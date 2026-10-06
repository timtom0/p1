/**
 * M13 §14: the grouping transform, proved numerically before it is written into a command.
 *
 * The claim being checked is that grouping can be made **purely structural**. If a group's authored
 * transform is the identity-on-page-space (`x=0, y=0, rotation=0, scaleX=scaleY=1`), then for a
 * child authored page-locally,
 *
 *   worldTransformIn(childLocal, groupTransform) === childPageLocal
 *
 * exactly, for *every* child, because `worldMatrix` of an identity frame is the identity matrix
 * regardless of width/height. That would make grouping a tree edit with **no** coordinate
 * conversion at all -- which is a far stronger and simpler guarantee than converting and hoping.
 *
 * The run also checks the general conversion (a non-identity group), because ungroup has to do it
 * for real, and the nested case.
 */
import { describe, expect, it } from 'vitest';
import type { Transform2D } from './types';
import { worldMatrix, worldTransformIn } from './transform';
import { multiply, applyPoint, invert } from '../core/geom/mat2d';
import type { Mat2D } from '../core/geom/mat2d';

/** The child frames the proofs run over: unrotated, rotated, uniform, non-uniform, and both. */
const children: Transform2D[] = [
  { x: 10, y: 20, width: 100, height: 50, rotation: 0, scaleX: 1, scaleY: 1 },
  { x: 10, y: 20, width: 100, height: 50, rotation: 0.6, scaleX: 1, scaleY: 1 },
  { x: 10, y: 20, width: 100, height: 50, rotation: 0, scaleX: 2, scaleY: 2 },
  { x: 10, y: 20, width: 100, height: 50, rotation: 0, scaleX: 2, scaleY: 0.5 },
  { x: 10, y: 20, width: 100, height: 50, rotation: -0.3, scaleX: 1.5, scaleY: 0.75 },
];

/**
 * Reads a `Transform2D` back out of a matrix -- the general form of the grouping conversion.
 *
 * Written here rather than in production because **M13's grouping does not need it**: grouping
 * creates a *transparent* group, so no conversion runs at all, and ungroup promotes with
 * `worldTransformIn`, which already exists. This exists to *prove* the claim that the conversion is
 * always expressible -- a non-uniform child inside a rotated, scaled group is the case that would
 * silently fail if it were not, and it is only checkable by decomposing.
 *
 * Two conventions, both of which a plausible-looking implementation gets wrong:
 *
 * - `Mat2D` is stored column-major for the linear part: `applyPoint` reads
 *   `x' = a·x + c·y`, `y' = b·x + d·y`, so the columns are `(a, b)` and `(c, d)`.
 * - `(e, f)` is **not** the frame's `x`/`y`. `worldMatrix` is
 *   `T(x + w/2, y + h/2)·L·T(-w/2, -h/2)`, so `x`/`y` position the box's centre and `(e, f)` is
 *   the transformed top-left corner. The centre is `centre = (e, f) + L·(w/2, h/2)`.
 *
 * There is **no** such inverse in production code, and adding one would be a second geometry system
 * for a conversion that turns out to be unnecessary. This is the probe that justifies not adding it.
 */
function decomposeFrame(m: Mat2D, width: number, height: number): Transform2D {
  const rotation = Math.atan2(m.b, m.a);
  const scaleX = Math.hypot(m.a, m.b);
  const scaleY = Math.hypot(m.c, m.d);
  // The centre, via the half-size mapped through the linear part.
  const halfW = (width / 2) * m.a + (height / 2) * m.c;
  const halfH = (width / 2) * m.b + (height / 2) * m.d;
  return {
    x: m.e + halfW - width / 2,
    y: m.f + halfH - height / 2,
    width,
    height,
    rotation,
    scaleX,
    scaleY,
  };
}
const identity = (width: number, height: number): Transform2D => ({
  x: 0,
  y: 0,
  width,
  height,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
});

describe('the identity frame is transparent', () => {
  it('worldMatrix of x=0,y=0,rot=0,scale=1 is the identity, at any size', () => {
    // The whole structural-grouping argument rests on this, so it is asserted at three sizes
    // including the degenerate one.
    for (const [w, h] of [
      [0, 0],
      [120, 80],
      [1e4, 1e4],
    ] as const) {
      const m = worldMatrix(identity(w, h));
      expect(m.a).toBeCloseTo(1, 12);
      expect(m.b).toBeCloseTo(0, 12);
      expect(m.c).toBeCloseTo(0, 12);
      expect(m.d).toBeCloseTo(1, 12);
      expect(m.e).toBeCloseTo(0, 12);
      expect(m.f).toBeCloseTo(0, 12);
    }
  });
});

describe('grouping as a structural edit preserves every child frame exactly', () => {

  it('worldTransformIn(child, identityGroup) equals the child page-local frame', () => {
    const group = identity(0, 0);
    for (const child of children) {
      const composed = worldTransformIn(child, group);
      expect(composed.x).toBe(child.x);
      expect(composed.y).toBe(child.y);
      expect(composed.width).toBe(child.width);
      expect(composed.height).toBe(child.height);
      expect(composed.rotation).toBe(child.rotation);
      expect(composed.scaleX).toBe(child.scaleX);
      expect(composed.scaleY).toBe(child.scaleY);
    }
  });

  it('and the matrices agree bit for bit, not just to a tolerance', () => {
    // `worldTransformIn` is a closed form and `worldMatrixIn` is multiplication. If they ever
    // disagreed by even one ulp the renderer (which uses the matrix) and the chrome (which uses
    // the transform) would place a frame a fraction of a pixel away from its object -- invisible in
    // a screenshot and obvious in a drag. So this is compared with `toBe`, not `toBeCloseTo`.
    const group = identity(0, 0);
    for (const child of children) {
      const viaTransform = worldMatrix(worldTransformIn(child, group));
      const viaMatrix = multiply(worldMatrix(group), worldMatrix(child));
      expect(viaTransform).toEqual(viaMatrix);
    }
  });
});

describe('the general case, which ungroup has to do for real', () => {
  const groups: Transform2D[] = [
    { x: 0, y: 0, width: 200, height: 150, rotation: 0, scaleX: 1, scaleY: 1 },
    { x: 30, y: 40, width: 200, height: 150, rotation: 0, scaleX: 1, scaleY: 1 },
    { x: 30, y: 40, width: 200, height: 150, rotation: 0.7, scaleX: 1, scaleY: 1 },
    { x: 30, y: 40, width: 200, height: 150, rotation: 0.7, scaleX: 1.5, scaleY: 1.5 },
    { x: 0, y: 0, width: 200, height: 150, rotation: 0.35, scaleX: 2.5, scaleY: 2.5 },
  ];

  it('a child authored page-locally composes to the same world matrix under a transformed group', () => {
    // This is the *conversion*: local = inverse(groupWorld) . childWorld. It has to hold for the
    // matrix, because ungrouping computes it and any error lands straight on the page.
    for (const group of groups) {
      for (const child of children) {
        const childWorld = worldMatrix(child);
        const groupWorld = worldMatrix(group);
        const local = multiply(invert(groupWorld), childWorld);

        // Composing back must reproduce the child's world matrix.
        const recomposed = multiply(groupWorld, local);
        expect(recomposed.a).toBeCloseTo(childWorld.a, 9);
        expect(recomposed.b).toBeCloseTo(childWorld.b, 9);
        expect(recomposed.c).toBeCloseTo(childWorld.c, 9);
        expect(recomposed.d).toBeCloseTo(childWorld.d, 9);
        expect(recomposed.e).toBeCloseTo(childWorld.e, 9);
        expect(recomposed.f).toBeCloseTo(childWorld.f, 9);
      }
    }
  });

  it('the converted local frame is itself a legal Transform2D (no shear)', () => {
    // `local` above is a raw 2x3 matrix. Writing it back as a `Transform2D` requires the linear
    // part to be `R(t).S(sx,sy)`, and that holds **only because group scale is uniform**:
    //
    //   (R(g)·S(s))⁻¹ · (R(c)·S(cx,cy))  =  S(1/s)·R(−g)·R(c)·S(cx,cy)
    //                                   =  R(c−g)·S(1/s)·S(cx,cy)     [S(1/s) uniform ⇒ commutes with R]
    //                                   =  R(c−g)·S(cx/s, cy/s)
    //
    // so a **non-uniform child scale survives**, because `1/s` multiplies both axes equally and
    // `cy/s` is still free. Drop the uniformity and `S(1/sx, 1/sy)` stops commuting with `R(g)`, a
    // shear term appears, and no `Transform2D` can hold it. That is ADR 0012's restriction seen
    // from the other end: it is not that groups are fussy about scale, it is that a non-uniform
    // *ancestor* scale makes a child's own frame inexpressible.
    //
    // Two layout traps, both found by writing this assertion and having it fail for the wrong
    // reason first. Both are invisible in any test that only compares whole matrices, which is why
    // this one decomposes:
    //
    // 1. `applyPoint` is `x' = a·x + c·y`, `y' = b·x + d·y`, so **column 0 is `(a, b)`** and column
    //    1 is `(c, d)`. Reading column 0 as `(a, c)` reported a shear of 1.41 on a matrix that is
    //    exactly `R(-0.1)·S(2, 0.5)`.
    // 2. **A matrix's `e`/`f` is not `transform.x`/`transform.y`.** `worldMatrix` is
    //    `T(x + w/2, y + h/2)·L·T(-w/2, -h/2)`, so `(e, f)` is where the box's *rotated, scaled
    //    top-left corner* lands. `x`/`y` place the box's **centre**. Recovering the frame therefore
    //    means mapping the half-size back through the linear part:
    //    `centre = (e, f) + L·(w/2, h/2)`, then `x = centre.x - w/2`.
    for (const group of groups) {
      const child: Transform2D = {
        x: 10,
        y: 20,
        width: 100,
        height: 50,
        rotation: 0.6,
        scaleX: 2,
        scaleY: 0.5,
      };
      const local = multiply(invert(worldMatrix(group)), worldMatrix(child));

      const rotation = Math.atan2(local.b, local.a);
      const scaleX = Math.hypot(local.a, local.b);
      const scaleY = Math.hypot(local.c, local.d);
      // No shear: the second column must be exactly `scaleY · (−sin t, cos t)`.
      expect(local.c / scaleY).toBeCloseTo(-Math.sin(rotation), 12);
      expect(local.d / scaleY).toBeCloseTo(Math.cos(rotation), 12);

      // The conversion divides the child's scale by the group's -- and because the group's is
      // uniform, a **non-uniform child stays non-uniform**: `(2, 0.5)` under a group scaled by 1.5
      // becomes `(1.333…, 0.333…)`, not `(1.333…, 1.333…)`. That is the restriction doing its job.
      expect(scaleX).toBeCloseTo(child.scaleX / group.scaleX, 12);
      expect(scaleY).toBeCloseTo(child.scaleY / group.scaleX, 12);

      const rebuilt = decomposeFrame(local, child.width, child.height);
      // Recomposing the decomposed frame under the group must reproduce the child's world matrix.
      const again = multiply(worldMatrix(group), worldMatrix(rebuilt));
      const want = worldMatrix(child);
      expect(again.a).toBeCloseTo(want.a, 9);
      expect(again.b).toBeCloseTo(want.b, 9);
      expect(again.c).toBeCloseTo(want.c, 9);
      expect(again.d).toBeCloseTo(want.d, 9);
      expect(again.e).toBeCloseTo(want.e, 9);
      expect(again.f).toBeCloseTo(want.f, 9);
    }
  });

  it('worldTransformIn is the composition ungrouping needs -- but only to float precision', () => {
    // The matrix route above is the general statement. What ungroup needs is the *other* direction
    // -- promote a group-local frame to page-local -- and `worldTransformIn` already is that
    // function, which is the reason this milestone adds no geometry of its own.
    //
    // **It is not bit-exact** against `multiply(worldMatrix(group), worldMatrix(child))`, and the
    // first draft of this test asserted `toEqual` and failed. That is worth recording rather than
    // papering over with a tolerance: `worldTransformIn` is a **closed form** and the matrix route is
    // a **product of four factors**, so they round differently. For the *transparent* group case
    // above they agree exactly, because there the closed form collapses to `child` untouched -- and
    // that is precisely why grouping can be made a purely structural edit.
    //
    // So the honest statement is: two spellings of one composition, agreeing to ~1e-12 rather than
    // exactly. A browser test asserting a painted position must therefore allow a small tolerance,
    // and any test that demands exact equality is asserting that no arithmetic happened at all --
    // which is only true for grouping, not for ungrouping.
    for (const group of groups) {
      for (const child of children) {
        const promoted = worldMatrix(worldTransformIn(child, group));
        const viaMatrix = multiply(worldMatrix(group), worldMatrix(child));
        for (const key of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
          expect(promoted[key]).toBeCloseTo(viaMatrix[key], 9);
        }
      }
    }
  });

  it('and for a transparent group it is bit-exact, because nothing is computed', () => {
    // The asymmetry above is the whole reason grouping needs no conversion. Where the group is
    // transparent, `worldTransformIn(child, identity)` returns numbers that are *equal*, not merely
    // close -- so grouping and ungrouping an ungrouped group restore the authored fields bit for
    // bit, which is the strongest form of "grouping then ungrouping restores geometry".
    const group = identity(0, 0);
    for (const child of children) {
      expect(worldTransformIn(child, group)).toEqual(child);
      expect(worldTransformIn(worldTransformIn(child, group), group)).toEqual(child);
    }
  });

  it('nested: an identity group inside a transformed group still composes', () => {
    const outer: Transform2D = {
      x: 15,
      y: 25,
      width: 300,
      height: 200,
      rotation: 0.4,
      scaleX: 1.25,
      scaleY: 1.25,
    };
    const inner = identity(0, 0);
    const leaf: Transform2D = {
      x: 60,
      y: 70,
      width: 40,
      height: 30,
      rotation: 0.2,
      scaleX: 1,
      scaleY: 1,
    };
    // inner is transparent, so the chain reduces to one composition -- and must equal it.
    const viaTwoSteps = worldTransformIn(
      worldTransformIn(leaf, inner),
      outer,
    );
    const viaOneStep = worldTransformIn(leaf, outer);
    expect(viaTwoSteps).toEqual(viaOneStep);
  });
});

describe('what ungrouping must reproduce', () => {
  it('the closed form inverts the composition exactly for the identity case', () => {
    // group -> ungroup is required to restore canonical authored state "where mathematically
    // possible". With an identity group it is possible exactly, because nothing was ever converted.
    for (const child of children) {
      const group = identity(0, 0);
      const wrapped = worldTransformIn(child, group);
      const unwrapped = worldTransformIn(wrapped, { ...group, x: 0, y: 0 });
      expect(unwrapped.x).toBe(child.x);
      expect(unwrapped.y).toBe(child.y);
      expect(unwrapped.rotation).toBe(child.rotation);
      expect(unwrapped.scaleX).toBe(child.scaleX);
      expect(unwrapped.scaleY).toBe(child.scaleY);
    }
  });

  it('a point on the painted child is unchanged by the wrap/unwrap round trip', () => {
    const group: Transform2D = {
      x: 22,
      y: 33,
      width: 180,
      height: 140,
      rotation: 0.55,
      scaleX: 1.4,
      scaleY: 1.4,
    };
    const child: Transform2D = {
      x: 50,
      y: 60,
      width: 70,
      height: 40,
      rotation: 0.25,
      scaleX: 1.1,
      scaleY: 0.9,
    };
    // local = inverse(group) . childWorld  -- the grouping conversion.
    const local = multiply(invert(worldMatrix(group)), worldMatrix(child));
    // And unwrapping multiplies it straight back.
    const back = multiply(worldMatrix(group), local);
    const want = worldMatrix(child);
    const p1 = { x: 12, y: 7 };
    expect(applyPoint(back, p1).x).toBeCloseTo(applyPoint(want, p1).x, 9);
    expect(applyPoint(back, p1).y).toBeCloseTo(applyPoint(want, p1).y, 9);
  });
});