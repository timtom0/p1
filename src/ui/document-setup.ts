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

import { el } from './dom';
import { createDocument } from '../model/factory';
import {
  createPageSetup,
  PAGE_RESIZE_BEHAVIOURS,
  PAGE_SIZE_PRESETS,
  clonePageSize,
  pageSizesEqual,
  type PageResizeBehaviour,
} from '../model/page-setup';
import {
  DEFAULT_MEASUREMENT_UNIT,
  MEASUREMENT_UNITS,
  PRECISION_BY_UNIT,
  fromPx,
  isMeasurementUnit,
  toPx,
} from '../core/units/units';
import type { MeasurementUnit } from '../core/units/units';
import type { Document, PageSize } from '../model/types';

const RESIZE_LABELS: Record<PageResizeBehaviour, string> = {
  crop: 'Crop — leave objects where they are',
  push: 'Push — move what no longer fits to the next page',
  scale: 'Scale — shrink content to fit the new page',
};



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
  /**
   * The document's measurement unit, M24.
   *
   * Before M24 this control wrote `defaultSize.unit` -- the *page's* unit -- and taking the A4 preset
   * silently selected millimetres while taking Letter selected inches. That is the leak the milestone
   * names: a paper preset's own unit becoming the document's authoring unit. The preset label still
   * carries the paper's own unit, because "A4 (210x297mm)" is what tells a reader the sheet size; the
   * conversion into the chosen unit happens when the preset is applied.
   *
   * `pc` is offered because it is the unit a typographer setting a line length actually reaches for,
   * and Scribus and InDesign both offer it. `px` is not: a document is a physical object.
   */
  const unitSelect = el('select', { 'data-setup-unit': '' });
  for (const unit of MEASUREMENT_UNITS) {
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
    el('div', { class: 'p1-setup__grid' }, labelled('Measure in', unitSelect), row(landscapeInput, el('span', {}, 'Landscape'))),
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

  /**
   * The unit the width and height boxes are currently expressed in.
   *
   * A variable rather than read from the select, and that is the whole fix for a bug the first cut
   * had: the `change` event fires *after* the control's value has changed, so reading it there
   * gives the new unit for both sides of the conversion and the conversion silently does nothing.
   * Tracking what the boxes hold is the only version of this that can tell "210 in mm" from "210 in
   * inches" once the user has moved on.
   */
  let inputsAreIn: MeasurementUnit = DEFAULT_MEASUREMENT_UNIT;

  /** The unit the dropdown is set to, falling back to the default rather than trusting the DOM. */
  const currentUnit = (): MeasurementUnit =>
    isMeasurementUnit(unitSelect.value) ? unitSelect.value : DEFAULT_MEASUREMENT_UNIT;

  /** Writes both boxes, recording the unit they are in. The only writer of `inputsAreIn`. */
  const writeInputs = (width: number, height: number, unit: MeasurementUnit): void => {
    const precision = PRECISION_BY_UNIT[unit];
    widthInput.value = String(Number(width.toFixed(precision)));
    heightInput.value = String(Number(height.toFixed(precision)));
    inputsAreIn = unit;
  };

  /**
   * Writes a preset's dimensions into the boxes **in the document's unit**.
   *
   * The conversion is the point. `A4` is 210x297mm and `Letter` is 8.5x11in, and both are the same
   * physical sheet once converted; showing them in the unit the user chose is what makes the unit
   * control a *display* choice rather than a second thing that decides the paper. The old code wrote
   * the preset's own numbers and then set the unit dropdown to match, which is how selecting Letter
   * silently turned a millimetre document into an inch one.
   */
  const applyPresetToInputs = (presetId: string): void => {
    const preset = PAGE_SIZE_PRESETS.find((candidate) => candidate.id === presetId);
    if (preset === undefined) return;
    const unit = currentUnit();
    writeInputs(
      fromPx(toPx(preset.size.width, preset.size.unit), unit),
      fromPx(toPx(preset.size.height, preset.size.unit), unit),
      unit,
    );
  };

  /**
   * Re-writes the width and height into the newly chosen unit, *keeping the same paper*.
   *
   * This is the difference between "change the unit" and "rescale the page", and getting it wrong is
   * the single most destructive thing this dialog could do: reading the numbers as belonging to the
   * old unit would turn an A4 page into a 210in x 297in one.
   */
  const convertInputsToUnit = (to: MeasurementUnit): void => {
    const from = inputsAreIn;
    if (from === to) {
      inputsAreIn = to;
      return;
    }
    const width = Number(widthInput.value);
    const height = Number(heightInput.value);
    // A box the user has typed something unparseable into is left alone, including the unit. The
    // error only surfaces on Create, so silently discarding what they typed here would lose it.
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    writeInputs(fromPx(toPx(width, from), to), fromPx(toPx(height, from), to), to);
  };

  presetSelect.addEventListener('change', () => applyPresetToInputs(presetSelect.value));
  unitSelect.addEventListener('change', () => convertInputsToUnit(currentUnit()));

  cancelButton.addEventListener('click', () => dialog.close('cancel'));

  return {
    open(current: Document) {
      // Pre-filled from the open document rather than the factory defaults; see the module comment.
      const setup = createPageSetup(current.pageSetup);
      const unit = setup.unit;
      presetSelect.value =
        PAGE_SIZE_PRESETS.find(
          (preset) =>
            // Compared physically, not field by field: A4 is 210x297mm *and* 8.2677x11.6929in, and
            // the second is what the boxes hold when the document is in inches. Matching on numbers
            // would report "Custom" for every correctly-configured preset.
            pageSizesEqual(preset.size, { ...setup.defaultSize, unit }) &&
            preset.size.orientation === setup.defaultSize.orientation,
        )?.id ?? '__custom';
      // Through `writeInputs`, so the unit the boxes are in is recorded -- otherwise the *first* unit
      // change after opening would convert from whatever the previous dialog left behind, and a
      // cancelled-then-reopened dialog would rescale a page on the next change.
      writeInputs(
        fromPx(toPx(setup.defaultSize.width, setup.defaultSize.unit), unit),
        fromPx(toPx(setup.defaultSize.height, setup.defaultSize.unit), unit),
        unit,
      );
      unitSelect.value = unit;
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
        if (!isMeasurementUnit(unitSelect.value)) {
          error.textContent = 'Pick a measurement unit.';
          return null;
        }
        const unit = unitSelect.value;
        const defaultSize: PageSize = {
          width,
          height,
          // The page is stored in the *document's* unit too, so a new document has one unit
          // throughout and the page panel's per-page override is something the user does
          // deliberately rather than something they inherited by picking a preset.
          //
          // Storing px here instead would be *wrong*, not merely redundant: `printSheetSize` reads
          // this unit to emit `@page { size: … }`, and a page whose unit said px while its numbers
          // were millimetres would ask the print engine for a sheet of a different size.
          unit,
          orientation: landscapeInput.checked ? 'landscape' : 'portrait',
        };
        return createDocument({
          name: nameInput.value.trim() === '' ? 'Untitled' : nameInput.value.trim(),
          pageSetup: createPageSetup({
            fixedSize: fixedSizeInput.checked,
            defaultSize: clonePageSize(defaultSize),
            resizeBehaviour: resizeSelect.value as PageResizeBehaviour,
            // M24. The unit the user picked, stored as the document's own.
            unit,
          }),
        });
      }
    },
  };
}
