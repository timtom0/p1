# ADR 0003 — The production text model

- **Status:** accepted
- **Date:** 2026-10-04
- **Depends on:** [ADR 0001](0001-text-editing-fence.md) (the fence),
  [ADR 0002](0002-text-undo-composition.md) (undo composition)
- **Amends:** ADR 0001 §"Decision" and finding 1 and finding 3 — see
  [Relationship to ADR 0001](#relationship-to-adr-0001)
- **Blocks:** M3 implementation

## Context

ADR 0001 validated the fence and left the typography model undesigned, deliberately:
it validated the *mechanism*, not the content model. M3 has to settle the content
model, and the first question is whether the fence as validated can carry it.

The answer was measured before anything was designed, because getting it wrong would
have invalidated the design rather than adjusted it.

## Measurements

### `plaintext-only` cannot produce inline formatting

Probed in Chromium 153. Both probes are retained:
`tests/spike/format-probe.spec.ts` (the `plaintext-only` measurements) and
`tests/spike/contenteditable-probe.spec.ts` (the `contenteditable="true"` ones).

| | `plaintext-only` | `contenteditable="true"` |
|---|---|---|
| `execCommand('bold')` returns | **`false`** | `true` |
| Ctrl+B produces markup | **nothing** | `<b>…</b>` |
| Ctrl+I | nothing | `<i>…</i>` |
| `queryCommandState('bold')` | always `false` | correct |
| Enter produces | `\n` inside the existing `<p>` | **a real `<p>` element** |
| Shift+Enter produces | `\n` inside the `<p>` | **`\n` inside the `<p>`** |
| Markup emitted | — | semantic tags, **not** `<span style>` |
| `justifyLeft`/`Center`/`Full` | — | work; emit `style="text-align:…"` |
| `underline`, `strikeThrough` | — | supported; emit `<u>`, `<strike>` |
| Enter inside bold markup | — | inherits the format: `<p><b><br></b></p><p><b>abcdef</b></p>` |

The first block is the finding that decides the design. **A `plaintext-only` fence
cannot be the editing surface for formatted text** — the browser will not emit
formatting at all. Not "emits it awkwardly": not at all. Any model with character
formatting would be reachable only by paste, or by rewriting the DOM under the caret
ourselves.

### What `contenteditable="true"` costs

It emits `<b>`, `<i>`, `<u>`, `<strike>`, `<div>`, `<font>`, `<span style>`,
`&nbsp;` and `<br>`, all of which the normalizer must absorb. Two observations make
that cheaper than it sounds:

1. **ADR 0001's normalizer already had to handle all of these.** Finding 3 recorded
   that `plaintext-only` "prevents most, *not all*, markup" and that paste and
   programmatic insertion still introduce `<b>`, `<div>`, `<font>` and `&nbsp;`. The
   format-preserving work was never optional; it was deferred.
2. **The DOM the browser produces is the DOM we produce.** Tags are semantic
   (`<b>`, not `<span style="font-weight:bold">`), nesting is canonical, and alignment
   arrives as `style="text-align:…"` — exactly what our renderer writes. The
   conversion is symmetric rather than merely invertible, which removes most of the
   round-trip bug surface.

### The switch also *improves* the paragraph mapping

ADR 0001 finding 1 recorded that `plaintext-only` inserts a literal `\n` for Enter,
so `\n` meant "new paragraph" and the normalizer had to guess. With
`contenteditable="true"`, Enter produces a real block element and `\n` inside a
paragraph means **soft break** (Shift+Enter). The ambiguity is gone, and `\n` becomes
a representation we can render for free (below).

## Decision

**Use `contenteditable="true"` and preserve formatting through a format-aware
normalizer.** `plaintext-only` is dropped for production text frames.

Rejected alternatives:

| Option | Why not |
|---|---|
| Keep `plaintext-only`, implement formatting by hand | `execCommand` fails outright in this mode, so this means rewriting the DOM under the caret — reimplementing the browser's editing model. ADR 0002 rejected exactly this trade for undo, on exactly this reasoning. |
| `plaintext-only` for plain frames, `true` for formatted ones | Two fences, two normalizer modes, two sets of edge cases, decided per frame by content. The worst of both. |
| Custom text engine | Abandons §9.1's case for the CSS backbone. Out of scope and not warranted. |

---

## The model

### Division of labour

The governing question for every property: **is this authored, or is it layout?**

> If the user authored it, it is in the model. If changing it changes pixels without
> the user authoring it, it belongs to CSS.

| In the model | Delegated to CSS |
|---|---|
| Paragraph structure and order | Line breaking and wrapping |
| Paragraph alignment | Line boxes, baselines, glyph positioning |
| Bold / italic / underline / strike, per run | Kerning, ligatures, font fallback |
| Soft breaks | Hyphenation, justification internals |
| Every character, **including whitespace** | Overflow and clipping geometry |
| Frame typography: family, size, line height, letter spacing, colour | Any OpenType feature |

The second column is not a punt; it is the reason the HTML/CSS backbone works. The
practical consequence is that **the model cannot derive auto-size**, because a fitted
box height needs measurement. That is why auto-size is deferred, and why §2.6's
measurement work is a prerequisite for it rather than an optional extra.

### Types

```ts
/** Character formatting. Absent means unformatted; `false` is not representable. */
export interface CharFormat {
  bold?: true;
  italic?: true;
  underline?: true;
  strike?: true;
}

export interface InlineRun {
  /** May contain '\n' for a soft break. All whitespace is significant. */
  text: string;
  /** Omitted entirely when unformatted — not `{}`. */
  format?: CharFormat;
}

export type ParagraphAlign = 'left' | 'center' | 'right' | 'justify';

export interface ParagraphBlock {
  kind: 'paragraph';
  /** Omitted means "inherit the CSS default", not "left". */
  align?: ParagraphAlign;
  runs: InlineRun[];
}

export interface RichText {
  blocks: ParagraphBlock[];
}

/** Frame-level typography. Every field is optional and omitted means "unset". */
export interface TextStyle {
  /** A CSS font stack, e.g. `'Georgia', serif`. */
  fontFamily?: string;
  /** Document px — the internal unit (§1.1). */
  fontSize?: number;
  /** Unitless multiplier. `1.2` = 120%. A length would break when size changes. */
  lineHeight?: number;
  /** In em, so it scales with font size. Omitted means CSS `normal`. */
  letterSpacing?: number;
  /** Any CSS colour string. */
  color?: string;
}

export interface TextFrameNode extends BaseNode {
  type: 'textFrame';
  text: RichText;
  style?: TextStyle;
}
```

### Decisions inside that shape, and why

**`format` is absent, not empty.** One representation of "not bold" makes equality
total and keeps the common case small.

**No `false`.** A flag is `true` or absent. Two encodings of the same visual text must
not exist, or history comparison and diffing would churn on documents that render
identically.

**Adjacent runs with equal formats are merged.** The model is in **canonical form**:
every visual text has exactly one run-sequence. Without this, `a<b>b</b>` and `<b>ab</b>`
would be different values for the same page. This is the most important invariant in
the design and it is enforced in the normalizer and tested.

**Character formatting is exactly four flags.** They are the four `execCommand`
emits as semantic tags, which is what makes the normalizer's mapping exhaustive and
testable rather than open-ended. Inline colour and size are the next increment and
extend `CharFormat` additively; the normalizer already discards them, so extending is
a known small change rather than a redesign.

**Alignment is per-paragraph, with no frame-level default.** One source of truth per
property. The alternative — a frame default plus per-paragraph overrides — creates a
"which one wins" question that every reader and writer would have to answer. A frame
aligned left means every paragraph is left.

**Line height and letter spacing are relative.** `lineHeight: 1.2` and
`letterSpacing: 0.02` (em) survive a font-size change; `19.2px` and `0.32px` do not.
This is what every design tool does and it is the difference between a usable
property and a trap.

**Only one block kind, but the discriminator stays.** §1.5's publishing scope includes
headings and lists. Keeping `kind` preserves the extension point so adding one is an
additive change rather than a refactor of every `block.runs` site. Crucially, the
conversion must **throw on an unrecognised kind** — the current `continue` silently
renders an empty frame, which is worse than refusing. The normalizer maps unknown
block-ish elements to `paragraph`, preserving their text.

### Whitespace and line breaks

- **All whitespace is content.** `white-space: pre-wrap` is load-bearing (ADR 0001
  finding 1) and stays. The normalizer must **not** trim run text — the current
  `line.trim()` silently destroys a trailing space the user typed.
- **A paragraph boundary is a block, never a character.**
- **A soft break is `\n` inside run text.**
- **Re-projection emits no `<br>`.** `pre-wrap` renders `\n` natively, so `<br>` is
  redundant in the render direction. Normalizing `<br>` → `\n` makes the two
  representations converge on one model value, which is exactly the round-trip
  property ADR 0001's sync rule 4 demands.

This is the one genuinely elegant consequence of the design: `<br>` appears **only**
in the DOM the browser writes, is removed on the way in, and is never needed on the
way out. One direction is many-to-one, so there is no doubling class of bug.

### Empty paragraphs and empty frames

- **An empty frame is one paragraph with one run of `''`.** Never `blocks: []`.
  So `blocks.length >= 1` is an invariant, and "is empty" is a helper, not a branch
  every reader has to write.
- **An empty paragraph may carry a format.** `runs: [{ text: '', format: { bold: true } }]`
  is how "bold the caret, then type" is represented. This is not a corner case: the
  browser produces exactly this (`<p><b><br></b></p>` when Enter is pressed inside
  bold text, measured above).
- **Empty paragraphs need a minimum height in CSS.** We emit `<p></p>` with no `<br>`,
  which has zero height. `.p1-text-content p { min-height: 1em }` fixes it. This is
  ADR 0001 finding 4, and it matters *more* now precisely because we stopped emitting
  the browser's `<br>`.

### Overflow

`overflow: visible` on the text content. Overflowing text stays visible so the user can
see they have overflowed; the page's own `overflow: hidden` clips at the page
boundary. Hit testing is unaffected because it is model-based — the model box is the
truth, so text painted outside its frame is not selectable there. Auto-grow and
overflow indicators are deferred.

### Vertical alignment: deliberately not in M3

It looks like it belongs — text vertically centred in a frame is ordinary page layout.
It is excluded because implementing it means making `.p1-text-frame` a flex container
so the content box is centred by the browser. That changes the content element's box,
which changes the caret's coordinate space relative to the element, which puts the
fence (ADR 0001's validated mechanism) back under test for a feature that is not
otherwise load-bearing. It needs its own spike, and it is recorded here as deferred
rather than silently omitted.

---

## Conversion

### Model → HTML

```
RichText
 └─ block ──▶ <p style="text-align:…">        (style only when align is set)
      └─ run ──▶ wrap text in <b> <i> <u> <strike> as the format requires
           └─ text node (may contain \n)
```

Nesting order is canonical: **bold outermost, then italic, underline, strike.** The
normalizer's output is forced into the same order, so a document has one HTML form as
well as one model form.

### HTML → model

A **stack-based walker** replacing the current flat string extractor. This is the
change that makes format preservation possible at all — the old `extractText` produces
a single string and has nowhere to put a format.

| DOM | Model |
|---|---|
| `<b>` `<strong>` | `bold` |
| `<i>` `<em>` `<cite>` `<dfn>` `<var>` | `italic` |
| `<u>` `<ins>` | `underline` |
| `<s>` `<strike>` `<del>` | `strike` |
| `style="font-weight:bold\|[6-9]00"` | `bold` |
| `style="font-style:italic\|oblique"` | `italic` |
| `style="text-decoration:…underline…"` | `underline` |
| `style="text-decoration:…line-through…"` | `strike` |
| `<font weight>` / `<font style>` | as above |
| `<font face>`, `<font color>`, `<span style="color:…">` | **discarded** — frame-level for M3 |
| `<p>` `<div>` `<li>` `<h1>`–`<h6>` `<pre>` | paragraph boundary |
| `<br>` | `\n` |
| **trailing** `<br>` (last child of a block) | **discarded** — see below |
| `\n` in a text node | `\n` |
| `<font>` `<span>` `<b>` … anything else | transparent (format stack unchanged) |
| `<script>` `<style>` `<meta>` `<link>` | dropped |

Post-processing, in order: fold `\r\n`/`\r` and U+00A0; merge adjacent runs with equal
format; guarantee ≥1 run per block; guarantee ≥1 block.

Discarded formatting is a **deliberate, tested** loss, not an accident. Making it
explicit is what keeps it a one-line extension when inline colour arrives.

### Three cases the walker has to get right

All three were wrong in the first implementation. They are not obvious, and each was
caught by a test rather than by reading the code.

**1. A trailing `<br>` is a placeholder, not a soft break.** Chromium keeps one at the
end of a block so the caret's line stays visible, and leaves `<p><br></p>` when a line
is emptied. Read as a break, an emptied frame's model value becomes `"\n"` — which
re-projects as a permanent blank line, so the frame stops being empty and stops
round-tripping. **Position decides, not tag**: `<p>a<br>b</p>` is a real soft break and
must survive. Caught by the pre-existing spike test `emptying the frame during editing
still leaves a valid model`, which had been passing against the spike's normalizer.

**2. "Empty paragraph" and "no paragraph" look identical in a run list.** `<p></p>` is
a paragraph — it is what the browser leaves when a line is emptied — so the walker has
to emit it. Leaving a block *forces* a flush; entering one does not, or the wrapper
would contribute an empty paragraph of its own.

**3. A block that contains blocks is a container, not a paragraph.** `<div><p>One</p>
<p>Two</p></div>` contributes no text of its own. Treating it as a paragraph emitted
phantom empty paragraphs before and after, turning two real paragraphs into four.

### Round-trip property

> For every model value `m`, `domToRichText(parse(richTextToHtml(m))) === m`.

Not a fuzzy assertion — exact structural equality. This is the single strongest
statement the design can make, and it is what catches a whole class of normalizer
bug. It is tested over a corpus including empty frames, whitespace-only frames,
multi-paragraph frames, soft breaks, every format flag, every combination of
alignment, and formatting adjacent to whitespace.

**One documented exception.** `{ text: '', format: { bold: true } }` — an empty
formatted paragraph — does not survive, because it has no characters for the walker to
attach a format to. Acceptable: the browser tracks a pending format *during* a session,
so the only way to reach that state is to exit with an empty selection, where the format
has nothing to apply to anyway. The model still *accepts* the value (§"Empty
paragraphs"), it just does not round-trip it.

**One guard on the corpus itself.** A test that asserts the corpus would fail on
flattened text alone, so the round-trip cases cannot quietly collapse into "it is just
a string after all".

### A consequence of this design, stated plainly

The meaning of `\n` inside a `<p>` is **mode-dependent**:

| Mode | Enter produces | So `\n` means |
|---|---|---|
| `plaintext-only` | a literal `\n` in the same `<p>` | a paragraph break |
| `contenteditable="true"` | a real `<p>` | a soft break |

The model has one meaning, and it is the production one. The text-editing spike pins
`plaintext-only` explicitly because it *measures* that mode, so its committed baseline
differs from its pre-M3 recording by one paragraph's margin. Making the normalizer
mode-aware would mean a second conversion path for a mode no product code uses — which
is the second rendering/mutation architecture this project does not get to have.

---

## Editing, history, and the model

### The session

`TextEditSession`'s mechanism is unchanged. One change: `contenteditable` becomes
`"true"`. Everything ADR 0001 established still holds — the fence is content-scoped,
the exit order is fixed, `afterUpdate` owns the marker.

New capability on the controller: **read-only formatting state** via
`queryCommandState`, so a toolbar can enable Bold correctly. It is a query, so it
belongs with the other session-scoped state.

### Formatting has two distinct operations, deliberately

| Operation | When | Mechanism | History |
|---|---|---|---|
| `setFrameTypography(style)` | frame selected, no session needed | model command | one entry, immediately |
| `applyInlineFormat(flags)` | inside a session | `execCommand`, browser owns it | part of the session's single entry |

Applied outside a session, `applyInlineFormat` targets every run in the frame — so
"select a frame, press bold" is well defined rather than a no-op.

This is ADR 0002's composition pattern applied to formatting, and it falls out for the
same reason: **a text session is a transaction.** What happens inside it becomes one
history entry, so nothing needs special-casing to keep undo usable.

### Text changes and history

Unchanged from M2 and ADR 0002: **one `setText` command, one history entry, per session
exit.**

`setText` keeps a whole-value payload. A diff or patch representation is the obvious
improvement and is **rejected**: the browser hands us the entire content at exit
anyway, so a diff would be computed from nothing rather than from an input. For a
10 000-character frame and a 200-entry history the snapshots total roughly 2 MB, which
is acceptable; revisit when measurement, not guesswork, says otherwise.

One change to `setText`: its no-op comparison must be **format-aware**. `{text:'abc',
format:{bold:true}}` is not equal to `{text:'abc'}`.

### External writes during a session

Policy unchanged from M2 and ADR 0001 finding 2: **the session wins, the external write
is replayed after exit**, as its own history entry, in order.

Extended in one respect: the deferral hook now covers the frame's `style` as well as
its `text`, so a font-size change from the inspector while a frame is being edited is
deferred rather than rendered mid-edit. The two are independent properties, so each
replays independently. No new policy is needed — the M2 rule generalises without
change.

## Relationship to ADR 0001

ADR 0001's **fence is unchanged and still validated**. What changes is its choice of
`plaintext-only` for that fence. Finding by finding:

| ADR 0001 | Status |
|---|---|
| The fence mechanism (content-scoped withholding, re-render preserves caret) | **Unchanged. Still the mechanism.** |
| 1 — `plaintext-only` inserts `\n` for Enter | **Superseded.** Enter now produces real `<p>` elements. `\n` survives as the *soft break* representation, and `pre-wrap` remains load-bearing. |
| 2 — external writes silently lost | **Unchanged.** Still true; now mitigated by deferral rather than acknowledged as a hole. |
| 3 — `plaintext-only` prevents most, not all, markup | **Moot.** We no longer use it. The normalizer must handle the tags the browser now emits deliberately, which it would have had to handle anyway. |
| 4 — emptied paragraph collapses to zero height | **Unchanged, and more load-bearing** — we emit `<p></p>` with no `<br>`, so `min-height` in CSS is now required. |
| 5 — exit ordering (`clear fence → write model → render`) | **Unchanged.** |
| 6 — `afterUpdate` owns the editing marker | **Unchanged.** |

The honest summary: ADR 0001's *risk* was "can text be fenced at all", and it can. The
`plaintext-only` detail was chosen to reduce normalizer surface, and it turns out to
cost more than it saves, because it removes the browser's formatting entirely.

## What this design does not include

Recorded so the omissions are decisions rather than oversights:

- **Vertical alignment** — needs a flex container on the frame; puts the fence back
  under test. Needs its own spike.
- **Padding** — box-model, not typography. Arrives with frame geometry work.
- **Headings and lists** — extension point preserved (`kind` stays, unknown kinds throw,
  the normalizer maps unknown block elements to `paragraph`), no kind implemented.
- **Inline colour and size in `CharFormat`** — the next increment; additive.
- **Columns, auto-size, linked frames, text-on-path, tables** — out of scope. Auto-size
  additionally depends on text measurement (§2.6), not on this model.
- **OpenType features** — delegated to CSS entirely; no model representation.

## Verification

| Claim | Where |
|---|---|
| `plaintext-only` produces no formatting; `contenteditable="true"` does | `tests/spike/format-probe.spec.ts`, `tests/spike/contenteditable-probe.spec.ts` — both **assert** the tables above, rather than only logging them |
| Round trip is exact (one documented exception) | `src/render/rich-text-html.test.ts` |
| Canonical form (adjacent equal-format runs merge) | `src/render/rich-text-html.test.ts` |
| Whitespace survives | same |
| Trailing `<br>` is a placeholder; `<p>a<br>b</p>` is not | same, six cases |
| Rendering, editing, formatting, overflow, empty paragraph height | `tests/editor/text.spec.ts` |
| Typography, overflow and blank-line pixels | `tests/visual/typography.spec.ts` baselines |
| History behaviour is unchanged | `tests/editor/history.spec.ts` |

If the round-trip property fails, this design is wrong.
