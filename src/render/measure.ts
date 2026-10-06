/**
 * Asking the browser what it laid out.
 *
 * The read side of ADR 0003's division of labour:
 *
 * > If the user authored it, it is in the model. If changing it changes pixels without
 * > the user authoring it, it belongs to CSS.
 *
 * So layout is not in the document, and this module is how the editor gets it back.
 * The design and the measurements behind it are in
 * `docs/adr/0004-measurement-boundary.md`; the short version:
 *
 *  - **`clientWidth/Height` and `scrollWidth/Height` are zoom- and
 *    transform-invariant.** They are layout quantities, and the page stack's
 *    `transform: scale(z)` is a paint-time transform applied *after* layout. Verified
 *    at four zoom levels and under a 30° object rotation.
 *  - **`getBoundingClientRect` is scaled, and under rotation it is the bounding box of
 *    the painted result** — 198×143 for a 200×50 box. It is the wrong tool for size,
 *    which is why nothing here uses it.
 *
 * ## What this module deliberately does not do
 *
 * It returns **sizes and overflow, in document px**. It performs no coordinate
 * conversion at all, so `render/` never needs to import `editor/` and no caller can
 * divide by zoom "just this once". Positions already have an owner: `Viewport` and
 * `Overlay` convert client ↔ stack ↔ page (§3.7).
 *
 * It also refuses to answer rather than answering wrongly. A `display: none` element
 * reports **zero** from every layout API, which is indistinguishable from a genuinely
 * zero-sized object — so `isRendered` exists and callers are expected to ask.
 *
 * @module
 */

/** A laid-out size, in document px. Integer; see {@link PreciseSize} for fractions. */
export interface LayoutSize {
  readonly width: number;
  readonly height: number;
}

/**
 * A laid-out size at the browser's own precision.
 *
 * `clientHeight` rounds to an integer, and a 19.5px line height reports `20` — so three
 * lines of text measure 58.5px and are reported as 60. Chromium also quantises layout to
 * 1/64px, so this is not a lossless number either. It is, however, the only
 * zoom-invariant, transform-invariant, *fractional* size the browser offers, and it
 * arrives asynchronously.
 */
export type PreciseSize = LayoutSize;

/**
 * Whether an element's content exceeds its box.
 *
 * Derived rather than exposing the raw `scroll* > client*` pair, because a raw pair
 * invites each caller to invent its own comparison and one of them will use `>=` and
 * report a sub-pixel difference as an overflow.
 */
export interface Overflow {
  readonly x: boolean;
  readonly y: boolean;
}

/**
 * The content box of an element, in document px.
 *
 * Note this is the *content* box: padding and borders are excluded, which is what a
 * page-layout editor wants and what `box-sizing: border-box` would otherwise hide.
 */
export function contentBoxSize(element: HTMLElement): LayoutSize {
  return { width: element.clientWidth, height: element.clientHeight };
}

/** The padding box, in document px. Differs from the content box once padding exists. */
export function paddingBoxSize(element: HTMLElement): LayoutSize {
  return { width: element.offsetWidth, height: element.offsetHeight };
}

/**
 * Whether the element's content overflows its box.
 *
 * Valid only for a rendered element: a `display: none` element reports zero scroll
 * dimensions and would be reported as not overflowing, which is a second way to be
 * wrong. Check {@link isRendered} first.
 */
export function overflowOf(element: HTMLElement): Overflow {
  return {
    x: element.scrollWidth > element.clientWidth,
    y: element.scrollHeight > element.clientHeight,
  };
}

/**
 * Whether the element is in the document and actually laid out.
 *
 * The check is `display`, not `offsetParent`: `offsetParent` is `null` for any
 * `position: fixed` element, which would make a correctly rendered frame look
 * unrendered.
 *
 * This exists because measurement has no honest answer for a hidden element. Every
 * layout API returns `0`, and `0` is a plausible size — a frame the model has hidden,
 * and a frame that is genuinely 0×0, are indistinguishable. Measured, not assumed:
 * see `tests/spike/measure-probe.spec.ts` probe N.
 */
export function isRendered(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  return getComputedStyle(element).display !== 'none';
}

/**
 * The laid-out size of `element`, or `null` when it cannot be measured.
 *
 * A convenience over {@link isRendered} plus {@link contentBoxSize}, and the form most
 * callers want. `null` means "no answer", which is a different statement from
 * "zero-sized" — see {@link isRendered}.
 */
export function measureRendered(element: HTMLElement): LayoutSize | null {
  if (!isRendered(element)) return null;
  return contentBoxSize(element);
}

/**
 * Resolves once no font load is pending for the document.
 *
 * Part of the measurement contract as a *promise*, not as a gate, because today the
 * application declares no `@font-face` rules at all (measured: `document.fonts.size`
 * is `0`) and every family it uses is locally installed — so there is no asynchronous
 * font step to wait for and this resolves immediately.
 *
 * The hook exists now because the first webfont makes it load-bearing, and a size
 * measured before a webfont arrives is wrong in a way nothing else would catch.
 *
 * **Do not use `document.fonts.check()` to ask whether a family exists.** It reports
 * whether *pending loads* have settled, not whether a family resolved, and returns
 * `true` for a family that does not exist at all (measured:
 * `check('16px NoSuchFamilyExistsAtAll') === true`).
 */
export function whenFontsSettled(): Promise<void> {
  if (typeof document === 'undefined' || document.fonts === undefined) {
    return Promise.resolve();
  }
  return document.fonts.ready.then(() => undefined);
}

/**
 * Observes an element's content box at the browser's own precision.
 *
 * The only source of a **fractional, zoom-invariant, transform-invariant** size.
 * Verified by rotating the observed element mid-observation: `blockSize` did not move,
 * while `getBoundingClientRect().height` grew from 64.8 to 96.1.
 *
 * Callbacks arrive after layout, coalesced to one per frame per element, and the first
 * call is asynchronous. That makes this the right tool for a *converging* operation
 * such as auto-size and the wrong tool for a synchronous read — see ADR 0004 §1.
 *
 * @returns A disposer. Measurement must never leak an observer, because an observer
 *   that outlives its element keeps a detached subtree alive and keeps firing.
 */
export function observeContentBox(
  element: HTMLElement,
  onChange: (size: PreciseSize) => void,
): () => void {
  if (typeof ResizeObserver === 'undefined') {
    // No observer means no fractional sizes. Not fatal: `contentBoxSize` still works,
    // and the integer path is what a synchronous caller uses anyway.
    return () => undefined;
  }

  const observer = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1];
    if (entry === undefined) return;

    const box = entry.contentBoxSize?.[0];
    // `contentBoxSize` is the array form; `contentRect` is the single form and is what
    // older engines expose. Both are fractional, unlike `clientWidth`/`clientHeight`.
    const width = box?.inlineSize ?? entry.contentRect.width;
    const height = box?.blockSize ?? entry.contentRect.height;
    onChange({ width, height });
  });

  observer.observe(element);
  return () => observer.disconnect();
}
