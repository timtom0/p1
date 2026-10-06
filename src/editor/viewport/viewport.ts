/**
 * Viewport: zoom, pan, and the coordinate spaces that connect them
 * (docs/ARCHITECTURE.md §3.7).
 *
 * Three mechanisms, each leaning on the browser rather than reimplementing it:
 *
 *   zoom — a single `transform: scale()` on the page-stack element. The document
 *          model never learns about zoom and no element's geometry changes, so
 *          line breaking, hyphenation and image cropping behave identically at
 *          every zoom level and match print output. This is the core claim of the
 *          architecture, and it costs one CSS write.
 *
 *   pan  — native scrolling of the viewport element. The canvas spacer is sized to
 *          `content × zoom`, so scrollbars always tell the truth and trackpad
 *          two-finger panning works without any code.
 *
 *   space — drag-to-pan for mouse users, who have no trackpad.
 *
 * ## Coordinate spaces
 *
 * Three distinct spaces, deliberately not conflated:
 *
 *   document  page-local px, origin at a page's top-left. What the model uses.
 *   stack     document px, origin at the top-left of the *first* page, including
 *             inter-page gaps. What page positioning uses.
 *   client    screen px (viewport coordinates). What input events use.
 *
 * Conversions live here and nowhere else, so tools cannot accidentally mix them.
 *
 * The overlay layer (selection, guides) is deliberately *not* transformed; it will
 * live outside the stack so its strokes stay 1px at any zoom. Not built yet — it
 * has no consumers until there is selection (M2).
 */

import type { Vec2 } from '../../core/geom/mat2d';
import { clamp } from './clamp';

export interface ViewportElements {
  /** Scroll container. */
  root: HTMLElement;
  /** Spacer sized to `content × zoom`; establishes the scrollable area. */
  canvas: HTMLElement;
  /** The transformed page stack; carries `transform: scale(zoom)`. */
  pages: HTMLElement;
}

export type ZoomMode = 'fit' | 'manual';

export interface ViewportState {
  zoom: number;
  mode: ZoomMode;
  /** Space between pages, in document px. View state, never document state. */
  pageGap: number;
  /** Which page the viewport is centred on, when known. */
  focusedPageIndex: number;
}

export interface ViewportOptions {
  minZoom?: number;
  maxZoom?: number;
  /** Breathing room around content when fitting, in screen px. */
  fitPadding?: number;
  onChange?: (state: ViewportState) => void;
}

/**
 * Document geometry the viewport needs.
 *
 * Note there is no `height`: the stack's height is *derived* here from
 * `pageCount`, `pageHeight` and the viewport's own gap, because the viewport owns
 * the gap. Accepting a precomputed height would mean two sources of truth for the
 * same value, and changing the gap would silently invalidate it.
 */
export interface ViewportContent {
  /** Page box width in document px. The stack is one page wide. */
  pageWidth: number;
  /** Page box height in document px. */
  pageHeight: number;
  pageCount: number;
}

/**
 * How far the viewport must scroll so that the document point under the cursor
 * stays under the cursor across a zoom change.
 *
 * Content scales about the stack origin, so a stack-local point at `previousZoom`
 * moves to `point · (next / previous)`; the difference is the scroll delta.
 * Extracted as a pure function because it is the one piece of zoom logic worth
 * testing without a layout engine.
 */
export function anchorScrollDelta(
  anchorStackPoint: Vec2,
  previousZoom: number,
  nextZoom: number,
): Vec2 {
  const ratio = nextZoom / previousZoom;
  return {
    x: anchorStackPoint.x * ratio - anchorStackPoint.x,
    y: anchorStackPoint.y * ratio - anchorStackPoint.y,
  };
}

/** Scroll offset within the spacer, in stack-local px. */
export interface ScrollPosition {
  left: number;
  top: number;
}

export class Viewport {
  private readonly root: HTMLElement;
  private readonly canvas: HTMLElement;
  private readonly pages: HTMLElement;

  private readonly minZoom: number;
  private readonly maxZoom: number;
  private readonly fitPadding: number;
  private readonly onChange: (state: ViewportState) => void;

  private content: ViewportContent = {
    pageWidth: 0,
    pageHeight: 0,
    pageCount: 0,
  };

  /**
   * Total stack size in document px, derived from the page box, page count and the
   * current gap. Single source of truth for the spacer size.
   *
   * Accepting a precomputed height was a bug in M1's first cut: changing the gap
   * then resized the spacer from a stale value, so the scroll extent no longer
   * matched the pages.
   */
  private stackWidth(): number {
    return this.content.pageWidth;
  }

  private stackHeight(): number {
    const { pageHeight, pageCount } = this.content;
    if (pageCount === 0) return 0;
    // n pages have n-1 gaps.
    return pageCount * pageHeight + (pageCount - 1) * this.gap;
  }

  private currentZoom = 1;
  private mode: ZoomMode = 'manual';
  private gap = 0;
  private focused = 0;

  private resizeObserver: ResizeObserver | undefined;
  private disposers: Array<() => void> = [];
  private spacePanning = false;
  private pointerPan: { pointerId: number; last: Vec2 } | undefined;

  constructor(elements: ViewportElements, options: ViewportOptions = {}) {
    this.root = elements.root;
    this.canvas = elements.canvas;
    this.pages = elements.pages;
    this.minZoom = options.minZoom ?? 0.02;
    this.maxZoom = options.maxZoom ?? 16;
    this.fitPadding = options.fitPadding ?? 48;
    this.onChange = options.onChange ?? (() => {});

    this.bindWheel();
    this.bindPanning();
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  get state(): ViewportState {
    return {
      zoom: this.currentZoom,
      mode: this.mode,
      pageGap: this.gap,
      focusedPageIndex: this.focused,
    };
  }

  get zoom(): number {
    return this.currentZoom;
  }

  /**
   * Tell the viewport how big the content is, in document px.
   *
   * Called on document or page changes. `gap` is stored because it affects both
   * the canvas size and `fit()`.
   */
  setContent(content: ViewportContent, gap: number): void {
    this.content = content;
    this.gap = gap;
    this.writeZoom(this.currentZoom);
    this.emit();
  }

  /** Space between pages, in document px. View state, never document state. */
  get pageGap(): number {
    return this.gap;
  }

  /**
   * Change the inter-page gap.
   *
   * Purely a view change: no document value is touched. The canvas resize and the
   * page offsets are recomputed from view state alone.
   */
  setPageGap(gap: number): void {
    if (gap === this.gap) return;
    this.gap = gap;
    this.writeZoom(this.currentZoom);
    this.emit();
  }

  /** Which page the viewport is centred on. */
  get focusedPageIndex(): number {
    return this.focused;
  }

  // -------------------------------------------------------------------------
  // Zoom
  // -------------------------------------------------------------------------

  /** Set an absolute zoom level, optionally anchored at a client point. */
  setZoom(zoom: number, anchorClient?: Vec2): void {
    this.mode = 'manual';
    this.applyZoom(zoom, anchorClient);
  }

  /** Multiply the current zoom, optionally anchored at a client point. */
  zoomBy(factor: number, anchorClient?: Vec2): void {
    this.mode = 'manual';
    this.applyZoom(this.currentZoom * factor, anchorClient);
  }

  /** Zoom so 1 document px maps to 1 CSS px, anchored at the viewport centre. */
  zoomToActualSize(): void {
    this.setZoom(1, this.viewportCentreClient());
  }

  zoomIn(): void {
    this.zoomBy(1.25, this.viewportCentreClient());
  }

  zoomOut(): void {
    this.zoomBy(1 / 1.25, this.viewportCentreClient());
  }

  /**
   * Scale the whole stack to fit the viewport and centre it.
   *
   * Chooses `min(scaleX, scaleY)`, so one axis ends up flush against the padding.
   * Stays in `fit` mode so a window resize keeps the page framed.
   */
  fit(): void {
    const { width, height } = this.viewportSize();
    if (width <= 0 || height <= 0 || this.stackWidth() <= 0) return;

    const zoom = clamp(
      Math.min(
        (width - this.fitPadding * 2) / this.stackWidth(),
        (height - this.fitPadding * 2) / this.stackHeight(),
      ),
      this.minZoom,
      this.maxZoom,
    );

    this.mode = 'fit';
    this.applyZoom(zoom);
    this.centerContent();
  }

  /** Fit a single page, and make it the focused page. */
  fitPage(index: number): void {
    const clamped = this.clampPageIndex(index);
    if (clamped === null) return;

    const { width, height } = this.viewportSize();
    if (width <= 0 || height <= 0 || this.content.pageWidth <= 0) return;

    const zoom = clamp(
      Math.min(
        (width - this.fitPadding * 2) / this.content.pageWidth,
        (height - this.fitPadding * 2) / this.content.pageHeight,
      ),
      this.minZoom,
      this.maxZoom,
    );

    this.focused = clamped;
    this.mode = 'manual';
    this.applyZoom(zoom);
    this.scrollPageIntoView(clamped);
    this.emit();
  }

  /** Re-fit on container resize only while the user has not chosen a zoom. */
  observeResize(): void {
    this.resizeObserver = new ResizeObserver(() => {
      if (this.mode === 'fit') this.fit();
    });
    this.resizeObserver.observe(this.root);
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
  }

  // -------------------------------------------------------------------------
  // Pan
  // -------------------------------------------------------------------------

  /** Scroll offset within the spacer, in stack-local px. */
  get scroll(): ScrollPosition {
    return { left: this.root.scrollLeft, top: this.root.scrollTop };
  }

  scrollTo(left: number, top: number): void {
    this.root.scrollLeft = Math.max(0, left);
    this.root.scrollTop = Math.max(0, top);
  }

  /** Centre the whole stack in the viewport. */
  centerContent(): void {
    this.scrollTo(
      (this.stackWidth() * this.currentZoom - this.viewportSize().width) / 2,
      (this.stackHeight() * this.currentZoom - this.viewportSize().height) / 2,
    );
  }

  /** Scroll the minimum amount needed to bring a page fully into view. */
  scrollPageIntoView(index: number): void {
    const clamped = this.clampPageIndex(index);
    if (clamped === null) return;

    const zoom = this.currentZoom;
    const pageTop = this.pageOffsetY(clamped) * zoom;
    const pageBottom = pageTop + this.content.pageHeight * zoom;
    const viewHeight = this.viewportSize().height;

    // Already fully visible: leave the scroll alone, so repeated calls do not
    // creep the view.
    if (pageTop >= this.root.scrollTop && pageBottom <= this.root.scrollTop + viewHeight) return;

    this.scrollTo(
      this.root.scrollLeft,
      pageTop - (viewHeight - (pageBottom - pageTop)) / 2,
    );
  }

  /** Temporarily pan with the space bar, as mouse users expect. */
  setSpacePanning(active: boolean): void {
    if (this.spacePanning === active) return;
    this.spacePanning = active;
    this.root.dataset['panning'] = active ? 'true' : 'false';
    this.emit();
  }

  get isSpacePanning(): boolean {
    return this.spacePanning;
  }

  // -------------------------------------------------------------------------
  // Coordinate spaces
  // -------------------------------------------------------------------------

  /**
   * Client → stack (document px, origin at the top-left of the first page,
   * including inter-page gaps).
   */
  stackPointFromClient(client: Vec2): Vec2 {
    const origin = this.stackOriginClient();
    return {
      x: (client.x - origin.x) / this.currentZoom,
      y: (client.y - origin.y) / this.currentZoom,
    };
  }

  /** Stack → client. */
  clientFromStackPoint(point: Vec2): Vec2 {
    const origin = this.stackOriginClient();
    return {
      x: origin.x + point.x * this.currentZoom,
      y: origin.y + point.y * this.currentZoom,
    };
  }

  /**
   * Client → page-local document coordinates.
   *
   * Returns `null` when the point is not over a page — in a gap, or past the end
   * of the stack. Callers must handle that rather than receiving a misleading
   * coordinate; selection will need it to reject clicks on background.
   */
  pagePointFromClient(client: Vec2): Vec2 | null {
    const stack = this.stackPointFromClient(client);
    const index = this.pageIndexAt(stack.y);
    if (index === null) return null;
    return { x: stack.x, y: stack.y - this.pageOffsetY(index) };
  }

  /** Page-local document coordinates → client, for a given page index. */
  clientFromPagePoint(point: Vec2, pageIndex: number): Vec2 {
    const clamped = this.clampPageIndex(pageIndex);
    const offsetY = clamped === null ? 0 : this.pageOffsetY(clamped);
    return this.clientFromStackPoint({ x: point.x, y: point.y + offsetY });
  }

  /** Which page contains a stack y offset, or `null` if it falls in a gap or past the end. */
  pageIndexAt(stackY: number): number | null {
    const { pageHeight, pageCount } = this.content;
    if (pageCount === 0 || stackY < 0) return null;
    const stride = pageHeight + this.gap;
    const index = Math.floor(stackY / stride);
    if (index >= pageCount) return null;
    // Inside the inter-page gap rather than on a page.
    if (stackY - index * stride >= pageHeight) return null;
    return index;
  }

  /** Stack y offset of a page's top edge, in document px. */
  pageOffsetY(index: number): number {
    return index * (this.content.pageHeight + this.gap);
  }

  /** Zoom clamped to the allowed range. Exposed for UI that previews a level. */
  clampZoom(zoom: number): number {
    return clamp(zoom, this.minZoom, this.maxZoom);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private bindWheel(): void {
    // Ctrl/⌘ + wheel zooms, anchored at the cursor. Plain wheel falls through to
    // native scrolling, which is what trackpad users expect.
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      this.zoomBy(Math.exp(-event.deltaY * 0.002), { x: event.clientX, y: event.clientY });
    };
    this.root.addEventListener('wheel', onWheel, { passive: false });
    this.disposers.push(() => this.root.removeEventListener('wheel', onWheel));
  }

  private bindPanning(): void {
    const onPointerDown = (event: PointerEvent): void => {
      const wantsPan = event.button === 1 || (event.button === 0 && this.spacePanning);
      if (!wantsPan) return;
      event.preventDefault();
      this.pointerPan = { pointerId: event.pointerId, last: { x: event.clientX, y: event.clientY } };
      this.root.setPointerCapture(event.pointerId);
      this.root.dataset['panning'] = 'true';
    };

    const onPointerMove = (event: PointerEvent): void => {
      const pan = this.pointerPan;
      if (pan === undefined || pan.pointerId !== event.pointerId) return;
      const dx = event.clientX - pan.last.x;
      const dy = event.clientY - pan.last.y;
      pan.last = { x: event.clientX, y: event.clientY };
      this.scrollTo(this.root.scrollLeft - dx, this.root.scrollTop - dy);
    };

    const endPan = (event: PointerEvent): void => {
      const pan = this.pointerPan;
      if (pan === undefined || pan.pointerId !== event.pointerId) return;
      this.pointerPan = undefined;
      if (this.root.hasPointerCapture(event.pointerId)) {
        this.root.releasePointerCapture(event.pointerId);
      }
      this.root.dataset['panning'] = this.spacePanning ? 'true' : 'false';
    };

    this.root.addEventListener('pointerdown', onPointerDown);
    this.root.addEventListener('pointermove', onPointerMove);
    this.root.addEventListener('pointerup', endPan);
    this.root.addEventListener('pointercancel', endPan);
    this.disposers.push(() => {
      this.root.removeEventListener('pointerdown', onPointerDown);
      this.root.removeEventListener('pointermove', onPointerMove);
      this.root.removeEventListener('pointerup', endPan);
      this.root.removeEventListener('pointercancel', endPan);
    });
  }

  private applyZoom(nextZoom: number, anchorClient?: Vec2): void {
    const zoom = clamp(nextZoom, this.minZoom, this.maxZoom);
    if (zoom === this.currentZoom) return;
    const previousZoom = this.currentZoom;

    if (anchorClient !== undefined) {
      const before = this.stackPointFromClient(anchorClient);
      this.writeZoom(zoom);
      const delta = anchorScrollDelta(before, previousZoom, zoom);
      this.scrollTo(this.root.scrollLeft + delta.x, this.root.scrollTop + delta.y);
    } else {
      this.writeZoom(zoom);
    }

    this.currentZoom = zoom;
    this.emit();
  }

  /**
   * Write zoom to the DOM.
   *
   * Three writes, and that is the entire cost of zooming: the spacer size, so
   * scrollbars are truthful, and the stack transform. No element geometry changes.
   */
  private writeZoom(zoom: number): void {
    this.canvas.style.width = `${this.stackWidth() * zoom}px`;
    this.canvas.style.height = `${this.stackHeight() * zoom}px`;
    this.pages.style.transform = `scale(${zoom})`;
  }

  private emit(): void {
    this.onChange(this.state);
  }

  private clampPageIndex(index: number): number | null {
    if (this.content.pageCount === 0) return null;
    return Math.min(Math.max(index, 0), this.content.pageCount - 1);
  }

  private viewportCentreClient(): Vec2 {
    const rect = this.root.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  private viewportSize(): { width: number; height: number } {
    return { width: this.root.clientWidth, height: this.root.clientHeight };
  }

  /** Client position of the stack's origin, i.e. of the first page's top-left. */
  private stackOriginClient(): Vec2 {
    const rect = this.pages.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  }
}
