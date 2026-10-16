import { describe, expect, it } from 'vitest';
import {
  ALL_UNITS,
  formatLength,
  fromPx,
  isPhysicalUnit,
  isUnit,
  parseLength,
  readLength,
  toPx,
  PX_PER_INCH,
} from './units';

describe('units', () => {
  it('anchors on the CSS definition of the inch', () => {
    expect(toPx(1, 'in')).toBeCloseTo(PX_PER_INCH, 12);
    expect(fromPx(PX_PER_INCH, 'in')).toBeCloseTo(1, 12);
  });

  it('converts the physical units a page can use', () => {
    expect(toPx(25.4, 'mm')).toBeCloseTo(96, 9);
    expect(toPx(2.54, 'cm')).toBeCloseTo(96, 9);
    expect(toPx(72, 'pt')).toBeCloseTo(96, 9);
    expect(toPx(6, 'pc')).toBeCloseTo(96, 9);
  });

  it('round-trips every unit without drift', () => {
    for (const unit of ALL_UNITS) {
      for (const value of [0, 1, 7.5, 123.456, -42]) {
        expect(fromPx(toPx(value, unit), unit)).toBeCloseTo(value, 9);
      }
    }
  });

  it('leaves px untouched', () => {
    expect(toPx(17.5, 'px')).toBe(17.5);
    expect(fromPx(17.5, 'px')).toBe(17.5);
  });

  it('resolves an A4 page to the expected pixel size', () => {
    // 210×297mm — the sample document's page.
    expect(toPx(210, 'mm')).toBeCloseTo(793.7007874, 6);
    expect(toPx(297, 'mm')).toBeCloseTo(1122.5196850, 6);
  });

  it('reads a bare number in its own field unit, which is the M24 contract', () => {
    // The regression this milestone exists to prevent. The old signature defaulted a bare number to
    // `px`, so a field displaying `mm` that received "75" stored 75 *pixels* -- off by a factor of
    // 3.4, with nothing on screen to suggest it.
    expect(parseLength('75', 'mm')).toBeCloseTo(toPx(75, 'mm'), 9);
    expect(parseLength('75', 'pt')).toBeCloseTo(toPx(75, 'pt'), 9);
    expect(parseLength('75', 'in')).toBeCloseTo(75 * 96, 9);
    // ...and a suffix still wins over the field's unit, so `12mm` in a points field is 12mm.
    expect(parseLength('12mm', 'pt')).toBeCloseTo(toPx(12, 'mm'), 9);
    expect(parseLength('12', 'pt')).not.toBeCloseTo(parseLength('12mm', 'pt') as number, 3);
  });

  it('parses lengths with and without units', () => {
    expect(parseLength('12', 'px')).toBeCloseTo(12, 9);
    expect(parseLength('12px', 'mm')).toBeCloseTo(12, 9);
    expect(parseLength('25.4mm', 'px')).toBeCloseTo(96, 9);
    expect(parseLength(' 1 in ', 'px')).toBeCloseTo(96, 9);
    expect(parseLength('-3pt', 'px')).toBeCloseTo(-4, 9);
  });

  it('rejects unparseable input instead of guessing', () => {
    expect(parseLength('', 'mm')).toBeNull();
    expect(parseLength('abc', 'mm')).toBeNull();
    expect(parseLength('12em', 'mm')).toBeNull();
    expect(parseLength('1,5mm', 'mm')).toBeNull();
    // Scribus returns 0 for all four of these (`unitValueFromString`). Returning `null` is the
    // deliberate deviation: zero is a *value*, and a field that cannot tell "refused" from "zero"
    // writes a number the user did not type.
  });

  it('names why a value was refused, so a field can say so', () => {
    expect(readLength('', 'mm').problem).toBe('empty');
    expect(readLength('abc', 'mm').problem).toBe('not-a-number');
    // The distinction that matters: `12em` is not a number *we accept*, and telling a user "not a
    // number" about a string that plainly is one is worse than saying nothing.
    expect(readLength('12em', 'mm').problem).toBe('unknown-unit');
    expect(readLength('12mm', 'pt')).toEqual({ px: toPx(12, 'mm'), unit: 'mm' });
    expect(readLength('12', 'pt')).toEqual({ px: toPx(12, 'pt'), unit: 'pt' });
  });

  it('formats without trailing zeros', () => {
    expect(formatLength(toPx(12.5, 'mm'), 'mm')).toBe('12.5mm');
    expect(formatLength(toPx(25.4, 'mm'), 'mm')).toBe('25.4mm');
    expect(formatLength(96, 'in')).toBe('1in');
    expect(formatLength(0, 'mm')).toBe('0mm');
  });

  it('classifies units', () => {
    expect(isUnit('mm')).toBe(true);
    expect(isUnit('em')).toBe(false);
    expect(isPhysicalUnit('px')).toBe(false);
    expect(isPhysicalUnit('pt')).toBe(true);
  });
});