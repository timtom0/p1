/**
 * The page ("paper") layer.
 *
 * The page element is the one place where CSS does work we would otherwise have
 * to implement ourselves: `overflow: hidden` clips all content to the page box,
 * which *is* page-level clipping. There is no clipper in this codebase.
 *
 * The page is also the zoom target — see `editor/viewport/viewport.ts`.
 */

import type { Page } from '../../model/types';
import { pageExtentOf } from '../../model/page';
import { cssLength } from '../num';
import { paintToCss } from '../paint';

/**
 * Sizes one page element from **its own** dimensions.
 *
 * The `doc` parameter is gone as of M20: the document used to own the size, so a renderer that read
 * `doc.pageSize` was correct by construction. Now it must be handed the page it is drawing, which is
 * the point — a mixed-size stack is drawn by the same loop that draws a uniform one, and there is no
 * argument through which one page could pick up another's size.
 */
export function applyPageGeometry(pageElement: HTMLElement, page: Page): void {
  const size = pageExtentOf(page);
  pageElement.style.width = cssLength(size.width);
  pageElement.style.height = cssLength(size.height);
  pageElement.style.backgroundColor = paintToCss(page.background);
}