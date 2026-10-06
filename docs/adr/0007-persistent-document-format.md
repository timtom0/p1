# ADR 0007 — The persistent document format and the local save/load boundary

- **Status:** accepted
- **Date:** 2026-10-05
- **Depends on:** `docs/ARCHITECTURE.md` §1.1–§1.6, §3.7, §4.2, §4.4, §6;
  [ADR 0001](0001-text-editing-fence.md) (the text fence),
  [ADR 0002](0002-text-undo-composition.md) (browser-owned undo inside a session),
  [ADR 0003](0003-production-text-model.md) (canonical rich text),
  [ADR 0005](0005-shape-geometry-contract.md) (the geometry contract),
  [ADR 0006](0006-image-asset-contract.md) (asset identity and lifecycle)
- **Extends:** §6.1's `resources` sketch, which had the right shape and the wrong version
- **Blocks:** autosave, migrations, export, collaboration

## Context

The model is canonical, immutable, and exhaustively tested. Nothing has ever written it
down. That is a specific hazard rather than an obvious one: every layer above the model has
been able to prove correctness *within a session*, and a document that has never crossed a
process boundary has never been asked whether it can be reconstructed from its own bytes.

Three things had to be decided before any code, because each one quietly becomes the format
if you get it wrong:

1. **What is "the document"?** Not the rendered DOM, and not the model as it happens to be
   shaped in memory. The authored state, and nothing derived.
2. **How does an id behave across a reload?** The id generator keeps module-level counters
   (§3 below shows why that is a live collision bug), so "load a file, add an object" is a
   question the format has to answer, not an accident of session order.
3. **What happens when the file is bad?** A `.p1doc` on disk is untrusted input even when
   this machine wrote it, because it may have been edited, truncated, copied from another
   tool, or written by a future version.

## Decision

### 1. One module owns the format

```
model/serialize.ts    serialize(doc) -> PersistedDocument
                      parse(unknown) -> Document
```

Nothing else knows the format exists. `render/`, `editor/`, `viewport/` and `inspector/`
have no idea how a document is written, and the DOM's HTML is never involved in either
direction — **the renderer is not a serialization format**, and the model is not
reconstructed from markup.

`serialize` and `parse` are **inverses through one canonicaliser**, which is what makes
determinism a property rather than a hope:

- `parse` validates *and* rebuilds every object with its keys in a declared order.
- `serialize` routes the model through the same canonicaliser, then `JSON.stringify`s.

So the string that goes to disk is produced by the same code that decides what a valid
document is, and the two cannot drift. `JSON.stringify`'s key-order sensitivity stops being
a hazard, because nothing reaches it un-canonicalised.

### 2. The format

```jsonc
{
  "format": "p1doc",
  "formatVersion": 1,
  "id": "doc_1",
  "name": "Untitled",
  "pageSize": { "width": 210, "height": 297, "unit": "mm", "orientation": "portrait" },
  "assets": {
    "asset_1": {
      "kind": "image",
      "mime": "image/png",
      "intrinsicWidth": 40,
      "intrinsicHeight": 20,
      "data": { "inline": "data:image/png;base64,..." }
    }
  },
  "pages": [
    {
      "id": "page_1",
      "name": "1",
      "background": { "type": "solid", "color": "#ffffff" },
      "objects": [
        { "id": "node_1", "type": "shape", "name": "Rectangle",
          "transform": { "x": 24, "y": 32, "width": 120, "height": 68,
                         "rotation": 0, "scaleX": 1, "scaleY": 1 },
          "visible": true, "locked": false, "opacity": 1, "blendMode": "normal",
          "shape": { "kind": "rect", "cornerRadius": 8 },
          "fill": { "type": "solid", "color": "#4f7cff" },
          "stroke": { "paint": { "type": "solid", "color": "#1b3a8f" },
                      "width": 2, "align": "inside" } },
        { "id": "node_2", "type": "textFrame", "name": "Text",
          "transform": { "x": 24, "y": 130, "width": 300, "height": 160,
                         "rotation": 0, "scaleX": 1, "scaleY": 1 },
          "visible": true, "locked": false, "opacity": 1, "blendMode": "normal",
          "text": { "blocks": [
            { "kind": "paragraph", "align": "left",
              "runs": [ { "text": "Hello" },
                        { "text": " bold", "format": { "bold": true } } ] }
          ] },
          "style": { "fontSize": 16, "lineHeight": 1.5 } },
        { "id": "node_3", "type": "image", "name": "Image",
          "transform": { "x": 0, "y": 0, "width": 40, "height": 20,
                         "rotation": 0, "scaleX": 1, "scaleY": 1 },
          "visible": true, "locked": false, "opacity": 1, "blendMode": "normal",
          "asset": "asset_1", "fit": "contain" }
      ]
    }
  ],
  "extensions": {}
}
```

(`fit` on the image node is present because it was authored; a document with no `fit` has
no `fit` key on disk, because absent is a value — see §6.)

**What is present** is exactly `Document` — every authored field, in the model's own
shape. That is the design: the format *is* the model, and the canonicaliser's job is to
make it explicit and ordered rather than to reshape it.

**What is absent, and why** — each of these is a runtime fact that the model deliberately
does not hold (§4.2, §4.5):

| Absent | Why |
|---|---|
| DOM nodes, rendered HTML | The renderer is a projection (§2.3), not a format |
| Blob URLs, `File`, `Blob` | Not canonical, not comparable, session-scoped (ADR 0006 §1) |
| Selection, hover, handles, editor mode, gesture | UI state (§5) |
| `contenteditable` session state, browser undo | ADR 0002 — the browser's, and only meaningful while open |
| Measurement results | Rendering output (ADR 0004) |
| Asset load state (`idle`/`loading`/`loaded`/`error`) | A fact about *this* session (ADR 0006 §5) |
| Decoded `<img>` elements, resolved `src` | Runtime cache |
| Viewport scroll, zoom, pan, `pageGap` | §3.7: **the page gap is view state, never document state**, so it is not in the file even though the task listed it |
| `lastRenderMs`, view caches | Instrumentation |

**Determinism.** Arrays keep their order (objects are paint order, pages are document
order — both meaningful). Object keys are emitted in a declared order by the
canonicaliser. `assets` is a map, so its keys are emitted **sorted**, which makes two
documents with the same assets byte-identical regardless of insertion order — while
*distinct ids holding equal bytes are preserved*, because deduplication is not this
milestone's job (§4 of the task forbids it) and silently merging two records would change
two nodes' `asset` fields.

### 3. IDs

`createId` mints `prefix + '_' + n.toString(36)` from a **module-level counter that no
document seeds**. That is a live bug the moment a file exists:

> Load a document whose last node is `node_4`, then add an object. The counter is at 0 in a
> fresh tab, so the new node is **`node_1`** — a duplicate id, which `validateDocument`
> reports as "duplicate or cyclic node id" and which `mapNodesById` resolves to whichever
> it visits first.

Fixed by `reserveIds(ids)`, called by the load path with **every id in the document** —
nodes, pages, assets, the document itself. It parses only the numeric suffix of ids this
module minted, and ignores anything it does not recognise.

> This is the one place the codebase parses an id, and it is worth being precise about the
> difference: it is **not** deriving identity from an id. It is advancing a generator so the
> generator cannot re-mint a name that is in use. Identity still comes from the document.

| Id | Persistent identity? |
|---|---|
| `Document.id` | Yes |
| `Page.id` | Yes |
| `Node.id` (all three types) | Yes |
| `AssetId` | Yes — and it is the *only* identity an asset has |
| `data-oid` on an element | No. A renderer stamp for lookup (§2.3) |
| Element references, object URLs | No |

An `AssetId` is opaque: not derived from a filename, a URL, an array position, an object
name, or the bytes. Two imports of the same picture are two assets, and both survive.

### 4. Versioning

`format` (`"p1doc"`) then `formatVersion`, both at the top level.

| Situation | Behaviour |
|---|---|
| `format` is not `p1doc` | Refuse: "not a P1 document" |
| `formatVersion` **>** current | Refuse: "saved by a newer version of P1" — **never silently downgraded** |
| `formatVersion` **<** current | Refuse: "saved by an older version; this build has no migration" |
| Equal | Parse |

**No migrations exist, and the machinery is not built.** §14 forbids building more than the
minimum, and a migration framework with no migrations is speculative infrastructure. What
*is* built is the contract a migration will slot into: a `CURRENT_FORMAT_VERSION` constant, a
`parse` that dispatches on the version before validating anything else, and a refusal that
names the version in both directions. Adding a migration later means adding a table entry
and a transform function — not restructuring the parser.

**Unknown fields.** Two categories, and the difference matters:

| Kind | Policy | Why |
|---|---|---|
| **`extensions` on a node** — the one declared opaque bag | **Preserved verbatim** | A build that writes it knows it is opaque |
| **Undeclared keys** anywhere | **Refuse**, with the path | A newer build's new property must bump the version and be added to the schema. Silently dropping it would make a document *look* fine after a round trip and have quietly lost authored state |
| **Unknown object `type`** | **Refuse** | ADR 0003's rule: an unrecognised kind must not render as an empty object, and the model cannot represent it |
| **Unknown shape `kind`** | **Refuse** | Same, and ADR 0005's discriminated union has nowhere to put it |

`extensions` is **node-level only**, because that is the only place the model declares it.
A document- or page-level opaque bag would be inventing surface for a build that does not
exist yet, and it would have to be justified by a concrete writer rather than by the
possibility of one. So when §6.1's document-level `styles` and page-level `guides` and
`grid` arrive, they will be schema fields with a version bump, and an older build will
refuse the file — loudly, which is the intended behaviour.

> **The constraint this places on future milestones:** a new authored property is either a
> version bump plus a schema entry, or it goes in `extensions`. There is no third option,
> because a property that is neither will be rejected on load by an older build — loudly,
> which is the intended behaviour.

### 5. Validation

`parse` is total: it returns a `Document` or it throws a `DocumentParseError` carrying the
**path** (`pages[1].objects[3].transform.width`). It never returns a partially valid
document, and it never repairs.

Repair is not implemented, deliberately. A deterministic repair rule is easy to invent and
hard to justify — silently dropping one bad node from a three-hundred-object document is a
data-loss decision the user never made, and refusing tells them exactly which field to fix.
`assetProblems()` already exists for a *loader* that wants to warn about a document it
chose to accept; nothing chooses to accept one yet.

Checked, with a precise message each: the format marker and version; required fields and
their types; finite and non-negative geometry (`width >= 0`, `scaleX/Y !== 0`, finite
rotation); positive page dimensions and a known unit; **unique** ids across the document;
object types and shape kinds against the registry; asset records including a **positive**
intrinsic size (ADR 0006's invariant, re-checked at the boundary); every `ImageNode.asset`
resolving to a record in `assets`; and the rich-text invariants — at least one block, only
`paragraph` kinds, and `normalizeRichText` applied on the way in.

**The parser never executes document-provided code.** It reads plain JSON produced by
`JSON.parse`, matches against literal keys, and copies values. No `eval`, no `Function`, no
property access by computed path string. Note that the *test* helpers do evaluate fixture
sources — that is a test-only concern and lives in `tests/`, never in `src/`.

### 6. Canonicalisation and round-trip

The existing canonical invariants must survive a round trip. `parse` re-applies
`normalizeRichText`, so adjacent equal-format runs are merged again even if a hand-edited
file did not; `serialize` emits absent optional properties as **absent**, so they are not
randomly materialised; and object/asset order is preserved.

The requirement is stated against the project's own equality, not JSON strings:

> `parse(serialize(doc))` must equal `doc` by **canonical model equality**.

Which needs `documentsEqual` — and it is needed anyway for dirty state (§9), so it is one
function with two callers rather than two comparisons.

**The precondition, found while testing it.** `parse` re-applies `normalizeRichText`, so a
file carrying adjacent equal-format runs comes back canonical. That means the round trip is
the identity **only when `doc` is already canonical** — which the command funnel guarantees
for anything the user did, but not for a document assembled by hand or by a test. For a
non-canonical one, the first trip canonicalises and the second is the identity:

```
parse(serialize(d))       == normalizeRichText(d)   // may differ from d
parse(serialize(that))    == that                  // identity
```

Asserted rather than papered over. "Round trip changes the document" is the kind of thing
that gets excused once and then relied on, and the fix is a stated precondition rather than a
fudge in the comparator.

### 7. Dirty state

> **A document is dirty when its canonical authored state differs from the state that was
> last saved or loaded.**

Implemented by keeping the *saved document* (a `Document` reference) and comparing with
`documentsEqual`. Not by comparing serialized strings — a document with a 1 MB inline image
would re-encode 1.3 MB of base64 on every keystroke, and dirty state does not need to be
that literal.

Explicitly **not** part of dirty state: DOM differences, viewport scroll/zoom, selection,
measurement, asset load state, and whether a text session is open. A session that ends with
no change does not dirty the document, because the funnel drops no-op commands (§4.2).

`edit → save → edit → undo` is **clean**, because `History` restores the previous
`Document` and `documentsEqual` then reports equality. This is the same history — no second
stack, and dirty state is a *derived read*, not stored state that could disagree.

A loaded or new document establishes its baseline by setting the saved reference to itself.

### 8. Saving during a text session

> **Saving ends the active text session first.**

The browser owns the editable subtree while a session is open (ADR 0001), so the model's
text is stale for exactly as long as the session is. The alternatives were considered and
rejected:

| Option | Why not |
|---|---|
| Serialise the model as-is | Writes the text **before the user's typing** — silent data loss |
| Disable the Save button | A dead button the user cannot diagnose |
| Serialise from the editing DOM | Reaches past the model into the browser's DOM; the ADR 0001 fence exists to prevent exactly this |

`Editor.endTextEdit()` is already the canonical exit: it commits through the funnel as one
undo entry, un-fences the element, and leaves `select` mode. Calling it first is therefore
not a new mechanism — it is the same path <kbd>Esc</kbd> and clicking-away take. It does
**not** mutate the editing subtree by any new means.

### 9. Loading order

> **Loading a document never waits for an image to decode.**

`parse` is synchronous and pure. The document becomes authoritative first; the renderer
then projects it and assigns `src`; `load`/`error` events arrive afterwards and update
`data-asset-state`. Consequences:

- **A document with a broken image opens instantly**, showing a marked placeholder
  (ADR 0006 §5) rather than blocking.
- **Loading can only fail because the document is malformed** — never because an image
  failed. That is a real property worth having and worth stating.

The M6 `lastDocument` bug class is avoided by the ordering already established there:
`DocumentView` publishes the document **before** reconciling, so a renderer mid-projection
resolves assets against the document being projected.

### 10. The local file workflow

**Download and upload, deliberately, and nothing more.**

| Operation | Mechanism |
|---|---|
| Save | A Blob of the canonical JSON, `URL.createObjectURL`, a synthetic `<a download="…p1doc">` click |
| Open | `<input type="file" accept=".p1doc,application/json">` |

**The File System Access API is not used**, and the limitation is real:

- No save-in-place, so "update the file I already have" means downloading again.
- A second download of the same name is subject to the OS/browser renaming it
  (`Untitled (1).p1doc`), so the file on disk can silently become a *different* file.
- No directory handle, so a document's `{ external }` asset paths have nothing to resolve
  against — which is a second, independent reason `external` is unresolved.

Recorded as deferred, with its prerequisite: FSA needs a **document handle that survives
reload** to be worth having, and this build persists no handles and no session state
(§14 forbids it). Until then a download is the honest mechanism — it is the one thing that
works identically in every browser, and it is the only one Playwright can drive, so the
round-trip tests exercise the real path rather than a test-only one.

### 11. New / load replace history

`DocStore.reset(doc)` already clears history and commits without recording an entry. So
opening a file discards the undo stack — which is correct: history entries hold `Document`
snapshots, and mixing a new document into another document's undo stack would make undo
jump between documents.

## Limitations, carried forward deliberately

- **No migrations**, by design (§4). A file from any other version refuses.
- **No autosave**, so a crash loses the session.
- **No `{ external }` resolution.** The reference round-trips exactly and renders as a
  named error with a marked placeholder; nothing is ever fetched.
- **No asset garbage collection.** Orphaned records survive a round trip, as they survive
  undo (ADR 0006 §5).
- **No deduplication.** Two assets with equal bytes and different ids are both preserved.
- **No repair.** A malformed document is refused with a path, not partially accepted.
- **No `extensions` semantics.** Preserved verbatim and never interpreted — which is all a
  format can promise without a plugin model.
- **No document identity conflict detection.** Loading a file replaces the open document;
  there is no "this file differs from your last save" check.

---

## 12. Amendments from implementation

Recorded here rather than by editing the sections above, so the reasoning stays next to the
decision it revises. Each of these changed what was built, not just how it is written.

### 12.1 The format lives in `persist/`, not `model/`

§1 named `model/serialize.ts`. It is `src/persist/{format,serialize,deserialize}.ts`, because
the layer was already reserved in `eslint.config.js` and in the §8 tree, and because the
persisted form is a *projection of* the model rather than part of it. The practical benefit is
mechanical: `persist/` imports `model/` and `core/` only, so there is no DOM in scope and the
renderer cannot be asked to serialize even by accident.

The layering needed one amendment. `persist/` may not import `ui/`, and `ui/` could not import
`persist/` — which would have left a file gateway unable to reach the format, i.e. a reason to
reimplement serialization in the UI. §8.1 now allows exactly one edge, `ui/ → persist/`, and
only from the file boundary. The inverse stays closed, and if the *editor* ever needs to
serialize that is a signal the seam is wrong, not that the rule should widen.

### 12.2 `extensions` is node-level only

§4 originally listed the declared opaque bags as living "on the document, a page or a node",
and the format emitted `extensions` at the top level. `BaseNode` is the only place the model
declares one. A document-level bag would be inventing surface for a build that does not exist,
justified by the *possibility* of a writer rather than a concrete one. So §6.1's document-level
`styles` and page-level `guides`/`grid` will arrive as schema fields with a version bump, and
an older build will refuse the file — loudly, which is the point.

### 12.3 `parse` is the canonicaliser; the round trip needs a precondition

Stated in §6 as an amendment: the round trip is the identity only for an already-canonical
document. `serialize` copies faithfully and `parse` canonicalises, so a hand-assembled
non-canonical document becomes canonical on its first trip and is stable from then on. Asserted
rather than papered over.

### 12.4 Asset keys are sorted; object order is not

§2 said asset keys are sorted so insertion order cannot reach the file. True, and the
implementation adds the other half explicitly: **object order is never sorted**, because it is
paint order, and sorting it would change what the document means. Two tests hold the pair
together — one asserts assets are order-independent, one asserts a reordered object list is a
*different document*.

### 12.5 The parser never executes the document, and `documentsEqual` never throws

§5's "the parser never executes document-provided code" needed no change. §6's round trip needed
one more thing: the comparator must be **total** over the fields it reads. A missing asset
table — which ~30 M6-era injected fixtures had, and which nothing checked — threw a `TypeError`
from inside `refreshChrome`, on every pointer move, and broke ten browser tests across six
suites. Each failure named its own test; the cause was a missing key in a fixture string.

Three fixes, and the middle one is the general rule: the fixtures were repaired; `validateDocument`
now checks `assets` and dangling image references, because a *required* field with no invariant
is a field the model does not actually require; and `assetsEqual` treats an absent table as
*not equal* rather than throwing. **A function on the render path must degrade to a wrong-ish
answer, never to an exception.**

### 12.6 The file input has one owner

§10 described the Open button and a hidden input but not who listens. The first implementation
wrapped `input.click()` in a promise and resolved from its own one-shot listener. That puts the
input's `change` event behind a waiter, so a selection delivered by any other route — a drop
target, a paste handler, a test setting the files — was delivered to nobody and silently lost.
The symptom was "Open does nothing".

The fix is the pattern the image import had been using all along: **the button is a pure
trigger, and `app.ts` owns the `change` listener.** One pattern per application beats a locally
tidier one, and the lesson is recorded in the gateway's own doc comment.

### 12.7 The baseline is settled before the store changes

§7 describes the baseline as a stored `Document`. It does not say *when* it moves, and the
first implementation moved it after `store.reset(doc)` — which notifies subscribers
synchronously, and those subscribers render the dirty indicator. A freshly opened or newly
created document therefore rendered as *unsaved* until something else refreshed the chrome.

The rule, now stated in the code: **everything a subscriber can read is in place before the
store changes.** Unit tests cannot see this, because they never render.

### 12.8 `URL.revokeObjectURL` is deferred by a tick

Revoking an object URL in the same tick as the anchor click races the browser's read of the
blob and can cancel the download outright. The symptom would be a Save button that sometimes
does nothing, which is the hardest kind of bug to attribute.

### 12.9 The golden fixture is `-text` in `.gitattributes`

§13's hand-inspectable fixture is *byte-compared* against the serialiser's output, which is the
strongest available statement and the one that catches a field added to the canonicaliser
without being added to the parser. `core.autocrlf` rewrote the file's line endings on checkout
and broke three assertions with a diff consisting entirely of `\n` versus `\r\n`. These files
are compared as bytes, so the bytes are the file.

### 12.10 A mutation check, because a green suite proves nothing on its own

Not part of the format, but part of establishing it. `scripts/mutation-check.ps1` breaks twenty
behaviours one at a time and asserts the relevant suite goes red. It found three gaps in tests
that were passing:

- `canonicalTransform` written as `{ ...transform }`. The golden byte-identity test **cannot**
  catch it, because the parser hands it keys that are already in canonical order — so the
  canonical form was only half-pinned. Now covered by a test that reverses key order at every
  depth.
- A dirty-state test that passed **without the save having happened**: `save()` suspends at its
  `await`, and the first assertion ran before the baseline moved, so every subsequent assertion
  was about undo alone.
- Two mutations run through Vitest against `.spec.ts` files, which Vitest collects none of, so
  "no tests found" read as a pass.

### 12.11 Verification table, as built

| Claim | Where |
|---|---|
| The checked-in fixture is byte-identical to what this build writes | `tests/persist/golden-roundtrip.test.ts` |
| A hand-formatted file loads to the same document | same (`handwritten.p1doc`) |
| The round trip is the identity, for canonical documents | same |
| A non-canonical document canonicalises once, then is stable | same |
| Determinism: twice is identical; asset insertion order cannot reach the bytes | same |
| Serialisation is independent of key order **at every depth** | same |
| Sixty generated documents round-trip | same |
| Id reservation prevents post-load collisions, and a refusal moves no counter | same |
| Validation refuses 83 malformed shapes, each naming its path | `tests/persist/validation.test.ts` |
| `documentsEqual` matches canonical model equality, and every optional field can make it false | `src/model/document-equality.test.ts` |
| Dirty state across save / edit / undo, and its negative control | `tests/persist/session.test.ts`, `tests/editor/persistence.spec.ts` |
| A save during a text session writes the typed text, as one undo entry | same |
| A refusal changes nothing and says why | same |
| Byte identity across a real close-and-reopen, through the UI | same |
| Every shape kind, rotated/scaled geometry, rich text, an inline image | same |
| The reopened document's images reach `data-asset-state="loaded"` | same |
| No runtime state appears in a saved file | same |
| Fixture literals carry the fields the model requires | `tests/fixture-guards.test.ts` |
| Twenty mutations each turn a suite red | `scripts/mutation-check.ps1` |

If any row above stops matching, this ADR is wrong.
