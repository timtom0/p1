/**
 * The style UI's three singletons and the one place the shortcut path reaches them.
 *
 * ## Why a module rather than constructor parameters
 *
 * Because they are not the inspector's to own. The dialogs are `document.body`-level, they must
 * outlive any one panel instance, and the keyboard path needs the *actions* while the inspector
 * panel needs the *controls* -- two unrelated consumers of the same machinery. Threading three more
 * parameters through `mountInspector` for that would put them in the signature of every future
 * caller to solve a problem neither caller has.
 *
 * Built on first use rather than at module load, because `document` does not exist when this module
 * is first imported in a non-DOM context -- the same reason `mountDocumentSetupDialog` is a function
 * rather than a module-level constant.
 *
 * ## The shortcut handle
 *
 * `registerStyleActions` is how the panel publishes itself. The alternative -- the inspector
 * exporting a mutable `let` -- would make the dependency invisible, and a keyboard shortcut silently
 * doing nothing because the panel had not mounted yet is exactly the kind of thing that gets
 * "fixed" by adding a console log somewhere else.
 */

import { mountStyleDialogs, type StyleDialogs } from './style-dialog';
import { mountStyleEditor, type StyleEditor } from './style-editor';
import { mountToaster, type Toaster } from './toast';

export interface StyleUi {
  dialogs: StyleDialogs;
  styleEditor: StyleEditor;
  toaster: Toaster;
}

/** A panel's immediate, dialog-free action. Returns the toast message, or `null` if it did nothing. */
export type StyleShortcutAction = (mode: 'unlink' | 'remove') => string | null;

let built: StyleUi | null = null;
let registered: StyleShortcutAction | null = null;

export function styleUi(): StyleUi {
  built ??= {
    dialogs: mountStyleDialogs(),
    styleEditor: mountStyleEditor(),
    toaster: mountToaster(),
  };
  return built;
}

/**
 * Publishes the panel's action, returning a function that un-publishes it.
 *
 * The teardown function matters because the inspector is mounted more than once in the app's life
 * (a re-mount on a route or profile change would otherwise leave the *old* panel's closure wired to
 * the keyboard, acting on a document the user is no longer looking at).
 */
export function registerStyleActions(action: StyleShortcutAction): () => void {
  registered = action;
  return () => {
    if (registered === action) registered = null;
  };
}

/**
 * Runs the selection-level style action with no confirmation.
 *
 * Returns whether anything happened, so the caller can leave the keystroke to the browser when it
 * did not -- which matters because a shortcut that swallows a keystroke and does nothing is worse
 * than one that was never bound.
 */
export function runStyleShortcut(mode: 'unlink' | 'remove'): boolean {
  if (registered === null) return false;
  const message = registered(mode);
  if (message === null) return false;
  styleUi().toaster.show(message, { action: { label: 'Undo', run: () => registeredUndo?.() } });
  return true;
}

/**
 * Set by the shortcut binder, which is the only layer holding an `Editor`.
 *
 * Injected rather than imported so this module never depends on the editor layer's types, and so a
 * test can drive the shortcut without a live editor.
 */
let registeredUndo: (() => void) | null = null;

export function registerUndo(run: () => void): void {
  registeredUndo = run;
}