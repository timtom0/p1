/**
 * The bottom toast.
 *
 * ## Why it exists, and why it is the only place an Undo button lives
 *
 * M23's shortcut path is meant to be *immediate*: no dialog between the keystroke and the edit.
 * That is the right default for an operation a user can see the meaning of instantly, and the wrong
 * default for one whose meaning is only visible afterwards -- which is exactly what unlink and
 * remove are. "Unlink" and "Remove" differ only in what happens to properties the user cannot see,
 * and pressing the wrong one changes the document in a way that is easy to miss and annoying to
 * undo through a menu.
 *
 * So the keystroke acts at once and the toast says what happened, with Undo in it. The alternative
 * -- a dialog on every shortcut -- makes the common case pay for the uncommon mistake, and the
 * requirement asks for no dialog at all on this path.
 *
 * ## Why Undo is a callback and not a second undo mechanism
 *
 * `onAction` is wired to `Editor.undo`, which is the same call the toolbar's Undo button and
 * Ctrl+Z make. There is no history here, no snapshot, no "revert this one edit" buffer. If a
 * future milestone needs an undo stack of its own that is a decision to make deliberately and
 * visibly, not something a notification widget should have introduced by accident.
 *
 * ## Why one toast at a time
 *
 * A queue would be more complete and less useful. Two toasts stacked means the top one has a live
 * Undo button for an edit the user has already been told about three rows up, and stacking is where
 * notification UIs go wrong. A second toast replaces the first; because every toast here is
 * undoable and therefore reports a discrete, recent edit, the newest one is the one worth offering.
 */

import { el } from './dom';

export interface ToastOptions {
  /** Label for the action button. Omit for a toast with no action. */
  action?: { label: string; run: () => void };
  /** How long the toast stays. Destructive-adjacent messages get longer, not shorter. */
  durationMs?: number;
}

export interface Toaster {
  /**
   * Shows a message. Replaces any toast already on screen.
   *
   * `message` is text, not markup: it is assembled from counts and style names, and a style name is
   * author-supplied. It reaches the DOM as a text node, so a name containing `<` cannot become
   * an element.
   */
  show: (message: string, options?: ToastOptions) => void;
  /** Removes the current toast, if any. Called on Escape and on the next `show`. */
  dismiss: () => void;
}

const DEFAULT_DURATION_MS = 6000;

export function mountToaster(): Toaster {
  const root = el('div', { class: 'p1-toast-region', 'data-toast-region': '' });
  // Not announced eagerly: a toast that interrupts the screen reader on every style change is worse
  // than one that is silent, and the change it reports is one the user just made and can see.
  root.setAttribute('aria-live', 'polite');
  document.body.append(root);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let current: HTMLElement | null = null;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const dismiss = (): void => {
    clearTimer();
    current?.remove();
    current = null;
  };

  const show = (message: string, options: ToastOptions = {}): void => {
    dismiss();

    const text = el('span', { class: 'p1-toast__text' }, message);
    const toast = el('div', { class: 'p1-toast', 'data-toast': '' }, text);

    if (options.action !== undefined) {
      const button = el(
        'button',
        { type: 'button', class: 'p1-toast__action', 'data-toast-action': '' },
        options.action.label,
      );
      // Dismiss first: if the undo handler threw, a toast stuck on screen with a button that does
      // nothing would be worse than no toast. And an undo that succeeds is exactly the case where
      // the message it was reporting is no longer true.
      button.addEventListener('click', () => {
        dismiss();
        options.action?.run();
      });
      toast.append(button);
    }

    root.append(toast);
    current = toast;
    timer = setTimeout(dismiss, options.durationMs ?? DEFAULT_DURATION_MS);
  };

  return { show, dismiss };
}