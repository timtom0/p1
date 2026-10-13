/**
 * Editing shortcuts (§3.3), split from the navigation map for the same reason that
 * one exists: a key map should be a readable table, not a switch buried in
 * composition code.
 *
 * ## Ctrl+Z has two targets, and that is not a bug
 *
 * Undo dispatches to the text session when one is open and to the application
 * history otherwise. See [ADR 0002](../../../../docs/adr/0002-text-undo-composition.md).
 * The shortcut layer therefore knows *that* the rule exists but not *why* — the
 * routing lives in `Editor.undo`, which is the only place that can see both.
 *
 * ## Guarding
 *
 * Keystrokes are ignored while a form control or a `contenteditable` has focus.
 * Without that guard, pressing Backspace to edit text would delete the selected
 * object and pressing "1" in an inspector field would resize something.
 */

import type { Editor } from '../../editor/editor';
import type { ShapeKind } from '../../model/types';
import type { CharFlag } from '../../model/rich-text';

/**
 * The character-formatting flag a keystroke means, or `null` for a key that means none.
 *
 * `event.key`, not `event.code`, for the reason `shortcuts.ts` gives: these are characters and
 * `code` would put them on the wrong physical keys outside a US layout.
 *
 * Alt is refused everywhere. Alt+B/I/U/X are browser and OS chords -- bookmarks, Firefox's reader
 * mode -- and an editor that swallows them breaks the user without adding anything.
 *
 * **Ctrl+X is not strikethrough; Ctrl+Shift+X is.** Plain Ctrl+X is cut, which every editor
 * provides and this one does not, so binding it would take away an operation to add a cosmetic one.
 * Chromium uses Ctrl+Shift+X for strikethrough, so the modifier matches the platform convention
 * rather than inventing one.
 *
 * **Superscript and subscript follow Chromium's own chords**, Ctrl+Shift+. and Ctrl+Shift+,,
 * because those are the ones that exist in every other editor on the platform. They are read off
 * `event.code` rather than `event.key`, which is the single departure from the rule above: the two
 * chords are defined by their *punctuation keys*, and `Shift+.` produces a different `key` on every
 * layout. Using `key` here would make the shortcut work on a US keyboard and nowhere else, which is
 * the exact failure `shortcuts.ts` warns against. `Period` and `Comma` are the physical keys; shift
 * is checked separately so an unmodified Ctrl+, (which browsers do not reserve) stays unbound.
 */
function characterFormatFlag(event: KeyboardEvent): CharFlag | null {
  if (event.altKey) return null;

  if (event.ctrlKey && event.shiftKey) {
    switch (event.code) {
      case 'Period':
        return 'super';
      case 'Comma':
        return 'sub';
      default:
        break;
    }
  }

  switch (event.key.toLowerCase()) {
    case 'b':
      return 'bold';
    case 'i':
      return 'italic';
    case 'u':
      return 'underline';
    case 'x':
      return event.shiftKey ? 'strike' : null;
    default:
      return null;
  }
}

/**
 * Which flags Chromium applies itself, with no chord of its own needed.
 *
 * Exists to answer one question: inside a text session, is this keystroke already handled? For
 * bold, italic and underline it is -- the browser binds Ctrl+B/I/U in a contenteditable and runs
 * `execCommand` before this handler is even consulted. Calling ours as well would toggle the format
 * back off, which reads as "the shortcut does nothing".
 *
 * Everything else is absent from this map, which means *not* handled: Chromium binds no chord for
 * strikethrough, superscript or subscript, so those must be forwarded or they never fire.
 */
const BROWSER_OWNS: Readonly<Record<CharFlag, boolean>> = {
  bold: true,
  italic: true,
  underline: true,
  strike: false,
  super: false,
  sub: false,
};

export interface EditingShortcutOptions {
  editor: Editor;
  /** Nudge distance in document px. Shift multiplies it by ten. */
  nudge?: number;
}

export function bindEditingShortcuts({ editor, nudge = 1 }: EditingShortcutOptions): () => void {
  const base = nudge;

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
    // Inside a text session the browser owns the keyboard almost entirely. Only the
    // keys that end the session are handled here, and only because the browser has
    // no way to signal "leave this frame" to the application.
    if (editor.currentMode === 'textEdit') {
      if (event.key === 'Escape') {
        event.preventDefault();
        editor.endTextEdit();
        return;
      }

      // Chromium owns Ctrl+B/I/U inside a contenteditable and applies them to the live selection
      // itself, so re-dispatching them would toggle the format straight back off. Those three are
      // therefore left alone -- which is exactly what the early return above used to mean for every
      // flag.
      //
      // The others it does *not* own. Chromium has no superscript, subscript or strikethrough chord
      // in a contenteditable, so for those the keystroke would simply vanish: a shortcut the
      // inspector advertises and the user tries, doing nothing. They are forwarded to
      // `applyInlineFormat`, which inside a session is `execCommand` against the browser -- the same
      // call the inspector buttons make, so there is still one implementation per behaviour.
      const inside = characterFormatFlag(event);
      if ((event.ctrlKey || event.metaKey) && inside !== null && !BROWSER_OWNS[inside]) {
        event.preventDefault();
        const frameId = editor.selectionState.primary;
        if (frameId !== null) editor.textSession?.applyInlineFormat(inside, frameId);
      }
      return;
    }


    const command = event.ctrlKey || event.metaKey;
    // ---- character formatting ----------------------------------------------
    //
    // Checked *before* the typing-target guard below, because the two cases want opposite
    // treatment and lumping them together is a real bug rather than a tidiness question.
    //
    // Inside a text session this is unreachable: the early return above has already handed the
    // keyboard back, and Ctrl+B/I/U reach the browser, which applies them to the live selection with
    // `execCommand`. So there is exactly one implementation of "bold the selection" and it is not
    // this one.
    //
    // Everywhere else the browser's own chord is worse than nothing: Ctrl+U opens view-source and
    // Ctrl+B opens the bookmarks sidebar. That is true even inside an inspector field, where this
    // must not *apply* anything -- pressing Ctrl+B while typing a colour should not bold a text
    // frame, and it should equally not navigate the user out of the document. So the default is
    // suppressed unconditionally, and the toggle only runs when the keystroke was not aimed at a
    // form control.
    //
    // Routed through `TextSessionController.applyInlineFormat` rather than a direct `setText`,
    // because that method already encodes the session-versus-model distinction this milestone says
    // to preserve, and it is the same call the inspector's B/I/U/S buttons make. A shortcut doing
    // its own thing would be a second implementation to keep in step with the buttons.
    const flag = characterFormatFlag(event);
    if (command && flag !== null) {
      event.preventDefault();
      if (isTypingTarget(event.target)) return;
      const frameId = editor.selectionState.primary;
      if (frameId !== null) editor.textSession?.applyInlineFormat(flag, frameId);
      return;
    }

    if (isTypingTarget(event.target)) return;


    // ---- history ----------------------------------------------------------
    if (command && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) editor.redo();
      else editor.undo();
      return;
    }
    if (command && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      editor.redo();
      return;
    }

    // ---- selection --------------------------------------------------------
    if (command && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      editor.selectAll();
      return;
    }

    // ---- character formatting ----------------------------------------------
    //
    if (event.key === 'Escape') {
      if (editor.isGesturing) {
        event.preventDefault();
        editor.cancelGesture();
      } else if (editor.currentMode === 'draw') {
        // Escape backs out of the armed tool, in that order: an in-flight gesture is
        // about to become an object, an armed tool is about to make one, and the
        // selection is merely about what is highlighted. So the most consequential
        // thing Escape can undo is handled first — and only one of them fires, rather
        // than Escape both dropping the tool and clearing the selection.
        event.preventDefault();
        editor.disarmDrawTool();
      } else if (editor.leaveGroupScope()) {
        // Inside a group, Escape leaves the group before it clears the selection.
        //
        // Ordered above the selection for the same reason the draw tool is: the most consequential
        // thing Escape can undo fires first, and only one of them does. Leaving a group *is* undoing
        // "I am inside this group", which is a bigger change than what is highlighted -- and clearing
        // the selection first would leave the user inside a group with nothing selected, which is the
        // most confusing of the three possible outcomes.
        event.preventDefault();
      } else {
        editor.clearSelection();
      }
      return;
    }

    // ---- grouping ----------------------------------------------------------
    // Both are plain chords with no modifier, chosen to sit beside Enter (which opens a text session)
    // in the same block rather than in a menu, because there is no menu in this milestone.
    if (event.ctrlKey || event.metaKey) {
      if (event.key.toLowerCase() === 'g') {
        event.preventDefault();
        if (event.shiftKey) editor.ungroupSelection();
        else editor.groupSelection();
        return;
      }
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const primary = editor.selectionState.primary;
      if (primary !== null) editor.beginTextEdit(primary);
      return;
    }

    // ---- tools -------------------------------------------------------------
    // The four tool buttons have always advertised these keys in their `title`, and nothing bound
    // them -- the titles were a promise the app did not keep. Binding them here rather than in
    // `shortcuts.ts` is what makes the behaviour correct: this is the half that knows about text
    // sessions, and the early return above means a keypress cannot arm a tool while text is being
    // edited. `shortcuts.ts` has no such guard, so putting it there would let "r" swap the tool out
    // from under an open text session.
    if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      const tool = TOOL_KEYS[event.key.toLowerCase()];
      if (tool !== undefined) {
        event.preventDefault();
        if (tool === 'select') editor.disarmDrawTool();
        else editor.armDrawTool(tool);
        return;
      }
    }

    // ---- deletion ---------------------------------------------------------
    if (event.key === 'Delete' || event.key === 'Backspace') {
      const ids = [...editor.selectionState.ids];
      if (ids.length === 0) return;
      event.preventDefault();
      editor.deleteSelection(ids);
      return;
    }

    // ---- nudge ------------------------------------------------------------
    // Shift is a ten-fold step; alt locks to the dominant axis. Assigning them
    // separately keeps each modifier meaning exactly one thing.
    const step = event.shiftKey ? base * NUDGE_MULTIPLIER : base;
    const delta = arrowDelta(event.key, step);
    if (delta === null) return;
    const ids = [...editor.selectionState.ids];
    if (ids.length === 0) return;

    event.preventDefault();
    editor.nudge(ids, delta, event.altKey);
  };

  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}

/** Shift-nudges ten times further, matching every other editor. */
const NUDGE_MULTIPLIER = 10;

/**
 * The tool each plain letter arms, matching the toolbar buttons' `title` attributes.
 *
 * `select` is spelled as the *absence* of a draw tool rather than a kind, because
 * `disarmDrawTool` is what the Select button calls and the two must not diverge.
 *
 * Matched on `key.toLowerCase()`, so the bindings survive a non-QWERTY layout: `event.code` would
 * put them on the wrong physical keys, which is the same reason the layer-order ladder above uses
 * `key` rather than `code`.
 */
const TOOL_KEYS: Readonly<Record<string, ShapeKind | 'select'>> = {
  v: 'select',
  r: 'rect',
  e: 'ellipse',
  l: 'line',
};

function arrowDelta(key: string, step: number): { x: number; y: number } | null {
  switch (key) {
    case 'ArrowLeft':
      return { x: -step, y: 0 };
    case 'ArrowRight':
      return { x: step, y: 0 };
    case 'ArrowUp':
      return { x: 0, y: -step };
    case 'ArrowDown':
      return { x: 0, y: step };
    default:
      return null;
  }
}
