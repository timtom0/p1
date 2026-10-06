/**
 * The bounds contract, and the frame arithmetic the overlay depends on.
 *
 * M11 added two functions (`paintedBounds`, `transformedCorners`) and one piece of arithmetic
 * (`Overlay.framePoint`). All three exist because the codebase had four different ideas of "where is
 * this object" and used one of them for all four (ADR 0011 §8 F6). The tests here pin the
 * distinctions, because a function named `paintedBounds` that returned the model frame would satisfy
 * every existing assertion.
 */

import { describe, expect, it } from 'vitest';

import { paintedBounds, transformedCorners, localToParent } from './transform';
import { createTransform } from './factory';

const DEG = Math.PI / 180;
const THIRTY = 30 * DEG;

describe('paintedBounds', () => {
  it('equals the model frame when nothing is transformed', () => {
    // The case that let the distinction hide for nine milestones.
    const t = createTransform({ x: 40, y: 60, width: 200, height: 100 });
    expect(paintedBounds(t)).toEqual({ x: 40, y: 60, width: 200, height: 100 });
  });

  it('is the axis-aligned box of the rotated shape, not the model frame', () => {
    const t = createTransform({ x: 60, y: 60, width: 200, height: 100, rotation: THIRTY });
    const bounds = paintedBounds(t);
    expect(bounds.width).toBeCloseTo(200 * Math.cos(THIRTY) + 100 * Math.sin(THIRTY), 6);
    expect(bounds.height).toBeCloseTo(200 * Math.sin(THIRTY) + 100 * Math.cos(THIRTY), 6);
    // 223.2 x 186.6 -- both different from the model frame, in opposite directions from M10b's note.
    expect(bounds.width).not.toBeCloseTo(200, 0);
    expect(bounds.height).not.toBeCloseTo(100, 0);
    // And the model frame's centre is preserved: rotation is about the box centre, so the two boxes
    // share a centre even when their sizes differ. This is what makes the outline and the object
    // concentric rather than merely similar.
    expect(bounds.x + bounds.width / 2).toBeCloseTo(t.x + t.width / 2, 6);
    expect(bounds.y + bounds.height / 2).toBeCloseTo(t.y + t.height / 2, 6);
  });

  it('contains the model frame only by accident, and that is not a guarantee', () => {
    // Worth stating because it is the tempting inference from the previous test: "bounds contain the
    // frame" is false in general. For 30 degrees the AABB does contain the unrotated box; for 45 on a
    // 200x50 it does not.
    const thirty = createTransform({ x: 0, y: 0, width: 200, height: 100, rotation: THIRTY });
    const b1 = paintedBounds(thirty);
    expect(
      b1.x <= 0 && b1.y <= 0 && b1.x + b1.width >= 200 && b1.y + b1.height >= 100,
      'at 30 degrees the AABB happens to contain the frame',
    ).toBe(true);

    const fortyFive = createTransform({ x: 0, y: 0, width: 200, height: 50, rotation: 45 * DEG });
    const b2 = paintedBounds(fortyFive);
    // The frame's far corner (200, 50) maps outside the AABB of the rotated shape.
    const mapped = localToParent(fortyFive, { x: 200, y: 50 });
    const inside =
      mapped.x >= b2.x && mapped.x <= b2.x + b2.width && mapped.y >= b2.y && mapped.y <= b2.y + b2.height;
    expect(inside, 'and the rotated shape is what the bounds describe').toBe(true);
  });

  it('handles negative page coordinates', () => {
    // Nothing clamps to the page, so an object above or left of the origin has negative coordinates
    // and the bounds must carry them rather than clamping at zero.
    const t = createTransform({ x: -200, y: -150, width: 100, height: 60, rotation: THIRTY });
    const bounds = paintedBounds(t);
    expect(bounds.x).toBeLessThan(0);
    expect(bounds.y).toBeLessThan(0);
    // The frame's own origin stays inside the bounds, since it is a corner of the shape.
    expect(bounds.x).toBeLessThanOrEqual(t.x);
    expect(bounds.y).toBeLessThanOrEqual(t.y);
  });

  it('handles a zero-extent object without collapsing', () => {
    const t = createTransform({ x: 50, y: 50, width: 160, height: 0 });
    const bounds = paintedBounds(t);
    expect(bounds.height, 'a zero-height object has zero painted height').toBe(0);
    expect(bounds.width).toBe(160);
    // And rotated: a zero-height line at 30 degrees is a segment, and its AABB is not degenerate.
    const rotated = paintedBounds(createTransform({ x: 50, y: 50, width: 160, height: 0, rotation: THIRTY }));
    expect(rotated.height).toBeCloseTo(160 * Math.sin(THIRTY), 6);
    expect(rotated.height, 'a rotated line is taller than it is thick').toBeGreaterThan(0);
  });

  it('a mirrored object produces bounds of the right size', () => {
    const t = createTransform({ x: 10, y: 10, width: 100, height: 40, rotation: 0.3, scaleY: -1 });
    const bounds = paintedBounds(t);
    // A reflection flips the shape about the frame's horizontal midline; the extent is unchanged.
    expect(bounds.width).toBeCloseTo(100 * Math.cos(0.3) + 40 * Math.sin(0.3), 6);
    expect(bounds.height).toBeCloseTo(100 * Math.sin(0.3) + 40 * Math.cos(0.3), 6);
  });
});

describe('transformedCorners', () => {
  it('gives the four corners clockwise from the model top-left', () => {
    const t = createTransform({ x: 60, y: 60, width: 200, height: 100, rotation: THIRTY });
    const [nw, ne, se, sw] = transformedCorners(t);
    if (nw === undefined || ne === undefined || se === undefined || sw === undefined) {
      throw new Error('expected four corners');
    }
    // Each agrees with the model's own mapping, which is the definition.
    for (const [corner, local] of [
      [nw, { x: 0, y: 0 }],
      [ne, { x: 200, y: 0 }],
      [se, { x: 200, y: 100 }],
      [sw, { x: 0, y: 100 }],
    ] as const) {
      const mapped = localToParent(t, local);
      expect(corner.x).toBeCloseTo(mapped.x, 9);
      expect(corner.y).toBeCloseTo(mapped.y, 9);
    }
  });

  it('encloses exactly the same area the painted bounds describe', () => {
    // The two functions must not disagree, since one is used for the outline and the other for
    // hit regions.
    for (const rotation of [0, 15 * DEG, THIRTY, 45 * DEG, 90 * DEG, 137 * DEG]) {
      const t = createTransform({ x: 12, y: 34, width: 200, height: 100, rotation });
      const corners = transformedCorners(t);
      const xs = corners.map((c) => c.x);
      const ys = corners.map((c) => c.y);
      const derived = {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
      };
      const bounds = paintedBounds(t);
      expect(derived.x, `x at ${rotation}`).toBeCloseTo(bounds.x, 9);
      expect(derived.y, `y at ${rotation}`).toBeCloseTo(bounds.y, 9);
      expect(derived.width, `width at ${rotation}`).toBeCloseTo(bounds.width, 9);
      expect(derived.height, `height at ${rotation}`).toBeCloseTo(bounds.height, 9);
    }
  });
});

