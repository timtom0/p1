/**
 * Mixed-size documents, measured against a **generated PDF**.
 *
 * ## Why this file exists and why it reads a PDF
 *
 * M20 replaced one document-wide page size with a size per page, and the browser suite's existing
 * print tests assert the DOM and the CSS -- which is not the thing in question. The question is whether
 * a mixed-size document produces a PDF whose **sheets are the right sizes**, and only the generated
 * file can answer that.
 *
 * This is the check the named-page mechanism was designed for, and designing for it is not the same as
 * confirming it. `@page { size: … }` applies to every sheet, so the obvious implementation prints a
 * mixed document entirely on the first page's paper: the CSS is correct, the DOM is correct, and the
 * PDF is wrong. Nothing short of reading `/MediaBox` per page catches that.
 *
 * ## Units
 *
 * PDF user space is **points**, 72 per inch. A4 portrait is 595 x 842pt; A5 portrait is 420 x 595pt.
 * Expected values are derived from the model's own mm dimensions through that conversion rather than
 * pasted in, so a change to the unit handling shows up as a failure here instead of silently agreeing
 * with a stale constant.
 */

import type { Page } from '@playwright/test';

import { expect, settle, test } from './helpers';
import { mountFixture } from '../visual/harness';
import type { PageSize } from '../../src/model/types';

const PT_PER_MM = 72 / 25.4;

const A4_PORTRAIT = { width: 210, height: 297, unit: 'mm', orientation: 'portrait' } as const;
const A5_PORTRAIT = { width: 148, height: 210, unit: 'mm', orientation: 'portrait' } as const;
const A4_LANDSCAPE = { width: 210, height: 297, unit: 'mm', orientation: 'landscape' } as const;

/** Sheet size in points, with orientation already swapped -- the model's own rule. */
function sheetPt(size: PageSize): [number, number] {
  const w = size.width * PT_PER_MM;
  const h = size.height * PT_PER_MM;
  return size.orientation === 'landscape' ? [h, w] : [w, h];
}

/**
 * The page count and every sheet's `/MediaBox`, read out of the generated file.
 *
 * Duplicated from `print.spec.ts` rather than exported from it: that file is a test module, and a
 * shared PDF reader between two suites would make one of them a library. The parser is four lines and
 * its failure mode -- a compressed object stream hiding the page tree -- is documented where it is
 * written, and `print.spec.ts` has the longer explanation of why a count alone is not enough.
 */
function readPdf(buffer: Buffer): { pageCount: number; mediaBoxes: string[] } {
  const text = buffer.toString('latin1');
  const count = (text.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  const mediaBoxes = [...text.matchAll(/\/MediaBox\s*\[\s*([\d.\s-]+?)\]/g)].map((m) =>
    (m[1] ?? '').trim().replace(/\s+/g, ' '),
  );
  return { pageCount: count, mediaBoxes };
}

/** Each `/MediaBox` as `[width, height]` in points. */
function boxes(pdf: { mediaBoxes: string[] }): Array<[number, number]> {
  return pdf.mediaBoxes.map((box) => {
    const parts = box.split(' ').map(Number);
    const width = parts[2];
    const height = parts[3];
    if (width === undefined || height === undefined) throw new Error(`unreadable MediaBox "${box}"`);
    return [width, height] as [number, number];
  });
}

/** Chromium rounds the sheet to whole points, so this is a tolerance, not an equality. */
function expectSheet(actual: [number, number], expected: [number, number], label: string): void {
  expect(actual[0], `${label}: width`).toBeCloseTo(expected[0], 0);
  expect(actual[1], `${label}: height`).toBeCloseTo(expected[1], 0);
}

/**
 * Mounts a document with the given page sizes.
 *
 * The parameter is `PageSize[]`, not `typeof A4_PORTRAIT[]`: the sizes are declared `as const` so the
 * values are checkable, which makes their *types* literal too, and a parameter typed from the first
 * constant then rejects A5 outright. The two wants are different -- literal values for the test to
 * read, a real type for the array to hold a mix.
 */
async function mountMixed(page: Page, sizes: readonly PageSize[]): Promise<void> {
  await mountFixture(page, `() => ({
    formatVersion: 3,
    id: 'doc_mixed',
    name: 'Mixed',
    // One line, deliberately: ixture-guards.test.ts finds document literals by this field and
    // then checks that ssets sits on the next line or two. A pretty multi-line block here would fail
    // that guard for a formatting reason.
    pageSetup: { fixedSize: true, defaultSize: { width: 210, height: 297, unit: 'mm', orientation: 'portrait' }, resizeBehaviour: 'crop' },
    assets: {},
    pages: ${JSON.stringify(sizes)}.map((size, index) => ({
      id: 'page_' + index,
      name: String(index + 1),
      size,
      background: { type: 'solid', color: '#ffffff' },
      objects: [],
    })),
  })`);
  await settle(page);
}

/** Generates a real PDF through the same path the Export button uses. */
async function printToPdf(page: Page): Promise<ReturnType<typeof readPdf>> {
  const buffer = await page.pdf({ printBackground: true, preferCSSPageSize: true });
  return readPdf(buffer);
}

test.describe('a uniform document', () => {
  test('one sheet per page, each at the document size', async ({ page }) => {
    await mountMixed(page, [A4_PORTRAIT, A4_PORTRAIT, A4_PORTRAIT]);
    const pdf = await printToPdf(page);

    expect(pdf.pageCount, 'three document pages, three sheets').toBe(3);
    for (const [index, box] of boxes(pdf).entries()) {
      expectSheet(box, sheetPt(A4_PORTRAIT), `sheet ${index}`);
    }
  });
});

test.describe('a mixed-size document', () => {
  test('produces one sheet per page, each at that page own size', async ({ page }) => {
    // The measurement the whole milestone turns on. A single `@page { size }` rule would give three
    // sheets of A4 here, and this assertion is the only thing that can tell the difference.
    await mountMixed(page, [A4_PORTRAIT, A5_PORTRAIT, A4_LANDSCAPE]);
    const pdf = await printToPdf(page);

    expect(pdf.pageCount, 'three document pages, three sheets').toBe(3);
    const sizes = boxes(pdf);
    expectSheet(sizes[0]!, sheetPt(A4_PORTRAIT), 'sheet 0 (A4 portrait)');
    expectSheet(sizes[1]!, sheetPt(A5_PORTRAIT), 'sheet 1 (A5 portrait)');
    expectSheet(sizes[2]!, sheetPt(A4_LANDSCAPE), 'sheet 2 (A4 landscape)');
  });

  test('does not print extra sheets for a differently sized page', async ({ page }) => {
    // A4 portrait is 842pt tall and A5 landscape is 595 x 420. If the sheets were all A4, the shorter
    // page would leave a large blank area rather than becoming its own sheet; if the taller content
    // ran on, an extra sheet would appear. Both show up as a page count other than two.
    await mountMixed(page, [A4_PORTRAIT, A5_PORTRAIT]);
    const pdf = await printToPdf(page);
    expect(pdf.pageCount).toBe(2);
  });

  test('preserves page order', async ({ page }) => {
    // Reverse order, so a sort or a first-page-wins bug shows up as swapped sizes rather than as
    // correct-looking sizes in the wrong places.
    await mountMixed(page, [A5_PORTRAIT, A4_LANDSCAPE, A4_PORTRAIT]);
    const pdf = await printToPdf(page);

    const sizes = boxes(pdf);
    expect(pdf.pageCount).toBe(3);
    expectSheet(sizes[0]!, sheetPt(A5_PORTRAIT), 'sheet 0');
    expectSheet(sizes[1]!, sheetPt(A4_LANDSCAPE), 'sheet 1');
    expectSheet(sizes[2]!, sheetPt(A4_PORTRAIT), 'sheet 2');
  });

  test('prints a single non-default page at its own size', async ({ page }) => {
    // One page is the degenerate case where a "default `@page` only" implementation would look fine
    // for A4 and wrong for anything else. Small paper, so a wrong size is unmistakable.
    await mountMixed(page, [A5_PORTRAIT]);
    const pdf = await printToPdf(page);

    expect(pdf.pageCount).toBe(1);
    expectSheet(boxes(pdf)[0]!, sheetPt(A5_PORTRAIT), 'the only sheet');
  });
});

test.describe('the sheet is the page, not the stack', () => {
  test('the inter-page gap adds nothing to any sheet', async ({ page }) => {
    // The gap is view state and must not reach the printed page. If it did, every sheet but the first
    // would be taller than its page, which shows up here as a height mismatch rather than as an
    // obviously wrong page count.
    await mountMixed(page, [A4_PORTRAIT, A4_PORTRAIT, A4_PORTRAIT]);
    const pdf = await printToPdf(page);
    for (const [index, box] of boxes(pdf).entries()) {
      expectSheet(box, sheetPt(A4_PORTRAIT), `sheet ${index}`);
    }
  });
});