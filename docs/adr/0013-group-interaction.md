# ADR 0013 — Group interaction

**Status:** accepted, in progress (grouping/ungrouping and the transform contract landed; editor
interaction still to come)
**Date:** 2026-10-06
**Supersedes:** nothing. **Builds on:** ADR 0012 (the group model), ADR 0011 (the transform contract),
ADR 0011b (selection geometry).

---

## 1. What this milestone is for

M12 made groups legitimate persistent objects: recursive ownership, group-local child coordinates,
recursive transforms, persistence v2, a rendering traversal, and hit testing. It deliberately built
**no interaction** — no gesture, no group selection, no entry mode.

This milestone makes them usable: create a group from the selection, select and move one, reach its
children, ungroup, and undo all of it correctly.

The constraint that shapes every decision below: **the DOM stays flat.** A group is a coordinate
frame in the model, never a container element in the document. Nothing in this milestone may be
implemented by nesting elements or by letting a click bubble to an ancestor.

## 2. The transform contract, proved before anything was written

The brief asks for a proof before implementation. It was done first, numerically, in
`src/model/grouping-probe.test.ts`, and it changed the design.

### 2.1 Grouping is a *structural* edit — no coordinate conversion at all

The naive plan is to convert each child from page-local to group-local coordinates. That plan is
unnecessary, and the reason is a property of `worldMatrix`:

> For **any** `width`/`height`, the matrix of a transform with `x = 0`, `y = 0`, `rotation = 0`,
> `scaleX = scaleY = 1` is exactly the identity.

`worldMatrix` is `T(x + w/2, y + h/2) · R·S · T(-w/2, -h/2)`; with `x = y = 0` and `R·S = I` the
half-size translations cancel exactly, whatever the size. So if a new group is authored as the
**transparent frame**, then

```
worldTransformIn(child, transparentGroup) === child      // bit-for-bit, not to a tolerance
```

Grouping therefore moves nodes into a new array and changes **no transform at all**. The
strongest possible form of "grouping preserves rendered appearance" falls out of the algebra rather
than out of careful arithmetic: there is no arithmetic to get wrong.

The new group's `width`/`height` are set to the page size rather than to zero. That is not
children-bounds fitting — it is a deliberate choice documented in §4 — and it costs nothing,
because width/height do not affect the identity result.

### 2.2 Ungrouping promotes with the function that already exists

Ungrouping needs the other direction: group-local → page-local. `worldTransformIn(child, group)`
already computes exactly that, as a closed form. **M13 adds no geometry.** A general
matrix-decompose-then-rebuild helper (`decomposeFrame` in the probe) would also work, and is proved
to work, but shipping it would be a second geometry system for a conversion that has an existing
owner.

### 2.3 Why the decomposition is always expressible — and what it costs

`inverse(group) · child` has linear part

```
S(1/s)·R(−g)·R(c)·S(cx,cy)  =  R(c−g)·S(cx/s, cy/s)
```

where the middle step needs `S(1/s)` to be **uniform**, so that it commutes with `R(g)`. Two
consequences:

- A **non-uniform child scale survives**: `(2, 0.5)` under a group scaled by 1.5 becomes
  `(1.33…, 0.33…)`, not `(1.33…, 1.33…)`. The uniform ancestor divides both axes equally, which
  preserves the child's ratio.
- A **non-uniform *group* scale would produce a shear** that no `Transform2D` can represent. That is
  ADR 0012's restriction seen from the other end. It is not a stylistic rule about groups; it is
  the condition under which a child's frame remains expressible at all.

### 2.4 Two conventions that a plausible implementation gets wrong

Both were found by writing the assertion and having it fail for the wrong reason.

1. **`Mat2D`'s linear part is column-major.** `applyPoint` is `x' = a·x + c·y`, `y' = b·x + d·y`, so
   column 0 is `(a, b)` and column 1 is `(c, d)`. Reading column 0 as `(a, c)` reports a shear of
   1.41 on a matrix that is exactly `R(-0.1)·S(2, 0.5)`.
2. **`(e, f)` is not `transform.x`/`transform.y`.** `(e, f)` is where the box's *rotated, scaled
   top-left corner* lands; `x`/`y` position the box's **centre**. Recovering a frame from a matrix
   needs `centre = (e, f) + L·(w/2, h/2)`.

Neither is visible in a test that only compares whole matrices — which is why the proof decomposes
rather than comparing.

### 2.5 Precision, stated rather than assumed

`worldTransformIn` (a closed form) and `multiply(worldMatrix(g), worldMatrix(c))` (a product of four
factors) agree to ~1e-12 but are **not bit-identical** for a non-transparent group. The first draft
of that assertion used `toEqual` and failed. The consequence for testing: a browser assertion on
painted position needs a small tolerance, and demanding exact equality is only legitimate for
*grouping*, where no arithmetic happens at all.

## 3. Selection: a group is one selected node

`SelectionState` stays editor-only and gains **nothing**. A selected group is one entry in `ids`; a
selected child is one entry in `ids` even though it has a group ancestor. Containment is decided by
model ancestry (`locateNode`), never by a DOM relationship.

No persistent "group selection" property is introduced, and the removed `anchor` field is not
resurrected.

## 4. The group's authored frame

Grouping authors the group at the **transparent frame** (`x=0, y=0, rotation=0, scaleX=scaleY=1`)
with `width`/`height` set to the **page size**.

- Not children-bounds: ADR 0007 and the brief both forbid deriving a group's authored geometry from
  its members, and nothing here does. The frame is the page, which is a statement about where the
  group's coordinate space *is*, not about what it contains.
- Why the page size rather than zero: `width`/`height` are the local box, they are authored, and the
  inspector's existing transform infrastructure reads them. A group with a zero box would report
  `0 × 0` for a group that visibly contains content, which is the same class of untruth as a group
  whose frame is fitted.
- It is not load-bearing either way, because §2.1 shows width/height do not affect the identity.

## 5. Marquee

Grouped content marquees as **leaves**, exactly as it did in M12. A marquee never yields a group id
and never yields an ancestor together with a descendant, because it only ever yields leaves.

This keeps §8's ancestor/descendant invariant true by construction rather than by a filter, and it
defersthe "select the group I swept over" question rather than answering it badly. Deferred
explicitly in ADR 0012 §14.

## 6. Deferred, with reasons

- **Group resize.** Brief excludes it, and it is genuinely excluded: resizing a group means scaling
  children, which is multi-object resize and needs ADR 0011 §17's re-entry condition to be met.
- **Marqueeing a group as a unit.** Deferred with §5.
- **Scale handles on a group.** A group's scale must stay uniform; exposing `scaleX`/`scaleY` would
  invite the illegal value, and the inspector does not currently expose them.

## 7. Mutation-testing performance (required by the brief)

### 7.1 What was measured, and the honest correction to the premise

M12 reported a ~7 hour mutation cost. Measured at the start of M13:

| | |
|---|---|
| **One clean full run of 52 mutants** | **30.9 min**, 52/52 detected |
| The reported "7 hours" | the **cumulative** cost of ~6 runs while M12's mutations were being written |

So the harness was not pathologically slow; the **workflow** was. With no narrow scope, the only way
to check one mutant was to run all 52, so every small change cost half an hour and the suite was
avoided until it was unavoidable.

Per-mutant cost: ~3–4 s for a Vitest target, ~30–85 s for a Playwright target. 20 of 52 target a
browser suite. The three heaviest: `layers.spec.ts` (58 s), `selection-frame.spec.ts` (35 s),
`group-geometry.spec.ts` (33 s).

### 7.2 What changed, by what it actually bought

1. **`-Filter '<regex>'` on the label — the whole point.** A 2-mutant targeted run takes 13.4 s
   against ~1900 s: **~143× faster**. This is the change that makes mutation testing usable during
   development.
2. **Per-mutant timing**, printed inline and summarised as the five slowest. The cost had been a
   black box, so nobody could see that 20 of 52 targeted a browser.
3. **`npx` → the direct binary**, ~2.5–3 s per invocation, ~2.5 min over a full run. `npx` spawns a
   Node wrapper and re-resolves the package every call; the dependency is already installed.
4. **One shared dev server** for the whole run, ~3.4 s per browser mutant, ~1 min over a full run.
   `reuseExistingServer` already existed; nothing had ever left a server running, so each browser
   mutant spawned `vite` and waited for readiness.
5. **`-CheckSites` preflight.** Applies every substitution and runs no tests, finding stale sites in
   seconds. Added after two ~30 min runs were spent discovering one stale site at a time — see §7.4.
6. **`-NoBrowser`**, for iterating on model code where a browser suite cannot be the subject.

### 7.3 Measured and rejected: parallelism

`workers: 4` with `fullyParallel` gave **62.5 s and 55.5 s against 58.0 s serial** on the heaviest
suite. The cost is per-test browser setup, not scheduling, so workers contend for the same CPU and
the same dev server and hand back nothing.

An earlier draft added a `P1_PARALLEL` env switch to `playwright.config.ts` on the assumption that
it would help. It was **removed** rather than left in as unused configuration; the measurement now
sits in a comment next to `workers: 1`.

Parallel *mutants* are not merely unhelpful but **incorrect**: two concurrent mutants would both see
each other's edits, since each is applied to the working tree that the other's runner reads.

### 7.4 What did not change

The mutation set (52), the detected/undetected accounting, the "site not found is an error" rule,
and full reversion of every mutation whether it passed or failed. A narrow run reports how many
mutants it actually ran and **exits non-zero if that count is zero**, because "no mutants matched"
and "every mutant was detected" must never look the same.

### 7.5 The corpus was reconstructed — disclosed

Rewriting `mutation-check.ps1` at the start of M13 destroyed the inline mutation corpus, which was
untracked and therefore unrecoverable from git. All 52 entries were rebuilt; provenance and the
argument for why a *detected* reconstruction is still a verified mutation are recorded at the top
of `scripts/mutations.ps1`.

Nine entries failed on first run. Every one was a fault in the reconstruction, not in the tests, and
the pattern was consistent:

- **Five no-op substitutions.** Replacing a line with a comment changes nothing, so the mutant
  survived. The documented failure mode ("a mutation whose substitution is a no-op is worse than no
  mutation") reproduced itself immediately.
- **Two wrong owners.** `preventDefault` and the `blur` listener live in `src/ui/app.ts`, not in the
  editor; the out-and-back-drag guard lives in `History.close`, not in the editor's `moved` flag.
  Editing the wrong file produces a plausible substitution that tests nothing.
- **One asset check with two owners** — `assertAssetReferences` and `validateDocument` — so
  disabling either alone left the refusal intact. A genuine finding, recorded at the mutation site.
- **One missing site** — a two-line block whose text did not match exactly.

- **`-CheckSites` cannot detect a left-over mutation of its own entry.** Found by the full browser
  suite rather than by the runner: `src/editor/editor.ts` line 701 read
  `outlines.length > 0 ? outlines[0] : undefined` where M11's fix requires `=== 1`, which broke two
  rotation-grip tests. It was a mutation a killed run had applied and never reverted.

  `-CheckSites` reported all 52 substitutions applying, and could not have reported otherwise: the
  surviving mutation *was* that entry, retargeted to the other of the two similar-looking
  `outlines[...]` expressions, so its pattern still matched a clean file. A site check answers "does
  this pattern still match?" — it cannot answer "is this file in its original state?".

  The honest conclusion is that **the unit and browser suites, not `-CheckSites`, are the integrity
  check**, and the two together caught what neither the runner nor its preflight could. The recovery
  backup handles a kill; nothing short of a green suite can detect a corruption that happens to leave
  a valid pattern.

All 52 are now individually verified to be **detected**, with one deliberate exception below.

### 7.6 The one accepted survivor

| entry | target | status |
|---|---|---|
| `the dirty indicator is laid out with padding again (resizes every baseline)` | `src/ui/styles.css` | **accepted survivor** |

**Deliberately not fixed.** `tests/editor/persistence.spec.ts` asserts `data-dirty` and never the CSS,
and `src/ui/styles.css` says so in its own comment: the attribute is the machine-readable half and
"it is what a browser test asserts, so the visual treatment and the tested value cannot drift apart".
Both are written from one `DocumentSession.isDirty` read, so asserting the attribute *is* the contract;
CSS presentation is deliberately outside it. Adding a pixel assertion for the indicator would pin a
visual detail the project has already decided not to treat as tested behaviour, and the mutation's
label ("resizes every baseline") describes a visual-baseline suite rather than this one.

So the entry stays in the corpus as a known survivor, and the runner must continue to report it.
That is the honest outcome — "if X fails, that is an equally valid outcome" — rather than removing
the entry to make the percentage look better, which would hide a real boundary of the contract.

### 7.7 The survivor that was a real gap, and is now closed

`the browser may start its own selection during an editor gesture` also survived, and unlike the entry
above it **was** a coverage gap. Every selection test drags across *shapes*, and a shape has no text in
the DOM for the browser to select — so nothing could observe the contract, because there was nothing
to observe. A drag over an empty box starts no selection whether or not the default is prevented.

`tests/editor/native-selection.spec.ts` puts real text under the pointer and reads
`window.getSelection()` directly. It is verified in **both** directions, because a suppression-only
test cannot see the opposite mistake:

| production change | result |
|---|---|
| `preventDefault()` removed | **2 tests fail** — kills the corpus mutant |
| `preventDefault()` applied unconditionally (carve-out dropped) | **the carve-out test fails** — a double-click inside a live text session selects no word |

That second row is the one worth having. "Always prevent" is what a naive fix looks like, and it makes
text uneditable by double-click; asserting only the suppressed case would have shipped it.

### 7.8 Two holes in the harness, found by running it

Both were found by using the tool rather than trusting it, and both are recorded because the header's
claims were wrong.

- **A crash left mutations applied.** "Every mutation is reverted in a `finally`, so a crash cannot
  leave a mutated file behind" is false when the process dies outside PowerShell's control — a killed
  pipeline, a closed pipe. It happened: `this.baseline = current;` was deleted from
  `src/ui/persistence.ts` and `node.fit` left unconditional in `src/persist/deserialize.ts`. Both were
  noticed only because `-CheckSites` reported three entries that had started passing and then failed.
  There is now a backup before the first write and a restore on the next start, **tested** by planting
  a killed state and watching it recover — which is how a second bug surfaced, since `$file.BaseName`
  strips the extension and the restore silently did nothing.
- **An exception inside `Mutate` was swallowed into a passing run.** `Save-BeforeMutation` threw on
  every call, the `throw` propagated out, `$results` stayed empty, and the summary printed
  **"every mutation was detected (0 of 0)" and exited 0**. A run in which nothing executed is exactly
  the result the `-Filter` zero-guard exists to prevent, arriving by a different road. Thrown
  mutations are now recorded and the run exits non-zero.

- **A guard that could not fail, and was not noticed because nothing tested it.** PowerShell unrolls
  a **single**-element array when it leaves an `if` used as an expression, so `$selected` was a bare
  `PSCustomObject` and `.Count` on one is `$null` under Windows PowerShell 5.1. Every guard comparing
  against `$selected.Count` therefore evaluated as `1 -eq $null` — false — and did nothing. The
  symptom: `-NoBrowser -Filter <a browser entry>` skipped its only mutant and reported
  **"every mutation was detected (0 of 0)" with exit 0**. The guards were present, readable, and
  inert.

The general rule, and the fourth time this project has met it: **a check that cannot fail is not a
check, and a run that cannot prove it executed must not be able to report success.** Each of the four
guards above is now exercised by a deliberate negative control rather than trusted:

| guard | control | required result |
|---|---|---|
| `-Filter` matched nothing | `-Filter 'no-such-mutation'` | non-zero exit |
| `-NoBrowser` on browser-only | `-NoBrowser -Filter 'dirty indicator is laid out'` | non-zero exit |
| a mutation threw | the `Save-BeforeMutation` incident above | reported, non-zero exit |
| a real targeted run | `-Filter 'own selection during'` | detected, zero exit |

### 7.9 The M12 group fixture was destroyed and recovered — a second overwrite

M13 overwrote `tests/editor/group-fixtures.ts` with its own fixtures, destroying M12's `GROUPS` export
and breaking 26 passing browser tests. That was the **second** time this project lost a hand-maintained
artefact by overwriting a file in place (the first was the mutation corpus, §7.5).

It was recovered in full, not reconstructed:

1. The Playwright transform cache held a **source map** with `sourcesContent` — but only of the
   *replacement*, written after the fact.
2. The agent session store (`~/.local/share/opencode/opencode.db`, SQLite) held every M12 tool call:
   the original `write`, three successful `edit`s, and — the part that mattered most — **four
   PowerShell patches** the M12 session had applied to the file. Those patches are invisible in the
   file's own history and added the hidden group, the fourth `extra` argument on `group()`, and a
   fixture reposition that made every child paint inside the page.
3. Replaying write → edits → patches reproduced the file such that **all 26 M12 tests pass unchanged**.

Two lessons, both now rules:

- **Never overwrite a hand-maintained fixture.** M13's fixtures now live in
  `tests/editor/group-interaction-fixtures.ts`. The M12 file is a protected artefact.
- **A session log is a real backup.** For a file built by tool calls plus shell patches, the tool-call
  history is the only faithful record. `sqlite3 opencode.db "SELECT data FROM session_message WHERE data
  LIKE '%<filename>%'"` recovered a file no IDE history had.

### 7.10 A selected group drew no outline — `pageIdOf` cannot find groups

The group-outline branch used `pageIdOf(this.doc, id)`, which is built on `placementOnPage`, and that
traversal returns a placement **only for leaves**. For a group it answered `null`, which reads as "this
node is not on any page", so the loop `continue`d and the selected group drew nothing while every other
signal said it was selected.

This is ADR 0012 §2's failure mode arriving a second time, and it is the strongest argument yet for the
one-traversal rule: **a consumer that picks the wrong traversal goes inert with nothing failing.** The
fix is `locateNode(...).pageId`, the traversal that answers "where does this node live" *including* for
a group.

It took a probe to find, because every other signal was correct — the command applied, history said
"Undo Group", the page stack held the right elements, and nothing threw.

## 8. Status

**Delivered.** The `group`/`ungroup` commands through the existing funnel; grouping as a pure structural
array move (§2); contiguous-span grouping; child object identity preserved; transparent-group transform
preservation; moved-group ungroup composition via the existing `worldTransformIn`; nested groups;
deletion; group and child movement through the existing gesture machinery; the ancestor/descendant
selection invariant enforced in `setSelection`; editor group scope with entry, exit and alt-click; and
the group selection outline.

**Group entry**, decided in §"The interaction": a plain click selects the leaf and never an ancestor;
<kbd>Alt</kbd>+click selects the containing group (reusing the existing alt convention);
<kbd>double-click</kbd> enters a group; <kbd>Esc</kbd> leaves one level. <kbd>Ctrl</kbd>+<kbd>G</kbd>
and <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> group and ungroup.

**Deferred, with reasons.** Grouped marquee selection: a marquee still yields leaves only, so the
ancestor/descendant invariant holds by construction rather than by a filter. Group resize, group
auto-fit, group scale handles, a layer panel, and any group-specific inspector — all out of scope, and
the first would require ADR 0011 §17's re-entry condition.