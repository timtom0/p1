/**

Per docs/ARCHITECTURE.md §1.1 the *internal* unit of the document model is the CSS `px`, as a float.
Physical units exist only at the authoring and display boundary, so the model and the DOM never
disagree about a length.

This module is pure: no DOM, no model types.

## What this module is for (M24)

Two directions, and they have **different** rules, which is the reason they are two functions rather
than one:

- **`parseLength`** reads what a person typed. A bare number means the *field's* unit.
- **`formatLength`** writes what a person reads. It never mutates anything; it returns a string.

That split is the whole M24 contract, and it is what `parseLength`'s previous signature got wrong: it
defaulted a bare number to `px`, which is the **CSS** convention and is correct for CSS but wrong for
a publishing document, where a bare number in a field displaying `mm` means millimetres. Three call
sites had grown private copies of the workaround; there is now one argument instead.

See `docs/adr/0022-document-measurement-units.md` for the contract and its sources.
 */

export type Unit = 'px' | 'pt' | 'pc' | 'in' | 'cm' | 'mm';

/** Units a page may be authored in. `px` is excluded: pages are physical. */
export type PhysicalUnit = Exclude<Unit, 'px'>;

/**
 * A unit a **document** may be authored in.
 *
 * A distinct name from {@link PhysicalUnit} rather than an alias, because the two answer different
 * questions and M24 exists to stop them being confused. `PhysicalUnit` is "the unit this *page's
 * dimensions* are written in", which is per page and is what `printSheetSize` reads. The document
 * unit is "the unit every *measurement field* in this document is shown and typed in", which is per
 * document. A Letter page in a millimetre document is normal and is the case that makes the
 * distinction load-bearing.
 */
export type MeasurementUnit = PhysicalUnit;

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

/**
 * The units a document may be authored in, in menu order.
 *
 * Millimetres first because it is the default for a new document and the unit every ISO paper size is
 * stated in. `px` is absent on purpose: a document is a physical object, and offering screen pixels
 * as its authoring unit would invite documents that print at the wrong size.
 */
export const MEASUREMENT_UNITS: readonly MeasurementUnit[] = ['mm', 'cm', 'in', 'pt', 'pc'];

/**
 * The unit a new document starts in.
 *
 * `mm`, and the reason is historical rather than editorial: `DEFAULT_PAGE_PRESET` has been A4 in
 * millimetres since before the format existed, so a document created with no explicit unit keeps the
 * page dimensions it has always had. Every pre-v6 file therefore migrates to `mm` too, which is what
 * makes the migration unobservable — see `format.ts`.
 */
export const DEFAULT_MEASUREMENT_UNIT: MeasurementUnit = 'mm';

export function isUnit(value: string): value is Unit {
  return Object.prototype.hasOwnProperty.call(UNITS_PER_INCH, value);
}

export function isPhysicalUnit(value: string): value is PhysicalUnit {
  return value !== 'px' && isUnit(value);
}

export function isMeasurementUnit(value: string): value is MeasurementUnit {
  return value !== 'px' && isUnit(value);
}

/**
 * Decimal places shown for a value in `unit`.
 *
 * ## The shape: the coarse unit gets more decimals than the fine one
 *
 * That is the part that matters and the part every "always two decimals" default gets backwards. A
 * value in inches is small (`8.5`) and needs more decimals to say anything; a value in points is
 * large (`595`) and needs fewer to say the same thing. Scribus's `unitGetPrecisionFromIndex` has the
 * same shape -- in 4, pt 2 -- and this table is the same shape with fewer digits.
 *
 * ## Why two, and why inches three
 *
 * Two decimals is the smallest number that round-trips a typical value through the field without
 * loss: 40px is 30.75pt, and one decimal would show `30.8` and store back 41.07. That was not a
 * hypothetical -- it broke about a dozen editor assertions before this was corrected, and the
 * symptom was a measurement off by 0.07px rather than anything recognisable as a unit bug.
 *
 * Inches get three because a page dimension is the one measurement where a hundredth of an inch is
 * routinely meaningful -- a bleed offset, a trim -- and because `8.5` needs the digits to say
 * anything at all.
 *
 * ## What this deliberately does not do
 *
 * It does not derive precision from the pixel. The tempting rule -- show the finest increment worth
 * at least a tenth of a pixel -- gives millimetres two decimals and points **one**, because 0.1pt is
 * 0.13px. That rule is self-consistent and it is wrong: it makes the displayed value unable to
 * represent the document's own geometry, and a field whose reading cannot be written back is a
 * field that cannot be edited. Legibility is bounded below by *round-trippability*, not only by the
 * raster.
 */
export const PRECISION_BY_UNIT: Readonly<Record<Unit, number>> = {
  mm: 2,
  cm: 2,
  in: 3,
  pt: 2,
  pc: 2,
  px: 2,
};

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
 * Parse a user-typed length into CSS pixels.
 *
 * ## The contract
 *
 * - A **bare number** is read in `defaultUnit`. That argument is required rather than defaulted,
 *   because the old behaviour — defaulting to `px` — was the CSS convention leaking into a document
 *   model, and it was wrong there in the worst way: a user who saw `mm` in the box, typed `75`, and
 *   got 75 *pixels* rather than 75 millimetres. Nothing looked wrong and the value was off by a
 *   factor of 3.4.
 * - A number **with a suffix** is read in that unit, whatever the field displays. `12mm` in a field
 *   showing `pt` is 12 millimetres, which is what every publishing application does and what a user
 *   who typed the suffix meant.
 * - Anything else returns `null`. The caller must decide what to do with it; this module never
 *   guesses, and in particular never falls back to zero.
 *
 * @param input    what the user typed
 * @param defaultUnit the unit a *bare* number is read in
 */
export function parseLength(input: string, defaultUnit: Unit): number | null {
  const match = LENGTH_PATTERN.exec(input.trim());
  if (!match) return null;
  const value = Number.parseFloat(match[1] as string);
  if (!Number.isFinite(value)) return null;
  const unit = (match[2] ?? defaultUnit) as Unit;
  return toPx(value, unit);
}

/**
 * The measured name of a rejection, for a field that wants to say *why*.
 *
 * Separate from `parseLength` returning `null` because "invalid" and "this unit is not one we
 * accept" are different mistakes, and the second one is worth naming: a caller that falls back to a
 * default on `null` has silently changed the user's unit.
 */
export type ParseProblem = 'empty' | 'not-a-number' | 'unknown-unit';

export interface ParseResult {
  /** CSS pixels, or `undefined` when the input could not be read. */
  px?: number;
  problem?: ParseProblem;
  /** The unit actually read, which differs from `defaultUnit` when a suffix was typed. */
  unit?: Unit;
}

/**
 * `parseLength` with the failure named.
 *
 * Not a replacement for it — this is what UI fields want, because a field that cannot say why it
 * refused shows the user a number they did not type and calls it theirs. `parseLength` stays for the
 * call sites that only need a yes/no.
 */
export function readLength(input: string, defaultUnit: Unit): ParseResult {
  const trimmed = input.trim();
  if (trimmed === '') return { problem: 'empty' };

  const match = LENGTH_PATTERN.exec(trimmed);
  if (!match) {
    // Name the cause rather than reporting a generic failure. A trailing token that is not one of
    // ours *and that follows a number* is the `12em` case, where the number is fine and the unit is
    // not -- saying "not a number" about a perfectly good number is worse than saying nothing.
    //
    // The digit test is what separates `12em` from `abc`: both end in letters, but only one of them
    // is someone who meant a unit and got the spelling wrong.
    const hasDigits = /\d/.test(trimmed);
    const suffix = trimmed.replace(/[\d.\-\s]/g, '');
    return { problem: hasDigits && suffix !== '' && !isUnit(suffix) ? 'unknown-unit' : 'not-a-number' };
  }

  const unit = (match[2] ?? defaultUnit) as Unit;
  const value = Number.parseFloat(match[1] as string);
  if (!Number.isFinite(value)) return { problem: 'not-a-number' };
  return { px: toPx(value, unit), unit };
}

/**
 * Format CSS pixels for display in `unit`, rounded to `precision` decimals with trailing zeros
 * removed ("12.5mm", not "12.50mm").
 *
 * `precision` defaults to {@link PRECISION_BY_UNIT} rather than to a constant, because two decimals
 * is right for millimetres and noise for points — and `printSheetSize` already had to pass `4`
 * explicitly for exactly that reason, which is the evidence that the old constant was a
 * presentation convenience rather than a decision.
 *
 * Returns a **string**. It cannot mutate the value it was handed, because it never receives one that
 * could be mutated.
 */
export function formatLength(px: number, unit: Unit, precision?: number): string {
  const value = fromPx(px, unit);
  const rounded = Number(value.toFixed(precision ?? PRECISION_BY_UNIT[unit]));
  return `${rounded}${unit}`;
}

/**
 * The number alone, with no suffix, for a field that shows its unit once in the label or beside it.
 *
 * Split from {@link formatLength} so that a field's unit is a property of the *field* rather than a
 * property of every value it renders — which is how a ruler tick and a spinbox end up disagreeing
 * about whether they are in millimetres.
 */
export function formatMeasure(px: number, unit: Unit, precision?: number): string {
  const value = fromPx(px, unit);
  return String(Number(value.toFixed(precision ?? PRECISION_BY_UNIT[unit])));
}
