/**
 * The local save/load boundary: how a document gets into and out of a file.
 *
 * ## Two concerns, one module
 *
 *  - A **gateway**: the browser mechanics. A Blob, an object URL, a synthetic `<a download>`
 *    click, a hidden `<input type=file>`. All of it disposable and all of it untestable
 *    without a browser, so it sits behind {@link DocumentGateway} and the tests supply a
 *    fake.
 *  - A **session**: the rules. What "dirty" means, what a save does to an open text
 *    session, when history is cleared, what the baseline is after an open. These are the
 *    parts worth being sure about, so they are here rather than in `app.ts`, and they are
 *    testable without a DOM.
 *
 * ## Why download and upload, and not the File System Access API
 *
 * FSA would give save-in-place, which is nicer. It is not used, and the limitation is
 * real rather than a shrug:
 *
 *  - No save-in-place, so "update the file I already have" means downloading again, and a
 *    second download of the same name is subject to the browser renaming it
 *    (`Untitled (1).p1doc`) -- so the file on disk can silently become a different file.
 *  - No directory handle, so an `{ external }` asset path has nothing to resolve against,
 *    which is a second independent reason `external` stays unresolved.
 *  - FSA needs a **document handle that survives a reload** to be worth having, and this
 *    build persists no handles and no session state. Without one, "save" would still be a
 *    fresh picker every time.
 *
 * Download + upload works identically in every browser, and it is the only path a browser
 * test can drive -- so the round-trip tests exercise the real mechanism rather than a
 * test-only one.
 *
 * ## Layer
 *
 * `ui/` owns browser side effects, so this is where the `Blob` and the `<input>` live. The
 * document rules reach `model/` (serialization) and `editor/` (the store) and no further.
 * Neither `render/` nor the format knows this module exists.
 *
 * @module
 */

import { documentsEqual } from '../model/document-equality';
import type { Document } from '../model/types';
import type { DocStore } from '../editor/store/doc-store';
import { DocumentParseError, DOCUMENT_EXTENSION } from '../persist/format';
import { parse } from '../persist/deserialize';
import { serializeToString } from '../persist/serialize';

/** A file the user chose, or a save this build handed them. */
export interface OpenedDocument {
  /** The name to show and to suggest on the next save. Never a path. */
  name: string;
  text: string;
}

/**
 * Delivery, abstracted so the rules can be tested without a browser.
 *
 * Two methods because save and open are genuinely different mechanics -- one hands bytes
 * out, the other asks for them -- and collapsing them into one "transfer" would have hidden
 * that save can fail while open can be *cancelled*, which is not a failure.
 */
export interface DocumentGateway {
  /** Hands `text` to the user as a file named `name`. */
  write(name: string, text: string): Promise<void>;
  /** Asks the user for a document, or resolves `null` if they cancelled. */
  read(): Promise<OpenedDocument | null>;
}

/** Why an operation did not produce a new state, in words a user can act on. */
export type SaveOutcome = 'saved' | 'cancelled';

/**
 * Document state that is not in the document: the saved baseline, and the rules around it.
 *
 * ## Dirty state
 *
 * A document is dirty when its **canonical authored state** differs from the state that was
 * last saved or loaded. Not its DOM, its scroll position, its selection, whether a
 * measurement is pending, whether an image has finished decoding, or whether a text session
 * is open. None of those are authored, and a save that reported "no changes" for any of them
 * would be lying.
 *
 * Implemented by comparing documents with `documentsEqual` rather than by comparing
 * serialized strings: a document holding a 1 MB inline image would re-encode 1.3 MB of
 * base64 on every keystroke to answer a question about canonical state. The comparison is a
 * *derived read* rather than stored state, so it cannot disagree with the document.
 *
 * ## The text fence, at save time
 *
 * Saving **ends the active text session first**. The browser owns the editable subtree
 * while a session is open (ADR 0001), so the model's text is stale for exactly as long as
 * the session is, and serializing it would write the text *before the user's typing* --
 * silent data loss. The alternatives were a dead Save button or reaching past the model
 * into the browser's DOM, and both are worse. `Editor.endTextEdit()` is already the
 * canonical exit that <kbd>Esc</kbd> and clicking away take: one undo entry, the element
 * handed back to the renderer, `select` mode. Calling it first is not a new mechanism.
 *
 * ## Loading
 *
 * `parse` is synchronous and pure, and **loading never waits for an image to decode**. The
 * document becomes authoritative first; the renderer then projects it and assigns `src`;
 * `load` and `error` arrive afterwards and update `data-asset-state`. So a document with a
 * broken image opens instantly behind a marked placeholder (ADR 0006 §5), and loading can
 * only fail because the *document* is malformed -- never because an image failed.
 *
 * @module
 */
export class DocumentSession {
  /**
   * The state that was last saved or loaded.
   *
   * Kept as a `Document` rather than a serialized string, for the reason above.
   */
  private baseline: Document;

  /** The name to suggest on the next save. `null` for a document that was never saved. */
  private name: string | null;

  /** Set when the last open or save failed, so the UI can explain itself. */
  private lastError: string | null = null;

  constructor(
    private readonly store: DocStore,
    private readonly gateway: DocumentGateway,
    /**
     * Commits an open text session, if there is one.
     *
     * Injected rather than reaching for `Editor`, so this class does not depend on the
     * editor and the rule stays testable without one. Must be synchronous: the document is
     * read immediately afterwards.
     */
    private readonly commitTextSession: () => void = () => {},
  ) {
    this.baseline = store.state;
    this.name = null;
  }

  /**
   * Whether the document has changed since it was last saved or loaded.
   *
   * A text session that ends with no change does not dirty the document, because the
   * command funnel drops no-op commands -- so committing one is not a change.
   */
  get isDirty(): boolean {
    return !documentsEqual(this.store.state, this.baseline);
  }

  /**
   * The name to save under: the opened or saved file's name, else the document's own.
   *
   * Read from the document rather than held separately, so renaming the document renames
   * the file and there is no second copy of the name to fall out of step.
   */
  get filename(): string {
    return withExtension(this.name ?? this.store.state.name);
  }

  /** Whether a file has ever been written or opened. Drives whether New warns. */
  get hasFile(): boolean {
    return this.name !== null;
  }

  /** The last failure, or `null`. Cleared by the next successful operation. */
  get error(): string | null {
    return this.lastError;
  }

  /**
   * Writes the document.
   *
   * The session is committed **before** the state is read, which is the whole rule; the
   * ordering is the point, so it is spelled out rather than left to reader order.
   */
  async save(): Promise<SaveOutcome> {
    this.commitTextSession();

    const current = this.store.state;
    const name = this.filename;
    try {
      await this.gateway.write(name, serializeToString(current));
    } catch (error) {
      this.lastError = describe(error);
      return 'cancelled';
    }

    // The baseline is the document that was written, by reference. Undo back to it then
    // reports clean without any comparison against a stored string.
    this.baseline = current;
    this.name = name;
    this.lastError = null;
    return 'saved';
  }

  /**
   * Opens a document, replacing the open one.
   *
   * On a refusal **nothing changes** -- not the document, not the baseline, not the name.
   * A half-opened document would leave the user unsure what they were editing, and the
   * baseline in particular must keep describing the document that is actually open.
   */
  async open(): Promise<SaveOutcome> {
    let opened: OpenedDocument | null;
    try {
      opened = await this.gateway.read();
    } catch (error) {
      this.lastError = describe(error);
      return 'cancelled';
    }
    if (opened === null) {
      // Cancelling is not an error and must not clear the previous one into a lie.
      return 'cancelled';
    }

    let doc: Document;
    try {
      doc = parse(JSON.parse(opened.text));
    } catch (error) {
      // Two very different failures land here, and the user needs to tell them apart:
      // the file is not JSON, or the file is JSON this build will not accept. The
      // `DocumentParseError` already names a path.
      this.lastError =
        error instanceof DocumentParseError
          ? error.message
          : error instanceof SyntaxError
            ? `not a readable document: ${error.message}`
            : describe(error);
      return 'cancelled';
    }

    // Settled before the store changes, never after: `reset` notifies subscribers
    // synchronously and they render the dirty indicator, so a baseline assigned afterwards
    // would leave the chrome reporting a freshly opened document as unsaved.
    this.baseline = doc;
    this.name = opened.name;
    this.lastError = null;
    // `reset` also clears history, which is correct rather than incidental: history entries
    // hold `Document` snapshots, so an undo stack spanning two documents would make undo
    // jump between them.
    this.store.reset(doc);
    return 'saved';
  }

  /**
   * Replaces the document with a fresh one, clearing history.
   *
   * Nothing is written: this milestone has no autosave, so New discards unsaved work only
   * as far as the caller is willing to discard it. The caller is responsible for asking.
   */
  resetTo(doc: Document, name: string | null = null): void {
    this.baseline = doc;
    this.name = name;
    this.lastError = null;
    // Last, for the same reason as in `open`: the store notifies synchronously and the
    // subscribers render the indicator.
    this.store.reset(doc);
  }
}

function withExtension(name: string): string {
  return name.endsWith(DOCUMENT_EXTENSION) ? name : `${name}${DOCUMENT_EXTENSION}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// The browser gateway
// ---------------------------------------------------------------------------

/**
 * Download and upload, over a plain file input.
 *
 * ## The input's owner is `app.ts`, not this module
 *
 * The Open button is a pure trigger that clicks a hidden input, and `app.ts` listens for
 * `change` on it and calls `session.open()`. `read()` is therefore just "take the file the
 * input is currently holding" -- it opens no dialog and owns no listener.
 *
 * An earlier version wrapped `input.click()` in a promise and attached its own one-shot
 * `change` listener. That put the input's events behind a waiter, so a `change` delivered by
 * anything else -- a drop target, a paste handler, a test setting the files directly -- was
 * delivered to nobody and silently lost. The symptom was "Open does nothing", and it took
 * the file boundary's first browser run to find it. The image import had been doing it the
 * other way all along, which is the real lesson: one pattern per app beats a locally tidier
 * one.
 */
export function browserGateway(options: { openInput: HTMLInputElement }): DocumentGateway {
  const input = options.openInput;
  return {
    write: (name, text) => downloadText(name, text),
    read: async () => {
      const file = input.files?.[0] ?? null;
      // Cleared on the way out: without it, choosing the same file twice in a row fires no
      // `change` event and the second attempt silently does nothing. This is the bug the
      // image import already had to work around.
      input.value = '';
      if (file === null) return null;
      return { name: file.name, text: await file.text() };
    },
  };
}

async function downloadText(name: string, text: string): Promise<void> {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.rel = 'noopener';
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Deferred by a tick on purpose. The click only *queues* the navigation, so revoking in
    // the same tick races the browser's read of the blob and can cancel the download
    // outright -- which would present as a Save button that silently does nothing.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  // Nothing to await: the click has been dispatched and the browser owns the rest. The
  // `async` is here so a future gateway that *can* fail -- a native picker the user
  // dismisses -- fits the same interface.
}

