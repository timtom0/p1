/**
 * Proving the characterisation, in both directions.
 *
 * `group-resize-limit.test.ts` (M8) and `group-composition.test.ts` (M10) both rest on the claim
 * that "columns are not perpendicular" means "no `Transform2D` can produce this". That claim is
 * only sound if perpendicularity is *sufficient* as well as necessary -- and the M8 file asserted
 * the converse in a comment without ever testing it. If it were false, every "this is a shear" in
 * this codebase would be an unproven excuse.
 *
 * So the converse gets its own test: factor a perpendicular-column matrix back into a rotation and
 * a diagonal scale, and require that the product reproduces the original exactly.
 */

import { describe, expect, it } from 'vitest';

import { isRotationTimesScale, linearColumns, shear } from './linear-part';
import { multiply, rotation, scaling } from './mat2d';
import type { Mat2D } from './mat2d';

const NEARLY_ZERO = 1e-12;

function expectMatrixClose(actual: Mat2D, expected: Mat2D): void {
  expect(actual.a).toBeCloseTo(expected.a, 9);
  expect(actual.b).toBeCloseTo(expected.b, 9);
  expect(actual.c).toBeCloseTo(expected.c, 9);
  expect(actual.d).toBeCloseTo(expected.d, 9);
}

describe('linearColumns', () => {
  it('reads the linear part and ignores the translation', () => {
    const columns = linearColumns({ a: 2, b: 3, c: 4, d: 5, e: 700, f: 800 });
    expect(columns[0]).toEqual({ x: 2, y: 3 });
    expect(columns[1]).toEqual({ x: 4, y: 5 });
  });
});

describe('shear', () => {
  it('is exactly zero for every rotation times scale the model can hold', () => {
    for (const t of [0, 0.1, 1, Math.PI / 2, Math.PI, -2.4, 7]) {
      for (const [sx, sy] of [
        [1, 1],
        [2, 1],
        [1, 2],
        [-3, 5],
        [1e-3, 1e3],
      ] as const) {
        const m = multiply(rotation(t), scaling(sx, sy));
        expect(Math.abs(shear(m)), `t=${t} ${sx}x${sy}`).toBeLessThan(NEARLY_ZERO);
        expect(isRotationTimesScale(m), `t=${t} ${sx}x${sy}`).toBe(true);
      }
    }
  });

  it('reports a real shear as a real number', () => {
    // The textbook shear: x scaled, y left alone.
    const sheared: Mat2D = { a: 2, b: 0, c: 1, d: 1, e: 0, f: 0 };
    expect(shear(sheared)).toBeCloseTo(2, 12);
    expect(isRotationTimesScale(sheared)).toBe(false);
  });

  it('is a signed quantity, so a shear in either direction is non-zero', () => {
    const forward: Mat2D = { a: 2, b: 0, c: 1, d: 1, e: 0, f: 0 };
    const backward: Mat2D = { a: 2, b: 0, c: -1, d: 1, e: 0, f: 0 };
    expect(Math.sign(shear(forward))).not.toBe(Math.sign(shear(backward)));
  });
});

describe('perpendicularity is sufficient, not merely necessary', () => {
  /**
   * The converse construction, exactly as the module comment states it.
   *
   * Normalise each column to unit length -- that matrix is orthogonal, hence a rotation possibly
   * composed with a reflection, and a reflection is a negative `sy`. Then scale each axis by the
   * column length that was divided out.
   */
  function factor(m: Mat2D): Mat2D {
    const [first, second] = linearColumns(m);
    const l1 = Math.hypot(first.x, first.y);
    const l2 = Math.hypot(second.x, second.y);
    // A rotation through the angle of the first column, keeping the second's handedness in the
    // sign of `sy`.
    const theta = Math.atan2(first.y, first.x);
    const handed = first.x * second.y - first.y * second.x < 0 ? -1 : 1;
    return multiply(rotation(theta), scaling(l1, handed * l2));
  }

  it('reproduces every perpendicular-column matrix from a rotation and a scale', () => {
    // Rotations and scales first: the ordinary case.
    const representable: Mat2D[] = [];
    for (const t of [0, 0.3, Math.PI / 3, -1.9]) {
      for (const [sx, sy] of [
        [1, 1],
        [2, 1],
        [1, 4],
        [-2, 3],
      ] as const) {
        representable.push(multiply(rotation(t), scaling(sx, sy)));
      }
    }

    for (const m of representable) {
      expect(isRotationTimesScale(m)).toBe(true);
      expectMatrixClose(factor(m), m);
    }
  });

  it('reproduces a perpendicular-column matrix with a translation attached', () => {
    // Translations are orthogonal to this argument, but a regression here would mean the
    // predicate had started looking at `e`/`f`.
    const m: Mat2D = { a: 2, b: 0, c: 0, d: 5, e: 31, f: -17 };
    expect(isRotationTimesScale(m)).toBe(true);
    const factored = factor(m);
    expect(factored.e).toBe(0);
    expect(factored.f).toBe(0);
    expectMatrixClose(factored, m);
  });

  it('round-trips every matrix this codebase can actually store', () => {
    // The property that matters, stated over the domain rather than over samples.
    for (const t of [0, 0.05, 0.785, 1.5707963267948966, 2.9, -3.14159]) {
      for (const [sx, sy] of [
        [1, 1],
        [1.5, 1],
        [1, 1.5],
        [0.25, 4],
        [-1, 1],
      ] as const) {
        const m = multiply(rotation(t), scaling(sx, sy));
        expect(isRotationTimesScale(m), `t=${t} ${sx}x${sy}`).toBe(true);
        expectMatrixClose(factor(m), m);
      }
    }
  });
});

describe('the tolerance is not doing hidden work', () => {
  it('rejects a shear far below any gesture resolution', () => {
    // A tenth of a degree is the smallest rotation a pointer gesture plausibly produces, and a
    // stretched frame shears it by ~0.0035. If the epsilon were anywhere near this, the predicate
    // would be lying.
    //
    // Note the operand order, which is the whole of ADR 0005's warning: `R(t) * S` is
    // representable at *every* rotation, while `S * R(t)` is a shear at every rotation but
    // zero. Applying scale after rotation rather than before is what a page-frame resize does,
    // and it is why the same object is fine when unrotated and impossible when rotated.
    const sheared = multiply(scaling(2, 1), rotation(Math.PI / 1800));
    expect(Math.abs(shear(sheared))).toBeGreaterThan(1e-3);
    expect(isRotationTimesScale(sheared)).toBe(false);

    // The negative control on that claim: the representable order at the same angle is accepted.
    expect(isRotationTimesScale(multiply(rotation(Math.PI / 1800), scaling(2, 1)))).toBe(true);
  });

  it('accepts a pure translation', () => {
    expect(isRotationTimesScale({ a: 1, b: 0, c: 0, d: 1, e: 40, f: 90 })).toBe(true);
  });
});