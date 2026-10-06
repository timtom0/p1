/**
 * Units.
 *
 * Per docs/ARCHITECTURE.md §1.1 the *internal* unit of the document model is the
 * CSS `px`, as a float. Physical units exist only at the authoring and display
 * boundary, so the model and the DOM never disagree about a length.
 *
 * This module is pure: no DOM, no model types.
 */

export type Unit = 'px' | 'pt' | 'pc' | 'in' | 'cm' | 'mm';

/** Units a page may be authored in. `px` is excluded: pages are physical. */
export type PhysicalUnit = Exclude<Unit, 'px'>;

/** Fixed by the CSS specification: 1in === 96px. */
export const PX_PER_INCH = 96;

const UNITS_PER_INCH: Readonly<Record<Unit, number>> = {
  px: 96,
  pt: 72,
  pc: 6,
  in: 1,
  cm: 2.54,
  mm: 25.4,
};

export const ALL_UNITS: readonly Unit[] = ['px', 'pt', 'pc', 'in', 'cm', 'mm'];

export function isUnit(value: string): value is Unit {
  return Object.prototype.hasOwnProperty.call(UNITS_PER_INCH, value);
}

export function isPhysicalUnit(value: string): value is PhysicalUnit {
  return value !== 'px' && isUnit(value);
}

/** Convert a length expressed in `unit` to CSS pixels. */
export function toPx(value: number, unit: Unit): number {
  return (value / UNITS_PER_INCH[unit]) * PX_PER_INCH;
}

/** Convert CSS pixels to a length expressed in `unit`. */
export function fromPx(px: number, unit: Unit): number {
  return (px / PX_PER_INCH) * UNITS_PER_INCH[unit];
}

const LENGTH_PATTERN = /^(-?\d*\.?\d+)\s*(px|pt|pc|in|cm|mm)?$/;

/**
 * Parse a user-typed length ("12", "12mm", "0.5 in") into CSS pixels.
 * Returns `null` for anything unparseable so callers can decide on feedback.
 */
export function parseLength(input: string): number | null {
  const match = LENGTH_PATTERN.exec(input.trim());
  if (!match) return null;
  const value = Number.parseFloat(match[1] as string);
  if (!Number.isFinite(value)) return null;
  const unit = (match[2] ?? 'px') as Unit;
  return toPx(value, unit);
}

/**
 * Format CSS pixels for display in `unit`, rounded to `precision` decimals with
 * trailing zeros removed ("12.5mm", not "12.50mm").
 */
export function formatLength(px: number, unit: Unit, precision = 2): string {
  const value = fromPx(px, unit);
  const rounded = Number(value.toFixed(precision));
  return `${rounded}${unit}`;
}