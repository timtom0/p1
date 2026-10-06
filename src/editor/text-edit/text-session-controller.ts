/**
 * `TextSessionController` — where ADR 0002 becomes code.
 *
 * The decision this implements:
 *
 * > While a text-editing session is active, the undo/redo action targets the
 * > session. Otherwise it targets the application history.
 *
 * Concretely, that means three things live here and nowhere else:
 *
 *  1. **Entering** a session marks the fence, so the renderer starts withholding
 *     that element and the browser starts owning it.
 *  2. **Exiting** commits one command — `setText` — as a *single* history entry.
 *     Because the browser owns intra-session undo, the entry represents the whole
 *     edit, and undoing past the session boundary is therefore correct without any
 *     extra bookkeeping.
 *  3. **Delegation.** `undo()`/`redo()` forward to the browser while a session is
 *     active, and to the application history otherwise.
 *
 * ## Formatting follows the same shape
 *
 * ADR 0003 adds a second routed operation, and it composes with the first for the
 * same reason: **a session is a transaction.**
 *
 *  - `applyInlineFormat` *inside* a session hands the selection to the browser via
 *    `execCommand`, and the result lands in the model as part of the session's single
 *    `setText` entry. Nothing special is needed to keep undo usable.
 *  - *Outside* a session it applies to every run in the frame, as an immediate model
 *    command — so "select a frame, press Bold" is well defined rather than a no-op.
 *
 * The controller also carries the conflict rule ADR 0001 identified as missing: a
 * model write to the frame being edited is *deferred* rather than silently
 * overwritten on exit. ADR 0003 widens that from text to typography, since a
 * font-size change from the inspector mid-edit is the same hazard.
 */

import type { CharFormat, Document, RichText, TextStyle } from '../../model/types';
import { nodeById } from '../../model/tree';
import type { CharFlag } from '../../model/rich-text';
import { formatAppliesThroughout, normalizeRichText, toggleFlag } from '../../model/rich-text';
import type { Command } from '../../model/commands';
import { apply } from '../../model/commands';
import { TextEditSession } from './text-edit-session';
import { domTextContent } from '../../render/rich-text-html';
import { contentOf } from '../../render/types/text-frame';
import type { DocStore } from '../store/doc-store';

export interface TextSessionHost {
  readonly store: DocStore;
  /** Resolves a node id to its mounted element, if any. */
  elementFor(nodeId: string): HTMLElement | undefined;
  /** Starts the renderer withholding this frame's content. */
  setFence(nodeId: string, active: boolean): void;
}

export interface TextSessionControllerOptions {
  host: TextSessionHost;
  /**
   * Injected rather than hard-wired so tests can assert delegation without
   * depending on `execCommand`, and so a future implementation could swap in a
   * different mechanism without touching callers.
   */
  nativeUndo?: () => boolean;
  nativeRedo?: () => boolean;
  /** Injected for the same reason: `execCommand` is deprecated and test-hostile. */
  nativeCommand?: (command: string) => boolean;
  /**
   * Called when the browser mutates the fenced DOM, that is, on every keystroke.
   *
   * Wired to `Editor.onChange` so the chrome re-reads what only the browser knows:
   * the format toggles' pressed state (`queryCommandState` is the only source of
   * truth mid-session) and any measurement of the live text. Without it the toolbar
   * shows the state the caret had when the session opened, which is wrong from the
   * first keystroke.
   *
   * It was previously unwired. `TextEditSession.begin` was called with no options,
   * so `onDomChange` never fired outside the spike harness. Found while probing the
   * measurement boundary: a measured height that cannot change while the user types
   * is a measurement boundary with a hole in it.
   */
  onDomChange?: () => void;
}

/** `execCommand` verb per formatting flag, matching the session's own map. */
const COMMAND_FOR_FLAG: Record<CharFlag, string> = {
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  strike: 'strikeThrough',
};

export class TextSessionController {
  private session: TextEditSession | null = null;

  /**
   * Model writes that arrived while a session was open, deferred until it ends.
   *
   * ADR 0001 found that such writes were silently lost. Deferring is the smallest
   * correct behaviour: the user's in-progress text wins, and the external write is
   * replayed afterwards rather than discarded.
   *
   * `text` and `style` are tracked separately because they are independent
   * properties: a session can only ever change `text`, so a deferred `style` always
   * replays, and a deferred `text` always replays after the session's own commit.
   */
  private deferred: { nodeId: string; text?: RichText; style?: TextStyle } | null = null;

  private readonly host: TextSessionHost;
  private readonly nativeUndo: () => boolean;
  private readonly nativeRedo: () => boolean;
  private readonly nativeCommand: (command: string) => boolean;
  private readonly onDomChange: () => void;

  constructor(options: TextSessionControllerOptions) {
    this.host = options.host;
    this.nativeUndo =
      options.nativeUndo ??
      (() => {
        /*
         * `execCommand` is deprecated, and this is the only reason it is used here:
         * it is the sole way to ask the browser to perform a native undo, and ADR
         * 0002 measured that it works. If it is ever removed, application-level undo
         * simply becomes unavailable during a text session — degraded, not broken.
         * The alternative (reimplementing the browser's undo) was rejected in the
         * ADR precisely because IME and autocorrect make that a bad trade.
         */
        return typeof document !== 'undefined' && document.execCommand('undo');
      });
    this.nativeRedo =
      options.nativeRedo ??
      (() => typeof document !== 'undefined' && document.execCommand('redo'));
    this.nativeCommand =
      options.nativeCommand ??
      ((command: string) => typeof document !== 'undefined' && document.execCommand(command));
    // No-op by default, so a controller built in a unit test need not know about
    // chrome refreshes.
    this.onDomChange = options.onDomChange ?? (() => undefined);
  }

  get isActive(): boolean {
    return this.session?.isActive === true;
  }

  get nodeId(): string | null {
    return this.session?.nodeId ?? null;
  }

  get hasDeferredWrite(): boolean {
    return this.deferred !== null;
  }

  // ---------------------------------------------------------------------------
  // Inline formatting (ADR 0003)
  // ---------------------------------------------------------------------------

  /**
   * Is `flag` applied at the browser's current selection?
   *
   * Reads the browser rather than the model, because mid-session the model is stale
   * by definition. Outside a session the selection is the frame's whole text, so the
   * answer comes from the model instead — one rule, two sources, and the caller does
   * not have to know which.
   */
  isFormatActive(flag: CharFlag, frameId?: string): boolean {
    if (this.session?.isActive === true) return this.session.isFormatActive(flag);
    if (frameId === undefined) return false;
    return formatAppliesThroughout(this.frameText(frameId), flag);
  }

  /**
   * Toggles a character-formatting flag.
   *
   * Inside a session the browser applies it to the selection and the result becomes
   * part of that session's single `setText` entry. Outside a session every run in
   * the frame is toggled, as an immediate command with its own history entry.
   */
  applyInlineFormat(flag: CharFlag, frameId?: string): boolean {
    if (this.session?.isActive === true) {
      return this.nativeCommand(COMMAND_FOR_FLAG[flag]);
    }
    if (frameId === undefined) return false;

    const current = this.frameText(frameId);
    const next = normalizeRichText({
      blocks: current.blocks.map((block) => ({
        kind: block.kind,
        ...(block.align === undefined ? {} : { align: block.align }),
        runs: block.runs.map((r) => {
          const format: CharFormat | undefined = toggleFlag(r.format, flag);
          return format === undefined ? { text: r.text } : { text: r.text, format };
        }),
      })),
    });

    const command: Command = { type: 'setText', nodeId: frameId, text: next };
    this.host.store.commitExternal(
      apply(this.host.store.state, command),
      command,
      describeFlag(flag),
    );
    return true;
  }

  /** Enters a session on `nodeId`. Returns false if it is already active elsewhere. */
  begin(nodeId: string): boolean {
    if (this.session?.isActive === true) return false;

    const element = this.host.elementFor(nodeId);
    if (element === undefined) return false;
    if (contentOf(element) === null) return false;

    const node = findNode(this.host.store.state, nodeId);
    if (node === undefined || node.type !== 'textFrame') return false;

    // The DOM-change hook is what makes the session observable from outside. Without
    // it, nothing downstream learns that the browser rewrote the content, so a
    // toolbar's pressed state and any measurement of the live text both freeze at the
    // moment the caret was placed.
    this.session = TextEditSession.begin(nodeId, element, {
      onDomChange: this.onDomChange,
    });
    this.host.setFence(nodeId, true);
    return true;
  }

  /**
   * Ends the session and commits its text as one application-history entry.
   *
   * Returns whether the text actually changed, so a session entered and left
   * untouched reports `false` and records nothing.
   *
   * Ordering matters and is asserted by the ADR's tests: clear the fence *first*,
   * then write the model, then let the renderer re-render. Writing the model first
   * re-renders while the renderer still believes the frame is being edited, so it
   * withholds the content we just committed.
   */
  end(): boolean {
    const session = this.session;
    if (session === null || !session.isActive) return false;

    const nodeId = session.nodeId;
    const text = session.end();

    // 1. Hand the element back to the renderer.
    this.host.setFence(nodeId, false);
    this.session = null;

    // 2. Commit. The funnel decides whether this is a change at all.
    const changed = this.commitText(nodeId, text, 'Edit text');

    this.replayDeferred();
    return changed;
  }

  /**
   * A model write to the frame currently being edited.
   *
   * Called by the store pipeline when the model changes underneath an open session.
   * The write is parked rather than applied, because the browser owns that element
   * until the session ends.
   *
   * `text` and `style` are optional independently: typography is a frame property
   * the session never touches, so deferring it loses nothing, whereas deferring text
   * would lose the user's typing.
   */
  notifyExternalWrite(nodeId: string, change: { text?: RichText; style?: TextStyle }): void {
    if (!this.isActive || this.session?.nodeId !== nodeId) return;
    const next = { nodeId, ...this.deferred, ...change };
    this.deferred = next;
  }

  /** Undo: the session's native stack if a session is open, else the app history. */
  undo(): void {
    if (this.isActive) {
      this.nativeUndo();
      return;
    }
    this.host.store.undo();
  }

  /** Redo, with the same targeting rule as `undo`. */
  redo(): void {
    if (this.isActive) {
      this.nativeRedo();
      return;
    }
    this.host.store.redo();
  }

  /** The label the UI should show for the undo action right now. */
  undoLabel(): string | null {
    if (this.isActive) return 'Undo text';
    return this.host.store.undoLabel;
  }

  /** Current text as the browser holds it, for diagnostics and tests. */
  liveText(): string | null {
    const nodeId = this.session?.nodeId;
    if (nodeId === undefined) return null;
    const element = this.host.elementFor(nodeId);
    const content = element === undefined ? null : contentOf(element);
    return content === null ? null : domTextContent(content);
  }

  private replayDeferred(): void {
    const deferred = this.deferred;
    this.deferred = null;
    if (deferred === null) return;

    // Text first, then typography: the session's own text commit has already landed
    // by this point, so this replays on top of it, in the order the writes happened.
    if (deferred.text !== undefined) {
      this.commitText(deferred.nodeId, deferred.text, 'Edit text');
    }
    if (deferred.style !== undefined) {
      this.commitStyle(deferred.nodeId, deferred.style, 'Typography');
    }
  }

  /**
   * Writes text to the model as one history entry, via the command funnel.
   *
   * Going through `apply` rather than hand-rolling the document rebuild is what makes
   * "this write changes nothing" detectable: `apply` returns the same reference for a
   * no-op, and `commitExternal` then records nothing.
   *
   * Returns whether the document changed.
   */
  private commitText(nodeId: string, text: RichText, label: string): boolean {
    return this.commit({ type: 'setText', nodeId, text }, label);
  }

  private commitStyle(nodeId: string, style: TextStyle, label: string): boolean {
    return this.commit({ type: 'setTextStyle', ids: [nodeId], patch: style }, label);
  }

  private commit(command: Command, label: string): boolean {
    const before = this.host.store.state;
    const next = apply(before, command);
    // Compared before committing: `commitExternal` moves the store onto `next`, so
    // asking afterwards would always report "no change".
    const changed = next !== before;
    this.host.store.commitExternal(next, command, label);
    return changed;
  }

  /** The model's text for a frame, or an empty frame if it is gone. */
  private frameText(nodeId: string): RichText {
    const node = findNode(this.host.store.state, nodeId);
    return node?.type === 'textFrame' ? node.text : { blocks: [{ kind: 'paragraph', runs: [{ text: '' }] }] };
  }
}

/** Human label for a formatting toggle, for the history. */
function describeFlag(flag: CharFlag): string {
  switch (flag) {
    case 'bold':
      return 'Bold';
    case 'italic':
      return 'Italic';
    case 'underline':
      return 'Underline';
    case 'strike':
      return 'Strikethrough';
    default:
      return 'Text format';
  }
}

/**
 * The node with this id, anywhere in the document.
 *
 * `undefined` rather than `null`, because every caller here writes `if (found === undefined)`, and
 * this module predates the shared helper. The search is recursive since M12, so a text frame
 * inside a group can open a session — see ADR 0012 §11 for why that is the same code and not a
 * branch.
 */
function findNode(doc: Document, id: string) {
  return nodeById(doc, id) ?? undefined;
}
