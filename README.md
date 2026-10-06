<img src="assets/icon.svg" width="64" height="64" alt="">

# P1

Created in [T3 Code](https://t3.codes).

A local-first, browser-based page layout / desktop publishing editor whose
**document rendering backbone is HTML + CSS**. JavaScript owns the document model,
interaction and persistence; the DOM is a disposable projection of that model.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — document model, rendering architecture,
  editor systems, state, UI, persistence, extensibility, project structure,
  rendering strategy, roadmap, and implementation notes.
- [ADR 0001 — text editing fence](docs/adr/0001-text-editing-fence.md) — the
  spike result: `contenteditable` **can** be fenced, with one caveat.
- [ADR 0002 — text undo composition](docs/adr/0002-text-undo-composition.md) — how
  browser-native text undo and application undo coexist.
- [ADR 0003 — the production text model](docs/adr/0003-production-text-model.md) — the
  text model, the HTML/CSS mapping, and the measurement that changed the fence's mode:
  `plaintext-only` **cannot** produce character formatting.
- [ADR 0004 — the measurement boundary](docs/adr/0004-measurement-boundary.md) —
  how the editor asks the browser what it laid out: which APIs are zoom- and
  transform-invariant, and why the offscreen `TextMeasurer` sketch was wrong.
- [ADR 0005 — the graphical object geometry contract](docs/adr/0005-shape-geometry-contract.md)
  — what `x/y/width/height` mean, whether a stroke moves them, why a line needs an SVG
  island, and where the editor's hit testing is *supposed* to disagree with Chromium.
- [ADR 0006 — images: the asset and geometry contract](docs/adr/0006-image-asset-contract.md)
  — what an image reference means, why a blob URL can never be an asset's identity, how
  missing assets stay visible, and why hit testing uses the box rather than the pixels.
- [ADR 0007 — the persistent document format](docs/adr/0007-persistent-document-format.md)
  — the `.p1doc` schema, the versioning and validation policies, dirty state, and the
  text fence applied at save time.
- [ADR 0008 — multi-selection, layer order, and why grouping is not yet a model
  object](docs/adr/0008-multi-selection-and-grouping.md) — what the flat object
  array actually means, why multi-selection was already complete, the proof that
  a non-uniform group resize needs a shear, and the two coordinate models a group
  could have.
- [ADR 0009 — the boundaries, audited](docs/adr/0009-boundaries-audit.md) — the
  interaction state machine as it actually is, four invariants that turned out to
  be false, and the rules that now keep them from being violated by accident.
- [ADR 0010 — groups, and the question they were really asking](docs/adr/0010-groups-and-the-transform-question.md) —
  both candidate group representations proved, neither built, and the finding that
  grouping and multi-object resize are one missing capability rather than two features.
- [ADR 0011 — does the geometry model need affine transforms?](docs/adr/0011-affine-transform-decision.md) —
  the 28-site inventory, the candidate model specified and proved, and the decision to
  **restrict** group scaling to uniform rather than extend the transform to a general affine.
- [ADR 0011b — the selection frame is the object's frame](docs/adr/0011b-selection-frame-and-stroke.md) —
  fixing the outline so it follows rotation, renaming `selectionRect`, and choosing a stroke-width
  semantic. The geometry a future group will rely on.
- [ADR 0012 — the persistent group model](docs/adr/0012-persistent-group-model.md) —
  `GroupNode` with group-local children, nesting, uniform-only group scale, the one
  recursive traversal, paint order by flattening, and `formatVersion: 2` with no
  migration. **The group as a document object; no interaction built.**
- [Visual tests](tests/visual/README.md) — browser verification of the renderer
  and the viewport.

> Every architectural risk taken so far is closed, and each one is recorded with the
> measurement or the bug that forced it. The remaining known limitations are narrow and
> documented: an external model write to a frame being edited is deferred rather than
> applied immediately, native redo does not survive a text session, orphaned image assets
> are never collected, `{ external }` assets have no resolver, there are no format
> migrations yet, and there is neither grouping nor multi-object resize — the last two
> **the same missing capability**, proved algebraically rather than left as intentions.
> `scaleX`/`scaleY` have no writer, and rotation is reachable only on a single unrotated
> selection.

## Getting started

```bash
npm install
npm run dev        # http://localhost:5173
```

| Script | Purpose |
|---|---|
| `npm run dev` | Dev server with HMR |
| `npm run build` | Typecheck, then production build to `dist/` |
| `npm run typecheck` | `tsc --noEmit`, strict |
| `npm run lint` | ESLint, including the module boundary rules |
| `npm test` | Unit and DOM-level tests (Vitest) |
| `npm run test:visual` | Browser verification of the renderer (Playwright) |
| `npm run test:visual:update` | Re-record visual baselines |
| `npm run test:all` | Both suites |

Visual tests need the browser once: `npx playwright install chromium`.

No backend, no cloud service, no runtime dependencies.

## Current state: M12 (groups are documents)

The document is editable, its text is a real document format rather than a record of what
the browser happened to write, it **survives closing the tab**, several objects can be worked
on together and reordered in the paint stack — the seams between the model, the renderer, the
browser, the editor and the file are written down and tested rather than assumed (M9) — **nothing
the application paints is ever a shear** (M10), the transform model has been examined for a general
affine and deliberately left alone (M10b), and **the selection frame is now the object's real,
rotated frame** (M11).

That last one sounds cosmetic. It was not: for nine milestones the editor drew an unrotated box
around a rotated object, put the resize handles on that box rather than on the object, and hid the
rotation grip for anything already rotated. Nothing was *broken* — clicking, dragging and undo all
worked — which is exactly why it survived so long, and why the pixel baselines could not see it
either.

Every mutation — a drag, an inspector field, an undo — goes through one command funnel,
which is what makes "every change is undoable" a property of the architecture rather than a
convention.

- **Selection** by model hit test, so `locked`, `visible` and object shape are all
  respected; shift-click and shift-drag coexist.
- **Move, resize, rotate** with shift (constrain) and alt (from centre) semantics.
  Resize under rotation holds the opposite corner exactly.
- **Undo/redo** with gesture coalescing, so one drag is one step.
- **A screen-space overlay** outside the zoom transform, so selection strokes stay
  1px and handles a constant size at any zoom.
- **A text fence** you can enter with <kbd>Enter</kbd> and leave with
  <kbd>Esc</kbd>. Inside it the browser owns undo; outside, the editor does.
- **Real text**: paragraphs, bold/italic/underline/strikethrough, alignment, soft
  breaks, and frame typography (family, size, line height, tracking, colour) — edited
  in place through native browser caret, selection, IME and spellcheck.

The text model is **canonical**: adjacent runs with equal formats are merged, so every
visual text has exactly one run-sequence. Two documents that render identically *are*
the same document, which is what stops the undo stack filling with steps that appear to
do nothing.

| | | |
|---|---|---|
| <kbd>click</kbd> / <kbd>drag</kbd> | select, move | |
| <kbd>shift</kbd>+<kbd>click</kbd>, <kbd>shift</kbd>+<kbd>drag</kbd> | extend selection, constrain to an axis | |
| <kbd>alt</kbd>+<kbd>click</kbd> | select through a lock | |
| <kbd>←</kbd><kbd>↑</kbd><kbd>↓</kbd><kbd>→</kbd> | nudge (<kbd>shift</kbd> for ten times, <kbd>alt</kbd> to lock the axis) | |
| <kbd>⌫</kbd> | delete the selection | |
| <kbd>⏎</kbd> / <kbd>Esc</kbd> | enter / leave a text session, or disarm a tool | |
| <kbd>ctrl</kbd>+<kbd>B</kbd> / <kbd>I</kbd> / <kbd>U</kbd> | bold / italic / underline while editing text | |
| <kbd>ctrl</kbd>+<kbd>Z</kbd> | undo — routed to the text session when one is open | |
| <kbd>ctrl</kbd>+<kbd>S</kbd> | save | |
| <kbd>]</kbd> / <kbd>[</kbd> | bring forward / send backward | |
| <kbd>ctrl</kbd>+<kbd>]</kbd> / <kbd>ctrl</kbd>+<kbd>[</kbd> | bring to front / send to back | |

### Graphical objects

Rectangles, ellipses and lines, with one geometry contract behind all three:

> **`transform.x/y/width/height` is the object's border box**, in page-local document px.
> A stroke does **not** expand it — with `align: 'inside'` the stroke eats inward, so
> `offsetWidth` equals the model exactly and selection geometry is the model box at every
> stroke width.

Each kind is described once, in `src/model/shapes.ts`: its hit-test predicate, the
inspector fields it contributes, and whether it has an interior. `rect` and `ellipse`
render as plain HTML/CSS; `line` renders as a scoped SVG `<line>` island, because
measurement showed CSS cannot stroke a zero-height box (`border` grows it downward;
`outline` paints nothing at all).

The editor's hit testing and Chromium's agree everywhere except **a line with no stroke**,
where there is no ink and therefore no browser target — and the editor still finds it,
because an object you drew has to be selectable whether or not it currently paints.

Pick **Rect**, **Ellipse** or **Line** in the toolbar and drag on a page to create one.
The tool stays armed so several objects can be drawn in a row.

### Images

Press **Image** and pick a file. It is decoded, placed at its natural size (scaled
uniformly if it is larger than the page), and becomes an ordinary object: selectable,
movable, resizable, rotatable, deletable, undoable.

The geometry contract is the same one every other object obeys: `transform.x/y/width/height`
is the object's border box, in page-local document px — true for an image whether it loaded,
failed, or is rotated, which was measured rather than assumed.

Two rules are new with images:

- **An image is referenced by an id, never a URL.** The document holds the bytes and an
  intrinsic size; the browser gets a `src`. Nothing session-scoped — a blob URL, a
  `File` — is ever in the model, because a document that cannot be reopened is not a
  document.
- **A missing asset is visible.** If the bytes cannot be resolved, the object keeps its
  box, paints a marked placeholder, and stays selectable so it can be fixed. It is never
  silently indistinguishable from a working one — which matters, because a failed image
  keeps its full authored box and still reports itself as `complete`.

An image is selected by its **object geometry, not its visible pixels**. Chromium hit-tests
a fully transparent pixel, so a pixel-accurate editor would disagree with the browser on
every image with transparency.

The editor can also **measure** what the browser laid out, without asking the model.
`clientWidth`/`clientHeight` and `scrollWidth`/`scrollHeight` are zoom- and
transform-invariant, so every measured value is already in document px and needs no
conversion — and zooming never invalidates a measurement. Hidden and out-of-date elements
are *refused* rather than reported as zero.

### Working with several objects

Select more than one: <kbd>shift</kbd>+click adds, <kbd>shift</kbd>+click on something already
selected removes it, and a drag on empty page space draws a marquee. Move, delete, nudge and
every inspector property then apply to the whole selection — and one gesture is **one** undo
step, not one per object.

> **Layer order *is* the object array.** There is no `zIndex` and no second ordering to keep in
> step: index 0 paints first, and the last index paints on top. That is why hit testing can walk
> the array backwards and be right, and why a reordering is a change the saved file carries.

**To front**, **Forward**, **Backward** and **To back** move the selection through that stack.
Three rules are worth stating, because they are not all obvious:

- The selection keeps its **relative order**. Bringing five objects to the front puts them at the
  front in the order they were already stacked.
- Moving **one position** never moves an object *over* another selected object — so with
  *everything* selected, all four operations correctly do nothing at all.
- Nothing is recorded when nothing moved. Bringing the frontmost object forward is not an undo
  step that does nothing.

A **hidden** object cannot be clicked — there is nothing painted to click — but a marquee still
reaches it, so the `Visible` checkbox is never a one-way door. A **locked** object is skipped by
both, and <kbd>alt</kbd>+click is how you get through: locking is a barrier, not a hiding place.

**A selection has no bounding box.** With several rotated objects selected there is
deliberately no single rectangle drawn around them, because for a 30°-rotated object the painted
extent is much larger than its box — such a rectangle would match nothing you can see or click.
Each object keeps its own outline, and the status bar reports how many are selected.

### Why there are no groups

**Grouping is not blocked.** M10 investigated it, and M10b removed the blocker — by *restricting*
group scaling to uniform scale, not by changing the geometry model. What remains is the work of
building them. See [ADR 0011](adr/0011-affine-transform-decision.md):

- **A group-local child is fully representable today**, for every case except one: a **non-uniform
  group scale applied to a rotated child** needs a *shear*, and `R(θ)·S` cannot produce one.
  Proved as arithmetic, not asserted.
- **That is the only blocked case**, and it is one capability rather than a coordinate space. Uniform
  group scale composes exactly, so `page → group → child → local` works for everything else.

### Why the transform model was *not* extended to a general affine

M10b asked whether `Transform2D` should become a general affine transform, and answered no. The
interesting parts of that answer:

- **It would have been one field.** The current linear part has 3 parameters and `GL(2)` has 4, so the
  model is a *codimension-1* subset — "no shear" is a single equation. The extension is a `skewX`
  field in `rotate() scale() skewX()` form, with a clean decomposition. **"It would be a second
  geometry system" is not an available objection, and this project does not make it.**
- **Everything arithmetic already works.** Hit testing, resize, measurement and rendering only need an
  *invertible* matrix, and that is all they ask for today.
- **It buys one capability that nothing can produce.** Non-uniform scaling. No gesture, no inspector
  field, and no command writes `scaleX`/`scaleY` — and the one function that would is dead and wrong.
- **It forces a stroke decision with no cheap answer.** Strokes are CSS borders, and a border
  transforms with its element: one authored `12px` border paints **24 × 36** at `scale(2,3)`. Because
  nothing writes the scales, document-space and object-space invariance are currently
  *indistinguishable* — the project has been getting object-space invariance by accident and has
  never chosen. Document-space invariance is not reachable by adjusting a number: Chromium accepts
  `vector-effect: non-scaling-stroke` on an HTML element and then ignores it.

So the model stays `R·S`, groups get **uniform-only** scaling, and the re-entry conditions — of which
the stroke is the binding one — are written down rather than left to judgement.

### Saving and opening

**Save** downloads a `.p1doc`. **Open** reads one. The first workflow is the whole point:

> new → edit → save → close the tab → open → **the identical document**

The format is deterministic, so that claim is checked as *byte identity* across a real
boundary, not as a DOM comparison:

```
save  →  bytes B1
open B1 in a fresh browser  →  save  →  bytes B2
B1 === B2
```

Four decisions carry it:

- **The format is the model, canonically ordered.** Every object is rebuilt field by field
  before it is written, so the bytes do not depend on how anything happened to be
  constructed. `assets` keys are sorted; object order is *not*, because object order is
  paint order.
- **Loading refuses rather than repairs.** A malformed document is rejected with the *path*
  of the bad field — `pages[1].objects[3].transform.width` — because silently dropping one
  bad node out of a three-hundred-object document is a data-loss decision you never made.
  An unknown object type is refused for the same reason an unknown block kind always was: it
  must not come back as an object that renders as nothing.
- **An unknown format version is refused, in both directions**, with a message naming both
  versions. There are no migrations yet, and a file from any other version is refused rather
  than guessed at.
- **Dirty state is canonical authored state, and nothing else.** Not the DOM, the scroll
  position, the selection, a pending measurement, an image still decoding, or an open text
  session. So `edit → save → edit → undo` reports clean, with no bookkeeping to keep in
  step — and **saving ends an open text session first**, because the browser owns the
  editing DOM and serializing first would write the text *before* your typing.

Loading **never waits for an image to decode**: a document with a broken image opens
instantly behind a marked placeholder, so loading can only fail because the document is
malformed, never because a picture would not paint.

### Deliberately not implemented yet

Snapping, guides, alignment, distribution, and panels beyond the inspector. Grouping and
multi-object resize, for the reasons above. Autosave, crash recovery, File System
Access save-in-place, project folders, and format migrations — see
[ADR 0007](docs/adr/0007-persistent-document-format.md). On the text side, vertical
alignment, padding, columns, auto-size, inline colour/size, headings and lists are all
deferred, each with its reason in
[ADR 0003](docs/adr/0003-production-text-model.md). On the graphics side, polygons and
paths, stroke alignments other than `inside`, gradients, patterns and shadows — see
[ADR 0005](docs/adr/0005-shape-geometry-contract.md). On the image side: no crop, no
`object-position`, no non-rectangular frames, no external asset resolution, and no asset
library — see [ADR 0006](docs/adr/0006-image-asset-contract.md).

### Verifying it

```bash
npm test                # 591 unit tests
npm run test:visual     # 468 browser tests, 25 visual baselines
& scripts\mutation-check.ps1   # 30 deliberate breakages, each asserted to fail a suite
```

That last one is unusual and worth explaining. A green suite says nothing on its own unless
a test *would* have failed, so `mutation-check.ps1` breaks twenty-six behaviours one at a time —
dirty state, the save baseline, the text fence at save time, asset ordering, version
refusals, id reservation, the layer-order no-op rule — and asserts the relevant suite turns
red. It found three gaps in tests that were passing, including one dirty-state test that
passed *without the save having happened*.

It also carries a **documented list of what it cannot cover**, and that list is the point. The
`pointercancel` handler is not mutation-checked: with the cause removed no cancel occurs, so
deleting the listener is unobservable from any test. A mutation that only proves the mutation
works is worse than a written-down gap.

It is also how a real bug stayed invisible for a milestone. <kbd>shift</kbd>-clicking a second
object and then dragging used to move the pair by 7.5px of an intended 60px and leave the
editor stuck mid-gesture, because the browser had begun a text selection and taken the pointer
back — and the existing test asserted only that the inspector went *mixed*, which 7.5px
satisfies. The M8 test asserts the whole delta, and a mutation of the fix is what keeps it
fixed.

See the [M0](docs/ARCHITECTURE.md#m0-implementation-notes),
[M1](docs/ARCHITECTURE.md#m1-implementation-notes),
[M2](docs/ARCHITECTURE.md#m2-implementation-notes),
[M3](docs/ARCHITECTURE.md#m3-implementation-notes--production-text-frames-and-typography),
[measurement boundary](docs/ARCHITECTURE.md#measurement-boundary-implementation-notes),
[M5](docs/ARCHITECTURE.md#m5-implementation-notes--graphical-objects),
[M6](docs/ARCHITECTURE.md#m6-implementation-notes--images),
[M7](docs/ARCHITECTURE.md#m7-implementation-notes--persistence),
[M8](docs/ARCHITECTURE.md#m8-implementation-notes--multi-object-editing) and
[M9](docs/ARCHITECTURE.md#m9-implementation-notes--interaction-integrity) notes, plus
[ADR 0001](docs/adr/0001-text-editing-fence.md),
[ADR 0002](docs/adr/0002-text-undo-composition.md),
[ADR 0003](docs/adr/0003-production-text-model.md),
[ADR 0004](docs/adr/0004-measurement-boundary.md),
[ADR 0005](docs/adr/0005-shape-geometry-contract.md),
[ADR 0006](docs/adr/0006-image-asset-contract.md) and
[ADR 0007](docs/adr/0007-persistent-document-format.md) and
[ADR 0008](docs/adr/0008-multi-selection-and-grouping.md) and
[ADR 0009](docs/adr/0009-boundaries-audit.md) and
[ADR 0010](docs/adr/0010-groups-and-the-transform-question.md) and
[ADR 0011](docs/adr/0011-affine-transform-decision.md) and
[ADR 0011b](docs/adr/0011b-selection-frame-and-stroke.md).
