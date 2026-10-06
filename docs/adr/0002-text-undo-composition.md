# ADR 0002 — Text undo: composition, not conversion

- **Status:** accepted
- **Date:** 2026-10-04
- **Closes:** §10.4 of `docs/ARCHITECTURE.md`
- **Depends on:** [ADR 0001](0001-text-editing-fence.md)
- **Blocks:** M2 (history), M3 (text)

## Context

ADR 0001 validated the `contenteditable` fence. It left one question open: the
browser's Ctrl+Z operates on the DOM's native undo stack, which is entirely
separate from the editor's command funnel (§4.4). Something has to give.

The failure mode is specific. A user edits a frame, exits, then presses undo. If
the two stacks do not know about each other, undo either does nothing visible or
reverts the wrong thing.

## Measurements

Rather than assume, the behaviour was probed in Chromium 153. The probes live in
`tests/spike/undo-probe.spec.ts` and are retained as executable documentation.

| # | Question | Measured answer |
|---|---|---|
| 1 | Does `beforeinput` fire for native undo? | Yes — `inputType: 'historyUndo'` |
| 2 | Is it cancelable? | **Yes**, `cancelable: true` |
| 3 | Does `input` also fire, after the DOM changes? | Yes, `inputType: 'historyUndo'`, `cancelable: false` |
| 4 | Does `preventDefault()` on it suppress the undo? | **Yes** — text was unchanged |
| 5 | Can the app trigger native undo itself? | **Yes** — `document.execCommand('undo')` returned `true` and undid |
| 6 | Does native redo survive leaving the session? | **No** — Ctrl+Shift+Z after re-entry did nothing |
| 7 | How does the browser group keystrokes? | Three keystrokes (`abc`) became **one** undo unit |
| 8 | What happens when the stack is exhausted? | `historyUndo` still fires, but the text does not change |

Findings 2, 4 and 5 are the important ones: the browser's undo is **fully
interceptable and fully drivable**. Both designs below are technically possible.
So the decision is not "can we", it is "should we".

## Options considered

### A. Coexistence with delegation *(chosen)*

The browser owns undo *within* a session. The editor owns everything else. When
the application-level undo action is invoked **while a session is active, it is
delegated to the browser**.

- Session exit commits the net text change as **one** command in the app's
  history, labelled "Edit text".
- Intra-session undo/redo is untouched and fully native.
- The app's undo affordance forwards via `execCommand('undo')` when in a session.

### B. Application-owned undo throughout

Record a text snapshot on every `input` event, `preventDefault()` all native
`historyUndo`, and restore from our own history. One stack; undo buttons and
labels work everywhere.

### C. Translate native history events into commands

Observe `historyUndo` in `beforeinput`, emit a command, re-render.

## Decision: **A. Coexistence with delegation.**

Browser undo stays native inside a text session. Application undo is native
everywhere else. The composition rule is one line:

> **While a text-editing session is active, the undo/redo action targets the
> session. Otherwise it targets the application history.**

### Why not B

Reimplementing undo means taking ownership of behaviour the browser already gets
right, and measurement says that behaviour is subtle:

- **Grouping is the browser's, not ours** (finding 7). Three keystrokes are one
  undo unit. Reimplementing means guessing where a user considers a step to end.
- **IME composition undo is genuinely hard.** ADR 0001 established that
  composition works natively; uncommitted text is held by the browser, and its
  undo semantics during composition are not something to reimplement casually.
- **Autocorrect, spellcheck replacement, drag-drop of text and swipe gestures
  all feed the same stack.** Any path we fail to model becomes a visible bug —
  "my undo skipped my autocorrect" — which is worse than two cooperating stacks.
- **Cost.** A snapshot per `input` is O(text length) per keystroke, and coalescing
  to avoid that reintroduces the grouping problem above.

The benefit of B is real but small: one stack, working undo buttons, accurate
labels. We get the important part of that benefit from delegation instead, without
touching the browser's semantics.

### Why not C

C observes the browser undoing but does not control *how far* it goes, so it
cannot produce a correct application-level entry — the app would have to record
"something was undone" without knowing what. It is strictly worse than A: all the
complexity of B, none of the control.

## Consequences

### The composition rule, concretely

```
Ctrl+Z, no session active   → application history.undo()
Ctrl+Z, session active      → session.undoNative()   (delegated)
Ctrl+Shift+Z, session       → session.redoNative()   (delegated)

session exit                → ONE command "Edit text" enters app history
```

Because the exit commit is a single command, undoing past a session boundary is
correct without any further work: the whole edit reverts as one step, which is
what users expect and what Figma and Illustrator do.

### New cost, and its mitigation

`execCommand('undo')` is deprecated. It is nonetheless the only way to ask the
browser to undo, and it works (finding 5). It is wrapped in
`TextSessionController.undoNative()` with a comment recording that this is the
entire reason, so it can be replaced if it ever disappears. If it does, the
fallback is simply that application-level undo is unavailable during a session —
a degraded feature, not a broken one.

### Behaviour users will notice, accepted deliberately

- **Native redo does not survive the session** (finding 6). Ctrl+Shift+Z after
  re-entering the frame does nothing. This is native behaviour and unavoidable
  without taking over the stack. Accepted.
- **Undo labels during a session** read "Edit text" only at session granularity,
  because the app does not know what the browser is about to undo. Accepted.
- **The browser's undo stack is exhausted silently** (finding 8). Delegated undo at
  an empty stack is a no-op. Accepted, and indistinguishable from correct behaviour.

### What this changes in the architecture

- §4.4 gains a rule: a transaction is the unit of history, and a text session is
  exactly one transaction.
- §3.3 (modes) gains `textEdit` as a mode whose undo/redo target differs. This is
  the first place the mode affects a command target rather than only input
  semantics — worth recording, because it will recur (e.g. a future drag-to-scrub).

## Risks, and what would change our mind

| Risk | Would change our mind if |
|---|---|
| `execCommand('undo')` is removed | Undo becomes unavailable during a session. Then option B becomes worth its cost, since delegation is gone. |
| In-app text undo buttons are needed (M3+) | If a UI *requires* one stack with per-keystroke labels, B's benefit becomes load-bearing rather than cosmetic. |
| Collaborative editing arrives | Two writers on one frame would each hold a divergent native stack. That would force B or a server-side history. Explicitly out of scope (§10.4 non-goals). |

None of these are currently true. A is the smallest mechanism that is correct
today and can be replaced later.

## Verification

`tests/editor/history.spec.ts` asserts the composition end to end in Chromium: native
undo inside a session, a single application entry after exit, undo reverting the whole
session, delegation from the toolbar button, and the post-boundary retarget.

`src/editor/text-edit/text-session-controller.test.ts` asserts the rule itself, with
`nativeUndo`/`nativeRedo` injected so the test depends on *our* routing rather than on
the browser's undocumented undo stack.

`tests/spike/undo-probe.spec.ts` retains the measurements above as executable
documentation.

If any of these break, this ADR is wrong.