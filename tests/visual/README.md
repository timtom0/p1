# Visual tests

Browser-level verification of the document renderer. This suite exists to check
the things a DOM emulator cannot: real page dimensions, real transform
composition, real clipping, real paint order, and real behaviour at several zoom
levels.

```bash
npm run test:visual              # run against the committed baselines
npm run test:visual:update       # re-record baselines (review the diff!)
```

First run needs the browser binary: `npx playwright install chromium`.

## What is covered

**`geometry.spec.ts` (18 tests)** — how a page renders. Page dimensions, object
positioning, `transform-origin`, scaling, page clipping, paint order, zoom
invariance, and baselines.

**`navigation.spec.ts` (30 tests)** — how the editor *presents* the document. Page
stack, zoom/pan/fit, coordinate spaces, and rulers.

**`typography.spec.ts` (6 tests, 4 baselines)** — how text renders. Character
formats, paragraph alignment, a soft break, an empty paragraph's height, and overflow.

**`../editor/*.spec.ts` (179 tests)** — how the editor *behaves*. Selection and hit
testing (39), the transform tools, the inspector, history and the ADR 0002 text-undo
composition (18), the selection overlay (13, seven of which record baselines), text
frames and typography (21), the ADR 0004 measurement contract (22), graphical objects (60)
and images (28, one baseline). All driven through real mouse and keyboard input.

**`../spike/*-probe.spec.ts`** — the measurements the ADRs rest on, recorded rather
than asserted, so a probe that drifts and a contract that drifts fail differently.

| Area | Assertions |
|---|---|
| Page stack | one element per page, in document order; vertical gap in document px; spacer reflects the whole stack |
| Zoom | exactly one transform, on the stack, and pages carry none; geometry identical at every zoom once zoom is divided out |
| Fit | frames the whole stack on load; tight axis bounded by the padding; re-fits on resize in fit mode; manual zoom survives a resize |
| Pan | scrolling moves content without changing geometry; space+drag pans and toggles the cursor; focus loss cancels pan; ctrl+wheel zooms, plain wheel scrolls |
| Anchored zoom | the document point under the cursor does not move |
| Coordinates | status bar reports page-local document mm; a gap reports "gap"; page 2's y restarts at 0 |
| Rulers | canvas chrome outside the document surface; redraws on zoom; tick count falls as you zoom out |
| Shortcuts | `+`/`-`/`0`/`1` work; ignored while typing in a field |
| Text | formats and alignment reach the DOM; `white-space: pre-wrap` is in force; a `\n` is a line break with **no `<br>` emitted**; repeated spaces survive; an empty paragraph still occupies a line; overflowing text is painted but is **not** selectable outside its own box |
| Shapes | a stroked box reports the model width from every layout API while its client box shrinks by the stroke; rotation does not move the reported box; a corner radius, `border-radius: 50%` and an SVG line all reach CSS; the SVG island keeps a zero-height line at height 0 |
| Shape hit testing | a rectangle is its box; an ellipse is the ellipse, so its corners do not select it; a horizontal line is selectable at height 0; a diagonal line is a segment, not its box; a rotated object is tested in its own space; the topmost of two overlapping objects wins |
| Editor vs. browser | the two answers are asserted **separately** where they should match (rect, stroked line, ellipse interior/exterior) and the divergence is asserted explicitly where they should not (a stroke-less line) — so a change in either direction fails |
| Creation | a drag commits exactly the dragged rect, normalised; a click commits a default size; a drag too small to select is refused; one drag is one undo step; identical document size at 195% and 64% zoom and while panned; an armed tool ignores the selection's handles; <kbd>Esc</kbd> disarms it |
| Shape inspector | fill, stroke, weight and opacity; a rect-only field is hidden for an ellipse; a line offers no fill; re-committing an unchanged value adds no history entry; a nested stroke edit preserves the stroke's other properties |
| Images | the authored box wins over the browser's decoded size, and over the document's *declared* intrinsic size; a rotated image still reports its model box; `object-fit` reaches CSS without moving the box; a missing asset paints a marked placeholder and stays selectable; a deliberately hidden object has no box at all; a file that is not an image changes nothing and adds no history entry |
| Image setup | every image assertion waits for `data-asset-state="loaded"` first, and the baseline deliberately includes one *missing* asset so it records a placeholder rather than an empty rectangle |

## Clip regions, and why they are not interchangeable

`tests/visual` clips the **page**, which proves the document renders correctly and
deliberately excludes chrome.

`tests/editor/overlay.spec.ts` clips the **`.surface`** box, which contains the
viewport *and* the overlay. That is the only region where selection chrome appears.

`tests/editor/shapes.spec.ts` uses the **page** clip too — shapes are document content —
and pairs it with an object-count assertion, because a screenshot of an empty page is a
passing test that shows nothing.

This matters: a page clip that included chrome would re-record every time a selection
changed, and a page clip that excluded it would not test it at all. `screenshotSurface`
therefore refuses to clip when the surface does not fit the viewport, for the same
reason `screenshotPage` does — a wrong-region clip records something plausible and
passes.

## Design notes

**Two assertion styles, deliberately.** Baselines (`toMatchSnapshot` on a clipped
screenshot) prove the page *looks* right. Behavioural assertions (`hitTestAt`,
computed geometry, scroll offsets) prove specific claims exactly and give a
readable failure. Clipping, paint order and the page stack use both.

**`hitTestAt` rather than pixel sampling.** For positioned elements the browser's
hit-test order *is* its paint order, and `overflow: hidden` clips hit targets
exactly as it clips painting. One `document.elementFromPoint` call answers both
"is this object clipped away here?" and "which object is on top here?" — and it is
far faster: decoding a screenshot inside the page cost ~35s per capture here.

**Fixtures render through the real reconciler.** `mountFixture` injects a document
via `window.__P1_FIXTURE__`, which the app's composition root consumes, so a
fixture cannot pass while the real app fails.

**Two mount flavours.** `mountSample`/`mountFixture` normalise zoom to 1:1,
because most geometry assertions are stated in absolute document pixels and need a
known zoom. `mountFixtureAsBooted` leaves the app's boot-time fit alone, which is
what stack and fit tests want — a 4-page stack at 1:1 is 4586px tall and mostly
off screen. Getting this wrong produced several failures that looked like
application bugs.

**Scroll offsets must be normalised before measuring.** The boot fit leaves the
viewport scrolled, so a "before" measurement taken without first setting
`scrollTop = 0` compares against an arbitrary starting scroll. Three tests failed
on exactly this.

## Traps hit while building this

Recorded because each produced a *passing* test that verified nothing, or a real
bug that only a rendered image revealed.

1. **`fullPage: true` with a clip silently pads with white.** The editor scrolls
   internally, so the document is only as tall as the window; a clip taller than the
   document is padded. The first `page-clip` baseline was entirely white — green,
   showing none of the content. Never use `fullPage` here.
2. **A clip is in client coordinates, so a partly-scrolled page captures chrome.**
   The M1 zoom baseline quietly started recording the toolbar once rulers existed.
   `screenshotPage` now throws when the page does not fit the viewport, rather than
   recording a misleading image.
3. **Locator screenshots of a taller-than-viewport element are pathologically
   slow** (>30s, via scroll-and-stitch). Use an explicit clip, and size the browser
   viewport (`VIEWPORT` in `playwright.config.ts`) so the page fits at the highest
   zoom under test.
4. **`projects[].use` merges after top-level `use`,** so `devices['Desktop Chrome']`
   silently overrode the configured viewport. The viewport must be restated in the
   project block.
5. **Vite binds IPv6 `::1` by default on Windows,** which the readiness probe on
   `127.0.0.1` cannot reach. The web server passes `--host 127.0.0.1`.
6. **Browser precision is bounded.** Layout geometry is quantised to 1/64px
   (Chromium LayoutUnit) and CSSOM re-serialises lengths to ~3 decimals. The unit
   tests assert the exact float; the browser tests assert within those limits and
   separately prove the page was not snapped to an integer.
7. **Screen px and document px are not interchangeable.** `getBoundingClientRect`
   returns screen px; the model is in document px. A gap read from rects and used
   as a document length produced a plausible-looking wrong zoom. `readGap` in
   `navigation.spec.ts` divides by the live zoom, with a comment saying why.
8. **Scroll and measure are separate steps.** A helper that scrolled to a point and
   returned its coordinates *in the same evaluate* returned the pre-scroll position,
   so the mouse landed on empty space. See `clientPointOn`.
9. **Chrome is not document, so it needs its own clip.** See the two-region note
   above. Adding overlay assertions to `geometry.spec.ts` would have re-recorded its
   page baselines on every selection change.
10. **`pointer-events: none` on the overlay is load-bearing.** The layer sits above
    the pages, so without it every click lands on chrome and nothing is selectable at
    all. It is asserted directly rather than left to "the other tests pass".
11. **A baseline of an empty frame is a baseline that cannot fail.** The first
    `text-empty-paragraph` recording was a blank white page — identical whether the
    frame rendered a line or not. The fixture now puts text *below* the blank line, so
    the image records the gap the line leaves. A baseline should be constructed so that
    the bug it exists to catch would change the pixels.
12. **The browser and the editor disagree about overflow, and both are right.** Below a
    text frame's bottom edge `elementFromPoint` returns the frame (its text really is
    painted there) while the editor selects nothing (its hit test is against the model,
    which knows the box). `typography.spec.ts` pins both answers rather than picking the
    convenient one.
13. **`toHaveText` normalises whitespace,** which silently defeats any assertion about
    significant whitespace. Text assertions read `textContent`.
14. **A helper that sets up state must assert it.** `measure.spec.ts` clicked `(60, 60)`
    to select a frame rotated 30° — a point outside the shape — and only *appeared* to
    select it because a zero-size marquee selected anything whose box contained the
    point. Twenty-two tests passed on every run while measuring nothing. The helper now
    asserts the frame was selected and names the failing point.
15. **`pointer-events` is inherited in SVG.** Setting `none` on an `<svg>` root to stop
    Chromium hit-testing its rectangular viewport also silences the child `<line>`,
    because the property inherits. An island needs `none` on the root *and* `stroke` on
    the shape — two declarations, or no pickable ink.
16. **A fixture that can be wrong about being an image will be.** Two M6 conclusions were
    artefacts of broken image data: "Chromium is alpha-aware for hit testing" (a
    hand-written PNG that did not decode, so every "loaded" case ran the *failure* path) and
    "a zero-sized image does not load" (a `0x0` canvas, which is undecodable). Both inverted
    once valid bytes were used. **Generate image fixtures at test time**, and refuse to let a
    test proceed against an image that did not load: a failed image keeps its full authored
    box and still reports `complete === true`, so "an element exists" proves nothing.
17. **`lastDocument` must be published before reconciling.** A renderer reads the document
    *during* projection. Assigning it afterwards meant a freshly inserted image resolved
    against the previous document and rendered empty — indistinguishable, from the test,
    from a decode failure.
18. **Hit testing has more than one entry point.** Fixing the marquee exposed how much
    depends on the *click* not being a drag: a zero-size rect overlaps every box
    containing the point. Any new gesture that ends by testing geometry needs checking
    against that, not only the one that reads a pointer.

19. **Chrome geometry is document geometry.** The status bar is a grid row and
    `.surface` takes whatever height is left, so *anything* that changes the
    chrome's height resizes every baseline in this suite. M7 added a dirty indicator
    with `padding: 1px 6px` and a `border`; four pixels of padding moved all
    twenty-five baselines by four pixels, and the failure surfaced as a
    `2502px by 2506px` mismatch in a suite about the overlay. Status-bar content must
    not be able to change the status bar's height: draw rings with an inset
    `box-shadow`, not a border and padding.
20. **A byte-compared fixture must be `-text`.** The golden `.p1doc` is compared
    against the serialiser's output, so its line endings *are* its identity.
    `core.autocrlf` rewrote them to CRLF on checkout and three assertions failed on a
    diff consisting entirely of `\n` versus `\r\n`. See `.gitattributes`.

21. **An assertion that checks *that* something moved will pass on a fraction of
    the movement.** The pre-existing multi-object drag test asserted only that the
    inspector went *mixed* — which one-eighth of an eight-step drag satisfies. A
    live bug was green behind it: <kbd>shift</kbd>-clicking a second object and
    dragging moved the pair 7.5px of an intended 60px and left the editor stuck
    mid-gesture, because the browser had started a text selection and taken the
    pointer back with `pointercancel` (a cancelled pointer delivers no further
    events at all). **Assert the end of a drag, not that it began.**

22. **An editor that captures the pointer must handle `pointercancel`.** It is
    not a rare formality. A press that also begins a native selection or drag gets
    its pointer cancelled, and a gesture left open then hangs forever with no event
    coming that could end it. `app.ts` both `preventDefault`s the gesture's
    `pointerdown` and handles `pointercancel` through `Editor.cancelGesture` — the
    cause and the symptom, because either alone leaves a path to the same hang.

23. **An identifier must not name two things.** The renderer stamped each object
    with `data-oid` and the overlay stamped its outline group with the same name, so
    `[data-oid="x"]` matched two elements in two different layers and Playwright
    reported a strict-mode violation on a locator that had looked reasonable. The
    overlay's marker is `data-for`. This is the M0 `zIndex` rejection applied to the
    DOM, and it is asserted as a *count* in `tests/editor/layers.spec.ts` so a
    future collision is one named failure instead of a dozen unrelated ones.

24. **Two fixtures on one page: the second `addInitScript` wins.** A `beforeEach`
    that mounts a fixture plus a test that mounts another registers two init
    scripts, and a test that calls `mountSample` instead registers none — so the app
    boots with the *previous* document and the failure reads as "no text frame",
    three steps from the cause. One mount per test.

25. **A helper that selects objects must clear the selection first.** A plain click
    on an already-selected object deliberately *keeps* the whole selection, because
    that is what makes dragging a selected object work. A helper that clicks the
    first object and then shift-clicks the rest therefore inherits whatever was
    selected before it. And <kbd>Esc</kbd> is ignored while a field has focus, so
    the focus has to be dropped first.

26. **An assertion that reads the first overlay outline is reading the first in
    *document* order.** The overlay is built from `selectedNodes(doc, selection)`,
    which walks the array, so its first outline is the frontmost selected object —
    not `selection.primary`. Reading it as the primary is wrong, and `primary` has
    no other DOM observable: <kbd>Enter</kbd> is the only way to see it.

27. **With everything selected, all four layer operations are no-ops.** This has
    broken three separate tests in one milestone, each of which asserted a real
    property for a reason that had nothing to do with it. It is M8's "no unselected
    neighbour to trade with" rule, and it is easy to forget when writing a test.

28. **A cancellation must be asserted on saved bytes, not on geometry.** A rollback
    that missed one pixel of sixty passes `toBeCloseTo` on one axis. The
    serialiser's output is a total function of the document, so bytes catch partial
    rollback, a wrong page, a stray node and an unintended property change — none of
    which a position assertion can see.

29. **A hand-written injected fixture fails as a bare timeout.** A fixture the parser
    refuses, or one with a syntax error, produces `net::…` or a 30-second
    `waitForSelector` timeout three steps from the cause. Build injected documents
    with the shared fixture helpers: they carry the same guards the format enforces.
30. **A fixture object can sit outside the page and still be in the document.** `SHAPES`
    places `rect-rotated` at `y: 320` on a 300-high page. It renders, it has a matrix,
    and it cannot be clicked, selected, or have a handle grabbed - so a test that
    selects it does nothing and every assertion after it passes vacuously. An early
    draft of `no-shear.spec.ts` had exactly this, and its "move" test was green while
    the click never landed. Assert the *selection* after selecting.
31. **`clickAt` and `drag` take document coordinates, not client ones.** They convert
    internally through `clientPointAt`. Passing what `getBoundingClientRect` returns
    aims somewhere else entirely - usually the background, which begins a marquee
    instead of a grab. Use `GEOMETRY` from the fixture, as `shapes.spec.ts` does.
32. **A gesture's reachability is not implied by the editor's capability.** `startRotate`
    fans out over several nodes, and no gesture can call it: the rotate handle is
    emitted only for a single outline whose `rotation === 0`. Writing a test against the
    capability produces a 30-second timeout waiting for a handle that will never
    exist. Check what the overlay actually offers before driving it.
33. **A sweep that finds nothing needs a witness.** `no-shear.spec.ts` reads every
    matrix after every gesture and finds no shear - which is also what an all-identity
    document, a wrong selector, or a broken predicate would produce. So it injects
    `matrix(2, 0, 1, 1, 0, 0)` into a live element and requires the same sweep to
    reject it, and separately requires it to accept a rotation and a non-uniform scale.
    Write the negative control into the same file, not a note about it.
34. **"The scale changed" and "the box changed" are different claims.** No gesture
    writes `scaleX`/`scaleY`, so a resize grows `width`/`height` and leaves the matrix
    scale at 1. An assertion checking the matrix scale after a resize tests nothing.
    Read `left`/`top` and `offsetWidth`/`offsetHeight` for the model, and reserve
    `getBoundingClientRect` for paint-space claims.
35. **A border does not change its parent's rect.** Probing a stroke by measuring the
    element it belongs to measures nothing, because a CSS border paints *inside* the
    box. Use a nested pair and read the child's offset from the parent's painted edge:
    that offset *is* the border's painted width. It is 12 at rest, **24 × 36** at
    `scale(2,3)`, and **19.2** under a shear — which is how M10b established that
    stroke invariance is unavailable without leaving CSS.
36. **A feature can be parsed and still do nothing.** `'vectorEffect' in
    document.body.style` is `true` in Chromium, and
    `el.style.vectorEffect = 'non-scaling-stroke'` reads back fine — on an HTML element,
    where it has no effect, because it is defined for SVG geometry. A test that asserted
    the property was *absent* passed for the wrong reason; the honest negative control
    sets the property and measures the thing it was supposed to change.
37. **A derived quantity needs the transformation that derives it.** Painted bounds are
    the AABB of four transformed corners. Under rotation there is a closed form; under
    shear there is not, and a shear can *narrow* an AABB as readily as widen it — so
    "the bounds are bigger now" is not a safe expectation even when a transform grew.
38. **Rotation about the box centre leaves the centre where it was.** The temptation is
    to explain the missing rotate handle by "the frame's centre drifts under rotation".
    It does not — `R` about the centre is a fixed point. The real cause is the eight
    *handles*, which are placed on the frame's corners, and those do move. Guessing the
    mechanism here would have produced a fix for the wrong part.
39. **A pixel baseline cannot see a 1px chrome change.** `maxDiffPixelRatio: 0.002`
    over the surface clip is several thousand pixels of tolerance, and a selection
    outline *rotating* is far under it — verified: the `overlay-rotated` snapshot passes
    both before and after the F6 fix. Assert chrome geometry with rectangles, not
    pictures. This is trap 14 with a much sharper edge than the page content it is
    calibrated for.
40. **Injected fixtures bypass the parser.** `window.__P1_FIXTURE__` is used as given:
    `expectOnlyKeys` never sees it and `normalizeRichText` never runs. A wrong shape is
    not *refused* — it reaches the renderer and throws, and the document mounts with
    **zero objects** and nothing indicating it was malformed. `RichText` is
    `{ blocks: [...] }`, not `{ paragraphs: [...] }`; an asset record is
    `{ kind, mime, intrinsicWidth, intrinsicHeight, data: { inline } }`. When a fixture
    yields no objects, read `pageerror` before reading the fixture.
41. **Page px and client px are not interchangeable, and three tests in one file
    managed to mix them.** `clickAt`/`drag` take document coordinates;
    `getBoundingClientRect` and `boundingBox` return client ones. The symptom is never
    "wrong coordinates" — it is a distance of several hundred pixels, or a field reading
    `NaN`, or a premise that passes for the wrong reason. Convert once, explicitly.
    M12 reached it **four** times in one file, from the other direction: a helper
    returning page-local px from `getComputedStyle` + `style.left`, compared against a
    `boundingBox()`. One of those produced a 469px "error" in a *handle* test that had
    nothing wrong with the handles. Name the unit in the helper's name, not in a comment.
42. **A helper's coordinate space is part of its contract, and a good name is the
    cheapest enforcement.** `corners()` returns page-local document px because
    `element.style.left` is page-local and the computed `transform` carries no
    translation. Nothing about the name says so, so the mistake is invisible until a
    number is 400px wrong.
43. **A fixture must paint inside its page, and a rotated object's extent is not its
    box.** M12's `g-kinds` group sat at `(40, 40)`; its rotated, 1.5-scaled first child
    painted from `y = -36` — above the page, so clipped and *unclickable*. The failure
    surfaced as a message about hit testing, four steps from the cause. This is
    `SHAPES`' `rect-rotated` at `y: 320` on a 300-high page, committed again in the file
    whose header warns about it. **Assert that a fixture object is reachable before
    asserting anything about it.**
44. **A test inserted outside its `describe` has no `beforeEach`.** M12's hidden-group
    test landed between two `test.describe` blocks, so the fixture never mounted and the
    test saw an empty document — and reported that hit testing was broken. The failure
    message pointed four layers away from the mistake.
45. **A click selects; it does not open a text session.** Enter does. A test that clicks
    a text frame and then waits for `data-editing` times out with nothing to suggest why,
    which reads as a fence bug rather than a missing keystroke.
46. **Centres, not origins — and not bounding boxes.** Two M12 traps in one: a shape's
    *centre* differs from its *origin* by half its own size, so two shapes' centres are
    not separated by their origins' separation unless they are the same size; and the
    centre of a **rotated** shape is not the centre of its bounding box. Comparing
    bounding-box centres of differently-sized shapes read 194.7 where the truth was
    167.6 — a 27px "error" with no fault behind it. Average the four transformed corners.

The recurring lesson: **a screenshot test nobody has looked at proves very little.**
Both all-white and chrome-containing baselines were green. And, from trap 14: **so does a
setup step that silently does nothing.** Traps 21, 25, 30, 33 and 36 are the same lesson at
different scales: a setup step that silently does *almost* nothing, or that does nothing at
all while appearing to succeed, is worse than one that fails — because its assertion is
still true. Trap 39 is the sharpest version: a whole milestone's central fix was invisible
to the visual suite that covers exactly that surface.

## Extending

When a new object type lands, add:

- one `mountFixture` document exercising it,
- one baseline screenshot at 1:1,
- behavioural assertions for anything the architecture claims about it.

M5, M6 and M7 are the worked examples. For shapes and images:
`tests/editor/shape-fixtures.ts` plus `shapes.spec.ts`, and `tests/editor/image-fixtures.ts`
plus `images.spec.ts` — with the registry predicates unit-tested separately in
`src/model/shapes.test.ts`, the asset rules in `src/model/assets.test.ts`, and the
measurements behind each contract recorded in `tests/spike/shape-*-probe.spec.ts` and
`tests/spike/image-probe.spec.ts`.

For images, the fixture builders take **source strings** rather than values, because the
asset table has to carry a data URL generated at test time — and `image-fixtures.test.ts`
parses the result and checks that every node's asset exists, so a dangling reference fails
as a fixture error rather than as an empty box.

For persistence, the equivalent separation is: the *format* is unit-tested against a
hand-written golden file (`tests/persist/`), and the *lifecycle* is browser-tested through
real bytes (`tests/editor/persistence.spec.ts`). Neither needs a visual baseline, because the
claim is byte identity rather than appearance — and asserting a round trip by comparing
rendered geometry would be *weaker*, since `getBoundingClientRect().height / zoom` is never a
size for a rotated box and cannot see the document's `name` or its asset table at all.

Keep the suite architectural. Comprehensive editor *behaviour* tests now live in
`tests/editor/` with the helpers they share.

For text, fixtures live in `../editor/text-fixtures.ts` and are **imported**, never
copied — a baseline recorded against one document and asserted against another is the
failure mode the harness comment already warns about.

For anything drawn in the overlay rather than on the page, use
`screenshotSurface` from `tests/editor/overlay.spec.ts` rather than
`screenshotPage` — and be explicit about which one you want, because they clip
different regions on purpose.

