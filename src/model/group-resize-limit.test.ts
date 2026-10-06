/**
 * Why multi-object resize is not in M8.
 *
 * This is the algebra behind ADR 0008 §4, written as a test rather than as prose because the
 * argument is short, checkable, and the kind of thing that gets re-litigated without one. The
 * conclusion is a *limitation of the model*, not a missing feature, so the test that pins it
 * belongs beside the transform it constrains.
 *
 * The obstruction, precisely. Writing the required linear part as
 * `diag(a, b) * R(t) * diag(sx, sy)`, its columns are `sx * (a cos t, b sin t)` and
 * `sy * (-a sin t, b cos t)`, whose dot product is `sx * sy * sin(t) * cos(t) * (b^2 - a^2)`.
 * So a **non-uniform** resize (`a != b`) of a member is expressible exactly when the member
 * is at a multiple of 90 degrees -- where the page-frame axes coincide with its own, possibly
 * swapped. Every other rotation is a shear, and every shear is out of reach.
 *
 * The claim, precisely:
 *
 * > `Transform2D` can only ever produce a 2x2 linear part whose two **columns are
 * > perpendicular**. A non-uniform resize of a *rotated* object by `(a, b)` in the page frame
 * > requires one whose columns are not perpendicular -- i.e. a shear -- so it is not
 * > representable. Adding one would mean a new transform parameter, a new invariant, and an
 * > amendment to ADR 0005's geometry contract, all to make one bounding-box handle work.
 *
 * The characteristic is easy to state and easy to falsify: for `M = R(t) * S(sx, sy)` the
 * columns are `sx * (cos t, sin t)` and `sy * (-sin t, cos t)`, whose dot product is zero. And
 * the converse holds too -- any 2x2 with perpendicular columns factors as a rotation times a
 * diagonal scale -- so "columns are perpendicular" is exactly the model's expressible set, not
 * merely a necessary condition that happens to hold for the cases we care about.
 */

import { describe, expect, it } from 'vitest';

import { localMatrix } from './transform';
import { identity, multiply, rotation, scaling } from '../core/geom/mat2d';
import type { Mat2D } from '../core/geom/mat2d';
// "Expressible" is one predicate, shared with `group-composition.test.ts` and defined once in
// `core`, so the two proofs cannot drift apart or disagree about what the model can hold.
import { isRotationTimesScale as isExpressible, SHEAR_EPSILON, shear } from '../core/geom/linear-part';
import { createTransform } from './factory';

const THIRTY_DEGREES = Math.PI / 6;

/** The linear part a non-uniform page-frame resize would have to produce. */
function resizedBy(scaleX: number, scaleY: number, rotationRadians: number, sx = 1, sy = 1): Mat2D {
  return multiply(
    scaling(scaleX, scaleY),
    multiply(rotation(rotationRadians), scaling(sx, sy)),
  );
}

describe('what Transform2D can express', () => {
  it('produces perpendicular columns, for every rotation and scale it can hold', () => {
    // The positive control: the characteristic really does hold across the model's whole range.
    // Without it, "not expressible" below would be vacuous.
    for (const radians of [0, 0.1, THIRTY_DEGREES, Math.PI / 2, Math.PI, 2.4, -1.1]) {
      for (const [sx, sy] of [
        [1, 1],
        [2, 1],
        [1, 3],
        [0.5, 0.25],
        [-1, 1],
      ] as const) {
        const m = localMatrix(createTransform({ rotation: radians, scaleX: sx, scaleY: sy }));
        expect(isExpressible(m), `rotation ${radians}, scale ${sx}x${sy}`).toBe(true);
      }
    }
  });

  it('is the identity for the default transform', () => {
    expect(isExpressible(localMatrix(createTransform()))).toBe(true);
    expect(localMatrix(createTransform())).toEqual(identity());
  });
});

describe('what a group resize would need', () => {
  it('is expressible for an unrotated member, however non-uniform', () => {
    // Which is why single-object resize works, and why a group of unrotated objects would
    // too: with no rotation, scaling width and height *is* the resize.
    for (const [a, b] of [
      [2, 1],
      [1, 4],
      [0.5, 3],
    ] as const) {
      expect(isExpressible(resizedBy(a, b, 0)), `scale ${a}x${b}`).toBe(true);
    }
  });

  it('is expressible for a uniform scale of a rotated member', () => {
    // A uniform group scale is representable, which is why it is a *semantics* problem
    // (which pivot?) rather than a representational one.
    for (const radians of [0.1, THIRTY_DEGREES, Math.PI / 3, -2.2]) {
      expect(isExpressible(resizedBy(2, 2, radians)), `rotation ${radians}`).toBe(true);
    }
  });

  it('is NOT expressible for a non-uniform scale of a rotated member', () => {
    // The claim. 30 degrees, stretched 2x horizontally and 1x vertically in the page frame:
    // dragging the right-middle handle of a selection bounding box.
    const required = resizedBy(2, 1, THIRTY_DEGREES);
    expect(isExpressible(required)).toBe(false);

    // Spelled out, so the failure is a number rather than a verdict: the columns are not
    // perpendicular, and the dot product says by how much.
    expect(shear(required)).not.toBeCloseTo(0, 6);
    // The same magnitude ADR 0008 §4 quotes, so the two documents cannot disagree:
    // `sin(t) * cos(t) * (b^2 - a^2)` with `a = 2`, `b = 1`.
    expect(Math.abs(shear(required))).toBeCloseTo(
      Math.sin(THIRTY_DEGREES) * Math.cos(THIRTY_DEGREES) * Math.abs(1 - 4),
      6,
    );
  });

  it('IS expressible at quarter turns, and that is the exception worth naming', () => {
    // "Rotated" is not the right word for the obstruction, and getting it wrong would
    // overstate the limitation. At a multiple of 90 degrees the page-frame axes coincide with
    // the object's own, possibly swapped, so a non-uniform page-frame scale is just a
    // different scaleX/scaleY. Everything strictly between is a shear.
    for (const radians of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      expect(isExpressible(resizedBy(2, 1, radians)), `rotation ${radians}`).toBe(true);
    }
    // And the obstruction is genuinely about the angle, not about being "rotated":
    for (const radians of [0.01, THIRTY_DEGREES, Math.PI / 3, 1.4, -2.2]) {
      expect(isExpressible(resizedBy(2, 1, radians)), `rotation ${radians}`).toBe(false);
    }
  });

  it('crosses from expressible to not exactly at a quarter turn', () => {
    // A boundary assertion rather than two separate ones, so the exception is located rather
    // than merely mentioned. The tolerances bracket the shared predicate's own epsilon: the
    // quarter-turn case is floating-point noise, and a tenth of a degree past it is not.
    const atQuarter = Math.abs(shear(resizedBy(2, 1, Math.PI / 2)));
    const justPast = Math.abs(shear(resizedBy(2, 1, Math.PI / 2 + 0.01)));
    expect(atQuarter).toBeLessThan(SHEAR_EPSILON);
    expect(justPast).toBeGreaterThan(SHEAR_EPSILON);
    // And a degree past it is a shear of real magnitude, so nothing is being decided on noise.
    expect(Math.abs(shear(resizedBy(2, 1, Math.PI / 2 + Math.PI / 180)))).toBeGreaterThan(1e-3);
  });

  it('is NOT expressible regardless of the member existing scale', () => {
    // The earlier draft of this argument claimed the obstruction depended on `scaleX` and
    // `scaleY` being equal. It does not: the required page-frame factors are what matter, and
    // the member's own scale just scales the dot product.
    for (const [sx, sy] of [
      [1, 1],
      [2, 2],
      [3, 0.5],
    ] as const) {
      expect(isExpressible(resizedBy(2, 1, THIRTY_DEGREES, sx, sy)), `member scale ${sx}x${sy}`).toBe(
        false,
      );
    }
  });

  it('would need a matrix outside the model, and the model would refuse it', () => {
    // The consequence, stated as a check on the invariant: a shear has perpendicular *edges*
    // but non-perpendicular columns under this parameterisation, and nothing in `Transform2D`
    // can hold it. So the honest options are to add a parameter -- and amend ADR 0005 -- or to
    // not offer the gesture. M8 takes the second.
    const sheared = resizedBy(3, 1, THIRTY_DEGREES);
    expect(shear(sheared)).toBeCloseTo(Math.sin(THIRTY_DEGREES) * Math.cos(THIRTY_DEGREES) * (1 - 9) * 1 * 1, 6);
    expect(isExpressible(sheared)).toBe(false);

    // Which means a candidate transform carrying a shear could not even be *validated* into
    // the model as it stands: `scaleX`/`scaleY` and `rotation` are the only degrees of freedom,
    // and they cannot express it.
    const candidate = createTransform({ rotation: THIRTY_DEGREES, scaleX: 3, scaleY: 1 });
    expect(isExpressible(localMatrix(candidate))).toBe(true);
  });
});
