import { describe, expect, it } from 'vitest';
import {
  expandRect,
  rect,
  rectBottom,
  rectCenter,
  rectContainsPoint,
  rectContainsRect,
  rectFromPoints,
  rectRight,
  rectsIntersect,
  rectTop,
  unionRects,
} from './rect';

describe('rect', () => {
  it('derives edges and centre', () => {
    const r = rect(10, 20, 100, 50);
    expect(rectRight(r)).toBe(110);
    expect(rectBottom(r)).toBe(70);
    expect(rectTop(r)).toBe(20);
    expect(rectCenter(r)).toEqual({ x: 60, y: 45 });
  });

  it('builds a rect from two drag corners in any order', () => {
    const expected = rect(10, 10, 50, 30);
    expect(rectFromPoints({ x: 60, y: 40 }, { x: 10, y: 10 })).toEqual(expected);
    expect(rectFromPoints({ x: 10, y: 10 }, { x: 60, y: 40 })).toEqual(expected);
    expect(rectFromPoints({ x: 10, y: 40 }, { x: 60, y: 10 })).toEqual(expected);
  });

  it('includes edges in point containment', () => {
    const r = rect(0, 0, 10, 10);
    expect(rectContainsPoint(r, { x: 0, y: 0 })).toBe(true);
    expect(rectContainsPoint(r, { x: 10, y: 10 })).toBe(true);
    expect(rectContainsPoint(r, { x: 11, y: 5 })).toBe(false);
  });

  it('treats edge-touching rects as non-intersecting, matching marquee behaviour', () => {
    const a = rect(0, 0, 10, 10);
    expect(rectsIntersect(a, rect(5, 5, 10, 10))).toBe(true);
    expect(rectsIntersect(a, rect(10, 0, 10, 10))).toBe(false);
  });

  it('checks containment', () => {
    const outer = rect(0, 0, 100, 100);
    expect(rectContainsRect(outer, rect(10, 10, 10, 10))).toBe(true);
    expect(rectContainsRect(outer, outer)).toBe(true);
    expect(rectContainsRect(outer, rect(90, 90, 20, 20))).toBe(false);
  });

  it('unions an empty list to a zero rect', () => {
    expect(unionRects([])).toEqual(rect(0, 0, 0, 0));
    expect(unionRects([rect(0, 0, 10, 10), rect(20, 5, 10, 10)])).toEqual(rect(0, 0, 30, 15));
  });

  it('expands symmetrically', () => {
    expect(expandRect(rect(10, 10, 10, 10), 5)).toEqual(rect(5, 5, 20, 20));
  });
});
