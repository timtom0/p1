# ADR 0006 — Images: the asset and geometry contract

- **Status:** accepted
- **Date:** 2026-10-05
- **Depends on:** `docs/ARCHITECTURE.md` §1.5, §1.6, §2.3, §2.6, §2.8, §3.4, §3.5, §6.1;
  [ADR 0004](0004-measurement-boundary.md) (measurement is layout, never a model value),
  [ADR 0005](0005-shape-geometry-contract.md) (the geometry contract and the registry discipline)
- **Extends:** §6.1's `.p1doc` `resources` sketch, which already had the right shape
- **Blocks:** crop/clip, asset management UI, export, persistence of assets

## Context

An image is the first object whose *content* the model does not own. Every other node is
pure geometry plus small authored values; an image adds bytes, an identity for those
bytes, and a lifecycle — decoded, not yet decoded, failed.

Three questions had to be answered before any code, because each one quietly becomes the
model if you get it wrong:

1. **What does a reference to an image mean?** If the model holds anything session-scoped
   (a blob URL, a `File`), the document stops being reproducible and every consumer —
   history, diffing, serialization — has to special-case it.
2. **Where does an image's intrinsic size come from?** If it comes from the DOM, then
   placing an image needs a browser round-trip and a layout read, which is ADR 0004's
   measurement contract applied to something the model should already know.
3. **What happens when the asset cannot be resolved?** Measured (PROBE Z): a failed image
   keeps its full authored box, keeps its full hit region, and reports `complete === true`.
   So a broken image is *indistinguishable from a working one* unless the application says
   otherwise — and "otherwise" has to be a designed state, not an absence.

The answers below are all measured. `tests/spike/image-probe.spec.ts` is the executable
record (PROBE W–AC).

## Measurements

### Intrinsic size is knowable at import time, and is not layout

| Question | Answer |
|---|---|
| Before `src` is set | `complete: true`, `naturalWidth/Height: 0`, **`offsetWidth/Height` already the authored box** |
| Synchronously after `src = …` | `complete: false`, natural `0×0` |
| After load | natural `40×20`, `offsetWidth/Height` still `200×100` |
| `await img.decode()` on a **detached** image | **`[60, 30]`** — intrinsic size without the image ever entering the document |
| `createImageBitmap(blob)` | `[60, 30]`, same |
| `await img.decode()` on non-image data | **rejects with `EncodingError`** — it does not resolve to `0×0` |

The last row is the load-bearing one. `decode()` **distinguishes "has no size" from "is not
an image"**, which every layout API fails to do. So an asset that cannot be decoded never
becomes an asset with size `0×0`, and §4's prohibition is satisfied *at import* rather
than by a later validity check.

And the first row is the geometry answer: **the authored box is present and correct
whether or not the image loaded.** Image geometry is authored state, exactly as ADR 0004
requires, and needs no measurement at all.

### `object-fit` changes the paint and nothing else

A `40×20` image in a `200×200` box, across all five `object-fit` values:

| fit | `offsetWidth/Height` | `offsetWidth/Height` of the `<img>` | `elementFromPoint` at the box corner |
|---|---|---|---|
| `fill` | 200×200 | 200×200 | the `<img>` |
| `contain` | 200×200 | 200×200 | the `<img>` |
| `cover` | 200×200 | 200×200 | the `<img>` |
| `none` | 200×200 | 200×200 | the `<img>` |
| `scale-down` | 200×200 | 200×200 | the `<img>` |

Identical in every column. `object-fit` is a *content placement* property: it changes which
pixels are painted inside the box, and does not move the box or the hit region. Under
`contain` the corner is letterboxed and unpainted, and the browser still reports a hit
there.

### A failed image is indistinguishable from a working one, except that it fails

| state | `complete` | `natural` | `offset` | `elementFromPoint` at centre |
|---|---|---|---|---|
| no `src` | **`true`** | `0×0` | 200×100 | the `<img>` |
| unreachable URL | **`true`** | `0×0` | 200×100 | the `<img>` |
| non-image data | **`true`** | `0×0` | 200×100 | the `<img>` |
| valid image | `true` | 40×20 | 200×100 | the `<img>` |

> **`complete` is not a success test.** It is `true` for all four rows. The only signal
> that distinguishes them is `naturalWidth > 0`.

This is why the asset's load state is a designed union (§4) rather than a boolean, and why
a missing asset must be made *visible*: nothing in the box or the hit region will say so.

### Transparency is not honoured by hit testing — the browser is not alpha-aware

A `40×20` PNG with its left half fully transparent, in a `200×200` box:

| Probe point | `elementFromPoint` |
|---|---|
| transparent half | **the `<img>`** |
| opaque half | the `<img>` |
| 4px outside the box | the host behind |

**A fully transparent pixel is a hit.** Chromium hit-tests the image's *box*, not its
pixels, exactly as it does for `border-radius: 50%` (ADR 0005 PROBE O).

> **This corrects a wrong earlier reading.** Round 1 of this probe used a hand-written
> base64 PNG that did not decode, and therefore measured the *failure* row above — where a
> failed image is hit-testable across its whole box — and concluded the browser was
> alpha-aware. The conclusion was an artefact of a broken fixture. With a valid image the
> answer is the opposite, and it is the answer that matters: **the editor's box predicate
> and Chromium agree on images exactly as they do on shapes.**

Alpha-aware hit testing is therefore **rejected on evidence**, not deferred by omission:
implementing it would make the editor *disagree* with the browser, inverting the property
every other object type has.

### An `<img>` cannot render a failure marker

Appending a child to an `<img>` keeps it in the DOM (`childCount: 1`,
`textContent: "missing"`), but an `<img>` is a **replaced element**: it has no content box
in which descendants render, so nothing paints. A bare `<img>` therefore has nowhere to put
a "missing image" state.

Measured equivalence of the two projections, for the record:

| | bare `<img>` as the object | wrapped `<div>` as the object |
|---|---|---|
| `offsetWidth/Height` | 200×100 | 200×100 |
| painted box @30° | 223×187 | 223×187 |
| computed `transform` | identical | identical |
| `box-sizing` | `border-box` | `border-box` |

There is no geometric advantage to the bare form, and it cannot host the state that §4
requires. **The wrapper wins.**

### Rotation leaves the reported box alone (ADR 0004 re-confirmed)

A `200×100` object with a valid image inside, at three rotations:

| rotation | `offsetWidth/Height` | `<img>` `offsetWidth/Height` | painted box |
|---|---|---|---|
| 0° | 200×100 | 200×100 | 200×100 |
| 30° | 200×100 | 200×100 | **223×187** |
| 90° | 200×100 | 200×100 | **100×200** |

The layout APIs stay transform-invariant for an image exactly as they do for a shape and a
text frame, so ADR 0004's contract and its `stale` check apply unchanged.

### CSS `aspect-ratio` cannot express a locked ratio

On a `200×100` box: setting `aspect-ratio: 2 / 1` left it `200×100`; then setting
`height: 250px` gave `200×250`. Explicit `width`/`height` win, so `aspect-ratio` only fills
in a dimension that is `auto`. It cannot express "this image's box is locked to its
intrinsic ratio" as an override, which means the lock cannot live in CSS.

## Decision

### 1. The asset reference contract

Two tables, with different lifetimes. This is the whole answer to "what does a reference
mean".

**Authored and canonical — in the model:**

```ts
export type AssetId = string;

export interface AssetRecord {
  readonly kind: 'image';
  readonly mime: string;
  /** Intrinsic size in px, read once at import via `decode()`. Never 0. */
  readonly intrinsicWidth: number;
  readonly intrinsicHeight: number;
  /** How the bytes are carried in the document. See the table below. */
  readonly data: AssetData;
}

export type AssetData =
  | { readonly inline: string }    // a data: URL
  | { readonly external: string };  // a project-relative path (not implemented)
```

and a node holds **only the id**:

```ts
export interface ImageNode extends BaseNode {
  type: 'image';
  asset: AssetId;
  fit?: ImageFit;
}
```

**Runtime and disposable — not in the model:**

`AssetResolver` (in `render/`) maps `assetId` → an object URL, memoised, and revokes the
previous URL when an asset's bytes are replaced. It is a cache. Nothing in the document,
the history, or the command funnel ever holds an object URL.

> **The rule, stated once:** *a blob URL may be a runtime projection; it may never be an
> asset's identity.* An object's `asset` field is an id that means the same thing in a
> fresh tab, in an undo, and in a serialized file.

### 2. Why each rejected representation is rejected

| Representation | Verdict | Reason |
|---|---|---|
| Blob URL in the model | **Forbidden** | Transient and per-session; revoked on reload. The document would describe a document that cannot be reopened. |
| `File`/`Blob` in the model | **Forbidden** | Not JSON, not diffable, not comparable by reference. `isNoop` (§4.2) compares values, and `History` compares by reference — an opaque binary would break both, and no-op detection would stop working for image properties. |
| Local filesystem path as identity | **Deferred** | Not portable, needs permission, breaks the single-file story. The `{ external }` slot exists so adding it is additive. |
| Remote URL | **Forbidden as a mechanism** | Local-first. A document that only renders online is not a document. |
| data: URL as the *only* form | **Accepted, with a caveat** | ~33% base64 overhead and no lazy loading, but it is the only form needing no external resolution — so a saved file is always complete. `{ external }` is the escape hatch for large media. |
| **Asset table + stable id** | **Chosen** | Identity survives re-render, undo, and serialization. Bytes and identity are separated, which is what lets the representation change later without touching nodes. |

The architecture's existing §6.1 `resources` sketch already had `kind`/`mime`/`width`/
`height`/`data:{inline|external}`. It is adopted unchanged rather than replaced — with the
correction that the intrinsic size is **required and never zero**, because `decode()`
guarantees it at import.

### 3. Image geometry

**Nothing new.** The §1.5 invariant applies verbatim:

> `transform.x/y/width/height` is the image's **border box**, in page-local document px.

Measured to hold whether the image loaded, failed, or was rotated. No second convention,
no `intrinsicWidth` on the node, no `fit`-derived geometry.

| Question | Answer |
|---|---|
| Intrinsic dimensions | **Asset metadata** (`AssetRecord.intrinsicWidth/Height`), not node state and not measurement |
| Default placement size | The asset's **intrinsic size**, from metadata. No browser round-trip and no measurement read |
| Default aspect behaviour | An image is **placed at its intrinsic ratio**, because its default size *is* its intrinsic size |
| Is the ratio preserved on resize? | **Only while the lock is held.** Resize writes `width`/`height`, exactly as for a shape |
| How is a non-proportional resize expressed? | As ordinary authored `width`/`height`. Nothing extra |
| Width/height → 0 | Valid, renders 0, and is not hit-testable — identical to every other object type (ADR 0005 §7) |
| Rotation | About the box centre; preserves size and the ratio. Measured above |
| Stroke | **Not applicable.** A stroke is a `ShapeNode` property. An image has no stroke, so the question does not arise; it is recorded here so that "why can't I outline an image" has an answer |

### 4. The aspect-ratio lock belongs to the gesture, not the model

**Aspect locking is a transient gesture modifier, exactly like shift-constrain in §3.5.**
It is not authored state, not a node field, and not an inspector checkbox.

Three reasons, in order of weight:

1. **CSS cannot do it** (PROBE AC): explicit `width`/`height` beat `aspect-ratio`, so the
   lock cannot be expressed as a style that the model does not hold.
2. **Storing it would change pixels the user did not author.** A persistent lock means
   every *later* resize silently alters the height — and the height is authored geometry.
   That is the line §1.5 draws: if the user authored it, it is in the model; if changing it
   changes pixels without the user authoring it, it is CSS. A lock is neither: it is a
   constraint on one gesture.
3. **It would be an image-specific transform concept**, and §6 of the milestone forbids
   building an image-specific transform system. Keeping it a modifier means images use
   `resizeTransform` unchanged.

So: the lock constrains the gesture, the gesture writes ordinary `width`/`height`, and the
result is indistinguishable from a proportional resize the user did by hand. Nothing new
in `editor/transform.ts`.

### 5. The asset lifecycle

**Load state is rendering output, never document state.** The model records a reference; it
does not record whether that reference currently resolves, because "currently" is not a
property of a document — it is a property of this browser session. This is ADR 0004's
philosophy applied to a second thing: *the model says what was authored, the browser says
what happened.*

```ts
export type AssetState = 'idle' | 'loading' | 'loaded' | 'error';
```

Projected onto the element as `data-asset-state`, derived from the `<img>`:

| state | derived from | meaning |
|---|---|---|
| `idle` | no `src` yet | resolution has not been attempted |
| `loading` | `src` set, `!complete` | in flight |
| `loaded` | `complete && naturalWidth > 0` | decoded |
| `error` | `complete && naturalWidth === 0` | **or** `decode()` rejected at import |

`error` is the state that `complete` alone would have hidden. It is the whole reason the
union exists rather than a boolean.

**Lifecycle operations:**

| Operation | What happens | Notes |
|---|---|---|
| **Creation** | `decode()` the bytes → `AssetRecord` with intrinsic size → `insert` carrying node **and** asset | One command (`batch`), so one undo step |
| **Runtime resolution** | `AssetResolver` memoises `assetId` → object URL | Disposable; revoked on replacement |
| **Render-time resolution** | The renderer sets `src` only when a URL exists, and publishes the state | Never sets `src` to a URL it does not have |
| **Replacement** | New bytes → new `AssetRecord` under the **same** `assetId`; the resolver revokes the old URL | Nodes referencing that id re-render; no node changes |
| **Deletion** | `remove` the node. **The asset record stays** | See the gap below |
| **Missing asset** | `data-asset-state="error"`, placeholder painted, node still selectable and still its authored size | Never silently invisible |

**Replacement keeps the id deliberately.** A `src` change that produced a new `assetId`
would silently invalidate every node using it — and the nodes would keep rendering the
*old* bytes while the document claimed otherwise. One id, new bytes, is the only version of
this that cannot drift.

> **Named gap: no asset garbage collection.** Deleting the last image that uses an asset
> leaves its bytes in the document, because `assets` is part of the model and therefore part
> of history — which is what lets undo restore a deleted image *and its bytes*. Collecting
> orphans needs a reference count across the document, and it needs to interact with undo.
> Deliberately not built, and recorded here rather than left to be discovered.

### 6. Rendering

A **wrapper `div` is the object element**, per PROBE AA — there is no geometric cost, and
it is the only form with somewhere to put a failure state.

```
div.p1-object.p1-image[data-oid][data-asset-state]   ← transform.x/y/width/height, transform, opacity
  └─ img.p1-image-content                             ← width/height 100%, object-fit
```

* **`width`/`height`/`object-fit`** on the `<img>`: `fill` (default) stretches to the box;
  `contain`/`cover`/`none`/`scale-down` are authored choices that change only the paint
  (PROBE X).
* **`object-position` is deliberately absent.** Under the default `fit: fill` it has no
  observable effect, so it would be a property with no authored meaning — and its entire
  purpose is crop control, which is out of scope. It arrives with cropping, additively.
* **`opacity`/`mix-blend-mode`** on the wrapper, as for every object type.
* The placeholder is CSS on the wrapper, keyed off `data-asset-state`, so a failed image is
  a **visible marked box** rather than an empty one — and `display: none` is reserved for
  `visible: false`, so the two can never be confused.

### 7. Hit testing

**The model's box, via the existing generic path.** No new predicate.

`hitNode` already ends in "anything that is not a shape is a box", which is correct for an
image and is now documented rather than accidental. An image's selection geometry is its
border box, at every `object-fit` value, with or without rotation.

**An image is selected by its object geometry, not by its visible pixels.** That is now a
measured decision rather than an omission: PROBE Y shows Chromium hit-tests a fully
transparent pixel, so a pixel-accurate editor would *disagree with the browser* on every
image with transparency. Alpha-aware hit testing is rejected on that evidence.

### 8. Measurement

**No image-specific measurement API, and no `measureImage`.**

Intrinsic size is **asset metadata** (§3), obtained at import by `decode()`. Rendered size
is **authored geometry**, readable through ADR 0004's existing contract — an image node's
`offsetWidth/Height` equals its model box in every state measured, including rotated and
failed. There is therefore no image-specific measurement requirement, and the `stale` check
works on an image with no changes at all.

The one thing measurement is good for here is *reporting*: the inspector reads
`data-asset-state` off the element to say whether an asset resolved, which is the same
"read the browser for what the browser knows" pattern as ADR 0004's read-only note.

### 9. Persistence

**Not implemented, and the reference contract is what matters.** §6.1 is a sketch; there is
no serializer in the tree.

The asset contract is chosen so that a future serializer needs no new decisions: a
`Record<AssetId, AssetRecord>` with a string payload is plain JSON, `isNoop` and `History`
work unchanged, and the `{ external }` variant is already typed. What persistence will
*not* get for free is `{ external }` resolution and the resource-loading order a real
format needs — both recorded as prerequisites for M8, not built here.

---

# 9. Amendments found during implementation

Three claims did not survive contact with the app. They are recorded here rather than
edited into the sections above, because *why* the first draft was wrong is the part that
constrains future work.

## 9.1 Inline assets need no object URL at all

§1 specified a resolver that "mints object URLs, memoised", and §1's table rejected blob
URLs *in the model*. Implementing it that way failed immediately and instructively:

```
new Blob([asset.data.inline], { type: mime })
```

wraps the **data-URL string** in a Blob. That Blob contains the text
`data:image/png;base64,iVBOR…`, which is not an image, so *every* image failed to load.
The failure was silent and looked like a decode problem: the node existed, was correctly
sized, was selectable, and showed nothing.

The fix was not to hand-decode the base64. It was to notice that the object URL was buying
nothing: a data URL is **already a stable function of the bytes**, so the `src` is
identical across renders and only changes when the bytes change — which was the entire
stated justification for minting one. So inline assets now pass straight through, and the
resolver's cache is kept only for the `external` case that will genuinely need a minted URL.

> **The revised rule:** *a blob URL may be a runtime projection; it may never be an asset's
> identity — and for inline assets there is no reason to mint one.*

## 9.2 `lastDocument` must be published before reconciling

`DocumentView.render` assigned `this.lastDocument = doc` **after** the reconcile loop. The
resolver reads the document through `lastDocument`, so during projection every read saw the
*previous* document — and a freshly inserted image resolved against a document that did not
contain its asset.

The symptom was the worst kind: the node was inserted, was the right size, was selectable,
and showed no pixels. It looked exactly like a decode failure and was chased as one. The
fix is a one-line reordering, and the comment at the assignment says why, because nothing
about the original ordering looks wrong in isolation.

**Generalised:** anything a renderer reads *during* projection must read the document being
projected. `lastDocument` is now a "currently projecting" field, not a "last projected" one.

## 9.3 A failed resolution must not derive as `idle`

The state derivation reads the `<img>`, and a resolution failure leaves it with no `src` —
which derives as `idle`. So a **missing asset reported itself as "still loading"**, a promise
the browser will never keep, and the placeholder CSS (keyed off `idle`) was coincidentally
right for the wrong reason.

Two attributes, because they answer different questions:

| attribute | question |
|---|---|
| `data-asset-state` | are there pixels yet? (`idle`/`loading`/`loaded`/`error`) |
| `data-asset-resolution` | did we even get a URL? (`failed`, present only on failure) |

`deriveAssetState` checks the second first, and remains a pure function of the element — so
`Editor.assetStateOf`, the inspector and the tests all read the same rule rather than
re-deriving it.

## 9.4 Two of my own measurements were artefacts of a broken fixture

Worth recording, because both produced confident, wrong conclusions:

- **"Chromium is alpha-aware."** Round 1's probe used a hand-written base64 PNG that did
  not decode, so every case meant to exercise a *loaded* image was silently exercising the
  *failure* path — where a failed image is hit-testable across its whole box. With valid
  bytes, a fully transparent pixel **is** a hit. The conclusion inverted.
- **"A `0×0`-boxed image does not load."** The image suite's zero-size case failed, and the
  natural reading was that Chromium skips fetching images with no layout box. PROBE AD
  measured it: a `0×0`-boxed image with valid bytes loads normally. The real cause was the
  fixture generating a `0×0` **canvas**, which produces an undecodable PNG.

Both are the same failure as M5's malformed-fixture episode, and both argue for the same
thing: **a fixture that can be wrong about being an image will be.** So every image fixture
in this suite is generated at test time, and `waitForDecoded` refuses to let a test proceed
against an image that did not load.

## 9.5 A correction to ADR 0005

Testing the zero-size image found that **ADR 0005 §5's claim that a zero-extent box is "not
reachable by click" was wrong.** The box predicate is inclusive on all four sides, so a
`0×0` box accepts exactly one point — its origin — and the editor *will* select a degenerate
object there, where Chromium will not.

Left as-is deliberately (a special case would make a `0×0` object impossible to select, and
creation already refuses to make one), and ADR 0005 has been amended. It is recorded here
because the error is instructive: it was a plausible claim about a degenerate case that
nobody had ever clicked on.

## 9.6 Declared intrinsic size can be wrong, and nothing checks it

Not a bug — a property, and one that argues for the design. A document may declare
`intrinsicWidth: 400` for a `40×20` PNG, and nothing in the renderer or the resolver
validates the claim. The pixels follow the bytes; the *placement size* and the inspector's
readout follow the document.

That is exactly why intrinsic size is asset **metadata** and not a measurement: a
measurement cannot be wrong about itself, whereas metadata is the document's assertion and
can be. A validator belongs with persistence, which will have to trust or check these
numbers; it is not the renderer's job.

---

## Limitations, carried forward deliberately

- **No garbage collection of orphaned assets** (§5). Bytes accumulate until a collector
  exists.
- **No `object-position`, no crop, no non-rectangular image frames.** All out of scope; the
  first is the prerequisite for the second.
- **No alpha-aware hit testing** — rejected on measurement, not deferred.
- **No asset management UI**: no library, no rename, no replace-by-picker, no usage
  listing. The only route in is "insert from a file", which is the minimum that makes the
  slice real.
- **`{ external }` is typed but not implemented.** No filesystem access, no
  `FileSystemObserver`, no permission flow.
- **No remote URLs.** A document that only renders online is not a document.

## Verification

| Claim | Where |
|---|---|
| Intrinsic size at import; `decode()` rejects non-images | `tests/spike/image-probe.spec.ts` W |
| `object-fit` changes paint only, not box or hit region | same, X |
| Transparent pixels are hit-testable (browser is not alpha-aware) | same, Y |
| `complete` is true for failures; only `naturalWidth > 0` distinguishes | same, Z |
| An `<img>` cannot render a failure marker; wrapper costs nothing | same, AA |
| Rotation leaves the reported box alone | same, AB |
| Explicit `width`/`height` beat `aspect-ratio` | same, AC |
| The contract through the real app, with negative controls | `tests/editor/images.spec.ts` |
| The model-side asset rules, exhaustively | `src/model/assets.test.ts` |

If any table above stops matching, this ADR is wrong.