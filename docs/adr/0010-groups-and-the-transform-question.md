# ADR 0010 — Groups, and the question they were really asking

- **Status:** accepted
- **Date:** 2026-10-05
- **Depends on:** `docs/ARCHITECTURE.md` §1.3, §2.3, §5, §6;
  [ADR 0004](0004-measurement-boundary.md), [ADR 0005](0005-shape-geometry-contract.md),
  [ADR 0007](0007-persistent-document-format.md),
  [ADR 0008](0008-multi-selection-and-grouping.md),
  [ADR 0009](0009-boundaries-audit.md)
- **Answers:** whether a group can be a real document object under the existing contracts; what a
  group is for, given that the existing editor already supports every geometric operation on a set
  of objects; and why the feature that is actually missing is not grouping
- **Supersedes:** nothing. **Amends:** ADR 0005 §3 (records a field with no writer) and ADR 0008
  §4 (records a capability with no gesture)

## Context

The brief asked whether a group can be represented as a real document object without violating the
geometry, measurement, text-editing, hit-testing, renderer, persistence, or history contracts, and
named two candidates:

- **A. Page-local children.** Children keep page coordinates; the group contains them.
- **B. Group-local children.** Children are authored in the group's coordinate system; the group
  owns a transform into page space.

It also asked for the proof *before* any UI, and named "if groups fail, stop after the proof" as an
equally valid outcome.

**Summary: neither option failed. Option A is implementable today, and it turns out to be a layer
folder — it adds a name and nothing else. Option B is the version that would earn the feature, and
it is blocked on a single question this codebase has deferred twice: whether `Transform2D` should
admit a shear. Grouping is therefore not the missing feature. It is the *symptom* of a missing
transform capability, and building it before that decision would ship the cheap half and make the
expensive half harder.**

Three findings fell out of the investigation that are independent of the decision, and two of them
correct the record.

## 1. The characterisation, as code rather than as prose

Every limit in ADR 0008 §4 and in §2 below reduces to one question: **can this 2×2 be a rotation
times a diagonal scale?**

That question is decidable in one line, and it is now one function:
`src/core/geom/linear-part.ts`.

- `R(t) · S(sx, sy)` has columns `sx·(cos t, sin t)` and `sy·(−sin t, cos t)`, whose dot product is
  zero. So perpendicularity is **necessary**.
- Conversely, a 2×2 with perpendicular columns factors as a rotation times a diagonal scale:
  normalise each column to unit length to get an orthogonal matrix — a rotation, possibly composed
  with a reflection, which a negative `sy` absorbs — then scale by the lengths divided out. So
  perpendicularity is **sufficient**.

"Columns are perpendicular" is therefore not a convenient necessary condition. It **is** the model's
expressible set, which is what turns "this is a shear" into arithmetic rather than opinion.

ADR 0008 asserted the converse in a comment and never tested it. `linear-part.test.ts` now does:
it factors perpendicular-column matrices back into `R` and `S` and requires the product to
reproduce the original, including with a translation attached. Both proof files
(`group-resize-limit.test.ts`, `group-composition.test.ts`) import the single predicate, so they
cannot drift apart or disagree about what the model can hold.

One detail worth recording, because it is the whole of ADR 0005's warning and it is invisible until
you write it down: `R(t)·S` is representable at *every* rotation, while `S·R(t)` is a shear at
every rotation but zero. The operand order is the difference.

## 2. Option B, formally

Child authored in group-local space, group authored in page space. Page space needs
`worldMatrix(group) · worldMatrix(child)`; only the linear parts decide representability:

```
L = R(θg) · S(σxg, σyg) · R(θc) · S(σxc, σyc)
```

Its columns are `σxg·σxc·(cos θg, sin θg)` and `σyg·σyc·(−sin(θg+θc), cos(θg+θc))`, and their dot
product is `−σxg·σyg·σxc·σyc·sin(θc)`.

So the composition is representable **iff `sin(θc) = 0`**:

| Group scale | Child rotation | Representable |
|---|---|---|
| identity or uniform | any | **yes** — rotation adds (`θg + θc`), scale multiplies |
| non-uniform | 0 or a quarter turn | **yes** |
| non-uniform | anything else | **no** — a shear |

The surprising half, and the reason the constraint is phrased about the *child*: a non-uniform group
scale is harmless on its own, and rotating the *group* does not help. There is no rotation at which
a non-uniform scale becomes safe.

There is a second, non-algebraic reason for the same constraint. With a uniform group scale the
composed rotation is `θg + θc`, so the child's authored `rotation` still describes what the user
sees. With a non-uniform scale it does not, and because no `(θ', sx', sy')` reproduces the composed
matrix, **the inspector would be displaying a number that does not describe the picture** — which
the measurement boundary would not catch and which no screenshot would either.

`group-composition.test.ts` proves all of the above, including the boundary from both sides.

### The renderer is not the constraint

CSS `matrix(a, b, c, d, e, f)` accepts any affine 2×2, shear included. A renderer could therefore
*paint* a sheared group, invert the same matrix for hit testing, and look correct in every
screenshot. What it could not do is store it in a `Transform2D`, show an honest rotation for it, or
keep the model's "no shear anywhere" promise. This is the same distinction ADR 0008 §5 turned on:
**the model is the constraint, not the DOM.** Worth stating explicitly, because "can we draw it" is
the question a reader reaches for first, and it is the one with the wrong answer.

## 3. Option A, formally

A child's `transform` is already page-space, so `worldMatrix(child)` is the answer whether or not a
group exists. There is no composition, and therefore **nesting can never introduce a shear — not at
any rotation, not at any scale, not at any depth.** Hit testing needs `invert(worldMatrix(child))`,
which is what `parentToLocal` already does. This is option A's entire geometric case, and it is a
strong one.

The price is structural, and it is where option A stops being interesting:

**A group has no transform of its own, therefore no authored geometry.**

- It has no `x`/`y`/`width`/`height` to store, so nothing to `setTransform`, nothing for
  `describeCommand` to name, nothing to persist.
- Its extent has to change whenever a child is added, moved, or resized, so its bounds are
  **derived** — and derived geometry cannot be authored.
- Every geometric operation on a group is therefore a fan-out over children. "Move the group" is
  `moveTransform` applied to each member about a captured pivot. "Rotate the group" is
  `rotateTransform` applied to each member about a captured centre.

That fan-out is **exactly the multi-select move and rotate that M8 already built and M9 already
tested.** Option A adds durable identity — "these five objects are one thing" — and nothing else.
It is a layer folder.

This is also why option A needs no DOM nesting, and why §4's measured result matters more than it
looks.

## 4. ADR 0008's pessimism, corrected

ADR 0008 §5 declined group-local children partly because "the text fence and the measurement
boundary have not been proven against a nesting transform". M10 tested that instead of carrying the
assumption forward. Both halves hold, and for the same reason:

> A CSS transform changes **paint**. Every API the measurement boundary is built on is a **layout**
> API.

Measured in the browser (`tests/editor/transform-invariance.spec.ts`), with the page stack carrying
a rotation and a non-uniform stretch:

| | 100% | scaled 1.6× | rotated 0.4 rad |
|---|---|---|---|
| `clientWidth` / `clientHeight` | 300 / 160 | 300 / 160 | 300 / 160 |
| `offsetWidth` | 300 | 300 | 300 |
| `scrollWidth` / `scrollHeight` | 300 / 136 | 300 / 136 | 300 / 136 |
| `getBoundingClientRect().width` | 300 | **480** | **338.6** |

Only the paint-space rect moves, and the negative control is inside the test: the rect assertion
*requires* the transform to have taken effect, so the sweep cannot pass by quietly doing nothing.

The text fence survives too, which is a stronger claim than measurement: under the same transform
the subtree is still `contenteditable`, a keystroke still produces exactly one model commit at
session exit, and the committed text is the model's canonical form rather than the DOM's. That last
one is verified negatively — reading `innerHTML` instead of canonical text makes the test fail.

**ADR 0008 was wrong on both counts, and M8's deferral of grouping rested partly on it.** The
measurement boundary and the fence are *not* what blocks groups. The transform model is.

## 5. What a group would cost, whichever option

Stated so the decision does not depend on my taste.

`Page.objects: Node[]` is assumed flat in **51 places** across 15 modules. With a group variant in
the `Node` union, the following must learn to recurse, and each of them is a place where "I forgot
the group" fails silently rather than loudly:

| Concern | Module | Failure if it ignores a group |
|---|---|---|
| id lookup, selection resolution | `document-view` | cannot select a child |
| validation, cycle and duplicate-id detection | `invariants` | accepts a cyclic or doubly-owned tree |
| canonical equality | `document-equality` | dirty state lies; undo never fires |
| serialise / deserialise | `persist/serialize`, `persist/deserialize` | data loss or a parse that refuses its own output |
| hit testing | `selection` | clicks fall through a group |
| rendering | `render/reconciler` | children never mounted |
| commands | `model/commands` | `setTransform` on a child is a no-op that reports success |

ADR 0007's rule settles the version question: *"Adding a new **node type** or a new shape kind
counts too, because an older build must refuse the file rather than render the object as nothing."*
So a `group` variant mandates `formatVersion: 2`.

Which produces the argument that decided this milestone. Option A today means `formatVersion: 2`.
Option B later adds a coordinate space to that node, which changes the on-disk shape again, so
`formatVersion: 3`. **Two bumps, and therefore two migrations, for one feature.** M11's job is to
design that chain once, carefully, with per-version golden fixtures. Spending the first bump on the
half of grouping that adds no capability is a poor trade.

## 6. Findings about the application, independent of groups

Four things were found while proving the above. Two correct the record.

**F1 — `scaleX`/`scaleY` have no writer.** No gesture in the application writes them. They are set
by `factory` (defaults), read by `deserialize`, and round-tripped by `serialize` — that is, they
exist so a file can carry them, and nothing can change them. Consequently every live object's matrix
is `R(t)·S(1,1)`: a pure rotation. The "no shear" property currently holds because *nothing scales*,
not because anything prevents it.

**F2 — `scaleTransforms` is dead code, and it is wrong.** `src/editor/transform.ts` exports
`scaleTransforms` "for scale gestures". Nothing calls it except its own tests, and those tests use
only unrotated boxes, where growing `width`/`height` about a pivot *is* a scale. Given a rotated
member it grows the box and leaves `rotation` alone, which is neither a page-frame scale nor the
bounding box of one.

This is a landmine with nothing guarding it: the first person to wire up a "scale the selection"
gesture will reach for this function, and it will ship precisely the shear ADR 0008 rules out. It is
left in place rather than deleted — deleting a function someone may be about to re-derive loses the
reasoning — but `src/editor/transform.test.ts` now pins what it does to a rotated member and why
that is wrong, in the only file a future implementer will open.

**F3 — the rotate handle exists only for a single, unrotated selection.** `overlayInput` emits it
only when there is one outline *and* `commonTransform.rotation === 0`. Two consequences: rotating
an object is a one-way trip, with no gesture for adjusting the angle afterwards; and
`Editor.startRotate`'s fan-out over several nodes **has no gesture that can reach it**. Multi-object
rotate is an editor capability with no user-facing entry point.

**F4 — `scaleTransforms` is not the only such capability, and `selectionRect` is the frame a group
would want.** `selectionRect` already computes a selection's bounding box ignoring rotation, and it
is the honest input to a group frame under option B. The blocker is not that the box cannot be
computed; it is that scaling *about* such a box is unrepresentable (§2, ADR 0008 §4).

### F5 — the no-shear invariant is now a runtime check, not a comment

ADR 0005 and ADR 0008's limits are statements about the *type*. Nothing was checking the
*application*. `tests/editor/no-shear.spec.ts` now reads every object's computed matrix after each
gesture the editor can perform and requires its columns to be perpendicular — and, critically, the
same sweep is required to *fail* when a known shear is injected into a live element. A guard that
cannot fail is not a guard.

Two of its non-vacuity assertions are worth keeping in mind when reading it, because both were
initially wrong and the first version of the file passed for the wrong reason:

- A **move** is asserted by the full delta (7.5px of an intended 40px satisfies "it moved" — trap
  21), and the linear part must be byte-identical afterwards.
- A **resize** changes the *box*, not the matrix scale, because of F1. Asserting "the scale changed"
  after a resize checks nothing at all.

## 7. Decision

**Do not implement grouping in M10.** The reason is not that a representation is impossible —
option A's proof is above and it is sound — but that the milestone would deliver the wrong half of
the feature.

1. **Option B is the version worth having.** An independent origin is the entire point of a group:
   with it, rotating or scaling a group rewrites *no child's* transform. Option A has no such thing,
   so every group operation is the multi-select fan-out that already exists.
2. **Option B is gated on one question that is worth more than grouping.** Whether `Transform2D`
   should admit a shear decides, in order: group-local coordinates under a non-uniform group scale;
   multi-object resize (ADR 0008 §4); and any future nesting. Those are one capability wearing three
   costumes. Grouping is not a good place to settle it, because settling it *for* grouping means
   choosing the smallest version of it.
3. **Option A now costs a format version for a folder.** §5.

### Why this is not "impossible"

Stated plainly, because the distinction is the deliverable: **option A is implementable this
milestone.** A `GroupNode` with page-local children, a contiguous run in the page's paint order, a
`groupObjects`/`ungroupObject` command pair, and a derived selection outline computed by the overlay
from the union of its children's painted bounds — none of that touches the transform model, the
measurement boundary, the text fence, or the renderer's flat projection. It is roughly a format
bump, twelve recursive traversals, two commands, and a test suite.

It was not built because of point 3, and because building a layer folder is not worth a format
version. If a group is wanted sooner than the shear decision, that is a legitimate call — and the
specification is §2–§5 plus the five rows of §5's table. It should be made deliberately, with the
format-version consequence stated out loud, not reached for accidentally.

### The smallest viable alternative

The milestone the roadmap should take next is **the shear decision**: does `Transform2D` admit a
general 2×2, or does it stay `R·S`? That is an architectural question, not a feature, and it has a
cheap first half — inventory every place that assumes a rotation angle exists and is meaningful
(the inspector's rotation field, `rotateTransform`'s angle arithmetic, the overlay's grip position,
`selectionRect`) and decide what each reports for a sheared object. Until that inventory exists,
"add shear" is a slogan.

If a *feature* is wanted instead, the smallest honest one available is **multi-object resize**
(ADR 0008 §4) — but it is gated on the same answer, so it is not actually available. The next
ungated feature remains M11, persistence: the migration chain that §5's argument assumes will be
needed eventually.

## 8. Rejected representations

| Representation | Rejected because |
|---|---|
| **A. Page-local children** | Representable, and geometrically free. Rejected as *insufficient*, not impossible: it adds identity only, every geometric operation is the existing multi-select fan-out, and it spends a format version. |
| **B. Group-local children** | Blocked: a non-uniform group scale applied to a rotated child is a shear (§2), which `Transform2D` cannot hold and the inspector could not honestly report. |
| **B′. Group-local with a uniform-scale constraint** | Coherent and cheap for unrotated children, but a constraint that silently disables the group's most ordinary operation. Recorded as the fallback if B is taken without shear: groups may only scale uniformly. |
| **B″. Group-local with a shear parameter** | The real answer, and out of scope here: it amends ADR 0005's geometry contract and needs the §7 inventory first. |
| **DOM-nested `<div>` per group** | Not the geometry's problem but the renderer's: DOM nesting is unnecessary under option A, and under option B it would need proving against paint order, pointer behaviour, the text fence, image decoding and reconciliation identity. The model must not acquire a second geometry system to justify a DOM shape. |
| **Group as `SelectionState`** | Not a document object. Fails identity across save/load, which the brief requires and §5's table requires a schema for. |
| **Group bounds as "whatever the children currently occupy"** | Explicitly forbidden by the brief, and impossible under option A anyway — such a value cannot be authored, so it cannot be the thing `setTransform` writes. Four distinct notions are needed instead: **authored** frame (option B only), **painted** bounds (four corners through `worldMatrix`, then the AABB), **selection** bounds (what the outline draws), **hit-test** bounds (per child, in the child's own space). |

## 9. Consequences

- `src/core/geom/linear-part.ts` is the single definition of what the model can express, shared by
  both proofs and by `tests/editor/no-shear.spec.ts`.
- `tests/editor/transform-invariance.spec.ts` generalises ADR 0004 from "the one transformed
  ancestor that exists" to "any transformed ancestor", and corrects ADR 0008 §5.
- `tests/editor/no-shear.spec.ts` makes ADR 0005's promise a checked property of the running
  application, and can itself fail.
- ADR 0008 §5's deferral rationale is amended: the fence and the measurement boundary were never
  the obstruction.
- ADR 0005 §3 is amended: `scaleX`/`scaleY` are file-carrying fields with no writer, and
  `scaleTransforms` is an unused and incorrect prototype.
- ADR 0008 §4 is amended: `startRotate`'s multi-object fan-out has no gesture that reaches it.
- **Open:** the shear decision (§7), and whether to spend `formatVersion: 2` on option A.
- **Bundle unchanged.** No production code was touched. `linear-part.ts` is imported only by proofs
  and tests, and the build confirms it is tree-shaken out: 107.61 kB raw / **32.98 kB gzipped**,
  byte-for-byte M9's figure. The mutation suite is therefore unchanged at **30/30**, and
  `scripts/mutation-check.ps1` records why there is nothing new to mutate — including why
  `scaleTransforms` and the unwritten `scaleX`/`scaleY` cannot be reached by a mutation at all.