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
      }
      return;
    }

    if (isTypingTarget(event.target)) return;

    const command = event.ctrlKey || event.metaKey;

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
