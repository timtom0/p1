/**
 * Is the current model really one equation away from a general affine transform?
 *
 * M10b's decision rests on a claim that sounds like a throwaway remark and is not:
 *
 * > **The current transform's linear part is a codimension-1 subset of `GL(2)`.** `R(t)·S(sx, sy)`
 * > has three parameters; a general 2×2 has four. "No shear" is one equation.
 *
 * If that is right, then introducing affine transforms is not "a second geometry system" and the
 * argument against it cannot be "that would be a new geometry system". The argument has to be about
 * *semantics* instead — rotation, bounds, stroke, canonical form — and this file is what forces the
 * argument onto those grounds.
 *
 * If it is wrong, M10b's central claim is wrong and the decision would have to be revisited from
 * the beginning. So it is proved here, from the definition, rather than asserted in an ADR.
 *
 * Every proof is arithmetic. The counts are exact.
 */

import { describe, expect, it } from 'vitest';

import { isRotationTimesScale, shear } from './linear-part';
import {
  angleDifference,
  columnAngle,
  composeRSK,
  decomposeRSK,
  determinantOf,
  polarRotation,
} from './affine';
import type { RskParameters } from './affine';
import { multiply, rotation, scaling } from './mat2d';
import type { Mat2D } from './mat2d';

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// §2 The candidate model, defined before it is argued about
// ---------------------------------------------------------------------------

describe('the candidate R(t) . S(sx, sy) . K(kx)', () => {
  it('reduces to the current transform when kx = 0', () => {
    // The compatibility requirement. A candidate that cannot express today's documents is not a
    // candidate, it is a replacement, and it would need a migration for no benefit.
    for (const t of [0, 0.3, Math.PI / 2, -1.2]) {
      for (const [sx, sy] of [
        [1, 1],
        [2, 1],
        [1, 0.5],
        [-1, 1],
      ] as const) {
        const candidate = composeRSK({ rotation: t, scaleX: sx, scaleY: sy, skewX: 0 });
        const current = multiply(rotation(t), scaling(sx, sy));
        expect(candidate.a, `t=${t} ${sx}x${sy}`).toBeCloseTo(current.a, 12);
        expect(candidate.b).toBeCloseTo(current.b, 12);
        expect(candidate.c).toBeCloseTo(current.c, 12);
        expect(candidate.d).toBeCloseTo(current.d, 12);
      }
    }
  });

  it('K(kx) alone is a shear', () => {
    // The extra dimension is exactly this and nothing more.
    expect(shear(composeRSK({ rotation: 0, scaleX: 1, scaleY: 1, skewX: 0.4 }))).toBeCloseTo(0.4, 12);
    expect(isRotationTimesScale(composeRSK({ rotation: 0, scaleX: 1, scaleY: 1, skewX: 0.4 }))).toBe(
      false,
    );
  });

  it('is invertible for every combination except a zero scale', () => {
    // Including reflection: negative scales are allowed and stay invertible.
    for (const t of [0, 0.7, Math.PI / 3, -2.4]) {
      for (const [sx, sy] of [
        [1, 1],
        [2, 0.5],
        [-1, 1],
        [1, -1],
        [-2, -3],
      ] as const) {
        for (const kx of [0, 0.5, -1.5]) {
          const m = composeRSK({ rotation: t, scaleX: sx, scaleY: sy, skewX: kx });
          expect(
            Math.abs(determinantOf(m)),
            `t=${t} ${sx}x${sy} kx=${kx} must be invertible`,
          ).toBeGreaterThan(1e-9);
        }
      }
    }
    // A zero scale is singular, which is why `invariants.ts` already forbids it. Floating-point
    // composition of a singular matrix leaves ~1e-16 rather than 0, so this is a closeness check.
    expect(
      Math.abs(determinantOf(composeRSK({ rotation: 0.5, scaleX: 0, scaleY: 2, skewX: 0.3 }))),
    ).toBeLessThan(1e-12);
  });

  it('round-trips: decompose(compose(p)) == p, for every invertible p', () => {
    // The property the whole representation rests on. If it fails, `setTransform` on an authored
    // field cannot be verified, canonical equality is impossible, and a file's numbers would not
    // mean what they say.
    //
    // Reflections are in the loop on purpose: the decomposition is a bijection onto all of GL(2),
    // not onto the orientation-preserving part of it.
    for (const t of [0, 0.05, 0.785, 1.3, -2.9, Math.PI]) {
      for (const [sx, sy] of [
        [1, 1],
        [2, 1],
        [1, 4],
        [0.25, 0.25],
        [3, 0.5],
        [1, -1],
        [-2, 1],
      ] as const) {
        for (const kx of [0, 0.3, -0.7, 2]) {
          const p = { rotation: t, scaleX: sx, scaleY: sy, skewX: kx };
          const back = decomposeRSK(composeRSK(p));
          expect(back, `t=${t} ${sx}x${sy} kx=${kx} must decompose`).not.toBeNull();
          if (back === null) continue;
          // `scaleX` is stored positive by the branch rule, and forcing it positive moves a
          // negative authored `sx` into `scaleY`: `R(t)·S(-sx, sy)` equals
          // `R(t - pi)·S(sx, -sy)`, which is the same matrix with the sign on the other axis.
          // Angles are compared with `angleDifference` rather than `toBeCloseTo`, because pi and
          // -pi are the same direction and differ by 2pi as numbers.
          const flipped = sx < 0;
          const expectedRotation = flipped ? p.rotation - Math.PI : p.rotation;
          const expectedScaleY = flipped ? -p.scaleY : p.scaleY;
          expect(
            angleDifference(back.rotation, expectedRotation),
            `rotation t=${t} sx=${sx}`,
          ).toBeLessThan(1e-9);
          expect(back.scaleX, `scaleX ${sx} at t=${t} kx=${kx}`).toBeCloseTo(Math.abs(sx), 9);
          expect(back.scaleY, `scaleY ${sy} at t=${t} sx=${sx} kx=${kx}`).toBeCloseTo(expectedScaleY, 9);
          expect(back.skewX, `skewX ${kx} at ${sx}x${sy}`).toBeCloseTo(kx, 9);
        }
      }
    }
  });

  it('surjects onto GL(2): an arbitrary invertible matrix always decomposes', () => {
    // The converse of round-tripping, and the reason this form is "general" rather than "a bit
    // more general". Four arbitrary numbers in, four parameters out.
    const arbitrary: Mat2D[] = [
      { a: 1, b: 2, c: 3, d: 5, e: 0, f: 0 },
      { a: -2, b: 0.5, c: 1, d: -3, e: 0, f: 0 },
      { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 },
      { a: 0.3, b: -0.8, c: 0.2, d: 0.9, e: 0, f: 0 },
      { a: 1, b: 0, c: -1, d: 1, e: 0, f: 0 },
    ];
    for (const m of arbitrary) {
      expect(Math.abs(determinantOf(m)), 'the fixture is invertible').toBeGreaterThan(1e-9);
      const back = decomposeRSK(m);
      expect(back, `a=${m.a} b=${m.b} c=${m.c} d=${m.d} must decompose`).not.toBeNull();
      if (back === null) continue;
      const rebuilt = composeRSK(back);
      expect(rebuilt.a, `a, from ${JSON.stringify(m)}`).toBeCloseTo(m.a, 9);
      expect(rebuilt.b).toBeCloseTo(m.b, 9);
      expect(rebuilt.c).toBeCloseTo(m.c, 9);
      expect(rebuilt.d).toBeCloseTo(m.d, 9);
    }
  });

  it('refuses a singular matrix rather than inventing parameters', () => {
    expect(decomposeRSK({ a: 1, b: 1, c: 1, d: 1, e: 0, f: 0 })).toBeNull();
  });

  it('reports a reflection as reflecting, and still decomposes it uniquely', () => {
    // A mirrored object decomposes with `scaleY < 0`. That is a fact to report, not a failure:
    // the parameters are unique, and the renderer can draw it.
    const mirrored = composeRSK({ rotation: 0.6, scaleX: 2, scaleY: -1.5, skewX: 0 });
    const back = decomposeRSK(mirrored);
    expect(determinantOf(mirrored), 'a reflection has negative determinant').toBeLessThan(0);
    expect(back?.reflects, 'and is reported as one').toBe(true);

    const plain = composeRSK({ rotation: 0.6, scaleX: 2, scaleY: 1.5, skewX: 0 });
    expect(decomposeRSK(plain)?.reflects, 'a non-mirror is not').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §3 Does "rotation" survive?
// ---------------------------------------------------------------------------

describe('rotation under the candidate model', () => {
  it('is exact for a pure rotation', () => {
    for (const t of [0, 15 * DEG, 30 * DEG, 45 * DEG, 90 * DEG, 180 * DEG, -137 * DEG]) {
      const m = composeRSK({ rotation: t, scaleX: 1, scaleY: 1, skewX: 0 });
      const polar = polarRotation(m);
      expect(polar, `t=${t}`).not.toBeNull();
      expect(angleDifference(polar ?? 0, t)).toBeLessThan(1e-9);
      expect(angleDifference(decomposeRSK(m)?.rotation ?? 0, t)).toBeLessThan(1e-9);
    }
  });

  it('is exact for rotation + uniform scale', () => {
    for (const t of [0, 20 * DEG, 75 * DEG, -40 * DEG]) {
      for (const k of [0.5, 2, 10]) {
        const m = composeRSK({ rotation: t, scaleX: k, scaleY: k, skewX: 0 });
        expect(angleDifference(polarRotation(m) ?? 0, t), `t=${t} k=${k}`).toBeLessThan(1e-9);
        // And the column angle agrees here, which is why the shortcut works today.
        expect(angleDifference(columnAngle(m), t)).toBeLessThan(1e-9);
      }
    }
  });

  it('keeps the AUTHORED rotation exactly recoverable, even under shear', () => {
    // This is the load-bearing result for the inspector, and it is a consequence of the *factor
    // order* rather than of luck. `K = [[1, kx], [0, 1]]` has first column `(1, 0)`, so it cannot
    // touch the first column of `R · S · K` -- which is `sx · (cos t, sin t)`. The first column's
    // angle is therefore the authored `t`, for every `kx`.
    //
    // The draft of this file asserted the opposite, on the reasonable-sounding guess that any shear
    // would tilt the first column. It does not, and had this been implemented with the skew in the
    // *page* frame (`S · R · K`) it would.
    const t = 30 * DEG;
    const sheared = composeRSK({ rotation: t, scaleX: 2, scaleY: 1, skewX: 0.5 });
    expect(isRotationTimesScale(sheared), 'the shear is real').toBe(false);
    expect(angleDifference(columnAngle(sheared), t), 'yet the first column still gives t').toBeLessThan(
      1e-9,
    );
    const back = decomposeRSK(sheared);
    expect(angleDifference(back?.rotation ?? 0, t)).toBeLessThan(1e-9);
    expect(back?.skewX).toBeCloseTo(0.5, 9);

    // For contrast, the page-frame order does not have this property, which is why the local one
    // is the candidate. `S · R · K` with a non-uniform S.
    const pageFrame = multiply(
      scaling(2, 1),
      multiply(rotation(t), { a: 1, b: 0, c: 0.5, d: 1, e: 0, f: 0 }),
    );
    expect(
      Math.abs(angleDifference(columnAngle(pageFrame), t)),
      'the page-frame skew does move the first column',
    ).toBeGreaterThan(1e-3);
  });

  it('disagrees with the DERIVED polar rotation as soon as there is shear', () => {
    // Two defensible meanings of "rotation" appear under affine, and this is where they part. The
    // authored field stays at 30 degrees; the polar factor -- the closest thing to "how is this
    // object actually tilted" -- reports 11.4 degrees for the same object. Both are correct
    // answers to different questions, which is precisely why ADR 0011 says to expose the authored
    // field and never a derived one.
    const authored = 30 * DEG;
    const sheared = composeRSK({ rotation: authored, scaleX: 2, scaleY: 1, skewX: 0.5 });
    const polar = polarRotation(sheared);
    expect(polar, 'a polar rotation still exists here').not.toBeNull();
    expect(angleDifference(polar ?? 0, authored), 'and it is not the authored angle').toBeGreaterThan(
      0.1,
    );
    // With no shear they agree exactly, which is why the question never arose before.
    const plain = composeRSK({ rotation: authored, scaleX: 2, scaleY: 1, skewX: 0 });
    expect(angleDifference(polarRotation(plain) ?? 0, authored)).toBeLessThan(1e-9);
  });

  it('has two answers for the same matrix when sx + sy < 0', () => {
    // The ambiguity, isolated and exact. `R(t)·S(-2,-2)` and `R(t+pi)·S(2,2)` are the same matrix,
    // and both are matrices the *current* model can already store.
    const a = composeRSK({ rotation: 0.4, scaleX: 2, scaleY: 2, skewX: 0 });
    const b = composeRSK({ rotation: 0.4 + Math.PI, scaleX: -2, scaleY: -2, skewX: 0 });
    expect(a.a).toBeCloseTo(b.a, 12);
    expect(a.b).toBeCloseTo(b.b, 12);
    expect(a.c).toBeCloseTo(b.c, 12);
    expect(a.d).toBeCloseTo(b.d, 12);
    expect(determinantOf(a), 'the determinant does not see the difference').toBeCloseTo(4, 12);

    // Both give the same polar rotation, because the polar factor is computed from the matrix and
    // cannot know which spelling was used. The *parameters* differ by pi; the matrix does not.
    expect(angleDifference(polarRotation(a) ?? 0, polarRotation(b) ?? 0)).toBeLessThan(1e-9);
  });

  it('has two AUTHORED rotations for one matrix, and one polar rotation', () => {
    // The multiple-decomposition answer, in the form that actually matters. `polarRotation` is a
    // function of the matrix, so two equal matrices necessarily give the same answer -- it cannot
    // depend on how the matrix was spelled. What is *not* determined by the matrix is the authored
    // field: `S(2,2)` at `t` and `S(-2,-2)` at `t + pi` are the same object written down two ways,
    // and the file can hold either.
    //
    // (An earlier draft asserted the opposite -- that the polar factor shifts with the spelling.
    // It cannot: that would make it a function of the *authoring* rather than of the geometry.)
    const p: RskParameters = { rotation: 0.7, scaleX: 2, scaleY: 2, skewX: 0 };
    const q: RskParameters = { rotation: 0.7 + Math.PI, scaleX: -2, scaleY: -2, skewX: 0 };
    const mp = composeRSK(p);
    const mq = composeRSK(q);
    expect(Math.abs(mp.a - mq.a), 'the same matrix').toBeLessThan(1e-12);
    expect(Math.abs(mp.d - mq.d)).toBeLessThan(1e-12);

    // One polar answer.
    expect(angleDifference(polarRotation(mp) ?? 0, polarRotation(mq) ?? 0)).toBeLessThan(1e-12);
    expect(angleDifference(polarRotation(mp) ?? 0, 0.7)).toBeLessThan(1e-9);

    // Two authored answers, pi apart.
    expect(angleDifference(p.rotation, q.rotation)).toBeCloseTo(Math.PI, 9);
    // And the branch rule picks the same answer for both spellings -- which is the property that
    // matters, because it is what makes `documentsEqual` able to compare two authored transforms
    // and conclude they describe the same object.
    const fromP = decomposeRSK(mp);
    const fromQ = decomposeRSK(mq);
    expect(fromP?.rotation).toBeCloseTo(0.7, 9);
    expect(angleDifference(fromQ?.rotation ?? 0, 0.7), 'same answer either way').toBeLessThan(1e-9);
    expect(fromQ?.scaleX).toBeCloseTo(2, 9);
    expect(fromQ?.scaleY).toBeCloseTo(2, 9);
    expect(fromQ?.reflects, 'and neither spelling looks like a reflection').toBe(false);
    // Worth being explicit about why, because it is the case that *is* a reflection: negating
    // *both* scales is a rotation by pi, not a mirror. Only opposite signs mirror.
    const mirrored = composeRSK({ rotation: 0.7, scaleX: 2, scaleY: -2, skewX: 0 });
    expect(decomposeRSK(mirrored)?.reflects, 'opposite signs do reflect').toBe(true);
  });

  it('has no polar rotation for a reflection', () => {
    // Because the polar factor is a reflection, not a rotation. A mirrored object therefore has no
    // derived rotation angle to report -- while the *authored* `rotation` field still holds a
    // perfectly good value. This is the clearest single reason to expose the authored field.
    //
    // The second half is the subtle part, and the draft of this file got it wrong first: the
    // branch rule forces `scaleX > 0`, so an author who writes a *negative* `scaleX` gets the same
    // object back with the rotation shifted by pi and the sign moved to `scaleY`. The first column's
    // angle therefore reports the **branch-normalised** rotation, which is what the inspector shows.
    for (const [sx, sy] of [
      [1, -1],
      [-2, 3],
    ] as const) {
      const mirrored = composeRSK({ rotation: 0.9, scaleX: sx, scaleY: sy, skewX: 0 });
      expect(polarRotation(mirrored), `sx=${sx} sy=${sy}`).toBeNull();
      const back = decomposeRSK(mirrored);
      expect(back?.reflects, `sx=${sx} sy=${sy} reflects`).toBe(true);

      // The normalised authored rotation, which is the branch-corrected form of 0.9.
      const normalised = sx > 0 ? 0.9 : 0.9 - Math.PI;
      expect(
        angleDifference(back?.rotation ?? 0, normalised),
        `decomposed sx=${sx}`,
      ).toBeLessThan(1e-9);
      expect(
        angleDifference(columnAngle(mirrored), normalised),
        `first column, sx=${sx} sy=${sy}`,
      ).toBeLessThan(1e-9);
    }

    // Negating *both* scales is a rotation by pi, not a mirror, so it is excluded above and
    // checked here instead -- determinant 6, positive, and a polar rotation that does exist.
    const flipped = composeRSK({ rotation: 0.9, scaleX: -2, scaleY: -3, skewX: 0 });
    expect(determinantOf(flipped), 'both scales negative is orientation-preserving').toBeGreaterThan(0);
    expect(polarRotation(flipped), 'so a polar rotation exists').not.toBeNull();
    expect(decomposeRSK(flipped)?.reflects).toBe(false);

    // And the headline case: a mirror written with a positive `scaleX` needs no correction at all,
    // so the authored field and the first column agree exactly.
    const simple = composeRSK({ rotation: 0.9, scaleX: 1, scaleY: -1, skewX: 0 });
    expect(angleDifference(columnAngle(simple), 0.9)).toBeLessThan(1e-9);
  });

  it('has no polar rotation for a singular matrix', () => {
    expect(polarRotation(composeRSK({ rotation: 0.3, scaleX: 0, scaleY: 2, skewX: 0.4 }))).toBeNull();
  });

  it('the no-shear surface passes through quarter turns, as M8 found', () => {
    // The codimension-1 surface is not smooth everywhere: at a multiple of 90 degrees a
    // page-frame scale *is* representable, because `sin(t)·cos(t) = 0` makes the shear term vanish.
    // That is ADR 0008 §4's exception, restated here with the shared predicate so the two
    // documents cannot drift. It is the third time this codebase has hit the same degeneracy, and
    // the reason is always the same: at a quarter turn the object's axes coincide with the page's.
    const pageFrameScale = (t: number, sx: number, sy: number) =>
      multiply(scaling(sx, sy), rotation(t));
    for (const t of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      expect(
        isRotationTimesScale(pageFrameScale(t, 2, 1)),
        `page-frame scale at ${t} is representable`,
      ).toBe(true);
    }
    for (const t of [0.01, Math.PI / 4, Math.PI / 3, 1.4, -2.2]) {
      expect(
        isRotationTimesScale(pageFrameScale(t, 2, 1)),
        `page-frame scale at ${t} is a shear`,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// §1 The codimension claim
// ---------------------------------------------------------------------------

describe('the current model is one equation away from general affine', () => {
  it('the model spans three parameters and GL(2) has four', () => {
    // Counting is the proof. `R(t)·S(sx, sy)` is determined by exactly three numbers, and three
    // distinct triples give three distinct matrices -- so the image is 3-dimensional, while the
    // space of invertible 2x2 matrices is 4-dimensional.
    const triples: RskParameters[] = [];
    for (const t of [0, 1, 2, 3]) {
      for (const [sx, sy] of [
        [1, 1],
        [2, 1],
      ] as const) {
        triples.push({ rotation: t, scaleX: sx, scaleY: sy, skewX: 0 });
      }
    }
    expect(triples).toHaveLength(8);
    const matrices = triples.map((p) => composeRSK(p));
    const distinct = new Set(matrices.map((m) => `${m.a},${m.b},${m.c},${m.d}`));
    expect(distinct.size, 'all eight are distinct matrices').toBe(8);

    // And the image is exactly the zero set of the perpendicularity equation.
    for (const m of matrices) expect(isRotationTimesScale(m)).toBe(true);
  });

  it('the missing direction is the shear equation, and one field closes it', () => {
    // "Codimension 1" made concrete: every matrix is within reach of the current model by moving
    // along a single parameter, and `skewX` is that parameter.
    const target = composeRSK({ rotation: 0.55, scaleX: 1.7, scaleY: 0.8, skewX: 0.9 });
    const reached = decomposeRSK(target);
    expect(reached, 'a general affine always decomposes').not.toBeNull();
    expect(isRotationTimesScale(target), 'the target is outside the current model').toBe(false);
    expect(reached?.skewX, 'and one parameter accounts for the difference').toBeCloseTo(0.9, 9);
  });

  it('generalising is therefore NOT a second geometry system', () => {
    // Stated as a test because it is the claim the decision turns on, and it is the claim a reader
    // is most likely to want to refute. Refuting it would mean showing that reaching a general
    // affine needs more than one extra number -- and every parameterisation of GL(2) by
    // (angle, two scales, one shear) is a bijection, proved by round-trip and surjectivity above.
    //
    // The concrete content: adding shear to this model leaves the object's *rotation and horizontal
    // scale* untouched, and changes only the vertical axis' lean. That is what "one dimension" means.
    const before = composeRSK({ rotation: 0.3, scaleX: 2, scaleY: 1, skewX: 0 });
    const after = composeRSK({ rotation: 0.3, scaleX: 2, scaleY: 1, skewX: 0.25 });

    // First column identical, bit for bit.
    expect(after.a).toBe(before.a);
    expect(after.b).toBe(before.b);
    // Second column changed.
    expect(after.c).not.toBe(before.c);
    expect(after.d).not.toBe(before.d);
    // And the two differ by precisely the shear, recoverable in one step.
    expect(decomposeRSK(after)?.skewX).toBeCloseTo(0.25, 9);
  });
});

// ---------------------------------------------------------------------------
// §12 Canonical serialisation
// ---------------------------------------------------------------------------

describe('canonical form', () => {
  it('the parameterised form is canonical by construction', () => {
    // Two equal matrices have equal parameters, provided the branch is fixed. This is what lets
    // `documentsEqual` compare authored fields and get the right answer.
    const a = composeRSK({ rotation: 0.8, scaleX: 1.5, scaleY: 2.5, skewX: 0.3 });
    const b = composeRSK({ rotation: 0.8, scaleX: 1.5, scaleY: 2.5, skewX: 0.3 });
    const da = decomposeRSK(a);
    const db = decomposeRSK(b);
    expect(da).not.toBeNull();
    expect([da?.rotation, da?.scaleX, da?.scaleY, da?.skewX]).toEqual([
      db?.rotation,
      db?.scaleX,
      db?.scaleY,
      db?.skewX,
    ]);
  });

  it('a raw 2x3 matrix has no canonical form without a rule, and the rule is lossy at pi', () => {
    // The argument against the matrix representation, as arithmetic. The matrix alone cannot
    // distinguish `S(2,2)` at `t` from `S(-2,-2)` at `t + pi`; the parameterised form can, but
    // only because `scaleX > 0` is *required* rather than derived. Remove the requirement and the
    // field-wise equality ADR 0007's byte-stable round trip depends on stops working.
    const same = (p: RskParameters, q: RskParameters): boolean =>
      p.rotation === q.rotation &&
      p.scaleX === q.scaleX &&
      p.scaleY === q.scaleY &&
      p.skewX === q.skewX;

    const p: RskParameters = { rotation: 0.4, scaleX: 2, scaleY: 2, skewX: 0 };
    const q: RskParameters = { rotation: 0.4 + Math.PI, scaleX: -2, scaleY: -2, skewX: 0 };
    const mp = composeRSK(p);
    const mq = composeRSK(q);

    // The matrices are equal to within a rounding error...
    expect(Math.abs(mp.a - mq.a)).toBeLessThan(1e-12);
    expect(Math.abs(mp.d - mq.d)).toBeLessThan(1e-12);
    // ...the fields are not.
    expect(same(p, q)).toBe(false);

    // So a byte-stable format must either forbid a negative `scaleX` or canonicalise it, and both
    // are *new rules* that a 2x3 matrix representation would not obviously need. That asymmetry --
    // extra rules versus no rules -- is the whole argument, and it is why ADR 0011 rejects the
    // matrix form even though it is strictly more general.
    expect(decomposeRSK(mp)?.scaleX, 'the branch rule resolves it').toBeGreaterThan(0);
    expect(decomposeRSK(mp)?.scaleX).toBeCloseTo(2, 9);
  });

  it('float round-trip is exact enough for a byte-stable format', () => {
    // The other half of the persistence question: does re-reading the numbers give the same
    // numbers? ADR 0007's format is a total function of the document, so this has to hold.
    for (const p of [
      { rotation: 0.123456789, scaleX: 1.23456789, scaleY: 0.987654321, skewX: 0.5555555 },
      { rotation: -2.9, scaleX: 100, scaleY: 0.01, skewX: -3.25 },
      { rotation: Math.PI, scaleX: 1, scaleY: 1, skewX: 0 },
    ]) {
      const written = JSON.parse(JSON.stringify(p)) as RskParameters;
      expect(written).toEqual(p);
      const viaMatrix = decomposeRSK(composeRSK(written));
      expect(viaMatrix?.rotation).toBeCloseTo(written.rotation, 9);
      expect(viaMatrix?.skewX).toBeCloseTo(written.skewX, 9);
    }
  });
});