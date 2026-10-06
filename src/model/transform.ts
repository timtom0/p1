/**
 * Conversions between the model's `Transform2D` and 2D matrices.
 *
 * This module lives in `model/` rather than `core/geom/` so that `core` never
 * needs to know about model types (dependency rule: `model` → `core`, never the
 * reverse).
 */

import {
  applyPoint,
  invert,
  multiply,
  multiplyAll,
  rotation,
  scaling,
  translation,
} from '../core/geom/mat2d';
import type { Mat2D, Vec2 } from '../core/geom/mat2d';
import type { Rect } from '../core/geom/rect';
import type { PageSize, Transform2D } from './types';
import { toPx } from '../core/units/units';

/**
 * The rotation/scale part of the transform, with no translation. This is what
 * goes into the element's `transform` property, paired with
 * `transform-origin: 50% 50%`.
 *
 * R·S, i.e. scale is applied to the point before rotation — the same order CSS
 * uses for `transform: rotate(θ) scale(s)`. The distinction only matters for
 * non-uniform scale, but getting it wrong is invisible until then.
 */
export function localMatrix(transform: Transform2D): Mat2D {
  return multiply(rotation(transform.rotation), scaling(transform.scaleX, transform.scaleY));
}

/**
 * The full mapping from the node's local box — always `(0, 0, width, height)` —
 * into its parent's coordinate space.
 *
 * M = T(cx, cy) · R·S · T(-w/2, -h/2), with the rightmost factor applied first:
 * step out of the box relative to its centre, rotate/scale about the centre, then
 * move the centre into the parent's space.
 */
export function worldMatrix(transform: Transform2D): Mat2D {
  const { width, height } = transform;
  return multiplyAll(
    translation(transform.x + width / 2, transform.y + height / 2),
    localMatrix(transform),
    translation(-width / 2, -height / 2),
  );
}

/**
 * A node's map from its local box into **page** space, given its parent's world matrix.
 *
 * The composition step M12 needed and the one place it is spelled. `worldMatrix(transform)` is a
 * node's map into *its parent's* space — unchanged, because that is what `Transform2D` has always
 * meant (ADR 0011 §3) — and this is that map followed by the chain above it.
 *
 * Order is load-bearing and not interchangeable: the parent's map is the **left** factor, because
 * it applies last, to a point already expressed in page coordinates. Pre-multiplying a child's
 * transform into the chain instead would apply the group before the child and compose in the wrong
 * order — the same `R` commutes with `R` but not with `R·S·K` hazard ADR 0011 §6 is about.
 */
export function worldMatrixIn(transform: Transform2D, parentWorld: Mat2D): Mat2D {
  return multiply(parentWorld, worldMatrix(transform));
}

/**
 * Composes a node's transform with its parent's, **as a `Transform2D`**.
 *
 * ## The theorem, which is stronger than it first looks
 *
 * A **uniform** scale commutes with every rotation -- `S(s)·R(t) = R(t)·S(s)` -- and therefore
 * `R(t1)·S(a1,b1) · R(t2)·S(a2,b2) = R(t1+t2) · S(a1·a2, b1·b2)`.
 *
 * The composed linear part is therefore always `R(t)·S(sx, sy)`, so it is written back as a
 * `Transform2D` **exactly**: no decomposition, no `atan2`, no sign convention, and no question about
 * what a reflection means. Composition is algebra, not a matrix readout.
 *
 * That closed form only applies when the **left** factor's scale is uniform, and that is the whole
 * content of the group restriction. What it amounts to:
 *
 * > **A non-uniform scale may not be followed by a rotation.**
 *
 * | | scale | followed by a rotation? | expressible as `R(t)·S(sx,sy)`? |
 * |---|---|---|---|
 * | a **group** | must be uniform, by invariant | yes -- its children carry their own `R` | **no**, unless `scaleX === scaleY` |
 * | a **leaf** | may be non-uniform | no -- nothing is inside it | **yes**, it is already that form |
 *
 * So a leaf keeps its non-uniform scale and a group may not have one, which is a sharper statement of
 * M10b's refusal than "group scaling must be uniform". It is also why this function multiplies
 * `scaleX` and `scaleY` independently instead of forcing them equal: **forcing equality was a real
 * regression.** It silently discarded the `scaleY: 0.5` of every scaled leaf, and
 * `tests/visual/geometry.spec.ts`'s "non-uniform scale is applied about the centre" caught it by
 * measuring a painted height of 200 where 50 was authored. A browser test measuring a literal number
 * found what a model-level test would have called "correct".
 *
 * ## The translation
 *
 * `worldMatrix(t) = T(x + w/2, y + h/2) · L · T(-w/2, -h/2)`, so composing two gives a translation
 * of `c1 + L1·(c2 - h1)` -- the parent's frame centre plus the child's frame centre displaced from it
 * and mapped through the parent's linear part. The result's `x`/`y` is therefore the **page-space
 * position of the child's local `(0, 0)`**, which is exactly what the renderer writes as
 * `left`/`top`.
 *
 * Centres, not origins. A first draft wrote `child.x - child.width / 2`, which is the child's centre
 * relative to its own origin, and mixed the two conventions: it subtracted `width/2` a second time
 * and shifted every node left by its own width. It surfaced immediately in
 * `document-view.test.ts` -- `left` of `24px` became `-96px` for a 120-wide rect.
 *
 * `width`/`height` pass through: the composed frame is still *the child's own box*, just positioned
 * in a further-away space. That is the M11 contract (the local box is the frame) and depth does not
 * change it.
 *
 * ## What it does not protect against
 *
 * This function does **not** check that the chain satisfies the invariant, and a chain that does not
 * would compose into something `R·S` cannot hold -- silently, and wrongly. The guard is
 * `UNIFORM_SCALE_EPSILON` in `validateDocument`, which refuses such a document at load and in the
 * dev overlay; `model/group-scale.test.ts` pins both the composed result and the refusal. A function
 * that cannot tell it is being misused is a reason the invariant must be enforced where it is, not a
 * reason to widen this.
 */
export function worldTransformIn(child: Transform2D, parent: Transform2D): Transform2D {
  // Two different "centres of the parent", and conflating them was this function's second bug in a
  // row -- the first subtracted the child's half-width twice.
  //
  //   `parent`'s centre **in its own local coordinates** is `(width/2, height/2)`. This is the point
  //   the child's local position is measured *from*, because a child's `x`/`y` is group-local.
  //   `parent`'s centre **in page coordinates** is `(x + width/2, y + height/2)`. This is where that
  //   local origin ends up.
  //
  // Displacing by `(x + width/2)` for both shifts every child by its parent's position *twice*, and
  // it only looks plausible when the parent is at the origin -- which is exactly the shape of bug a
  // test built around one nested group would have missed. `model/tree.test.ts` pins the general case
  // against `multiply(parentWorld, worldMatrix(child))`, which cannot have this error.
  const childCentreX = child.x + child.width / 2;
  const childCentreY = child.y + child.height / 2;
  const parentLocalCentreX = parent.width / 2;
  const parentLocalCentreY = parent.height / 2;
  const parentCentreX = parent.x + parent.width / 2;
  const parentCentreY = parent.y + parent.height / 2;

  const dx = childCentreX - parentLocalCentreX;
  const dy = childCentreY - parentLocalCentreY;
  const cos = Math.cos(parent.rotation);
  const sin = Math.sin(parent.rotation);
  const centreX = parentCentreX + (dx * cos * parent.scaleX - dy * sin * parent.scaleY);
  const centreY = parentCentreY + (dx * sin * parent.scaleX + dy * cos * parent.scaleY);

  return {
    x: centreX - child.width / 2,
    y: centreY - child.height / 2,
    width: child.width,
    height: child.height,
    rotation: parent.rotation + child.rotation,
    scaleX: parent.scaleX * child.scaleX,
    scaleY: parent.scaleY * child.scaleY,
  };
}
/** Map a point from a node's local box space into its parent's space. */
export function localToParent(transform: Transform2D, p: Vec2): Vec2 {
  return applyPoint(worldMatrix(transform), p);
}

/** Map a point from a node's parent's space into its local box space. */
export function parentToLocal(transform: Transform2D, p: Vec2): Vec2 {
  return applyPoint(invert(worldMatrix(transform)), p);
}

/**
 * The node's **painted bounds**: the axis-aligned box that contains the transformed local box.
 *
 * This is the fourth of the quantities ADR 0011 §8 insists on naming separately, and the one the
 * codebase was missing. Four exist in some form:
 *
 * | quantity | what it is |
 * |---|---|
 * | **model frame** | `{x, y, width, height}` off the transform — the local box, untransformed |
 * | **painted bounds** | *this*: the AABB of the four transformed corners |
 * | **oriented bounds** | the transformed rectangle itself; only representable with a matrix |
 * | **hit-test region** | per kind, in the node's own space |
 *
 * For an unrotated, unscaled node the first two coincide, which is why the distinction went
 * unnoticed — and why M10b found the selection outline drawing a 140×100 box around an object that
 * paints 171.2 × 156.6 (ADR 0011 §8 F6).
 *
 * Four corners, not a closed form: under rotation the AABB is
 * `|w·cos t| + |h·sin t|` by `|w·sin t| + |h·cos t|`, which is already not what
 * `{x, y, width, height}` says, and there is no closed form that survives a shear (ADR 0011 §4).
 * The corner computation *is* the specification.
 *
 * **Never** derived from `getBoundingClientRect`. That is a paint-space measurement in CSS pixels:
 * it would be wrong under zoom, wrong across pages, and unavailable for an object that is not
 * mounted. Every consumer of this function works in document px.
 */
export function paintedBounds(transform: Transform2D): Rect {
  const matrix = worldMatrix(transform);
  const { width, height } = transform;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const corner of [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ]) {
    const p = applyPoint(matrix, corner);
    left = Math.min(left, p.x);
    top = Math.min(top, p.y);
    right = Math.max(right, p.x);
    bottom = Math.max(bottom, p.y);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The four corners of the **oriented bounds**, in parent space, clockwise from the model's top-left. */
export function transformedCorners(transform: Transform2D): [Vec2, Vec2, Vec2, Vec2] {
  const matrix = worldMatrix(transform);
  const { width, height } = transform;
  return [
    applyPoint(matrix, { x: 0, y: 0 }),
    applyPoint(matrix, { x: width, y: 0 }),
    applyPoint(matrix, { x: width, y: height }),
    applyPoint(matrix, { x: 0, y: height }),
  ];
}

/** Page size in CSS pixels, honouring orientation. */
export function pageSizeToPx(size: PageSize): { width: number; height: number } {
  const width = toPx(size.width, size.unit);
  const height = toPx(size.height, size.unit);
  return size.orientation === 'landscape' ? { width: height, height: width } : { width, height };
}