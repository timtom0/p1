/**
 * The traversal, and the ownership invariant it exists to make checkable.
 *
 * `tree.ts` is the only module that knows how a document's hierarchy composes. These tests are the
 * reason it can be the only one: each claim below is a claim that some *other* module would have to
 * re-derive if the traversal were not handed to it whole.
 *
 * The two halves matter equally:
 *
 * - **geometry** — that `worldMatrix(placement.transform) === placement.world`, which is what lets
 *   the renderer write CSS from one spelling and the editor hit-test from the other without either
 *   noticing they could disagree;
 * - **ownership** — that a node has exactly one parent, that a cycle is refused rather than
 *   followed, and that an edit rebuilds the path to the page and nothing else.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_GROUP_DEPTH,
  isGroup,
  locateNode,
  mapNodesByIdIn,
  nodeIdsInPaintOrder,
  nodeIdsOnPage,
  nodeById,
  pageIdOf,
  placementOf,
  placementsInDocument,
  placementsOnPage,
  removeNodesById,
} from './tree';
import { worldMatrix } from './transform';
import { applyPoint, invert } from '../core/geom/mat2d';
import { createTransform } from './factory';
import { CURRENT_FORMAT_VERSION } from './factory';
import type { Document, GroupNode, Node, Page, ShapeNode, Transform2D } from './types';
import { validateDocument } from './invariants';

const DEG = Math.PI / 180;

/**
 * Literals, not factories.
 *
 * `createRectNode` and friends mint their own ids from `createId`, so a test that needs to *name* a
 * node -- which every ownership and paint-order test does -- has to build the value itself. That is
 * the better shape for a test anyway: the document under test is stated in full, so a reader can see
 * the tree rather than infer it from a builder's defaults.
 */
/**
 * Index access that states its own precondition.
 *
 * `noUncheckedIndexedAccess` is on, so `objects[1]` is `Node | undefined`, and writing `objects[1]!`
 * everywhere would push a silently-missing-element failure *below* an assertion -- the shape of
 * vacuous test this project has been bitten by repeatedly. Throwing here keeps the cause and the
 * symptom adjacent.
 */
function at(nodes: readonly Node[], index: number): Node {
  const node = nodes[index];
  if (node === undefined) throw new Error(`no node at index ${index}`);
  return node;
}

function groupOf(node: Node): GroupNode {
  if (!isGroup(node)) throw new Error(`expected a group, got "${node.type}"`);
  return node;
}

function tf(  x: number,
  y: number,
  width = 0,
  height = 0,
  rotation = 0,
  scale = 1,
): Transform2D {
  return createTransform({
    x,
    y,
    width,
    height,
    rotation,
    scaleX: scale,
    // Uniform by default: the *group* invariant, so a test that means to break it has to say so out
    // loud rather than getting it by omission.
    scaleY: scale,
  });
}

function leaf(id: string, transform: Transform2D = tf(0, 0, 10, 10)): ShapeNode {
  return {
    id,
    type: 'shape',
    name: id,
    transform,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    shape: { kind: 'rect', cornerRadius: 0 },
  };
}

function group(
  id: string,
  children: Node[],
  transform: Transform2D = tf(0, 0, 50, 50),
): GroupNode {
  return {
    id,
    type: 'group',
    name: id,
    transform,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    children,
  };
}

function page(id: string, objects: Node[]): Page {
  return {
    id,
    name: id,
    background: { type: 'solid', color: '#ffffff' },
    objects,
  };
}

function doc(id: string, pages: Page[]): Document {
  return {
    formatVersion: CURRENT_FORMAT_VERSION,
    id,
    name: id,
    pageSize: { width: 400, height: 300, unit: 'pt', orientation: 'portrait' },
    assets: {},
    pages,
  };
}

/** `A, Group G [B, C], D` — the arrangement ADR 0012 §5 specifies paint order for. */
function pageWithGroup(): Document {
  return doc('doc1', [
    page('p1', [
      leaf('a', tf(0, 0, 10, 10)),
      group(
        'g',
        [leaf('b', tf(10, 20, 40, 30)), leaf('c', tf(50, 60, 10, 10))],
        tf(100, 200, 80, 80, 0.3, 2),
      ),
      leaf('d', tf(300, 300, 10, 10)),
    ]),
  ]);
}

describe('paint order', () => {
  it('flattens A, Group[B, C], D to A, B, C, D', () => {
    // The stated rule, asserted as a list rather than as "the group is somewhere in there".
    expect(nodeIdsInPaintOrder(pageWithGroup())).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps child array order, because child order IS paint order', () => {
    // The negative: the same two children, reversed, paint in the other order. If these compared
    // equal then `documentsEqual` would report a visible reorder as no change and Save would be
    // disabled on a document the user just edited.
    const original = pageWithGroup();
    const source = original.pages[0]!;
    const sourceGroup = groupOf(at(source.objects, 1));

    const reordered = doc('doc1', [
      page('p1', [
        at(source.objects, 0),
        group('g', [sourceGroup.children[1]!, sourceGroup.children[0]!], sourceGroup.transform),
        at(source.objects, 2),
      ]),
    ]);

    expect(nodeIdsInPaintOrder(original)).toEqual(['a', 'b', 'c', 'd']);
    expect(nodeIdsInPaintOrder(reordered)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('gives depth and the ancestor chain', () => {
    const [a, b] = placementsInDocument(pageWithGroup());
    expect(a?.depth, 'a page child is depth 0').toBe(0);
    expect(a?.ancestors, 'and has no ancestors').toEqual([]);
    expect(b?.depth, 'a group child is depth 1').toBe(1);
    expect(b?.ancestors.map((ancestor) => ancestor.id)).toEqual(['g']);
  });

  it('returns leaves only, and says so by not returning groups', () => {
    // `g` is absent because it has no visual form of its own. This is what keeps the object-type
    // registry from needing a group entry.
    expect(nodeIdsInPaintOrder(pageWithGroup())).not.toContain('g');
    expect(placementsInDocument(pageWithGroup()).some((p) => isGroup(p.node))).toBe(false);
  });
});

describe('the two spellings of a placement agree', () => {
  it('worldMatrix(transform) === world, for a flat document', () => {
    // The control. For a document with no groups the composed transform must be the node's own
    // exactly -- this is what makes the renderer's substitution a no-op on every existing document,
    // and 667 passing tests were the first evidence of it.
    const flat = doc('flat', [
      page('p1', [
        leaf('r', tf(17, 43, 200, 100, 0.7, 1.5)),
        leaf('r2', tf(-5, -6, 30, 0)),
      ]),
    ]);
    for (const placement of placementsInDocument(flat)) {
      const expected = worldMatrix(placement.transform);
      for (const key of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
        expect(placement.world[key], `${placement.node.id}.${key}`).toBeCloseTo(
          expected[key],
          9,
        );
      }
    }
  });

  it('worldMatrix(transform) === world, through one group', () => {
    const placements = placementsInDocument(pageWithGroup());
    expect(placements).toHaveLength(4);
    for (const placement of placements) {
      const expected = worldMatrix(placement.transform);
      for (const key of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
        expect(placement.world[key], `${placement.node.id}.${key}`).toBeCloseTo(
          expected[key],
          9,
        );
      }
    }
  });

  it('worldMatrix(transform) === world, through three levels', () => {
    // Depth 2 is where a careless composition starts disagreeing with itself, and it is a depth M12
    // permits rather than forbids, so it gets its own assertion.
    const deep = doc('deep', [
      page('p1', [
        group(
          'outer',
          [
            group(
              'inner',
              [leaf('leaf', tf(30, 40, 20, 10, 0.2))],
              tf(70, 80, 50, 50, -0.4, 1.5),
            ),
          ],
          tf(11, 13, 90, 90, 0.9, 0.75),
        ),
      ]),
    ]);
    const placement = placementOf(deep, 'leaf');
    if (placement === null) throw new Error('no placement');
    expect(placement.depth).toBe(2);
    expect(placement.ancestors.map((ancestor) => ancestor.id)).toEqual(['outer', 'inner']);
    const expected = worldMatrix(placement.transform);
    for (const key of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
      expect(placement.world[key], key).toBeCloseTo(expected[key], 9);
    }
  });

  it('a child frame centre lands where the group says it does', () => {
    // The brief's "prove page -> group -> child -> local produces the expected world matrix", as two
    // independent routes to one number.
    //
    // The two routes differ in *which* local point they start from, and that difference is the
    // whole subtlety of group-local coordinates:
    //
    //   placement.world        maps the **child's own** box space -> page
    //   worldMatrix(groupNode) maps **group-local** space -> page
    //
    // so the same point is `(w/2, h/2)` on one route and `(child.x + w/2, child.y + h/2)` on the
    // other. Using one for both is a category error that still produces a plausible number, which is
    // why it is worth asserting explicitly rather than assuming.
    const document = pageWithGroup();
    const placement = placementOf(document, 'b');
    const groupNode = groupOf(at(document.pages[0]!.objects, 1));
    const child = nodeById(document, 'b');
    if (placement === null || child === null) throw new Error('setup');

    const viaPlacement = applyPoint(placement.world, {
      x: child.transform.width / 2,
      y: child.transform.height / 2,
    });
    const viaGroup = applyPoint(worldMatrix(groupNode.transform), {
      x: child.transform.x + child.transform.width / 2,
      y: child.transform.y + child.transform.height / 2,
    });

    expect(viaPlacement.x).toBeCloseTo(viaGroup.x, 9);
    expect(viaPlacement.y).toBeCloseTo(viaGroup.y, 9);
    // And the placement is not the identity, so this is not vacuously true.
    expect(
      Math.hypot(viaPlacement.x - child.transform.width / 2, viaPlacement.y),
    ).toBeGreaterThan(50);
  });

  it('a child at the group origin is placed at the group origin', () => {
    // The simplest possible statement of group-local semantics: a child at local (0,0) sits exactly
    // at the group's local origin, mapped to page space.
    const document = doc('origin', [
      page('p1', [
        group('g', [leaf('b', tf(0, 0, 10, 10))], tf(100, 200, 80, 80, 0.5, 2)),
      ]),
    ]);
    const placement = placementOf(document, 'b');
    const placement0 = placement;
    const groupNode = groupOf(at(document.pages[0]!.objects, 0));
    if (placement0 === null) throw new Error('setup');
    const expected = applyPoint(worldMatrix(groupNode.transform), { x: 0, y: 0 });
    expect(placement0.world.e).toBeCloseTo(expected.x, 9);
    expect(placement0.world.f).toBeCloseTo(expected.y, 9);
  });

  it('the inverse conversion round-trips a page point into local and back', () => {
    // The whole of §10's "page point -> inverse group transforms -> inverse own transform ->
    // predicate", as a round trip: unproject a page point into the child's local box and reproject
    // it, and it must come back. If it did not, hit testing would be testing the wrong geometry --
    // and it would still *look* right for a child at the group origin.
    const document = pageWithGroup();
    const placement = placementOf(document, 'b');
    if (placement === null) throw new Error('no placement');
    for (const point of [
      { x: 0, y: 0 },
      { x: 20, y: 15 },
      { x: -140, y: 260 },
    ]) {
      const local = applyPoint(invert(placement.world), point);
      const back = applyPoint(placement.world, local);
      expect(back.x, `x for ${JSON.stringify(point)}`).toBeCloseTo(point.x, 9);
      expect(back.y, `y for ${JSON.stringify(point)}`).toBeCloseTo(point.y, 9);
    }
  });
});

describe('ownership', () => {
  it('locates a node at any depth, naming its owner', () => {
    const child = locateNode(pageWithGroup(), 'c');
    expect(child?.index).toBe(1);
    expect(child?.pageId).toBe('p1');
    const owner = child?.owner;
    if (owner === undefined) throw new Error('owner');
    expect(groupOf(owner as Node).id).toBe('g');

    const top = locateNode(pageWithGroup(), 'd');
    expect(top?.index).toBe(2);
    // A page-level node's owner is the **Page**, not a Node, and that is the distinction a
    // structural command needs: "which array do I write into" is `group.children` or `page.objects`.
    const topOwner = top?.owner;
    if (topOwner === undefined) throw new Error('no owner');
    expect('objects' in topOwner, 'a page owns it').toBe(true);
    expect('children' in topOwner, 'and a page has no children array').toBe(false);
  });

  it('reports the page of a nested node, where the old scan could not', () => {
    // The specific regression M12 would have shipped without this: `page.objects.some(...)` cannot
    // see a group child, so every consumer concluded it was on no page and went inert for it.
    expect(pageIdOf(pageWithGroup(), 'c')).toBe('p1');
    expect(pageIdOf(pageWithGroup(), 'nope')).toBeNull();
  });

  it('refuses a node that appears twice', () => {
    const shared = leaf('shared');
    const duplicated = doc('dup', [
      page('p1', [group('g1', [shared]), group('g2', [shared])]),
    ]);
    const violations = validateDocument(duplicated);
    expect(
      violations.some((v) => v.message.includes('duplicate or cyclic node id "shared"')),
      JSON.stringify(violations),
    ).toBe(true);
  });

  it('refuses a cycle, and the refusal is what makes the traversal safe', () => {
    // Constructible in JavaScript even though JSON cannot express one, so this is not theoretical.
    //
    // The asymmetry is worth stating plainly rather than papering over: **`placementsInDocument`
    // does not survive a cycle** -- it recurses until the stack gives out (a `RangeError`). It is not
    // defended, and that is a decision rather than an oversight: a depth guard on a hot path that
    // runs on every render would cost something measurable to protect against a state the model
    // forbids.
    //
    // What makes it unreachable is `validateDocument`, and there are two enforcement points in
    // front of the traversal -- `deserialize` runs it before returning a document, and the dev
    // overlay runs it on every change -- so no document from a file and no document from the editor
    // can be cyclic. This test is the proof that the enforcement works, and the note above is the
    // reason the traversal is allowed to trust it.
    const inner = group('inner', []);
    const outer = group('outer', [inner]);
    (inner as { children: GroupNode[] }).children = [outer];
    const cyclic = doc('cyc', [page('p1', [outer])]);

    // Terminates, and reports the id the walk came back around to -- exactly one report, because the
    // guard returns before recursing and so nothing downstream is visited twice. (A first draft
    // asserted both ids were reported; only one *is*, and asserting the wrong count would have
    // hidden a guard that reports every repeated visit.)
    const violations = validateDocument(cyclic);
    expect(violations.map((v) => v.message)).toEqual([
      'duplicate or cyclic node id "outer"',
    ]);

    // And the traversal's failure mode, recorded rather than hidden: loud, not silent.
    expect(() => placementsInDocument(cyclic)).toThrow(RangeError);
  });

  it('bounds depth, so a deep-but-valid document is not the same as a cycle', () => {
    // The bound is on reachability, not expressiveness: `MAX_GROUP_DEPTH` groups are fine.
    let node: Node = leaf('leaf');
    for (let index = 0; index < MAX_GROUP_DEPTH - 1; index += 1) {
      node = group(`g${index}`, [node]);
    }
    const deep = doc('deep-ok', [page('p1', [node])]);
    expect(validateDocument(deep), `${MAX_GROUP_DEPTH} levels is reachable`).toEqual([]);
    expect(placementOf(deep, 'leaf')).not.toBeNull();
  });

  it('refuses a non-uniform group scale and names the consequence', () => {
    // ADR 0011 §2's refusal, as a load-time rule. The message matters: "scaleX must equal scaleY"
    // leaves an author to work out why a value they think is valid is refused.
    const sheared = doc('shear', [
      page('p1', [
        group(
          'g',
          [leaf('r', tf(0, 0, 10, 10, 0.5))],
          createTransform({ x: 0, y: 0, width: 50, height: 50, scaleX: 2, scaleY: 1 }),
        ),
      ]),
    ]);
    const violation = validateDocument(sheared).find((v) => v.path.endsWith('.transform'));
    expect(violation, JSON.stringify(validateDocument(sheared))).toBeDefined();
    expect(violation?.message).toContain('uniform');
    expect(violation?.message).toContain('shear');
  });

  it('reports a dangling asset reference inside a nested group, at the full path', () => {
    // The asset check moved *into* `checkNode` in M12 because the parallel walk it replaced had no
    // cycle guard -- and the new site has the guard. That consolidation is invisible to the parser
    // tests, because `deserialize` runs its own recursive check first: the invariant could have lost
    // the descent entirely and every parser test would still pass.
    //
    // So it is asserted here, on `validateDocument` alone, with a group two levels deep.
    const dangling = doc('dangling', [
      page('p1', [
        group('outer', [
          group(
            'inner',
            [
              leaf('r', tf(0, 0, 10, 10)),
              {
                id: 'i',
                type: 'image',
                name: 'i',
                transform: tf(0, 0, 40, 30),
                visible: true,
                locked: false,
                opacity: 1,
                blendMode: 'normal',
                asset: 'nowhere',
              },
            ],
            tf(0, 0, 10, 10),
          ),
        ]),
      ]),
    ]);
    const violation = validateDocument(dangling).find((v) => v.path.endsWith('.asset'));
    expect(violation, JSON.stringify(validateDocument(dangling))).toBeDefined();
    expect(violation?.path, 'and the path reaches the node, not just "some image"').toBe(
      'pages[0].objects[0].children[0].children[1].asset',
    );
    expect(violation?.message).toContain('nowhere');
  });

  it('allows a non-uniform LEAF scale, because nothing is inside a leaf', () => {
    // The asymmetry, and the sharper form of the restriction: what cannot happen is a non-uniform
    // scale *followed by* a rotation. A leaf has no descendants, so its scale is unconstrained -- and
    // forcing it uniform would have been a real regression, caught by
    // `tests/visual/geometry.spec.ts` measuring a painted height of 200 where 50 was authored.
    const scaled = doc('leafscale', [
      page('p1', [
        leaf(
          'r',
          createTransform({ x: 10, y: 10, width: 100, height: 50, scaleX: 2, scaleY: 0.5 }),
        ),
      ]),
    ]);
    expect(validateDocument(scaled)).toEqual([]);
    const placement = placementOf(scaled, 'r');
    expect(placement?.transform.scaleX, 'and the renderer keeps it').toBe(2);
    expect(placement?.transform.scaleY).toBe(0.5);
  });
});

describe('structural edits', () => {
  it('mapNodesByIdIn reaches a nested node and rebuilds only its path', () => {
    const original = pageWithGroup();
    const next = mapNodesByIdIn(original, new Set(['c']), (node) => ({ ...node, name: 'renamed' }));
    expect(nodeById(next, 'c')?.name).toBe('renamed');

    // Everything else keeps its **reference**, which is what makes the renderer's "unchanged" signal
    // and `History`'s no-op rule work at every level rather than only at the page.
    const before = original.pages[0]!.objects;
    const after = next.pages[0]!.objects;
    expect(at(after, 0)).toBe(at(before, 0));
    expect(at(after, 2)).toBe(at(before, 2));
    const groupBefore = groupOf(at(before, 1));
    const groupAfter = groupOf(at(after, 1));
    expect(groupAfter).not.toBe(groupBefore);
    expect(at(groupAfter.children, 0)).toBe(at(groupBefore.children, 0));
    expect(at(groupAfter.children, 1)).not.toBe(at(groupBefore.children, 1));
  });

  it('mapNodesByIdIn returns the SAME document when nothing matches', () => {
    // The no-op rule. A command that matched nothing must not produce a new document identity, or
    // every undo step would be a step that changed nothing.
    const original = pageWithGroup();
    expect(mapNodesByIdIn(original, new Set(['absent']), (node) => node)).toBe(original);
    expect(mapNodesByIdIn(original, new Set<string>(), (node) => node)).toBe(original);
  });

  it('can edit a group and one of its children in a single pass', () => {
    // Not an `else`: a multi-selection spanning a group and a member is legal data, and M12's brief
    // only forbids *producing* it through a gesture.
    const next = mapNodesByIdIn(pageWithGroup(), new Set(['g', 'b']), (node) => ({
      ...node,
      locked: true,
    }));
    expect(nodeById(next, 'g')?.locked).toBe(true);
    expect(nodeById(next, 'b')?.locked).toBe(true);
    expect(nodeById(next, 'c')?.locked, 'and the sibling is untouched').toBe(false);
  });

  it('removeNodesById removes a group child from inside its group', () => {
    const next = removeNodesById(pageWithGroup(), new Set(['b']));
    expect(nodeIdsInPaintOrder(next)).toEqual(['a', 'c', 'd']);
    const groupAfter = groupOf(at(next.pages[0]!.objects, 1));
    expect(groupAfter.children).toHaveLength(1);
  });

  it('removing a group takes its subtree, without needing its children named', () => {
    const next = removeNodesById(pageWithGroup(), new Set(['g']));
    expect(nodeIdsInPaintOrder(next)).toEqual(['a', 'd']);
    expect(nodeById(next, 'b'), 'b went with the group it lived in').toBeNull();
  });

  it('removeNodesById is inert for an id that matches nothing', () => {
    const original = pageWithGroup();
    expect(removeNodesById(original, new Set(['nope']))).toBe(original);
    expect(removeNodesById(original, new Set<string>())).toBe(original);
  });

  it('removes from inside a group and leaves a sibling group alone', () => {
    const document = doc('two', [
      page('p1', [group('g1', [leaf('x'), leaf('y')])]),
    ]);
    const next = removeNodesById(document, new Set(['x']));
    expect(nodeIdsOnPage(next.pages[0]!)).toEqual(['y']);
  });
});

describe('multi-page', () => {
  it('walk order is page by page', () => {
    const document = doc('multi', [
      page('p1', [leaf('a1')]),
      page('p2', [group('g', [leaf('a2')]), leaf('a3')]),
    ]);
    expect(nodeIdsInPaintOrder(document)).toEqual(['a1', 'a2', 'a3']);
    expect(nodeIdsOnPage(document.pages[0]!)).toEqual(['a1']);
    expect(nodeIdsOnPage(document.pages[1]!)).toEqual(['a2', 'a3']);
    expect(pageIdOf(document, 'a2')).toBe('p2');
  });

  it('an id present on two pages resolves to the first, and the invariant forbids the file', () => {
    // The parser's job, not the traversal's: `collectIds` catches the duplicate at load, so the
    // traversal's ambiguity is unreachable from a file. Asserted because the traversal *would*
    // silently pick the first, and silent is what is being avoided.
    const clashing = doc('clash', [
      page('p1', [leaf('same')]),
      page('p2', [leaf('same')]),
    ]);
    expect(pageIdOf(clashing, 'same')).toBe('p1');
    expect(validateDocument(clashing).some((v) => v.message.includes('duplicate'))).toBe(true);
  });
});

describe('small things that are easy to get wrong', () => {
  it('does not leak the ancestor array between calls', () => {
    // The array is rebuilt per node rather than shared and pushed, because a shared array would let
    // one node's traversal leak into the next page's.
    const document = pageWithGroup();
    const first = placementsOnPage(document.pages[0]!);
    const second = placementsOnPage(document.pages[0]!);
    expect(first[1]?.ancestors).not.toBe(second[1]?.ancestors);
    expect(first[1]?.ancestors.map((ancestor) => ancestor.id)).toEqual(['g']);
    expect(second[1]?.ancestors.map((ancestor) => ancestor.id)).toEqual(['g']);
  });

  it('an empty page yields no placements', () => {
    expect(placementsOnPage(page('p1', []))).toEqual([]);
  });

  it('a group with no children contributes nothing to the paint order, and stays authored', () => {
    // Empty groups are legal, and they are the one thing invisible in the flattened output while
    // still being authored content. It round-trips, renders as nothing, and must not be dropped:
    // a later "optimisation" that discarded empty groups would be an unreported data loss.
    const document = doc('empty-group', [page('p1', [group('g', [])])]);
    expect(placementsInDocument(document)).toEqual([]);
    expect(validateDocument(document)).toEqual([]);
    expect(nodeById(document, 'g')).not.toBeNull();
  });

  it('rotation is additive down a chain, and the sum is the composed angle', () => {
    // The invariant that makes `rotation` the authoritative field at any depth, and the reason the
    // model never needs a derived "polar rotation" (ADR 0011 §3: expose the authored field).
    const document = doc('angles', [
      page('p1', [
        group(
          'g',
          [
            group(
              'g2',
              [leaf('r', tf(0, 0, 10, 10, 15 * DEG))],
              tf(0, 0, 10, 10, 45 * DEG),
            ),
          ],
          tf(0, 0, 10, 10, 30 * DEG),
        ),
      ]),
    ]);
    const placement = placementOf(document, 'r');
    if (placement === null) throw new Error('no placement');
    expect(placement.transform.rotation).toBeCloseTo(90 * DEG, 9);
    // And the matrix agrees, which is what proves the sum rather than "close to it".
    expect(placement.world.a).toBeCloseTo(Math.cos(90 * DEG), 9);
    expect(placement.world.b).toBeCloseTo(Math.sin(90 * DEG), 9);
  });

  it('a uniform group scale multiplies through to the child', () => {
    // The rule ADR 0011 §7 will need for M12's group scaling: the child's own size is unchanged, and
    // the scale reaches it as a product. `width`/`height` do **not** multiply -- they are the child's
    // local box, which is the M11 contract.
    const document = doc('scaled', [
      page('p1', [group('g', [leaf('r', tf(0, 0, 20, 10))], tf(0, 0, 50, 50, 0, 3))]),
    ]);
    const placement = placementOf(document, 'r');
    if (placement === null) throw new Error('setup');
    expect(placement.transform.scaleX).toBe(3);
    expect(placement.transform.scaleY).toBe(3);
    expect(placement.transform.width, 'the local box is unchanged').toBe(20);
    expect(placement.transform.height).toBe(10);
  });
});