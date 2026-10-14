/**
 * The two style confirmations, kept in one file because they share a rule.
 *
 * ## The rule
 *
 * **Never silently choose the discards-formatting option.** Every dialog here either offers both
 * readings explicitly, or -- where there is only one thing to do -- says what that thing does.
 *
 * The temptation this guards against is real, and it is a *convenience* temptation: defaulting a
 * choice so the common case needs one keystroke. The common case is not knowable in advance. The
 * user who pressed Remove on a title they are about to restyle and the user who pressed it on a
 * title they have already restyled want opposite outcomes, and the dialog cannot tell them apart.
 *
 * ## Why two dialogs rather than one with a flag
 *
 * Because they ask *different questions*, and collapsing them makes one answer wrong:
 *
 *  - the selection dialog asks "are you sure about these N objects?", and the answer is already
 *    decided by the button the user pressed. It confirms; it does not choose.
 *  - the deletion dialog asks "what happens to M references elsewhere in the document?", and that
 *    answer genuinely is not yet decided, because the definition is going away either way.
 *
 * A single dialog with a scope flag would put the deletion case's two-choice control beside a single
 * Confirm button in the selection case, and a reader would not know whether the second button was
 * missing or merely out of scope.
 */

import { el } from './dom';

/** How a definition's references are settled when the definition itself goes away. */
export type DeletionChoice = 'unlink' | 'remove';

export interface SelectionActionRequest {
  /** What the user asked for: preserve appearance, or discard inherited values. */
  mode: 'unlink' | 'remove';
  styleName: string;
  /** `Paragraph`, `Character` or `Frame` -- the site the style applies at. */
  categoryLabel: string;
  /** How many of the selected objects actually carry the reference. */
  objects: number;
  /** How many references those objects hold; a frame's paragraphs each count separately. */
  references: number;
  /** Whether a selected object exists that does *not* carry the reference. */
  partialSelection: boolean;
}

export interface DeletionRequest {
  styleName: string;
  /** References across the whole document. Zero means the dialog is a plain confirmation. */
  references: number;
}

export interface StyleDialogs {
  confirmSelectionAction: (request: SelectionActionRequest) => Promise<boolean>;
  confirmDeletion: (request: DeletionRequest) => Promise<DeletionChoice | null>;
}

const SELECTION_UNLINK = 'selection:unlink';
const SELECTION_REMOVE = 'selection:remove';
const DELETE_PLAIN = 'delete:plain';
const DELETE_UNLINK = 'delete:unlink';
const DELETE_REMOVE = 'delete:remove';

/**
 * Built once and reused, for the reason `document-setup.ts` gives: a fresh dialog per open loses
 * focus on every cancel and re-runs the whole construction to say the same thing.
 */
export function mountStyleDialogs(): StyleDialogs {
  const selection = buildDialog('selection');
  const deletion = buildDialog('deletion');
  document.body.append(selection.root, deletion.root);

  const askSelection = (request: SelectionActionRequest): Promise<string | null> => {
    const body = el('div', { class: 'p1-style-dialog__body' });
    body.append(el('p', { class: 'p1-style-dialog__text' }, SELECTION_TEXT[request.mode]));
    body.append(el('p', { class: 'p1-style-dialog__text p1-style-dialog__text--aside' }, scope(request)));
    if (request.partialSelection) {
      // Said explicitly, because the plausible wrong reading is "this is about everything that
      // uses the style" -- and unlike the deletion case, that reading happens to be false here.
      body.append(
        el(
          'p',
          { class: 'p1-style-dialog__text p1-style-dialog__text--aside' },
          'Only the selected objects change. Objects you did not select keep their reference to the style.',
        ),
      );
    }
    body.append(el('p', { class: 'p1-style-dialog__text p1-style-dialog__text--aside' }, 'This can be undone.'));

    const value = request.mode === 'unlink' ? SELECTION_UNLINK : SELECTION_REMOVE;
    return ask(selection, {
      value,
      title: `${request.mode === 'unlink' ? 'Unlink' : 'Remove'} "${request.styleName}"?`,
      body,
      confirmLabel: request.mode === 'unlink' ? 'Unlink style' : 'Remove style',
      choice: null,
    });
  };

  const askDeletion = (request: DeletionRequest): Promise<string | null> => {
    const body = el('div', { class: 'p1-style-dialog__body' });
    body.append(
      el(
        'p',
        { class: 'p1-style-dialog__text' },
        request.references === 0
          ? 'This style is not used anywhere in the document, so nothing else will change.'
          : `This style is used in ${request.references === 1 ? '1 place' : `${request.references} places`} in the document. All of ${request.references === 1 ? 'it' : 'them'} must be dealt with: a reference to a style that no longer exists cannot be resolved.`,
      ),
    );
    if (request.references > 0) {
      body.append(
        el(
          'p',
          { class: 'p1-style-dialog__text p1-style-dialog__text--aside' },
          'This reaches the whole document, not just what is selected.',
        ),
      );
    }

    // With no references there is nothing to settle, so the choice is not offered at all. Asking it
    // would be asking about a document state that cannot occur.
    const choice =
      request.references === 0
        ? null
        : {
            unlink: { label: 'Unlink and Delete', consequence: DELETE_UNLINK_TEXT },
            remove: { label: 'Remove Style and Delete', consequence: DELETE_REMOVE_TEXT },
          };

    return ask(deletion, {
      value: DELETE_PLAIN,
      title: `Delete "${request.styleName}"?`,
      body,
      confirmLabel: 'Delete style',
      choice,
    });
  };

  return {
    confirmSelectionAction: async (request) => (await askSelection(request)) !== null,
    confirmDeletion: async (request) => {
      const value = await askDeletion(request);
      if (value === null) return null;
      if (value === DELETE_UNLINK) return 'unlink';
      if (value === DELETE_REMOVE) return 'remove';
      // The plain-confirmation path, and the one-keypress answer to the selection dialog's
      // confirmation. `unlink` here would be the "preserve appearance" reading, which is the one a
      // user who has just been told "nothing else will change" is entitled to expect.
      return value === DELETE_PLAIN ? 'unlink' : null;
    },
  };
}

/**
 * The two texts, written out rather than assembled from a template.
 *
 * Both say which way the document gets -- larger for unlink, smaller for remove -- because that is
 * the part a user can least predict from the button label, and it is the difference between the two
 * options once they are chosen.
 */
const SELECTION_TEXT: Record<'unlink' | 'remove', string> = {
  unlink:
    'The values the style supplies become direct formatting on the selected objects, and the ' +
    'reference is dropped. They will look exactly as they do now, and the document gets larger. ' +
    'Editing the style afterwards will no longer change them.',
  remove:
    'The reference is dropped and the objects keep only the direct formatting they already had. ' +
    'Anything that came from the style falls back to the default, so they will probably look ' +
    'different and the document gets smaller. Your own overrides are kept.',
};

const DELETE_UNLINK_TEXT =
  'Every object using this style keeps its appearance: its current effective values become direct ' +
  'formatting, its reference is dropped, and the style is deleted. The document gets larger.';

const DELETE_REMOVE_TEXT =
  'Every object using this style keeps only the direct formatting it already had. Its reference is ' +
  'dropped and the style is deleted, so anything the style supplied falls back to the default and ' +
  'the document gets smaller. Objects will probably look different.';

function scope(request: SelectionActionRequest): string {
  const sites =
    request.references === 1 ? 'in 1 place' : `in ${request.references} places`;
  const objects =
    request.objects === 1 ? '1 selected object' : `${request.objects} selected objects`;
  return `${request.categoryLabel} style, used ${sites} across ${objects}.`;
}

interface ChoiceCopy {
  label: string;
  consequence: string;
}

interface DialogParts {
  root: HTMLDialogElement;
  title: HTMLElement;
  body: HTMLElement;
  cancel: HTMLButtonElement;
  confirm: HTMLButtonElement;
  choices: HTMLElement;
  unlinkButton: HTMLButtonElement;
  removeButton: HTMLButtonElement;
  unlinkConsequence: HTMLElement;
  removeConsequence: HTMLElement;
}

/**
 * One dialog, built for both roles.
 *
 * The two-choice control is present in the markup and hidden when unused rather than added and
 * removed, because its presence changes the actions row's layout: a dialog whose action row reflows
 * between opens is a dialog whose buttons move under the pointer.
 */
function buildDialog(role: 'selection' | 'deletion'): DialogParts {
  const root = document.createElement('dialog');
  root.className = 'p1-style-dialog';
  root.dataset['styleDialog'] = role;

  const title = el('h2', { class: 'p1-style-dialog__title' });
  const body = el('div', {});
  const unlinkButton = el('button', {
    type: 'button',
    class: 'p1-style-dialog__choice-button',
    'data-style-choice': 'unlink',
  });
  const removeButton = el('button', {
    type: 'button',
    class: 'p1-style-dialog__choice-button',
    'data-style-choice': 'remove',
  });
  const unlinkConsequence = el('p', { class: 'p1-style-dialog__consequence' });
  const removeConsequence = el('p', { class: 'p1-style-dialog__consequence' });
  const choices = el(
    'div',
    { class: 'p1-style-dialog__choices' },
    el(
      'div',
      { class: 'p1-style-dialog__choice' },
      unlinkButton,
      el('p', { class: 'p1-style-dialog__choice-label' }, 'Keeps every object looking the same'),
      unlinkConsequence,
    ),
    el(
      'div',
      { class: 'p1-style-dialog__choice' },
      removeButton,
      el('p', { class: 'p1-style-dialog__choice-label' }, 'Keeps only direct formatting'),
      removeConsequence,
    ),
  );

  const cancel = el('button', { type: 'button', 'data-style-cancel': '' }, 'Cancel');
  const confirm = el('button', { type: 'button', 'data-style-confirm': '' });

  root.append(
    el(
      'form',
      { class: 'p1-style-dialog__form' },
      title,
      body,
      choices,
      el('div', { class: 'p1-style-dialog__actions' }, cancel, confirm),
    ),
  );

  return {
    root,
    title,
    body,
    cancel,
    confirm,
    choices,
    unlinkButton,
    removeButton,
    unlinkConsequence,
    removeConsequence,
  };
}

/**
 * Runs `parts` with the given content and resolves its `returnValue`.
 *
 * `returnValue` is the *submitter's* value, so Escape -- which fires `close` with no submitter --
 * and Cancel both arrive as the empty string. This is the same cancellation contract
 * `document-setup.ts` uses rather than a second convention.
 */
function ask(
  parts: DialogParts,
  content: {
    value: string;
    title: string;
    body: HTMLElement;
    confirmLabel: string;
    choice: { unlink: ChoiceCopy; remove: ChoiceCopy } | null;
  },
): Promise<string | null> {
  parts.title.textContent = content.title;
  parts.body.replaceChildren(content.body);
  parts.confirm.textContent = content.confirmLabel;
  parts.choices.hidden = content.choice === null;

  const unlink = content.choice?.unlink;
  parts.unlinkButton.textContent = unlink?.label ?? '';
  parts.unlinkConsequence.textContent = unlink?.consequence ?? '';
  parts.removeButton.textContent = content.choice?.remove.label ?? '';
  parts.removeConsequence.textContent = content.choice?.remove.consequence ?? '';

  return new Promise((resolve) => {
    const onClose = (): void => {
      parts.root.removeEventListener('close', onClose);
      const value = parts.root.returnValue;
      resolve(value === '' ? null : value);
    };

    const settle = (value: string) => (): void => parts.root.close(value);
    parts.confirm.onclick = settle(content.value);
    parts.cancel.onclick = settle('');
    parts.unlinkButton.onclick = unlink === undefined ? null : settle('delete:unlink');
    parts.removeButton.onclick =
      content.choice === null ? null : settle('delete:remove');

    parts.root.addEventListener('close', onClose);
    parts.root.showModal();
    // Focus `confirm`, which is never one of the two choice buttons. Enter must not be able to fall
    // into a branch by reflex, and in the deletion dialog one of those branches is the one that
    // discards formatting.
    parts.confirm.focus();
  });
}