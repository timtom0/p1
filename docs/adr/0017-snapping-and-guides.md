# ADR 0017 — Snapping, and the threshold that has to survive zoom

- **Status:** accepted
- **Date:** 2026-10-08
- **Depends on:** `docs/ARCHITECTURE.md`; [ADR 0008](0008-multi-selection-and-grouping.md),
  [ADR 0011b](0011b-selection-frame-and-stroke.md), [ADR 0012](0012-persistent-group-model.md),
  [ADR 0013](0013-group-interaction.md), [ADR 0016](0016-alignment-and-distribution.md)
- **Answers:** what snapping measures, in what space; what the threshold is; how a snap is chosen when
  several qualify; and what a guide is
- **Extends:** the `OverlayInput.snapLines` contract, which M11 defined and M17 is the first consumer of

## Context

Moving an object with a pointer is the only gesture that is *continuously* aimed at something. Resize and
rotate both grab a specific handle or grip, so the target is already known; a move has to infer one from the
pointer's position, which is why every editor with a move gesture also has snapping.

The overlay contract for guides has existed since M11 and has never had a consumer:

```ts
export interface SnapLine { axis: 'x' | 'y'; position: number; pageId: string; from: number; to: number }
export interface OverlayInput { …; snapLines: readonly SnapLine[]; … }
```

and `Overlay.snapLine` already renders them through `toLayer`, the same page→layer conversion that places
the outline and the handles. `editor.ts` passed `snapLines: []`.

So most of the visual half already exists and is exercised by nothing. This milestone supplies the
calculation and populates the field. **No overlay change was needed**, which is the outcome the M0–M16 habit
of building on contracts was supposed to produce.

## 1. What snapping measures

**Painted bounds, in page space — the same quantity alignment uses.** ADR 0016 established
`arrangeTargets` and `arrangeBounds`, which resolve a selection (or any set of ids) to page-space painted
boxes, give a group the union of its descendants' painted bounds, and produce a selection's union.

Snapping reuses both, verbatim:

| snapping needs | M16's function |
|---|---|
| the moving arrangement's box | `arrangeBounds(arrangeTargets(doc, selectionIds))` |
| a group's painted box | `arrangeTargets`, which unions descendants |
| nearby objects' boxes | `arrangeTargets(doc, otherIds)` |

There is therefore **no second definition of object bounds** in the snapping code. That was the explicit
requirement and the reason the M16 API was shaped as it was: `arrangeTargets` returning `painted` boxes
rather than raw transforms is what makes this reuse possible.

Candidates are the **edges and centres** of those boxes, on each axis:

| axis | features of the moving box | features of each target box |
|---|---|---|
| x | left, horizontal centre, right | left, horizontal centre, right |
| y | top, vertical centre, bottom | top, vertical centre, bottom |

Page edges and page centre are just another target — the page's own rect, in the same units, participating
in the same comparison. There is no special "page snap" code path.

### A multi-selection is one arrangement

The moving box is the **union** of the selection. Members are not snapped independently, because
independently-snapped members would end up at different alignments than the user dragged toward — the
selection would visibly come apart. One union, one snap, applied to every member by the same delta.

## 2. The threshold, and the conversion that matters

> **The threshold is 10 screen pixels. It is converted to document space by dividing by the current zoom,
> and it is that document-space value — not the screen one — that the comparison uses.**

This is the part that is easy to get wrong and invisible when it is. The gesture already works in page
space: `pagePointFromClient` converts the pointer, and `applyMove` computes `dx = pagePoint.x − origin.x` in
document px. So the distance being compared is a **document-space** distance, and comparing it against a
screen-space constant would make the effective threshold `10 × zoom` document px — 2.5 px of document space
at 25% and 40 px at 400%. The snap would feel dead when zoomed out and magnetic when zoomed in.

Hence `thresholdDocument = SNAP_THRESHOLD_SCREEN_PX / zoom`, evaluated with the live zoom on every pointer
move. 10 screen px at any zoom.

The conversion is a named function taking the zoom, rather than being inlined, precisely so it can be
tested at several zooms — a unit test that asserts `thresholdDocument(0.25) === 40` and
`thresholdDocument(4) === 2.5` is the whole guarantee, and it cannot be expressed any other way.

## 3. Choosing a snap

Independent per axis, and **both may be active at once** — snapping on x does not prevent snapping on y,
because the two are decided from orthogonal features and a user dragging towards a corner wants both.

On one axis, for each feature `f` of the moving box and each candidate position `c`:

- `d = c − f`; the candidate qualifies when `|d| ≤ threshold`;
- the **smallest `|d|` wins**.

Ties are broken by **scan order**, with a strict `<` so the first candidate at the minimum is kept. Scan
order is fixed and total:

1. **page** features, in the order left, centre, right (x) / top, centre, bottom (y);
2. then **object** candidates in document order — which `arrangeTargets` guarantees, independently of the
   order the ids were passed in or the order the user clicked them.

Nothing here iterates a `Set`, so nothing depends on insertion order.

### Why the tie-break prefers the page

Page edges are checked first, so at an exact tie — a moving edge 4 px from both the page centre and an
object's centre — the page wins. That is deliberate and observable: page geometry is stable for as long as
the document is, whereas an object candidate may be about to move. Snapping to the more stable thing is
what stops a drag from chasing a target that is itself in motion.

### Why this does not oscillate

`applyMove` already recomputes `dx` from `gesture.origin` and the **raw pointer position on every move**, and
never accumulates. Snapping is applied to that same fresh delta each frame, so it cannot drift and cannot
ratchet. A classic oscillation — object A approaches B, snaps, overshoots, snaps back — needs the result to
feed the next frame's input, and here it does not.

The remaining, genuinely unavoidable case is a pointer hovering exactly between two candidates: crossing
the midpoint swaps which one wins, and the object jumps by the difference between them. That is a property
of nearest-candidate snapping in any implementation, it is bounded by the threshold, and it is resolved the
way every editor resolves it — by the user letting go.

## 4. Suppressing snapping: Alt

> **Alt held during a move drag disables snapping for that drag.**

Every mainstream editor uses Alt (Cmd on macOS) for this, and it is the only modifier free at this point in
the gesture:

| modifier | in use, at pointer-down | in use, during the drag |
|---|---|---|
| Shift | additive selection | axis lock on move, aspect on resize |
| Ctrl | group / undo / redo | — |
| Alt | select the containing group, include locked | **free** |

Alt is read at **pointer-down** to decide *what is grabbed* and during the **drag** to decide *whether to
snap*, so the two uses never apply at the same moment. The user presses to grab the leaf, then holds Alt to
drag it freely.

It was not extended to resize or rotate. Snapping is a *move* affordance, and adding it elsewhere would mean
deciding what a resize handle snaps to, which this milestone deliberately does not answer.

## 5. Guides are derived, transient, screen-space state

A guide is a `SnapLine` in the existing overlay contract: an axis, a position in page-local document
coordinates, the page it belongs to, and an extent. It is drawn by the overlay, in layer coordinates, and
never in the document.

| property | how it holds |
|---|---|
| appears only while a snap is active | `snapLines` is set in `applyMove` and **cleared in both `endMove` and `cancelMove`** |
| screen-space rendering | `Overlay.snapLine` → `toLayer`, the existing page→layer conversion |
| never persists | not a `Document` field; `formatVersion` unchanged |
| never dirties the document | no command is dispatched for a guide |
| never enters history | guides are not commands |

The clearing is the load-bearing part and it is asserted in both directions — a guide survives across the
frames of one drag, and is gone after it. A guide that outlived its gesture would be a lie drawn on the
canvas.

**No persistent ruler guides.** They are a document feature — they are authored, saved, and shared — and
this milestone is explicitly not that.

## 6. Scope

Snapping is integrated into the **move gesture only**. Resize, rotate, alignment, distribution, selection
and grouping are untouched.

- **A selected group** snaps using its derived painted bounds (the M16 union) and is **moved as a group**.
  Members are never rewritten individually because the group was selected.
- **A selected nested child** moves through `pageDeltaToParentDelta`, the M16 conversion. The snap produces a
  page-space delta and is converted exactly as an unsnapped delta would be, so snapping cannot drift where
  plain dragging no longer does.
- **No affine/shear**, **no multi-object resize**, no change to `Transform2D`.

## 7. Persistence

No format-version bump: snapping writes nothing but `setTransform` on the moving objects, which is the same
mutation an unsnapped drag performs.

`tests/editor/persistence.spec.ts` already proves the format *refuses* an undeclared `guides` key on load,
which is the load-time half of this guarantee. M17 adds the other half: that displaying guides and snapping
produce **byte-identical** saved output for the same document, so snap state cannot leak into the file even
transiently.

## 8. Findings

- **F19 — the guide contract was built in M11 and never connected.** `SnapLine`, `OverlayInput.snapLines`
  and `Overlay.snapLine` were all present, rendering correctly through `toLayer`, with the single hard-coded
  `snapLines: []` standing in for a consumer. Four years of interface design for something that had no user.
  It is also the strongest argument for the M0–M16 rule about adding contracts before consumers: the shape
  was right, and the only thing missing was the calculation.
- **F20 — the threshold's failure mode is invisible at 100% zoom.** A screen-space constant compared against
  a document-space distance is exactly correct at zoom 1 and wrong everywhere else, which is why it would
  have passed every test written at the default zoom. The conversion is therefore a named, exported function
  with its own tests at 0.25 and 4.
- **F21 — the moving box must be captured at pointer-down, not re-derived from the document each frame.**
  This is the one real defect the milestone produced, and it is worth recording because the mistake is
  natural and the pure engine gave no hint of it.

  The obvious implementation is "on every `pointermove`, ask the document where the selection is and
  translate it by the pointer delta." That is wrong here, because **the move gesture dispatches its
  `setTransform` batch on every frame**. By the time the next `pointermove` arrives, `this.doc` already holds
  the *previous frame's snapped position*. Translating that by the new delta applies the delta twice, and
  compounds from the first snap onward.

  The symptoms were entirely misleading, which is why this belongs in an ADR rather than a commit message:

  | observed | actual |
  |---|---|
  | a drag that snapped to a candidate **140 px from the object on screen** | the box was read one frame stale and the previous adjustment re-applied |
  | a drag that refused to snap where a candidate was visibly 3 px away | same cause; the accumulated error moved the box out of threshold |
  | Alt appearing not to suppress snapping | it did; the stale box still produced a snap from an earlier frame |
  | a near miss at 25% landing on `b`'s centre rather than its left edge | *not* this bug — two features genuinely tied, correctly tie-broken |

  What made it findable at all is that the calculation is pure: `computeSnap` was verified correct on the
  exact failing numbers (a unit check returned the right adjustment where the browser did not), which
  localised the defect to the integration in one step instead of by inspection.

  The rule adopted, and the reason `Gesture` now carries `bounds`: **the gesture captures its geometry once,
  at pointer-down, and every frame is arithmetic on it.** Nothing in the snapping path reads live document
  state except the *targets*, which the moving selection never includes and which do not move during the
  gesture.

  A second, smaller finding sits alongside it: a document-space reading of the *test helper* was the same
  error one level down. `getBoundingClientRect` reports client pixels, and dividing by zoom only became
  necessary because a test asserted at 25% and 400% — at the default 100% zoom the client and document
  numbers are identical, which is exactly what let the mistake through to that point.
