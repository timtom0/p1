# ADR 0001 — Text editing: fencing `contenteditable` against the document model

- **Status:** accepted (with caveats)
- **Date:** 2026-10-04
- **Closes:** §10.3 of `docs/ARCHITECTURE.md`
- **Supersedes:** nothing

## Context

The entire rendering architecture rests on HTML/CSS being the document renderer,
with the DOM a disposable projection of the model. Text is the one place where
that could fail: inside a `contenteditable` session the browser rewrites the DOM
as you type, so the DOM is briefly authoritative for one element while the model
is authoritative for everything else.

§2.7 proposed fencing this behind a `TextEditSession`, but that was a hypothesis.
This ADR records the experiment that tested it.

## The experiment

A throwaway harness (`spike.html` + `src/spike/`) driving the **real** renderer —
the same `DocumentView`, `textFrameRenderer` and reconciler the editor uses — so a
passing result says something about the real architecture. 28 browser tests plus
17 unit tests on the normalizer.

Nothing else in the editor was built to accommodate it, and no assumption was made
that the spike would succeed.

## Question

> Can the editor use native browser text editing through `contenteditable` while
> keeping the document model authoritative outside an explicit text-editing
> session?

## Answer: **Yes, with one real caveat.**

The fence holds. The model can remain authoritative for the whole document, with
exactly one element temporarily excluded. Everything the architecture depends on
survives.

### What was verified working

| Behaviour | Result |
|---|---|
| Model → DOM rendering | Exact before any session |
| Entering a session | One element becomes `contenteditable`; caret placed at end |
| Typing, backspace, delete | Native, correct |
| Multiline (Enter) | Works, with a caveat below |
| Selection + replacement | Native, correct |
| Caret movement | Native, survives re-render |
| Paste (plain + rich) | Plain text only; markup does not survive normalization |
| IME composition events | Fire correctly; uncommitted text never reaches the model |
| Undo/redo | Native in-session; **integration with editor undo unresolved** |
| Re-render *during* a session | Text, DOM *and caret* all survive — the fence's payoff |
| Model sync on exit | DOM committed to model; model resumes authority |
| Re-render after exit | Reads from model, no stale editor state |

### The fence mechanism that works

The renderer queries, per node, `ctx.isTextEditing(nodeId)`. When true it
**withholds that one element's content** and writes everything else normally. The
element itself still gets `left`/`top`/`width`/`opacity`/`display`, so external
changes to geometry or visibility apply *while* text is being edited — confirmed by
test.

Crucially the withholding is **content-scoped, not element-scoped**. That is what
makes it a fence rather than a special case.

## Findings

### 1. Enter inserts a literal `\n`, not a new element (important)

OBSERVED: in `plaintext-only` mode Chromium does **not** create a `<p>`/`<div>` for
Enter. It inserts `\n` *inside* the existing `<p>`.

Consequences:
- The `<p>`-per-block mapping in §1.5 does **not** survive an editing session. The
  normalizer must treat `\n` as a block boundary, which it does.
- `white-space: pre-wrap` on the content element is **load-bearing, not
  cosmetic**. Without it the line break vanishes and the model would disagree with
  what is displayed.

This is precisely the browser-specific detail the normalizer exists to absorb, and
it was invisible until a real browser ran it.

### 2. External model changes during a session are silently lost (the caveat)

OBSERVED: if the model changes for the frame being edited while a session is
active, the DOM does **not** update (correct — the user is typing), and on exit the
user's DOM text **overwrites** the external change. The external write is lost with
no conflict signal.

This is the sharpest limitation found. It is acceptable for a single-user,
single-writer local editor, but it is a genuine hole, and it is a hole in the
"model is authoritative" claim.

**Mitigation for M2:** treat a model change to an actively-edited frame as a
conflict to be surfaced, not silently overwritten — either by deferring the write
until session end, or by notifying the user. The spike does not implement this; it
records that it is required.

### 3. `plaintext-only` prevents most, not all, markup

Chromium supports `contenteditable="plaintext-only"`, which suppresses most
invented markup. Paste and programmatic insertion can still introduce `<b>`,
`<div>`, `<font>` and `&nbsp;`. The normalizer absorbs all of it. The normalizer
does **not** rely on `plaintext-only` being available.

### 4. An emptied paragraph collapses to zero height

OBSERVED: select-all + delete leaves `<p><br></p>`. The normalizer reads it as
empty (correct), but the renderer's re-projection emits a bare `<p></p>`, which has
no height in CSS. A real implementation must keep a minimum height or a `<br>` for
an empty paragraph. Not a fence problem, but only a browser test would catch it.

### 5. Session exit has an ordering requirement

Committing the model *before* clearing the fence flag re-renders while the
renderer still thinks the frame is being edited — so it withholds the content it
was just handed, and a stale `data-editing` marker survives. The order must be:

```
clear fence → write model → re-render
```

This was a real bug caught by the browser tests, and it is a rule about the session
boundary that the real implementation must follow.

### 6. `contenteditable` lifecycle needs one owner

The `data-editing` marker was being set in two places (session and renderer) and
leaked when they disagreed. Resolution: a new optional `afterUpdate` hook on
`ObjectRenderer` gives the renderer sole ownership, so every exit path — including
the no-change fast path — leaves the marker consistent.

## Decision

**Proceed.** The fenced `contenteditable` architecture is viable. The HTML/CSS
backbone claim survives contact with text, which was the single largest risk to it.

### Session boundary, precisely

```
ENTER   model → DOM normally; renderer withholds one element from then on
DURING  browser authoritative for that element ONLY;
        model authoritative for every other element and all other properties
EXIT    1. read DOM → RichText          (domToRichText)
        2. remove contenteditable + markers
        3. clear the fence
        4. write RichText to the model
        5. re-render from the model      (unwithheld)
```

### Synchronization rules

1. **The fence is content-scoped.** Geometry, visibility and opacity still render
   during a session.
2. **`update()` must be idempotent and early-return safe** — `afterUpdate` exists
   because it was not.
3. **Exit order is fixed**: clear fence → write model → render.
4. **The normalizer is the trust boundary.** Anything the browser can produce must
   survive `domToRichText` and produce an equal value on re-projection
   (`normalizeNewlines` + idempotence are unit-tested).
5. **A frame's content element is owned by the renderer**, except during a session.

### Limitations carried into M2/M3

- External writes to an actively-edited frame are lost (finding 2). Needs a conflict
  policy.
- Browser undo/redo inside a session uses the browser's own stack, which does not
  share history with the editor's command funnel. **Unresolved** — see below.
- Inline formatting is discarded. Extending the model to runs with styles means
  extending both directions of `rich-text-html.ts`, and the normalizer's
  format-stripping becomes format-preserving. Not validated by this spike.
- Empty paragraphs need explicit minimum height.
- No vertical alignment, columns, auto-size, overflow or linked frames. §1.5's full
  `textFrame` shape remains undesigned; this spike validated the *mechanism*, not
  the typography model.

## What the spike could NOT settle

**Undo/redo integration.** The browser's Ctrl+Z inside a `contenteditable` operates
on the DOM's native undo stack, which is separate from the editor's command funnel
(§4.4). Whether the two can be reconciled — by intercepting `beforeinput` for
history events, by reading `inputType === 'historyUndo'`, or by giving up native
undo in favour of model-level undo — was **not** determined. Driving native undo
from a test only exercises the browser, not our integration.

This is now the **next** architectural risk, replacing the one this ADR closes. It
should be resolved before M3 ships undo, and it interacts with M2's history work:
if native undo cannot be reconciled, the editor must prevent native undo during a
text session and own the history itself.

## Consequences for the architecture

- **§2.7** is promoted from hypothesis to validated mechanism.
- **`ObjectRenderer`** gains an optional `afterUpdate` hook (§2.3).
- **`RenderCtx`** gains an optional `isTextEditing` query (§2.3) — deliberately
  queried, not pushed, so renderers stay pure projections.
- **§1.5's `<p>`-per-block mapping** is corrected: it holds for rendering from the
  model but not inside a session. `white-space: pre-wrap` is required.
- **§10.3** is closed. Undo/redo becomes the new open risk.

## Costs

`rich-text-html.ts` lives in `render/` rather than `editor/text-edit/`, because both
directions of the conversion are about the HTML representation and `editor/` may
import `render/` but not the reverse. The ESLint boundary rule caught this
inversion on first run.