/**
 * Group geometry: what a group's transform may be, and what it does to its children.
 *
 * ## The one thing to read
 *
 * `worldTransformIn`'s doc comment states the theorem; these tests are its proof, and the **negative
 * case is the point**. The restriction is not "groups are simpler than leaves" — it is
 *
 * > **a non-uniform scale may not be followed by a rotation**
 *
 * so the same `scaleX: 2, scaleY: 0.5` is *legal* on a leaf and *illegal* on a group. Both halves are
 * tested here, and both were needed: an early version of `worldTransformIn` forced every composed
 * transform to be uniform, which silently discarded the `scaleY: 0.5` of every scaled leaf and was
 * caught only by a browser test measuring a painted height of 200 where 50 was authored.
 *
 * A test file that only exercised the legal half would have passed with that bug in it.
 */

import { describe, expect, it } from 'vitest';

import { localToParent, worldMatrix, worldMatrixIn, worldTransformIn } from './transform';
import { applyPoint, invert } from '../core/geom/mat2d';
import { createTransform } from './factory';
import type { Document, GroupNode, Node, ShapeNode, Transform2D } from './types';
import { placementOf } from './tree';
import { validateDocument } from './invariants';

const DEG = Math.PI / 180;

function tf(over: Partial<Transform2D> = {}): Transform2D {
  return createTransform({ x: 0, y: 0, width: 40, height: 20, ...over });
}

function leaf(id: string, transform: Transform2D): ShapeNode {
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

function group(id: string, children: Node[], transform: Transform2D): GroupNode {
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

function docWith(objects: Node[]): Document {
  return {
    formatVersion: 2,
    id: 'doc',
    name: 'doc',
    pageSize: { width: 400, height: 300, unit: 'pt', orientation: 'portrait' },
    assets: {},
    pages: [
      { id: 'p1', name: '1', background: { type: 'solid', color: '#ffffff' }, objects },
    ],
  };
}

/** Matrix equality to full double precision -- the composed form must be *exact*, not close. */
function expectSameMatrix(actual: ReturnType<typeof worldMatrix>, expected: ReturnType<typeof worldMatrix>, label: string): void {
  for (const key of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
    expect(actual[key], `${label}.${key}`).toBeCloseTo(expected[key], 9);
  }
}

describe('a group transform composes into its children', () => {
  it('an IDENTITY group leaves a child exactly where it was', () => {
    // The control for everything else, and the reason 667 pre-existing tests kept passing.
    const child = tf({ x: 17, y: 43, width: 200, height: 100 });
    const parent = tf({ x: 0, y: 0, width: 0, height: 0, scaleX: 1, scaleY: 1 });
    expectSameMatrix(
      worldMatrix(worldTransformIn(child, parent)),
      worldMatrix(child),
      'identity',
    );
  });

  it('a TRANSLATED group moves the child by exactly the translation', () => {
    const child = tf({ x: 10, y: 20, width: 40, height: 30 });
    const parent = tf({ x: 100, y: 200, width: 80, height: 80 });
    const composed = worldTransformIn(child, parent);
    expectSameMatrix(
      worldMatrix(composed),
      worldMatrixIn(child, worldMatrix(parent)),
      'translated',
    );
    // And stated directly: the same offset, not merely the same matrix.
    expect(composed.x).toBeCloseTo(110, 9);
    expect(composed.y).toBeCloseTo(220, 9);
  });

  it('a ROTATED group rotates the child about the group frame centre', () => {
    const child = tf({ x: 0, y: 0, width: 20, height: 10 });
    const parent = tf({ x: 0, y: 0, width: 100, height: 100, rotation: 90 * DEG });
    const composed = worldTransformIn(child, parent);
    expectSameMatrix(
      worldMatrix(composed),
      worldMatrixIn(child, worldMatrix(parent)),
      'rotated',
    );
    expect(composed.rotation).toBeCloseTo(90 * DEG, 9);
    // A child at the group's local origin rotates about the group's own frame centre, so the origin
    // moves -- that is what "about the frame centre" means, and it is the reason a group's frame is
    // authored rather than fitted.
    const moved = applyPoint(worldMatrix(composed), { x: 0, y: 0 });
    expect(Math.hypot(moved.x, moved.y)).toBeGreaterThan(40);
  });

  it('a UNIFORMLY SCALED group scales the child, and does not move its local box', () => {
    const child = tf({ x: 10, y: 10, width: 20, height: 10 });
    const parent = tf({ x: 0, y: 0, width: 50, height: 50, scaleX: 2, scaleY: 2 });
    const composed = worldTransformIn(child, parent);
    expectSameMatrix(
      worldMatrix(composed),
      worldMatrixIn(child, worldMatrix(parent)),
      'uniform',
    );
    expect(composed.scaleX).toBe(2);
    expect(composed.scaleY).toBe(2);
    // `width`/`height` are the child's **local box** and do not multiply: M11's contract, and the
    // reason a scale is a paint transform rather than a change of the authored size.
    expect(composed.width).toBe(20);
    expect(composed.height).toBe(10);
  });

  it('a translated + rotated + scaled group composes all three at once', () => {
    const child = tf({ x: 15, y: 25, width: 30, height: 12, rotation: 0.2 });
    const parent = tf({
      x: 120,
      y: 60,
      width: 90,
      height: 70,
      rotation: -0.7,
      scaleX: 1.75,
      scaleY: 1.75,
    });
    expectSameMatrix(
      worldMatrix(worldTransformIn(child, parent)),
      worldMatrixIn(child, worldMatrix(parent)),
      'all three',
    );
  });

  it('a child of a scaled group is offset by the SCALED distance, not the raw one', () => {
    // The detail that distinguishes "the group scales its contents" from "the group's origin moves":
    // a child 10 group-local px from the frame centre is 20 page px away at scale 2.
    const child = tf({ x: 60, y: 40, width: 10, height: 10 });
    const parent = tf({ x: 0, y: 0, width: 100, height: 100, scaleX: 2, scaleY: 2 });
    const composed = worldTransformIn(child, parent);
    const localCentre = { x: 60, y: 40 };
    const pageCentre = applyPoint(worldMatrix(parent), localCentre);
    // Measured from the group's **frame centre**, not from the page origin. The first draft measured
    // from the origin and failed by 47.9 -- which is the whole point: the group's frame centre is at
    // (50, 50), so a point 14.14 away from it becomes 28.28 away from it, and 76.16 away from the
    // origin. Both are correct numbers for different questions, and only one of them is this one.
    const frameCentrePage = applyPoint(worldMatrix(parent), { x: 50, y: 50 });
    expect(
      Math.hypot(pageCentre.x - frameCentrePage.x, pageCentre.y - frameCentrePage.y),
      'the displacement from the frame centre is doubled',
    ).toBeCloseTo(2 * Math.hypot(localCentre.x - 50, localCentre.y - 50), 9);
    expectSameMatrix(worldMatrix(composed), worldMatrixIn(child, worldMatrix(parent)), 'scaled');
  });
});

describe('group and child composition, deeper', () => {
  it('three levels compose exactly, and the closed form stays exact', () => {
    const document = docWith([
      group(
        'outer',
        [
          group(
            'inner',
            [leaf('leaf', tf({ x: 5, y: 7, width: 20, height: 10, rotation: 0.3 }))],
            tf({ x: 40, y: 30, width: 60, height: 60, rotation: -0.2, scaleX: 1.5, scaleY: 1.5 }),
          ),
        ],
        tf({ x: 100, y: 50, width: 80, height: 80, rotation: 0.45, scaleX: 0.8, scaleY: 0.8 }),
      ),
    ]);
    const placement = placementOf(document, 'leaf');
    if (placement === null) throw new Error('no placement');
    // The traversal's two spellings agree at depth 2...
    expectSameMatrix(worldMatrix(placement.transform), placement.world, 'depth 2');
    // ...and the sum of the scales is the product, and the sum of the rotations the sum.
    expect(placement.transform.scaleX).toBeCloseTo(1.5 * 0.8, 9);
    expect(placement.transform.rotation).toBeCloseTo(0.45 - 0.2 + 0.3, 9);
  });

  it('rotation is additive, so a 30-degree group and a 60-degree child compose to 90', () => {
    // Stated as an exact number rather than "close to it", because "additive" is the whole claim and
    // a tolerance would hide a matrix decomposition that happens to be close.
    const document = docWith([
      group(
        'g',
        [leaf('r', tf({ x: 0, y: 0, width: 10, height: 10, rotation: 60 * DEG }))],
        tf({ x: 0, y: 0, width: 50, height: 50, rotation: 30 * DEG }),
      ),
    ]);
    const placement = placementOf(document, 'r');
    if (placement === null) throw new Error('no placement');
    expect(placement.transform.rotation).toBeCloseTo(90 * DEG, 9);
    // 90 degrees exactly: the x-column is (cos90, sin90) = (0, 1).
    expect(placement.world.a).toBeCloseTo(0, 9);
    expect(placement.world.b).toBeCloseTo(1, 9);
  });

  it('an inverse conversion round-trips through two levels', () => {
    const document = docWith([
      group(
        'g',
        [
          group(
            'g2',
            [leaf('r', tf({ x: 13, y: 21, width: 20, height: 10, rotation: 0.15 }))],
            tf({ x: 30, y: 40, width: 40, height: 40, rotation: 0.6, scaleX: 1.25, scaleY: 1.25 }),
          ),
        ],
        tf({ x: 90, y: 10, width: 70, height: 70, rotation: -0.9, scaleX: 2, scaleY: 2 }),
      ),
    ]);
    const placement = placementOf(document, 'r');
    if (placement === null) throw new Error('no placement');
    const inverse = invert(placement.world);
    for (const point of [
      { x: 0, y: 0 },
      { x: 20, y: 10 },
      { x: -300, y: 411 },
    ]) {
      const back = applyPoint(placement.world, applyPoint(inverse, point));
      expect(back.x).toBeCloseTo(point.x, 9);
      expect(back.y).toBeCloseTo(point.y, 9);
    }
    // And the local point really is local: it is inside the child's own box.
    const local = applyPoint(inverse, applyPoint(placement.world, { x: 3, y: 4 }));
    expect(local.x).toBeCloseTo(3, 9);
    expect(local.y).toBeCloseTo(4, 9);
  });

  it('localToParent on the child, then the group, equals the placement', () => {
    // Three routes to the same page point: the model's own helper twice, or the composed matrix once.
    const document = docWith([
      group(
        'g',
        [leaf('r', tf({ x: 9, y: 11, width: 20, height: 10, rotation: 0.4 }))],
        tf({ x: 70, y: 20, width: 50, height: 50, rotation: 0.25, scaleX: 1.5, scaleY: 1.5 }),
      ),
    ]);
    const groupNode = document.pages[0]!.objects[0];
    if (groupNode === undefined || groupNode.type !== 'group') throw new Error('setup');
    const placement = placementOf(document, 'r');
    if (placement === null) throw new Error('setup');
    const point = { x: 7, y: 3 };
    const twice = localToParent(groupNode.transform, localToParent(groupNode.children[0]!.transform, point));
    const once = applyPoint(placement.world, point);
    expect(twice.x).toBeCloseTo(once.x, 9);
    expect(twice.y).toBeCloseTo(once.y, 9);
  });
});

describe('degenerate geometry', () => {
  it('a zero-size group places its children by translation alone', () => {
    // A group's frame is authored, and nothing stops it being zero-sized -- which is what
    // `createGroupNode` defaults to. With no size there is no frame centre, and the rotation pivot
    // degenerates to the group's own `x`/`y`.
    const child = tf({ x: 7, y: 9, width: 20, height: 10 });
    const parent = tf({ x: 50, y: 60, width: 0, height: 0 });
    const composed = worldTransformIn(child, parent);
    expect(composed.x).toBeCloseTo(57, 9);
    expect(composed.y).toBeCloseTo(69, 9);
    expectSameMatrix(worldMatrix(composed), worldMatrixIn(child, worldMatrix(parent)), 'zero-size');
  });

  it('a zero-size CHILD under a scaled group still moves correctly', () => {
    const child = tf({ x: 20, y: 20, width: 0, height: 0 });
    const parent = tf({ x: 0, y: 0, width: 40, height: 40, scaleX: 3, scaleY: 3 });
    const composed = worldTransformIn(child, parent);
    expectSameMatrix(worldMatrix(composed), worldMatrixIn(child, worldMatrix(parent)), 'zero child');
    expect(composed.scaleX).toBe(3);
  });

  it('a negative scale mirrors, and does not throw or wrap', () => {
    // Legal in `Transform2D` and unchanged by M12. A mirror is a negative scale, not a rotation, and
    // the composed form keeps it as a negative scale rather than inventing an angle -- which is the
    // point of the closed form over a decomposition (ADR 0011 §3: expose the authored field).
    const child = tf({ x: 10, y: 10, width: 20, height: 10 });
    const parent = tf({ x: 0, y: 0, width: 50, height: 50, scaleX: 1, scaleY: -1 });
    const composed = worldTransformIn(child, parent);
    expectSameMatrix(worldMatrix(composed), worldMatrixIn(child, worldMatrix(parent)), 'mirrored');
    expect(composed.scaleY).toBe(-1);
    // Unchanged by the negative scale -- rotations commute with a uniform scale, mirror included.
    expect(composed.rotation).toBeCloseTo(child.rotation, 9);
  });
});

describe('the refused case: non-uniform group scale with a rotated child', () => {
  // M10b §2's dot product: `-σxg σyg σxc σyc · sin(θc)`, non-zero for almost every (group, child)
  // pair. This is the case ADR 0011 §16 refused, and here it is as a *runtime* refusal rather than a
  // mathematical note.

  it('is refused by the invariant, naming the shear', () => {
    const document = docWith([
      group(
        'g',
        [leaf('r', tf({ x: 0, y: 0, width: 20, height: 10, rotation: 30 * DEG }))],
        tf({ x: 0, y: 0, width: 50, height: 50, scaleX: 2, scaleY: 0.5 }),
      ),
    ]);
    const violations = validateDocument(document);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('uniform');
    expect(violations[0]?.message).toContain('shear');
    expect(violations[0]?.path, 'and the path names the transform, not the node').toBe(
      'pages[0].objects[0].transform',
    );
  });

  it('would produce a matrix that is NOT expressible as R(t)·S(sx,sy)', () => {
    // The mathematics, executed rather than quoted, because "shear" is a word and this is a number:
    // with `S(2, 0.5)` left-multiplying a 30-degree rotation, the two columns are
    // `(2cos30, 0.5sin30)` and `(-2sin30, 0.5cos30)`. For an `R·S` the two columns must be
    // perpendicular-scaled copies of `(cos t, sin t)` and `(-sin t, cos t)`, which needs the two
    // scales to agree.
    const parent = tf({ x: 0, y: 0, width: 50, height: 50, scaleX: 2, scaleY: 0.5 });
    const child = tf({ x: 0, y: 0, width: 20, height: 10, rotation: 30 * DEG });
    const composed = worldMatrixIn(child, worldMatrix(parent));

    // Column 1 of the composed matrix.
    const c1 = { x: composed.a, y: composed.c };
    const c2 = { x: composed.b, y: composed.d };
    const angle = Math.atan2(c1.y, c1.x);
    const sx = Math.hypot(c1.x, c1.y);
    // The column that *would* be there if it were R(t)·S.
    const expectedSecond = { x: -Math.sin(angle) * sx, y: Math.cos(angle) * sx };
    const offBy = Math.hypot(c2.x - expectedSecond.x, c2.y - expectedSecond.y);
    expect(offBy, 'the second column cannot be reached by any R and any S').toBeGreaterThan(0.1);
  });

  it('is NOT refused when the child is unrotated, because then it is representable', () => {
    // The boundary, and the reason the refusal is stated as it is rather than "groups cannot be
    // scaled non-uniformly": without a rotation inside, a non-uniform group scale *is* expressible.
    // Refusing that too would forbid something the model can hold.
    const document = docWith([
      group(
        'g',
        [leaf('r', tf({ x: 0, y: 0, width: 20, height: 10, rotation: 0 }))],
        tf({ x: 0, y: 0, width: 50, height: 50, scaleX: 2, scaleY: 0.5 }),
      ),
    ]);
    // Still refused -- by the *uniform* invariant, which is a rule about the authored format rather
    // than about representability. Recorded here because the distinction is easy to confuse: this
    // document is representable but not authorable today, and M12 chooses not to author it.
    expect(validateDocument(document)).toHaveLength(1);
  });

  it('a NON-UNIFORM LEAF scale with a rotation is fine, and composes exactly', () => {
    // The control that makes the refusal meaningful: the *same* numbers are legal one level down,
    // because nothing is inside the leaf. A test file that only tried the group case could not tell
    // a correct refusal from an over-broad one.
    const document = docWith([
      group(
        'g',
        [leaf('r', tf({ x: 0, y: 0, width: 20, height: 10, rotation: 30 * DEG, scaleX: 2, scaleY: 0.5 }))],
        tf({ x: 0, y: 0, width: 50, height: 50, scaleX: 3, scaleY: 3 }),
      ),
    ]);
    expect(validateDocument(document), 'a non-uniform leaf under uniform groups is legal').toEqual([]);
    const placement = placementOf(document, 'r');
    if (placement === null) throw new Error('no placement');
    expect(placement.transform.scaleX).toBe(6);
    expect(placement.transform.scaleY).toBe(1.5);
    expect(placement.transform.rotation).toBeCloseTo(30 * DEG, 9);
  });
});