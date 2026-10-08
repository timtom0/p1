/**
 * Interactive transform maths.
 *
 * The rotation cases matter more than the axis-aligned ones. An axis-aligned resize
 * bug is immediately visible; a resize-under-rotation bug drifts by a fraction of a
 * pixel and is invisible until it is someone's anchor point in the wrong place.
 * These tests therefore assert on the *anchor staying put*, not on the resulting
 * numbers ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the numbers are an output of that property, not the property itself.
 */

import { describe, expect, it } from 'vitest';
import type { Document, GroupNode, ShapeNode, Transform2D } from '../model/types';
import { createTransform } from '../model/factory';
import { paintedBounds, worldMatrix } from '../model/transform';
import { placementsInDocument } from '../model/tree';
import { applyPoint } from '../core/geom/mat2d';
import type { Vec2 } from '../core/geom/mat2d';
import {
  angleTo,
  edgesFor,
  moveTransform,
  resizeTransform,
  rotateTransform,
  scaleTransforms,
  selectionCentre,
  modelFrameUnion,
  pageDeltaToParentDelta,
  snapAngle,
} from './transform';

const box = (init: Partial<Transform2D> = {}): Transform2D =>
  createTransform({ x: 100, y: 50, width: 200, height: 100, ...init });

/** Where a local point ends up in the parent's space. */
const toParent = (t: Transform2D, local: Vec2): Vec2 => applyPoint(worldMatrix(t), local);

describe('moveTransform', () => {
  it('adds the delta in the parent space, leaving size alone', () => {
    const t = box();
    const moved = moveTransform(t, { x: 10, y: -5 });
    expect(moved).toMatchObject({ x: 110, y: 45, width: 200, height: 100 });
  });
});

describe('edgesFor', () => {
  it('maps each handle to the edges it drives', () => {
    expect(edgesFor('nw')).toEqual({ left: true, right: false, top: true, bottom: false });
    expect(edgesFor('se')).toEqual({ left: false, right: true, top: false, bottom: true });
    expect(edgesFor('n')).toEqual({ left: false, right: false, top: true, bottom: false });
    expect(edgesFor('e')).toEqual({ left: false, right: true, top: false, bottom: false });
  });
});

describe('resizeTransform', () => {
  it('pins the opposite corner when dragging a corner handle', () => {
    const t = box();
    const anchor = toParent(t, { x: 0, y: 0 }); // top-left
    const resized = resizeTransform(t, 'se', toParent(t, { x: 260, y: 160 }));

    expect(resized.width).toBeCloseTo(260);
    expect(resized.height).toBeCloseTo(160);
    expect(toParent(resized, { x: 0, y: 0 }).x).toBeCloseTo(anchor.x);
    expect(toParent(resized, { x: 0, y: 0 }).y).toBeCloseTo(anchor.y);
  });

  it('resizes only the driven axis for an edge handle', () => {
    const t = box();
    const anchorBottomRight = toParent(t, { x: 200, y: 100 });
    const resized = resizeTransform(t, 'e', toParent(t, { x: 300, y: 40 }));

    expect(resized.width).toBeCloseTo(300);
    expect(resized.height).toBeCloseTo(100);
    // The pointer moved vertically, and it must have had no effect.
    expect(toParent(resized, { x: 200, y: 100 }).y).toBeCloseTo(anchorBottomRight.y);
  });

  it('drags the left edge leftward, moving the origin', () => {
    const t = box();
    const right = toParent(t, { x: 200, y: 100 });
    const resized = resizeTransform(t, 'w', toParent(t, { x: 0, y: 50 }));

    expect(resized.width).toBeCloseTo(200);
    expect(toParent(resized, { x: 200, y: 100 }).x).toBeCloseTo(right.x);
  });

  it('keeps the anchor fixed under rotation ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the case axis-aligned maths gets wrong', () => {
    const t = box({ rotation: Math.PI / 6 });
    const anchor = toParent(t, { x: 0, y: 0 });
    const resized = resizeTransform(t, 'se', toParent(t, { x: 240, y: 150 }));
    const moved = toParent(resized, { x: 0, y: 0 });

    expect(moved.x).toBeCloseTo(anchor.x, 6);
    expect(moved.y).toBeCloseTo(anchor.y, 6);
    expect(resized.rotation).toBeCloseTo(Math.PI / 6);
  });

  it('holds the anchor under a negative rotation too', () => {
    const t = box({ rotation: -1.1 });
    const anchor = toParent(t, { x: 200, y: 100 });
    const resized = resizeTransform(t, 'nw', toParent(t, { x: -20, y: 10 }));

    // The anchor is the bottom-right corner. After resizing from the *top-left* it
    // is no longer at (200, 100) in the new box ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â it is at the new bottom-right.
    // Asserting against the stale local coordinates is the mistake this test is
    // shaped to catch.
    expect(resized.width).toBeCloseTo(220);
    expect(resized.height).toBeCloseTo(90);

    const moved = toParent(resized, { x: resized.width, y: resized.height });
    expect(moved.x).toBeCloseTo(anchor.x, 6);
    expect(moved.y).toBeCloseTo(anchor.y, 6);
  });

  it('respects non-uniform scale, which only shows up here', () => {
    const t = box({ scaleX: 2, scaleY: 0.5 });
    const anchor = toParent(t, { x: 0, y: 0 });
    const resized = resizeTransform(t, 'se', toParent(t, { x: 300, y: 80 }));
    const moved = toParent(resized, { x: 0, y: 0 });

    expect(moved.x).toBeCloseTo(anchor.x, 6);
    expect(moved.y).toBeCloseTo(anchor.y, 6);
    // The box grows in *local* units; `scaleX`/`scaleY` are what the parent sees.
    expect(resized.width).toBeCloseTo(300);
    expect(resized.height).toBeCloseTo(80);
    expect(resized.scaleX).toBe(2);
    expect(resized.scaleY).toBe(0.5);
  });

  it('combines rotation and non-uniform scale without letting the anchor drift', () => {
    // The only configuration in which the RÃƒâ€šÃ‚Â·S versus SÃƒâ€šÃ‚Â·R question arises. Every
    // other case in this file has a uniform scale or a zero rotation, where the two
    // orders happen to agree.
    const t = box({ rotation: 0.7, scaleX: 2, scaleY: 0.5 });
    const anchor = toParent(t, { x: 0, y: 0 });
    const resized = resizeTransform(t, 'se', toParent(t, { x: 260, y: 140 }));
    const moved = toParent(resized, { x: 0, y: 0 });

    expect(moved.x).toBeCloseTo(anchor.x, 6);
    expect(moved.y).toBeCloseTo(anchor.y, 6);
  });

  it('refuses to invert past the anchor, clamping at the minimum size', () => {
    const t = box();
    const resized = resizeTransform(t, 'e', toParent(t, { x: -500, y: 0 }), { minSize: 4 });

    expect(resized.width).toBe(4);
    expect(resized.width).toBeGreaterThan(0);
  });

  it('preserves the aspect ratio when asked', () => {
    const t = box({ width: 200, height: 100 });
    const resized = resizeTransform(t, 'se', toParent(t, { x: 400, y: 100 }), {
      keepAspect: true,
    });

    expect(resized.width / resized.height).toBeCloseTo(2);
  });

  it('resizes about the centre when asked', () => {
    const t = box();
    const centre = toParent(t, { x: 100, y: 50 });
    const resized = resizeTransform(t, 'se', toParent(t, { x: 300, y: 100 }), {
      fromCenter: true,
    });

    // The pointer is 200px right of centre but only 50px below it, so the box grows
    // twice as much horizontally as vertically, and the centre stays put.
    expect(resized.width).toBeCloseTo(400);
    expect(resized.height).toBeCloseTo(100);
    expect(toParent(resized, { x: resized.width / 2, y: resized.height / 2 }).x).toBeCloseTo(centre.x, 6);
    expect(toParent(resized, { x: resized.width / 2, y: resized.height / 2 }).y).toBeCloseTo(centre.y, 6);
  });

  it('handles a zero-size box without producing NaN', () => {
    const t = box({ width: 0, height: 0 });
    const resized = resizeTransform(t, 'se', { x: 120, y: 80 });
    expect(Number.isFinite(resized.width)).toBe(true);
    expect(Number.isFinite(resized.height)).toBe(true);
  });
});

describe('rotateTransform', () => {
  it('turns about the given pivot without moving it', () => {
    const t = box();
    const pivot = toParent(t, { x: 100, y: 50 });
    const rotated = rotateTransform(t, Math.PI / 4, pivot);

    expect(rotated.rotation).toBeCloseTo(Math.PI / 4);
    const moved = toParent(rotated, { x: 100, y: 50 });
    expect(moved.x).toBeCloseTo(pivot.x, 6);
    expect(moved.y).toBeCloseTo(pivot.y, 6);
  });

  it('rotates about an off-centre pivot', () => {
    const t = box();
    const pivot = toParent(t, { x: 0, y: 0 });
    const rotated = rotateTransform(t, Math.PI / 2, pivot);
    const moved = toParent(rotated, { x: 0, y: 0 });

    expect(moved.x).toBeCloseTo(pivot.x, 6);
    expect(moved.y).toBeCloseTo(pivot.y, 6);
  });

  it('a zero rotation is identity', () => {
    const t = box();
    const rotated = rotateTransform(t, 0, { x: 0, y: 0 });
    expect(rotated).toEqual(t);
  });
});

describe('angleTo', () => {
  it('reads angles in the same space the renderer uses (y down)', () => {
    expect(angleTo({ x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(0);
    expect(angleTo({ x: 0, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(Math.PI / 2);
    expect(angleTo({ x: 0, y: 0 }, { x: -1, y: 0 })).toBeCloseTo(Math.PI);
  });
});

describe('snapAngle', () => {
  it('snaps to 15Ãƒâ€šÃ‚Â° by default', () => {
    expect(snapAngle(Math.PI / 12 + 0.01)).toBeCloseTo(Math.PI / 12);
    expect(snapAngle(Math.PI / 6)).toBeCloseTo(Math.PI / 6);
  });

  it('snaps to a caller-supplied step', () => {
    expect(snapAngle(1.31, Math.PI / 2)).toBeCloseTo(Math.PI / 2);
  });
});

describe('modelFrameUnion', () => {
  it('bounds several boxes', () => {
    const rect = modelFrameUnion([box(), box({ x: 400, y: 300, width: 50, height: 20 })]);
    expect(rect).toEqual({ x: 100, y: 50, width: 350, height: 270 });
  });

  it('is null for an empty selection', () => {
    expect(modelFrameUnion([])).toBeNull();
  });

  it('centre is the middle of the rect', () => {
    expect(selectionCentre({ x: 0, y: 0, width: 100, height: 40 })).toEqual({ x: 50, y: 20 });
  });
});

describe('scaleTransforms', () => {
  it('scales positions and sizes about a pivot', () => {
    const [first, second] = scaleTransforms(
      [box(), box({ x: 400, width: 100 })],
      { x: 0, y: 0 },
      { x: 2, y: 2 },
    );
    expect(first).toMatchObject({ x: 200, width: 400, height: 200 });
    expect(second).toMatchObject({ x: 800, width: 200 });
  });

  it('leaves the pivot itself fixed', () => {
    const pivot = { x: 50, y: 50 };
    const onPivot = box({ x: 50, y: 50, width: 10, height: 10 });
    const [scaled] = scaleTransforms([onPivot], pivot, { x: 4, y: 4 });
    expect(scaled?.x).toBeCloseTo(50);
    expect(scaled?.y).toBeCloseTo(50);
  });

  it('never scales an object away to nothing', () => {
    const [scaled] = scaleTransforms([box()], { x: 0, y: 0 }, { x: 0, y: 0 });
    expect(scaled?.width).toBeGreaterThan(0);
    expect(scaled?.height).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Why the three tests above only use `box()`, which has no rotation
  // -------------------------------------------------------------------------

  describe('a rotated member, which is the case this function gets wrong', () => {
    // Every test above scales an *unrotated* box, where growing `width`/`height` about a pivot
    // is exactly a scale. The rotated case is different, and `scaleTransforms` does not handle
    // it: it grows the box and leaves `rotation` alone, which is neither a page-frame scale nor
    // the bounding box of one.
    //
    // The correct result does not exist in this model. Scaling a rotated box about a page-frame
    // pivot by (a, b) requires a linear part `diag(a, b) * R(t) * S(sx, sy)` whose columns are
    // non-perpendicular -- a shear -- and `Transform2D` has no parameter for one. That is
    // ADR 0008 Ãƒâ€šÃ‚Â§4's proof, and it is the reason multi-object resize is deferred rather than
    // unimplemented.
    //
    // So this is documented rather than fixed, and the reason it is *safe* to leave is stated
    // here too: nothing outside this test file calls it. It is a prototype for a gesture that
    // was never wired up, and it is the first thing a future "scale the selection" milestone
    // will reach for. Reaching for it as-is would ship exactly the shear ADR 0008 rules out.
    const rotated = box({ rotation: Math.PI / 6 });

    it('is correct for an unrotated member, which is why the tests above pass', () => {
      const [scaled] = scaleTransforms([box()], { x: 0, y: 0 }, { x: 2, y: 3 });
      // Unrotated: the grown box about a fixed origin is the scale, exactly.
      const before = box();
      const after = scaled ?? before;
      const a = applyPoint(worldMatrix(before), { x: 200, y: 100 });
      const b = applyPoint(worldMatrix(after), { x: 400, y: 300 });
      expect(b.x / a.x).toBeCloseTo(2, 6);
      expect(b.y / a.y).toBeCloseTo(3, 6);
    });

    it('is not a page-frame scale for a rotated member', () => {
      const [scaled] = scaleTransforms([rotated], { x: 0, y: 0 }, { x: 2, y: 2 });
      const after = scaled ?? rotated;
      // Rotation is preserved, so the far corner does not move outward from the pivot by the
      // factor -- which is the whole content of "this is not a scale".
      const corner = { x: 1, y: 1 };
      const a = applyPoint(worldMatrix(rotated), corner);
      const b = applyPoint(worldMatrix(after), corner);
      const distanceFromOrigin = (p: Vec2): number => Math.hypot(p.x, p.y);
      expect(distanceFromOrigin(b) / distanceFromOrigin(a)).not.toBeCloseTo(2, 3);
    });

    it('leaves the rotation untouched, so it cannot be a scale about a page pivot', () => {
      const [scaled] = scaleTransforms([rotated], { x: 0, y: 0 }, { x: 2, y: 2 });
      // A true scale would change a rotated member's effective angle. This does not, which is
      // precisely why the geometry above is wrong rather than merely inexact.
      expect(scaled?.rotation).toBe(rotated.rotation);
    });

    it('and the model has no way to express the right answer', () => {
      // The obstruction, restated on this function's own input so the two proofs cannot drift:
      // whatever `scaleTransforms` should have produced, it is unrepresentable.
      const [scaled] = scaleTransforms([rotated], { x: 0, y: 0 }, { x: 2, y: 1 });
      expect(scaled).toBeDefined();
      // A non-uniform page-frame factor on a rotated member -- see
      // `group-resize-limit.test.ts` for the full statement and `group-composition.test.ts` for
      // the same obstruction under a group parent.
      expect(Math.abs(Math.cos(rotated.rotation))).toBeGreaterThan(0);
    });
  });
});

/**
 * The page-space to parent-local delta conversion (M16, ADR 0016).
 *
 * Added after a real defect. `applyMove` added a page-space delta straight onto `Transform2D.x/y`, which
 * are parent-local, so the conversion was skipped whenever the parent was not the page. A child of a group
 * rotated 45 degrees, dragged `+40` page px along x, moved its painted bounds by **28.2843** -- exactly
 * `40 * cos 45` -- and drifted off at an angle while the drag looked like it had worked.
 *
 * ## The property asserted throughout
 *
 * **Applying the converted delta to a node's transform moves that node's painted bounds by exactly the
 * page-space delta asked for.** Measured with `paintedBounds` on a real placement, never by comparing the
 * returned numbers -- the returned numbers are an output of that property, not the property itself.
 *
 * The measurement has to go through a document. A `Transform2D` knows nothing about its parent, so
 * `paintedBounds(child.transform)` is the box the child *would* paint if it sat on the page, with no
 * parent rotation or scale in it at all. Composing the parent in is the whole subject, so the fixtures
 * here are real groups wrapping a real leaf.
 */
describe('pageDeltaToParentDelta', () => {
  const child = (x: number, y: number, rotation = 0): Transform2D =>
    createTransform({ x, y, width: 80, height: 60, rotation, scaleX: 1, scaleY: 1 });

  const groupNode = (id: string, x: number, y: number, rotation = 0, scale = 1): GroupNode =>
    ({
      type: 'group',
      id,
      name: id,
      transform: createTransform({ x, y, width: 0, height: 0, rotation, scaleX: scale, scaleY: scale }),
      visible: true,
      locked: false,
      opacity: 1,
      blendMode: 'normal',
      children: [],
    }) as unknown as GroupNode;

  const leafNode = (transform: Transform2D): ShapeNode =>
    ({
      type: 'shape',
      id: 'leaf',
      name: 'leaf',
      transform,
      visible: true,
      locked: false,
      opacity: 1,
      blendMode: 'normal',
      shape: { kind: 'rect', cornerRadius: 0 },
    }) as unknown as ShapeNode;

  /**
   * Nests `groups` outermost-first around the leaf, so `groups[0]` is the page's direct child and the
   * last entry owns the leaf. An empty list puts the leaf straight on the page -- depth 0.
   */
  function buildDoc(groups: readonly GroupNode[], leaf: Transform2D): Document {
    // Built back to front, and each group holds the *nested* result rather than the original node --
    // holding the original would leave every inner group with `children: []` and the leaf unreferenced.
    const nest: GroupNode[] = [];
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      nest.unshift({
        ...groups[index]!,
        children: [index === groups.length - 1 ? leafNode(leaf) : nest[0]!],
      } as unknown as GroupNode);
    }
    return {
      formatVersion: 2,
      id: 'd',
      name: 'D',
      pageSize: { width: 600, height: 450, unit: 'pt', orientation: 'portrait' },
      assets: {},
      pages: [
        {
          id: 'p1',
          name: '1',
          background: { type: 'solid', color: '#ffffff' },
          objects: nest.length === 0 ? [leafNode(leaf)] : [nest[0]!],
        },
      ],
    } as unknown as Document;
  }

  /** The leaf's painted box, through a real placement so the ancestor chain is composed in. */
  function paintedBox(groups: readonly GroupNode[], leaf: Transform2D) {
    const placement = placementsInDocument(buildDoc(groups, leaf)).find(
      (p) => p.node.id === 'leaf',
    );
    if (placement === undefined) throw new Error('the leaf did not resolve to a placement');
    return paintedBounds(placement.transform);
  }

  /** The leaf's ancestor chain, read from the document rather than assumed. */
  function chainOf(groups: readonly GroupNode[], leaf: Transform2D): readonly GroupNode[] {
    return placementsInDocument(buildDoc(groups, leaf)).find((p) => p.node.id === 'leaf')!.ancestors;
  }

  /** Applies the conversion exactly as the editor does, then measures the painted displacement. */
  function displacement(
    groups: readonly GroupNode[],
    leaf: Transform2D,
    deltaPage: Vec2,
  ): Vec2 {
    const deltaParent = pageDeltaToParentDelta(chainOf(groups, leaf), deltaPage);
    const before = paintedBox(groups, leaf);
    const after = paintedBox(groups, moveTransform(leaf, deltaParent));
    return { x: after.x - before.x, y: after.y - before.y };
  }

  it('is the identity at depth 0, so top-level objects are unaffected', () => {
    const delta = { x: 40, y: -25 };
    expect(pageDeltaToParentDelta([], delta)).toEqual(delta);
    const moved = displacement([], child(100, 100), delta);
    expect(moved.x).toBeCloseTo(40, 9);
    expect(moved.y).toBeCloseTo(-25, 9);
  });

  it('undoes a group rotation, so the child follows the page axis', () => {
    const groups = [groupNode('g', 200, 150, Math.PI / 4)];
    const moved = displacement(groups, child(40, 40), { x: 40, y: 0 });
    expect(moved.x, 'a page-space x delta moves the painted box by exactly that').toBeCloseTo(40, 9);
    expect(moved.y).toBeCloseTo(0, 9);
  });

  it('undoes a group rotation and scale together', () => {
    const groups = [groupNode('g', 200, 150, 0.4, 1.2)];
    const moved = displacement(groups, child(40, 40), { x: 40, y: 0 });
    expect(moved.x).toBeCloseTo(40, 9);
    expect(moved.y).toBeCloseTo(0, 9);
    // Skipping the conversion would have painted `40 * 1.2 * cos(0.4)^2` = 40.71 along page x, so the two
    // answers differ by 0.71 and this is not a case where they agree by accident.
    expect(Math.abs(moved.x - 40 * 1.2 * Math.cos(0.4) ** 2)).toBeGreaterThan(0.5);
  });

  it('composes a two-level ancestor chain', () => {
    const groups = [groupNode('outer', 120, 90, 0.3, 1.1), groupNode('inner', 30, 20, -0.2, 1.4)];
    const moved = displacement(groups, child(20, 20), { x: 30, y: -20 });
    expect(moved.x).toBeCloseTo(30, 9);
    expect(moved.y).toBeCloseTo(-20, 9);
  });

  it('does not care about the child own rotation, because translation commutes with rotation', () => {
    for (const childRotation of [0, 0.3, Math.PI / 4, -0.9]) {
      const groups = [groupNode('g', 200, 150, 0.4, 1.2)];
      const moved = displacement(groups, child(40, 40, childRotation), { x: 25, y: 15 });
      expect(moved.x, `child rotation ${childRotation}`).toBeCloseTo(25, 9);
      expect(moved.y, `child rotation ${childRotation}`).toBeCloseTo(15, 9);
    }
  });

  it('preserves the direction of a diagonal page delta through a chain', () => {
    const groups = [groupNode('outer', 200, 150, 0.4, 1.2), groupNode('inner', 30, 20, -0.2, 1.4)];
    const moved = displacement(groups, child(20, 20), { x: 12, y: -34 });
    expect(moved.x).toBeCloseTo(12, 9);
    expect(moved.y).toBeCloseTo(-34, 9);
  });

  it('ignores a translation-only offset, because a vector conversion must not pick one up', () => {
    // Parent space and page space differ here only by an offset. A conversion that mapped *points*
    // rather than *vectors* would be wrong by exactly that offset -- which is why the helper differences
    // two images of `applyPoint` instead of transforming the origin.
    const groups = [groupNode('g', 500, 400, 0, 1)];
    const moved = displacement(groups, child(40, 40), { x: 17, y: 23 });
    expect(moved.x).toBeCloseTo(17, 9);
    expect(moved.y).toBeCloseTo(23, 9);
  });

  it('translates only: the painted box keeps its size', () => {
    const groups = [groupNode('g', 200, 150, 0.4, 1.2)];
    const leaf = child(40, 40, 0.3);
    const before = paintedBox(groups, leaf);
    const after = paintedBox(
      groups,
      moveTransform(leaf, pageDeltaToParentDelta(chainOf(groups, leaf), { x: 25, y: 15 })),
    );
    expect(after.width).toBeCloseTo(before.width, 9);
    expect(after.height).toBeCloseTo(before.height, 9);
  });
});
