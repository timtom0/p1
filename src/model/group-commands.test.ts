/**
 * M13: grouping and ungrouping, at the model layer.
 *
 * ## What these tests are actually asserting
 *
 * M12 proved that a group authored at the transparent frame is the identity in page space, so
 * `worldTransformIn(child, group) === child` bit-for-bit. Everything here is downstream of that:
 *
 * - **grouping preserves every child's world transform** is not an approximation, it is *equality*,
 *   and the strongest form of it is that the child objects are the same objects with the same
 *   transforms. A test asserting only "the painted position is within 0.01px" would pass a conversion
 *   that quietly re-quantised every child.
 * - **group then ungroup is the identity**, for a transparent group, by reference as well as by
 *   canonical equality.
 * - **a moved group is not transparent**, and ungrouping it must compose -- which is the one place
 *   `worldTransformIn` is used, and the test pins that it is the same function's answer.
 */

import { describe, expect, it } from 'vitest';
import type { Document, GroupNode, Node } from './types';
import { apply, describeCommand, isNoop } from './commands';
import { createDocument, createGroupNode, createShapeNode } from './factory';
import { resetIds } from '../core/ids';
import { documentsEqual } from './document-equality';
import { locateNode, placementsOnPage, placementsInDocument } from './tree';
import { worldMatrix, worldMatrixIn, worldTransformIn } from './transform';
import type { Mat2D } from '../core/geom/mat2d';
import { validateDocument } from './invariants';

/** The document under test: a page of rectangles with distinct, awkward geometry. */
function documentWith(ids: readonly string[]): Document {
  resetIds();
  const doc = createDocument({ name: 'G' });
  const page = doc.pages[0];
  if (page === undefined) throw new Error('unreachable');
  return {
    ...doc,
    pages: [
      {
        ...page,
        objects: ids.map((id, index) =>
          createShapeNode(
            'rect',
            {
              id,
              name: id,
              transform: {
                x: 10 + index * 40,
                y: 20 + index * 10,
                width: 30,
                height: 25,
                rotation: index * 0.3,
                scaleX: 1 + index * 0.25,
                scaleY: 1,
              },
            },
          ),
        ),
      },
    ],
  };
}

const at = <T>(list: readonly T[], index: number): T => {
  const value = list[index];
  if (value === undefined) throw new Error(`unreachable: index ${index}`);
  return value;
};

/** Every leaf's world matrix, as the renderer and hit testing would compute it. */
function worldMatrices(doc: Document): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const placement of placementsInDocument(doc)) {
    if (!placement.node.id.startsWith('r')) continue;
    out[placement.node.id] = [
      placement.world.a,
      placement.world.b,
      placement.world.c,
      placement.world.d,
      placement.world.e,
      placement.world.f,
    ];
  }
  return out;
}

/**
 * World matrices rounded to 1e-9, for comparisons that span the two spellings of a composition.
 *
 * `worldMatrix(worldTransformIn(...))` is a closed form and `worldMatrixIn(...)` is a product of four
 * matrix factors. They are the same composition and they round differently — which is already recorded
 * in `grouping-probe.test.ts` and in `worldTransformIn`'s own doc comment. Comparing them with `toEqual`
 * would assert an exactness neither has; comparing with a tolerance is the honest form, and it still
 * catches every error that matters here (a dropped translation, a transposed multiply, a lost rotation)
 * by many orders of magnitude.
 */
const roundWorld = (m: Record<string, number[]>): Record<string, number[]> => {
  const out: Record<string, number[]> = {};
  for (const [id, values] of Object.entries(m)) {
    out[id] = values.map((value) => Math.round(value * 1e9) / 1e9);
  }
  return out;
};

/** {@link roundWorld} under a name that does not collide with the other rounding helper. */
const roundedRecords = roundWorld;

/** The six numbers of a `Mat2D`, rounded, so two spellings of one composition can be compared. */
const roundMatrix = (m: Mat2D): number[] =>
  [m.a, m.b, m.c, m.d, m.e, m.f].map((value) => Math.round(value * 1e9) / 1e9);

const groupIdOf = (doc: Document): string => {
  const node = at(doc.pages[0]?.objects ?? [], 0);
  if (node.type !== 'group') throw new Error(`expected a group at index 0, got ${node.type}`);
  return node.id;
};

describe('group', () => {
  it('wraps the selection, keeping the same child objects with the same transforms', () => {
    const before = documentWith(['r1', 'r2', 'r3']);
    const originals = before.pages[0]?.objects ?? [];
    const after = apply(before, { type: 'group', ids: ['r1', 'r2'] });

    const group = at(after.pages[0]?.objects ?? [], 0);
    expect(group.type).toBe('group');
    if (group.type !== 'group') throw new Error('unreachable');
    // Identity, not a copy: this is what lets the renderer's `prev` skip treat an untouched leaf as
    // unchanged, and it is why grouping needs no conversion.
    expect(group.children[0]).toBe(at(originals, 0));
    expect(group.children[1]).toBe(at(originals, 1));
    expect(at(after.pages[0]?.objects ?? [], 1)).toBe(at(originals, 2));
  });

  it('preserves every child world transform exactly, not approximately', () => {
    const before = documentWith(['r1', 'r2', 'r3', 'r4']);
    const want = worldMatrices(before);
    const after = apply(before, { type: 'group', ids: ['r1', 'r2', 'r3'] });
    expect(worldMatrices(after)).toEqual(want);
  });

  it('takes the position of the first selected node in paint order', () => {
    const after = apply(documentWith(['r1', 'r2', 'r3']), { type: 'group', ids: ['r2', 'r3'] });
    const objects = after.pages[0]?.objects ?? [];
    expect(objects).toHaveLength(2);
    expect(at(objects, 0).id).toBe('r1');
    expect(at(objects, 1).type).toBe('group');
  });

  it('preserves child order regardless of the order the ids were given in', () => {
    const ordered = apply(documentWith(['r1', 'r2']), { type: 'group', ids: ['r1', 'r2'] });
    const reversed = apply(documentWith(['r1', 'r2']), { type: 'group', ids: ['r2', 'r1'] });
    const a = at(ordered.pages[0]?.objects ?? [], 0);
    const b = at(reversed.pages[0]?.objects ?? [], 0);
    if (a.type !== 'group' || b.type !== 'group') throw new Error('unreachable');
    expect(a.children.map((child) => child.id)).toEqual(['r1', 'r2']);
    expect(b.children.map((child) => child.id)).toEqual(['r1', 'r2']);
  });

  it('absorbs the contiguous span when the selection has a gap, so paint order cannot change', () => {
    // A, B, C, D with A and C selected. Any group holding only A and C would have to move B, which
    // changes what is painted. So the group takes the span -- documented at `groupSiblings`.
    const after = apply(documentWith(['r1', 'r2', 'r3', 'r4']), { type: 'group', ids: ['r1', 'r3'] });
    const group = at(after.pages[0]?.objects ?? [], 0);
    if (group.type !== 'group') throw new Error('unreachable');
    expect(group.children.map((child) => child.id)).toEqual(['r1', 'r2', 'r3']);
    expect(at(after.pages[0]?.objects ?? [], 1).id).toBe('r4');
    // And the paint order is byte-identical to before.
    expect(worldMatrices(after)).toEqual(worldMatrices(documentWith(['r1', 'r2', 'r3', 'r4'])));
  });

  it('nests: a group may itself become a child of a group', () => {
    const base = documentWith(['r1', 'r2', 'r3']);
    const want = worldMatrices(base);
    const inner = apply(base, { type: 'group', ids: ['r1', 'r2'] });
    const innerId = groupIdOf(inner);
    // Group the inner group together with a third sibling. They share the page as parent, so this is
    // a legal grouping and produces depth 2.
    const outer = apply(inner, { type: 'group', ids: [innerId, 'r3'] });
    const outerNode = at(outer.pages[0]?.objects ?? [], 0);
    if (outerNode.type !== 'group') throw new Error('unreachable');
    expect(outerNode.children.map((child) => child.id)).toEqual([innerId, 'r3']);
    expect(validateDocument(outer)).toEqual([]);
    // Two levels of wrapping, and still not one pixel of movement.
    // Two levels of wrapping for the inner pair, one for the third node.
    expect(placementsInDocument(outer).map((p) => p.depth)).toEqual([2, 2, 1]);
    expect(worldMatrices(outer)).toEqual(want);
  });

  it('refuses fewer than two, unknown ids, and mixed parents -- all as no-ops', () => {
    const doc = documentWith(['r1', 'r2']);
    expect(isNoop(doc, { type: 'group', ids: ['r1'] })).toBe(true);
    expect(isNoop(doc, { type: 'group', ids: ['r1', 'nope'] })).toBe(true);
    expect(isNoop(doc, { type: 'group', ids: [] })).toBe(true);
  });

  it('produces a document the model accepts', () => {
    const after = apply(documentWith(['r1', 'r2', 'r3']), { type: 'group', ids: ['r1', 'r2'] });
    expect(validateDocument(after)).toEqual([]);
  });

  it('leaves the input document untouched', () => {
    const before = documentWith(['r1', 'r2']);
    const snapshot = JSON.stringify(before);
    apply(before, { type: 'group', ids: ['r1', 'r2'] });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('is labelled Group, and is one command rather than a fan-out', () => {
    expect(describeCommand({ type: 'group', ids: ['r1', 'r2'] })).toBe('Group');
  });
});

describe('ungroup', () => {
  it('returns the same child objects, in order, at the group position', () => {
    const before = documentWith(['r1', 'r2', 'r3']);
    const originals = before.pages[0]?.objects ?? [];
    const wrapped = apply(before, { type: 'group', ids: ['r1', 'r2'] });
    const after = apply(wrapped, { type: 'ungroup', ids: [groupIdOf(wrapped)] });
    expect(at(after.pages[0]?.objects ?? [], 0)).toBe(at(originals, 0));
    expect(at(after.pages[0]?.objects ?? [], 1)).toBe(at(originals, 1));
    expect(at(after.pages[0]?.objects ?? [], 2)).toBe(at(originals, 2));
  });

  it('restores the canonical document exactly for a transparent group', () => {
    const before = documentWith(['r1', 'r2', 'r3']);
    const wrapped = apply(before, { type: 'group', ids: ['r1', 'r2'] });
    const unwrapped = apply(wrapped, { type: 'ungroup', ids: [groupIdOf(wrapped)] });
    expect(documentsEqual(unwrapped, before)).toBe(true);
    // By reference too, which is stronger than canonical equality and costs nothing here.
    expect(unwrapped.pages[0]?.objects[0]).toBe(before.pages[0]?.objects[0]);
  });

  it('composes through the group frame when the group has been moved', () => {
    // A transparent group needs no arithmetic, so this is the one case where the child's transform
    // actually changes -- and it is the case a purely structural implementation would get wrong, by
    // snapping every child back to where it was before the group moved.
    const wrapped = apply(documentWith(['r1', 'r2']), { type: 'group', ids: ['r1', 'r2'] });
    const id = groupIdOf(wrapped);
    const moved = apply(wrapped, {
      type: 'setTransform',
      ids: [id],
      patch: { x: 137, y: -42, rotation: 0.6, scaleX: 2, scaleY: 2 },
    });
    // The promise is that ungrouping does not move anything on the page: the leaves keep the world
    // matrices they had *while grouped and moved*.
    const painted = worldMatrices(moved);
    const unwrapped = apply(moved, { type: 'ungroup', ids: [id] });
    expect(roundedRecords(worldMatrices(unwrapped))).toEqual(roundedRecords(painted));

    // And it is genuinely different from the un-moved document, so the test is not vacuous.
    expect(worldMatrices(unwrapped)).not.toEqual(worldMatrices(documentWith(['r1', 'r2'])));
  });

  it('is one level only: a nested group survives its parent being ungrouped', () => {
    const base = documentWith(['r1', 'r2', 'r3']);
    const want = worldMatrices(base);
    const inner = apply(base, { type: 'group', ids: ['r1', 'r2'] });
    const innerId = groupIdOf(inner);
    const outer = apply(inner, { type: 'group', ids: [innerId, 'r3'] });
    const outerId = groupIdOf(outer);
    const unwrapped = apply(outer, { type: 'ungroup', ids: [outerId] });

    const lifted = locateNode(unwrapped, innerId);
    expect(lifted).not.toBeNull();
    // Still a group, still holding its own children, now directly on the page -- one level only.
    expect(lifted?.node.type).toBe('group');
    expect(lifted?.ancestors).toEqual([]);
    expect(lifted?.owner).toBe(unwrapped.pages[0]);
    expect(worldMatrices(unwrapped)).toEqual(want);
  });

  it('refuses an id that is not a group, as a no-op', () => {
    const doc = documentWith(['r1', 'r2']);
    expect(isNoop(doc, { type: 'ungroup', ids: ['r1'] })).toBe(true);
    expect(isNoop(doc, { type: 'ungroup', ids: ['nope'] })).toBe(true);
  });

  it('is labelled Ungroup', () => {
    expect(describeCommand({ type: 'ungroup', ids: ['g1'] })).toBe('Ungroup');
  });
});

describe('group movement', () => {
  it('moves the group and rewrites no child transform', () => {
    const wrapped = apply(documentWith(['r1', 'r2']), { type: 'group', ids: ['r1', 'r2'] });
    const id = groupIdOf(wrapped);
    const group = at(wrapped.pages[0]?.objects ?? [], 0) as GroupNode;
    const childTransforms = group.children.map((child) => child.transform);

    const moved = apply(wrapped, { type: 'setTransform', ids: [id], patch: { x: 500, y: 250 } });
    const movedGroup = at(moved.pages[0]?.objects ?? [], 0);
    if (movedGroup.type !== 'group') throw new Error('unreachable');

    // The children are the *same objects*, so "no child was rewritten" is not an approximation.
    expect(movedGroup.children.map((child) => child.transform)).toEqual(childTransforms);
    expect(movedGroup.children[0]).toBe(group.children[0]);
    expect(movedGroup.transform.x).toBe(500);
  });

  it('moves every descendant, because the group matrix is what places them', () => {
    const wrapped = apply(documentWith(['r1', 'r2']), { type: 'group', ids: ['r1', 'r2'] });
    const moved = apply(wrapped, {
      type: 'setTransform',
      ids: [groupIdOf(wrapped)],
      patch: { x: 500, y: 250 },
    });
    const before = worldMatrices(wrapped);
    const after = worldMatrices(moved);
    for (const id of Object.keys(before)) {
      // A pure translation of the group translates every descendant by exactly the same amount --
      // which is the property that says "moving a group moves its contents" without any child rewrite.
      const from = at(before[id] ?? [], 4) as number;
      const to = at(after[id] ?? [], 4) as number;
      expect(to).toBeCloseTo(from + 500, 9);
      expect(at(after[id] ?? [], 5) as number).toBeCloseTo((at(before[id] ?? [], 5) as number) + 250, 9);
    }
  });

  it('applies to a child inside a rotated and uniformly scaled group', () => {
    const wrapped = apply(documentWith(['r1', 'r2']), { type: 'group', ids: ['r1', 'r2'] });
    const id = groupIdOf(wrapped);
    const placed = apply(wrapped, {
      type: 'setTransform',
      ids: [id],
      patch: { x: 200, y: 100, rotation: 0.5, scaleX: 1.5, scaleY: 1.5 },
    });
    const group = at(placed.pages[0]?.objects ?? [], 0);
    if (group.type !== 'group') throw new Error('unreachable');
    const child = at(group.children, 0);
    // A **page-space** nudge of the child, composed through the group. Because the group is rotated and
    // scaled, the equivalent *local* delta is not (10, 0) -- and getting this wrong is the classic
    // "page delta applied as a local delta" bug, where a child drifts diagonally under a rotated group.
    const composed = worldTransformIn({ ...child.transform, x: child.transform.x + 10 }, group.transform);
    expect(composed.x).not.toBe(child.transform.x + 10);
    // The child's own local transform is what the group frame maps; composing the *unmodified* child
    // through the group is the placement the child actually has.
    expect(roundMatrix(worldMatrixIn(child.transform, worldMatrix(group.transform)))).toEqual(
      roundMatrix(worldMatrix(worldTransformIn(child.transform, group.transform))),
    );
  });
});

describe('deletion', () => {
  it('removes a group and its whole subtree as one operation', () => {
    const wrapped = apply(documentWith(['r1', 'r2', 'r3']), { type: 'group', ids: ['r1', 'r2'] });
    const after = apply(wrapped, { type: 'remove', ids: [groupIdOf(wrapped)] });
    expect(after.pages[0]?.objects.map((node) => node.id)).toEqual(['r3']);
    expect(locateNode(after, 'r1')).toBeNull();
    expect(locateNode(after, 'r2')).toBeNull();
  });

  it('removes one child and leaves its siblings alone', () => {
    const wrapped = apply(documentWith(['r1', 'r2', 'r3']), { type: 'group', ids: ['r1', 'r2', 'r3'] });
    const id = groupIdOf(wrapped);
    const after = apply(wrapped, { type: 'remove', ids: ['r2'] });
    expect(locateNode(after, 'r2')).toBeNull();
    expect(locateNode(after, 'r1')).not.toBeNull();
    expect(locateNode(after, id)).not.toBeNull();
  });
});

describe('the transparent frame, restated as an invariant of the group itself', () => {
  it('createGroupNode authors the frame that makes grouping free', () => {
    // If this ever changes, `groupSiblings` stops being a pure array move and every assertion about
    // preserved child transforms above becomes false. So the dependency is explicit.
    const group = createGroupNode();
    expect(group.transform).toMatchObject({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 });
    expect(roundMatrix(worldMatrix(group.transform))).toEqual(roundMatrix(worldMatrix({
      x: 0, y: 0, width: group.transform.width, height: group.transform.height,
      rotation: 0, scaleX: 1, scaleY: 1,
    })));
  });

  it('and a group is not fitted to its children', () => {
    const group = createGroupNode({
      children: [
        createShapeNode('rect', {
          transform: { x: 400, y: 400, width: 90, height: 90, rotation: 0, scaleX: 1, scaleY: 1 },
        }),
      ],
    });
    expect(group.transform.width).toBe(0);
    expect(group.transform.height).toBe(0);
  });
});

describe('placements after grouping', () => {
  it('flattens to the same leaf order as before', () => {
    const before = documentWith(['r1', 'r2', 'r3']);
    const after = apply(before, { type: 'group', ids: ['r1', 'r2'] });
    expect(placementsOnPage(before.pages[0] ?? ({} as never)).map((p) => p.node.id)).toEqual(
      placementsOnPage(after.pages[0] ?? ({} as never)).map((p) => p.node.id),
    );
  });

  it('reports the depth of each child, which is what the renderer and hit test both need', () => {
    const after = apply(documentWith(['r1', 'r2', 'r3']), { type: 'group', ids: ['r1', 'r2'] });
    const depths = new Map(placementsInDocument(after).map((p) => [p.node.id, p.depth]));
    expect(depths.get('r1')).toBe(1);
    expect(depths.get('r3')).toBe(0);
  });

  it('never yields a group as a placement, so a group cannot reach the leaf reconciler', () => {
    const after = apply(documentWith(['r1', 'r2']), { type: 'group', ids: ['r1', 'r2'] });
    for (const placement of placementsInDocument(after)) {
      expect(placement.node.type).not.toBe('group');
    }
    const nodes: Node[] = placementsInDocument(after).map((p) => p.node);
    expect(nodes.some((node) => node.type === 'group')).toBe(false);
  });
});