import type { Page } from '@playwright/test';
import {
  FIXTURE,
  IDS,
  clickAt,
  clientPointAt,
  drag,
  expect,
  handleCount,
  hoverId,
  inspectorPlaceholder,
  rotateHandleVisible,
  selectionCount,
  test,
} from './helpers';
import { mountFixture } from '../visual/harness';

/**
 * Visual baselines for the M2 selection overlay.
 *
 * ## Why this suite clips the surface, not the page
 *
 * The page screenshots in `tests/visual` clip the *page*, which proves the document
 * renders correctly and deliberately excludes chrome. The overlay is chrome, so
 * asserting it needs a different region: the `.surface` box, which contains the
 * viewport and the overlay and nothing else.
 *
 * That distinction is the whole reason these are separate from the existing
 * baselines rather than added to them. A page clip that included selection chrome
 * would break every time a selection changed, and a page clip that excluded it
 * would not test it at all.
 *
 * ## Every baseline here was looked at
 *
 * Per the lesson recorded in `tests/visual/README.md`: a screenshot test nobody has
 * inspected proves very little. These were rendered and checked during M2.
 */

test.beforeEach(async ({ page }) => {
  await mountFixture(page, FIXTURE);
});

/**
 * Clips the document surface, which is where the overlay lives.
 *
 * Refuses rather than clipping blindly, for the same reason `screenshotPage` does: a
 * clip in the wrong place records chrome or whitespace and passes anyway.
 */
async function screenshotSurface(page: Page, name: string): Promise<void> {
  const surface = page.locator('.surface');
  const box = await surface.boundingBox();
  if (box === null) throw new Error('The document surface has no bounding box');

  const viewport = page.viewportSize();
  if (viewport === null) throw new Error('No viewport size');
  const fits =
    box.x >= 0 &&
    box.y >= 0 &&
    box.x + box.width <= viewport.width &&
    box.y + box.height <= viewport.height;
  if (!fits) {
    throw new Error(
      `The document surface (${Math.round(box.width)}×${Math.round(box.height)}) does not fit ` +
        `the ${viewport.width}×${viewport.height} viewport. The clip would capture chrome.`,
    );
  }

  const buffer = await page.screenshot({
    clip: {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    },
    animations: 'disabled',
  });
  await expect(buffer).toMatchSnapshot(`${name}.png`);
}

test.describe('overlay appearance', () => {
  test('nothing selected draws no chrome over the document', async ({ page }) => {
    expect(await selectionCount(page)).toBe(0);
    expect(await page.locator('.overlay').evaluate((el) => el.childElementCount)).toBe(0);

    await screenshotSurface(page, 'overlay-empty');
  });

  test('hovering draws a distinct, lighter outline', async ({ page }) => {
    const point = await clientPointAt(page, IDS.gamma.x + 60, IDS.gamma.y + 40);
    await page.mouse.move(point.x, point.y);

    expect(await hoverId(page)).toBe('gamma');
    await screenshotSurface(page, 'overlay-hover');
  });

  test('a single selection draws an outline and eight handles', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);

    expect(await handleCount(page)).toBe(8);
    await screenshotSurface(page, 'overlay-single-selection');
  });

  test('a multi-selection draws one outline and handle set per object', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    await clickAt(page, IDS.beta.x + 60, IDS.beta.y + 40, ['Shift']);

    expect(await handleCount(page)).toBe(16);
    expect(await inspectorPlaceholder(page, 'x')).toBe('Mixed');
    await screenshotSurface(page, 'overlay-multi-selection');
  });

  test('an unrotated selection shows the rotation handle above the top edge', async ({ page }) => {
    await clickAt(page, IDS.beta.x + 60, IDS.beta.y + 40);

    expect(await rotateHandleVisible(page)).toBe(true);
    await screenshotSurface(page, 'overlay-rotation-handle');
  });

  test('a rotated selection KEEPS its rotation handle, on the frame own top edge', async ({ page }) => {
    await clickAt(page, IDS.beta.x + 60, IDS.beta.y + 40);

    const gripBefore = await page.locator('.p1-overlay-rotate').boundingBox();
    expect(gripBefore, 'an unrotated selection offers the grip').not.toBeNull();

    await drag(
      page,
      { x: IDS.beta.x + IDS.beta.width / 2, y: IDS.beta.y - 24 },
      { x: IDS.beta.x + IDS.beta.width / 2 + 70, y: IDS.beta.y - 24 },
    );

    // The grip used to *retire* here, because it was pinned to the unrotated frame's top edge and
    // would have landed on the shape. With the frame following the object's matrix it is placed on
    // the transformed top edge and stays outside the shape at any angle, so there is no reason to
    // hide it (ADR 0011 §8 F6).
    expect(await rotateHandleVisible(page), 'and it survives the rotation').toBe(true);

    // The strong claim: the grip is outside the object's painted extent, not merely present. An
    // assertion that only checked visibility would pass if the grip were drawn on top of the shape.
    const placed = await page.evaluate(() => {
      const grip = document.querySelector('.p1-overlay-rotate');
      if (!(grip instanceof HTMLElement)) throw new Error('no grip');
      const object = document.querySelector('[data-objects] [data-oid]');
      if (!(object instanceof HTMLElement)) throw new Error('no object');
      const g = grip.getBoundingClientRect();
      const o = object.getBoundingClientRect();
      const centre = { x: g.x + g.width / 2, y: g.y + g.height / 2 };
      const dx = Math.max(o.x - centre.x, 0, centre.x - (o.x + o.width));
      const dy = Math.max(o.y - centre.y, 0, centre.y - (o.y + o.height));
      return { centre, distanceOutside: Math.hypot(dx, dy) };
    });
    expect(placed.distanceOutside, 'the grip is clear of the painted object').toBeGreaterThan(2);

    await screenshotSurface(page, 'overlay-rotated');
  });

  test('the marquee draws a filled rect while dragging on the background', async ({ page }) => {
    const start = await clientPointAt(page, 20, 20);
    const end = await clientPointAt(page, 380, 140);

    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 6 });

    const marquee = await page.locator('.p1-overlay-box--marquee').boundingBox();
    expect(marquee).not.toBeNull();
    expect(marquee?.width ?? 0).toBeCloseTo(360, 0);

    await screenshotSurface(page, 'overlay-marquee');
    await page.mouse.up();
  });

  test('chrome stays a constant size at any zoom — the point of screen space', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);

    const atOne = await page.locator('.p1-overlay-handle').first().boundingBox();

    // Zoom out two steps. A handle inside the zoom transform would shrink with the
    // document; this is the assertion that proves it does not.
    await page.locator('[data-zoom="out"]').click();
    await page.locator('[data-zoom="out"]').click();

    const zoomedOut = await page.locator('.p1-overlay-handle').first().boundingBox();
    const scale = await page.locator('[data-pages]').evaluate((el) =>
      Number.parseFloat(/scale\(([\d.]+)\)/.exec((el as HTMLElement).style.transform)?.[1] ?? '1'),
    );

    expect(zoomedOut?.width ?? 0).toBeCloseTo(atOne?.width ?? -1, 1);
    expect(zoomedOut?.height ?? 0).toBeCloseTo(atOne?.height ?? -1, 1);
    // ...while the document itself did shrink, so the page is smaller under the same
    // chrome. Without this the test could pass because nothing zoomed at all.
    expect(scale).toBeLessThan(1);
    expect(
      await page.locator('[data-objects] [data-oid="alpha"]').boundingBox(),
    ).not.toBeNull();
  });

  test('selection strokes are exactly 1px at any zoom', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);

    const readStroke = () =>
      page
        .locator('.p1-overlay-box--selection')
        .evaluate((el) => Number.parseFloat(getComputedStyle(el).borderTopWidth));

    expect(await readStroke()).toBe(1);

    await page.locator('[data-zoom="in"]').click();
    await page.locator('[data-zoom="in"]').click();
    expect(await readStroke()).toBe(1);
  });

  test('the overlay does not intercept pointer events', async ({ page }) => {
    // If the layer swallowed clicks, this click would select nothing — which is the
    // exact failure mode of adding it to the stack without `pointer-events: none`.
    expect(await page.locator('.overlay').evaluate((el) => getComputedStyle(el).pointerEvents)).toBe(
      'none',
    );

    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    expect(await selectionCount(page)).toBe(1);
  });

  test('the overlay never grows a scrollbar', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);

    const overflow = await page.locator('.overlay').evaluate((el) => ({
      overflowX: getComputedStyle(el).overflowX,
      overflowY: getComputedStyle(el).overflowY,
    }));
    expect(overflow).toEqual({ overflowX: 'visible', overflowY: 'visible' });
  });
});

test.describe('chrome is not document', () => {
  test('no overlay element lives inside the zoom transform', async ({ page }) => {
    // The architectural claim of §3.8, asserted structurally rather than by
    // comparing pixels: nothing under `[data-pages]` may be overlay chrome.
    const insideDocument = await page
      .locator('[data-pages] [class*="p1-overlay"]')
      .count();
    expect(insideDocument).toBe(0);

    const inStack = await page.evaluate(
      () => document.querySelector('[data-overlay]')?.closest('[data-pages]') !== null,
    );
    expect(inStack).toBe(false);
  });

  test('the inspector and overlay live outside the page stack', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);

    const insideDocument = await page
      .locator('[data-pages] [data-inspector], [data-pages] .overlay')
      .count();
    expect(insideDocument).toBe(0);
  });
});
