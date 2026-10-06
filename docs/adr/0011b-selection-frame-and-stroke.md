# ADR 0011b — The selection frame is the object's frame

- **Status:** accepted
- **Date:** 2026-10-06
- **Depends on:** `docs/ARCHITECTURE.md` §1.3, §3.5, §3.8;
  [ADR 0005](0005-shape-geometry-contract.md), [ADR 0007](0007-persistent-document-format.md),
  [ADR 0008](0008-multi-selection-and-grouping.md), [ADR 0010](0010-groups-and-the-transform-question.md),
  [ADR 0011](0011-affine-transform-decision.md)
- **Answers:** what the selection frame is, what a stroke's width means, and what M12 may assume
- **Fixes:** F6 and F7/F8 from ADR 0011
- **Delivered by:** [ADR 0012](0012-persistent-group-model.md), which builds the group this
  geometry was made for
- **Amends:** ADR 0008 §7 and §13, ADR 0011 §8 and §19 F6/F7

## Context

M10b refused to extend `Transform2D` to a general affine, and in doing so found two defects that
predate it: **F6**, the selection outline did not follow rotation, and **F7/F8**, stroke scaling
semantics had never been chosen. Groups are now architecturally unblocked, and this milestone exists
because a group will rely on both of those answers. A group will be moved by dragging its frame and
will carry members whose strokes must not change meaning when the group scales — so "selection
bounds", "rotation" and "stroke width" have to be unambiguous *before* there is a group to be wrong
about.

**Summary: F6 was one conceptual error in five consumers, not five bugs. The fix reuses the
renderer's own projection rather than adding a second one, and it is 30 lines. F7/F8 is resolved by
*choosing* option B — stroke width is a local dimension and transforms with the object — which costs
nothing today, because no gesture writes the scales, and which makes a uniform group scale a
consequence rather than a special case.**

## 1. F6's root cause

Not "the overlay forgot the rotation". **The codebase had four different ideas of where an object
is, used one of them for all four, and named it "bounds".**

| consumer | what it actually used | correct for |
|---|---|---|
| `toRect` → the outline box | `{x, y, width, height}` | an unrotated object |
| `toRect` → the eight handles | the same, plus `HANDLE_UNITS` | ditto |
| `applyMarquee` | `toRect` per object | ditto |
| `hitTestPage` → `hitNode` | `invert(worldMatrix)` then a local predicate | **every object, correctly** |
| `paintedBounds` | *did not exist* | — |

Five sites, one mistake. The hit tester was right the whole time — which is why the bug was invisible
in behaviour and visible only in the chrome: clicking a rotated object worked, dragging it worked,
and the outline around it was in the wrong place.

That is also why the mistake survived nine milestones. Every interaction test asserted on the
*outcome* of a gesture, and the gestures were correct. Only a test that compares the **drawn frame**
to the **painted object** could see it, and no such test existed.

## 2. The fix: reuse the projection, do not add one

The smallest correct representation is **the object's own matrix, written onto the outline.**

`render/types/shape.ts` already writes `transform: matrix(...)` with `transform-origin: 50% 50%` onto
every object. The overlay now writes *the same matrix, with the same origin*, onto a box laid out at
the same `{x, y, width, height}`. The outline is therefore the object by construction rather than by
a second computation of it — one projection, two callers, and no way for them to disagree.

Concretely, in `src/editor/viewport/overlay.ts`:

- `SelectionOutline` gains `matrix: Mat2D` — the node's `localMatrix`, identity for a marquee.
- `outline()` writes `transform: cssMatrix(outline.matrix)` and `transform-origin: 50% 50%`.
- `framePoint(outline, local)` maps a point on the frame into page space, rebuilding
  `T(centre) · M · T(-centre)` — which is what `worldMatrix` does and what the overlay cannot import
  directly, because it holds a rect and a linear part rather than a `Transform2D`.
- `handlePoint(outline, direction)` and `rotationGripPoint(outline, gap)` are **public**, and the
  editor's `handleAt` calls `handlePoint` rather than recomputing.

### The single source of truth

Before, `overlay.outline()` and `editor.handleAt()` each computed
`rect.x + rect.width * unit.x`. They agreed with each other and both were wrong about the object.
That is the worst possible arrangement: a fix applied to one would have left the other behind, and
the symptom would be "the handle I can see is not the handle I can grab".

So `handlePoint` is now the only place handle positions are computed, and the test
`src/editor/viewport/overlay-frame.test.ts` asserts `framePoint === localToParent` for six probes ×
five transforms. That cross-check is the point: `paintedBounds` would still be right and the chrome
would still be wrong if the two sides each had their own test and no shared assertion.

### A bug the fix introduced, caught by the zoom test

The first version composed `scale(zoom)` into the outline's matrix, on the reasonable-sounding
grounds that the overlay is outside the zoom transform. It was already wrong: `toClientRect` lays
the box out at `width · zoom`, so the zoom is in the layout and the matrix scaled it a **second**
time.

At 100% zoom this is invisible, so every other test passed. It appears only at any other zoom, where
the outline stops matching the object. The zoom test in `tests/editor/selection-frame.spec.ts` is the
only thing that caught it — and it is why that test is in this milestone rather than left to whoever
next touches the overlay.

## 3. What the frame is, and what it is not

Four quantities, named once, in `src/model/transform.ts`:

| | definition | used for |
|---|---|---|
| **model frame** | `{x, y, width, height}` off the transform | the rotate pivot; `modelFrameUnion` |
| **painted bounds** | AABB of the four transformed corners (`paintedBounds`) | the marquee's hit region |
| **oriented bounds** | the transformed rectangle itself (`transformedCorners`) | the outline, the handles, the grip |
| **hit-test region** | per kind, in the node's own space | `hitTestPage` |

**`paintedBounds` and `transformedCorners` are new.** Before, nothing computed them.

### The rename

`selectionRect` returned the model frame and was called `selectionRect`, which is precisely the
ambiguity ADR 0011 §8 objected to: a caller could not tell from the name whether it was being handed
what the user sees. It is now **`modelFrameUnion`**, with a doc comment saying which of the four it
is, which one a caller probably wants instead, and why the rotate pivot is correct with it (`R` about
the frame's centre is a fixed point, so the centre does not move under the object's own rotation).

A comment would have been read once. A name is read at every call site.

### Why four corners and not a closed form

Under rotation the AABB is `|w·cos t| + |h·sin t|` by `|w·sin t| + |h·cos t|`, which is already not
what `{x, y, width, height}` says. There is no closed form that survives a shear, and a shear can
*narrow* an AABB as readily as widen it — so "the bounds are bigger now" is not even a safe
expectation. The corner computation *is* the specification.

### The marquee

`applyMarquee` tested `toRect(node.transform)` — the model frame. Changed to `paintedBounds`. Same
root cause, one cause further out: a rotated object could be selected by a region containing none of
it, which is the identical failure the function's own comment describes for an ellipse's transparent
corner. Still box intersection, still not exact pixels — that part of the comment stands.

## 4. Handles and the grip

Every handle was positioned from the model frame. All eight now come from `handlePoint`, i.e. the
transformed corners. Verified per corner against the object's own computed matrix, with the old
placement asserted as a negative control: for a 200×100 box at 30°, the old `nw` handle was **61 px**
from the real corner.

### The suppression is gone, and what replaced it

The rotate grip used to require `rotation === 0`. That was **not a capability limit** — it was a
workaround for the frame not following the rotation, and the comment said so ("so it can never
overlap the object's own corners"). With the grip placed on the transformed frame's top edge, pushed
out along the frame's own local −y, it is outside the shape at any angle.

The condition is now `outlines.length === 1`, which **is** a capability limit and is stated as one:
the pivot is the single selected object's frame centre, so with several objects there is no coherent
point to rotate about — because M8 deliberately has no aggregate selection frame (ADR 0008 §7).

**Consequence, and it is the point of the milestone:** a rotated object can now be rotated *again*.
Rotation was one-way before. `tests/editor/selection.spec.ts` asserts two successive rotations, and
one undo step for both.

## 5. Stroke semantics (F7/F8)

### The decision

> **Stroke width is authored in the object's own units and transforms with the object** (option B).

| | |
|---|---|
| **B — transforms with the object** | **chosen.** Free: the CSS border and the SVG `stroke-width` are both inside the transformed element, so neither needs a compensating mechanism. Consistent with `width`/`height` being local dimensions. Consistent with the **line's hit tolerance**, which is `stroke.width / 2` in local space — so the grabbable region and the painted region stay the same size. |
| A — invariant in document space | Unreachable without leaving CSS: `vector-effect: non-scaling-stroke` is **accepted and ignored** on an HTML element (measured), because it is defined for SVG geometry. Applying it to the SVG line alone would make the two kinds disagree — the exact failure §7 exists to prevent. |
| C — compensating vector-effect | Not a thing for HTML borders, and it fixes one mechanism out of two. |

`align: 'inside'` is unaffected in every case: it is a statement about the box, and the box is
transformed rigidly.

### It was previously accidental, and now it is not

M10b's §9 established that A and B are **indistinguishable today**, because every object's scale is 1
(ADR 0010 §6 F1). So the project has been getting B by accident for six milestones without having
chosen it. Choosing it now costs nothing and makes the answer explicit for the group scale that M12
will add.

### The price, stated

Under a **non-uniform** scale, one authored stroke becomes two painted strokes: a `12px` border
paints **24 × 36** at `scale(2, 3)`, and under a shear the painted extent is **19.2** with no single
width at all. Measured, in `tests/editor/stroke-under-transform.spec.ts`. That is the cost of B, and
it is the reason A was worth considering.

## 6. §7: one semantic across three rendering mechanisms

ADR 0005 draws a rectangle and an ellipse with a **CSS border** and a `line` with a **scoped SVG
`<line>`** carrying `stroke-width`, because CSS cannot stroke a zero-height box. Two mechanisms, one
model concept — the arrangement that produces "rectangles mean one thing and lines mean another".

Verified, in `tests/editor/stroke-semantics.spec.ts`:

- The SVG line's authored `stroke-width` is the model value in the element's own units.
- The island is **inside the same transform** as a CSS border: a 180 px segment at 30° reports a
  bounding box of 155.9 × 90, which is only possible if the element's rotation reaches the SVG. An
  island that had escaped the element would report 180 × 0.
- A zero-height line paints its stroke through the SVG with `border-width: 0px`, so the two
  mechanisms are not both claiming the same object.

Not measurable, and recorded rather than asserted: the *painted* thickness of an SVG stroke.
`getBoundingClientRect` on an SVG shape reports geometry, not stroke, so the 8 px width is absent
from that box. The stroke width is asserted from the attribute and from the border offset trick
instead.

## 7. §8: what a uniform group scale will do to a stroke

Not implemented — no group exists. The **rule M12 will implement**, stated so it is testable before
there is anything to test:

> A group's uniform scale is a transform on the child. Under option B a transform that scales the
> child scales the child's stroke by the same factor. A child's authored 12 px stroke under a group
> scaled by `k` paints `12 · k`.

There is **no separate "stroke scale" to keep in step** — that is the property that makes B safe to
adopt before groups exist. Asserted as a composition: at `matrix(2,0,0,2,0,0)` the box doubles *and*
the stroke doubles, by the same number.

A group's own stroke, if it ever has one, is authored in **group-local** units and follows the same
rule one level up.

## 8. What the visual baselines cannot see

**The overlay suite's pixel baselines cannot detect F6.** `maxDiffPixelRatio: 0.002` over the
surface clip is several thousand pixels of tolerance, and a 1 px chrome outline rotating is far
under it.

Verified directly: the `overlay-rotated` snapshot **passes both before and after** the fix. The
stored baseline was read and it shows a rotated outline with handles on the rotated corners — so it
was recorded from the fixed rendering, and the unfixed rendering also satisfied it.

The tolerance is right for page content (antialiasing) and wrong for 1 px chrome, and it is not
changed here because every other suite depends on it. The consequence is recorded instead: **every
F6 assertion is geometric.** `tests/editor/selection-frame.spec.ts` reads rectangles and compares
them, and asserts the old placement as a negative control. A guard that cannot fail is not a guard,
and neither is a baseline that cannot fail.

## 9. Consumers audited

| consumer | verdict |
|---|---|
| `overlay.outline` box | **fixed** — carries the object's matrix |
| `overlay.outline` handles | **fixed** — `handlePoint`, transformed corners |
| `editor.handleAt` | **fixed** — calls `handlePoint`; was a second copy of the same formula |
| `overlay.rotationHandle` | **fixed** — `rotationGripPoint`, on the transformed top edge |
| `editor.rotationHandleAt` | already agreed (it hit-tested the point the overlay drew); now a *correct* point |
| `editor.applyMarquee` | **fixed** — `paintedBounds` instead of `toRect` |
| `editor.overlayInput` outlines + hover | **fixed** — both carry `matrix` |
| `editor/transform.selectionRect` | **renamed** `modelFrameUnion`, documented against the other three |
| `editor/selection.commonFrame` | unchanged: compares five *fields*, and the inspector shows those fields, so it is correct for its purpose |
| `hitTestPage` / `hitNode` | unchanged and correct — `invert(worldMatrix)` then a local predicate |
| `editor/transform.resizeTransform` | unchanged and correct — unprojects into the object's own space; the handle it is given is now the right one |
| `editor/transform.rotateTransform` | unchanged; pivot unchanged (`R` about the frame centre is a fixed point) |
| measurement (`editor/measure`, `render/measure`) | unchanged — layout APIs, transform-invariant (ADR 0004, ADR 0010 §4) |
| persistence | unchanged — no model or format change |

## 10. Findings

- **F11 — the overlay suite's baselines cannot detect a 1 px chrome change.** §8. Trap 14 realised.
- **F12 — injected fixtures bypass the parser.** `window.__P1_FIXTURE__` is used as given:
  `expectOnlyKeys` never sees it, `normalizeRichText` never runs. A wrong shape is not *refused* — it
  reaches the renderer and throws, and the document mounts with **zero objects** and no indication
  that it was malformed. `RichText` is `{ blocks: [...] }`, not `{ paragraphs: [...] }`, and an asset
  record is `{ kind, mime, intrinsicWidth, intrinsicHeight, data: { inline } }`. Recorded on the
  fixture itself.
- **F13 — `Object.keys(HANDLE_DIRECTIONS)` order is load-bearing.** The F6 test indexes handle
  positions by array order. That is fragile in a way the old name-based lookup was not, and the
  ordering is now stated in the test rather than assumed.
- **F14 — the layer rule caught a test that reached across it.** `src/model/painted-bounds.test.ts`
  initially imported `editor/viewport/overlay` to cross-check the frame arithmetic. ESLint refused,
  correctly; the cross-check moved to `src/editor/viewport/overlay-frame.test.ts`. The rule works.

## 11. Consequences

- The selection frame, its handles and its grip are the object's transformed frame at every zoom, on
  every page, for every object kind.
- Rotation is adjustable more than once, and the disabled state is a stated capability predicate
  rather than a geometry accident.
- `selectionRect` no longer exists under a name that lied.
- `paintedBounds` and `transformedCorners` exist and are tested, so painted bounds are a named,
  computed quantity rather than an emergent one.
- Stroke width has a chosen semantic, and the uniform-group-scale rule follows from it.
- **New invariants:** the outline's matrix is the node's own; `handlePoint` is the only handle
  geometry; a marquee tests painted bounds; stroke width is a local dimension.
- **M12 may assume:** selecting a group outlines its members' transformed frames; a group's uniform
  scale multiplies member stroke widths by the same factor; `paintedBounds` is how you ask where an
  object is.
- **Still deferred, and now for the stated reason:** multi-object resize (a group's frame would need
  handles that resize members, which is ADR 0008 §4's shear), and any aggregate selection frame
  (M8's decision, which is why the grip is single-selection only).