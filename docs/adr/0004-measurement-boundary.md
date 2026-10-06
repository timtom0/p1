# ADR 0004 — The measurement boundary

- **Status:** accepted
- **Date:** 2026-10-04
- **Depends on:** [ADR 0001](0001-text-editing-fence.md) (the fence),
  [ADR 0002](0002-text-undo-composition.md) (undo composition),
  [ADR 0003](0003-production-text-model.md) (the text model)
- **Amends:** `docs/ARCHITECTURE.md` §2.6, which sketched a `TextMeasurer` that
  re-renders text offscreen. See [Relationship to §2.6](#relationship-to-26).
- **Blocks:** auto-size, columns, fit-to-content, baseline snapping

## Context

ADR 0003 ended with a stated debt: every deferred text feature needs numbers the
document cannot supply, because line breaking, line boxes and glyph positions are
delegated to CSS by design. §2.6 sketched the answer as a `TextMeasurer` that clones
the computed typography into an offscreen host and measures it there.

That sketch is wrong, and this ADR replaces it. It is wrong for three independent
reasons, each established by measurement rather than by argument:

1. **The text is already in the document.** We do not need a second, offscreen copy of
   it to measure it. Rendering the same `RichText` twice is a second rendering path,
   which is the one thing this architecture does not get to have — and it would drift
   from the real one the first time the projection changed.
2. **Zoom and transforms would have to be undone by hand.** An offscreen host has no
   page-stack transform, so its numbers would be in a *fifth* coordinate space that
   every caller then converts. The measured alternative needs no conversion at all
   (below), and that is not a coincidence: it is a property of which DOM APIs are
   consulted.
3. **It would answer the wrong question.** An offscreen host at some assumed width
   cannot tell you how the *mounted* text is laid out. Only the mounted projection can,
   and only it is the thing a user is looking at.

So the question this ADR actually answers is the one §2.6 left implicit:

> Given this document model, rendered through our normal HTML/CSS pipeline, what
> geometry did the browser produce?

## Method

Every claim below was measured in Chromium 153 against the **real application** —
real reconciler, real stylesheet, real page-stack `transform: scale(z)` — through
`mountFixture`. `tests/spike/measure-probe.spec.ts` is retained as the executable
record and is the evidence for every table here.

Probes cover: the control case; four zoom levels; a 30° object rotation; wrapped
text; soft breaks; multiple paragraphs with per-paragraph ranges; an empty frame;
trailing whitespace against the same text trimmed; overflow; a hidden frame;
fractional line height; `ResizeObserver`; font readiness; read-after-write timing;
repeated measurement; an active editing session; and a frame with no `TextStyle`.

## Measurements

### Zoom: which APIs survive it

The same 200×50 frame, one short line, at four zoom levels:

| Stack scale | `getBoundingClientRect` | `offsetW/H` | `clientW/H` | `scrollW/H` |
|---|---|---|---|---|
| 0.8 | 160 × 40 | **200 × 50** | **200 × 50** | **200 × 50** |
| 1 | 200 × 50 | **200 × 50** | **200 × 50** | **200 × 50** |
| 1.25 | 250 × 62.5 | **200 × 50** | **200 × 50** | **200 × 50** |
| 1.5625 | 312.5 × 78.125 | **200 × 50** | **200 × 50** | **200 × 50** |

**`offsetWidth/Height`, `clientWidth/Height` and `scrollWidth/Height` are
zoom-invariant. `getBoundingClientRect` and every `Range` rect are scaled.**

This is the load-bearing fact of the whole ADR, and it is structural rather than
incidental: those three are *layout* quantities, and `scale()` is a paint-time
transform applied after layout. Zoom is one CSS write (§2.2) precisely so that
layout never has to change — and this is that decision paying out.

### Object rotation: layout box vs painted box

A 200×50 frame rotated 30° about its centre:

| | Value | What it is |
|---|---|---|
| `getBoundingClientRect` | 198.2 × **143.3** | axis-aligned bounding box of the *painted* result |
| `offsetWidth/Height` | **200 × 50** | the layout box |
| `clientWidth/Height` | **200 × 50** | the layout box |
| `scrollWidth/Height` | **200 × 50** | the layout box |

The painted height is nearly **three times** the real one. So
`getBoundingClientRect().height / zoom` is not a small inaccuracy — for any rotated
object it is badly wrong, and it is wrong in a direction that grows with the rotation.

### Text height: which API actually holds it

| Fixture | Content laid-out height | `clientHeight` | `getBoundingClientRect().height` |
|---|---|---|---|
| one short line | 24 | 24 | 24 |
| wrapped to 4 lines | 96 | 96 | 96 |
| three soft breaks | 72 | 72 | 72 |
| three paragraphs | 72 | 72 | 72 |
| empty paragraph | 16 (`min-height: 1em`) | 16 | 16 |
| 8 lines in a 40px frame (overflow) | 192 | **192** | 192 |

The text content element has `height: auto`, so its laid-out height *is* the text's
height — no overflow arithmetic required, and the overflow row shows it stays true when
the text exceeds the frame. **`clientHeight` on the content element is the auto-size
number.**

### Precision: integers versus fractions

Three lines at `font-size: 16px; line-height: 1.35` — exactly 64.8px:

| API | Value |
|---|---|
| exact | 64.8 |
| `getBoundingClientRect().height` | 64.781 |
| `offsetHeight` / `clientHeight` / `scrollHeight` | **65** |
| `ResizeObserver.contentBoxSize[0].blockSize` | **64.78125** |

Two separate quantisations, and this matters:

- Layout APIs **round to integers**. A 19.5px line height reports `20`. So a
  three-line frame is 58.5px of text reported as 60 — a **1.5px** error.
- Chromium quantises to **1/64px** internally, so even the fractional values are
  `64.78125`, not `64.8`.

`ResizeObserver` is the only source of a **fractional, zoom-invariant,
transform-invariant** size. Confirmed by rotating the observed element during
observation: `blockSize` stayed `64.78125` while `getBoundingClientRect().height`
moved to `96.1`.

### Empty frames and hidden frames

| | Range rects | `Range.getBoundingClientRect` | `clientHeight` |
|---|---|---|---|
| empty paragraph | **none** | **0 × 0** | 16 |
| `visible: false` frame | none | 0 × 0 | **0** |

An empty paragraph has no range geometry at all; its height comes only from
`min-height`. And a frame the model has hidden (`display: none`) reports **zero from
every API** — indistinguishable from a genuinely zero-sized object.

### Line boxes: `Range.getClientRects` is not a line API

| Fixture | Lines | Rects returned | What the extra rects are |
|---|---|---|---|
| wrapped | 4 | **8** | one block rect per `<p>`, then one per *inline fragment*; wrapped lines yield two, the second being a 4.4px overhang |
| soft breaks | 3 | **6** | block rect plus, at each break, a **zero-width** rect |
| three paragraphs | 3 | 6 | alternating block rect / text rect |

`getClientRects` returns **one rect per inline fragment**, not per line. Counting them
to count lines is wrong by a factor of up to two, and zero-width rects appear at soft
breaks.

### Ink bounds

`'ab      '` (six trailing spaces) and `'ab'`:

| | text rect width | `scrollWidth` |
|---|---|---|
| with trailing spaces | 43.84 | 200 |
| trimmed | 17.55 | 200 |

The spaces occupy 26.3px of real layout — `white-space: pre-wrap` is doing its job —
but **no layout API reveals it**. Ink bounds are reachable only through client-space
range rects.

## Decision

### 1. The measurement contract

Two sizes, one boolean pair, one refusal. Nothing else.

```ts
/** Laid-out size in document px. Integer; zoom- and transform-invariant. */
export interface LayoutSize { readonly width: number; readonly height: number }

/** Whether an element's content exceeds its box. Derived, never raw numbers. */
export interface Overflow { readonly x: boolean; readonly y: boolean }

export type Measurement =
  | { readonly status: 'ok'; readonly size: LayoutSize; readonly overflow: Overflow }
  | { readonly status: 'unmounted' }
  | { readonly status: 'hidden' }
  | { readonly status: 'stale' };
```

The four failure statuses are the point. **A measurement never returns a number it
cannot stand behind.** A hidden frame returns `hidden`, not `0`, because `0` is a
plausible-looking answer that is wrong; a stale projection returns `stale`, because the
alternative is reporting the *previous* document's layout as if it were current.

`stale` deserves its own justification. It is checkable: the frame's `offsetWidth`
must equal the model's `transform.width`, and the frame's `offsetHeight` must equal
`transform.height` (ADR 0003 §1.5.1 — the frame is a box the model sizes). Two integer
reads turn "did you measure the document or a memory of it?" from a convention into a
verifiable property. It is also the only thing standing between this API and the most
tempting future bug in the codebase: measuring before the render pass and writing the
answer into the model.

Sizes come in two precisions, and the split is forced by the measurements rather than
chosen:

| | Source | Precision | When |
|---|---|---|---|
| **Sync** | `clientWidth/Height` | integer | anywhere, immediately |
| **Async** | `ResizeObserver.contentBoxSize` | 1/64 px | after layout settles |

`Overflow` is derived (`scrollWidth > clientWidth`) rather than exposing the raw pair,
because a raw pair invites every caller to invent its own threshold — and one of them
will use `>=` and report a 1px overflow as an overflow.

### 2. Coordinate spaces

| Space | Origin / unit | Who owns conversions |
|---|---|---|
| **document** | page-local, document px | the model's unit; what every measurement returns |
| stack | first page's top-left incl. gaps | `Viewport.pageOffsetY` |
| client | screen px | `Viewport.stackPointFromClient`, `Overlay.clientToLayer` |

**Every value this contract returns is in document px.** Not client, not stack.

That is not a simplification, it is the measurement: `clientWidth/Height` and
`scrollWidth/Height` are unaffected by both the stack's `scale()` and the object's own
matrix, so they are *already* in document px and need no division. Exposing a client
rect instead would hand every caller a number that must be divided by zoom — which is
exactly the "ad-hoc conversions" failure mode §3.7's single-conversion-point rule
exists to prevent, and which a browser test already caught once (§3.7).

**Positions are deliberately not part of this contract.** They already exist:
`Viewport` converts client ↔ stack ↔ page, `Overlay` converts page → client for
chrome. Measurement supplies sizes only, so it can never become a second conversion
path — and `render/` never needs to import `editor/`, which keeps the ESLint layer
rule satisfied by construction rather than by care.

One thing is therefore explicitly *not* offered: a client-space rect. A future feature
that needs one (a screen-space text guide, say) must ask `Viewport`/`Overlay` for the
conversion, in the same way every other caller does.

### 3. Timing and lifecycle

Each rule below is measured, and each names the case that would break it.

1. **Synchronous read-after-write is valid.** Setting `width: 70px` and reading
   `clientHeight` in the *same task* returned 168, identical to the value after a
   `requestAnimationFrame`. A layout-forcing read flushes pending layout, so **no
   frame boundary is required**. (Had this not held, every caller would need a frame
   of slack and the API would be much harder to use.)
2. **Immediately after a command is valid — because the store renders synchronously.**
   `store.subscribe(() => project())` is the store's only subscriber and calls
   `view.render` inline. This is a *wiring* property, not a guarantee, so the
   implementation does not assume it: `measureNode` compares the DOM against the model
   and returns `stale` if they disagree. §4.3's sketch said rendering would be
   microtask-coalesced; if a later milestone coalesces for performance, `stale` is what
   catches it, loudly, instead of a silently wrong number.
3. **Zoom does not invalidate a measurement.** No re-measure on zoom, ever. Verified
   across four levels. This is the single largest ergonomic consequence of choosing
   layout APIs, and it means the overlay and any future text chrome can read sizes at
   any zoom without a subscription.
4. **Viewport resize does not invalidate a measurement.** Pages have fixed document
   sizes, so document layout is unaffected by window size. (A resize that changes *fit*
   changes zoom, which is case 3.)
5. **Font loading does invalidate a measurement — when webfonts exist.** See §4.
6. **`display: none` must be refused.** Measured: every API returns `0`. A `visible:
   false` object must yield `hidden`, never a zero size.
7. **During a text session, measurement is valid but observes the browser, not the
   model.** See §5. And see §5.1: reads are safe mid-session, DOM writes are not.

### 4. Fonts

Measured: `document.fonts.status` is `loaded` and `document.fonts.size` is **0** — the
application declares no `@font-face` rules, and every family it uses (`system-ui`,
`Georgia`, `Segoe UI`) is locally installed, so there is **no asynchronous font step to
wait for**. `document.fonts.ready` resolved with no change in measured width.

**Decision: font readiness is part of the contract as a promise, not as a gate.**

```ts
export function whenFontsSettled(): Promise<void>;
```

It resolves `document.fonts.ready`. Today it is a no-op that costs nothing; the day a
webfont is introduced it becomes load-bearing, and every size measurement taken before
it resolves is wrong. Providing it now means the hook exists before the first thing that
needs it, rather than being retrofitted into every call site.

**`document.fonts.check()` is unusable and is recorded here so nobody reaches for
it.** Measured: `check('16px NoSuchFamilyExistsAtAll')` returns **`true`**. It reports
whether *pending loads* have settled, not whether a family resolved. A caller using it
to validate a `fontFamily` would accept a family that does not exist.

A second font decision follows from the measurement, and it is a **bug fix**, not a
contract detail. `body` declares `font: 13px/1.5 system-ui`, and `line-height` is a
*number*, so it inherits as a factor and recomputes against each element's own size. A
text frame with no `TextStyle` therefore rendered at **13px** — the editor toolbar's
font (measured; `clientHeight` 20 from a 19.5px line).

That is wrong twice over. A publishing editor whose documents are sized by its own
chrome means restyling the toolbar reflows every document. And it makes every
measurement conditional on a stylesheet the document does not own — precisely the
coupling this contract exists to remove. `.p1-text-content` now declares its own
`font-family`, `font-size: 16px` and `line-height: 1.2`, and `TextStyle` overrides them.

### 5. The fence

The question: can measurement observe the live `contenteditable` DOM without
violating ADR 0001?

**Yes, and measured rather than argued.** With a session open, the caret was recorded,
then a deliberately aggressive measurement pass ran — element rects, scroll dimensions,
a `Range` over the live content, and a fresh `Range` per paragraph — and the caret was
recorded again:

| | Before measuring | After measuring |
|---|---|---|
| caret offset | 5 | **5** |
| container text | `second` | **`second`** |
| inside `[contenteditable]` | yes | **yes** |

Typing afterwards landed exactly where the caret was (`firstseconZZdthird`), and the
frame still carried `data-editing="true"` throughout.

Every candidate API is read-only, so measurement *cannot* commit, and no code path from
a measurement result to `dispatch` exists. The rule this establishes:

> Measurement may observe the fenced DOM. It may never feed a measured value back into
> authored state on its own initiative. A future feature may do so **only** by
> dispatching a command, which puts it through the funnel and into history like any
> other authored change.

### 5.1 What may run *during* a session — and what may not

While establishing the above, wiring the session's `onDomChange` to a chrome refresh
turned out to break native undo. That is serious enough to pin down, because it is a
constraint on every future text feature and it is not obvious.

ADR 0002 measured that Chromium coalesces consecutive keystrokes into one undo unit, and
the application delegates to that. The grouping is therefore load-bearing. Measured, by
applying each kind of work *between* keystrokes and pressing Ctrl+Z once
(`tests/spike/undo-granularity-probe.spec.ts`):

| Work done per keystroke | Ctrl+Z undoes |
|---|---|
| nothing (baseline) | the whole word |
| a forced layout read (`clientHeight`) | the whole word |
| a selection query (`queryCommandState`) | the whole word |
| both reads | the whole word |
| **rebuilding the overlay's DOM** (`replaceChildren`) | **one character** |
| **rewriting a toolbar button's text** | **one character** |
| the full `Editor.onChange` refresh | one character |

**Reads are safe during an editing session. DOM mutations outside the editable are
not.** A full chrome refresh contains mutations, so per-keystroke refresh silently
destroys the keystroke grouping that ADR 0002's whole design rests on.

Two consequences:

1. `onDomChange` is **not** wired to `onChange`. The accepted cost is that the format
   toggles' pressed state, and the measured text height, show the state from when the
   caret was placed until the session exits. That is a real cost and it is the cheaper
   of the two — a stale toolbar indicator versus undo that deletes one character at a
   time.
2. **Measurement is on the safe side of this line.** Every API in the contract is a
   read. A future feature may measure on every keystroke if it needs to, provided it
   writes nothing.

This is also the reason the measured readout in the inspector does not track typing
live. It is not that measurement cannot see it — it can, and correctly — but that
publishing the number means writing to the DOM, and writing to the DOM costs the user
their undo granularity.


The consequence for auto-size is concrete and is in §7.

### 6. What is deliberately not exposed

Each rejection cites the measurement that motivates it, because "we could expose it" is
the argument these need to beat.

| Not exposed | Why |
|---|---|
| **Object border/content box** | It duplicates the model. `offsetWidth` on a frame equals `transform.width`, and `getBoundingClientRect` is *wrong* — 198×143 for a 200×50 box rotated 30°. Exposing it would create a second source of truth for geometry, which §1.3 makes impossible by construction. |
| **Raw scroll dimensions** | Only the derived `overflow` booleans. See §1. |
| **Line boxes** | `Range.getClientRects()` returns one rect per *inline fragment*: 8 rects for 4 lines, with zero-width rects at soft breaks. There is no reliable per-line geometry here, and inventing one would mean building a text layout engine — the thing §9.1 exists to avoid. **Unsupported.** |
| **Baselines** | Not available. `getBoxQuads()` is Firefox-only. The standard workaround is injecting a zero-width `vertical-align: baseline` strut into the live DOM and reading its top — which *mutates the projection* and is a second rendering concern. Recorded as the known route if a future feature needs it; **deliberately not built.** |
| **Text ink bounds** | Only reachable in client space, and no layout API reveals them (trailing spaces: 26.3px of ink, `scrollWidth` unchanged at 200). Any caller needing ink must opt into client space explicitly and convert through `Viewport`. |
| **Scroll position** | Not layout. The viewport owns it. |
| **Anything browser-specific** | `DOMRectReadOnly`, `ResizeObserverEntry`, `getComputedStyle` and `element.style` do not appear in the contract's types. They appear in the implementation and stop there. |

## Relationship to §2.6

§2.6 sketched:

```ts
measure(text: RichText, frame: FrameProps, opts: { maxWidth?: number }): { width: number; height: number }
```

Every part of it is superseded:

| §2.6 | ADR 0004 |
|---|---|
| an offscreen host cloning computed typography | the **mounted** projection, which is the thing being looked at |
| takes `text` and `frame` as input | takes an already-rendered element; the model is only used to check the projection is current |
| `maxWidth` option | the width is the model's `transform.width`; the element already has it |
| returns `{ width, height }` | returns a **status union**, because the failure modes are real and `0` is a lie |
| "sync measurement at command time" | correct, and now measured rather than assumed — but insufficient for fractional precision |
| "ResizeObserver … guarded by a measured-don't-re-measure flag" | correct, and now **required** rather than optional, because rounding makes it necessary (§7) |

What survives is the reasoning, not the code: measurement is a question asked of the
browser, and it is a prerequisite for the deferred text features rather than an extra.

## Relationship to ADR 0003

ADR 0003's division of labour is unchanged and is what makes this cheap:

> If the user authored it, it is in the model. If changing it changes pixels without the
> user authoring it, it belongs to CSS.

Measurement is the read side of that rule. It reports what CSS produced; it never
becomes a place where layout is *stored*. The one path by which a measured value could
reach authored state is a command, and §5 requires it to go through the funnel so it
lands in history like any other change. A text frame's height that auto-size adjusts is
then a **user-visible, undoable edit**, not a hidden side effect — which is the only
outcome consistent with §4.2's "every mutation is a command".

## Auto-size implications

The contract is **sufficient**, and two consequences follow that change what auto-size
must be.

**What it needs, and gets:**

| Needed | From |
|---|---|
| text height at the current width | `content.clientHeight` |
| the width to reflow at | the model already owns it (`transform.width`) |
| whether it currently overflows | `overflow.y` |
| convergence across renders | `observeContentBox` |

**What it does not need:** positions, baselines, line boxes, ink bounds, or the text
width. None of those are required to size a box to its text.

**Consequence 1 — auto-size cannot be a pure, synchronous command.** The integer
`sync` measurement can be off by up to ~1.5px per three lines (measured: 58.5px of text
reported as 60). Using it would make the frame's height a function of rounding, so the
frame would oscillate between two values. Fractional precision requires the
`ResizeObserver` path, which is asynchronous, so auto-size is necessarily:

> change the width → render → measure → dispatch the fitted height → render → measure again

**Consequence 2 — the loop guard is mandatory, not defensive.** §2.6 called for a
"measured, don't re-measure" flag. With rounding in play that flag is what makes the
operation terminate: commit only when the measured height differs from the frame's
current height, and only re-arm the observer after a commit. Without it the sequence
above can oscillate forever, and each iteration is an undo entry.

**Consequence 3 — it must not run during a text session.** §5 established that
measurement is non-disturbing, but a measurement taken mid-session is a measurement of
the browser's uncommitted DOM. Sizing the frame to it would commit an uncommitted
measurement. Auto-size must therefore run on session exit, or defer — and if the latter,
the loop guard must also cover the session boundary.

None of this is implemented here. It is recorded so that whoever implements auto-size
inherits the constraints instead of rediscovering them.

## Limitations

Carried forward deliberately, so they are not mistaken for oversights.

- **No line geometry and no baselines.** The two things a text editor most wants, and
  the browser does not offer them reliably. See §6. Snapping to baselines is therefore
  **not** currently supportable, and inventing support would mean a text layout engine.
- **Integer sizes from the synchronous path.** Up to ~0.5px per line box, plus
  Chromium's own 1/64px quantisation. Acceptable for a box that will be fitted and
  rounded anyway; unacceptable for anything requiring exact metrics.
- **`stale` is checked against object geometry only.** It proves the *frame* is current.
  It cannot prove the *text* inside it is current, because the content element's size is
  exactly the thing being asked about. The check catches the realistic failure (measuring
  before the render pass) and cannot catch a hypothetical partial render.
- **Fonts are only settled for locally-installed families.** Correct today; the first
  webfont makes `whenFontsSettled()` load-bearing, and until then nothing verifies it.
- **Measurement forces layout.** Every call is a layout-forcing read. Fine for a handful
  of frames on demand; a pass over a large document must be batched and coalesced, and
  must not run per pointer-move.

## Verification

| Claim | Where |
|---|---|
| Zoom invariance of the layout APIs; `getBoundingClientRect` scaling | `tests/spike/measure-probe.spec.ts` A–B |
| Rotation: painted AABB vs layout box | same, C |
| Text height from `clientHeight`, including overflow and empty | same, A, D, E, F, G, I |
| Integer rounding, and `ResizeObserver` as the fractional source | same, J, K |
| Trailing whitespace is real ink but invisible to layout APIs | same, H |
| `display: none` returns 0 from every API | same, N |
| Line rects are per inline fragment, not per line | same, D, E, F |
| Font readiness, and `check()` being unusable | same, L |
| Same-task read-after-write; hidden reads 0 | same, M |
| Repeated measurement stability | same, O |
| The fence: measuring mid-session preserves the caret and the marker | same, P |
| Reads are safe mid-session, DOM writes are not | `tests/spike/undo-granularity-probe.spec.ts` |
| The contract itself, with negative controls | `tests/editor/measure.spec.ts` |
| The four status branches | `src/editor/measure.test.ts` |

If any table above stops matching, this ADR is wrong.
