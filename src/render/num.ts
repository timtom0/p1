/**
 * CSS value formatting.
 *
 * Numbers written to the DOM must format *stably*, because the reconciler's
 * style cache compares strings to decide whether a write is needed. Rounding to
 * a fixed precision keeps `0.1 + 0.2` from producing a spurious write on every
 * frame, and keeps style strings short.
 */

/** Round to sub-micron precision: far finer than any display, coarse enough to be stable. */
export function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Format a number as a CSS length in `unit`. */
export function cssLength(value: number, unit = 'px'): string {
  return `${round(value)}${unit}`;
}

/**
 * Format a unitless CSS number, with the same stable rounding as lengths.
 *
 * Used for `line-height`, which is a multiplier rather than a length: writing
 * `19.2px` would stop meaning the same thing the moment the font size changed.
 */
export function cssNumber(value: number): string {
  return String(round(value));
}

/**
 * Format a matrix as a CSS `matrix()` value. M0 matrices are rotation × scale
 * with no translation, so `e`/`f` are normally zero.
 */
export function cssMatrix(m: {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}): string {
  return `matrix(${round(m.a)}, ${round(m.b)}, ${round(m.c)}, ${round(m.d)}, ${round(m.e)}, ${round(m.f)})`;
}