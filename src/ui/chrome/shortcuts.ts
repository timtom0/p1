/**
 * Keyboard shortcuts for viewport navigation.
 *
 * Split out of `app.ts` so the key map is one readable table rather than a switch buried in
 * composition code. Navigation and the save shortcut live here; editing shortcuts belong to
 * `editing-shortcuts.ts`, which is the half that has to know about text sessions.
 *
 * Shortcuts are ignored while a text field has focus, so typing "1" into an input
 * does not change zoom.
 */

import type { Viewport } from '../../editor/viewport/viewport';

export interface ShortcutOptions {
  viewport: Viewport;
  onZoomChanged?: () => void;
  /**
   * Ctrl+S / Cmd+S.
   *
   * Handed in rather than implemented here so the shortcut table has no opinion about how a
   * document is written: `app.ts` owns the file boundary, this file owns the key map. It
   * goes through the same call the Save button does, which is what keeps the text-session
   * commit and the dirty-state refresh from having two code paths.
   */
  onSave?: () => void;
  /**
   * Layer order, for `[` / `]` and their command-key forms.
   *
   * Handed in for the same reason as `onSave`: this file owns the key map, `app.ts` owns what
   * happens, and a shortcut table that also knows about selection and the store is two things
   * to keep in step.
   */
  onRestack?: (direction: 'forward' | 'backward' | 'front' | 'back') => void;
}

export function bindShortcuts({
  viewport,
  onZoomChanged,
  onSave,
  onRestack,
}: ShortcutOptions): () => void {
  const isTypingTarget = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) return false;
    return (
      target.isContentEditable ||
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT'
    );
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (isTypingTarget(event.target)) return;

    // Space pans, and only while held. `setSpacePanning` is idempotent, so
    // auto-repeat is harmless.
    if (event.code === 'Space') {
      event.preventDefault();
      viewport.setSpacePanning(true);
      return;
    }

    const usesCommandKey = event.ctrlKey || event.metaKey;

    // Layer order. `[` and `]` move one position, with the command key for the ends -- the
    // ladder every other editor uses, and the one that needs no modifier memorisation for the
    // common case.
    //
    // `event.key`, not `event.code`: these are layout-independent characters, and `code` would
    // put them on the wrong physical keys outside a US layout.
    if (event.key === ']') {
      event.preventDefault();
      onRestack?.(usesCommandKey ? 'front' : 'forward');
      return;
    }
    if (event.key === '[') {
      event.preventDefault();
      onRestack?.(usesCommandKey ? 'back' : 'backward');
      return;
    }

    // Checked before the zoom keys: the browser's own "save page" is the default action for
    // Ctrl+S, and letting it through would download the HTML rather than the document.
    if (usesCommandKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      onSave?.();
      return;
    }

    switch (event.key) {
      case '+':
      case '=':
        event.preventDefault();
        viewport.zoomIn();
        onZoomChanged?.();
        break;
      case '-':
      case '_':
        event.preventDefault();
        viewport.zoomOut();
        onZoomChanged?.();
        break;
      case '0':
        event.preventDefault();
        viewport.fit();
        onZoomChanged?.();
        break;
      case '1':
        if (!usesCommandKey) {
          event.preventDefault();
          viewport.zoomToActualSize();
          onZoomChanged?.();
        }
        break;
      default:
        break;
    }
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === 'Space') {
      viewport.setSpacePanning(false);
    }
  };

  // Releasing focus mid-hold would otherwise leave the pan cursor stuck on.
  const onBlur = (): void => viewport.setSpacePanning(false);

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
  };
}