// @vitest-environment happy-dom

/**
 * Viewport unit tests.
 *
 * `happy-dom` has no layout engine, so anything depending on measured geometry is
 * stubbed explicitly below. What is tested here is the logic: zoom clamping, fit
 * arithmetic, the coordinate conversions between the three spaces, and the pure
 * anchor-scroll maths. The browser suite (`tests/visual/`) covers the parts that
 * genuinely need a real layout engine.
 */

import { describe, expect, it } from 'vitest';
import { anchorScrollDelta, Viewport } from './viewport';
import type { ViewportContent } from './viewport';
import type { Vec2 } from '../../core/geom/mat2d';

/** A4 portrait in document px. */
const PAGE = { width: 793.7007874015748, height: 1122.5196850393702 };
const GAP = 32;

interface Harness {
  viewport: Viewport;
  root: HTMLElement;
  canvas: HTMLElement;
  pages: HTMLElement;
  setViewportSize(width: number, height: number): void;
  setStackOrigin(x: number, y: number): void;
  readZoom(): number;
}

/** Content descriptor. The stack height is derived by the viewport from the gap. */
function content(pageCount = 1): ViewportContent {
  return {
    pageWidth: PAGE.width,
    pageHeight: PAGE.height,
    pageCount,
  };
}

function mount(options: { minZoom?: number; maxZoom?: number; fitPadding?: number } = {}): Harness {
  const root = document.createElement('div');
  const canvas = document.createElement('div');
  const pages = document.createElement('div');

  // happy-dom reports zero for every layout property, so stub the ones the
  // viewport reads. Anything unstubbed would silently be 0 and hide bugs.
  let viewportWidth = 1280;
  let viewportHeight = 900;
  let origin: Vec2 = { x: 0, y: 0 };
  let scrollLeft = 0;
  let scrollTop = 0;

  Object.defineProperty(root, 'clientWidth', { get: () => viewportWidth, configurable: true });
  Object.defineProperty(root, 'clientHeight', { get: () => viewportHeight, configurable: true });
  Object.defineProperty(root, 'scrollLeft', {
    get: () => scrollLeft,
    set: (value: number) => {
      scrollLeft = Math.max(0, value);
    },
    configurable: true,
  });
  Object.defineProperty(root, 'scrollTop', {
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.max(0, value);
    },
    configurable: true,
  });
  root.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: viewportWidth, height: viewportHeight, right: viewportWidth, bottom: viewportHeight }) as DOMRect;

  pages.getBoundingClientRect = () =>
    ({ left: origin.x, top: origin.y, width: PAGE.width, height: PAGE.height, right: origin.x + PAGE.width, bottom: origin.y + PAGE.height }) as DOMRect;

  canvas.getBoundingClientRect = () =>
    ({ left: origin.x, top: origin.y, width: PAGE.width, height: PAGE.height }) as DOMRect;

  const viewport = new Viewport({ root, canvas, pages }, options);
  viewport.setContent(content(), GAP);

  return {
    viewport,
    root,
    canvas,
    pages,
    setViewportSize: (width, height) => {
      viewportWidth = width;
      viewportHeight = height;
    },
    setStackOrigin: (x, y) => {
      origin = { x, y };
    },
    readZoom: () => Number(/scale\(([\d.]+)\)/.exec(pages.style.transform)?.[1] ?? 'NaN'),
  };
}

describe('zoom', () => {
  it('writes exactly one transform plus a spacer resize', () => {
    const { viewport, canvas, pages } = mount();
    viewport.setZoom(2);

    expect(pages.style.transform).toBe('scale(2)');
    // The spacer tracks content × zoom so scrollbars tell the truth.
    expect(parseFloat(canvas.style.width)).toBeCloseTo(PAGE.width * 2, 3);
    expect(parseFloat(canvas.style.height)).toBeCloseTo(PAGE.height * 2, 3);
  });

  it('clamps to the configured range', () => {
    const { viewport } = mount({ minZoom: 0.25, maxZoom: 4 });
    viewport.setZoom(1000);
    expect(viewport.zoom).toBe(4);
    viewport.setZoom(0.0001);
    expect(viewport.zoom).toBe(0.25);
  });

  it('exposes clamping without changing state', () => {
    const { viewport } = mount({ minZoom: 0.5, maxZoom: 2 });
    viewport.setZoom(1);
    expect(viewport.clampZoom(99)).toBe(2);
    expect(viewport.zoom).toBe(1);
  });

  it('steps by 1.25 in both directions', () => {
    const { viewport } = mount();
    viewport.setZoom(1);
    viewport.zoomIn();
    expect(viewport.zoom).toBeCloseTo(1.25, 6);
    viewport.zoomOut();
    expect(viewport.zoom).toBeCloseTo(1, 6);
  });

  it('does not notify when the zoom is unchanged', () => {
    const root = document.createElement('div');
    const canvas = document.createElement('div');
    const pages = document.createElement('div');
    let notifications = 0;
    const viewport = new Viewport(
      { root, canvas, pages },
      { onChange: () => (notifications += 1) },
    );

    viewport.setZoom(2);
    expect(notifications).toBe(1);
    viewport.setZoom(2);
    expect(notifications).toBe(1);
  });

  it('scales the spacer by the stack extent, not the page size', () => {
    const { viewport, canvas } = mount();
    viewport.setContent(content(3), GAP);
    viewport.setZoom(1);

    const expectedHeight = 3 * PAGE.height + 2 * GAP;
    expect(parseFloat(canvas.style.height)).toBeCloseTo(expectedHeight, 3);
  });
});

describe('fit', () => {
  it('chooses min(scaleX, scaleY) against viewport minus padding', () => {
    const { viewport, setViewportSize } = mount({ fitPadding: 50 });
    setViewportSize(1000, 1000);
    viewport.setContent(content(), GAP);
    viewport.fit();

    const expected = Math.min(
      (1000 - 100) / PAGE.width,
      (1000 - 100) / PAGE.height,
    );
    expect(viewport.zoom).toBeCloseTo(expected, 6);
  });

  it('leaves exactly one padding on the tight axis and more on the other', () => {
    const { viewport, setViewportSize } = mount({ fitPadding: 50 });
    setViewportSize(1000, 1000);
    viewport.setContent(content(), GAP);
    viewport.fit();

    // A4 is taller than it is wide, so with a square viewport height binds:
    // scaleY = 900/1122.52 is smaller than scaleX = 900/793.70.
    const slackX = 1000 - PAGE.width * viewport.zoom;
    const slackY = 1000 - PAGE.height * viewport.zoom;

    // The tight axis is flush against the padding on both sides.
    expect(Math.min(slackX, slackY)).toBeCloseTo(100, 1);
    expect(Math.max(slackX, slackY)).toBeGreaterThan(100);
    // And it is the height, confirming min() picked the binding axis.
    expect(slackY).toBeLessThan(slackX);
  });

  it('fits the whole stack, so more pages means smaller zoom', () => {
    const { viewport, setViewportSize } = mount({ fitPadding: 0 });
    setViewportSize(1000, 1200);

    viewport.setContent(content(1), GAP);
    viewport.fit();
    const onePage = viewport.zoom;

    viewport.setContent(content(4), GAP);
    viewport.fit();
    const fourPages = viewport.zoom;

    expect(fourPages).toBeLessThan(onePage);
    expect(fourPages).toBeCloseTo(
      1200 / (4 * PAGE.height + 3 * GAP),
      6,
    );
  });

  it('centres the content', () => {
    const { viewport, setViewportSize } = mount({ fitPadding: 0 });
    setViewportSize(1000, 1200);
    viewport.setContent(content(1), GAP);
    viewport.fit();

    const scroll = viewport.scroll;
    const scaledHeight = PAGE.height * viewport.zoom;
    expect(scroll.top).toBeCloseTo((scaledHeight - 1200) / 2, 3);
  });

  it('re-fits on resize only while in fit mode', () => {
    const { viewport, setViewportSize } = mount({ fitPadding: 0 });
    setViewportSize(1000, 1200);
    viewport.setContent(content(), GAP);

    viewport.fit();
    const fitted = viewport.zoom;
    expect(viewport.state.mode).toBe('fit');

    // A manual zoom takes the viewport out of fit mode, so later resizes must
    // not override the user's choice.
    viewport.setZoom(1);
    expect(viewport.state.mode).toBe('manual');
    setViewportSize(600, 600);
    expect(viewport.zoom).toBe(1);
    expect(fitted).not.toBeCloseTo(1, 3);
  });

  it('does nothing when the viewport has no size yet', () => {
    const { viewport, setViewportSize } = mount();
    setViewportSize(0, 0);
    viewport.setContent(content(), GAP);
    viewport.fit();
    expect(viewport.zoom).toBe(1);
  });

  it('fits a single page and focuses it', () => {
    const { viewport, setViewportSize } = mount({ fitPadding: 0 });
    setViewportSize(1000, 2000);
    viewport.setContent(content(3), GAP);

    viewport.fitPage(1);
    expect(viewport.focusedPageIndex).toBe(1);
    // Page fit uses the page box, not the whole stack, so it can be larger.
    expect(viewport.zoom).toBeCloseTo(1000 / PAGE.width, 6);
  });

  it('clamps an out-of-range page index', () => {
    const { viewport } = mount();
    viewport.setContent(content(3), GAP);
    viewport.fitPage(99);
    expect(viewport.focusedPageIndex).toBe(2);
    viewport.fitPage(-5);
    expect(viewport.focusedPageIndex).toBe(0);
  });
});

describe('coordinate spaces', () => {
  it('converts client → stack → client', () => {
    const { viewport, setStackOrigin } = mount();
    setStackOrigin(37, 91);
    viewport.setZoom(2);

    const client: Vec2 = { x: 437, y: 291 };
    const stack = viewport.stackPointFromClient(client);
    expect(stack.x).toBeCloseTo(200, 6);
    expect(stack.y).toBeCloseTo(100, 6);

    const back = viewport.clientFromStackPoint(stack);
    expect(back.x).toBeCloseTo(client.x, 6);
    expect(back.y).toBeCloseTo(client.y, 6);
  });

  it('converts client → page-local, offsetting by the page position', () => {
    const { viewport, setStackOrigin } = mount();
    viewport.setContent(content(3), GAP);
    setStackOrigin(0, 0);
    viewport.setZoom(1);

    // A point 10px into the second page.
    const secondPageStart = PAGE.height + GAP;
    const point = viewport.pagePointFromClient({ x: 50, y: secondPageStart + 30 });
    expect(point).not.toBeNull();
    expect(point!.x).toBeCloseTo(50, 6);
    // Page-local y restarts at the page's own top edge.
    expect(point!.y).toBeCloseTo(30, 6);
  });

  it('returns null for a point in the gap between pages', () => {
    const { viewport, setStackOrigin } = mount();
    viewport.setContent(content(3), GAP);
    setStackOrigin(0, 0);
    viewport.setZoom(1);

    // Inside the gap below page 1.
    const inGap = PAGE.height + 10;
    expect(viewport.pagePointFromClient({ x: 50, y: inGap })).toBeNull();
  });

  it('returns null above the stack and past the last page', () => {
    const { viewport, setStackOrigin } = mount();
    viewport.setContent(content(2), GAP);
    setStackOrigin(0, 0);
    viewport.setZoom(1);

    expect(viewport.pagePointFromClient({ x: 50, y: -1 })).toBeNull();
    const pastEnd = 2 * PAGE.height + GAP + 10;
    expect(viewport.pagePointFromClient({ x: 50, y: pastEnd })).toBeNull();
  });

  it('round-trips page-local coordinates for a given page', () => {
    const { viewport, setStackOrigin } = mount();
    viewport.setContent(content(3), GAP);
    setStackOrigin(11, 23);
    viewport.setZoom(1.5);

    const original: Vec2 = { x: 120, y: 240 };
    const client = viewport.clientFromPagePoint(original, 2);
    const recovered = viewport.pagePointFromClient(client);
    expect(recovered!.x).toBeCloseTo(original.x, 6);
    expect(recovered!.y).toBeCloseTo(original.y, 6);
  });

  it('maps stack offsets to page indices, excluding gaps', () => {
    const { viewport } = mount();
    viewport.setContent(content(3), GAP);

    expect(viewport.pageIndexAt(0)).toBe(0);
    expect(viewport.pageIndexAt(PAGE.height - 1)).toBe(0);
    expect(viewport.pageIndexAt(PAGE.height + GAP - 1)).toBeNull();
    expect(viewport.pageIndexAt(PAGE.height + GAP)).toBe(1);
    expect(viewport.pageIndexAt(2 * (PAGE.height + GAP))).toBe(2);
    expect(viewport.pageIndexAt(-1)).toBeNull();
    expect(viewport.pageIndexAt(10 * PAGE.height)).toBeNull();
  });

  it('keeps page offsets in document px regardless of zoom', () => {
    const { viewport } = mount();
    viewport.setContent(content(3), GAP);

    viewport.setZoom(1);
    const atOne = viewport.pageOffsetY(2);
    viewport.setZoom(4);
    expect(viewport.pageOffsetY(2)).toBeCloseTo(atOne, 9);
    expect(atOne).toBeCloseTo(2 * (PAGE.height + GAP), 6);
  });
});

describe('panning', () => {
  it('reports and sets scroll offsets, never negative', () => {
    const { viewport } = mount();
    viewport.setContent(content(3), GAP);
    viewport.setZoom(2);

    viewport.scrollTo(120, 340);
    expect(viewport.scroll).toEqual({ left: 120, top: 340 });

    viewport.scrollTo(-50, -50);
    expect(viewport.scroll).toEqual({ left: 0, top: 0 });
  });

  it('centres content', () => {
    const { viewport, setViewportSize } = mount();
    setViewportSize(700, 1200);
    viewport.setContent(content(2), GAP);
    viewport.setZoom(1);
    viewport.centerContent();

    const height = 2 * PAGE.height + GAP;
    // Both axes overflow here (page is 793.7 wide, viewport 700), so centring is
    // a real scroll offset on each axis.
    expect(viewport.scroll.top).toBeCloseTo((height - 1200) / 2, 3);
    expect(viewport.scroll.left).toBeCloseTo((PAGE.width - 700) / 2, 3);
  });

  it('does not scroll negatively when content is smaller than the viewport', () => {
    const { viewport, setViewportSize } = mount();
    // Viewport wider and taller than the page: centring should clamp at 0,0
    // rather than producing a negative offset.
    setViewportSize(2000, 2000);
    viewport.setContent(content(1), GAP);
    viewport.setZoom(1);
    viewport.centerContent();

    expect(viewport.scroll).toEqual({ left: 0, top: 0 });
  });

  it('scrolls a page into view only when it is not already visible', () => {
    const { viewport, setViewportSize } = mount({ fitPadding: 0 });
    setViewportSize(1000, 1200);
    viewport.setContent(content(4), GAP);
    viewport.setZoom(1);
    viewport.scrollTo(0, 0);

    // Page 3 is far below; scrolling to it must move.
    viewport.scrollPageIntoView(3);
    const moved = viewport.scroll.top;
    expect(moved).toBeGreaterThan(0);

    // Asking again must not creep.
    viewport.scrollPageIntoView(3);
    expect(viewport.scroll.top).toBeCloseTo(moved, 9);
  });

  it('toggles space panning state for the cursor', () => {
    const { viewport, root } = mount();
    expect(viewport.isSpacePanning).toBe(false);
    viewport.setSpacePanning(true);
    expect(viewport.isSpacePanning).toBe(true);
    expect(root.dataset['panning']).toBe('true');
    viewport.setSpacePanning(false);
    expect(root.dataset['panning']).toBe('false');
  });
});

describe('page gap as view state', () => {
  it('resizes the spacer when the gap changes, without touching the document', () => {
    const { viewport, canvas, pages } = mount();
    viewport.setContent(content(3), GAP);
    viewport.setZoom(1);

    const before = canvas.style.height;
    viewport.setPageGap(100);

    const expected = 3 * PAGE.height + 2 * 100;
    expect(parseFloat(canvas.style.height)).toBeCloseTo(expected, 3);
    expect(canvas.style.height).not.toBe(before);
    expect(viewport.pageGap).toBe(100);
    // Page elements keep their own size: the gap is not baked into the document.
    expect(pages.style.transform).toBe('scale(1)');
  });

  it('ignores a no-op gap change', () => {
    const root = document.createElement('div');
    const canvas = document.createElement('div');
    const pages = document.createElement('div');
    let notifications = 0;
    const viewport = new Viewport({ root, canvas, pages }, { onChange: () => (notifications += 1) });

    viewport.setContent(content(2), GAP);
    const afterSetContent = notifications;

    viewport.setPageGap(GAP);
    // Idempotent: the value survives and nothing is re-emitted.
    expect(viewport.pageGap).toBe(GAP);
    expect(notifications).toBe(afterSetContent);
  });
});

describe('anchorScrollDelta', () => {
  it('is zero at the stack origin', () => {
    expect(anchorScrollDelta({ x: 0, y: 0 }, 1, 4)).toEqual({ x: 0, y: 0 });
  });

  it('keeps an anchored document point stationary across a zoom change', () => {
    const anchor = { x: 300, y: 150 };
    const from = 1;
    const to = 2.5;
    const delta = anchorScrollDelta(anchor, from, to);

    const docBefore = { x: anchor.x / from, y: anchor.y / from };
    const docAfter = {
      x: (anchor.x + delta.x) / to,
      y: (anchor.y + delta.y) / to,
    };
    expect(docAfter.x).toBeCloseTo(docBefore.x, 9);
    expect(docAfter.y).toBeCloseTo(docBefore.y, 9);
  });

  it('points the other way when zooming out', () => {
    expect(anchorScrollDelta({ x: 400, y: 200 }, 2, 1).x).toBeCloseTo(-200, 9);
    expect(anchorScrollDelta({ x: 400, y: 200 }, 2, 1).y).toBeCloseTo(-100, 9);
  });
});