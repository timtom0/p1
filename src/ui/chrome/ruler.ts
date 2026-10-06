/**
 * Rulers.
 *
 * Explicitly **chrome, not document content** (§3.7). A `<canvas>` 2D surface is
 * the right tool for tick marks and labels and does not violate the CSS-backbone
 * rule, which governs how the *document* renders. The document itself is never
 * drawn here.
 *
 * The ruler is redrawn from viewport state rather than kept in sync by hand: it
 * subscribes to the viewport and asks for conversions each time. That keeps it
 * correct through zoom, pan and fit without any incremental-update logic.
 */

import { formatLength } from '../../core/units/units';
import type { Unit } from '../../core/units/units';
import type { Viewport } from '../../editor/viewport/viewport';

export interface RulerOptions {
  /** Document unit used for tick labels. */
  unit: Unit;
}

const TICK_STEPS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000,
] as const;

/**
 * Pick a tick spacing in **document** px that stays legible on screen.
 *
 * Returns the smallest 1/2/5-decade step whose on-screen spacing is at least
 * `minPixelsPerTick`, so ticks never bunch up as you zoom out.
 */
export function chooseTickStep(zoom: number, minPixelsPerTick = 64): number {
  for (const step of TICK_STEPS) {
    if (step * zoom >= minPixelsPerTick) return step;
  }
  return TICK_STEPS[TICK_STEPS.length - 1]!;
}

/** How many device pixels one CSS pixel occupies. */
function devicePixelRatio(): number {
  return window.devicePixelRatio || 1;
}

export class Rulers {
  private readonly horizontal: HTMLCanvasElement;
  private readonly vertical: HTMLCanvasElement;
  private readonly corner: HTMLElement;
  private readonly unit: Unit;
  private readonly viewport: Viewport;

  private resizeObserver: ResizeObserver | undefined;
  private frame: number | undefined;

  constructor(
    elements: { horizontal: HTMLCanvasElement; vertical: HTMLCanvasElement; corner: HTMLElement },
    viewport: Viewport,
    options: RulerOptions,
  ) {
    this.horizontal = elements.horizontal;
    this.vertical = elements.vertical;
    this.corner = elements.corner;
    this.unit = options.unit;
    this.viewport = viewport;

    this.resizeObserver = new ResizeObserver(() => this.draw());
    this.resizeObserver.observe(this.horizontal);
    this.resizeObserver.observe(this.vertical);

    this.draw();
  }

  /** Coalesce redraws to one per animation frame. */
  scheduleDraw(): void {
    if (this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      this.draw();
    });
  }

  draw(): void {
    const zoom = this.viewport.zoom;
    // `step` is a document-space interval (e.g. every 10mm). Multiplying by zoom
    // gives its on-screen spacing, which is what chooseTickStep reasons about.
    const step = chooseTickStep(zoom);

    this.drawAxis(this.horizontal, 'horizontal', step, zoom);
    this.drawAxis(this.vertical, 'vertical', step, zoom);
    this.corner.textContent = formatLength(0, this.unit);
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
  }

  /**
   * @param step  Tick interval in **document** px.
 * @param zoom  Current zoom; converts document px to screen px.
 */
private drawAxis(
    canvas: HTMLCanvasElement,
    axis: 'horizontal' | 'vertical',
    step: number,
    zoom: number,
  ): void {
    const dpr = devicePixelRatio();
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    if (cssWidth === 0 || cssHeight === 0) return;

    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);

    const context = canvas.getContext('2d');
    if (context === null) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, cssWidth, cssHeight);

    const styles = getComputedStyle(canvas);
    const tickColor = styles.getPropertyValue('--ruler-tick').trim() || '#8b8f99';
    const labelColor = styles.getPropertyValue('--ruler-label').trim() || '#8b8f99';
    const background = styles.getPropertyValue('--ruler-bg').trim() || '#1c1d22';
    context.fillStyle = background;
    context.fillRect(0, 0, cssWidth, cssHeight);

    const scroll = axis === 'horizontal' ? this.viewport.scroll.left : this.viewport.scroll.top;
    const length = axis === 'horizontal' ? cssWidth : cssHeight;
    const thickness = axis === 'horizontal' ? cssHeight : cssWidth;
    const stepPx = step * zoom;

    context.strokeStyle = tickColor;
    context.fillStyle = labelColor;
    context.font = '10px system-ui, sans-serif';
    context.lineWidth = 1;

    /*
     * Scroll is a screen-space offset; ticks are indexed in document space. So the
     * first visible tick is the one at or before `scroll / stepPx`, and each tick's
     * screen position is `documentPx · zoom − scroll`.
     *
     * Conflating these two spaces is the bug this comment exists to prevent: it
     * puts ticks at the right *count* but the wrong *positions* as soon as the
     * two factors differ, which they do at every zoom other than 1.
     */
    const firstIndex = Math.floor(scroll / stepPx);
    for (let index = firstIndex; ; index += 1) {
      const documentPx = index * step;
      const position = documentPx * zoom - scroll;
      if (position > length) break;
      if (position < 0) continue;

      const isMajor = index % 5 === 0;
      const tickLength = isMajor ? thickness * 0.6 : thickness * 0.3;

      context.beginPath();
      if (axis === 'horizontal') {
        const x = Math.round(position) + 0.5;
        context.moveTo(x, 0);
        context.lineTo(x, tickLength);
      } else {
        const y = Math.round(position) + 0.5;
        context.moveTo(0, y);
        context.lineTo(tickLength, y);
      }
      context.stroke();

      if (!isMajor) continue;

      // Label the major ticks. Negative values are reachable by scrolling past
      // the origin, and are useful for seeing the page in context.
      const label = formatLength(documentPx, this.unit, 1);
      if (axis === 'horizontal') {
        context.textBaseline = 'top';
        context.fillText(label, Math.round(position) + 3, tickLength + 1);
      } else {
        context.save();
        context.translate(tickLength + 1, Math.round(position) + 3);
        context.rotate(-Math.PI / 2);
        context.textAlign = 'right';
        context.textBaseline = 'top';
        context.fillText(label, 0, 0);
        context.restore();
      }
    }
  }
}