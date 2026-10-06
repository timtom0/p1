# ADR 0012 — The persistent group model

- **Status:** accepted
- **Date:** 2026-10-06
- **Depends on:** `docs/ARCHITECTURE.md` §1.3, §1.3.1, §1.6, §6;
  [ADR 0007](0007-persistent-document-format.md), [ADR 0008](0008-multi-selection-and-grouping.md),
  [ADR 0010](0010-groups-and-the-transform-question.md),
  [ADR 0011](0011-affine-transform-decision.md), [ADR 0011b](0011b-selection-frame-and-stroke.md)
- **Delivers:** the group node, group-local coordinate semantics, uniform-only group scaling,
  nesting, paint order, persistence at `formatVersion: 2`, and the recursive traversal every
  consumer reads
- **Explicitly not in scope:** any grouping interaction, gesture, or UI

## Context

M10b decided *whether* groups need an affine transform and concluded they do not.
[ADR 0011b](0011b-selection-frame-and-stroke.md) then made the geometry a group will rely on
explicit. What was missing is the thing a group **is**: a document object that can be saved, loaded,
compared, rendered, and transformed correctly, before anyone can create one.

**Summary: a group is a transform and an ordered list of children, in group-local coordinates, and
the composed linear part of any chain of them is *exactly* `R(t)·S(sx, sy)` — so the renderer needs
no new projection, the parser needs one key, and the only new mathematics is that uniform scales
commute with rotations. The one real restriction is sharper than "groups scale uniformly": a
non-uniform scale may not be followed by a rotation.**

This ADR does not repeat M10b's affine analysis. Where it needs a result, it cites it.

## 1. The group node

```ts
interface GroupNode extends BaseNode {
  type: 'group';
  children: Node[];
}
```

Four decisions, each with a reason.

### 1.1 Children by value, never by id

An id-reference model would need a separate uniqueness rule to achieve what a value tree gets for
free: a node lives in exactly one array, so it has exactly one parent, and it cannot be in two
groups because it would have to be in two arrays.

### 1.2 `children` is **paint order**, and is never sorted

`[B, C]` and `[C, B]` are different documents. `documentsEqual` compares children **by position**,
and `canonicalNode` writes `children: node.children.map(canonicalNode)` — `.map`, never `.sort`. A
mutation that sorts them is in the suite, precisely because a "tidy up" there would be silent data
loss rather than a style change.

### 1.3 `transform` is an ordinary `Transform2D`

No new transform type. A group's transform maps group-local coordinates into its parent (page)
space, exactly as for every other node, and rotation is about the centre of the frame.

### 1.4 `width`/`height` are authored, and are **not** fitted to the children

A group's extent is the size of its local coordinate space and the frame its rotation happens about.
Deriving it from children would make the parent a function of its members, which puts layout in the
authored document, changes what `Transform2D` means (§1.3), and is circular the moment a child is
itself a group.

**Consequence, stated:** a group may be larger or smaller than its members, and nothing in
`validateDocument` objects. Fitting a group's frame is a *tool*, not a property.

## 2. Coordinate semantics

A child of a group is positioned in **group-local** coordinates:

```
page  ->  group transform  ->  child transform  ->  child geometry
W(child) = W(ancestors) · W(group) · W(child)
```

`worldMatrix(transform)` is unchanged — a node's map into *its parent's* space, which is what it has
always been ([ADR 0011](0011-affine-transform-decision.md) §3). The composition step is new and is
`multiply`, the existing utility.

### The theorem that makes this cheap

A **uniform** scale commutes with every rotation, so

```
R(t1)·S(a1,b1) · R(t2)·S(a2,b2)  =  R(t1+t2) · S(a1·a2, b1·b2)
```

The composed linear part is therefore always `R(t)·S(sx, sy)`: **exactly** expressible as a
`Transform2D`, with no decomposition, no `atan2`, no sign convention, and no question about what a
reflection means. `worldTransformIn` is that algebra, and `width`/`height` pass through — the
composed frame is still the child's own box, just positioned in a further-away space.

### 2.1 The restriction, stated sharply

The closed form needs the **left** factor's scale to be uniform, which amounts to:

> **A non-uniform scale may not be followed by a rotation.**

| | scale | followed by a rotation? | expressible as `R(t)·S(sx,sy)`? |
|---|---|---|---|
| a **group** | must be uniform, by invariant | yes — its children carry their own `R` | **no**, unless `scaleX === scaleY` |
| a **leaf** | may be non-uniform | no — nothing is inside it | **yes**, it is already that form |

This is the same refusal as ADR 0011 §2, in a form that survives into the code. It is enforced by
`UNIFORM_SCALE_EPSILON` in `validateDocument`, whose message names the consequence (a shear) rather
than restating the rule, and `src/model/group-scale.test.ts` pins both the composed result and the
refusal.

**Why `scaleX` and `scaleY` were not replaced by one field:** `Transform2D` expresses scale as two
independent numbers. A group reuses it and constrains the two to agree, rather than adding a second
place for the same number. One representation, with the constraint in the invariant.

**The bug this theorem prevented.** The first `worldTransformIn` *forced* the composed scale
uniform — on the reasoning that every scale in the chain was uniform. That silently discarded the
`scaleY: 0.5` of every scaled leaf, and was caught by `tests/visual/geometry.spec.ts`'s "non-uniform
scale is applied about the centre" measuring a painted height of **200** where **50** was authored.
A model-level test would have called the result correct. `src/model/group-scale.test.ts` now has a
control that only exercises the *legal* non-uniform leaf case, because a file testing only the group
case cannot distinguish a correct refusal from an over-broad one.

## 3. Nesting: allowed, to arbitrary depth

The recursion in `tree.ts` is the same at every level — no "top-level" branch, no "child" branch —
which is the whole argument: a model needing a special case at depth two needs another at depth three.
ADR 0010 §2 chose group-local over page-local children *because* the coordinate model is already
recursive, and declining to use that would waste the reason for the choice.

**Depth is bounded at 64** (`MAX_GROUP_DEPTH`) for *reachability*, not expressiveness. Every depth a
person could author is expressible. The bound exists so a cyclic object graph — constructible in
JavaScript, impossible in JSON — fails with a document error rather than exhausting the stack.

**Cycles need no separate rule.** A cycle in a value tree necessarily revisits a node, so its id is
already in `seen`, so the existing duplicate-id check catches it *and* terminates. `validateDocument`
reports `duplicate or cyclic node id` and names both words because the cause is not recoverable from
the value alone.

`placementsInDocument` is **not** guarded: a cyclic model overflows the stack there. That is recorded
rather than hidden (`tree.test.ts` asserts the `RangeError`), because it is a decision — a depth
guard on a per-render path costs something measurable to protect against a state the model forbids —
and because two enforcement points (`deserialize`'s post-parse validation, and the dev overlay) stand
between any source of such a model and the traversal.

## 4. Ownership invariant

| rule | enforced by |
|---|---|
| a node has exactly one parent | being in exactly one array |
| no node in two groups | same |
| no node in a page *and* a group | same |
| no cycles | the duplicate-id check (§3) |
| ids globally unique across the document | `collectIds` + `assertDocumentIsConsistent` |

**There is no second identity namespace.** A group's id is an ordinary `NodeId` from the same table
as a shape's, generated by the same `createId('group')`. A group-specific namespace would need its
own uniqueness argument and would break every `mapNodesById` call for no gain.

**Ids are globally unique**, and `collectIds` recurses. A group child whose id went unreserved could
be handed out again by the generator, producing a document with two nodes claiming one id — the exact
failure `assertDocumentIsConsistent` prevents on load, reintroduced by the writer.

`locateNode` answers "which array owns this node", and `NodeLocation.owner` is deliberately
`Page | GroupNode`: a structural command needs to know whether it writes `page.objects` or
`group.children`.

## 5. Paint order: a group flattens into its parent's slot

For a page holding `A`, `Group G [B, C]`, `D`, the paint order is **`A, B, C, D`**. A group occupies
exactly one slot in its parent's array and paints its children at that slot, in array order.

This is depth-first flattening, and it is what keeps the rest of the system unchanged: **the paint
stack is still a flat list.** The reconciler, tree-order-is-z-order, `restack`'s relative rules and
every existing DOM contract are untouched. Only the *matrix* is recursive.

**A group is a coordinate frame, not a rendering box.** So no DOM nesting: there is no container
element, no stacking context, and no `data-oid` on a group. `document-view.ts` asserts that no group
reaches the reconciler, and the object-type registry has no group entry.

The alternative — a nested DOM subtree per group — would make each group a stacking context and put
a group's `opacity`/`blendMode` in charge of its children in a way that is hard to undo.

## 6. Persistence

### 6.1 The schema

A group is a new **variant** of the existing `Node` union: no field added to any other node, none
removed, none changed meaning, and `{ formatVersion, pages[].objects }` is untouched. So the schema
*can* represent a recursive node without changing — a discriminated union is exactly the construct
that admits a new member without disturbing its siblings.

### 6.2 `formatVersion` is **2**, and version 1 is still read

[ADR 0007](0007-persistent-document-format.md)'s rule says bump when a new node type appears, so that
an older build refuses the file deliberately rather than incidentally. The rule was **followed
rather than re-argued**. A version-1 build would in fact refuse a group document — `expectOnlyKeys`
rejects `type: 'group'` at a named path — but only because the node type happens to be unknown to it,
which is a refusal resting on a *different* rule continuing to hold.

`MINIMUM_FORMAT_VERSION = 1`, so both are accepted. **This is not a migration.** A version-1 document
is a strict *subset* of version 2: the same document with no `children` array anywhere, because
version 1 had no `group` type. Nothing is converted, defaulted, or at risk. Opening a version-1 file
and saving it stamps `2`, which is a re-stamp and the whole of the difference — which is why the
golden fixtures were **re-stamped**, not regenerated.

Both version error messages are unchanged and stay two-sided: above `CURRENT` is *newer* (update
P1), below `MINIMUM` is *older* (no migration exists).

### 6.3 Validation

`children` is **required**, never optional: "absent means no children" would give one meaning two
spellings, which is what ADR 0007 exists to remove. An empty group is written `children: []`.

Two rules are *not* key-list questions and live where they can be seen:

| rule | where |
|---|---|
| a non-uniform group scale | `validateDocument`, run from `assertDocumentIsConsistent` |
| a duplicate id, or a cycle | `collectIds`, then `assertDocumentIsConsistent` |

So `parse` returns a document that satisfies the model's invariants, with the violation as a
`DocumentParseError` at a full path
(`pages[0].objects[0].children[1].transform`). Without that pass, `parse` would happily return a
group whose scale is `(2, 1)` — a shear, on a rotated child — and the first symptom would be an
object painted at an angle nobody asked for.

**Repair remains absent.** One bad child refuses the whole document.

### 6.4 Equality

`nodesEqual` gained a `group` branch that is **structural then by position**. Not by id: matching by
id would make `[B, C]` and `[C, B]` compare equal, which is the most expensive mistake available — a
visible reorder would not dirty the document, and Save would be disabled.

### 6.5 A latent bug this milestone exposed

`document-equality.ts`'s `pagesEqual` began with `if (a.objects === b.objects) return true`. That was
sound while a page's array was the only thing that could change. With a group it stops being sound: a
child's field change rebuilds the group's `children` array and the enclosing group while
`page.objects` **keeps its identity**. The function that decides whether the document is dirty would
have reported two differing pages as equal, and every command would have looked like a no-op.

The fix keeps the fast path but requires it to hold for the whole subtree.

`commands.ts`'s `pagePropsEqual` has the same shape and **stays reference-only** — its sole caller is
`setPageProps`, which spreads `{ ...page, name }` and cannot have changed a node. Two functions, one
shape, opposite soundness; the difference is the caller, so it is recorded at both.

## 7. The one traversal

`src/model/tree.ts` is the only module that knows how the hierarchy composes. Consumers receive
`NodePlacement { node, world, transform, depth, ancestors }` and do not walk ancestors themselves.

**Two spellings, both given, because different consumers need different ones:**

| need | use |
|---|---|
| `left`/`top`/`width`/`height`/`matrix(...)` — the renderer, the selection frame | `transform` |
| `invert(world)` for hit testing, or any arithmetic | `world` |

`tree.test.ts` asserts `worldMatrix(placement.transform) === placement.world` for flat documents, one
group, and three levels. That cross-check is the point: each side's own test would pass while the two
disagreed — which is exactly the M11 lesson applied one level up.

### 7.1 The renderer receives a *projected node*, not a placement

Every renderer takes a `Node` and reads `node.transform`. That is a good contract — a renderer should
not know what a group is — so `document-view.ts` resolves the recursion *before* the renderer sees
anything, substituting `placement.transform` for the node's own. Identity passes through by
reference, so `data-oid` is still the authored id.

### 7.2 Two functions, not one, for "the node with this id"

| function | finds | why |
|---|---|---|
| `nodeById` | leaves **and** groups | "the node with this id" — a group is a node |
| `placementOf` | leaves only | "where does this paint" — a group has no paint of its own |

Asking `placementOf` for a group returns `null`, which reads as "no such node" and is wrong. Two
`tree.test.ts` cases failed on exactly that before the two were separated.

## 8. Hit testing, and what "not interaction" means

`hitTestPage` walks `placementsOnPage` backwards — the same loop as before, over a longer list — and
inverts `placement.world`, so every ancestor is absorbed in one step and the per-kind predicate is
unchanged. ADR 0011 §7 already proved the composition is affine-invariant for every kind.

A grouped child is therefore **hit-testable, and so selectable by an ordinary click.** M12's brief
lists "child selection inside groups" among the things not to build, and nothing here adds a group
gesture, an entry mode, or a way to select a group as a unit. But a document containing a group
whose children *render* and cannot be *hit* is a broken document, not a deferred feature — the same
argument as M11's F6. Recorded rather than assumed.

### 8.1 A group's `visible` and `locked`

`isEffectivelyVisible` checks the **ancestor chain**, not the leaf. And `document-view.ts`
propagates a hidden ancestor into the projected node's `visible`, so the renderer maps it to
`display: none` — which every renderer already did for a leaf.

Both halves were needed, and the disagreement between them was a **bug this milestone found**: with
only the hit-test rule, a hidden group's children still *painted*. The group claimed to be hidden and
its contents were on the page anyway — the "invisible but live" state that makes a document feel
haunted.

`locked` is **not** propagated: locking is about interaction, not paint.

## 9. What did not change

| | |
|---|---|
| `Transform2D` | unchanged — no `skewX`, no fourth parameter |
| `worldMatrix` | unchanged — still a node's map into its parent |
| measurement | unchanged — a child's layout box is its own **local** box; `clientWidth`/`offsetWidth` are unmoved by any ancestor, `getBoundingClientRect` is not (ADR 0011 §10) |
| text | unchanged — `contenteditable` fence on the frame, no group in the text model, no DOM nesting |
| images | unchanged — asset reference, `fit`, and `data-asset-state` are exactly as before, and `parse` still fetches nothing |
| `hitTestPage`'s predicate | unchanged |
| `resizeTransform` / `rotateTransform` | unchanged — both are stated in the object's own local coordinates, so the matrix never enters |
| multi-object resize | still deferred |
| aggregate selection frame | still M8's decision, so the rotation grip is still single-selection only |

## 10. Why page-local groups remain rejected

Restating [ADR 0010](0010-groups-and-the-transform-question.md) §2 in one line, because the choice is
visible in every signature here: with page-local children a group's transform is **not in the
coordinate chain at all**, so every consumer must be taught about it separately, hit testing needs a
different composition, and "where is this object" has three answers rather than one. Group-local
children make a group an ordinary node with an ordinary parent, which is why `tree.ts` is 400 lines
rather than a rewrite and why `hitTestPage`'s loop is unchanged.

## 11. Findings

- **F15 — two sources for `formatVersion`.** `createDocument` wrote `formatVersion: 1` and
  `persist/format.ts` declared `1`; they agreed by coincidence and were both right until M12 moved
  one. Every round-trip test then failed at once with "the document is not equal to itself after a
  round trip", which says nothing about the version and everything about the duplication. The single
  literal now lives in `model/factory.ts`, `persist/format.ts` re-exports it, and
  `tests/persist/version-ownership.test.ts` asserts they cannot drift. **A layer rule that forces a
  duplication is a reason to move the constant, not to write it down twice.**
- **F16 — a hidden group did not hide its children.** §8.1.
- **F17 — `validateDocument` could overflow the stack.** M12 folded the parallel asset-reference walk
  into `checkNode`, which has the cycle guard. The parallel walk did not, so a cyclic model overflowed
  the stack *inside the asset check* — and `validateDocument` is precisely the function everything
  relies on to **refuse** such a model. The enforcement point had become the thing that crashed on
  what it enforces against, which is worse than no guard because it looked like one.
- **F18 — `worldTransformIn` had the centre-convention bug twice.** It subtracted the child's
  half-width twice, then mixed the parent's *page* centre with its *local* centre. Both are invisible
  for a parent at the origin, and the test written to catch the second one made it a third time.
- **F19 — `nodeById` could not find a group**, because it was `placementOf`-based and that returns
  leaves. Two `tree.test.ts` cases failed on it.
- **F20 — the M12 fixture committed the trap its own header names.** `g-kinds` at `(40, 40)` painted
  its first child from `y = -36`, above the page: clipped, unclickable, and the failure surfaced as a
  message about hit testing.

## 12. Tests

- `src/model/tree.test.ts` — 32: paint order, depth, the two spellings agreeing at three levels,
  ownership, cycles, depth bound, structural edits, multi-page, nesting arithmetic.
- `src/model/group-scale.test.ts` — 17: identity/translated/rotated/uniform/all-three composition,
  three-level nesting, inverse round trip, degenerate geometry, and **the refused case** — the group
  scale, the shear arithmetic executed, the boundary, and the legal non-uniform *leaf* control.
- `tests/persist/group-persistence.test.ts` — 31: the serialized shape, order preservation at depth,
  every kind of child, absent fields, `collectIds`, byte stability, the version rules, and 13
  refusals each asserting a **path**.
- `tests/editor/group-geometry.spec.ts` — 26: every kind inside a group measured against a
  hand-derived number, nesting, a hidden group, a flat control, paint order, hit testing against the
  authored position, chrome, and text editing.
- 15 mutations, all detected; `52 of 52` overall.

**Nine of these assertions were wrong on the first run**, all recorded in place: the same
centre-convention mistake three times, page px compared with client px in four places (including a
469px "error" that was pure units), an expected value that used the origins' separation rather than
the centres', a click that missed because a click does not open a text session, an ellipse
"separated" by comparing bounding-box centres of differently-sized shapes, a 90° rotation asserted
without its 1.25 scale, a group-local origin painted above the page, and a test inserted outside the
`describe` whose `beforeEach` mounted the fixture — so it saw an empty document and blamed geometry.

## 13. What M12+ may assume

- **Groups** are documents: saved, loaded, compared, rendered, transformed, hit-tested, editable.
- **Nesting** works to 64 levels, with no depth-dependent code anywhere.
- `tree.ts` is the only traversal; `NodePlacement.transform` and `.world` are the two ways to ask
  where something is.
- A group's `visible` hides its subtree, in pixels and in hit testing.
- `paintedBounds(placement.transform)` is in page space.
- **Stroke width follows a uniform group scale** (ADR 0011b §7): a child's authored 12 px stroke
  under a group scaled by `k` paints `12·k`, and a group's own stroke would be authored in
  group-local px.

## 14. Still deferred, with the reason

| | why |
|---|---|
| grouping / ungrouping gestures | this milestone's brief |
| selecting a group, entering a group, child selection *modes* | §8: a child's ordinary hit is not a group interaction |
| group dragging, group transform handles, group resize | needs a group's frame to have handles that move members — ADR 0008 §4's shear, unless uniform-only |
| aggregate group bounds | M8's decision; would also make the rotation grip coherent for groups |
| a layer panel, alignment, snapping | nothing in the model requires them |
| `locateNode` is exported but unused in production | kept because it is the answer to "which array owns this node" and the first structural command will need it — **recorded as a deliberate exception to this project's objection to unused code** |