/**
 * The affine question, made into arithmetic.
 *
 * M10 established that page-local grouping is free and group-local grouping needs "a shear",
 * and deferred the decision to M10b. This module is the specification side of that question: it
 * defines the *candidate* affine model precisely enough to be argued about, and it is imported by
 * tests only. Nothing in `src/` outside a `*.test.ts` reads it, the build tree-shakes it, and it
 * must stay that way until ADR 0011 says otherwise — the milestone rule is that production geometry
 * is not touched before the decision is proven.
 *
 * ## The shape of the answer, before any of it
 *
 * The current transform's linear part is `R(t) · S(sx, sy)`: three parameters. A general 2×2 has
 * four. So
 *
 * > **The current model is a codimension-1 subset of `GL(2)`.** "No shear" is not a separate
 * > geometry system; it is one equation — `a·c + b·d = 0`, the perpendicularity condition of
 * > `linear-part.ts` — and general affine is what you get by dropping it.
 *
 * That reframes the whole decision, so it is proved first (`affine.test.ts`). What follows is the
 * *representational* question: if the extra dimension is added, how is it written down, and does
 * "rotation" survive.
 *
 * ## Why `R(t) · S(sx, sy) · K(kx)` and not a 2×3 matrix
 *
 * A 2×3 matrix is the general answer and is rejected in `affine.test.ts` for two reasons that are
 * both about *legibility*, not mathematics:
 *
 * 1. `docs/ARCHITECTURE.md` §1.3 states why the current form was chosen: "human-readable in the
 *    file, directly editable in the inspector". Six opaque floats fail the second half of that,
 *    and `docs/ARCHITECTURE.md` §1.3's claim that this form "composes predictably down a group
 *    tree" is the statement M10 proved false — so it is being corrected anyway, but the legibility
 *    half stands and nothing has superseded it.
 * 2. A matrix has many equivalent spellings (`R(t)·S(k,k)` and `R(t+pi)·S(-k,-k)` are the same
 *    matrix), so it needs a canonicalisation rule before `documentsEqual` and the byte-stable
 *    round trip of ADR 0007 can work. A parameterised form is canonical *by construction*, because
 *    the parameters are what is stored.
 *
 * `R · S · K` with `K = [[1, kx], [0, 1]]` is the standard QR parameterisation with the sign
 * convention fixed, and it happens to be CSS's own order — `rotate() scale() skewX()` — so the
 * renderer needs no new vocabulary.
 */

import { multiply, rotation, scaling } from './mat2d';
import type { Mat2D } from './mat2d';
import { SHEAR_EPSILON } from './linear-part';

// ---------------------------------------------------------------------------
// The candidate parameterisation
// ---------------------------------------------------------------------------

/**
 * The candidate's parameters: today's three, plus one.
 *
 * `skewX` matches CSS's `skewX()`, and is expressed in the object's own axes rather than the
 * page's — which is why it belongs after `S` rather than before `R`. Shear in the page frame is
 * `S · R · K`, a different parameterisation with the same span; the local one is chosen because it
 * is the one a user can picture and a file can hold.
 */
export interface RskParameters {
  rotation: number;
  scaleX: number;
  scaleY: number;
  skewX: number;
}

/**
 * `R(t) · S(sx, sy) · K(kx)` — the linear part.
 *
 * With `K = [[1, kx], [0, 1]]` this is
 *
 * ```
 * | sx·c          sx·kx·c - sy·s |
 * | sx·s          sx·kx·s + sy·c |
 * ```
 *
 * Note the two columns: the first is `sx · (cos t, sin t)`, so **the first column alone determines
 * `t` and `sx`**, and the second then determines `kx` and `sy`. That is what makes the
 * decomposition recoverable, and it is the reason `skewX` goes after `S`: it is the one parameter
 * that does not touch the first column.
 */
/**
 * The skew factor `K = [[1, kx], [0, 1]]` -- CSS''s `skewX()`.
 *
 * `Mat2D` stores `[[a, c], [b, d]]`, so the upper-triangular off-diagonal is **`c`**, not `b`. That
 * is not a detail: putting `kx` in `b` gives the *lower*-triangular `[[1, 0], [kx, 1]]`, which tilts
 * the first column and so destroys the one property the decomposition depends on. The first draft
 * of this module did exactly that, and `decomposeRSK` then reported 0.2914 radians for an object
 * authored at 0. "Which cell is it" is the entire content of a 2x2.
 */
function skew(kx: number): Mat2D {
  return { a: 1, b: 0, c: kx, d: 1, e: 0, f: 0 };
}

/**
 * `R(t) · S(sx, sy) · K(kx)` -- the linear part.
 *
 * With `K = [[1, kx], [0, 1]]` this is
 *
 * ```
 * | sx·c          sx·kx·c - sy·s |
 * | sx·s          sx·kx·s + sy·c |
 * ```
 *
 * Note the two columns: the first is `sx · (cos t, sin t)`, so **the first column alone determines
 * `t` and `sx`**, and the second then determines `kx` and `sy`. That is what makes the
 * decomposition recoverable, and it is the reason `skewX` goes after `S`: it is the one parameter
 * that does not touch the first column.
 */
export function composeRSK(p: RskParameters): Mat2D {
  return multiply(rotation(p.rotation), multiply(scaling(p.scaleX, p.scaleY), skew(p.skewX)));
}

export interface RskDecomposition extends RskParameters {
  /**
   * `true` when the matrix mirrors, i.e. `scaleY < 0`.
   *
   * There is deliberately **no "canonical" flag**, because the decomposition does not need one.
   * Requiring `scaleX > 0` removes the only sign ambiguity -- the joint flip
   * `(t, sx) -> (t + pi, -sx)` -- and the remaining parameters follow from the second column,
   * *including* when that column puts `scaleY` below zero. `decomposeRSK` is therefore a bijection
   * onto all of `GL(2)`, reflections included.
   *
   * An earlier draft claimed the decomposition was non-canonical for reflections. It was conflating
   * two different questions: whether the parameters are *unique* (yes, always) and whether a
   * *rotation* exists for the matrix (no -- see {@link polarRotation}). Both matter, and they are
   * answered separately.
   */
  reflects: boolean;
}

/**
 * Recovers `(t, sx, sy, kx)` from any invertible 2×2.
 *
 * The reconstruction is forced, not chosen:
 *
 * - the first column of `R·S·K` is `sx·(cos t, sin t)`, so `t` is the angle of that column and
 *   `sx` is its length. Taking that length positive fixes the joint sign flip, which is the *only*
 *   place this parameterisation is ambiguous.
 * - rotating the second column by `-t` gives `(sx·kx, sy)`, hence `kx` and `sy`.
 *
 * Returns `null` for a singular matrix, where no decomposition exists -- the same case
 * `invariants.ts` already refuses at the model boundary.
 */
export function decomposeRSK(m: Mat2D): RskDecomposition | null {
  const sx = Math.hypot(m.a, m.b);
  if (sx <= SHEAR_EPSILON || Math.abs(determinantOf(m)) <= SHEAR_EPSILON) return null;

  const t = Math.atan2(m.b, m.a);
  const c = Math.cos(t);
  const s = Math.sin(t);
  // The second column expressed in the frame the first column defines: R(-t) · col2.
  const along = m.c * c + m.d * s;
  const across = -m.c * s + m.d * c;
  return {
    rotation: t,
    scaleX: sx,
    scaleY: across,
    skewX: along / sx,
    reflects: across < 0,
  };
}

// ---------------------------------------------------------------------------
// Is "rotation" still a thing?
// ---------------------------------------------------------------------------

/**
 * The polar rotation: the unique `t` with `M = R(t) · S` and `S` symmetric.
 *
 * For `M = R(t)·S(sx, sy)` the formula `atan2(b - c, a + d)` reduces to
 * `atan2((sx + sy)·sin t, (sx + sy)·cos t)`, which is `t` when `sx + sy > 0` and **`t + pi` when
 * `sx + sy < 0`**. So even for matrices the model already stores, "the rotation" has two answers
 * unless a branch is chosen.
 *
 * Returns `null` when there is no answer to give: a singular matrix, or one with negative
 * determinant, whose polar factor is a *reflection* and therefore not a rotation at all.
 */
export function polarRotation(m: Mat2D): number | null {
  const determinant = m.a * m.d - m.b * m.c;
  if (Math.abs(determinant) <= SHEAR_EPSILON) return null;
  if (determinant < 0) return null;
  return Math.atan2(m.b - m.c, m.a + m.d);
}

/**
 * What the inspector would report today: the angle of the first column.
 *
 * Included because it is the *implicit* definition in use. It is exact for `R(t)·S` and **silently
 * wrong for anything else** — under a shear the first column is not the image of the x-axis under
 * a rotation times a scale, so its angle is not a rotation of anything. Nothing in the current code
 * reads it, which is lucky rather than principled: a file that carries `scaleX = -1` already
 * disagrees with it.
 */
export function columnAngle(m: Mat2D): number {
  return Math.atan2(m.b, m.a);
}

/**
 * How far apart two candidate rotations for the same matrix are, in radians.
 *
 * For tests that need to say "these are the same angle" without tripping over the `2·pi` wrap or
 * the `pi` branch.
 */
export function angleDifference(a: number, b: number): number {
  const raw = Math.abs(a - b) % (2 * Math.PI);
  return Math.min(raw, 2 * Math.PI - raw);
}

/** Determinant of a linear part. Zero is forbidden by the model, and that is not negotiable. */
export function determinantOf(m: Mat2D): number {
  return m.a * m.d - m.b * m.c;
}
