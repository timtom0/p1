# P1 — Architecture

A local-first, browser-based page layout / desktop publishing editor whose **document
rendering backbone is HTML + CSS**, with JavaScript owning the document model,
interaction, and persistence.

Status: M0 through M9 implemented and browser-verified. **M10 delivered as a proof and M10b as a
decision** — see [ADR 0010](adr/0010-groups-and-the-transform-question.md) and
[ADR 0011](adr/0011-affine-transform-decision.md). Grouping is now **unblocked with one stated
restriction**; the transform model is **not** extended to affine. Everything below remains the design
of record; deviations are recorded in the milestone notes at the end.

---

## Status

| Milestone | State |
|---|---|
| **M0** Foundations | **Done and browser-verified** — see [M0 notes](#m0-implementation-notes). |
| **M1** Viewport & pages | **Done** — see [M1 notes](#m1-implementation-notes). Page stack, rulers, zoom/pan/fit, three coordinate spaces, status bar. |
| **Spike** Text editing | **Done — the fence is viable.** See [ADR 0001](adr/0001-text-editing-fence.md) and §10.3. |
| **M2** Selection & transform | **Done** — see [M2 notes](#m2-implementation-notes). Command funnel, history, model hit testing, screen-space overlay, move/resize/rotate, inspector scaffold. |
| **Text undo** | **Resolved** — see [ADR 0002](adr/0002-text-undo-composition.md) and §10.4. Browser owns undo inside a session; the editor owns it outside. |
| **M3** Text frames & typography | **Done** — see [M3 notes](#m3-implementation-notes--production-text-frames-and-typography). Production text model, `contenteditable="true"`, format-preserving normalizer, frame typography, inspector. |
| **Text model** | **Resolved** — see [ADR 0003](adr/0003-production-text-model.md) and §10.5. `plaintext-only` cannot carry formatting, so the fence's mode changed and the paragraph mapping got better. |
| **Measurement** | **Resolved** - see [ADR 0004](adr/0004-measurement-boundary.md) and 2.6. Layout APIs are zoom- and transform-invariant, so measurement needs no coordinate conversion; the offscreen `TextMeasurer` sketch is superseded. |
| **M5** Graphical objects | **Done** - see [M5 notes](#m5-implementation-notes--graphical-objects) and [ADR 0005](adr/0005-shape-geometry-contract.md). Geometry contract, shape-kind registry, rect + ellipse + line, draw tools, schema-driven inspector. |
| **M6** Images | **Done** - see [M6 notes](#m6-implementation-notes--images) and [ADR 0006](adr/0006-image-asset-contract.md). Asset id contract, intrinsic size as metadata, a four-state asset lifecycle, a marked placeholder for missing assets. |
| **M7** Persistence | **Done** — see [M7 notes](#m7-implementation-notes--persistence) and [ADR 0007](adr/0007-persistent-document-format.md). A versioned, deterministic `.p1doc` format; a total validating parser that refuses with a path; golden fixtures; download/upload save-load; canonical dirty state; a save that ends an open text session. |
| **M8** Multi-object editing | **Done** — see [M8 notes](#m8-implementation-notes--multi-object-editing) and [ADR 0008](adr/0008-multi-selection-and-grouping.md). Multi-selection audited and found already complete; `restack` as a relative model command; layer-order commands in the chrome; mixed-aware shared object properties. **Grouping deferred, with the preconditions recorded.** |
| **M9** Interaction integrity | **Done** — see [M9 notes](#m9-implementation-notes--interaction-integrity) and [ADR 0009](adr/0009-boundaries-audit.md). An audit rather than a feature: the interaction state machine written down, four false invariants found and fixed, one dead abstraction removed, and the model's immutability proved by deep-freezing the input to every command. |
| **M10** Groups, proved | **Proof delivered; grouping deliberately not built** — see [M10 notes](#m10-implementation-notes--groups-and-the-transform-question) and [ADR 0010](adr/0010-groups-and-the-transform-question.md). Page-local groups are implementable today and turn out to be a layer folder; group-local groups are blocked on whether `Transform2D` admits a shear — the same question that blocks multi-object resize. Two ADR 0008 limitations corrected as a by-product. |
| **M10b** Affine decision | **Done — RESTRICT GROUPS** — see [M10b notes](#m10b-implementation-notes--does-the-geometry-model-need-affine-transforms) and [ADR 0011](adr/0011-affine-transform-decision.md). The 28-site inventory; the candidate model defined and proved; rotation survives under shear; resize, hit testing, measurement and rendering are already correct for any invertible matrix; and the extension is refused because it buys one capability nothing can produce while forcing a stroke decision with no cheap answer. Two pre-existing bugs found (the selection frame does not follow rotation; the stroke semantic was never chosen). |
| **M11** Selection geometry | **Done** — see [M11 notes](#m11-implementation-notes--the-geometry-groups-will-stand-on) and [ADR 0011b](adr/0011b-selection-frame-and-stroke.md). F6 fixed: the selection outline, its eight handles and its rotation grip are now the object's *transformed* frame, reusing the renderer's own projection rather than adding a second one. `selectionRect` renamed `modelFrameUnion`; `paintedBounds` and `transformedCorners` added so "where is this object" is a named quantity. F7/F8 resolved: stroke width is a local dimension and transforms with the object. The accidental rotate-handle suppression is gone. |
| **M12** Group model | **Done — the document object, no interaction** — see [M12 notes](#m12-implementation-notes--the-group-model) and [ADR 0012](adr/0012-persistent-group-model.md). `GroupNode` with group-local children, nesting to arbitrary depth, uniform-only group scale, `tree.ts` as the single recursive traversal, paint order by flattening. Persistence at `formatVersion: 2`, with version 1 still read and no migration. |
| **M13** Group interaction | **Done** — see [M13 notes](#m13-implementation-notes--group-interaction) and [ADR 0013](adr/0013-group-interaction.md). `group`/`ungroup` through the command funnel; grouping as a pure structural array move on M12's theorem; contiguous-span grouping; child object identity preserved; moved-group ungroup composition; group scope with entry and exit; the ancestor/descendant selection invariant enforced in `setSelection`. The M12 group fixture was overwritten and recovered from the session store. |
| **M14** Asset garbage collection | **Done** — see [ADR 0014](adr/0014-asset-garbage-collection.md). `pruneAssets` as a payload-free command, so one collection is one undo entry; `referencedAssetIds` as a pure function; reachability via `placementsInDocument` so GC sees exactly what the editor can see. Closes the named gap from ADR 0006 §5. |
| **M15** Boot reliability | **Done — a harness fix, not a feature** — see [M15 notes](#m15-implementation-notes--boot-reliability). Roughly one test per full run died on a boot that produced no `[data-page]`. Root cause was Windows TCP ephemeral-port exhaustion (`ERR_NO_BUFFER_SPACE`, Tcpip 4231) from a dev-mode module graph, not an application fault. |
| **M16** Alignment & distribution | **Done** — see [M16 notes](#m16-implementation-notes--alignment-and-distribution) and [ADR 0016](adr/0016-alignment-and-distribution.md). Relative model commands, so undo, history and persistence come from the existing funnel. |
| **M17** Snapping & guides | **Done** — see [M17 notes](#m17-implementation-notes--snapping-and-guides) and [ADR 0017](adr/0017-snapping-and-guides.md). A pure snapping engine, a 10-screen-pixel threshold, page features scanned first, Alt as an explicit opt-out, transient guides. F21: the moving box is captured at pointer-down. |
| **M18** Visibility semantics | **Done** — see [M18 notes](#m18-implementation-notes--visibility-semantics). `visible: false` is not a rendering detail: a node is effectively visible when it **and every ancestor** is visible. The contract already lived in the renderer and in `selection.ts`; `arrange.ts` was the outlier and now filters placements. |
| **M19** Print profile & PDF export | **Done** — see [M19 notes](#m19-implementation-notes--print-profile-and-pdf-export) and [ADR 0018](adr/0018-print-profile-and-pdf-export.md). Export is `window.print()` against a print profile — no PDF writer and no second representation of the document. |
| M20+ | Not started |

Seventeen known limitations are recorded rather than hidden. Three of them are now closed and struck
through rather than deleted — the selection outline in M11, group interaction in M13, orphaned assets in
M14 — so a reader can see what was believed and when it stopped being true. None of the open fourteen
blocks the next milestone:

- **Lost external writes.** A model write to a frame being edited is deferred and
  replayed on session exit (see ADR 0001 finding 2). M3 widened the hook from text to
  text *and* typography, but the policy underneath is still single-writer and will need
  revisiting before any multi-writer story exists.
- **Redo does not survive a text session.** Native browser behaviour, accepted
  deliberately in ADR 0002.
- ~~**Orphaned assets are never collected.**~~ **Closed in M14** by
  [ADR 0014](adr/0014-asset-garbage-collection.md). `pruneAssets` removes every asset no image node at any
  depth references, as one command so one collection is one undo entry, and returns the same document
  reference when there is nothing to collect. It is **never implicit** — nothing on load, save or delete
  calls it, so the user decides when bytes are dropped, and it has **no menu or toolbar item yet**: it is
  reachable as the editor action *"Clean up unused images"* (`src/editor/editor.ts`) and nothing else.
- **`{ external }` assets are typed but not implemented.** They resolve to a named error
  and paint a placeholder rather than silently doing nothing. The reference now round-trips
  through a saved file exactly (ADR 0007 §4), so a project folder is a resolver away — but
  there is no project folder, and M7's download/upload workflow gives an `external` path
  nothing to resolve against, which is one of the two reasons the File System Access API
  was not adopted.
- **No format migrations.** A file from any version other than the current one is refused
  with a message naming both versions (ADR 0007 §4). The contract a migration will slot into
  exists; the migrations themselves do not, by design. **M12 widened this once**: version 1 is now
  read alongside version 2, because a version-1 document is a strict subset (no groups) and nothing needs
  converting. Saving re-stamps it. Both error messages stay two-sided.
- **No autosave.** A crash loses the session. Save is explicit, and `New` asks before
  discarding unsaved work, but nothing is written without the user asking.
- **No save-in-place.** Save is a download, so updating a file means downloading again and
  the browser may rename the copy (ADR 0007 §10). Accepted for now because the alternative
  needs a document handle that survives a reload, which needs persisted session state.
- ~~**No grouping *interaction*.**~~ **Mostly closed by M13** — see
  [ADR 0013](adr/0013-group-interaction.md). `group`/`ungroup` gestures, selecting a group, entering and
  leaving a group, and group dragging all exist now. Still missing from M13's original scope:
  **group resize** and **scale handles on a group**, both excluded by ADR 0013 as genuinely out of
  scope — resizing a group means scaling its children, which *is* multi-object resize and needs ADR
  0011's re-entry condition, and a group's scale must stay uniform — and **no layer panel**. A grouped
  child remains click-selectable, because a rendered object that cannot be hit would be a broken
  document — a consequence of hit testing being correct, not a group feature.
- **A group's scale must be uniform.** Sharper than "groups scale uniformly": a **non-uniform scale
  may not be followed by a rotation**. Nothing is inside a leaf, so a leaf may be scaled
  non-uniformly; a group's children carry their own rotations, so a group's may not. A non-uniform
  group scale is refused at load with a message naming the shear (ADR 0012 §2.1).

- **No aggregate selection frame.** M8's decision, kept through M12 to M19, and the same missing frame is
  why a group cannot be resized (ADR 0013). The visible consequence is that the rotation grip is offered
  for one object and withheld for several, because there is no single pivot to rotate about.
  M16 is the instructive near-miss: alignment and distribution **do** need a box for the whole selection,
  and `arrangeBounds` computes one as the union of the members' painted boxes. ADR 0010 refused an
  aggregate selection frame as a rectangle *presented to the user* as though it were a real object, and
  that is still the rule — the union is computed for the arithmetic and never drawn.
- **Nothing in the application writes `scaleX`/`scaleY`.** This is the *one* capability the shear
  discussion was about: no gesture, no inspector field, no command sets a scale (ADR 0010 §6 F1).
  A document can *hold* a non-uniformly scaled leaf — `Transform2D` always could, and M12 confirms it
  composes correctly under uniform ancestors — but nothing produces one. Multi-object resize and
  non-uniform **group** scale are both consequences of this single gap, not independent omissions.
- **No multi-object resize.** A non-uniform resize of a rotated object needs a shear, and
  `Transform2D` has no shear parameter. Proved algebraically rather than asserted, in
  `src/model/group-resize-limit.test.ts` (ADR 0008 §4), and generalised in ADR 0010 §1 to a single
  predicate in `src/core/geom/linear-part.ts`. **This, non-uniform group scale, and affine transforms
  are one question** — see ADR 0011 §16's re-entry condition, whose binding term is the stroke.
- **A non-uniform scale has no single stroke width, by decision.** Option B was chosen in M11: stroke
  width is authored in the object's own units and transforms with the object. Measured: at `scale(2,3)`
  an authored `12px` border paints 24 on one axis and 36 on the other, and under shear the painted
  extent is 19.2 with no single width at all. That is the *price* of B, recorded rather than
  discovered. Invariance is not achievable by adjusting a number:
  `vector-effect: non-scaling-stroke` is accepted by Chromium on an HTML element and then ignored,
  because it is defined for SVG geometry (ADR 0011 §9 F7, F8; ADR 0011b §5).
- ~~**The selection outline does not follow rotation.**~~ **Fixed in M11.** For nine milestones the
  overlay wrote `x/y/width/height` with **no transform**, so a rotated object was framed by an
  unrotated box at its model position — a rotated ellipse painted 171.2 x 156.6 inside a frame of
  140 x 100, with the eight handles on that box. It was not an affine consequence and it was not
  broken *behaviour*: clicking, dragging and undo all worked, and the hit tester was correct
  throughout. Only the drawn frame was wrong, which is why no interaction test saw it and why the
  pixel baselines could not either (ADR 0011b §8). `selectionRect` is now `modelFrameUnion`, the
  outline carries the object's own matrix, and `paintedBounds` is a named function.
- **`scaleTransforms` is unused and incorrect.** `src/editor/transform.ts` exports it "for scale
  gestures"; nothing outside its own tests calls it, and given a rotated member it grows the box and
  leaves `rotation` alone — neither a page-frame scale nor the bounding box of one. It is a landmine
  for a future scale gesture, and its tests use only unrotated boxes. Pinned in
  `src/editor/transform.test.ts` rather than deleted, so the reasoning is where the next
  implementer will look (ADR 0010 §6 F2).
- **Rotation is reachable on a single selection, rotated or not.** The suppression for an already
  rotated object is **gone**: it was a workaround for the frame not following the rotation, and M11
  fixed the frame (ADR 0011b §4). What remains is a genuine capability limit — the grip's pivot is the
  single object's frame centre, so with several selected there is nothing coherent to rotate about,
  because M8 has no aggregate selection frame. `startRotate`'s fan-out therefore still has **no
  gesture that can reach it**.
- **Interaction state is single-writer.** A gesture captures the document state it started from,
  so a change made *during* a gesture is overwritten by the next pointer move. Unchanged by M9
  and M10 and re-recorded as a live assumption rather than a settled design (ADR 0001 finding 2).
  M10 checked that groups do not make it worse: a page-local group's geometry is derived from its
  children and never authored, so there is no second writer to introduce.
- **The `pointercancel` handler is not covered by a test.** With the cause removed no cancel
  occurs, so deleting the listener is unobservable from any test. Recorded in
  `mutation-check.ps1` rather than papered over with a mutation that would only prove the
  mutation works (ADR 0009 §10).

## 0. Executive summary

Ten decisions carry most of the weight. Everything below is elaboration.

| # | Decision | Why |
|---|---|---|
| 1 | **Immutable document model**, plain TypeScript types, zero DOM types in it | Undo, diffing, reconciliation, and future scripting all become trivial |
| 2 | **Every mutation goes through pure commands** (`apply(doc, cmd) -> doc`) | One funnel ⇒ nothing can mutate the document outside undo/serialization |
| 3 | **Object tree order == paint order == z-order** (no separate `zIndex`) | Removes an entire class of ordering bugs |
| 4 | **Page-local coordinate space**, internal unit = CSS `px`, physical units only a presentation/authoring concern | Lets us use CSS layout directly without fighting it |
| 5 | **Zoom is a single CSS `transform: scale()`** on the page box, never a model change | Text reflows exactly as it will print; WYSIWYG for free |
| 6 | **Overlay (selection/handles/guides) is a separate, untransformed layer** in screen space | Crisp 1px strokes, constant-size handles, no counter-scale hacks |
| 7 | **We own a ~400-line keyed reconciler** that maps model → DOM incrementally | The DOM is a projection of the model, never a second source of truth |
| 8 | **Object types, tools, styles, and migrations are registries keyed by string id** | New features are additive registrations, not core special cases |
| 9 | **Inspector is generated from per-type property schemas** | Property editing scales to new types without new UI code |
| 10 | **JSON document format, versioned, with an explicit migration chain** | Diffable, evolvable, human-inspectable, no backend |

### Non-negotiable architectural rule

> The DOM is a **projection** of the document model. It is derived, disposable, and
> never authoritative — with exactly one documented exception (in-flight text
> editing, §2.7), which is fenced off behind a session boundary.

---

## 1. Document model

### 1.1 Units and coordinates

* **Internal unit is the CSS `px`**, as a float. Never rounded.
* Physical units (`mm`, `cm`, `in`, `pt`, `pc`) exist only at the *authoring*
  and *display* boundary. `core/units.ts` holds one conversion table anchored on
  the CSS-defined constant `96px === 1in`.
* Documents store page size in a **physical unit plus an orientation** so that
  "A4" survives a round trip and printing is exact; geometry is derived.

```ts
type Unit = 'px' | 'pt' | 'mm' | 'cm' | 'in' | 'pc';
const PX_PER_INCH = 96;

interface PageSize { width: number; height: number; unit: Exclude<Unit,'px'>; }
```

* **Page-local space.** Each page has its own origin at its top-left corner. An
  object's coordinates are relative to its **parent's** space, not to the page.
  Multi-page stacking is a *layout of pages in the canvas*, not part of the
  document's geometry, so there is no global "document space" to reason about.
* **Scaling is unit conversion, not layout.** A document authored in `mm` is
  converted to px once at load; from then on everything is px.

### 1.2 Geometry primitives

A small, dependency-free, exhaustively unit-tested module: `Vec2`, `Rect`,
`Mat2D` (`a,b,c,d,e,f`), `compose`, `invert`, `apply`, `transformRect`,
`aabbOfTransformedRect`, `rectsIntersect`, `pointInPolygon`. No allocation in hot
paths (accept out-params / return new small objects, whichever benchmarks favour;
start simple, optimize with data).

### 1.3 Transform representation

```ts
interface Transform2D {
  x: number; y: number;        // top-left of the layout box, in PARENT space
  width: number; height: number;
  rotation: number;            // radians, about the box centre
  scaleX: number; scaleY: number;
}
```

* The **local box is always `(0, 0, width, height)`** — unrotated, unscaled.
* The world matrix is derived, never stored:
  `M = T(x + w/2, y + h/2) · R(rotation) · S(scaleX, scaleY) · T(-w/2, -h/2)`
* Why this form: it is human-readable in the file, directly editable in the
  inspector, composes predictably down a group tree, and matches what
  professional layout tools expose. `Mat2D` is used *inside* geometry and
  rendering; it is not the serialized shape.
* Non-orthogonal skew and 3D are **out of scope for the model**. If we ever need
  them, the escape hatch is an extra `matrix?: [a,b,c,d,e,f]` override on the
  transform — additive, not a breaking change.
* **What this form can express, exactly.** The linear part is `R(t)·S(sx, sy)`, so its two
  columns are always perpendicular — and conversely *any* 2×2 with perpendicular columns factors
  back into a rotation and a diagonal scale. Perpendicularity is therefore not a convenient
  necessary condition; it **is** the model's expressible set, which is what makes "this is a
  shear" a statement of arithmetic rather than opinion. It is one function,
  `isRotationTimesScale` in `src/core/geom/linear-part.ts`, with both directions proved in
  `linear-part.test.ts` (ADR 0010 §1).
* **A shear is a shear whichever order you compose in.** `R(t)·S` is representable at *every*
  rotation; `S·R(t)` — a page-frame scale applied to a rotated object — is a shear at every
  rotation but zero. This is the whole of the multi-object-resize limit (ADR 0008 §4) and the
  group-nesting limit (ADR 0010 §2), and it is why single-object resize works under rotation at
  all: `resizeTransform` unprojects the pointer into the object's *own* space and changes the box,
  which never composes a page-frame scale with the object's rotation.
* **`scaleX`/`scaleY` currently have no writer.** No gesture writes them; they are read from files
  and round-tripped. See the status limitations (ADR 0010 §6 F1).
* **Affine was examined in full and refused** (ADR 0011). The linear part is 3 parameters against
  `GL(2)`'s 4, so the model is a **codimension-1** subset — one equation, `a·c + b·d = 0`. The
  extension is one field, `skewX`, in the parameterisation `R(t)·S(sx,sy)·K(kx)` with
  `K(kx) = [[1,kx],[0,1]]` (CSS's `skewX`, in the object's own axes); `decomposeRSK` is a bijection
  onto all of `GL(2)` once `scaleX > 0` is required, so equality stays field-wise and a file has one
  spelling per matrix. A **2×3 matrix is rejected on legibility**, not mathematics: §1.3's
  "directly editable in the inspector" and the byte-stable round trip both argue against six opaque
  floats, and a matrix has no canonical form without an extra rule. What the extension buys is one
  capability — non-uniform scaling — for which nothing in the application is a writer, and it forces
  a stroke-width decision that document-space invariance cannot make in CSS. Re-entry conditions are
  in ADR 0011 §16; the binding one is the stroke.
* **What affine would *not* have cost**, which is why "a second geometry system" is not an argument:
  hit testing, resize, measurement and the renderer are already correct for any **invertible** matrix
  (ADR 0011 §§5, 7). `local = M⁻¹p` then a local predicate is the whole of each. What it *would* have
  cost is semantics: a second meaning for "rotation" the moment a shear exists (§3 there — the
  authored field survives, the derived polar rotation does not), and the selection frame, which needs
  fixing regardless (§8).
* **Rotation must be applied in parent space once shear exists.** `R` commutes with `R` but not with
  `R·S·K`, so pre-multiplying accumulates the angle and carries the scales and shear untouched, while
  post-multiplying redistributes them. Parent space is the only order with a closed form, and therefore
  the only one under which repeated rotation is stable (ADR 0011 §6).

### 1.3.1 Where an object is: four quantities, four names

The single most expensive ambiguity in this codebase, and the cause of F6. Four different
questions have four different answers, and for nine milestones one of them answered all four.

| quantity | definition | function | used by |
|---|---|---|---|
| **model frame** | `{x, y, width, height}` off the transform, untransformed | `toRect` | the rotate pivot; `modelFrameUnion` |
| **painted bounds** | AABB of the four transformed corners | `paintedBounds` | the marquee's hit region |
| **oriented bounds** | the transformed rectangle itself | `transformedCorners` | the outline, the handles, the grip |
| **hit-test region** | per kind, in the node's own space | `shapeContainsPoint` | `hitTestPage` |

**The overlay carries the object's own matrix.** `SelectionOutline` holds the node's `localMatrix`
alongside its frame, and the outline box is written with the same `matrix(...)` and the same
`transform-origin: 50% 50%` that the renderer writes onto the object — so the outline *is* the object
by construction rather than by a second computation of it. One projection, two callers.

**`Overlay.handlePoint` is the only place handle positions are computed**, and the editor's hit test
calls it. It used to be computed twice — once to draw, once to hit-test — and the two agreed with each
other while both being wrong, which is the worst arrangement available: a fix to one would have left
the other behind.

**Never** derive any of this from `getBoundingClientRect`: it is a paint-space measurement, wrong
under zoom, wrong across pages, and unavailable for an object that is not mounted. See ADR 0011b §§2–3.

### 1.4 Document, pages, nodes

```ts
interface Document {
  formatVersion: number;
  id: string;
  name: string;
  pageSize: PageSize;
  pages: Page[];                        // ordered
  styles: StyleSheet;                   // reserved from day one (see §7.4)
  resources: Record<ResourceId, Resource>;
  meta: Record<string, unknown>;
}

interface Page {
  id: string;
  name: string;
  background: Paint;
  objects: Node[];                      // ORDER IS PAINT ORDER
  guides: Guide[];                      // user-placed, persisted
  grid: GridSpec;
}

interface BaseNode {
  id: string;
  type: string;                         // 'group' | 'textFrame' | 'image' | 'shape' | ...
  name: string;
  transform: Transform2D;
  visible: boolean;
  locked: boolean;
  opacity?: number;
  blendMode?: BlendMode;
  effects?: Effect[];                   // shadows — composable, not new node types
  extensions?: Record<string, unknown>; // escape hatch for plugins/future features
  styleId?: string;                     // reserved
}
```

Hierarchy is a plain tree: `GroupNode { type:'group'; children: Node[] }`.
**Groups own a transform** and therefore a coordinate space. Frame properties
(`clip`, `blend isolation`) live on the group.

Layer panel is a *view* over `pages[].objects` — it has no state of its own, so
layer order and paint order cannot diverge.

### 1.5 Object types (v1 set)

Modelled as **one node type per *kind of content***, with styling expressed as
composable records rather than as node subclasses.

```ts
interface TextFrameNode extends BaseNode {
  type: 'textFrame';
  text: RichText;
  style?: TextStyle;
}
```

**The shape node, as built in M5.** One node type covers every graphical kind, and the
kind is a **discriminated union** rather than a bag of optional fields:

```ts
export type ShapeGeometry =
  | { kind: 'rect'; cornerRadius: number }
  | { kind: 'ellipse' }
  | { kind: 'line' };
```

| Sketch | As built | Why |
|---|---|---|
| `{ kind; points?; closed?; cornerRadius? }` | a discriminated union | Every optional field meant `{ kind: 'line', cornerRadius: 8 }` type-checked and meant nothing. "A rect has corners" is now a *type* fact |
| `kind: 'polygon' \| 'star' \| 'path'`, `points?: Vec2[]` | **absent** | Not deferred behind an empty bag — absent, so nothing can be written the renderer would ignore. Adding one is a point list in the model, a third predicate, and a third renderer |
| `stroke.align: 'center' \| 'outside'` | kept in the type, **thrown** at render time | `inside` is what makes selection geometry equal to the model box. `center`/`outside` cannot be honoured by CSS without a second paint (§2.8) |

**The geometry contract is one sentence:** `transform.x/y/width/height` is the object's
**border box**, in page-local document px. For a rect and an ellipse it bounds the shape;
for a line it is the box whose diagonal from local `(0,0)` to `(width, height)` is the
segment, so a horizontal line has height 0. A stroke does **not** expand it. Everything
else follows, and `docs/adr/0005-shape-geometry-contract.md` has the measurements.

**Text frames, rebuilt as M3.** See `docs/adr/0003-production-text-model.md` for the
design and the measurements it rests on. As built:

```ts
interface CharFormat { bold?: true; italic?: true; underline?: true; strike?: true }
interface InlineRun  { text: string; format?: CharFormat }   // '\n' = soft break
interface ParagraphBlock { kind: 'paragraph'; align?: ParagraphAlign; runs: InlineRun[] }
interface RichText   { blocks: ParagraphBlock[] }            // always >= 1
interface TextStyle  { fontFamily?; fontSize?; lineHeight?; letterSpacing?; color? }
```

Two rules make this a *document* format rather than a record of browser output.

**Canonical form.** Adjacent runs with equal formats are merged
(`normalizeRichText`), so every visual text has exactly one run-sequence. Without it
`a` + `<b>b</b>` and `<b>ab</b>` would be two values for one page, and since `History`
skips commands returning the same reference (§4.4) the undo stack would fill with
steps that appear to do nothing.

**Optional-means-absent, and no `false`.** Every `CharFormat` flag is `true` or
missing. One encoding of "not bold" means equality is total and the model stays sparse.

**As built vs. the original sketch, and why:**

| Sketch | As built | Why |
|---|---|---|
| `ParagraphStyle` per paragraph (10 fields) | `align` per paragraph; the rest moved to frame-level `TextStyle` | Font size belongs to the frame for M3. Per-paragraph typography is the next increment, and adding fields to `ParagraphBlock` is additive. |
| `frame.verticalAlign` | **deferred** | Needs a flex container on the frame, which moves the content element's box and therefore the caret's coordinate space — the ADR 0001 fence back under test for a non-load-bearing feature. |
| `frame.columns`, `frame.autoSize` | **deferred** | Both need measurement (§2.6). The model *cannot* derive them, which is a consequence of keeping layout out of the model. |
| `frame.padding` | **deferred** | Box model, not typography; arrives with frame geometry. |
| `frame.overflow: 'visible'\|'hidden'` | always `visible`; the **page** clips | A text frame is not a clipping box. See §1.5.1. |
| `InlineStyle` with `link`, `baselineShift` | **deferred** | `baselineShift` is positional, not stylistic — Chromium reports `superscript`/`subscript` as supported, so accepting them silently would mean storing a position the model cannot resolve. |
| `style` on a run | `format` on a run | "Format" cannot be mistaken for a CSS bag; `CharFormat` is a closed set of four flags. |

**How the text maps to HTML.** One `<p>` per block; `align` as an inline
`style="text-align:…"`; each run's text as a text node wrapped once per flag in the
canonical order **bold → italic → underline → strike**. A soft break is a literal `\n`
inside a text node, *not* `<br>`: `white-space: pre-wrap` renders it, so `<br>` is
redundant in the render direction. Normalizing `<br>` → `\n` makes the two
representations converge on one model value, so there is no `<br>`-doubling class of
bug. One direction is many-to-one.

The reverse direction is a **stack-based walk** carrying a format down the tree —
the flat string extraction the spike used had nowhere to record a format. Its defining
property is tested exactly:

> For every model value `m`, `domToRichText(parse(richTextToHtml(m))) === m`.

`docs/adr/0003-production-text-model.md` has the full mapping table. Two behaviours
worth stating here because they are easy to get wrong:

- **A trailing `<br>` is a placeholder, not a soft break.** Chromium keeps one so the
  caret's line stays visible, and leaves `<p><br></p>` when a line is emptied.
  Reading it as a break gave an emptied frame the model value `"\n"`, which
  re-projects as a permanent blank line — so the frame stopped being empty and stopped
  round-tripping. Only a *trailing* `<br>` is dropped; `<p>a<br>b</p>` is a real break.
- **Whitespace is content and is never trimmed.** `white-space: pre-wrap` is
  load-bearing (ADR 0001 finding 1) and the normalizer preserves every space the user
  typed. The spike's normalizer trimmed each line, which silently destroyed a trailing
  space.


```ts
interface ImageNode extends BaseNode {
  type: 'image';
  resourceId: string;
  fit: 'fill' | 'contain' | 'cover';
  crop?: Insets; focal?: Vec2;
  mask?: { kind:'rect'|'ellipse'|'polygon'; radius?: number; points?: Vec2[] };
}

interface ShapeNode extends BaseNode {
  type: 'shape';
  shape: { kind:'rect'|'ellipse'|'line'|'polygon'|'star'|'path';
           points?: Vec2[]; closed?: boolean; cornerRadius?: number };
  fill?: Paint; stroke?: Stroke;
}
```

`Paint` = solid / linear / radial gradient. `Stroke` = paint + width + align +
dash + cap + join + miter.

**Deliberately not modelled:** skew, 3D, CMYK/overprint, per-object filters beyond
shadows (CSS covers shadows natively), text-on-path (deferred — see roadmap).

### 1.5.1 Text frames are not clipping boxes

A text frame's box is **fixed** and its content is not. The text content element sets
`overflow: visible`, so text that does not fit stays painted — the user has to be able
to *see* that they have overflowed. Clipping happens one level up, at the page's own
`overflow: hidden`, which is where a page boundary actually is.

This creates a deliberate disagreement, and it is worth naming because both halves are
correct:

| Question | Answer | Why |
|---|---|---|
| What is painted below the frame? | The overflowing text. | `overflow: visible`. |
| What is *clickable* below the frame? | Nothing. | Hit testing is against the model (§3.4), and only the model knows the object's true extent. |
| What is painted below the *page*? | Nothing. | `.page { overflow: hidden }`. |

So `document.elementFromPoint` and the editor disagree below a frame's bottom edge.
The editor is right: a browser hit test answers "what is painted here", and the
question a click asks is "what did the user mean to select". `tests/visual/typography.spec.ts`
pins both answers.

### 1.5.2 Empty paragraphs need a CSS minimum

The renderer emits an empty paragraph as `<p></p>` — no `<br>` — because `pre-wrap`
makes `<br>` redundant in the render direction and two sources of truth for one thing
is worse than one. An element with no content has **zero height**, so the caret would
sit on a collapsed line and `Enter` would have nowhere visible to go.

`.p1-text-content p { min-height: 1em }` fixes it. `1em` rather than `1lh`: the `lh`
unit is newer than the editor's browser floor, and for a *minimum* the difference
between a font size and a line box is invisible. This is ADR 0001 finding 4, and M3
made it load-bearing rather than cosmetic by stopping to emit the browser's `<br>`.

## 1.6 Model invariants

Enforced by `model/invariants.ts` in dev builds and by tests:

1. Ids are unique across the document.
2. `width`/`height` > 0 (or `>= 0` for lines/degenerate shapes).
3. A group contains at least one child.
4. Child indices are dense and in range.
5. No cycles; depth limit enforced to prevent pathological nesting.
6. `scaleX/scaleY != 0` (guard against non-invertible matrices).
7. Every `resourceId` referenced resolves; every `styleId` referenced resolves.
8. `RichText.blocks.length >= 1`. An empty frame is one paragraph with one run of
   `''`, never zero blocks — the caret needs somewhere to live and `Enter` needs
   somewhere to go, and "is the frame empty" then stays a helper (`isRichTextEmpty`)
   rather than a branch every reader has to write.
9. A `RichText` reaching the store is in **canonical form** (§1.5). `setText` and the
   normalizer both call `normalizeRichText`, so the invariant holds on every write
   path rather than by convention.

---

## 2. HTML/CSS rendering architecture

### 2.1 Layer stack

```
rulers        (chrome — <canvas>, outside the document surface entirely)
viewport      (scroll container — native scrollbars & trackpad panning)
└─ canvas     (size = stackExtent × zoom; the scrollable spacer)
   ├─ pages   (transform: scale(zoom); transform-origin: 0 0)  ← ONE zoom write
   │  └─ page × n   (position: absolute; top = pageOffsetY in document px;
   │  │               overflow: hidden  ← clips content to the page box)
   │  │  └─ objects (absolutely positioned children; DOM order == paint order)
   └─ (overlay, M2 — SCREEN SPACE, outside the scale transform)
```

Three consequences worth stating explicitly:

* **Content clipping to the page is free.** `overflow: hidden` on the page box is
  exactly page-level clipping; we never implement a clipper.
* **Zoom is one CSS write for the whole document.** The transform lives on the
  *stack*, not on individual pages, so adding pages costs nothing and no page
  geometry is ever touched by zooming.
* **The overlay is not scaled**, so strokes are exactly 1 device-independent px,
  handles are a constant size at any zoom, and labels stay legible. The cost is
  one `× zoom` at write time, funnelled through a single helper.

### 2.2 Zoom

```html
<div class="page" style="width:210mm-in-px; height:297mm-in-px;
                        transform:scale(0.75); transform-origin:0 0">
```

* Zoom changes **only** that one CSS property (plus the canvas' spacer size).
  It never touches the model. Line breaking, hyphenation, justification, and
  image cropping therefore behave identically at every zoom and match print.
* Known cost: fractional scale factors resample text. Mitigation ladder, in
  order of preference: (a) snap zoom to "nice" values, (b) at ≥ 200% switch to
  the same non-scaled path (we are already at/above physical size), (c) never
  use CSS `zoom` on the page — it changes layout semantics.

### 2.3 The reconciler

We do **not** use a UI framework for the document surface. We own a small keyed
reconciler, because the mapping we need (model tree ⇄ DOM subtree, with
paint-order equality and per-property style diffing) is narrow, well-understood,
and would be a fighting fit with a component framework's assumptions.

```ts
interface ObjectRenderer<P> {
  type: string;
  create(ctx: RenderCtx): HTMLElement;                    // detached element
  update(el: HTMLElement, node: Node & P, prev: Node | undefined, ctx: RenderCtx): void;
  /** Optional: contribute rules to the document-scoped <style>, e.g. dedup'd text styles. */
  rules?(node: Node & P, ctx: RenderCtx): CssRules | undefined;
  /** Optional: model-accurate hit test; default is the transformed local box. */
  hitTest?(node: Node & P, pt: Vec2): boolean;
  /**
   * Optional: runs after `update`, so a renderer can normalise state that an early
   * return inside `update` left inconsistent.
   *
   * Added by the §10.3 spike. `update()` returns early when text is unchanged, which
   * left the text renderer's `data-editing` marker stale; owning it from
   * `afterUpdate` means every exit path leaves the attribute consistent.
   */
  afterUpdate?(el: HTMLElement, node: Node & P, ctx: RenderCtx): void;
}
```

`RenderCtx` also carries an optional `isTextEditing(nodeId)` query — the whole of
what a renderer learns about the text fence. It is **queried, not pushed**, so
renderers remain pure projections of the model.

Reconciler responsibilities, and nothing else:

1. **Structure**: keyed children diff per parent (by `id`), handling
   insert / remove / **move** (reorder ⇒ real DOM reordering, so paint order is
   genuinely DOM order) and update.
2. **Identity**: maintain `Map<NodeId, HTMLElement>` for O(1) lookup — no
   `querySelector` in hot paths.
3. **Style patching**: each element caches the last value written per CSS
   property and writes only diffs (`el.__styleCache`), preventing style thrash
   during drag operations.
4. **Nothing else.** No measuring, no reading `offsetWidth`, no event handling,
   no business logic. If a renderer needs a measurement, it goes through
   `TextMeasurer` (§2.6).

`el.dataset.oid = node.id` on every object element for debuggability and for
dev-mode DOM inspection.

### 2.4 Who does what

| Concern | Owner |
|---|---|
| Typography: shaping, kerning, ligatures, justification, hyphenation, ruby, CJK line breaking | **CSS** |
| Text layout: wrapping, `columns`, `text-overflow`, `white-space`, `direction` | **CSS** |
| Box geometry: `width`/`height`, `padding`, `min/max-*`, `aspect-ratio`, `object-fit` | **CSS** |
| Position & orientation: `transform: matrix(...)`, `transform-origin: 50% 50%` | **CSS** |
| Clipping: `overflow`, `clip-path`, `mask-image` | **CSS** |
| Fill & stroke: `background`, gradients, `border`, `outline`, `box-shadow` | **CSS** |
| Effects: `filter`, `backdrop-filter`, `mix-blend-mode`, `isolation`, `opacity` | **CSS** |
| Compositing / GPU promotion, layer management | **CSS** (browser) |
| Paged output: `@page`, `break-*`, print stylesheets | **CSS** |
| Model, commands, selection, tools, snapping, viewport, persistence | **JS** |
| Hit testing, geometry math, text measurement | **JS** |
| Frame sizes derived from content (auto-size, fit-to-text) | **JS**, fed by measurements |

The line to remember: **CSS decides how pixels look; JS decides what the pixels
mean.**

### 2.5 Style delivery

Two layers, chosen per property:

* **Element inline styles** for geometry and per-instance values (`transform`,
  `width`, `left`, `background-image`).
* **A document-scoped `<style>` element owned by the renderer** for dedup'd
  repeated values — notably paragraph/run styles and paint definitions. A
  paragraph with 40 runs emits a handful of class rules instead of 40 style
  attributes, keeping the DOM light for text-heavy pages.
  Rules are content-hashed and pruned on change.

This is a genuine advantage of the CSS backbone: we get a stylesheet optimizer,
selector matching, and the cascade for free.

### 2.6 Text measurement

**Superseded by [ADR 0004](adr/0004-measurement-boundary.md).** The sketch below was
wrong, and this section is replaced rather than amended.

```ts
// was: an offscreen host cloning computed typography
measure(text: RichText, frame: FrameProps, opts: { maxWidth?: number }): { width: number; height: number }
```

It proposed a second, offscreen copy of the text. That is a second rendering path, which
this architecture does not get to have — and it would drift from the real one the first
time the projection changed. It also answers the wrong question: an offscreen host at
some assumed width cannot tell you how the *mounted* text is laid out.

**As built**, measurement asks the browser about the mounted projection:

```ts
type Measurement =
  | { status: 'ok'; size: { width: number; height: number }; overflow: { x: boolean; y: boolean } }
  | { status: 'unmounted' } | { status: 'hidden' } | { status: 'stale' };
```

Three measured facts, not assumptions:

| Fact | Consequence |
|---|---|
| `clientWidth/Height` and `scrollWidth/Height` are **zoom- and transform-invariant** | Sizes need **no coordinate conversion at all**, and zoom never invalidates a measurement. Verified at four zoom levels and under a 30° rotation. |
| `getBoundingClientRect` is **scaled**, and under rotation it is the bounding box of the *painted* result — 198×143 for a 200×50 box | Never used for size. This is why §3.7's single conversion point stays single. |
| A `display: none` element reports **zero from every API** | `0` is a plausible size, so the API returns a **status**, never a bare number. `stale` additionally checks the DOM against the model, which turns "did you measure the document or a memory of it?" into a verifiable property. |

**Coordinates: everything returned is in document px.** Positions are deliberately *not*
part of this contract — `Viewport` and `Overlay` already own client ↔ stack ↔ page
conversion, and handing measurement a client rect would invite a second one.

**Timing**, all measured: a layout-forcing read after a style write is valid **in the
same task** with no frame boundary needed; measurement is valid immediately after a
command because the store's only subscriber renders synchronously; and **zoom does not
invalidate a measurement**, which is the largest ergonomic consequence of choosing
layout APIs.

**During a text session** measurement is valid and non-disturbing — the caret was
verified identical across an aggressive measuring pass — but it observes the browser,
not the model. See §2.6.1 for what may and may not run mid-session.

Used for: fit-frame-to-text, min-content width for auto-size, snapping to text
baselines, and page previews. `ResizeObserver` is the only source of a *fractional*,
transform-invariant size, and it is asynchronous — which is what makes auto-size a
converging operation rather than a pure command (ADR 0004, "Auto-size implications").

**This is not an optimisation — it is what the text model cannot do without.** Every
deferred text feature (auto-size, columns, fit-to-content, baseline snapping) needs a
number the model cannot derive, because line breaking, line boxes and glyph positions
are delegated to CSS by design (§1.5). Keeping layout out of the model is the right
call; the cost is that "how tall is this text?" is a *question asked of the browser*,
not a value read from the document.

### 2.6.1 What may run during an editing session

Measured in Chromium, because it constrains every future text feature and it is not
obvious. `tests/spike/undo-granularity-probe.spec.ts` applies each kind of work on
every keystroke and presses Ctrl+Z once:

| Work done on every keystroke | Ctrl+Z undoes |
|---|---|
| a forced layout read (`clientHeight`) | the whole word |
| a selection query (`queryCommandState`) | the whole word |
| **rebuilding the overlay's DOM** (`replaceChildren`) | **one character** |
| **rewriting a toolbar button's text** | **one character** |

**Reads are safe during an editing session. DOM mutations outside the editable are
not.** A chrome refresh contains mutations, so per-keystroke refresh silently destroys
the keystroke grouping that [ADR 0002](adr/0002-text-undo-composition.md)'s delegation
depends on.

So `TextEditSession`'s `onDomChange` hook is deliberately **not** wired to a chrome
refresh. The accepted cost is that the format toggles' pressed state, and any measured
readout, show the state from when the caret was placed until the session exits. A stale
toolbar indicator is the cheaper of the two failure modes. Measurement itself is on the
safe side of this line: every API in the §2.6 contract is a read.

### 2.7 Where CSS cannot help — and what we do

| # | Limitation | Pragmatic resolution |
|---|---|---|
| 1 | **Text editing.** `contenteditable` gives us caret, selection, IME, spellcheck, accessibility — for free, and it is the single biggest argument for the HTML/CSS backbone. But inside a session the DOM, not the model, is the truth. | **Fenced exception — VALIDATED by the §10.3 spike.** A `TextEditSession` marks exactly one frame's *content* as DOM-authoritative; geometry and typography still render from the model. On exit, the DOM is normalized back into `RichText` and the model resumes authority. See [ADR 0001](adr/0001-text-editing-fence.md). Caveats, all now addressed: an external model write during a session is deferred and replayed on exit rather than silently lost; undo/redo composition is settled in [ADR 0002](adr/0002-text-undo-composition.md) (§10.4); and the `plaintext-only` fence cannot carry character formatting at all, so M3 runs `contenteditable="true"` with a format-preserving normalizer — see [ADR 0003](adr/0003-production-text-model.md). |
| 2 | **Blend modes escape their stacking context.** `mix-blend-mode` blends only within the nearest stacking context. | Set `isolation: isolate` on groups so blending is predictable and *group-local*. Blending against the page backdrop is not supported; documented limitation. |
| 3 | **Object-level blend/flattening semantics** (InDesign-style transparency groups). | Model `effects`/group flatten flags now; implement with `isolation` + `opacity` first, refine later. |
| 4 | **Strokes outside the box edge.** CSS borders are inside/outside; SVG strokes straddle. | Ship `inside` (border) and `center` (border + outline compensation) at M4. `outside` deferred to a scoped SVG island renderer. |
| 5 | **Arbitrary paint servers** (mesh/angular gradients, complex patterns). | Not CSS-expressible. Add them as a *new paint kind* with a scoped SVG/canvas island — do not abandon the backbone. |
| 6 | **Text wrap around arbitrary objects.** CSS has no exclusion system. | Use CSS-native `shape-outside` for the common single-object-inside-a-text-frame case. Full exclusion is deferred; anchored text frames are a separate feature, not a wrap algorithm. |
| 7 | **Text on a path, per-glyph transforms, optical sizing.** | `textPath` in a scoped SVG island object type; per-glyph transforms deferred. |
| 8 | **Non-orthogonal / 3D transforms.** | Store a matrix override, apply `matrix()`, and keep hit-testing/handles in model space (which we own anyway). |
| 9 | **Overprint, CMYK, separations, preflight.** | Out of scope for a screen-first editor; print profile is RGB. Revisit only if print fidelity becomes a goal. |
| 10 | ~~**Exact print output.**~~ **Resolved in M19.** `window.print()` against a print profile: a `@media print` stylesheet plus a dynamic `@page { size: <exact>; margin: 0 }` injected from `doc.pageSize`. | Highest fidelity, lowest effort - a direct dividend of the HTML/CSS backbone. See [ADR 0018](adr/0018-print-profile-and-pdf-export.md). |
| 11 | **DOM node budget** on very large documents. | Page virtualization (mount only visible pages ± 1), `content-visibility: auto` on off-screen pages, and resource decoding budgets. |
| 12 | **DOM hit-testing is not usable.** `elementFromPoint` ignores our model (locked/hidden/alpha/shape-interior rules) and fights transforms. | Always hit-test in JS against the model via the geometry module, topmost-first with inverse matrices. |

### 2.8 The escape-hatch principle

> When HTML/CSS cannot express a required visual, **add a narrowly scoped island
> renderer** (SVG, or canvas for pathological cases) for *that object type
> only*, leaving the rest of the document on the CSS backbone.

This keeps the architecture honest: CSS-first, with explicit, bounded islands —
never a creeping hybrid where every feature special-cases.

---

## 3. Editor architecture

### 3.1 Mode vs. tool

Two orthogonal concepts, both explicit state:

* **Mode** — global interaction semantics: `select`, `directSelect`, `textEdit`,
  `draw`, `hand`, `zoom`.
* **Tool** — what a pointer drag does within a mode: `marquee`, `move`,
  `resize`, `rotate`, `pen`, `rectangle`, `ellipse`, `eyedropper`, `scale`, `gradient`.

Keeping them separate means `Space` temporarily switches to `hand` without
destroying the active tool, and `Esc` from `textEdit` returns to the previous
tool.

### 3.2 Tool contract

```ts
interface Tool {
  id: string;
  cursor?: string;
  onActivate?(ctx: ToolCtx): void;
  onDeactivate?(ctx: ToolCtx): void;
  onPointerDown(e: PointerEv, ctx: ToolCtx): void;
  onPointerMove(e: PointerEv, ctx: ToolCtx): void;
  onPointerUp(e: PointerEv, ctx: ToolCtx): void;
  onKeyDown?(e: KeyboardEv, ctx: ToolCtx): void;
  onCancel?(): void;
}

interface ToolCtx {
  doc: DocState;                       // read-only view
  dispatch(cmds: Command | Command[], opts?: DispatchOpts): void;
  selection: SelectionState;
  viewport: ViewportState;
  space: SpaceMapper;                   // screen ⇄ page ⇄ local conversions
  overlay: OverlayApi;                  // draw guides, handles, previews
  snap: SnapEngine;
  beginTransaction(label: string, mergeKey?: string): void;
}
```

Rules that keep tools from becoming spaghetti:

* A tool **never** touches object DOM. It reads the model, dispatches commands,
  and draws to the overlay.
* A tool **never** mutates the model directly.
* Tools are stateless w.r.t. document data; per-gesture scratch state lives in a
  `Gesture` object created on pointer-down and destroyed on pointer-up/cancel.
* Cross-tool logic (alignment guides, duplicate-on-alt, snapping) lives in shared
  services, not in each tool.

### 3.3 Pointer pipeline

1. `pointerdown` captured on the viewport root (`setPointerCapture`, single
   listener, no per-element handlers).
2. Convert client → canvas → **page-local document coords**.
3. If a text-edit session is active and the hit is inside that frame, route to
   the editing controller.
4. Otherwise hit-test the model (topmost-first, honouring `visible`, `locked`,
   groups, and any `hitTest` override) → produce `{ nodeId, part }` where
   `part` may be `'body' | 'handle:se' | 'path-node:3'`.
5. Dispatch to the active tool. Tools may re-interpret (Alt = cycle selection
   beneath, Shift = extend, Space = pan).

Modifier semantics are centralized in one `modifiers(e)` helper so they are
consistent everywhere.

### 3.4 Selection

```ts
interface SelectionState {
  ids: ReadonlySet<string>;      // node ids, across pages
  primary: string | null;        // the id the inspector edits
  anchor: string | null;         // shift-extension anchor
  hover: string | null;
  editing: { nodeId: string; sessionId: number } | null;
  range: { pageId: string; rect: Rect } | null;   // marquee, transient
}
```

Derived, memoized selectors: `selectionBounds`, `commonFrame`, `selectionNodes`,
`selectionAncestors` (for the layers panel). Selection is **editor state** — it
is saved/restored around undo but is **not** part of the document.

### 3.5 Transformations

The subtle part is resize under rotation, so it is specified precisely:

* A handle is `{ nodeId, part: 'nw'|'n'|…| 'se', frame: 'outer'|'bounds' }`.
* On drag: convert the pointer into the node's **local, unrotated space** via
  `inverse(worldMatrix(node))`.
* Compute the new local box from the anchored (opposite) edge/corner, applying
  Shift (aspect / centre-symmetric) and Alt (from centre).
* Re-derive `x/y/width/height` so the **anchor point stays fixed in parent
  space**, and keep `rotation` untouched.
- Rotation: drag angle about the selection centre; Shift snaps to 15°; the
  rotation origin is the selection centre (bounding-box centre for multi-select).
- Rotation of a group rotates children about the group centre.
- All of this is pure geometry in `editor/transform/*`, unit-tested with
  property-style round-trip assertions (`apply then invert ≈ identity`).

### 3.6 Guides, grid, snapping

Three separate mechanisms, deliberately not conflated. **Only the third is built**, and the first two are
listed so the intent is not lost rather than because they exist:

* **Persisted guides** (`page.guides`): user-placed lines, stored in the file, rendered always, draggable,
  with magnetic snapping. **Not built — `Page` has no `guides` field.**
* **Grid** (`page.grid`): origin, spacing, subdivisions; rendered as an overlay pattern; optionally
  *snap to grid* as a lower-priority snap source. **Not built — `Page` has no `grid` field.**
* **Smart guides**: transient, computed per gesture. **Built in M17** ([ADR 0017](adr/0017-snapping-and-guides.md)).

The engine is a pure module, `src/model/snap.ts`, and knows nothing about the viewport, the overlay or the
pointer — which is what makes it testable at several zooms without a browser.

```ts
computeSnap(input: SnapInput): SnapResult   // { dx, dy, lines: SnapLine[] }
```

1. Build candidate axes from the page (`pageSnapRect`: edges and centre) and from other objects'
   **painted** bounds (`snapTargetsFor`, which reuses the M16 arrangement targets and therefore honours
   M18's visibility rule for free).
2. Project the moving selection's bounds onto those axes.
3. Choose the smallest correction within **`SNAP_THRESHOLD_SCREEN_PX = 10`** *screen* pixels, converted to
   document units by `snapThresholdDocument(zoom) = 10 / zoom`, so the feel is zoom-independent.
4. Page features are scanned **first**, so a tie goes to stable geometry rather than to whichever object
   happened to be iterated last.
5. Return the correction **plus** the line extents, so the overlay can draw a full-width/full-height rule
   rather than a dot. `SnapLine` and `OverlayInput.snapLines` have existed since M11 as placeholders; M17
   populated them.

**Alt** suppresses snapping. The two moments are split in time deliberately: at pointer-down Alt means
*select the containing group*, during the drag it means *do not snap*.

Guides are **derived, transient, screen-space state**: never persisted, and cleared in both `pointerUp` and
`cancelGesture`. Equal-spacing detection remains a later refinement.

### 3.7 Viewport

```ts
interface ViewportState {
  zoom: number;
  mode: 'fit' | 'manual';   // manual opts out of resize re-fitting
  pageGap: number;          // view state, never document state
  focusedPageIndex: number;
}
```

* **Pan** comes free from the scroll container; the canvas spacer is sized to
  `stackExtent × zoom`, so scrollbars are always truthful. Space+drag and
  middle-drag pan exist for mouse users, who have no trackpad.
* **Zoom** is a `transform` on the page *stack* plus a spacer resize — one CSS
  write for the whole document at any zoom. Anchored zoom preserves the document
  point under the cursor.
* Presets: fit whole stack, fit single page, 100%, and (M2) zoom-to-selection.

#### Three coordinate spaces, deliberately separate

| Space | Origin | Used by |
|---|---|---|
| **document** | a page's top-left | the model, object coordinates |
| **stack** | top-left of the *first* page, including inter-page gaps | page positioning, scroll maths |
| **client** | screen | input events, overlay chrome |

Conversions live only in `Viewport`: `stackPointFromClient`, `clientFromStackPoint`,
`pagePointFromClient`, `clientFromPagePoint`, `pageIndexAt`, `pageOffsetY`. Tools
cannot mix the spaces without going through it.

`pagePointFromClient` returns **`null` for any point not on a page** — the gap
between pages as well as past the ends of the stack. Callers that must
distinguish (selection rejecting clicks on background) consult `pageIndexAt`
rather than inferring it from a `null` coordinate. Conflating the two produces a
status bar that says "outside page" when the user is between pages.

`pageGap` is the viewport's to own, so the viewport also derives the stack extent
from `pageCount × pageHeight + (n−1) × gap`. Accepting a precomputed extent would
create two sources of truth for one value, and changing the gap would leave the
scroll extent silently stale — a bug M1 actually shipped and fixed.

#### Rulers are chrome, not document content

A `<canvas>` 2D surface is the right tool for tick marks and does not violate the
CSS-backbone rule, which governs how the *document* renders. Rulers are never
inside `.pages`, and a visual test asserts that. (Same for the grid fill and any
minimap.)

Rulers redraw from viewport state rather than tracking it incrementally, which
keeps them correct through zoom, pan and fit with no update logic. Tick spacing is
chosen in **document** px and converted for drawing; conflating the two spaces
puts ticks at the right count but the wrong positions at any zoom other than 1.

### 3.8 Rendering the editor UI in the overlay

All selection affordances are drawn into the overlay in screen space:
selection outlines (1px, `devicePixelRatio`-aware), 8 resize handles + 4 rotate
handles, rotation hotspots, hover outline, marquee rect, snap lines, distance
labels, baseline/column guides for text editing, and a transform preview ghost
during rotation/scale.

**As built in M2**, the overlay is `editor/viewport/overlay.ts` and a sibling of the
scroll container rather than a descendant. It renders from a plain input object —
outlines, marquee, snap lines, rotation handle, hover — with no incremental diffing,
because the amount of chrome is small and fixed.

Four consequences of it being screen space, all of which bit during implementation:

- **Positioning.** The layer is `position: absolute; inset: 0` inside a `.surface`
  wrapper, which is also what clips chrome to the document area. Positioning it
  against the window instead put selection outlines over the toolbar.
- **`pointer-events: none`.** The layer sits above the pages, so without this every
  click lands on chrome. All gesture listeners live on the viewport root.
- **Two coordinate systems.** Metrics hand back *client* points; children are
  positioned in *layer-local* ones. `Overlay.clientToLayer` does the subtraction once
  per frame rather than once per handle — and it is what makes handle hit-testing
  agree with the drawn chrome. Getting this wrong draws handles in one place and
  grabs them in another.
- **`toClientRect` is public.** The editor hit-tests handles against the *same*
  rectangle they were drawn from. A second, slightly different computation is exactly
  how a hit area drifts from its handle.

Implemented: selection outlines, 8 handles per selected object, a rotation handle,
hover outline, and the marquee. Not yet: snap lines (§3.6), distance labels, text
guides, and the transform ghost — `snapLines` is accepted by `OverlayInput` and
ignored, because §3.6's snapping is a later milestone and passing an empty array costs
nothing.

---

## 4. State management

### 4.1 Three stores, deliberately separate

| Store | Holds | In history? |
|---|---|---|
| `DocStore` | the document, immutable root | **yes** |
| `EditorStore` | selection, mode, tool, viewport, overlay scratch, prefs | no |
| `UiStore` | panel layout, expanded sections, inspector tab, dialogs | no |

Mixing these is the most common source of "why did undo restore my scroll
position" bugs. The separation is the point.

**As built in M2**, the split is real but only two of the three exist yet.
`DocStore` is `editor/store/doc-store.ts` and owns the document, the history, and the
single write path. Selection, mode and the in-flight gesture live in `Editor`
(`editor/editor.ts`) rather than in a separate observable store — they are one
coherent object with one owner, and splitting them would have meant threading
subscriptions between two objects that always change together. The rule that matters
is the one that *is* enforced: **selection and viewport never enter a history entry**,
because §4.4 stores the document root and a command, nothing else.

`UiStore` does not exist. The inspector holds no state; it is rebuilt from the
selection and re-rendered on every change. Adding it before there is panel layout to
remember would be the "infrastructure for features that don't exist" mistake.

### 4.2 Document store and commands

```ts
type Command =
  | { type: 'setTransform'; ids: string[]; transform: Partial<Transform2D> }
  | { type: 'setProps';   ids: string[]; props: Record<string, unknown> }
  | { type: 'insert';     parentId: string; index: number; nodes: Node[] }
  | { type: 'remove';     ids: string[] }
  | { type: 'reorder';    id: string; toIndex: number }
  | { type: 'moveToPage'; ids: string[]; pageId: string; index: number }
  | { type: 'replaceText'; nodeId: string; text: RichText }
  | { type: 'setPage';    pageId: string; props: Partial<Page> }
  | { type: 'batch';      cmds: Command[]; label: string };

function apply(doc: DocState, cmd: Command): DocState;   // pure, total
```

* Every mutation — from tools, the inspector, menus, paste, or a future script
  API — is a command. This is what makes "no special cases" enforceable: there
  is no second path into the model.
* Because the model is immutable, `apply` is structurally shared (only touched
  paths are copied), which also makes change-detection and rendering cheap.

**As built**, `model/commands.ts` differs from the sketch in two ways, both forced
by the text session:

- `replaceText` became `setText`, and `insert`/`reorder` take a `pageId` — the model
  has no parent id, because `Page.objects` is a flat paint-ordered list per page.
- `moveToPage` does not exist yet; moving objects between pages needs a decision about
  cross-page selection and multi-select that has not been made.

M3 added two text commands, and the split between them is the whole point:

| Command | Scope | Changes | Why two and not one |
|---|---|---|---|
| `setText` | one frame | `text` | Whole-value. A diff/patch representation is the obvious improvement and is **rejected**: the browser hands over the entire content at session exit, so a diff would be computed from nothing rather than from an input. |
| `setTextStyle` | many frames | `style` (partial) | Frame typography. A `Partial`, for the same reason `setTransform` patches: "change the size" must not restate family, line height and colour. |
| `setTextAlign` | one frame | `align` on every block | Alignment is a **paragraph** property (§1.5), so a frame-level change rewrites every paragraph. A `batch` of these is one history entry for a multi-selection. |

`setText`'s no-op test must be **format-aware**: `{text:'abc', format:{bold:true}}` is
not equal to `{text:'abc'}`. `richTextEqual` compares structure rather than flattened
text, because two texts can have the same characters and different paragraphs — or the
same characters and different formatting.

The property that actually matters, and which §4.4 depends on: **`apply` returns the
same reference when the command changes no value.** Every branch compares
field-by-field to guarantee it. History treats reference identity as "nothing
happened", so a command that quietly rebuilt its page anyway would put an entry in the
undo stack for an action that did nothing.

### 4.3 Rendering pipeline

```
dispatch(cmd)
  → apply(doc, cmd)                        // pure
  → commit: bump version, notify DocStore subscribers
  → schedule microtask-coalesced render   // one pass per frame, not per command
       ├─ reconcile document DOM (keyed diff, style diffing)
       └─ repaint overlay from current editor + doc state
```

* Rendering is **coalesced per animation frame**. A gesture that dispatches 200
  commands per second causes 60 reconciles, not 200.
- Reads that must follow writes (text measurement, `scrollTo`, caret restore)
  happen in a single batched read phase after the DOM pass.

### 4.4 Undo / redo

Given immutable state, the simplest *correct* design wins:

```ts
interface HistoryEntry { before: Document; command: Command; label: string; }
```

* Snapshot-based, bounded (200 entries), storing only the root reference
  (structural sharing makes this cheap).
* **Transaction + coalescing policy**: a gesture opens a transaction
  (`begin(label, mergeKey)`) and closes it on pointer-up. Consecutive dispatches
  inside one transaction collapse into a single entry, so dragging a box yields
  one undo step, not four hundred. Changing `mergeKey` mid-transaction flushes the
  current entry and starts another, so two gestures are two steps even if a caller
  forgets to close in between.
* **Abort, not compensate.** A cancelled gesture rolls the document back to where
  the transaction began and discards whatever the transaction recorded. It does
  *not* dispatch the starting transforms as a compensating edit — `apply` compares
  by reference, so an out-and-back drag produces a document that equals the
  starting one without being it, and history would record a step that does
  nothing. See `History.abort`.
* **Undo restores the document, not the selection.** Restoring the selection would
  make undo jump the user's selection around underneath them. What it does instead
  is *prune* the selection: ids deleted by the undone operation are dropped, so the
  overlay never draws an outline for an object that no longer exists.
* **No-op commands record nothing.** `apply` returns the *same reference* when a
  command changes no value, and history treats that as "nothing happened". This is
  load-bearing rather than an optimisation: it is what stops a click that drags
  nothing from leaving an undo step. Every command type therefore compares
  field-by-field rather than rebuilding unconditionally.
* Migration path, if this ever bites: op-based entries recording
  `{ cmd, inverse }`. The command funnel means this swap is local to `history.ts`.

### 4.4.1 Two histories, composed by one rule

A text session (§10.3) means there are two undo stacks, not one:

| Stack | Owns | Lifetime |
|---|---|---|
| Browser's native undo | keystrokes *within* a session | one editing host, one session |
| `History` | everything else, including the session's exit commit | the document |

They compose across a boundary rather than merging, per
[ADR 0002](adr/0002-text-undo-composition.md):

> **While a text-editing session is active, the undo/redo action targets the
> session. Otherwise it targets the application history.**

Because a session's exit commits **one** `setText` command, undoing past the
boundary is correct with no extra bookkeeping — the whole edit reverts as one step,
which is what Figma and Illustrator do. This is the first place a mode changes a
command's *target* rather than only its input semantics, which is why §3.1's
mode/tool split had to be kept clean enough to route through one place.

### 4.4.2 Formatting composes with undo by the same rule

M3 added a second routed operation, and it needed no new machinery, because the
reason the first one works applies unchanged: **a text session is a transaction.**

| Action | Where it lands | History |
|---|---|---|
| `applyInlineFormat` **inside** a session | the browser's selection, via `execCommand` | part of the session's single `setText` entry |
| `applyInlineFormat` **outside** a session | every run in the frame, via `setText` | its own entry |
| `setTextStyle` / `setTextAlign` | always the model | its own entry |

Both paths go through `TextSessionController`, so a caller asks for "bold" without
knowing whether a session is open. Applied outside a session it toggles *every* run in
the frame, which makes "select a frame, press Bold" well defined rather than a no-op —
and toggling rather than setting is what makes a second press mean "remove", matching
what the browser does inside a session.

Formatting *state* has the same shape, with two sources: read from the browser while a
session is open (where the model is stale by definition) and from the model otherwise.
`TextSessionController.isFormatActive` owns that rule so no caller has to know it.

### 4.5 Derived state

Selectors are pure functions memoized on `(state, version)`; no ad-hoc
subscriptions to model internals from panels. Panels subscribe to *stores* and
read *selectors*.

---

## 5. UI architecture

### 5.1 Chrome layout

```
┌─────────────────────────────────────────────────────────────┐
│ top bar:  file | edit | object | text | view menus, zoom, doc name │
├────┬───────────────────────────────────────────┬────────────┤
│ T  │  rulers                                    │  Inspector │
│ o  │  ┌─────────────────────────────────────┐  │  ─────────  │
│ o  │  │            viewport                 │  │  Transform  │
│ l  │  │                                     │  │  Appearance │
│ b  │  └─────────────────────────────────────┘  │  Text       │
│ a  │                                           │  ─────────  │
│ r  │                                           │  Pages      │
├────┴───────────────────────────────────────────┴────────────┤
│ status bar:  zoom · cursor position · selection summary · snap toggles │
└─────────────────────────────────────────────────────────────┘
```

Panels: **Layers**, **Pages**, **Assets**, **Resources/Properties**, plus a
**Document** panel (page size, units, guides, grid).

### 5.2 The Inspector is schema-driven

This is the single most important UI decision for long-term maintainability.
Each object type contributes a **property schema**, and the inspector, context
menus, and (later) the style editor are all generated from it.

```ts
type FieldSchema =
  | { key:'x'|'y'|'width'|'height'|'rotation'; kind:'length'|'angle'; unit?:Unit; step:number; min?:number; max?:number }
  | { key:'opacity'; kind:'number'; min:0; max:1; step:0.01 }
  | { key:'blendMode'; kind:'enum'; options:(BlendMode|string)[] }
  | { key:'visible'|'locked'; kind:'toggle' }
  | { key:'fill'; kind:'paint' }
  | { key:'stroke'; kind:'stroke' }
  | { key:'text.fontSize'; kind:'length'; ... }
  | { key:'text.align'; kind:'enum'; ... };
```

Rendering rules:

* Fields are bound to a `get/set` pair over the selection, so **multi-select
  editing is automatic** — write the same key to every selected node.
* `commit` mode (drag the number, write on release) vs `live` mode (write on
  every input) is declared per field. Transform fields are live for dragging and
  committed for typed entry, which gives correct undo granularity without extra
  work.
* Mixed values across a multi-selection render as an empty field with a
  "multiple values" affordance — a detail that is free with schemas and painful
  with hand-written UI.
- Adding a new object type therefore ships **zero new inspector code**.

**As built in M2**, `ui/inspector.ts` is schema-driven from the start, with the
transform group (x, y, width, height, rotation) as the only section. Two rules that
proved their worth immediately:

- **Typed entry commits on blur or Enter, never on input.** Otherwise three
  keystrokes produce three undo steps, which is the single most common way an
  editor's undo system becomes unusable. Dragging is unaffected — it goes through the
  gesture path, not this one.
- **A bare number is read in the unit the field displays.** `parseLength('75')`
  returns 75 *pixels*, but a field showing `30pt` must mean 75 *points*. Getting this
  wrong is a silent 25% error on a value the user can see they typed correctly.

Mixed values render as an empty field with a `Mixed` placeholder, computed by the
`commonFrame` selector in `editor/selection.ts`, which reports differing values as
`null` rather than picking an arbitrary member's value.

**M3 added the Text section**, shown only when *every* selected object is a text frame
— a section that half-applies is worse than no section. It is schema-driven on the
same principle, and the fourth property cost one entry rather than a fourth block of
imperative code:

| Field | Kind | Note |
|---|---|---|
| Size | `length` | read and written in the **displayed unit** (the rule above). `30` in a `pt` document is 30pt = 40px. |
| Line | `ratio` | unitless: a length stops meaning the same thing the moment the size changes. |
| Track | `ratio` | in `em`, so letter spacing scales with the size it belongs to. |
| Colour | `colour` | any CSS colour string, passed through verbatim — `hsl()`, `oklch()` and named colours are all legal, so validation only rejects an empty field. |
| Align | segmented | an enumeration with four values and no free text. One `batch` of `setTextAlign`, so a multi-selection is a single undo step. |
| B / I / U / S | toggles | routed through `TextSessionController` (§4.4.2). |

Three decisions in there are worth stating:

- **The section is built eagerly and hidden, never created on demand.** A panel that
  adds and removes DOM on selection change loses focus, and losing focus while typing a
  font size is the worst possible moment to lose it.
- **The format toggles exist for discoverability as much as function.** Ctrl+B works,
  but only once the caret is inside a frame, and a user with nothing to click has no
  way to find that out.
- **Pressed state comes from one rule, two sources** (§4.4.2), so a toggle inside a
  session — which changes only the DOM and fires no store notification — still updates.
  That is why `Editor.refresh()` exists: a change that touches no model state needs the
  chrome re-read, and it goes through the existing callback rather than a second one.

**M5 added the Appearance section**, shown only when *every* selected object is a shape,
and driven by the registry rather than by conditionals:

| Field | Path | Kind | Note |
|---|---|---|---|
| Fill | `fill.color` | `colour` | **Hidden for a kind with no interior.** A line is painted by its stroke alone, so a fill field would be a control that cannot do anything |
| Stroke | `stroke.paint.color` | `colour` | Editing it on a stroke-less object creates the stroke from `creation.ts`'s defaults, so the two routes produce identical values |
| Weight | `stroke.width` | `length` | |
| Opacity | `ratio` | `ratio` | |
| *(kind-specific)* | from `shapeSpec(kind).properties` | | A rect's corner radius today. Adding one to the registry adds a field, with no edit to the inspector |

Four rules, each of which replaced something that was wrong first:

- **Nested writes go through a `batch` of one `setProps` per object.** `setProps`
  replaces a *top-level* key wholesale, so patching `stroke.width` from the first selected
  object's stroke would overwrite every other selected object's stroke width with it.
  Each patch is built from its own node, and `batch` collapses them into one history
  entry.
- **The patch carries a complete replacement for the top-level key.** An early version
  cloned `node.stroke.paint` and returned it under the key `stroke`, producing
  `{ stroke: { type, color } }` — silently discarding `width` and `align`, so a line lost
  its stroke width the moment its colour was edited. Found by asserting the *rendered* SVG
  attribute rather than the model.
- **A field declares whether it is `shared` or `kind`-specific.** Inferring this from
  `when: 'always'` meant a rectangle's corner radius was offered for an ellipse: a control
  that cannot do anything, in a panel whose whole promise is that its fields describe the
  selection.
- **`hidden` has to be restated in the stylesheet.** `.p1-inspector-field` sets
  `display: flex`, and any author `display` beats the UA's `[hidden] { display: none }` on
  specificity — so `row.hidden = true` left the row on screen and editable. The panel
  hides rows constantly, so this was never an edge case.

Inspector writes go through `store.mutate` and **never touch the DOM directly**, which is
what keeps ADR 0002's native undo grouping intact during a text session (ADR 0004 §2.6.1):
the panel does not write into a `contenteditable` subtree to stay visually synchronised.

### 5.3 Framework stance

**No UI framework for the document surface or the state layer.** The reconciler
(§2.3) and the stores (§4) are the framework here, and they are small because
the problem is narrow.

For panels, start with a ~100-line internal reactive helper
(`html`-tagged templates + per-panel re-render on store change) and a small
internal control kit (`NumberField` with unit parsing/formatting, `ColorField`,
`Select`, `Toggle`, `Segmented`, `FontPicker`, `PathField`). Panels are small,
mostly static, and cheap to re-render wholesale.

**Revisit point:** if panel complexity outgrows the internal helper — nested
lists, virtualization, complex focus management — adopt **Preact for the chrome
only**, keeping the viewport, reconciler, and stores framework-free. The boundary
is drawn so that this swap touches only `src/ui/`. I am deliberately not
adopting a framework now: it would add a build dependency and a second rendering
mental model for zero present benefit, and the panels are not the hard part.

### 5.4 UI ⟂ document

* Panels **never** import from `render/` or `editor/tools/`. They import stores,
  selectors, commands, and schema types.
* No panel holds document data. If a panel needs to remember something, it is
  UI state in `UiStore` or document state on a node.

**As built in M2**, `ui/inspector.ts` does import `DocStore` and `Editor` directly
rather than going through a `UiStore`, for the reason above: it holds no state. It
renders from the selection and reads the document only to commit a command. The rule
that matters is respected — it cannot mutate the document except by dispatching a
`Command`, which is the same guarantee the architectural rule was reaching for.
- Modal flows (new document, export, preferences) are dialogs that dispatch
  commands or call `persist/`.

---

## 6. Persistence

> **Implemented in M7.** The decisions are
> [ADR 0007](adr/0007-persistent-document-format.md); this section is the reference for the
> format as it exists, and ADR 0007 §11 records what changed from the sketch this section
> originally carried.

### 6.1 Format

A single JSON document (`.p1doc`), human-readable, diff-friendly, and **deterministic**: two
equivalent documents serialise to identical bytes. The full schema is ADR 0007 §2; the shape
is `Document` plus a `format` marker, canonically ordered.

```
src/persist/format.ts        # the vocabulary: constants, key lists, validation primitives
src/persist/serialize.ts     # document -> canonical persisted value
src/persist/deserialize.ts   # persisted value -> Document, or a refusal naming a path
```

`persist/` imports `model/` and `core/` and **nothing above them**. There is no DOM in scope,
so "the format is not the rendered HTML" is an enforced property rather than a convention: the
renderer is never asked to serialise, and the model is never reconstructed from markup.

- **Units:** all geometry serialised in document px (stable, unambiguous); page size
  additionally in its physical unit, so "A4" survives a round trip. `px` is *not* a valid page
  unit — the field is a physical unit precisely so print size is defined.
- **Assets:** `Document.assets`, keyed by an opaque `AssetId` (ADR 0006), each carrying its
  mime, intrinsic size and bytes as `{ inline }` or `{ external }`. Inline base64 data URLs by
  default, for single-file portability. **Orphans are preserved** and distinct ids holding
  equal bytes are both kept — deduplication is not this milestone's job, and silently merging
  two records would change two nodes' `asset` fields.
- **`extensions`** on a node survives round-trips untouched. It is the one declared opaque
  bag, and it is **node-level only** — see ADR 0007 §4 for why a document-level one would be
  surface invented for a build that does not exist.
- **Absent stays absent.** An unauthored optional is never materialised with a default, because
  `{ fit: 'fill' }` and `{}` render identically but are *authored* differently.
- No compression or zip in v1 (readability wins); a zip container is a later, additive option.

Determinism is a property of the code rather than a hope. Every object is rebuilt field by
field in a declared order before `JSON.stringify` sees it; `assets` keys are sorted; arrays
keep their order, because object order *is* paint order. Two tests hold this: a golden file is
byte-compared against what the serialiser emits, and a second fixture is generated by reversing
object key order at every depth, which no single test could otherwise pin down.

### 6.2 Versioning and migrations

```ts
const CURRENT_FORMAT_VERSION = 1;
// a Migrator table slots in here, dispatching on the version before anything else is read
```

- `format` then `formatVersion` at the top level. A file from a **newer** version is refused
  with a message naming both versions — never silently downgraded. A file from an **older**
  version gets a *different* message, because the user needs a different action.
- **No migrations exist, and none are built.** A migration framework with no migrations is
  speculative infrastructure, and the milestone brief forbade building more than the minimum.
  What is built is the contract a migration will slot into: a version constant, a parser that
  dispatches on the version *before* validating anything else, and two refusals that say what
  happened.
- **Undeclared keys are refused**, with their path. Silently dropping one would let a document
  look fine after a round trip while having quietly lost authored state. The consequence is a
  constraint on future work: a new authored property is either a version bump plus a schema
  entry, or it goes in a node's `extensions`. There is no third option.
- An unknown object `type` or shape `kind` is **refused**, preserving ADR 0003's rule that an
  unrecognised kind must not render as an empty object.
- **No repair.** The parser is total: it returns a `Document` or throws a `DocumentParseError`
  naming the offending path. This is a deliberate departure from the original sketch's "repair
  path that collects rather than throws"; ADR 0007 §5 gives the reasoning.
- Golden-file tests: `tests/golden/sample.p1doc` is byte-compared against what the serialiser
  emits, so a field added to the canonicaliser without being added to the parser fails the
  test rather than passing quietly.

### 6.3 Storage

- **Local files only, and only via download and upload.** Save is a Blob, an object URL and a
  synthetic `<a download>` click; open is a hidden `<input type="file">` whose `change` event
  `app.ts` owns. The File System Access API is deliberately **not** used — ADR 0007 §10 gives
  three reasons, the sharpest being that FSA needs a document handle that survives a reload,
  and this build persists no handles.
- **Dirty state is a derived read**, not stored state: `!documentsEqual(current, saved)`.
  Canonical authored state only — not the DOM, the viewport, the selection, a pending
  measurement, an asset's load state, or an open text session. It therefore cannot disagree
  with the document, and `edit → save → edit → undo` is clean with no bookkeeping.
- **Saving ends an open text session first**, because the browser owns the editable subtree
  and the model's text is stale for exactly as long as the session is. This is the text fence
  (ADR 0001) applied at save time, and it reuses the same exit <kbd>Esc</kbd> takes rather
  than inventing a mechanism.
- **Opening never waits for an image to decode.** `parse` is synchronous and pure, so the
  document becomes authoritative first and the renderer assigns `src` afterwards. A document
  with a broken image therefore opens instantly behind a marked placeholder, and **loading can
  only fail because the document is malformed** — a genuinely useful property, and one worth
  stating.
- **Opening replaces the document and clears history**, because history entries hold
  `Document` snapshots and an undo stack spanning two documents would make undo jump between
  them.
- *Not implemented:* autosave to IndexedDB, crash recovery, FSA save-in-place, a document
  handle, and `external` resolution. Autosave would make `New`'s confirm prompt wrong; a
  handle has nothing to attach to until session state is persisted.

### 6.4 Import / export roadmap


* **PDF** - **done (M19).** Browser print against a print profile (`@page { size: <exact>; margin: 0 }`,
  `print-color-adjust: exact`). See [ADR 0018](adr/0018-print-profile-and-pdf-export.md).

* **SVG** — export from the model (we own the geometry), not by scraping DOM.
* **PNG/JPEG** — rasterization needs research; candidates are printing to a
  canvas-backed path or `SVG foreignObject`. Spiked at M12, not assumed.
* **Import** — PDF import is a large project (outline it separately); SVG and
  EPS-ish vector import are tractable from the model side; image import is
  trivial (resource insertion).
* Clipboard: internal clipboard uses our own JSON payload; foreign content is
  adapted through `ClipboardAdapter`s registered in a registry.

---

## 7. Extensibility

### 7.1 Registries

Everything extensible is a registry keyed by string id, resolved through
`core/registry.ts` with duplicate-id and missing-id diagnostics in dev:

`ObjectTypeRegistry` · `ToolRegistry` · `InspectorSchemaRegistry` ·
`StyleRegistry` · `MigratorRegistry` · `ClipboardAdapterRegistry` ·
`ExportFormatRegistry` · `ResourceHandlerRegistry`

### 7.2 Adding an object type

Three touchpoints, no core edits:

```ts
defineObjectType({
  type: 'star',
  schema: s => s.object({ /* fields */ }),                 // validation
  defaults: (): ShapeNode => ({ … }),
  render: { create, update },                               // DOM projection
  inspector: { group: 'Shape', fields: [ /* … */ ] },       // generated UI
  hitTest: (node, pt) => pointInPolygon(pt, starPoints(node)),// accurate picking
  serialize: (node) => ({ … }),                             // optional override
  deserialize: (raw) => ({ … }),
  toCSS?: (node, env) => CssRules,                          // optional stylesheet hook
});
```

The core contains **no** `if (type === 'image')`. This is the concrete meaning
of "no giant collection of special cases", and it is enforceable with a lint
rule banning string comparisons against type ids outside the registry.

**As built (M5), the registry is real but split by key, because there are two keys.**
A sketch with one `defineObjectType` implies hit testing, rendering and inspector fields
all arrive together; in practice the three have different layer constraints, and conflating
them is what produces `if (type === ...)` chains:

| Registry | Key | Lives in | Holds |
|---|---|---|---|
| `ObjectTypeRegistry` | `node.type` | `render/reconciler.ts` | one `ObjectRenderer` per node type |
| `SPECS` (`ShapeKindSpec`) | `shape.kind` | `model/shapes.ts` | hit-test predicate, inspector `properties`, `hasInterior`, `needsExtent` |
| `PROJECTORS` | `shape.kind` | `render/types/shape.ts` | the CSS/SVG projection |

Three rules, each enforced rather than documented:

- **The shape registry lives in `model/`**, because it holds pure geometry about the model
  and all three of `render/`, `editor/` and `ui/` need to read it — `model/` being the only
  layer all three may import. The layer rule caught a violation of exactly this during M5:
  "does this kind have an interior" was first filed in `render/`, where `model/` may not
  import from.
- **Rendering is *not* in the shape registry.** A projection needs `HTMLElement`, and
  `model/` may not touch the DOM. It is a `Record<ShapeKind, Projector>` instead — a keyed
  map rather than a `switch`, but with the same compile-time exhaustiveness: adding a kind
  is a type error until its projector exists.
- **Inspector properties are declared as data in the registry**, addressed by a dotted
  *path* into the node (`fill.color`, `stroke.width`, `shape.cornerRadius`) rather than a
  getter/setter pair. A getter would have to be invoked per node per field and the
  "do they all agree across the selection" question would be written once per property.

### 7.3 Adding a tool

Implement `Tool`, register it, bind a shortcut. Tools compose shared services
(`snap`, `overlay`, `gesture`), so new gestures are tens of lines.

**As built (M5), a tool is a mode and the creation gesture reuses the marquee.** The
draw tool is `EditorMode = 'draw'` plus a `drawKind`, rather than a second parallel state,
so "what does the next click do" has one answer. Creation produces a single `insert`
through `store.mutate` — there is no special mutation path for drawing — and its drag
preview is the *same* overlay rect as a selection marquee, because a create preview and a
marquee are the same affordance and two rects would be two places for the overlay's
geometry to disagree with the gesture's.

### 7.4 Evolution-friendly model decisions

* `styles` (named text/paragraph/object styles with a `styleId` reference on
  nodes) is **reserved now, implemented at M10** — adding it later touches only
  the resolution layer because the field already exists.
* `extensions` bags exist on nodes and the document for third-party data.
* Commands are data, so a future scripting/batch API needs no new mutation path.
* Storing *derived* data is forbidden: if it can be computed from the model, it
  is computed. Otherwise format migrations accumulate forever.

### 7.5 Process

* Short ADRs in `docs/adr/` for decisions that are expensive to reverse (units,
  immutability, overlay space, text-edit fencing).
* Feature flags for in-progress capabilities, so the main branch stays usable.
* A `CHANGELOG` discipline for format changes: every `formatVersion` bump ships
  its migrator in the same commit.

---

## 8. Project structure

```
p1/
├─ docs/
│  ├─ ARCHITECTURE.md            # this document
│  └─ adr/                       # one file per expensive-to-reverse decision (0001-0018; 0015 skipped)
├─ assets/                       # icon.svg, checked in and referenced from index.html
├─ scripts/                      # mutation-check.ps1 + mutations.ps1 (the corpus), golden-asset generator
├─ src/
│  ├─ core/                      # NO app imports. Pure, dependency-free.
│  │  ├─ geom/                   # affine.ts, linear-part.ts, mat2d.ts, rect.ts
│  │  ├─ units/                  # units.ts — unit parsing/formatting/conversion
│  │  └─ ids.ts                  # id generation + validation
│  ├─ model/                     # imports core only. ZERO DOM references.
│  │  ├─ types.ts                # Document, Page, BaseNode, all node types
│  │  ├─ tree.ts                 # the single recursive traversal (placementOf, nodeById, placementsInDocument)
│  │  ├─ commands.ts             # Command union + pure apply() + isNoop + describeCommand
│  │  ├─ shapes.ts               # the shape-kind registry: hit test + inspector props
│  │  ├─ creation.ts             # creation geometry; the only place defaults are decided
│  │  ├─ assets.ts               # asset rules, the four load states, referencedAssetIds/orphanAssetIds
│  │  ├─ arrange.ts              # alignment + distribution (M16); arrangement targets honour visibility
│  │  ├─ snap.ts                 # the pure snapping engine (M17): candidates, threshold, translateBounds
│  │  ├─ transform.ts            # Transform2D and the shear predicate
│  │  ├─ document-equality.ts    # canonical equality, used by dirty state
│  │  ├─ page.ts                 # page geometry, pageExtentPx — shared by the viewport and print
│  │  ├─ factory.ts, invariants.ts, rich-text.ts
│  ├─ render/                    # imports model, core. Owns ALL DOM for documents.
│  │  ├─ reconciler.ts           # keyed children diff, style patch cache
│  │  ├─ document-view.ts        # node -> DOM projection; propagates visible:false down a hidden group
│  │  ├─ dom-style.ts, paint.ts, num.ts, measure.ts, render-context.ts
│  │  ├─ assets.ts               # id -> src resolution; decode-on-import
│  │  ├─ rich-text-html.ts       # RichText -> HTML for the production text model
│  │  ├─ layers/page.ts
│  │  └─ types/                  # object-type renderers: shape, image, text-frame
│  ├─ editor/                    # imports model, render, core
│  │  ├─ editor.ts               # the gesture/command controller — the largest file, deliberately
│  │  ├─ selection.ts            # hit testing, isEffectivelyVisible, modelFrameUnion, paintedBounds
│  │  ├─ transform.ts            # resize/rotate maths (and the unused scaleTransforms landmine)
│  │  ├─ history.ts              # transactions, coalescing, undo/redo
│  │  ├─ measure.ts
│  │  ├─ store/doc-store.ts      # the command funnel boundary
│  │  ├─ viewport/               # viewport.ts, overlay.ts (screen-space overlay), clamp.ts
│  │  └─ text-edit/              # text-edit-session.ts, text-session-controller.ts — the fenced zone
│  ├─ ui/                        # imports editor, model, core, persist. No render/ internals.
│  │  ├─ app.ts                  # composition root — the one deliberate ui/ -> render/ edge
│  │  ├─ inspector.ts            # schema-driven field rendering
│  │  ├─ persistence.ts          # file gateway + saved-baseline/dirty-state rules
│  │  ├─ print-profile.ts        # the @page rule and window.print() (M19)
│  │  ├─ boot-diagnostics.ts
│  │  └─ chrome/                 # editing-shortcuts.ts, shortcuts.ts, ruler.ts (+ styles.css)
│  ├─ persist/                   # imports model, core. A leaf: no DOM, no editor, no ui.
│  │  ├─ format.ts               # the vocabulary: constants, key lists, validation
│  │  ├─ serialize.ts            # document -> canonical persisted value
│  │  └─ deserialize.ts          # persisted value -> document, or a refusal naming a path
│  └─ spike/                     # throwaway text-editing research (ADR 0001); excluded from the bundle
├─ tests/
│  ├─ editor/                    # 40 files: interaction, geometry, snapping, layers, print, …
│  ├─ persist/                   # format, validation, session, group persistence, golden round-trip
│  ├─ spike/                     # text-editing spike specs (the known __spike flake lives here)
│  ├─ visual/                    # Playwright screenshot diffs + the shared harness
│  └─ golden/                    # .p1doc fixtures, byte-compared (-text in .gitattributes)
└─ index.html, spike.html, vite.config.ts, playwright.config.ts, eslint.config.js, tsconfig.json
```

**This section previously described a target structure rather than the built one**, and the two had
diverged for several milestones. The list below is what the original plan called for and does not exist
yet, recorded here so the intent is not lost and so nobody goes looking for it:

| Planned | State |
|---|---|
| `fixtures/` (golden files per format version) | superseded by `tests/golden/` |
| `tests/unit/`, `tests/e2e/` | never created; unit specs live beside the code as `src/**/*.test.ts`, browser specs under `tests/` |
| `benchmarks/` | not started |
| `docs/guides/` | not started |
| `src/platform/` (env detection, feature flags) | not needed so far; capability checks are local |
| `src/core/immutable.ts`, `events.ts`, `registry.ts`, `result.ts` | folded into the modules that needed them |
| `src/model/schema.ts`, `selectors.ts` | schema language and memoised reads were not needed; the inspector is schema-driven from `shapes.ts` |
| `src/editor/clipboard.ts`, `commands-registry.ts`, `tools/`, `interaction/`, `snapping/`, `guides/`, `overlay/` | not created as directories; snapping is `src/model/snap.ts` and the gesture pipeline is `src/editor/editor.ts` |
| `src/render/style-sheet.ts`, `dom-pool.ts`, `text-measure.ts`, `export/` | superseded by `document-view.ts` + `dom-style.ts`; `export/` became `src/ui/print-profile.ts` |
| `src/ui/panels/`, `controls/`, `dialogs/`, `reactive.ts` | not created; the inspector is one file and the chrome is three |
| `src/persist/migrations/`, `storage/`, `document-service.ts` | still owed — no migrations, no autosave, no IndexedDB (§8.2, ADR 0007) |

### 8.1 Dependency rule (enforced)

```
platform → ui → editor → render → model → core
              ↘ persist ↗
```

* `model/` and `core/` may **never** import from `render/`, `editor/`, `ui/`, or
  reference `HTMLElement`, `document`, `window`, or any DOM type. This is the
  mechanical guarantee behind "the DOM is a projection".
* `render/` may not import from `editor/` or `ui/`.
* `ui/` may not import `render/` internals — **with one deliberate exception: the
  composition root** (`ui/app.ts`), whose entire job is to construct the render
  and editor layers and hand them to the shell. Every other `ui/` module goes
  through stores, selectors and commands.
* **`persist/` is a leaf beside `model/`, not a stage above `ui/`.** It imports `model/`
  and `core/` and nothing else, so the format cannot see the DOM. Exactly one edge
  reaches it, `ui/ → persist/`, and only from the file boundary — a gateway that
  could not reach the format would have to reimplement serialisation, which is the
  "every layer knows how to save its own state" outcome this rule exists to prevent.
  The inverse edge stays closed: `persist/` may not import `ui/`, and if the *editor*
  ever needs to serialise, that is a signal the seam is in the wrong place rather
  than a reason to widen the rule.
- Enforced in `eslint.config.js` via per-layer `no-restricted-imports` zones plus
  a `no-restricted-syntax` rule banning DOM type references in `core/` and
  `model/`, run in CI. Cheap, and it turns a convention into a build failure.

What the rule has caught, in order:

1. `render/` importing `editor/` — twice, once to reach the text fence and once to
   read selection state. Both were symptoms of the fence not having an owner, which
   is why `TextSessionController` exists (§10.3).
2. `model/commands.test.ts` importing `editor/history.ts` (M2). The test was correct
   and the *placement* was wrong; history's tests moved to `editor/history.test.ts`.

The second is the useful one: the rule does not only catch violations, it also
catches *tests* that have been written in the wrong layer. A boundary that only ever
fires on product code eventually gets worked around; one that also fires on tests
does not.

### 8.2 Testing strategy

* **Unit** (Vitest): geometry (incl. round-trip properties), units, commands,
  schema, migrations, snapping thresholds, history coalescing. `model/` and
  `core/` are pure, so these need no DOM. Reconciler behaviour that is
  structural rather than visual — element identity across renders, DOM order,
  the style-diff cache — is covered in `happy-dom`.
* **Visual** (Playwright): renders the real app and checks what only a browser can
  answer — actual page dimensions, transform composition and `transform-origin`,
  `overflow: hidden` clipping, DOM paint order, and zoom. This is the regression
  net that protects the CSS projection layer.
* **E2E**: scripted gestures (select-drag-resize-undo) asserting model + DOM.
  Belongs to M2/M3, once there are gestures.
- **Benchmarks**: reconcile time for 100/1000/10000 nodes; live-drag frame time.

Two rules learned while building the visual suite, both of which produced a
*passing* test that verified nothing:

1. **A screenshot must be exactly the document.** Viewport decoration (the paper's
   drop shadow) belongs on the canvas, not the page, or it bleeds into captures.
   And `fullPage: true` combined with a clip silently pads out-of-document regions
   with white — the first `page-clip` baseline was entirely white and still green.
2. **Assert behaviour where possible, pixels where necessary.** The browser's own
   hit testing answers "is this clipped?" and "which object is on top?" exactly,
   in milliseconds; sampling screenshot pixels was both slower and weaker.

See `tests/visual/README.md` for the full set of traps and the reasoning.

**A third rule, learned the hard way in M5: a helper that sets up state must assert it.**
`measure.spec.ts`'s `selectFrame` clicked a point that was *outside* the frame it thought
it was selecting — outside only because the frame was rotated, and apparently selected only
because a zero-size marquee selected anything whose box contained the point. Twenty-two
tests passed on every run while measuring nothing they claimed to measure. The helper now
asserts the frame was selected, and its error message says which point failed and why.

The general form: **any test whose setup silently no-ops will pass.** Setup assertions are
not defensive padding; they are what makes the assertion after them mean anything.

**A fourth rule, learned in M7: a mutation is the only proof that a test can fail.**
The M6 suite had no negative controls — nothing verified that breaking a behaviour would fail
the test claiming it. `scripts/mutation-check.ps1` now breaks 112 behaviours one at a time,
asserts the relevant suite goes red, and restores the file; a mutation that no test notices is
reported as a failure. Three gaps it found, all of which were green:

* `canonicalTransform` written as `{ ...transform }` rather than field by field. The
  golden file's byte-identity test could not catch it, because the parser hands it keys that
  are *already* in canonical order. Fixed by a test that reverses key order at every depth.
* The `is clean after save, edit, and undo` test was passing without the save having
  happened: `save()` suspends at its `await`, and the assertion ran before the baseline
  moved. Every other assertion in it was about undo alone.
* Two of the twenty mutations *at the time* were run through Vitest against `.spec.ts` files, which Vitest
  silently collects none of - so "no tests found" read as a pass. The harness now dispatches on
  file kind.

Run it with `& scripts\mutation-check.ps1`. It is slow — each mutation runs a suite, and a full
112-mutant run is roughly 16–25 minutes on the machine this was developed on — and it is
worth it: it is the only thing in the repository that can tell you a green suite means
something.

### 8.3 Fixture guards

`window.__P1_FIXTURE__` is an unchecked `() => Document` cast, so an injected fixture that is
*not* a valid document typechecks, runs, and renders. That is a hole, and M6 walked into it:
`Document.assets` became required and ~30 fixture literals were left untouched, which nothing
reported because the renderer happened to tolerate the missing field. M7 then read the asset
table on the render path — once per `refreshChrome`, on every pointer move — and every drag
threw. Ten suites failed, each pointing at its own test, with the cause a missing key in a
string in another file.

`tests/fixture-guards.test.ts` closes it structurally: every injected document literal must
carry `assets`, and the guard asserts it found any literals at all, so it cannot become a
vacuous no-op. A new fixture that omits a required field now fails at the fixture.

---

## 9. Rendering strategy

### 9.1 Where HTML/CSS is decisively the right tool

* **Typography.** Font fallback, shaping, kerning, ligatures, optical sizing,
  hyphenation, justification, CJK/Latin mixed line breaking, `ruby`, small
  caps, `font-variant-*`. A custom text engine would take years to approach this.
* **Text layout.** Wrapping, `columns`, `text-overflow: ellipsis`, `white-space`,
  `word-break`, `line-break`, `hanging-punctuation`, `direction`/bidi.
* **Geometry & transforms.** Subpixel-accurate layout, `transform: matrix()` with
  GPU-accelerated compositing, `transform-origin`, `perspective` if ever needed.
* **Clipping & masking.** `overflow`, `clip-path`, `mask-image`, `shape-outside`.
* **Paint.** Solid/linear/radial/conic gradients, `background-clip`,
  `border-image`, `box-shadow` (inset/outside), `outline`.
* **Effects & compositing.** `filter`, `backdrop-filter`, `mix-blend-mode`,
  `isolation`, `opacity`, `mix-blend` + `isolation` giving us Photoshop-class
  compositing semantics.
* **Text editing & a11y.** `contenteditable` provides caret, selection, IME,
  spellcheck, screen-reader semantics, and platform text services — all things we
  would otherwise have to build.
* **Printing.** Paged media, `@page`, print color adjustment — a direct route to
  high-fidelity PDF output.
* **Performance.** The browser's compositor and style engine are extremely well
  optimized; we get batching, layer management, and invalidation for free if we
  write styles surgically (§2.3).
* **Debuggability.** Inspectable DOM, working devtools, screenshotting, and
  `elementFromPoint` as a sanity check against our own hit-testing.

### 9.2 Where it is weak, and the pragmatic answer

Covered in detail in §2.7; the *pattern* to internalize:

| Weakness | Answer | Cost |
|---|---|---|
| In-session text editing makes the DOM temporarily authoritative | Fence it: one `TextEditSession`, `beforeinput` → model ops, normalize on exit | Highest-risk area; spike first |
| Blend modes scoped by stacking context | `isolation: isolate` per group; accept group-local blending | Documented limitation |
| Strokes outside the box | Ship inside/center now; SVG island later | Small |
| Arbitrary paint servers, text-on-path, per-glyph transforms | Scoped SVG island **object types** | Localized complexity |
| No object-exclusion text wrap | `shape-outside` for the common case; defer full exclusions | Deferred feature |
| Non-orthogonal / 3D transforms | Matrix override on the transform + our own geometry | Additive |
| CMYK / overprint / separations | Out of scope (RGB screen-first) | Explicit non-goal |
| Print fidelity quirks | Print profile stylesheet + headless print | Bounded |
| DOM scale limits | Page virtualization, `content-visibility`, decode budgets | Bounded |

**The rule:** CSS handles everything it can; irreducible gaps become a new
object type, a new paint kind, or a scoped island renderer — never a rewrite of
the backbone and never a canvas re-implementation of document rendering.

---

## 10. Development roadmap

Each milestone ends with something demonstrable and a green test suite.

| # | Milestone | Deliverable | Depends on |
|---|---|---|---|
| **M0** | Foundations | ✅ Repo + Vite + TS strict, ESLint boundary rules; `core/units`, `core/geom`; immutable model + invariants; **keyed reconciler** projecting a real document to the DOM; viewport with zoom/pan/fit; Playwright visual suite with baselines | — |
| **M1** | Viewport & pages | ✅ Scroll/pan container, zoom + anchored zoom + fit, page box with `overflow:hidden`, multi-page vertical stack with gaps, page background, rulers, status bar coordinates | M0 |
| **M2** | Selection & transform | ✅ Hit-testing, selection state, move/resize/rotate tools with modifier semantics, overlay handles, **undo/redo + transactions + command funnel**, inspector scaffold with transform fields | M1 |
| **M3** | Text frames | ✅ Production text model + canonical form, format-preserving normalizer on `contenteditable="true"`, paragraphs, soft breaks, alignment, bold/italic/underline/strike, frame typography, session integration, inspector Text section. **Deliberately not here: fit-to-text, auto-size, vertical align** — all need measurement (§2.6) or a fence re-test, and each is recorded as deferred with its reason (ADR 0003) | M2 |
| **M4** | Shapes & appearance | rect/ellipse/line/polygon, Paint + Stroke, corner radius, opacity, blend modes, shadows, effects; schema-driven inspector completion | M2, M3 |
| **M5** | ~~Hierarchy & layers~~ → delivered as **Graphical objects** | ✅ Delivered as shapes and appearance: rect/ellipse/line, `Paint` + `Stroke`, corner radius, opacity, blend modes, schema-driven inspector. The hierarchy half was split off — see [ADR 0008](adr/0008-multi-selection-and-grouping.md) §5 for why grouping was not the next increment. M6 became images. | M2, M3 |
| **M6** | Guides, grid, snapping | Rulers, persisted guides, grid, `SnapEngine` + smart guides + snap-line rendering, spacing guides. **Delivered as Images & resources**; guides and snapping are still owed | M2 |
| **M7** | Images & resources | ✅ Delivered as **Persistence**: a versioned, deterministic `.p1doc` format, a total validating parser, golden fixtures, download/upload save-load. Resource registry, image insertion, fit/crop, masks, an asset panel and IndexedDB blob storage are **still owed** | M0, M6 |
| **M8** | Multi-object editing | ✅ Multi-selection audited and found already complete; `restack` as a relative model command; layer-order commands in the chrome; mixed-aware `visible`/`locked`/`opacity`/`blendMode` in the Transform section. **Grouping and multi-object resize deliberately deferred** with proofs and preconditions — see [M8 notes](#m8-implementation-notes--multi-object-editing) and [ADR 0008](adr/0008-multi-selection-and-grouping.md) | M2, M7 |
| **M9** | Interaction integrity | ✅ An audit, not a feature. The interaction state machine written down and every exit path tested; **four false invariants found and fixed** (window blur did not end a gesture, an out-and-back gesture recorded an undo step, `data-oid` had three writers, `SelectionState.anchor` was a dead abstraction); model immutability proved by deep-freezing the input to every command — see [M9 notes](#m9-implementation-notes--interaction-integrity) and [ADR 0009](adr/0009-boundaries-audit.md) | M8 |
| ~~**M10**~~ | ~~Grouping~~ **Re-scoped by M10** | **Done as an investigation.** Both representations proved; neither built. The finding is that grouping and multi-object resize are *one* missing capability — a representable parent-child composition — so the next architectural question is the shear decision (ADR 0010 §7), not a group feature. M10 also corrected two ADR 0008 limitations and made the no-shear invariant a runtime check | M8, M9 |
| **M10b** | Affine transforms | **Done — refused.** The inventory found 28 assumption sites, 9 of which need nothing and 7 of which are representation-only; the other 7 are semantics, and they cluster in rotation, the selection frame, and the stroke. The candidate model is specified and proved in `src/core/geom/affine.ts`, and the extension is one field away — refused because it buys exactly one capability with no writer, and because the stroke decision has no cheap answer. **Decision: RESTRICT GROUPS** | ADR 0010, ADR 0008 |
| ~~**M11**~~ | ~~Persistence (the rest)~~ | **Re-scoped, not renamed.** The persistence *of groups* was done in M12: `formatVersion: 2`, version 1 still read, **no migration needed** — a version-1 document is a strict subset. What remains is autosave to IndexedDB, crash recovery, File System Access save-in-place, project folders for `{ external }`, asset garbage collection. Deferred because none of it is a prerequisite for anything now. | M0, M7 |
| **M12** | Group **model** | **Done - [ADR 0012](adr/0012-persistent-group-model.md).** `GroupNode`, group-local children, nesting, uniform-only group scale, `tree.ts`, `formatVersion: 2`. **No interaction built.** | ADR 0010, M11 |
| **M13** | Group **interaction** + page/object operations | **Partly delivered, as two milestones.** Group interaction shipped: `group`/`ungroup` gestures, selecting a group, group scope, group dragging — [ADR 0013](adr/0013-group-interaction.md). Alignment/distribution shipped as the delivered **M16** ([ADR 0016](adr/0016-alignment-and-distribution.md)) and snapping as the delivered **M17** ([ADR 0017](adr/0017-snapping-and-guides.md)). **Still owed:** duplicate, copy/paste (internal + foreign adapters), delete, layer panel | ADR 0012 §14, M5, M8 |
| **M13** | Styles | Named paragraph/character/object styles, `styleId` resolution, styles panel, apply/clear, "no style" handling | M3, M4 |
| **M14** | Page management & document setup | Add/duplicate/delete/reorder pages, per-page size & orientation, margins/columns, bleed marks, document dialog with live preview | M1, M8 |
| **M15** | Output | **Partly delivered as the M19 milestone**: print profile and PDF export via `window.print()` ([ADR 0018](adr/0018-print-profile-and-pdf-export.md), §6.4). **Still owed:** SVG export, page previews / print-preview panel | M8, M11 |
| **M16** | Import | SVG import, image import, HTML/rich-text paste normalization, basic PDF import spike | M9 |
| **M17** | Advanced | Text-on-path, tables, footnotes, variables, plugin API, scripting via the command bus, master pages, XML-ish tagging for export | M10b+ |

**A note on the numbering, because the two schemes now disagree.** This table is the *original plan*,
written before delivery, and it was never renumbered — which is correct, since rewriting history to match
outcomes would destroy the record of what was intended. The *delivered* milestones reused the same labels
for different work: plan-M14 (page management) and plan-M15 (output) are still owed, while the delivered
M14 was asset garbage collection and the delivered M19 was print/PDF export. Where this document means the
plan it says "plan-M…"; everywhere else, and in the Status table and the ADRs, M-numbers are the delivered
ones. Two rows also changed meaning rather than just falling behind: plan-M6 (guides, grid, snapping) was delivered as images in M6; its snapping half shipped as the delivered
M17, but only **transient, screen-space guides** — persisted guides and the grid are still owed. Plan-M7 was
delivered as persistence with its resource half (registry, asset panel, IndexedDB blob storage) still owed.

### 10.1 Ordering rationale

* **M0 before anything.** The reconciler, unit system, and command funnel are the
  three decisions that everything else would have to be rewritten around. Getting
  them right first is the whole point of starting with a plan.
* **M2 before M3.** Text editing depends on selection, transactions, and undo.
  Building text first would mean building them badly, under pressure.
* **The text spike was deliberately done before M2/M3.** It is the one place where
  the chosen architecture was genuinely at risk, and the answer was that the fence
  holds — which unblocks M3. The spike did surface a *new* risk (undo/redo inside a
  session, §10.4), which M2 then settled by measurement rather than preference
  ([ADR 0002](adr/0002-text-undo-composition.md)). Sequencing it this way meant the
  question was answered with a browser to hand, instead of being decided by omission
  later.
* **Persistence at M8, not M1.** The format is designed in M0 and validated by
  golden fixtures throughout, but wiring storage before the model stops changing
  weekly would be wasted work. The *schema* discipline starts immediately.
* **M6 (snapping) after M5 (groups)** because candidate generation depends on
  resolved world-space bounds of nested nodes.
* **Advanced features last** — they are all expressible in the model we will
  already have.

### 10.2 Do first, deliberately

1. Unit/geometry core with property tests. ✅ *done in M0*
2. Immutable model + command funnel + history. *(Cheap now, priceless later. M0
   has the immutable model; the command funnel lands with M2's undo.)*
3. Keyed reconciler with style-diff cache, driven by a fixture document. ✅ *done in M0*
4. Visual regression harness. *(Protects everything that follows. Done — see
   `tests/visual/`.)*
5. Text-editing spike. ✅ *done — the fence holds. See [ADR 0001](adr/0001-text-editing-fence.md).*

---

### 10.3 Text editing — RESOLVED

**Status: complete.** The spike ran and the architecture holds. See
[ADR 0001](adr/0001-text-editing-fence.md) for the full result, the session
boundary, the synchronization rules, and the limitations.

Short version: `contenteditable` **can** be fenced. The DOM remains a disposable
projection of the model, with exactly one element excluded for the duration of an
explicit editing session. The exclusion is content-scoped, so geometry and
visibility still render during a session. Re-rendering mid-edit preserves the text
*and the caret* — the payoff that makes the whole approach worthwhile.

Two corrections to this document followed from the experiment:

- §2.7's `TextEditSession` is now a validated mechanism rather than a hypothesis.
- §1.5's `<p>`-per-block mapping does **not** survive an editing session *in
  `plaintext-only`*: Chromium inserts a literal `\n` inside the existing `<p>`.
  `white-space: pre-wrap` is therefore load-bearing, not cosmetic.

The second correction was later **narrowed**, and §1.5 as built reflects the narrower
claim. See §10.5.

### 10.4 Undo/redo inside a text session — RESOLVED

**Status: complete.** See [ADR 0002](adr/0002-text-undo-composition.md) for the
measurements, the options, and the reasoning.

The question was: **during a text-editing session, does undo come from the browser
or from the editor?** It is answered by *both*, with one line deciding which:
while a session is active, undo targets the session; otherwise it targets the
application history (§4.4.1).

The decision rests on measurements rather than preference. In Chromium:

| Question | Measured |
|---|---|
| Does `beforeinput` fire for native undo? | Yes, `inputType: 'historyUndo'` |
| Is it cancelable? | **Yes** — so intercepting is technically possible |
| Does `input` also fire, after the DOM changes? | Yes |
| Does `preventDefault()` suppress it? | **Yes** |
| Can the app drive native undo? | **Yes** — `execCommand('undo')` |
| Does native redo survive leaving the session? | **No** |
| How does the browser group keystrokes? | Three keystrokes became *one* undo unit |
| What happens when the stack is exhausted? | `historyUndo` fires, nothing changes |

Rows 2, 4 and 5 mean browser undo is fully interceptable *and* fully drivable, so
this was a choice, not a constraint. Taking it over was rejected because grouping
(measurement 7), IME composition undo, autocorrect and spellcheck replacement all
feed the same stack, and reimplementing them is a bad trade — the spike had already
established that composition works natively. Delegation buys the important part of a
single stack (working undo buttons, correct labels) without touching any of it.

Two costs are accepted rather than hidden, and are listed in the ADR's
consequences: **native redo does not survive the session**, and **undo labels during
a session are session-granular** ("Undo text").

Verified by `tests/editor/history.spec.ts` (composition, end to end in Chromium) and
`src/editor/text-edit/text-session-controller.test.ts` (the rule, with the native
call injected). The browser's own behaviour is pinned by
`tests/spike/undo-probe.spec.ts`, which is retained as executable documentation of
the measurements the decision rests on.


### 10.5 The production text model — RESOLVED

**Status: complete.** See [ADR 0003](adr/0003-production-text-model.md) for the design,
the measurements it rests on, and the full model.

M3 asked whether the ADR 0001 fence could carry a real content model. It could — but
not in the mode ADR 0001 measured, and finding that out changed the design rather than
adjusting it.

The question was settled by measurement before anything was designed:

| | `plaintext-only` | `contenteditable="true"` |
|---|---|---|
| `execCommand('bold')` returns | **`false`** | `true` |
| Ctrl+B produces markup | **nothing** | `<b>…</b>` |
| `queryCommandState('bold')` | always `false` | correct |
| Enter produces | `\n` inside the existing `<p>` | **a real `<p>`** |
| Markup emitted | — | semantic tags, not `<span style>` |
| `justifyLeft`/`Center`/`Full` | — | work; emit `style="text-align:…"` |

`plaintext-only` **cannot** produce character formatting at all. Not awkwardly — none.
So the fence as validated was incompatible with the feature, and the choice was
between dropping it or abandoning native formatting.

**`contenteditable="true"` was chosen**, with a format-preserving normalizer. Two
things made it cheaper than it sounds, and one made it *better*:

1. ADR 0001 finding 3 already recorded that `plaintext-only` "prevents most, *not
   all*, markup" — paste and programmatic insertion still bring `<b>`, `<div>`,
   `<font>` and `&nbsp;`. The format-preserving work was always required, only
   deferred.
2. The DOM the browser produces is **the DOM we produce**: semantic tags, canonical
   nesting, alignment as an inline style. The conversion is symmetric rather than
   merely invertible, which removes most of the round-trip bug surface.
3. Enter producing a real `<p>` **improves** the paragraph mapping. `\n` inside a
   paragraph is now unambiguously a *soft break*, where before it had to be guessed at.

**Consequences for the rest of this document**, all now as built:

- §1.5 carries `CharFormat`/`TextStyle`/`ParagraphAlign` rather than the original
  sketch, with a table of what was deferred and why.
- §1.5.1 new: text frames are not clipping boxes, and the editor's hit test
  deliberately disagrees with the browser's below a frame's bottom edge.
- §1.5.2 new: an empty paragraph needs a CSS minimum, because the renderer emits no
  `<br>`. ADR 0001 finding 4 became load-bearing.
- §4.4.2 new: character formatting composes with undo by ADR 0002's rule, because a
  session is a transaction.
- §2.6 is a **prerequisite**, not an optimisation: auto-size, columns and
  fit-to-content all need measurement, because the model deliberately holds no layout.

**One mode-dependent consequence, recorded rather than hidden.** The meaning of `\n`
inside a `<p>` depends on the mode: under `plaintext-only` it is a paragraph break
(Enter is the only source), under `contenteditable="true"` it is a soft break. The
model has one meaning and it is the production one. The spike pins `plaintext-only`
explicitly because it *measures* that mode, so its committed baseline now differs from
its pre-M3 recording by one paragraph's margin. Making the normalizer mode-aware would
mean a second conversion path for a mode no product code uses.

Verified by `src/render/rich-text-html.test.ts` (the round-trip property, exactly, over
a corpus including empty frames, whitespace-only frames, soft breaks, every flag and
every alignment), `tests/editor/text.spec.ts` (rendering, editing, formatting, history,
deferred writes in Chromium), and `tests/visual/typography.spec.ts`. The measurements
are pinned by `tests/spike/format-probe.spec.ts` and
`tests/spike/contenteditable-probe.spec.ts`, both retained as executable documentation
of ADR 0003's tables.


### 10.6 The measurement boundary - RESOLVED

**Status: complete.** See [ADR 0004](adr/0004-measurement-boundary.md) for the design,
the measurements it rests on, and the full rejected-API table.

ADR 0003 ended by naming a debt: every deferred text feature needs numbers the
document cannot hold. This milestone settled how the editor gets them, and replaced
§2.6's `TextMeasurer` sketch with it.

The short version, all measured in Chromium against the real application:

| Question | Answer |
|---|---|
| Which APIs are zoom-invariant? | `clientWidth/Height`, `scrollWidth/Height` — verified at four levels |
| Which are transform-invariant? | The same four. `getBoundingClientRect` under 30° rotation returns the *painted* bounding box, 198×143 for a 200×50 box |
| So does measurement need coordinate conversion? | **No.** Every value is already in document px. This is the load-bearing consequence |
| What about positions? | Deliberately not part of the contract. `Viewport`/`Overlay` own them |
| Is a synchronous read valid after a style write? | **Yes**, same task, no frame boundary |
| Does zoom invalidate a measurement? | **No** |
| What if the element is hidden? | Refuse: return `status: 'hidden'`, never `0` |
| What if the projection is behind the model? | Refuse: `status: 'stale'`, checked by comparing the DOM box to `transform.width/height` |
| Fractional sizes? | `ResizeObserver` only, and asynchronously. The integer APIs round: a 19.5px line height reports `20` |
| Is it valid mid-session? | **Yes**, and non-disturbing — but it observes the browser, not the model (§2.6.1) |
| Fonts? | `document.fonts.ready` is part of the contract as a promise, a no-op today. `document.fonts.check()` is unusable — it returns `true` for a family that does not exist |
| Line boxes? | **Not available.** `Range.getClientRects()` returns one rect per *inline fragment*: 8 rects for 4 lines, zero-width rects at soft breaks |
| Baselines? | **Not available.** `getBoxQuads()` is Firefox-only. Recorded, deliberately not built |

Two defects were found and fixed on the way, both consequences of the model's own
division of labour:

- **The document inherited typography from the editor chrome.** `body` declares
  `font: 13px/1.5 system-ui`, and `line-height` is a *number*, so it inherits as a
  factor — a text frame with no `TextStyle` rendered at **13px**, the toolbar's font
  (measured). That makes a document's layout depend on stylesheet it does not own,
  and every measurement conditional on it. `.p1-text-content` now declares its own
  `font-size: 16px` / `line-height: 1.2`.
- **Per-keystroke chrome refresh destroys native undo grouping** (§2.6.1). Found by
  wiring the session's `onDomChange` hook and watching Ctrl+Z go from one word to
  one character.

Auto-size is **not** implemented: the spike did not show it necessary to prove the
contract, and ADR 0004 records the three constraints it inherits instead.

### 10.7 Graphical objects - RESOLVED

**Status: complete.** See [ADR 0005](adr/0005-shape-geometry-contract.md) for the geometry
contract, the measurements it rests from, and the three claims that had to be amended once
the renderer existed.

The short version, all measured in Chromium against the real stylesheet:

| Question | Answer |
|---|---|
| What are `x/y/width/height`? | The **border box**, in page-local document px. `offsetWidth/Height` equals it exactly |
| Does a stroke expand the box? | **No** with `align: 'inside'` — it eats inward. `clientWidth` drops by 2× the stroke; `offsetWidth` does not move |
| Is stroke width geometry? | **No.** Authored, so in the model and undoable, but not in `transform`. It is the one visual property hit testing consults |
| What does resizing do to a stroke? | Nothing. Borders do not scale with `width` |
| What does rotation preserve? | The box's size, the stroke width, and the centre |
| Can a line be drawn in CSS? | **No.** `border` grows a zero-height box downward; `outline` paints nothing at all. Measured both |
| So how is a line drawn? | A scoped SVG `<line>` island — §2.8's escape hatch, for one shape kind, inside the object's own element |
| Is that a second rendering backend? | **No.** `rect` and `ellipse` are pure CSS. The island is the exception the measurements forced |
| Zero dimensions? | Valid and meaningful (a horizontal line). CSS agrees: it renders 0 |
| Negative dimensions? | **Impossible.** `width: -50px` computes to `0px`; the invariant rejects it; `resizeTransform` clamps |
| How is hit testing decided? | Per kind, through `model/shapes.ts`. **Never** `elementFromPoint` (§3.4) |
| Where does the editor disagree with the browser? | **Only a line with no stroke.** There is no ink, so there is no browser target; the editor still finds it |

Two registries, because there are two keys, and conflating them is what produces
`if (type === ...)` chains:

- **by `node.type`** — the existing `ObjectTypeRegistry` in `render/reconciler.ts`.
- **by `shape.kind`** — new, in `model/shapes.ts`, holding the hit-test predicate, the
  inspector properties, and whether the kind has an interior. It lives in `model/` because
  `render/`, `editor/` and `ui/` all need it and `model/` is the only layer all three may
  import. Rendering is *not* there — a projection needs `HTMLElement` — so
  `render/types/shape.ts` holds a `Record<ShapeKind, Projector>`, which TypeScript keeps
  exhaustively.

`ShapeGeometry` became a discriminated union (`{kind:'rect', cornerRadius} |
{kind:'ellipse'} | {kind:'line'}`). The previous sketch was a bag of optional fields, so
`{ kind: 'line', cornerRadius: 8 }` type-checked and meant nothing.

### 1.5.3 The image node

An image is the first object whose *content* the model does not own. Its geometry is the
same border box as everything else — that invariant is the point — and its content is
reached through an **id**, never a URL.

```ts
export type AssetId = string;             // opaque; nothing may parse or infer from it

export interface AssetRecord {
  readonly kind: 'image';
  readonly mime: string;
  readonly intrinsicWidth: number;        // metadata; never 0
  readonly intrinsicHeight: number;
  readonly data: { readonly inline: string } | { readonly external: string };
}

export interface ImageNode extends BaseNode {
  type: 'image';
  asset: AssetId;                         // an id, not a URL / File / Blob
  fit?: ImageFit;                         // 'fill' | 'contain' | 'cover' | 'none' | 'scale-down'
}
```

and the document owns the bytes:

```ts
export interface Document {
  /* … */
  assets: Record<AssetId, AssetRecord>;   // part of the model, so part of history
}
```

**Three rules carry the whole contract.**

1. **Identity is an id.** A `blob:` URL may be a runtime projection; it may never be an
   asset's identity. Nothing session-scoped is ever in the model — and `File`/`Blob` are
   ruled out for a second reason: they are not comparable by value, which is what both
   `isNoop` (§4.2) and `History` (§4.4) depend on.
2. **Bytes and intrinsic size live in the model; URLs live in `render/`.** Assets are in
   the document so undo can restore a deleted image *together with its bytes*.
3. **Intrinsic size is asset metadata, not measurement.** It is read once at import with
   `decode()`, which **rejects** on data that is not a decodable image — so a failed import
   never becomes an asset with size `0×0`. Because it is metadata rather than a layout
   read, placing an image needs no render pass and cannot produce a `stale` document.

`docs/adr/0006-image-asset-contract.md` has the measurements and the rejected
representations. **What is deliberately absent:** `object-position` (no observable effect
under the default `fill`), crop, non-rectangular frames, `external` resolution, and any
asset management UI.

**Load state is rendering output, never document state.** `idle | loading | loaded | error`
is derived from the `<img>` and published as `data-asset-state`; whether an asset *currently*
resolves is a fact about this browser session, not about the document. `error` exists
because `img.complete` is `true` for every failure (measured), so `naturalWidth > 0` is the
only success signal. A missing asset paints a marked placeholder and keeps its box;
`display: none` is reserved for `visible: false`, so the two can never be confused.

### 10.9 Images - RESOLVED

**Status: complete.** See [ADR 0006](adr/0006-image-asset-contract.md) for the asset and
geometry contracts, the measurements they rest on, and the four claims implementation had
to amend.

The short version, all measured in Chromium:

| Question | Answer |
|---|---|
| What does a reference mean? | An **`AssetId`**. A `blob:` URL may be a runtime projection; it may never be an asset's identity |
| Why not a `File`/`Blob` in the model? | Not comparable by value, which is what `isNoop` and `History` both rely on |
| Where do the bytes live? | `Document.assets`, in the model, so undo restores an image *and* its bytes |
| Where does intrinsic size come from? | `decode()` at import. **Asset metadata, not measurement** |
| What if the bytes are not an image? | `decode()` **rejects** with `EncodingError` — so a failed import never becomes a `0×0` asset |
| Is the box still the border box? | **Yes**, unchanged, and true whether the image loaded, failed or is rotated |
| Default placement size | The intrinsic size, scaled *uniformly* to fit the page. No measurement, no render pass |
| Is the aspect ratio preserved on resize? | Only while a gesture modifier holds it. **Not authored state** |
| Why not a stored lock? | CSS cannot express it (measured: explicit `width`/`height` beat `aspect-ratio`), and a persistent lock would silently change height the user never authored |
| Does `object-fit` move the box? | **No** — measured across all five values: identical `offset*` size and hit region |
| What is `object-position` for? | Nothing under the default `fit: fill`. **Absent**, and arrives with cropping |
| Is the browser alpha-aware for hit testing? | **No** — a fully transparent pixel is a hit. So a pixel-accurate editor would *disagree* with Chromium |
| How is an image selected? | By its **object geometry**, not its visible pixels |
| What does a failed asset look like? | A marked placeholder, its authored box, still selectable. `display: none` is reserved for `visible: false` |
| How is a failure *detected*? | `naturalWidth > 0`. `complete` is `true` for **every** failure, including no `src` at all |
| Do images need their own measurement API? | **No.** Rendered size is authored geometry; ADR 0004's contract already covers them |

### 10.10 Explicit non-goals for now

No canvas document rendering; no 3D; no CMYK/overprint; no collaborative editing;
no backend or accounts; no plugin marketplace; no multi-user presence; no
full object-exclusion text wrap.

**Graphical objects specifically** (each is a decision with a reason in
[ADR 0005](adr/0005-shape-geometry-contract.md)): no polygons, stars, paths or arbitrary
SVG authoring — `pointInPolygon` already exists in `core/geom`, but adding a path means a
point list in the model, a fourth predicate, and a fourth renderer; no stroke alignment other
than `inside` (`center` and `outside` **throw** rather than render something plausible);
no line direction or arrowheads; no gradients, patterns, shadows or blend modes beyond the
`blendMode` field's existing pass-through; no group transforms, snapping, guides or grids.

**Images specifically** ([ADR 0006](adr/0006-image-asset-contract.md)): no remote URLs as a
storage mechanism, no cloud assets, no filesystem sync, no asset deduplication, no image
editing, filters or masks, no alpha-aware hit testing (rejected on measurement), no
arbitrary clipping paths, no non-rectangular image frames, no asset management UI (library,
rename, replace, usage listing), no `external` resolution, and no export or print pipeline.
The only route in is "insert from a file" — the minimum that makes the contract real.

**Text specifically** (each is a decision with a reason in
[ADR 0003](adr/0003-production-text-model.md), not an oversight): no vertical
alignment, padding, columns, auto-size, linked frames, text-on-path or tables; no
inline colour or size in `CharFormat`; no headings or list block kinds (the `kind`
discriminator is kept so adding one is additive, and an unrecognised kind **throws**
rather than rendering an empty frame); no OpenType feature editing — those are
delegated to CSS entirely and have no model representation.

---

## Appendix A — Key decisions and rationale (ADR summary)

| Decision | Alternative rejected | Rationale |
|---|---|---|
| Immutable model | Mutable model + patch log | Trivial undo, trivial diffing, trivial reconcile; cost is disciplined copying |
| Commands only | Direct model mutation from tools/UI | One funnel makes undo/serialization/scripting free; prevents untracked state |
| Snapshot history | Op/inverse-log history | Simpler and correct today; command funnel keeps the migration local |
| Internal unit = px | Internal unit = mm/pt | Matches CSS exactly → no conversion layer between model and DOM |
| Page-local coords | Global document coords | Removes cross-page coordinate reasoning; matches page-based thinking |
| Tree order = z-order | Separate `zIndex` | Impossible to desynchronize; matches DOM/CSS reality |
| Own reconciler | React/Preact/Vue for the surface | Narrow problem, specialized needs (paint-order identity, style diffing); a framework adds a second rendering model |
| No UI framework now | Preact for panels | Panels are small; the internal helper suffices; boundary drawn so it can be adopted later |
| Overlay unscaled | Overlay inside the scale transform | Crisp strokes and constant-size handles; one helper absorbs the zoom multiply |
| Schema-driven inspector | Hand-written inspector per type | New types ship zero UI code; multi-select editing for free |
| JSON + migrations | Binary/protobuf, or schema-less JSON | Diffable and debuggable; migrations are the only real requirement for evolution |
| `extensions` bags | Strict closed schema | Preserves unknown data; makes third parties non-destructive |
| Page decoration on the canvas | Shadow on the page element | Keeps `[data-page]` screenshots pixel-exact to the document; the page box stays purely the document |
| Browser hit testing for clipping/stacking | Pixel-sampling screenshots | ~1ms instead of ~35s, and a stronger assertion: hit order *is* paint order, and `overflow` clips hit targets too |
| Zoom on the page *stack* | Transform per page | One CSS write for the whole document at any zoom; page geometry is never touched by zooming |
| Viewport owns the stack extent | Caller passes a precomputed size | Two sources of truth otherwise: changing the gap would leave the scroll extent stale (a bug M1 shipped and fixed) |
| Three coordinate spaces, conversions in one place | Ad-hoc maths per caller | A test mixing screen and document px produced plausible-but-wrong numbers; centralising made that a visible failure |
| Model hit testing for selection | `document.elementFromPoint` | Only the model knows `locked`, `visible` and object shape; during a text session the DOM answers about the browser, not the document |
| `apply` detects its own no-ops | Rebuild unconditionally, let history filter | History skips reference-identical results; a command that rebuilt anyway would put an undo step on every click |
| A cancelled gesture aborts its transaction | Compensating edit (re-dispatch the start) | An out-and-back drag equals the start by value but not by reference, so compensation records a step that does nothing |
| Undo does not restore selection | Snapshot `sel` with each entry | Restoring it moves the user's selection underneath them; pruning deleted ids is enough |
| Text undo: browser owns the session, editor owns the rest | Editor owns everything | Keystroke grouping, IME composition undo, autocorrect and spellcheck all feed the browser's stack; ADR 0002 measured all of it |
| One store subscription drives re-projection | Each caller remembers to re-render | The inspector changed the model with nothing subscribed — a divergence only undo exposed |
| `contenteditable="true"` for text frames | `plaintext-only`, validated by ADR 0001 | Measured: `plaintext-only` **cannot** produce character formatting — `execCommand('bold')` returns `false` and Ctrl+B produces nothing. It also *improves* the paragraph mapping, since Enter then produces a real `<p>` |
| Canonical form for rich text | Store runs as authored | Two run-sequences for one visual text means two documents that render identically and compare unequal; history would fill with no-op steps |
| Flags are `true` or absent | `boolean` | `false` gives "not bold" two encodings, which makes equality non-total and equality is what decides whether a command is a no-op |
| Soft break is `\n`, never `<br>` | Emit `<br>` for shifts | `white-space: pre-wrap` already renders `\n`; `<br>` in one direction and not the other is the doubling class of bug |
| Alignment per paragraph, no frame default | Frame default + per-paragraph overrides | One source of truth per property. "Which one wins" is a question every reader and writer would have to answer |
| Relative line height and letter spacing | px lengths | `1.2` and `0.02em` survive a size change; `19.2px` and `0.32px` silently stop meaning what they meant |
| Unknown block kind throws | Skip it, render a paragraph | Silently rendering an empty frame is far worse than refusing; the normalizer maps unknown *elements* to `paragraph` so content is still preserved |
| Typography is not fenced, content is | Fence the whole frame | Changing the font size mid-edit is legitimate, and CSS applying it does not move the caret — only replacing the content would |
| Deferred writes replay as *properties*, not nodes | Replay the whole node | A session can only change `text`, so a deferred `style` always replays and a deferred `text` always replays after the session's own commit — the M2 rule generalises unchanged |
| Measurement reads the **mounted** projection, not an offscreen clone | An offscreen `TextMeasurer` | A second rendering path that would drift from the real one, and which cannot answer how the mounted text is laid out anyway |
| Measurement returns a **status union**, never a bare number | `{ width, height }` | A hidden element measures `0` from every layout API, and `0` is a plausible size; a projection behind the model reports the previous document's layout |
| Sizes come from **layout APIs**, which are zoom- and transform-invariant | `getBoundingClientRect` | It is scaled, and under rotation it is the painted bounding box (198x143 for a 200x50 box). Using it would make every caller divide by zoom |
| Measurement returns **document px only**; positions stay with `Viewport`/`Overlay` | Also return client rects | A client rect invites a second conversion path, which is the failure mode 3.7's single conversion point exists to prevent |
| No chrome refresh per keystroke during a session | Wire `onDomChange` to `onChange` | Measured: DOM mutations outside the editable destroy the browser's undo grouping, one character per Ctrl+Z instead of a word |
| `transform.x/y/width/height` **is** the border box | Add an explicit inset/outset for the stroke | Measured: with `box-sizing: border-box`, `offsetWidth` equals the model exactly and an inside stroke eats inward. One rectangle, one meaning, and selection geometry == the model box at every stroke width |
| Stroke width is authored but **not** geometry | Put it in `transform` | The user authors it, so it belongs in the model and is undoable — but it does not change the box and must not move a handle. Naming the third category is what stops it being argued about |
| Only `align: 'inside'` is supported; the rest **throw** | Approximate with `outline` | Measured: `outline` paints *nothing* on a zero-height box. And `inside` is what makes "selection == the model box" true rather than a question |
| A line is an **SVG island** | `border-top`, `outline`, a rotated thin div | Measured all three: a border grows the box downward, an outline paints nothing, and a rotated bar makes the model box lie about the shape. §2.8 sanctions an island, and only this one needs it |
| `ShapeGeometry` is a **discriminated union** | A bag of optional fields | Every optional field meant `{ kind: 'line', cornerRadius: 8 }` type-checked and meant nothing. Making "a rect has corners" a type fact is cheaper than a runtime check |
| Shape behaviour is keyed by **`shape.kind`**, not `node.type` | Extend the `node.type === 'shape'` chain | `BaseNode.type` says never compare it outside `render/`, and `selection.ts` did exactly that. The chain also would have been *wrong* for a non-rectangle: it made ellipses selectable in their corners and lines unselectable |
| Rendering is **not** in the shape registry | Put the projection in `model/shapes.ts` | A projection needs `HTMLElement`, and `model/` may not touch the DOM. The layer rule caught this immediately, which is the argument for having it |
| Inspector properties are **paths**, not getters | Getter/setter per property | A getter must run per node per field, so "do they all agree across the selection" would be written once per property. A path is walked once, by generic code |
| A **click is not a marquee** | Let a zero-size marquee select | A zero-size rect overlaps every box containing the point, so clicking an ellipse's transparent corner selected it — `hitNode` refused the point and `applyMarquee` selected the object anyway, in the same gesture |
| An SVG island needs **two** `pointer-events` declarations | One, on the root | Chromium hit-tests an `<svg>` against its rectangular viewport (a phantom target where nothing is painted), and `pointer-events` is *inherited*, so `none` on the root also kills the stroke |
| A text frame's box hit test is **not** optional | One guard covering both node types | Removing the shared early-out when the shape branch was added made every text frame hit-testable anywhere on its page. Found by "every click selects the text frame" |
| An asset's identity is an **id**, never a URL | Blob URL / `File` / path in the model | A session-scoped handle makes the document unreproducible, and an opaque binary is not comparable by value — which is what `isNoop` and `History` both depend on |
| Intrinsic size is **asset metadata**, not measurement | Read `naturalWidth` at render time | `decode()` gives it at import, *before* the image is in the document, so placement needs no render pass and cannot go `stale`. And it rejects on non-image data, so a failed import never becomes a `0×0` asset |
| Assets live **in the model** | A side store outside history | Undo restoring a deleted image must restore its bytes too; a side store would restore a reference to nothing |
| A missing asset gets a **marked placeholder** | Let the empty box speak for itself | Measured: a failed image keeps its full authored box, keeps its full hit region, and reports `complete === true`. Nothing in the box distinguishes it from a working one |
| Asset state is **rendering output**, four states | A `loaded: boolean` on the node | `complete` is true for every failure, so a boolean cannot tell "not yet" from "never coming". And "currently resolves" is a fact about this session, not the document |
| Images are hit-tested by their **box** | Alpha-aware hit testing | Measured: Chromium hit-tests a fully transparent pixel, so a pixel-accurate editor would *disagree* with the browser — inverting the property every other object type has |
| The aspect lock is a **gesture modifier** | A stored node property | CSS cannot express it (explicit `width`/`height` beat `aspect-ratio`), and a persistent lock would silently change height the user never authored — and would be an image-specific transform concept |
| `.p1-object` stays a **div** for images | A bare `<img>` as the object | No geometric difference (measured), and an `<img>` is a *replaced element*: descendants are in the DOM but nothing paints, so there is nowhere to put a failure state |
| Inline assets need **no object URL** | Mint one per asset for a stable `src` | A data URL is already a stable function of the bytes, so minting bought nothing — and a Blob built from a data-URL *string* is not an image, so every image failed to load |
| `lastDocument` is published **before** reconciling | After, as "last rendered" | Renderers read the document *during* projection. Assigning after made a freshly inserted image resolve against a document that did not contain its asset |
| The format **is** the model, plus a marker | A separate persisted hierarchy | One canonicaliser then serves both directions, so the code that decides what a valid document is cannot drift from the code that writes one. Two hierarchies would mean mapping every field twice |
| Every object is rebuilt **field by field**, in a declared order | `JSON.stringify(model)` | `JSON.stringify` preserves insertion order, so the bytes would depend on how each object happened to be built. The mutation check caught the one nested case the golden file could not |
| Asset keys are **sorted**; object order is **not** | Sort everything, for tidiness | Object order is paint order, so sorting it would change what the document means. Assets are a map, so their order carries nothing |
| `assets` is in the **format**, not a side file | A `.p1doc` plus a media folder | Single-file portability, and undo already restores the bytes because assets are in the model. A side file would restore a reference to nothing |
| A duplicate asset record is **impossible**, and equal bytes under different ids are **both kept** | Deduplicate by content | A `Record<AssetId, AssetRecord>` cannot hold two records under one id, so "are duplicates legal" has a structural answer. Merging equal bytes would change two nodes' `asset` fields — a document nobody asked to change |
| Undeclared fields are **refused** | Ignore unknown keys | Silently dropping one makes a document look fine after a round trip while having quietly lost authored state. Refusing is loud and names the key, which is what makes a hand-repair possible |
| The parser **never repairs** | Collect recoverable problems and accept | Dropping one bad node out of a three-hundred-object document is a data-loss decision the user never made. Refusing with a path is the only version that tells them what to fix |
| `{ inline }` is **not validated as a data URL**; a colour is **not validated as a colour** | Validate payloads at the boundary | An unrenderable payload is a *rendering* state the document already knows how to show, and refusing the file over it would discard the user's work to avoid a cosmetic complaint |
| The version check runs **first**, and the two directions get different messages | One "unsupported version" error | A file from a newer build may mean anything at all; one from an older build is stale. The user needs "update P1" and "this file is old", not one string |
| **No migrations**, and no framework for them | A `MIGRATIONS` table, empty | A migration framework with no migrations is speculative infrastructure. What exists is the contract one will slot into: a constant, a version dispatch before validation, and two refusals that say what happened |
| Id reservation after a load | Parse into fresh counters, accept a collision | `createId` keeps module-level counters no document seeds, so "open a file, add an object" minted `node_1` — a duplicate id, which `mapNodesById` resolves to whichever it visits first. Now every id in the document is reserved, and a *refused* file moves nothing |
| Saving **ends** the open text session | Serialise the model as-is; disable Save; read the DOM | The browser owns the editable subtree, so the stale model writes the text *before* the user's typing. A dead button cannot be diagnosed, and reading the DOM is what the fence exists to prevent. `endTextEdit()` is already the canonical exit |
| Dirty state is a **derived read** over canonical authored state | Compare serialized strings; store a flag | A 1 MB inline image would re-encode 1.3 MB of base64 per keystroke. A derived read cannot disagree with the document, and it makes `edit → save → edit → undo` clean with no bookkeeping |
| Dirty is decided by the **model**, never the DOM or the viewport | Diff the projection | Scrolling, zooming, selecting, hovering and a pending measurement are all observable and all unauthored. A save that reported "no changes" for any of them would be lying |
| Save is a **download**, open an **upload** | File System Access API | FSA needs a document handle that survives a reload, and this build persists no handles — so "save" would be a fresh picker every time anyway. Download works identically everywhere and is the only path a browser test can drive, so the round-trip tests exercise the real mechanism |
| The **Open button is a trigger**; `app.ts` owns the input's `change` | The gateway wraps `input.click()` in a promise | Wrapping it puts the input's events behind a waiter, so a `change` from any other route is delivered to nobody. Found as "Open does nothing"; the image import had been doing it the other way all along |
| The store baseline is settled **before** `store.reset` | After | `reset` notifies subscribers synchronously and they render the indicator, so a baseline assigned afterwards reports a freshly opened document as unsaved. Found by the browser suite; invisible to unit tests, which never render |
| `documentsEqual` is **total** over what it compares | Trust the type | It runs on the render path, so a `TypeError` does not fail a save — it breaks selection, undo and every visual baseline. One malformed document reported as ten unrelated failures. A missing asset table now reads as *not equal*, never as an exception |
| Status-bar content must not change the **status bar's height** | Any padding | The bar is a grid row and the document surface takes the remainder, so four pixels of padding moved twenty-five visual baselines by four pixels. The ring is an inset `box-shadow` |
| `.p1doc` fixtures are **`-text` in `.gitattributes`** | Normalised line endings | The golden file is byte-compared against the serialiser's output; `core.autocrlf` rewrote it to CRLF on checkout and broke three assertions with a diff of nothing but `\n` versus `\r\n` |
| `.p1doc` fixtures are **`-text` in `.gitattributes`** | Normalised line endings | The golden file is byte-compared against the serialiser's output; `core.autocrlf` rewrote it to CRLF on checkout and broke three assertions with a diff of nothing but `\n` versus `\r\n` |
| **Layer order is a relative command in the model** (`restack`), not index arithmetic in the UI | Extend `reorder` with a delta, or compute target indices in the chrome | "One position forward" is a *different number* per object in a multi-selection under `reorder`'s after-removal indexing, and the number is stale the moment anything is inserted. A UI computing indices is a UI holding a model rule, and a `batch` of `reorder`s would be one history entry by accident with the label "4 changes" |
| A restack does not move an object **over another selected object** | Let the loop move whatever it can | Front-to-back processing prevents two *adjacent* selected objects swapping, and nothing prevents an object stepping into a slot held by a selected neighbour that is itself blocked. Found by a browser test: `[A,B,G,D]` with `A`,`G`,`D` selected became `[B,A,D,G]` — the exact inversion the feature promises never to happen |
| With **every** object selected, all four layer operations are no-ops | Treat "already at the front" as the only no-op | Correct, and a consequence worth asserting: there is no unselected neighbour to trade with. An implementation ignoring the blocked move returns a *new array*, which `documentsEqual` calls unchanged — so the order on screen looks right while the saved file differs |
| A restack returns the **same array** when nothing moved | Return a fresh but equal array | `isNoop` decides by reference identity, so a fresh array is an undo step that does nothing. The order assertion cannot see this; only the history can |
| **No grouping in M8**; multi-selection already provides every interaction a derived-transform group would | Ship "a selection with one bounding box" | That is not a group, and the brief said so. The only group model the architecture supports has a *derived* transform, which cannot be authored or persisted — and its only real content is durable identity, which is a model feature deserving its own milestone and version bump (ADR 0008 §5) |
| Children of a future group stay in **page coordinates**; the group transform is derived and never persisted | Children group-local, group transform authored | Group-local is a second coordinate space, and the measurement boundary and the text fence were both written for one. With children inside the group node the hierarchy is a **tree**, so "reject cycles" is free rather than a check |
| Non-uniform multi-object resize is **deferred**, because it needs a shear | Add a shear parameter to `Transform2D` | Proved, not asserted: the required linear part is `diag(a,b)·R(t)·diag(sx,sy)`, whose columns are perpendicular only when `sin(t)·cos(t)·(b²−a²) = 0`. So it is representable exactly at multiples of 90° and a shear everywhere else. A new transform field means a new invariant and an amendment to ADR 0005 — to make one handle work |
| **No aggregate selection frame**; one outline per selected object | An axis-aligned box around the selection | For a 30°-rotated 200×50 box the painted height is 143.3, so the union of `x/y/width/height` is a rectangle matching nothing the user can see, and handles on it would invite the shear resize. The honest cost — nothing says "these five, as a set" as a *shape* — is a feedback gap, not a geometry one |
| `visible`, `locked`, `opacity`, `blendMode` live in the **Transform** section | The Appearance section | They are `BaseNode` fields, and Appearance is filtered to shapes — which is exactly why a text frame's opacity had been unreachable since M3. Transform is the only section rendered for a selection of mixed types, so it is the only one with an answer |
| A disagreeing boolean renders **indeterminate**; setting it applies to every selected object | Show the first member's value, or a three-state select | A mixed selection of a visible and a hidden object has no single answer, and an unchecked box is the only honest rendering of that. A field that showed an arbitrary member's value would be the "never an arbitrary member's value" rule broken for booleans |
| Opacity outside `0..1` and an unrecognised blend mode are **refused and restored** | Clamp; write the string and let the renderer ignore it | Clamping writes something the user did not ask for, and an invalid blend mode is a rendering state the document has no way to show. Both restore what was displayed instead |
| `setProps` labels name the **property** (`Opacity`, `Fill`) | The literal `Change` | It already returned `Change` for everything, so every appearance-field commit read "Undo Change". M8 routed four more properties through it, which turned a cosmetic gap into a wrong label on every commit a user can now make |
| The overlay's per-object marker is **`data-for`**, never `data-oid` | Share `data-oid` with the renderer | The renderer stamps each object; the overlay stamped its outline group with the same name, so `[data-oid="x"]` matched two elements in two layers and Playwright raised a strict-mode violation on a locator that looked reasonable. The same principle as rejecting `zIndex` — an identifier in two places is a second source that can disagree — applied to the DOM |
| The editor **`preventDefault`s the gesture's `pointerdown`**, and handles `pointercancel` | Let the browser start its own selection | A press that also begins a native selection gets its pointer **cancelled**, and a cancelled pointer delivers no further `pointermove` and no `pointerup`. Shift-click two objects and drag, and they moved 7.5px of an intended 60px, the gesture never ended, and the editor kept the capture. The `preventDefault` is skipped inside a frame being edited, where the browser's default is what places the caret |
| The marquee **includes hidden objects**; hit testing does not | Filter both, for symmetry | A click is a point gesture and there is nothing to click; a marquee is a region gesture, and it is the *only* way back for an object the new `visible` checkbox can hide. Without it the field is a one-way door. `locked` stays excluded from both, because Alt-click already reaches it — locking is a barrier, not a hiding place |
| Layer buttons are **`aria-disabled`**, never `disabled` | `disabled` when nothing is selected | `disabled` drops the button out of the tab order and loses its tooltip, so a user tabbing through the toolbar would find four buttons missing with no way to discover the shortcut. `aria-disabled` is feedback; the model still drops the command, and one test forces the click past the actionability check to prove the handler is harmless |
| The whole stack is observed as **DOM order inside the page** | Read the order back through the overlay | The renderer appends in array order and CSS paints in DOM order, so the rendered sequence *is* the paint order *is* the persisted order — one observation, three claims. The overlay draws outlines in *selection* order, so it could not tell a restack from a reselect |
| A geometry assertion on a drag must check the **whole delta** | "Something moved" / "the fields went mixed" | The pre-existing multi-object drag test asserted only that the inspector went mixed, which one-eighth of an eight-step drag satisfies. That is why a live `pointercancel` bug was green: 7.5px is not 0 |

**15. `reorder` moves one node, so a paint-order reversal is two commands.** A test
wanted "reverse the page's paint order" and reached for a bulk helper. There is no
such command and there should not be — `reorder` moving a single object is what a
layers panel needs. The test now performs the two moves a reversal actually is. The
temptation to add the command was the same one that keeps a test-only API alive in
production code.

| A gesture is not an action if its result equals its start, and the comparison is **canonical** | Compare by reference only | A drag accumulates one `setTransform` per `pointermove`, each computed from the captured start, so an out-and-back drag ends its sequence at the start *to within the float error of inverting the stack transform twice*. The document rendered identically and compared unequal, so the drag landed on the history and <kbd>Ctrl+Z</kbd> undid nothing visible. A tolerance in the model was rejected: it would make `apply` stop being a total function of its inputs |
| Window `blur` ends an in-flight gesture, through the same `cancelGesture` as Escape and `pointercancel` | Treat `blur` as a pan concern only | Chromium has **three** ways a pointer can go away — `pointerup`, `pointercancel`, and the window losing focus — and only the first was handled. A gesture survived alt-tabbing: the object was left part-way, the capture was still held, and no further `pointermove` was acted on. Dead but believed live, observable because <kbd>Esc</kbd> after the blur still rolled it back. This is the same defect M8 found one trigger over |
| The **reconciler** stamps `data-oid` and `data-type`; renderers do not | Each renderer's `create()` stamps its own | Three owners for one semantic attribute, in two notations (`dataset.oid` and `dataset['oid']`). M8 had already fixed the *symptom* — the overlay sharing `data-oid` — and this was the remaining half of the same class. A new object type could spell it wrong or forget it, and nothing would notice until a test failed for an unrelated reason |
| Identity is stamped on **creation only** | Re-stamp on every reconcile | A `data-oid` that could change would mean the reconciler's key and the DOM's identity had diverged, and the element would be unreachable by its own id |
| Identity is asserted as a **count**, not as "the selector works" | Assert the selector resolves | The failure mode is *two* matches: a test reading `data-oid` while something is selected would get a plausible wrong answer instead of an error. A second assertion covers the general form — no element may answer to both `data-oid` and `data-for` |
| `SelectionState.anchor` **removed** | Keep it for the alt-cycle | It was written as `null` in two places, read by nothing, and documented for a shift-extend and an alt-cycle that **do not exist**: shift-extension is `pendingDeselect` at pointer-up, and `altKey` is `includeLocked`. A field whose comment describes unimplemented behaviour is how a reader comes to rely on it. The replacement test asserts the state's *shape*, so the next dead field cannot be added by the same route |
| `primary` has **no DOM observable**, and that is recorded rather than fixed | Read it off the overlay | The overlay draws one outline per selected object in **document order**, so the first outline is the first in paint order, not the primary. The only honest observable is <kbd>Enter</kbd>. Inventing a projection to make a field testable would be adding a feature to an audit |
| "Cannot be selected" is **two rules**: locked is a barrier (Alt-click gets through, the marquee honours it); hidden is invisible (nothing gets through, *including Alt*, and only a marquee reaches it) | One rule for both | M8 added the `visible` checkbox, and a marquee that also skipped hidden objects would have made it a one-way door. The asymmetry is the fix, and it is now the matrix's second axis |
| Model immutability is proved by **deep-freezing the input**, not by snapshotting | Compare the document before and after | Every module is an ES module and so runs in strict mode, so a write to a frozen object throws — one `not.toThrow()` over every command covers the document, a page's array, a node, a nested `transform`, a `fill` and the asset bytes at once. A snapshot only sees mutations that *persist*, misses any value the serialiser never reads, and says nothing about sharing |
| An untouched node must come back as the **same object** | Assert the document is correct | A command that rebuilt every node would be perfectly immutable and would also re-render the whole document on every drag. The sharing *is* the property that makes "the renderer reads only what changed" true rather than aspirational |
| Reordering **moves** elements, asserted with a token on the element object | Assert the resulting order | A recreated element would lose focus, reset a text session and restart an image decode, and no paint-order assertion would notice. A property on the element survives an attribute rewrite and dies with the node, which is exactly the identity being claimed |
| A gesture's exit is **one method**, reached by every trigger | One exit per trigger | Three separate code paths to the same rollback is a place for them to disagree. The tests assert all three agree rather than each one working |
| Cancellation is asserted on **saved bytes**, not on geometry | Compare positions | A rollback that missed one pixel of sixty passes `toBeCloseTo` on one axis. The serialiser's output is a total function of the document, so bytes catch partial rollback, a wrong page, a stray node and an unintended property change |
| The `pointercancel` handler is **not** mutation-covered, and the reason is written down | Add a mutation to reach 100% | With the `preventDefault` cause removed, no cancel occurs, so deleting the listener is unobservable from any test. A mutation that only proves the mutation works is worse than a documented gap |
| "The model cannot hold a shear" as **one predicate with both directions proved** | Two proof files each deriving the dot product | ADR 0008 asserted the *sufficiency* half in a comment and never tested it, so "not expressible" rested on an unproven converse. `isRotationTimesScale` in `core/geom/linear-part.ts` is imported by both proofs and by the live check, so they cannot drift apart (ADR 0010 §1) |
| Measuring the measurement boundary against a **transformed ancestor**, not carrying the assumption forward | Repeating ADR 0008 §5's deferral verbatim | Two milestones' worth of grouping deferral rested partly on "the text fence and the measurement boundary are unproven against a second coordinate space". Measured: layout APIs are unaffected by a CSS transform, and the fence survives it. Both were wrong, and the correction is what freed the rest of the analysis (ADR 0010 §4) |
| A live invariant check that is **required to fail** | Only the positive sweep | A sweep that finds no shears proves nothing unless it can reject one. `no-shear.spec.ts` injects a known shear into a live element and requires the same sweep to reject it, and separately requires it to accept a rotation and a non-uniform scale (ADR 0010 §6 F5) |
| Assert the **full delta** of a gesture, and read `left`/`top` rather than the rect | `expect(after).not.toBe(before)` | Written twice in one milestone. 7.5px of an intended 40px satisfies a truthiness check — the same trap that kept M8's live `pointercancel` bug green — and `getBoundingClientRect` reports a rotated, scaled box rather than the model (ADR 0010 §6) |
| Pin an **unused, incorrect** function where the next implementer will look | Delete dead code | `scaleTransforms` has no callers and is wrong for any rotated member, so deleting it discards the reasoning. Its tests cover only unrotated boxes, where it happens to be right. The pinned test is what stops a future scale gesture from inheriting a shear (ADR 0010 §6 F2) |
| **Refusing** a general affine transform, after proving it is one field away | "It would be a second geometry system" | That argument is not available and ADR 0011 does not make it: the model is codimension-1 in `GL(2)`, and hit testing, resize, measurement and rendering are already correct for any *invertible* matrix. It is refused because it buys one capability nothing can produce, and because it forces a stroke-width decision with no CSS route to invariance — a permanent semantic cost for a contingent one (ADR 0011 §16) |
| A **`rotation` field stays meaningful under shear**, and the proof is the factor order | Publishing a derived "actual tilt" | `K = [[1,kx],[0,1]]` cannot touch the first column, so the first column's angle is still the authored `t` at any shear. The *derived* polar rotation diverges the moment `kx ≠ 0` (30° authored, 11.4° polar) and does not exist at all for a reflection — so the inspector shows the authored number and never a derived one (ADR 0011 §3) |
| Proving a **semantic** by measurement when CSS is the mechanism | Reasoning about what borders "obviously" do | Whether a stroke is invariant in document space or transforms with the object is a browser fact, and it turned out the project had **never chosen**: at `scale(2,3)` an authored 12 px border paints 24 × 36. Measured with a nested pair, since a border does not change its parent's rect (ADR 0011 §9) |
| Discovering that `vector-effect` is **accepted and ignored** on HTML elements | Assuming it would rescue stroke invariance | Chromium parses `vector-effect` into `HTMLElement.style` and does nothing, because it is defined for SVG geometry. Document-space stroke invariance therefore means an SVG stroke renderer — the one part of this renderer CSS cannot express (ADR 0011 §9 F8) |
| Calling a **frame** a frame, and a bound a bound | "Selection bounds" | `selectionRect` returns `x/y/width/height` off the transform and the overlay draws it with no transform, so for a rotated object the outline is not the shape: 140 × 100 drawn against 171.2 × 156.6 painted. The loose name is what let a real bug look like a terminology problem (ADR 0011 §8 F6) |
| Testing an **invariant of the running application**, not only of the type | A static proof plus a comment | ADR 0005 and ADR 0008's limits are statements about `Transform2D`. M10 added a live sweep over every computed matrix, required to fail on an injected shear — because a guard that cannot fail is not a guard (ADR 0010 §6 F5) |

**16. A stale id is a no-op, not a throw.** The M0 mutators threw `No node with id`;
`apply` returns the document unchanged. Total is the right property for a funnel —
a command racing a deletion must not crash the editor — and the behaviour change is
asserted so it is not mistaken for a regression.

---

## M0 implementation notes

What was built, what reality taught us, and what changed as a result. The design
above is unchanged except where noted explicitly.

### What exists

```
src/core/units/units.ts          unit conversion, parsing, formatting
src/core/geom/{mat2d,rect}.ts   affine matrices, rectangles
src/core/ids.ts                  short deterministic ids
src/model/types.ts               Document, Page, Node, Transform2D, Paint, Stroke
src/model/transform.ts           Transform2D ⇄ matrix, pageSizeToPx
src/model/{factory,invariants,mutations}.ts
src/render/reconciler.ts         keyed diff + id→element map + minimal DOM moves
src/render/{dom-style,num,paint,render-context,document-view}.ts
src/render/layers/page.ts        page box geometry
src/render/types/shape.ts        the one object-type renderer
src/editor/viewport/viewport.ts  zoom, pan, coordinate conversion
src/ui/{app,dev-harness}.ts      composition root + temporary harness
```

69 tests across 7 files, `tsc --noEmit` clean, ESLint clean, production build
~5 kB gzipped with **zero runtime dependencies**.

### Verified behaviour

Confirmed in a real browser (Chromium 153), not just in a DOM emulator:

* A4 portrait (`210×297 mm`) renders at 793.7 × 1122.5 px, and landscape swaps it.
  The declared CSS value keeps three decimals — the page is never snapped to an
  integer, which is the whole point of keeping `px` as the internal unit.
* Rotation is about the box centre, confirmed by `transform-origin: 50px 50px` and
  by the box staying at its page-relative position; a top-left origin would move it.
* Non-uniform scale is about the centre, and rotation+scale compose as R·S — the
  same order as `transform: rotate(θ) scale(s)` in CSS.
* `overflow: hidden` clips an overhanging object exactly at the page edge, and the
  clipped object is not hit-testable there.
* DOM order equals model order, and the last object is topmost; reversing the model
  reverses the paint.
* The page's layout size is zoom-invariant; page-relative object position and size
  do not change at any zoom. Zoom is one `transform: scale()`.
* `fit()` computes `min(scaleX, scaleY)` against (viewport − 2 × padding).
* Re-rendering an unchanged document writes zero style properties; changing one
  field writes only that property.
* Reorder moves existing DOM elements rather than recreating them.

### Findings that changed the design

**1. Matrix composition order was wrong, and only non-uniform scale revealed it.**
`multiply(m, n)` was originally "apply `m`, then `n`", i.e. the product `n·m`. The
architecture states the world matrix as
`M = T(cx,cy) · R · S · T(-w/2,-h/2)` in ordinary algebraic order. The two agree
for uniform scale and disagree for non-uniform scale, so the first round of tests
passed while the code was wrong. `multiply` is now a plain matrix product
(`m·n`, rightmost applied first) matching CSS and the spec, so the model formula
reads exactly as written. Cost: a slightly less intuitive helper, paid back by
`model/transform.ts` now being a transcription of §1.3 rather than a
reinterpretation. There is a regression test for the ordering specifically, and a
browser test asserting the composed matrix.

**2. `ui/ → render/` needs an explicit exemption, and the lint rule found it.**
The composition root must construct a `DocumentView`; that is its purpose. Rather
than weaken the boundary, `ui/app.ts` is exempted by path and every other `ui/`
module stays restricted. The rule also caught a genuine violation — a dev harness
reaching into `DocumentView` for stats — which was fixed by passing plain numbers
through a callback instead of the render object. **The boundary is worth
enforcing precisely because it caught something on the first run.**

**3. The paper's drop shadow had to move off the page element.** It was originally
`box-shadow` on `.page`. That is a *viewport* decoration — paper on a desk — and
putting it on the page meant document screenshots included a soft halo and no
longer corresponded to the document box. It now lives on `.canvas`, which does not
affect the page's layout or paint. Small change, but it is the difference between a
screenshot that shows the document and one that shows the editor's idea of a desk.

**4. Browser precision is bounded, and the tests must say so.** Two independent
limits apply: layout geometry is quantised to 1/64 px (Chromium's `LayoutUnit`), and
CSSOM re-serialises lengths to about three decimals. So the unit tests assert the
exact float (`793.7007874015748`) and the browser tests assert within the browser's
own limits, separately proving the page was not snapped to an integer. Pretending
the browser keeps full float precision would have meant a test that either fails
spuriously or asserts nothing.

**5. Two green tests that verified nothing, and what they teach.**
`fullPage: true` combined with a clip silently pads regions beyond the document with
white — the editor scrolls internally, so the document is only window-height. The
resulting `page-clip` baseline was entirely white and the test passed. Separately,
`expect(page).toHaveScreenshot()` can capture more than the page if the page does
not fill the window, which is why the page element must be asserted via
`page.locator('[data-page]')`. Both were found by *looking at the baseline images*,
not by the test runner. Worth remembering: a screenshot test that nobody has
inspected is a test that proves very little.

**6. Pixel sampling was the wrong tool; hit testing is the right one.** Decoding a
screenshot inside the page to assert a pixel colour cost ~35s per capture. Asking
the browser `document.elementFromPoint` is ~1ms *and* is a stronger assertion:
for positioned elements hit-test order is paint order, and `overflow: hidden`
clips hit targets exactly as it clips painting. Screenshot baselines are kept as
the complementary visual check.

### Deviations from the original plan

* **No command funnel yet.** `model/mutations.ts` holds four pure immutable
  functions (`insertNode`, `removeNode`, `setTransform`, `reversePaintOrder`) used
  only by the dev harness. They are explicitly marked as scaffolding to be
  replaced by `apply(doc, command)` in M2, not extended. Nothing else in the
  codebase mutates a document.
* **Dev harness ships in M0.** `ui/dev-harness.ts` with four buttons (insert,
  update, remove, reorder) exists to exercise the reconciler's diff paths without
  building selection and undo first. It is marked for deletion in M2.
* **`Stroke.align` supports only `inside`.** `center` and `outside` throw a clear
  error rather than silently approximating; they need `outline` or an SVG island
  and are scheduled for M4.
* **`Paint` is solid-only.** Gradients are a paint-kind addition with no
  architectural impact, scheduled for M4.
* **`group`/`textFrame`/`image` are not in the `Node` union.** Adding them is a
  union extension plus a renderer registration, which is the extensibility
  mechanism working as designed — no core file changes.

### Confirmed for the next milestone

The architecture held up under implementation. Nothing in §1, §2.3 or §3.7 had
to be redesigned; the corrections were local (a helper's convention, a lint
exemption). The reconciler in particular behaved as specified, which is the main
thing M0 existed to find out.

---

## M1 implementation notes

### What was implemented

Multi-page vertical stack with a configurable gap, rulers, and the full
navigation system: zoom (clamped, anchored), pan (native scroll, space+drag,
middle-drag, ctrl+wheel), fit-whole-stack, fit-single-page, keyboard shortcuts,
a status bar reporting page-local document coordinates, and three coordinate
spaces with conversions centralised in `Viewport`.

New modules: `model/page.ts` (stack geometry), `ui/chrome/ruler.ts`,
`ui/chrome/shortcuts.ts`; `Viewport` substantially rewritten; `DocumentView` now
owns a keyed page stack.

### Architectural changes

**1. The zoom transform moved from the page to the page stack.** In M0 there was
one page, so the transform sat on it. With *n* pages that would mean *n*
transforms to keep in sync and a per-page cost. It now sits on a single `.pages`
element, which is one CSS write for the whole document at any zoom. This
generalises the M0 behaviour — for one page the two are equivalent — and it means
no page element's geometry is ever touched by zooming.

**2. `ViewportContent` lost its `height`.** The first cut accepted a
precomputed stack extent *and* a gap. That is two sources of truth for one value:
changing the gap resized the spacer from a stale height, so the scroll extent no
longer matched the pages. The viewport now derives the extent from
`pageCount × pageHeight + (n−1) × gap`, because it owns the gap.

**3. Three coordinate spaces, named and centralised.** `document` (page-local),
`stack` (from the first page, including gaps), `client` (screen). All conversion
lives in `Viewport`. §3.7 documents why: a test that mixed screen and document px
produced plausible-but-wrong numbers, and centralising the conversions made that
failure obvious instead of silent.

**4. Rulers are canvas, and that is not a contradiction.** They are chrome, drawn
outside `[data-pages]`, and a browser test asserts no canvas exists inside the
document surface. The CSS-backbone rule governs how the *document* renders.

### Problems discovered

**5. A green baseline that showed the toolbar.** With rulers added, the M0 zoom
baseline began capturing app chrome: the clip is in client coordinates, so any
part of the page scrolled out of the viewport captures whatever is behind it. The
test passed while recording an image of the editor. `screenshotPage` now
*refuses* when the page does not fit the viewport rather than recording a
misleading baseline. Same failure class as the all-white `page-clip` baseline from
M0 — worth remembering that a screenshot test nobody inspects proves very little.

**6. Ruler ticks were indexed in the wrong coordinate space.** The first cut
computed `documentPx = index * stepPx`, where `stepPx` was already a *screen*
distance. Ticks landed at the right count but the wrong positions at any zoom
other than 1. Caught by looking at the rendered ruler, not by a test.

**7. The status bar said "outside page" in the gap between pages.**
`pagePointFromClient` returns `null` for both cases, and the code collapsed them.
This is a design consequence, not just a bug: `null` means "not on a page", and
callers that need to distinguish must ask `pageIndexAt`. Documented in §3.7 so M2
does not repeat it when hit-testing clicks on the background.

### Tests added

- **Unit (93 total, up from 69)**: 30 viewport tests covering zoom clamping and
  isolation, fit arithmetic for whole stack vs single page, scroll clamping,
  every coordinate conversion including gap and past-the-end rejection, and page
  offsets invariant under zoom; plus page-stack geometry and reconciler multi-page
  cases.
- **Browser (48 total, up from 18)**: a new `navigation.spec.ts` covering the
  page stack, zoom invariance, fit semantics, resize behaviour, all three pan
  mechanisms, keyboard shortcuts (including that they are ignored while typing),
  anchored zoom holding the cursor's document point fixed, status-bar coordinate
  reporting, ruler behaviour, and multi-page visual baselines.
- The M0 `geometry.spec.ts` baselines are unchanged and still pass, which is the
  evidence that the stack refactor did not alter how a page renders.

### Confirmed for the next milestone

M1 again produced no architectural surprises: the reconciler, the transform-based
zoom and the three-space model all behaved as specified. The corrections were
local.

---

## Text-editing spike

Run **before** M2/M3, as planned. It closed the architecture's largest open risk
and produced the result recorded in
[ADR 0001](adr/0001-text-editing-fence.md). Summary of what changed as a
consequence:

- **§2.7** promoted from hypothesis to validated mechanism.
- **`ObjectRenderer`** gained an optional `afterUpdate` hook (§2.3), because
  `update()` returns early when text is unchanged and the text renderer had no way
  to keep its editing marker consistent.
- **`RenderCtx`** gained an optional `isTextEditing` query (§2.3) — queried, not
  pushed, so renderers stay pure projections.
- **§1.5 corrected**: `<p>`-per-block does not survive an editing session;
  `plaintext-only` makes Chromium insert a literal `\n` inside the existing `<p>`,
  and `white-space: pre-wrap` is therefore load-bearing.
- **§10.3 closed**; §10.4 (undo/redo inside a text session) became the new
  architectural risk, and was itself closed by
  [ADR 0002](adr/0002-text-undo-composition.md) during M2.

### Two bugs the browser found that a DOM emulator could not

1. **The content element's class attribute was set to a selector.**
   `TEXT_CONTENT_SELECTOR` (`.p1-text-content`) was assigned to `className`,
   producing `class=".p1-text-content"` — an element that matched nothing, so
   `TextEditSession` threw on every frame and the spike rendered as empty. The
   class *name* and the *selector* are now separate constants.
2. **Exit ordering.** Committing the model before clearing the fence flag
   re-renders while the renderer still thinks the frame is being edited, so it
   withholds the content it was just handed and leaves a stale `data-editing`
   marker. The order must be: clear fence → write model → re-render.

Both were invisible to `happy-dom` and to unit tests, and both would have been
found immediately by a user. That is the argument for keeping this suite.

### Deliberately left undone

Production text frames, typography, styles, multi-frame editing, overflow, and the
production `TextEditSession` API. The spike validated the *mechanism*, not the
typography model. Inline formatting in particular is discarded by the normalizer,
and extending it means extending both directions of `rich-text-html.ts` — real
M3 work that this spike does not pretend to have done.

---

## M2 implementation notes

### What was implemented

The command funnel, history, model hit testing, screen-space selection overlay,
move/resize/rotate with modifier semantics, an inspector scaffold, keyboard
shortcuts, and the ADR 0002 text-undo composition.

| Concern | Module |
|---|---|
| Commands (pure `apply`) | `model/commands.ts` |
| History (transactions, coalescing, abort) | `editor/history.ts` |
| Document store + write path | `editor/store/doc-store.ts` |
| Hit testing, selection state, common-frame selector | `editor/selection.ts` |
| Interactive transform maths | `editor/transform.ts` |
| Selection state, gestures, undo routing | `editor/editor.ts` |
| Screen-space chrome | `editor/viewport/overlay.ts` |
| Text-session fence owner | `editor/text-edit/text-session-controller.ts` |
| Schema-driven inspector | `ui/inspector.ts` |
| Editing key map | `ui/chrome/editing-shortcuts.ts` |

`model/mutations.ts` is removed. `apply(doc, command)` replaced it, which is what M0's
own notes said it was scaffolding for — and keeping a second set of mutators beside
the funnel is exactly the "second path into the model" §4.2 exists to prevent. The two
test files that used it now build documents with commands, so nothing exercises a route
the application cannot take.

### Architectural changes

**1. History entry stores `before` plus the command, not `doc` plus selection.**
§4.4 originally proposed `{ label, doc, sel }`. Restoring selection was dropped:
undo would move the user's selection around underneath them, which is disorienting.
Undo instead *prunes* ids that the undone operation deleted. Redo replays the
command, so entries need both halves.

**2. A cancelled gesture aborts its transaction; it does not compensate.**
`Editor.cancelGesture` originally re-dispatched the pre-gesture transforms. That is
wrong in a way only testing found: `apply` decides "did this change anything" by
*reference* equality, so an out-and-back drag yields a document that equals the
start without being it, and history recorded an undo step that did nothing — Escape
left a visible entry. `History.abort()` now rolls the document back and discards the
transaction's entries. A transaction also records where it *began* separately from
where its current entry began, because a merge-key change moves the latter forward
and an abort must land at the former.

**3. Every command type must detect its own no-op.**
`History.dispatch` skips a command that returns the same document reference, which
is what stops a drag that moved nothing from leaving an undo step. The first cut only
did this for `setTransform`'s identity case; `remove`, `reorder`, `insert`,
`setPageProps` and `setText` all rebuilt their page unconditionally and so always
"changed". Every branch now compares field-by-field. `setText` needed a structural
`RichText` comparison because two texts can share every character and still differ in
paragraph structure.

**4. Labels go in with the dispatch, not after it.**
The inspector wanted "Undo X" rather than "Undo Transform". Relabelling the entry
afterwards never reached the UI: the store had already notified subscribers with the
derived label, and mutating the label afterwards notifies nobody. `DispatchOptions`
now carries an optional `label`.

**5. Hit testing is against the model, and that is not an optimisation.**
`document.elementFromPoint` knows about pixels; the model knows about objects.
Selection must respect `locked`, `visible` and object shape, and during a text
session `elementFromPoint` would answer about the browser's DOM rather than the
document. Tests assert this directly, using cases where the two would disagree — an
invisible object on top, a locked object, and a rotated object whose bounding box
would claim a hit it should not.

**6. The overlay is screen space, and so its hit test is in screen space too.**
`Overlay` draws outside the zoom transform (§3.8), which keeps strokes at 1px. The
first cut passed a *client* point to a hit test that compared against *layer-local*
rectangles, so handles were drawn in one place and grabbed in another. The overlay
now owns `clientToLayer`. Because the overlay sits above the pages, it is
`pointer-events: none` and every gesture listener lives on the viewport root.

**7. One store subscription is the re-projection path.**
The inspector committed fields through `DocStore` directly, and nothing was
subscribed to it — so the model changed and the screen did not, a divergence only
undo exposed. `app.ts` now subscribes once; `Editor.onChange` handles selection-only
changes, which need chrome refreshed but not the reconciler run (hover fires on every
pointer move).

**8. The fence takes effect when it is set, not at the next render.**
Entering a text session changes nothing in the model, so recording the fence and
waiting for a render left it recorded but not in effect. `DocumentView.setTextEditing`
writes the DOM marker itself. This also removes the ordering hazard entirely: nothing
can re-render between "session started" and "fence active".

**9. Element lookups live in `ui/chrome/`.**
`editing-shortcuts.ts` joins `shortcuts.ts` and `ruler.ts`. The key maps stay
readable tables rather than switches buried in composition code. `Editor.undo`
implements the routing rule from ADR 0002 and the shortcut layer stays ignorant of
*why* — it only knows that some modes retarget an action.

### Problems discovered

**10. Shift-click and shift-drag are the same gesture until the pointer moves.**
Toggling on pointer-down made shift+drag on an already-selected object remove it and
then drag nothing. Toggling on pointer-up unconditionally made shift+drag delete the
object it was dragging. The resolution: add immediately when the target is not
selected; when it *is* selected, defer the removal to pointer-up and apply it only
if the gesture never changed the document. Both behaviours coexist because the
ambiguity is resolved by the only evidence available.

**11. The inspector read bare numbers as pixels while displaying points.**
`parseLength('75')` returns `75` px, but the field *shows* `30pt`. A user selecting
"30pt" and typing "75" got 75px — a silent 25% error on a value they could see they
had typed correctly. The inspector now reads a bare number in the unit it writes in.

**12. Every object type must stamp its own identity.**
`shape.ts` wrote `data-oid`; `text-frame.ts` did not, so `[data-oid="…"]` silently
matched nothing for text frames. Found because a test selector matched an *overlay*
element instead of the document object. Per §2.3 the reconciler deliberately does not
stamp identity itself, so each renderer must.

**13. A temporal-dead-zone error in the composition root broke every listener.**
`project()` reads status-bar elements that were declared *after* the first call to
it. Boot threw before a single event listener was attached — the app rendered and then
did nothing at all, with one `pageerror` in the console. All element lookups now
happen before anything that can call back. Worth recording because the symptom
("it draws, so it works") points away from the cause.

**14. `overflow: hidden` on a wrapper silently killed scrolling.**
Introducing `.surface` to clip the overlay made `.viewport` a plain block child, so it
sized to its content and had nothing to scroll — the entire page stack became
unreachable, with no error anywhere. One `display: flex` on the wrapper. Caught by the
M1 navigation tests, which is exactly what they are for.

### Tests added

- **Unit (203 total, up from 110)**: the command funnel (no-op detection per command
  type, structural sharing, purity, labels), history (coalescing, merge-key changes,
  nesting, abort, the depth limit, redo-branch invalidation), transform maths
  including resize-under-rotation and non-uniform scale, model hit testing, and the
  ADR 0002 composition rule with the native undo call injected.
- **Browser (152 total, up from 77)**: `tests/editor/selection.spec.ts` (39 tests)
  covering selection, hit testing, marquee, all three transform tools, the inspector,
  and deletion — all through real mouse and keyboard input;
  `tests/editor/history.spec.ts` (18) covering history through real input and the
  ADR 0002 composition end to end in Chromium; and
  `tests/editor/overlay.spec.ts` (13), which records seven baselines of the selection
  overlay. Those baselines clip the `.surface` box rather than the page, because the
  overlay is chrome — a page clip would exclude exactly what is being tested, and a
  surface clip added to `geometry.spec.ts` would re-record its page baselines on every
  selection change.
- Every editor assertion reads a **user-visible surface**: an overlay outline, an
  inspector field, a history button label. There is no `window.__p1` test hook, and
  removing the dev harness removed the last thing that existed only for tests.

### Deviations from the original plan

- **The dev harness is gone.** `ui/dev-harness.ts` was marked "removed once selection
  exists", which M2 is. Its one remaining test dependency — reversing paint order at
  runtime — is now done by mounting a reversed fixture, which tests the same claim
  without needing a mutation affordance no real feature requires. The sidebar went to
  the inspector.
- **Multi-selection resize was scoped down.** Handles are per object and a handle
  resizes only its own object. A group-level scale gesture is a later milestone;
  pretending a corner handle could drive every box would have been wrong.
- **Reorder has no user affordance.** The command exists (`reorder`) and is tested,
  but no shortcut or menu item exposes it, because layer ordering is a panel feature
  that has not been built. The command is ready for it.
- **Arrow-key nudging uses alt for axis lock**, shift for a ten-fold step. §3.5 did
  not assign these; the rule is that each modifier means exactly one thing.

### Confirmed for the next milestone

M3 can start. Both architectural risks are closed, the command funnel and history it
depends on exist, and the text fence has a real owner (`TextSessionController`) rather
than a spike harness.

Two things M3 inherits deliberately:

- **Lost external writes.** A model write to a frame being edited is deferred and
  replayed on session exit. Adequate for a single writer; needs a policy before
  anything that writes from outside the editor exists.
- **Redo does not survive a text session.** Native behaviour, accepted in ADR 0002.

---

## M3 implementation notes — production text frames and typography

### What was implemented

The first vertical slice of the text system: text frames, paragraphs, four character
formats, frame typography, the existing editing session, model synchronization, undo
integration, and inspector support. Designed in
[ADR 0003](adr/0003-production-text-model.md) **before** any of it was written.

- **The model** (`model/types.ts`, new `model/rich-text.ts`): `CharFormat` (four flags),
  `InlineRun` with `format`, `ParagraphAlign` on the block, `TextStyle` on the frame.
  `rich-text.ts` owns canonical form (`normalizeRichText`), total equality
  (`richTextEqual`), and the two plain-text projections.
- **The conversion** (`render/rich-text-html.ts`): rewritten from flat string
  extraction to a **stack-based walk** carrying a format down the tree. The old version
  produced one string and had nowhere to record a format.
- **The renderer** (`render/types/text-frame.ts`): typography projected onto the content
  element; the fence scoped to content only.
- **Commands**: `setText` (now format-aware), plus `setTextStyle` and `setTextAlign`.
- **The session** (`editor/text-edit/`): `contenteditable="true"`;
  `isFormatActive` and `applyInlineFormat` on the controller; deferred writes widened
  from text to text *and* style.
- **The inspector**: a schema-driven Text section shown only for text-frame selections.
- **The sample document** now carries a text frame with four formats, a soft break, and
  mixed alignment, so the default document exercises the model instead of presenting an
  empty box.

### Architectural changes

Three, and one of them amends a validated decision.

1. **`contenteditable="true"` replaces `plaintext-only`.** Amends ADR 0001's choice
   while keeping its fence, on measurement (`§10.5`). The spike now *pins*
   `plaintext-only` explicitly, because it exists to measure that mode and letting it
   drift with the default would have quietly invalidated two ADRs' own tables.
2. **Canonical form is a stated invariant** (`§1.6` rule 9), enforced on every write
   path rather than by convention.
3. **The deferral hook became per-property.** `notifyExternalWrite` now takes
   `{ text?, style? }`, because a session can only ever change `text` — so a deferred
   `style` always replays, and a deferred `text` always replays after the session's own
   commit. The M2 rule generalises with no new policy.

### Problems discovered

Twelve, of which four would have shipped silent data loss.

**1. `plaintext-only` cannot do character formatting at all.** `execCommand('bold')`
returns `false`; Ctrl+B produces nothing; `queryCommandState('bold')` never becomes
true. The fence ADR 0001 validated was incompatible with the feature it was validated
*for*. Found by probing before designing anything, which is the only reason it was a
design input rather than a mid-implementation surprise.

**2. The normalizer's `line.trim()` destroyed typed whitespace.** A trailing space the
user typed was silently removed on exit. `white-space: pre-wrap` is load-bearing
(ADR 0001 finding 1), so the model has to hold every space or the pixels stop matching
the document. Whitespace is content; nothing is trimmed.

**3. Tag nesting was inverted.** Iterating the wrapper list forwards produced
`<s><i><b>x</b></i></s>` for `{bold, italic, strike}` — a *second* HTML form for one
model value, which is precisely what the canonical order exists to prevent. Found by
the round-trip property, not by inspection.

**4. Empty paragraphs were dropped, then phantom ones appeared.** Two separate bugs in
the walker:

- `<p>One</p><p></p><p>Two</p>` lost its middle paragraph, because "an empty
  paragraph" and "no paragraph at all" look identical in a run list. `flush` now takes
  a `force` flag: *leaving* a block forces, because `<p></p>` is what the browser leaves
  when a line is emptied; *entering* one does not.
- `<div><p>One</p><p>Two</p></div>` produced **four** blocks. A block that contains other
  blocks is a container, not a paragraph, and flushing it emitted a phantom empty
  paragraph before and after.

**5. A trailing `<br>` is a placeholder, not a soft break.** Chromium keeps one so the
caret's line stays visible, and leaves `<p><br></p>` when a line is emptied. Read as a
break, an emptied frame's model value became `"\n"` — which re-projects as a permanent
blank line, so the frame stopped being empty and stopped round-tripping. Found by the
*pre-existing* spike test `emptying the frame during editing still leaves a valid
model`, which had been passing against the old normalizer. Only a *trailing* `<br>` is
dropped; `<p>a<br>b</p>` is a real soft break and must survive. Pinned by six new unit
tests, including the `<p>a<br><br></p>` case that distinguishes them.

**6. `text-align` was read from `element.style`,** which happy-dom does not populate
from `innerHTML` — so every aligned round-trip failed in unit tests while working in
the browser. Now parsed from the attribute, which is environment-independent *and*
closer to what the browser actually wrote.

**7. `text-align` is reported as `start`, not `left`,** for the LTR default. Two test
expectations were wrong, not the code.

**8. The inspector's unit rule bit immediately.** `fontSize` filled with `30` produced
40px, not 30 — correctly, because the field displays points and `30` means 30 *points*.
A user types a number and gets another one unless the field's unit is honoured. The
M2 rule generalises; the test asserts the conversion explicitly.

**9. `Inspector` had a module-level `currentDocument` global** introduced by an
inconvenient helper signature. It was wrong on sight — the closures already have the
`Editor` — and the fix was to pass `editor.doc` to the two selectors.

**10. Four sample-document tests broke on adding a text frame,** because they asserted
an absolute object count. Pinning the count meant a content change with no
architectural meaning broke tests that were never about the number of objects. They now
address objects by type and by relative position.

**11. `geometry.spec.ts` hit a strict-mode violation** on `[data-objects] > *` once the
sample had two objects. Fixed by targeting `[data-type="shape"]`, which also says what
the test means.

**12. `elementFromPoint` and the editor disagree below a frame's bottom edge,** and both
are right: the browser answers "what is painted", the editor answers "what did the
user mean to select". Now pinned on both sides (`§1.5.1`) rather than left as a trap
for the next person who finds `overflow: visible` and assumes the box grew.

### Tests added

- **Unit (245 total, up from 203)**: `src/render/rich-text-html.test.ts` rewritten
  around the round-trip property — 21 corpus cases (empty frames, whitespace-only,
  soft breaks, every flag, every alignment, formatting adjacent to whitespace, formats
  around soft breaks), plus the walker's edge cases and canonical form. One corpus
  guard asserts the corpus would *fail* on flattened text, so it cannot quietly become
  theatre.
- **Browser (199 total, up from 152)**: `tests/editor/text.spec.ts` (21 tests) covering
  rendering and computed typography, Enter vs Shift+Enter, formatting reaching the model
  and surviving a re-render, paragraph survival, history composition, deferred writes,
  and the fence holding now that the browser may write formatting.
  `tests/visual/typography.spec.ts` (6) with four new baselines — character formats,
  a blank line, overflow, and the shipped sample. Fixtures are imported from
  `tests/editor/text-fixtures.ts` rather than copied, so a baseline cannot be recorded
  against one document and asserted against another.
- **The ADR's measurements are now executable.** `tests/spike/format-probe.spec.ts` and
  `tests/spike/contenteditable-probe.spec.ts` assert the tables in ADR 0003 rather than
  only logging them. Both were partly broken — two probes threw `IndexSizeError` from a
  `Range` offset into the wrong kind of node — so the evidence ADR 0003 cited did not
  actually run.

### Deviations from the original plan

- **The spike's committed baseline changed by one paragraph's margin.** Under
  `plaintext-only` Enter still inserts a literal `\n`, and ADR 0003 reads `\n` as a soft
  break, so that text stays one `<p>` instead of becoming two. Traced, diffed and
  re-recorded rather than rubber-stamped. The mode-dependent meaning of `\n` is
  recorded in `§10.5` and in the spike's own test, because it is a real consequence of
  pinning the spike rather than an accident.
- **`verticalAlign` is not in M3**, though §1.5 sketched it and page layouts want it.
  It needs a flex container on the frame, which moves the content element's box and
  therefore the caret's coordinate space — the ADR 0001 fence back under test for a
  feature that is not otherwise load-bearing. Recorded as deferred with its reason, in
  the type, and in ADR 0003.
- **Padding is not in M3.** It is box model, not typography; it arrives with frame
  geometry work and would otherwise make the Text section look incomplete.
- **Two probe files were kept rather than deleted** after the investigation, because
  ADR 0003 cites them. An ADR whose evidence is not in the repository is an assertion.

### Confirmed for the next milestone

- **Measurement (§2.6) is now a prerequisite, not an extra.** Auto-size, columns,
  fit-to-content and baseline snapping all need a number the model cannot derive,
  because line breaking and line boxes are delegated to CSS by design.
- **Deferred external writes still have no multi-writer policy.** M3 widened the hook
  to typography and generalised the rule; it did not change the single-writer
  assumption underneath it.
- **Redo still does not survive a text session.** Unchanged, accepted in ADR 0002.
- **`inlineAlign` on the frame is still absent.** Per-paragraph alignment was chosen on
  the "one source of truth" argument, but a 500-paragraph frame stores 500 alignments.
  Revisit when the verbosity is measured, not guessed at.

---

## Measurement boundary implementation notes

### What was implemented

The smallest subsystem that proves ADR 0004's contract, and nothing beyond it.

- **`render/measure.ts`** — the DOM-level primitives, and nothing more:
  `contentBoxSize`, `paddingBoxSize`, `overflowOf`, `isRendered`,
  `measureRendered`, `whenFontsSettled`, `observeContentBox`. Zoom-agnostic by
  construction: it performs no coordinate conversion, so `render/` never needs to
  import `editor/`.
- **`editor/measure.ts`** — the model-aware half: `measureNode`,
  `measureTextContent`, `observeTextContent`, `textNodeIds`, and the `Measurement`
  status union. This is where `stale` lives, because comparing the DOM against the
  model needs the model.
- **`Editor.measureNode` / `Editor.measureTextContent`** — exposed on the editor so
  `ui/` never imports `render/`. `eslint.config.js` forbids `ui → render` apart from
  `app.ts`, and the inspector is exactly the panel that would want a convenience
  import. The arrangement satisfies the rule instead of exempting it.
- **One visible consumer** — a read-only measured-height line in the inspector's Text
  section, with `data-status` and `data-overflow` so a test asserts the *decision*
  rather than parsing prose. A measurement surface nothing displays is one nobody
  keeps honest.

### Layering

| | |
|---|---|
| `render/measure.ts` | knows about elements. Imports nothing but DOM types |
| `editor/measure.ts` | knows which element is a node, and whether it is current |
| `Editor` | the host `ui/` is allowed to talk to |
| `ui/inspector.ts` | displays, and imports none of the above directly |

### Problems discovered

Six, of which three were found by looking at rendered output rather than by reading
code — the usual ratio for this kind of work.

**1. The document inherited typography from the editor chrome.** `body` declares
`font: 13px/1.5 system-ui`; `line-height` is a *number*, so it inherits as a factor
and recomputes per element. A frame with no `TextStyle` rendered at **13px** — the
toolbar's font (measured: `contentFontSize: "13px"`, `contentLineHeight: "19.5px"`).
Two wrongs: restyling the chrome reflowed every document, and every measurement was
conditional on a stylesheet the document does not own — the precise coupling ADR
0004 exists to remove. Fixed by giving `.p1-text-content` its own `font-size: 16px`
and `line-height: 1.2`.

**2. The overflow readout compared formatted strings.** `frameHeight === height` on
two already-formatted values reports "overflowing" whenever they differ, which is
almost always — so a 19px text in a 50px frame announced itself as overflowing, on
every non-overflowing frame in the application. Found by screenshotting the
inspector and reading it; the code looks as though it means the right thing. Now
compared as numbers.

**3. Wiring `onDomChange` to a chrome refresh broke native undo.** Ctrl+Z went from
one word to one character per press, which would have made ADR 0002's delegation
useless. Three `history.spec.ts` tests caught it. Narrowing it produced the sharpest
result of the milestone (§2.6.1): reads are safe mid-session, DOM mutations outside
the editable are not.

**4. Three probe fixtures were silently malformed.** A stray bracket meant
`window.__P1_FIXTURE__` threw, the app fell back to the sample document, and the
probe reported "no element for `[data-oid=copy]`" — an error three screens from the
cause. `tests/spike/measure-fixtures.test.ts` now parse-checks every injected source
and asserts they all name their frame `copy`, so the failure names itself.

**5. `Playwright` and `Vitest` collided over a filename.** Widening Vitest's
`include` to `tests/**/*.test.ts` made Playwright collect the same file, and every
browser run failed with "Vitest failed to access its internal state" — naming
neither the cause nor the file. The split is now explicit: `*.test.ts` under
`tests/` is Vitest's, `*.spec.ts` is Playwright's, and `playwright.config.ts` says so.

**6. A test had pinned a doubled label.** `Editor.undoLabel()` returned `"Undo text"`
while `app.ts` renders `Undo ${label}`, so the button read "Undo Undo text" — and
`history.spec.ts` asserted that string. The test had recorded what the button showed
instead of what it should have shown. Fixed to the convention every `History` label
already follows.

Two more were my own test premises, worth recording because both produced
*false confidence* rather than a failure:

- A baseline of an empty frame was blank white whether or not the frame rendered a
  line. Rebuilt so the blank line is followed by text and the gap is visible.
- The measurement control typed `End` + text into a **one-line** frame, so the height
  could not change and the "control for the test above" proved nothing. It now adds
  a line with `Enter`.

### Tests added

- **Unit (270 total, up from 253)**: `src/editor/measure.test.ts` (17) covering all
  four status branches, the staleness tolerance, the overflow derivation and the
  disposer contract; plus `tests/spike/measure-fixtures.test.ts` (2) guarding the
  injected sources.
- **Browser (245 total, up from 199)**: `tests/editor/measure.spec.ts` (22) — the
  contract through the real app, with a **negative control for every structural
  claim**: change the text and expect a different height; measure at five zooms and
  expect one value; rotate and expect the same value while asserting the painted box
  really did triple; a fractional line height that proves the integer rounding is
  real; a hidden frame that must be refused rather than reported as `0`.
  `tests/spike/measure-probe.spec.ts` (18) records the measurements themselves, and
  `tests/spike/undo-granularity-probe.spec.ts` (7) records the §2.6.1 table.

The status branches are unit-tested rather than browser-tested **on purpose**:
`hidden` is unreachable through the UI (the model hit test refuses a `display: none`
frame, so it cannot be selected) and `stale` needs a DOM that disagrees with the
model, which a correct application never produces. A browser test for either would
have to break the application to reach it.

### Deviations from the original plan

- **`vitest.config` now includes `tests/`.** One line, and the reason is in
  `vite.config.ts`: injected fixture sources are test data that needs a parse check,
  and that check is a unit test.
- **Auto-size, columns, fit-to-content and baseline snapping are all still absent.**
  The spike did not reveal a vertical slice necessary to prove the contract, so none
  was built. ADR 0004 records what each would need instead.
- **The inspector readout does not track typing live**, and that is deliberate:
  publishing a number mid-session is a DOM write, and a DOM write costs the user
  their undo granularity (§2.6.1). A test that asserted the live value would have
  pinned a behaviour that measurably breaks Ctrl+Z.

### Confirmed for the next milestone

- **Auto-size is unblocked and constrained.** It needs only
  `content.clientHeight` at the current width; the width is already in the model. It
  must be a *converging* operation (change → render → measure → dispatch → render →
  measure) because integer rounding makes a synchronous fit oscillate, it needs the
  "measured, don't re-measure" loop guard to terminate, and it must not run during a
  text session.
- **Line geometry and baselines remain unavailable.** Snapping to baselines is
  therefore not supportable today, and inventing support would mean a text layout
  engine. Recorded rather than worked around.
- **`whenFontsSettled()` is a no-op until the first webfont.** Nothing verifies it
  yet, and `document.fonts.check()` cannot.
- **The `stale` check compares object geometry only.** It catches measuring before
  the render pass; it cannot catch a partial render.

---

## M5 implementation notes - graphical objects

### What was implemented

| Area | What |
|---|---|
| **Geometry contract** | ADR 0005, from 18 browser probes. `transform.x/y/width/height` **is** the border box; stroke does not move it; zero is legal and negative is impossible |
| **Model** | `ShapeGeometry` became a discriminated union (`rect` / `ellipse` / `line`). `polygon`/`star`/`path` are **absent** rather than present as empty optional fields |
| **Registry** | `src/model/shapes.ts` — per kind: hit-test predicate, inspector `properties`, `hasInterior`, `needsExtent`. Plus `Record<ShapeKind, Projector>` in `render/types/shape.ts` and `createShapeNode` in the factory |
| **Renderer** | `rect` and `ellipse` are pure HTML/CSS. `line` is a scoped SVG `<line>` island, forced by measurement (§2.8's escape hatch) |
| **Hit testing** | `editor/selection.ts` routes through the registry. The `if (node.type === 'shape' && node.shape.kind === 'rect')` chain — a direct violation of `BaseNode.type`'s own stated rule — is gone |
| **Creation** | `EditorMode = 'draw'` + `drawKind`. Toolbar buttons per registered kind. One `insert` through `store.mutate`; the drag preview reuses the marquee rect |
| **Inspector** | An Appearance section driven by the registry: fill, stroke, weight, opacity, plus each kind's own `properties` |
| **Tool chrome** | A tool group in the toolbar, with pressed state read from `Editor.armedShapeKind` so a button cannot claim a tool is armed when it is not |

### Architectural changes

- **Two registries, not one.** §7.2 has the table. The split is forced by layer
  constraints, and conflating the keys is exactly what produces `if (type === ...)`
  chains. The `model → render` lint rule caught the mistake immediately: "does this kind
  have an interior" was first filed in `render/`, where `model/` may not import from. It is
  a fact about the kind, and it moved to `model/shapes.ts` where both `model/` and
  `render/` can read it.
- **`stroke.align` accepts only `'inside'`, and the others throw.** `center` and
  `outside` are kept in the type so documents can express intent, but rendering one
  raises rather than approximating. `inside` is what makes selection geometry equal to
  the model box at every stroke width.
- **A text frame's opacity is currently not editable.** It is a shared `BaseNode`
  property but lives in the shape-only Appearance section, so a text frame hides the
  section and loses the field. A named gap, not a designed answer: the fix is to move
  opacity into the always-present Transform section, not to loosen the section rule.

### Problems discovered

**1. A click was marquee-selecting by bounding box.** A press on empty space starts a
marquee; on release `applyMarquee` selected every object whose *box* the rect touched. A
click is a zero-size rect, and a zero-size rect overlaps every box containing the point —
so clicking inside an ellipse's transparent corner selected the ellipse. `hitNode`
correctly refused the point and `applyMarquee` selected the object anyway, in the same
gesture. Box-based marquee selection is *correct* and stays; the fix is that **a click is
not a marquee**.

**2. A 22-test suite had been passing on that bug.** `measure.spec.ts` clicked
`(60, 60)` to select a frame at `(40, 40, 200, 50)` **rotated 30°** — a point outside the
shape. Only the marquee bug made it look selected. It passed on every run while measuring
nothing it claimed to measure. The strongest argument in this document for negative
controls: the helper now asserts the frame was selected and names the failure itself.

**3. `pointer-events` is inherited, so the SVG island needed *two* declarations.** Chromium
hit-tests an `<svg>` against its rectangular viewport, which for a zero-height line is the
1px strip inserted to stop the viewport collapsing — so a stroke-less line reported a hit
and a stroked one did not. The first fix, `pointer-events: none` on the root, silenced the
stroke as well and made every line unpickable. The shipped pair is `none` on the `<svg>`
and `stroke` on the `<line>`. Any future island renderer inherits this requirement.

**4. `setProps` had no no-op detection**, so it violated §4.2's rule that `apply` returns
the same reference when nothing changes. Latent until M5 routed fill, stroke, width and
opacity through it: every inspector field re-commits on blur, so an unchanged colour put an
entry on the undo stack and the next Ctrl+Z did nothing. Fixed with a bounded structural
comparison; `src/model/commands-setprops.test.ts` pins both the fix and the non-fix it must
not become (object props compared by identity).

**5. The nested-write patch replaced the wrong level.** Cloning `node.stroke.paint` and
returning it under the key `stroke` produced `{ stroke: { type, color } }`, silently
discarding `width` and `align` — so a line lost its stroke width the moment its colour was
edited. Found only because the test asserted the *rendered* SVG attribute, not the model.
The whole chain is now rebuilt from the top key down.

**6. `hidden` did not hide anything.** `.p1-inspector-field` sets `display: flex`, and any
author `display` beats the UA's `[hidden] { display: none }` on specificity — so
`row.hidden = true` left the row on screen and editable. The panel hides rows constantly
(kind-specific fields, fill on a line), so this was never an edge case.

**7. Removing the shared box early-out made text frames unclickable-but-everywhere.** When
the shape branch was added to `hitNode`, the guard above it — which had covered both kinds
— went with it. Every text frame became hit-testable anywhere on its page. Caught by the
shape suite's first symptom, "every click selects the text frame".

**8. A kind-specific field was offered for a kind that lacks it.** Inferring "is this a
kind-specific field?" from `when: 'always'` meant a rect's corner radius appeared for an
ellipse. Now declared: every field says whether it is `shared` or `kind`-scoped.

### Tests added

- **Unit (319 total, up from 270)**: `src/model/shapes.test.ts` (18) covering every
  registry predicate with a negative control per edge case — the ellipse's box corners, a
  line's segment ends, a zero-extent ellipse falling back to the box instead of dividing by
  zero; `src/model/creation.test.ts` (14); `src/model/commands-setprops.test.ts` (12);
  `tests/editor/shape-fixtures.test.ts` (5) guarding the injected sources and the fixture's
  internal consistency (every id in the geometry table exists; the overlap pair is in the
  order the paint-order test assumes).
- **Browser (314 total, up from 245)**: `tests/editor/shapes.spec.ts` (60), plus
  `tests/spike/shape-geometry-probe.spec.ts` and `tests/spike/shape-line-probe.spec.ts`
  (23 probes) as the executable record for every table in ADR 0005.

The probes were written **before** the renderer and are the reason ADR 0005 could be
written at all: PROBE L found that a CSS border grows a zero-height box downward, PROBE M
that `outline` paints nothing there, and PROBE N that only the SVG island keeps the box at
zero. PROBE O is the cross-check that `border-radius: 50%` really does hit-test as a true
ellipse — 430 of 441 grid samples exact, the 11 exceptions all on the boundary — so the
editor's predicate and Chromium's answer were compared rather than assumed.

The suite's structure is deliberate: where the editor and the browser *should* agree
(rect, stroked line) both answers are asserted and must match; where they *should not*
(a stroke-less line) the disagreement is asserted explicitly, so a change in either
direction fails rather than passing unnoticed.

24 visual baselines, up from 23. The new one is the whole shape document; it is paired
with an object-count assertion, because a screenshot of an empty page is a passing test
that shows nothing.

### Deviations from the original plan

- **The SVG island is scoped to one kind and lives inside the object element.** §2.8
  permits an island renderer; what was not anticipated is that it would also *fix* the hit
  testing, since an SVG stroke is painted and therefore pickable. ADR 0005's divergence
  table was amended rather than quietly rewritten — the original claim was measured, just
  on the representation that was rejected.
- **A line's direction is not authored.** The segment always runs local `(0,0)` →
  `(width, height)`, so a drag from bottom-right to top-left produces the same line. For a
  straight segment that is visually identical; there is simply no way to express "this line
  starts here".
- **The tool stays armed after drawing**, as in every editor with a shape toolbar.
  One-shot arming means clicking the toolbar once per object, and nothing asked for it.

### Confirmed for the next milestone

- **Auto-size remains unblocked and unchanged** by M5: it needs only
  `content.clientHeight` at the current width, must converge (change → render → measure →
  dispatch → render → measure) with a loop guard, and must not run during a text session.
  M5 added nothing that constrains it further, and the `stale` check still compares object
  geometry only, so it still cannot catch a partial render.
- **`stroke.align` is the cheapest unfilled gap.** `outline` cannot centre on a
  zero-height box (measured), so `center` and `outside` need a different mechanism for
  lines than for filled shapes — most likely `box-shadow` on the island. Not cheap.
- **Polygons are genuinely bigger than a field.** `pointInPolygon` already exists in
  `core/geom`, but a polygon needs a point list in the model, a fourth predicate, and an
  SVG renderer. ADR 0005 records this rather than leaving it implied.
- **Hit testing now has a second consumer to keep honest.** §8.2's rule — *a click is not a
  marquee* — was found the hard way. Any future gesture that ends by testing geometry must
  be checked against it, not only the one that reads a pointer.
- **A text frame's opacity is unreachable from the inspector**, as above.

---

## M6 implementation notes - images

### What was implemented

| Area | What |
|---|---|
| **Asset contract** | ADR 0006, from 13 browser probes. `AssetId` as identity; `Document.assets` holding mime, intrinsic size and bytes |
| **Model** | `AssetId`, `AssetRecord`, `AssetData`, `ImageFit`, `ImageNode`; `Document.assets`. `src/model/assets.ts` owns the rules, and refuses a non-positive intrinsic size |
| **Decode & resolution** | `render/assets.ts`: `importImageFile` decodes a picked file **detached** (rejecting non-images), and `AssetResolver` maps an id to a `src` or a named reason |
| **Renderer** | `render/types/image.ts` — a wrapper `div` (`.p1-image`) with a sized `<img>` inside, publishing `data-asset-state` and `data-asset-resolution` |
| **Placeholder** | CSS on the wrapper for `idle`/`loading`/`error`, so a missing asset is a **marked box** rather than an empty one |
| **Creation** | One hidden file input; `Editor.insertImage` commits the asset and the node as one `batch`, at the intrinsic size scaled uniformly to fit |
| **Inspector** | An Image section: a `fit` select built from the model's own union, plus a read-only asset-state note and a native-vs-authored size readout |
| **Command** | `setAssets`, a **map** rather than add/remove — replacing an asset's bytes is a write to the same id, so a reference can never dangle between two commands |

### Architectural changes

- **Nothing in the geometry contract changed, on purpose.** An image's `transform.x/y/width/height`
  is the same border box as a rectangle's, and is so in every state measured — loaded,
  failed, rotated. That was the single most important thing to *not* change.
- **Assets are part of the model, not a side store**, because undo restoring a deleted image
  must restore its bytes too. The cost is a documented garbage-collection gap.
- **Asset load state is rendering output.** It is derived from the `<img>`, published on the
  element, and read back through `Editor` — the same arrangement as ADR 0004's measurement
  note, applied to a second thing.
- **`.p1-object` stays a `div` for every object type.** Measured: no geometric difference
  from a bare `<img>`, and a replaced element has no content box in which descendants
  render, so a bare `<img>` has nowhere to put a failure state.
- **The aspect-ratio lock is a gesture modifier, not a node field.** CSS cannot express it
  (measured), a stored lock would silently change height the user never authored, and it
  would be an image-specific transform concept. So `resizeTransform` is unchanged.

### Problems discovered

**1. A `Blob` built from a data-URL string is not an image.** The first resolver did
`new Blob([asset.data.inline], …)` — wrapping the *text* `data:image/png;base64,…`. Every
image failed to load. The symptom was the worst kind: the node existed, was correctly sized,
was selectable, and showed nothing, so it looked like a decode problem and was chased as
one. The fix was not to hand-decode base64 but to notice the object URL was buying nothing —
a data URL is already a stable function of the bytes.

**2. `lastDocument` was published *after* reconciling.** Renderers read the document during
projection, so a freshly inserted image resolved against the *previous* document — one with
no assets — and rendered empty. Same symptom as (1), different cause, and the reason the
assignment now carries a comment saying why the ordering matters.

**3. A failed resolution reported itself as `idle`.** The state derivation reads the
`<img>`, and a resolution failure leaves it with no `src` — which derives as "still
loading", a promise the browser will never keep. Fixed with a second attribute,
`data-asset-resolution`, answering "did we get a URL?" separately from "are there pixels
yet?".

**4. `findAsset` returned `Object.prototype.toString`** for the key `'toString'`. Caught by
a unit test, not by the browser. Ids are generated as `asset_1` so it cannot happen from our
own factory — but a *deserialized* document can carry any key, which is exactly where a
lookup has to be defensive.

**5. A test that was wrong about being a test — twice.** The image probe's round 1 used a
hand-written PNG that did not decode, so every "loaded" case silently exercised the
*failure* path, and I concluded Chromium was alpha-aware for hit testing. With valid bytes
the answer is the opposite: a fully transparent pixel **is** a hit. Separately, the suite's
zero-size test generated a `0×0` **canvas**, which is undecodable, and I concluded Chromium
skips loading zero-sized images. PROBE AD measured it: it loads normally. Every image
fixture is now generated at test time, and `waitForDecoded` refuses to let a test proceed
against an image that did not load.

**6. ADR 0005 was wrong about zero-extent boxes.** It claimed a zero-size object is
"unreachable by click". The box predicate is inclusive on all four sides, so a `0×0` box
accepts exactly one point — its origin — and the editor *will* select a degenerate object
there, where Chromium will not. Left as-is (a special case would make a `0×0` object
impossible to select, and creation already refuses to make one) and ADR 0005 amended.

**7. A test used `image` as its example of an unregistered type.** `document-view.test.ts`
picked `image` to assert a clear "no renderer registered" error — correct until images were
implemented, then wrong for having been right about the code and wrong about the future. Now
uses a fictional type, so the intent survives any milestone.

### Tests added

- **Unit (348 total, up from 319)**: `src/model/assets.test.ts` (14) — the intrinsic-size
  refusal, no-URL-in-the-record, the `hasOwn` lookup, and the problems-not-throws contract;
  `src/model/image-enums.test.ts` (3) — every `ImageFit` and every `AssetState` has a label,
  because a missing one renders as `undefined` in the inspector; plus 6 for
  `imagePlacementRect` in `creation.test.ts`.
- **Browser (342 total, up from 314)**: `tests/editor/images.spec.ts` (28, 1 baseline) and
  `tests/spike/image-probe.spec.ts` (13 probes: intrinsic size, `object-fit`,
  transparency, failure states, the `<img>`-as-container question, rotation, `aspect-ratio`,
  and the zero-box question).

**The suite's central rule is asserted, not just followed.** Measured: an image that failed
to load still occupies its full authored box, is hit-testable across all of it, and reports
`complete === true`. So a test that only checks "an element with `data-type=image` exists"
passes against a completely broken image. `waitForDecoded` waits for
`data-asset-state="loaded"` **and** refuses to continue otherwise, naming what it found. The
visual baseline is paired with it, and the baseline deliberately includes a *missing* asset
so it records a marked placeholder rather than an empty rectangle.

25 visual baselines, up from 24.

### Deviations from the original plan

- **No object URLs for inline assets** (§9.1 of the ADR). The resolver keeps the cache and
  the `invalidate`/`release` machinery because the `external` case will need it, and
  `mintedCount` is exposed so "zero minted URLs" is checkable rather than assumed.
- **`object-position` is absent.** Under the default `fit: fill` it has no observable
  effect, so it would be a control that cannot do anything. It arrives with cropping.
- **The only route in is a hidden file input.** No asset browser, no library, no replace, no
  usage listing. A picker is UI; the contract is the milestone.
- **`intrinsicWidth/Height` is unvalidated**, so a document may declare a size its bytes do
  not have — and the test suite proves the renderer and the metadata diverge harmlessly.
  That is the point of metadata rather than measurement: a measurement cannot be wrong about
  itself, and metadata can.

### Confirmed for the next milestone

- **Persistence now has an asset contract to implement**, and it is the first thing in the
  project that cannot be postponed: `Record<AssetId, AssetRecord>` is plain JSON, but
  `{ external }` resolution and resource-loading order are genuine prerequisites for M8 and
  are recorded rather than designed here.
- ~~**Asset garbage collection is owed.**~~ **Done** - see [ADR 0014](adr/0014-asset-garbage-collection.md).
  A payload-free `pruneAssets` command: one undo step, `apply` returns the same reference when there is
  nothing to collect, and the reference walk uses `placementsInDocument` so GC sees exactly the nodes the
  editor can see. Explicit only — nothing on load, save, or delete collects, because the bytes are
  history and an implicit sweep would take them with no undo step to restore them.
- **A text frame's opacity is still unreachable** from the inspector; the fix is to move
  opacity into the always-present Transform section, not to loosen the section rule.
- **The zero-extent hit-test quirk applies to every object type**, not just images. Whatever
  milestone next touches `hitNode` should know that a `0×0` object is selectable at its
  origin, and that this is deliberate.
- **Auto-size is still unblocked and unchanged**: it needs only `content.clientHeight` at the
  current width, must converge with a loop guard, and must not run during a text session.

## M7 implementation notes — persistence

The document can finally leave the process. What changed, what the browser found, and what is
still owed. The decisions are [ADR 0007](adr/0007-persistent-document-format.md); §6 is the
reference for the format.

### What was implemented

- **`src/persist/`** — the format, in three files. `format.ts` holds the *vocabulary* once:
  constants, the declared key lists for every object, and the validation primitives.
  `serialize.ts` rebuilds a document field by field in that declared order. `deserialize.ts`
  validates, rebuilds in the same order, and reserves the document's ids with the generator.
  The two directions are inverses **through one description**, so they cannot drift; that they
  agree is a property, and it is checked rather than assumed.
- **`src/model/document-equality.ts`** — canonical model equality, with `canonicalJson` for
  opaque bags. One function, two callers: the round-trip property and dirty state.
- **`src/core/ids.ts`** — `reserveIds`, so a loaded document cannot be collided with by the
  generator (see ADR 0007 §3).
- **`src/ui/persistence.ts`** — `DocumentGateway` (the browser mechanics) and
  `DocumentSession` (the rules: dirty state, the text fence at save time, clearing history on
  open). Split so the rules are testable without a DOM.
- **Chrome** — `New` / `Open` / `Save` buttons, a hidden document input, a document-name
  readout, a dirty indicator (`data-dirty`), and a message area for a refusal. `Ctrl+S` runs
  the same path as the button.
- **`src/model/invariants.ts`** — the `assets` table is now checked, along with dangling
  `ImageNode.asset` references.
- **Golden fixtures** — `tests/golden/sample.p1doc` in canonical form, byte-compared against
  the serialiser, plus `tests/golden/handwritten.p1doc` — the same document written by hand
  with objects collapsed onto one line, which must load to the same document.
  `scripts/make-golden-assets.mjs` regenerates the inline PNGs; they are generated rather
  than hand-written for the reason M6 established.
- **`scripts/mutation-check.ps1`** — twenty mutations as of M7, each asserted to turn a suite red.
  The corpus has since grown to 112 and the harness has been reworked twice (§8.2); the corpus itself
  lives in `scripts/mutations.ps1`.

### Architectural changes

- **`persist/` became a real layer.** It was already in `eslint.config.js`; the code now
  matches. `ui/ → persist/` is the one edge that reaches it, and only from the file boundary —
  §8.1 explains why a gateway that could not reach the format would be worse than the edge.
- **`ui/` no longer constructs a save path in `app.ts`.** The lifecycle rules live in
  `DocumentSession`; `app.ts` wires the gateway, the text-session commit, and the chrome. The
  composition root does not know the format's shape.
- **The dirty indicator is a *read*, not state.** It has no independent storage, so it cannot
  disagree with the document. That is also why §8.3's fixture guard matters: `documentsEqual`
  is now on the render path.
- **The status bar's height became a constraint, not a style choice.** See the fourth rule in
  §8.2 and the `box-shadow` in `styles.css`.

### Problems discovered

Nine, in descending order of how badly they hid.

1. **~30 injected fixtures were not valid documents.** `Document.assets` became required in
   M6 and the fixtures were never updated; nothing reported it because the renderer tolerated
   the missing field. M7 read the table on the render path — once per `refreshChrome`, on
   every pointer move — and **ten browser tests failed across six suites**: selection, undo,
   text sessions, and every visual baseline. Each failure named its own test; the cause was a
   missing key in a string in `tests/editor/helpers.ts`. Fixed three ways: the fixtures, a new
   `assets` invariant, and `tests/fixture-guards.test.ts`, which asserts the field is present
   *and* that it found any literals at all so it cannot become a vacuous no-op.
2. **A four-pixel status-bar change moved twenty-five visual baselines by four pixels.** The
   dirty indicator had `padding: 1px 6px` and a `border`. The bar is a grid row and the
   document surface takes the remainder, so the failure surfaced as a 2502-vs-2506 pixel
   screenshot mismatch in a suite about the overlay. Fixed with an inset `box-shadow`, and
   recorded as a rule: *status-bar content must not be able to change the status bar's height.*
3. **`documentsEqual` threw on the render path**, which is the mechanism behind (1). A function
   called on every pointer move must degrade to "not equal", never to an exception. It is now
   total over what it compares.
4. **The file input's `change` event had no owner.** The gateway wrapped `input.click()` in a
   promise and resolved from its own one-shot listener, so a `change` delivered by anything
   else — a drop target, a paste handler, a test — went to nobody. Symptom: "Open does
   nothing". The image import had been doing it the other way all along, so the fix was to
   match it: the button is a trigger, `app.ts` owns the listener.
5. **The baseline was assigned after `store.reset`,** which notifies subscribers synchronously
   — so a freshly opened or newly created document rendered as *unsaved*. Found by the browser
   suite; unit tests cannot see it because they never render.
6. **A refusal was silent.** `withDocumentFeedback` refreshed the chrome only on success, so a
   user who picked the wrong file was told nothing happened.
7. **`URL.revokeObjectURL` in the same tick as the click** races the browser's read of the
   blob and can cancel the download outright — a Save button that silently does nothing.
   Deferred by a tick.
8. **`core.autocrlf` broke the golden fixture.** The `.p1doc` files are byte-compared against
   the serialiser's output, and a stash round-trip rewrote them to CRLF: three assertions
   failed on a diff consisting entirely of `\n` versus `\r\n`. Fixed with
   `.gitattributes` — these files are compared as bytes, so the bytes *are* the file.
9. **`a manual zoom that overflows is centred by scrolling` was already red.** It demands
   sub-pixel agreement between a fractional `getBoundingClientRect()` and an integer scroll
   offset; measured at 2.55px before M7 and 1.45px after. The claim ("scrolled, not padded")
   never needed that precision, so the test now asserts `scrollTop > 0` directly — which is
   the property it is actually about — and allows two device pixels for the margins.

### Testing

- **20 mutations, all detected.** Three gaps it closed, all of which were green:
  `canonicalTransform` written as a spread (the golden byte-identity test cannot catch it,
  because the parser hands it keys that are already canonical — now covered by a test that
  reverses key order at every depth); a dirty-state test that passed *without the save having
  happened*, because `save()` suspends at its `await` and the first assertion ran before the
  baseline moved; and two mutations run through Vitest against `.spec.ts` files, which Vitest
  collects none of, so "no tests found" read as a pass.
- **`tests/golden/sample.p1doc` is byte-compared** against the serialiser, so a field added to
  the canonicaliser without being added to the parser fails a test rather than passing
  quietly.
- **The browser round trip is byte identity across a real boundary**: save → close the context
  → open in a fresh one → save again → identical. Byte equality rather than DOM reading,
  because `getBoundingClientRect().height / zoom` is never a size for a rotated box and cannot
  see the document's `name` or asset table at all.
- **Every image assertion goes through `data-asset-state`**, never "an element exists" — M6's
  rule, and the reopened document's images must reach `loaded`, which is what proves the
  renderer resolved assets against *the document it just opened*.
- **Refusal tests assert four things**, not one: the object count, the dirty state, the
  filename, and that the message names the actual fault. "It showed an error" is satisfied by
  a wrong error.

### Deliberately not implemented

PDF, SVG, PNG/JPEG export, print, autosave, crash recovery, IndexedDB, cloud sync,
collaboration, File System Access, `external` resolution, asset garbage collection, asset
deduplication, an asset browser, format migrations, document thumbnails, templates.

### Confirmed for the next milestone

- **A project folder is the prerequisite for `external`**, and a document handle is the
  prerequisite for save-in-place. Both need persisted session state, which M7 deliberately does
  not have.
- **Asset garbage collection is still owed**, and it is now harder to bolt on: assets round-trip
  through a file, so a collection pass must not run on load, or opening and re-saving a
  document would silently discard undo history's bytes.
- **Autosave would make `New`'s confirm prompt wrong**, so the two belong in the same milestone.
- **`extensions` is preserved but never interpreted.** The first plugin-shaped feature will need
  to decide what that means.
- **A new authored property is either a version bump plus a schema entry, or it goes in a
  node's `extensions`.** There is no third option, and an older build will refuse the file
  loudly rather than drop the field.

---

## M8 implementation notes — multi-object editing

The milestone was named "layers, groups, and multi-object editing". Two of those three turned
out to be already built, and the third turned out to be the wrong next increment. Both findings
are in [ADR 0008](adr/0008-multi-selection-and-grouping.md), which is the primary document for
this milestone; this is the summary.

### What was implemented

- **`restack`** — a relative layer-order command in the model
  (`{ type: 'restack'; pageId; ids; direction }`), with all four directions, one command for any
  number of objects, and reference-identity no-op detection.
- **Four layer buttons** and `[` / `]` with the command key for the ends, in
  `src/ui/chrome/shortcuts.ts`. Four commands, not a layer panel: a panel is a second place that
  has to know and display paint order, which is the desynchronisable-second-source problem that
  made M0 reject a `zIndex` field.
- **`visible`, `locked`, `opacity` and `blendMode` in the Transform section**, mixed-aware, one
  command for the whole selection. These are `BaseNode` fields and the Transform section is the
  only one rendered for a selection of mixed types — which is why a text frame's opacity had
  been unreachable since M3.
- **Named `setProps` commands.** `describeCommand` returned `Change` for every `setProps`, so
  every appearance-field commit already read "Undo Change"; a single top-level key now names the
  command.

### What the investigation found, before any code

Measured against the milestone's own list, multi-selection was **already complete**: marquee,
additive selection, deferred single deselection, select-all, multi-delete, multi-move, and
mixed inspector values all existed and were tested. Building them again was the milestone's main
risk. `reorder` also existed as a command and was **unreachable from the user** — that was the
real gap, and it is now closed.

The flat `Page.objects: Node[]` carries four meanings and deliberately refuses two: paint order,
identity, coordinate space and persisted order are all the same array, while *selection order* is
a `Set` in editor state and page ownership is containment. A second order has nowhere to live.

### Deliberately not implemented

**Grouping**, and **multi-object resize**.

- *Group resize*: a non-uniform resize of a rotated object needs a shear, and `Transform2D` has no
  shear parameter. Proved in `src/model/group-resize-limit.test.ts` by exhibiting the required
  matrix and showing its columns are not perpendicular — which is exactly the set `R(θ)·S(sx,sy)`
  can produce. The exception is precise: a multiple of 90°, where the page-frame axes coincide
  with the object's own.
- *Grouping*: of the two coordinate models, children-in-page-coordinates gives a group whose
  transform is *derived* and therefore unauthorable and unpersistable — and which multi-selection
  already provides every interaction for. Children-group-local is a second coordinate space that
  the measurement boundary and the text fence have not been proven against, and it is a format
  version bump. The five preconditions for doing it properly are ADR 0008 §5.

Also not built: snapping, guides, grids, alignment and distribution, nesting, boolean operations,
clipping, masks, a layer panel, collaboration.

### Two bugs found, both from tests failing unexpectedly

1. **A shift-click press could start a native text selection, and Chromium answers that with
   `pointercancel`** — after which the pointer delivers nothing at all. Shift-click two objects
   and drag, and they moved 7.5px of an intended 60px, the gesture never ended, and the editor
   kept the capture. Fixed by claiming the pointer (`preventDefault` on the gesture's
   `pointerdown`, skipped inside a frame being edited) and by handling `pointercancel` through
   the existing `Editor.cancelGesture`.

   The pre-existing test for this behaviour asserted only that the inspector went mixed, which one
   increment satisfies — so the bug was live and green. The M8 test asserts the **full** delta.
   That difference is the whole reason it was found.

2. **A hidden object was unreachable by any means** — hit testing and the marquee both skipped
   `visible: false` — so the new `visible` checkbox would have been a one-way door. A marquee
   now takes hidden objects: a click is a point gesture and there is nothing to click, a marquee
   is a region gesture and is the only way back. `locked` stays excluded from both, because
   Alt-click already reaches it: locking is a barrier, not a hiding place.

Two more were found by the new tests rather than by inspection: the overlay's per-object marker
shared the name `data-oid` with the renderer's, so `[data-oid="x"]` matched two elements in two
layers (now `data-for`); and a restack that moved an object over a selected neighbour which
itself could not move inverted the selection's order.

### Testing

- **38 browser tests** in `tests/editor/layers.spec.ts`, and **27 unit tests** across
  `src/model/restack.test.ts` and `src/model/group-resize-limit.test.ts`.
- **Layer order is observed as DOM order within the page.** Not a shortcut: the renderer appends
  in array order and CSS paints in DOM order, so the rendered sequence is the model's paint
  order is the persisted order. One observation, three claims, and a user-visible surface rather
  than a test hook.
- **Every setup helper asserts the intended selection** — and one of them has to clear the
  selection first, because a plain click on an already-selected object deliberately *keeps* the
  selection rather than reducing it, which is what makes dragging a selected object work.
- **Restack is asserted not to touch geometry or paint**, because an implementation that rewrote
  a node would pass every order assertion.
- **The full-delta drag assertion** is the `pointercancel` regression guard, and the reason it
  is written as it is.
- 26 mutations, six of them M8's, each asserted to turn a suite red. The `pointercancel` listener
  is **not** mutation-covered and the script says so: with the cause removed, no cancel occurs,
  so deleting the listener is unobservable.

### Confirmed for the next milestone

- **A selection has no aggregate frame, and that is deliberate.** For a 30°-rotated 200×50 box
  the painted height is 143.3, so a rectangle around several rotated objects would match nothing
  the user can see or click, and handles on it would invite the shear resize. The honest cost is
  that nothing says "these five, as a set" as a *shape*; the status bar's count is most of the
  answer.
- **`restack` acts on the current selection**, so two restacks with a click between them are not
  inverses. Anything automating the chrome has to re-select rather than assume.
- **A non-uniform group resize needs a shear parameter**, which means a new transform field, a new
  invariant, and an amendment to ADR 0005's geometry contract. That is the price, and it is why
  the decision was proved rather than taken.
- **`SelectionState.anchor` is documented as the anchor for an alt-cycle that does not exist.**
  `altKey` means `includeLocked`.
- **Grouping is a model feature, not an interaction one.** The first honest cut is "remember
  these five objects as one thing", with a derived transform that is never persisted — which is
  why it needs its own milestone, its own version bump, and its own proof that the renderer and
  the text fence handle a second container.

---

## M9 implementation notes — interaction integrity

A milestone with no features, whose output is a list of things that were wrong. The primary
document is [ADR 0009](adr/0009-boundaries-audit.md); this is the summary, and the M9 notes on
what held are as much a part of it as the findings.

### What was already correct

Stated first, because an audit that only lists defects misrepresents the codebase.

- **Model immutability held** — and is now *proved* rather than assumed.
  `src/model/immutability.test.ts` deep-freezes a document and runs every command in the funnel
  against it; every module is an ES module and so runs in strict mode, so one
  `expect(...).not.toThrow()` covers the document, a page's `objects` array, a node, a nested
  `transform`, a `fill`, the `assets` record and the asset bytes at once.
- **The sharing half held too**: an untouched node comes back as the *same object*, which is what
  lets the reconciler skip it.
- **The reconciler's contract held.** Elements are keyed by node id and reused; reordering *moves*
  them, asserted with a token stashed on the element object.
- **The persistence boundary held.** Every piece of state classifies as authored, derived or
  editor-only, and the dangerous direction — authored state living only in the DOM — is empty.
- **The browser/model split held.** Nothing treats a measurement as authored; nothing duplicates
  browser layout without necessity.

### What was actually changed

Five source changes, each proved by a failing test first:

1. **Window `blur` now ends an in-flight gesture** (F1), through the same `Editor.cancelGesture`
   as <kbd>Esc</kbd> and `pointercancel`. Four tests across move, resize and marquee failed
   before this.
2. **`History.flush` drops an entry canonically equal to its start** (F5). An out-and-back drag
   was landing on the history.
3. **The reconciler owns `data-oid` and `data-type`** (F2). The three renderers no longer write
   them, in two different notations.
4. **`SelectionState.anchor` removed** (F3). It was written as `null`, read by nothing, and
   documented for a shift-extend and an alt-cycle that do not exist.
5. **`beginBodyGrab` routes every branch through `setSelection`** (F6). Two of three skipped the
   overlay redraw, covered only by a coincidence of call order.

### Every invariant found to be false

| # | The invariant | How it was found |
|---|---|---|
| F1 | *A gesture is ended by something other than the user finishing it.* `blur` did nothing, so a gesture survived alt-tabbing — dead but still believed live, observable because <kbd>Esc</kbd> after the blur still rolled it back | a cancellation test written from the state-machine table |
| F2 | *One semantic attribute, one writer.* `data-oid` and `data-type` had three writers in two notations | a Playwright strict-mode violation on a locator that had looked reasonable — M8 had fixed the symptom, not the class |
| F3 | *A field in `SelectionState` is a supported semantic.* `anchor` was neither | reading every use of it: two writes, zero reads |
| F5 | *A gesture whose result equals its start is not an action.* `flush` compared by reference, and a gesture accumulates floats | an out-and-back drag left the object visibly where it started and still produced an undo step |
| F6 | *One code path per state transition.* `beginBodyGrab` had two | reading the method |

The recurring lesson is F1 and F2 together: **the same defect shape appeared twice, one trigger
apart.** Chromium has three ways a pointer can go away and only one was handled; the same DOM
attribute was written in four places and the collision was found by symptom rather than by
construction.

### Bugs found

The five above. One was a **live user-facing bug that no test could see**: shift-click two
objects, drag, and the pair moved 7.5px of an intended 60px while the editor hung mid-gesture
(M8's `pointercancel`). Its sibling — `blur` — was the same bug one trigger over, and the
milestone that found it is the one that had written the test proving the *other* trigger was
fixed.

### Architectural decisions made

> - An editor that captures the pointer must handle `pointerup`, `pointercancel` **and** window
>   `blur`, all three through one method.
> - One semantic DOM attribute, one writer, stamped on creation only. `data-oid` is object
>   identity; `data-type` is the node type and the application never dispatches on it; the
>   overlay stamps `data-for`.
> - "Unreachable" is **not one rule**. Locked is a barrier with an Alt key; hidden is invisible and
>   needs a marquee — and Alt does *not* reach it, which was not obvious and is now asserted.
> - A gesture is not an action if its result equals its start, and the comparison must be
>   *canonical*, because a gesture accumulates floats. A tolerance in the model was rejected: it
>   would make `apply` stop being a total function of its inputs.
> - `primary` has no DOM observable. The overlay draws outlines in document order, so the only way
>   to observe it is <kbd>Enter</kbd>. An audit should say that rather than invent a projection.

### Tests added

- **`src/model/immutability.test.ts`** — 11 unit tests. Deep-freeze plus reference identity, over
  every command.
- **`tests/editor/cancellation.spec.ts`** — 19 tests. Every exit path for every gesture, each
  asserting the document is **byte-identical** to before and the history is empty. Bytes rather
  than geometry, because a rollback missing one pixel of sixty passes a `toBeCloseTo`.
- **`tests/editor/interaction-matrix.spec.ts`** — 24 tests. The reachability matrix declared as
  data, plus the DOM identity rule and the reconciler's move-don't-recreate contract.
- **`tests/editor/boundaries.spec.ts`** — 13 tests. The persistence boundary, dirty state against
  a real save, undo/redo around multi-object commands, and a text session against an external
  change.

Total: **591 unit** (was 579), **468 browser** (was 411), **30/30 mutations** (was 26),
**32.98 kB gzipped** (was 33.06 — *smaller*, because removing `anchor` and three duplicated
identity stamps more than paid for the blur listener and the canonical check).

### What could not be made testable

Recorded in `scripts/mutation-check.ps1` rather than papered over:

- The **`pointercancel` handler**. With the `preventDefault` cause removed, no cancel occurs, so
  deleting the listener is unobservable. Same for the correctness of the `blur` handler beyond the
  behaviour above.
- **`cancelGesture`'s idle guard.** No open transaction means `History.abort` returns null and
  nothing follows, so the guard has no present behaviour — it is defence against a *future* caller
  reaching it during a text session.
- **`beginBodyGrab`'s routing.** Both forms redraw once.
- **`anchor`'s removal.** A field written as `null` has no behaviour to mutate; the test that
  pins it asserts the state's *shape*.

### Deliberately not done

No M10 features. No new format version, because nothing authored changed. No generic
state-machine framework: `Editor` already had the right shape — a six-variant union, one
`pointerDown` choosing between them, two exits — and a framework would have been the
"infrastructure for features that don't exist" mistake this project already has a rule about.

### Newly discovered architectural risk

**Interaction state is single-writer, and M9 made that assumption visible rather than resolved.**
A gesture captures the document state it started from, so a change made *during* a gesture is
overwritten by the next `pointermove`. That is fine today because there is no second writer — the
text fence defers its writes, and the only other writer is the user. It becomes a real constraint
the moment anything else can write: a collaborator, a plugin through `extensions`, or a
background asset resolution. It is now recorded in the status limitations and in ADR 0009 rather
than left implicit in a `Map` captured at press time.

### Confirmed for the next milestone

- **Grouping is M10**, with the five preconditions unchanged (ADR 0008 §5). M9's audit does not
  soften them: the text fence and the measurement boundary are still unproven against a second
  coordinate space.
- **The overlay marker is now load-bearing in a second way.** `data-for` is asserted by count, and
  the reconciler owns the object-side stamps, so a collision fails as one named test.
- **A selection's "cannot be selected" is two rules, not one.** Anything that adds a way to reach
  an object — a layer panel, an outline view — has to decide which of the two it is honouring.

---

## M10 implementation notes — Groups, and the transform question

An investigation milestone. **No grouping was built**, and the reason is a re-ordering of the
roadmap rather than an obstruction. Full argument in
[ADR 0010](adr/0010-groups-and-the-transform-question.md).

### What was already supported

More than M8 credited. A group with **page-local** children needs no geometry work at all: the
child's `transform` is already page-space, so `worldMatrix(child)` is the answer whether or not a
group exists and nesting can never introduce a shear at any rotation, scale, or depth. Hit testing
needs `invert(worldMatrix(child))`, which `parentToLocal` already does. This is proved, not
asserted — `src/model/group-composition.test.ts`, option A section.

Grouping also does not need DOM nesting. Children render into the same flat container as everything
else, so §10's concern about introducing a DOM hierarchy evaporates rather than needing an answer.

And M8's stated blocker was wrong. §4's pessimism rested on the text fence and the measurement
boundary being unproven against a second coordinate space. M10 measured both under a rotated and
non-uniformly-stretched ancestor: **layout APIs are unaffected** (`clientWidth`, `offsetWidth`,
`scrollHeight` all unchanged while `getBoundingClientRect().width` moved 300 → 480 → 338.6), and the
text fence survives intact — still `contenteditable`, still one model commit per session, and the
committed text is the model's canonical form, verified negatively by reading `innerHTML` and
watching the test fail. A CSS transform changes paint; every API the measurement boundary uses is a
layout API. See `tests/editor/transform-invariance.spec.ts`.

### What was proven

**Option B, group-local children, is blocked — and the obstruction is on the child, not the group.**
Composing `R(θg)·S(σxg, σyg)` with `R(θc)·S(σxc, σyc)` gives columns whose dot product is
`−σxg σyg σxc σyc · sin(θc)`. So a non-uniform group scale is representable exactly when the child is
unrotated, and rotating the *group* does not help. The same proof, for the same reason, appears in
ADR 0008 §4 for multi-object resize.

Both proofs now share one predicate, `isRotationTimesScale`, in `src/core/geom/linear-part.ts`.
ADR 0008 asserted the *sufficiency* half in a comment and never tested it; M10 did, by factoring
perpendicular-column matrices back into `R` and `S` and requiring the product to reproduce the
original. Both files import the single function so they cannot drift apart.

**Option A is implementable but adds only identity.** A page-local group has no transform of its
own, therefore no authored geometry: no `x`/`y`/`width`/`height` to store, nothing for
`setTransform` to write, nothing for `describeCommand` to name, and bounds that are necessarily
*derived* because they must change when a child moves. Every geometric operation on it is therefore
a fan-out over children — which is exactly the multi-select move and rotate M8 already built. It is a
layer folder.

### What was decided, and why it is not "impossible"

Option A could have been built this milestone. It was not, for a reason that is about sequencing
rather than feasibility:

1. The version that earns grouping is option B, and option B is gated on whether `Transform2D`
   admits a shear — the same gate as multi-object resize. **Those are one capability wearing two
   costumes**, and grouping is a bad place to settle it, because settling it *for* grouping means
   choosing the smallest version of it.
2. A `group` node type mandates `formatVersion: 2` under ADR 0007's own rule. Option B later adds a
   coordinate space to that node, which changes the on-disk shape again, so `formatVersion: 3` — two
   bumps and two migrations for one feature, spent first on the half that adds no capability.

The specification for option A is written down in ADR 0010 §§2–5 in case it is wanted sooner,
including the seven `Page.objects` traversal sites that must learn to recurse and the specific
silent failure each one produces.

### Bugs and findings

Five, of which two correct the record:

- **F1 — `scaleX`/`scaleY` have no writer.** No gesture writes them; they exist so a file can carry
  them. Every live matrix is a pure rotation, so the no-shear property holds because *nothing
  scales*, not because anything prevents it.
- **F2 — `scaleTransforms` is dead code and is wrong.** Nothing outside its own tests calls it, and
  those tests use only unrotated boxes, where growing `width`/`height` about a pivot *is* a scale.
  Given a rotated member it grows the box and leaves `rotation` alone — neither a page-frame scale
  nor the bounding box of one. Left in place, because deleting it loses the reasoning, but pinned in
  `src/editor/transform.test.ts` where the next implementer will look.
- **F3 — the rotate handle exists only for a single, unrotated selection.** Rotating is a one-way
  trip with no gesture to adjust the angle afterwards, and `startRotate`'s multi-object fan-out has
  **no gesture that can reach it**. This amends ADR 0008 §4, which assumed a multi-selection can be
  rotated.
- **F4 — `selectionRect` is already the frame a group would want.** The blocker is not computing a
  box; it is that scaling *about* one is unrepresentable.
- **F5 — ADR 0008 §5's deferral rationale is corrected**, as described above.

### Tests

- `src/core/geom/linear-part.test.ts` — 9 unit tests, including the sufficiency direction ADR 0008
  asserted without testing, and the operand-order asymmetry that is the whole of ADR 0005's warning.
- `src/model/group-composition.test.ts` — 10 unit tests: option B's obstruction, the exact
  constraint, the inspector-honesty corollary, option A's geometric freedom, and the separate
  observation that the renderer is not the constraint.
- `src/editor/transform.test.ts` — 4 new tests pinning `scaleTransforms` against a rotated member.
- `tests/editor/transform-invariance.spec.ts` — 2 browser tests: measurement invariance under a
  transformed ancestor, and the text fence under one.
- `tests/editor/no-shear.spec.ts` — 7 browser tests: the invariant over the live document after each
  gesture the editor can perform, plus **two that require the sweep to fail** — an injected shear
  must be rejected, and a pure rotation and a pure non-uniform scale must be accepted. A guard that
  cannot fail is not a guard.

Two of those tests failed for instructive reasons while being written, both recorded in place: the
"move" test initially passed *vacuously* because `rect-rotated` sits at y=320 on a 300-high page, so
the click never landed; and the "resize" test asserted that the matrix scale had changed, when a
resize changes the *box* and leaves the scale at 1 — a consequence of F1.

### Deliberately not done

No grouping, in any form. No `GroupNode`, no `groupObjects`/`ungroupObject`, no `formatVersion`
bump, no layer panel, no group outline. No shear parameter, and no partial one. The shear decision
is recorded as **M10b** rather than taken here.

**No production code changed at all**, so the mutation suite is unchanged at 30/30 and the bundle is
byte-for-byte M9's 107.61 kB raw / 32.98 kB gzipped — `src/core/geom/linear-part.ts` is imported
only by proofs and tests and is tree-shaken out. `scripts/mutation-check.ps1` records why there is
nothing new to mutate, and why `scaleTransforms` (no callers) and `scaleX`/`scaleY` (no writer)
cannot be reached by a mutation at all. That is the honest result rather than a gap: a browser-level
invariant is not expressible as a source mutation, which is why `no-shear.spec.ts` — including its
two tests that require the sweep to fail — is the coverage.

### Architectural risk

**The roadmap was pointing at a feature instead of a capability.** Two milestones' worth of
deferral (ADR 0008 §4 and §5) rested on the same obstruction without either naming it as shared. The
risk now is the opposite one: reaching for `scaleTransforms` when someone wants a scale gesture, and
shipping a shear. It is documented in the only file that would be opened, and the live invariant is
checked by a test that can fail.

### Confirmed for the next milestone

- **The shear decision (M10b) is architectural, not a feature.** Its first half is an inventory of
  every place that assumes a meaningful rotation angle — the inspector's field, `rotateTransform`'s
  arithmetic, the overlay grip's position, `selectionRect` — and a decision about what each reports
  for a sheared object.
- **M11 is now a prerequisite rather than a parallel track.** The argument against building groups
  first is that it would spend `formatVersion: 2` on a variant with no capability.
- **A group has no second writer.** Interaction state remains single-writer (ADR 0009), and M10
  checked that groups do not make it worse: a page-local group's geometry is derived and never
  authored, so there is nothing new to write to.

---

## M10b implementation notes — Does the geometry model need affine transforms?

A decision milestone. **No production geometry was changed**, and the transform model is **not**
extended. Full argument in [ADR 0011](adr/0011-affine-transform-decision.md).

### The inventory

Every production site that reads `rotation`, `scaleX` or `scaleY` — **28** of them. `.rotation` is
read in nine places; the scales in nineteen. Classified in ADR 0011 §1:

- **9 need nothing**, because they need only an *invertible* matrix: hit testing, the shape
  predicates, `resizeTransform`, measurement, the renderer projections, `cssMatrix`, the reconciler.
- **7 are representation-only** — one field and one factor: `types`, `factory`, `localMatrix`,
  `worldMatrix`, `invariants`, `commands`, `document-equality`, `serialize`/`deserialize`,
  `commonFrame`.
- **7 carry semantic consequences**, and they cluster in exactly three places: **what "rotation"
  means**, **the selection frame**, and **the stroke**.

That ratio is the decision. It is also why "it would be a second geometry system" is *not* an
available argument, and ADR 0011 does not make one.

### The mathematics

The current linear part is **3 parameters**; `GL(2)` has **4**. The model is therefore a
**codimension-1 subset** — "no shear" is one equation, `a·c + b·d = 0`, and general affine is what
you get by dropping it. Proved from the definition in `src/core/geom/affine.test.ts`, because ADR
0010's decision rested on it being true and a reader is entitled to refute it.

The candidate is `R(t)·S(sx,sy)·K(kx)` with `K(kx) = [[1,kx],[0,1]]` — CSS's `skewX`, in the object's
own axes. `decomposeRSK ∘ composeRSK = id`, and it surjects onto `GL(2)`, so it is a bijection once
`scaleX > 0` is required; that single branch rule is what keeps field-wise equality and a one-spelling
file correct. **A 2×3 matrix is rejected on legibility**: §1.3's "directly editable in the inspector"
and ADR 0007's byte-stable round trip both argue against six opaque floats, and a matrix has no
canonical form without a new rule.

**Rotation survives**, and the reason is the *factor order*: `K`'s first column is `(1,0)`, so `K`
cannot touch the first column of `R·S·K` — which is `sx·(cos t, sin t)`. The first column's angle is
therefore still the authored `t`, at any shear, and `atan2(b,a)` — what the inspector effectively
reads — keeps working. Three caveats, each tested: the *derived* polar rotation diverges from the
authored field as soon as `kx ≠ 0` (30° authored, 11.4° polar); the polar rotation has a π branch when
`sx + sy < 0` and returns `null` for a reflection; and with the skew in the **page** frame the
property fails. So: **expose the authored field, never a derived one.**

### What survives unchanged, and what does not

Unchanged, and proved for any invertible matrix rather than argued:

- **§4 `width`/`height`** stay the local box. A 200×50 box means 200×50 after any affine, because
  the four local corners are at fixed local coordinates.
- **§5 resize** is exact for all eight handles, because the rule is stated entirely in the object's own
  coordinates and there is no step at which the matrix can enter. It changes local geometry only —
  never the rotation, never the scales.
- **§7 hit testing** is affine-invariant for rect, ellipse, line, text and image, because the hit set
  in page space is the affine image of the local set.
- **§10 text** and **§11 images** are unaffected: layout is local and stays local, and intrinsic size
  is metadata that no transform can alter.

Not unchanged:

- **§6 rotation** must become parent-space. `R` commutes with `R` but not with `R·S·K`: pre-multiplying
  accumulates the angle and carries the scales and shear untouched, post-multiplying redistributes
  them. Parent space is the only order with a closed form, and so the only one under which repeated
  rotation is stable.
- **§8 selection geometry** is the largest consequence, and it is **not caused by affine**.
- **§9 stroke** has no cheap answer, and the project has never made the choice.

### Two pre-existing bugs, found by the inventory

- **F6 — the selection outline does not follow rotation.** `toRect` returns the object's
  `x/y/width/height` and the overlay writes them with **no transform at all**. Measured: a rotated
  ellipse paints 171.2 × 156.6 at (975.4, 234.2) while its frame is 140 × 100 at (991, 262.5),
  `transform: none`. The eight handles sit on that frame, so they point at the wrong place. This is
  the mechanical reason for both the rotate-handle suppression and the deferred multi-object resize,
  and it makes `selectionRect` a **frame**, not bounds — a distinction that has been blurred since M8.
  Reclassified from "semantic change" to "fix a bug, then representation-only".
- **F7/F8 — the stroke semantic has never been chosen.** Every stroke is a CSS `border`, and a border
  transforms with its element: measured, an authored `12px` border paints **24 × 36** at
  `scale(2,3)` and **19.2** under a shear. Because no gesture writes the scales, document-space and
  object-space invariance are currently **indistinguishable**. And document-space invariance is not
  reachable by adjusting a number: Chromium *accepts* `vector-effect: non-scaling-stroke` on an HTML
  element and then ignores it, because the property is defined for SVG geometry — so semantics A
  means an SVG stroke renderer, which would be the one part of this renderer CSS cannot express.

### Decision

**RESTRICT GROUPS.** Group-local children are supported; **group scaling is uniform-only**;
`Transform2D` is not extended.

The evidence, in order:

1. The mathematics is not a reason to refuse — one field, one equation, and every arithmetic site is
   already correct for any invertible matrix.
2. It buys **exactly one capability**, non-uniform scaling, and **nothing can produce it**: no gesture,
   no inspector field, no command writes `scaleX`/`scaleY`, and the one function that would is dead and
   wrong.
3. It forces three permanent semantic decisions, and the stroke one has **no cheap answer**.
4. Restricting group scaling costs almost nothing — uniform group scale composes exactly, so
   `page → group → child → local` works for every case except non-uniform group scale with a rotated
   descendant.
5. The restriction is stated and proved, not approximated — the standard M8 set for multi-object resize.

**The precondition ADR 0010 recorded is now satisfied** for every case but one, and that residual case
is resolved by restriction. Groups are no longer blocked on a capability question.

### Persistence

Unchanged at `formatVersion: 1`. The refusal is what avoids a bump. Had affine been adopted it would
have been **2** — one new optional field `skewX`, absent meaning 0, **no data migration**, since every
version-1 transform is already in the model's image. Field-wise equality stays sound precisely because
the parameterisation is a bijection; a 2×3 form would have needed a canonicalisation rule for ADR
0007's byte-stable round trip to depend on.

### Tests

- `src/core/geom/affine.test.ts` — 22 unit tests: the candidate's compatibility, invertibility,
  round-trip, surjectivity, singularity; rotation's survivability and the polar divergence; the
  canonical-form asymmetry against a raw matrix; float round trip; and the codimension claim.
- `src/core/geom/linear-part.test.ts` — extended to share one predicate with both proof files.
- `src/model/affine-interaction.test.ts` — 17 unit tests: §§4–8 above, at matrix level, against the
  same operations the production functions perform.
- `tests/editor/frame-vs-shape.spec.ts` — 3 browser tests: F6, with an unrotated control.
- `tests/editor/stroke-under-transform.spec.ts` — 5 browser tests: F7/F8, measured, with the
  `vector-effect` negative control.
- `tests/editor/no-shear.spec.ts` and `transform-invariance.spec.ts` — unchanged and still green.

**Nine of the proofs' own test expectations were wrong on the first run** and are recorded in place,
because each was a wrong belief rather than a typo: `skewX` belongs in `c` not `b` (a lower-triangular
`K` tilts the first column, and `decompose` then reported 0.2914 rad for an object authored at 0);
"any shear tilts the first column" was false; the decomposition *is* unique for reflections, and the
earlier claim conflated uniqueness with the existence of a rotation; the polar factor is a function of
the matrix and cannot depend on how it was spelled; negating **both** scales is a rotation by π, not a
mirror; rotations commute with rotations, not with `R·S·K`; a shear can *narrow* an AABB; a rotated
200×50 box paints 198.2 wide, not more than 200; and `'vectorEffect' in document.body.style` is `true`
in Chromium.

### Deliberately not done

No affine parameter. No `skewX` field. No `formatVersion` bump. No group of any kind. **No fix for F6
or F7** — both are recorded with measurements and both belong to the milestone that touches the
overlay and the stroke. The rotate-handle suppression stays: lifting it before the frame is fixed would
put the grip in the wrong place.

### Architectural risk

**The temptation to treat a semantic as free because the arithmetic is.** Every arithmetic site in the
inventory is already correct for any invertible matrix, which makes affine look like a one-field
change — and it is not. The costs are a second meaning for "rotation", a stroke semantic with no CSS
route to invariance, and an inspector that would gain a skew field while still exposing no scale
fields at all. ADR 0011 §14 classifies each, and §17 sequences the work with the stroke **first**,
because it is the only step that can invalidate the rest.

### Confirmed for the next milestone

- **The affine re-entry condition** (ADR 0011 §16): a scale gesture must exist, non-uniform scaling must
  be wanted, **and** a stroke semantic must be chosen. The third is the binding one.
- **Multi-object resize is not blocked on the model** — it is blocked on there being no scale gesture.
- **Groups are unblocked** with uniform-only group scaling, and still want the `formatVersion` bump that
  M11's migration chain should be designed around.
- **`selectionRect` returns a frame.** Anything that needs painted bounds must compute the AABB of the
  four transformed corners; a shear has no closed form for it, so the corner computation is the
  specification. **(Done in M11: `paintedBounds` exists, and `selectionRect` is now
  `modelFrameUnion`.)**

## M11 implementation notes — The geometry groups will stand on

Groups became architecturally unblocked in M10b, which left two pre-existing defects standing
between here and them: **F6**, the selection outline did not follow rotation, and **F7/F8**, stroke
scaling semantics had never been chosen. A group will be moved by dragging its frame and will carry
members whose strokes must not change meaning when it scales — so both answers had to be explicit
*before* there was a group to be wrong about. Full argument in
[ADR 0011b](adr/0011b-selection-frame-and-stroke.md).

### F6's root cause was one error in five consumers

Not "the overlay forgot the rotation". The codebase had **four different ideas of where an object
is**, used one of them for all four, and called it "bounds":

| consumer | used | correct for |
|---|---|---|
| the outline box | `{x, y, width, height}` | an unrotated object |
| the eight handles | the same + `HANDLE_UNITS` | ditto |
| `applyMarquee` | `toRect` per object | ditto |
| `hitTestPage` → `hitNode` | `invert(worldMatrix)` + a local predicate | **every object** |
| `paintedBounds` | *did not exist* | — |

Five sites, one mistake. The hit tester was right throughout, which is why the bug was invisible in
behaviour and visible only in the chrome: clicking a rotated object worked, dragging it worked, and
the outline around it was in the wrong place. It is also why it survived nine milestones — every
interaction test asserted on a gesture's *outcome*, and the gestures were correct.

### The fix reuses the projection; it does not add one

`render` already writes `transform: matrix(...)` with `transform-origin: 50% 50%` onto every object.
The overlay now writes **the same matrix, with the same origin**, onto a box laid out at the same
`{x, y, width, height}` — so the outline is the object by construction rather than by a second
computation of it.

`SelectionOutline` gained `matrix: Mat2D`; `framePoint`, `handlePoint` and `rotationGripPoint` are
public; and **`editor.handleAt` now calls `handlePoint`** instead of recomputing. That last one is the
structural point: the drawing and the hit test each used to compute `rect.x + rect.width * unit.x`
independently. They agreed with each other and both were wrong — the worst arrangement available,
because a fix to one would have left the other behind and produced "the handle I can see is not the
handle I can grab".

`src/editor/viewport/overlay-frame.test.ts` asserts `framePoint === localToParent` for six probes ×
five transforms. That cross-check is the point: each side's own test would pass while the two
disagreed.

### A bug the fix introduced, caught by the zoom test

The first version composed `scale(zoom)` into the outline's matrix, reasoning that the overlay is
outside the zoom transform. It was already wrong — `toClientRect` lays the box out at `width · zoom`,
so the zoom is in the layout and the matrix scaled it a **second** time. **At 100% this is invisible**,
so every other test passed; it appears only at another zoom, where the outline stops matching the
object. The zoom test caught it.

### Four quantities, four names

`paintedBounds` and `transformedCorners` are new; `selectionRect` is now **`modelFrameUnion`**. A
comment would have been read once — a name is read at every call site. §1.3.1 has the table.

The **marquee** moved to `paintedBounds` too: same root cause, one cause further out. A rotated object
could not be selected by a region that visibly covered it. Still box intersection, still not exact
pixels — that part of `applyMarquee`'s comment stands.

### The suppression is gone, and what replaced it

The rotate grip used to require `rotation === 0`. That was **not a capability limit** — it was a
workaround for the frame not following the rotation, and the comment said so. With the grip on the
transformed top edge it clears the shape at any angle, so the condition is now `outlines.length === 1`,
which **is** one: the pivot is the single object's frame centre, and M8 deliberately has no aggregate
frame.

**Consequence, and the point of the milestone: a rotated object can be rotated again.** Rotation was
one-way. Two successive rotations and one undo step are now asserted.

### Stroke: option B, chosen rather than inherited

**Stroke width is authored in the object's own units and transforms with the object.** Free (both
mechanisms are inside the transformed element), consistent with `width`/`height` being local
dimensions, and consistent with the **line's hit tolerance**, which is `stroke.width / 2` in local
units — so the grabbable region and the painted region scale together.

The price, stated: under a non-uniform scale one authored stroke becomes two painted strokes (**24 ×
36** from a single `12px` at `scale(2,3)`), and under a shear there is no single width at all
(**19.2**). Document-space invariance would require leaving CSS — `vector-effect` is **accepted and
ignored** on an HTML element — and would desynchronise the tolerance from the paint.

**And §8's rule for M12:** a group's uniform scale is a transform on the child, so it multiplies the
child's stroke by the same factor it multiplies the child's box. No separate "stroke scale" to keep
in step.

### The overlay's pixel baselines cannot see any of this

`maxDiffPixelRatio: 0.002` over the surface clip is several thousand pixels of tolerance, and a 1 px
chrome outline rotating is far under it. Verified: the `overlay-rotated` snapshot **passes both
before and after** the fix. The tolerance is right for page content and wrong for 1 px chrome, and
is not changed here because every other suite depends on it.

So **every F6 assertion is geometric** — `tests/editor/selection-frame.spec.ts` reads rectangles,
compares them, and asserts the old placement as a negative control. A guard that cannot fail is not a
guard, and neither is a baseline that cannot fail.

### Findings

- **F11 — the overlay baselines cannot detect a 1 px chrome change.** Trap 14 realised.
- **F12 — injected fixtures bypass the parser.** `window.__P1_FIXTURE__` is used as given:
  `expectOnlyKeys` never sees it and `normalizeRichText` never runs. A wrong shape is not *refused* —
  it reaches the renderer and throws, and the document mounts with **zero objects** and no sign that it
  was malformed. `RichText` is `{ blocks: [...] }`, not `{ paragraphs: [...] }`. Recorded on the fixture.
- **F13 — `HANDLE_DIRECTIONS` order is load-bearing.** The F6 test indexes handles by array order; the
  ordering is now stated in the test rather than assumed.
- **F14 — the layer rule caught a test that reached across it.** `src/model/` importing
  `editor/viewport/overlay` was refused by ESLint, correctly, and the cross-check moved.

### Consumers audited

| consumer | verdict |
|---|---|
| the outline box, its handles, the grip | **fixed** — the object's matrix, transformed corners |
| `editor.handleAt` | **fixed** — calls `handlePoint`; was a second copy of the same formula |
| `applyMarquee` | **fixed** — `paintedBounds` |
| `selectionRect` | **renamed** `modelFrameUnion`, documented against the other three |
| `commonFrame` | unchanged — compares five *fields*, which is what the inspector shows |
| `hitTestPage`, `resizeTransform`, `rotateTransform` | unchanged and correct |
| measurement, persistence, the format | unchanged — no model or format change |

### Tests

- `tests/editor/selection-frame.spec.ts` — 13 browser tests: rect, ellipse, image, text frame,
  zero-height line, zoom, second page, handles on the transformed corners, the grip outside the
  *shape* (not the box), the marquee, DOM identity, and pointer-events. With the old placement
  asserted as a negative control in each case that can fail.
- `tests/editor/stroke-semantics.spec.ts` — 6 browser tests: one semantic across the CSS border and
  the SVG island, rotation, the zero-height line, and §8's group-scale rule.
- `src/model/painted-bounds.test.ts`, `src/editor/viewport/overlay-frame.test.ts` — 12 unit tests
  between them, including the cross-check that keeps the overlay and the model in register.

**Eight of these assertions were wrong on the first run and are recorded in place** — page px mixed
with client px three times, a grip tested against a bounding box instead of the shape, a "negative
control" that computed 223.2 and compared it against 223.2, a remembered constant that was the wrong
term of the right formula, and a marquee region that turned out to overlap the very object it was
meant to miss.

### Deliberately not done

**No groups.** No group node, no group transform, no grouping UI, no ungrouping, no layer folders.
No multi-object resize. No aggregate selection frame. `formatVersion` unchanged at 1.

### Confirmed for the next milestone

- **M12 may assume:** selecting a group outlines its members' transformed frames; a group's uniform
  scale multiplies member stroke widths by the same factor as their boxes; `paintedBounds` is how you
  ask where an object is; `Overlay.handlePoint` is the only handle geometry.
- **Still deferred, now for a stated reason:** multi-object resize — a group's frame would need
  handles that resize members, which is ADR 0008 §4's shear.
- **The overlay's visual tolerance is a standing weakness**, recorded rather than fixed, because
  changing it affects every suite.

## M12 implementation notes — The group model

Groups became architecturally unblocked in M10b and their geometry was made explicit in M11. What was
missing is the thing a group **is**: a document object that can be saved, loaded, compared,
rendered, and transformed correctly, before anyone can create one. Full argument in
[ADR 0012](adr/0012-persistent-group-model.md).

### The group is an ordinary node with an ordinary parent

```ts
interface GroupNode extends BaseNode {
  type: 'group';
  children: Node[];
}
```

Four decisions, each load-bearing:

| decision | why |
|---|---|
| children **by value**, never by id | a node lives in exactly one array, so it has exactly one parent — the uniqueness rule is the data structure |
| `children` is **paint order**, never sorted | `[B, C]` and `[C, B]` are different documents |
| `transform` is an **ordinary `Transform2D`** | no new transform type, no second place for the scale |
| `width`/`height` are **authored**, never fitted to children | the frame is the rotation pivot; deriving it puts layout in the document and is circular once a child is a group |

**A group may be larger or smaller than its members, and nothing objects.** Fitting a group's frame
is a tool, not a property.

### The theorem that makes it cheap

A **uniform** scale commutes with every rotation, so

```
R(t1)·S(a1,b1) · R(t2)·S(a2,b2)  =  R(t1+t2) · S(a1·a2, b1·b2)
```

The composed linear part is therefore always `R(t)·S(sx, sy)` — **exactly** expressible as a
`Transform2D`, with no decomposition, no `atan2`, no sign convention and no reflection question.
`worldTransformIn` is that algebra; `width`/`height` pass through, because the composed frame is
still the child's own box, just positioned in a further-away space.

### The restriction, stated sharper than "groups scale uniformly"

The closed form needs the **left** factor's scale to be uniform, which is exactly:

> **A non-uniform scale may not be followed by a rotation.**

So the *same* `scaleX: 2, scaleY: 0.5` is **legal on a leaf** and **refused on a group** — nothing is
inside a leaf, while a group's children carry their own rotations. This is ADR 0011 §2's refusal in a
form that survives into the code, enforced by `UNIFORM_SCALE_EPSILON` in `validateDocument` with a
message that names the consequence rather than restating the rule.

**And the bug this prevented:** the first `worldTransformIn` *forced* the composed scale uniform,
silently discarding every scaled leaf's `scaleY`, and was caught by
`tests/visual/geometry.spec.ts` measuring a painted height of **200** where **50** was authored. A
model-level test would have called that correct — which is why `group-scale.test.ts` now includes a
control that exercises only the *legal* non-uniform leaf case.

### Nesting: allowed, to arbitrary depth

The recursion in `tree.ts` is the same at every level — no "top-level" branch, no "child" branch —
and that is the argument: a model needing a special case at depth two needs another at depth three.
ADR 0010 §2 chose group-local children *because* the coordinate model is already recursive.

**Depth is bounded at 64 for reachability, not expressiveness.** **Cycles need no separate rule** —
a cycle in a value tree revisits a node, so its id is in `seen`, so the existing duplicate-id check
catches it *and* terminates. `placementsInDocument` is deliberately unguarded and overflows on a
cyclic model; that is recorded rather than hidden, and two enforcement points stand between any such
model and the traversal.

### Paint order: a group flattens into its parent's slot

For `A`, `Group G [B, C]`, `D` the order is **`A, B, C, D`**. A group occupies one slot and paints its
children there. So **the paint stack is still a flat list** — the reconciler, tree-order-is-z-order,
`restack`'s rules and every DOM contract are untouched. Only the *matrix* is recursive.

**A group is a coordinate frame, not a rendering box.** No DOM nesting, no container element, no
stacking context, no `data-oid` on a group — and `document-view.ts` asserts that no group reaches the
reconciler, so the object-type registry has no group entry.

### One traversal, two spellings

`tree.ts` is the only module that knows how the hierarchy composes. Consumers get
`NodePlacement { node, world, transform, depth, ancestors }`:

| need | use |
|---|---|
| `left`/`top`/`matrix(...)` — the renderer, the selection frame | `transform` |
| `invert(world)` for hit testing | `world` |

`tree.test.ts` asserts `worldMatrix(placement.transform) === placement.world` at three depths. That
cross-check is the M11 lesson applied one level up: each side's own test would pass while the two
disagreed.

The renderer receives a **projected node** rather than a placement, so no renderer ever learns what a
group is. And `nodeById` / `placementOf` are **two functions**: the first finds leaves *and* groups,
the second leaves only, because asking the second for a group returns `null` — which reads as "no such
node" and is wrong.

### The version: 2, with version 1 still read, and no migration

A group is a new **variant** of the existing `Node` union — no field added, removed, or changed — so
the schema *can* represent it. ADR 0007's rule says bump anyway, so an older build refuses
deliberately rather than incidentally; the rule was **followed rather than re-argued**.

`MINIMUM_FORMAT_VERSION = 1`, so both are accepted, and **that is not a migration**: a version-1
document is a strict subset with no `children` array anywhere, so nothing is converted or defaulted.
Opening one and saving stamps `2` — a re-stamp, which is why the golden fixtures were re-stamped
rather than regenerated. Both version messages stay two-sided.

`children` is **required**: an absent array would give "no children" two spellings.

Two rules are not key-list questions and live where they can be seen — a **non-uniform group scale**
and a **duplicate id or cycle**. Without that pass, `parse` would return a group whose scale is
`(2, 1)` and the first symptom would be an object painted at an angle nobody asked for.

### Two bugs the milestone found

- **A hidden group did not hide its children.** `isEffectivelyVisible` checked the ancestor chain for
  hit testing, but the renderer read only the leaf's `visible`, so the subtree still *painted* — the
  group claiming to be hidden with its contents on the page. Both halves now agree: the projection
  propagates a hidden ancestor into `visible`, which every renderer already maps to `display: none`.
  `locked` is deliberately **not** propagated; locking is about interaction, not paint.
- **The dirty-state fast path stopped being sound.** `pagesEqual`'s `a.objects === b.objects` shortcut
  was true while a page's array was the only thing that could change. With a group it is not: a
  child's edit rebuilds the enclosing group while `page.objects` keeps its identity, so the function
  that decides whether the document is dirty would report differing pages as equal.

### Findings

- **F15 — two sources for `formatVersion`.** `createDocument` and `persist/format.ts` each held a
  literal; they agreed by coincidence and both were right until M12 moved one, at which point 17
  round-trip tests failed with "the document is not equal to itself after a round trip". The single
  literal now lives in `model/factory.ts` and `persist/format.ts` re-exports it. **A layer rule that
  forces a duplication is a reason to move the constant, not to write it down twice.**
- **F16 — a hidden group did not hide its children** (above).
- **F17 — `validateDocument` could overflow the stack.** The parallel asset-reference walk had no
  cycle guard, so a cyclic model overflowed *inside the asset check* — and `validateDocument` is the
  function everything relies on to **refuse** such a model. The enforcement point had become the
  thing that crashed on what it enforces against, which is worse than no guard because it looked like
  one. One traversal, one guard.
- **F18 — `worldTransformIn` had the centre-convention bug twice**: it subtracted the child's
  half-width twice, then mixed the parent's *page* centre with its *local* centre. Both are invisible
  for a parent at the origin.
- **F19 — `nodeById` could not find a group**, being `placementOf`-based.
- **F20 — the M12 fixture committed the trap its own header names.** `g-kinds` painted its first
  child from `y = -36`, above the page: clipped, unclickable, and the failure surfaced as a message
  about hit testing.

### Tests

- `src/model/tree.test.ts` — 32: paint order, depth, both spellings at three levels, ownership,
  cycles, the depth bound, structural edits, multi-page, nesting arithmetic.
- `src/model/group-scale.test.ts` — 17: the composition cases, degenerate geometry, **and the refused
  case** — the scale rule, the shear arithmetic executed, the boundary, and the legal non-uniform leaf
  control.
- `tests/persist/group-persistence.test.ts` — 31: the serialized shape, order at depth, every kind of
  child, absent fields, `collectIds`, byte stability, the version rules, and 13 refusals each asserting
  a **path**.
- `tests/editor/group-geometry.spec.ts` — 26: every kind inside a group against a hand-derived number,
  nesting, a hidden group, a flat control, paint order, hit testing against the *authored* position,
  chrome, and text editing.
- `tests/persist/version-ownership.test.ts` — 4: the two spellings of the version are one value.

**Nine assertions were wrong on the first run**, all recorded in place: the centre-convention mistake
three times, page px compared with client px in four places (including a 469px "error" that was pure
units), an expected value using the origins' separation rather than the centres', a click that missed
because a click does not open a text session, an ellipse "separated" by comparing bounding-box centres
of differently-sized shapes, a 90° rotation asserted without its 1.25 scale, a group-local origin
painted above the page, and a test inserted outside the `describe` whose `beforeEach` mounted the
fixture — so it saw an empty document and blamed geometry.

### Deliberately not done

**No group interaction of any kind.** No group/ungroup gesture, no selecting a group, no entering a
group, no group dragging, no group transform handles, no group resize, no aggregate group bounds, no
layer panel, no alignment, no snapping. A grouped child is hit-testable and therefore click-selectable
— a consequence of `hitTestPage` being correct, not a group feature, and recorded as such
(ADR 0012 §8).

`locateNode` is exported and currently unused in production: it is the answer to "which array owns this
node" and the first structural command will need it. Recorded as a deliberate exception to this
project's objection to unused code.

---

## M13 implementation notes - Group interaction

**Not written at the time.** The milestone was delivered and recorded in
[ADR 0013](adr/0013-group-interaction.md); this section is a pointer, added later so the Status
table's link resolves. What the ADR settles, and why it is worth reading rather than skimming:

- Grouping is a **pure structural array move** on M12's theorem — no new node type, no reparenting
  protocol, and therefore nothing new for the reconciler, the serializer or hit testing.
- The **ancestor/descendant selection invariant** is enforced in `setSelection` rather than filtered
  afterwards, so it holds by construction.
- `tree.ts` exposes four look-alike lookups with **different reachability** (`placementOf` finds leaves
  only, `nodeById` finds everything, `pageIdOf` answers `null` for a group). M13 shipped a selected group
  that drew no outline because it used `pageIdOf`, and every other signal said the object was there.
  ADR 0014 later hit the same seam and settled on `placementsInDocument` as the one traversal.
- **Explicitly out of scope, by decision:** group resize, group scale handles, a layer panel, and any
  group-specific inspector.

## M15 implementation notes - Boot reliability

**A harness fix, not a feature.** Recorded here because the symptom looked like an application bug and
was not one.

Roughly one test per full browser run died on a boot that produced no `[data-page]`. The harness reported
`no [data-page] within 15s` *alongside* `readout: "100%"`, and those were read as contradictory — an app
that painted chrome but no document.

They were not. `index.html` ships `<output data-zoom-readout>100%</output>` as **static markup**, so "100%"
was the default, present before any application JavaScript ran. The harness comment claiming the readout
was populated only after boot completed was false, and the readiness condition built on it was therefore
always half-true — contributing nothing while looking like a safeguard.

**Root cause.** A dev-mode boot pulls the module graph over ~49 separate requests, and one long-lived Vite
dev server served all of them. Every boot spent dozens of short-lived sockets, each lingering in
`TIME_WAIT` for 240s against a 16,384-port dynamic range. Over a full run the OS ran out:

```
/src/render/assets.ts -> status -1, _failureText "net::ERR_NO_BUFFER_SPACE"
```

Windows logged Tcpip event 4231 in the same second — *"a request to allocate an ephemeral port number has
failed due to all such ports being in use"*. The browser abandoned a request that never reached the
server, so `app.ts` was never evaluated.

**Fix.** The browser suite is served the **production bundle** for `/`, with the dev server reachable only
through the preview server's proxy for `spike.html`. The module graph collapses to a handful of built
assets, and the ephemeral-port pressure goes with it.

The lasting consequence is load-bearing for everything else in this file: **browser tests serve `dist/`, not
the dev server**, so a source change is invisible to them unless `dist/` is rebuilt. `mutation-check.ps1`
rebuilds before every browser mutant for exactly this reason, and this milestone is why that is not
optional.

## M16 implementation notes - Alignment and distribution

See [ADR 0016](adr/0016-alignment-and-distribution.md). Three decisions worth carrying:

- Alignment operates on **painted bounds in page space**, not on model frames, because a rotated or scaled
  object's visible box is not its model rectangle.
- **The aggregate box is calculation data, never geometry.** Alignment needs a box for the whole
  selection; ADR 0010 had already refused an aggregate selection frame as a rectangle *presented to the
  user*. `arrangeBounds` computes the union for arithmetic and never draws it. This is the distinction
  that keeps M16 from reopening the M8/M10 decision.
- The **page/parent coordinate boundary** is resolved explicitly rather than by convention, so a
  selection spanning pages has a defined answer.

A later correction is recorded against it: `distributionDeltas` stores only `sorted.slice(1, -1)`, so
for two objects the delta map is **structurally empty** rather than zero-filled. A test that assumed both
anchors were present was asserting an implementation detail; it now derives the result from the gap.

## M17 implementation notes - Snapping and guides

See [ADR 0017](adr/0017-snapping-and-guides.md).

- **What snapping measures:** the moving box against page features and other objects, in document space.
- **The threshold has to survive zoom**, so it is defined in *screen* pixels and converted:
  `snapThresholdDocument(zoom) = 10 / zoom`. A fixed document-space constant makes snapping stop working
  as the user zooms in, which is the defect the mutant `the threshold uses a fixed document-space
  constant, so zoom stops mattering` pins.
- **Choosing a snap:** page features are scanned first, so a tie goes to stable geometry rather than to
  whichever object happened to be iterated last.
- **Alt** suppresses snapping, and the two moments are split in time: at pointer-down Alt means *select
  the containing group*, during the drag it means *do not snap*.
- **Guides are derived, transient, screen-space state** — never persisted, and cleared in both `pointerUp`
  and `cancelGesture`.

### F21 - the defect this milestone's own testing found

The moving box must be **captured once at pointer-down** (`Gesture.bounds`), not re-derived from the
document each frame. The move gesture dispatches `setTransform` every frame, so `this.doc` holds the
*previous, already-snapped* position; re-deriving compounds the snap each frame.

The symptom was a snap **140px away from the object**, and Alt appearing broken. What made it findable
was that `computeSnap` was verified correct *on the exact failing numbers* while the browser was not —
the defect was upstream of the engine everyone was reading.

## M18 implementation notes - Visibility semantics

**`visible: false` is not a rendering detail.** Three parts of the system already agreed about it:

- `render/document-view.ts` propagates `visible: false` down a hidden group's subtree;
- `isEffectivelyVisible` in `editor/selection.ts` refuses to hit-test a node whose ancestor chain is
  hidden;
- ADR 0012 §A10 recorded the rule for the model.

The outlier was a comment in `arrange.ts`'s `boxFor` claiming a group is dropped when all its children are
invisible. Measurement showed it was not. **The comment was directionally right and the code was wrong** —
so the contract was established from the renderer, `selection.ts` and ADR 0012 rather than from the
comment, and `arrange.ts` now filters placements.

Effective visibility is therefore: **a node is visible when it and every ancestor are visible.**

Snapping inherits this for free, because it consumes the same arrangement targets. The milestone's real
content is that a rule three subsystems already implemented became written down in one place.

## M19 implementation notes - Print profile and PDF export

See [ADR 0018](adr/0018-print-profile-and-pdf-export.md) and §6.4.

- **Export is `window.print()`.** There is no PDF writer and no second representation of the document —
  the browser's own paginator is the renderer, which is the only way to get real page boxes without
  reimplementing text layout.
- **The profile is split in two**, because CSS cannot read the model: a static `@media print` block in
  `styles.css`, plus a dynamic injected `<style data-print-profile>` holding
  `@page { size: …; margin: 0 }`, re-derived from `doc.pageSize` on every store change.
- `printSheetSize` **reuses `pageExtentPx`**, so the sheet and the page cannot disagree about orientation.
- **Chrome is hidden, not removed**, so printing mutates no editor state.

### The defect worth remembering

Three print rules must beat *inline* styles written by `viewport.ts` and `document-view.ts` — `transform`
on `.pages`, `width`/`height` on `.canvas`, `top` on `.page`. The canvas spacer's height in particular
made a 3-page document print as **4 sheets**. It was invisible to every DOM assertion and was found only by
**counting sheets in a generated PDF**, which is why `tests/editor/print.spec.ts` asserts on a real
`page.pdf()` and reads `/MediaBox` rather than on the DOM.

`print-color-adjust` is separately unobservable headlessly: it does not change computed `background-color`,
and Playwright's `printBackground` is Chromium's own switch. Those tests assert the instruction is present
*and* that the colour reaches the PDF.
