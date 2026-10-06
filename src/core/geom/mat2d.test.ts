import { describe, expect, it } from 'vitest';
import {
  applyPoint,
  invert,
  multiply,
  multiplyAll,
  rotation,
  scaling,
  translation,
  determinant,
} from './mat2d';
import type { Vec2 } from './mat2d';

const points: Vec2[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: 12.5, y: -7.25 },
  { x: -300.75, y: 842.125 },
];

/** Forward-then-inverse must be the identity for any invertible composition. */
function assertInverseRoundTrip(composed: ReturnType<typeof multiply>): void {
  const inverse = invert(composed);
  for (const point of points) {
    const result = applyPoint(inverse, applyPoint(composed, point));
    expect(result.x).toBeCloseTo(point.x, 9);
    expect(result.y).toBeCloseTo(point.y, 9);
  }
}

describe('mat2d', () => {
  it('translates points', () => {
    expect(applyPoint(translation(10, -5), { x: 1, y: 2 })).toEqual({ x: 11, y: -3 });
  });

  it('scales about the origin', () => {
    expect(applyPoint(scaling(2, 3), { x: 4, y: 5 })).toEqual({ x: 8, y: 15 });
  });

  it('rotates counter-clockwise in a y-down space, matching CSS', () => {
    const rotated = applyPoint(rotation(Math.PI / 2), { x: 1, y: 0 });
    expect(rotated.x).toBeCloseTo(0, 9);
    expect(rotated.y).toBeCloseTo(1, 9);
  });

  it('composes in matrix-product order, rightmost factor applied first', () => {
    // translate(10,0) · scale(2) means "scale the point, then translate".
    expect(applyPoint(multiply(translation(10, 0), scaling(2)), { x: 1, y: 1 })).toEqual({
      x: 12,
      y: 2,
    });
  });

  it('orders rotation before scale the way CSS does', () => {
    // `transform: rotate(90deg) scale(2,1)` is the product R·S.
    const cssOrder = multiply(rotation(Math.PI / 2), scaling(2, 1));
    const reversed = multiply(scaling(2, 1), rotation(Math.PI / 2));
    const point = { x: 1, y: 0 };

    // R·S: scale x by 2 → (2,0), then rotate 90° CCW → (0,2).
    expect(applyPoint(cssOrder, point).x).toBeCloseTo(0, 9);
    expect(applyPoint(cssOrder, point).y).toBeCloseTo(2, 9);
    // S·R is genuinely different, which is why the order matters at all.
    expect(applyPoint(reversed, point).x).toBeCloseTo(0, 9);
    expect(applyPoint(reversed, point).y).toBeCloseTo(1, 9);
  });

  it('composes to the same matrix however the factors are grouped', () => {
    const factors = [translation(3, 4), rotation(0.7), scaling(1.5, 0.5)];
    const left = multiplyAll(factors[0]!, factors[1]!, factors[2]!);
    const right = multiplyAll(multiply(factors[0]!, factors[1]!), factors[2]!);
    expect(right).toEqual(left);
  });

  it('round-trips through its inverse', () => {
    assertInverseRoundTrip(multiplyAll(translation(13, -4), rotation(0.31), scaling(2, 0.5)));
  });

  it('inverts a pure translation exactly', () => {
    expect(applyPoint(invert(translation(7, -3)), { x: 100, y: 100 })).toEqual({ x: 93, y: 103 });
  });

  it('reports singularity and refuses to invert it', () => {
    expect(determinant(scaling(0))).toBe(0);
    expect(() => invert(scaling(0))).toThrow(/singular/i);
  });
});