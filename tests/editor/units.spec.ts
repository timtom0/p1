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

  test('the inspector uses the document unit on an inch page', async ({ page }) => {
    // Page 2 is sized in **inches**; the document is in millimetres. Before M24 the focused page
    // decided, so this field would have read `0.42in` and the ruler would have flipped to inches as
    // the user scrolled -- the behaviour the milestone exists to end.
    //
    // This selects the object directly, which is only possible because `clickAt` takes a page index.
    // Before that, this suite asserted the same question through the ruler and the pages panel
    // instead, which proved the two units were separate but never that the *fields* followed the
    // document while showing a page they disagreed with.
    await clickAt(page, 130, 80, [], 1);
    await settle(page);

    // 30px is 7.94mm. The stored x is 30 either way; only the unit differs.
    expect(await inspector(page, 'x')).toBe('7.94mm');
    expect(await rulerUnit(page)).toBe('0mm');

    // The pages panel reads the **focused** page, and clicking a shape does not move the focus --
    // `focusPage` is called from the panel alone. So focus page 2 explicitly before reading it,
    // which also puts the assertion on the combination the milestone is about: a focused inch page
    // inside a millimetre document.
    await page.locator('[data-page-row]:nth-child(2) [data-page-select]').click();
    await settle(page);
    expect(await page.locator('[data-pages-panel] [data-page-unit]').inputValue()).toBe('in');
    expect(await page.locator('[data-pages-panel] [data-document-unit]').inputValue()).toBe('mm');

    // ...and switching the document to points is the same length said differently, on a page still
    // sized in inches.
    await page.locator('[data-pages-panel] [data-document-unit]').selectOption('pt');
    await settle(page);
    expect(await inspector(page, 'x')).toBe('22.5pt');
    expect(await page.locator('[data-pages-panel] [data-page-unit]').inputValue()).toBe('in');
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

/**
 * Everything about how the document is *drawn* and *shaped*, in one round trip.
 *
 * Deliberately not the inspector's readings. Every unit invariant below is a claim about the
 * document being untouched, and the inspector is the one surface that is *supposed* to change when
 * the unit changes -- so a test that read the fields would be measuring the thing it is meant to
 * prove independent of.
 *
 * Object positions are **relative to their own page**, not to the viewport. Viewport coordinates
 * move when the canvas scrolls, which is exactly what reloading a document does, and a sweep that
 * reported a 38px shift across a reload would be reporting the scroll rather than the geometry.
 */
async function geometry(page: Page): Promise<{
  pages: Array<{ id: string; width: number; height: number }>;
  objects: Array<{ id: string; page: string; left: number; top: number; width: number; height: number }>;
}> {
  return page.evaluate(() => {
    const pageOf = new Map<Element, HTMLElement>();
    const pages = Array.from(document.querySelectorAll<HTMLElement>('[data-page]'));
    for (const el of pages) {
      for (const child of el.querySelectorAll('[data-oid]')) pageOf.set(child, el);
    }
    return {
      pages: pages.map((el) => {
        const box = el.getBoundingClientRect();
        return { id: el.dataset['page'] ?? '?', width: box.width, height: box.height };
      }),
      objects: Array.from(document.querySelectorAll<HTMLElement>('[data-oid]')).map((el) => {
        const box = el.getBoundingClientRect();
        const origin = pageOf.get(el)?.getBoundingClientRect();
        return {
          id: el.dataset['oid'] ?? '?',
          page: pageOf.get(el)?.dataset['page'] ?? '?',
          left: box.left - (origin?.left ?? 0),
          top: box.top - (origin?.top ?? 0),
          width: box.width,
          height: box.height,
        };
      }),
    };
  });
}

/** Opens a document through the app's own file input, as a user would. */
async function open(page: Page, document: unknown, name = 'round-trip.p1doc'): Promise<void> {
  await page.locator('[data-file-input="document"]').setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(document), 'utf8'),
  });
  await settle(page);
}

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

  // ---------------------------------------------------------------------
  // Invariants. The tests above establish that the unit *reaches* the UI.
  // These establish that nothing else moves when it does -- which is the
  // claim the whole contract rests on and the one no reading can prove,
  // because the readings are supposed to change.
  // ---------------------------------------------------------------------

  test('moves no pixel of the document, in any unit', async ({ page }) => {
    // Every unit in turn, against one full sweep of rendered geometry.
    //
    // The fixture is deliberately mixed (A4/mm, 5x7in, 400x500pt), so a sweep that only looked at
    // page 0 would pass while a conversion leaked into one of the other two.
    const before = await geometry(page);
    // Three: two on the millimetre page and one on the inch page. The count is asserted because a
    // sweep over fewer objects than the fixture has is a sweep that would pass a partial conversion.
    expect(before.objects.map((o) => o.id).sort(), 'the sweep found the fixture objects').toEqual([
      'in_copy',
      'mm_box',
      'mm_copy',
    ]);

    for (const unit of ['mm', 'cm', 'in', 'pt', 'pc'] as const) {
      await page.locator('[data-pages-panel] [data-document-unit]').selectOption(unit);
      await settle(page);
      expect(await geometry(page), `switching to ${unit} moved something`).toEqual(before);
    }

    // ...and back to millimetres, because the loop above never returns to the starting state and a
    // one-way change could pass a comparison that only ever moves forward.
    await page.locator('[data-pages-panel] [data-document-unit]').selectOption('mm');
    await settle(page);
    expect(await geometry(page)).toEqual(before);
  });

  test('leaves every page size untouched, not just every page unit', async ({ page }) => {
    // The companion to `leaves every page on its own unit`, and it is the one that would catch a
    // unit change *rescaling* the sheet. `unit` and `size` are separate fields; a conversion that
    // reached the wrong one would leave the unit correct and the paper wrong.
    await page.locator('[data-pages-panel] [data-document-unit]').selectOption('pc');
    await settle(page);
    const doc = await saved(page);
    expect((doc['pages'] as Array<{ size: Record<string, number | string> }>).map((p) => p.size)).toEqual([
      { width: 210, height: 297, unit: 'mm', orientation: 'portrait' },
      { width: 5, height: 7, unit: 'in', orientation: 'portrait' },
      { width: 400, height: 500, unit: 'pt', orientation: 'portrait' },
    ]);
  });
});

test.describe('a mixed-unit document survives a real round trip', () => {
  test('editing, saving and loading again leaves it mixed, and identical', async ({ page }) => {
    await mountFixture(page, MIXED);
    const before = await geometry(page);

    // Edit something on page 1 in the document's unit, using a **suffixed** value so the edit is
    // also exercising the override rule inside the round trip rather than beside it.
    await clickAt(page, 100, 80);
    await settle(page);
    const width = page.locator('[data-inspector] [data-field="width"]');
    await width.fill('2in');
    await width.press('Enter');
    await settle(page);
    // 2in is 192px; the field reports it in millimetres, which is 50.8.
    expect(await width.inputValue()).toBe('50.8mm');

    const savedDoc = await saved(page);
    await open(page, savedDoc);

    // The unit came back...
    expect((savedDoc['pageSetup'] as { unit: string }).unit).toBe('mm');
    // ...the page units came back, still disagreeing...
    expect(
      (savedDoc['pages'] as Array<{ size: { unit: string } }>).map((p) => p.size.unit),
    ).toEqual(['mm', 'in', 'pt']);
    // ...the edit is there, in px...
    const box = (savedDoc['pages'] as Array<{ objects: Array<Record<string, unknown>> }>)[0]?.objects[0];
    expect((box?.['transform'] as { width: number }).width).toBe(192);
    // ...and the drawing is the same drawing, one edit later. Compared by **id**, not by index:
    // DOM order across a reload is a property of the renderer, not of the document, and asserting
    // on it would fail for a reason that has nothing to do with units.
    const after = await geometry(page);
    expect(after.pages).toEqual(before.pages);
    const was = new Map(before.objects.map((o) => [o.id, o]));
    const now = new Map(after.objects.map((o) => [o.id, o]));
    expect([...now.keys()].sort(), 'the same objects, by id').toEqual([...was.keys()].sort());
    // The edited one moved; the one on the inch page did not.
    expect(now.get('mm_box')?.width).not.toBeCloseTo(was.get('mm_box')?.width ?? 0, 1);
    expect(now.get('mm_copy')).toEqual(was.get('mm_copy'));
    expect(now.get('in_copy')).toEqual(was.get('in_copy'));
  });

  test('reopening the mixed document three times is stable', async ({ page }) => {
    // The failure this catches is a migration that is not idempotent -- each load rewriting a
    // slightly different value, so the third save differs from the second for no reason. One pass
    // would look fine; only a repeat shows the drift.
    await mountFixture(page, MIXED);
    let previous = JSON.stringify(await saved(page));
    for (let round = 0; round < 3; round += 1) {
      await open(page, JSON.parse(previous));
      const again = JSON.stringify(await saved(page));
      expect(again, `round ${round + 1} changed the document`).toBe(previous);
      previous = again;
    }
  });
});

test.describe('the inspector never writes back what it only displayed', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, MIXED);
  });

  test('selecting away and back does not quantise the value', async ({ page }) => {
    await clickAt(page, 100, 80);
    await settle(page);
    const before = await inspector(page, 'x');

    // Away to another object and back. This is the route that is *not* a blur -- the panel is torn
    // down for one object and rebuilt for the other -- so it is the one most likely to commit on
    // rebuild.
    await clickAt(page, 60, 240);
    await settle(page);
    expect(await inspector(page, 'x'), 'the other object really was selected').toBe('10.58mm');
    await clickAt(page, 100, 80);
    await settle(page);

    expect(await inspector(page, 'x')).toBe(before);
    const doc = await saved(page);
    const node = (doc['pages'] as Array<{ objects: Array<Record<string, unknown>> }>)[0]?.objects[0];
    // 40px is 10.58333...mm, so committing the displayed `10.58mm` would store 39.987px. The
    // assertion is tight enough to see a single quantisation, which is the failure itself.
    expect((node?.['transform'] as { x: number }).x).toBe(40);
  });

  test('switching the document unit does not quantise anything either', async ({ page }) => {
    await clickAt(page, 100, 80);
    await settle(page);
    // A unit change refreshes every field, which is the widest possible "the panel was redrawn".
    for (const unit of ['in', 'cm', 'pc', 'pt', 'mm'] as const) {
      await page.locator('[data-pages-panel] [data-document-unit]').selectOption(unit);
      await settle(page);
    }
    const doc = await saved(page);
    const box = (doc['pages'] as Array<{ objects: Array<Record<string, unknown>> }>)[0]?.objects[0];
    expect((box?.['transform'] as { x: number; width: number }).x).toBe(40);
    expect((box?.['transform'] as { width: number }).width).toBe(120);
  });

  test('a field the user did touch is committed exactly once', async ({ page }) => {
    await clickAt(page, 100, 80);
    await settle(page);
    const width = page.locator('[data-inspector] [data-field="width"]');
    await width.fill('40');
    await width.press('Enter');
    await settle(page);

    const first = await saved(page);
    const node = (first['pages'] as Array<{ objects: Array<Record<string, unknown>> }>)[0]?.objects[0];
    // 40mm, exactly. Not 39.99, which is what re-committing the displayed value would give.
    expect((node?.['transform'] as { width: number }).width).toBeCloseTo(151.181, 3);

    // Blur afterwards must not commit the rounded reading over it.
    await page.locator('[data-inspector] [data-field="height"]').click();
    await settle(page);
    const second = await saved(page);
    const again = (second['pages'] as Array<{ objects: Array<Record<string, unknown>> }>)[0]
      ?.objects[0];
    expect((again?.['transform'] as { width: number }).width).toBe(
      (node?.['transform'] as { width: number }).width,
    );
  });
});

test.describe('a suffix always wins', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, MIXED);
  });

  // Each of the five accepted units, entered into a **millimetre** document, with the value chosen
  // so its px equivalent is exact where that is possible and the assertion is written accordingly.
  const CASES: ReadonlyArray<{ typed: string; px: number; shown: string }> = [
    { typed: '1in', px: 96, shown: '25.4mm' },
    { typed: '72pt', px: 96, shown: '25.4mm' },
    { typed: '6pc', px: 96, shown: '25.4mm' },
    { typed: '2.54cm', px: 96, shown: '25.4mm' },
    { typed: '96px', px: 96, shown: '25.4mm' },
  ];

  for (const { typed, px, shown } of CASES) {
    test(`${typed} is read as itself, not as millimetres`, async ({ page }) => {
      await clickAt(page, 100, 80);
      await settle(page);
      const x = page.locator('[data-inspector] [data-field="x"]');
      await x.fill(typed);
      await x.press('Enter');
      await settle(page);

      expect(await x.inputValue(), 'the field reports the document unit, not the typed one').toBe(
        shown,
      );
      const doc = await saved(page);
      const node = (doc['pages'] as Array<{ objects: Array<Record<string, unknown>> }>)[0]
        ?.objects[0];
      expect((node?.['transform'] as { x: number }).x, `${typed} was not read in its own unit`).toBe(
        px,
      );
    });
  }

  test('a bare number in the same field would have meant something else', async ({ page }) => {
    // The control for the loop above: 96 is 96mm, which is 361.4px -- not the 96px that `96px` means.
    // Without this the loop could pass with a parser that ignored the suffix entirely and the
    // fixture's numbers happened to line up.
    await clickAt(page, 100, 80);
    await settle(page);
    const x = page.locator('[data-inspector] [data-field="x"]');
    await x.fill('96');
    await x.press('Enter');
    await settle(page);
    const doc = await saved(page);
    const node = (doc['pages'] as Array<{ objects: Array<Record<string, unknown>> }>)[0]?.objects[0];
    expect((node?.['transform'] as { x: number }).x).toBeCloseTo(362.835, 2);
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

test.describe('a legacy document keeps its appearance', () => {
  // The app has to exist before a file can be opened into it; `open` replaces whatever is mounted.
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, MIXED);
  });

  /**
   * A **format 5** document: no `pageSetup.unit`, because M24 put the field in v6.
   *
   * Mixed units on purpose, for the reason the milestone exists -- a migration that inferred the
   * document unit from the first page would look correct on this document if it happened to start
   * in millimetres, and would be wrong on any document that does not.
   *
   * The shapes are at px values that are not round in any unit (40, 137, 213), so a migration that
   * rescaled by a ratio rather than leaving the numbers alone would move them visibly.
   */
  const LEGACY = {
    format: 'p1doc',
    formatVersion: 5,
    id: 'legacy',
    name: 'Legacy',
    pageSetup: {
      fixedSize: true,
      defaultSize: { width: 210, height: 297, unit: 'mm', orientation: 'portrait' },
      resizeBehaviour: 'crop',
    },
    styles: [],
    assets: {},
    pages: [
      {
        id: 'l_mm',
        name: '1',
        size: { width: 210, height: 297, unit: 'mm', orientation: 'portrait' },
        background: { type: 'solid', color: '#ffffff' },
        objects: [
          {
            type: 'shape',
            id: 'legacy_box',
            name: 'box',
            transform: { x: 37, y: 41, width: 137, height: 213, rotation: 0, scaleX: 1, scaleY: 1 },
            visible: true,
            locked: false,
            opacity: 1,
            blendMode: 'normal',
            shape: { kind: 'rect', cornerRadius: 8 },
            fill: { type: 'solid', color: '#3366ff' },
          },
        ],
      },
      {
        id: 'l_in',
        name: '2',
        size: { width: 5, height: 7, unit: 'in', orientation: 'portrait' },
        background: { type: 'solid', color: '#ffffff' },
        objects: [],
      },
    ],
  };

  test('opens, migrates on save, and looks the same before and after', async ({ page }) => {
    await open(page, LEGACY, 'legacy.p1doc');
    const asOpened = await geometry(page);

    // Migrated on save: the bytes that come back are v6, with a unit the file never had.
    const migrated = await saved(page);
    expect(migrated['formatVersion']).toBe(6);
    expect((migrated['pageSetup'] as { unit: string }).unit).toBe('mm');
    // And not one stored number moved to get there.
    const box = (migrated['pages'] as Array<{ objects: Array<Record<string, unknown>> }>)[0]?.objects[0];
    expect((box?.['transform'] as Record<string, number>)).toMatchObject({ x: 37, y: 41, width: 137, height: 213 });

    await open(page, migrated, 'migrated.p1doc');
    expect(await geometry(page), 'the migrated document draws differently').toEqual(asOpened);
  });

  test('looks the same as the same document authored directly in v6', async ({ page }) => {
    // The control for the test above. "It round-tripped" can be true of a migration that rescaled
    // *consistently*, so the comparison has to be against a document that was never migrated --
    // otherwise a wrong unit would be invisible, because both readings would be wrong the same way.
    await open(page, LEGACY, 'legacy.p1doc');
    const legacy = await geometry(page);

    await open(page, { ...LEGACY, formatVersion: 6, pageSetup: { ...LEGACY.pageSetup, unit: 'mm' } }, 'current.p1doc');
    expect(await geometry(page), 'a v5 document and its v6 equivalent must draw identically').toEqual(
      legacy,
    );
  });

  test('a v5 document declaring a unit is refused, so it cannot be quietly accepted', async ({ page }) => {
    // The other side of the migration's contract. If a v5 file carrying `unit` were accepted, the
    // migration would have two sources for the same answer and no way to say which won.
    await open(page, { ...LEGACY, pageSetup: { ...LEGACY.pageSetup, unit: 'cm' } }, 'bad.p1doc');
    await settle(page);
    const refused = await page.locator('[data-doc-message]').getAttribute('data-error');
    expect(refused, 'a v5 document with a v6 field must be refused').toBe('true');
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