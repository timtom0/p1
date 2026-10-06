# ADR 0011 — Does the geometry model need affine transforms?

- **Status:** accepted
- **Date:** 2026-10-06
- **Depends on:** `docs/ARCHITECTURE.md` §1.3, §1.4, §2.3, §3.5, §6;
  [ADR 0004](0004-measurement-boundary.md), [ADR 0005](0005-shape-geometry-contract.md),
  [ADR 0007](0007-persistent-document-format.md),
  [ADR 0008](0008-multi-selection-and-grouping.md),
  [ADR 0009](0009-boundaries-audit.md),
  [ADR 0010](0010-groups-and-the-transform-question.md)
- **Answers:** whether `Transform2D` should be extended from `R·S` to a general affine; what a
  group's capabilities would become; and what the roadmap should do next
- **Amends:** ADR 0005 §1 and §3 (stroke semantics were undefined, not chosen), ADR 0008 §4
  (multi-object resize), ADR 0010 §7 (the shear question, now decided)

## Context

M10 proved that grouping is not the missing abstraction, and identified the missing abstraction
instead: **a representable parent–child affine composition.** Group-local children need it, and so
does the multi-object resize ADR 0008 §4 deferred. This milestone decides whether to provide it by
extending the transform model.

The brief was explicit that the question is not "can affine transforms be implemented" — they can —
but "is arbitrary affine geometry justified by the capabilities the project actually needs".

**Summary: the mathematics is not the obstacle and never was. The current model is one equation
away from a general affine, and the extension is a single field with a clean decomposition. What
stops it is that it buys exactly one capability — non-uniform scaling — which nothing in the
application can currently produce, while forcing permanent semantic decisions about stroke width,
selection bounds and rotation that the project has never had to make and has, in one case, never
even chosen. The decision is RESTRICT GROUPS.**

## 1. The inventory

Every place that reads `rotation`, `scaleX` or `scaleY` in production code. `.rotation` is read in
**nine** places; the scales in nineteen. The surface is small, which is itself the first finding.

| # | Site | Assumption | Class | Survives shear? |
|---|---|---|---|---|
| 1 | `model/types.ts:29–31` | the field set | representation | needs a 4th field |
| 2 | `model/factory.ts:25–27` | defaults `0,1,1` | representation | add `skewX: 0` |
| 3 | `model/transform.ts:32` `localMatrix` | `R·S` | representation | **changes**: `R·S·K` |
| 4 | `model/transform.ts:43` `worldMatrix` | `T·R·S·T` | representation | **changes** |
| 5 | `model/transform.ts:108` `resizeTransform` | needs only an invertible inverse | **arithmetic** | **yes, unchanged** |
| 6 | `model/transform.ts:157` | `R·S` to find the anchor | arithmetic | **yes** (inverse + forward) |
| 7 | `model/transform.ts:196` `rotateTransform` | rotation is a scalar angle | **semantic** | **no** — §6 |
| 8 | `editor/transform.ts:219` `selectionRect` | `x/y/width/height` is the frame | **semantic** | **no** — §8 |
| 9 | `editor/transform.ts:240` `scaleTransforms` | page-frame scale | **wrong already** | n/a — ADR 0010 F2 |
| 10 | `editor/selection.ts:103` `hitNode` | needs only an invertible inverse | **arithmetic** | **yes, unchanged** |
| 11 | `model/shapes.ts:88–145` | predicates in local space | arithmetic | **yes, unchanged** |
| 12 | `model/shapes.ts:135` line tolerance | `stroke.width / 2` in local units | arithmetic | **yes**, and consistent with the stroke |
| 13 | `model/invariants.ts:30–34` | finite rotation, non-zero scales, non-negative size | invariant | add finiteness for the new field |
| 14 | `model/commands.ts:296–298`, `document-equality.ts:153–155` | field-wise equality | **canonicalisation** | **yes** — §12 |
| 15 | `render/num.ts:34` `cssMatrix` | formats `a..f` | representation | **unchanged** — CSS `matrix()` takes any affine |
| 16 | `render/types/shape.ts` | `localMatrix` → `cssMatrix` | representation | unchanged |
| 17 | `render/paint.ts:35` `applyStroke` | `border-width` in px | **semantic** | **no** — §9 |
| 18 | `render/reconciler.ts` | writes `style.transform` | representation | unchanged |
| 19 | `editor/editor.ts:646,655` `toRect` | frame = `{x,y,w,h}`, no matrix | **semantic** | **no** — §8 |
| 20 | `editor/viewport/overlay.ts:190–193` | outline is `left/top/width/height`, `transform: none` | **semantic** | **no** — §8 |
| 21 | `editor/editor.ts:663` | rotate handle only when `rotation === 0` | semantic | unchanged, but see §8 |
| 22 | `editor/selection.ts:179` `commonFrame` | compares five fields | representation | add the new field |
| 23 | `ui/inspector.ts:42` | exposes `x,y,w,h,rotation`; **no scale fields** | **UI gap** | needs a field either way |
| 24 | `persist/format.ts:106–113` `TRANSFORM_KEYS` | the serialised field set | **persistence** | **formatVersion 2** |
| 25 | `persist/serialize.ts:216–218`, `deserialize.ts:407–411` | field-wise round trip | persistence | one more field |
| 26 | `editor/measure.ts` | layout APIs only | arithmetic | **yes** — ADR 0010 §4 |
| 27 | `render/types/text-frame.ts`, `types/image.ts` | element `transform` | representation | unchanged |
| 28 | `model/transform.test.ts:243–263` | `scaleTransforms` on unrotated boxes | test | the rotated case is untested and wrong |

**Reading of the table.** Of 28 sites: **9 need nothing**, **7 are representation-only** (a field and
a factor), and **7 carry semantic consequences** — and the seven are all in the same three places:
rotation's meaning, the selection frame, and the stroke. That ratio is the whole decision.

Two of the semantic rows are **not** about affine at all:

- **#20 is an existing bug.** The selection outline carries no transform, so for a rotated object the
  frame does not follow the rotation. Measured in `tests/editor/frame-vs-shape.spec.ts`: a rotated
  ellipse paints 171.2 × 156.6 while its frame is 140 × 100 with `transform: none`. The frame's
  eight handles therefore point at the wrong place, which is the mechanical reason the rotate handle
  is suppressed for rotated selections (ADR 0010 F3) and multi-object resize is deferred.
- **#17 is an existing *non*-decision.** See §9: the project has never chosen between document-space
  and object-space stroke invariance, because every object's scale is 1.

## 2. The candidate model

Defined before it is argued about, in `src/core/geom/affine.ts`.

> `localMatrix = R(rotation) · S(scaleX, scaleY) · K(skewX)`, with `K(kx) = [[1, kx], [0, 1]]` —
> CSS's `skewX()`, in the object's own axes.

| Question | Answer |
|---|---|
| Translation | unchanged: `x`/`y` plus the box-centre convention already in `worldMatrix` |
| Linear 2×2 | four authored parameters: angle, two scales, one skew |
| Reflection | **allowed.** `scaleY < 0`; it decomposes and is reported (`reflects`) |
| Zero determinant | **forbidden**, as today — `invariants.ts` already refuses a zero scale |
| Negative scale | **allowed**, with a branch rule (below) |
| Shear authored? | **yes.** It is a field, an inspector field, and a file field |
| Shear from parent composition? | **also yes** — a group's non-uniform scale would produce one implicitly |
| Canonical form | **by construction.** `decomposeRSK ∘ composeRSK = id` (proved) |
| Comparison | field-wise, which is sound precisely *because* the parameterisation is bijective |
| Serialisation | one new optional field, `skewX`, absent meaning 0 |

**Why not a 2×3 matrix.** It is the general answer and it is rejected on legibility, not
mathematics. `docs/ARCHITECTURE.md` §1.3 states why the current form was chosen: "human-readable in
the file, directly editable in the inspector". Six opaque floats fail the second half. It also has no
canonical form without an extra rule — `R(t)·S(2,2)` and `R(t+π)·S(-2,-2)` are the same matrix —
and that rule is a *new* invariant ADR 0007's byte-stable round trip would then depend on. The
parameterised form needs no such rule, because the parameters are what is stored. Asymmetry of that
kind is the whole argument.

**The branch rule.** `decomposeRSK` requires `scaleX > 0`. That removes the only sign ambiguity
(`(t, sx) → (t+π, −sx)`) and makes the map a bijection onto all of `GL(2)`, reflections included.
Without it, two files could describe the same object and compare unequal.

An earlier draft of this module claimed the decomposition was *non-canonical* for reflections. It
was conflating two questions: whether the parameters are unique (always yes) and whether a *rotation*
exists for the matrix (no). §3 answers both.

## 3. Is "rotation" still a meaningful authored property?

Yes, and this is the strongest result in the milestone. It holds **because of the factor order**, and
the order was a choice.

`K`'s first column is `(1, 0)`, so `K` cannot touch the first column of `R·S·K`, which is
`sx·(cos t, sin t)`. Therefore the first column's angle **is** the authored `t`, for every `kx`. The
inspector's existing `rotation` field stays exactly meaningful under shear — `atan2(b, a)` still
returns it. The drafted test asserted the opposite, on the reasonable guess that any shear tilts the
first column; it does not, and with the skew in the *page* frame (`S·R·K`) it would.

The property is order-dependent, and that is the finding:

| operation | authored `rotation` recovered? |
|---|---|
| `R(t)·S(2,1)·K(0.5)` → `decompose` | **yes, exactly** |
| `S(2,1)·R(t)·K(0.5)` (page-frame skew) | **no** — off by > 1e-3 |

Three further results, each tested:

- **The derived polar rotation disagrees.** For `R(30°)·S(2,1)·K(0.5)` the authored field is 30° and
  the polar factor reports 11.4°. Two defensible meanings of "rotation" appear, and they part exactly
  when a shear is present. **So expose the authored field and never a derived one.**
- **The polar rotation has a π branch and can fail to exist.** `atan2(b − c, a + d)` returns `t` when
  `sx + sy > 0` and `t + π` when `sx + sy < 0` — and both spellings are storable *today*. It returns
  `null` for a reflection (the polar factor is a reflection, not a rotation) and for a singular matrix.
- **Negating both scales is a rotation by π, not a mirror.** Only *opposite* signs reflect. Worth
  stating because the test for it was written wrong twice.

**Rule adopted:** the inspector exposes the authored `rotation` only. No derived angle is displayed,
and none may be until its definition is written down and tested. `src/core/geom/affine.ts` carries
`polarRotation` precisely so that a future implementer reaches for the *authored* number and has to
look at why the derived one was left alone.

## 4. What `width` and `height` mean

**Unchanged, and provably so.** They remain the **local box** — `(0, 0, width, height)` — in the
object's own coordinates. A 200 × 50 box means 200 × 50 after any invertible affine, because the four
local corners are at fixed local coordinates whatever the matrix is; only their page positions move.

What must *not* happen is `width`/`height` drifting into meaning "painted extent". Those are three
distinct quantities and the codebase already conflates two of them (§8). The painted extent is
**derived**: the axis-aligned bounding box of the four transformed corners. It is not available in
closed form under shear — a shear can narrow an AABB as much as widen it — so the corner computation
*is* the specification.

## 5. Resize semantics

**Preserved, unchanged, for every handle under every invertible matrix.** This is the largest single
item in the inventory (rows 5, 6) and it costs nothing.

`resizeTransform` does one geometric step: unproject the pointer through `invert(worldMatrix)`. For an
invertible matrix that is exact, and the new extents are then read off the local point. The rule is
stated entirely in the object's own coordinates, so **there is no step at which the matrix can enter**.
Tested for all eight handles × five matrices (identity, rotated, non-uniform, sheared, mirrored),
against expected extents written out by hand rather than recomputed by the same expression.

Per the brief's three-way split:

| | answer |
|---|---|
| changing local geometry | **yes** — `width`/`height` only |
| changing the object's transform | **no** — the linear part is bit-identical after a resize |
| changing both | **no** |

The reason single-object resize already works under rotation is this same fact, and M10b explains it:
a local resize never introduces a page-frame factor, so the no-shear property survives both
"resize then rotate" and "rotate then resize".

## 6. Rotation semantics

**Rotation must be applied in parent space.** This is forced, not preferred.

`rotateTransform` sets an absolute angle, which works today because rotations commute: `R(d)·R(t) =
R(t+d)`, so order never mattered. That reasoning dies with a shear, because **`R` does not commute
with `R·S·K`**:

| operation | resulting `rotation` | resulting `skewX` |
|---|---|---|
| `R(δ) · m` (parent space) | `t + δ` exactly | **unchanged** (0.4 → 0.4) |
| `m · R(δ)` (local space) | not `t + δ` | **redistributed** (0.4 → 1.755) |

Parent-space rotation therefore has a closed form: the angle accumulates, the scales and the shear are
carried untouched, and **repeated rotation is stable** — five successive deltas reproduce
`R(t + Σδ)·S·K` to 1e-12 and introduce no shear as a side effect. Local-space rotation has no such
form.

(The two orders also differ with no shear at all, since a non-uniform scale does not commute with a
rotation either. What parent space buys is not agreement between orders — it is the closed form.)

## 7. Hit testing

**Unchanged, for every object type, under any invertible matrix.** Rows 10–12, 26 need nothing.

`hitNode` unprojects the page point and calls a registry predicate in local space. For an invertible
`M`, a page point's local image is exactly `M(local)`, so the page-space hit set is the affine image of
the local set. Tested as a grid of >100 local points × five matrices × rect and ellipse: the predicate
returns the identical answer before and after a round trip through the matrix and back.

- **rect**: box test in local space — invariant.
- **ellipse**: normalised `(x/w − ½)² + (y/h − ½)² ≤ 1` — invariant, and its degenerate case is
  handled by normalisation rather than division.
- **line**: the one predicate that is not set membership. Its tolerance is `stroke.width / 2` in
  **local** units, so it transforms with the object — and that is *consistent* with the painted stroke,
  which is a CSS border on the same transformed element (§9). The two agree.
- **text / image**: both fall through to the local box test in `hitNode`, so they inherit the
  invariance with nothing kind-specific to verify.

No `getBoundingClientRect` is used as a substitute for model geometry anywhere in this.

## 8. Selection geometry

**The largest consequence, and it is not caused by affine.** Rows 8, 19, 20, 21.

`selectionRect` returns `{x, y, width, height}` off the transform. `toRect` does the same per object.
The overlay writes them to `left`/`top`/`width`/`height` and **never sets a transform**. So the
selection frame is the object's *model box*, unrotated, at its model position — and for a rotated
object it is not the object's shape. Measured: a rotated ellipse paints 171.2 × 156.6 at
(975.4, 234.2) while its frame is 140 × 100 at (991, 262.5), `transform: none`.

Five notions must be named, and the codebase currently has three:

| notion | definition | status |
|---|---|---|
| **authored frame** | `{x, y, width, height}` from the transform | exists; what `selectionRect` returns |
| **painted bounds** | AABB of the four transformed corners | derivable; **not computed anywhere** |
| **selection outline** | what the overlay draws | **currently the authored frame**, i.e. wrong under rotation |
| **oriented bounds** | the transformed rectangle itself | not implemented; would need `matrix()` on the overlay box |
| **hit-test bounds** | per child, in the object's own space | exists and correct |

So the honest correction is terminological: **`selectionRect` returns a frame, not bounds**, and
calling it bounds has been wrong since M8 for any rotated object. Fixing it — giving the overlay the
object's own matrix, and drawing the oriented rectangle — is a **correctness fix that affine also
needs**, not new UI that affine would force. That reclassifies row 20 from "semantic change" to
"fix a bug, then it is representation-only".

**Rotation grip.** The grip sits above the *frame's* centre, and the eight handles sit on the frame's
corners. Once the frame follows the matrix, both land correctly for any invertible transform — and
the suppression at `rotation === 0` (row 21) becomes removable. **It is not removed here**: doing so
before the frame is fixed would put a grip in the wrong place.

## 9. Stroke semantics

**A gate, and the project has never made this choice.** Measured with a nested pair, since a border
does not change its parent's rect but a child at the padding edge does — so the offset between them
*is* the border's painted width.

| | horizontal border | vertical border |
|---|---|---|
| no transform | 12 | 12 |
| `scale(2, 3)` | **24** | **36** |
| `matrix(1, 0.6, 0, 1, 0, 0)` | 12 | **19.2** |

1. **B (transformed with the object) is what CSS does**, and it is free.
2. **A (invariant in document space) is not reachable by adjusting a number.** There is no CSS border
   equivalent: `vector-effect: non-scaling-stroke` is *accepted* by Chromium on an HTML element and
   then ignored (both halves tested), because it is defined for SVG geometry. Semantics A therefore
   means rendering strokes as SVG — which ADR 0005 declined for every kind except `line`, and which
   would make stroke rendering the one part of the renderer CSS cannot express.
3. **Under a non-uniform scale one authored stroke becomes two painted strokes** (24 and 36 from a
   single `12px`), and under shear the painted extent has no single width at all (19.2). Neither
   shape has an authored meaning yet.

**And the finding that makes it live rather than theoretical:** since M10 established that no gesture
writes `scaleX`/`scaleY`, every object's scale is 1, so **A and B are currently indistinguishable**.
The project has been getting B by accident and has never chosen. Affine would make the choice visible
for the first time.

`align: 'inside'` is unaffected in every case: it is a statement about the box, and the box is
transformed rigidly.

## 10. Text semantics

**Unaffected.** The three concerns separate cleanly and only one of them is geometric:

| concern | owner | affected by affine? |
|---|---|---|
| line breaking, baselines, kerning | **the browser**, in the frame's local space | no |
| frame geometry (`width`/`height`, local box) | the model | no — §4 |
| visual transform of the laid-out text | the element's `transform` | yes, by definition |

ADR 0010 §4 already proved the fence survives a transformed **ancestor**: layout metrics are
invariant (`clientWidth` 300 → 300 → 300) while `getBoundingClientRect` moves (300 → 480 → 338.6),
the subtree stays `contenteditable`, and one session produces exactly one model commit. A shear on
the object's own transform is the same mechanism, so text layout is untouched; the glyphs are
rasterised through the sheared matrix, which is the browser's job.

**No DOM nesting is introduced.** Nothing here needs it, and M10 §3 already showed option-A groups
render flat.

## 11. Image semantics

**Unaffected, with one thing that must not move.**

- **Intrinsic dimensions are metadata**, decoded once by ADR 0006 and stored on the asset record. An
  affine transform cannot alter them, and `AssetState` — rendering output published as
  `data-asset-state` — is likewise unaffected.
- **`object-fit` operates in the content box**, in local space. `cover` still covers the content box;
  the transform is applied afterwards.
- **A failed asset still paints its placeholder** and still reports `error`; the placeholder is an
  element like any other.
- **Hit testing is by box, not pixels** (ADR 0006 PROBE X/Y) — §7 covers it.
- **Persistence is untouched**: an image node's authored metadata is its `asset` id and its `fit`.

The one rule: **an affine transform must never alter authored asset metadata.** Nothing in this
design does, and `images.spec.ts` would fail if it did.

## 12. Persistence

The existing format **can** represent the candidate, at the cost of a version bump.

| | |
|---|---|
| New field | `skewX: number`, in `TRANSFORM_KEYS` after `scaleY` |
| Absent means | `0`, matching ADR 0007's rule for optionals |
| Canonical ordering | the declared key order, unchanged in kind |
| Validation | finite; the existing zero-scale refusal covers singularity |
| Equality | **field-wise, and sound** — because the parameterisation is bijective |
| Float round trip | exact enough; JSON round trip and decompose∘compose both hold to 1e-9 |
| **Format version** | **2.** ADR 0007: "a new field … a changed meaning" counts |

**Multiple equivalent serialised representations?** No, and this is the decisive point in favour of the
parameterised form. `R(t)·S(2,2)` and `R(t+π)·S(−2,−2)` are one matrix with two spellings; a 2×3 form
would carry both and need a canonicalisation rule to compare them. The parameterised form has exactly
one spelling per matrix **once `scaleX > 0` is required**, and `decomposeRSK` is that rule.

A migration is **not** required for the bump: every version-1 document has `skewX` absent, which means
0, and every version-1 transform is in the model's image already. This is the cheapest possible bump
— and it is still a bump, which is what ADR 0010's two-bump argument was about.

## 13. Grouping, revisited

With the analysis above, **group-local children become fully representable** under the *current*
model, provided group scaling is restricted:

| child under group | representable? | why |
|---|---|---|
| translated | **yes** | translations compose |
| rotated | **yes** | `R(θg)·R(θc) = R(θg+θc)` |
| non-uniformly scaled | **yes**, group unrotated or uniform-scaled | `R·S·R·S` with `S` on the group diagonal or uniform factors through |
| rotated, group uniform-scaled by `k` | **yes** | `k·R(θg+θc)·S` |
| rotated, group **non-uniformly** scaled | **no** | shear — ADR 0010 §2 |

So the composition `page → group → child → local` works for everything except one case, and the
exception is exactly one capability: **non-uniform group scale with a rotated descendant**.

The chosen composition for the renderer and hit testing is `M = M_group · M_child`, with the child's
`M_child = T(…)·R·S·T(…)`. That product is representable under the restriction, so **no second
geometry system is needed** — which was the requirement.

## 14. Blast radius

Classified from the §1 table.

| Subsystem | Class | Count |
|---|---|---|
| `core/geom` | representation-only (one factor, one predicate) | 1 |
| `model/types`, `factory` | representation-only (one field) | 2 |
| `model/transform` | representation-only (`localMatrix`, `worldMatrix`) | 1 |
| `model/invariants`, `commands`, `document-equality` | representation-only (one field each) | 3 |
| `model/shapes`, `editor/selection` hit testing | **no change** | 2 |
| `editor/measure`, `render/*` projections | **no change** | 3 |
| `editor/transform` `resizeTransform` | **no change** | 1 |
| `editor/transform` `rotateTransform` | **semantic change** — parent-space semantics, §6 | 1 |
| `editor/viewport/overlay` + `editor/editor` `toRect` | **correctness fix, then representation-only** — §8 | 2 |
| `ui/inspector` | **new UI semantics** — a `skewX` field; also today it exposes no scale at all | 1 |
| `persist` | **migration required** — `formatVersion` 2, no data migration | 1 |
| tests | new coverage for each of the above | — |

Against §12 of ADR 0010's table, the 51 `Page.objects` traversal sites are **unaffected**: a group
node still needs them, and they are a cost of groups, not of affine.

**The cost of affine is therefore: one new field, one new factor, one format bump, one new inspector
field, one rotation-semantics change, and one stroke-semantics decision — the last of which has no
cheap answer.**

## 15. Alternatives

| | Capabilities | Geometry | Implementation | Persistence | Interaction | Effect on invariants | Enables | Makes harder |
|---|---|---|---|---|---|---|---|---|
| **A. Keep, reject non-representable group scale** | move, rotate, uniform-scale a group | exact | `group`/`ungroup` + restriction | one node type, one bump | none new | none | group identity, uniform scale | nothing |
| **B. Group-local, uniform-only scale** | **+ non-uniform child scale under a uniform/unrotated group** | exact | same as A | same | none new | none | **everything but one case** | nothing |
| **C. Separate parent–child representation for groups only** | same as B | exact, but a second representation | **two** transform types | two schemas | none new | **breaks "one transform type"** | nothing B lacks | authoring, inspection, persistence |
| **D. General affine for all objects** | + non-uniform group scale | exact | see §14 | bump + inspector field + rotation semantics + stroke decision | none new | **stroke semantics decided** | non-uniform group scale; true multi-object resize | stroke authoring; the meaning of "rotation" |
| **E. Page-local groups, pure identity** | identity only | exact | cheapest | one bump | none new | none | durable hierarchy | nothing |

C is rejected on evidence: it buys nothing B lacks and costs a second transform type, which is the
"second geometry system" ADR 0010 warned against — just located in the group node instead of the
document.

E is rejected because M10 §3 established it is a layer folder: no geometry, no independent origin,
every operation the existing multi-select fan-out already provides.

## 16. Decision

**RESTRICT GROUPS.**

> Support group-local children, and **restrict group scaling to uniform scale**. Non-uniform group
> scaling is explicitly unsupported and is stated as unsupported rather than approximated. Do **not**
> extend `Transform2D`.

The evidence, in the order it mattered:

1. **The mathematics is not a reason to refuse.** The current model is a **codimension-1** subset of
   `GL(2)` — one equation, `a·c + b·d = 0`. The extension is one field, the decomposition is a
   bijection, and every arithmetic site in the inventory (hit testing, resize, measurement,
   rendering) is *already* correct for any invertible matrix. "A second geometry system" is not an
   available argument against it, and this ADR does not make one.
2. **It buys exactly one capability, and nothing can produce it.** Non-uniform scaling of *anything*.
   There is no writer for `scaleX`/`scaleY` — no gesture, no inspector field, no command. M10 F2
   records that the one function that would write them is dead and wrong. So the capability affine
   would add has no caller today, and the nearest caller is blocked behind a format bump it would also
   require.
3. **It forces three permanent semantic decisions, one of which is unresolved.** Rotation gains a
   second meaning the moment a shear exists (§3) — mitigable, but a rule forever. The selection frame
   needs fixing regardless (§8), so that cost is not attributable to affine. And the **stroke**
   decision (§9) has no cheap answer: document-space invariance would mean abandoning CSS borders for
   stroke rendering, contradicting the project's core premise.
4. **Restricting group scaling costs almost nothing.** Uniform group scale composes exactly
   (§13). Non-uniform group scale is one capability, not the feature.
5. **The restriction is honest and testable.** It is a stated limit with a proof, not a silent
   approximation — the same standard M8 set for multi-object resize.

### The precondition this satisfies

ADR 0010 recorded the blocker as *representability of parent–child affine composition*. **It is now
satisfied for every case except non-uniform group scale**, and that residual case is resolved by
restriction rather than by a model change. Groups are no longer blocked on a capability question.

### What is explicitly **not** decided

Multi-object resize (ADR 0008 §4) stays deferred. It needs the same shear, and the same argument
applies: nothing can produce a page-frame scale today. It is not blocked on the model; it is blocked
on there being no scale gesture.

### The re-entry condition

Extend `Transform2D` when **all three** hold:

1. a scale gesture exists that writes `scaleX`/`scaleY` (so the fields stop being file-only), **and**
2. non-uniform group scale or multi-object resize is actually wanted, **and**
3. a stroke semantic is chosen — with the acknowledgement that document-space invariance requires an
   SVG stroke renderer.

Condition 3 is the real one. Conditions 1 and 2 are ordinary; 3 changes what the renderer is.

## 17. Plan, if affine is ever approved

Recorded so the decision is reversible for the right reasons rather than by improvisation. **Not
implemented, and nothing in this milestone changes production geometry.**

1. **Decide the stroke semantic first** (§9), and record it in ADR 0005, whose §1 currently says
   "inside" without saying what "width" is measured in. This is the only step that can invalidate the
   rest.
2. Add `skewX?: number` to `Transform2D`, absent meaning 0, and `decomposeRSK`/`composeRSK` to
   `core/geom` — the code in `affine.ts` is already written and tested.
3. `localMatrix` becomes `R·S·K`. `worldMatrix`, `invariants`, `commands`, `document-equality`,
   `commonFrame`, `serialize`, `deserialize`, `TRANSFORM_KEYS` gain the field. **`cssMatrix` and the
   reconciler do not change** — CSS `matrix()` already takes any affine.
4. `formatVersion` → 2. No data migration: absent means 0.
5. Fix the selection frame (§8) **before** exposing the field, so the frame is right for the shapes
   that already exist. Then the rotate-handle suppression can be lifted.
6. `rotateTransform`: state parent-space semantics explicitly, with the §6 test as its proof.
7. Add `skewX` to the inspector — and, while there, the scale fields it has never had, or the
   inspector will show a skew with no way to see or change the scales that interact with it.
8. Multi-object resize becomes derivable from the same machinery; it should be re-derived, not
   re-enabled, and `scaleTransforms` must be replaced rather than reused (ADR 0010 F2).

## 18. Corrections to earlier decisions

§18 of the brief asks for these explicitly. Each is recorded where it belongs, not only here.

| Claim to correct | Where it was wrong | Correction |
|---|---|---|
| "M8's second-coordinate-space blocker was false" | ADR 0008 §5 cited the text fence and measurement boundary as unproven | Both **hold** under a transformed ancestor — measured in ADR 0010 §4. Neither was ever the obstruction; the transform model was |
| "Page-local grouping does not require DOM nesting" | not previously stated | Correct, and proved: children render into the same flat container. ADR 0010 §3 |
| "The real blocker for group-local scaling is representability of parent–child composition" | ADR 0008 framed it as "group resize" | Correct, and now *resolved by restriction* rather than by a model change (§13, §16) |
| "The absence of scale writers matters to the no-shear invariant" | ADR 0010 F1 recorded it as a fact | It is now load-bearing: it is why no-shear holds *by absence* rather than by enforcement, and why `no-shear.spec.ts` needs rotation-and-box assertions |
| "`scaleTransforms` must not be treated as evidence that scale semantics exist" | it was exported "for scale gestures" and is tested as though it worked | It is dead, and wrong for any rotated member. Pinned in `src/editor/transform.test.ts` (ADR 0010 F2) and classified `wrong already` in §1 |
| "The rotate handle does not establish multi-object rotation support" | ADR 0008's resize proof assumes a rotatable multi-selection | `startRotate`'s fan-out has **no gesture**. ADR 0010 F3, and §1 row 21 |

## 19. New findings in this milestone

> **F6, F7 and F8 are fixed.** See [ADR 0011b](0011b-selection-frame-and-stroke.md).
>
> **Delivered in M12.** The group itself is now a document object:
> [ADR 0012](0012-persistent-group-model.md), which restates this milestone's decision as the
> rule **a non-uniform scale may not be followed by a rotation** — sharper than "group scaling
> must be uniform", because a *leaf* may be scaled non-uniformly and a group may not. F6 by giving
> the outline the object's own matrix; F7/F8 by choosing a stroke semantic (option B, stroke width is
> a local dimension) and recording that a uniform group scale therefore multiplies member stroke
> widths by the same factor it multiplies their boxes.

- **F6 - the selection outline does not follow rotation.** Not an affine issue: it is a bug today.
  Measured, and the mechanical explanation for the rotate-handle suppression and the deferred
  multi-object resize. `tests/editor/frame-vs-shape.spec.ts`.
- **F7 — the stroke semantic has never been chosen.** A and B are indistinguishable while every
  scale is 1. `tests/editor/stroke-under-transform.spec.ts`, measured.
- **F8 — `vector-effect` is accepted on HTML elements and ignored.** Chromium parses it into
  `HTMLElement.style` and does nothing, because it is defined for SVG geometry. So document-space
  stroke invariance has no CSS route.
- **F9 — the current model is codimension-1 in `GL(2)`.** One equation, one field. This retires "a
  second geometry system" as an argument against affine, permanently.
- **F10 — rotation survives under shear, but only because of the factor order.** `K`'s first column
  is `(1,0)`, so the first column's angle is still the authored angle. Page-frame skew would break it.

## 20. Consequences

- `src/core/geom/affine.ts` and `linear-part.ts` are the executable form of this ADR. Both are
  imported only by tests; the build tree-shakes them and the bundle is unchanged.
- ADR 0005 §1 and §3 are amended: stroke width is transformed with the object, and that was never a
  decision.
- ADR 0008 §4 and §5 are amended per §18.
- ADR 0010 §7's "shear decision" is **answered**: deferred, with a three-part re-entry condition.
- Groups are unblocked, with one stated restriction.
- **New invariants to record when affine lands:** `skewX` is finite; `scaleX > 0` is the canonical
  branch; rotation is the authored field and never a derived one; stroke width is object-space.