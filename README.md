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
  semantic. The geometry a later group relies on.
- [ADR 0012 — the persistent group model](docs/adr/0012-persistent-group-model.md) —
  `GroupNode` with group-local children, nesting, uniform-only group scale, the one
  recursive traversal, paint order by flattening, and `formatVersion: 2` with no
  migration. **The group as a document object.**
- [ADR 0013 — group interaction](docs/adr/0013-group-interaction.md) — how a group is
  entered, selected, moved and left, and why the page→group→child conversion is the
  load-bearing part.
- [ADR 0014 — asset garbage collection](docs/adr/0014-asset-garbage-collection.md) —
  what an asset's identity is, and why nothing collects them yet.
- [ADR 0016 — alignment and distribution](docs/adr/0016-alignment-and-distribution.md) —
  painted bounds as the shared quantity, the sort/anchor/spacing rules, and why the
  aggregate box is transient calculation data.
- [ADR 0017 — snapping and guides](docs/adr/0017-snapping-and-guides.md) — the 10-screen-pixel
  threshold and the zoom conversion it needs, how a candidate is chosen, why Alt, and
  the defect that made a drag snap to a candidate 140px from the object on screen.
- [ADR 0018 — print profile and PDF export](docs/adr/0018-print-profile-and-pdf-export.md) —
  why export is `window.print()` against a stylesheet rather than a PDF writer, why the `@page` size
  has to be injected rather than declared, and the three inline styles a print profile has to beat.
- [Visual tests](tests/visual/README.md) — browser verification of the renderer
  and the viewport.

> ADR numbering skips **0015**, which was never written.

> Every architectural risk taken so far is closed, and each one is recorded with the
> measurement or the bug that forced it. The remaining known limitations are narrow and
> documented: an external model write to a frame being edited is deferred rather than
> applied immediately, native redo does not survive a text session, orphaned image assets
> are never collected, `{ external }` assets have no resolver, and there are no format
> migrations yet. Multi-object resize is still absent — but **not** because of shear,
> which is why it is no longer grouped with "grouping is blocked" the way it was in
> ADR 0010. See [Groups](#groups).

## Getting started

```bash
npm install
npm run dev        # http://localhost:5173
```

| Script | Purpose |
|---|---|
| `npm run dev` | Dev server with HMR, on **5173** |
| `npm run build` | Typecheck, then production build to `dist/` |
| `npm run preview` | Serve `dist/` — on **5174**, which is what the browser suite uses |
| `npm run typecheck` | `tsc --noEmit`, strict |
| `npm run lint` | ESLint, including the module boundary rules |
| `npm test` | Unit and DOM-level tests (Vitest) |
| `npm run test:visual` | Browser suite (Playwright) |
| `npm run test:visual:update` | Re-record visual baselines |
| `npm run test:all` | Both suites |
| `.\scripts\mutation-check.ps1` | Deliberate breakages, each asserted to fail a suite |

Browser tests need the browser once: `npx playwright install chromium`.

No backend, no cloud service, no runtime dependencies.

### A note on what the browser suite actually runs

Since M15 the browser suite is served **`dist/`**, not the dev server. That was not a
preference — it is a diagnosed fix. A dev-mode boot pulls roughly 49 module requests per
boot against one long-lived server, and on Windows that exhausts the ephemeral port pool
(`net::ERR_NO_BUFFER_SPACE`, `Tcpip` event 4231), which showed up as an intermittent
browser failure. One bundled request per boot cannot do that.

The consequence is a deliberate test-infrastructure boundary: **the browser suite tests the
production bundle**, so a change to `src/` only reaches it after a rebuild. That is why
`scripts/mutation-check.ps1` rebuilds `dist/` before every browser mutant — without that,
every source mutant silently reports "NOT FOUND" and the tool stops testing anything while
still reporting survivors. `spike.html` stays excluded from the bundle and is proxied to
the dev server.

## Current state: M19

The document is editable, its text is a real document format rather than a record of what
the browser happened to write, it **survives closing the tab**, several objects can be
worked on together, reordered in the paint stack, **grouped, aligned, distributed and
snapped into alignment** — and the seams between the model, the renderer, the browser, the
editor and the file are written down and tested rather than assumed.

Every mutation — a drag, an inspector field, an undo — goes through one command funnel,
which is what makes "every change is undoable" a property of the architecture rather than a
convention.

- **Selection** by model hit test, so `locked`, `visible` and object shape are all
  respected; shift-click and shift-drag coexist.
- **Move, resize, rotate** with shift (constrain) and alt (from centre) semantics.
  Resize under rotation holds the opposite corner exactly.
- **Snapping** during a move, to page edges and to other objects, with transient guides.
- **Alignment and distribution** for a multi-selection.
- **Groups**, nestable, with page-space dragging.
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

## Keyboard and pointer

| | | |
|---|---|---|
| <kbd>click</kbd> / <kbd>drag</kbd> | select, move | |
| <kbd>alt</kbd>+<kbd>click</kbd> | select through a lock, or select the containing group | |
| <kbd>alt</kbd>+<kbd>drag</kbd> | move with **snapping suppressed** | |
| <kbd>shift</kbd>+<kbd>click</kbd>, <kbd>shift</kbd>+<kbd>drag</kbd> | extend selection, constrain to an axis | |
| <kbd>←</kbd><kbd>↑</kbd><kbd>↓</kbd><kbd>→</kbd> | nudge (<kbd>shift</kbd> for ten times, <kbd>alt</kbd> to lock the axis) | |
| <kbd>⌫</kbd> | delete the selection | |
| <kbd>⏎</kbd> / <kbd>Esc</kbd> | enter / leave a text session; <kbd>Esc</kbd> cancels a gesture, disarms a tool, leaves a group, then clears the selection | |
| <kbd>ctrl</kbd>+<kbd>G</kbd> / <kbd>ctrl</kbd>+<kbd>shift</kbd>+<kbd>G</kbd> | group / ungroup the selection | |
| <kbd>ctrl</kbd>+<kbd>A</kbd> | select all | |
| <kbd>ctrl</kbd>+<kbd>B</kbd> / <kbd>I</kbd> / <kbd>U</kbd> | bold / italic / underline while editing text | |
| <kbd>ctrl</kbd>+<kbd>Z</kbd> / <kbd>ctrl</kbd>+<kbd>shift</kbd>+<kbd>Z</kbd> / <kbd>ctrl</kbd>+<kbd>Y</kbd> | undo / redo — routed to the text session when one is open | |
| <kbd>ctrl</kbd>+<kbd>S</kbd> | save | |
| <kbd>]</kbd> / <kbd>[</kbd> | bring forward / send backward | |
| <kbd>ctrl</kbd>+<kbd>]</kbd> / <kbd>ctrl</kbd>+<kbd>[</kbd> | bring to front / send to back | |
| <kbd>+</kbd> / <kbd>−</kbd> / <kbd>0</kbd> / <kbd>1</kbd> | zoom in / out / fit / actual size | |
| <kbd>space</kbd>+<kbd>drag</kbd> | pan | |
| <kbd>V</kbd> / <kbd>R</kbd> / <kbd>E</kbd> / <kbd>L</kbd> | select / rectangle / ellipse / line | |

Two of these deserve a note rather than a table cell.

**Bold/italic/underline have no key handler, on purpose.** Inside a text session the browser
owns the keyboard: <kbd>ctrl</kbd>+<kbd>B</kbd> is Chromium's own contenteditable command and
arrives as a `beforeinput` the session reads back into the canonical model. Binding it again
would put a second implementation between the user and the same result.

**<kbd>Esc</kbd> is ordered by consequence, not by convenience.** Cancelling an in-flight
gesture beats disarming an armed tool, which beats leaving a group, which beats clearing a
selection — and exactly one of them fires. Leaving a group before clearing the selection
matters: the reverse leaves you inside a group with nothing selected, which is the most
confusing of the three outcomes.

## Graphical objects

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

## Working with several objects

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

A **multi-selection draws no single bounding rectangle.** With several rotated objects selected
there is deliberately no one rectangle drawn around them, because for a 30°-rotated object the
painted extent is much larger than its box — such a rectangle would match nothing you can see or
click. Each object keeps its own outline, and the status bar reports how many are selected.
Alignment and distribution compute such a union, but only as **transient calculation data**: it
is never drawn, never grabbable, and never stored.

### Alignment and distribution

Eight buttons in the toolbar: **Align left / centre / right / top / middle / bottom**, and
**Distribute H / Distribute V**.

- **Alignment needs two or more objects. Distribution needs three or more**, because with two
  both are the outermost anchors and there is nothing to place between them.
- Both operate on **page-space painted bounds** — the same quantity everywhere else in the
  editor. A rotated object aligns by where it is *seen*, not by its unrotated model frame.
- Distribution sorts by the near painted edge, breaks ties by **id** so the result cannot depend
  on click order, fixes the outermost two as anchors, and equalises the **gaps** between painted
  edges (not the distances between centres). Negative gaps are allowed.
- A group is aligned and distributed by its **derived** bounds — the union of its descendants' —
  and is moved **as a group**. Its children are never rewritten individually.
- An operation that cannot apply is disabled with `aria-disabled`, not `disabled`, so the button
  stays focusable and a test can still exercise the guard underneath.
- Clicking an already-aligned selection is a **no-op and not an undo step**, because zero deltas
  are omitted rather than stored.

### Snapping and guides

While you drag, the moving selection snaps to page edges and page centre, and to the edges and
centres of other objects — including groups, by their derived bounds. A guide is drawn for as
long as the snap holds.

- **The threshold is 10 screen pixels at every zoom.** That is the whole reason
  `snapThresholdDocument` divides by the live zoom: the gesture's delta is already in document
  px, so comparing it against a screen-space constant would make the effective threshold
  `10 × zoom` — dead at 25%, magnetic at 400%, and exactly right at 100%, which is the zoom the
  suite tests by default.
- **A multi-selection is one arrangement.** It is snapped by its union and moved by one delta, so
  members cannot end up at different alignments than you dragged toward.
- **Nearest candidate wins; ties go to the earlier one in a fixed scan order** — page features
  first, then objects in document order. Page geometry is stable for as long as the document is,
  whereas an object candidate may be about to move.
- **Both axes can snap at once**, because a drag toward a corner wants both.
- **<kbd>alt</kbd> during the drag suppresses snapping.** Alt is the only modifier free at that
  point in the gesture: at pointer-down it chooses *what is grabbed*, and during the drag it
  chooses *whether to snap*, so the two never apply at the same moment.
- **Guides are derived state.** They are rebuilt from scratch each frame and cleared when the
  gesture ends *or is cancelled*. They are not commands, not document fields, and never
  persisted — snapping writes nothing but a `setTransform`, the same mutation an unsnapped drag
  performs.

This is the one place worth reading the ADR rather than the summary, because of a real defect it
records. The obvious implementation re-derives the moving box from the document on every frame —
and that is wrong, because the move gesture dispatches its transform *every frame*, so the
document already holds the previous frame's snapped position. The delta gets applied twice and
compounds. It presented as a drag snapping to a candidate **140px from the object on screen**,
and as <kbd>alt</kbd> appearing not to suppress snapping when it did. The fix is that the
gesture captures its geometry once, at pointer-down, and every frame is arithmetic on that.

## Groups

Groups exist, are documents, and nest. <kbd>ctrl</kbd>+<kbd>G</kbd> groups the selection and
<kbd>ctrl</kbd>+<kbd>shift</kbd>+<kbd>G</kbd> ungroups it; there is no toolbar button, because
there is no menu and a chord sits more cheaply than one.

- A group is a real node with group-local children, saved in the document and part of
  `formatVersion: 2`.
- <kbd>alt</kbd>+click selects the containing group rather than the leaf you clicked.
- <kbd>Esc</kbd> leaves a group before it clears the selection.
- **Dragging a child inside a rotated or scaled group follows the page axis, not the group's.**
  The page-space delta is converted into the parent-local one the child's transform understands.
  Getting this wrong was the M16 defect: the child drifted along the group's local axis, which is
  invisible at depth 0 and is exactly why the browser test for it is nested.
- Group scale is **uniform only**, and that restriction is deliberate — see below.

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

Multi-object resize is still absent, and no longer shares a cause with grouping: ADR 0010 proved
that grouping and multi-object resize are *one* capability, because both are blocked by the same
non-uniform-scale-plus-rotation shear. Grouping was then built with uniform scale, so the shear is
no longer on the path — a multi-object resize is now its own piece of work, not a blocked one.

## Saving and opening

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

## Printing and PDF export

**Export PDF** in the document toolbar opens the browser's own print dialog, with the document already
described to it: one document page per sheet, at the page size the document says, in the order the pages
are in.

> You get a PDF out of *your* print dialog. "Save as PDF" is one of its destinations — which means the
> usual choices are yours: destination, paper, scaling, and whether to print backgrounds. The editor
> sets the sheet geometry and gets out of the way.

It works because the document *is* HTML and CSS, so a printed page is laid out by the same code that
draws the screen. Export does not render a second copy of anything — there is no export pipeline, no
second representation, and no fidelity setting, because there is nothing to degrade.

What the print profile does, in three groups:

- **Hides the editor.** Toolbar, rulers, inspector, status bar, and the overlay layer — which is where
  selection outlines, resize handles, the rotation grip and every snap guide are drawn, so one rule
  retires all of them. It *hides* rather than tears them down, because printing must not change editor
  state, and the tests assert invisibility rather than absence for exactly that reason.
- **Removes the screen's furniture.** The zoom transform, the canvas margin, the stack's drawn paper
  edge, and the scroll containers that clip to a viewport. Three of those are written **inline** by
  the viewport and renderer, so no stylesheet rule beats them without `!important` — and one of them,
  the canvas spacer's zoomed height, is what made a three-page document print four sheets before it was
  found. Only generating a PDF and counting sheets could see it.
- **Keeps what is document content.** Page clipping is untouched, so an object hanging off the page is
  still clipped; and backgrounds are forced on with `print-color-adjust: exact`, so a coloured page
  prints as paper rather than as white.

The sheet comes from the document: a page authored in millimetres gets `@page { size: 210mm 297mm }`,
one authored in inches gets `8.5in 11in`, and landscape is the renderer's own orientation rule rather
than a swap re-implemented here. **A4 is nowhere in the code** — it is a choice this editor does not
make for you. Page size is not authorable in the UI; it arrives from the file or from New.

**Two limitations worth stating rather than discovering.**

- **Backgrounds depend on the browser's own switch.** Playwright's headless `printBackground` flag is
  Chromium's, and does not consult `print-color-adjust`, so the CSS declaration's real-world effect can
  only be seen in a real print dialog. What the tests verify is that the instruction is present and
  that the authored colour does reach the PDF.
- **Images are awaited before printing.** A print dialog is a snapshot, and a user cannot tell "not
  loaded yet" from "deliberately blank", so export waits for each image to decode — with a bounded
  wait, because printing must not hang and a broken image is already a marked placeholder.

See [ADR 0018](docs/adr/0018-print-profile-and-pdf-export.md.

## What is not painted is not geometry

`visible: false` is not a rendering detail, and M18 established that in the geometry layer.

The renderer propagates `visible: false` down a hidden group's subtree; hit testing refuses a
node whose own `visible` is false *or* any ancestor's; and ADR 0012 A10 records the rule
deliberately — a group is the only thing that can hide a subtree, so leaving it inert "would
make `visible` mean something different on a group than on every other node".

Arrangement is now the fourth reader and agrees with all three. Before that it applied no
visibility rule at all, which cost five distinct things — an invisible leaf could be named as an
alignment target, a group whose children were all invisible kept a box, a **hidden group with
visible children** offered a box for a region where nothing is painted, and because a group's box
is the union of its descendants', **one invisible member at (5000, 5000) stretched a 60×40 union
to 5010×5010**. For snapping it was worse than cosmetic, because a snap *draws a guide*: dragging
near an invisible object snapped to it and drew a line pointing at nothing.

`placementsInDocument` still applies no visibility rule, and should not: a placement says *where*
a thing is, which does not require it to be on the page. The filter belongs to the code that is
about what the page shows.

## Deliberately not implemented yet

Panels beyond the inspector — no layer panel, no rulers with draggable guides, no asset library.
Multi-object resize, for the reason above. Autosave, crash recovery, File System Access
save-in-place, project folders, and format migrations — see
[ADR 0007](docs/adr/0007-persistent-document-format.md). On the text side, vertical
alignment, padding, columns, auto-size, inline colour/size, headings and lists are all
deferred, each with its reason in
[ADR 0003](docs/adr/0003-production-text-model.md). On the graphics side: polygons and
paths, stroke alignments other than `inside`, gradients, patterns and shadows — see
[ADR 0005](docs/adr/0005-shape-geometry-contract.md). On the image side: no crop, no
`object-position`, no non-rectangular frames, no external asset resolution — see
[ADR 0006](docs/adr/0006-image-asset-contract.md).

One rough edge worth naming rather than hiding: **orphaned image assets are never collected**
([ADR 0014](docs/adr/0014-asset-garbage-collection.md)).

## Verifying it

```bash
npm test                            # 911 unit tests
npm run test:visual                 # 635 browser tests, 25 visual baselines
.\scripts\mutation-check.ps1        # 112 deliberate breakages, each asserted to fail a suite
```

That last one is unusual and worth explaining. A green suite says nothing on its own unless
a test *would* have failed, so `mutation-check.ps1` breaks 112 behaviours one at a time — dirty
state, the save baseline, the text fence at save time, asset ordering, version refusals, id
reservation, the layer-order no-op rule, page-to-local conversion, snapping's threshold and
tie-break, visibility in arrangement bounds, the tool shortcuts, the print profile — and asserts the relevant suite turns
red. **111 are detected.** It found real gaps in tests that were otherwise passing, including one
dirty-state test that passed *without the save having happened*.

It also carries a **documented list of what it cannot cover**, and that list is the point.

- One mutant is an **accepted survivor**: adding padding to the dirty indicator resizes a badge
  by two pixels, and no test measures that element's geometry. The only way to detect it is a
  pixel baseline, and ADR 0011b §8 established that these baselines cannot see a sub-pixel chrome
  change — so a baseline would report it detected while being unable to fail for the right
  reason. It is written down in `scripts/mutations.ps1` with that justification.
- Mutations that proved **equivalent** are recorded with the algebra and *not* carried, rather
  than counted forever as survivors. Reversing an ancestor chain is one: with uniform scale
  throughout, `R(a)·S(s) · R(b)·S(t) = s·t·R(a+b)`.
- The `pointercancel` handler is not mutation-checked: with the cause removed no cancel occurs,
  so deleting the listener is unobservable from any test. A mutation that only proves the
  mutation works is worse than a written-down gap.

It is also how a real bug stayed invisible for a milestone. <kbd>shift</kbd>-clicking a second
object and then dragging used to move the pair by 7.5px of an intended 60px and leave the
editor stuck mid-gesture, because the browser had begun a text selection and taken the pointer
back — and the existing test asserted only that the inspector went *mixed*, which 7.5px
satisfies. The M8 test asserts the whole delta, and a mutation of the fix is what keeps it
fixed.

**On running it: ~16-25 minutes, and why not faster.** The corpus is 36 browser mutants and 76 unit. The
one change that halved it was `--max-failures=1` on browser targets: the only question asked of a suite is
"did it fail?", and for a detected mutant that is settled by the first failing test, so running the rest
cannot change the answer. Browser mutants went from 30-85s to 3-16s each.

Parallelism across *mutants* is implemented and **off by default**, because on an ordinary 4-core machine
it does not pay: a mixed slice of 8 mutants measured 111.6s serial against 187.7s across 4 workers, run back
to back. Four concurrent Chromium instances contend for the thing the browser mutants need, and the unit
half cannot make up for it — four concurrent Vitest runs beat four serial ones by only 1.24x. It stays
behind `-Workers` because it is correct and would pay with cores to spare.

Two things that look like obvious next steps were measured and rejected: `--bail=1` for the unit half (the
analogue of the flag above) is **2.3x slower**, and dropping the per-mutant `vite build` is not possible at
all — since the browser suite is served `dist/`, that build *is* the mechanism by which a source mutation
reaches a browser test.

One caution when reading any of these numbers: this machine's wall clock drifts. The slowest mutant in the
corpus measured 62.2s and later 97.4s on byte-identical code, and a full serial run measured 15.9 min and
later 24.4 min. Comparisons here are only meaningful when taken back to back, and an earlier version of
this file quoted a 22x figure that was really a broken server lifecycle rather than a property of
parallelism.

The implementation notes behind all of this are in
[ARCHITECTURE.md](docs/ARCHITECTURE.md) — the
[M0](docs/ARCHITECTURE.md#m0-implementation-notes),
[M1](docs/ARCHITECTURE.md#m1-implementation-notes),
[M2](docs/ARCHITECTURE.md#m2-implementation-notes),
[M3](docs/ARCHITECTURE.md#m3-implementation-notes--production-text-frames-and-typography),
[measurement boundary](docs/ARCHITECTURE.md#measurement-boundary-implementation-notes),
[M5](docs/ARCHITECTURE.md#m5-implementation-notes---graphical-objects),
[M6](docs/ARCHITECTURE.md#m6-implementation-notes---images),
[M7](docs/ARCHITECTURE.md#m7-implementation-notes--persistence),
[M8](docs/ARCHITECTURE.md#m8-implementation-notes--multi-object-editing) and
[M9](docs/ARCHITECTURE.md#m9-implementation-notes--interaction-integrity),
[M10](docs/ARCHITECTURE.md#m10-implementation-notes--groups-and-the-transform-question),
[M10b](docs/ARCHITECTURE.md#m10b-implementation-notes--does-the-geometry-model-need-affine-transforms),
[M11](docs/ARCHITECTURE.md#m11-implementation-notes--the-geometry-groups-will-stand-on),
[M12](docs/ARCHITECTURE.md#m12-implementation-notes--the-group-model) notes — plus every ADR
above, each of which records the measurement or the bug that forced the decision rather than
the decision alone.
