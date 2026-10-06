/**
 * Inspector scaffold (§5.2) — transform fields, driven by a declarative schema.
 *
 * Deliberately schema-driven even with only five fields. The reason is not
 * elegance: the alternative is five hand-written `addEventListener` blocks, and the
 * sixth property (opacity, then fill, then corner radius) would then need a seventh.
 * Adding a field becomes one entry in a list.
 *
 * ## The rule that matters
 *
 * **Every field commit is a transaction.** Otherwise typing a value produces one
 * undo entry per keystroke, which is the single most common way an editor's undo
 * system becomes unusable. Editing commits on blur or Enter, never on input.
 */

import type { DocStore } from '../editor/store/doc-store';
import type { Editor } from '../editor/editor';
import { describeCommand } from '../model/commands';
import type { Command, TextStylePatch, TransformPatch } from '../model/commands';
import type { BlendMode, Document, ImageNode, Node, ParagraphAlign, ShapeNode } from '../model/types';
import { shapeHasInterior, shapeKinds, shapeSpec } from '../model/shapes';
import { ASSET_STATE_LABELS, IMAGE_FITS, IMAGE_FIT_LABELS, findAsset } from '../model/assets';
import type { PropertySpec } from '../model/shapes';
import { defaultStroke } from '../model/creation';
import { findNode } from '../editor/selection';
import type { CharFlag } from '../model/rich-text';
import { formatLength, parseLength as parseLengthPx } from '../core/units/units';
import type { PhysicalUnit } from '../core/units/units';

interface FieldSpec {
  key: keyof TransformPatch;
  label: string;
  /** Rotation is stored in radians but edited in degrees. */
  unit?: 'deg';
}

const FIELDS: readonly FieldSpec[] = [
  { key: 'x', label: 'X' },
  { key: 'y', label: 'Y' },
  { key: 'width', label: 'W' },
  { key: 'height', label: 'H' },
  { key: 'rotation', label: '∠', unit: 'deg' },
];

export interface Inspector {
  /** Repaints from the current selection. Cheap; called on every selection change. */
  sync(): void;
}

/**
 * Frame-level typography, shown only when every selected object is a text frame.
 *
 * Schema-driven like the transform group, for the reason in the header: a
 * hand-written field per property is the alternative, and the seventh property would
 * then need an eighth block. Adding one becomes one entry here.
 */
type TextFieldKey = 'fontSize' | 'lineHeight' | 'letterSpacing' | 'color';

interface TextFieldSpec {
  key: TextFieldKey;
  label: string;
  /** `px` lengths go through the unit parser; multipliers and em are unitless. */
  kind: 'length' | 'ratio' | 'colour';
}

const TEXT_FIELDS: readonly TextFieldSpec[] = [
  { key: 'fontSize', label: 'Size', kind: 'length' },
  { key: 'lineHeight', label: 'Line', kind: 'ratio' },
  { key: 'letterSpacing', label: 'Track', kind: 'ratio' },
  { key: 'color', label: 'Colour', kind: 'colour' },
];

const PARAGRAPH_ALIGNS: ReadonlyArray<{ value: ParagraphAlign; label: string }> = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Centre' },
  { value: 'right', label: 'Right' },
  { value: 'justify', label: 'Justify' },
];

/**
 * Visual properties every graphical object shares, whatever its kind.
 *
 * Split from the kind-specific ones the registry supplies, because "what does an ellipse
 * look like" and "what does *this* ellipse look like" are different questions: these four
 * are common to every kind, so listing them per kind would be duplication, and a shared
 * property edited through a kind's entry would break the moment a second kind existed.
 *
 * `when` is data rather than a `switch` in the sync path, so which fields apply is
 * decided once, here, next to the field they decide about.
 */
const APPEARANCE_FIELDS: readonly AppearanceFieldSpec[] = [
  // No interior means nothing to fill: a line is painted by its stroke alone, so
  // offering a fill field would offer a control that cannot do anything.
  { path: 'fill.color', label: 'Fill', kind: 'colour', scope: 'shared', when: 'filled' },
  { path: 'stroke.paint.color', label: 'Stroke', kind: 'colour', scope: 'shared', when: 'always' },
  { path: 'stroke.width', label: 'Weight', kind: 'length', scope: 'shared', when: 'always' },
  { path: 'opacity', label: 'Opacity', kind: 'ratio', scope: 'shared', when: 'always' },
];

interface AppearanceFieldSpec {
  /** Dotted path into the node; see `PropertySpec` in `model/shapes.ts`. */
  path: string;
  label: string;
  kind: 'length' | 'colour' | 'ratio';
  /**
   * Whether the property belongs to every kind or to one.
   *
   * Load-bearing, and the reason it is data rather than something inferred from the
   * registry: a kind-specific field must apply **only** when the selected kinds include
   * the one that declares it. An earlier version inferred this from `when: 'always'`,
   * which meant a rectangle's corner radius was offered for an ellipse — a control that
   * cannot do anything, in a panel whose whole promise is that its fields describe the
   * selection.
   */
  scope: 'shared' | 'kind';
  /** For shared fields: whether the selection has an interior to fill. */
  when: 'always' | 'filled';
}

/**
 * Converts a registry property into a field this panel can edit, or `null`.
 *
 * The registry may declare a property kind the inspector has no editor for. Returning
 * `null` makes that an *absent field* rather than a field that parses wrongly, and the
 * filter at the call site is where a milestone that adds, say, a boolean editor pays it
 * off — without this file growing a second copy of the property list.
 */
function toAppearanceField(property: PropertySpec): AppearanceFieldSpec | null {
  if (property.kind !== 'length' && property.kind !== 'colour') return null;
  return {
    path: property.path,
    label: property.label,
    kind: property.kind,
    scope: 'kind',
    when: 'always',
  };
}

export function mountInspector(
  container: HTMLElement,
  editor: Editor,
  store: DocStore,
  unit: () => PhysicalUnit,
): Inspector {
  container.replaceChildren();
  container.dataset['inspector'] = 'transform';

  const header = document.createElement('div');
  header.className = 'p1-inspector-header';
  header.textContent = 'Transform';
  container.append(header);

  const grid = document.createElement('div');
  grid.className = 'p1-inspector-grid';
  container.append(grid);

  const inputs = new Map<keyof TransformPatch, HTMLInputElement>();

  // ---------------------------------------------------------------------------
  // Object properties
  //
  // `visible`, `locked`, `opacity` and `blendMode`, which every object type carries. Two are
  // switches and two are values, so they are not four more text fields: a checkbox per boolean
  // keeps "is this object shown" a single glance rather than a value to parse, and it is the
  // one place the inspector stops being uniform.
  // ---------------------------------------------------------------------------

  const objectInputs = new Map<ObjectFieldKey, HTMLInputElement>();
  const objectGroup = document.createElement('div');
  objectGroup.className = 'p1-inspector-grid';

  for (const field of OBJECT_FIELDS) {
    const label = document.createElement('label');
    label.className = 'p1-inspector-field';

    const name = document.createElement('span');
    name.className = 'p1-inspector-field-label';
    name.textContent = field.label;

    const input = document.createElement('input');
    input.className = 'p1-inspector-field-input';
    input.dataset['objectField'] = field.key;
    input.spellcheck = false;
    input.setAttribute('aria-label', `${field.label} of selected object`);

    if (field.kind === 'boolean') {
      input.type = 'checkbox';
      input.addEventListener('change', () => {
        commitObjectField(field.key, input.checked);
      });
    } else {
      input.type = 'text';
      input.inputMode = field.kind === 'enum' ? 'text' : 'decimal';
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          input.blur();
        } else if (event.key === 'Escape') {
          input.value = input.dataset['shown'] ?? '';
          input.blur();
        }
      });
      input.addEventListener('blur', () => {
        const parsed = parseObjectField(field.key, input.value.trim());
        if (parsed === null) {
          // Restore rather than guess: a half-typed `0.` is a typo, not an opacity.
          input.value = input.dataset['shown'] ?? '';
          input.classList.add('p1-inspector-field-input--invalid');
          return;
        }
        input.classList.remove('p1-inspector-field-input--invalid');
        commitObjectField(field.key, parsed);
      });
    }

    label.append(name, input);
    objectGroup.append(label);
    objectInputs.set(field.key, input);
  }
  container.append(objectGroup);

  /**
   * Commits one object property across the whole selection, as one command.
   *
   * `setProps` already takes `ids` and already has per-key no-op detection, so a commit that
   * changes nothing is dropped instead of becoming an undo step. The label is the model's own
   * `describeCommand`, because that is where every label in the app is spelled.
   */
  function commitObjectField(key: ObjectFieldKey, value: boolean | number | string): void {
    const ids = [...editor.selectionState.ids];
    if (ids.length === 0) return;
    const command: Command = { type: 'setProps', ids, props: { [key]: value } };
    store.mutate(describeCommand(command), () => command);
  }

  for (const field of FIELDS) {
    const label = document.createElement('label');
    label.className = 'p1-inspector-field';

    const name = document.createElement('span');
    name.className = 'p1-inspector-field-label';
    name.textContent = field.label;

    const input = document.createElement('input');
    input.className = 'p1-inspector-field-input';
    input.type = 'text';
    input.inputMode = 'decimal';
    input.dataset['field'] = field.key;
    input.spellcheck = false;
    input.setAttribute('aria-label', `${field.label} of selected object`);

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      } else if (event.key === 'Escape') {
        // Abandon the edit without committing, then restore the shown value.
        input.value = input.dataset['shown'] ?? '';
        input.blur();
      }
    });

    input.addEventListener('blur', () => commit(field, input));

    label.append(name, input);
    grid.append(label);
    inputs.set(field.key, input);
  }

  function commit(field: FieldSpec, input: HTMLInputElement): void {
    const ids = [...editor.selectionState.ids];
    if (ids.length === 0) return;

    const raw = input.value.trim();
    const parsed = field.unit === 'deg' ? parseDegrees(raw) : parseLength(raw, unit());
    if (parsed === null) {
      input.value = input.dataset['shown'] ?? '';
      input.classList.add('p1-inspector-field-input--invalid');
      return;
    }
    input.classList.remove('p1-inspector-field-input--invalid');

    // One transaction per commit: a single undo step, regardless of how the value
    // got there.
    store.mutate(
      ids.length > 1 ? `${field.label} ${ids.length} objects` : field.label,
      () => ({
        type: 'setTransform',
        ids,
        patch: { [field.key]: parsed } as TransformPatch,
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Appearance section
  // ---------------------------------------------------------------------------

  /**
   * Fill / stroke / weight / opacity, plus whatever the selected kind contributes.
   *
   * Built once for *every* field that could ever apply and hidden rather than rebuilt,
   * for the reason the text section gives: a panel that adds and removes DOM on
   * selection change loses focus, and losing focus mid-typing is unforgivable.
   *
   * A field's row is hidden, not removed, so switching from a rectangle to an ellipse
   * does not tear down the corner-radius input the user might be about to need again.
   */
  const appearanceSection = document.createElement('div');
  appearanceSection.className = 'p1-inspector-appearance';
  appearanceSection.hidden = true;

  const appearanceHeader = document.createElement('div');
  appearanceHeader.className = 'p1-inspector-subheader';
  appearanceHeader.textContent = 'Appearance';
  appearanceSection.append(appearanceHeader);

  const appearanceGrid = document.createElement('div');
  appearanceGrid.className = 'p1-inspector-grid';
  appearanceSection.append(appearanceGrid);

  const appearanceInputs = new Map<string, { row: HTMLElement; input: HTMLInputElement }>();

  /** Every field the panel can ever show, in display order. */
  const allAppearanceFields: readonly AppearanceFieldSpec[] = [
    ...APPEARANCE_FIELDS,
    // The kind-specific rows, taken from the registry rather than written out here.
    // This is the whole of "the inspector describes properties from the object type
    // definition": a kind that declares a property gets a field without any edit to
    // this file.
    //
    // Mapped through `toAppearanceField` because the registry's `PropertyKind` is
    // deliberately wider than this panel can edit — a kind may declare a boolean or an
    // angle property with no field yet. A property the panel cannot render is *dropped
    // here*, loudly, rather than rendered as a text box that would then have to guess
    // how to parse it.
    ...shapeKinds().flatMap((kind) =>
      shapeSpec(kind)
        .properties.map(toAppearanceField)
        .filter((field): field is AppearanceFieldSpec => field !== null),
    ),
  ];

  for (const field of allAppearanceFields) {
    const row = document.createElement('label');
    row.className = 'p1-inspector-field';
    // The row and the input carry *different* attribute names for the same path. An
    // earlier version put data-property on both, which made every test selector
    // ambiguous -- Playwright's strict mode rejected it, and rightly: two elements
    // answering to one identity is a smell in the markup, not only in the test.
    // propertyRow is what a test asks about visibility; property is what it types into.
    row.dataset['propertyRow'] = field.path;

    const name = document.createElement('span');
    name.className = 'p1-inspector-field-label';
    name.textContent = field.label;

    const input = document.createElement('input');
    input.className = 'p1-inspector-field-input';
    input.type = 'text';
    input.inputMode = field.kind === 'colour' ? 'text' : 'decimal';
    input.dataset['property'] = field.path;
    input.spellcheck = false;
    input.setAttribute('aria-label', `${field.label} of selected object`);

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      } else if (event.key === 'Escape') {
        // Abandon the edit without committing, then restore the shown value. Escape here
        // must not reach the document-level handler and disarm the draw tool: the field
        // is the thing being abandoned.
        event.stopPropagation();
        input.value = input.dataset['shown'] ?? '';
        input.blur();
      }
    });

    input.addEventListener('blur', () => commitAppearance(field, input));

    row.append(name, input);
    appearanceGrid.append(row);
    appearanceInputs.set(field.path, { row, input });
  }

  function commitAppearance(field: AppearanceFieldSpec, input: HTMLInputElement): void {
    const ids = shapeIds();
    if (ids.length === 0) return;

    const raw = input.value.trim();
    const parsed =
      field.kind === 'length'
        ? parseLength(raw, unit())
        : field.kind === 'ratio'
          ? parseRatio(raw)
          : parseColor(raw);

    if (parsed === null) {
      input.value = input.dataset['shown'] ?? '';
      input.classList.add('p1-inspector-field-input--invalid');
      return;
    }
    input.classList.remove('p1-inspector-field-input--invalid');

    // One command per object, in a single batch, because `setProps` replaces a top-level
    // key wholesale: patching `stroke.width` from the first selected object's stroke
    // would overwrite every *other* selected object's stroke width with it. Building
    // each patch from its own node keeps a mixed selection's other properties intact,
    // and `batch` collapses the lot into one history entry.
    //
    // No DOM is written outside a command. In particular this never touches a
    // `contenteditable` subtree, so the browser's own undo grouping during a text
    // session (ADR 0002) is undisturbed.
    store.mutate(
      ids.length > 1 ? `${field.label} ${ids.length} objects` : field.label,
      () => ({
        type: 'batch',
        label: field.label,
        cmds: ids.map((id) => {
          const node = findNode(editor.doc, id);
          return {
            type: 'setProps',
            ids: [id],
            // `shapeIds()` only yields shape ids, but `findNode` widens back to `Node`,
            // so the narrowing is repeated rather than assumed — a future non-shape node
            // reaching here would produce `{}` and silently do nothing.
            props:
              node !== null && node.type === 'shape'
                ? propsWithPath(node, field.path, parsed)
                : {},
          };
        }),
      }),
    );
  }

  function syncAppearanceSection(): void {
    const selected = [...editor.selectionState.ids];
    const nodes = selected
      .map((id) => findNode(editor.doc, id))
      .filter((node): node is ShapeNode => node !== null && node.type === 'shape');

    // All-or-nothing, like the text section: a field that half-applies across a
    // selection is worse than no field, because the user cannot tell which half worked.
    const allShapes = nodes.length > 0 && nodes.length === selected.length;
    appearanceSection.hidden = !allShapes;
    if (!allShapes) return;

    const kinds = new Set(nodes.map((node) => node.shape.kind));
    // Kind-specific fields need a single kind: a corner radius is meaningful for a rect
    // and meaningless for an ellipse, so a mixed selection has no shared answer to show.
    // Written as an explicit lookup rather than `[...set][0]` so the narrowing to a
    // non-optional `ShapeKind` is the compiler's, not an unchecked index.
    const kind = kinds.size === 1 ? kinds.values().next().value : null;
    const kindPaths =
      kind === null || kind === undefined ? new Set<string>() : new Set(shapeSpec(kind).properties.map((p) => p.path));
    const filled = nodes.every((node) => shapeHasInterior(node.shape.kind));

    for (const field of allAppearanceFields) {
      const entry = appearanceInputs.get(field.path);
      if (entry === undefined) continue;

      const applies =
        field.scope === 'kind' ? kindPaths.has(field.path) : field.when === 'always' || filled;
      entry.row.hidden = !applies;
      if (!applies) continue;

      const value = commonPath(nodes, field.path);
      if (value === undefined) {
        // A mixed selection shows a blank, never an arbitrary member's value — and never
        // a default that would silently become the shared value on the next commit.
        entry.input.value = '';
        entry.input.placeholder = nodes.length > 1 ? 'Mixed' : '—';
        entry.input.dataset['shown'] = '';
        continue;
      }

      entry.input.placeholder = '';
      const shown =
        field.kind === 'length'
          ? formatLength(value as number, unit())
          : field.kind === 'ratio'
            ? formatRatio(value as number)
            : String(value);
      entry.input.value = shown;
      entry.input.dataset['shown'] = shown;
    }
  }

  /** Ids of the selected shapes, which is what the appearance fields apply to. */
  function shapeIds(): string[] {
    return [...editor.selectionState.ids].filter((id) => findNode(editor.doc, id)?.type === 'shape');
  }

  function sync(): void {
    const common = editor.commonTransform;
    const empty = common === null;

    container.dataset['state'] = empty ? 'empty' : editor.selectionState.ids.size > 1 ? 'mixed' : 'single';

    for (const field of FIELDS) {
      const input = inputs.get(field.key);
      if (input === undefined) continue;

      const value = common?.[field.key];
      if (value === null || value === undefined) {
        // A mixed selection shows a blank, never an arbitrary member's value.
        input.value = '';
        input.placeholder = empty ? '—' : 'Mixed';
        input.disabled = empty;
        input.dataset['shown'] = '';
        continue;
      }

      input.disabled = false;
      input.placeholder = '';
      const shown =
        field.unit === 'deg' ? formatDegrees(value) : formatLength(value, unit());
      input.value = shown;
      input.dataset['shown'] = shown;
    }

    syncObjectSection();
    syncTextSection();
    syncAppearanceSection();
    syncImageSection();
  }

  /**
   * The shared object fields, with the mixed-state rule the transform fields already use.
   *
   * A boolean that is not unanimous is shown **indeterminate**, which is the only honest
   * rendering: a selection of a visible and a hidden object has no single answer. Resolving
   * it by clicking sets the value the user is reaching for, which is what every other editor
   * does and the only rule that does not need a second click to discover.
   */
  function syncObjectSection(): void {
    const nodes: Node[] = [...editor.selectionState.ids]
      .map((id) => findNode(editor.doc, id))
      .filter((node) => node !== null);
    const empty = nodes.length === 0;

    for (const field of OBJECT_FIELDS) {
      const input = objectInputs.get(field.key);
      if (input === undefined) continue;

      const values = nodes.map((node) => node[field.key]);
      const shared = values.length > 0 && values.every((value) => value === values[0]);
      const common: boolean | number | string | undefined = shared ? values[0] : undefined;

      input.disabled = empty;
      input.dataset['mixed'] = String(common === undefined && !empty);

      if (field.kind === 'boolean') {
        const checkbox = input as HTMLInputElement;
        // `indeterminate` only shows while the box is unchecked; setting both flags on a
        // checked box leaves it looking ordinary.
        checkbox.indeterminate = common === undefined && !empty;
        checkbox.checked = common === true;
        input.dataset['shown'] = String(common ?? '');
        continue;
      }

      input.placeholder = empty ? '-' : 'Mixed';
      const shown = common === undefined ? '' : formatObjectField(field.key, common);
      input.value = shown;
      input.dataset['shown'] = shown;
    }
  }

  // ---------------------------------------------------------------------------
  // Text section
  // ---------------------------------------------------------------------------

  /**
   * The typography section, built once and shown only for text frames.
   *
   * Built eagerly and hidden rather than created on demand: a panel that adds and
   * removes DOM on selection change loses focus, and losing focus while typing a font
   * size is the worst possible time to lose it.
   */
  const textSection = document.createElement('div');
  textSection.className = 'p1-inspector-text';
  textSection.hidden = true;

  const textHeader = document.createElement('div');
  textHeader.className = 'p1-inspector-subheader';
  textHeader.textContent = 'Text';
  textSection.append(textHeader);

  const textGrid = document.createElement('div');
  textGrid.className = 'p1-inspector-grid';
  textSection.append(textGrid);

  const textInputs = new Map<TextFieldKey, HTMLInputElement>();

  for (const field of TEXT_FIELDS) {
    const label = document.createElement('label');
    label.className = 'p1-inspector-field';

    const name = document.createElement('span');
    name.className = 'p1-inspector-field-label';
    name.textContent = field.label;

    const input = document.createElement('input');
    input.className = 'p1-inspector-field-input';
    input.type = 'text';
    input.spellcheck = false;
    input.dataset['textField'] = field.key;
    input.setAttribute('aria-label', `${field.label} of selected text`);

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      } else if (event.key === 'Escape') {
        input.value = input.dataset['shown'] ?? '';
        input.blur();
      }
    });

    input.addEventListener('blur', () => commitText(field, input));
    label.append(name, input);
    textGrid.append(label);
    textInputs.set(field.key, input);
  }

  // Alignment is a paragraph property, so it applies to every paragraph rather than
  // to the frame (ADR 0003). A segmented control rather than a text field, because it
  // is an enumeration with four values and no free text.
  const alignRow = document.createElement('div');
  alignRow.className = 'p1-inspector-align';
  alignRow.dataset['alignRow'] = 'true';

  const alignButtons = new Map<ParagraphAlign, HTMLButtonElement>();
  for (const align of PARAGRAPH_ALIGNS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = align.label;
    button.dataset['align'] = align.value;
    button.addEventListener('click', () => {
      const ids = textFrameIds();
      if (ids.length === 0) return;
      // One command, so setting alignment on a multi-selection is a single undo step.
      store.mutate('Align', () => ({
        type: 'batch',
        cmds: ids.map((id) => ({ type: 'setTextAlign', nodeId: id, align: align.value })),
      }));
    });
    alignRow.append(button);
    alignButtons.set(align.value, button);
  }
  textSection.append(alignRow);

  /**
   * Character-formatting toggles.
   *
   * These exist for discoverability as much as function: Ctrl+B works, but only once
   * the caret is inside a frame, and a user with nothing to click has no way to find
   * that out. They are wired to `TextSessionController`, which routes the click to
   * the browser inside a session and to the model outside one — the ADR 0003 rule —
   * so the same button works in both states.
   */
  const formatRow = document.createElement('div');
  formatRow.className = 'p1-inspector-format';

  const formatButtons = new Map<CharFlag, HTMLButtonElement>();
  for (const [flag, label, title] of [
    ['bold', 'B', 'Bold (Ctrl+B)'],
    ['italic', 'I', 'Italic (Ctrl+I)'],
    ['underline', 'U', 'Underline (Ctrl+U)'],
    ['strike', 'S', 'Strikethrough'],
  ] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset['flag'] = flag;
    button.title = title;
    button.className = `p1-inspector-format-${flag}`;
    button.addEventListener('click', () => {
      const session = editor.textSession;
      if (session === null) return;
      // Inside a session the browser applies it to the selection; outside one, every
      // run in the frame toggles. Same click, one rule, chosen by the controller.
      session.applyInlineFormat(flag, editor.selectionState.primary ?? undefined);
      // A toggle inside a session changes only the DOM, so nothing in the store
      // fires; this is what re-reads the toolbar's pressed state from the browser.
      editor.refresh();
    });
    formatRow.append(button);
    formatButtons.set(flag, button);
  }
  textSection.insertBefore(formatRow, alignRow);

  /**
   * Read-only: the text's laid-out size, and whether it overflows its frame.
   *
   * Not an editable field, because it is not authored state — it is what the browser
   * laid out, and there is nothing for the user to type into it. It is here because it
   * is the one number a text editor most wants and the document cannot hold (ADR 0004),
   * and because a measurement surface nothing displays is one nobody keeps honest.
   *
   * A measured value is allowed here only because it is labelled as measured and never
   * fed back into the model. When auto-size arrives it dispatches a command like any
   * other authored change, and this readout becomes its feedback.
   */
  const layoutNote = document.createElement('div');
  layoutNote.className = 'p1-inspector-note';
  layoutNote.dataset['layout'] = 'text';
  textSection.append(layoutNote);

  // ---------------------------------------------------------------------------
  // Image section
  // ---------------------------------------------------------------------------

  /**
   * Fit, and a readout of whether the asset resolved.
   *
   * Two fields, not five, and both are there because they have an authored meaning:
   *
   *  - **`fit`** is user intent with a visible effect and no other representation.
   *    Measured, it changes only which pixels are painted inside the box — `offset*` size
   *    and the hit region are identical for all five values (ADR 0006 PROBE X) — so it is
   *    authored state that is *not* geometry, and it belongs here rather than in
   *    `transform`.
   *  - **The state readout** is not a property at all. It is a read of rendering output,
   *    the same arrangement as ADR 0004's measurement note: the model says what was
   *    authored, the browser says what happened, and the panel reports both.
   *
   * Deliberately **absent**: `object-position`, because under the default `fill` it has
   * no observable effect and would be a control that cannot do anything. It arrives with
   * cropping. Also absent: the asset id, because there is no operation a user could
   * perform on it here — replace and delete are asset-management UI, out of scope.
   */
  const imageSection = document.createElement('div');
  imageSection.className = 'p1-inspector-image';
  imageSection.hidden = true;

  const imageHeader = document.createElement('div');
  imageHeader.className = 'p1-inspector-subheader';
  imageHeader.textContent = 'Image';
  imageSection.append(imageHeader);

  const imageGrid = document.createElement('div');
  imageGrid.className = 'p1-inspector-grid';
  imageSection.append(imageGrid);

  const fitRow = document.createElement('label');
  fitRow.className = 'p1-inspector-field';
  fitRow.dataset['propertyRow'] = 'fit';

  const fitName = document.createElement('span');
  fitName.className = 'p1-inspector-field-label';
  fitName.textContent = 'Fit';
  fitRow.append(fitName);

  const fitSelect = document.createElement('select');
  fitSelect.className = 'p1-inspector-field-input';
  fitSelect.dataset['property'] = 'fit';
  fitSelect.setAttribute('aria-label', 'Fit of selected image');
  // Built from the model's own union, so a new `ImageFit` cannot be missing from the UI
  // without a type error -- the same property the shape registry has for its predicates.
  for (const value of IMAGE_FITS) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = IMAGE_FIT_LABELS[value];
    fitSelect.append(option);
  }
  fitSelect.addEventListener('change', () => commitImageFit(fitSelect.value));
  fitRow.append(fitSelect);
  imageGrid.append(fitRow);

  const assetRow = document.createElement('div');
  assetRow.className = 'p1-inspector-field';
  assetRow.dataset['propertyRow'] = 'asset';

  const assetName = document.createElement('span');
  assetName.className = 'p1-inspector-field-label';
  assetName.textContent = 'Asset';
  assetRow.append(assetName);

  // A read-only note, not an input: there is nothing the user could type here that would
  // mean anything. It reports the browser's answer and, when the asset is missing, the
  // reason -- which is the difference between "the image did not load" and "this document
  // has no such asset".
  const assetNote = document.createElement('div');
  assetNote.className = 'p1-inspector-note';
  assetNote.dataset['asset'] = 'state';
  assetRow.append(assetNote);
  imageGrid.append(assetRow);

  const sizeNote = document.createElement('div');
  sizeNote.className = 'p1-inspector-note';
  sizeNote.dataset['asset'] = 'size';
  imageSection.append(sizeNote);

  function commitImageFit(raw: string): void {
    const ids = imageIds();
    if (ids.length === 0) return;
    const fit = IMAGE_FITS.find((value) => value === raw);
    if (fit === undefined) return;

    // Through the funnel like everything else, so it is undoable and no-op-detected.
    // `setProps` replaces a top-level key wholesale, and `fit` is one, so the payload is
    // the value itself rather than a nested patch.
    store.mutate(ids.length > 1 ? `Fit ${ids.length} objects` : 'Fit', () => ({
      type: 'setProps',
      ids,
      props: { fit },
    }));
  }

  /** Selected node ids that are images. */
  function imageIds(): string[] {
    return [...editor.selectionState.ids].filter(
      (id) => findNode(editor.doc, id)?.type === 'image',
    );
  }

  function syncImageSection(): void {
    const selected = [...editor.selectionState.ids];
    const nodes = selected
      .map((id) => findNode(editor.doc, id))
      .filter((node): node is ImageNode => node !== null && node.type === 'image');

    // All-or-nothing, for the same reason as every other section.
    const allImages = nodes.length > 0 && nodes.length === selected.length;
    imageSection.hidden = !allImages;
    if (!allImages) return;

    // The shared value, or `undefined` when the selection disagrees — so a mixed
    // selection shows a blank rather than one object's choice.
    const shared = nodes
      .map((node) => node.fit ?? 'fill')
      .every((value) => value === (nodes[0]?.fit ?? 'fill'))
      ? (nodes[0]?.fit ?? 'fill')
      : undefined;
    fitSelect.value = shared ?? '';
    fitSelect.disabled = shared === undefined;

    syncAssetNote(nodes[0]);
    syncAssetSize(nodes);
  }

  /**
   * Reports the browser's asset state, read off the mounted element.
   *
   * A read of rendering output through `Editor`, not a value from the model — because the
   * model has no such value, and must not: "does this asset currently resolve" is a fact
   * about this browser session, not about the document. The same split as ADR 0004's
   * measurement note.
   */
  function syncAssetNote(node: ImageNode | undefined): void {
    const state = node === undefined ? null : editor.assetStateOf(node.id);
    assetNote.dataset['state'] = state ?? '';
    if (node === undefined) {
      assetNote.textContent = '';
      return;
    }
    assetNote.textContent =
      state === null
        ? 'not mounted'
        : `${ASSET_STATE_LABELS[state]} · ${editor.assetProblemOf(node.id) ?? 'ok'}`;
  }

  /**
   * The asset's intrinsic size, against the box's size.
   *
   * The comparison is the point. An image authored at 200×150 from a 2000×1500 source is
   * *resized*, and the author should be able to see that rather than infer it — the same
   * reason the text section shows a measured height (ADR 0004).
   */
  function syncAssetSize(nodes: readonly ImageNode[]): void {
    const node = nodes[0];
    if (node === undefined) {
      sizeNote.textContent = '';
      sizeNote.dataset['state'] = '';
      return;
    }
    const asset = findAsset(editor.doc.assets, node.asset);
    if (asset === null) {
      sizeNote.textContent = 'This document has no asset record for this image.';
      sizeNote.dataset['state'] = 'error';
      return;
    }

    const box = node.transform;
    const atNativeSize =
      Math.round(asset.intrinsicWidth) === Math.round(box.width) &&
      Math.round(asset.intrinsicHeight) === Math.round(box.height);

    sizeNote.dataset['state'] = atNativeSize ? 'native' : 'scaled';
    sizeNote.textContent =
      `${formatLength(asset.intrinsicWidth, unit())} × ${formatLength(asset.intrinsicHeight, unit())}` +
      (atNativeSize ? '' : ' native');
  }

  container.append(textSection);
  // Sections are appended together here rather than beside their own construction,
  // because each is built in several steps (element, header, grid, fields) and inserting
  // one into `container` early would put it before the transform grid in source order —
  // which is also its visual order, since the panel is a plain column. Ordering is
  // therefore decided in one place, where the whole panel's structure is visible.
  container.append(appearanceSection);
  container.append(imageSection);

  /** Selected node ids that are text frames. */
  function textFrameIds(): string[] {
    return [...editor.selectionState.ids].filter(
      (id) => findNode(editor.doc, id)?.type === 'textFrame',
    );
  }

  function commitText(field: TextFieldSpec, input: HTMLInputElement): void {
    const ids = textFrameIds();
    if (ids.length === 0) return;

    const raw = input.value.trim();
    const parsed =
      field.kind === 'length'
        ? parseLength(raw, unit())
        : field.kind === 'ratio'
          ? parseRatio(raw)
          : parseColor(raw);

    if (parsed === null) {
      input.value = input.dataset['shown'] ?? '';
      input.classList.add('p1-inspector-field-input--invalid');
      return;
    }
    input.classList.remove('p1-inspector-field-input--invalid');

    store.mutate(ids.length > 1 ? `Text style ${ids.length} objects` : 'Typography', () => ({
      type: 'setTextStyle',
      ids,
      patch: { [field.key]: parsed } as TextStylePatch,
    }));
  }

  function syncTextSection(): void {
    const ids = textFrameIds();
    const frameIds = editor.selectionState.ids;
    // Shown only when *every* selected object is a text frame. A section that
    // half-applies is worse than no section.
    const allText = frameIds.size > 0 && ids.length === frameIds.size;
    textSection.hidden = !allText;
    if (!allText) return;

    for (const field of TEXT_FIELDS) {
      const input = textInputs.get(field.key);
      if (input === undefined) continue;

      const value = commonTextStyle(editor.doc, ids, field.key);
      if (value === undefined) {
        input.value = '';
        input.placeholder = ids.length > 1 ? 'Mixed' : '—';
        input.dataset['shown'] = '';
        continue;
      }

      input.placeholder = '';
      const shown =
        field.kind === 'length'
          ? formatLength(value as number, unit())
          : field.kind === 'ratio'
            ? formatRatio(value as number)
            : String(value);
      input.value = shown;
      input.dataset['shown'] = shown;
    }

    const align = commonAlign(editor.doc, ids);
    for (const [value, button] of alignButtons) {
      button.dataset['active'] = String(value === align);
    }

    // Format state has two sources, and the caller should not have to know which:
    // the browser while a session is open (where the model is stale by definition),
    // and the model otherwise. `TextSessionController.isFormatActive` owns the rule.
    const session = editor.textSession;
    const frameId = ids[0];
    for (const [flag, button] of formatButtons) {
      const active = session === null ? false : session.isFormatActive(flag, frameId);
      button.dataset['active'] = String(active);
    }

    syncLayoutNote(ids[0]);
  }

  /**
   * Writes the measured text size, or why there is none.
   *
   * Every status from ADR 0004 is rendered, because "no answer" and "zero" must not
   * look alike — a hidden frame measuring `0` is exactly the confusion the status
   * union exists to prevent, and it would reappear here if the note collapsed them.
   */
  function syncLayoutNote(frameId: string | undefined): void {
    if (frameId === undefined) {
      layoutNote.textContent = '';
      layoutNote.dataset['status'] = '';
      return;
    }

    const text = editor.measureTextContent(frameId);
    layoutNote.dataset['status'] = text.status;

    switch (text.status) {
      case 'ok': {
        const height = formatLength(text.size.height, unit());
        const frame = editor.measureNode(frameId);
        //
        // Compared as numbers, never as formatted strings. Comparing the strings
        // reports "overflowing" whenever the two differ, which is almost always -- so
        // a 19px text in a 50px frame announced itself as overflowing, on every
        // non-overflowing frame in the application. Found by looking at the rendered
        // readout; the code reads as though it means the right thing.
        const overflows = frame.status === 'ok' && text.size.height > frame.size.height;
        const frameHeight =
          frame.status === 'ok' ? formatLength(frame.size.height, unit()) : null;

        layoutNote.textContent =
          frameHeight === null
            ? `Text height ${height}`
            : overflows
              ? `Text height ${height} - overflowing a ${frameHeight} frame`
              : `Text height ${height} in a ${frameHeight} frame`;
        // Exposed so a browser test can assert the decision rather than parse prose.
        layoutNote.dataset['overflow'] = String(overflows);
        return;
      }
      case 'hidden':
        layoutNote.textContent = 'Text height unavailable - frame is hidden';
        return;
      case 'stale':
        layoutNote.textContent = 'Text height unavailable - waiting for the next render';
        return;
      default:
        layoutNote.textContent = 'Text height unavailable';
    }
  }

  sync();
  return { sync };
}

/**
 * The shared value at a dotted path, or `undefined` when the nodes differ or all leave
 * it unset.
 *
 * The path-based counterpart to `commonTransform`, and the reason the appearance fields
 * are declared by path rather than by getter. A getter pair would have to be invoked per
 * node per field and the "do they all agree" question would end up written once per
 * property — which is how a panel grows a sixth copy of the mixed-selection rule.
 */
function commonPath(
  nodes: readonly ShapeNode[],
  path: string,
): string | number | undefined {
  let shared: string | number | undefined;
  let first = true;

  for (const node of nodes) {
    const value = readPath(node, path);
    if (first) {
      shared = value;
      first = false;
      continue;
    }
    if (shared !== value) return undefined;
  }
  return shared;
}

// ---------------------------------------------------------------------------
// Shared object properties
// ---------------------------------------------------------------------------

/** The `BaseNode` fields the inspector exposes, and how each is read back from a string. */
type ObjectFieldKey = 'visible' | 'locked' | 'opacity' | 'blendMode';

interface ObjectFieldSpec {
  key: ObjectFieldKey;
  label: string;
  kind: 'boolean' | 'ratio' | 'enum';
}

const OBJECT_FIELDS: readonly ObjectFieldSpec[] = [
  { key: 'visible', label: 'Visible', kind: 'boolean' },
  { key: 'locked', label: 'Locked', kind: 'boolean' },
  { key: 'opacity', label: 'Opacity', kind: 'ratio' },
  { key: 'blendMode', label: 'Blend', kind: 'enum' },
];

/** Accepted blend modes, read off the model rather than restated. */
const BLEND_MODES_READABLE: readonly BlendMode[] = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
];

/** The model already guarantees a blend mode; an unrecognised string is refused here too. */
function isBlendMode(value: string): value is BlendMode {
  return (BLEND_MODES_READABLE as readonly string[]).includes(value);
}

/**
 * Parses one object field from the inspector's text, or `null` for anything unusable.
 *
 * Opacity is bounded to 0..1 because that is the model's range and the renderer's; a value
 * outside it is a typo, and clamping it silently would write something the user did not ask
 * for.
 */
function parseObjectField(key: ObjectFieldKey, raw: string): boolean | number | string | null {
  if (key === 'blendMode') {
    const value = raw.toLowerCase();
    return isBlendMode(value) ? value : null;
  }
  if (key === 'opacity') {
    const value = Number(raw);
    if (raw === '' || !Number.isFinite(value) || value < 0 || value > 1) return null;
    return value;
  }
  return raw === 'true' ? true : raw === 'false' ? false : null;
}

/** How a committed value is shown back. Two decimals, so 0.5 is not `0.5000000001`. */
function formatObjectField(key: ObjectFieldKey, value: boolean | number | string): string {
  if (key === 'opacity') return formatRatio(value as number);
  return String(value);
}

/** Reads a dotted path off a node. A missing path reads as `undefined`, not a throw. */
function readPath(node: object, path: string): string | number | undefined {
  let current: unknown = node;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  if (typeof current === 'string' || typeof current === 'number') return current;
  return undefined;
}

/**
 * A complete value for a container that does not exist yet, keyed by its dotted path.
 *
 * Needed because the model types are not bags: `Paint` is a discriminated union and
 * `Stroke` requires three fields, so setting one leaf cannot be done by writing the leaf.
 * This is the only place that knowledge lives — an object given a stroke here is
 * byte-identical to one created with it, because the defaults *are* creation's.
 *
 * A path with no entry returns `null`, which makes the command a no-op that `isNoop`
 * drops. Visible as "nothing happened" rather than as a half-applied edit.
 */
function containerDefault(path: string): Record<string, unknown> | null {
  if (path === 'fill') return { type: 'solid' };
  if (path === 'stroke') return { ...defaultStroke() };
  if (path === 'stroke.paint') return { type: 'solid' };
  return null;
}

/**
 * A `setProps` payload that sets one dotted path on a node.
 *
 * `setProps` spreads the payload over the node, so the payload has to carry a
 * **complete** replacement for the *top-level* key, not just the container nearest the
 * leaf. That distinction was the whole of an early bug here: cloning `node.stroke.paint`
 * and returning it under the key `stroke` produced `{ stroke: { type, color } }`, which
 * silently discarded `width` and `align` and made a line lose its stroke width the moment
 * its colour was edited. So the whole chain is rebuilt, from the top key down.
 *
 * An absent top-level value starts from `containerDefault`, which is why typing a weight
 * onto an object that has no stroke produces the same stroke creation would.
 */
function propsWithPath(
  node: ShapeNode,
  path: string,
  value: string | number,
): Record<string, unknown> {
  const keys = path.split('.');
  // `split` on a non-empty string always yields at least one element, but
  // `noUncheckedIndexedAccess` cannot see that, so the impossible case is stated.
  const top = keys[0];
  if (top === undefined) return {};
  if (keys.length === 1) return { [top]: value };

  const leaf = keys[keys.length - 1];
  if (leaf === undefined) return {};

  const existing = (node as unknown as Record<string, unknown>)[top];
  const seed =
    typeof existing === 'object' && existing !== null
      ? (existing as Record<string, unknown>)
      : containerDefault(keys.slice(0, 1).join('.'));
  if (seed === null) return {};

  // Clone the whole chain, so every sibling survives: editing `stroke.paint.color` must
  // not drop `stroke.width`, and editing `shape.cornerRadius` must not drop `shape.kind`.
  const root: Record<string, unknown> = { ...seed };
  let cursor = root;
  for (const key of keys.slice(1, -1)) {
    const child = cursor[key];
    if (typeof child !== 'object' || child === null) {
      // A container the node does not have and `containerDefault` does not describe.
      // Returning `{}` makes the command a no-op that `isNoop` drops -- "nothing happened"
      // rather than a half-applied edit.
      return {};
    }
    const cloned: Record<string, unknown> = { ...(child as Record<string, unknown>) };
    cursor[key] = cloned;
    cursor = cloned;
  }

  cursor[leaf] = value;
  return { [top]: root };
}

/**
 * The shared value of one typography property, or `undefined` when the frames differ
 * or all of them leave it unset.
 *
 * Mirrors `commonFrame` for transforms: differing values must never be shown as one
 * of them.
 */
function commonTextStyle(
  doc: Document,
  ids: readonly string[],
  key: TextFieldKey,
): string | number | undefined {
  let shared: string | number | undefined;
  let first = true;

  for (const id of ids) {
    const node = findNode(doc, id);
    const value = node?.type === 'textFrame' ? node.style?.[key] : undefined;
    if (first) {
      shared = value;
      first = false;
      continue;
    }
    if (shared !== value) return undefined;
  }
  return shared;
}

/** Shared alignment across a frame's paragraphs, or `undefined` when mixed. */
function commonAlign(doc: Document, ids: readonly string[]): ParagraphAlign | undefined {
  let shared: ParagraphAlign | undefined;
  let first = true;

  for (const id of ids) {
    const node = findNode(doc, id);
    const aligns = new Set<ParagraphAlign | undefined>(
      node?.type === 'textFrame' ? node.text.blocks.map((block) => block.align) : [],
    );
    const value = aligns.size === 1 ? [...aligns][0] : undefined;

    if (first) {
      shared = value;
      first = false;
      continue;
    }
    if (shared !== value) return undefined;
  }
  return shared;
}

/**
 * Parses a unitless ratio or em value.
 *
 * Unitless on purpose: `lineHeight` is a multiplier and `letterSpacing` is in em, so
 * a length would stop meaning what it meant after a font-size change (ADR 0003).
 */
function parseRatio(raw: string): number | null {
  if (raw === '') return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

function formatRatio(value: number): string {
  return String(Number(value.toFixed(3)));
}

/**
 * Validates a colour well enough to reject a typo before it reaches CSS.
 *
 * Deliberately permissive — any CSS colour string is legal, including `hsl()`,
 * `oklch()` and a named colour. The only rejection is an empty field, which would
 * otherwise silently unset the colour on a blur the user did not mean to make.
 */
function parseColor(raw: string): string | null {
  return raw === '' ? null : raw;
}

/** `parseLength` already handles the authored unit; degrees have no unit parser. */
function parseDegrees(raw: string): number | null {
  if (raw === '') return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? (value * Math.PI) / 180 : null;
}

/**
 * Parses a length into **document px**, defaulting a bare number to `defaultUnit`.
 *
 * The default matters more than it looks. The field *displays* the page's authored
 * unit, so a user who selects "30pt" and types "75" means 75pt. Letting `parseLength`
 * fall back to px would set 75px instead — a silent 25% error on a value the user can
 * see they typed correctly. The field has to read in the unit it writes in.
 */
function parseLength(raw: string, defaultUnit: PhysicalUnit): number | null {
  const hasUnit = /[a-z]+\s*$/i.test(raw.trim());
  const withDefault = hasUnit ? raw : `${raw}${defaultUnit}`;
  return parseLengthPx(withDefault);
}

function formatDegrees(radians: number): string {
  const degrees = (radians * 180) / Math.PI;
  return Number.isInteger(degrees) ? String(degrees) : degrees.toFixed(1);
}
