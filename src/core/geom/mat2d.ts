/**
 * 2D affine matrices, using the same component order and convention as the CSS
 * `matrix(a, b, c, d, e, f)` function:
 *
 *   x' = a*x + c*y + e
 *   y' = b*x + d*y + f
 *
 * Pure: no DOM, no model types. Conversion between a model `Transform2D` and
 * these matrices lives in `model/transform.ts` so that `core` stays free of
 * model types.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Mat2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export function vec2(x: number, y: number): Vec2 {
  return { x, y };
}

export function identity(): Mat2D {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

export function translation(tx: number, ty: number): Mat2D {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

export function scaling(sx: number, sy: number = sx): Mat2D {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

export function rotation(radians: number): Mat2D {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

/**
 * Compose two matrices as a product: `multiply(m, n)(p) === m(n(p))`.
 *
 * This is ordinary matrix-product order, matching the notation in
 * docs/ARCHITECTURE.md §1.3 and matching CSS, where `transform: rotate(45deg)
 * scale(2)` is the product R·S (scale applied to the vector first). Because the
 * rightmost factor is applied first, callers write factors left-to-right exactly
 * as the spec states them.
 */
export function multiply(m: Mat2D, n: Mat2D): Mat2D {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

/** Product of a sequence of matrices, in the order given. */
export function multiplyAll(...matrices: readonly Mat2D[]): Mat2D {
  return matrices.reduce(multiply, identity());
}

export function determinant(m: Mat2D): number {
  return m.a * m.d - m.b * m.c;
}

export function applyPoint(m: Mat2D, p: Vec2): Vec2 {
  return {
    x: m.a * p.x + m.c * p.y + m.e,
    y: m.b * p.x + m.d * p.y + m.f,
  };
}

/** Transform a direction, ignoring translation. */
export function applyVector(m: Mat2D, v: Vec2): Vec2 {
  return { x: m.a * v.x + m.c * v.y, y: m.b * v.x + m.d * v.y };
}

/** Throws on a singular matrix; callers that may hit one should check `determinant` first. */
export function invert(m: Mat2D): Mat2D {
  const det = determinant(m);
  if (det === 0) {
    throw new Error('Cannot invert a singular 2D matrix');
  }
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}