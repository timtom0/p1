import type { Page } from '@playwright/test';
import {
  A4_PX,
  FIT_PADDING,
  ZOOM_LEVELS,
  expect,
  measure,
  measurePageLayout,
  mountFixture,
  mountSample,
  expectPageScreenshot,
  hitTestAt,
  readZoom,
  readZoomReadout,
  test,
} from './harness';

/**
 * Renderer verification: what the browser actually does.
 *
 * Each test corresponds to a claim the architecture makes that a DOM emulator
 * cannot check. See docs/ARCHITECTURE.md §2 and §8.2.
 *
 * Every mount runs at 1:1 (the harness normalises zoom), because these tests
 * assert absolute document pixels.
 */

// ---------------------------------------------------------------------------
// 1. Real page dimensions
// ---------------------------------------------------------------------------

test('page box is A4 portrait in real layout pixels', async ({ page }) => {
  await mountSample(page);

  const layout = await measurePageLayout(page);

  // Precision is bounded by the browser, not by us. Two separate limits apply:
  //
  //   - Layout geometry is quantised to 1/64px (Chromium's LayoutUnit), so
  //     `getBoundingClientRect` can only land on a multiple of 0.015625.
  //   - CSSOM re-serialises lengths to ~3 decimal places.
  //
  // Neither is rounding in the model: the unit tests assert the exact float
  // (793.7007874015748). What matters here is that the browser neither snapped
  // the page to an integer nor dropped the sub-pixel part entirely.
  expect(layout.width).toBeCloseTo(A4_PX.width, 1);
  expect(layout.height).toBeCloseTo(A4_PX.height, 1);
  expect(layout.width).not.toBe(Math.round(layout.width));

  // The declared value keeps three decimals rather than being truncated.
  const declared = await page
    .locator('[data-page]')
    .evaluate((el) => (el as HTMLElement).style.width);
  expect(declared).toMatch(/^793\.70\dpx$/);
  expect(Number.parseFloat(declared)).not.toBe(Math.round(A4_PX.width));
});

test('landscape orientation swaps the page box', async ({ page }) => {
  await mountFixture(
    page,
    `() => ({
      formatVersion: 1, id: 'doc_l', name: 'landscape',
      pageSize: { width: 210, height: 297, unit: 'mm', orientation: 'landscape' },
      assets: {},
      pages: [{ id: 'page_1', name: '1',
        background: { type: 'solid', color: '#ffffff' }, objects: [] }],
    })`,
  );

  const layout = await measurePageLayout(page);
  expect(layout.width).toBeCloseTo(A4_PX.height, 1);
  expect(layout.height).toBeCloseTo(A4_PX.width, 1);
});

test('object sits at its model position in real pixels', async ({ page }) => {
  await mountSample(page);

  const pageBox = await measure(page, '[data-page]');
  const object = await measure(page, '[data-objects] > [data-type="shape"]');

  // transform.x = 24, y = 32, width = 120, height = 68, rotation 0, zoom 1.
  expect(object.rect.x - pageBox.rect.x).toBeCloseTo(24, 2);
  expect(object.rect.y - pageBox.rect.y).toBeCloseTo(32, 2);
  expect(object.rect.width).toBeCloseTo(120, 2);
  expect(object.rect.height).toBeCloseTo(68, 2);

  // Corner radius and the inside stroke, both from the model. Targeted by type rather
  // than position: `[data-objects] > *` now matches the sample's text frame as well as
  // its rectangle, and a bare selector on a two-object page is a strict-mode violation
  // rather than a helpful failure.
  const box = await page
    .locator('[data-objects] > [data-type="shape"]')
    .evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        radius: style.borderTopLeftRadius,
        borderWidth: style.borderTopWidth,
        borderStyle: style.borderTopStyle,
        background: style.backgroundColor,
      };
    });
  expect(box.radius).toBe('8px');
  expect(box.borderWidth).toBe('2px');
  expect(box.borderStyle).toBe('solid');
  expect(box.background).toBe('rgb(79, 124, 255)');
});

test('page background comes from the page model', async ({ page }) => {
  await mountSample(page);
  const geometry = await measure(page, '[data-page]');
  expect(geometry.backgroundColor).toBe('rgb(255, 255, 255)');
});

// ---------------------------------------------------------------------------
// 2. transform-origin, rotation, scale
// ---------------------------------------------------------------------------

test('rotation happens about the box centre, not the corner', async ({ page }) => {
  await mountFixture(page, rotatingSquareFixture());

  const object = await measure(page, '[data-objects] > *');

  // transform-origin must be the centre of the box.
  expect(object.transformOrigin).toMatch(/^50px 50px$/);
  expect(object.transform).toMatch(/matrix\(0, 1, -1, 0/);

  // The box is at (300,300)-(400,400) in page coordinates. Rotation about the
  // centre leaves it there; a top-left origin would swing it to (300,200)-(400,300).
  // Because the page sits at a non-zero offset in the viewport, compare page-relative.
  const pageBox = await measure(page, '[data-page]');
  const relX = object.rect.x - pageBox.rect.x;
  const relY = object.rect.y - pageBox.rect.y;

  expect(relX).toBeCloseTo(300, 1);
  expect(relY).toBeCloseTo(300, 1);
  expect(relX + object.rect.width / 2).toBeCloseTo(350, 1);
  expect(relY + object.rect.height / 2).toBeCloseTo(350, 1);
});

test('non-uniform scale is applied about the centre', async ({ page }) => {
  await mountFixture(page, scaledRectFixture({ scaleX: 2, scaleY: 0.5, rotation: 0 }));

  const pageBox = await measure(page, '[data-page]');
  const object = await measure(page, '[data-objects] > *');
  // scale(2, 0.5) about the box centre (350,350): width doubles, height halves,
  // centre fixed.
  expect(object.rect.width).toBeCloseTo(200, 1);
  expect(object.rect.height).toBeCloseTo(50, 1);
  expect(object.rect.x - pageBox.rect.x + object.rect.width / 2).toBeCloseTo(350, 1);
  expect(object.rect.y - pageBox.rect.y + object.rect.height / 2).toBeCloseTo(350, 1);
});

test('rotation and scale compose in CSS order (R·S)', async ({ page }) => {
  // scaleX=2 with a 90° rotation. Per §1.3 the product is R·S, so the doubled
  // x-extent ends up running vertically: a 200-tall, 100-wide box. If the product
  // were S·R the box would be 100 wide and 200 tall in the other sense, i.e. the
  // transform string itself differs.
  await mountFixture(page, scaledRectFixture({ scaleX: 2, scaleY: 1, rotation: Math.PI / 2 }));

  const object = await measure(page, '[data-objects] > *');
  expect(object.transform).toMatch(/matrix\(0, 2, -1, 0/);
  expect(object.rect.width).toBeCloseTo(100, 1);
  expect(object.rect.height).toBeCloseTo(200, 1);
});

// ---------------------------------------------------------------------------
// 3. Page clipping
// ---------------------------------------------------------------------------

test('page clips overflowing objects with overflow:hidden', async ({ page }) => {
  await mountFixture(
    page,
    `() => ({
      formatVersion: 1, id: 'doc_c', name: 'clip',
      pageSize: { width: 210, height: 297, unit: 'mm', orientation: 'portrait' },
      assets: {},
      pages: [{ id: 'page_1', name: '1',
        background: { type: 'solid', color: '#ffffff' },
        objects: [{
          id: 'node_c', type: 'shape', name: 'overhang',
          transform: { x: 700, y: 1000, width: 160, height: 200,
                       rotation: 0, scaleX: 1, scaleY: 1 },
          visible: true, locked: false, opacity: 1, blendMode: 'normal',
          shape: { kind: 'rect', cornerRadius: 0 },
          fill: { type: 'solid', color: '#000000' },
        }] }],
    })`,
  );

  const pageBox = await measure(page, '[data-page]');
  expect(pageBox.overflow).toBe('hidden');

  // The object genuinely extends past the page box…
  const object = await measure(page, '[data-objects] > *');
  expect(object.rect.x + object.rect.width).toBeGreaterThan(pageBox.rect.width + 50);
  expect(object.rect.y + object.rect.height).toBeGreaterThan(pageBox.rect.height + 50);

  // …but the painted result must stop exactly at the page edge. This is the
  // assertion happy-dom cannot make: clipping is a browser behaviour.
  await expectPageScreenshot(page, 'page-clip');

  // Behavioural confirmation, independent of any baseline. The object spans
  // (700,1000)-(860,1200) while the page ends at (793.7, 1122.5), so part of it
  // must be clipped away.
  //
  // `overflow: hidden` clips hit targets exactly as it clips painting, so asking
  // the browser what is under a point is a direct test of the clipping.
  //
  // Zoomed out so the overhang region is on screen at all.
  await page.locator('[data-zoom="actual"]').click();
  await page.locator('[data-zoom="out"]').click();
  await page.locator('[data-zoom="out"]').click();

  // Well inside the page, on the object.
  expect(await hitTestAt(page, 750, 1050)).toBe('object:node_c');

  // Past the page's right edge, the object would be here if unclipped.
  expect(await hitTestAt(page, 820, 1050)).toBe('outside');

  // Past the page's bottom edge.
  expect(await hitTestAt(page, 750, 1160)).toBe('outside');

  // Away from the object, inside the page, nothing but page is there.
  expect(await hitTestAt(page, 400, 400)).toBe('page');
});

// ---------------------------------------------------------------------------
// 4. Paint order
// ---------------------------------------------------------------------------

test('later objects paint over earlier ones', async ({ page }) => {
  const stack = (order: 'ab' | 'ba') => `() => {
      const make = (id, color) => ({
        id, type: 'shape', name: id,
        transform: { x: 200, y: 200, width: 300, height: 300,
                     rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color },
      });
      const red = make('a_bottom', '#ff0000');
      const blue = make('b_top', '#0000ff');
      return {
        formatVersion: 1, id: 'doc_p', name: 'paint order',
        pageSize: { width: 210, height: 297, unit: 'mm', orientation: 'portrait' },
        assets: {},
        pages: [{ id: 'page_1', name: '1',
          background: { type: 'solid', color: '#ffffff' },
          objects: '${order}' === 'ab' ? [red, blue] : [blue, red] }],
      };
    }`;

  await mountFixture(page, stack('ab'));

  // DOM order must equal model order.
  expect(await domOrder(page)).toEqual(['a_bottom', 'b_top']);

  // Blue is last in the model, so blue must be topmost where they overlap. They
  // both cover (200,200)-(500,500), so (350,350) is inside both.
  expect(await hitTestAt(page, 350, 350)).toBe('object:b_top');
  await expectPageScreenshot(page, 'paint-order-blue-on-top');

  // The reversed model must reverse the paint, and change nothing else.
  //
  // Checked by mounting a second fixture rather than reordering the live document.
  // The reverse used to be driven by the temporary reconciler harness, which M2
  // removed; mounting the reversed model tests exactly the same claim — that paint
  // order follows model order — without needing a runtime mutation affordance that
  // no real feature requires yet.
  await mountFixture(page, stack('ba'));
  expect(await domOrder(page)).toEqual(['b_top', 'a_bottom']);
  expect(await hitTestAt(page, 350, 350)).toBe('object:a_bottom');
  await expectPageScreenshot(page, 'paint-order-red-on-top');
});

// ---------------------------------------------------------------------------
// 5. Zoom
// ---------------------------------------------------------------------------

test('zoom scales the page without changing its layout size', async ({ page }) => {
  await mountSample(page);
  await page.locator('[data-zoom="actual"]').click();

  const at100 = await measurePageLayout(page);
  expect(at100.zoom).toBeCloseTo(1, 4);
  expect(at100.transform).toBe('scale(1)');

  await page.locator('[data-zoom="in"]').click();
  const zoomed = await measurePageLayout(page);
  expect(zoomed.zoom).toBeCloseTo(1.25, 4);

  // The page's layout size is zoom-invariant. This is the guarantee that line
  // breaking, hyphenation and image cropping never change with zoom.
  expect(zoomed.width).toBeCloseTo(at100.width, 3);
  expect(zoomed.height).toBeCloseTo(at100.height, 3);
});

test('page geometry scales linearly with zoom', async ({ page }) => {
  await mountSample(page);
  await page.locator('[data-zoom="actual"]').click();

  const at100 = await measure(page, '[data-page]');
  expect(at100.rect.width).toBeCloseTo(A4_PX.width, 1);

  await page.locator('[data-zoom="in"]').click();
  const zoom = await readZoom(page);
  const scaled = await measure(page, '[data-page]');

  expect(scaled.rect.width).toBeCloseTo(at100.rect.width * zoom, 1);
  expect(scaled.rect.height).toBeCloseTo(at100.rect.height * zoom, 1);
});

test('object keeps its page-relative position and size at any zoom', async ({ page }) => {
  await mountSample(page);

  const readRelative = async () => readPageRelative(page);

  await page.locator('[data-zoom="actual"]').click();
  const at100 = await readRelative();

  await page.locator('[data-zoom="in"]').click();
  const zoomedIn = await readRelative();

  await page.locator('[data-zoom="out"]').click();
  await page.locator('[data-zoom="out"]').click();
  const zoomedOut = await readRelative();

  expect(at100.zoom).toBeCloseTo(1, 4);
  expect(zoomedIn.zoom).toBeCloseTo(1.25, 4);
  expect(zoomedOut.zoom).not.toBeCloseTo(1, 3);

  for (const reading of [zoomedIn, zoomedOut]) {
    expect(reading.relX).toBeCloseTo(at100.relX, 2);
    expect(reading.relY).toBeCloseTo(at100.relY, 2);
    expect(reading.width).toBeCloseTo(at100.width, 2);
    expect(reading.height).toBeCloseTo(at100.height, 2);
  }
});

test('zoom readout agrees with the applied transform', async ({ page }) => {
  await mountSample(page);
  await page.locator('[data-zoom="actual"]').click();

  const readBoth = async () => ({
    readout: await readZoomReadout(page),
    applied: await readZoom(page),
  });

  const initial = await readBoth();
  expect(initial.readout).toBeCloseTo(initial.applied, 2);

  await page.locator('[data-zoom="out"]').click();
  const afterOut = await readBoth();
  expect(afterOut.readout).toBeCloseTo(afterOut.applied, 2);
  expect(afterOut.applied).toBeLessThan(initial.applied);
});

test('fit scales the whole page into the viewport', async ({ page }) => {
  await mountSample(page);
  await page.locator('[data-zoom="fit"]').click();

  const viewportBox = await page.locator('[data-viewport]').evaluate((el) => ({
    width: (el as HTMLElement).clientWidth,
    height: (el as HTMLElement).clientHeight,
  }));
  const pageBox = await measure(page, '[data-page]');

  // Fitted, so both axes fit.
  expect(pageBox.rect.width).toBeLessThanOrEqual(viewportBox.width);
  expect(pageBox.rect.height).toBeLessThanOrEqual(viewportBox.height);

  // `fit()` picks min(scaleX, scaleY) against (viewport - 2×padding), so on the
  // tight axis the leftover space is exactly one padding either side.
  const slackX = viewportBox.width - pageBox.rect.width;
  const slackY = viewportBox.height - pageBox.rect.height;
  const tight = Math.min(slackX, slackY);
  const loose = Math.max(slackX, slackY);

  expect(tight).toBeGreaterThanOrEqual(2 * FIT_PADDING - 1);
  expect(tight).toBeLessThanOrEqual(2 * FIT_PADDING + 2);
  expect(loose).toBeGreaterThan(tight);
});

test('fit is reached on load', async ({ page }) => {
  // Deliberately does not click anything: the app fits the page during boot, and
  // that behaviour is what is under test.
  await page.goto('/');
  await page.waitForFunction(() => {
    const readout = document.querySelector('[data-zoom-readout]');
    return readout instanceof HTMLOutputElement && readout.value !== '';
  });

  const viewportBox = await page.locator('[data-viewport]').evaluate((el) => ({
    width: (el as HTMLElement).clientWidth,
    height: (el as HTMLElement).clientHeight,
  }));
  const layout = await measurePageLayout(page);

  // Recompute what `fit()` should have chosen from the live viewport. Asserting
  // the relationship rather than a magic number keeps this honest if the app
  // chrome or the test viewport changes.
  const expected = Math.min(
    (viewportBox.width - 2 * FIT_PADDING) / A4_PX.width,
    (viewportBox.height - 2 * FIT_PADDING) / A4_PX.height,
  );
  expect(layout.zoom).toBeCloseTo(expected, 4);
});

test('renders at a low zoom', async ({ page }) => {
  await mountSample(page, { zoom: ZOOM_LEVELS['41%'] });
  expect(await readZoom(page)).toBeCloseTo(ZOOM_LEVELS['41%'], 4);
  await expectPageScreenshot(page, 'zoom-41-percent');
});

test('renders at a high zoom', async ({ page }) => {
  await mountSample(page, { zoom: ZOOM_LEVELS['195%'] });
  expect(await readZoom(page)).toBeCloseTo(ZOOM_LEVELS['195%'], 4);
  await expectPageScreenshot(page, 'zoom-195-percent');
});

// ---------------------------------------------------------------------------
// 6. Baseline appearance of the sample document
// ---------------------------------------------------------------------------

test('sample document renders as expected', async ({ page }) => {
  await mountSample(page);
  await expectPageScreenshot(page, 'sample-document');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Object ids of the first page, in DOM order. */
async function domOrder(page: Page): Promise<(string | null)[]> {
  return page
    .locator('[data-objects] > *')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-oid')));
}

/** Reads a rectangle in document px relative to a specific page, plus the live zoom. */
async function readPageRelative(page: Page, index = 0) {
  const selector = '[data-page]';
  const object = await page.locator(`${selector} >> nth=${index}`).locator('[data-objects] > *').first().evaluate((el) => {
    const box = el.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  });
  const pageBox = await page.locator(selector).nth(index).evaluate((el) => {
    const box = el.getBoundingClientRect();
    return { x: box.x, y: box.y };
  });
  const zoom = await readZoom(page);
  return {
    zoom,
    relX: (object.x - pageBox.x) / zoom,
    relY: (object.y - pageBox.y) / zoom,
    width: object.width / zoom,
    height: object.height / zoom,
  };
}

function rotatingSquareFixture(): string {
  return rectFixture({
    x: 300,
    y: 300,
    width: 100,
    height: 100,
    scaleX: 1,
    scaleY: 1,
    rotation: Math.PI / 2,
  });
}

function scaledRectFixture(transform: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  scaleX?: number;
  scaleY?: number;
  rotation?: number;
}): string {
  return rectFixture({
    x: 300,
    y: 300,
    width: 100,
    height: 100,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    ...transform,
  });
}

function rectFixture(t: {
  x: number;
  y: number;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
}): string {
  return `() => ({
    formatVersion: 1, id: 'doc_x', name: 'geometry',
    pageSize: { width: 210, height: 297, unit: 'mm', orientation: 'portrait' },
    assets: {},
    pages: [{ id: 'page_1', name: '1',
      background: { type: 'solid', color: '#ffffff' },
      objects: [{
        id: 'node_x', type: 'shape', name: 'rect',
        transform: { x: ${t.x}, y: ${t.y}, width: ${t.width}, height: ${t.height},
                     rotation: ${t.rotation}, scaleX: ${t.scaleX}, scaleY: ${t.scaleY} },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#000000' },
      }] }],
  })`;
}
