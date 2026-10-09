/**
 * M16: alignment and distribution, at the model layer.
 *
 * ## What these tests are actually asserting
 *
 * Alignment is a **visual** operation, so every assertion here is about **painted bounds** -- the AABB of
 * the transformed corners -- and never about `{x, y, width, height}`. That distinction is the whole
 * subject of the milestone: ADR 0011b §3 established that the model frame is not what the user sees, and
 * a 100x60 box rotated 45° paints 113.1 x 113.1. An implementation that aligned model frames would pass
 * every axis-aligned test in this file and be visibly wrong, which is why:
 *
 * - the rotated fixture uses **45°**, chosen so the painted box (113.1²) is far from the model frame
 *   (100x60). At a mild angle the two nearly coincide and the distinction is untestable;
 * - `aligns a rotated object by its painted bounds, not its model frame` asserts the two answers differ,
 *   so the test cannot pass under either implementation.
 *
 * ## The properties that are easy to get wrong, and are therefore pinned
 *
 * - **Translation only.** Every alignment and distribution must leave `width`, `height`, `rotation` and
 *   both scales untouched. Under ADR 0011b §5 stroke width is a local dimension that transforms with the
 *   object, so an implementation that scaled would silently change every stroke's thickness.
 * - **Size is preserved.** Aligning left edges lines up three boxes of different widths without making
 *   them the same width. `width` is not a consequence of alignment.
 * - **Anchors are fixed.** Distribution moves only what is between the outermost two.
 * - **Gaps, not centres.** Equal gaps between painted edges, which differs from equal centres whenever
 *   the objects differ in size -- and these fixtures are deliberately unequal so the two cannot be
 *   confused.
 * - **Negative gaps are a result, not an error.** An overlapping selection still distributes.
 * - **Already-aligned is a no-op.** Asserted as *zero delta*, not as an epsilon, so it matches the
 *   model's own no-op rule rather than introducing a tolerance.
 * - **Deterministic order.** Ties on an edge are broken by id, so the answer is a function of the
 *   document and not of the order the user happened to click.
 */

import { describe, expect, it } from 'vitest';

import {
  arrangementDeltas,
  arrangeBounds,
  arrangeTargets,
  canArrange,
  describeArrange,
  translatedTransform,
  MIN_ALIGN,
  MIN_DISTRIBUTE,
  type ArrangeOperation,
  type ArrangeTarget,
} from './arrange';
import { paintedBounds } from './transform';
import { placementsInDocument } from './tree';
import type { Document, GroupNode, Node, ShapeNode, Transform2D } from './types';

// ---------------------------------------------------------------------------
// Fixture construction
// ---------------------------------------------------------------------------

function rect(id: string, x: number, y: number, width: number, height: number, rotation = 0): ShapeNode {
  return {
    type: 'shape',
    id,
    name: id,
    transform: { x, y, width, height, rotation, scaleX: 1, scaleY: 1 },
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    shape: { kind: 'rect', cornerRadius: 0 },
  } as ShapeNode;
}

function group(id: string, x: number, y: number, children: Node[], rotation = 0, scale = 1): GroupNode {
  return {
    type: 'group',
    id,
    name: id,
    transform: { x, y, width: 0, height: 0, rotation, scaleX: scale, scaleY: scale },
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    children,
  };
}

function docOf(nodes: Node[]): Document {
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
        objects: nodes,
      },
    ],
  } as unknown as Document;
}

/**
 * Applies the deltas the way the editor does, returning each node's new transform.
 *
 * The editor converts each page-space delta into the node's parent-local delta before translating. That
 * conversion is identity for every fixture here except the group tests, which assert on the group's own
 * painted box rather than on its children's, so it is exercised in `arrange.test.ts` in the editor and in
 * `transform.test.ts` for the conversion itself rather than being restated here.
 */
function applyDeltas(
  targets: ArrangeTarget[],
  deltas: Map<string, { x: number; y: number }>,
): Map<string, Transform2D> {
  const out = new Map<string, Transform2D>();
  for (const target of targets) {
    const delta = deltas.get(target.id);
    out.set(target.id, translatedTransform(target.transform, delta ?? { x: 0, y: 0 }));
  }
  return out;
}

/** The painted box a node will have after a transform change. */
function paintedAfter(
  doc: Document,
  id: string,
  next: Map<string, Transform2D>,
): { x: number; y: number; width: number; height: number } {
  const rewritten = {
    ...doc,
    pages: doc.pages.map((page) => ({
      ...page,
      objects: page.objects.map((node) => {
        const replacement = next.get(node.id);
        return replacement === undefined ? node : { ...node, transform: replacement };
      }),
    })),
  } as unknown as Document;
  const placement = placementsInDocument(rewritten).find((p) => p.node.id === id);
  if (placement === undefined) throw new Error(`no placement for ${id}`);
  return paintedBounds(placement.transform);
}

function align(mode: string): ArrangeOperation {
  return { kind: 'align', mode } as ArrangeOperation;
}

function distribute(axis: 'horizontal' | 'vertical'): ArrangeOperation {
  return { kind: 'distribute', axis };
}

// Three axis-aligned boxes of deliberately different sizes.
const SIZED = docOf([rect('a', 40, 40, 60, 40), rect('b', 200, 80, 100, 120), rect('c', 380, 150, 50, 90)]);

// Two boxes.
const TWO = docOf([rect('a', 40, 40, 80, 60), rect('b', 200, 150, 120, 90)]);

// Three boxes with equal widths at x = 40, 140, 240: gaps of 40, already distributed horizontally.
const DISTRIBUTED = docOf([rect('a', 40, 40, 60, 30), rect('b', 140, 120, 60, 90), rect('c', 240, 250, 60, 40)]);

// Overlapping: total width 300 inside a span of 260, so the gap is negative.
const OVERLAP = docOf([rect('a', 40, 40, 100, 100), rect('b', 100, 60, 100, 100), rect('c', 200, 120, 100, 100)]);

// Two axis-aligned boxes and one rotated 45 degrees.
const ROTATED = docOf([
  rect('a', 40, 40, 100, 60),
  rect('b', 300, 200, 100, 60),
  rect('c', 120, 300, 100, 60, Math.PI / 4),
]);

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

describe('arrangeTargets', () => {
  it('resolves painted bounds in page space, not the model frame', () => {
    const targets = arrangeTargets(ROTATED, ['a', 'b', 'c']);
    const c = targets.find((t) => t.id === 'c');
    // The model frame of `c` is 100x60 at (120,300). Rotated 45 degrees it paints 113.1 x 113.1, so a
    // target that reported the model frame would be 100x60 here.
    expect(c?.painted.width).toBeCloseTo((100 + 60) * Math.SQRT1_2, 6);
    expect(c?.painted.height).toBeCloseTo((100 + 60) * Math.SQRT1_2, 6);
    const a = targets.find((t) => t.id === 'a');
    expect(a?.painted.width, 'an unrotated box paints its model frame').toBe(100);
  });

  it("gives a group the union of its descendants' painted bounds", () => {
    const doc = docOf([rect('plain', 40, 40, 100, 60), group('grp', 300, 200, [
      rect('m1', 0, 0, 70, 50, 0.5),
      rect('m2', 90, 60, 70, 50, -0.4),
    ], 0.3)]);
    const grp = arrangeTargets(doc, ['plain', 'grp']).find((t) => t.id === 'grp');

    // Computed independently from the members' painted bounds -- the same derivation the overlay uses.
    const members = placementsInDocument(doc).filter((p) => p.ancestors.some((g) => g.id === 'grp'));
    expect(members.length).toBe(2);
    const left = Math.min(...members.map((m) => paintedBounds(m.transform).x));
    const top = Math.min(...members.map((m) => paintedBounds(m.transform).y));
    const right = Math.max(...members.map((m) => {
      const b = paintedBounds(m.transform);
      return b.x + b.width;
    }));
    const bottom = Math.max(...members.map((m) => {
      const b = paintedBounds(m.transform);
      return b.y + b.height;
    }));

    expect(grp?.painted.x).toBeCloseTo(left, 6);
    expect(grp?.painted.y).toBeCloseTo(top, 6);
    expect(grp?.painted.width).toBeCloseTo(right - left, 6);
    expect(grp?.painted.height).toBeCloseTo(bottom - top, 6);
    // And emphatically not the group's own transparent frame.
    expect(grp?.painted.width).toBeGreaterThan(1);
  });

  it('uses the descendants union for a group nested two deep', () => {
    const doc = docOf([
      group('outer', 120, 90, [group('inner', 30, 20, [rect('leaf', 20, 20, 60, 60)], -0.2, 1.4)], 0.3, 1.1),
    ]);
    const outer = arrangeTargets(doc, ['outer'])[0];
    const leaf = placementsInDocument(doc).find((p) => p.node.id === 'leaf');
    expect(leaf).toBeDefined();
    expect(outer?.painted.width).toBeCloseTo(paintedBounds(leaf!.transform).width, 6);
  });

  it('drops ids that do not resolve, rather than inventing a zero box', () => {
    const targets = arrangeTargets(SIZED, ['a', 'nope']);
    expect(targets.map((t) => t.id)).toEqual(['a']);
  });

  it('drops a wanted group that has nothing painted in it', () => {
    // A wanted group with no *visible* descendant is still located and emitted, and it is `emit` that
    // declines to give it a box. Giving it a zero box instead would drag every union and alignment to the
    // origin, so this is a behaviour worth pinning rather than an incidental branch.
    const withEmptyGroup = docOf([rect('a', 40, 40, 60, 40), group('hollow', 300, 300, [])]);

    expect(arrangeTargets(withEmptyGroup, ['a', 'hollow']).map((t) => t.id)).toEqual(['a']);
    // And the consequence: the union is `a`'s box, nowhere near the origin.
    const bounds = arrangeBounds(arrangeTargets(withEmptyGroup, ['a', 'hollow']))!;
    expect(bounds.x).toBeCloseTo(40, 6);
    expect(bounds.y).toBeCloseTo(40, 6);
  });

  it('is deterministic: document order, not selection order', () => {
    expect(arrangeTargets(SIZED, ['c', 'a', 'b']).map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(arrangeTargets(SIZED, ['b', 'c', 'a']).map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// Visibility
//
// `visible: false` is not a rendering detail as far as arrangement is concerned. It means the object is not
// on the page: the renderer hides it (`document-view.ts`), hit testing refuses it (`selection.ts`), and a
// hidden group hides its whole subtree (ADR 0012 A10). Alignment asks "line these up *as I see them*", so a
// box for something nobody can see is not a conservative answer -- it is a wrong one.
//
// Every case below failed before M18, in a different way each time, which is why each is its own assertion.
// ---------------------------------------------------------------------------

describe('visibility', () => {
  const hidden = (id: string, x: number, y: number, w: number, h: number): ShapeNode => ({
    ...rect(id, x, y, w, h),
    visible: false,
  });
  // `group()` takes rotation and scale but not `visible`, so a hidden group is spelled by override --
  // which also keeps the intent obvious at the call site.
  const hiddenGroup = (id: string, children: Node[]): GroupNode => ({
    ...group(id, 300, 300, children),
    visible: false,
  });

  it('does not offer an invisible leaf, even when the selection names it', () => {
    const doc = docOf([rect('a', 40, 40, 60, 40), hidden('hid', 400, 300, 50, 50)]);
    // A user cannot select this -- `selection.ts` refuses it -- so the only way it arrives is a caller
    // naming it. It must not become a target.
    expect(arrangeTargets(doc, ['a', 'hid']).map((t) => t.id)).toEqual(['a']);
  });

  it('does not offer a visible group whose children are all invisible', () => {
    const doc = docOf([rect('a', 40, 40, 60, 40), group('dim', 300, 300, [hidden('c', 10, 10, 40, 40)])]);
    expect(arrangeTargets(doc, ['a', 'dim']).map((t) => t.id)).toEqual(['a']);
  });

  it('does not offer a hidden group, and its visible children do not rescue it', () => {
    // The subtree case, and the one a leaf-only filter would miss: the children *are* visible, but the
    // group is not, and a hidden group hides its subtree. The renderer paints nothing here.
    const doc = docOf([rect('a', 40, 40, 60, 40), hiddenGroup('gone', [rect('c', 10, 10, 40, 40)])]);
    expect(arrangeTargets(doc, ['a', 'gone']).map((t) => t.id)).toEqual(['a']);
  });

  it('does not offer a visible group whose only descendant is inside a hidden group', () => {
    // Nested, because the ancestor chain has to be walked rather than the parent checked: `deep` is
    // visible, `inner` is not, and `outer` is. `outer` has no visible descendant and so has no box.
    const doc = docOf([
      rect('a', 40, 40, 60, 40),
      group('outer', 300, 300, [hiddenGroup('inner', [rect('deep', 0, 0, 40, 40)])]),
    ]);
    expect(arrangeTargets(doc, ['a', 'outer']).map((t) => t.id)).toEqual(['a']);
  });

  it('keeps only the visible descendants in a group that has a mix', () => {
    // The surviving behaviour: a group is still the union of its descendants' bounds, just not of the
    // ones that are not painted.
    const doc = docOf([
      rect('a', 40, 40, 60, 40),
      group('mixed', 0, 0, [rect('shown', 100, 100, 50, 50), hidden('unseen', 900, 900, 50, 50)]),
    ]);
    const mixed = arrangeTargets(doc, ['mixed'])[0]!;
    expect(mixed.painted.x).toBeCloseTo(100, 6);
    expect(mixed.painted.width, 'the hidden child must not stretch the union').toBeCloseTo(50, 6);
  });

  it('does not let one invisible member stretch a union', () => {
    // The concrete damage, and the reason this is not a cosmetic rule: before M18 this union was
    // 5010 x 5010 instead of 60 x 40.
    const doc = docOf([rect('a', 40, 40, 60, 40), hidden('far', 5000, 5000, 50, 50)]);
    const bounds = arrangeBounds(arrangeTargets(doc, ['a', 'far']))!;
    expect(bounds.width).toBeCloseTo(60, 6);
    expect(bounds.height).toBeCloseTo(40, 6);
  });

  it('leaves a fully visible selection exactly as it was', () => {
    // The guard against the fix being over-eager: alignment of ordinary visible objects is untouched,
    // including a nested one.
    const doc = docOf([
      rect('a', 40, 40, 60, 40),
      group('g', 300, 200, [rect('child', 10, 10, 50, 50)]),
    ]);
    expect(arrangeTargets(doc, ['a', 'g']).map((t) => t.id)).toEqual(['a', 'g']);
    const g = arrangeTargets(doc, ['g'])[0]!;
    expect(g.painted.width).toBeCloseTo(50, 6);
  });
});

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

describe('canArrange', () => {
  it('needs two objects to align and three to distribute', () => {
    expect(MIN_ALIGN).toBe(2);
    expect(MIN_DISTRIBUTE).toBe(3);
    const one = arrangeTargets(TWO, ['a']);
    const two = arrangeTargets(TWO, ['a', 'b']);
    const three = arrangeTargets(SIZED, ['a', 'b', 'c']);

    expect(canArrange(one, align('left'))).toBe(false);
    expect(canArrange(two, align('left'))).toBe(true);
    // Distribution with two objects is refused, because both are the outermost and nothing can move.
    expect(canArrange(two, distribute('horizontal'))).toBe(false);
    expect(canArrange(three, distribute('horizontal'))).toBe(true);
  });

  it('returns null rather than an empty map when it cannot apply', () => {
    const two = arrangeTargets(TWO, ['a', 'b']);
    // The distinction matters: null means "unavailable" and disables a control; an empty map means
    // "available and moves nothing".
    expect(arrangementDeltas(two, distribute('horizontal'))).toBeNull();
    expect(arrangementDeltas(two, align('left'))).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------

describe('alignment', () => {
  /** Runs one mode and returns each node's painted box afterwards. */
  function alignBoxes(doc: Document, ids: string[], mode: string) {
    const targets = arrangeTargets(doc, ids);
    const deltas = arrangementDeltas(targets, align(mode));
    if (deltas === null) throw new Error('alignment refused');
    const next = applyDeltas(targets, deltas);
    const out = new Map<string, ReturnType<typeof paintedAfter>>();
    for (const id of ids) out.set(id, paintedAfter(doc, id, next));
    return { boxes: out, targets, next };
  }

  it('aligns left edges of boxes of different sizes', () => {
    const { boxes } = alignBoxes(SIZED, ['a', 'b', 'c'], 'left');
    const lefts = ['a', 'b', 'c'].map((id) => boxes.get(id)!.x);
    expect(lefts[0]).toBeCloseTo(lefts[1]!, 6);
    expect(lefts[1]).toBeCloseTo(lefts[2]!, 6);
    // The leftmost box is the anchor and does not move.
    expect(lefts[0]).toBeCloseTo(40, 6);
  });

  it('aligns horizontal centres', () => {
    const { boxes } = alignBoxes(SIZED, ['a', 'b', 'c'], 'center-h');
    const centres = ['a', 'b', 'c'].map((id) => {
      const b = boxes.get(id)!;
      return b.x + b.width / 2;
    });
    expect(centres[0]).toBeCloseTo(centres[1]!, 6);
    expect(centres[1]).toBeCloseTo(centres[2]!, 6);
  });

  it('aligns right edges', () => {
    const { boxes } = alignBoxes(SIZED, ['a', 'b', 'c'], 'right');
    const rights = ['a', 'b', 'c'].map((id) => {
      const b = boxes.get(id)!;
      return b.x + b.width;
    });
    expect(rights[0]).toBeCloseTo(rights[1]!, 6);
    expect(rights[1]).toBeCloseTo(rights[2]!, 6);
    // The rightmost is the anchor.
    expect(rights[2]).toBeCloseTo(430, 6);
  });

  it('aligns top edges, and vertical centres and bottom edges', () => {
    for (const [mode, read] of [
      ['top', (b: { y: number }) => b.y],
      ['center-v', (b: { y: number; height: number }) => b.y + b.height / 2],
      ['bottom', (b: { y: number; height: number }) => b.y + b.height],
    ] as const) {
      const { boxes } = alignBoxes(SIZED, ['a', 'b', 'c'], mode);
      const values = ['a', 'b', 'c'].map((id) => read(boxes.get(id)!));
      expect(values[0], `${mode} first`).toBeCloseTo(values[1]!, 6);
      expect(values[1], `${mode} second`).toBeCloseTo(values[2]!, 6);
    }
  });

  it('translates only: width, height, rotation and scales survive exactly', () => {
    const { targets, next } = alignBoxes(ROTATED, ['a', 'b', 'c'], 'left');
    for (const target of targets) {
      const after = next.get(target.id)!;
      const before = target.transform;
      expect(after.width, `${target.id} width`).toBe(before.width);
      expect(after.height, `${target.id} height`).toBe(before.height);
      expect(after.rotation, `${target.id} rotation`).toBe(before.rotation);
      expect(after.scaleX, `${target.id} scaleX`).toBe(before.scaleX);
      expect(after.scaleY, `${target.id} scaleY`).toBe(before.scaleY);
    }
  });

  it('preserves each box size, so aligning edges does not equalise widths', () => {
    const { boxes } = alignBoxes(SIZED, ['a', 'b', 'c'], 'left');
    // Three different widths that must remain three different widths.
    expect(boxes.get('a')!.width).toBeCloseTo(60, 6);
    expect(boxes.get('b')!.width).toBeCloseTo(100, 6);
    expect(boxes.get('c')!.width).toBeCloseTo(50, 6);
    expect(new Set([60, 100, 50]).size, 'widths must not have been equalised').toBe(3);
  });

  it('aligns a rotated object by its painted bounds, not its model frame', () => {
    const { boxes, next } = alignBoxes(ROTATED, ['a', 'b', 'c'], 'left');
    const paintedLefts = ['a', 'b', 'c'].map((id) => boxes.get(id)!.x);
    expect(paintedLefts[0]).toBeCloseTo(paintedLefts[1]!, 6);
    expect(paintedLefts[1]).toBeCloseTo(paintedLefts[2]!, 6);

    // The model-frame answer differs, and the difference is measurable. `c` is authored at x=120, but a
    // 100x60 box rotated 45 degrees paints 113.14 wide about its own centre, so its painted left edge
    // sits at 113.43 -- about 6.57 short of its authored x.
    const cPlacement = placementsInDocument(ROTATED).find((p) => p.node.id === 'c')!;
    const cBefore = paintedBounds(cPlacement.transform);
    const overhang = cPlacement.node.transform.x - cBefore.x;
    expect(
      Math.abs(overhang),
      'the model frame and the painted box must differ, or this test proves nothing',
    ).toBeGreaterThan(5);

    // `a` is the leftmost painted box and is the anchor, so it stays at 40. Aligning by painted bounds
    // puts `c`'s painted left edge at 40 as well; an implementation that aligned *model frames* would
    // instead have put it at 40 + overhang. This asserts the painted answer and denies the other.
    expect(boxes.get('a')!.x).toBeCloseTo(40, 6);
    expect(boxes.get('c')!.x).toBeCloseTo(40, 6);
    expect(boxes.get('c')!.x).not.toBeCloseTo(40 + overhang, 3);
    expect(next.get('c')!.width, 'and it did not resize to compensate').toBe(100);
  });

  it('is a no-op when everything is already aligned', () => {
    // An **empty** map, not a map of zeroes: zero deltas are omitted so that "applies and moves nothing"
    // is observable as such, and is distinguishable from `null` ("cannot apply at all").
    const aligned = docOf([rect('a', 40, 40, 60, 40), rect('b', 40, 200, 100, 120), rect('c', 40, 350, 50, 90)]);
    const targets = arrangeTargets(aligned, ['a', 'b', 'c']);
    const deltas = arrangementDeltas(targets, align('left'))!;
    expect(deltas.size, 'nothing moves, so nothing is in the map').toBe(0);
    // And the operation *was* available -- three objects is enough to align.
    expect(canArrange(targets, align('left'))).toBe(true);
  });

  it('works on exactly two objects', () => {
    const { boxes } = alignBoxes(TWO, ['a', 'b'], 'top');
    expect(boxes.get('a')!.y).toBeCloseTo(boxes.get('b')!.y, 6);
    expect(boxes.get('a')!.y, 'the topmost is the anchor').toBeCloseTo(40, 6);
  });

  it('aligns a leaf nested in a group against a top-level object', () => {
    /*
     * The regression this test exists for, and it was found in the browser suite after the unit suite was
     * already green.
     *
     * `paintedBounds` resolves a transform against its **immediate parent**, so handing it a leaf's
     * authored transform measures the leaf inside its group rather than on the page. The two coincide at
     * depth 0 -- which is every other test in this file -- so nothing caught it here. The measured effect:
     * the nested leaf's box came out at its authored (20, 20) instead of its painted position, dragging the
     * selection's union to the wrong edge and sending the top-level object to x=20.
     *
     * The assertions are therefore about the *anchor's* edge being where the leaf actually paints, which
     * cannot be satisfied by the parent-local answer.
     */
    const nested = docOf([
      group('outer', 120, 90, [group('inner', 30, 20, [rect('leaf', 20, 20, 60, 60)], -0.2, 1.4)], 0.3, 1.1),
      rect('outside', 400, 320, 70, 60),
    ]);

    const leafPlacement = placementsInDocument(nested).find((p) => p.node.id === 'leaf')!;
    const leafPainted = paintedBounds(leafPlacement.transform);
    // The two are far apart, which is what makes this a real test rather than a formality.
    expect(
      Math.abs(leafPainted.x - leafPlacement.node.transform.x),
      'the nested leaf paints far from its authored x',
    ).toBeGreaterThan(50);

    const targets = arrangeTargets(nested, ['leaf', 'outside']);
    const deltas = arrangementDeltas(targets, align('left'))!;
    const next = applyDeltas(targets, deltas);

    // The leaf is leftmost, so it is the anchor and must not move.
    expect(leafPainted.x).toBeLessThan(400);
    expect(deltas.has('leaf'), 'the anchor is not in the delta map').toBe(false);

    // And the top-level object lands exactly on the leaf's *painted* left edge.
    const outsideAfter = paintedAfter(nested, 'outside', next);
    expect(outsideAfter.x, 'the top-level box reached the leaf painted edge').toBeCloseTo(
      leafPainted.x,
      6,
    );
    // And emphatically not on the leaf's authored x, which is the bug.
    expect(outsideAfter.x).not.toBeCloseTo(leafPlacement.node.transform.x, 3);
  });

  it('moves a group as a whole, and its members follow by composition', () => {
    const doc = docOf([rect('plain', 40, 40, 100, 60), group('grp', 300, 200, [
      rect('m1', 0, 0, 70, 50, 0.5),
      rect('m2', 90, 60, 70, 50, -0.4),
    ], 0.3)]);
    const targets = arrangeTargets(doc, ['plain', 'grp']);
    const before = new Map(
      placementsInDocument(doc).map((p) => [p.node.id, paintedBounds(p.transform)]),
    );
    const deltas = arrangementDeltas(targets, align('left'))!;
    expect(deltas.get('grp')!.x).not.toBe(0);

    // Apply only the group's command, the way the editor does.
    const next = new Map<string, Transform2D>();
    next.set('grp', translatedTransform(doc.pages[0]!.objects[1]!.transform, deltas.get('grp')!));
    const rewritten = {
      ...doc,
      pages: doc.pages.map((p) => ({
        ...p,
        objects: p.objects.map((n) =>
          n.id === 'grp' ? { ...n, transform: next.get('grp')! } : n,
        ),
      })),
    } as unknown as Document;

    // Every member's painted box moved by the same page-space delta: the group moved, the children did
    // not get their own transforms rewritten.
    for (const id of ['m1', 'm2']) {
      const after = paintedBounds(
        placementsInDocument(rewritten).find((p) => p.node.id === id)!.transform,
      );
      expect(after.x - before.get(id)!.x, `${id} follows the group`).toBeCloseTo(deltas.get('grp')!.x, 6);
      expect(after.y - before.get(id)!.y, `${id} follows the group`).toBeCloseTo(deltas.get('grp')!.y, 6);
    }
    // And the members' own authored transforms are untouched by the group's move.
    const m1After = placementsInDocument(rewritten).find((p) => p.node.id === 'm1')!.node.transform;
    const m1Before = placementsInDocument(doc).find((p) => p.node.id === 'm1')!.node.transform;
    expect(m1After).toEqual(m1Before);
  });
});

// ---------------------------------------------------------------------------
// Distribution
// ---------------------------------------------------------------------------

describe('distribution', () => {
  function distributeBoxes(doc: Document, ids: string[], axis: 'horizontal' | 'vertical') {
    const targets = arrangeTargets(doc, ids);
    const deltas = arrangementDeltas(targets, distribute(axis));
    if (deltas === null) throw new Error('distribution refused');
    const next = applyDeltas(targets, deltas);
    const out = new Map<string, ReturnType<typeof paintedAfter>>();
    for (const id of ids) out.set(id, paintedAfter(doc, id, next));
    return { boxes: out, deltas, targets, next };
  }

  it('spaces three boxes into equal horizontal gaps', () => {
    const { boxes } = distributeBoxes(SIZED, ['a', 'b', 'c'], 'horizontal');
    // Sorted by left edge: a(40,w60), b(200,w100), c(380,w50). Span 40..430 = 390, widths 210,
    // so each gap is (390 - 210) / 2 = 90.
    const a = boxes.get('a')!;
    const b = boxes.get('b')!;
    const c = boxes.get('c')!;
    expect(b.x - (a.x + a.width), 'gap a->b').toBeCloseTo(90, 6);
    expect(c.x - (b.x + b.width), 'gap b->c').toBeCloseTo(90, 6);
  });

  it('spaces three boxes into equal vertical gaps', () => {
    const { boxes } = distributeBoxes(SIZED, ['a', 'b', 'c'], 'vertical');
    // Sorted by top: a(40,h40), b(80,h120), c(150,h90). Span 40..240 = 200, heights 250 > span, so the
    // gap is negative: (200 - 250) / 2 = -25. Overlap is a result, not a refusal.
    const a = boxes.get('a')!;
    const b = boxes.get('b')!;
    const c = boxes.get('c')!;
    expect(b.y - (a.y + a.height), 'gap a->b').toBeCloseTo(-25, 6);
    expect(c.y - (b.y + b.height), 'gap b->c').toBeCloseTo(-25, 6);
  });

  it('keeps the outermost two fixed as anchors', () => {
    const { boxes, deltas } = distributeBoxes(SIZED, ['a', 'b', 'c'], 'horizontal');
    // `a` is leftmost and `c` rightmost, so neither appears in the delta map at all.
    expect(deltas.has('a'), 'the left anchor is not moved').toBe(false);
    expect(deltas.has('c'), 'the right anchor is not moved').toBe(false);
    expect(deltas.has('b'), 'only the middle object moves').toBe(true);
    expect(boxes.get('a')!.x).toBeCloseTo(40, 6);
    expect(boxes.get('c')!.x).toBeCloseTo(380, 6);
  });

  it('distributes an overlapping selection by allowing a negative gap', () => {
    const { boxes } = distributeBoxes(OVERLAP, ['a', 'b', 'c'], 'horizontal');
    // a(40,w100), b(100,w100), c(200,w100). Span 40..300 = 260, widths 300, gap = -20.
    const a = boxes.get('a')!;
    const b = boxes.get('b')!;
    const c = boxes.get('c')!;
    expect(b.x - (a.x + a.width), 'a negative gap is produced, not an error').toBeCloseTo(-20, 6);
    expect(c.x - (b.x + b.width)).toBeCloseTo(-20, 6);
    // The middle object really did move: it started overlapping `a` and now sits at 120.
    expect(b.x).toBeCloseTo(120, 6);
  });

  it('is a no-op when the boxes are already evenly spaced', () => {
    // DISTRIBUTED has equal widths at x = 40, 140, 240, so the gaps are already 40.
    const { deltas, targets } = distributeBoxes(DISTRIBUTED, ['a', 'b', 'c'], 'horizontal');
    expect(deltas.size, 'nothing moved, so nothing is in the delta map').toBe(0);
    for (const target of targets) expect(deltas.has(target.id)).toBe(false);
  });

  it('is a no-op with exactly two objects, because both are anchors', () => {
    // Refused by `canArrange` rather than silently accepted and vacuous.
    const targets = arrangeTargets(TWO, ['a', 'b']);
    expect(arrangementDeltas(targets, distribute('horizontal'))).toBeNull();
    expect(canArrange(targets, distribute('horizontal'))).toBe(false);
  });

  it('breaks edge ties by id, so the result does not depend on click order', () => {
    /*
     * Two boxes share an edge exactly, and the third does not -- the common case of an already
     * left-aligned pair being distributed.
     *
     * `arrangeTargets` already returns document order, so calling it with the ids in a different order
     * does **not** exercise the tie-break: the target list comes back the same either way, and a stable
     * sort would then agree with an id tie-break. That is why this test builds the target list by hand,
     * in an order the document does not have. Without the tie-break, `Array.prototype.sort` is stable and
     * keeps the caller's order, so the tie resolves by whoever happened to be passed first -- which is the
     * click order a user would have produced.
     */
    const tied = docOf([rect('m', 40, 40, 60, 60), rect('z', 40, 140, 80, 60), rect('a', 200, 240, 50, 60)]);
    const forward = arrangeTargets(tied, ['m', 'z', 'a']);
    const reversed = [...forward].reverse();

    // Sanity: the tie really is a tie, or this test would pass for the wrong reason.
    expect(forward[0]!.painted.x).toBe(forward[1]!.painted.x);

    const a = arrangementDeltas(forward, distribute('horizontal'))!;
    const b = arrangementDeltas(reversed, distribute('horizontal'))!;

    // **Only the middle box moves.** `distributionDeltas` records `sorted.slice(1, -1)`, and `record`
    // drops exact zeros, so both anchors are absent from the map *by construction* rather than present
    // with a zero delta. Asserting the key set is therefore part of the contract under test, not a detail
    // -- and it is why this test may not read `.get(id)?.x` for an anchor.
    //
    // The expected delta is derived, not fitted. `m` wins the tie on id, so it is the first anchor at 40,
    // and `a` is the last at 200 with extent 50. Span is therefore 210, total extent is 60 + 80 + 50 = 190,
    // and `gap = (210 - 190) / (3 - 1) = 10`. The cursor leaves `m` at `40 + 60 + 10 = 110`, which is 70
    // past `z`'s near edge of 40.
    expect([...a.keys()], 'only the middle box moves; both anchors are omitted').toEqual(['z']);
    expect(a.get('z')?.x, 'z moves to the equal-gap position, 70px along the axis').toBeCloseTo(70, 9);
    expect(a.get('z')?.y, 'distribution along one axis leaves the other alone').toBe(0);
    expect(a.has('m'), 'm won the tie on id, so it is an anchor and never a delta').toBe(false);
    expect(a.has('a'), 'a is the far anchor').toBe(false);

    // Had the tie been broken by input order instead, `z` would anchor and `m` would be the middle box:
    // span and total are unchanged, but the cursor would leave `z` at `40 + 80 + 10 = 130`, recording
    // **90 on `m`** instead. Both facts are asserted above, so removing the tie-break fails this test
    // rather than quietly reordering a result nobody inspects.
    //
    // And the point of the exercise: input order does not change the outcome.
    expect(
      [...b.entries()],
      'the reversed input produces exactly the same deltas',
    ).toEqual([...a.entries()]);
  });

  it('translates only, and preserves each box size', () => {
    const { targets, next } = distributeBoxes(OVERLAP, ['a', 'b', 'c'], 'horizontal');
    for (const target of targets) {
      const after = next.get(target.id)!;
      const before = target.transform;
      expect(after.width).toBe(before.width);
      expect(after.height).toBe(before.height);
      expect(after.rotation).toBe(before.rotation);
      expect(after.scaleX).toBe(before.scaleX);
      expect(after.scaleY).toBe(before.scaleY);
    }
  });
});

// ---------------------------------------------------------------------------
// Aggregate bounds
// ---------------------------------------------------------------------------

describe('arrangeBounds', () => {
  it('is the union of the members painted boxes', () => {
    const targets = arrangeTargets(SIZED, ['a', 'b', 'c']);
    const bounds = arrangeBounds(targets)!;
    expect(bounds.x).toBeCloseTo(40, 6);
    expect(bounds.y).toBeCloseTo(40, 6);
    expect(bounds.x + bounds.width).toBeCloseTo(430, 6);
    expect(bounds.y + bounds.height).toBeCloseTo(240, 6);
  });

  it('is null for an empty selection rather than a zero rect at the origin', () => {
    // A zero rect at (0,0) would drag every alignment to the top-left corner of the page.
    expect(arrangeBounds([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

describe('describeArrange', () => {
  it('names the operation and the count', () => {
    expect(describeArrange(align('left'), 3)).toBe('Align 3 objects');
    expect(describeArrange(align('top'), 1)).toBe('Align 1 object');
    expect(describeArrange(distribute('horizontal'), 4)).toBe('Distribute 4 objects horizontally');
    expect(describeArrange(distribute('vertical'), 3)).toBe('Distribute 3 objects vertically');
  });
});
