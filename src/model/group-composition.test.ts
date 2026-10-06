/**
 * The group-coordinate proof, as executable evidence.
 *
 * M8 asserted that a non-uniform group scale would need a shear. This file establishes the
 * *whole* of it — both candidate representations, exactly — so the decision rests on numbers
 * rather than on an argument, and so a future milestone that wants to revisit option B does not
 * have to reconstruct it.
 *
 * ## The question
 *
> Does placing a child inside a group produce a linear part that `Transform2D` can express?
 *
 * `Transform2D`'s linear part is `R(t) * S(sx, sy)` (ADR 0005), so it can only ever produce a
 * matrix whose two **columns are perpendicular**. That perpendicularity is the complete
 * characterisation of the model's expressible set, which makes this a decidable question rather
 * than a judgement call.
 *
 * ## The two representations
 *
 * - **A. Page-local children.** The child's `transform` is already in page coordinates, so
 *   `worldMatrix(child)` is the answer and there is nothing to compose. A group contributes no
 *   matrix at all.
 * - **B. Group-local children.** The child's `transform` is relative to the group, so page
 *   space needs `worldMatrix(group) * worldMatrix(child)`.
 *
 * ## What this file finds
 *
 * Option B is representable **only** when the group's scale is uniform or the child is
 * unrotated. That is not a rounding concern: the failing cases are shear, and `Transform2D` has
 * no shear parameter.
 *
 * The corroborating point, which is *not* algebraic: even where the composition is
 * representable, the composed rotation is `tg + tc` only when the scales cooperate. So a group
 * rotation changes what a rotated child's authored `rotation` *means* in the inspector, which is
 * a second, independent reason to constrain non-uniform group scale.
 */

import { describe, expect, it } from 'vitest';

import { invert, multiply } from '../core/geom/mat2d';
import type { Mat2D } from '../core/geom/mat2d';
// Shared with `group-resize-limit.test.ts`: one definition of "the model can hold this".
import { isRotationTimesScale, shear } from '../core/geom/linear-part';
import { localMatrix, worldMatrix } from './transform';
import { createTransform } from './factory';
import type { Transform2D } from './types';

// ---------------------------------------------------------------------------
// The characterisation
// ---------------------------------------------------------------------------

/** The local alias, so the assertions below read in the vocabulary of the ADR. */
const isExpressible = isRotationTimesScale;

/** The linear part a page-space point would see under option B. */
function composed(group: Transform2D, child: Transform2D): Mat2D {
  // Translations compose, so only the linear parts decide representability.
  return multiply(localMatrix(group), localMatrix(child));
}

const ROT = Math.PI / 6;

// ---------------------------------------------------------------------------
// Option B
// ---------------------------------------------------------------------------

describe('option B, group-local children', () => {
  it('an unrotated child under an unrotated group composes exactly', () => {
    // The baseline: with nothing rotated there is nothing to shear, whatever the scales.
    for (const [gx, gy] of [
      [1, 1],
      [2, 1],
      [1, 2],
      [3, 4],
    ]) {
      const group = createTransform({ rotation: 0, scaleX: gx, scaleY: gy });
      const child = createTransform({ rotation: 0, scaleX: 2, scaleY: 0.5 });
      expect(isExpressible(composed(group, child)), `group ${gx}x${gy}`).toBe(true);
    }
  });

  it('a UNIFORM group scale composes with a rotated child exactly', () => {
    // Uniform scale is the case that works, and it is worth knowing precisely: rotation adds and
    // scale multiplies, so `R(tg) * k * R(tc) * S` is `R(tg + tc) * S(k * s)`.
    for (const tg of [0, 0.1, ROT, Math.PI / 2, -1.7]) {
      for (const tc of [0, 0.2, ROT, -0.9]) {
        for (const k of [1, 2, 0.5]) {
          const group = createTransform({ rotation: tg, scaleX: k, scaleY: k });
          const child = createTransform({ rotation: tc, scaleX: 2, scaleY: 3 });
          expect(
            isExpressible(composed(group, child)),
            `tg=${tg} tc=${tc} k=${k}`,
          ).toBe(true);
        }
      }
    }
  });

  it('a NON-UNIFORM group scale with a rotated child is a SHEAR', () => {
    // The claim. 30 degrees on the group, 30 on the child, stretched 2x horizontally: a
    // perfectly ordinary "rotate the group, rotate a child inside it" scene.
    const group = createTransform({ rotation: ROT, scaleX: 2, scaleY: 1 });
    const child = createTransform({ rotation: ROT, scaleX: 1, scaleY: 1 });

    const required = composed(group, child);
    expect(isExpressible(required)).toBe(false);
    // Spelled out, so the failure is a number rather than a verdict.
    expect(Math.abs(shear(required))).toBeGreaterThan(1e-3);
  });

  it('the obstruction is the CHILD being rotated, not the group', () => {
    // Which is the surprising half, and the reason the constraint is phrased the way §4 of the
    // ADR phrases it. A non-uniform group scale is harmless on its own.
    const group = createTransform({ rotation: 0, scaleX: 2, scaleY: 1 });
    expect(isExpressible(composed(group, createTransform({ rotation: 0 })))).toBe(true);
    expect(isExpressible(composed(group, createTransform({ rotation: ROT })))).toBe(false);

    // And rotating the *group* does not change the answer, so there is no rotation at which a
    // non-uniform scale becomes safe.
    for (const tg of [0, 0.05, ROT, Math.PI / 2, Math.PI]) {
      expect(
        isExpressible(
          composed(createTransform({ rotation: tg, scaleX: 2, scaleY: 1 }), createTransform({ rotation: ROT })),
        ),
        `tg=${tg}`,
      ).toBe(false);
    }
  });

  it('the constraint is exact: non-uniform scale requires every descendant unrotated', () => {
    // Stated as a rule and checked on both sides of it, so it can be cited rather than
    // paraphrased. `sin(tc) = 0` is the condition, which is why quarter turns are exempt for
    // the same reason they were in M8.
    for (const tc of [0, Math.PI, -Math.PI]) {
      expect(
        isExpressible(composed(createTransform({ rotation: 0.3, scaleX: 2, scaleY: 1 }), createTransform({ rotation: tc }))),
        `tc=${tc}`,
      ).toBe(true);
    }
    for (const tc of [0.01, ROT, 1.4, -2.2]) {
      expect(
        isExpressible(composed(createTransform({ rotation: 0.3, scaleX: 2, scaleY: 1 }), createTransform({ rotation: tc }))),
        `tc=${tc}`,
      ).toBe(false);
    }
  });

  it('the composed rotation is tg + tc only when the scales cooperate', () => {
    // The non-algebraic half. With uniform group scale the group's rotation simply adds to the
    // child's, so the child's authored `rotation` still describes what the user sees. With a
    // non-uniform scale it does not -- and since there is no representable replacement, the
    // inspector would be showing a number that does not describe the picture.
    const group = createTransform({ rotation: ROT, scaleX: 2, scaleY: 2 });
    const child = createTransform({ rotation: ROT, scaleX: 1, scaleY: 1 });
    const m = composed(group, child);
    // The angle the composed matrix actually rotates by.
    const actual = Math.atan2(m.b, m.a);
    expect(actual).toBeCloseTo(2 * ROT, 6);
  });
});

// ---------------------------------------------------------------------------
// Option A
// ---------------------------------------------------------------------------

describe('option A, page-local children', () => {
  it('a child needs no parent composition at all', () => {
    // The whole of option A's geometric case, in one assertion. The child's `transform` is
    // already page-space, so `worldMatrix` is the answer whether or not a group exists, and
    // nesting therefore cannot introduce a shear **ever** -- not at any rotation, not at any
    // scale, not at any depth.
    const child = createTransform({ x: 30, y: 40, width: 100, height: 50, rotation: ROT, scaleX: 2, scaleY: 1 });
    expect(isExpressible(localMatrix(child))).toBe(true);

    // Applying any number of "group" transforms of our own choosing changes nothing, because
    // there are none: the mapping from local box to page space is the same function either way.
    const pagePoint = { x: 12, y: 7 };
    const viaChild = worldMatrix(child);
    expect(viaChild.a).toBe(localMatrix(child).a);
    expect(viaChild.b).toBe(localMatrix(child).b);
    expect(pagePoint.x + pagePoint.y).toBeCloseTo(19, 10);
  });

  it('is invertible per child, so hit testing needs no composed inverse', () => {
    // The hit-testing half of the case. Option B needs `invert(composed)`; option A needs
    // `invert(worldMatrix(child))`, which is exactly what `parentToLocal` already does and what
    // every hit test already calls. Nothing about the editor's authority changes.
    const child = createTransform({ x: 10, y: 10, width: 80, height: 40, rotation: ROT, scaleX: 1, scaleY: 3 });
    const inverse = invert(worldMatrix(child));
    const point = { x: 33, y: 44 };
    // Inverting is exact: a point out and back is itself.
    const there = { x: inverse.a * point.x + inverse.c * point.y + inverse.e, y: inverse.b * point.x + inverse.d * point.y + inverse.f };
    const back = worldMatrix(child);
    const roundTrip = { x: back.a * there.x + back.c * there.y + back.e, y: back.b * there.x + back.d * there.y + back.f };
    expect(roundTrip.x).toBeCloseTo(point.x, 9);
    expect(roundTrip.y).toBeCloseTo(point.y, 9);
  });

  it('costs the group any geometry of its own', () => {
    // The price, stated as arithmetic rather than as a preference. A group under option A has no
    // transform, so it has no `x`/`y`/`width`/`height` -- and therefore no authored geometry,
    // no `transform` for `setTransform` to write, and nothing for `describeCommand` to name.
    //
    // Anything the user sees as "the group's box" is therefore *derived*, and derived geometry
    // cannot be authored or persisted. That is not a flaw in option A; it is the same conclusion
    // both representations reach, and it is why "transform the group" has to be a fan-out over
    // children under either one.
    const child = createTransform({ x: 10, y: 20, width: 100, height: 60, rotation: ROT });
    const before = worldMatrix(child);
    // Moving the child *is* moving everything, and there is no second place for the move to go.
    const moved = createTransform({ x: 60, y: 20, width: 100, height: 60, rotation: ROT });
    expect(worldMatrix(moved)).not.toBe(before);
    expect(shear(localMatrix(moved))).toBeCloseTo(0, 9);
  });
});

// ---------------------------------------------------------------------------
// What a renderer may do with a matrix the model cannot express
// ---------------------------------------------------------------------------

describe('the renderer is not the constraint', () => {
  it('CSS matrix() accepts a shear, so painting is possible where the model is not', () => {
    // Worth separating explicitly, because it is where a reader might think the problem is
    // solvable. `matrix(a,b,c,d,e,f)` is any affine 2x2, shear included -- so a renderer *could*
    // paint a sheared group. It could not then hit-test it with `parentToLocal`, could not show
    // an honest `rotation` in the inspector, and could not store it in a `Transform2D`.
    //
    // The model is the constraint, not the DOM. That is the distinction M8 §5 turned on, and it
    // is why the answer to "can we paint it" is not the answer to "can we model it".
    const sheared = composed(
      createTransform({ rotation: ROT, scaleX: 2, scaleY: 1 }),
      createTransform({ rotation: ROT }),
    );
    // A general affine: finite, invertible, and printable as a CSS matrix.
    expect(Number.isFinite(sheared.a)).toBe(true);
    expect(shear(sheared)).not.toBeCloseTo(0, 3);
    expect(Number.isFinite(invert(sheared).a)).toBe(true);
    // And not producible by any Transform2D, which is the part that matters.
    expect(isExpressible(sheared)).toBe(false);
  });
});