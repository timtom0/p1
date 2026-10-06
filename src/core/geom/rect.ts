/**
 * Axis-aligned rectangles, expressed in whatever space the caller is working
 * in (page-local document space for us). Pure: no DOM, no model types.
 */

import type { Vec2 } from './mat2d';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

export function rectFromPoints(a: Vec2, b: Vec2): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

export function rectCenter(r: Rect): Vec2 {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export function rectLeft(r: Rect): number {
  return r.x;
}
export function rectRight(r: Rect): number {
  return r.x + r.width;
}
export function rectTop(r: Rect): number {
  return r.y;
}
export function rectBottom(r: Rect): number {
  return r.y + r.height;
}

export function rectContainsPoint(r: Rect, p: Vec2): boolean {
  return p.x >= r.x && p.x <= rectRight(r) && p.y >= r.y && p.y <= rectBottom(r);
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    rectLeft(a) < rectRight(b) &&
    rectRight(a) > rectLeft(b) &&
    rectTop(a) < rectBottom(b) &&
    rectBottom(a) > rectTop(b)
  );
}

export function rectContainsRect(outer: Rect, inner: Rect): boolean {
  return (
    rectLeft(inner) >= rectLeft(outer) &&
    rectTop(inner) >= rectTop(outer) &&
    rectRight(inner) <= rectRight(outer) &&
    rectBottom(inner) <= rectBottom(outer)
  );
}

/** Smallest rectangle containing all inputs. Empty input yields a zero rect. */
export function unionRects(rects: readonly Rect[]): Rect {
  if (rects.length === 0) return rect(0, 0, 0, 0);
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const r of rects) {
    if (r.x < left) left = r.x;
    if (r.y < top) top = r.y;
    if (rectRight(r) > right) right = rectRight(r);
    if (rectBottom(r) > bottom) bottom = rectBottom(r);
  }
  return rect(left, top, right - left, bottom - top);
}

export function expandRect(r: Rect, amount: number): Rect {
  return rect(r.x - amount, r.y - amount, r.width + amount * 2, r.height + amount * 2);
}