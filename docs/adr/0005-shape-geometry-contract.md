# ADR 0005 — The graphical object geometry contract

- **Status:** accepted, and **amended during implementation** — see §8
- **Date:** 2026-10-04 (amended 2026-10-05)
- **Depends on:** `docs/ARCHITECTURE.md` §1.2, §1.3, §1.5, §2.3, §3.4, §3.5;
  [ADR 0003](0003-production-text-model.md) (the registry discipline),
  [ADR 0004](0004-measurement-boundary.md) (layout APIs vs painted boxes)
- **Amends:** §1.5's `ShapeNode` sketch, which modelled `points`/`closed`/`polygon`/
  `star`/`path` as one bag of optional fields
- **Blocks:** auto-size, polygons, paths, boolean operations

## Context

M4's rectangle works, and it established more than it looks. Before adding an ellipse
and a line, the questions §1's `ShapeNode` sketch left open have to be answered, because
every one of them is observable by a user and every wrong answer is a bug that only
shows up after someone drags a handle.

The questions were answered by measurement, in Chromium, against the real stylesheet —
`box-sizing: border-box` is load-bearing for the whole contract, so a bare test page
would have answered a different question. `tests/spike/shape-geometry-probe.spec.ts` and
`tests/spike/shape-line-probe.spec.ts` are the executable record.

## Measurements

### A stroke does not move the box

A `200×100` box with a `10px` border, `box-sizing: border-box`:

| | value |
|---|---|
| `offsetWidth/Height` | **200 × 100** |
| `getBoundingClientRect` | 200 × 100 |
| `clientWidth/Height` | 180 × 80 (the *padding* box) |
| computed `width` | `200px` |

The declared box **is** the border box, and a stroke is drawn inward from it. The same
element without a stroke reports `clientWidth` 200. So the stroke consumes fill area and
never geometry.

### A box thinner than its stroke *does* grow

The exception, and the reason a line is not simply a rectangle:

| box | border | `offsetHeight` | where the paint lands |
|---|---|---|---|
| `200×100` | 10px | 100 | inside, `[y+10, y+90]` |
| `200×0` | 4px top | **4** | `[y, y+4)` — entirely *below* `y` |

`border-box` cannot produce a box thinner than its own border, so the box grows
*downward* and the model's `height: 0` becomes a 4px-tall rendered box at the wrong
place. **`offsetHeight` stops agreeing with the model.**

### There is no CSS way to stroke a zero-height line

| candidate | box after | painted |
|---|---|---|
| `border-top` on a zero-height box | **4px tall** | `[y, y+4)` — asymmetric |
| `outline` on a zero-height box | 0 | **nothing at all** |
| SVG `<line>` island, `overflow: visible` | **0** | `[y-1, y+2]` — straddles, centred |

`outline` was the promising one — it does not affect layout — and it paints *nothing* on
a zero-height box. Only the SVG island keeps the model box exactly and centres the
stroke.

### Zero and negative extents

| declared | `offsetWidth` | computed `width` | browser hit at centre |
|---|---|---|---|
| `0 × 100` | 0 | `0px` | **no — the host got it** |
| `200 × 0` | 200 × 0 | `200px × 0px` | **no** |
| `-50 × 100` | 0 | **`0px`** | no |

Negative widths are **not representable in CSS** — `width: -50px` computes to `0px`. The
model's invariant (`size >= 0`) and CSS agree, so there is no disagreement to paper over;
`0` is simply the floor.

And a zero-extent box is **not hit-testable by the browser at all**. A horizontal line
has height 0, so if the editor used the browser it could never be grabbed.

### Ellipse: CSS and the mathematical answer agree

`border-radius: 50%` on a `200×100` box. Sampling a 21×21 grid, comparing the browser's
hit test against the unit-circle test:

| | |
|---|---|
| agree | 430 / 441 |
| disagree | 11 / 441 — **all** within ~4% of the boundary, i.e. antialiasing and exact-boundary ties |

Corners are genuinely unpainted (`nw`, `ne` → the host behind). So an ellipse needs no
SVG, and the editor can hit-test it mathematically *and* agree with Chromium to within
edge pixels.

## Decision

### 1. What `x`, `y`, `width`, `height` are

> **`transform.x/y/width/height` is the object's border box, in page-local document px.**

The single rectangle in the border box; for a line, the box whose diagonal from local
`(0,0)` to `(width, height)` is the segment.

Everything else follows:

| Question | Answer | Evidence |
|---|---|---|
| Fill, content or border bounds? | **Border box.** | `offsetWidth == model width` exactly. |
| Does stroke expand the model bounds? | **No**, with `align: 'inside'`. | offset stays 200×100. |
| Is stroke width authored geometry? | **Authored, but not geometry.** See below. | — |
| What does resizing do to a stroke? | Changes `width/height`; **stroke width is unchanged** in document px. It scales only under a transform. | Borders do not scale with `width`. |
| What does rotation preserve? | The box's size, the stroke width, and the centre. Rotation is about the box centre. | `localMatrix` is R·S about the centre. |
| Coordinate space? | **Page-local document px** — the model's internal unit. | The renderer writes `left`/`top` straight from them. |
| Model vs CSS? | **All authored properties are in the model; the model holds no painted-pixel extent.** | §0's rule. |

**Stroke width is a third category, and naming it matters.** It is *authored* (so it is
in the model, and undoable) but it is *not geometry* (so it is not in
`transform.width/height`, and changing it moves no handle). It is the one property that
has a geometric effect without being geometry. §4 therefore requires hit testing to
consult it — the only visual property that does.

### 2. `align: 'inside'` is the only supported stroke alignment

Not deferred-and-ignored: **rejected at render time with a clear error.** The
measurements show `center` and `outside` would need `outline` (which paints nothing on a
zero-height box) or a second paint. And `inside` is what makes the rest of the contract
unambiguous:

> Because an inside stroke cannot extend beyond the border box, **selection geometry
> equals the model box exactly**, for every shape, at every stroke width.

If `outside` were supported, selection would have to decide whether the visible ring is
selectable — a question with no answer that is right in every editor. Deferring the
alignment keeps the question from arising.

> **Amended by [ADR 0011b](0011b-selection-frame-and-stroke.md) §5.** This section said
> "selection geometry equals the model box exactly", and for six milestones that was read as
> *selection geometry equals the object*. It does not: for a rotated object the model box,
> the painted bounds and the painted shape are three different things, and the selection
> frame was drawn as the first while the object was the third. The stroke's *alignment* claim
> is unaffected and still holds — an inside stroke never extends past the border box, so it
> never changes where the shape ends. What M11 fixed is which box the *chrome* follows.

### 2a. Stroke width is a local dimension, and transforms with the object

Added by ADR 0011b §5, because the section above fixed the alignment but never said what
stroke **width** means under a transform — and the answer was never chosen.

> **A stroke's width is authored in the object's own units and transforms with the object.**
> An authored 12 px stroke paints 12 px at any rotation, and `12 · k` on an object scaled by `k`.

Not invariant in document space. Measured, in `tests/editor/stroke-under-transform.spec.ts`:

| | authored 12 px paints |
|---|---|
| no transform | 12 and 12 |
| `scale(2)` | 24 and 24 |
| `scale(2, 3)` | **24 and 36** — one authored stroke, two painted strokes |
| `matrix(1, 0.6, 0, 1, 0, 0)` | 12 and **19.2** — no single width at all |

Three reasons this is the answer rather than the alternative:

- **It is free.** The CSS border and the SVG `stroke-width` are both *inside* the transformed
  element, so neither needs a compensating mechanism. Invariance would require leaving CSS:
  `vector-effect: non-scaling-stroke` is **accepted and ignored** on an HTML element by
  Chromium, because it is defined for SVG geometry — so invariance means an SVG stroke
  renderer, which would be the one part of this renderer CSS cannot express.
- **It agrees with hit testing.** `containsLinePoint` uses `stroke.width / 2` as a tolerance in
  **local** units, so the grabbable region and the painted region scale together. Document-space
  invariance would desynchronise them.
- **It is the same rule as `width` and `height`.** All three are local dimensions, so a group
  scale — a transform on the child — multiplies all three by the same factor. There is no separate
  "stroke scale" to keep in step, which is what makes this safe to adopt before groups exist.

It was previously **accidental**: no gesture writes `scaleX`/`scaleY` (ADR 0010 §6 F1), so every
scale is 1 and document-space and object-space invariance are indistinguishable. M11 chooses.

### 3. A line is an SVG island, and that is forced

`contenteditable`-style precedent aside, §2.8's escape hatch is explicit: a *narrowly
scoped island renderer* for the object type that needs it. Measured, that is a line.

| | model box after | stroke centred? |
|---|---|---|
| `border` | grows to 4px | no — sits below `y` |
| `outline` | stays 0 | paints nothing |
| **SVG `<line>`** | **stays 0** | **yes** |

So `line` renders an `<svg>` inside its object element. Three properties keep this from
becoming a second rendering architecture:

1. It is **one shape kind**, not a backend. The element is still a `.p1-object` div
   carrying `data-oid`, still positioned and transformed by the same renderer code, and
   still a member of the same paint order.
2. The reconciler already permits it — §2.3's invariant says auxiliary children go
   *inside* the object element, and `reconcileInto` never touches a leaf's children.
   The `<svg>` is created once in `create()` and thereafter only its attributes change.
3. `rect` and `ellipse` stay pure HTML/CSS. The island is the exception the measurements
   forced, recorded as such.

**Documented consequence:** a line's direction is not authored. The segment always runs
local `(0,0) → (width, height)`, so a drag from bottom-right to top-left produces a
positive box with the same line. For a straight segment that is visually identical, so
nothing is lost — but there is no way to express "the line starts here".

### 4. Hit testing and selection

Hit testing is against the model, never `elementFromPoint` (§3.4). Each kind supplies
its own predicate through a **registry**, not a conditional chain:

| kind | predicate | tolerance |
|---|---|---|
| `rect` | point in the box | none |
| `ellipse` | `(x/w − ½)² + (y/h − ½)² ≤ ¼` | none |
| `line` | distance to the segment ≤ `strokeWidth / 2` | **the stroke width** |

Two of these deserve their reasoning:

- **A line's tolerance is its stroke width, and that is what makes a zero-height line
  reachable at all.** The browser cannot hit-test a zero-extent box (measured), so a
  distance-to-segment test is the only way a horizontal line can be grabbed. It is also
  what a user expects: clicking *on* a line selects it.
- **A rectangle has no tolerance.** Its box *is* its extent, so there is no ring to
  widen. Adding one would make the editor disagree with Chromium on a shape where the
  two currently agree exactly (measured: `justOutside` → not a hit).

### 5. Where the disagreement with Chromium is, and is not

The task requires this stated rather than smoothed over.

**This section was written before the renderer existed and one row of it was wrong. The
corrected table is in §8.1; the original is kept here because the correction is the
interesting part.**

| Case | Chromium | Editor | Agreement |
|---|---|---|---|
| `rect`, any stroke width | border box | border box | **exact** |
| `ellipse` | matches the unit circle | unit circle | **within edge antialiasing** (11/441 samples, all on the boundary) |
| `line`, height 0 | **cannot hit-test** | segment ± `strokeWidth/2` | **deliberate disagreement** |
| hidden object | hit-testable | refuses (`visible === false`) | **deliberate, §3.4** |
| zero-extent box | not hit-testable | box test, so **reachable at its origin** | editor is *more* permissive |

> **Correction (M6).** This table originally said a zero-extent box is "not reachable by
> click", which was wrong and is only discoverable by testing it. The box predicate is
> inclusive on all four sides, so a `0×0` box accepts exactly one point — its origin — and
> the editor will select a degenerate object there. Chromium will not, because a zero-size
> element has no interior to hit. Found by `tests/editor/images.spec.ts`.
>
> It is left as-is on purpose. Making it unselectable would add a special case for a
> degenerate case *and* would make a `0×0` object impossible to select — so a user who
> accidentally created one could not resize their way out of it. Consistency of one rule
> for every object type is worth more than tidiness at the edge, and creation already
> refuses to produce such an object (§6).

Only the line is a real, intended divergence, and it exists because the browser has no
answer at all. Everywhere else the editor's answer is the browser's answer, which is a
result worth having rather than an accident.

**A zero-extent rectangle has no interior to click** — though the inclusive box predicate
does accept its single origin point, so the editor will select one if you click exactly
there. Chromium will not, because a zero-size element has no interior. Left as-is: creation
never produces such an object (§6), and making one unselectable would mean a user who had
one could not resize their way out of it. Found and corrected in M6; see §5's table.

### 6. Creation never produces a degenerate object

A drag from a point to itself would be `0 × 0`. Rather than commit an object that cannot
be selected, creation applies:

- **drag** → the dragged rect, normalised so width/height are non-negative;
- **click without drag** → a **default-size** shape at that point;
- either way, a minimum extent is enforced so the result is reachable by click.

`normaliseRect` already exists for the marquee, so the normalisation is the same code
path — not a second implementation.

### 7. Zero and negative dimensions

- **Negative is unreachable.** CSS computes `width: -50px` to `0px` and the invariant
  rejects it. `resizeTransform` clamps to `minSize = 1`. All three agree.
- **Zero is valid** and meaningful for a line. It is *not* clamped away, because clamping
  a horizontal line to 1px tall would be wrong.
- So the rule is: **zero is legal; negative is impossible.** Nothing to reconcile.

## The registry

Two registries, because there are two keys, and conflating them is what produces
`if (type === ...)` chains.

**By node type** — already exists. `ObjectTypeRegistry` in `render/reconciler.ts`, keyed
by `node.type`, holding one renderer per type. Unchanged.

**By shape kind** — new, in `model/shapes.ts`, because the answers are *pure geometry
about the model* and both `render` and `editor` need them:

```ts
interface ShapeKindSpec {
  readonly kind: ShapeKind;
  readonly label: string;
  /** Hit test in the node's local box space. */
  readonly containsPoint: (local: Vec2, box: LayoutBox, node: ShapeNode) => boolean;
  /** Extra inspector properties this kind contributes. */
  readonly properties: readonly PropertySpec[];
}
```

Living in `model/` is what lets `render/`, `editor/` and `ui/` all read it without any of
them importing each other. It contains **no DOM** — that is why it can live in the
layer that is forbidden from touching the DOM.

**Rendering** is per kind too, but as a `Record<ShapeKind, Projector>` in
`render/types/shape.ts` rather than a registry entry. A projection is inherently
presentational, and a `Record` keyed by the union is compile-time exhaustive: adding a
kind is a type error until its projector exists. That is the same guarantee a `switch`
gives, without the growing chain.

**Inspector properties** are declared as data in the registry, not as conditionals in the
inspector. The inspector walks `properties` and generates fields; a new kind contributes
its own fields by existing.

## The model change

The sketch's `ShapeGeometry` was a bag of optional fields:

```ts
{ kind: 'rect'|'ellipse'|'line'|'polygon'|'star'|'path'; points?: Vec2[]; closed?: boolean; cornerRadius?: number }
```

Every field is optional, so nothing stops `{ kind: 'line', cornerRadius: 8 }` — a
well-typed value that means nothing. Replaced with a discriminated union:

```ts
export type ShapeGeometry =
  | { kind: 'rect'; cornerRadius: number }
  | { kind: 'ellipse' }
  | { kind: 'line' };
```

`cornerRadius` existing *only* on a rect becomes a type fact rather than a runtime
check, and `points`/`closed` are gone — not deferred behind an empty bag, but absent,
so nothing can be written that the renderer would silently ignore.

## Limitations

Carried forward deliberately.

- **`stroke.align` accepts only `'inside'`,** and `center`/`outside` **throw** rather than
  rendering something plausible. The type still carries the other two so documents can
  express intent, and so the migration is additive when they are implemented.
- **No line direction, no arrowheads, no multi-point paths.** All of those need a real
  path model and are explicitly not in scope.
- **`ellipse` is an axis-aligned ellipse inscribed in the box.** A circle is an ellipse
  with `width === height`; there is no separate circle kind.
- **No polygon or path support**, though `pointInPolygon` exists in `core/geom`. Adding
  it means a point list in the model, a different hit-test predicate, and an SVG
  renderer — three new things, so it is a separate milestone rather than a field.
- **The `stale` check now covers shapes too,** which it already did, because
  `offsetWidth` equals the model width for every kind including the SVG-backed line
  (measured: `offsetHeight` 0 for the SVG line).

## Verification

| Claim | Where |
|---|---|
| A stroke does not change `offsetWidth/Height` | `tests/spike/shape-geometry-probe.spec.ts` G |
| A box thinner than its stroke grows | same, I |
| `outline` paints nothing on a zero-height box | `tests/spike/shape-line-probe.spec.ts` M |
| SVG island keeps the box at zero; its stroke **is** a browser hit target | same, N |
| Negative width computes to `0px`; zero-extent boxes are unhit-testable | `shape-geometry-probe.spec.ts` H |
| `border-radius: 50%` agrees with the unit-circle test | `shape-line-probe.spec.ts` O |
| The contract, through the real app, with negative controls | `tests/editor/shapes.spec.ts` |
| The registry's predicates, exhaustively | `src/model/shapes.test.ts` |
| Creation geometry | `src/model/creation.test.ts` |
| `setProps` no-op detection | `src/model/commands-setprops.test.ts` |
| The fixtures parse and are internally consistent | `tests/editor/shape-fixtures.test.ts` |

If any table above stops matching, this ADR is wrong.

---

# 8. Amendments found during implementation

The design above was written before the renderer existed. Three of its claims did not
survive contact with the app, and each was found by a test that failed for a reason worth
understanding. They are recorded here rather than quietly edited into §5, because *why*
the first draft was wrong is the part that constrains future work.

## 8.1 The SVG island removes the line's disagreement, and creates a smaller one

**§5 claimed Chromium cannot hit-test a line, and listed that as the deliberate
divergence.** That claim was measured — but on a CSS border on a zero-height `div`
(PROBE L), which is the representation the investigation *rejected*. The shipped
representation is an SVG `<line>`, and PROBE N measured, in the same run, that an SVG
stroke **is** a hit target: the probe located the painted band with `elementFromPoint`
and found it at `[y-1, y+2]` for a 4px stroke.

So for a **stroked** line the editor and the browser agree exactly, and the corrected
table is:

| Case | Chromium | Editor | Agreement |
|---|---|---|---|
| `rect`, any stroke width | border box | border box | exact |
| `ellipse` | unit circle | unit circle | within edge antialiasing |
| `line` **with** a stroke | the painted stroke | segment ± `strokeWidth/2` | **exact** |
| `line` **without** a stroke | no target at all — no ink | segment ± `strokeWidth/2` | **deliberate disagreement** |
| zero-size rect | not hit-testable | reachable at its origin only | editor is *more* permissive; see the correction below |
| hidden object | hit-testable | refuses (`visible === false`) | deliberate, §3.4 |

The remaining divergence is *smaller* and better: it applies only to an object that paints
nothing, and it exists because the browser genuinely has no target. The editor's reason
for owning hit testing at all (§3.4: `elementFromPoint` cannot answer questions about
`locked`, `visible` or object-specific shape) is unaffected.

### 8.1.1 `pointer-events` is inherited, and the island needs both halves

Getting the above right needed a subtlety that cost a full debug cycle:

- Chromium hit-tests an `<svg>` element against its **rectangular viewport**. For a
  zero-height line that is the `Math.max(height, 1)` strip the renderer inserts to stop the
  viewport collapsing — so a *stroke-less* line reported as a hit, and a *stroked* one did
  not. A phantom target where there is no paint.
- Fixing it with `pointer-events: none` on the root **silenced the stroke as well**,
  because `pointer-events` is an *inherited* SVG property. That made every line unpickable
  by the browser — the opposite of the intent.

The shipped pair is `pointer-events: none` on the `<svg>` and `pointer-events: stroke` on
the `<line>`: the viewport is not a target, real ink is, and unpainted area is not.

> **Generalisable rule:** an SVG island needs *two* `pointer-events` declarations, not
> one, and the second is on the shape rather than the root. Any future island renderer
> (a star, a path, an arrowhead) inherits this requirement and should copy both lines.

## 8.2 A click must never marquee-select

**§4 says hit testing is per-kind and exact. It was, and the editor still got an ellipse
wrong** — because hit testing was only half of the answer.

A press on empty space starts a **marquee**, and on release `applyMarquee` selected every
object whose *box* the rect touched. A click is a zero-size rect, and a zero-size rect
overlaps every box containing the point. So clicking inside an ellipse's transparent
corner selected the ellipse — `hitNode` correctly refused the point and `applyMarquee`
selected the object anyway, in the same gesture.

Box-based marquee selection is *correct* and stays: a marquee is a rectangular gesture, and
every editor selects by bounding box. The fix is that **a click is not a marquee**.
`pointerMove` now marks a marquee as moved once it has extent, and `pointerUp` only applies
one that did.

### 8.2.1 A test had come to depend on the bug

`tests/editor/measure.spec.ts` — 22 browser tests, all passing, all correct — clicked
`(60, 60)` to select a frame at `(40, 40, 200, 50)` **rotated 30° about its centre**. That
point is outside the shape. The click only appeared to select the frame because of the bug
above.

This is the strongest argument in this document for negative controls: a test passed, on
every run, while measuring nothing it claimed to measure. The helper now asserts that the
frame was selected and names the failure in its own message.

## 8.3 `setProps` had no no-op detection, and M5 made that load-bearing

§4.2 requires `apply` to return the *same reference* when a command changes nothing,
because `History` reads reference identity as "nothing happened". `setProps` spread its
payload unconditionally, so every commit produced a new object.

Latent until now. M5 routes fill, stroke, stroke width and opacity through `setProps`, and
each of those inspector fields re-commits whenever it loses focus — so opening and closing
an unchanged colour put an entry on the undo stack, and the user's next Ctrl+Z appeared to
do nothing. Fixed with a bounded structural comparison (`payloadEqual`); the unit tests in
`src/model/commands-setprops.test.ts` pin both the fix and the *non*-fix it must not become.

## 8.4 Authored stroke width is not geometry, and that has a consequence

The §1 table is right and worth restating as a constraint: `stroke.width` is authored
(so it is in the model, and undoable) but is **not** geometry (so it is not in
`transform.width/height`, and changing it moves no handle).

The consequence is that **hit testing is the only place a visual property has geometric
effect**, so it is the only visual property the registry's predicates may read. Adding a
visual property later means asking whether it should affect hit testing — a question with a
different answer than "does the renderer need it".
