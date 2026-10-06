/**
 * Page stack geometry (pure model-side arithmetic, no DOM).
 *
 * The vertical arrangement of pages is a *view* concern, not a document concern:
 * `pageGap` lives in viewport state (§3.7), never in the model. What the model
 * knows is the page size and how many pages there are, which is enough to derive
 * the stack's extent.
 */

import type { Document, PageSize } from './types';
import { pageSizeToPx } from './transform';

export interface Size {
  width: number;
  height: number;
}

/** The page box in document px, honouring orientation. */
export function pageExtentPx(pageSize: PageSize): Size {
  return pageSizeToPx(pageSize);
}

/**
 * Top offset of a page within the stack, in document px.
 *
 * `index` is clamped to the stack so callers can pass a stale index without
 * producing a position past the end of the document.
 */
export function pageOffsetY(index: number, pageCount: number, pageHeight: number, gap: number): number {
  const last = Math.max(0, pageCount - 1);
  const clamped = Math.min(Math.max(index, 0), last);
  return clamped * (pageHeight + gap);
}

/**
 * Total extent of the page stack in document px.
 *
 * The gap sits *between* pages, so n pages have n−1 gaps. A single-page
 * document therefore has exactly the page's own extent, which keeps the M0 case
 * unchanged.
 */
export function pageStackExtent(doc: Document, gap: number): Size {
  const page = pageExtentPx(doc.pageSize);
  const count = doc.pages.length;
  if (count === 0) return { width: 0, height: 0 };
  return {
    width: page.width,
    height: count * page.height + (count - 1) * gap,
  };
}

/** Index of the page containing a document-stack y offset, or null if past the end. */
export function pageIndexAt(y: number, pageCount: number, pageHeight: number, gap: number): number | null {
  if (pageCount === 0 || y < 0) return null;
  const stride = pageHeight + gap;
  const index = Math.floor(y / stride);
  if (index >= pageCount) return null;
  return index;
}