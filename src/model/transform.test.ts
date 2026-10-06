import { describe, expect, it } from 'vitest';
import { applyPoint, multiplyAll } from '../core/geom/mat2d';
import type { Vec2 } from '../core/geom/mat2d';
import { createRectNode, createTransform } from './factory';
import { localToParent, pageSizeToPx, parentToLocal, worldMatrix } from './transform';

const samples: Vec2[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 0, y: 10 },
  { x: 60, y: 34 },
  { x: -5, y: 120 },
];

describe('transform', () => {
  it('leaves the box corners in place when there is no rotation or scale', () => {
    const t = createTransform({ x: 20, y: 30, width: 100, height: 40 });
    expect(localToParent(t, { x: 0, y: 0 })).toEqual({ x: 20, y: 30 });
    expect(localToParent(t, { x: 100, y: 40 })).toEqual({ x: 120, y: 70 });
  });

  it('rotates about the box centre, not the origin', () => {
    const t = createTransform({ x: 0, y: 0, width: 100, height: 100, rotation: Math.PI / 2 });
    // The centre must not move.
    const centre = localToParent(t, { x: 50, y: 50 });
    expect(centre.x).toBeCloseTo(50, 9);
    expect(centre.y).toBeCloseTo(50, 9);
    // The top-left corner swings to where the top-right used to be.
    const topLeft = localToParent(t, { x: 0, y: 0 });
    expect(topLeft.x).toBeCloseTo(100, 9);
    expect(topLeft.y).toBeCloseTo(0, 9);
  });

  it('scales about the box centre, so the box grows outwards', () => {
    const t = createTransform({ x: 10, y: 10, width: 100, height: 100, scaleX: 2, scaleY: 2 });
    // The centre does not move.
    const centre = localToParent(t, { x: 50, y: 50 });
    expect(centre.x).toBeCloseTo(60, 9);
    expect(centre.y).toBeCloseTo(60, 9);
    // Corners move symmetrically away from it — the same as CSS, where
    // `transform-origin: 50% 50%` scales about the centre.
    expect(localToParent(t, { x: 0, y: 0 })).toEqual({ x: -40, y: -40 });
    expect(localToParent(t, { x: 100, y: 100 })).toEqual({ x: 160, y: 160 });
  });

  it('round-trips parent space → local space → parent space', () => {
    const transforms = [
      createTransform({ x: 24, y: 32, width: 120, height: 68 }),
      createTransform({ x: 5, y: 5, width: 10, height: 10, rotation: 0.7 }),
      createTransform({ x: -3, y: 90, width: 40, height: 25, rotation: -2.1, scaleX: 1.5, scaleY: 0.5 }),
    ];

    for (const t of transforms) {
      for (const point of samples) {
        const roundTripped = localToParent(t, parentToLocal(t, point));
        expect(roundTripped.x).toBeCloseTo(point.x, 9);
        expect(roundTripped.y).toBeCloseTo(point.y, 9);
      }
    }
  });

  it('composes nested nodes exactly as a parent/child DOM would', () => {
    // The invariant groups will depend on: parent∘child as a matrix product must
    // equal mapping the point through each node in turn.
    const parent = createTransform({ x: 100, y: 100, width: 200, height: 200, rotation: Math.PI / 2 });
    const child = createTransform({ x: 60, y: 30, width: 40, height: 20, scaleX: 1.5, scaleY: 0.5 });

    const composed = multiplyAll(worldMatrix(parent), worldMatrix(child));
    for (const point of samples) {
      const nested = localToParent(parent, localToParent(child, point));
      const flat = applyPoint(composed, point);
      expect(nested.x).toBeCloseTo(flat.x, 9);
      expect(nested.y).toBeCloseTo(flat.y, 9);
    }
  });

  it('scales non-uniformly about the centre', () => {
    const t = createTransform({ x: 0, y: 0, width: 100, height: 100, scaleX: 2, scaleY: 0.5 });
    // The centre stays put under any scale.
    const centre = localToParent(t, { x: 50, y: 50 });
    expect(centre.x).toBeCloseTo(50, 9);
    expect(centre.y).toBeCloseTo(50, 9);
    // The top-left corner moves to centre - 50·scale.
    const corner = localToParent(t, { x: 0, y: 0 });
    expect(corner.x).toBeCloseTo(-50, 9);
    expect(corner.y).toBeCloseTo(25, 9);
  });

  it('defaults a node to an unrotated, unscaled box', () => {
    const node = createRectNode();
    expect(node.transform).toEqual({ x: 0, y: 0, width: 0, height: 0, rotation: 0, scaleX: 1, scaleY: 1 });
    expect(node.visible).toBe(true);
    expect(node.type).toBe('shape');
  });
});

describe('pageSizeToPx', () => {
  it('swaps width and height for landscape', () => {
    const portrait = pageSizeToPx({ width: 210, height: 297, unit: 'mm', orientation: 'portrait' });
    const landscape = pageSizeToPx({ width: 210, height: 297, unit: 'mm', orientation: 'landscape' });
    expect(portrait.width).toBeCloseTo(793.7007874, 6);
    expect(portrait.height).toBeCloseTo(1122.519685, 6);
    expect(landscape.width).toBeCloseTo(portrait.height, 9);
    expect(landscape.height).toBeCloseTo(portrait.width, 9);
  });

  it('does not round-trip through integers', () => {
    const { width } = pageSizeToPx({ width: 210, height: 297, unit: 'mm', orientation: 'portrait' });
    expect(width).not.toBe(Math.round(width));
  });
});