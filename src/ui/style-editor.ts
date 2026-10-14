/**
 * Creating and editing a style *definition*.
 *
 * ## What this dialog edits, and what it deliberately does not
 *
 * A definition is a set of properties, and this dialog edits those properties. It does **not** edit
 * what anything resolves to, and it has no control for "the effective value": a definition that
 * tried to display resolved values would be reporting the appearance of one particular object as if
 * it were a property of the style, and the moment two objects disagreed the dialog would have to
 * lie about one of them.
 *
 * ## The category is fixed while editing
 *
 * A style's category decides which sites may reference it -- `character` at a run, `paragraph` at a
 * block, `frame` at the frame -- and changing it under existing references would leave documents
 * whose `styleId` points at the wrong kind. `updateStyle` replaces rather than merges precisely so a
 * category change *is* expressible, for the importer and for tests; it is simply not offered here,
 * because the only safe way to do it from the UI is to delete and recreate.
 *
 * ## Every property is optional, and that is load-bearing
 *
 * A blank property means "this style says nothing about this", which is what makes a partial style
 * useful: a paragraph style that sets only alignment still lets its objects inherit their own
 * indents. The alternative -- a dialog with defaults pre-filled -- would create styles that
 * overwrite things the author never mentioned, and the first edit to any unrelated property would
 * then start depending on what the dialog happened to put in the box.
 */

import { createId } from '../core/ids';
import { el } from './dom';
import type { PhysicalUnit } from '../core/units/units';
import type {
  ParagraphAlign,
  ParagraphDirection,
  ParagraphMetrics,
  StyleDefinition,
  TextStyle,
} from '../model/types';
import type { CharFormat } from '../model/types';
import type { StyleCategory } from '../model/styles';

export interface StyleEditorRequest {
  /** `null` to create, the existing definition to edit. */
  existing: StyleDefinition | null;
  category: StyleCategory;
  /** Pre-fill for a new style's name. */
  suggestedName: string;
  /** Read-only length formatter, so numbers are shown in the document's unit. */
  formatLength: (value: number) => string;
  /** Returns `undefined` for an unparseable value, so the field can keep the user mid-edit. */
  parseLength: (raw: string) => number | undefined;
}

export interface StyleEditor {
  /**
   * Opens the dialog. Resolves with the definition to store, or `null` if cancelled.
   *
   * The id is generated here rather than by the caller, and `existing` keeps its own id, because a
   * reference is an id and a dialog that minted a fresh one on every edit would break every
   * reference in the document on the first save.
   */
  open: (request: StyleEditorRequest) => Promise<StyleDefinition | null>;
}

const CATEGORY_LABEL: Record<StyleCategory, string> = {
  frame: 'Frame',
  paragraph: 'Paragraph',
  character: 'Character',
};

/** One entry per category, so adding a property is adding a row and not adding a dialog. */
const FRAME_FIELDS: readonly { key: keyof TextStyle; label: string; kind: 'length' | 'ratio' | 'family' | 'colour' }[] = [
  { key: 'fontFamily', label: 'Font', kind: 'family' },
  { key: 'fontSize', label: 'Size', kind: 'length' },
  { key: 'lineHeight', label: 'Line', kind: 'ratio' },
  { key: 'letterSpacing', label: 'Track', kind: 'ratio' },
  { key: 'color', label: 'Colour', kind: 'colour' },
];

const CHAR_FLAGS: readonly { key: keyof CharFormat; label: string }[] = [
  { key: 'bold', label: 'Bold' },
  { key: 'italic', label: 'Italic' },
  { key: 'underline', label: 'Underline' },
  { key: 'strike', label: 'Strikethrough' },
  { key: 'super', label: 'Superscript' },
  { key: 'sub', label: 'Subscript' },
];

const CHAR_FIELDS: readonly { key: keyof TextStyle; label: string; kind: 'length' | 'ratio' | 'family' | 'colour' }[] = [
  { key: 'fontFamily', label: 'Font', kind: 'family' },
  { key: 'fontSize', label: 'Size', kind: 'length' },
  { key: 'color', label: 'Colour', kind: 'colour' },
];

const PARAGRAPH_ALIGNS: ReadonlyArray<{ value: ParagraphAlign | ''; label: string }> = [
  { value: '', label: 'Not set' },
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Centre' },
  { value: 'right', label: 'Right' },
  { value: 'justify', label: 'Justify' },
];

const PARAGRAPH_DIRECTIONS: ReadonlyArray<{ value: ParagraphDirection | ''; label: string }> = [
  { value: '', label: 'Not set' },
  { value: 'ltr', label: 'LTR' },
  { value: 'rtl', label: 'RTL' },
];

const PARAGRAPH_METRICS: readonly {
  key: keyof ParagraphMetrics;
  label: string;
  placeholder: string;
}[] = [
  { key: 'textIndent', label: 'First line', placeholder: 'Inherit' },
  { key: 'marginStart', label: 'Indent start', placeholder: 'Inherit' },
  { key: 'marginEnd', label: 'Indent end', placeholder: 'Inherit' },
  { key: 'marginBefore', label: 'Space before', placeholder: 'Inherit' },
  { key: 'marginAfter', label: 'Space after', placeholder: 'Inherit' },
];

export function mountStyleEditor(): StyleEditor {
  const dialog = document.createElement('dialog');
  dialog.className = 'p1-style-editor';
  dialog.dataset['styleEditor'] = '';

  const title = el('h2', { class: 'p1-style-dialog__title' });
  const categoryNote = el('p', { class: 'p1-style-dialog__text p1-style-dialog__text--aside' });
  const body = el('div', { class: 'p1-style-editor__body' });
  const error = el('p', { class: 'p1-setup__error', 'data-style-editor-error': '' });

  const nameInput = el('input', { type: 'text', 'data-style-name': '', spellcheck: 'false' });
  nameInput.placeholder = 'Style name';

  const cancel = el('button', { type: 'button', 'data-style-editor-cancel': '' }, 'Cancel');
  const save = el('button', { type: 'button', 'data-style-editor-save': '' }, 'Save style');

  const form = el(
    'form',
    { class: 'p1-setup__form' },
    title,
    categoryNote,
    el(
      'label',
      { class: 'p1-setup__field' },
      el('span', { class: 'p1-setup__label' }, 'Name'),
      nameInput,
    ),
    body,
    error,
    el('div', { class: 'p1-setup__actions' }, cancel, save),
  );
  dialog.append(form);
  document.body.append(dialog);

  return {
    open(request) {
      title.textContent = request.existing === null ? 'New style' : 'Edit style';
      categoryNote.textContent =
        request.category === 'frame'
          ? 'A frame style supplies typography for a text frame. It applies to the frames you select.'
          : request.category === 'paragraph'
            ? 'A paragraph style supplies alignment, direction and indents for every paragraph of the frames you select.'
            : 'A character style supplies character formatting for every run in the frames you select.';

      nameInput.value = request.existing?.name ?? request.suggestedName;
      error.textContent = '';

      const controls = buildControls(request);
      body.replaceChildren(controls.root);

      return new Promise((resolve) => {
        const onClose = (): void => {
          dialog.removeEventListener('close', onClose);
          resolve(dialog.returnValue === '' ? null : (JSON.parse(dialog.returnValue) as StyleDefinition));
        };
        const onSave = (): void => {
          const name = nameInput.value.trim();
          if (name === '') {
            // A style with no name cannot be listed, so it cannot be applied and cannot be deleted
            // by anyone who finds it. Say so here rather than storing it.
            error.textContent = 'A style needs a name.';
            nameInput.focus();
            return;
          }
          const id = request.existing?.id ?? createId('sty');
          const built = controls.read(name, id);
          dialog.close(JSON.stringify(built));
        };

        save.onclick = onSave;
        cancel.onclick = (): void => dialog.close('');
        nameInput.onkeydown = (event): void => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onSave();
          }
        };
        dialog.addEventListener('close', onClose);
        dialog.showModal();
        nameInput.focus();
        nameInput.select();
      });
    },
  };
}

interface Controls {
  root: HTMLElement;
  read: (name: string, id: string) => StyleDefinition;
}

/**
 * Builds the property controls for one category.
 *
 * Read back in `read()` rather than kept in a parallel model: the dialog's only output is a
 * definition, and building it from the inputs at save time means the input elements are the single
 * source of truth. A shadow copy would be a second thing to keep in step.
 */
function buildControls(request: StyleEditorRequest): Controls {
  if (request.category === 'character') return buildCharacterControls(request);
  if (request.category === 'paragraph') return buildParagraphControls(request);

  const inputs = buildTypographyInputs(FRAME_FIELDS, frameStyleOf(request.existing), request);
  return {
    root: inputs.root,
    read: (name, id) => ({ id, name, kind: 'frame', frame: inputs.read() }),
  };
}

function frameStyleOf(existing: StyleDefinition | null): TextStyle | undefined {
  return existing !== null && existing.kind === 'frame' ? existing.frame : undefined;
}

function buildCharacterControls(request: StyleEditorRequest): Controls {
  const flags = new Map<keyof CharFormat, HTMLInputElement>();
  const flagRow = el('div', { class: 'p1-style-editor__flags' });
  const existingFormat =
    request.existing !== null && request.existing.kind === 'character'
      ? request.existing.character
      : undefined;

  for (const flag of CHAR_FLAGS) {
    const box = el('input', { type: 'checkbox', 'data-char-flag': flag.key });
    box.checked = existingFormat?.[flag.key] === true;
    flags.set(flag.key, box);
    flagRow.append(el('label', { class: 'p1-style-editor__flag' }, box, ` ${flag.label}`));
  }

  const typography = buildTypographyInputs(CHAR_FIELDS, charStyleOf(existingFormat), request);
  const root = el('div', {}, flagRow, typography.root);

  return {
    root,
    read: (name, id): StyleDefinition => {
      const format: CharFormat = {};
      for (const [key, box] of flags) {
        // Only a *set* flag is written. `bold: false` is not a thing this model can hold, and
        // writing one would break `hasFormat`'s single-spelling property.
        if (box.checked) Object.assign(format, { [key]: true });
      }
      Object.assign(format, typography.read());
      return { id, name, kind: 'character', character: format };
    },
  };
}

function charStyleOf(format: CharFormat | undefined): TextStyle | undefined {
  if (format === undefined) return undefined;
  const { fontFamily, fontSize, lineHeight, letterSpacing, color } = format as CharFormat &
    TextStyle;
  const out: TextStyle = {};
  if (fontFamily !== undefined) out.fontFamily = fontFamily;
  if (fontSize !== undefined) out.fontSize = fontSize;
  if (lineHeight !== undefined) out.lineHeight = lineHeight;
  if (letterSpacing !== undefined) out.letterSpacing = letterSpacing;
  if (color !== undefined) out.color = color;
  return Object.keys(out).length === 0 ? undefined : out;
}

function buildParagraphControls(request: StyleEditorRequest): Controls {
  const existing =
    request.existing !== null && request.existing.kind === 'paragraph'
      ? request.existing.paragraph
      : undefined;

  const align = el(
    'select',
    { 'data-style-align': '' },
    ...PARAGRAPH_ALIGNS.map((option) => {
      const node = el('option', { value: option.value }, option.label);
      return node;
    }),
  );
  align.value = existing?.align ?? '';

  const dir = el(
    'select',
    { 'data-style-dir': '' },
    ...PARAGRAPH_DIRECTIONS.map((option) => el('option', { value: option.value }, option.label)),
  );
  dir.value = existing?.dir ?? '';

  const metrics = new Map<keyof ParagraphMetrics, HTMLInputElement>();
  const metricGrid = el('div', { class: 'p1-inspector-grid' });
  for (const metric of PARAGRAPH_METRICS) {
    const input = el('input', {
      type: 'text',
      class: 'p1-inspector-field-input',
      'data-style-metric': metric.key,
      'data-placeholder': metric.placeholder,
    });
    const shown = existing?.metrics?.[metric.key];
    input.placeholder = metric.placeholder;
    input.value = shown === undefined ? '' : request.formatLength(shown);
    metrics.set(metric.key, input);
    metricGrid.append(
      el(
        'label',
        { class: 'p1-inspector-field' },
        el('span', { class: 'p1-inspector-field-label' }, metric.label),
        input,
      ),
    );
  }

  const root = el(
    'div',
    {},
    selectField('Alignment', align),
    selectField('Direction', dir),
    metricGrid,
    el(
      'p',
      { class: 'p1-style-dialog__text p1-style-dialog__text--aside' },
      'A blank field means this style says nothing about it, so objects keep whatever they would otherwise have. Indents are logical: they land on the start edge whichever way the text runs.',
    ),
  );

  return {
    root,
    read: (name, id): StyleDefinition => {
      const paragraph: { align?: ParagraphAlign; dir?: ParagraphDirection; metrics?: ParagraphMetrics } = {};
      if (align.value !== '') Object.assign(paragraph, { align: align.value as ParagraphAlign });
      if (dir.value !== '') Object.assign(paragraph, { dir: dir.value as ParagraphDirection });

      const out: ParagraphMetrics = {};
      for (const [key, input] of metrics) {
        const raw = input.value.trim();
        if (raw === '') continue;
        const parsed = request.parseLength(raw);
        if (parsed === undefined) continue;
        if (parsed < 0 && key !== 'textIndent') continue;
        Object.assign(out, { [key]: parsed });
      }
      if (Object.keys(out).length > 0) paragraph.metrics = out;

      return { id, name, kind: 'paragraph', paragraph };
    },
  };
}

function selectField(label: string, control: HTMLElement): HTMLElement {
  return el(
    'label',
    { class: 'p1-setup__field' },
    el('span', { class: 'p1-setup__label' }, label),
    control,
  );
}

/** Typography fields, shared by the frame and character categories, which differ only in which. */
function buildTypographyInputs(
  fields: readonly { key: keyof TextStyle; label: string; kind: 'length' | 'ratio' | 'family' | 'colour' }[],
  current: TextStyle | undefined,
  request: StyleEditorRequest,
): { root: HTMLElement; read: () => TextStyle } {
  const inputs = new Map<keyof TextStyle, HTMLInputElement>();
  const grid = el('div', { class: 'p1-inspector-grid' });

  for (const field of fields) {
    const input = el('input', {
      type: 'text',
      class: 'p1-inspector-field-input',
      'data-style-field': field.key,
      spellcheck: 'false',
      'data-placeholder': 'Not set',
    });
    input.placeholder = 'Not set';
    const value = current?.[field.key];
    if (field.kind === 'length' && typeof value === 'number') {
      input.value = request.formatLength(value);
    } else if (field.kind === 'ratio' && typeof value === 'number') {
      input.value = String(value);
    } else if (typeof value === 'string') {
      input.value = value;
    }
    inputs.set(field.key, input);
    grid.append(
      el(
        'label',
        { class: 'p1-inspector-field' },
        el('span', { class: 'p1-inspector-field-label' }, field.label),
        input,
      ),
    );
  }

  const root = el(
    'div',
    {},
    grid,
    el(
      'p',
      { class: 'p1-style-dialog__text p1-style-dialog__text--aside' },
      'A blank field means this style says nothing about it, so objects keep whatever they would otherwise have.',
    ),
  );

  return {
    root,
    read: () => {
      const out: TextStyle = {};
      for (const [key, input] of inputs) {
        const field = fields.find((candidate) => candidate.key === key);
        const raw = input.value.trim();
        if (raw === '') continue;
        if (field?.kind === 'length') {
          const parsed = request.parseLength(raw);
          if (parsed === undefined) continue;
          Object.assign(out, { [key]: parsed });
        } else if (field?.kind === 'ratio') {
          const parsed = Number(raw);
          if (!Number.isFinite(parsed)) continue;
          Object.assign(out, { [key]: parsed });
        } else {
          Object.assign(out, { [key]: raw });
        }
      }
      return out;
    },
  };
}

export const STYLE_CATEGORY_LABEL = CATEGORY_LABEL;
export type { PhysicalUnit };