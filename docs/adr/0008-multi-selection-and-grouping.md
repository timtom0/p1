# ADR 0008 — Multi-selection, layer order, and why grouping is not yet a model object

- **Status:** accepted
- **Date:** 2026-10-05
- **Depends on:** `docs/ARCHITECTURE.md` §1.3, §1.6, §2.3, §3.4, §3.5, §4.2, §5.2, §6;
  [ADR 0004](0004-measurement-boundary.md) (measurement),
  [ADR 0005](0005-shape-geometry-contract.md) (the geometry contract),
  [ADR 0006](0006-image-asset-contract.md) (assets),
  [ADR 0007](0007-persistent-document-format.md) (the format and its refusal policy)
- **Answers:** whether M8 needs a group model at all

## Context

M8 was titled "layers, groups, and multi-object editing". Two of those three turned out to be
mostly already built, and the third turned out to be the wrong next increment. Both findings
need writing down before any code, because the second one is a *negative* result and a
negative result that is not recorded gets re-litigated in two milestones.

The investigation questions were fixed in advance:

1. What does the flat `Page.objects: Node[]` actually mean?
2. Which operations are possible without a group?
3. What is the difference between multi-selection and grouping, in this codebase?
4. Is multi-object resize definable in the current transform model?
5. Is a group model supportable without a transform redesign?

## 1. What the flat array means

Six things were asked of one array. It carries four of them and deliberately does not carry
two. Stating which is which is what makes "just add a group node" answerable.

| Question | Answer | Where |
|---|---|---|
| **Paint order** | Yes, and it is the *only* order. Index 0 paints first (furthest back); the last index paints last. | `render/layers/page.ts`; `hitTestPage` iterates `length - 1 → 0` so the topmost hit wins |
| **Selection order** | **No.** `SelectionState.ids` is a `Set`, and the "object the inspector edits" is `selection.primary`. Selection order is already decoupled from array order. | `editor/selection.ts` |
| **Object identity** | Yes. `node.id`, unique across the whole document, checked by `validateDocument` and reserved on load. | ADR 0007 §3 |
| **Transform coordinate space** | Yes. Page-local document px, `x/y` = border-box top-left, rotation and scale about the box centre. `worldMatrix` is documented as mapping into "the node's *parent's* coordinate space" — the wording anticipated nesting, but the parent is always the page today. | ADR 0005; `model/transform.ts` |
| **Page ownership** | Yes, by containment. `pageIdOfNode` walks `pages` to find it. There is no `pageId` field on a node. | `editor/selection.ts` |
| **Persistence order** | Yes — the same array, verbatim. `deserialize` maps `objects` in order and `serialize` emits them in order, so **paint order is the persisted order** and there is nowhere for a second order to live. | ADR 0007 §2 |

So: one array, one order, four meanings, no duplication. A `zIndex` field would have been
the desynchronisable fifth, and was rejected in M0 for exactly that reason.

## 2. Multi-selection is already complete

Measured against the milestone's own list, before writing anything:

| Required | State | Evidence |
|---|---|---|
| Selecting multiple objects | **Exists** | marquee; `applyMarquee` |
| Additive selection | **Exists** | shift-click adds (`beginBodyGrab`) |
| Removing one from the selection | **Exists** | shift-click on a selected object sets `pendingDeselect`; applied at pointer-up **only if nothing moved** |
| Select all | **Exists** | `Editor.selectAll` |
| Deleting multiple | **Exists**, one entry | `remove` takes `ids`; `Delete 5 objects` label |
| Moving multiple | **Exists**, one entry | `startMove` captures every selected transform, `applyMove` dispatches one batched `setTransform` per node under one transaction |
| Undo/redo of multi-object ops | **Exists** | transaction + `mergeKey` coalescing |
| Mixed inspector values | **Exists** | `commonTransform`, `commonPath`, `commonTextStyle`, `commonAlign`, `propsWithPath`; a `Mixed` placeholder and `data-state="mixed"` |

The deferred-removal rule deserves a note, because it is the kind of thing that looks like a
missing feature and is actually a solved ambiguity. Shift on an **already selected** object is
either "remove it" or "move everything", and the two are indistinguishable until the pointer
moves. So the removal is deferred to pointer-up and applied only when the press was a click.
That is the behaviour users describe as correct even when they cannot say why.

**Conclusion: M8 does not need to build multi-selection.** Building it again would have been
the milestone's main risk, and the only honest response to "the milestone is named after
something that already exists" is to say so and find the real gaps.

## 3. Multi-selection is not grouping

The distinction is not philosophical; it is the difference between editor state and document
state, which this codebase already draws a hard line through (§4.5, ADR 0002).

**Multi-selection** is several *independent* objects that happen to be acted on together.

- It lives in `Editor.selection`, never in `Document`.
- It is not serialized, and cannot be: there is nothing in the format for it, and adding one
  would violate ADR 0007 §2's list of things that are not in a file.
- It has no identity: deselecting and re-selecting the same five objects is a different
  selection with the same content.
- Its bounds are a *presentation* concern. M2 settled that the overlay draws **one outline per
  object**; there is no aggregate selection rectangle, and §8 below says why adding one would
  be a regression in honesty rather than a gain.
- Ungrouping is free: it is clearing the selection.

**Grouping** is several objects becoming *one authored object*.

- It lives in `Document`, with a stable `id`, and it is serialized.
- It has identity across sessions.
- It has a transform, and a transform means a *coordinate space* for its children.
- Its bounds are authored geometry, not a presentation.

So "a selection with one bounding box" is not a group — it is a selection with a bounding box,
and the bounding box is the whole of the difference. The milestone brief's warning is taken
literally: **do not implement grouping that way.**

## 4. Multi-object resize: not definable, and provably so

The brief asked whether the existing transform model has enough information, and said not to
invent a transform system to make a handle work. It does not, and the reason is a property of
the algebra rather than a missing feature.

`localMatrix` composes **rotation then scale** and nothing else:

```
L = rotation(θ) · scaling(sx, sy)  =  [ cosθ·sx   −sinθ·sy ]
                                     [ sinθ·sx    cosθ·sy ]
```

Every object on the page has a linear part of exactly this form. Now scale one *rotated*
object by `(a, b)` in the page frame — which is what dragging a group bounding box's corner
would do:

```
L' = scaling(a, b) · L  =  [ a·cosθ·sx   −a·sinθ·sy ]
                           [ b·sinθ·sx    b·cosθ·sy ]
```

Its columns are `sx · (a·cosθ, b·sinθ)` and `sy · (−a·sinθ, b·cosθ)`, whose dot product is

```
sx · sy · sinθ · cosθ · (b² − a²)
```

For `L'` to be some `rotation(θ') · scaling(sx', sy')` its columns must be perpendicular. So:

> A **non-uniform** resize (`a ≠ b`) of a member is representable **exactly when the member is
> at a multiple of 90°** — where the page-frame axes coincide with its own, possibly swapped.
> At every other rotation the result is a shear.

*Correction to a first draft of this section, kept because the wrong version was the more
tempting one:* the obstruction was originally stated as depending on the member's own
`scaleX`/`scaleY`, or as "any rotated member". Neither is right. The member's scale only
multiplies the dot product; and quarter turns are exempt, because there a non-uniform
page-frame scale is simply a different `scaleX`/`scaleY`. Saying "any rotated object" would
have overstated the limitation, and understating it in the other direction would have quietly
promised a gesture that cannot work. `src/model/group-resize-limit.test.ts` pins the real
boundary, including a one-degree step either side of 90°.

`Transform2D` has no shear field, the projection emits one `matrix()` from `localMatrix`, and
ADR 0005's contract is stated per object as translate · rotate · scale. Adding shear would
mean a new transform parameter, a new invariant in `validateDocument`, a new ADR amending
0005, and a re-derivation of the geometry contract — to make one handle work.

**A uniform group scale is representable** — multiply every member's `scaleX/scaleY` and size.
But that is a different gesture with different semantics (what is the pivot? the union's
centre? each member's own centre?), it is not what a corner handle means, and it is not
needed. Deferred.

**Decision: multi-object resize is deferred. Single-object resize is unchanged** — it already
refuses to grab more than the pressed object, with a comment saying why, and that comment is
still correct: *a handle belongs to one box, and resizing all of them from one box's corner is
not what the user grabbed.*

## 5. Groups: two coordinate models, and only one fits

The brief asked which of three things to choose. Both were worked through.

### (A) Children stay in page coordinates; the group's transform is *derived*

`GroupNode` holds children whose `Transform2D` are page-local, exactly as they are now. The
group's own transform is computed from the children's painted union.

- It **cannot be authored**, so `setTransform` cannot write it and it must not be persisted —
  persisted derived state is state that can disagree with its source.
- **Moving the group is exactly the multi-select move that already exists.** No new geometry.
- **Rotating the group** is rotating each child about the derived union centre: expressible,
  but it is the multi-select rotate that already exists, with a centre computed instead of
  grabbed.
- **Resizing the group** is the shear problem from §4.
- The group's selection bounds would be a *derived* aggregate, and for rotated children the
  union of `x/y/width/height` is not the painted bounds — so either the overlay grows an
  aggregate frame that is not the geometry (M2's decision, reversed, for a shape the model
  cannot back), or it keeps drawing per-child outlines, which is what it does now.
- **The hierarchy is a tree**, because children live *inside* the group node. A cycle is
  structurally impossible, so "reject cycles" costs nothing.

Net: (A) buys **durable group identity** and nothing geometric.

### (B) Children become group-local; the group transform is authored

This is a second coordinate space, and it is the one every consumer of the transform has to
learn about:

- `Node` gains a variant, so every traversal becomes recursive: `mapNodesById`,
  `selectedNodes`, `findNode`, `pageIdOfNode`, `validateDocument`, `hitNode`, `hitTestPage`,
  `collectIds`, `documentsEqual`, `serialize`, `deserialize`, the reconciler's child
  projection, the overlay's page lookup, and the inspector's path walk.
- `hitNode` must compose the group matrix with the child matrix. Mechanical, but it changes
  the *authority* claim ADR 0004 rests on: today the editor inverts exactly one matrix per
  node, and that is the whole of "the editor, not the browser, decides what was clicked".
- **The text fence is the hard one.** A `contenteditable` inside a transformed ancestor means
  the caret lives in a space the model does not have. M3 already established that any DOM
  mutation *outside* the editable destroys the browser's undo grouping, so a group must be
  projected as an ancestor element with a `matrix()` — which is fine — but then a frame's
  measured text is no longer a page-space value without composing, and ADR 0004's
  measurement boundary was written for a single space.
- It is a **`formatVersion` bump**, so by ADR 0007 §4 every older build refuses the file.
  Correct behaviour, but a real cost for a feature whose geometry is still undefined.
- `setTransform` on a group and on a leaf would be two different commands with the same name,
  or one command with a branch — either way the funnel grows a "did you mean to move the
  children?" question.

### Decision

> **Grouping is not implemented in M8.**

(A) is the only model the current architecture supports, and (A) is not worth having yet,
because **multi-selection already provides every interaction (A) would offer.** What remains
is durable group identity — a real and worthwhile feature, and a *model* feature rather than
an interaction one.

Shipping a group now would mean one of two bad outcomes: a group whose transform is derived
and therefore unauthorable (an affordance pretending to be a model, which is precisely what
the brief forbids), or a nested coordinate space adopted before the text fence and
measurement boundary have been proven against it.

### Preconditions for the milestone that does it

Stated so the next milestone starts from facts rather than from this document's conclusion:

1. **Choose (A) or (B) explicitly.** Recommendation: **(A)**, children in page coordinates.
   It is a tree, so cycles are impossible; it needs no new coordinate space; and it is
   additive to the format.
2. **With (A), the group's transform is derived and must not be persisted or authored.** A
   `setGroupTransform` that fans out to children is the same code path as the existing
   multi-select move — which suggests the honest first cut of grouping is *"remember these
   five objects as one thing"* and nothing else.
3. **The overlay question must be answered before any group frame is drawn.** Per-child
   outlines, or an aggregate frame that is explicitly *not* the painted bounds? This ADR's
   answer is per-child, and an aggregate group frame is a separate decision with a separate
   ADR.
4. **With (B), a `composedMatrix(node, ancestors)` in `model/transform.ts` must come first**,
   every consumer must be switched to it, and a measurement probe must show a text frame's
   reported content size still matches what the browser laid out inside a rotated ancestor.
   That probe is the gate, not a detail.
5. **A `formatVersion` bump, with a `group` node type in the schema.** The refusal policy is
   already written: an older build refuses the file, and an unknown `type` is refused rather
   than rendered as nothing. Nothing new is needed there, and that is a point in favour of
   doing it properly rather than early.

## 6. Layer order

`reorder` already exists as a command, with a subtlety worth preserving: `toIndex` is measured
in the array **after** the node is removed, so a same-position move is `to === from - 1`, not
`to === from`. It is unit-tested.

It is also **unreachable from the user**, which is the actual gap. Four operations are needed,
and the decision is *not* to extend `reorder`:

> **`restack` — a relative command, in the model, in one piece.**

```ts
{ type: 'restack'; pageId: string; ids: readonly string[]; direction: 'forward' | 'backward' | 'front' | 'back' }
```

Reasons, in order of weight:

1. **Index arithmetic does not belong in the UI.** "Bring forward" means *one position*, which
   under `reorder`'s after-removal indexing is a different number per object, and the
   collision-avoidance order matters. A UI that computes target indices is a UI holding a
   model rule.
2. **Relative intent survives the array changing underneath it.** `toIndex` is stale the
   moment anything is inserted. "Forward" is not.
3. **One command for N objects.** `ids` is a list, like `remove` and `setTransform`. The
   alternative — a `batch` of `reorder`s built in the UI — is one history entry by accident,
   and the label would read "4 changes".

Semantics, stated so they cannot be re-derived differently:

- Selected ids are taken **in current array order**, and their relative order is preserved.
  Paint order is meaningful, so a group's internal order is never scrambled.
- `forward`: each id moves up one position, processed **front to back** so no two swap.
  `backward`: each moves down one, processed **back to front**.
- `front` / `back`: remove all, then re-insert in the original relative order.
- **No-op** when no id actually moves — the topmost object brought forward, the bottommost
  sent backward, and any `restack` whose ids are absent from the page. `isNoop` handles it by
  reference identity, so the rule is just "return the same page".
- Label: `Bring forward` / `Send backward` / `Bring to front` / `Send to back`, with a count
  for several objects, matching `Delete 5 objects`.

Multi-page selections restack per page, batched — one history entry, because `batch` is one
entry and the labels collapse.

## 7. Selection bounds for several objects

The brief asks what the selection bounds mean, and warns against assuming the union of
`x/y/width/height` is the visible bounds. Both are already settled and the answer is the
reason not to change it:

> **The overlay draws one outline per selected object, and there is no aggregate rectangle.**

For a rotated object, `x/y/width/height` is the *unrotated* box. Its painted extent is the
rotated rectangle, whose axis-aligned bounds are larger — for a 30°-rotated 200×50 box, the
painted height is 143.3, not 50. An aggregate frame around several rotated objects would
therefore be a rectangle that matches nothing the user can see or click, and handles on it
would invite the shear resize §4 ruled out.

Per-object outlines are also the only option that keeps M2's screen-space property: each
outline is that object's own box, drawn in screen space, and a zoom change re-projects all of
them by the same factor.

The cost is honest and worth stating: with five rotated objects selected, there is no single
thing on screen that says "these five, as a set". That is a real gap in *feedback*, and the
right fix is a selection *badge* or a count, not a geometry frame that lies.

## 8. Mixed properties in the inspector

The rule M6 and M7 already established, restated as it applies here:

- A field shows a value only when **every** selected object has it. Otherwise it shows
  `Mixed` and `data-state="mixed"` on the section.
- One committed field is **one command** for the whole selection. `setProps` already takes
  `ids`.
- **Absent is not the default.** `propsWithPath` seeds each node's payload from **that
  node's own** value, and only falls back to `containerDefault` when the node has no such
  container. So editing `fill.color` on a selection of one coloured and one uncoloured rect
  *authors* a fill on both — which is what the user asked for — while re-committing a field
  nobody touched writes nothing at all, and a node that never authored a corner radius does
  not acquire one.
- A container the model cannot express yields `{}`, which `isNoop` drops: "nothing happened"
  rather than a half-applied edit.

The one real gap this milestone closes is that `visible`, `locked`, `opacity` and `blendMode`
are **not editable at all** — for any object type. That is a recorded limitation ("a text
frame's opacity is unreachable"), and the fix is the one already named: put them in the
**Transform** section, which is the only section shown for every node type and therefore the
only one that has an answer for a selection of mixed types. They are `BaseNode` fields, not
shape fields, so the Appearance section is the wrong home by construction.

## 9. What is not built

Snapping, guides, grids, alignment and distribution, group resize, nested groups, boolean
operations, clipping groups, masks, a layer panel, collaboration — and, per §5, **grouping**.

## 10. Verification

| Claim | Where |
|---|---|
| `restack` moves one position, front to back, without swapping | `src/model/commands.test.ts` |
| `restack` to front/back preserves relative order | same |
| `restack` is a no-op at the ends, and with unknown ids | same |
| `restack` is one history entry for N objects | same, `tests/editor/history.spec.ts` |
| The four operations are reachable and undoable from the UI | `tests/editor/layers.spec.ts` |
| **Layer order is observable as DOM order within the page** | same |
| A restacked document round-trips through save/load byte-identically | same |
| A non-uniform group resize needs a matrix that is not `R · S` | `src/model/group-resize-limit.test.ts` |
| Mixed inspector values show `Mixed` and never an arbitrary member's value | `tests/editor/inspector-mixed.spec.ts` |
| One inspector commit is one command for the whole selection | same |
| A commit writes no property onto a node that did not author it | same |
| `visible`/`locked`/`opacity`/`blendMode` are editable for every node type, mixed-aware | same |
| Multi-select move/delete/undo still behave | existing `selection.spec.ts`, `history.spec.ts` |

If any row above stops matching, this ADR is wrong.

If any row above stops matching, this ADR is wrong.

---

# Part II — As built

Everything above was written before the code. This part records where the implementation
disagreed, what was found that the investigation did not predict, and the two rules that exist
only because a test failed in a way nobody expected.

The verification table above is also corrected here: three of its rows named files that did not
end up owning those claims, and one named a test that passed for the wrong reason.

## 11. Corrections to the sections above

### 11.1 §4 — the shear condition was wrong twice

The first draft said the obstruction depended on the member's own `scaleX`/`scaleY`, then that
it applied to "any rotated object". Both are wrong. The required linear part is
`diag(a, b) · R(t) · diag(sx, sy)`, whose columns have dot product
`sx · sy · sin(t) · cos(t) · (b² − a²)`. A **non-uniform** resize is therefore representable
exactly when `t` is a multiple of 90° — where the page-frame axes coincide with the object's
own, possibly swapped — and is a shear at every other angle. The member's existing scale only
multiplies the dot product.

`src/model/group-resize-limit.test.ts` pins the real boundary, including a boundary assertion
one degree either side of a quarter turn, because "quarter turns are the exception" is an easy
thing to assume and a wrong thing to leave implicit.

### 11.2 §6 — front-to-back ordering is necessary but not sufficient

The rule as first written — process `forward` front to back so no two selected objects swap —
is correct for two *adjacent* selected objects and wrong for the general case.

Found by `tests/editor/layers.spec.ts`, not by reasoning. Stack `[A, B, G, D]` with `A`, `G` and
`D` selected, brought forward:

```
D is frontmost, so it cannot move.
G's target slot is D's, and G moves into it.
```

`D` is skipped because it is at the end, but nothing stops `G` stepping into the slot `D` is
still occupying — and the result is `[B, A, D, G]`, with two objects the user had selected
together now in the opposite order. That is the exact scrambling the whole feature promises
never to do, produced by an implementation that had the iteration order right.

The added rule:

> **An object does not move into a slot held by another selected object.** `forward` skips an
> object whose neighbour in front is also selected; `backward` skips one whose neighbour behind
> is.

Same case: only `A` has an unselected neighbour in front of it, so only `A` moves, and the
result is `[B, A, G, D]`. Two consequences worth stating rather than leaving to be found:

- The selected set's relative order is preserved unconditionally, which is the property the
  feature is built on.
- **With every object selected, all four operations are no-ops.** There is no unselected
  neighbour to trade with. That is correct — the whole stack is already as forward as it goes —
  and it is now a test, because an implementation that ignored the blocked move would produce a
  new array, which `documentsEqual` would call unchanged, so the order on screen would look
  right while the saved file differed.

The no-op rule also needed `front`/`back` to be fixed. They returned a fresh array
unconditionally, so "bring the whole stack to the front" produced a new document and an undo
step that did nothing — invisible to any assertion about paint order, because the order really
was unchanged.

### 11.3 §7 — unchanged, and the cost is real

No aggregate selection frame was added, for the reasons given. The cost — nothing on screen
says "these five, as a set" — is real and unaddressed. The status bar already reports the
selection count, which is most of the feedback, and adding a *geometry* frame would be the
honest-looking wrong answer.

### 11.4 §8 — the shared object fields, as built

`visible`, `locked`, `opacity` and `blendMode` are in the Transform section, for the reason
given. Two are switches and two are values, so they are not four more text fields: a boolean
that is not unanimous is rendered **indeterminate**, which is the only honest display for a
disagreement, and setting it applies to every selected object. Opacity is bounded to `0..1`
because that is the model's range — a value outside it is a typo, and clamping it would write
something the user did not ask for. An unrecognised blend mode is refused the same way rather
than written as a string the renderer would ignore.

That exposed a pre-existing gap: `describeCommand` labelled **every** `setProps` command
`Change`, so every appearance-field commit already read "Undo Change" in the history menu. A
single top-level key now names the command (`Opacity`, `Fill`, `Stroke`), with a count for
several objects. More than one key falls back to `Change` rather than guessing which part
mattered.

## 12. Two rules that exist because a test failed

Neither is in the sections above, because neither was predictable from the design.

### 12.1 The editor must claim the pointer, and must survive losing it

**The bug.** A `pointerdown` that the editor treats as a gesture could *also* start a native
text selection. Chromium answers that with `pointercancel`, and a cancelled pointer then
delivers **no further `pointermove` and no `pointerup` at all**.

The consequence for the user: shift-click to add a second object to the selection, then drag —
and the objects move exactly one increment (one-eighth of an eight-step drag, 7.5px of an
intended 60px), the gesture never ends, and the editor keeps the pointer capture. The editor is
stuck until Escape.

**Why nothing caught it.** The pre-existing multi-object drag test asserted only that the
inspector's `x` went mixed — which one increment satisfies, since 7.5px is not 0. It also
happened to be the *only* assertion, and it was true. The bug was found because the M8 test for
the same behaviour asserts the **full delta**.

**The fix, in two parts.**

1. `preventDefault()` on the `pointerdown` that starts a gesture, so the browser does not begin
   a selection. Skipped inside a frame being edited, where the browser's default is exactly what
   puts the caret where the user clicked — so the check is `closest('[data-editing]')`, not a
   guess about which object types need care.
2. A `pointercancel` listener that releases the capture and calls `Editor.cancelGesture()`.

The second part is defence in depth and **is not covered by a test**, because with the cause
removed no cancel occurs. That is stated in `scripts/mutation-check.ps1` next to the `preventDefault`
mutation rather than papered over with a mutation that would only prove the mutation works.

`cancelGesture` already existed for Escape. It gained an idle guard, which is what makes the new
caller safe: a stray cancel with nothing in flight must do nothing at all, because
`abortTransaction` would otherwise reach for whatever transaction happened to be open — which,
during a text session, is not its business.

The general rule, now written down because it is easy to get wrong again:

> **An editor that captures the pointer must handle `pointercancel`.** It is not a rare
> formality. A cancelled pointer delivers nothing further, so a gesture left open hangs the
> editor with no event coming that could ever end it.

### 12.2 Hiding an object must not make it unreachable

`visible: false` objects were skipped by hit testing *and* by the marquee, so they could not be
selected by any means. That was latent: the only way to reach the state was to open a document
that already had a hidden object. M8 added a `visible` checkbox, which makes the state one click
away — and an object that cannot be selected cannot be un-hidden, so the field would have been a
one-way door.

A marquee now takes hidden objects. The asymmetry is deliberate and is the rule:

> A **click** is a point gesture and legitimately skips what is not painted there. A **marquee**
> is a region gesture, and "I drew a box around it" is unambiguous — and it is the only way back.

`locked` stays excluded from both, because Alt-click already reaches a locked object: locking is
a *barrier*, not a hiding place, and the two properties now mean different things.

## 13. Smaller amendments

### 13.1 The overlay's per-object marker is `data-for`, not `data-oid`

The renderer writes `data-oid` on each object element. The overlay wrote the *same* attribute on
its outline group, so `[data-oid="x"]` matched two elements in two different layers and
Playwright reported a strict-mode violation on a locator that had looked reasonable.

The overlay's marker is `data-for` now. This is the same principle as M0's rejection of a
`zIndex` field — an identifier duplicated across two places is a second source that can
disagree — applied to the DOM rather than the model. Four call sites in three files read it
directly, so `firstSelectionId` and `selectionIds` in `tests/editor/helpers.ts` now own the
attribute name, and one test asserts the count directly so a future collision is one named
failure rather than a dozen unrelated ones.

### 13.2 `alt` means "include locked", not "drill through"

This milestone's first draft assumed Alt-click cycles to the object underneath an overlap. It
does not: `pointerDown` passes `altKey` to hit testing as `includeLocked`. The existing semantic
is better, and it is the strongest available statement of "a click is not a marquee" — with the
front object locked, `document.elementFromPoint` returns it and the editor returns the one
underneath, because hit testing is a walk of the model. The test now asserts both.

`SelectionState.anchor` is documented as the anchor for "shift-extend and alt-cycle". There is no
alt-cycle. The comment is wrong and the field is currently only written by `selectionOf`.

### 13.3 `getPropertyValue` takes the CSS name

`el.style.getPropertyValue('mixBlendMode')` returns nothing; it wants `mix-blend-mode`. `opacity`
and `display` are single words, so both spellings work — which is exactly why it reads correctly,
passes for every other property, and silently fails for this one.

### 13.4 "Bounds" means the model frame, and that was true — ADR 0011b renamed it

`selectionRect` computed the union of `x/y/width/height` and this document called the result
"selection bounds". The name was wrong and the function was right: for a **single unrotated**
object they coincide, which is why nothing looked amiss.

[ADR 0011](0011-affine-transform-decision.md) §8 required the four quantities to be named
separately. [ADR 0011b](0011b-selection-frame-and-stroke.md) renamed the function to
**`modelFrameUnion`**, added `paintedBounds` and `transformedCorners` for the other two, and gave
the outline the object's own matrix so the *drawn* frame follows the shape.

This section's conclusion is unchanged and still deliberate: **there is no aggregate selection
frame.** A multi-selection still draws one outline per object. M11 kept that decision and recorded
why it now has a consequence — with no aggregate frame there is no single pivot, so the rotation grip
is offered for one object and withheld for several.

## 14. Verification, as built

| Claim | Where |
|---|---|
| `restack` moves one position without swapping adjacent selected objects | `src/model/restack.test.ts` |
| An object does not step over a selected neighbour that cannot move | same |
| With everything selected, all four directions are no-ops by reference | same |
| `restack` returns the *same array* when nothing moved | same, asserted by identity |
| `front`/`back` preserve relative order, and ignore the order the ids were given in | same |
| A restacked document is carried by the file, in the order the editor showed | `tests/persist/layer-order-roundtrip.test.ts` |
| A reorder changes the bytes and only the bytes' object order | same |
| The four operations are reachable, undoable and redoable from the chrome | `tests/editor/layers.spec.ts` |
| **Layer order is observable as DOM order within the page** | same |
| A multi-select drag applies the **whole** delta, after a shift-click | same — the `pointercancel` regression guard |
| A restack rewrites no node's geometry or paint | same |
| A locked object painted on top is skipped, and `elementFromPoint` disagrees | same |
| With everything selected, no layer operation records anything | same |
| A restacked document round-trips through save/load byte-identically | same |
| Mixed inspector values read `Mixed` and never a member's value | same |
| One commit across three objects is one undo entry | same |
| Re-committing the shown value records nothing | same |
| An unparseable or out-of-range value restores and writes nothing | same |
| A hidden object cannot be clicked but a marquee reaches it | same |
| A locked object is reachable with Alt but not with a marquee | same |
| Every object field is reachable for a text frame and an image | same |
| One `data-oid` per object, and the overlay marks with `data-for` | same |
| A non-uniform group resize needs a matrix outside the model | `src/model/group-resize-limit.test.ts` |
| The algebra boundary is at a quarter turn, not at "rotated" | same |
| Multi-select move/delete/undo still behave | `tests/editor/selection.spec.ts` (strengthened), `history.spec.ts` |

Twenty-six mutations, each asserted to turn a suite red. Six of them are M8's, and the note about
which M8 behaviour is *not* mutation-covered is in §12.1.

---

## 14. Corrections from M10 and M10b

Added 2026-10-06. Each of these corrects a statement *above*, and each is recorded here rather than
only in the later ADR, because this document is what a reader arrives at when they ask about grouping.

### 14.1 §5's stated blocker was wrong

§5 listed five preconditions for doing grouping properly. Two of them were:

> - the text fence and the measurement boundary have not been proven against a second coordinate
>   space

**Both hold.** M10 measured them against a transformed ancestor: layout APIs are unaffected
(`clientWidth` 300 unchanged at 1x, 1.6x and 0.4 rad, while `getBoundingClientRect().width` moved
300 -> 480 -> 338.6), and the text fence survives intact -- still `contenteditable`, one model commit
per session, canonical model text. A CSS transform changes *paint*; every API the measurement
boundary uses is a *layout* API. See ADR 0010 §4 and `tests/editor/transform-invariance.spec.ts`.

The fence and the measurement boundary were never the obstruction. **The transform model is.** This
does not make grouping possible; it replaces the stated reason with the real one.

### 14.2 §5(B)'s claim about DOM nesting was never made, and would have been wrong to make

Group-local children do **not** require a DOM hierarchy. M10 proved that a page-local group's children
render into the same flat container as everything else, and that a group-local child's measurement is
unaffected by its ancestor's transform. A hierarchical DOM would have been an unforced choice with
five separate consequences to discharge (paint order, pointer behaviour, text editing, image decoding,
reconciliation identity). It is not taken. See ADR 0010 §3.

### 14.3 The real blocker is representability, and it is now resolved by restriction

§5(B) said group-local children need "a second coordinate space" and left the cost open. The precise
obstruction is narrower: **a non-uniform group scale applied to a rotated child requires a shear**,
which `Transform2D` cannot hold. Uniform group scale composes exactly. ADR 0010 §2 proves it and
ADR 0011 §13 shows the composition `page → group → child → local` works for every other case.

So the blocker is **one capability**, not a coordinate space. ADR 0011 decides it by restriction:
group-local children are supported, group scaling is uniform-only.

### 14.4 §4's proof assumed a multi-selection can be rotated

§4's shear argument is unchanged and still correct -- it is restated with the shared predicate in
`src/core/geom/affine.test.ts` so the two documents cannot drift. But the *context* was wrong:

`Editor.startRotate` fans out over several nodes, and **no gesture can reach it.** The rotate handle
is emitted only for a single outline whose `rotation === 0`, so rotating is a one-way trip and there
is no multi-object rotation gesture at all. §4 treated multi-object rotation as available; it is an
editor capability with no user-facing entry point. See ADR 0010 §6 F3.

### 14.5 §7's "selection bounds" are frames, and the outline does not follow rotation

§7 discussed the bounds of several objects. The terminology was loose in a way that mattered:
`selectionRect` returns the **authored frame** (`x/y/width/height` off the transform), not bounds.
For a rotated object the two differ -- a 200×50 box at 30 degrees paints 143.3 high, not 50 -- and the
overlay draws the frame with **no transform at all**.

Measured: a rotated ellipse paints 171.2 × 156.6 at (975.4, 234.2) while its selection frame is
140 × 100 at (991, 262.5) with `transform: none`. The eight handles are placed on that frame, so they
point at the wrong place. This is a bug today, not an affine consequence, and it is the mechanical
reason for both the rotate-handle suppression and §4's deferral. See ADR 0011 §8 F6 and
`tests/editor/frame-vs-shape.spec.ts`.

### 14.6 The absence of scale writers is load-bearing for the no-shear invariant

`scaleX`/`scaleY` have no writer: no gesture, no inspector field, no command. Every live object's
matrix is therefore `R(t)·S(1,1)`, and the no-shear property holds because **nothing scales** rather
than because anything prevents it. `src/editor/transform.ts` exports `scaleTransforms` "for scale
gestures"; nothing outside its own tests calls it, and given a rotated member it grows the box and
leaves `rotation` alone -- neither a page-frame scale nor the bounding box of one. It must not be
treated as evidence that scaling semantics exist. See ADR 0010 §6 F1/F2 and ADR 0011 §1 row 9.