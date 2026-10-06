/**
 * Creation geometry (ADR 0005 §6).
 *
 * Unit tests because every question here is pure: given a drag, what rect should be
 * committed? The browser only matters for whether that rect *looks* right, which the
 * shape suite checks separately — and if these answers were wrong, a browser test would
 * fail for a reason three layers away.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CREATED_EXTENT,
  MIN_CREATED_EXTENT,
  creationIndex,
  creationRect,
  createShapeFor,
  defaultStroke,
  imagePlacementRect,
} from './creation';
import { shapeHasInterior } from './shapes';
import type { ShapeKind } from './types';

const at = (x: number, y: number) => ({ x, y });

describe('a drag produces the rect the user drew', () => {
  it('is normalised, so dragging up-and-left still yields a positive box', () => {
    // A negative width is not representable in CSS -- it computes to 0px -- so a
    // non-normalised rect would silently commit a zero-sized object the user cannot
    // select. `rectFromPoints` is the same helper the marquee uses, so there is one
    // normalisation rather than two.
    const rect = creationRect(at(300, 250), at(100, 50), 'rect', true);
    expect(rect).toEqual({ x: 100, y: 50, width: 200, height: 200 });
  });

  it('is exactly the dragged distance, with no snapping or rounding', () => {
    // No snapping exists yet (§3.6 owns it). The value has to arrive verbatim or the
    // preview rect and the committed rect would differ, which is the bug the shared
    // `normaliseRect` call is there to prevent.
    const rect = creationRect(at(37.5, 11.25), at(112.25, 66.75), 'rect', true);
    expect(rect).toEqual({ x: 37.5, y: 11.25, width: 74.75, height: 55.5 });
  });
});

describe('creation refuses to make an object that cannot be selected', () => {
  it('rejects a filled shape with no width or height', () => {
    // A zero-extent box is not hit-testable by the browser (measured) and, with the
    // editor's own predicates, effectively not reachable by click either. Committing one
    // would put an object on the page the user could not then select.
    expect(creationRect(at(100, 100), at(100, 100), 'rect', true)).toBeNull();
    expect(creationRect(at(100, 100), at(130, 100), 'rect', true)).toBeNull();
    expect(creationRect(at(100, 100), at(100, 130), 'rect', true)).toBeNull();
  });

  it('rejects a drag below the minimum extent, and accepts one at it', () => {
    const just = MIN_CREATED_EXTENT - 0.5;
    const exact = MIN_CREATED_EXTENT;
    expect(creationRect(at(0, 0), at(just, exact), 'rect', true)).toBeNull();
    expect(creationRect(at(0, 0), at(exact, exact), 'rect', true)).toEqual({
      x: 0,
      y: 0,
      width: exact,
      height: exact,
    });
  });

  it('exempts a line from the vertical minimum, because a flat line is a line', () => {
    // A horizontal line has height 0 by definition. Applying the vertical minimum to it
    // would mean "no horizontal lines", which is not a limitation anyone asked for.
    expect(creationRect(at(0, 50), at(200, 50), 'line', true)).toEqual({
      x: 0,
      y: 50,
      width: 200,
      height: 0,
    });
  });

  it('still rejects a line with no width, which is not a line', () => {
    expect(creationRect(at(0, 0), at(0, 200), 'line', true)).toBeNull();
  });
});

describe('a click creates a default-sized object', () => {
  it('for the kinds that need an extent', () => {
    for (const kind of ['rect', 'ellipse'] as ShapeKind[]) {
      const rect = creationRect(at(70, 90), at(70, 90), kind, false);
      expect(rect).toEqual({
        x: 70,
        y: 90,
        width: DEFAULT_CREATED_EXTENT,
        height: DEFAULT_CREATED_EXTENT,
      });
    }
  });

  it('but not for a line, which needs two points', () => {
    // A "default line" has no defensible direction or length, so inventing one would be
    // a guess. Refusing is honest and matches every editor that requires a drag for a
    // straight segment.
    expect(creationRect(at(70, 90), at(70, 90), 'line', false)).toBeNull();
  });
});

describe('a created node is visible and complete', () => {
  it('fills the kinds that have an interior', () => {
    for (const kind of ['rect', 'ellipse'] as ShapeKind[]) {
      const node = createShapeFor(kind, { x: 0, y: 0, width: 10, height: 10 });
      expect(node.fill).toEqual({ type: 'solid', color: '#4f7cff' });
      expect(shapeHasInterior(kind)).toBe(true);
    }
  });

  it('gives a line a stroke, because a line with no stroke is invisible', () => {
    const node = createShapeFor('line', { x: 0, y: 0, width: 100, height: 0 });
    expect(node.fill).toBeUndefined();
    expect(node.stroke?.width).toBeGreaterThan(0);
    expect(node.stroke?.align).toBe('inside');
  });

  it('records the requested rect as the transform, not as loose fields', () => {
    const node = createShapeFor('ellipse', { x: 12.5, y: 30, width: 44, height: 22 });
    expect(node.transform).toMatchObject({ x: 12.5, y: 30, width: 44, height: 22 });
    // The rest of the transform keeps the factory's defaults, so a created object is
    // identical to one the factory made and then moved.
    expect(node.transform.rotation).toBe(0);
    expect(node.transform.scaleX).toBe(1);
    expect(node.transform.scaleY).toBe(1);
  });

  it('lets an override replace a default without dropping the other one', () => {
    const node = createShapeFor(
      'rect',
      { x: 0, y: 0, width: 10, height: 10 },
      { fill: { type: 'solid', color: '#ff0000' } },
    );
    expect(node.fill).toEqual({ type: 'solid', color: '#ff0000' });
  });
});

describe('shared defaults are copied, not aliased', () => {
  it('hands out a fresh stroke every call', () => {
    // `defaultStroke()` is read by the inspector when a user types a weight onto an
    // object that has no stroke. If it returned the shared object, one object's stroke
    // paint would become the default for every later object.
    const first = defaultStroke();
    const second = defaultStroke();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.paint).not.toBe(second.paint);
  });
});

describe('a new object goes on top of everything already on the page', () => {
  it('lands at the end of the paint order', () => {
    // Not "after the selected object": that would put a shape drawn over another one
    // *under* it, which reads as the draw having failed.
    expect(creationIndex(0)).toBe(0);
    expect(creationIndex(7)).toBe(7);
  });
});

describe('a new image is placed at its intrinsic size, centred on the point', () => {
  const page = { width: 600, height: 400 };

  it('when it fits, with no arithmetic at all', () => {
    // The common case: the image is smaller than the page, so it is placed exactly as big
    // as it is. Anything else would mean the user resizes it before it is correct.
    expect(imagePlacementRect({ width: 120, height: 80 }, { x: 300, y: 200 }, page)).toEqual({
      x: 240,
      y: 160,
      width: 120,
      height: 80,
    });
  });

  it('and it needs no measurement to do so', () => {
    // The size came from `decode()` at import. There is no layout read anywhere in this
    // function, which is why inserting an image cannot produce a `stale` document.
    const placed = imagePlacementRect({ width: 1200, height: 800 }, { x: 300, y: 200 }, page);
    expect(placed.width).toBe(placed.height * 1.5);
  });

  it('scaled by a uniform factor when it does not fit, so the ratio is exact', () => {
    // 800x400 on a 600x400 page: the factor is 600/800 = 0.75, giving 600x300.
    const placed = imagePlacementRect({ width: 800, height: 400 }, { x: 300, y: 200 }, page);
    expect(placed.width).toBe(600);
    expect(placed.height).toBe(300);
    expect(placed.width / placed.height).toBe(2);
  });

  it('constrained by whichever axis binds first', () => {
    // Tall rather than wide: 100x800 on a 600x400 page is limited by height (0.5), not
    // width. Getting this backwards would produce a box wider than the page.
    const placed = imagePlacementRect({ width: 100, height: 800 }, { x: 300, y: 200 }, page);
    expect(placed.height).toBe(400);
    expect(placed.width).toBe(50);
  });

  it('still centred, after scaling', () => {
    const placed = imagePlacementRect({ width: 800, height: 400 }, { x: 300, y: 200 }, page);
    expect(placed.x + placed.width / 2).toBe(300);
    expect(placed.y + placed.height / 2).toBe(200);
  });

  it('leaving the image alone on a page with no area', () => {
    // A degenerate page must not produce a `0x0` image, which would be an object the user
    // could not select.
    const placed = imagePlacementRect({ width: 120, height: 80 }, { x: 10, y: 10 }, {
      width: 0,
      height: 0,
    });
    expect(placed.width).toBe(120);
    expect(placed.height).toBe(80);
  });
});