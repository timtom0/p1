/**
 * M19: the print profile's size derivation.
 *
 * These are the parts that can be settled without a browser, and they are the parts most likely to be
 * wrong quietly: a sheet that is 2mm short still *prints*, and the user finds out when a duplex job
 * runs short of paper.
 *
 * Two rules are being protected here:
 *
 *  - **Orientation is resolved once.** `printSheetSize` calls `pageExtentPx` rather than swapping
 *    width and height itself, so the sheet and the rendered page cannot disagree about what "landscape"
 *    means. A mutant that re-implements the swap locally would pass a portrait test and disagree on a
 *    landscape one.
 *  - **The unit round-trips.** The value goes out to px (`pageExtentPx`) and comes back (`formatLength`),
 *    so `210mm` has to come back as `210mm` rather than `209.99999mm`. That is the whole reason the
 *    formatter rounds rather than the caller.
 */

import { describe, expect, it } from 'vitest';

import { printProfileCss, printSheetSize } from './print-profile';
import { pageExtentPx } from '../model/page';
import { fromPx } from '../core/units/units';
import type { PageSize } from '../model/types';

const size = (
  width: number,
  height: number,
  unit: PageSize['unit'],
  orientation: PageSize['orientation'] = 'portrait',
): PageSize => ({ width, height, unit, orientation });

/** The two numbers out of a `printSheetSize` result, as written. */
const pair = (sheet: string): [string, string] => {
  const parts = sheet.split(' ') as [string, string];
  return parts;
};

describe('printSheetSize', () => {
  it('uses the authored unit, not a hardcoded A4', () => {
    expect(printSheetSize(size(210, 297, 'mm'))).toBe('210mm 297mm');
    expect(printSheetSize(size(8.5, 11, 'in'))).toBe('8.5in 11in');
    expect(printSheetSize(size(595, 842, 'pt'))).toBe('595pt 842pt');
  });

  it('swaps for landscape, because the sheet follows the page', () => {
    expect(printSheetSize(size(210, 297, 'mm', 'landscape'))).toBe('297mm 210mm');
    expect(printSheetSize(size(11, 8.5, 'in', 'landscape'))).toBe('8.5in 11in');
  });

  it('round-trips through px without accumulating noise', () => {
    // 210mm is 793.7007874px. Without the formatter's rounding this is the test that fails.
    const sheet = printSheetSize(size(210, 297, 'mm'));
    expect(sheet, 'no precision beyond what a page size can state').not.toMatch(/\d\.\d{5,}/);
    expect(sheet).toBe('210mm 297mm');
  });

  it('agrees with the size the renderer gives a page element', () => {
    // The point of reusing `pageExtentPx`: one definition of the page box. Each authored number is
    // converted to px the way the renderer does it, then back, and must land on itself — in the order
    // the extent actually has, which is the order the sheet string is written in.
    for (const orientation of ['portrait', 'landscape'] as const) {
      const authored = size(210, 297, 'mm', orientation);
      const extent = pageExtentPx(authored);
      const [width, height] = pair(printSheetSize(authored));
      expect(Number.parseFloat(width), `${orientation} width`).toBeCloseTo(
        fromPx(extent.width, 'mm'),
        3,
      );
      expect(Number.parseFloat(height), `${orientation} height`).toBeCloseTo(
        fromPx(extent.height, 'mm'),
        3,
      );
    }
  });

  it('handles units other than the common two', () => {
    // 2.54cm x 5.08cm is a 1in x 2in page, chosen so the expected values are exact in the authored
    // unit rather than in some other one.
    expect(printSheetSize(size(2.54, 5.08, 'cm'))).toBe('2.54cm 5.08cm');
    expect(printSheetSize(size(2, 1, 'pc'))).toBe('2pc 1pc');
  });
});

describe('printProfileCss', () => {
  it('declares the sheet and zeroes the margin', () => {
    // `margin: 0` is what makes "one document page per sheet" true: with the browser's default page
    // margin, a full-size page element is shrunk to fit inside it and every sheet gets a border.
    expect(printProfileCss(size(210, 297, 'mm'))).toBe('@page { size: 210mm 297mm; margin: 0; }');
  });

  it('is scoped to the sheet, so it cannot restyle the editor', () => {
    const css = printProfileCss(size(210, 297, 'mm'));
    expect(css.startsWith('@page')).toBe(true);
    // Nothing in the injected rule may touch `.toolbar`, `.page` or a colour: the chrome and clipping
    // rules live in the print stylesheet, where they are reviewable in one place.
    expect(css).not.toContain('.toolbar');
    expect(css).not.toContain('.page');
    expect(css).not.toContain('color');
  });
});