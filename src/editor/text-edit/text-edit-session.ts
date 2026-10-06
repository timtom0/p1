/**
 * `TextEditSession` — the ADR 0001 fence, in production form.
 *
 * The claim, now validated:
 *
 * > The DOM is a disposable projection of the model, *except* inside an
 * > explicitly fenced `contenteditable` session, during which the browser is
 * > authoritative for exactly one element.
 *
 * ## Session boundary
 *
 * **Enter** — the frame's content element gets `contenteditable`, and the renderer
 * starts withholding it. From this moment the browser may rewrite the subtree freely.
 *
 * **During** — the browser is authoritative for that element's *content*. We do not
 * re-render it on every keystroke; doing so would move the caret. Other frames, and
 * this frame's geometry and typography, continue to render from the model. That
 * scoping is what makes the fence a fence rather than a special case.
 *
 * **Exit** — read the DOM back via `domToRichText`, remove `contenteditable`, clear
 * the fence, write the model, re-render. The order is fixed; see ADR 0001 finding 5.
 *
 * ## Where the surrounding decisions live
 *
 * - Undo composition: [ADR 0002](../../adr/0002-text-undo-composition.md), and
 *   `TextSessionController`, which owns the fence and the routing.
 * - Content model and `contenteditable` mode: [ADR 0003](../../adr/0003-production-text-model.md).
 * - Normalization: `render/rich-text-html.ts`.
 */

import type { RichText, TextFrameNode } from '../../model/types';
import type { CharFlag } from '../../model/rich-text';
import { domToRichText } from '../../render/rich-text-html';
import { contentOf } from '../../render/types/text-frame';

/** `execCommand` verb per formatting flag. Chromium's names; deprecated but load-bearing. */
const COMMAND_FOR_FLAG: Record<CharFlag, string> = {
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  strike: 'strikeThrough',
};

export interface TextEditSessionEvents {
  /** The model was updated from the DOM. Fires on exit, and optionally on commit. */
  onCommit?: (nodeId: string, text: RichText) => void;
  /** Fires when the DOM changes during a session. Used by the spike's instrumentation. */
  onDomChange?: (nodeId: string) => void;
}

export interface TextEditSessionOptions extends TextEditSessionEvents {
  /**
   * Ask the browser for `plaintext-only`, suppressing most invented markup.
   *
   * **Off by default since ADR 0003**, because `plaintext-only` also suppresses
   * *formatting*: `execCommand('bold')` returns `false` there, so character
   * formatting becomes unreachable. Retained as an escape hatch for a frame that
   * genuinely must never accept markup — nothing in the product needs it yet.
   */
  preferPlaintextOnly?: boolean;
}

/** Whether `contenteditable="plaintext-only"` actually took effect. */
export function supportsPlaintextOnly(element: HTMLElement): boolean {
  element.contentEditable = 'plaintext-only';
  const supported = element.contentEditable === 'plaintext-only';
  if (!supported) element.removeAttribute('contenteditable');
  return supported;
}

/**
 * One `contenteditable` session over a single text frame.
 *
 * ## Why `contenteditable="true"` and not `"plaintext-only"`
 *
 * The spike ran in `plaintext-only`, which suppresses almost all invented markup.
 * M3 needs character formatting, and measurement settled the question:
 * **in `plaintext-only`, `execCommand('bold')` returns `false` and Ctrl+B produces
 * nothing at all.** Not awkward markup — none. So `plaintext-only` cannot be the
 * editing surface for formatted text.
 *
 * `contenteditable="true"` costs richer markup, and the normalizer handles it. It
 * also *gains* two things the spike could not have:
 *  - Enter produces a real `<p>` element instead of a literal `\n`, so a paragraph
 *    boundary is an element and `\n` is unambiguously a soft break;
 *  - the browser emits semantic tags (`<b>`, `<i>`, `<u>`, `<strike>`) rather than
 *    `<span style>`, so the conversion is symmetric with our own output.
 *
 * See ADR 0003, which supersedes ADR 0001's `plaintext-only` choice while keeping
 * its fence. `plaintextOnly` remains an option for a frame that must never accept
 * markup, but nothing in the product needs it yet.
 */
export class TextEditSession {
  private readonly element: HTMLElement;
  private readonly content: HTMLElement;
  private readonly options: TextEditSessionOptions;
  private readonly usedPlaintextOnly: boolean;

  private active = false;
  private composing = false;

  /** Counts, for the spike's assertions about what the browser actually did. */
  readonly stats = { domMutations: 0, beforeInputs: 0, compositions: 0 };

  private readonly onInput = (): void => {
    this.stats.domMutations += 1;
    this.options.onDomChange?.(this.nodeId);
  };
  private readonly onCompositionStart = (): void => {
    this.composing = true;
    this.stats.compositions += 1;
  };
  private readonly onCompositionEnd = (): void => {
    this.composing = false;
  };
  private readonly onBeforeInput = (event: InputEvent): void => {
    this.stats.beforeInputs += 1;
    // Recorded, not intercepted. The spike's question is whether the browser's own
    // mutation is acceptable — so we must not preventDefault on the path being
    // measured.
    if (event.isComposing) this.composing = true;
  };

  private constructor(
    readonly nodeId: string,
    element: HTMLElement,
    options: TextEditSessionOptions,
  ) {
    this.element = element;
    this.options = options;
    const content = contentOf(element);
    if (content === null) {
      throw new Error(`Text frame "${nodeId}" has no content element to edit`);
    }
    this.content = content;

    const preferPlaintext = options.preferPlaintextOnly ?? false;
    this.usedPlaintextOnly = preferPlaintext && supportsPlaintextOnly(content);
    content.contentEditable = this.usedPlaintextOnly ? 'plaintext-only' : 'true';
  }

  static begin(
    nodeId: string,
    element: HTMLElement,
    options: TextEditSessionOptions = {},
  ): TextEditSession {
    const session = new TextEditSession(nodeId, element, options);
    session.start();
    return session;
  }

  get isActive(): boolean {
    return this.active;
  }

  get isComposing(): boolean {
    return this.composing;
  }

  get isPlaintextOnly(): boolean {
    return this.usedPlaintextOnly;
  }

  /**
   * Is `flag` applied throughout the current browser selection?
   *
   * Read-only, and deliberately routed through the browser rather than computed from
   * the model: mid-session the model is stale by definition, and the browser holds
   * the truth. This is what lets a toolbar show Bold as pressed while typing.
   */
  isFormatActive(flag: CharFlag): boolean {
    if (!this.active) return false;
    const command = COMMAND_FOR_FLAG[flag];
    try {
      return typeof document !== 'undefined' && document.queryCommandState(command);
    } catch {
      // `queryCommandState` throws if the document is not in a selection context,
      // which happens briefly on focus changes. "Not active" is the honest answer.
      return false;
    }
  }

  /** The element the browser owns for the duration of the session. */
  get editableElement(): HTMLElement {
    return this.content;
  }

  private start(): void {
    if (this.active) return;
    this.active = true;
    this.content.addEventListener('input', this.onInput);
    this.content.addEventListener('beforeinput', this.onBeforeInput as EventListener);
    this.content.addEventListener('compositionstart', this.onCompositionStart);
    this.content.addEventListener('compositionend', this.onCompositionEnd);
    this.element.dataset['editing'] = 'true';
    this.focus();
  }

  private focus(): void {
    this.content.focus();
    // Put the caret at the end of the existing text, which is the behaviour a user
    // expects when double-clicking into a frame and pressing a key.
    const selection = window.getSelection();
    if (selection === null) return;
    const range = document.createRange();
    range.selectNodeContents(this.content);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /**
   * Reads the browser's DOM back into the model.
   *
   * Called on exit, and safe to call mid-session to check whether the DOM and model
   * have diverged — which is exactly the question the spike needs answered.
   */
  readModel(): RichText {
    return domToRichText(this.content);
  }

  /**
   * Ends the session and returns the text to write back to the model.
   *
   * Removes the listeners and `contenteditable` first, so that the element is back
   * under renderer control before the caller re-renders.
   */
  end(): RichText {
    const text = this.readModel();

    this.content.removeEventListener('input', this.onInput);
    this.content.removeEventListener('beforeinput', this.onBeforeInput as EventListener);
    this.content.removeEventListener('compositionstart', this.onCompositionStart);
    this.content.removeEventListener('compositionend', this.onCompositionEnd);
    this.content.removeAttribute('contenteditable');
    // Clear both editing markers. `TextEditSession` set the attribute here and
    // `DocumentView` may still hold the id; clearing only one leaves the renderer
    // withholding a frame that is no longer being edited.
    delete this.element.dataset['editing'];
    delete this.content.dataset['editing'];
    this.active = false;

    this.options.onCommit?.(this.nodeId, text);
    return text;
  }
}

/** True when any descendant of `root` currently has an active editing session marker. */
export function hasActiveTextEditing(root: HTMLElement): boolean {
  return root.querySelector('[data-editing="true"]') !== null;
}

/** Convenience for the spike harness: the node's text, if it is a text frame. */
export function textOf(node: { type: string; text?: RichText }): RichText | null {
  return node.type === 'textFrame' ? ((node as TextFrameNode).text ?? null) : null;
}