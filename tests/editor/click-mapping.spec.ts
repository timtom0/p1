/**
 * The click harness's page mapping: `clickAt`'s `pageIndex` and `clickablePointAt`'s check.
 *
 * ## Why this is its own file rather than a test in a feature suite
 *
 * Because the failure it guards against is **silent**. Before M24 every call site used page 0, which
 * was fine; the moment a suite wanted an object on a later page the helper could not offer it, and
 * the workaround was to assert the same question through whatever other surface happened to be
 * reachable. That is how M24's mixed-unit claim ended up resting on ruler readouts instead of on
 * selecting the object.
 *
 * A harness invariant tested inside a feature suite gets deleted when the feature changes. Tested
 * here, it is the thing it says: these helpers either address the page asked for or they fail.
 *
 * ## The fixture
 *
 * Two pages of **different sizes**, so a mapping that used the wrong page's rect would produce a
 * point inside page 0 rather than page 1 -- which is the bug. Two pages the same size would hide it.
 * Each carries one object at a *different* document coordinate, so a click that lands on the right
 * screen position but for the wrong reason is still detectable.
 */

import type { Page } from '@playwright/test';
import { expect, settle, test } from './helpers';
import { clickablePointAt, clickAt, selectionIds } from './helpers';
import { mountFixture } from '../visual/harness';

/** Page 1 is A4 (793.7 x 1122.5px); page 2 is 5x7in (480 x 672px). */
const TWO_PAGES = `() => ({
  formatVersion: 6, id: 'map', name: 'Mapping',
  pageSetup: { fixedSize: true, unit: 'pt', defaultSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' }, resizeBehaviour: 'crop' },
  styles: [],
  assets: {},
  pages: [
    {
      id: 'first', name: '1',
      size: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
      background: { type: 'solid', color: '#ffffff' },
      objects: [
        {
          type: 'shape', id: 'on_first', name: 'on first',
          transform: { x: 40, y: 40, width: 120, height: 80, rotation: 0, scaleX: 1, scaleY: 1 },
          visible: true, locked: false, opacity: 1, blendMode: 'normal',
          shape: { kind: 'rect', cornerRadius: 0 },
          fill: { type: 'solid', color: '#3366ff' },
        },
      ],
    },
    {
      id: 'second', name: '2',
      size: { width: 5, height: 7, unit: 'in', orientation: 'portrait' },
      background: { type: 'solid', color: '#ffffff' },
      objects: [
        {
          type: 'shape', id: 'on_second', name: 'on second',
          transform: { x: 30, y: 30, width: 200, height: 100, rotation: 0, scaleX: 1, scaleY: 1 },
          visible: true, locked: false, opacity: 1, blendMode: 'normal',
          shape: { kind: 'rect', cornerRadius: 0 },
          fill: { type: 'solid', color: '#ff6633' },
        },
      ],
    },
  ],
})`;

/**
 * The canvas scroll offset.
 *
 * `[data-viewport]` scrolls, not the window -- see `clickablePointAt`. Asserting on `window.scrollY`
 * here is how the first version of this file reported a healthy zero while measuring the wrong box.
 */
async function scrollTop(page: Page): Promise<number> {
  return page.evaluate(
    () => (document.querySelector('[data-viewport]') as HTMLElement | null)?.scrollTop ?? 0,
  );
}

test.beforeEach(async ({ page }) => {
  await mountFixture(page, TWO_PAGES);
});

test('clickAt selects the object on the page it was given, not page 0', async ({ page }) => {
  // Page 0's object sits at (40, 40); page 1's at (30, 30). Same coordinates would be ambiguous, so
  // each click uses a point only its own page has.
  await clickAt(page, 100, 80);
  expect(await selectionIds(page)).toEqual(['on_first']);

  // The whole point of the parameter. 130,80 is inside `on_second` (x 30..230) and 30px past the
  // right edge of `on_first`, so a mapping that used page 0's rect would land on nothing.
  await clickAt(page, 130, 80, [], 1);
  expect(await selectionIds(page)).toEqual(['on_second']);
});

test('the page index is per call, not sticky', async ({ page }) => {
  // A helper that remembered the last page it was asked for would pass the test above and fail
  // every suite that clicks across pages -- which is why this checks the return trip too.
  await clickAt(page, 130, 80, [], 1);
  expect(await selectionIds(page)).toEqual(['on_second']);

  await clickAt(page, 100, 80);
  expect(await selectionIds(page)).toEqual(['on_first']);
});

test('the mapping is a point inside the page it was asked for', async ({ page }) => {
  const at = await clickablePointAt(page, 130, 80, 1);
  const rect = await page.evaluate(() => {
    const box = document.querySelectorAll('[data-page]')[1]?.getBoundingClientRect();
    return box === undefined ? null : { x: box.x, y: box.y, w: box.width, h: box.height };
  });
  expect(rect).not.toBeNull();
  expect(at.x).toBeGreaterThanOrEqual(rect!.x);
  expect(at.y).toBeGreaterThanOrEqual(rect!.y);
  expect(at.x).toBeLessThanOrEqual(rect!.x + rect!.w);
  expect(at.y).toBeLessThanOrEqual(rect!.y + rect!.h);

  // ...and it is a different point from page 0's. Two pages the same size would satisfy every
  // assertion above while this one proved the index reached the mapping.
  const first = await clickablePointAt(page, 130, 80, 0);
  expect(Math.abs(first.y - at.y)).toBeGreaterThan(50);
});

test('a point past the page is refused rather than clicked somewhere else', async ({ page }) => {
  // Page 2 is 480 x 672px, so (400, 650) is inside it but (600, 700) is past both edges. The old
  // helper would have returned a client point for either, and the click would have landed on
  // whatever was under it.
  await expect(clickablePointAt(page, 600, 700, 1)).rejects.toThrow(/outside that page/);
});

test('asking for a page that does not exist says how many there are', async ({ page }) => {
  // The fixture has two pages. "no page at index 5" reads like a coordinate problem; this says the
  // real answer, which is that the index is out of range.
  await expect(clickablePointAt(page, 10, 10, 5)).rejects.toThrow(
    /no page at index 5; the document has 2/,
  );
});

test("scrolling to a later page is the helper's job, not the caller's", async ({ page }) => {
  // The default test viewport fits both pages, so there is nothing to scroll and the helper's
  // scroll path would never run. This shrinks the window until the stack overflows, which is the
  // only configuration in which "it scrolled" means anything.
  await page.setViewportSize({ width: 900, height: 520 });
  await settle(page);
  const before = await scrollTop(page);
  const overflowed = await page.evaluate(() => {
    const vp = document.querySelector('[data-viewport]') as HTMLElement;
    return vp.scrollHeight > vp.clientHeight;
  });
  expect(overflowed, 'the fixture must overflow for this test to mean anything').toBe(true);
  expect(before).toBe(0);

  await clickAt(page, 130, 80, [], 1);
  await settle(page);
  expect(await selectionIds(page)).toEqual(['on_second']);
  // ...and it really did scroll the canvas. Reading `window.scrollY` here is what the first version
  // of this helper did, and it reported zero while the viewport was in fact a different box --
  // which is how the point-ended-up-off-screen case went unnoticed.
  expect(await scrollTop(page)).toBeGreaterThan(before);
});