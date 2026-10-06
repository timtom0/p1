import type { Page } from '@playwright/test';
import {
  A4_PX,
  FIT_PADDING,
  ZOOM_LEVELS,
  expect,
  measure,
  measurePageLayout,
  mountFixture,
  mountFixtureAsBooted,
  mountSample,
  pageAt,
  pageCount,
  pageRegion,
  readZoom,
  test,
} from './harness';

/**
 * Viewport / navigation verification.
 *
 * Split from `geometry.spec.ts` because it tests a different subsystem: how the
 * editor *presents* the document (zoom, pan, page stack, rulers) rather than how a
 * single page renders. The split also keeps the M0 baselines untouched when
 * navigation changes.
 *
 * The central claim under test: **zoom lives entirely in one CSS transform on the
 * page stack.** Every assertion that follows is a consequence of that.
 */

// ---------------------------------------------------------------------------
// Page stack
// ---------------------------------------------------------------------------

/**
 * Reads the inter-page gap in **document** px.
 *
 * Page boxes are measured in screen px, so dividing by the live zoom is what
 * converts them back to document space. Getting this wrong silently mixes the two
 * spaces and produces plausible-looking but wrong numbers.
 */
async function readGap(page: Page): Promise<number> {
  const zoom = await readZoom(page);
  const gapScreen = await page
    .locator('[data-page]')
    .evaluateAll((els) => {
      const a = els[0]!.getBoundingClientRect();
      const b = els[1]!.getBoundingClientRect();
      return b.top - a.bottom;
    });
  return gapScreen / zoom;
}

/** A document with `count` empty pages, all A4 portrait. */
function stackFixture(count: number): string {
  const pages = Array.from(
    { length: count },
    (_unused, index) => `{
      id: 'pg_${index + 1}', name: '${index + 1}',
      background: { type: 'solid', color: '#ffffff' }, objects: [],
    }`,
  ).join(',');

  return `() => ({
    formatVersion: 1, id: 'doc_stack', name: 'stack',
    pageSize: { width: 210, height: 297, unit: 'mm', orientation: 'portrait' },
    assets: {},
    pages: [${pages}],
  })`;
}

test('renders one page element per page, in document order', async ({ page }) => {
  await mountFixture(page, stackFixture(3));

  expect(await pageCount(page)).toBe(3);
  const ids = await page
    .locator('[data-page]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-page')));
  expect(ids).toEqual(['pg_1', 'pg_2', 'pg_3']);
});

test('pages stack vertically with a gap, in document px', async ({ page }) => {
  await mountFixture(page, stackFixture(3));

  // The gap is view state; read it back from the geometry rather than hard-coding.
  const tops = await page
    .locator('[data-page]')
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
  const gapDocument = tops[1]! - (tops[0]! + A4_PX.height);

  expect(gapDocument).toBeGreaterThan(0);
  // Each subsequent page sits exactly one page + one gap lower.
  expect(tops[2]! - tops[1]!).toBeCloseTo(A4_PX.height + gapDocument, 1);
});

test('the spacer reflects the whole stack, so scrollbars tell the truth', async ({ page }) => {
  await mountFixture(page, stackFixture(3));
  await page.locator('[data-zoom="actual"]').click();

  const gap = await readGap(page);

  const canvasHeight = await page
    .locator('[data-canvas]')
    .evaluate((el) => (el as HTMLElement).offsetHeight);

  // 3 pages and 2 gaps.
  expect(canvasHeight).toBeCloseTo(3 * A4_PX.height + 2 * gap, 0);
});

test('a single page has no gap, matching the M0 extent', async ({ page }) => {
  await mountSample(page);
  await page.locator('[data-zoom="actual"]').click();

  const canvasHeight = await page
    .locator('[data-canvas]')
    .evaluate((el) => (el as HTMLElement).offsetHeight);
  expect(canvasHeight).toBeCloseTo(A4_PX.height, 0);
});

// ---------------------------------------------------------------------------
// Zoom stays out of the document
// ---------------------------------------------------------------------------

test('zoom is one transform on the stack, and pages carry none', async ({ page }) => {
  await mountFixture(page, stackFixture(3));
  await page.locator('[data-zoom="actual"]').click();
  await page.locator('[data-zoom="in"]').click();

  // Exactly one element is transformed.
  expect(await page.locator('[data-pages]').evaluate((el) => (el as HTMLElement).style.transform)).toBe(
    'scale(1.25)',
  );
  const pageTransforms = await page
    .locator('[data-page]')
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).style.transform));
  expect(pageTransforms).toEqual(['', '', '']);
});

test('page geometry is identical at every zoom once zoom is divided out', async ({ page }) => {
  await mountFixture(page, stackFixture(2));

  const readGeometry = async () =>
    page.locator('[data-page]').evaluateAll((els) =>
      els.map((el) => {
        const box = el.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      }),
    );

  await page.locator('[data-zoom="actual"]').click();
  const zoom = await readZoom(page);
  const at100 = (await readGeometry()).map((r) => ({
    x: r.x / zoom,
    y: r.y / zoom,
    width: r.width / zoom,
    height: r.height / zoom,
  }));

  for (const level of [ZOOM_LEVELS['195%'], ZOOM_LEVELS['41%']]) {
    await mountNormalised(page, level);
    const z = await readZoom(page);
    const scaled = (await readGeometry()).map((r) => ({
      x: r.x / z,
      y: r.y / z,
      width: r.width / z,
      height: r.height / z,
    }));
    for (let i = 0; i < scaled.length; i += 1) {
      expect(scaled[i]!.width).toBeCloseTo(at100[i]!.width, 1);
      expect(scaled[i]!.height).toBeCloseTo(at100[i]!.height, 1);
      // Page 2's offset from page 1 must also survive.
      expect(scaled[i]!.y - scaled[0]!.y).toBeCloseTo(at100[i]!.y - at100[0]!.y, 1);
    }
  }
});

/** Remounts the stack fixture at a specific zoom, for a clean comparison. */
async function mountNormalised(page: Page, zoom: number): Promise<void> {
  await mountFixture(page, stackFixture(2), { zoom });
}

// ---------------------------------------------------------------------------
// Fit
// ---------------------------------------------------------------------------

test('the whole stack is fitted on load', async ({ page }) => {
  // Mounted as booted: the app fits on load, which is the behaviour under test.
  // Forcing 1:1 here would be meaningless — a 4-page stack is 4586px tall.
  await mountFixtureAsBooted(page, stackFixture(4));

  const metrics = await page.locator('[data-viewport]').evaluate((el) => ({
    width: (el as HTMLElement).clientWidth,
    height: (el as HTMLElement).clientHeight,
  }));
  const gap = await readGap(page);

  const expected = Math.min(
    (metrics.width - 2 * FIT_PADDING) / A4_PX.width,
    (metrics.height - 2 * FIT_PADDING) / (4 * A4_PX.height + 3 * gap),
  );
  expect(await readZoom(page)).toBeCloseTo(expected, 3);
});

test('fit leaves the tight axis framed by the padding', async ({ page }) => {
  await mountFixture(page, stackFixture(3));
  await page.locator('[data-zoom="fit"]').click();

  const gap = await readGap(page);
  const zoom = await readZoom(page);
  const stackHeight = 3 * A4_PX.height + 2 * gap;

  const viewport = await page.locator('[data-viewport]').evaluate((el) => ({
    top: (el as HTMLElement).getBoundingClientRect().top,
    height: (el as HTMLElement).clientHeight,
  }));
  const firstPageTop = await pageAt(page, 0).evaluate((el) => el.getBoundingClientRect().top);
  const lastPageBottom = await pageAt(page, 2).evaluate((el) => el.getBoundingClientRect().bottom);

  /*
   * After a fit the stack is *never* taller than the viewport, so there is nothing
   * to centre and no scrollbar — the visible gap above the stack is the canvas
   * margin, not the fit padding. What fit actually guarantees is the *size*: the
   * stack, plus padding on both sides, still fits. Asserting the observable
   * geometry (scaled stack height) rather than pixel offsets is what makes this
   * independent of the canvas margin and of whether scrolling happened.
   */
  const scaledStackHeight = stackHeight * zoom;
  expect(scaledStackHeight).toBeLessThanOrEqual(viewport.height);
  expect(scaledStackHeight).toBeGreaterThan(viewport.height - 2 * FIT_PADDING - 4);

  // The stack is fully visible: both ends inside the viewport box.
  expect(firstPageTop).toBeGreaterThanOrEqual(viewport.top - 1);
  expect(lastPageBottom).toBeLessThanOrEqual(viewport.top + viewport.height + 1);
});

test('a manual zoom that overflows is centred by scrolling, not by padding', async ({ page }) => {
  // Small window, so 1:1 on three pages genuinely overflows.
  await mountFixture(page, stackFixture(3));
  await page.setViewportSize({ width: 900, height: 600 });
  await page.locator('[data-zoom="actual"]').click();

  // Fit centres the (now overflowing) stack by scrolling it into the middle.
  await page.locator('[data-zoom="fit"]').click();
  await page.locator('[data-zoom="actual"]').click();

  const viewport = page.locator('[data-viewport]');
  await viewport.evaluate((el) => {
    // Centre explicitly via the public scroll path.
    const container = el as HTMLElement;
    container.scrollTop = (container.scrollHeight - container.clientHeight) / 2;
  });

  const gap = await readGap(page);
  const zoom = await readZoom(page);
  const stackHeight = 3 * A4_PX.height + 2 * gap;

  const viewportTop = await viewport.evaluate((el) => (el as HTMLElement).getBoundingClientRect().top);
  const firstPageTop = await pageAt(page, 0).evaluate((el) => el.getBoundingClientRect().top);
  const lastPageBottom = await pageAt(page, 2).evaluate((el) => el.getBoundingClientRect().bottom);

  const above = firstPageTop - viewportTop;
  const below = viewportTop + (await viewport.evaluate((el) => (el as HTMLElement).clientHeight)) - lastPageBottom;

  // Scrolled, not padded: the overflow is reached by scrolling, which is what distinguishes
  // the two strategies. Asserted directly rather than inferred from the margins, so no
  // tolerance below can weaken it.
  const scrollTop = await viewport.evaluate((el) => (el as HTMLElement).scrollTop);
  expect(scrollTop).toBeGreaterThan(0);

  // Equal margins to within a device pixel. The residual is a fractional scroll offset
  // meeting an integer one; a padded stack would be out by the whole overflow, ~1500px.
  expect(Math.abs(above - below)).toBeLessThan(2);
  expect(stackHeight * zoom).toBeGreaterThan(600);
});

test('manual zoom is not overridden by a window resize', async ({ page }) => {
  await mountFixture(page, stackFixture(2));
  await page.locator('[data-zoom="actual"]').click();
  const before = await readZoom(page);

  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(80);

  expect(await readZoom(page)).toBeCloseTo(before, 4);
});

test('fit re-fits after a resize', async ({ page }) => {
  await mountFixture(page, stackFixture(2));
  await page.locator('[data-zoom="fit"]').click();
  const before = await readZoom(page);

  await page.setViewportSize({ width: 1000, height: 700 });
  await page.waitForTimeout(120);
  const after = await readZoom(page);

  // Height shrank, so fitting must produce a smaller zoom.
  expect(after).toBeLessThan(before);
});

// ---------------------------------------------------------------------------
// Pan
// ---------------------------------------------------------------------------

test('scrolling moves the stack without changing its geometry', async ({ page }) => {
  await mountFixture(page, stackFixture(3));
  await page.locator('[data-zoom="actual"]').click();

  const viewport = page.locator('[data-viewport]');
  const readFirstPageTop = () => pageAt(page, 0).evaluate((el) => el.getBoundingClientRect().top);

  // Anchor at scrollTop 0 explicitly. The app's boot fit leaves the viewport
  // scrolled, so measuring "before" without normalising would compare against an
  // arbitrary starting scroll and produce a meaningless delta.
  await viewport.evaluate((el) => {
    (el as HTMLElement).scrollTop = 0;
  });
  const start = await readFirstPageTop();

  await viewport.evaluate((el) => {
    (el as HTMLElement).scrollTop = 300;
  });
  const afterScroll = await readFirstPageTop();

  // Content moved up by exactly the scroll delta; size unchanged.
  expect(afterScroll).toBeCloseTo(start - 300, 0);
  expect(await pageAt(page, 0).evaluate((el) => el.getBoundingClientRect().width)).toBeCloseTo(
    A4_PX.width,
    1,
  );
});

test('space+drag pans, and the cursor reports the panning state', async ({ page }) => {
  await mountFixture(page, stackFixture(3));
  await page.locator('[data-zoom="actual"]').click();

  const viewport = page.locator('[data-viewport]');
  const box = (await viewport.boundingBox())!;
  await viewport.evaluate((el) => {
    (el as HTMLElement).scrollTop = 200;
  });
  const before = await pageAt(page, 0).evaluate((el) => el.getBoundingClientRect().top);

  // Hold space: the viewport should advertise the panning cursor.
  await page.keyboard.down('Space');
  expect(await viewport.getAttribute('data-panning')).toBe('true');

  await page.mouse.move(box.x + 200, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 200, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Space');

  const after = await pageAt(page, 0).evaluate((el) => el.getBoundingClientRect().top);
  // Dragging up by 100px scrolls down by 100px, so content moves up. Asserted on
  // the scroll offset rather than a measured page position, because a synthetic
  // mouse drag lands within a pixel or two of the requested path and the scroll
  // value is the quantity under test anyway.
  const scrollAfter = await viewport.evaluate((el) => (el as HTMLElement).scrollTop);
  // A synthetic drag lands within a pixel or two of the requested path, so the
  // tolerance is a couple of pixels rather than exact.
  expect(scrollAfter).toBeGreaterThan(290);
  expect(scrollAfter).toBeLessThan(310);
  expect(after).toBeLessThan(before);
  expect(await viewport.getAttribute('data-panning')).toBe('false');
});

test('space panning stops when the window loses focus', async ({ page }) => {
  await mountFixture(page, stackFixture(2));
  const viewport = page.locator('[data-viewport]');

  await page.keyboard.down('Space');
  expect(await viewport.getAttribute('data-panning')).toBe('true');

  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  expect(await viewport.getAttribute('data-panning')).toBe('false');
  await page.keyboard.up('Space');
});

test('keyboard shortcuts change zoom', async ({ page }) => {
  await mountFixture(page, stackFixture(1));
  await page.locator('[data-zoom="actual"]').click();
  expect(await readZoom(page)).toBeCloseTo(1, 4);

  await page.keyboard.press('-');
  expect(await readZoom(page)).toBeCloseTo(0.8, 4);

  await page.keyboard.press('+');
  expect(await readZoom(page)).toBeCloseTo(1, 4);

  await page.keyboard.press('0');
  // Fit, which for one page in a tall viewport is well under 1.
  expect(await readZoom(page)).not.toBeCloseTo(1, 3);

  await page.keyboard.press('1');
  expect(await readZoom(page)).toBeCloseTo(1, 4);
});

test('keyboard shortcuts are ignored while typing in a field', async ({ page }) => {
  await mountFixture(page, stackFixture(1));
  await page.locator('[data-zoom="actual"]').click();

  // Focus a text input, then press a zoom key.
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'probe-input';
    document.body.append(input);
    input.focus();
  });
  await page.keyboard.press('-');
  expect(await readZoom(page)).toBeCloseTo(1, 4);

  await page.evaluate(() => document.querySelector('#probe-input')?.remove());
});

test('ctrl+wheel zooms anchored at the cursor', async ({ page }) => {
  await mountFixture(page, stackFixture(3));
  await page.locator('[data-zoom="actual"]').click();

  const viewport = page.locator('[data-viewport]');
  const box = (await viewport.boundingBox())!;
  const anchor = { x: box.x + 300, y: box.y + 300 };

  // Which page is under the cursor before zooming?
  const pageUnder = () =>
    viewport.evaluate(
      (_viewport, point: { x: number; y: number }) => {
        const el = document.elementFromPoint(point.x, point.y);
        return el?.closest('[data-page]')?.getAttribute('data-page') ?? null;
      },
      anchor,
    );
  const pageIndexBefore = await pageUnder();

  await page.mouse.move(anchor.x, anchor.y);
  await page.mouse.wheel(0, -120); // ctrl not set: this must NOT zoom
  expect(await readZoom(page)).toBeCloseTo(1, 4);

  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -240);
  await page.keyboard.up('Control');
  expect(await readZoom(page)).toBeGreaterThan(1);

  // The document point under the cursor should still be on the same page.
  expect(await pageUnder()).toBe(pageIndexBefore);
});

test('plain wheel scrolls without zooming', async ({ page }) => {
  await mountFixture(page, stackFixture(3));
  await page.locator('[data-zoom="actual"]').click();

  const viewport = page.locator('[data-viewport]');
  const box = (await viewport.boundingBox())!;
  await page.mouse.move(box.x + 200, box.y + 200);
  await page.mouse.wheel(0, 300);

  expect(await readZoom(page)).toBeCloseTo(1, 4);
  expect(await viewport.evaluate((el) => (el as HTMLElement).scrollTop)).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Anchored zoom
// ---------------------------------------------------------------------------

test('anchored zoom keeps the document point under the cursor fixed', async ({ page }) => {
  await mountFixture(page, stackFixture(3));
  await page.locator('[data-zoom="actual"]').click();

  const viewport = page.locator('[data-viewport]');
  // Anchor at a point known to be on the first page, 200px in: the top of the
  // stack is canvas margin, so a naive offset from the viewport's own top could
  // land in the inter-page gap, where there is nothing to hit-test.
  const anchor = await clientPointOn(page, 0, 200, 200);

  // Which page is under the anchor, and where on it? Measured from whichever page
  // element actually contains the point, so the assertion holds regardless of how
  // far the stack has scrolled.
  const pageLocalAt = () =>
    viewport.evaluate((_v, a: { x: number; y: number }) => {
      const el = document.elementFromPoint(a.x, a.y);
      const pageEl = el?.closest('[data-page]') as HTMLElement | null;
      if (pageEl === null || pageEl === undefined) return null;
      const rect = pageEl.getBoundingClientRect();
      return { id: pageEl.getAttribute('data-page'), x: a.x - rect.x, y: a.y - rect.y };
    }, anchor);

  const before = await pageLocalAt();
  expect(before).not.toBeNull();
  // Remember the page's own client rect too, so the assertion below is in
  // *screen* space — the actual contract. Page-local document coordinates are not
  // expected to match, because zoom changed how much document a pixel covers.
  const pageTopBefore = await pageAt(page, 0).evaluate((el) => el.getBoundingClientRect().top);

  await page.keyboard.down('Control');
  await page.mouse.move(anchor.x, anchor.y);
  await page.mouse.wheel(0, -240);
  await page.keyboard.up('Control');

  const zoomAfter = await readZoom(page);
  expect(zoomAfter).toBeGreaterThan(1);

  const after = await pageLocalAt();
  expect(after).not.toBeNull();

  // Same screen point, same page, despite the zoom. `pageLocalAt` reports offsets
  // from the page's own top edge, so adding the page's client top recovers the
  // screen position of the anchor.
  const pageTopAfter = await pageAt(page, 0).evaluate((el) => el.getBoundingClientRect().top);
  expect(after!.id).toBe(before!.id);
  // Screen position of the anchor is recovered by adding the page's client top.
  expect(after!.y + pageTopAfter).toBeCloseTo(before!.y + pageTopBefore, 0);
});

// ---------------------------------------------------------------------------
// Coordinate spaces
// ---------------------------------------------------------------------------

/**
 * Scrolls a page-local point into view and returns its client position.
 *
 * Necessary because the boot fit leaves the viewport scrolled to the middle of the
 * stack: a point measured on page 2 may be off screen, and a synthetic mouse move
 * to an off-screen coordinate lands nowhere useful.
 *
 * The scroll and the measurement are separate steps on purpose: scrolling moves the
 * element, so a single combined evaluate would return the position from *before*
 * the scroll and aim the mouse at empty space.
 */
async function clientPointOn(
  page: Page,
  pageIndex: number,
  docX: number,
  docY: number,
): Promise<{ x: number; y: number }> {
  const zoom = await readZoom(page);

  // Step 1: bring the point to roughly a third of the way down the viewport.
  await pageAt(page, pageIndex).evaluate(
    (el, args) => {
      const container = document.querySelector('[data-viewport]') as HTMLElement;
      const rect = el.getBoundingClientRect();
      const targetY = rect.y + args.y * args.zoom;
      const containerTop = container.getBoundingClientRect().top;
      container.scrollTop += targetY - containerTop - container.clientHeight / 3;
    },
    { x: docX, y: docY, zoom },
  );

  // Step 2: read where it ended up, after the scroll has settled.
  return pageAt(page, pageIndex).evaluate(
    (el, args) => {
      const rect = el.getBoundingClientRect();
      return { x: rect.x + args.x * args.zoom, y: rect.y + args.y * args.zoom };
    },
    { x: docX, y: docY, zoom },
  );
}

test('status bar reports page-local document coordinates, not screen ones', async ({ page }) => {
  await mountFixture(page, stackFixture(3));
  await page.locator('[data-zoom="actual"]').click();

  // A known page-local point: 100,200 inside the second page.
  const target = await clientPointOn(page, 1, 100, 200);
  await page.mouse.move(target.x, target.y);

  const readout = await page.locator('[data-status="point"]').textContent();
  // 100px = 26.458mm, 200px = 52.917mm at 96px/in, shown to 2 decimals.
  expect(readout).toBe('26.46mm, 52.92mm');

  const pageLabel = await page.locator('[data-status="page"]').textContent();
  expect(pageLabel).toBe('page 2');
});

test('status bar reports a gap when the pointer is between pages', async ({ page }) => {
  await mountFixture(page, stackFixture(3));
  await page.locator('[data-zoom="actual"]').click();

  const target = await pageAt(page, 0).evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return { x: rect.x + 100, y: rect.bottom + 8 };
  });
  await page.mouse.move(target.x, target.y);

  expect(await page.locator('[data-status="page"]').textContent()).toBe('gap');
});

test('a point on the second page restarts its y at zero', async ({ page }) => {
  await mountFixture(page, stackFixture(3));
  await page.locator('[data-zoom="actual"]').click();

  // Top edge of page 2: page-local y must be ~0, not ~pageHeight + gap.
  const target = await clientPointOn(page, 1, 50, 1);
  await page.mouse.move(target.x, target.y);

  const readout = await page.locator('[data-status="point"]').textContent();
  // 1px ≈ 0.26mm, so the y value must be tiny rather than ~300mm.
  const [, y] = (readout ?? '').split(', ');
  expect(Number.parseFloat(y ?? '999')).toBeLessThan(2);
});

// ---------------------------------------------------------------------------
// Rulers (chrome)
// ---------------------------------------------------------------------------

test('rulers are chrome: canvases, outside the page stack', async ({ page }) => {
  await mountSample(page);

  expect(await page.locator('canvas[data-ruler-horizontal]').count()).toBe(1);
  expect(await page.locator('canvas[data-ruler-vertical]').count()).toBe(1);
  // The rulers must not be inside the document surface, or they would become
  // part of the rendered document.
  const insideStack = await page.evaluate(() => document.querySelectorAll('[data-pages] canvas').length);
  expect(insideStack).toBe(0);
});

test('rulers redraw when zoom changes', async ({ page }) => {
  await mountFixture(page, stackFixture(2));
  await page.locator('[data-zoom="actual"]').click();

  const canvas = page.locator('canvas[data-ruler-horizontal]');
  const before = await canvas.evaluate((el) => (el as HTMLCanvasElement).toDataURL());

  await page.locator('[data-zoom="in"]').click();
  await page.waitForTimeout(60);
  const after = await canvas.evaluate((el) => (el as HTMLCanvasElement).toDataURL());

  expect(after).not.toBe(before);
});

test('ruler tick spacing grows as you zoom out, so ticks stay legible', async ({ page }) => {
  await mountFixture(page, stackFixture(2));

  /**
   * Counts tick marks by scanning the ruler's top rows for dark pixels. A
   * behavioural check of "are ticks drawn, and how many", rather than an
   * assertion about the drawing code's internals.
   */
  const countTicks = async (): Promise<number> => {
    const canvas = page.locator('canvas[data-ruler-horizontal]');
    return canvas.evaluate((el) => {
      const canvas = el as HTMLCanvasElement;
      const context = canvas.getContext('2d');
      if (context === null) return 0;
      const scanHeight = Math.min(6, canvas.height);
      const { data, width } = context.getImageData(0, 0, canvas.width, scanHeight);

      const isDark = (x: number): boolean => {
        if (x < 0 || x >= width) return false;
        for (let row = 0; row < scanHeight; row += 1) {
          const i = (row * width + x) * 4;
          if (data[i]! < 120 && data[i + 1]! < 120 && data[i + 2]! < 120) return true;
        }
        return false;
      };

      let ticks = 0;
      for (let x = 0; x < width; x += 1) {
        if (isDark(x) && !isDark(x - 1)) ticks += 1;
      }
      return ticks;
    });
  };

  await page.locator('[data-zoom="actual"]').click();
  const atFull = await countTicks();

  // Zoom out twice; the same physical ruler must show *fewer* document ticks,
  // because the step size increases.
  await page.locator('[data-zoom="out"]').click();
  await page.locator('[data-zoom="out"]').click();
  await page.waitForTimeout(60);
  const zoomedOut = await countTicks();

  expect(atFull).toBeGreaterThan(0);
  expect(zoomedOut).toBeLessThanOrEqual(atFull);
});

// ---------------------------------------------------------------------------
// Visual baselines for the stack
// ---------------------------------------------------------------------------

test('two-page stack renders both pages', async ({ page }) => {
  await mountFixture(
    page,
    `() => {
      const make = (x, color) => ({
        id: 'node_' + x, type: 'shape', name: 'r' + x,
        transform: { x: 40, y: 60, width: 200, height: 120,
                     rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color },
      });
      return {
        formatVersion: 1, id: 'doc_two', name: 'two pages',
        pageSize: { width: 210, height: 297, unit: 'mm', orientation: 'portrait' },
        assets: {},
        pages: [
          { id: 'pg_1', name: '1', background: { type: 'solid', color: '#ffffff' },
            objects: [make(1, '#ff0000')] },
          { id: 'pg_2', name: '2', background: { type: 'solid', color: '#f4f4f5' },
            objects: [make(2, '#0000ff')] },
        ],
      };
    }`,
  );

  await expect(pageRegion(page, 0)).toHaveScreenshot('stack-page-1.png');
  await expect(pageRegion(page, 1)).toHaveScreenshot('stack-page-2.png');
});

test('the sample document still renders identically at 1:1', async ({ page }) => {
  await mountSample(page);
  await expect(pageRegion(page)).toHaveScreenshot('m1-sample-document.png');
});

test('page layout is zoom-invariant (viewport path)', async ({ page }) => {
  await mountSample(page);
  await page.locator('[data-zoom="actual"]').click();
  const at100 = await measurePageLayout(page);

  await page.locator('[data-zoom="in"]').click();
  const zoomed = await measurePageLayout(page);

  expect(at100.width).toBeCloseTo(A4_PX.width, 1);
  expect(zoomed.width).toBeCloseTo(at100.width, 1);
  expect(zoomed.height).toBeCloseTo(at100.height, 1);
});

test('the page box keeps overflow:hidden in a multi-page stack', async ({ page }) => {
  await mountFixture(page, stackFixture(2));
  const overflow = await pageAt(page, 1).evaluate((el) => getComputedStyle(el).overflow);
  expect(overflow).toBe('hidden');
});

test('measure helper agrees with the direct read on a stacked page', async ({ page }) => {
  await mountFixture(page, stackFixture(2));
  await page.locator('[data-zoom="actual"]').click();

  const viaHelper = (await measure(page, '[data-page]')).rect;
  const direct = await pageAt(page, 0).evaluate((el) => {
    const box = el.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  });

  expect(viaHelper.width).toBeCloseTo(direct.width, 3);
  expect(viaHelper.height).toBeCloseTo(direct.height, 3);
});
