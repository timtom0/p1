# ADR 0014 — Asset garbage collection

**Status:** accepted
**Date:** 2026-10-07
**Closes:** the named gap in [ADR 0006](0006-image-asset-contract.md) §5 and
[ADR 0007](0007-persistent-document-format.md) §14.
**Builds on:** ADR 0007 (the format), ADR 0012 (the recursive tree).

---

## 1. The gap, quoted

ADR 0006, verbatim:

> **Named gap: no asset garbage collection.** Deleting the last image that uses an asset leaves its
> bytes in the document, because `assets` is part of the model and therefore part of history — which is
> what lets undo restore a deleted image *and its bytes*. Collecting orphans needs a reference count
> across the document, and it needs to interact with undo. Deliberately not built, and recorded here
> rather than left to be discovered.

Two obligations come out of that sentence, and they pull in opposite directions:

- assets are **history**, so undo must be able to bring the bytes back; and
- orphans must not accumulate forever.

Any solution that runs GC as a sweep outside the command funnel satisfies the second and breaks the
first.

## 2. Contract

**`{ type: 'pruneAssets' }` — a command with no payload**, applied through the existing funnel.

- `apply(doc, { type: 'pruneAssets' })` removes every record in `doc.assets` that **no image node at any
  depth references**, and returns the **same `doc` reference** when there is nothing to collect, so
  `isNoop` is true and no undo step appears.
- It is a **single command**, so a collection is one history entry, and undo restores the whole table
  because `History` snapshots whole `Document`s.
- It is **never implicit**: nothing on load, save, or delete calls it. The editor issues it from an
  explicit action, so the user decides when bytes are dropped.
- The referenced-id computation is exposed as a **pure function**, `referencedAssetIds(doc)`, so "what
  would be collected" is answerable without mutating anything.

### Why a payload-free command rather than `removeAsset`

`setAssets` merges per key and cannot remove, which is correct for its job (M5: re-importing identical
bytes must not record a change). Adding a `removeAsset` would be the obvious fix and is the wrong one:
it makes GC a *sequence* of one-remove-per-asset commands, so a document with forty orphans produces
forty undo steps, and the collected set is decided by the caller rather than by the document. One
command that asks the document what is unreachable keeps the decision in one place.

The empty payload is what makes it plain data — there is nothing to serialise, and the command cannot
be replayed against a *different* document than the one it was built for, which is the property that
matters for history.

## 3. The traversal is the whole point

An asset is reachable from exactly one place: `ImageNode.asset`. So the reference set is every image
node's `asset`, **at any depth**.

That is a smaller question than it looks and it is the seam M13 proved hazardous. `tree.ts` exposes four
look-alike lookups with different reachability — `placementOf` finds **leaves only**, `nodeById` finds
everything, `pageIdOf` is built on `placementOnPage` and so answers `null` for a group. M13 shipped a
selected group that drew no outline because it used `pageIdOf`, and every other signal said the object
was there.

So GC uses `placementsInDocument`, the same traversal rendering and hit testing use, rather than a
fresh recursive walk. It costs a matrix per leaf, which is irrelevant for an explicit user action, and
it buys the guarantee that **GC sees exactly the objects the editor can see** — including an image
inside a hidden group, a locked group, and a group nested in a group. A separate walk would be a third
answer to "where are the nodes", and the first two already disagreed once.

## 4. Failure modes, enumerated before implementation

Each of these is a test:

| | |
|---|---|
| an image at depth 0, 1 and 2 all keep their asset | depth blindness is the classic failure |
| an image inside a **hidden** group keeps its asset | "not painted" is not "not referenced" |
| an image inside a **locked** group keeps its asset | ditto |
| deleting the last image makes its asset collectible | the whole point |
| deleting a group makes **every** asset under it collectible | subtree, not one node |
| a shared asset used twice survives until both are gone | reference counting, not ownership |
| nothing to collect returns the same reference | no empty undo step |
| undo restores the dropped bytes | the ADR 0006 obligation |
| `serialize`/`parse` round-trips the pruned table | persistence stays truthful |
| two successive collections collect nothing the second time | idempotence |

## 5. Non-goals

- **No implicit collection.** Not on load, not on save, not on delete.
- **No deduplication.** Two records with identical bytes stay two records; collapsing them would change
  ids that history references.
- **No byte re-encoding, compression, or format optimisation.**
- **No `external` URL resolution** — deferred with project folders (ADR 0007).
- **No asset limit, quota, or size budget.**
- **No trimming of history.** The bytes come back on undo, and they stay until the user collects again.

## 6. Status

Implemented in `src/model/assets.ts` (`referencedAssetIds`, `orphanAssetIds`), `src/model/commands.ts`
(`pruneAssets`), and the editor action that issues it.