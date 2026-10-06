/**
 * The page ("paper") layer.
 *
 * The page element is the one place where CSS does work we would otherwise have
 * to implement ourselves: `overflow: hidden` clips all content to the page box,
 * which *is* page-level clipping. There is no clipper in this codebase.
 *
 * The page is also the zoom target — see `editor/viewport/viewport.ts`.
 */

import type { Document, Page } from '../../model/types';
import { pageSizeToPx } from '../../model/transform';
import { cssLength } from '../num';
import { paintToCss } from '../paint';

export function applyPageGeometry(pageElement: HTMLElement, doc: Document, page: Page): void {
  const size = pageSizeToPx(doc.pageSize);
  pageElement.style.width = cssLength(size.width);
  pageElement.style.height = cssLength(size.height);
  pageElement.style.backgroundColor = paintToCss(page.background);
}