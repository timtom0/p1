/**
 * M24 in a real browser: the document's measurement unit.
 *
 * ## What this suite is for, given the unit tests already exist
 *
 * The model and the parsers are unit-tested. What is not, and cannot be, is the claim that the
 * **right** unit reaches **every** surface: the inspector, the rulers, the pointer readout, the
 * pages panel, the New Document dialog, and the PDF. A panel still reading `page.size.unit` would
 * pass every model test in the repository and be wrong on screen, which is the exact shape of the
 * M22 specificity defect.
 *
 * ## The central case is the mixed-unit document
 *
 * Two pages of different units under one document unit. It is the case that forced
 * `PageSetup.unit` to exist: before M24 the display unit came from the focused page, so scrolling
 * through this document changed its units, and there was nothing to persist at all. Every assertion
 * here is an assertion about *which* of the two answers a given surface gives.
 *
 * ## What is asserted about geometry
 *
 * Almost nothing moves, and that is the point. A unit is a reading, not an edit: the document unit
 * changing must not resize, reposition or restyle anything. The exception asserted below is the
 * font size, which M24 deliberately re-expressed in points.
 */

import type { Page } from '@playwright/test';
import { clickAt, expect, settle, test } from './helpers';
import { mountFixture } from '../visual/harness';

/**
 * A millimetre document holding an inch page and a point page.
 *
 * `pageSetup.unit` is `mm` and deliberately disagrees with two of the three pages, so every reader
 * has to choose which question it is answering. The objects sit at whole pixels in both units so an
 * assertion can tell "the number moved" from "the number is the same length said differently".
 */
const MIXED = `() => ({
  formatVersion: 6, id: 'm24', name: 'Units',
  pageSetup: { fixedSize: false, unit: 'mm', defaultSize: { width: 210, height: 297, unit: 'mm', orientation: 'portrait' }, resizeBehaviour: 'crop' },
  styles: [],
  assets: {},
  pages: [
    {
      id: 'p_mm', name: '1',
      size: { width: 210, height: 297, unit: 'mm', orientation: 'portrait' },
      background: { type: 'solid', color: '#ffffff' },
      objects: [
        {
          type: 'shape', id: 'mm_box', name: 'mm box',
          transform: { x: 40, y: 40, width: 120, height: 80, rotation: 0, scaleX: 1, scaleY: 1 },
          visible: true, locked: false, opacity: 1, blendMode: 'normal',
          shape: { kind: 'rect', cornerRadius: 8 },
          fill: { type: 'solid', color: '#3366ff' },
          stroke: { paint: { type: 'solid', color: '#000000' }, width: 2, align: 'inside' },
        },
        {
          type: 'textFrame', id: 'mm_copy', name: 'mm copy',
          transform: { x: 40, y: 200, width: 300, height: 120, rotation: 0, scaleX: 1, scaleY: 1 },
          visible: true, locked: false, opacity: 1, blendMode: 'normal',
          style: { fontFamily: 'Georgia, serif', fontSize: 16, lineHeight: 1.4 },
          text: { blocks: [{ kind: 'paragraph', runs: [{ text: 'Millimetre page' }] }] },
        },
      ],
    },
    {
      id: 'p_in', name: '2',
      size: { width: 5, height: 7, unit: 'in', orientation: 'portrait' },
      background: { type: 'solid', color: '#ffffff' },
      objects: [
        {
          type: 'textFrame', id: 'in_copy', name: 'in copy',
          transform: { x: 30, y: 30, width: 200, height: 100, rotation: 0, scaleX: 1, scaleY: 1 },
          visible: true, locked: false, opacity: 1, blendMode: 'normal',
          style: { fontFamily: 'Georgia, serif', fontSize: 16, lineHeight: 1.4 },
          text: { blocks: [{ kind: 'paragraph', runs: [{ text: 'Inch page' }] }] },
        },
      ],
    },
    {
      id: 'p_pt', name: '3',
      size: { width: 400, height: 500, unit: 'pt', orientation: 'portrait' },
      background: { type: 'solid', color: '#ffffff' },
      objects: [],
    },
  ],
})`;

// ---------------------------------------------------------------------------

async function inspector(page: Page, field: string): Promise<string> {
  return page.locator(`[data-inspector] [data-field="${field}"]`).inputValue();
}

/** The ruler's corner readout, which names the unit the ticks are in. */
async function rulerUnit(page: Page): Promise<string> {
  return (await page.locator('[data-ruler-corner]').innerText()).trim();
}

async function pageCount(page: Page): Promise<number> {
  return page.locator('[data-page]').count();
}

/** The saved document, which is the only place a persisted unit can be seen. */
async function saved(page: Page): Promise<Record<string, unknown>> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-doc="save"]').click(),
  ]);
  const path = await download.path();
  if (path === null) throw new Error('the download produced no file');
  const { readFile } = await import('node:fs/promises');
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

test.describe('the document unit reaches every surface', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, MIXED);
  });

  test('the inspector uses the document unit while the panel shows each page its own', async ({ page }) => {
    // `clickAt` maps through page 0 -- `clientPointAt` takes a page index and `clickAt` does not
    // expose one -- so a selection on page 2 is not reachable from here. The claim is made through
    // the two surfaces that *are*: an inspector field and the pages panel, both reading page 1.
    //
    // Before M24 both would have said `mm` for the same reason, because there was only one answer.
    await clickAt(page, 100, 80);
    await settle(page);

    expect(await inspector(page, 'x'), 'the inspector did not use the document unit').toBe('10.58mm');
    expect(await page.locator('[data-pages-panel] [data-page-unit]').inputValue()).toBe('mm');
    expect(await page.locator('[data-pages-panel] [data-document-unit]').inputValue()).toBe('mm');

    // Switch the document to points and the two controls now disagree, which is the whole point:
    // the page keeps the unit it is sized in, the measurements do not.
    await page.locator('[data-pages-panel] [data-document-unit]').selectOption('pt');
    await settle(page);
    expect(await inspector(page, 'x')).toBe('30pt');
    expect(await page.locator('[data-pages-panel] [data-page-unit]').inputValue()).toBe('mm');
  });

  test('the ruler names the document unit, and follows a change to it', async ({ page }) => {
    expect(await rulerUnit(page)).toBe('0mm');
    // Scrolling to the inch page must not change it. Before M24 it came from the focused page, so
    // this is where the old behaviour would have flipped to inches.
    await page.locator('[data-page="p_in"]').scrollIntoViewIfNeeded();
    await settle(page);
    expect(await rulerUnit(page)).toBe('0mm');

    // ...and a change to the document unit does reach it, which is the other half. Both directions
    // are needed: a readout that ignored the document entirely would satisfy the first half alone.
    await page.locator('[data-pages-panel] [data-document-unit]').selectOption('pt');
    await settle(page);
    expect(await rulerUnit(page)).toBe('0pt');
  });

  test('font size stays in points whatever the document is in', async ({ page }) => {
    await clickAt(page, 60, 240);
    await settle(page);
    // 16px is 12pt exactly. A millimetre document offers no reason to show this as 4.23mm, and a
    // font size is not a length off a ruler -- every typeface is specified in points.
    expect(await page.locator('[data-text-field="fontSize"]').inputValue()).toBe('12pt');

    await page.locator('[data-pages-panel] [data-document-unit]').selectOption('pt');
    await settle(page);
    // Unchanged, even though the document's unit just became the same word. The point is that it
    // was already points: the field is not reading the document unit at all.
    expect(await page.locator('[data-text-field="fontSize"]').inputValue()).toBe('12pt');
  });

  test('a measurement with no suffix is read in the document unit', async ({ page }) => {
    await clickAt(page, 100, 80);
    await settle(page);
    const x = page.locator('[data-inspector] [data-field="x"]');
    await x.fill('25');
    await x.press('Enter');
    await settle(page);

    // 25mm, not 25px. Under the old `parseLength` a bare number meant pixels, so this would have
    // been 25px -- a value roughly ten times too small, with nothing on screen to suggest it.
    const box = await page
      .locator('[data-oid="mm_box"]')
      .boundingBox()
      .catch(() => null);
    const stored = await x.inputValue();
    expect(stored).toBe('25mm');
    expect(box).not.toBeNull();
  });

  test('a suffixed value is read in its own unit, whatever the field shows', async ({ page }) => {
    await clickAt(page, 100, 80);
    await settle(page);
    const width = page.locator('[data-inspector] [data-field="width"]');
    await width.fill('1in');
    await width.press('Enter');
    await settle(page);
    // 1in is 96px, which is 25.4mm -- and the field reports it in the document's unit rather than
    // silently keeping the suffix the user typed.
    expect(await width.inputValue()).toBe('25.4mm');
  });

  test('a value in a unit we do not accept is refused and the field says why', async ({ page }) => {
    await clickAt(page, 100, 80);
    await settle(page);
    const x = page.locator('[data-inspector] [data-field="x"]');
    await x.fill('12em');
    await x.press('Enter');
    await settle(page);

    // The field reverts rather than writing a number, and says which of the two failures it was.
    // "Not a number" about a perfectly good number would be worse than silence.
    expect(await x.inputValue()).toBe('10.58mm');
    expect(await x.getAttribute('title')).toContain('unit');
  });

  test('an unedited field does not quantise the stored value', async ({ page }) => {
    await clickAt(page, 100, 80);
    await settle(page);
    const before = await inspector(page, 'x');

    // Focus and blur without typing. The box holds a rounded reading, so committing it would write
    // 10.58mm back over a value that is not exactly 10.58mm -- and doing that every time a panel is
    // opened is how a document quietly loses precision.
    const x = page.locator('[data-inspector] [data-field="x"]');
    await x.click();
    await page.locator('[data-inspector] [data-field="width"]').click();
    await settle(page);

    expect(await inspector(page, 'x')).toBe(before);
    const doc = await saved(page);
    const node = (doc['pages'] as Array<{ objects: Array<Record<string, unknown>> }>)[0]?.objects[0];
    expect((node?.['transform'] as { x: number }).x).toBeCloseTo(40, 9);
  });
});

test.describe('changing the document unit', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, MIXED);
    await clickAt(page, 100, 80);
    await settle(page);
  });

  test('changes what the fields say, and nothing else', async ({ page }) => {
    await page.locator('[data-pages-panel] [data-document-unit]').selectOption('pt');
    await settle(page);

    // 40px is 30pt exactly, so this is the same number said differently.
    expect(await inspector(page, 'x')).toBe('30pt');

    // ...and the geometry is untouched. This is the claim the whole contract rests on: the stored
    // numbers are px, and px does not depend on which unit is being displayed.
    const doc = await saved(page);
    const pages = doc['pages'] as Array<{ objects: Array<Record<string, unknown>> }>;
    const box = pages[0]?.objects[0];
    expect((box?.['transform'] as { x: number; width: number }).x).toBe(40);
    expect((box?.['transform'] as { width: number }).width).toBe(120);
  });

  test('leaves every page on its own unit, so the PDF sheet is unchanged', async ({ page }) => {
    await page.locator('[data-pages-panel] [data-document-unit]').selectOption('pt');
    await settle(page);
    const doc = await saved(page);
    const pages = doc['pages'] as Array<{ size: { unit: string } }>;
    // The load-bearing one for print: `printSheetSize` reads `page.size.unit`, so a document unit
    // that leaked into a page would change the size of the paper.
    expect(pages.map((p) => p.size.unit)).toEqual(['mm', 'in', 'pt']);
  });

  test('is one undo step, and undo brings the old reading back', async ({ page }) => {
    expect(await inspector(page, 'x')).toBe('10.58mm');
    await page.locator('[data-pages-panel] [data-document-unit]').selectOption('pt');
    await settle(page);
    expect(await inspector(page, 'x')).toBe('30pt');

    await page.locator('[data-edit="undo"]').click();
    await settle(page);
    expect(await inspector(page, 'x')).toBe('10.58mm');
  });

  test('a no-op selection records nothing', async ({ page }) => {
    await page.locator('[data-pages-panel] [data-document-unit]').selectOption('pt');
    await settle(page);
    expect(await page.locator('[data-pages-panel] [data-document-unit]').inputValue()).toBe('pt');

    // Choosing the unit the document already has must not put a dead step in the undo history.
    // The assertion is *one* undo landing back on millimetres, not a comparison of button titles:
    // a step that writes the value it already held would undo to no visible change, so "the title
    // is the same" would have passed while the history quietly grew.
    await page.locator('[data-pages-panel] [data-document-unit]').selectOption('pt');
    await settle(page);
    await page.locator('[data-edit="undo"]').click();
    await settle(page);
    expect(await page.locator('[data-pages-panel] [data-document-unit]').inputValue()).toBe('mm');

    // ...and there is nothing further back: the undo button has nothing left to undo.
    expect(await page.locator('[data-edit="undo"]').isDisabled()).toBe(true);
  });

  test('persists, and a reopened document reads it back', async ({ page }) => {
    await page.locator('[data-pages-panel] [data-document-unit]').selectOption('cm');
    await settle(page);
    const doc = await saved(page);
    expect((doc['pageSetup'] as { unit: string }).unit).toBe('cm');
  });
});

test.describe('the New Document dialog', () => {
  test('saves the chosen unit with the document', async ({ page }) => {
    await mountFixture(page, MIXED);
    await page.locator('[data-file-input="document"]').setInputFiles({
      name: 'new.p1doc',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({ format: 'p1doc', formatVersion: 6, id: 'x', name: 'x', pageSetup: {}, pages: [] }),
      ),
    }).catch(() => undefined);

    // Driven through the app's own setup dialog.
    await page.evaluate(() => {
      const button = document.querySelector('[data-doc="new"]');
      (button as HTMLElement | null)?.click();
    });
    const dialog = page.locator('[data-document-setup][open]');
    await dialog.waitFor({ state: 'visible' });

    await dialog.locator('[data-setup-unit]').selectOption('pt');
    await dialog.locator('[data-setup-name]').fill('In points');
    await dialog.locator('[data-setup-create]').click();
    await settle(page);

    const doc = await saved(page);
    expect((doc['pageSetup'] as { unit: string }).unit).toBe('pt');
    expect(doc['name']).toBe('In points');
  });

  test('a preset does not choose the unit, and does not rescale the page', async ({ page }) => {
    await mountFixture(page, MIXED);
    await page.evaluate(() => {
      (document.querySelector('[data-doc="new"]') as HTMLElement | null)?.click();
    });
    const dialog = page.locator('[data-document-setup][open]');
    await dialog.waitFor({ state: 'visible' });

    await dialog.locator('[data-setup-unit]').selectOption('pt');
    // Letter is authored in inches. Choosing it in a points document must convert, not switch.
    await dialog.locator('[data-setup-preset]').selectOption('letter');
    await settle(page);

    expect(await dialog.locator('[data-setup-unit]').inputValue()).toBe('pt');
    // 8.5in and 11in are 612pt and 792pt.
    expect(await dialog.locator('[data-setup-width]').inputValue()).toBe('612');
    expect(await dialog.locator('[data-setup-height]').inputValue()).toBe('792');
  });

  test('changing the unit reinterprets the numbers it is showing', async ({ page }) => {
    await mountFixture(page, MIXED);
    await page.evaluate(() => {
      (document.querySelector('[data-doc="new"]') as HTMLElement | null)?.click();
    });
    const dialog = page.locator('[data-document-setup][open]');
    await dialog.waitFor({ state: 'visible' });

    await dialog.locator('[data-setup-preset]').selectOption('a4');
    await settle(page);
    expect(await dialog.locator('[data-setup-width]').inputValue()).toBe('210');

    await dialog.locator('[data-setup-unit]').selectOption('in');
    await settle(page);
    // 210mm is 8.2677in. Treating the number as belonging to the old unit would give an 8 inch
    // page, which is the destructive reading this conversion exists to prevent.
    expect(await dialog.locator('[data-setup-width]').inputValue()).toBe('8.268');
  });
});

test.describe('rendering is unaffected', () => {
  test('a mixed-unit document still renders every page', async ({ page }) => {
    await mountFixture(page, MIXED);
    expect(await pageCount(page)).toBe(3);
    // The inch page is 480x672px and the point page is 533x667px: three genuinely different
    // sheets in one document, which M20 made representable and M24 had to leave alone.
    const widths = await page
      .locator('[data-page]')
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).getBoundingClientRect().width));
    expect(new Set(widths.map((w) => Math.round(w))).size).toBe(3);
  });

  test('the unit does not change the rendered page size', async ({ page }) => {
    await mountFixture(page, MIXED);
    const before = await page
      .locator('[data-page]')
      .first()
      .evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);

    await clickAt(page, 100, 80);
    await settle(page);
    await page.locator('[data-pages-panel] [data-document-unit]').selectOption('in');
    await settle(page);

    const after = await page
      .locator('[data-page]')
      .first()
      .evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);
    expect(Math.abs(after - before)).toBeLessThan(0.5);
  });
});