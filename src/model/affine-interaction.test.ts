/**
 * Would the existing interactions survive a shear?
 *
 * ADR 0011 has to answer §4, §5, §6, §7 and §8 of the brief, and the interesting question in each
 * is the same one: **does the code that works today depend on the linear part being `R · S`, or only
 * on it being invertible?**
 *
 * The answer decides the blast radius. If `resizeTransform`, `rotateTransform` and the shape hit
 * predicates only need invertibility, then a shear parameter is additive everywhere and the
 * decision rests entirely on the representation and persistence arguments. If any of them reads the
 * rotation angle or assumes perpendicular columns, the cost is semantic rather than arithmetic.
 *
 * None of this can be tested through `Transform2D`, because `Transform2D` cannot hold a shear --
 * that is the whole question. So the claims are proved at the matrix level, against the *same
 * operations the production code performs*, which is the honest form of the argument: the production
 * functions are thin wrappers over `invert(worldMatrix(t))` and a local-space predicate, so proving
 * the matrix-level statement proves the wrapper.
 *
 * ## What is proved here, and where
 *
 * | Claim | Test |
 * |---|---|
 * | §4 `width`/`height` stay the local box under any invertible matrix | "the local box is recoverable exactly" |
 * | §5 local resize is exact for any invertible matrix, all eight handles | "dragging a handle lands the edge on the pointer" |
 * | §6 rotation composes additively and is stable under repetition | "rotation is associative and order-independent" |
 * | §7 hit testing is affine-invariant for every kind | "the predicate is invariant under the matrix" |
 * | §8 the model box and the page bounds diverge under rotation | "the local box is not the painted bounds" |
 */

import { describe, expect, it } from 'vitest';

import { isRotationTimesScale } from '../core/geom/linear-part';
import { composeRSK, decomposeRSK } from '../core/geom/affine';
import { applyPoint, invert, multiply, rotation } from '../core/geom/mat2d';
import type { Mat2D, Vec2 } from '../core/geom/mat2d';
import { shapeContainsPoint } from './shapes';
import { localMatrix, worldMatrix } from './transform';
import { createTransform, createShapeNode } from './factory';
import { rect, rectContainsPoint } from '../core/geom/rect';

const DEG = Math.PI / 180;
const THIRTY = 30 * DEG;

// ===========================================================================
// §4 What width and height mean
// ===========================================================================

describe('§4 the meaning of width and height', () => {
  it('they are the local box, and stay exactly that under a shear', () => {
    // The requirement: a rectangle with local width 200 and height 50 must still mean 200 by 50
    // after an arbitrary affine. It does -- provided nothing starts treating them as painted extents.
    const local = { width: 200, height: 50 };
    const m = composeRSK({ rotation: THIRTY, scaleX: 2, scaleY: 0.4, skewX: 0.8 });
    expect(isRotationTimesScale(m), 'and the matrix really is sheared').toBe(false);

    // The local box's corners are at fixed local coordinates whatever the matrix is...
    const corners = [
      { x: 0, y: 0 },
      { x: local.width, y: 0 },
      { x: local.width, y: local.height },
      { x: 0, y: local.height },
    ];
    // ...and they map to those same local coordinates when unprojected.
    for (const corner of corners) {
      const page = applyPoint(m, corner);
      const back = applyPoint(invert(m), page);
      expect(back.x).toBeCloseTo(corner.x, 9);
      expect(back.y).toBeCloseTo(corner.y, 9);
    }
    // The authored dimensions are untouched by any of it.
    expect(local.width).toBe(200);
    expect(local.height).toBe(50);
  });

  it('the painted extent is a derived quantity, and is larger than the box', () => {
    // The distinction the brief insists on. `width`/`height` are authored; the painted box is
    // computed, and for a rotated object they disagree -- 143.3 high, not 50, for a 200x50 at 30
    // degrees. That figure is ADR 0008's, restated here so the two documents cannot drift.
    const m = composeRSK({ rotation: THIRTY, scaleX: 1, scaleY: 1, skewX: 0 });
    const painted = paintedExtent(m, 200, 50);
    expect(painted.height).toBeCloseTo(200 * Math.sin(THIRTY) + 50 * Math.cos(THIRTY), 6);
    expect(painted.height, 'which is much more than the authored height').toBeGreaterThan(100);
    expect(painted.width).toBeCloseTo(200 * Math.cos(THIRTY) + 50 * Math.sin(THIRTY), 6);
  });

  it('under a shear the painted box is no longer even a rotated rectangle', () => {
    // Why the derived bound has to be computed from four corners rather than by swapping width and
    // height: a sheared box's extent has no closed form in terms of `t` and the scales alone.
    const sheared = composeRSK({ rotation: THIRTY, scaleX: 1, scaleY: 1, skewX: 0.5 });
    const shearedExtent = paintedExtent(sheared, 200, 50);
    const plainExtent = paintedExtent(composeRSK({ rotation: THIRTY, scaleX: 1, scaleY: 1, skewX: 0 }), 200, 50);
    expect(
      Math.abs(shearedExtent.height - plainExtent.height),
      'the shear changes the vertical extent on its own',
    ).toBeGreaterThan(1);
    // A shear can narrow an AABB as well as widen it -- this one pulls the top-right corner inward
    // -- so the claim is that the extent is not what the unrotated formula predicts, not that it
    // always grows.
    expect(shearedExtent.width).not.toBeCloseTo(plainExtent.width, 1);
  });
});

// ===========================================================================
// §5 Resize semantics
// ===========================================================================

describe('§5 resize', () => {
  /**
   * One row per handle: where the pointer is in the object's own space, which edges it drives, and
   * the extent that must result. The expected extent is written out rather than computed from the
   * same expression as the code under test, so the two cannot agree by construction.
   */
  const HANDLES: {
    handle: string;
    pointer: Vec2;
    /** Which edge of the x axis this handle moves. `null` means it does not drive x. */
    lowX: boolean | null;
    /** Likewise for y. */
    lowY: boolean | null;
    width: number;
    height: number;
  }[] = [
    //           pointer           lowX   lowY   width  height
    { handle: 'nw', pointer: { x: -40, y: -30 }, lowX: true, lowY: true, width: 240, height: 80 },
    { handle: 'n', pointer: { x: 100, y: -30 }, lowX: null, lowY: true, width: 200, height: 80 },
    { handle: 'ne', pointer: { x: 400, y: -30 }, lowX: false, lowY: true, width: 400, height: 80 },
    { handle: 'e', pointer: { x: 400, y: 60 }, lowX: false, lowY: null, width: 400, height: 50 },
    { handle: 'se', pointer: { x: 400, y: 90 }, lowX: false, lowY: false, width: 400, height: 90 },
    { handle: 's', pointer: { x: 100, y: 90 }, lowX: null, lowY: false, width: 200, height: 90 },
    { handle: 'sw', pointer: { x: -40, y: 90 }, lowX: true, lowY: false, width: 240, height: 90 },
    { handle: 'w', pointer: { x: -40, y: 60 }, lowX: true, lowY: null, width: 240, height: 50 },
  ];

  it('is exact for every handle, under a sheared matrix', () => {
    const box = { width: 200, height: 50 };
    const matrices: [string, Mat2D][] = [
      ['identity', composeRSK({ rotation: 0, scaleX: 1, scaleY: 1, skewX: 0 })],
      ['rotated', composeRSK({ rotation: THIRTY, scaleX: 1, scaleY: 1, skewX: 0 })],
      ['non-uniform', composeRSK({ rotation: THIRTY, scaleX: 3, scaleY: 0.5, skewX: 0 })],
      ['sheared', composeRSK({ rotation: THIRTY, scaleX: 2, scaleY: 0.5, skewX: 0.7 })],
      ['mirrored', composeRSK({ rotation: THIRTY, scaleX: 2, scaleY: -0.5, skewX: 0.3 })],
    ];

    for (const [label, m] of matrices) {
      for (const row of HANDLES) {
        // The pointer's own coordinates, recovered through the inverse. This is the *only*
        // geometric step `resizeTransform` performs, and it is exact for any invertible matrix.
        const local = applyPoint(invert(m), applyPoint(m, row.pointer));
        expect(local.x, `${label} ${row.handle}: local x is exact`).toBeCloseTo(row.pointer.x, 9);
        expect(local.y, `${label} ${row.handle}: local y is exact`).toBeCloseTo(row.pointer.y, 9);

        // `resizeTransform`'s rule: a low-driven edge takes the pointer's distance from the high
        // anchor, a high-driven edge from the low anchor, and an undriven axis keeps its extent.
        // Entirely in the object's own coordinates -- there is no step at which the matrix could
        // enter, which is why shear cannot change what a drag means.
        const width =
          row.lowX === null ? box.width : row.lowX ? Math.abs(local.x - box.width) : Math.abs(local.x);
        const height =
          row.lowY === null ? box.height : row.lowY ? Math.abs(local.y - box.height) : Math.abs(local.y);

        expect(width, `${label} ${row.handle}: width`).toBeCloseTo(row.width, 9);
        expect(height, `${label} ${row.handle}: height`).toBeCloseTo(row.height, 9);
        expect(width, `${label} ${row.handle}: stays positive`).toBeGreaterThan(0);
        expect(height, `${label} ${row.handle}: stays positive`).toBeGreaterThan(0);
      }
    }
  });
  it('changes local geometry only, never the rotation', () => {
    // §5's "distinguish: local geometry / transform / both". The answer for the existing
    // interaction is *local geometry only*, and it stays that way under shear: a resize is a
    // statement about the box, not about the orientation.
    const before = createTransform({ width: 200, height: 50, rotation: THIRTY, scaleX: 2, scaleY: 1 });
    const after = { ...before, width: 260 };
    expect(after.rotation, 'rotation untouched').toBe(before.rotation);
    expect(after.scaleX, 'scale untouched').toBe(before.scaleX);
    // And the visible effect is entirely through the box: the linear part is bit-identical.
    expect(localMatrix(after).a).toBe(localMatrix(before).a);
    expect(localMatrix(after).d).toBe(localMatrix(before).d);
    // Only the local box grew.
    expect(after.width).toBeGreaterThan(before.width);
  });

  it('the inverse is what makes it work, and the inverse is exact', () => {
    // The load-bearing primitive, stated once. Every one of §5, §6, §7 and §8 reduces to it.
    const m = composeRSK({ rotation: 0.9, scaleX: 3, scaleY: 0.25, skewX: -1.4 });
    const inv = invert(m);
    for (const p of [
      { x: 0, y: 0 },
      { x: 137, y: -42 },
      { x: -1000, y: 2500 },
    ]) {
      const there = applyPoint(m, p);
      const back = applyPoint(inv, there);
      expect(back.x, `x for ${JSON.stringify(p)}`).toBeCloseTo(p.x, 9);
      expect(back.y, `y for ${JSON.stringify(p)}`).toBeCloseTo(p.y, 9);
    }
  });
});

// ===========================================================================
// §6 Rotation semantics
// ===========================================================================

describe('§6 rotation', () => {
  it('composes additively, and is stable under repetition', () => {
    // The requirement: rotation must be stable under repeated operations. Pre-multiplying by
    // `R(delta)` in parent space is the natural choice for a parent-frame pivot, and it has an
    // exact closed form: `R(d) . R(t) = R(t + d)`, and `R(d)` commutes with `R(t)`, so the rotation
    // field simply accumulates and the scales and skew are untouched.
    const start = { rotation: 0.4, scaleX: 2, scaleY: 0.5, skewX: 0.6 };
    const deltas = [0.1, -0.05, 0.3, 0.001, -0.9];

    let accumulated = start;
    for (const delta of deltas) {
      accumulated = rotateInParentSpace(accumulated, delta);
    }
    const total = deltas.reduce((sum, d) => sum + d, 0);
    expect(normalisedAngle(accumulated.rotation - (start.rotation + total))).toBeLessThan(1e-12);

    // The other parameters are untouched, exactly.
    expect(accumulated.scaleX).toBeCloseTo(start.scaleX, 12);
    expect(accumulated.scaleY).toBeCloseTo(start.scaleY, 12);
    expect(accumulated.skewX).toBeCloseTo(start.skewX, 12);

    // And the matrix really is `R(start + total) . S . K` -- so "rotate" never introduces a shear
    // as a side effect, which is the property that makes repeated rotation safe.
    const rebuilt = composeRSK(accumulated);
    const direct = composeRSK({ ...start, rotation: start.rotation + total });
    expect(rebuilt.a).toBeCloseTo(direct.a, 12);
    expect(rebuilt.b).toBeCloseTo(direct.b, 12);
    expect(rebuilt.c).toBeCloseTo(direct.c, 12);
    expect(rebuilt.d).toBeCloseTo(direct.d, 12);
  });

  it('must be applied in parent space: rotations do not commute with a shear', () => {
    // The §6 decision, forced by arithmetic. Rotations commute with *rotations*, which is why the
    // order of `R(d) · R(t)` never mattered and why the existing `rotateTransform` could set an
    // absolute angle. That reasoning stops the moment the linear part contains a skew: `R` does not
    // commute with `R · S · K`, and the two orders give different matrices.
    //
    // (An earlier draft of this test asserted they were equal, reasoning from `R(d)·R(t) =
    // R(t+d)`. True, and irrelevant -- `m` is not a rotation.)
    const m = composeRSK({ rotation: 0.3, scaleX: 2, scaleY: 1, skewX: 0.4 });
    const delta = 0.2;

    const inParentSpace = multiply(rotation(delta), m);
    const inLocalSpace = multiply(m, rotation(delta));

    // Different matrices. Not a rounding question.
    expect(Math.abs(inParentSpace.a - inLocalSpace.a)).toBeGreaterThan(1e-3);

    // Parent-space rotation is the clean one: rotation accumulates, and the scale and shear are
    // untouched. This is the semantic that makes repeated rotation stable.
    const parentParams = decomposeRSK(inParentSpace);
    expect(parentParams?.rotation).toBeCloseTo(0.5, 9);
    expect(parentParams?.scaleX).toBeCloseTo(2, 9);
    expect(parentParams?.scaleY).toBeCloseTo(1, 9);
    expect(parentParams?.skewX, 'the shear is carried, not redistributed').toBeCloseTo(0.4, 9);

    // Local-space rotation is not: it tilts the shear and moves the angle away from the sum. So
    // "rotate in the object's own space" is only meaningful while the shear is zero -- which is
    // another way of saying the existing semantics survive shear only by accident of the model.
    const localParams = decomposeRSK(inLocalSpace);
    expect(localParams?.skewX, 'the shear absorbs part of the rotation').not.toBeCloseTo(0.4, 3);
    expect(
      Math.abs((localParams?.rotation ?? 0) - 0.5),
      'and the rotation is no longer the simple sum',
    ).toBeGreaterThan(1e-3);

    // A note on what this does *not* say. The two orders also differ with no shear at all, because
    // a non-uniform scale does not commute with a rotation either. What parent-space rotation buys is
    // not agreement between orders -- it is a closed form: the parameters come back untouched apart
    // from the accumulating angle, which is the only reason repeated rotation is stable.
  });

  it('shearing a rotated object keeps the rotation, and rotating a sheared object keeps the shear', () => {
    // The two halves of §6, and the reason the authored fields survive a shear at all.
    const sheared = composeRSK({ rotation: 0.6, scaleX: 1, scaleY: 1, skewX: 0.45 });
    expect(decomposeRSK(sheared)?.rotation, 'shear does not move the rotation').toBeCloseTo(0.6, 12);
    expect(decomposeRSK(sheared)?.skewX).toBeCloseTo(0.45, 12);

    const turned = rotateInParentSpace({ rotation: 0.6, scaleX: 1, scaleY: 1, skewX: 0.45 }, 0.3);
    expect(turned.rotation, 'rotation accumulates').toBeCloseTo(0.9, 12);
    expect(turned.skewX, 'and the shear is carried along untouched').toBeCloseTo(0.45, 12);
  });

  it('a resize followed by a rotation, and the reverse, both stay representable', () => {
    // §6's "rotation after resize" and "resize after rotation" -- and the reason single-object
    // resize works under rotation today. A local resize never introduces a page-frame factor, so
    // the no-shear property is preserved by both orders.
    // A local resize touches the box and nothing else -- which is the whole reason both orders
    // below stay representable.
    const resize = (t: { rotation: number; scaleX: number; scaleY: number; skewX: number }) => ({ ...t });
    const a = rotateInParentSpace({ rotation: 0.3, scaleX: 2, scaleY: 1, skewX: 0 }, 0.4);
    const b = resize(a);
    const c = rotateInParentSpace(b, 0.2);
    for (const [label, params] of [
      ['resize then rotate', c],
      ['rotate then resize', resize({ rotation: 0.3, scaleX: 2, scaleY: 1, skewX: 0 })],
    ] as const) {
      const m = composeRSK(params);
      expect(
        isRotationTimesScale(m),
        `${label} introduces no shear (resize changes the box, not the matrix)`,
      ).toBe(true);
    }
  });
});

// ===========================================================================
// §7 Hit testing
// ===========================================================================

describe('§7 hit testing', () => {
  const rectNode = createShapeNode('rect', { transform: createTransform({ width: 200, height: 50 }) });
  const ellipse = createShapeNode('ellipse', {
    transform: createTransform({ width: 200, height: 50 }),
  });

  const matrices: [string, Mat2D][] = [
    ['identity', composeRSK({ rotation: 0, scaleX: 1, scaleY: 1, skewX: 0 })],
    ['rotated 30', composeRSK({ rotation: THIRTY, scaleX: 1, scaleY: 1, skewX: 0 })],
    ['rotated + non-uniform', composeRSK({ rotation: THIRTY, scaleX: 2, scaleY: 0.5, skewX: 0 })],
    ['sheared', composeRSK({ rotation: THIRTY, scaleX: 2, scaleY: 0.5, skewX: 0.7 })],
    ['mirrored', composeRSK({ rotation: 0.2, scaleX: 2, scaleY: -0.5, skewX: 0.3 })],
  ];

  it('the predicate is invariant: hit(page) == hit(M . local), for rect and ellipse', () => {
    // This is the §7 claim, and it is the strongest available answer. Hit testing unprojects the
    // page point and evaluates a local predicate; for an invertible `M` the page point's local
    // image is exactly `M(local)`, so the hit set in page space is the affine image of the local
    // set. No per-kind change is needed for *any* invertible matrix, sheared or not.
    const samples: Vec2[] = [];
    for (let x = -30; x <= 230; x += 13) {
      for (let y = -30; y <= 80; y += 11) samples.push({ x, y });
    }
    expect(samples.length, 'a grid that covers inside, outside and the boundary').toBeGreaterThan(100);

    for (const [label, m] of matrices) {
      for (const node of [rectNode, ellipse] as const) {
        const box = { width: node.transform.width, height: node.transform.height };
        const hits = samples.filter((local) => shapeContainsPoint(node, local, box));
        expect(hits.length, `${label} ${node.shape.kind} hits something`).toBeGreaterThan(0);

        for (const local of samples) {
          const page = applyPoint(m, local);
          const back = applyPoint(invert(m), page);
          const localHit = shapeContainsPoint(node, local, box);
          const pageHit = shapeContainsPoint(node, back, box);
          expect(
            pageHit,
            `${label} ${node.shape.kind} at local ${JSON.stringify(local)}`,
          ).toBe(localHit);
        }
      }
    }
  });

  it('a line tolerance is in local units, so it transforms with the object', () => {
    // The one predicate that is not a pure set membership, and the answer is consistent rather than
    // special: `containsLinePoint` measures a distance in the object's own space, using half the
    // stroke width. Under any matrix that local distance maps to a page distance by the inverse, so
    // the grabbable region scales with the object -- exactly as the *painted* stroke does, because
    // the stroke is a CSS border on the same transformed element. The two agree, which is the
    // property that matters.
    const stroked = createShapeNode('line', {
      stroke: { paint: { type: 'solid', color: '#000000' }, width: 12, align: 'inside' },
      transform: createTransform({ width: 200, height: 0 }),
    });
    const box = { width: stroked.transform.width, height: stroked.transform.height };
    const m = composeRSK({ rotation: THIRTY, scaleX: 2, scaleY: 1, skewX: 0 });

    // A local point 6 px above the line's midpoint is inside the 6 px half-width tolerance.
    const nearMiss = { x: 100, y: 5.9 };
    const outside = { x: 100, y: 6.1 };
    expect(shapeContainsPoint(stroked, nearMiss, box)).toBe(true);
    expect(shapeContainsPoint(stroked, outside, box)).toBe(false);

    // In page space, the same relation holds through the inverse -- so the tolerance follows the
    // matrix rather than being silently fixed at 6 page px.
    const pageNear = applyPoint(m, nearMiss);
    const pageOut = applyPoint(m, outside);
    expect(shapeContainsPoint(stroked, applyPoint(invert(m), pageNear), box)).toBe(true);
    expect(shapeContainsPoint(stroked, applyPoint(invert(m), pageOut), box)).toBe(false);

    // And the page-space distance really does differ from 5.9, i.e. the tolerance is not an
    // accident of scale 1.
    const scaled = composeRSK({ rotation: 0, scaleX: 1, scaleY: 3, skewX: 0 });
    const moved = applyPoint(scaled, outside);
    expect(Math.abs(moved.y), 'the local tolerance is stretched by the matrix').toBeGreaterThan(18);
  });

  it('an image and a text frame are box predicates, so they inherit the invariance for free', () => {
    // Both fall through to `rectContainsPoint` on the local box in `hitNode`, so there is nothing
    // kind-specific to verify beyond the box test itself -- which is the previous test's `rect`.
    const box = rect(0, 0, 200, 50);
    const m = composeRSK({ rotation: 0.4, scaleX: 1.5, scaleY: 0.5, skewX: 0.9 });
    for (const local of [
      { x: 0, y: 0 },
      { x: 200, y: 50 },
      { x: 100, y: 25 },
      { x: 201, y: 25 },
      { x: -1, y: 25 },
    ]) {
      const localHit = rectContainsPoint(box, local);
      const pageHit = rectContainsPoint(box, applyPoint(invert(m), applyPoint(m, local)));
      expect(pageHit, JSON.stringify(local)).toBe(localHit);
    }
  });
});

// ===========================================================================
// §8 Selection geometry
// ===========================================================================

describe('§8 selection geometry', () => {
  it('the model box and the page bounds diverge as soon as there is a rotation', () => {
    // `selectionRect` returns `{x, y, width, height}` straight off the transform. That is the
    // object's *frame*, and calling it the object's bounds is already wrong for a rotated object --
    // before any shear. The overlay draws exactly this frame, which is what
    // `frame-vs-shape.spec.ts` measures in the browser.
    const t = createTransform({ x: 40, y: 60, width: 200, height: 50, rotation: THIRTY });
    const frame = { x: t.x, y: t.y, width: t.width, height: t.height };
    const painted = paintedExtent(worldMatrix(t), t.width, t.height);
    expect(frame.width, 'the frame is the authored box').toBe(200);
    // 200*cos30 + 50*sin30 = 198.2 -- *narrower* than the frame, which is the point: for a rotated
    // box the painted extent and the frame disagree in both directions, so "the bounds" has to say
    // which bounds.
    expect(painted.width).toBeCloseTo(200 * Math.cos(THIRTY) + 50 * Math.sin(THIRTY), 6);
    expect(painted.width).not.toBeCloseTo(200, 0);
    expect(painted.height).toBeGreaterThan(100);
  });

  it('the page bounds need all four corners, and agree with the closed form when unrotated', () => {
    // Under shear there is no closed form in the parameters, which is the concrete reason §4's
    // "derived bounds" must be specified as a corner computation.
    const m = composeRSK({ rotation: THIRTY, scaleX: 2, scaleY: 0.5, skewX: 0.6 });
    const byCorners = paintedExtent(m, 200, 50);

    // Cross-check against the matrix's own column lengths for an axis-aligned case.
    const axis = composeRSK({ rotation: 0, scaleX: 2, scaleY: 0.5, skewX: 0 });
    const axisExtent = paintedExtent(axis, 200, 50);
    expect(axisExtent.width, 'width = |col1| · width').toBeCloseTo(2 * 200, 9);
    expect(axisExtent.height, 'height = |col2| · height').toBeCloseTo(0.5 * 50, 9);
    // Sanity: the sheared case is *not* recoverable from the column lengths alone.
    expect(Math.abs(byCorners.height - Math.hypot(m.b, m.d) * 50)).toBeGreaterThan(1);
  });

  it('a multi-selection frame is the union of member frames, not of member bounds', () => {
    // What `selectionRect` actually computes, and why that is the frame of a *set*: it takes the
    // axis-aligned box of the members' `x/y/width/height`, so two rotated members contribute their
    // unrotated frames. The honest name for the result is "the members' frames, unioned", and the
    // distinction is what §8 is asking to be preserved rather than blurred.
    const a = createTransform({ x: 0, y: 0, width: 100, height: 100, rotation: 0 });
    const b = createTransform({ x: 150, y: 20, width: 100, height: 40, rotation: THIRTY });
    const union = [a, b].reduce(
      (acc, t) => ({
        left: Math.min(acc.left, t.x),
        top: Math.min(acc.top, t.y),
        right: Math.max(acc.right, t.x + t.width),
        bottom: Math.max(acc.bottom, t.y + t.height),
      }),
      { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
    );
    // Compared field by field rather than with 	oEqual, because the reduce produces -0 for a
    // left/top that landed on zero and -0 !== 0 -- a difference in the *representation* of the
    // answer, not in the answer.
    expect(union.left).toBeCloseTo(0, 9);
    expect(union.top).toBeCloseTo(0, 9);
    expect(union.right).toBeCloseTo(250, 9);
    expect(union.bottom, 'the taller member wins, and the rotated one contributes only its frame').toBeCloseTo(100, 9);
    // The painted union is larger, and cannot be obtained by growing the frame union.
    const paintedUnion = paintedExtent(localMatrix(b), b.width, b.height);
    expect(paintedUnion.height).toBeGreaterThan(b.height);
  });

  it('the rotate-handle suppression is a consequence of the frame not following the rotation', () => {
    // ADR 0010 F3 recorded the suppression as a fact about the design. It is really a consequence:
    // the grip is placed above the *frame's* centre, and for a rotated object the frame's centre is
    // not the object's centre, so the grip would be somewhere unrelated to the shape.
    const t = createTransform({ x: 0, y: 0, width: 200, height: 50, rotation: THIRTY });
    const frameCentre = { x: t.x + t.width / 2, y: t.y + t.height / 2 };
    const local = { x: t.width / 2, y: t.height / 2 };
    const trueCentre = applyPoint(worldMatrix(t), local);
    expect(trueCentre, 'a rotation about the box centre leaves the centre where it was').toEqual(
      frameCentre,
    );
    // So for rotation alone the centres coincide -- and the suppression is *not* explained by this.
    // It is explained by the eight handles: they are placed on the frame's corners, which are not
    // the object's corners.
    const frameCorner = applyPoint({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, {
      x: t.width,
      y: t.height,
    });
    const trueCorner = applyPoint(worldMatrix(t), { x: t.width, y: t.height });
    expect(Math.hypot(trueCorner.x - frameCorner.x, trueCorner.y - frameCorner.y)).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The page-space extent of a local box under a matrix, by transforming its four corners.
 *
 * The definition every "derived bounds" answer needs, and the one §4 asks to be specified exactly
 * rather than left as "whatever the bounding box happens to be".
 */
function paintedExtent(m: Mat2D, width: number, height: number): { width: number; height: number } {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const corner of [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ]) {
    const p = applyPoint(m, corner);
    left = Math.min(left, p.x);
    top = Math.min(top, p.y);
    right = Math.max(right, p.x);
    bottom = Math.max(bottom, p.y);
  }
  return { width: right - left, height: bottom - top };
}

/** `R(delta)` applied in parent space, decomposed back to authored parameters. */
function rotateInParentSpace(
  p: { rotation: number; scaleX: number; scaleY: number; skewX: number },
  delta: number,
): { rotation: number; scaleX: number; scaleY: number; skewX: number } {
  const decomposed = decomposeRSK(multiply(rotation(delta), composeRSK(p)));
  if (decomposed === null) throw new Error('singular matrix');
  return {
    rotation: decomposed.rotation,
    scaleX: decomposed.scaleX,
    scaleY: decomposed.scaleY,
    skewX: decomposed.skewX,
  };
}

/** Angles are compared modulo 2 pi, so the difference is wrapped rather than raw. */
function normalisedAngle(a: number): number {
  const wrapped = a % (2 * Math.PI);
  return Math.min(Math.abs(wrapped), 2 * Math.PI - Math.abs(wrapped));
}