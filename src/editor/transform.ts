/**
 * Interactive transform maths (§3.5): move, resize, rotate.
 *
 * The hard case is resize under rotation. The rule that makes it tractable:
 *
 *   Map the pointer into the node's **local, unrotated space**, resize the box
 *   there, then re-derive `x`/`y` so the anchor stays fixed in the *parent's* space.
 *
 * Resizing the parent's axis-aligned rect instead makes the opposite corner drift
 * as soon as rotation is non-zero, which is the bug this structure avoids.
 */

import { applyPoint, identity, invert, multiply, rotation, scaling } from '../core/geom/mat2d';
import type { Mat2D, Vec2 } from '../core/geom/mat2d';
import type { Rect } from '../core/geom/rect';
import type { GroupNode, Transform2D } from '../model/types';
import { worldMatrix, worldMatrixIn } from '../model/transform';

export type HandleDirection = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/**
 * Where each handle sits in the object's own local space, as a 0..1 fraction.
 *
 * `0.5` on an axis means that handle does not resize along that axis — the edge
 * handles (n, s, e, w) and the side handles (nw, sw) each leave one axis alone.
 */
export const HANDLE_UNITS: Record<HandleDirection, Vec2> = {
  nw: { x: 0, y: 0 },
  n: { x: 0.5, y: 0 },
  ne: { x: 1, y: 0 },
  e: { x: 1, y: 0.5 },
  se: { x: 1, y: 1 },
  s: { x: 0.5, y: 1 },
  sw: { x: 0, y: 1 },
  w: { x: 0, y: 0.5 },
};

export interface ResizeOptions {
  /** Preserve the aspect ratio. */
  keepAspect?: boolean;
  /** Resize about the centre rather than the opposite edge. */
  fromCenter?: boolean;
  /** Minimum extent in document px, so an object cannot be inverted away. */
  minSize?: number;
}

const DEFAULT_MIN_SIZE = 1;

/** Which edges a handle moves. */
export function edgesFor(handle: HandleDirection): {
  left: boolean;
  right: boolean;
  top: boolean;
  bottom: boolean;
} {
  const unit = HANDLE_UNITS[handle];
  return {
    left: unit.x === 0,
    right: unit.x === 1,
    top: unit.y === 0,
    bottom: unit.y === 1,
  };
}

/**
 * Which fraction of the box each handle *leaves fixed*, per axis.
 *
 * `0.5` on an axis means neither edge moves — that is the middle of the edge
 * handles (`n`, `s`, `e`, `w`). This is the anchor, expressed as a unit position
 * rather than as an edge pair, because an edge pair cannot express "the middle".
 */
const ANCHOR_UNITS: Record<HandleDirection, Vec2> = {
  nw: { x: 1, y: 1 },
  n: { x: 0.5, y: 1 },
  ne: { x: 0, y: 1 },
  e: { x: 0, y: 0.5 },
  se: { x: 0, y: 0 },
  s: { x: 0.5, y: 0 },
  sw: { x: 1, y: 0 },
  w: { x: 1, y: 0.5 },
};

/**
 * Resizes `transform` by dragging `handle` until it reaches `pointerParent`.
 *
 * Both arguments are in the **parent's** space. The result has a new size, and a new
 * origin chosen so the anchor does not move.
 *
 * ## Why the anchor is expressed twice
 *
 * The anchor has to be named once in the *old* box's local coordinates, to ask the
 * old matrix where it currently is in parent space, and once in the *new* box's local
 * coordinates, to work out where the new origin must be. Reusing one set of numbers
 * for both is the subtle mistake here: when the left edge is dragged, the right edge
 * is at `w` before the resize and at `newW` after it, and treating those as the same
 * point moves the anchor.
 */
export function resizeTransform(
  transform: Transform2D,
  handle: HandleDirection,
  pointerParent: Vec2,
  options: ResizeOptions = {},
): Transform2D {
  const minSize = options.minSize ?? DEFAULT_MIN_SIZE;
  const { width: w, height: h } = transform;

  // Work in the object's own unrotated space, where the box is (0, 0, w, h).
  const local = applyPoint(invert(worldMatrix(transform)), pointerParent);

  const driven = HANDLE_UNITS[handle];
  const anchorUnit = ANCHOR_UNITS[handle];
  const centre = options.fromCenter === true;

  // ---- new size ------------------------------------------------------------
  let width = w;
  if (driven.x === 1) width = centre ? (local.x - w / 2) * 2 : local.x;
  else if (driven.x === 0) width = centre ? (w - local.x) * 2 : w - local.x;

  let height = h;
  if (driven.y === 1) height = centre ? (local.y - h / 2) * 2 : local.y;
  else if (driven.y === 0) height = centre ? (h - local.y) * 2 : h - local.y;

  // Dragging past the anchor would invert the box; clamp to a usable size.
  width = Math.max(minSize, width);
  height = Math.max(minSize, height);

  if (options.keepAspect === true && w > 0 && h > 0) {
    // The axis the handle owns wins, and the other one follows it. For an edge
    // handle only one axis is driven, so that is necessarily the winner; for a
    // corner, the one that moved further.
    const widthDriven = driven.x !== 0.5;
    const heightDriven = driven.y !== 0.5;
    const aspect = w / h;
    const widthLeads = width / height > aspect;

    if (widthDriven && !heightDriven) height = width / aspect;
    else if (heightDriven && !widthDriven) width = height * aspect;
    else if (widthLeads === widthDriven) height = width / aspect;
    else width = height * aspect;
  }

  // ---- new origin ----------------------------------------------------------
  // `fromCenter` moves the anchor to the middle of the driven axes.
  const anchorOld: Vec2 = {
    x: (centre && driven.x !== 0.5 ? 0.5 : anchorUnit.x) * w,
    y: (centre && driven.y !== 0.5 ? 0.5 : anchorUnit.y) * h,
  };
  const anchorNew: Vec2 = {
    x: (centre && driven.x !== 0.5 ? 0.5 : anchorUnit.x) * width,
    y: (centre && driven.y !== 0.5 ? 0.5 : anchorUnit.y) * height,
  };

  const anchorParent = applyPoint(worldMatrix(transform), anchorOld);
  // `rotation` then `scaling`, matching `localMatrix`. The order matters as soon as
  // scale is non-uniform, and matching the renderer's own order is what keeps this
  // consistent with what is on screen.
  const linear = multiply(rotation(transform.rotation), scaling(transform.scaleX, transform.scaleY));
  const offset = applyPoint(linear, {
    x: anchorNew.x - width / 2,
    y: anchorNew.y - height / 2,
  });

  return {
    ...transform,
    x: anchorParent.x - offset.x - width / 2,
    y: anchorParent.y - offset.y - height / 2,
    width,
    height,
  };
}

/** Translates a transform by a delta in the parent's space. */
export function moveTransform(transform: Transform2D, deltaParent: Vec2): Transform2D {
  return { ...transform, x: transform.x + deltaParent.x, y: transform.y + deltaParent.y };
}

/**
 * Composes a node's **parent** world matrix from its ancestor chain, outermost first.
 *
 * Identity for a node whose parent is the page, which is the depth-0 case every top-level object
 * lives in. The chain is composed with `worldMatrixIn`, which is the one established composition
 * order in the codebase (ADR 0011 §6) -- the parent's map is the left factor. Writing this as a
 * separate accumulation would be exactly the second transform system ADR 0011b §2 warns against.
 */
function parentWorldMatrix(ancestors: readonly GroupNode[]): Mat2D {
  let world = identity();
  for (const ancestor of ancestors) {
    world = worldMatrixIn(ancestor.transform, world);
  }
  return world;
}

/**
 * Converts a **page-space** translation into the **parent-local** translation that produces it.
 *
 * ## Why this exists
 *
 * `Transform2D.x/y` are the node's position *in its parent's space*, but every user-facing gesture
 * and every alignment operation is expressed in page space -- the space the pointer, the painted
 * bounds and the selection outline all live in. Adding a page-space delta straight onto `x/y` is
 * only correct when the parent is the page, i.e. at depth 0, where the parent matrix is the
 * identity. One level down it is wrong: a child of a group rotated by `t` asked to move `d` page
 * pixels along x moves `d·cos t` along page x instead, drifting off at an angle.
 *
 * Measured, before this helper existed: a child of a group rotated 45°, asked for `+40` page px,
 * moved its painted bounds by **28.2843** -- exactly `40·cos 45°`.
 *
 * ## Why the inverse rather than a hand-rolled `R(-t)/s`
 *
 * The chain is already composed by {@link parentWorldMatrix} and inverted by `invert`, both of which
 * are the primitives the rest of the renderer uses. Spelling the inverse out by hand would be a
 * second derivation of the same algebra, free to disagree with `worldMatrix` about composition
 * order -- the single defect ADR 0011b §2 calls "the worst possible arrangement".
 *
 * A translation is applied to two points and subtracted rather than to the origin, because
 * `applyPoint` is the affine form and the difference of two affine images of two points differing by
 * `deltaPage` is exactly the local vector that maps to it.
 */
export function pageDeltaToParentDelta(
  ancestors: readonly GroupNode[],
  deltaPage: Vec2,
): Vec2 {
  if (ancestors.length === 0) return deltaPage;
  const inverse = invert(parentWorldMatrix(ancestors));
  const from = applyPoint(inverse, { x: 0, y: 0 });
  const to = applyPoint(inverse, deltaPage);
  return { x: to.x - from.x, y: to.y - from.y };
}

/**
 * Rotates by `angle` about a pivot given in the **parent's** space.
 *
 * Solved on the centre rather than on the origin. Rotating an origin-based
 * transform means the origin travels along an arc as the angle changes, so "keep the
 * pivot fixed" turns into a trigonometry problem; the centre-based form
 *
 *     C' = pivot + R(Δ)·(C − pivot)
 *
 * is one line and obviously correct, because rotating about a point is what that
 * expression *is*. Scale is absent from it deliberately: scaling about the centre
 * does not move the centre, so including `scale` here would be wrong, not merely
 * redundant.
 */
export function rotateTransform(
  transform: Transform2D,
  angle: number,
  pivotParent: Vec2,
): Transform2D {
  const delta = angle - transform.rotation;
  const centre = {
    x: transform.x + transform.width / 2,
    y: transform.y + transform.height / 2,
  };
  const offset = applyPoint(rotation(delta), {
    x: centre.x - pivotParent.x,
    y: centre.y - pivotParent.y,
  });

  return {
    ...transform,
    rotation: angle,
    x: pivotParent.x + offset.x - transform.width / 2,
    y: pivotParent.y + offset.y - transform.height / 2,
  };
}
/** Snaps an angle to a multiple of `step`, e.g. 15° for shift-drag. */
export function snapAngle(angle: number, step = Math.PI / 12): number {
  return Math.round(angle / step) * step;
}

/**
 * The axis-aligned union of several objects' **model frames**.
 *
 * ## The name is the contract
 *
 * This returns `{x, y, width, height}` straight off each transform: the local box, untransformed.
 * It is **not** the painted bounds, and for a rotated object the two disagree — a 200×50 box at 30°
 * has a frame of 200 × 50 and paints 223.2 × 143.3. It is **not** an interaction frame either,
 * because it is the union of *frames* rather than of shapes: two rotated members contribute their
 * unrotated boxes, so the result can cover a region containing none of the artwork and can miss
 * parts of it.
 *
 * It was called `selectionRect`, which is precisely the ambiguity ADR 0011 §8 objected to: a caller
 * could not tell from the name whether it was being handed what the user sees. Renamed rather than
 * documented, because a comment is read once and a name is read at every call site.
 *
 * **What a future caller almost certainly wants instead** is
 * `paintedBoundsUnion` from `model/transform` — the union of the members' painted bounds. That is
 * the quantity an aggregate selection frame would be built from, when M12 decides whether to have
 * one. M8 deliberately has none (ADR 0008 §7), and M11 keeps that decision.
 *
 * What this *is* still used for: the rotation pivot, which is a property of the model frame and is
 * correct by construction — `R` about the frame's centre is a fixed point, so the centre does not
 * move under the object's own rotation (ADR 0011 §8).
 */
export function modelFrameUnion(transforms: readonly Transform2D[]): Rect | null {
  if (transforms.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const t of transforms) {
    left = Math.min(left, t.x);
    top = Math.min(top, t.y);
    right = Math.max(right, t.x + t.width);
    bottom = Math.max(bottom, t.y + t.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The centre of a **model frame**. A pivot, not a visual centre. */
export function selectionCentre(rect: Rect): Vec2 {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** Scales every transform about a pivot, for scale gestures. */
export function scaleTransforms(
  transforms: readonly Transform2D[],
  pivot: Vec2,
  factor: Vec2,
): Transform2D[] {
  return transforms.map((transform) => ({
    ...transform,
    x: (transform.x - pivot.x) * factor.x + pivot.x,
    y: (transform.y - pivot.y) * factor.y + pivot.y,
    width: Math.max(DEFAULT_MIN_SIZE, transform.width * factor.x),
    height: Math.max(DEFAULT_MIN_SIZE, transform.height * factor.y),
  }));
}

/** The angle from `origin` to `point`, in radians. */
export function angleTo(origin: Vec2, point: Vec2): number {
  return Math.atan2(point.y - origin.y, point.x - origin.x);
}