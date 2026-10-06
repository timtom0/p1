/**
 * "No shear" as a predicate rather than as a paragraph.
 *
 * ADR 0005 fixes the model's transform as `x, y, width, height, rotation, scaleX, scaleY`, whose
 * linear part is `R(t) * S(sx, sy)`. Every consequence of that choice -- the M8 multi-object
 * resize limit, the M10 group-nesting limit -- reduces to the same question: *can this 2x2 be a
 * rotation times a diagonal scale?*
 *
 * That question is decidable, and the test is one line, which is worth having in `core` rather
 * than re-derived in each proof:
 *
 * - `R(t) * S(sx, sy)` has columns `sx * (cos t, sin t)` and `sy * (-sin t, cos t)`, and their dot
 *   product is `sx * sy * (cos t * -sin t + sin t * cos t) = 0`. So perpendicularity is necessary.
 * - Conversely, a 2x2 whose columns are perpendicular factors as a rotation times a diagonal
 *   scale: put `R = [c1/|c1| |c2/|c2|]` (orthonormal, so a rotation up to a reflection, which a
 *   negative `sy` absorbs) and `S = diag(|c1|, |c2|)`. So perpendicularity is sufficient.
 *
 * "Columns are perpendicular" is therefore not a convenient necessary condition. It **is** the
 * model's expressible set, which is what makes "this is a shear" a statement of fact rather than
 * a judgement call.
 *
 * ## Why this is not the constraint people assume
 *
 * CSS `matrix(a, b, c, d, e, f)` accepts any affine 2x2, shear included, so a renderer could paint
 * a matrix the model cannot store. Nothing here is about the DOM. The predicate exists because the
 * *model* is the narrow one, and every limit this codebase records follows from that rather than
 * from any rendering limit.
 */

import type { Mat2D } from './mat2d';

/** The two columns of a matrix's linear part. */
export function linearColumns(m: Mat2D): readonly [Vec2Like, Vec2Like] {
  return [
    { x: m.a, y: m.b },
    { x: m.c, y: m.d },
  ];
}

interface Vec2Like {
  x: number;
  y: number;
}

/**
 * How far the linear part is from a rotation times a scale: the dot product of its columns.
 *
 * Exactly zero for any matrix `Transform2D` can produce. Also a usable *magnitude* for a failure
 * message -- a shear of 0.5 reads as an obstruction, a shear of 1e-17 reads as rounding.
 */
export function shear(m: Mat2D): number {
  const [first, second] = linearColumns(m);
  return first.x * second.x + first.y * second.y;
}

/**
 * Tolerance for {@link shear}.
 *
 * Not arbitrary: a rotation is computed from floating-point trigonometry, so `sin` and `cos` of
 * the same angle leave residuals around 1e-16, and the column dot product inherits roughly the
 * square of that. 1e-12 is many orders of magnitude above the rounding noise and many orders below
 * the smallest shear any real gesture produces (`sin(0.1 rad)` is already 0.1).
 */
export const SHEAR_EPSILON = 1e-12;

/** Whether some `Transform2D` produces this linear part -- i.e. whether the model can hold it. */
export function isRotationTimesScale(m: Mat2D): boolean {
  return Math.abs(shear(m)) <= SHEAR_EPSILON;
}