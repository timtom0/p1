/**
 * Snapping during a move gesture, and nothing else.
 *
 * ## Pure, and deliberately so
 *
 * This module takes geometry and returns a page-space adjustment. It touches no DOM, measures nothing, and
 * knows nothing about the viewport, the overlay or the pointer. That is what makes it testable at thresholds
 * and zoom levels no browser test could reach, and it is why ADR 0017 could specify the whole resolution
 * rule without a single DOM coordinate in it.
 *
 * ## Where the boxes come from
 *
 * **M16's `arrangeTargets` and `arrangeBounds`, unchanged.** Snapping has no definition of "where an object
 * is": a leaf is its own `paintedBounds`, a group is the union of its descendants' painted bounds, and both
 * come from the one function alignment already uses. A second definition is the specific failure ADR 0011b
 * §2 describes -- four ideas of "bounds", used for everything -- and this milestone does not add a fifth.
 *
 * ## The threshold, and why it is divided by zoom
 *
 * The gesture's delta is in **document px** (`pagePointFromClient` has already converted the pointer), so
 * the distance being compared is a document-space distance. Comparing it to a screen-space constant would
 * make the effective threshold `10 * zoom` document px -- 2.5px of document space at 25% zoom and 40px at
 * 400%, i.e. dead when zoomed out and magnetic when zoomed in, and **exactly right at 100%**, which is the
 * only zoom the suite tests at by default.
 *
 * So {@link snapThresholdDocument} divides, and is exported and tested at several zooms rather than being
 * inlined at the call site. A tolerance that is only correct at the default zoom is not a tolerance.
 *
 * ## Resolution
 *
 * Independent per axis, so **both can be active at once** -- a drag towards a corner wants both. On one
 * axis, the smallest absolute distance within the threshold wins; ties go to the earlier candidate in a
 * fixed, total scan order (page features first, then objects in document order) by using a strict `<`, so
 * the first candidate at the minimum is kept. Nothing iterates a `Set`.
 *
 * Page edges are scanned first deliberately: page geometry is stable for as long as the document is, whereas
 * an object candidate may be about to move. Snapping to the stable thing is what stops a drag chasing a
 * target that is in motion. See ADR 0017 §3.
 */

import { arrangeBounds, arrangeTargets, type ArrangeTarget } from './arrange';
import { pageExtentPx } from './page';
import { placementsInDocument } from './tree';
import type { Rect } from '../core/geom/rect';
import type { Vec2 } from '../core/geom/mat2d';
import type { Document, PageSize } from './types';

/** The snap threshold, in **screen** pixels. See {@link snapThresholdDocument}. */
export const SNAP_THRESHOLD_SCREEN_PX = 10;

/**
 * The same threshold expressed in **document** pixels at a given zoom.
 *
 * Divided, not multiplied: the gesture's delta is already in document px, so this is the value the
 * comparison must use for the snap to *feel* like 10 screen px at any zoom.
 *
 * At 25% a screen pixel is four document px, so the threshold is 40; at 400% it is 2.5. Both are the same
 * 10 screen px.
 */
export function snapThresholdDocument(zoom: number): number {
  // A zoom of 0 or below is not a viewport state, but dividing by it would produce Infinity and silently
  // snap to everything, so it is clamped. Cheap, and it cannot be reached from `Viewport`.
  return SNAP_THRESHOLD_SCREEN_PX / Math.max(zoom, Number.EPSILON);
}

/** Which edge or centre a snap is measuring. Named, because guides and tests refer to them. */
export type SnapFeature = 'left' | 'center-h' | 'right' | 'top' | 'center-v' | 'bottom';

export interface SnapAxis {
  readonly axis: 'x' | 'y';
  /** The feature of the **moving** box that is being snapped. Which one is a guide fact, not a rule. */
  readonly feature: SnapFeature;
  /** The page-space coordinate being snapped to. */
  readonly position: number;
  /** The object or page that owns it. `null` for a page edge. */
  readonly targetId: string | null;
  /** The page it belongs to, for the guide. */
  readonly pageId: string;
  /** The signed correction applied to the moving box on this axis. */
  readonly delta: number;
}

/** The result of one snap evaluation: what was snapped, and by how much. */
export interface SnapResult {
  /** Page-space correction to add to the raw pointer delta. `null` when nothing qualified. */
  readonly adjustment: Vec2;
  readonly axes: readonly SnapAxis[];
}

/** Everything the calculation needs. No document, no viewport, no DOM. */
export interface SnapInput {
  /** The moving arrangement's page-space box, at the **unsnapped** position. */
  readonly moving: Rect;
  /** The page the movement is on. Page candidates come from this page's own extent. */
  readonly pageId: string;
  /** Page size, for the page's edge and centre candidates. */
  readonly pageRect: Rect;
  /** Nearby objects' page-space painted boxes, already excluding the moving selection. */
  readonly others: readonly ArrangeTarget[];
  /** Threshold in **document** px -- from {@link snapThresholdDocument}, not a literal. */
  readonly threshold: number;
}

/** The three features of a box on one axis, in the order they are scanned. */
function featuresOn(
  rect: Rect,
  axis: 'x' | 'y',
): readonly { feature: SnapFeature; position: number }[] {
  return axis === 'x'
    ? [
        { feature: 'left', position: rect.x },
        { feature: 'center-h', position: rect.x + rect.width / 2 },
        { feature: 'right', position: rect.x + rect.width },
      ]
    : [
        { feature: 'top', position: rect.y },
        { feature: 'center-v', position: rect.y + rect.height / 2 },
        { feature: 'bottom', position: rect.y + rect.height },
      ];
}

/** The page's own features. Scanned first, so a tie goes to the stable geometry (ADR 0017 §3). */
function pageFeatures(
  pageRect: Rect,
  axis: 'x' | 'y',
): readonly { feature: SnapFeature; position: number; targetId: null }[] {
  return featuresOn(pageRect, axis).map((entry) => ({ ...entry, targetId: null }));
}

/**
 * The best snap on one axis, or `null`.
 *
 * The scan is a flat, ordered walk with a strict `<`, so the first candidate at the minimum distance wins and
 * the outcome is a function of the geometry alone -- never of a `Set`'s iteration order or the order the
 * user happened to click the selection.
 */
function bestOnAxis(
  moving: Rect,
  axis: 'x' | 'y',
  pageRect: Rect,
  others: readonly ArrangeTarget[],
  threshold: number,
  pageId: string,
): SnapAxis | null {
  type Candidate = {
    feature: SnapFeature;
    position: number;
    targetId: string | null;
    ownerPage: string;
  };

  // Page first, then objects in the order `arrangeTargets` produced them (document order).
  const candidates: Candidate[] = [];
  for (const entry of pageFeatures(pageRect, axis)) {
    candidates.push({ ...entry, ownerPage: pageId });
  }
  for (const other of others) {
    for (const entry of featuresOn(other.painted, axis)) {
      candidates.push({ ...entry, targetId: other.id, ownerPage: pageId });
    }
  }

  const movingFeatures = featuresOn(moving, axis);

  let best: { candidate: Candidate; feature: SnapFeature; delta: number } | null = null;
  for (const feature of movingFeatures) {
    for (const candidate of candidates) {
      const delta = candidate.position - feature.position;
      const distance = Math.abs(delta);
      // Outside the threshold: not a candidate at all.
      if (distance > threshold) continue;
      // Strict `<`: an equal-distance candidate does not displace the one already found, which is what
      // makes the scan order the tie-break.
      if (best === null || distance < Math.abs(best.delta)) {
        best = { candidate, feature: feature.feature, delta };
      }
    }
  }

  if (best === null) return null;
  return {
    axis,
    feature: best.feature,
    position: best.candidate.position,
    targetId: best.candidate.targetId,
    pageId: best.candidate.ownerPage,
    delta: best.delta,
  };
}

/**
 * The page-space adjustment that snaps a moving box to the nearest candidates.
 *
 * **Pure.** Returns `{ adjustment: {x: 0, y: 0}, axes: [] }` when nothing is within the threshold, which is
 * the common case and is indistinguishable at the call site from "no snapping is available".
 */
export function computeSnap(input: SnapInput): SnapResult {
  const x = bestOnAxis(
    input.moving,
    'x',
    input.pageRect,
    input.others,
    input.threshold,
    input.pageId,
  );
  const y = bestOnAxis(
    input.moving,
    'y',
    input.pageRect,
    input.others,
    input.threshold,
    input.pageId,
  );

  // Both axes independently, so a drag towards a corner snaps on both.
  return {
    adjustment: { x: x === null ? 0 : x.delta, y: y === null ? 0 : y.delta },
    axes: [...(x === null ? [] : [x]), ...(y === null ? [] : [y])],
  };
}

/**
 * Translate a box by a page-space delta.
 *
 * **Pure, and this is load-bearing rather than tidy.** The first version of this took the document and the
 * selection and re-derived the union on every pointer move, which was wrong: `applyMove` dispatches the
 * move's `setTransform` batch *before* the next `pointermove` arrives, so the document already held the
 * **previous frame's snapped position**. Re-deriving from it and translating by the new delta applied the
 * delta twice, and once a snap had fired the error compounded. It surfaced as a drag that snapped to a
 * candidate 140px from the object on screen, and as a drag that refused to snap where it clearly should.
 *
 * The gesture now captures its arrangement's box once, at pointer-down, before anything has moved, and
 * every frame is arithmetic on that. Nothing in the snapping path reads live document state.
 */
export function translateBounds(rect: Rect, delta: Vec2): Rect {
  return { ...rect, x: rect.x + delta.x, y: rect.y + delta.y };
}

/**
 * The moving arrangement's box at gesture start: the union of the selection's painted bounds.
 *
 * **A multi-selection is one arrangement.** Members are not snapped independently -- they would end up at
 * different alignments than the user dragged toward, and the selection would visibly come apart.
 *
 * Called once, at pointer-down. See {@link translateBounds} for why it must not be called per frame.
 */
export function movingBounds(doc: Document, ids: Iterable<string>): Rect | null {
  return arrangeBounds(arrangeTargets(doc, ids));
}

/**
 * Every object that could be a snap target: the whole document minus the moving selection **and everything
 * inside it**.
 *
 * ## Two things this has to get right, and initially got wrong
 *
 * **Groups are targets.** `allNodes` returns *leaves only*, by design ("a group is not a painted thing"),
 * so using it here silently excluded every group from being a snap target -- and a group is exactly the
 * kind of thing a user aligns a dragged object against. Group ids are therefore taken from the `ancestors`
 * chain of the placements, which is also precisely the set of groups that *can* be a target: a group with no
 * placed descendant has no painted box, and {@link arrangeTargets} would drop it anyway.
 *
 * **A selection excludes its own contents, not just its own ids.** `normaliseSelection` guarantees a
 * selection never contains both a node and one of its descendants, so `['grp']` does *not* name `grp`'s
 * members -- and members are leaves, so they were still being offered as targets. A group would therefore
 * snap to its own member. Each candidate's ancestor chain is checked against the excluded set, which removes
 * the contents along with the group.
 */
export function snapTargetsFor(doc: Document, exclude: Iterable<string>): ArrangeTarget[] {
  const skip = new Set(exclude);
  const leaves = placementsInDocument(doc);

  const groupIds = new Set<string>();
  for (const placement of leaves) {
    for (const ancestor of placement.ancestors) groupIds.add(ancestor.id);
  }

  const ids: string[] = [];
  for (const placement of leaves) {
    if (skip.has(placement.node.id)) continue;
    if (placement.ancestors.some((ancestor) => skip.has(ancestor.id))) continue;
    ids.push(placement.node.id);
  }
  for (const id of groupIds) {
    if (!skip.has(id)) ids.push(id);
  }

  // Document order, and free of `Set` iteration order: `arrangeTargets` walks the placements and emits a
  // wanted group at the position of its first descendant, so the result does not depend on the order ids
  // were collected in above.
  return arrangeTargets(doc, ids);
}

/** The page's own box, which is where the page-edge candidates come from. */
export function pageSnapRect(page: { readonly pageSize: PageSize }): Rect {
  const extent = pageExtentPx(page.pageSize);
  return { x: 0, y: 0, width: extent.width, height: extent.height };
}
