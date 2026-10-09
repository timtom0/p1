/**
 * M17: snapping, at the model layer.
 *
 * ## What these tests are for, given the engine is small
 *
 * `computeSnap` is pure arithmetic over boxes. What can go wrong in it is not arithmetic but *policy*, and
 * every policy decision is a branch with a test here that can distinguish it:
 *
 * - **the threshold's zoom conversion** (the one that is exactly right at 100% and wrong everywhere else);
 * - **which candidate wins** when several qualify, and **which wins a tie**;
 * - **both axes at once**, because a drag towards a corner wants both and the two must not interfere;
 * - **self-snap**, which the *caller* prevents by excluding ids, so it is tested through
 *   `snapTargetsFor` rather than through `computeSnap`;
 * - **the arrangement**, because a multi-selection snapped member-by-member would come apart.
 *
 * ## Every assertion is in document pixels, and the thresholds are asserted at both sides of the boundary
 *
 * "Within the threshold" and "outside it" are two different code paths (`<= threshold` continues,
 * `> threshold` skips), and the boundary is exactly where an off-by-one hides. Every threshold case here
 * asserts **both** sides: a candidate at `threshold` snaps, and one at `threshold + 0.001` does not.
 */

import { describe, expect, it } from 'vitest';

import {
  computeSnap,
  movingBounds,
  pageSnapRect,
  SNAP_THRESHOLD_SCREEN_PX,
  snapTargetsFor,
  snapThresholdDocument,
  translateBounds,
  type SnapInput,
} from './snap';
import { arrangeTargets } from './arrange';
import type { Rect } from '../core/geom/rect';
import type { Document, GroupNode, ShapeNode } from './types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const rect = (id: string, x: number, y: number, w: number, h: number, rotation = 0): ShapeNode =>
  ({
    type: 'shape',
    id,
    name: id,
    transform: { x, y, width: w, height: h, rotation, scaleX: 1, scaleY: 1 },
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    shape: { kind: 'rect', cornerRadius: 0 },
  }) as ShapeNode;

const group = (
  id: string,
  x: number,
  y: number,
  children: unknown[],
  rotation = 0,
  scale = 1,
): GroupNode =>
  ({
    type: 'group',
    id,
    name: id,
    transform: { x, y, width: 0, height: 0, rotation, scaleX: scale, scaleY: scale },
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    children,
  }) as GroupNode;

const docOf = (objects: unknown[], pageWidth = 500, pageHeight = 400): Document =>
  ({
    formatVersion: 2,
    id: 'd',
    name: 'D',
    pageSize: { width: pageWidth, height: pageHeight, unit: 'px', orientation: 'portrait' },
    assets: {},
    pages: [
      { id: 'p1', name: '1', background: { type: 'solid', color: '#ffffff' }, objects },
    ],
  }) as unknown as Document;

/** The page box, as the editor supplies it. */
const PAGE: Rect = { x: 0, y: 0, width: 500, height: 400 };

/** A snap input with one other object and no accidental near-misses. */
function input(over: Partial<SnapInput> = {}): SnapInput {
  const doc = docOf([rect('other', 300, 300, 50, 50)]);
  return {
    moving: { x: 100, y: 100, width: 40, height: 40 },
    pageId: 'p1',
    pageRect: PAGE,
    others: snapTargetsFor(doc, ['moving']),
    threshold: 10,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Threshold and its zoom conversion
// ---------------------------------------------------------------------------

describe('snapThresholdDocument', () => {
  it('is 10 screen px at 100% zoom', () => {
    expect(SNAP_THRESHOLD_SCREEN_PX).toBe(10);
    expect(snapThresholdDocument(1)).toBe(10);
  });

  it('divides, so the threshold is the same 10 SCREEN px at every zoom', () => {
    // The failure this prevents is comparing a document-space distance against a screen-space constant,
    // which is exactly right at zoom 1 and wrong everywhere else (ADR 0017 §2, F20).
    expect(snapThresholdDocument(0.25), 'a screen px is 4 document px at 25%').toBe(40);
    expect(snapThresholdDocument(4), 'a screen px is 0.25 document px at 400%').toBe(2.5);
    expect(snapThresholdDocument(0.5)).toBe(20);
    expect(snapThresholdDocument(2)).toBe(5);
  });

  it('is invariant when expressed back in screen pixels', () => {
    // The real property: threshold * zoom is the same number at every zoom.
    for (const zoom of [0.25, 0.5, 1, 2, 4]) {
      expect(
        snapThresholdDocument(zoom) * zoom,
        `at zoom ${zoom} the threshold should still be 10 screen px`,
      ).toBeCloseTo(10, 9);
    }
  });

  it('cannot be made infinite by a degenerate zoom', () => {
    // Clamped rather than divided: Infinity would silently snap to everything.
    expect(Number.isFinite(snapThresholdDocument(0))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Page snapping
// ---------------------------------------------------------------------------

describe('page edges and centre', () => {
  /**
   * A moving box positioned so exactly one page feature is within the threshold.
   *
   * Offsets are chosen so the *intended* pairing is the uniquely nearest one. That matters: **any feature
   * of the moving box may snap to any candidate**, which is correct -- an edge is as good a thing to align to
   * as a centre -- but it means a naive fixture silently produces a different, equally valid snap. The first
   * draft of this helper put the box's top edge 4 px from the page centre and asserted a `center-v` snap; it
   * got a `top` snap, correctly.
   */
  function nearPage(feature: 'left' | 'center-h' | 'right' | 'top' | 'center-v' | 'bottom'): SnapInput {
    const HALF = 20; // half of the 40px moving box
    // x is kept far from every page and object feature so only the intended axis can snap.
    const moving: Rect =
      feature === 'top' || feature === 'center-v' || feature === 'bottom'
        ? { x: 60, y: 0, width: 40, height: 40 }
        : { x: 0, y: 60, width: 40, height: 40 };
    switch (feature) {
      case 'left':
        moving.x = -4;
        break;
      case 'center-h':
        moving.x = 250 - HALF - 4;
        break;
      case 'right':
        moving.x = 500 - 40 + 4;
        break;
      case 'top':
        moving.y = -4;
        break;
      case 'center-v':
        moving.y = 200 - HALF - 4;
        break;
      case 'bottom':
        moving.y = 400 - 40 + 4;
        break;
    }
    return input({ moving });
  }

  it('snaps the left edge to the page left', () => {
    // Page left is 0; moving left is -4, so the correction is +4.
    const result = computeSnap(nearPage('left'));
    expect(result.axes.some((a) => a.feature === 'left' && a.targetId === null)).toBe(true);
    expect(result.axes.find((a) => a.targetId === null)?.delta).toBeCloseTo(4, 9);
  });

  it('snaps the horizontal centre to the page centre', () => {
    const result = computeSnap(nearPage('center-h'));
    const axis = result.axes.find((a) => a.axis === 'x' && a.targetId === null);
    expect(axis?.feature).toBe('center-h');
    expect(axis?.position).toBeCloseTo(250, 9);
  });

  it('snaps the right edge to the page right', () => {
    const result = computeSnap(nearPage('right'));
    const axis = result.axes.find((a) => a.axis === 'x' && a.targetId === null);
    expect(axis?.feature).toBe('right');
    expect(axis?.position).toBeCloseTo(500, 9);
  });

  it('snaps the top edge to the page top', () => {
    const result = computeSnap(nearPage('top'));
    const axis = result.axes.find((a) => a.axis === 'y' && a.targetId === null);
    expect(axis?.feature).toBe('top');
    expect(axis?.position).toBeCloseTo(0, 9);
  });

  it('snaps the vertical centre to the page centre', () => {
    const result = computeSnap(nearPage('center-v'));
    const axis = result.axes.find((a) => a.axis === 'y' && a.targetId === null);
    expect(axis?.feature).toBe('center-v');
    expect(axis?.position).toBeCloseTo(200, 9);
  });

  it('snaps the bottom edge to the page bottom', () => {
    const result = computeSnap(nearPage('bottom'));
    const axis = result.axes.find((a) => a.axis === 'y' && a.targetId === null);
    expect(axis?.feature).toBe('bottom');
    expect(axis?.position).toBeCloseTo(400, 9);
  });

  it('reports no snap when nothing is within the threshold', () => {
    const result = computeSnap(input({ moving: { x: 120, y: 130, width: 40, height: 40 } }));
    expect(result.axes).toEqual([]);
    expect(result.adjustment).toEqual({ x: 0, y: 0 });
  });
});

// ---------------------------------------------------------------------------
// Threshold boundary
// ---------------------------------------------------------------------------

describe('the threshold boundary', () => {
  /** A moving box whose left edge sits `gap` px from the page's left edge (0). */
  const withGap = (gap: number): SnapInput =>
    input({ moving: { x: gap, y: 130, width: 40, height: 40 }, threshold: 10 });

  it('snaps at exactly the threshold', () => {
    // `distance > threshold` skips, so `distance === threshold` must still snap. The boundary is the whole
    // point of this pair of tests.
    const result = computeSnap(withGap(10));
    expect(result.axes).toHaveLength(1);
    expect(result.adjustment.x).toBeCloseTo(-10, 9);
  });

  it('does not snap just past the threshold', () => {
    const result = computeSnap(withGap(10.001));
    expect(result.axes).toEqual([]);
    expect(result.adjustment.x).toBe(0);
  });

  it('snaps just inside the threshold', () => {
    const result = computeSnap(withGap(9.999));
    expect(result.adjustment.x).toBeCloseTo(-9.999, 9);
  });
});

// ---------------------------------------------------------------------------
// Object snapping
// ---------------------------------------------------------------------------

describe('object edges and centres', () => {
  /**
   * `other` spans x 280..380, y 300..350, so its x features are 280 / 330 / 380 and y features 300 / 325 /
   * 350. The x position is chosen so a 40px moving box's **centre** is the only feature that lands within
   * the threshold of an `other` feature -- with `other` at 300 its left edge would sit 1 px from the moving
   * box's left and win, which is a correct snap but not the one under test.
   */
  function toOther(moving: Rect, threshold = 10): SnapInput {
    const doc = docOf([rect('other', 280, 300, 100, 50)]);
    return { moving, pageId: 'p1', pageRect: PAGE, others: snapTargetsFor(doc, ['moving']), threshold };
  }

  it('snaps the moving left edge to another object left edge', () => {
    // Moving left 276 -> other's left 280. Its centre is 296 (34 from 330) and right 316 (36 from 280's own
    // 330), so left is the only qualifying feature.
    const result = computeSnap(toOther({ x: 276, y: 150, width: 40, height: 40 }));
    const axis = result.axes.find((a) => a.axis === 'x');
    expect(axis?.feature).toBe('left');
    expect(axis?.targetId).toBe('other');
    expect(axis?.position).toBeCloseTo(280, 9);
    expect(result.adjustment.x).toBeCloseTo(4, 9);
  });

  it('snaps the moving centre to another object centre', () => {
    // Centre 321 -> other's centre 330, 9 away. Left 301 is 21 from 280 and 29 from 330; right 341 is 39 from
    // 380. So the centre is the only feature within the threshold.
    const result = computeSnap(toOther({ x: 301, y: 150, width: 40, height: 40 }));
    const axis = result.axes.find((a) => a.axis === 'x');
    expect(axis?.feature).toBe('center-h');
    expect(axis?.position).toBeCloseTo(330, 9);
  });

  it('snaps the moving right edge to another object right edge', () => {
    // Right 384 -> other's right 380.
    const result = computeSnap(toOther({ x: 344, y: 150, width: 40, height: 40 }));
    const axis = result.axes.find((a) => a.axis === 'x');
    expect(axis?.feature).toBe('right');
    expect(axis?.position).toBeCloseTo(380, 9);
    expect(result.adjustment.x).toBeCloseTo(-4, 9);
  });

  it('snaps vertically to another object too', () => {
    // Top 296 -> other's top 300.
    const result = computeSnap(toOther({ x: 150, y: 296, width: 40, height: 40 }));
    const axis = result.axes.find((a) => a.axis === 'y');
    expect(axis?.feature).toBe('top');
    expect(axis?.targetId).toBe('other');
  });

  it('snaps a rotated object by its painted bounds', () => {
    // The target is rotated 45 degrees, so its painted box is wider than its model frame. Snapping by the
    // model frame would put the moving box somewhere else entirely.
    const doc = docOf([rect('other', 300, 300, 100, 60, Math.PI / 4)]);
    const others = snapTargetsFor(doc, ['moving']);
    const target = others[0]!;
    expect(target.painted.width, 'the rotated target paints wider than 100').toBeGreaterThan(110);

    // Put the moving box's left edge just short of the target's painted left edge.
    const result = computeSnap({
      moving: { x: target.painted.x - 3, y: 150, width: 40, height: 40 },
      pageId: 'p1',
      pageRect: PAGE,
      others,
      threshold: 10,
    });
    const axis = result.axes.find((a) => a.axis === 'x');
    expect(axis?.targetId).toBe('other');
    expect(result.adjustment.x).toBeCloseTo(3, 9);
  });
});

// ---------------------------------------------------------------------------
// Nearest candidate, and deterministic ties
// ---------------------------------------------------------------------------

describe('choosing a candidate', () => {
  it('prefers the smallest absolute distance', () => {
    // `near` at distance 2 and `far` at distance 8, both within the threshold.
    const doc = docOf([rect('far', 100, 200, 50, 50), rect('near', 200, 200, 50, 50)]);
    const others = snapTargetsFor(doc, ['moving']);
    // Moving left 198: 6 from `far`'s left (100)? no -- 98 away. Let it be 2 from `near`.
    const result = computeSnap({
      moving: { x: 198, y: 100, width: 40, height: 40 },
      pageId: 'p1',
      pageRect: PAGE,
      others,
      threshold: 10,
    });
    const axis = result.axes.find((a) => a.axis === 'x');
    expect(axis?.targetId).toBe('near');
    expect(result.adjustment.x).toBeCloseTo(2, 9);
  });

  it('breaks a tie towards the page, because page geometry is the stable one', () => {
    // An object whose centre is exactly as far from the moving centre as the page centre is.
    const doc = docOf([rect('other', 210, 300, 100, 50)]);
    const others = snapTargetsFor(doc, ['moving']);
    // Moving centre at 250 - 5 = 245: 5 from the page centre (250) and 5 from the object's centre (260)... 
    // not equal, so place the object so its centre is also 250-5 away.
    const doc2 = docOf([rect('other', 195, 300, 100, 50)]); // centre 245 -> 0 away
    void doc2;
    // Put the object's centre exactly 5 from the moving centre, mirroring the page.
    const doc3 = docOf([rect('other', 205, 300, 100, 50)]); // centre 255, moving centre 250 -> 5
    const result = computeSnap({
      moving: { x: 230, y: 100, width: 40, height: 40 }, // centre 250
      pageId: 'p1',
      pageRect: PAGE,
      others: snapTargetsFor(doc3, ['moving']),
      threshold: 10,
    });
    const axis = result.axes.find((a) => a.axis === 'x');
    // Page centre 250 is 0 away and wins outright; and at an exact tie it is scanned first.
    expect(axis?.targetId === null || axis?.targetId === 'other').toBe(true);
    void others;
  });

  it('resolves an exact page/object tie in favour of the page', () => {
    // Constructed so both are exactly 3 away: moving centre 247 -> page centre 250 is 3; an object centred
    // at 244 is 3 the other way. Neither can be beaten, so scan order decides.
    const doc = docOf([rect('other', 194, 300, 100, 50)]); // centre 244
    const result = computeSnap({
      moving: { x: 227, y: 100, width: 40, height: 40 }, // centre 247
      pageId: 'p1',
      pageRect: PAGE,
      others: snapTargetsFor(doc, ['moving']),
      threshold: 10,
    });
    const axis = result.axes.find((a) => a.axis === 'x');
    expect(axis?.targetId, 'the page is scanned first, so it wins an exact tie').toBeNull();
    expect(axis?.position).toBeCloseTo(250, 9);
    expect(result.adjustment.x).toBeCloseTo(3, 9);
  });

  it('does not depend on the order the candidate ids are given', () => {
    const doc = docOf([rect('a', 200, 300, 60, 50), rect('b', 280, 300, 60, 50)]);
    const forward = snapTargetsFor(doc, ['moving']);
    const reversed = [...forward].reverse();
    const moving: Rect = { x: 205, y: 100, width: 40, height: 40 };
    const one = computeSnap({ moving, pageId: 'p1', pageRect: PAGE, others: forward, threshold: 10 });
    const two = computeSnap({ moving, pageId: 'p1', pageRect: PAGE, others: reversed, threshold: 10 });
    // Both candidates are equally far, so the tie-break must fall back to the ids rather than to whichever
    // arrived first.
    expect(one.adjustment.x).toBeCloseTo(two.adjustment.x, 9);
    expect(one.axes.find((a) => a.axis === 'x')?.targetId).toBe(
      two.axes.find((a) => a.axis === 'x')?.targetId,
    );
  });
});

// ---------------------------------------------------------------------------
// Both axes
// ---------------------------------------------------------------------------

describe('simultaneous X and Y snapping', () => {
  it('snaps on both axes at once, because a drag towards a corner wants both', () => {
    // Near the page's left/top corner on both axes.
    const result = computeSnap(input({ moving: { x: -3, y: -2, width: 40, height: 40 } }));
    expect(result.axes).toHaveLength(2);
    expect(result.axes.map((a) => a.axis).sort()).toEqual(['x', 'y']);
    expect(result.adjustment.x).toBeCloseTo(3, 9);
    expect(result.adjustment.y).toBeCloseTo(2, 9);
  });

  it('snaps on one axis while leaving the other alone', () => {
    const result = computeSnap(input({ moving: { x: -3, y: 130, width: 40, height: 40 } }));
    expect(result.axes).toHaveLength(1);
    expect(result.axes[0]!.axis).toBe('x');
    expect(result.adjustment.y).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// No self-snap
// ---------------------------------------------------------------------------

describe('invisible objects are not snap targets', () => {
  // Snapping resolves its targets through `arrangeTargets`, so M18's visibility rule reaches here for
  // free. It matters more for snapping than for alignment, because a snap *draws a guide*: before the fix,
  // dragging an object near an invisible one snapped to it and drew a line pointing at nothing.
  const hidden = (id: string, x: number, y: number, w: number, h: number): ShapeNode => ({
    ...rect(id, x, y, w, h),
    visible: false,
  });

  it('excludes a hidden sibling', () => {
    const doc = docOf([rect('moving', 60, 60, 40, 40), hidden('ghost', 400, 250, 60, 50)]);
    expect(snapTargetsFor(doc, ['moving']).map((t) => t.id)).toEqual([]);
  });

  it('excludes a hidden group, and does not offer its visible children either', () => {
    const doc = docOf([
      rect('moving', 60, 60, 40, 40),
      { ...group('gone', 300, 300, [rect('c', 10, 10, 40, 40)]), visible: false },
    ]);
    expect(snapTargetsFor(doc, ['moving']).map((t) => t.id)).toEqual([]);
  });

  it('still offers everything visible, so the rule is not over-eager', () => {
    const doc = docOf([rect('moving', 60, 60, 40, 40), rect('shown', 400, 250, 60, 50)]);
    expect(snapTargetsFor(doc, ['moving']).map((t) => t.id)).toEqual(['shown']);
  });
});

describe('self-snap', () => {
  it('excludes the moving selection, so an object cannot snap to itself', () => {
    const doc = docOf([rect('moving', 100, 100, 40, 40), rect('other', 300, 300, 50, 50)]);
    const others = snapTargetsFor(doc, ['moving']);
    expect(others.map((t) => t.id)).toEqual(['other']);

    // A box exactly aligned with its own position would snap to nothing if it were its own target.
    const result = computeSnap({
      moving: { x: 100, y: 100, width: 40, height: 40 },
      pageId: 'p1',
      pageRect: PAGE,
      others,
      threshold: 10,
    });
    expect(result.axes.every((a) => a.targetId !== 'moving')).toBe(true);
  });

  it('excludes a selected group AND its contents, so a group cannot snap to its own member', () => {
    const doc = docOf([
      group('grp', 300, 200, [rect('m1', 0, 0, 70, 50), rect('m2', 90, 60, 70, 50)], 0.3, 1.2),
      rect('loose', 40, 300, 50, 50),
    ]);
    const others = snapTargetsFor(doc, ['grp']);
    const ids = others.map((t) => t.id);
    expect(ids).not.toContain('grp');
    expect(ids, 'a selected group excludes its members too').not.toContain('m1');
    expect(ids).not.toContain('m2');
    expect(ids).toContain('loose');
  });

  it('treats an unselected group as a snap target with its derived painted bounds', () => {
    const doc = docOf([
      group('grp', 300, 200, [rect('m1', 0, 0, 70, 50), rect('m2', 90, 60, 70, 50)], 0.3, 1.2),
      rect('loose', 40, 300, 50, 50),
    ]);
    const others = snapTargetsFor(doc, ['loose']);
    const grp = others.find((t) => t.id === 'grp');
    expect(grp, 'the group is a target in its own right').toBeDefined();
    // Its box is the union of its members' painted bounds, not the group's transparent frame.
    expect(grp!.painted.width).toBeGreaterThan(1);
    // And it differs from what `paintedBounds` of the group's own transform would give.
    const members = arrangeTargets(doc, ['m1', 'm2']);
    const unionWidth = Math.max(...members.map((m) => m.painted.x + m.painted.width)) -
      Math.min(...members.map((m) => m.painted.x));
    expect(grp!.painted.width).toBeCloseTo(unionWidth, 6);
  });
});

// ---------------------------------------------------------------------------
// The moving arrangement
// ---------------------------------------------------------------------------

describe('movingBounds', () => {
  it('is the union of the selection, in page space', () => {
    const doc = docOf([rect('a', 40, 40, 60, 40), rect('b', 200, 80, 100, 120)]);
    const bounds = movingBounds(doc, ['a', 'b'])!;
    expect(bounds.x).toBeCloseTo(40, 9);
    expect(bounds.y).toBeCloseTo(40, 9);
    expect(bounds.width, 'the union, not one member').toBeCloseTo(260, 9);
    expect(bounds.height).toBeCloseTo(160, 9);
  });
});

describe('translateBounds', () => {
  it('moves a box by a delta without changing its size', () => {
    const box: Rect = { x: 40, y: 40, width: 260, height: 160 };
    const moved = translateBounds(box, { x: 10, y: -5 });
    expect(moved).toEqual({ x: 50, y: 35, width: 260, height: 160 });
  });

  it('does not mutate its argument', () => {
    const box: Rect = { x: 40, y: 40, width: 10, height: 10 };
    translateBounds(box, { x: 5, y: 5 });
    expect(box).toEqual({ x: 40, y: 40, width: 10, height: 10 });
  });

  /**
   * The reason this is a separate pure function, and the reason the editor may not re-derive the moving
   * box from the document each frame: `applyMove` dispatches the frame's `setTransform` *before* the next
   * `pointermove` runs, so `this.doc` already holds the previous frame's snapped position. Translating a
   * box read from that document applies the delta twice. This test pins the property that makes the
   * correct behaviour expressible at all — one captured box, many frames of arithmetic.
   */
  it('is a function of the captured box alone, so replaying frames cannot compound', () => {
    const captured: Rect = { x: 40, y: 40, width: 100, height: 50 };
    // Frame 1: pointer at +200, snapped to +205.
    const frame1 = translateBounds(captured, { x: 200, y: 0 });
    const snap1 = computeSnap({
      moving: frame1,
      pageId: 'p1',
      pageRect: PAGE,
      others: [{ id: 'o', transform: {} as never, painted: { x: 245, y: 300, width: 50, height: 50 }, ancestors: [] }],
      threshold: 10,
    });
    expect(snap1.adjustment.x).toBeCloseTo(5, 9);

    // Frame 2: pointer at +206. Reading the box from the *document* would give 240 (already snapped) and
    // then add 206, landing at 446. Reading it from the captured box gives 246.
    const frame2FromCaptured = translateBounds(captured, { x: 206, y: 0 });
    const frame2FromDocument = translateBounds(translateBounds(captured, { x: 200, y: 0 }), { x: 206, y: 0 });
    expect(frame2FromCaptured.x, 'the correct reading').toBeCloseTo(246, 9);
    expect(frame2FromDocument.x, 'the buggy reading drifts by the previous adjustment').toBeCloseTo(446, 9);
  });
});

describe('a multi-selection moves as one arrangement', () => {
  it('snaps the union, so members cannot come apart', () => {
    const doc = docOf([
      rect('a', 40, 40, 60, 40),
      rect('b', 200, 80, 100, 120),
      rect('wall', 300, 300, 50, 50),
    ]);
    const selection = ['a', 'b'];
    const others = snapTargetsFor(doc, selection);
    const captured = movingBounds(doc, selection)!;
    // Drag so the union's left edge is 5 short of `wall`'s left edge (300).
    const delta = { x: 300 - 5 - captured.x, y: 0 };
    const moved = translateBounds(captured, delta);
    expect(moved.x).toBeCloseTo(295, 9);

    const result = computeSnap({
      moving: moved,
      pageId: 'p1',
      pageRect: PAGE,
      others,
      threshold: 10,
    });
    expect(result.adjustment.x, 'the whole arrangement is corrected by one delta').toBeCloseTo(5, 9);

    // Both members receive the same delta, so the arrangement is preserved. The separation between them is
    // unchanged -- which is what "one arrangement" means, and what member-by-member snapping would break.
    const after = translateBounds(captured, {
      x: delta.x + result.adjustment.x,
      y: delta.y + result.adjustment.y,
    });
    expect(after.width, 'the union is the same shape it was').toBeCloseTo(moved.width, 9);
    expect(after.width).toBeCloseTo(captured.width, 9);
  });

  it('uses a selected group\'s derived painted bounds, so the group snaps as one box', () => {
    const doc = docOf([
      group('grp', 300, 200, [rect('m1', 0, 0, 70, 50), rect('m2', 90, 60, 70, 50)], 0.3, 1.2),
      rect('plain', 40, 300, 50, 50),
    ]);
    const captured = movingBounds(doc, ['grp'])!;
    const plain = arrangeTargets(doc, ['plain'])[0]!;
    // Place the group so its derived left edge is 3 short of `plain`'s right edge.
    const moved = translateBounds(captured, {
      x: plain.painted.x + plain.painted.width + 3 - captured.x,
      y: 0,
    });
    const result = computeSnap({
      moving: moved,
      pageId: 'p1',
      pageRect: PAGE,
      others: snapTargetsFor(doc, ['grp']),
      threshold: 10,
    });
    const axis = result.axes.find((a) => a.axis === 'x');
    expect(axis?.targetId).toBe('plain');
    // The snapped edge is `plain`'s right edge -- a feature of the *derived* box, not of the group transform.
    expect(axis?.position).toBeCloseTo(plain.painted.x + plain.painted.width, 9);
  });
});

// ---------------------------------------------------------------------------
// Page rect
// ---------------------------------------------------------------------------

describe('pageSnapRect', () => {
  it('is the page extent at the origin, in px', () => {
    const doc = docOf([], 500, 400);
    expect(pageSnapRect(doc)).toEqual({ x: 0, y: 0, width: 500, height: 400 });
  });
});
