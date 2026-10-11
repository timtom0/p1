/**
 * The pages panel: the list of pages, what you can do to them, and the size of the current one.
 *
 * ## Why this is a panel and not a menu
 *
 * Page management is a *panel* rather than a toolbar row because most of it needs a target: "delete"
 * and "move up" mean something only in relation to a page, and "this page is A4" is a statement you
 * read rather than an action you take. A toolbar of unlabeled verbs would have to guess the target,
 * and the guess would be wrong whenever the user's attention is elsewhere.
 *
 * ## Where the page sizes come from
 *
 * Two different things, and conflating them was the main design risk in this milestone:
 *
 *  - **This page's size** — a value on `Page`, editable here, and the only place a mixed-size document
 *    can be made mixed.
 *  - **The document's defaults** — `fixedSize`, `defaultSize` and `resizeBehaviour`, which decide what
 *    the *next* page is and what a resize does. They live in their own section because they are
 *    document-level, and because `fixedSize` genuinely does **not** mean "all pages are this size".
 *
 * The label on the fixed-size checkbox says so in as many words, because the obvious reading of "Fixed
 * page size" is a constraint on existing pages and it is not one: resizing one page of a fixed-size
 * document makes the document mixed, and the next page added still takes the default.
 *
 * ## Focus and typing
 *
 * Re-rendering happens on every document change, which would otherwise wipe a half-typed number. Any
 * focused input is left alone, so a value survives being edited across an unrelated document change --
 * and is committed on `change` rather than `input`, so an intermediate "1" for "100" is never applied
 * as a one-millimetre page.
 */

import type { DocStore } from '../editor/store/doc-store';
import type { Command } from '../model/commands';
import { canDeletePage, describeCommand } from '../model/commands';
import { pageExtentPx } from '../model/page';
import {
  DEFAULT_PAGE_PRESET,
  PAGE_RESIZE_BEHAVIOURS,
  PAGE_SIZE_PRESETS,
  clonePageSize,
  findPageSizePreset,
  pageSizesEqual,
  type PageResizeBehaviour,
} from '../model/page-setup';
import type { Document, Page, PageSize } from '../model/types';
import { isPhysicalUnit, type PhysicalUnit } from '../core/units/units';

export interface PagePanelOptions {
  /**
   * Makes `index` the focused page.
   *
   * `fit` distinguishes two intents: clicking a page in the list means "go there" and re-frames it,
   * while refocusing after an operation means "stay on this page" and must not touch the zoom.
   * Getting that wrong is not cosmetic -- see `Viewport.focusPage`.
   */
  onFocusPage: (index: number, fit?: boolean) => void;
  /**
   * The currently focused page's index.
   *
   * A getter rather than a field because the panel renders more often than the focus changes, and a
   * captured index would keep pointing at whatever page happened to be focused when the panel was
   * built -- which is how "delete" ends up removing a page the user is no longer looking at.
   */
  currentIndex: () => number;
}

/** The page the viewport is focused on, or the first page. */
function focusedPage(doc: Document, focusedIndex: number): Page | undefined {
  return doc.pages[focusedIndex] ?? doc.pages[0];
}

/** A short human label for a size, preferring a preset name when the values match one exactly. */
function sizeLabel(size: PageSize): string {
  const preset = findPageSizePreset(size);
  const base = preset === null ? `${size.width}×${size.height}` : preset.label;
  return `${base} ${size.orientation === 'landscape' ? 'landscape' : 'portrait'} · ${size.unit}`;
}

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


/**
 * Writes `value` into `input` unless the user is mid-edit.
 *
 * The guard is the whole reason this panel is usable: a document change re-renders it, and without it
 * every keystroke would be followed by the field being rewritten from the model.
 */
function setInputValue(input: HTMLInputElement, value: string): void {
  if (document.activeElement === input) return;
  if (input.value === value) return;
  input.value = value;
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  if (document.activeElement === select) return;
  if (select.value === value) return;
  select.value = value;
}

export interface PagePanel {
  /** Re-reads the document and rewrites the panel. */
  render: (focusedIndex: number) => void;
}

export function mountPagePanel(
  host: HTMLElement,
  store: DocStore,
  options: PagePanelOptions,
): PagePanel {
  const doc = (): Document => store.state;

  // --- page list ------------------------------------------------------------------------------
  const list = el('ol', { class: 'p1-pages__list', 'data-page-list': '' });
  const empty = el('p', { class: 'p1-pages__empty' }, 'This document has no pages.');

  // --- actions --------------------------------------------------------------------------------
  const addButton = el('button', { type: 'button', 'data-page-action': 'add' }, 'Add');
  const duplicateButton = el('button', { type: 'button', 'data-page-action': 'duplicate' }, 'Duplicate');
  const deleteButton = el('button', { type: 'button', 'data-page-action': 'delete' }, 'Delete');
  const upButton = el('button', { type: 'button', 'data-page-action': 'up', title: 'Move page up' }, 'Up');
  const downButton = el('button', { type: 'button', 'data-page-action': 'down', title: 'Move page down' }, 'Down');

  const commit = (command: Command): void => {
    store.mutate(describeCommand(command), () => command);
  };

  addButton.addEventListener('click', () => {
    commit({ type: 'addPage' });
    // Focus the page just created. Leaving focus where it was would make the next Delete remove a
    // page the user never selected.
    options.onFocusPage(doc().pages.length - 1);
  });
  duplicateButton.addEventListener('click', () => {
    const page = focusedPage(doc(), options.currentIndex());
    if (page !== undefined) {
      commit({ type: 'duplicatePage', pageId: page.id });
      // The copy sits directly after the original.
      options.onFocusPage(options.currentIndex() + 1);
    }
  });
  deleteButton.addEventListener('click', () => {
    const page = focusedPage(doc(), options.currentIndex());
    if (page !== undefined) {
      const at = options.currentIndex();
      commit({ type: 'deletePage', pageId: page.id });
      // Land on whatever slid into this position, or on the new last page.
      options.onFocusPage(Math.min(at, doc().pages.length - 1));
    }
  });
  // Reorder moves the page and then re-focuses **it**, not the position. The focused page is an
  // index, so leaving the index alone after a move silently points the focus at a different page --
  // which is how a 'move up' followed by a 'delete' removes the wrong page.
  const moveBy = (delta: number): void => {
    const index = options.currentIndex();
    const page = doc().pages[index];
    if (page === undefined) return;
    commit({ type: 'movePage', pageId: page.id, toIndex: index + delta });
    options.onFocusPage(index + delta);
  };
  upButton.addEventListener('click', () => moveBy(-1));
  downButton.addEventListener('click', () => moveBy(1));

  // --- this page's size -----------------------------------------------------------------------
  const presetSelect = el('select', { 'data-page-preset': '' });
  // The first option is "custom", so a size that is not a preset has somewhere to be without
  // pretending to be one. Its value is derived rather than stored, which is why it is not a preset id.
  presetSelect.append(el('option', { value: '__custom' }, 'Custom'));
  for (const preset of PAGE_SIZE_PRESETS) {
    presetSelect.append(el('option', { value: preset.id }, preset.label));
  }

  const widthInput = el('input', { type: 'number', min: '1', step: 'any', 'data-page-width': '' });
  const heightInput = el('input', { type: 'number', min: '1', step: 'any', 'data-page-height': '' });
  const unitSelect = el('select', { 'data-page-unit': '' });
  for (const unit of ['mm', 'cm', 'in', 'pt'] as const) {
    unitSelect.append(el('option', { value: unit }, unit));
  }
  const landscapeInput = el('input', { type: 'checkbox', 'data-page-landscape': '' });

  const readSize = (): PageSize | null => {
    const width = Number(widthInput.value);
    const height = Number(heightInput.value);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    if (!isPhysicalUnit(unitSelect.value)) return null;
    return {
      width,
      height,
      unit: unitSelect.value as PhysicalUnit,
      orientation: landscapeInput.checked ? 'landscape' : 'portrait',
    };
  };

  const commitSize = (): void => {
    const page = focusedPage(doc(), options.currentIndex());
    const size = readSize();
    if (page === undefined || size === null) return;
    if (pageSizesEqual(page.size, size)) return;
    // No `behaviour` override: the document's policy decides, which is the point of having one.
    commit({ type: 'setPageSize', pageId: page.id, size });
  };

  for (const input of [widthInput, heightInput, unitSelect, landscapeInput]) {
    // `change`, not `input`: an intermediate "1" while typing "100" would otherwise be applied as a
    // one-millimetre page and pushed somewhere the user did not ask for.
    input.addEventListener('change', commitSize);
  }

  presetSelect.addEventListener('change', () => {
    const preset = PAGE_SIZE_PRESETS.find((candidate) => candidate.id === presetSelect.value);
    if (preset === undefined) return;
    const page = focusedPage(doc(), options.currentIndex());
    if (page === undefined) return;
    // Orientation is the user's, not the preset's: switching from A4 to Letter should not silently
    // flip a landscape page back to portrait.
    const size: PageSize = { ...clonePageSize(preset.size), orientation: page.size.orientation };
    if (pageSizesEqual(page.size, size)) return;
    commit({ type: 'setPageSize', pageId: page.id, size });
  });

  const sizeNote = el('p', { class: 'p1-pages__note', 'data-page-note': '' });

  // --- document defaults ----------------------------------------------------------------------
  const fixedSizeInput = el('input', { type: 'checkbox', 'data-pages-fixed-size': '' });
  const setupPresetSelect = el('select', { 'data-pages-default-size': '' });
  for (const preset of PAGE_SIZE_PRESETS) {
    setupPresetSelect.append(el('option', { value: preset.id }, preset.label));
  }
  const resizeSelect = el('select', { 'data-pages-resize': '' });
  for (const behaviour of PAGE_RESIZE_BEHAVIOURS) {
    resizeSelect.append(el('option', { value: behaviour }, RESIZE_LABELS[behaviour]));
  }

  fixedSizeInput.addEventListener('change', () =>
    commit({ type: 'setPageSetup', setup: { fixedSize: fixedSizeInput.checked } }),
  );
  setupPresetSelect.addEventListener('change', () => {
    const preset = PAGE_SIZE_PRESETS.find((candidate) => candidate.id === setupPresetSelect.value);
    if (preset === undefined) return;
    commit({ type: 'setPageSetup', setup: { defaultSize: clonePageSize(preset.size) } });
  });
  resizeSelect.addEventListener('change', () =>
    commit({
      type: 'setPageSetup',
      setup: { resizeBehaviour: resizeSelect.value as PageResizeBehaviour },
    }),
  );

  // --- assemble -------------------------------------------------------------------------------
  const actions = el('div', { class: 'p1-pages__actions' });
  actions.append(addButton, duplicateButton, deleteButton, upButton, downButton);

  const sizeSection = el('section', { class: 'p1-pages__section' });
  sizeSection.append(
    el('h3', {}, 'This page'),
    field('Preset', presetSelect),
    field('Width', widthInput),
    field('Height', heightInput),
    field('Unit', unitSelect),
    field('Landscape', landscapeInput),
    sizeNote,
  );

  const setupSection = el('section', { class: 'p1-pages__section' });
  setupSection.append(
    el('h3', {}, 'New pages'),
    field(fixedSizeInput, 'Fixed page size'),
    el(
      'p',
      { class: 'p1-pages__note' },
      'New pages always take the size below. Clear the box and a new page instead copies the page you are on.',
    ),
    field('Size', setupPresetSelect),
    field('On resize', resizeSelect),
  );

  host.replaceChildren(
    el('h2', { class: 'p1-pages__heading' }, 'Pages'),
    list,
    empty,
    actions,
    sizeSection,
    setupSection,
  );

  function field(labelOrInput: HTMLElement | string, inputOrLabel?: HTMLElement | string): HTMLElement {
    const isLabelFirst = typeof labelOrInput === 'string';
    const label = el('label', { class: 'p1-pages__field' });
    if (isLabelFirst) {
      label.append(el('span', { class: 'p1-pages__field-label' }, labelOrInput), inputOrLabel as HTMLElement);
    } else {
      label.append(labelOrInput, el('span', { class: 'p1-pages__field-label' }, inputOrLabel as string));
    }
    return label;
  }

  const render = (focusedIndex: number): void => {
    const current = doc();
    const index = Math.min(Math.max(focusedIndex, 0), Math.max(0, current.pages.length - 1));
    const page = focusedPage(current, index);

    empty.hidden = current.pages.length > 0;
    list.replaceChildren(
      ...current.pages.map((candidate, candidateIndex) => {
        const row = el('li', {
          class: 'p1-pages__row',
          'data-page-row': '',
          'data-page-id': candidate.id,
          'aria-current': candidateIndex === index ? 'true' : 'false',
        });
        const select = el('button', {
          type: 'button',
          class: 'p1-pages__select',
          'data-page-select': '',
        });
        select.append(
          el('span', { class: 'p1-pages__name' }, candidate.name),
          el('span', { class: 'p1-pages__size' }, sizeLabel(candidate.size)),
        );
        select.addEventListener('click', () => options.onFocusPage(candidateIndex));
        row.append(select);
        return row;
      }),
    );

    const canDelete = canDeletePage(current);
    deleteButton.disabled = !canDelete;
    deleteButton.title = canDelete ? 'Delete this page' : 'A document keeps at least one page';
    upButton.disabled = index === 0;
    downButton.disabled = index === current.pages.length - 1;

    if (page !== undefined) {
      setSelectValue(presetSelect, findPageSizePreset(page.size)?.id ?? '__custom');
      setInputValue(widthInput, String(page.size.width));
      setInputValue(heightInput, String(page.size.height));
      setSelectValue(unitSelect, page.size.unit);
      landscapeInput.checked = page.size.orientation === 'landscape';
      // Says what actually happens, in this document, under the policy this document carries.
      sizeNote.textContent = `${pageExtentPx(page.size).width.toFixed(0)}×${pageExtentPx(page.size).height.toFixed(0)} px. On resize: ${RESIZE_LABELS[current.pageSetup.resizeBehaviour].toLowerCase()}.`;
    }

    fixedSizeInput.checked = current.pageSetup.fixedSize;
    setSelectValue(setupPresetSelect, findPageSizePreset(current.pageSetup.defaultSize)?.id ?? DEFAULT_PAGE_PRESET.id);
    setSelectValue(resizeSelect, current.pageSetup.resizeBehaviour);
  };

  return { render };
}

/**
 * What each policy does, in the user's terms rather than the type's.
 *
 * Shown in the select and in the per-page note, so the choice is made with its consequence visible
 * rather than by discovering afterwards that content moved to another page.
 */
const RESIZE_LABELS: Record<PageResizeBehaviour, string> = {
  crop: 'Crop (leave objects where they are)',
  push: 'Push (move what no longer fits to the next page)',
  scale: 'Scale (shrink content to fit)',
};