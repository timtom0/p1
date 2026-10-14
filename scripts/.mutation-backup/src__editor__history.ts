/**
 * History (§4.4): snapshot-based, transaction-oriented, with gesture coalescing.
 *
 * The model is immutable, so an undo entry is just the previous root reference.
 * Structural sharing makes that cheap — a snapshot costs one pointer plus whatever
 * changed along the path, not a copy of the document.
 *
 * ## Two levels, deliberately
 *
 * - **Application history** — commands, driven by tools and the inspector.
 * - **Text session** — the browser's native undo, *not* recorded here.
 *
 * They compose across a boundary rather than merging, per
 * [ADR 0002](../../docs/adr/0002-text-undo-composition.md): the browser owns undo
 * *inside* a text session because it handles IME, autocorrect and grouping better
 * than we could, and a text session commits exactly one entry here on exit.
 *
 * ## Coalescing
 *
 * A drag dispatches a command per pointer-move. Without coalescing that is
 * hundreds of undo steps for one gesture. A transaction accumulates dispatches into
 * a single entry, and a change of `mergeKey` flushes the current entry and starts a
 * new one — so one drag is one undo, but two distinct gestures are two.
 */

import type { Document } from '../model/types';
import type { Command } from '../model/commands';
import { apply, describeCommand, isNoop } from '../model/commands';
import { documentsEqual } from '../model/document-equality';

export interface HistoryEntry {
  /** The document *before* this entry's commands were applied. */
  before: Document;
  /** The accumulated command(s), kept for redo and labelling. */
  command: Command;
  label: string;
}

export interface HistoryOptions {
  /** Maximum entries retained. Older entries are dropped from the bottom. */
  limit?: number;
}

export interface TransactionOptions {
  /**
   * Consecutive dispatches sharing this key accumulate into one entry. Use a key
   * that identifies the *gesture*, e.g. `move:node_1`. Changing the key flushes.
   */
  mergeKey?: string;
  /** Label for the entry this transaction produces. */
  label?: string;
}

export interface DispatchOptions {
  /** Optional merge key for this dispatch; overrides the transaction's. */
  mergeKey?: string;
  /**
   * Overrides the derived label for the entry this dispatch creates.
   *
   * Supplied rather than applied afterwards because a relabel after the fact has to
   * notify listeners separately — and forgetting that left the toolbar reading
   * "Undo Transform" for an edit the inspector had named.
   */
  label?: string;
}

interface OpenTransaction {
  label: string;
  mergeKey: string | null;
  /** Document at the start of the *current* entry; what `undo` would return. */
  before: Document;
  /**
   * Document at the start of the whole transaction.
   *
   * Distinct from `before` because a merge-key change splits one transaction into
   * several entries, and only this one is where an abort must land.
   */
  origin: Document;
  commands: Command[];
}

export class History {
  /** Entries oldest-first. `undo()` pops from `cursor - 1`. */
  private entries: HistoryEntry[] = [];
  private cursor = 0;

  private open: OpenTransaction | null = null;
  private readonly limit: number;

  /** Entry count when the current transaction opened, so `abort` can roll back. */
  private depthAtOpen = 0;

  constructor(options: HistoryOptions = {}) {
    this.limit = options.limit ?? 200;
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.entries.length;
  }

  get undoLabel(): string | null {
    return this.canUndo ? (this.entries[this.cursor - 1]?.label ?? null) : null;
  }

  get redoLabel(): string | null {
    return this.canRedo ? (this.entries[this.cursor]?.label ?? null) : null;
  }

  get depth(): number {
    return this.entries.length;
  }

  get isTransactionOpen(): boolean {
    return this.open !== null;
  }

  /**
   * Opens a transaction. Nested calls are ignored: only the outermost has an
   * effect, which is what a caller expects when a tool wraps an operation that
   * itself dispatches.
   */
  begin(doc: Document, options: TransactionOptions = {}): void {
    if (this.open !== null) return;
    this.depthAtOpen = this.entries.length;
    this.open = {
      label: options.label ?? 'Change',
      mergeKey: options.mergeKey ?? null,
      before: doc,
      origin: doc,
      commands: [],
    };
  }

  /**
   * Applies a command, recording it for undo.
   *
   * Returns `true` when the document changed. A no-op records nothing, so a click
   * that moves nothing produces nothing to undo.
   */
  dispatch(
    doc: Document,
    command: Command,
    options: DispatchOptions = {},
  ): { doc: Document; changed: boolean } {
    const next = apply(doc, command);
    if (next === doc) return { doc, changed: false };
    const label = options.label ?? describeCommand(command);

    if (this.open === null) {
      this.push({ before: doc, command, label });
      return { doc: next, changed: true };
    }

    const mergeKey = options.mergeKey ?? this.open.mergeKey;
    // A different key means a different gesture: close this entry, start another.
    if (this.open.mergeKey !== null && mergeKey !== null && mergeKey !== this.open.mergeKey) {
      // Read the label before flushing — `flush` clears `this.open`.
      const label = this.open.label;
      const origin = this.open.origin;
      this.flush();
      this.open = { label, mergeKey, before: doc, origin, commands: [] };
    } else if (this.open.mergeKey === null) {
      this.open.mergeKey = mergeKey;
    }

    this.open.commands.push(command);
    return { doc: next, changed: true };
  }

  /** Closes the open transaction, flushing it into an entry. */
  end(): void {
    this.flush();
  }

  /**
   * Abandons the open transaction, returning the document to how it started.
   *
   * Rolling back rather than dispatching a compensating edit, because a compensating
   * edit cannot be recognised as one: `apply` compares by reference, so moving an
   * object out and back produces a document that *equals* the starting one without
   * *being* it — and the history records an undo step that does nothing. Escape on a
   * drag must leave no trace at all, so the rollback happens here instead.
   */
  abort(): Document | null {
    const open = this.open;
    this.open = null;
    if (open === null) return null;

    // Discard anything this transaction flushed into the list (a merge-key change
    // can do that mid-gesture).
    this.entries.length = this.depthAtOpen;
    this.cursor = Math.min(this.cursor, this.entries.length);
    // `origin`, not `before`: a merge-key change moves `before` forward, and an abort
    // must land where the gesture started, not where its last sub-entry did.
    return open.origin;
  }

  /**
   * Runs `fn` inside a transaction, always closing it afterwards.
   *
   * The `finally` matters: an exception mid-gesture must not leave the history
   * permanently open, which would silently merge every later command into one
   * entry.
   */
  transact(
    doc: Document,
    options: TransactionOptions,
    fn: (doc: Document) => Document,
  ): Document {
    this.begin(doc, options);
    try {
      return fn(doc);
    } finally {
      this.end();
    }
  }

  undo(doc: Document): Document {
    if (!this.canUndo) return doc;
    const entry = this.entries[this.cursor - 1];
    if (entry === undefined) return doc;
    this.cursor -= 1;
    return entry.before;
  }

  redo(doc: Document): Document {
    if (!this.canRedo) return doc;
    const entry = this.entries[this.cursor];
    if (entry === undefined) return doc;
    this.cursor += 1;
    return apply(doc, entry.command);
  }

  /**
   * Records a change discovered rather than dispatched.
   *
   * The text session commits this way: the DOM was authoritative, so the model
   * change is found at exit instead of dispatched per keystroke. It is exactly one
   * entry, which is what makes undoing past a session boundary correct.
   */
  commitExternal(
    before: Document,
    after: Document,
    command: Command,
    label?: string,
  ): Document {
    if (after === before) return before;
    this.push({ before, command, label: label ?? describeCommand(command) });
    return after;
  }

  /** Discards all history. Used when a different document is opened. */
  clear(): void {
    this.entries = [];
    this.cursor = 0;
    this.open = null;
  }

  private flush(): void {
    const open = this.open;
    this.open = null;
    // `null` here means no transaction was open, which is not an error: `end()` is
    // called unconditionally by `transact`'s finally block.
    if (open === null || open.commands.length === 0) return;

    // A single command stays un-batched, so redo re-applies exactly what was
    // dispatched rather than a synthetic wrapper.
    const command =
      open.commands.length === 1
        ? (open.commands[0] as Command)
        : ({ type: 'batch', cmds: open.commands } satisfies Command);

    // A gesture that dispatched nothing is not an action. `abort` is what handles a gesture
    // the user cancelled; this handles the case where nothing ever changed at all.
    const after = apply(open.before, command);
    if (after === open.before) return;

    // A gesture that moved and came back is not an action either, and the reference check
    // above cannot see it. A drag accumulates one `setTransform` per pointermove, each
    // computed from the gesture's captured start, so an out-and-back drag ends its sequence
    // at the start -- to within the float error of inverting the stack transform twice. The
    // document then renders identically and compares unequal by reference, so the drag lands
    // on the history and undo does nothing visible.
    //
    // This is the same canonical equality M7 uses for dirty state. It runs only where the
    // cheap check has already failed, so the cost is one walk of a document that genuinely
    // changed, and it cannot drop a real entry: an entry whose result is canonically equal
    // to where it started has nothing to undo.
    if (documentsEqual(open.before, after)) return;

    this.push({ before: open.before, command, label: open.label });
  }

  private push(entry: HistoryEntry): void {
    // Any new action invalidates the redo branch.
    this.entries.length = this.cursor;
    this.entries.push(entry);
    this.cursor = this.entries.length;
    this.trim();
  }

  private trim(): void {
    if (this.entries.length <= this.limit) return;
    const excess = this.entries.length - this.limit;
    this.entries.splice(0, excess);
    this.cursor = Math.max(0, this.cursor - excess);
  }
}

export { apply, isNoop };
export type { Command };