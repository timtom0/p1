/**
 * What happens to a page's objects when the page is resized.
 *
 * `PageResizeBehaviour` in `page-setup.ts` names the three options; this file is where they mean
 * something. Each is defined here **before** it is implemented, because the obvious implementations of
 * two of them are wrong in ways that only show up later.
 *
 * ## `crop` -- change the paper, move nothing
 *
 * The page's `size` changes and nothing else does. Content keeps its document coordinates, so anything
 * now outside the page box is outside it; the page element's `overflow: hidden` clips it.
 *
 * The default, and the only option that cannot lose anything.
 *
 * ## `scale` -- scale the content uniformly about the page origin
 *
 * Ratio `r = min(newWidth / oldWidth, newHeight / oldHeight)`, so the content that fit before still
 * fits, on the axis that is the binding constraint.
 *
 * **`min`, not a per-axis ratio.** Scaling width and height independently would fit the content
 * exactly on both axes, and would also *shear* every rotated object and every child of a rotated group.
 * ADR 0011 §2 proves a non-uniform scale on a rotated child is not representable in this model at all.
 * So the ratio is uniform and the result has margins on the looser axis, which is the correct trade:
 * distortion is unrepresentable, margins are not.
 *
 * **Only top-level objects are visited, and that is exact rather than a shortcut.** A child's world
 * transform is `W(group) · W(child)`, so scaling the group's own box by `r` scales the entire subtree
 * by `r` with no arithmetic on the children at all. Walking into a group and scaling its children too
 * would scale them twice.
 *
 * **Typography is not scaled**, and that is a real limitation rather than an oversight. `style.fontSize`
 * is an authored value (ADR 0003), so scaling it would silently rewrite something the user typed, and a
 * frame whose box grew while its type size did not re-wraps differently rather than scaling. `src/model/page-resize.test.ts`
 * pins the behaviour so a later change has to decide about it deliberately.
 *
 * ## `push` -- move what no longer fits to the next page
 *
 * An object whose world bounds are not contained in the new page box moves to the following page,
 * keeping its page-local coordinates. If the resized page is the last one, a page is created after it.
 *
 * **One hop, deliberately.** Cascading — pushing, then re-checking the destination and pushing again —
 * is what a print-production tool does, but it makes a single "resize" command edit an unbounded number
 * of pages, and the size of that edit would depend on how much happened to overflow. One hop is
 * predictable: the command changes at most two pages, and the user can push again if that is what they
 * wanted.
 *
 * Bounds are the **world** bounds of top-level objects, so a group is judged by where it actually
 * paints rather than by its frame alone, and a group's children travel with it.
 */

import { createId } from '../core/ids';
import type { Rect } from '../core/geom/rect';
import { paintedBounds, pageSizeToPx as pageExtentPx } from './transform';
import type { Node, Page, PageSize } from './types';
import { isGroup } from './tree';

/**
 * The uniform factor that fits content authored for `from` into `to`.
 *
 * `min` of the two ratios, so both axes shrink by the same amount and the content that fitted still
 * fits. See the module comment for why this is not per-axis.
 */
export function resizeRatio(from: { width: number; height: number }, to: { width: number; height: number }): number {
  if (from.width <= 0 || from.height <= 0) return 1;
  const byWidth = to.width / from.width;
  const byHeight = to.height / from.height;
  const ratio = Math.min(byWidth, byHeight);
  // A ratio of exactly 0 or a negative cannot happen for validated sizes, but a defensive `> 0`
  // keeps a division-by-zero from turning into `NaN` transforms that render as nothing.
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

/**
 * Scales a node's transform box by `ratio` about the page origin.
 *
 * **Why only `x`, `y`, `width` and `height` change, and not `scaleX`/`scaleY`.** This is the part that
 * looks wrong and is not. `Transform2D`'s world matrix is
 *
 * ```text
 * T(x + w/2, y + h/2) · R(rotation) · S(scaleX, scaleY) · T(-w/2, -h/2)
 * ```
 *
 * and scaling the rendered result by `r` means composing `S(r)` on the left. Working that through, the
 * terms of the rotation cancel against each other and the product is identical to the matrix of
 * `Transform2D { x: r·x, y: r·y, width: r·w, height: r·h }` with `rotation`, `scaleX` and `scaleY`
 * unchanged. Scaling the *scale factors* as well would be scaling twice.
 */
export function scaleTransform(
  transform: { x: number; y: number; width: number; height: number; rotation: number; scaleX: number; scaleY: number },
  ratio: number,
): typeof transform {
  return {
    ...transform,
    x: transform.x * ratio,
    y: transform.y * ratio,
    width: transform.width * ratio,
    height: transform.height * ratio,
  };
}

/** `scale`, applied to a page's top-level objects. See the module comment for why not recursively. */
export function scalePageObjects(objects: readonly Node[], ratio: number): Node[] {
  if (ratio === 1) return objects as Node[];
  return objects.map((node) => ({ ...node, transform: scaleTransform(node.transform, ratio) }));
}

function containedIn(rect: Rect, width: number, height: number): boolean {
  return rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= width && rect.y + rect.height <= height;
}

/**
 * Splits a page's objects into those that still fit the new box and those that no longer do.
 *
 * **Iterates `page.objects` directly rather than `placementsOnPage`.** That helper returns *leaves
 * only* -- groups are flattened away, which is right for painting and wrong here: a group is exactly
 * the thing most likely to straddle a page edge, and it would never appear in the list to be judged.
 * The first draft used it and a group straddling the edge was simply not moved.
 *
 * A top-level node's world transform **is** its own transform -- its parent is the page, so the
 * composition starts from the identity -- which is why `paintedBounds(node.transform)` is already
 * page-local and no matrix walk is needed.
 *
 * So a group's decision is made on where its whole frame paints, and its children travel with it as
 * one unit. That is the right granularity: splitting a group because one child pokes out would break
 * it apart, and the resize policy is about moving objects between pages, not about splitting them.
 */
export function partitionByOverflow(page: Page, size: PageSize): { fits: Node[]; overflows: Node[] } {
  const target = pageExtentPx(size);
  const fits: Node[] = [];
  const overflows: Node[] = [];
  for (const node of page.objects) {
    const bounds = paintedBounds(node.transform);
    (containedIn(bounds, target.width, target.height) ? fits : overflows).push(node);
  }
  return { fits, overflows };
}

/**
 * Gives every node in a subtree a fresh id, returning the new subtree and the old→new mapping.
 *
 * **Recursive, and it has to be.** Copying a page and leaving its descendants with the originals' ids
 * would put two nodes in one document claiming the same identity -- the exact collision
 * `assertDocumentIsConsistent` refuses on load and `mapNodesById` would silently resolve to whichever
 * it visits first, so editing the duplicate would edit the original.
 *
 * The prefix follows the node's own kind, so a duplicated group is still `group_n` and a duplicated
 * shape is still `node_n`, matching what `createGroupNode` and `createRectNode` would have produced.
 */
export function remapNodeIds(node: Node): { node: Node; map: ReadonlyMap<string, string> } {
  const map = new Map<string, string>();
  const walk = (input: Node): Node => {
    const id = createId(input.type === 'group' ? 'group' : 'node');
    map.set(input.id, id);
    if (isGroup(input)) {
      return { ...input, id, children: input.children.map(walk) };
    }
    return { ...input, id };
  };
  return { node: walk(node), map };
}