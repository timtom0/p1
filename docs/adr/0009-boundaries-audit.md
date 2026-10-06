# ADR 0009 — The boundaries, audited

- **Status:** accepted
- **Date:** 2026-10-05
- **Depends on:** `docs/ARCHITECTURE.md` §1.3, §2.3, §3.3, §3.4, §4.2, §4.4, §5.4, §6;
  [ADR 0001](0001-text-editing-fence.md), [ADR 0003](0003-production-text-model.md),
  [ADR 0004](0004-measurement-boundary.md), [ADR 0006](0006-image-asset-contract.md),
  [ADR 0007](0007-persistent-document-format.md),
  [ADR 0008](0008-multi-selection-and-grouping.md)
- **Answers:** which of the six boundaries are actually load-bearing, which were false, and what
  now prevents them being violated by accident

## Context

M8 delivered a feature. M9 delivers none. The purpose was to stress-test the seams *before* the
next feature family, on the assumption that the most expensive defects are not in the features
but in the places two subsystems meet.

The brief named six boundaries:

```
Document model → renderer → browser layout → editor state → interaction state → persistence
```

and asked for each to be explicit, tested, and difficult to violate. This ADR records what the
audit found. It is deliberately shaped as **findings**, not as a description: the useful output
of an audit is the list of things that were wrong.

**Summary: four invariants were false, one subsystem was carrying a dead abstraction, and the
model's immutability — the assumption everything else rests on — turned out to be true and is
now proved rather than assumed.**

## 1. The interaction state machine, as it actually is

There is no state-machine framework, and this audit did not add one. `Editor` already has a
discriminated union for exactly this, and it is the right size: six states, one `pointerDown`
that chooses between them, one `pointerMove` that dispatches, and two exits.

| State | Entered by | Pointer owned | Selection changes | Command yet? | Reversible how |
|---|---|---|---|---|---|
| **idle** | `pointerUp`, `cancelGesture` | no | — | — | — |
| **pressed, not moved** | `pointerDown` on a body, before any `pointermove` | yes, captured | **immediately** for a body press; **deferred** for a shift-press on a selected object | no | `Escape`, blur, `pointercancel` |
| **move** | `pointerDown` on a body | yes | no | no — commands go into an open transaction on each `pointermove` | `abortTransaction` |
| **resize** | `pointerDown` on a handle | yes | no | no | `abortTransaction` |
| **rotate** | `pointerDown` on the rotation grip | yes | no | no | `abortTransaction` |
| **marquee** | `pointerDown` on the background | yes | **on release, and only if the pointer moved** | no — the preview is overlay geometry | trivially: nothing was changed |
| **draw** | `pointerDown` with a tool armed | yes | on release, to the new object | no — one `insert` on release | a refused creation disarms; otherwise the insert is one entry |
| **text session** | <kbd>Enter</kbd>, or a second click on a frame | the browser owns the subtree | intercepted: a press outside *ends the session and has no selection effect* | no — the session commits on exit | `Escape`; a deferred write replays on exit |

Four answers the brief asked for, which are not obvious from the code:

**Who owns the pointer.** `viewportRoot`, via `setPointerCapture` on `pointerdown`. One
exception, and it is load-bearing: a press inside a frame being edited does **not**
`preventDefault`, because there the browser's default is what places the caret.

**Does selection change immediately or at pointer-up.** Both, and the split is deliberate. A
plain press on a body changes the selection immediately, because that is what makes dragging a
selected object work. A shift-press on an *already selected* object is ambiguous — "remove it" or
"move everything" — and is deferred to pointer-up, applied only if the pointer never moved.

**What happens if the target is removed during the interaction.** The reachable version is
covered: `apply` treats a stale id as a no-op rather than throwing, `removeFromSelection` re-points
`primary` rather than clearing it, and `Delete` clears the selection rather than leaving ids that
resolve to nothing. A pointer *disappearing* mid-gesture is a different question, and §2 is about
it.

**What happens if the document changes externally.** `gesture.start` holds transforms captured at
press time, so a mid-gesture change is overwritten by the next `pointermove`. This is a
single-writer assumption, recorded in ADR 0001 and unchanged here; there is no second writer.

## 2. F1 — window blur did not end a gesture

**The invariant that was false:** *a gesture is ended by something other than the user finishing
it.*

`bindShortcuts` cleared the space-pan cursor on `blur` and did nothing else. An in-flight
move, resize, rotate, marquee or draw survived alt-tabbing: the object was left at a partial
position, the pointer capture was still held, and no further `pointermove` was acted on. The drag
was **dead while the editor still believed it was live** — observable, because <kbd>Esc</kbd>
*after* the blur still rolled it back.

This is the same class as the `pointercancel` gap M8 closed, one trigger over, and it is the
second time the same defect has appeared. That is the finding worth recording:

> **An editor that captures the pointer must end the gesture on every way the pointer can go
> away.** Chromium has three: `pointerup`, `pointercancel`, and the window losing focus. The
> first is the easy one.

**The fix:** `app.ts` listens for `window`'s `blur` and calls the existing
`Editor.cancelGesture()` — the same method <kbd>Esc</kbd> and `pointercancel` use, so the three
paths cannot drift. `cancelGesture` already had an idle guard, which is what makes a stray blur
harmless.

Proved before the fix, in `tests/editor/cancellation.spec.ts`: the document came back
byte-different after a blur, and four other tests across move, resize and marquee failed for the
same reason.

## 3. F2 — object identity had three owners

**The invariant that was false:** *one semantic attribute, one writer.*

`data-oid` and `data-type` were written by all three object renderers' `create()`, in two
different notations — `dataset.oid` in `shape.ts`, `dataset['oid']` in the other two. M8 had
already found the *symptom* of this class, when the overlay's marker shared the name `data-oid`
and `[data-oid="x"]` matched two elements in two layers. The remaining half was the three
renderers, and it was live: a new object type could spell it wrong or forget it, and nothing
would notice until a test failed for an unrelated reason.

**The fix:** the reconciler stamps both, in one place, and the renderers stop. The reconciler
already held both values — it looked the renderer up by `node.type` and keys the element map by
`node.id` — so this is its invariant to keep. `create()` became "make the element".

**The rule, as a constraint on future work:**

> - `data-oid` is **object identity**: exactly one element per object, across the whole document.
> - `data-type` is the node's `type`, for tests and devtools. The application never dispatches on
>   it; `BaseNode.type` is compared with `===` only inside `render/` (ADR 0003).
> - The overlay stamps `data-for`. A selector that matched both would make one object look like
>   two.
> - Identity is stamped on **creation only**. A `data-oid` that could change would mean the
>   reconciler's key and the DOM's identity had diverged.

Asserted as a *count*, not as "the selector works", because the failure mode is two matches: a
test reading `data-oid` while something is selected would get a plausible wrong answer instead of
an error. A second assertion covers the general form — no element may answer to both — so a
*new* collision is caught and not just the one that already happened.

## 4. F3 — `SelectionState.anchor` was a dead abstraction

**The question the brief asked:** does `anchor` represent a supported interaction semantic?

No. It was written as `null` in two places, read by nothing, and documented as *"Anchor for
shift-extend and alt-cycle"* — **neither of which exists**. Shift-extension is resolved by
`pendingDeselect` at pointer-up; `altKey` is `includeLocked` for hit testing, not a cycle. A
single unit test asserted it was `null`, which is the only kind of assertion a dead field can
support.

**Removed**, per the brief's instruction to remove rather than preserve. The replacement test
asserts the *shape* of the state — exactly `ids`, `primary`, `hover` — so the next dead field
cannot be added by the same route. A field whose comment describes unimplemented behaviour is
how a reader comes to rely on it.

### 4.1 The actual semantics

| Field | Meaning | Not |
|---|---|---|
| `ids` | a `Set` of selected node ids — **membership only, no order** | not an order, deliberately |
| `primary` | the id the inspector edits and <kbd>Enter</kbd> opens a session on | not the first outline; the overlay draws in *document* order |
| `hover` | the id with a hover outline, never also selected | not a selection |
| additive selection | shift on an unselected object adds; shift on a selected one removes, **deferred to pointer-up** | not a mode |
| locked inclusion | skipped by hit testing and by the marquee; reached by Alt-click | not unreachable |
| hidden inclusion | skipped by hit testing *and* by Alt; reached by the **marquee** | not unreachable either |

`primary` has **no DOM observable**, which is worth stating: the overlay cannot show it, so the
only way to observe it is <kbd>Enter</kbd>. A test that wants `primary` must use a text frame.

### 4.2 F4 — two different "cannot be selected", and they are not the same

Both `visible: false` and `locked: true` keep an object out of a plain click, and conflating them
is the mistake the audit had to undo in its own first draft.

- **Locked** is a *barrier*. Alt-click includes it, and the marquee honours it.
- **Hidden** is *not painted*. There is nothing at those pixels, so nothing reaches it — and
  **Alt does not either**, which was not obvious and is now asserted. A marquee does reach it,
  because drawing a box around something is unambiguous, and because M8's `visible` checkbox
  would otherwise be a one-way door.

The matrix in `tests/editor/interaction-matrix.spec.ts` declares the reachable states as data and
runs every interaction against every one, so adding a state without deciding what it does is a
red test rather than a silent gap.

## 5. F5 — an out-and-back gesture recorded an undo step that did nothing

**The invariant that was false:** *a gesture whose result equals its starting point is not an
action.*

`History.flush` decided this by re-applying the entry's command to its starting document and
comparing **by reference**. That is right for a command and wrong for a gesture: a drag
accumulates one `setTransform` per `pointermove`, each computed from the gesture's captured
start, so an out-and-back drag ends its sequence at the start — *to within the float error of
inverting the stack transform twice*, which is not zero.

The document then rendered identically and compared unequal, so the drag landed on the history and
<kbd>Ctrl+Z</kbd> undid nothing the user could see. This is the exact failure the no-op rule
exists to prevent, one level above where the rule sits.

**The fix:** after the cheap reference check fails, `flush` asks the canonical equality M7 built
for dirty state. It runs only on the path where something genuinely changed, and it cannot drop
a real entry — an entry whose result is canonically equal to its start has nothing to undo.

The alternative was a tolerance in the model. Rejected: the model is exact by design, and a
tolerance there would make `apply` stop being a total function of its inputs.

## 6. F6 — `beginBodyGrab` wrote the selection field directly

Two of its three branches called `setSelection`; one assigned `this.selection` in place.
`setSelection` is not only a setter — it is what redraws the overlay — so the inconsistency was a
live hazard rather than a style note. It had not bitten because `pointerDown` calls
`redrawOverlay()` two lines later, which is a coincidence of call order and not a property of the
method.

All three now go through `setSelection`. **Not mutation-covered**, and the reason is recorded in
`mutation-check.ps1`: both forms redraw once, so the change removes a coincidence rather than a
behaviour.

## 7. What the audit found to be *correct*

The point of an audit is as much what holds as what does not.

**Model immutability held, and is now proved rather than assumed.** `src/model/immutability.test.ts`
deep-freezes a document and runs **every command in the funnel** against it. Every module is an ES
module and so runs in strict mode, so a write to a frozen object throws — which makes one
`expect(...).not.toThrow()` a total check on the no-mutation invariant, covering the document, a
page's `objects` array, a node, a nested `transform`, a `fill`, the `assets` record and the asset
bytes at once.

The weaker alternative was a JSON snapshot comparison, and it is worth saying why it was not used:
it only sees mutations that *persist*, so a write followed by a compensating write is invisible;
it cannot see a mutation of a value the serialiser never reads; and it says nothing about
*sharing*. The sharing half is asserted separately by reference identity — an untouched node must
come back as the **same object**, because that is what lets the reconciler skip it, and it is what
makes "the renderer reads only what changed" true rather than aspirational.

**The reconciler's contract held.** Elements are keyed by node id and reused; reordering *moves*
them. Asserted with a token stashed on the element object, which survives an attribute rewrite and
dies with the node — a recreated element would lose focus, reset a text session and restart an
image decode, and no paint-order assertion would notice.

**The persistence boundary held.** Every piece of state classifies cleanly, and the dangerous
direction — authored state living only in the DOM — has nothing in it. A test asserts that the
saved bytes contain no `ids`, `primary`, `hover`, `anchor`, `gesture` or `moved` field, and
another that `data-asset-state` and no asset status is ever serialised.

**`primary` survives a restack, because `ids` is a `Set`.** Selection order and paint order are
independent, and M8's "the selection keeps its relative order" is only unambiguous because of it.

## 8. The persistence boundary, classified

| State | Class | What would break it |
|---|---|---|
| `Page.objects` order | **authored** | a `zIndex` beside the array |
| `transform`, `visible`, `locked`, `opacity`, `blendMode` | **authored** | reading them from the DOM |
| `text` | **authored** | trusting the DOM outside a session |
| intrinsic image size | **authored** | re-measuring on load, which would make the file machine-dependent |
| `data-asset-state` | **derived** | reading it back as if it were a property of the document |
| element `style` | **derived** | saving from the projection |
| `ids`, `primary`, `hover` | **editor-only** | a format field for any of them |
| gesture, `moved`, `pendingDeselect`, pointer capture | **editor-only** | — |
| the draw/marquee preview rect | **derived** | committing it before release |
| measured text size | **derived** | a bare number instead of a status union (ADR 0004) |
| caret, selection, IME state | **browser** | the browser owns the subtree inside a session |

## 9. Browser versus model

The rule — *authored geometry comes from the model; browser layout answers what cannot be derived
faithfully from the model* — survives the audit unchanged, and every user of it was checked:

| Question | Answered by | Why not the other |
|---|---|---|
| text measurement | **browser** (`clientWidth`/`scrollWidth`) | zoom- and transform-invariant, and hidden/stale is *refused* not zero |
| image intrinsic size | **model** (asset metadata from `decode()`) | re-measuring on load would make the file's rendering machine-dependent |
| transform → matrix | **model** (`localMatrix`) | CSS computes the same thing; deriving it twice would be a second source |
| hit testing | **model** | the browser answers about the browser: a hidden object has no pixels, a locked one is selectable, a line with no stroke has no ink |
| selection geometry | **model** | `transform` *is* the border box, so `offsetWidth` equals it and a stroke eats inward |
| visibility | **model** → `display: none` | and that is why a hidden object needs a marquee to reach |
| overflow | **browser** (`overflow: hidden` on the page) | page-level clipping is the one thing CSS does better |
| `contenteditable` state | **browser**, inside a session only | the fence is the whole point |

Nothing was found treating a measurement as authored, and nothing was found duplicating browser
layout without necessity.

## 10. The one thing this audit could not make testable

`pointercancel`'s *handler* is not mutation-covered, and neither is the `blur` handler's
correctness beyond the behaviour above. With the `preventDefault` cause removed, no cancel
occurs, so deleting the listener is unobservable from any test. That is recorded in
`mutation-check.ps1` next to the mutations rather than papered over with a mutation that would
only prove the mutation works.

Three further behaviours are deliberately unasserted for the same reason, and the reasons are
recorded there: `cancelGesture`'s idle guard (no present behaviour to assert), `beginBodyGrab`'s
routing (both forms redraw once), and `anchor`'s removal (a field written as `null` has no
behaviour to mutate).

## 11. What this milestone changed, in one list

1. `window`'s `blur` ends an in-flight gesture, through the same `cancelGesture` as Escape and
   `pointercancel`.
2. `History.flush` drops an entry whose result is canonically equal to its start.
3. The reconciler owns `data-oid` and `data-type`; the three renderers no longer write them.
4. `SelectionState.anchor` removed; the state's shape is now asserted.
5. `beginBodyGrab` routes every branch through `setSelection`.

And the rules that constrain future work:

> - An editor that captures the pointer must handle `pointerup`, `pointercancel` **and** window
>   `blur`. All three end the gesture through one method.
> - One semantic DOM attribute, one writer, stamped on creation only.
> - "Unreachable" is not one rule. Locked is a barrier with an Alt key; hidden is invisible and
>   needs a marquee.
> - A gesture is not an action if its result equals its start — and the comparison has to be
>   canonical, because a gesture accumulates floats.
