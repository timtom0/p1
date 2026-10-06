import { describe, expect, it } from 'vitest';
import {
  ALL_UNITS,
  formatLength,
  fromPx,
  isPhysicalUnit,
  isUnit,
  parseLength,
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

  it('parses lengths with and without units', () => {
    expect(parseLength('12')).toBeCloseTo(12, 9);
    expect(parseLength('12px')).toBeCloseTo(12, 9);
    expect(parseLength('25.4mm')).toBeCloseTo(96, 9);
    expect(parseLength(' 1 in ')).toBeCloseTo(96, 9);
    expect(parseLength('-3pt')).toBeCloseTo(-4, 9);
  });

  it('rejects unparseable input instead of guessing', () => {
    expect(parseLength('')).toBeNull();
    expect(parseLength('abc')).toBeNull();
    expect(parseLength('12em')).toBeNull();
    expect(parseLength('1,5mm')).toBeNull();
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