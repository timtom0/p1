/**
 * The one traversal that knows where a node is.
 *
 * ## Why this module exists
 *
 * M12 made the document tree recursive. Before it, every consumer walked `page.objects` and treated
 * `x/y/width/height` as page coordinates, which was correct precisely because the page was the
 * only parent there was. A group adds a level, and the tempting fix — have each consumer compose
 * matrices itself — produces the failure mode ADR 0008 §13.1 already warns about: two elements
 * answering to one fact, with no owner. A consumer that forgets the group matrix gets an object in
 * the wrong place, and nothing fails loudly.
 *
 * So there is exactly **one** function that walks the hierarchy, and it hands every consumer both
 * the node and the matrix that places it. Consumers do not walk ancestors; they receive the answer.
 *
 * ## The recursion, stated once
 *
 * ```
 * page (identity)
 *   └── node          W = parentW · worldMatrix(node.transform)
 *         └── group's children   parentW = W
 *               └── child        W = parentW · worldMatrix(child.transform)
 * ```
 *
 * `worldMatrix(transform)` alone is a node's map *into its parent*, which is what it has always
 * been (ADR 0011 §3). Composition is the new step, and it is `multiply` — the existing utility,
 * not a second matrix implementation.
 *
 * ## Nesting is allowed, and it needs no special cases
 *
 * A group may contain a group, to any depth (bounded by {@link MAX_GROUP_DEPTH}, which exists only
 * to keep a hand-built cyclic model from hanging a traversal). The recursion below is the same at
 * every level: there is no "top-level" branch and no "child" branch. That is the whole argument for
 * permitting nesting — a model that needs a special case at depth two needs another at depth three.
 *
 * Cycles are caught by the existing duplicate-id rule rather than by a separate check, because a
 * cycle in a value tree necessarily visits some id twice; see `invariants.ts` and ADR 0012 §4.
 */

import type { GroupNode, Node, Page, Transform2D } from './types';
import type { Document } from './types';
import type { Mat2D } from '../core/geom/mat2d';
import { identity } from '../core/geom/mat2d';
import { worldMatrixIn, worldTransformIn } from './transform';

/**
 * How deep a group may nest.
 *
 * A bound on *reachability*, not on expressiveness: every depth a document can actually contain is
 * expressible, because nothing in the format, the renderer or the traversal assumes a small number.
 * It exists so that a cyclic object graph — constructible in JavaScript, impossible in JSON — fails
 * with a document error instead of exhausting the stack.
 *
 * 64 is far beyond anything a person would author and far below anything that hurts.
 */
export const MAX_GROUP_DEPTH = 64;

/** Narrowing helper. `Node['type']` is `string` on `BaseNode`, so `===` is needed somewhere. */
export function isGroup(node: Node): node is GroupNode {
  return node.type === 'group';
}

/**
 * The transform of the page itself: a zero-sized frame at the origin, no rotation, unit scale.
 *
 * The page is the root of every chain and it has **no** authored transform — a page is not an
 * object and cannot be moved or rotated — so its contribution is the identity, stated as a value
 * rather than as a special case in the composition. `worldTransformIn(child, this)` therefore
 * returns `child`'s own frame, which is what makes a flat document's placements identical to what
 * the renderer did before M12.
 */
const IDENTITY_TRANSFORM: Transform2D = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
};

/**
 * A node together with the matrix that places it in **page-local** coordinates.
 *
 * `world` is the full composed matrix, translation included. A consumer that positions chrome
 * wants the translation; one that hits tests wants `invert(world)`. Neither should recompose it.
 */
export interface NodePlacement {
  readonly node: Node;
  /** Page-local matrix: local coordinates -> page coordinates. */
  readonly world: Mat2D;
  /**
   * The same placement **as a `Transform2D`**, expressed about the node's own box centre.
   *
   * Available because every scale in a chain is uniform, which makes the composed linear part
   * `R(t)·S(s)` exactly — see {@link worldTransformIn} for the algebra and why there is no
   * decomposition and no reflection question.
   *
   * Both forms are given because different consumers need different ones, and giving each its own
   * conversion is how they would drift:
   *
   * | need | use |
   * |---|---|
   * | write `left`/`top`/`width`/`height`/`matrix(...)` — the renderer, and the selection frame | `transform` |
   * | `invert(world)` for hit testing, or any arithmetic | `world` |
   *
   * `src/model/tree.test.ts` asserts `worldMatrix(placement.transform) === placement.world` for a
   * set of chains, so the two spellings cannot disagree.
   */
  readonly transform: Transform2D;
  /** 0 for a page's direct children, 1 for their children, and so on. */
  readonly depth: number;
  /** The enclosing group chain, outermost first. Empty for a page's direct children. */
  readonly ancestors: readonly GroupNode[];
}

/**
 * A node's children in paint order, or nothing for a leaf.
 *
 * Flattened immediately: there is no `childrenOf(group)` that returns groups' children for painting,
 * because painting wants leaves and every consumer of a paint list wants leaves.
 */
export function childrenOf(node: Node): readonly Node[] {
  return isGroup(node) ? node.children : EMPTY_NODES;
}

const EMPTY_NODES: readonly Node[] = Object.freeze([]);

/**
 * Every leaf on a page, in recursive paint order.
 *
 * ## The order, and why it is the order asked for
 *
 * For a page holding `A`, `Group G [B, C]`, `D`, the result is **`A, B, C, D`**. A group occupies
 * exactly one slot in its parent's array and paints its children at that slot, in array order.
 *
 * That is depth-first flattening, and it is what makes the rest of the system simpler: the paint
 * stack is still a **flat list**, so the reconciler, `z-index`-free ordering, `restack`'s relative
 * rules and every existing DOM contract are untouched. Only the *matrix* is recursive.
 *
 * The alternative — a nested DOM subtree per group — would make each group a stacking context and
 * put a group's `opacity`/`blendMode` in charge of its children in a way that is hard to undo. A
 * group here is a *coordinate frame*, not a rendering box. ADR 0012 §5.
 */
export function placementsOnPage(page: Page): NodePlacement[] {
  const out: NodePlacement[] = [];
  for (const node of page.objects) {
    collectPlacements(node, identity(), IDENTITY_TRANSFORM, 0, [], out);
  }
  return out;
}

function collectPlacements(
  node: Node,
  parentWorld: Mat2D,
  parentTransform: Transform2D,
  depth: number,
  ancestors: readonly GroupNode[],
  out: NodePlacement[],
): void {
  const world = worldMatrixIn(node.transform, parentWorld);
  const transform = worldTransformIn(node.transform, parentTransform);
  if (!isGroup(node)) {
    out.push({ node, world, transform, depth, ancestors });
    return;
  }
  const nextAncestors = [...ancestors, node];
  for (const child of node.children) {
    collectPlacements(child, world, transform, depth + 1, nextAncestors, out);
  }
}

/** Every leaf in the document, page by page, in recursive paint order. */
export function placementsInDocument(doc: Document): NodePlacement[] {
  const out: NodePlacement[] = [];
  for (const page of doc.pages) {
    for (const node of page.objects) {
      collectPlacements(node, identity(), IDENTITY_TRANSFORM, 0, [], out);
    }
  }
  return out;
}

/** Every leaf id in the document, in recursive paint order. Duplicates are impossible; see invariants. */
export function nodeIdsInPaintOrder(doc: Document): string[] {
  return placementsInDocument(doc).map((placement) => placement.node.id);
}

/** Every leaf id on one page, in recursive paint order. */
export function nodeIdsOnPage(page: Page): string[] {
  return placementsOnPage(page).map((placement) => placement.node.id);
}

/** The placement of a node, searching every page. `null` if no such node exists. */
export function placementOf(doc: Document, nodeId: string): NodePlacement | null {
  for (const page of doc.pages) {
    for (const node of page.objects) {
      const found = findPlacementIn(node, nodeId, identity(), IDENTITY_TRANSFORM, 0, []);
      if (found !== null) return found;
    }
  }
  return null;
}

/** As {@link placementOf}, but without a document — for a page already in hand. */
export function placementOnPage(page: Page, nodeId: string): NodePlacement | null {
  for (const node of page.objects) {
    const found = findPlacementIn(node, nodeId, identity(), IDENTITY_TRANSFORM, 0, []);
    if (found !== null) return found;
  }
  return null;
}

function findPlacementIn(
  node: Node,
  nodeId: string,
  parentWorld: Mat2D,
  parentTransform: Transform2D,
  depth: number,
  ancestors: readonly GroupNode[],
): NodePlacement | null {
  const world = worldMatrixIn(node.transform, parentWorld);
  const transform = worldTransformIn(node.transform, parentTransform);
  if (!isGroup(node)) {
    return node.id === nodeId ? { node, world, transform, depth, ancestors } : null;
  }
  for (const child of node.children) {
    const found = findPlacementIn(
      child,
      nodeId,
      world,
      transform,
      depth + 1,
      [...ancestors, node],
    );
    if (found !== null) return found;
  }
  return null;
}

/**
 * Where a node lives: the array that owns it, and its position in it.
 *
 * This is what a *structural* command needs — one that moves or removes a node rather than changing
 * it. `mapNodesById` covers the other kind without knowing any of this.
 */
export interface NodeLocation {
  readonly node: Node;
  /** The page or group whose `objects`/`children` array holds `node`. */
  readonly owner: Page | GroupNode;
  readonly index: number;
  /** The page the node is on, however deeply nested. */
  readonly pageId: string;
  /** Group chain outermost first; empty when `owner` is the page. */
  readonly ancestors: readonly GroupNode[];
}

/** Locate a node for a structural edit, or `null` if it does not exist. */
export function locateNode(doc: Document, nodeId: string): NodeLocation | null {
  for (const page of doc.pages) {
    const found = locateIn(page, page.objects, nodeId, []);
    if (found !== null) return { ...found, pageId: page.id };
  }
  return null;
}

function locateIn(
  page: Page,
  siblings: readonly Node[],
  nodeId: string,
  ancestors: readonly GroupNode[],
): Omit<NodeLocation, 'pageId'> | null {
  for (let index = 0; index < siblings.length; index += 1) {
    const node = siblings[index];
    if (node === undefined) continue;
    if (node.id === nodeId) {
      const owner = ancestors.length === 0 ? page : (ancestors[ancestors.length - 1] as GroupNode);
      return { node, owner, index, ancestors };
    }
    if (isGroup(node)) {
      const found = locateIn(page, node.children, nodeId, [...ancestors, node]);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * The page a node belongs to, however deeply nested.
 *
 * Replaces the old `page.objects.some(...)` scan, which could not see a group child at all — the
 * kind of gap that produces "the object renders but every command on it is inert".
 */
export function pageIdOf(doc: Document, nodeId: string): string | null {
  for (const page of doc.pages) {
    if (placementOnPage(page, nodeId) !== null) return page.id;
  }
  return null;
}

/**
 * The node with this id, anywhere in the document, **including a group**, or `null`.
 *
 * Searched with {@link locateNode}, not {@link placementOf}, and the distinction is the point:
 *
 * | function | finds | why |
 * |---|---|---|
 * | `nodeById` | leaves **and** groups | "the node with this id" -- a group is a node |
 * | `placementOf` | leaves only | "where does this paint" -- a group has no paint of its own |
 *
 * Asking `placementOf` for a group returns `null`, which reads as "no such node" and is wrong. Two
 * tests in `tree.test.ts` failed on exactly that before the two were separated: an empty group was
 * "missing" from a document that contained it.
 */
export function nodeById(doc: Document, nodeId: string): Node | null {
  return locateNode(doc, nodeId)?.node ?? null;
}

/**
 * Every **leaf** in the document, in recursive paint order.
 *
 * Leaves only, for the same reason `placementOf` is: a group is not a painted thing, and counting or
 * listing one where an object was meant is the sort of quiet wrongness this project keeps paying for.
 */
export function allNodes(doc: Document): Node[] {
  return placementsInDocument(doc).map((placement) => placement.node);
}

/**
 * Applies `fn` to matching nodes at **every** depth, rebuilding only the arrays on a changed path.
 *
 * The recursion rebuilds a group only if one of its descendants actually changed, so a command that
 * matches nothing returns the original document **by reference** — the property the renderer's
 * reference-equality "unchanged" signal and `History`'s no-op rule both depend on (ADR 0009 §5).
 *
 * `null` from the recursive helpers means "unchanged", and that is what keeps an untouched
 * subtree at zero cost. Returning a fresh equal array instead would make every pointer move during
 * a drag rebuild the whole page, and would make `apply` return a new document for a command that
 * changed nothing — which the no-op rule treats as an undo step.
 */
export function mapNodesByIdIn(
  doc: Document,
  ids: ReadonlySet<string>,
  fn: (node: Node) => Node,
): Document {
  let changed = false;
  const pages = doc.pages.map((page) => {
    const objects = mapList(page.objects, ids, fn);
    if (objects === null) return page;
    changed = true;
    return { ...page, objects };
  });
  return changed ? { ...doc, pages } : doc;
}

/** `null` for "nothing in this list changed", which is the caller's cue to keep the old array. */
function mapList(
  nodes: readonly Node[],
  ids: ReadonlySet<string>,
  fn: (node: Node) => Node,
): Node[] | null {
  let changed = false;
  const out = nodes.map((node) => {
    let next = node;
    // A group's *own* fields are edited here, and its descendants below. Both can match, so this
    // is not an `else` — editing a group and one of its children in one command is legal.
    if (ids.has(node.id)) {
      const replaced = fn(node);
      if (replaced !== node) {
        changed = true;
        next = replaced;
      }
    }
    if (isGroup(next)) {
      const children = mapList(next.children, ids, fn);
      if (children !== null) {
        changed = true;
        next = { ...next, children };
      }
    }
    return next;
  });
  return changed ? out : null;
}

/**
 * Removes nodes by id from anywhere in the tree.
 *
 * A removed group takes its whole subtree with it, and only the **named** ids are removed: deleting
 * a group does not separately delete its children, because they went with it — there is nothing left
 * for them to be removed from. Order is otherwise preserved, and an id that matches nothing is
 * inert, returning the original document by reference.
 */
export function removeNodesById(doc: Document, ids: ReadonlySet<string>): Document {
  if (ids.size === 0) return doc;
  let changed = false;
  const pages = doc.pages.map((page) => {
    const objects = removeFrom(page.objects, ids);
    if (objects === null) return page;
    changed = true;
    return { ...page, objects };
  });
  return changed ? { ...doc, pages } : doc;
}

function removeFrom(nodes: readonly Node[], ids: ReadonlySet<string>): Node[] | null {
  let changed = false;
  const out: Node[] = [];
  for (const node of nodes) {
    if (ids.has(node.id)) {
      changed = true;
      continue;
    }
    if (isGroup(node)) {
      const children = removeFrom(node.children, ids);
      if (children !== null) {
        changed = true;
        out.push({ ...node, children });
        continue;
      }
    }
    out.push(node);
  }
  return changed ? out : null;
}