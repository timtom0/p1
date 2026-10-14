/**
 * The style-management panel: pick a style, create one, edit one, unlink it, remove it, delete it.
 *
 * ## The three actions, and why they are three buttons and not one
 *
 * `Unlink` and `Remove` differ only in what happens to properties the user cannot see on the object
 * they are looking at -- one freezes them as direct formatting, the other lets them fall back to the
 * defaults. A single "Clear style" control would have to guess which the user meant, and a dialog
 * with two buttons would make every routine application pay for the distinction. Two buttons, each
 * with its own confirmation, puts the decision where the difference is visible.
 *
 * `Delete` is a *third* thing and is deliberately not in that group: it removes the definition, and
 * therefore has to settle references across the whole document rather than only the selection. The
 * requirement to keep those workflows apart is respected by the layout -- the two selection actions
 * sit together, and definition management is a separate row below them.
 *
 * ## Which category is in play
 *
 * The panel has three category tabs, and the tab decides what the picker lists and what the two
 * buttons act on. That is not a convenience. A run may only reference a character style, a
 * paragraph a paragraph style, and a frame a frame style, so "the style" is not one thing -- it is
 * three, and the reference site is what tells them apart.
 *
 * The keyboard path has no tab and does not need one: it acts on whatever the selection actually
 * references, at every site, because a user pressing a shortcut has said "the styles on this" rather
 * than "the paragraph style".
 *
 * ## What this panel never does
 *
 * It never shows a resolved value as if it were authored. Editing a definition edits the
 * definition; it does not restate what one particular object happens to resolve to. See the header
 * of `style-editor.ts` for why that distinction is the whole design.
 */

import { formatLength, parseLength } from '../core/units/units';
import { countStyleUsers } from '../model/style-commands';
import { documentReferences, resolveStyle } from '../model/styles';
import { el } from './dom';
import { STYLE_CATEGORY_LABEL } from './style-editor';
import type { StyleDialogs } from './style-dialog';
import type { Toaster } from './toast';
import type { StyleEditor } from './style-editor';
import type { Editor } from '../editor/editor';
import type { DocStore } from '../editor/store/doc-store';
import type { Command } from '../model/commands';
import type { StyleCategory } from '../model/styles';
import type { PhysicalUnit } from '../core/units/units';
import type { Document, Node, StyleDefinition } from '../model/types';

export interface StylesPanel {
  root: HTMLElement;
  /** Repaints from the current selection. Called from the inspector's `syncTextSection`. */
  sync: () => void;
  /**
   * The shortcut path: act at once, at every site the selection references, with no dialog.
   *
   * Returns the message for the toast, or `null` when there was nothing to do -- the caller then
   * shows nothing, because a toast saying "nothing happened" for a key pressed with nothing
   * selected is noise.
   */
  runImmediate: (mode: 'unlink' | 'remove') => string | null;
}

const CATEGORIES: readonly { value: StyleCategory; label: string }[] = [
  { value: 'frame', label: 'Frame' },
  { value: 'paragraph', label: 'Paragraph' },
  { value: 'character', label: 'Character' },
];

export function createStylesPanel(
  editor: Editor,
  store: DocStore,
  dialogs: StyleDialogs,
  styleEditor: StyleEditor,
  toaster: Toaster,
  unit: () => PhysicalUnit,
): StylesPanel {
  const root = el('div', { class: 'p1-styles', 'data-styles-panel': '' });

  const tabs = el('div', { class: 'p1-styles__tabs', role: 'group' });
  tabs.setAttribute('aria-label', 'Style category');
  const tabButtons = new Map<StyleCategory, HTMLButtonElement>();
  for (const category of CATEGORIES) {
    const button = el('button', { type: 'button', 'data-style-category': category.value }, category.label);
    tabButtons.set(category.value, button);
    tabs.append(button);
  }

  const picker = el('select', { class: 'p1-styles__select', 'data-style-select': '' });
  const newButton = el('button', { type: 'button', 'data-style-new': '' }, 'New');
  const editButton = el('button', { type: 'button', 'data-style-edit': '' }, 'Edit');

  const unlinkButton = el(
    'button',
    { type: 'button', class: 'p1-styles__action', 'data-style-unlink': '' },
    'Unlink Style',
  );
  const removeButton = el(
    'button',
    { type: 'button', class: 'p1-styles__action', 'data-style-remove': '' },
    'Remove Style',
  );
  const renameInput = el('input', {
    type: 'text',
    class: 'p1-styles__rename',
    'data-style-rename': '',
    spellcheck: 'false',
  });
  const deleteButton = el('button', { type: 'button', 'data-style-delete': '' }, 'Delete style');
  const note = el('p', { class: 'p1-inspector-note', 'data-style-note': '' });

  root.append(
    tabs,
    el('div', { class: 'p1-styles__picker' }, picker, newButton, editButton),
    el('div', { class: 'p1-styles__actions' }, unlinkButton, removeButton),
    el('div', { class: 'p1-styles__manage' }, renameInput, deleteButton),
    note,
  );

  /**
   * The tab currently shown.
   *
   * Held in a variable rather than read back off the DOM because four handlers need it and the
   * alternative is four queries that each have to trust the markup.
   */
  let category: StyleCategory = 'paragraph';

  // ---------------------------------------------------------------------------
  // Reading the selection
  // ---------------------------------------------------------------------------

  const selectionIds = (): string[] => [...editor.selectionState.ids];

  /**
   * The style the *selection* references at the current category.
   *
   * `null` for none, `undefined` for "more than one". A selection referencing two styles at one
   * site is genuinely ambiguous, and answering with either of them would be a lie -- so the picker
   * says `Mixed` and the definition buttons are disabled, because "unlink the Quote style" has no
   * answer until the user has said which style they meant.
   */
  const selectedStyle = (): StyleDefinition | null | undefined => {
    const ids = selectionIds();
    if (ids.length === 0) return null;
    const found = new Set<string>();
    let unresolved = 0;
    for (const reference of documentReferences(editor.doc)) {
      if (reference.kind !== category || !ids.includes(reference.nodeId)) continue;
      const style = resolveStyle(editor.doc.styles, reference.styleId, category);
      if (style === undefined) unresolved += 1;
      else found.add(style.id);
    }
    if (found.size > 1) return undefined;
    if (found.size === 0) return unresolved > 0 ? undefined : null;
    const id = [...found][0];
    return id === undefined ? null : resolveStyle(editor.doc.styles, id, category) ?? null;
  };

  /** Distinct selected objects carrying `styleId`, which is what a user counts as "objects". */
  const objectsUsing = (styleId: string): number => {
    if (styleId === '') return 0;
    const ids = selectionIds();
    const nodes = new Set<string>();
    for (const reference of documentReferences(editor.doc)) {
      if (reference.styleId === styleId && ids.includes(reference.nodeId)) nodes.add(reference.nodeId);
    }
    return nodes.size;
  };

  /**
   * Whether the selection's only references at this category point at styles the document does not
   * have.
   *
   * The deserializer deliberately preserves unresolved references so a document with a missing style
   * round-trips losslessly, and recovery is a later edit rather than a save-time rewrite. That is
   * right for the model, but it means the panel can be looking at an object referencing nothing --
   * and reporting that as "None" would be a control quietly lying about the document.
   */
  const hasUnresolved = (): boolean => {
    const ids = selectionIds();
    return documentReferences(editor.doc).some(
      (reference) =>
        reference.kind === category &&
        ids.includes(reference.nodeId) &&
        resolveStyle(editor.doc.styles, reference.styleId, category) === undefined,
    );
  };

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  /**
   * The selection action for one named style at one site, behind its confirmation.
   *
   * The dialog is told how many of the selected objects actually carry the reference, because a
   * selection of five objects where one uses the style is a different action from one where all five
   * do -- and a dialog that says "these 5 objects" when it means one of them is asking for consent to
   * something the user did not ask for.
   */
  const runSelectionAction = async (mode: 'unlink' | 'remove', style: StyleDefinition): Promise<void> => {
    const ids = selectionIds();
    if (ids.length === 0) return;
    const objects = objectsUsing(style.id);
    if (objects === 0) return;

    const confirmed = await dialogs.confirmSelectionAction({
      mode,
      styleName: style.name,
      categoryLabel: STYLE_CATEGORY_LABEL[category],
      objects,
      references: countStyleUsers(editor.doc, ids, style.id),
      partialSelection: objects < ids.length,
    });
    if (!confirmed) return;

    // Re-read the selection at commit time. The dialog is modal, so the selection cannot change
    // while it is open -- but acting on a captured id list would still be fragile in a way that costs
    // one array construction to avoid.
    const now = selectionIds();
    store.mutate(mode === 'unlink' ? 'Unlink style' : 'Remove style', () => ({
      type: 'unlinkStyle',
      ids: now,
      category,
      styleId: style.id,
      mode,
    }));
  };

  /**
   * The shortcut path: act on **every** category the selection references, batched into one command
   * so the whole gesture is a single undo step. That is the difference between "unlink the styles on
   * this" and three undo presses to reverse.
   */
  const runImmediate = (mode: 'unlink' | 'remove'): string | null => {
    const ids = selectionIds();
    if (ids.length === 0) return null;

    const commands: Command[] = [];
    const names: string[] = [];
    for (const candidate of CATEGORIES) {
      const seen = new Set<string>();
      for (const reference of documentReferences(editor.doc)) {
        if (reference.kind !== candidate.value || !ids.includes(reference.nodeId)) continue;
        const style = resolveStyle(editor.doc.styles, reference.styleId, candidate.value);
        if (style === undefined || seen.has(style.id)) continue;
        seen.add(style.id);
        names.push(style.name);
        commands.push({ type: 'unlinkStyle', ids, category: candidate.value, styleId: style.id, mode });
      }
    }
    if (commands.length === 0) return null;

    const label = mode === 'unlink' ? 'Unlink style' : 'Remove style';
    store.mutate(
      commands.length === 1 ? label : `${label} (${commands.length} styles)`,
      () => (commands.length === 1 ? commands[0]! : { type: 'batch', cmds: commands }),
    );

    return mode === 'unlink'
      ? `Unlinked ${listOf(names)}. That formatting is now direct and will not follow the style.`
      : `Removed ${listOf(names)}. Formatting the style supplied has fallen back to the default.`;
  };

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  for (const [value, button] of tabButtons) {
    button.addEventListener('click', () => {
      category = value;
      sync();
    });
  }

  picker.addEventListener('change', () => {
    const ids = selectionIds();
    if (ids.length === 0) return;
    // The null form is `applyStyle` with no id, which *is* the remove semantics: clear the
    // reference, keep direct formatting, do not materialize. One command, one meaning.
    store.mutate(picker.value === '' ? 'Remove style' : 'Apply style', () => ({
      type: 'applyStyle',
      ids,
      category,
      styleId: picker.value === '' ? null : picker.value,
    }));
  });

  newButton.addEventListener('click', () => {
    void (async () => {
      const built = await styleEditor.open({
        existing: null,
        category,
        suggestedName: suggestedName(editor.doc, category),
        formatLength: (value) => formatLength(value, unit()),
        parseLength: (raw) => {
          const hasUnit = /[a-z]+\s*$/i.test(raw.trim());
          return parseLength(hasUnit ? raw : `${raw}${unit()}`) ?? undefined;
        },
      });
      if (built === null) return;
      const ids = selectionIds();
      // Create *and* apply, because a style nothing references is a style nobody can see, and the
      // user who pressed "New" beside a selected object meant it for that object. Both are one undo
      // step, so a mis-typed name is one Ctrl+Z away from being fixed.
      store.mutate(`Create style ${built.name}`, () => ({
        type: 'batch',
        cmds: [
          { type: 'addStyle', style: built },
          ...(ids.length === 0 ? [] : [{ type: 'applyStyle' as const, ids, category, styleId: built.id }]),
        ],
      }));
    })();
  });

  editButton.addEventListener('click', () => {
    void (async () => {
      const style = selectedStyle();
      if (style === null || style === undefined) return;
      const built = await styleEditor.open({
        existing: style,
        category: style.kind,
        suggestedName: style.name,
        formatLength: (value) => formatLength(value, unit()),
        parseLength: (raw) => {
          const hasUnit = /[a-z]+\s*$/i.test(raw.trim());
          return parseLength(hasUnit ? raw : `${raw}${unit()}`) ?? undefined;
        },
      });
      if (built === null) return;
      // `updateStyle` replaces rather than merges, so a property cleared in the dialog stops being
      // supplied. Editing propagates to every reference in the document with no reapplication -- which
      // is the entire reason the reference is stored separately from the object's own values.
      store.mutate(`Edit style ${built.name}`, () => ({ type: 'updateStyle', id: style.id, style: built }));
    })();
  });

  unlinkButton.addEventListener('click', () => {
    const style = selectedStyle();
    if (style === null || style === undefined) return;
    void runSelectionAction('unlink', style);
  });

  removeButton.addEventListener('click', () => {
    const style = selectedStyle();
    if (style === null || style === undefined) return;
    void runSelectionAction('remove', style);
  });

  const commitRename = (): void => {
    const style = selectedStyle();
    const wanted = renameInput.value.trim();
    renameInput.value = '';
    if (style === null || style === undefined) return;
    // Discarding rather than committing: a rename to the existing name is not a rename, and recording
    // one would put a no-op in the undo history under a label describing a change.
    if (wanted === '' || wanted === style.name) return;
    // `renameStyle` touches `name` and nothing else, which is why renaming cannot break a
    // reference: references are ids.
    store.mutate('Rename style', () => ({ type: 'renameStyle', id: style.id, name: wanted }));
  };

  renameInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    commitRename();
  });
  renameInput.addEventListener('blur', () => commitRename());

  deleteButton.addEventListener('click', () => {
    void (async () => {
      const style = selectedStyle();
      if (style === null || style === undefined) return;
      const references = countStyleUsers(editor.doc, allNodeIds(editor.doc), style.id);
      const choice = await dialogs.confirmDeletion({ styleName: style.name, references });
      if (choice === null) return;
      // One command for the whole document. `deleteStyle` already settles every reference in a
      // single pass, so this is one undo step restoring the definition, every reference, and every
      // direct value it rewrote.
      store.mutate(
        choice === 'unlink' ? 'Unlink style and delete' : 'Delete style',
        () => ({ type: 'deleteStyle', id: style.id, mode: choice }),
      );
      toaster.show(
        choice === 'unlink'
          ? `Deleted "${style.name}". Every reference became direct formatting, so nothing moved.`
          : `Deleted "${style.name}". Formatting it supplied has fallen back to the default.`,
        { action: { label: 'Undo', run: () => editor.undo() } },
      );
    })();
  });

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------

  function sync(): void {
    for (const [value, button] of tabButtons) {
      button.dataset['active'] = String(value === category);
    }

    const chosen = selectedStyle();
    const styles = editor.doc.styles.filter((style) => style.kind === category);

    if (chosen === undefined && hasUnresolved()) {
      // The model preserved a reference to a style that is not in the document. Say so; do not
      // present it as "None", and do not drop the reference to make the panel tidy.
      picker.replaceChildren(
        el('option', { value: '' }, `Missing ${STYLE_CATEGORY_LABEL[category].toLowerCase()} style`),
      );
      picker.value = '';
    } else {
      picker.replaceChildren(
        el('option', { value: '' }, chosen === undefined ? 'Mixed' : 'None'),
        ...styles.map((style) => el('option', { value: style.id }, style.name)),
      );
      picker.value = chosen === null || chosen === undefined ? '' : chosen.id;
    }

    const single = chosen !== null && chosen !== undefined;
    const used = single ? objectsUsing(chosen.id) : 0;
    editButton.disabled = !single;
    // Unlink and Remove are only offered when the *selection* carries the style, which is the
    // distinction from Delete and the reason Delete is not here: Delete always reaches the whole
    // document, and these two never do.
    unlinkButton.disabled = used === 0;
    removeButton.disabled = used === 0;
    deleteButton.disabled = !single;
    renameInput.disabled = !single;
    renameInput.placeholder = single ? 'Rename' : 'Style name';

    note.textContent = single
      ? 'Editing this style changes every object that uses it, immediately.'
      : chosen === undefined && selectionIds().length > 0
        ? 'The selection uses more than one style here. Pick one from the list above.'
        : '';
  }

  return { root, sync, runImmediate };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listOf(names: readonly string[]): string {
  if (names.length === 1) return `"${names[0]}"`;
  return `${names.slice(0, -1).map((name) => `"${name}"`).join(', ')} and "${names[names.length - 1]}"`;
}

/** `New paragraph style`, `New paragraph style 2`, ... so a second click does not collide. */
function suggestedName(doc: Document, category: StyleCategory): string {
  const base = `New ${STYLE_CATEGORY_LABEL[category].toLowerCase()} style`;
  const taken = new Set(doc.styles.map((style) => style.name));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

/**
 * Every object id in the document, groups included.
 *
 * `deleteStyle` settles references wherever they are, so the count shown in the deletion dialog has
 * to cover wherever they are too -- including inside a group, which is exactly where a count written
 * against `page.objects` would under-report and make the dialog promise less than the command does.
 */
function allNodeIds(doc: Document): string[] {
  const ids: string[] = [];
  const walk = (nodes: readonly Node[]): void => {
    for (const node of nodes) {
      ids.push(node.id);
      if (node.type === 'group') walk(node.children);
    }
  };
  for (const page of doc.pages) walk(page.objects);
  return ids;
}