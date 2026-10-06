/**
 * The overlay's frame arithmetic, cross-checked against the model's.
 *
 * Split out of `src/model/painted-bounds.test.ts` because of the layer rule: `model` may not import
 * `editor`, and the ESLint boundary caught the attempt -- which is the rule working. The overlay
 * holds a *rect* and a *linear part*, not a `Transform2D`, so it has to rebuild the composition
 * `T(centre) · M · T(-centre)` that `worldMatrix` performs. If that rebuild were wrong, the outline
 * would drift from the object at exactly the moment M11 fixed them, and no unit test on either side
 * alone would notice: `paintedBounds` would still be right, and the chrome would still be wrong.
 *
 * So the check is the cross one: every point the overlay places must equal `localToParent`.
 */

import { describe, expect, it } from 'vitest';

import { Overlay } from './overlay';
import { identity } from '../../core/geom/mat2d';
import { localMatrix, localToParent, parentToLocal, transformedCorners } from '../../model/transform';
import { createTransform } from '../../model/factory';

const DEG = Math.PI / 180;
const THIRTY = 30 * DEG;

/**
 * An `Overlay` wired to a pass-through metrics object, so `toLayer` is the identity and the numbers
 * under test are the overlay's own arithmetic rather than a viewport's zoom.
 */
function stubOverlay(): Overlay {
  return new Overlay(
    { layer: null as unknown as HTMLElement, viewport: null as unknown as HTMLElement },
    { toClient: (_pageId, point) => point },
  );
}

function outlineFor(transform: ReturnType<typeof createTransform>) {
  return {
    rect: {
      x: transform.x,
      y: transform.y,
      width: transform.width,
      height: transform.height,
    },
    matrix: localMatrix(transform),
    pageId: 'p1',
  };
}

describe('the overlay frame arithmetic agrees with the model', () => {
  it('framePoint is exactly localToParent, for every corner and outside the box', () => {
    const cases = [
      createTransform({ x: 60, y: 60, width: 200, height: 100 }),
      createTransform({ x: 60, y: 60, width: 200, height: 100, rotation: THIRTY }),
      createTransform({
        x: -40,
        y: 120,
        width: 140,
        height: 90,
        rotation: -0.9,
        scaleX: 2,
        scaleY: 0.5,
      }),
      createTransform({ x: 10, y: 10, width: 160, height: 0, rotation: THIRTY }),
      createTransform({ x: 10, y: 10, width: 100, height: 40, rotation: 0.3, scaleY: -1 }),
    ];
    const probes = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 100 },
      { x: 0, y: 100 },
      // Outside the box, which is how the rotation grip is placed.
      { x: 100, y: -24 },
      { x: -30, y: 55 },
    ];
    const overlay = stubOverlay();
    for (const t of cases) {
      const outline = outlineFor(t);
      for (const probe of probes) {
        const viaOverlay = overlay.framePoint(outline, probe);
        const viaModel = localToParent(t, probe);
        expect(viaOverlay.x, `x for ${JSON.stringify(probe)} at ${t.rotation}`).toBeCloseTo(
          viaModel.x,
          9,
        );
        expect(viaOverlay.y, `y for ${JSON.stringify(probe)} at ${t.rotation}`).toBeCloseTo(
          viaModel.y,
          9,
        );
      }
    }
  });

  it('the rotation grip lands one handle-gap beyond the frame top edge', () => {
    // Spelled out because the gap is a constant in the editor and the arithmetic is here: a reader
    // changing one needs to know the other is involved.
    const gap = 24;
    const t = createTransform({ x: 60, y: 60, width: 200, height: 100, rotation: THIRTY });
    const outline = outlineFor(t);
    const grip = stubOverlay().rotationGripPoint(outline, gap);

    // In the object's own space the grip is at (w/2, -gap): outside the box, above its top edge.
    const back = parentToLocal(t, grip);
    expect(back.x).toBeCloseTo(t.width / 2, 9);
    expect(back.y).toBeCloseTo(-gap, 9);

    // And in page space it is `gap` from the top-edge midpoint, measured along the frame's own
    // outward normal -- which is why it clears the shape at any rotation.
    const corners = transformedCorners(t);
    const topLeft = corners[0];
    const topRight = corners[1];
    if (topLeft === undefined || topRight === undefined) throw new Error('expected corners');
    const midpoint = { x: (topLeft.x + topRight.x) / 2, y: (topLeft.y + topRight.y) / 2 };
    expect(Math.hypot(grip.x - midpoint.x, grip.y - midpoint.y)).toBeCloseTo(gap, 9);
  });

  it('an identity matrix places handles on the untransformed corners', () => {
    // The unrotated control, and the reason the outline writes its matrix unconditionally: an
    // identity matrix and `transform: none` are the same picture, so branching on "is it rotated"
    // would leave the rotated path exercised only by the rotated tests.
    const overlay = stubOverlay();
    const outline = { rect: { x: 0, y: 0, width: 10, height: 10 }, matrix: identity(), pageId: 'p1' };
    for (const [direction, expected] of [
      ['nw', { x: 0, y: 0 }],
      ['n', { x: 5, y: 0 }],
      ['se', { x: 10, y: 10 }],
      ['w', { x: 0, y: 5 }],
    ] as const) {
      const point = overlay.handlePoint(outline, direction);
      expect(point.x, `${direction} x`).toBeCloseTo(expected.x, 9);
      expect(point.y, `${direction} y`).toBeCloseTo(expected.y, 9);
    }
  });

  it('a handle on a rotated frame is the transformed corner, and not the model one', () => {
    const overlay = stubOverlay();
    const t = createTransform({ x: 60, y: 60, width: 200, height: 100, rotation: THIRTY });
    const outline = outlineFor(t);
    const corners = transformedCorners(t);
    const topLeft = corners[0];
    if (topLeft === undefined) throw new Error('expected a corner');

    const nw = overlay.handlePoint(outline, 'nw');
    expect(nw.x).toBeCloseTo(topLeft.x, 9);
    expect(nw.y).toBeCloseTo(topLeft.y, 9);

    // The negative control: the old placement was the model frame's own corner, 61px away.
    expect(Math.hypot(nw.x - t.x, nw.y - t.y), 'the model-frame corner is not the handle').toBeGreaterThan(
      50,
    );
  });
});
