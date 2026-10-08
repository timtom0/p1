# ADR 0016 — Alignment and distribution, and the page/local coordinate boundary

- **Status:** accepted
- **Date:** 2026-10-08
- **Depends on:** `docs/ARCHITECTURE.md`; [ADR 0008](0008-multi-selection-and-grouping.md),
  [ADR 0010](0010-groups-and-the-transform-question.md), [ADR 0011](0011-affine-transform-decision.md),
  [ADR 0011b](0011b-selection-frame-and-stroke.md), [ADR 0012](0012-persistent-group-model.md),
  [ADR 0013](0013-group-interaction.md)
- **Answers:** what geometry alignment and distribution operate on; whether an aggregate selection box is
  now permitted; and where the page-space/parent-local boundary is drawn
- **Amends:** nothing. **Extends:** ADR 0011b §3 with a consumer that is neither the overlay nor hit testing

## Context

M16 adds the first multi-selection *editing* operations: six alignments and two distributions. Two
questions had to be answered before any code, and one of them had been answered wrongly elsewhere in the
codebase.

The second is the more interesting, because it is a **defect found while building the feature** rather than
a design choice made in advance. `applyMove` added a page-space delta straight onto `Transform2D.x/y`.

## 1. Alignment operates on painted bounds, in page space

> **Every box alignment and distribution reasons about is a page-space painted bound.** A leaf's is its own
> `paintedBounds`; a group's is the union of its descendants' painted bounds.

Not the model frame. ADR 0011b §3 established that `{x, y, width, height}` is the **local, unrotated** box,
and that for a rotated object it is not what the user sees — a 100×60 box at 45° paints 113.1 × 113.1.
Alignment is a visual operation, so aligning model frames would line up invisible boxes and visibly
misalign the shapes.

The choice is only testable at an angle large enough to separate the two answers. `tests/editor/align-fixtures.ts`
uses 45° for exactly that reason, and `src/model/arrange.test.ts` asserts that the model-frame answer and the
painted answer differ before asserting that the painted one is produced. A fixture at 0.4 rad would have
passed under either implementation.

### A group's box is its descendants' union — not a special case

A group authored at the transparent frame (ADR 0012) has a `width`/`height` describing nothing painted, so
`paintedBounds` of the group node would be a box the user never sees. The union of its members' painted bounds
is **already** how the selection outline frames a group (`editor.ts`, `overlayInput`).

Reusing that derivation is the point: alignment then reasons about the same box the user is looking at, and
the two cannot drift apart. A special case invented here would have been a third answer to "where is this
group", which is the arrangement ADR 0011b §2 calls the worst possible one.

Aligning a group **moves the group**. Nothing fans out to children: the group's transform is the authored
quantity, and the members follow by composition. Rewriting member transforms would be a second mutation path
with no contract behind it.

### Two transforms, and only one of them is exposed

`paintedBounds` resolves a transform against its **immediate parent**. Handing it a node's authored
transform therefore measures the object *inside its group*, not on the page. The two coincide at depth 0 —
which is most objects, and every test that existed before this one — so the error is invisible until
something is nested.

That is exactly what happened: `ArrangeTarget` first carried a single `transform`, and a nested leaf's box
came out at its authored `(20, 20)` instead of its painted `(163.36, 154.48)`, dragging the selection's
union to the wrong edge and sending a top-level object to `x = 20`. The browser test caught it; the unit
suite was green.

So `ArrangeTarget` exposes the **authored** transform only, and the page-space form is computed, used to
produce `painted`, and discarded. There is no second transform on the interface to pick up wrongly. That is a
shape decision, not a comment: the comment was already there and was still got wrong.

## 2. The aggregate box is calculation data, never geometry

Alignment needs a reference box for the whole selection: the union of the members' painted bounds.

ADR 0008 §7 refused an **aggregate selection frame**, and the two are easy to conflate. That ADR's objection
was to a rectangle *presented to the user* as though it were geometry — which, for rotated children, is not
the painted bounds, and which would invite a resize gesture that M8 deliberately does not have.

| | aggregate selection frame (ADR 0008 §7) | this union |
|---|---|---|
| drawn | yes | **no** |
| grabbable | yes, in principle | **no** |
| backed by the model | no — derived | no — derived |
| exists between frames | yes | no — computed, used, discarded |

Nothing is presented, so nothing can be mistaken for geometry. The overlay still draws per-member outlines
exactly as before, and the rotation grip remains single-selection because ADR 0011b §4's stated reason — no
coherent pivot for several objects — is untouched by this milestone.

**Multi-object resize stays deferred.** Distribution needs each member's extent, which is why this milestone
needs painted bounds at all, and it is precisely the capability a resize would need. That is ADR 0008 §4's
shear problem, and nothing here touches it.

## 3. The page/parent coordinate boundary

> **`Transform2D.x/y` are parent-local. Every user-facing quantity is page-space. The conversion between them
> happens in exactly one place, `pageDeltaToParentDelta`.**

The defect: `applyMove` computed `dx = pagePoint.x - gesture.origin.x` — page space — and added it to
`node.transform.x`, which is parent-local. Correct only when the parent is the page. A child of a group
rotated 45°, dragged `+40` page px along x, moved its painted bounds by **28.2843** — exactly `40·cos 45°` —
and drifted off at an angle while the drag looked like it had worked.

It survived because the only drag test dragged a **group**, which sits at depth 0 where the parent matrix is
the identity. `tests/editor/group-interaction.spec.ts` had claimed in its own header, since it was written,
that *"a child inside a rotated, uniformly scaled group moves correctly"* was load-bearing coverage. It was
not, and no such test existed. The header now matches the file.

The conversion composes the ancestor chain with `worldMatrixIn` — the one established composition order
(ADR 0011 §6) — and applies `invert`. It differences two images of `applyPoint` rather than transforming the
origin, because a vector conversion must not pick up the chain's translation.

**Chain order is not observable.** With every scale in a chain uniform — the invariant `worldTransformIn`
documents and `validateDocument` enforces — each linear part is `R(t)·S(s)`, and

```
R(a)·S(s) · R(b)·S(t)  =  s·t·R(a+b)
```

so reversing the chain changes nothing. Verified by measurement: the nested leaf moves `30.000000 / -20.000000`
either way. A non-uniform scale would break the identity, and `UNIFORM_SCALE_EPSILON` refuses such a document
before it can reach here. The corresponding mutant is therefore **equivalent** and is recorded in
`scripts/mutations.ps1` as such rather than carried as a survivor that can never fail.

## 4. Consequences

- Alignment and distribution translate only. `width`, `height`, `rotation` and both scales are carried
  through untouched, so sizes are preserved exactly and — under ADR 0011b §5, where stroke width is a local
  dimension that transforms with the object — **no stroke changes thickness**.
- The distribution rules are stated in `src/model/arrange.ts` and pinned by mutants: sorted by the near
  painted edge with `id` breaking ties, outermost two fixed as anchors, equal **gaps** (not equal centres),
  negative gaps allowed, two objects refused.
- **Two kinds of nothing are kept apart.** `arrangementDeltas` returns `null` when the selection is too small
  (the operation is *unavailable*, which disables a control) and an empty map when it applies and moves
  nothing (a silent no-op). Zero deltas are omitted rather than stored as `{x: 0, y: 0}`, so the no-op is
  observable and needs no second zero check — and no epsilon appears anywhere, because a tolerance would be a
  second definition of "already aligned" that could disagree with the model's own no-op rule.
- One user operation is one undo step: a `batch` of `setTransform`, the same shape `restack` uses. No new
  command type, so `mapNodesById`, the merge-and-compare no-op check and `isNoop` are not reimplemented.
- Selection is preserved. Alignment moves objects; it does not re-select them, which is what lets a user
  align twice — the second click being a correct no-op rather than a selection that moved underneath them.
- No format-version bump. Alignment changes existing transforms and nothing else; asserted by reading
  `formatVersion` back out of the saved bytes.

## 5. Findings

- **F15 — `data-align` was already taken.** The inspector's paragraph-alignment control writes `data-align`
  with the values `left`/`center`/`right` (ADR 0003), and `tests/editor/text.spec.ts` selects it. The toolbar's
  object alignment uses `data-object-align` / `data-object-distribute`, which is both unambiguous and more
  accurate: these operate on objects, that operates on the text inside one. Every `[data-align="left"]` locator
  resolved to two elements until this was noticed.
- **F16 — `aria-disabled` is honoured by tooling, so an unavailable control cannot be clicked normally.**
  Playwright's actionability check treats `aria-disabled="true"` as disabled and waits rather than clicking.
  This is the contract working as intended — it is why the layer buttons use `aria-disabled` rather than
  `disabled`, and why they stay in the tab order. It is recorded because a test that needs to exercise the
  *application's* guard underneath must pass `force: true`, and that looks like a workaround until you know.
- **F17 — serving the production bundle silently disarms the mutation harness.** Since M15 the browser suite
  is served `dist/`, so a mutation to `src/` reaches nothing unless `dist/` is rebuilt per mutant. A bundle
  built once means **no source mutation can affect any browser test**, and all twenty browser mutants report
  "NOT FOUND" — the worst failure mode this tool has, because twenty survivors all look like coverage gaps.
  `scripts/mutation-check.ps1` now rebuilds before each browser mutant, and says why at the call site.
- **F18 — the milestone's own unit suite had the gap that its browser suite caught.** Every unit test that
  predated the nested case agreed at depth 0. The regression is now pinned on both sides, and the unit test
  that pins it was verified to fail against the original shape (`20` against `163.37`).
