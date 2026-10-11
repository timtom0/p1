/**
 * Page stack geometry (pure model-side arithmetic, no DOM).
 *
 * The vertical arrangement of pages is a *view* concern, not a document concern:
 * `pageGap` lives in viewport state (§3.7), never in the model. What the model
 * knows is each page's own size and how many pages there are, which is enough to
 * derive the stack's extent.
 *
 * ## Why every function here takes the sizes rather than the document
 *
 * Before M20 a page's size was `Document.pageSize`, so `pageOffsetY(index, count, height, gap)` could
 * multiply. Sizes are per-page now, so a stack of n pages has n different heights and a page's top
 * offset is a **running sum**, not a product. Passing the document in would be more convenient at the
 * call site and would also drag the rest of the document into a file that is currently four pure
 * functions — and these are the functions the viewport's own tests exercise directly, with arrays
 * rather than a fixture document. So they take what they need and nothing else.
 */

import type { Document, Page, PageSize } from './types';
import { pageSizeToPx } from './transform';

export interface Size {
  width: number;
  height: number;
}

/** The page box in document px, honouring orientation. */
export function pageExtentPx(pageSize: PageSize): Size {
  return pageSizeToPx(pageSize);
}

/** The extent of one page, in document px. */
export function pageExtentOf(page: Page): Size {
  return pageExtentPx(page.size);
}

/**
 * Every page's extent in document px, in document order.
 *
 * The one place that reads `page.size`, so a caller never has to remember to.
 */
export function pageExtents(pages: readonly Page[]): Size[] {
  return pages.map(pageExtentOf);
}

/**
 * Top offset of a page within the stack, in document px.
 *
 * `index` is clamped to the stack so callers can pass a stale index without producing a position past
 * the end of the document — a selection that still refers to a page deleted two edits ago.
 *
 * A running sum of the heights before it, plus the gaps before it. With uniform pages this reduces
 * to `index × (height + gap)`, which is what it was before M20, so a single-page document and a
 * uniform multi-page document land on exactly the same numbers as before.
 */
export function pageOffsetY(index: number, heights: readonly number[], gap: number): number {
  const count = heights.length;
  if (count === 0) return 0;
  const clamped = Math.min(Math.max(index, 0), count - 1);
  let offset = 0;
  for (let i = 0; i < clamped; i++) offset += (heights[i] ?? 0) + gap;
  return offset;
}

/**
 * The CSS named-page a page element must reference to print at its own sheet size.
 *
 * **CSS named pages are the only mechanism that varies sheet size per page.** A bare `@page { size }`
 * rule applies to every sheet, so a mixed-size document printed against one rule gives every page the
 * first page's paper -- the failure M20 exists to prevent. Declaring one named `@page` rule per sheet
 * and pointing each element at its own name is what makes a mixed document print correctly.
 *
 * It lives in the model rather than beside either of its two users -- `render/layers/page.ts`, which
 * writes it onto the element, and `ui/print-profile.ts`, which declares the matching rules -- because
 * the layer rules put `model` below both and nothing else below both. An earlier draft put it in
 * `render` and had `ui` import it, which the linter correctly refused as a boundary violation.
 *
 * Two independent spellings of `p${n}` would desynchronise silently: the element would reference a
 * rule that was never declared, and the document would print at the fallback size with no error
 * anywhere. Hence one function, here, imported by both.
 *
 * Keyed by **index**, not page id, because both sides number by index -- so reordering pages renames
 * the rules and the references together, and they cannot disagree.
 */
export function printPageName(index: number): string {
  return `p${index}`;
}

/**
 * Total extent of the page stack in document px.
 *
 * The gap sits *between* pages, so n pages have n−1 gaps. A single-page document therefore has exactly
 * the page's own extent, which keeps the M0 case unchanged.
 *
 * Width is the **widest** page, not the first: the stack is a column, so a single wide page in an
 * otherwise narrow document must not clip its neighbours.
 */
export function pageStackExtent(heights: readonly number[], widths: readonly number[], gap: number): Size {
  const count = heights.length;
  if (count === 0) return { width: 0, height: 0 };
  let height = 0;
  let width = 0;
  for (let i = 0; i < count; i++) {
    height += heights[i] ?? 0;
    const w = widths[i] ?? 0;
    if (w > width) width = w;
  }
  return { width, height: height + (count - 1) * gap };
}

/** `pageStackExtent` for a document. The convenience form every caller actually wants. */
export function documentStackExtent(doc: Document, gap: number): Size {
  const extents = pageExtents(doc.pages);
  return pageStackExtent(
    extents.map((e) => e.height),
    extents.map((e) => e.width),
    gap,
  );
}

/**
 * Index of the page containing a document-stack y offset, or `null` if it falls in a gap or past the end.
 *
 * A walk rather than a division, for the same reason {@link pageOffsetY} sums. Returning `null` for a
 * gap is load-bearing: a click in the space between two differently sized pages is not "the nearer
 * page", and callers already handle `null` by refusing the hit.
 */
export function pageIndexAt(y: number, heights: readonly number[], gap: number): number | null {
  if (heights.length === 0 || y < 0) return null;
  let cursor = 0;
  for (let i = 0; i < heights.length; i++) {
    const height = heights[i] ?? 0;
    if (y >= cursor && y < cursor + height) return i;
    cursor += height + gap;
  }
  return null;
}