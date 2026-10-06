/**
 * The persistent format's vocabulary: constants, the persisted type, the error, and the
 * validation primitives.
 *
 * ## Why this file exists
 *
 * `serialize` and `deserialize` are inverses **through one description of what a document
 * is**. If each kept its own list of field names, the two would agree only until the first
 * field was added to one of them, and the symptom would be a document that loads with a
 * field quietly missing — the exact failure this milestone exists to make impossible.
 *
 * So the *description* lives here, once:
 *
 *  - {@link DOCUMENT_KEYS} and the per-field lists are the single statement of the shape.
 *  - The `expect*` readers are the single statement of the *rules* (finite, non-negative,
 *    in-range, one-of, declared-only).
 *  - {@link PersistedDocument} is the type both directions are checked against.
 *
 * `deserialize` uses the readers to validate. `serialize` uses the field lists to emit. And
 * the golden test proves the two agree, which is a stronger statement than either could
 * make about itself.
 *
 * ## Layer
 *
 * `persist/` imports `model/` and `core/` and nothing above them. It cannot see the
 * renderer, the editor or the UI, which is what makes "the format is not the DOM" an
 * enforced property rather than a convention -- there is no DOM in scope here to reach for.
 *
 * @module
 */

import { isPhysicalUnit } from '../core/units/units';
import type { PhysicalUnit } from '../core/units/units';
import type { Document } from '../model/types';

/** The `format` marker every persisted document carries. */
export const DOCUMENT_FORMAT = 'p1doc';

/**
 * The version this build **writes**.
 *
 * Re-exported from `model/factory.ts`, where the single literal lives. It was two literals until
 * M12 -- one here and one in `createDocument` -- which agreed by coincidence and then stopped;
 * see the constant's own comment for the failure that produced.
 *
 * Bumped **only** when the on-disk shape changes: a new field, a removed field, a changed
 * meaning. Adding a new *node type* or a new *shape kind* counts too, because an older
 * build must refuse the file rather than render the object as nothing.
 *
 * It started at **1**, not at the `3` of the §6.1 sketch. That sketch was written before any
 * of the fields it names existed, so there was nothing to be version 3 *of* -- and a version
 * number that claims a history nobody has is a version number that will be wrong later.
 *
 * ## It is 2 now, and here is the argument (M12, ADR 0012 §7)
 *
 * A group is a new **variant** of the existing `Node` union: no field was added to any other node,
 * none removed, none changed meaning, and the top-level shape (`{ formatVersion, pages[].objects }`)
 * is untouched. So the question "can the existing schema represent a recursive node?" answers
 * **yes** -- a discriminated union is exactly the construct that admits a new member without
 * disturbing its siblings.
 *
 * The project's own rule says bump anyway, and for a reason the answer above does not dissolve:
 * *an older build must refuse the file rather than render the object as nothing.* A version-1 build
 * would in fact refuse a group document -- `expectOnlyKeys` rejects `type: 'group'` at a named
 * path -- but only because the node type happens to be unknown to it. That is a refusal for an
 * incidental reason, resting on a *different* rule continuing to hold. Making it a version rule
 * makes the refusal deliberate instead.
 *
 * So the rule was followed rather than re-argued, and the cost is one accepted version number.
 */
export { CURRENT_FORMAT_VERSION } from '../model/factory';

/**
 * The oldest version this build reads.
 *
 * The first time this has had more than one accepted value, and the reason deserves being explicit
 * because it looks like the thing ADR 0007 forbade: **this is not a migration.** That ADR said "no
 * migrations", and it still holds.
 *
 * A version-1 document is a strict *subset* of version 2. It is the same document with no
 * `children` array anywhere, because version 1 had no `group` type at all -- so there is nothing to
 * convert, no field to default, and no authored content at risk. Accepting 1 is not "reading an old
 * format"; it is "reading this format, written before groups existed".
 *
 * What does change: opening a version-1 file and saving it stamps `formatVersion: 2`. That is a
 * version bump and nothing else, which is the entire difference, and it is why the golden fixtures
 * are re-stamped rather than regenerated.
 *
 * A lower bound rather than a set, because the error messages are two-sided and must stay
 * two-sided: above `CURRENT` is **newer** (written by a build that knows more) and below this is
 * **older**. Both messages are unchanged.
 */
export const MINIMUM_FORMAT_VERSION = 1;

/** The file extension offered on save and accepted on open. */
export const DOCUMENT_EXTENSION = '.p1doc';

/**
 * The persisted shape.
 *
 * `Document` plus the `format` marker. Deliberately **not** a separate hierarchy that
 * `deserialize` would have to map field by field twice: declaring the format as "the model,
 * with a marker and a canonical key order" is what lets one description serve both
 * directions.
 */
export interface PersistedDocument extends Omit<Document, 'formatVersion'> {
  format: typeof DOCUMENT_FORMAT;
  formatVersion: number;
}

/** What went wrong, and where. Never a partially usable document. */
export class DocumentParseError extends Error {
  /** Dotted path of the offending value, e.g. `pages[1].objects[3].transform.width`. */
  readonly path: string;

  constructor(path: string, message: string, options?: { cause?: unknown }) {
    super(path === '' ? message : `${path}: ${message}`, options);
    this.name = 'DocumentParseError';
    this.path = path;
  }
}

// ---------------------------------------------------------------------------
// The shape, stated once
// ---------------------------------------------------------------------------

export const DOCUMENT_KEYS = [
  'format',
  'formatVersion',
  'id',
  'name',
  'pageSize',
  'assets',
  'pages',
] as const;

export const PAGE_SIZE_KEYS = ['width', 'height', 'unit', 'orientation'] as const;

export const PAGE_KEYS = ['id', 'name', 'background', 'objects'] as const;

export const ASSET_RECORD_KEYS = [
  'kind',
  'mime',
  'intrinsicWidth',
  'intrinsicHeight',
  'data',
] as const;

export const TRANSFORM_KEYS = [
  'x',
  'y',
  'width',
  'height',
  'rotation',
  'scaleX',
  'scaleY',
] as const;

export const STROKE_KEYS = ['paint', 'width', 'align'] as const;

/**
 * A group node's type-specific key: the ordered child array.
 *
 * **Order is authored, never sorted.** A group's `children` is paint order, so `[B, C]` and
 * `[C, B]` are different documents — see `document-equality.ts`, where they compare unequal. This is
 * the same rule the page's `objects` already follows, stated here because `children` is the first
 * array in the format whose order is not page order, and a reader who assumed otherwise would
 * eventually "tidy" it.
 */
export const GROUP_NODE_KEYS = ['children'] as const;

export const PAINT_KEYS = ['type', 'color'] as const;

export const RICH_TEXT_KEYS = ['blocks'] as const;

export const PARAGRAPH_KEYS = ['kind', 'align', 'runs'] as const;

export const RUN_KEYS = ['text', 'format'] as const;

export const TEXT_STYLE_KEYS = [
  'fontFamily',
  'fontSize',
  'lineHeight',
  'letterSpacing',
  'color',
] as const;

/** Fields every node carries, whatever its type. */
export const SHARED_NODE_KEYS = [
  'id',
  'type',
  'name',
  'transform',
  'visible',
  'locked',
  'opacity',
  'blendMode',
] as const;

// ---------------------------------------------------------------------------
// Closed sets
//
// Read off the model wherever a registry exists, so a value cannot drift out of step with
// the type it validates. Where the type is a bare union with no registry, the list is
// restated -- and the typecheck is what keeps it honest, because `deserialize` casts
// through the element type. A list that gained a value the union does not have would stop
// compiling.
// ---------------------------------------------------------------------------

/** Flag order is also the serialization order, so two equal runs always emit equally. */
export const CHAR_FLAGS = ['bold', 'italic', 'underline', 'strike'] as const;

export const BLEND_MODES = [
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
] as const;

export const PARAGRAPH_ALIGNS = ['left', 'center', 'right', 'justify'] as const;

export const ORIENTATIONS = ['portrait', 'landscape'] as const;

/** The type carries all three; only `inside` renders (ADR 0005 §2). */
export const STROKE_ALIGNS = ['center', 'inside', 'outside'] as const;

/** Only for the error message; `isPhysicalUnit` is the real check. */
export const PHYSICAL_UNITS = ['pt', 'pc', 'in', 'cm', 'mm'] as const;

// ---------------------------------------------------------------------------
// Validation primitives
//
// Each names its own path, because "it failed to load" is not an actionable message and
// `pages[1].objects[3].transform.width` is.
// ---------------------------------------------------------------------------

export function expectRecord(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new DocumentParseError(path, `expected an object, got ${describe(input)}`);
  }
  return input as Record<string, unknown>;
}

export function expectArray(input: unknown, path: string): unknown[] {
  if (!Array.isArray(input)) {
    throw new DocumentParseError(path, `expected an array, got ${describe(input)}`);
  }
  return input;
}

export function expectString(input: unknown, path: string): string {
  if (typeof input !== 'string') {
    throw new DocumentParseError(path, `expected a string, got ${describe(input)}`);
  }
  return input;
}

export function expectBoolean(input: unknown, path: string): boolean {
  if (typeof input !== 'boolean') {
    throw new DocumentParseError(path, `expected a boolean, got ${describe(input)}`);
  }
  return input;
}

export function expectNumber(input: unknown, path: string): number {
  if (typeof input !== 'number') {
    throw new DocumentParseError(path, `expected a number, got ${describe(input)}`);
  }
  return input;
}

export function expectFinite(input: unknown, path: string): number {
  const value = expectNumber(input, path);
  if (!Number.isFinite(value)) {
    throw new DocumentParseError(path, `must be finite, got ${describe(input)}`);
  }
  return value;
}

export function expectPositiveNumber(input: unknown, path: string): number {
  const value = expectFinite(input, path);
  if (value <= 0) throw new DocumentParseError(path, `must be greater than 0, got ${value}`);
  return value;
}

export function expectNonNegative(input: unknown, path: string): number {
  const value = expectFinite(input, path);
  if (value < 0) throw new DocumentParseError(path, `must not be negative, got ${value}`);
  return value;
}

export function expectNonZero(input: unknown, path: string): number {
  const value = expectFinite(input, path);
  if (value === 0) {
    throw new DocumentParseError(path, 'must not be 0: it makes the transform non-invertible');
  }
  return value;
}

export function expectOpacity(input: unknown, path: string): number {
  const value = expectFinite(input, path);
  if (value < 0 || value > 1) {
    throw new DocumentParseError(path, `must be between 0 and 1, got ${value}`);
  }
  return value;
}

export function expectId(input: unknown, path: string): string {
  const value = expectString(input, path);
  if (value === '') throw new DocumentParseError(path, 'must not be empty');
  return value;
}

export function expectPhysicalUnit(input: unknown, path: string): PhysicalUnit {
  const value = expectString(input, path);
  if (!isPhysicalUnit(value)) {
    // `px` is excluded deliberately: the field is a *physical* unit, so a document authored
    // in px has no defined print size. `isPhysicalUnit` is the model's own rule, read
    // rather than restated here.
    throw new DocumentParseError(
      path,
      `expected a physical unit (${PHYSICAL_UNITS.join(', ')}), got "${value}"`,
    );
  }
  return value;
}

export function expectEnum<T extends string>(
  input: unknown,
  path: string,
  allowed: readonly T[],
): T {
  const value = expectString(input, path);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new DocumentParseError(
      path,
      `expected one of ${allowed.map((v) => `"${v}"`).join(', ')}, got "${value}"`,
    );
  }
  return value as T;
}

/**
 * Rejects undeclared keys.
 *
 * The whole point of the format's version story: a key this build does not know is a
 * version mismatch or a hand-edit, and **silently dropping it would let a document look
 * fine after a round trip while having quietly lost authored state**. Refusing is loud and
 * names the key, which is what makes a hand-repair possible.
 *
 * `extensions` is the one declared exception: it is opaque by definition, so a build that
 * writes it knows this build cannot interpret it.
 */
export function expectOnlyKeys(
  record: Record<string, unknown>,
  path: string,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(record)) {
    if (allowed.includes(key)) continue;
    throw new DocumentParseError(
      path === '' ? key : `${path}.${key}`,
      `unknown field "${key}" (this build understands: ${allowed.join(', ')})`,
    );
  }
}

export function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'missing';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}