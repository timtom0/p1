/**
 * Selection and hit testing (§3.4).
 *
 * Hit testing is done against the **model**, never with `document.elementFromPoint`.
 * That is deliberate and not an optimisation: the DOM knows about pixels, the model
 * knows about objects, and selection must respect `locked`, `visible`, groups and
 * object-specific shapes. `elementFromPoint` cannot answer those questions, and
 * during a text session it would answer them about the browser's DOM instead of the
 * document.
 *
 * Paint order gives the traversal order: later objects are on top, so a hit test
 * walks the object list backwards.
 */

import type { Document, Node } from '../model/types';
import type { NodePlacement } from '../model/tree';
import {
  locateNode,
  nodeById,
  nodeIdsOnPage,
  pageIdOf,
  placementsOnPage,
} from '../model/tree';
import { applyPoint, invert } from '../core/geom/mat2d';
import type { Vec2 } from '../core/geom/mat2d';
import { layoutBoxOf, shapeContainsPoint } from '../model/shapes';
import { rectContainsPoint } from '../core/geom/rect';

/** Where a hit landed, so a tool can react to the part that was grabbed. */
export type HitPart =
  | 'body'
  | 'handle:nw' | 'handle:n' | 'handle:ne' | 'handle:e'
  | 'handle:se' | 'handle:s' | 'handle:sw' | 'handle:w';

export interface Hit {
  nodeId: string;
  part: HitPart;
  /** Client coordinates of the hit, for tools that want them. */
  client: Vec2;
}

export interface SelectionState {
  /** Selected node ids. A `Set` because membership tests dominate. */
  ids: ReadonlySet<string>;
  /**
   * The id the inspector edits, and the one <kbd>Enter</kbd> opens a text session on.
   *
   * Not an ordering. `ids` is a `Set` precisely so that selection order and paint order stay
   * independent: a selection has no sequence, and `Page.objects` has the only one.
   *
   * Kept non-null whenever `ids` is non-empty — `removeFromSelection` re-points it rather than
   * clearing it, because a null `primary` with a non-empty `ids` would make the inspector read
   * "empty" while the overlay drew outlines.
   */
  primary: string | null;
  /** Hovered node id, for the hover outline. */
  hover: string | null;
}

export function emptySelection(): SelectionState {
  return { ids: new Set(), primary: null, hover: null };
}

export function selectionOf(ids: Iterable<string>, primary: string | null = null): SelectionState {
  const set = new Set(ids);
  return {
    ids: set,
    primary: primary ?? [...set][0] ?? null,
    hover: null,
  };
}

/**
 * Hit test a page, topmost-first.
 *
 * Returns the topmost hit, or `null` on empty space. `includeLocked` exists for
 * alt-cycle (drilling through to select a locked object deliberately).
 *
 * ## Recursive, and why that is not interaction
 *
 * `placementsOnPage` returns leaves in recursive paint order — `A, Group[B, C], D` flattens to
 * `A, B, C, D` — so the backwards walk below is the same loop it always was, over a longer list.
 * The *hit* on a group child is found by inverting the child's **composed** world matrix, which
 * absorbs every ancestor in one step.
 *
 * That a child is therefore hit-testable is a consequence, not a feature: M12's brief lists
 * "child selection inside groups" among the things not to build, and nothing here adds a group
 * gesture, an entry mode, or a way to select a group as a unit. But a document containing a group
 * whose children *render* and cannot be *hit* is a broken document, not a deferred feature — the
 * same argument as M11's F6, where a rendered-but-unframeable object was a bug. Recorded rather
 * than assumed; see ADR 0012 §10.
 */
export function hitTestPage(
  doc: Document,
  pageId: string,
  pagePoint: Vec2,
  options: { includeLocked?: boolean } = {},
): Hit | null {
  const page = doc.pages.find((candidate) => candidate.id === pageId);
  if (page === undefined) return null;

  const placements = placementsOnPage(page);
  for (let index = placements.length - 1; index >= 0; index -= 1) {
    const placement = placements[index];
    if (placement === undefined) continue;
    // A hidden or locked **group** hides or locks everything inside it, and the check is on the
    // ancestor chain rather than on the leaf -- otherwise hiding a group would leave its children
    // visible on the page and hit-testable, which is the kind of "invisible but live" object that
    // makes a document feel haunted.
    if (!isEffectivelyVisible(placement, options)) continue;
    if (hitNode(placement, pagePoint, options) !== null) {
      return { nodeId: placement.node.id, part: 'body', client: pagePoint };
    }
  }
  return null;
}

/**
 * Whether a leaf is painted, and permitted to be picked, given everything above it.
 *
 * Three rules, and the third is the one M12 introduced:
 *
 * 1. the leaf must be `visible`;
 * 2. the leaf must be unlocked, unless `includeLocked`;
 * 3. **every ancestor group must also be `visible`**, and unlocked under the same condition.
 *
 * Rule 3 is a deliberate departure from "the group is a container and nothing more". The
 * alternative -- a group's `visible: false` hiding nothing -- was rejected because a group is the
 * only thing that *can* hide a subtree, and leaving it inert would make `visible` mean something
 * different on a group than on every other node. ADR 0012 §10.
 */
function isEffectivelyVisible(
  placement: NodePlacement,
  options: { includeLocked?: boolean },
): boolean {
  const node = placement.node;
  if (!node.visible) return false;
  if (node.locked && options.includeLocked !== true) return false;
  for (const ancestor of placement.ancestors) {
    if (!ancestor.visible) return false;
    if (ancestor.locked && options.includeLocked !== true) return false;
  }
  return true;
}

function hitNode(
  placement: NodePlacement,
  pagePoint: Vec2,
  options: { includeLocked?: boolean },
): HitPart | null {
  const node = placement.node;
  if (!isEffectivelyVisible(placement, options)) return null;

  // Map the page point into the node's local box, where hit testing is simple. The
  // inverse of the object's own matrix absorbs position, rotation and scale in one
  // step, so a predicate never has to know about any of them.
  //
  // `placement.world` is the *composed* matrix, so every ancestor's translation, rotation and
  // scale are already in this one inverse. That is the whole recursive conversion
  //   page point -> inverse group transforms -> inverse own transform -> local predicate
  // collapsed into a single step -- and it is why the predicate below is unchanged and why a
  // group child needs no special case here. ADR 0011 §7 proved the composition is affine-invariant
  // for every kind.
  const local = applyPoint(invert(placement.world), pagePoint);

  // The predicate comes from the shape registry, not from a `switch` on the kind.
  //
  // This used to be `if (node.type === 'shape' && node.shape.kind === 'rect')`, which
  // is precisely what `BaseNode.type` forbids -- "never compared with `===` outside
  // `render/`" -- and would have grown a branch per kind. It was also *wrong* for
  // anything but a rectangle: a shared box early-out made an ellipse selectable in its
  // corners, and a zero-height line unselectable at all.
  if (node.type === 'shape') {
    return shapeContainsPoint(node, local, layoutBoxOf(node)) ? 'body' : null;
  }

  // A text frame's box is its own answer, so it needs no registry entry. This guard is
  // *not* optional: dropping it when the shape branch was added made every text frame
  // hit-testable everywhere on its page, because the old code had a single box early-out
  // above this point that covered both kinds. Found by a shape suite whose first symptom
  // was "every click selects the text frame".
  // An image lands here too, and that is correct rather than accidental: **an image is
  // selected by its object geometry, not by its visible pixels.** Measured - Chromium
  // hit-tests a fully transparent image pixel, and object-fit never changes the hit
  // region (ADR 0006 PROBE X and Y). So a pixel-accurate predicate would make the
  // editor *disagree* with the browser on every image with transparency, inverting the
  // property every other object type has. Alpha-aware hit testing is therefore
  // rejected on evidence, not deferred. If it is ever wanted, it needs a reason the
  // measurements above no longer supply.
  const { width, height } = node.transform;
  return rectContainsPoint({ x: 0, y: 0, width, height }, local) ? 'body' : null;
}

/**
 * Every leaf id on a page, in recursive paint order.
 *
 * Group ids are **not** included. A group is not selectable in M12 — there is no gesture for it —
 * so `Control+A` selects the things that can be drawn individually, and `pageNodeIds` is what
 * `Control+A` and the layer-order buttons both read. If a group's id appeared here it would be
 * selected by a key nobody asked for, and then every command targeting it would find a node with no
 * gesture to produce it. ADR 0012 §10.
 */
export function pageNodeIds(doc: Document, pageId: string): string[] {
  const page = doc.pages.find((candidate) => candidate.id === pageId);
  return page === undefined ? [] : nodeIdsOnPage(page);
}

/**
 * Finds the page containing a node id, at any depth.
 *
 * Delegated to `tree.ts` rather than re-walked here. The old version scanned
 * `page.objects.some(...)`, which could not see a group child at all -- so every consumer of this
 * function would have concluded a grouped object was **not on any page**, and every one of them
 * would have quietly gone inert for it. That is the failure mode a traversal exists to prevent.
 */
export function pageIdOfNode(doc: Document, nodeId: string): string | null {
  return pageIdOf(doc, nodeId);
}

/** The node with this id, anywhere in the document, if it exists. */
export function findNode(doc: Document, nodeId: string): Node | null {
  return nodeById(doc, nodeId);
}

/**
 * Selected nodes that still exist, in recursive paint order.
 *
 * The order matters: it is the order the inspector's mixed-field report reads and the order a
 * multi-selection's first member is taken from, and it now crosses group boundaries. Before M12 it
 * was "page order"; after, it is "paint order, flattened" -- which for a flat document is the
 * identical sequence, so no existing behaviour moved.
 */
export function selectedNodes(doc: Document, selection: SelectionState): Node[] {
  const out: Node[] = [];
  for (const page of doc.pages) {
    for (const placement of placementsOnPage(page)) {
      if (selection.ids.has(placement.node.id)) out.push(placement.node);
    }
  }
  return out;
}

/**
 * Selected nodes **with their page-space placements**, in recursive paint order.
 *
 * What chrome actually needs. `selectedNodes` returns bare `Node`s, whose `transform` is local to
 * their parent — so drawing a frame from it would put a grouped child's outline at the wrong place,
 * which is precisely the F6 bug M11 fixed and would reintroduce one level down. The pair is returned
 * together so no caller has to remember to look the placement up.
 */
export function selectedPlacements(
  doc: Document,
  selection: SelectionState,
): { node: Node; placement: NodePlacement }[] {
  const out: { node: Node; placement: NodePlacement }[] = [];
  for (const page of doc.pages) {
    for (const placement of placementsOnPage(page)) {
      if (selection.ids.has(placement.node.id)) {
        out.push({ node: placement.node, placement });
      }
    }
  }
  return out;
}

/**
 * Whether `nodeId` is somewhere inside `ancestorId`, at any depth.
 *
 * Model ancestry, not DOM containment -- there is no DOM containment to ask about, because groups are
 * not rendered. `locateNode` is the answer; this is the one-line spelling of "read the ancestor chain
 * and look", used by group entry.
 */
export function isDescendantOf(doc: Document, nodeId: string, ancestorId: string): boolean {
  return locateNode(doc, nodeId)?.ancestors.some((group) => group.id === ancestorId) ?? false;
}

/**
 * Enforces the ancestor/descendant invariant on a selection, keeping the **outermost** of each pair.
 *
 * ## Why the invariant exists
 *
 * A selection containing both a group and something inside it makes three commands indeterminate, and
 * none of them is a small ambiguity:
 *
 * - `group` cannot both take a node and put it in a new group when it is already inside another one;
 * - `ungroup` has no determinate answer, because the descendant's fate depends on which of the two the
 *   user meant;
 * - `remove` would name a node that removing the ancestor already took with it.
 *
 * ## Why outermost wins
 *
 * Keeping the descendant and dropping the ancestor is the alternative, and it is worse: the ancestor is
 * the thing the user can see and manipulate, and every command that would apply to the descendant
 * applies to the ancestor too -- moving it moves the descendant, deleting it deletes the descendant. So
 * keeping the descendant would be keeping the less useful of the two.
 *
 * ## Where it runs
 *
 * Called from `Editor.setSelection`, which every producer of a selection goes through. Enforcing it at
 * each producer instead would mean every future producer had to remember, and "prevent or normalise it
 * explicitly" is only honest if there is one door.
 *
 * ## Cost
 *
 * One `locateNode` per selected id. That is not free, and it runs on every pointer-down including a
 * marquee drag; it is paid because the alternative is a class of bug where `group` silently reorders a
 * user's document, which is much worse than a few microseconds.
 */
export function normaliseSelection(doc: Document, selection: SelectionState): SelectionState {
  if (selection.ids.size < 2) return selection;
  const kept = new Set(selection.ids);
  // Drop any selected node that has a **selected ancestor**. Iterating and deleting the current element
  // of a `Set` is safe, and only `id` itself is ever removed -- an ancestor is never deleted, which is
  // what makes "outermost wins" true rather than merely intended.
  //
  // The first version of this walked each node's ancestors and deleted *those*, which keeps the
  // descendant -- the exact opposite of the rule its own doc comment stated. The unit test caught it,
  // and it is worth recording that the bug was a plausible-looking loop rather than a typo: "for each
  // selected id, resolve its ancestors" reads naturally and answers the inverse question.
  for (const id of [...kept]) {
    const location = locateNode(doc, id);
    if (location === null) continue;
    if (location.ancestors.some((ancestor) => kept.has(ancestor.id))) kept.delete(id);
  }
  if (kept.size === selection.ids.size) return selection;
  const primary = selection.primary !== null && kept.has(selection.primary)
    ? selection.primary
    : ([...kept][0] ?? null);
  return { ...selection, ids: kept, primary };
}

/**
 * The common frame of the selection, or `null` when nothing is selected.
 *
 * "Common" means identical values are reported once and differing values are
 * reported as `null`, so the inspector shows a blank field for a mixed selection
 * rather than an arbitrary member's value (§5.2).
 */
export function commonFrame(doc: Document, selection: SelectionState) {
  const nodes = selectedNodes(doc, selection);
  if (nodes.length === 0) return null;

  const first = nodes[0];
  if (first === undefined) return null;
  const fields = ['x', 'y', 'width', 'height', 'rotation'] as const;

  const frame: Record<string, number | null> = {};
  for (const field of fields) {
    const value = first.transform[field];
    const shared = nodes.every((node) => node.transform[field] === value);
    frame[field] = shared ? value : null;
  }
  return frame as Record<(typeof fields)[number], number | null>;
}
