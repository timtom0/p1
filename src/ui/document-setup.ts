/**
 * Document setup: the dialog that decides what a new document is.
 *
 * ## Why a dialog and not a panel
 *
 * The pages panel edits the *current* document. This decides the *next* one, and it has to be a
 * separate gesture because the two answers are not the same question: "what size is this page" and
 * "what size will my pages be" only coincide until the user resizes something. A dialog also gets
 * focus trapping, Escape and backdrop dismissal from the platform, which a panel would have to
 * reimplement.
 *
 * ## Pre-filled from the current document
 *
 * The dialog opens showing the open document's setup rather than the factory defaults. A user who has
 * been working in A5 and then presses "New" almost always wants A5 again, and silently handing them
 * A4 is the kind of default that gets noticed only when a print comes out wrong. Changing a setting
 * here therefore does not have to be repeated to make it stick across new documents -- but it still
 * starts from the current one.
 *
 * ## `fixedSize` is labelled for what it does
 *
 * The obvious reading of "Fixed page size" is a constraint on every page, and it is not one. It
 * decides the size of *newly added* pages. The helper text under the box says so explicitly, because a
 * user who believes the constraint holds will resize a page, see the document become mixed, and
 * conclude the checkbox is broken.
 */

import { createDocument } from '../model/factory';
import { createPageSetup, PAGE_RESIZE_BEHAVIOURS, PAGE_SIZE_PRESETS, clonePageSize, type PageResizeBehaviour } from '../model/page-setup';
import { isPhysicalUnit, type PhysicalUnit } from '../core/units/units';
import type { Document, PageSize } from '../model/types';

const RESIZE_LABELS: Record<PageResizeBehaviour, string> = {
  crop: 'Crop — leave objects where they are',
  push: 'Push — move what no longer fits to the next page',
  scale: 'Scale — shrink content to fit the new page',
};

/**
 * A minimal element builder: `el('button', { type: 'button' }, 'Add')`.
 *
 * Variadic children rather than a single `text` argument because most of this panel is small trees
 * -- a row that is a button containing two spans -- and an `el` that took one string would need an
 * `append` after every nested element. Strings become text nodes, so a child is either an `HTMLElement`
 * or a string and never a bare value that could be stringified by accident.
 */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}


export interface DocumentSetupDialog {
  /** Opens the dialog, pre-filled from `current`. Resolves with the new document, or `null` if cancelled. */
  open: (current: Document) => Promise<Document | null>;
}

/**
 * Builds the dialog once and reuses it.
 *
 * A fresh dialog per open would lose focus on every cancel and re-run the whole construction for what
 * is a handful of nodes; the state that matters is read from `current` on each open instead.
 */
export function mountDocumentSetupDialog(): DocumentSetupDialog {
  const dialog = el('dialog', { class: 'p1-setup', 'data-document-setup': '' });

  const presetSelect = el('select', { 'data-setup-preset': '' });
  presetSelect.append(el('option', { value: '__custom' }, 'Custom'));
  for (const preset of PAGE_SIZE_PRESETS) {
    presetSelect.append(el('option', { value: preset.id }, `${preset.label} (${preset.size.width}×${preset.size.height} ${preset.size.unit})`));
  }

  const widthInput = el('input', { type: 'number', min: '1', step: 'any', 'data-setup-width': '' });
  const heightInput = el('input', { type: 'number', min: '1', step: 'any', 'data-setup-height': '' });
  const unitSelect = el('select', { 'data-setup-unit': '' });
  for (const unit of ['mm', 'cm', 'in', 'pt'] as const) {
    unitSelect.append(el('option', { value: unit }, unit));
  }
  const landscapeInput = el('input', { type: 'checkbox', 'data-setup-landscape': '' });
  const fixedSizeInput = el('input', { type: 'checkbox', 'data-setup-fixed-size': '' });
  const resizeSelect = el('select', { 'data-setup-resize': '' });
  for (const behaviour of PAGE_RESIZE_BEHAVIOURS) {
    resizeSelect.append(el('option', { value: behaviour }, RESIZE_LABELS[behaviour]));
  }

  const nameInput = el('input', { type: 'text', 'data-setup-name': '', value: 'Untitled' });

  const error = el('p', { class: 'p1-setup__error', 'data-setup-error': '' });

  const row = (...nodes: HTMLElement[]): HTMLElement => {
    const wrapper = el('label', { class: 'p1-setup__field' });
    wrapper.append(...nodes);
    return wrapper;
  };
  const labelled = (text: string, control: HTMLElement): HTMLElement => {
    const wrapper = el('label', { class: 'p1-setup__field' });
    wrapper.append(el('span', { class: 'p1-setup__label' }, text), control);
    return wrapper;
  };

  const cancelButton = el('button', { type: 'button', 'data-setup-cancel': '' }, 'Cancel');
  const createButton = el('button', { type: 'button', 'data-setup-create': '' }, 'Create');

  // `el` takes an attribute record, so a value containing spaces has to go through the properties
  // object rather than `setAttribute` -- hence these two rather than more `attrs` entries.
  widthInput.placeholder = '210';
  heightInput.placeholder = '297';
  nameInput.placeholder = 'Untitled';

  const form = el('form', { class: 'p1-setup__form' });
  form.append(
    el('h2', {}, 'New document'),
    labelled('Name', nameInput),
    labelled('Page size', presetSelect),
    el('div', { class: 'p1-setup__grid' }, labelled('Width', widthInput), labelled('Height', heightInput)),
    el('div', { class: 'p1-setup__grid' }, labelled('Unit', unitSelect), row(landscapeInput, el('span', {}, 'Landscape'))),
    row(fixedSizeInput, el('span', {}, 'Fixed page size')),
    el(
      'p',
      { class: 'p1-setup__note' },
      'New pages always take the size above. Clear this and a new page instead copies the page you are on.',
    ),
    labelled('When a page is resized', resizeSelect),
    error,
    el('div', { class: 'p1-setup__actions' }, cancelButton, createButton),
  );
  dialog.append(form);

  document.body.append(dialog);

  const applyPresetToInputs = (presetId: string): void => {
    const preset = PAGE_SIZE_PRESETS.find((candidate) => candidate.id === presetId);
    if (preset === undefined) return;
    widthInput.value = String(preset.size.width);
    heightInput.value = String(preset.size.height);
    unitSelect.value = preset.size.unit;
  };

  presetSelect.addEventListener('change', () => applyPresetToInputs(presetSelect.value));

  cancelButton.addEventListener('click', () => dialog.close('cancel'));

  return {
    open(current: Document) {
      // Pre-filled from the open document rather than the factory defaults; see the module comment.
      const setup = createPageSetup(current.pageSetup);
      presetSelect.value =
        PAGE_SIZE_PRESETS.find(
          (preset) =>
            preset.size.width === setup.defaultSize.width &&
            preset.size.height === setup.defaultSize.height &&
            preset.size.unit === setup.defaultSize.unit,
        )?.id ?? '__custom';
      widthInput.value = String(setup.defaultSize.width);
      heightInput.value = String(setup.defaultSize.height);
      unitSelect.value = setup.defaultSize.unit;
      landscapeInput.checked = setup.defaultSize.orientation === 'landscape';
      fixedSizeInput.checked = setup.fixedSize;
      resizeSelect.value = setup.resizeBehaviour;
      nameInput.value = 'Untitled';
      error.textContent = '';

      return new Promise<Document | null>((resolve) => {
        const onClose = (): void => {
          dialog.removeEventListener('close', onClose);
          createButton.removeEventListener('click', onCreate);

          // `returnValue` is the *submitter's* value, so Cancel and Escape both land here as null and
          // nothing is created. That is the whole cancellation contract.
          if (dialog.returnValue !== 'create') {
            resolve(null);
            return;
          }
          resolve(readDocument());
        };

        const onCreate = (): void => {
          const created = readDocument();
          // Validation lives in one place: if it cannot be built, the dialog stays open and says why.
          if (created === null) return;
          dialog.close('create');
        };

        createButton.addEventListener('click', onCreate);
        dialog.addEventListener('close', onClose);
        dialog.showModal();
        widthInput.focus();
        widthInput.select();
      });

      function readDocument(): Document | null {
        const width = Number(widthInput.value);
        const height = Number(heightInput.value);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
          error.textContent = 'Width and height must both be positive numbers.';
          return null;
        }
        if (!isPhysicalUnit(unitSelect.value)) {
          error.textContent = 'Pick a physical unit.';
          return null;
        }
        const defaultSize: PageSize = {
          width,
          height,
          unit: unitSelect.value as PhysicalUnit,
          orientation: landscapeInput.checked ? 'landscape' : 'portrait',
        };
        return createDocument({
          name: nameInput.value.trim() === '' ? 'Untitled' : nameInput.value.trim(),
          pageSetup: createPageSetup({
            fixedSize: fixedSizeInput.checked,
            defaultSize: clonePageSize(defaultSize),
            resizeBehaviour: resizeSelect.value as PageResizeBehaviour,
          }),
        });
      }
    },
  };
}