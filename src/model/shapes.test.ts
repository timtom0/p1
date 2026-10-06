import { describe, expect, it } from 'vitest';
import {
  isGeometry,
  layoutBoxOf,
  shapeContainsPoint,
  shapeKinds,
  shapeLabel,
  shapeNeedsExtent,
  shapeSpec,
} from './shapes';
import type { ShapeKind, ShapeNode } from './types';
import { createShapeNode } from './factory';

/**
 * The shape registry's geometry predicates (ADR 0005 §4).
 *
 * These are the answers to "what does the editor consider selectable", and they are the
 * half of the hit-testing contract that does not need a browser. The other half — that
 * Chromium agrees — is in `tests/editor/shapes.spec.ts`.
 */

/** A shape of `kind` occupying a `width`×`height` local box, with an optional stroke. */
function shape(
  kind: ShapeKind,
  width: number,
  height: number,
  strokeWidth?: number,
): ShapeNode {
  const node = createShapeNode(kind);
  node.transform = { ...node.transform, width, height };
  if (strokeWidth !== undefined) {
    node.stroke = { paint: { type: 'solid', color: '#000' }, width: strokeWidth, align: 'inside' };
  }
  return node;
}

/** Whether a local point hits the shape. */
function hits(node: ShapeNode, x: number, y: number): boolean {
  return shapeContainsPoint(node, { x, y }, layoutBoxOf(node));
}

describe('the registry is total over the kind union', () => {
  it('has an entry for every kind, and no others', () => {
    // The compile-time half is `Record<ShapeKind, ShapeKindSpec>`; this is the runtime
    // half, and it is what catches a kind added to the union but not to the table by a
    // cast or by `Object.keys` losing an entry.
    expect([...shapeKinds()].sort()).toEqual(['ellipse', 'line', 'rect']);
    for (const kind of shapeKinds()) {
      expect(shapeSpec(kind).kind).toBe(kind);
      expect(shapeLabel(kind)).not.toBe('');
    }
  });
});

describe('rect hit testing is the box, with no tolerance', () => {
  it('accepts a point inside, including the exact edges', () => {
    const rect = shape('rect', 100, 50);
    expect(hits(rect, 50, 25)).toBe(true);
    expect(hits(rect, 0, 0)).toBe(true);
    expect(hits(rect, 100, 50)).toBe(true);
  });

  it('rejects a point one pixel outside any edge', () => {
    // Negative control for the edge cases above: if the predicate used `>=`/`<=` on the
    // wrong side, or widened by a tolerance, exactly one of these would flip.
    const rect = shape('rect', 100, 50);
    expect(hits(rect, -0.5, 25)).toBe(false);
    expect(hits(rect, 100.5, 25)).toBe(false);
    expect(hits(rect, 50, -0.5)).toBe(false);
    expect(hits(rect, 50, 50.5)).toBe(false);
  });

  it('ignores a stroke width, because a box has no ring to widen', () => {
    // ADR 0005 §4: only a line's tolerance comes from its stroke. A rectangle's visible
    // extent *is* its box, so widening here would make the editor disagree with Chromium
    // on the one shape where the two currently agree exactly.
    const thin = shape('rect', 100, 50, 1);
    const fat = shape('rect', 100, 50, 40);
    expect(hits(thin, 50, 25)).toBe(hits(fat, 50, 25));
    expect(hits(fat, 101, 25)).toBe(false);
  });
});

describe('ellipse hit testing is the inscribed ellipse, not its box', () => {
  it('accepts the centre and the ends of the axes', () => {
    const ellipse = shape('ellipse', 200, 100);
    expect(hits(ellipse, 100, 50)).toBe(true);
    expect(hits(ellipse, 0, 50)).toBe(true);
    expect(hits(ellipse, 200, 50)).toBe(true);
    expect(hits(ellipse, 100, 0)).toBe(true);
    expect(hits(ellipse, 100, 100)).toBe(true);
  });

  it('rejects the corners, which the box predicate would accept', () => {
    // The discriminating assertion. A box hit test passes every point here; only the
    // unit-circle test rejects them. If this ever fails, hit testing has regressed to
    // the box and the editor and the browser have started disagreeing.
    const ellipse = shape('ellipse', 200, 100);
    expect(hits(ellipse, 2, 2)).toBe(false);
    expect(hits(ellipse, 198, 2)).toBe(false);
    expect(hits(ellipse, 2, 98)).toBe(false);
    expect(hits(ellipse, 198, 98)).toBe(false);
  });

  it('rejects a point just past the curve on the diagonal', () => {
    // The ellipse is 2:1, so on the 45-degree diagonal the curve passes through
    // (0.6, 0.6) in normalised coordinates and nowhere near (0.8, 0.8). Both probes are
    // well inside the *box*, so only the unit-circle test can tell them apart.
    const ellipse = shape('ellipse', 200, 100);
    expect(hits(ellipse, 160, 80)).toBe(true);
    expect(hits(ellipse, 180, 90)).toBe(false);
  });

  it('falls back to the box when a dimension is zero, rather than dividing by it', () => {
    // A flat ellipse is a line segment; the normalised form has to say so rather than
    // producing NaN, which would compare false against everything and make the object
    // unselectable — the worst possible failure, because it looks like "clicking misses".
    const flat = shape('ellipse', 100, 0);
    expect(hits(flat, 50, 0)).toBe(true);
    expect(hits(flat, 150, 0)).toBe(false);
  });
});

describe('line hit testing is distance to the segment, within half the stroke', () => {
  it('accepts a point on the segment and rejects one a full stroke-width away', () => {
    const line = shape('line', 200, 100, 6);
    expect(hits(line, 0, 0)).toBe(true);
    expect(hits(line, 200, 100)).toBe(true);
    expect(hits(line, 100, 50)).toBe(true);
    // The segment has slope 0.5, so a *vertical* offset is not the perpendicular
    // distance: dividing by sqrt(1 + 0.25) puts 2px of vertical offset at 1.79px of
    // perpendicular distance (inside 3) and 5px at 4.47px (outside). Asserting the
    // vertical offsets directly would be asserting the wrong quantity.
    expect(hits(line, 100, 52)).toBe(true);
    expect(hits(line, 100, 55)).toBe(false);
  });

  it('is reachable when the box has zero height, which the browser cannot manage', () => {
    // ADR 0005 §5: Chromium cannot hit-test a zero-extent box at all (measured), so a
    // horizontal line would be ungrabbable. This is the assertion that pins the one
    // deliberate disagreement between the editor and the browser.
    const line = shape('line', 200, 0, 6);
    expect(hits(line, 100, 0)).toBe(true);
    expect(hits(line, 100, 2.9)).toBe(true);
    expect(hits(line, 100, 20)).toBe(false);
  });

  it('gives a stroke-less line a minimum grab width, so it is not unclickable', () => {
    // A bare line has nothing painted, but a user who drew one must still be able to
    // select it. Without the floor the tolerance would be exactly 0.
    const bare = shape('line', 200, 0);
    expect(hits(bare, 100, 1.9)).toBe(true);
    expect(hits(bare, 100, 2.1)).toBe(false);
  });

  it('does not select a point beyond the segment ends', () => {
    // Distance to an *infinite line* would accept these; the segment is finite, and the
    // ends are the ends.
    const line = shape('line', 100, 0, 6);
    expect(hits(line, 105, 0)).toBe(false);
    expect(hits(line, -5, 0)).toBe(false);
  });

  it('handles a zero-length segment without dividing by zero', () => {
    const dot = shape('line', 0, 0, 6);
    expect(hits(dot, 0, 0)).toBe(true);
    expect(hits(dot, 2, 0)).toBe(true);
    expect(hits(dot, 4, 0)).toBe(false);
  });
});

describe('a stroke width is authored but is not geometry', () => {
  it('is consulted by hit testing and is absent from the box', () => {
    const thin = shape('line', 100, 0, 2);
    const fat = shape('line', 100, 0, 20);
    // The tolerance follows the stroke...
    expect(hits(thin, 50, 5)).toBe(false);
    expect(hits(fat, 50, 5)).toBe(true);
    // ...while the box, which is the whole of the geometry, does not move.
    expect(layoutBoxOf(thin)).toEqual(layoutBoxOf(fat));
  });
});

describe('the registry also answers the questions creation asks', () => {
  it('reports a line as the one kind with no interior', () => {
    expect(shapeSpec('line').hasInterior).toBe(false);
    expect(shapeSpec('rect').hasInterior).toBe(true);
    expect(shapeSpec('ellipse').hasInterior).toBe(true);
  });

  it('reports that only kinds with an interior need a default size for a click', () => {
    expect(shapeNeedsExtent('rect')).toBe(true);
    expect(shapeNeedsExtent('ellipse')).toBe(true);
    expect(shapeNeedsExtent('line')).toBe(false);
  });

  it('declares corner radius for a rect and nothing else', () => {
    // The registry mirrors the model's discriminated union, so a shape kind with a
    // property it does not have cannot acquire an inspector field for it.
    expect(shapeSpec('rect').properties.map((p) => p.path)).toEqual(['shape.cornerRadius']);
    expect(shapeSpec('ellipse').properties).toEqual([]);
    expect(shapeSpec('line').properties).toEqual([]);
  });
});

describe('isGeometry narrows the union the way the type says', () => {
  it('admits a matching kind and rejects a mismatched one', () => {
    const geometry = createShapeNode('rect').shape;
    expect(isGeometry(geometry, 'rect')).toBe(true);
    expect(isGeometry(geometry, 'ellipse')).toBe(false);
    if (isGeometry(geometry, 'rect')) {
      // The point of the guard: `cornerRadius` is only readable after narrowing.
      expect(typeof geometry.cornerRadius).toBe('number');
    }
  });
});