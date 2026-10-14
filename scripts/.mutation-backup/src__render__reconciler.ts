/**
 * Keyed model → DOM reconciler.
 *
 * The document surface is a *projection* of the model: this class turns a
 * `Node[]` into a DOM subtree, and re-runs cheaply when the model changes. It
 * deliberately does four things and nothing else (docs/ARCHITECTURE.md §2.3):
 *
 *   1. structure — keyed children diff (insert / remove / reorder / update)
 *   2. identity  — an id → element map, so lookups are O(1)
 *   3. style     — writes only CSS properties whose values actually changed
 *   4. recursion — descends into children via the renderer
 *
 * It does no measuring, no reading of layout, no event handling, and no
 * business logic. Those belong to other modules.
 *
 * Invariant it relies on: an object element contains only object elements, so
 * `parent.childNodes` is exactly the set this reconciler manages. A renderer
 * that needs auxiliary children (SVG `<defs>`, say) must nest them inside its own
 * element rather than as siblings of the object elements.
 */

import type { Node } from '../model/types';
import type { RenderCtx } from './render-context';

export interface ObjectRenderer<P extends Node = Node> {
  /** Must equal `node.type`; this is the registry key. */
  readonly type: string;
  /**
   * Create a detached element for this node. Receives the node so a renderer can
   * stamp stable identity onto the element (see `shape.ts` writing `data-oid`).
   */
  create(ctx: RenderCtx, node: P): HTMLElement;
  /** Project `node` onto `el`. Must be idempotent. */
  update(el: HTMLElement, node: P, prev: P | undefined, ctx: RenderCtx): void;
  /** Child nodes to reconcile *inside* `el`. Omit for leaves. */
  children?(node: P): readonly Node[];

  /**
   * Runs immediately after `update`, so a renderer can normalise state that an
   * early return inside `update` would have left inconsistent.
   *
   * Added by the §10.3 spike: the text renderer must mark and unmark its editing
   * state on every path, and a no-change fast return gave it no way to do that.
   */
  afterUpdate?(element: HTMLElement, node: P, ctx: RenderCtx): void;
}

/**
 * Publishes an object's identity onto its element, and does nothing else.
 *
 * ## Why this is here and not in each renderer
 *
 * `data-oid` and `data-type` were written by all three renderers, in two different notations
 * (`dataset.oid` and `dataset['oid']`). One semantic attribute with three owners is the same
 * shape of hazard as a `zIndex` beside the array order: a new object type can spell it wrong or
 * omit it, and nothing notices until a test fails for an unrelated reason. The reconciler
 * already holds both values -- it looked the renderer up by `node.type`, and it keys the element
 * map by `node.id` -- so identity is its invariant to keep.
 *
 * ## The two attributes mean different things and must not be conflated
 *
 * - `data-oid` is **object identity**, and it is unique per object across the whole document.
 * - `data-type` is the node's `type`, for tests and the devtools inspector. It is *not* a
 *   discriminator the application dispatches on: `BaseNode.type` is compared with `===` only
 *   inside `render/` (ADR 0003), and the model reaches for the shape registry instead.
 *
 * The editor's overlay stamps `data-for`, never `data-oid` — see ADR 0008 §13.1. A selector
 * that matched both would make one object look like two, and Playwright reports that as a
 * strict-mode violation on a locator that had looked reasonable.
 *
 * Stamped on creation only. A `data-oid` that could change would mean the reconciler's key and
 * the DOM's identity had diverged, and the element would be unreachable by its own id.
 */
function stampIdentity(element: HTMLElement, node: Node): void {
  element.dataset['oid'] = node.id;
  element.dataset['type'] = node.type;
}

export class ObjectTypeRegistry {
  private readonly renderers = new Map<string, ObjectRenderer>();

  register<P extends Node>(renderer: ObjectRenderer<P>): void {
    const existing = this.renderers.get(renderer.type);
    if (existing !== undefined) {
      throw new Error(`Object type "${renderer.type}" is already registered`);
    }
    this.renderers.set(renderer.type, renderer as ObjectRenderer);
  }

  get(type: string): ObjectRenderer {
    const renderer = this.renderers.get(type);
    if (renderer === undefined) {
      throw new Error(
        `No renderer registered for object type "${type}". ` +
          `Registered types: ${[...this.renderers.keys()].join(', ') || '(none)'}`,
      );
    }
    return renderer;
  }

  has(type: string): boolean {
    return this.renderers.has(type);
  }
}

export class Reconciler {
  private readonly elements = new Map<string, HTMLElement>();
  /** Last model node projected onto each element, passed to `update` as `prev`. */
  private readonly projected = new Map<string, Node>();
  /** The key order this reconciler last wrote into each parent element. */
  private readonly childKeys = new WeakMap<HTMLElement, string[]>();

  constructor(private readonly registry: ObjectTypeRegistry) {}

  /** Project `nodes` into `parent`, diffing against whatever is already there. */
  reconcile(parent: HTMLElement, nodes: readonly Node[], ctx: RenderCtx): void {
    const seen = new Set<string>();
    for (const node of nodes) {
      if (seen.has(node.id)) {
        throw new Error(`Duplicate node id "${node.id}" in a single sibling list`);
      }
      seen.add(node.id);
    }
    this.reconcileInto(parent, nodes, ctx);
  }

  private reconcileInto(parent: HTMLElement, nodes: readonly Node[], ctx: RenderCtx): void {
    // 1. Drop elements whose node is gone.
    const previousKeys = this.childKeys.get(parent) ?? [];
    const nextKeys = nodes.map((node) => node.id);
    const nextKeySet = new Set(nextKeys);
    for (const key of previousKeys) {
      if (!nextKeySet.has(key)) this.destroy(key);
    }

    // 2. Create or update each element, then recurse into its children.
    const nextElements: HTMLElement[] = [];
    for (const node of nodes) {
      const renderer = this.registry.get(node.type);

      let element = this.elements.get(node.id);
      if (element === undefined) {
        element = renderer.create(ctx, node);
        this.elements.set(node.id, element);
        // Identity is stamped here and nowhere else. See the note on `stampIdentity`.
        stampIdentity(element, node);
      }

      const prev = this.projected.get(node.id);
      renderer.update(element, node, prev, ctx);
      renderer.afterUpdate?.(element, node, ctx);
      this.projected.set(node.id, node);
      nextElements.push(element);

      if (renderer.children !== undefined) {
        this.reconcileInto(element, renderer.children(node), ctx);
      }
    }

    // 3. Make DOM order match model order. Model order *is* paint order, so this
    //    is a correctness requirement, not a nicety.
    this.applyOrder(parent, nextElements);
    this.childKeys.set(parent, nextKeys);
  }

  /**
   * Reorder children with the minimum number of moves: walk the desired order
   * and only touch an element when it is not already in the right place.
   */
  private applyOrder(parent: HTMLElement, elements: readonly HTMLElement[]): void {
    let cursor: ChildNode | null = parent.firstChild;
    for (const element of elements) {
      if (element === cursor) {
        cursor = cursor.nextSibling;
      } else {
        parent.insertBefore(element, cursor);
      }
    }
  }

  private destroy(id: string): void {
    const element = this.elements.get(id);
    if (element !== undefined) {
      element.remove();
      this.elements.delete(id);
    }
    this.projected.delete(id);
  }

  elementFor(id: string): HTMLElement | undefined {
    return this.elements.get(id);
  }

  get size(): number {
    return this.elements.size;
  }

  /** Remove every element this reconciler owns. */
  dispose(): void {
    for (const element of this.elements.values()) element.remove();
    this.elements.clear();
    this.projected.clear();
  }
}