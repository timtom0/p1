/**
 * Alignment and distribution for a multi-selection.
 *
 * ## What this operates on, and why
 *
 * **`paintedBounds`, in page space.** Not the model frame.
 *
 * Alignment is a visual editor operation: the user is asking "line these up *as I see them*". ADR 0011b §3
 * established that `{x, y, width, height}` off the transform is the **model frame** -- the local,
 * unrotated box -- and that for a rotated object it is *not* what is on screen. A 100x60 box rotated 45°
 * paints 113.1 x 113.1. Aligning by the model frame would therefore line up invisible boxes and visibly
 * misalign the shapes.
 *
 * So every box here is `paintedBounds(placement.transform)`, which is page space at any depth -- verified
 * by `tree.test.ts`, which asserts `worldMatrix(placement.transform) === placement.world`. There is no
 * second geometry system here: the function is M11's, and the placement is M12's.
 *
 * ## A group's box is its descendants' painted bounds, unioned
 *
 * This is not a special case invented for groups. It is the derivation the selection outline **already**
 * uses to frame a group (`editor.ts`, `overlayInput`): a group authored at the transparent frame has a
 * `width`/`height` of its own that describes nothing the user can see, so `paintedBounds` of the group
 * node would be a box the user never sees. The overlay unions the group's members' painted bounds, and
 * alignment uses the same union -- so an object aligns to the outline the user is looking at, which is the
 * only definition that cannot disagree with what is drawn.
 *
 * Aligning a group therefore **moves the group**, and its members move with it by composition. Nothing
 * fans out to children: the group's transform is the authored quantity, and rewriting members would be a
 * second mutation path with no contract behind it.
 *
 * ## Translation only
 *
 * Alignment and distribution only ever produce a translation. Nothing here writes `width`, `height`,
 * `rotation`, `scaleX` or `scaleY`.
 *
 * Two consequences, both asserted:
 *
 * - **Size is preserved exactly.** A translated object's painted box keeps its dimensions, so after
 *   aligning the left edges of three boxes every one of them has the same left edge *and* its original
 *   width. An implementation that "helpfully" resized to match would pass a left-edge test and fail this.
 * - **Stroke width is untouched** (ADR 0011b §5: stroke is authored in local units and transforms with
 *   the object). A move does not scale, so a 12px stroke is 12px before and after. Had alignment scaled,
 *   every stroke in a group would have silently changed thickness.
 *
 * ## The aggregate box is calculation data, never geometry
 *
 * Aligning needs a reference box for the whole selection, which is the union of the members' painted
 * bounds. That union is computed here, used, and discarded. It is never drawn, never stored, and never
 * becomes something a gesture can grab.
 *
 * This is the distinction ADR 0008 §7 drew, and it is worth stating precisely because the two are easy to
 * conflate. That ADR refused an *aggregate selection frame*: a rectangle presented to the user as though
 * it were geometry, which for rotated children is not the painted bounds and would invite a resize
 * gesture that M8 deliberately does not have. A transient union used to compute two translations is not
 * that. Nothing is presented, so nothing can be mistaken for geometry, and the overlay still draws
 * per-member outlines exactly as before. See ADR 0016.
 *
 * ## Multi-object resize remains out of scope
 *
 * Distributing requires knowing each member's extent, which is why this file needs painted bounds at
 * all -- and it is exactly the capability a resize would need and does not have. Nothing here resizes,
 * and the absence is deliberate: resizing a multi-selection is ADR 0008 §4's shear problem, still
 * deferred.
 */

import { paintedBounds } from './transform';
import { locateNode, placementsInDocument, type NodePlacement } from './tree';
import { unionRects } from '../core/geom/rect';
import type { Rect } from '../core/geom/rect';
import type { Vec2 } from '../core/geom/mat2d';
import type { Document, GroupNode, Transform2D } from './types';

/** The six edge alignments and the two distributions. */
export type AlignMode =
  | 'left'
  | 'center-h'
  | 'right'
  | 'top'
  | 'center-v'
  | 'bottom';

export type DistributeAxis = 'horizontal' | 'vertical';

/** What an alignment or distribution asks for. */
export type ArrangeOperation =
  | { kind: 'align'; mode: AlignMode }
  | { kind: 'distribute'; axis: DistributeAxis };

/**
 * One selected object, with the box alignment reasons about.
 *
 * ## Only the authored transform is exposed, on purpose
 *
 * There are two transforms in play and they are not interchangeable:
 *
 * - the **authored** one, stored in the document, whose `x`/`y` are in the node's *parent's* space. This is
 *   what a `setTransform` patch is built from, and it is the only transform this interface exposes.
 * - the **page-space** one, which is the only space alignment and distribution can reason about.
 *
 * The page-space form is computed here, used to produce `painted`, and then discarded. It is deliberately
 * *not* a field, because exposing it invites exactly the bug this file had first: `paintedBounds` resolves
 * a transform against its immediate parent, so a caller handed the authored transform measures the object
 * *inside its group* rather than on the page. At depth 0 the two coincide and every top-level test passes,
 * which is the worst shape a bug can have. With one transform on the interface and the box precomputed,
 * there is no second thing to pick up.
 *
 * `ancestors` is carried because a group's own transform does not describe its visible extent -- see the
 * module comment -- and because it is what converts a page-space delta into a parent-local one.
 */
export interface ArrangeTarget {
  readonly id: string;
  /** The authored, parent-local transform. What a `setTransform` patch is built from. */
  readonly transform: Transform2D;
  /** Outermost first; empty when the parent is the page. Drives the page-to-local delta conversion. */
  readonly ancestors: readonly GroupNode[];
  /** The page-space box alignment and distribution reason about. See {@link boxFor}. */
  readonly painted: Rect;
}

/**
 * A one-line label for an arrangement, for the history entry and the undo menu.
 *
 * "Align 3" rather than "Align left 3 objects": the count is the part that tells the user how much they
 * are about to undo, and it matches `nudge`'s `Move ${countLabel(n)}` so the two read consistently.
 */
export function describeArrange(operation: ArrangeOperation, count: number): string {
  const noun = count === 1 ? 'object' : 'objects';
  switch (operation.kind) {
    case 'align':
      return `Align ${count} ${noun}`;
    case 'distribute':
      return `Distribute ${count} ${noun} ${operation.axis === 'horizontal' ? 'horizontally' : 'vertically'}`;
  }
}

/** The fewest objects an operation can do anything with. */
export const MIN_ALIGN = 2;

/**
 * The fewest objects a distribution can do anything with.
 *
 * Three, not two, and the reason is structural rather than arbitrary: distribution keeps the outermost
 * two objects fixed and moves everything between them. With two objects *both* are the outermost, so
 * there is nothing left to move and the operation is vacuous. Requiring three means the requirement
 * states the precondition under which the operation has an answer, instead of accepting a selection and
 * silently doing nothing.
 */
export const MIN_DISTRIBUTE = 3;

/**
 * The painted box of one selected object, in page space.
 *
 * A leaf is its own painted bounds. A group is the **union of its descendants' painted bounds** -- the
 * same derivation the overlay uses to frame it, so alignment reasons about the outline the user sees.
 *
 * `worldTransform` must be the **page-space** form. `paintedBounds` applies `worldMatrix`, which resolves
 * a transform against its immediate parent, so handing it an authored transform measures the object
 * *inside its group* rather than on the page. That is correct-looking at depth 0 and wrong everywhere
 * else, which is the worst shape of bug: the whole top-level suite passes.
 *
 * `leaves` is the document's placements, which are leaves; a group's descendants are found by walking
 * `ancestors`, so nesting at any depth is covered without a recursive search of its own.
 */
function boxFor(
  id: string,
  isGroup: boolean,
  worldTransform: Transform2D,
  leaves: readonly NodePlacement[],
): Rect | null {
  // A leaf is its own painted bounds -- including a rotated one, which is the whole reason this uses
  // `paintedBounds` and not the model frame.
  if (!isGroup) return paintedBounds(worldTransform);

  const rects = leaves
    .filter((candidate) => candidate.ancestors.some((group) => group.id === id))
    .map((candidate) => paintedBounds(candidate.transform));
  // A group with no **visible** descendant has no painted extent. Three cases reach it, and because
  // `leaves` arrives already filtered to effectively-visible placements they all fall out of one
  // `length === 0`: an empty group; a group whose children are all invisible; and a group that is itself
  // hidden -- which hides its subtree, so even its visible children contribute nothing.
  //
  // Returning null rather than a zero-sized box keeps it out of the union instead of collapsing the
  // result to a point.
  return rects.length === 0 ? null : unionRects(rects);
}

/**
 * Whether a placement contributes to painted geometry at all.
 *
 * **The rule the renderer and hit testing already share, and the one ADR 0012 A10 records:** the node must
 * be `visible`, and so must every ancestor group. A hidden group hides its subtree -- that is the one thing
 * a group does that a leaf cannot -- so a node beneath one paints nothing and is not on the page.
 *
 * `placementsInDocument` deliberately does **not** apply this, and should not: a placement says where a
 * thing is, which does not require it to be on the page. That is why the filter lives here, in the code that
 * is about what the page shows.
 *
 * ## Why this has to agree with the other two
 *
 * `editor/document-view.ts` propagates `visible: false` down a hidden group's subtree, and
 * `isEffectivelyVisible` in `editor/selection.ts` refuses to hit-test one. Those two agree; this function
 * existed to make them agree. Arrangement was the third reader, and it applied no visibility rule at all --
 * so a hidden object still contributed its box, and because a group's box is the union of its descendants',
 * one invisible member could stretch a union arbitrarily far. Aligning or snapping to geometry that is not
 * on the page is the "invisible but live" state the renderer comment calls haunting.
 */
function isEffectivelyVisible(placement: NodePlacement): boolean {
  if (!placement.node.visible) return false;
  return placement.ancestors.every((ancestor) => ancestor.visible);
}

/**
 * Resolves the selected ids to their painted boxes, in page space, in a deterministic order.
 *
 * ## Order
 *
 * **`document order`**, from `placementsInDocument`. Not `Set` iteration order and not the order the ids
 * were clicked: alignment is symmetric in its inputs, so any order gives the same answer, but *naming* a
 * target in an error or a test needs to be stable, and document order is the one the model already
 * guarantees. Distribution then re-sorts explicitly and breaks ties by id.
 *
 * Ids that do not resolve to a placement, or that resolve to a box-less group, are **dropped** -- they
 * cannot be aligned, and inventing a zero box for them would drag the union to the origin.
 */
export function arrangeTargets(
  doc: Document,
  ids: Iterable<string>,
): ArrangeTarget[] {
  const wanted = new Set(ids);
  // Leaves, for the group union. Groups are not in here: `placementsInDocument` yields leaves only, so a
  // group has to be located with `locateNode`, which reaches both.
  //
  // **Filtered to what actually paints.** Every box below is the box of something the user can see, because
  // alignment asks "line these up as I see them" and distribution asks where the gaps look. An invisible
  // object is neither on the page nor selectable (`selection.ts` refuses it), so letting it contribute
  // would align against geometry that is not there -- and, through a group's union, one hidden member at
  // (5000, 5000) would stretch a 60x40 union to 5010x5010.
  const leaves = placementsInDocument(doc).filter(isEffectivelyVisible);
  const targets: ArrangeTarget[] = [];
  const emitted = new Set<string>();

  const emit = (
    id: string,
    isGroup: boolean,
    transform: Transform2D,
    ancestors: readonly GroupNode[],
    /** Page-space transform of a **leaf**. Ignored for a group, whose box comes from its descendants. */
    leafWorld: Transform2D,
  ): void => {
    if (emitted.has(id)) return;
    emitted.add(id);
    const painted = boxFor(id, isGroup, leafWorld, leaves);
    // A group with nothing painted in it has no box and cannot be aligned; skipping it here is better
    // than giving it a zero box that would drag the union to a point.
    if (painted === null) return;
    targets.push({ id, transform, ancestors, painted });
  };

  for (const placement of leaves) {
    // A wanted ancestor is emitted at the position of its first descendant, outermost first. That is
    // where it sits in paint order, and it keeps the output in document order for a mixed selection
    // without a sort -- so the result cannot depend on `Set` iteration order or on click order.
    for (const ancestor of placement.ancestors) {
      if (!wanted.has(ancestor.id)) continue;
      // A group's box is its descendants' union, so its own page-space transform is never consulted.
      emit(ancestor.id, true, ancestor.transform, ancestorsOf(placement, ancestor.id), ancestor.transform);
    }
    if (wanted.has(placement.node.id)) {
      // `placement.transform` is the page-space form and is what `paintedBounds` needs; `node.transform`
      // is the authored parent-local form and is what a patch is built from. Passing the second to the
      // first is the bug this interface is now shaped to make impossible.
      emit(placement.node.id, false, placement.node.transform, placement.ancestors, placement.transform);
    }
  }

  // A wanted group with no visible descendants -- empty, every child invisible, or hidden itself -- is still
  // located, so that it is reported rather than silently absent. It contributes no target, because
  // `boxFor` gives it no box.
  //
  // **Only a group can reach here.** Every effectively-visible leaf was emitted by the loop above, so a leaf
  // that arrives is one that was filtered out as invisible and has no place on the page. Letting one
  // through would also hand `emit` the authored parent-local transform where `leafWorld` expects a
  // page-space one -- a wrong box rather than a missing one.
  for (const id of wanted) {
    if (emitted.has(id)) continue;
    const location = locateNode(doc, id);
    if (location === null || location.node.type !== 'group') continue;
    emit(location.node.id, true, location.node.transform, location.ancestors, location.node.transform);
  }

  return targets;
}

/** The chain above `ancestorId`, outermost first, for a placement that lies inside it. */
function ancestorsOf(
  placement: NodePlacement,
  ancestorId: string,
): readonly GroupNode[] {
  const index = placement.ancestors.findIndex((ancestor) => ancestor.id === ancestorId);
  return index <= 0 ? [] : placement.ancestors.slice(0, index);
}

/**
 * Can this operation do anything with this many targets?
 *
 * A **capability predicate**, stated once so the UI's disabled state and the model's own refusal cannot
 * disagree. It answers "is this operation available", not "would this particular alignment change
 * anything" -- the latter is the model's no-op rule, and predicting it here would be a second copy of it
 * that could disagree, exactly as the layer buttons' comment explains.
 */
export function canArrange(targets: readonly ArrangeTarget[], operation: ArrangeOperation): boolean {
  return operation.kind === 'align'
    ? targets.length >= MIN_ALIGN
    : targets.length >= MIN_DISTRIBUTE;
}

/** The reference box for a whole selection: the union of its members' painted boxes. */
export function arrangeBounds(targets: readonly ArrangeTarget[]): Rect | null {
  if (targets.length === 0) return null;
  return unionRects(targets.map((target) => target.painted));
}

/**
 * The page-space translation that puts `target`'s painted box where the operation wants it.
 *
 * Zero for every mode that does not move this particular target -- which is most of them, and is the
 * whole point: aligning left edges moves only the objects whose left edge is not already the leftmost.
 */
function alignmentDelta(
  target: ArrangeTarget,
  bounds: Rect,
  mode: AlignMode,
): Vec2 {
  const box = target.painted;
  switch (mode) {
    case 'left':
      return { x: bounds.x - box.x, y: 0 };
    case 'center-h':
      return { x: bounds.x + bounds.width / 2 - (box.x + box.width / 2), y: 0 };
    case 'right':
      return { x: bounds.x + bounds.width - (box.x + box.width), y: 0 };
    case 'top':
      return { x: 0, y: bounds.y - box.y };
    case 'center-v':
      return { x: 0, y: bounds.y + bounds.height / 2 - (box.y + box.height / 2) };
    case 'bottom':
      return { x: 0, y: bounds.y + bounds.height - (box.y + box.height) };
  }
}

/**
 * Sorts for distribution, deterministically.
 *
 * By the near edge on the axis, with **`id` as the tiebreaker**. The tiebreaker is not decoration: two
 * objects can share an edge exactly (left-aligned objects are the common case), and without it their
 * relative order would come from `Array.prototype.sort` stability applied to whatever order the input
 * arrived in -- which for a `Set` of selection ids is insertion order, i.e. the order the user clicked.
 * The *set* of resulting positions would be the same either way, but which object gets which position
 * would depend on click order, and a test asserting "b moved to 200" would pass or fail depending on how
 * the selection was made. Sorting by id makes the answer a function of the document alone.
 */
function sortForDistribution(
  targets: readonly ArrangeTarget[],
  axis: DistributeAxis,
): ArrangeTarget[] {
  const near = (target: ArrangeTarget): number =>
    axis === 'horizontal' ? target.painted.x : target.painted.y;
  return [...targets].sort((a, b) => {
    const delta = near(a) - near(b);
    return delta !== 0 ? delta : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * The page-space translation that distributes `targets` along `axis`.
 *
 * ## The rules, stated
 *
 * - **Sorted** by the near painted edge, `id` breaking ties (see {@link sortForDistribution}).
 * - **The first and last are fixed anchors.** They keep their positions; everything between them moves.
 *   This is what "distribute" means in every editor worth copying: the user has already positioned the
 *   two extremes and wants the middle ones spaced between them. It also makes the operation
 *   non-destructive at the edges, so a user who drags one object afterwards is not fighting it.
 * - **Spacing is equal gaps between painted edges**, not equal centres. `gap = (span - total extent) /
 *   (count - 1)`, and each middle object is placed so the gap before it equals that value. Equal *centres*
 *   is a different operation with a different answer whenever the objects differ in size, and this fixture
 *   set is built with deliberately unequal sizes so the two cannot be confused.
 * - **Negative gaps are allowed.** When the objects are wider than the span between the anchors, the
 *   computed gap is negative and the middle objects are still placed at it -- which separates them as far
 *   as the geometry permits. Refusing to distribute an overlapping selection would be worse: the user
 *   asked for even spacing and would get silence.
 * - **All already evenly spaced is a no-op**, and falls out of the arithmetic: every delta is zero, so
 *   `setTransform` returns the same references and no history entry appears. There is no epsilon test
 *   anywhere in this file, deliberately -- a tolerance here would be a second definition of "aligned"
 *   that could disagree with the no-op rule in `apply`.
 */
function distributionDeltas(
  targets: readonly ArrangeTarget[],
  axis: DistributeAxis,
): Map<string, Vec2> {
  const deltas = new Map<string, Vec2>();
  const sorted = sortForDistribution(targets, axis);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) return deltas;

  const horizontal = axis === 'horizontal';
  const near = (target: ArrangeTarget): number =>
    horizontal ? target.painted.x : target.painted.y;
  const extent = (target: ArrangeTarget): number =>
    horizontal ? target.painted.width : target.painted.height;

  const span = near(last) + extent(last) - near(first);
  const total = sorted.reduce((sum, target) => sum + extent(target), 0);
  const gap = (span - total) / (sorted.length - 1);

  // Walk from the first anchor, accumulating: each object's near edge is the previous object's far
  // edge plus `gap`. The last object's position is therefore whatever the arithmetic gives it, which for
  // an evenly-spaced selection is exactly where it already was -- that is the no-op, not a special case.
  let cursor = near(first) + extent(first) + gap;
  for (const target of sorted.slice(1, -1)) {
    const delta = cursor - near(target);
    // Recorded even when zero: whether this is a no-op is decided by the caller, which strips zero deltas
    // from every operation uniformly. Deciding it here as well would be a second place to get it wrong.
    deltas.set(target.id, horizontal ? { x: delta, y: 0 } : { x: 0, y: delta });
    cursor += extent(target) + gap;
  }
  return deltas;
}

/**
 * Computes the page-space translation for every object that actually moves, or `null` when the operation
 * cannot apply.
 *
 * ## Two kinds of nothing, kept apart
 *
 * - **`null`** -- the selection is too small. The operation is *unavailable*, which is what disables a
 *   control.
 * - **an empty map** -- the operation applies and moves nothing, because everything is already aligned
 *   or already distributed. This is the common case for a user who clicks align twice, and it must be
 *   distinguishable from the first, or the UI would grey out a control that would work.
 *
 * Zero deltas are therefore **omitted** rather than stored as `{x: 0, y: 0}`. That makes the no-op
 * observable as an empty map rather than as a map full of zeroes, and it means the caller does not need a
 * second zero check of its own -- a check that could disagree with this one about what counts as no-op.
 * Exact equality, deliberately: there is no epsilon anywhere in this file, because an epsilon would be a
 * second definition of "already aligned" that could disagree with the model's own no-op rule.
 */
export function arrangementDeltas(
  targets: readonly ArrangeTarget[],
  operation: ArrangeOperation,
): Map<string, Vec2> | null {
  if (!canArrange(targets, operation)) return null;

  const deltas = new Map<string, Vec2>();
  const record = (id: string, delta: Vec2): void => {
    if (delta.x === 0 && delta.y === 0) return;
    deltas.set(id, delta);
  };

  if (operation.kind === 'distribute') {
    for (const [id, delta] of distributionDeltas(targets, operation.axis)) record(id, delta);
    return deltas;
  }

  const bounds = arrangeBounds(targets);
  if (bounds === null) return null;
  for (const target of targets) {
    record(target.id, alignmentDelta(target, bounds, operation.mode));
  }
  return deltas;
}

/**
 * The new transform for a target, or `null` when nothing changes.
 *
 * **Translation only** -- the spread carries every other field through untouched, which is what keeps
 * `width`, `height`, `rotation` and both scales, and therefore stroke width, exactly as authored. There is
 * no code path here that can write any of them.
 */
export function translatedTransform(
  transform: Transform2D,
  deltaParent: Vec2,
): Transform2D {
  return { ...transform, x: transform.x + deltaParent.x, y: transform.y + deltaParent.y };
}
