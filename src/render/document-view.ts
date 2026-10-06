/**
 * `DocumentView` — the single entry point that projects a `Document` into the DOM.
 *
 * Everything above it holds a model and calls `render(doc, gap)`. Nothing else in
 * the codebase is permitted to touch the document DOM. That is the whole of the "DOM
 * is a projection" rule, enforced by convention now and by module boundaries later.
 *
 * ## Layout
 *
 * ```
 * .pages        transform: scale(zoom)   ← the only place zoom is written
 *   .page × n   position: absolute; top = pageOffsetY(...) in document px
 *     .objects  reconciled children
 * ```
 *
 * The stack is one transformed element rather than one transform per page: a
 * single CSS write covers the whole document at any zoom, and page offsets stay in
 * document px where the coordinate system already lives.
 *
 * Zoom never enters the model, and never enters any element's geometry — only the
 * stack's `transform` changes.
 */

import type { Document, Node } from '../model/types';
import type { NodePlacement } from '../model/tree';
import { placementsOnPage } from '../model/tree';
import { pageExtentPx, pageOffsetY } from '../model/page';
import { applyPageGeometry } from './layers/page';
import { ObjectTypeRegistry, Reconciler } from './reconciler';
import { createRenderContext } from './render-context';
import { shapeRenderer } from './types/shape';
import { textFrameRenderer } from './types/text-frame';
import { AssetResolver } from './assets';
import { createImageRenderer } from './types/image';
import type { AssetId } from '../model/types';

export interface DocumentViewElements {
  /** The transformed page stack. Carries `transform: scale(zoom)`. */
  pages: HTMLElement;
}

/**
 * A leaf node with its **world** transform substituted for its own.
 *
 * ## Why the renderer is handed a projected node rather than a placement
 *
 * Every renderer takes a `Node` and reads `node.transform` to write `left`/`top`/`width`/`height`
 * and `matrix(...)`. That is a good contract and worth keeping: a renderer should not know what a
 * group is. So the recursion is resolved *before* the renderer sees anything, by replacing the
 * transform with the composed one.
 *
 * The substitution is **exact** rather than approximate, because a uniform scale commutes with
 * every rotation, so the composed linear part of a whole chain of (rotation, uniform scale) pairs
 * is itself `R(t)·S(s)` — see `worldTransformIn` in `model/transform.ts`, and ADR 0011 §2's algebra
 * for why the general affine needs a fourth parameter that a uniform-only chain never reaches.
 * There is no shear to represent and no decomposition to get wrong. ADR 0012 §9.
 *
 * `width`/`height` pass through unchanged: the composed frame is still *the node's own box*, just
 * positioned in page space. That is the M11 contract — the local box is the frame — and depth does
 * not change it.
 *
 * The spread copies `id`, `name`, `visible`, `locked`, `opacity`, `blendMode` and every kind
 * specific field **by reference**, so identity is untouched: `data-oid` is stamped by the
 * reconciler from `node.id`, and a projected node carries the authored id, never a synthetic one.
 * ADR 0008 §13.1's rule is unaffected.
 */
function projectPlacement(placement: NodePlacement): Node {
  const node = placement.node;
  // A hidden **group** hides its subtree, and the renderer is where that becomes pixels: every
  // renderer already maps `node.visible` to `display`, so the only thing missing was the chain.
  //
  // Without this a hidden group's children painted normally -- the group claimed to be hidden and its
  // contents were on the page anyway, which is the "invisible but live" state that makes a document
  // feel haunted. `isEffectivelyVisible` in `editor/selection.ts` already checked the chain for hit
  // testing, so the two agreed about *clicking* a hidden subtree while disagreeing about whether it
  // was on the page at all.
  //
  // `locked` is **not** propagated: locking is about interaction, not paint, and propagating it would
  // make a locked group grey out its children, which is a visual decision nobody asked for.
  //
  // `visible: false` on a leaf whose ancestors are all visible is untouched, so a flat document
  // projects exactly as it did before M12 -- and the identity assertions still hold, because `id`,
  // `name` and every kind-specific field pass through by reference.
  const hidden = placement.ancestors.some((ancestor) => !ancestor.visible);
  if (!hidden) return { ...node, transform: placement.transform };
  return { ...node, transform: placement.transform, visible: false };
}

export interface DocumentViewOptions {
  /**
   * Called when an asset resolves, fails, or is replaced after the document settled.
   *
   * The document does not change, so this exists only so chrome can re-read the state --
   * the inspector reporting "missing" instead of "loading" is the same arrangement as
   * ADR 0004's measurement note.
   */
  onAssetStateChanged?: (nodeId: string) => void;
}

export class DocumentView {
  private readonly reconciler: Reconciler;
  private lastDocument: Document | null = null;
  private lastGap = 0;
  /** Wall-clock duration of the most recent `render`, for the dev harness. */
  lastRenderMs = 0;

  /** Node ids currently owned by a text-editing session; the renderer must skip them. */
  private readonly textEditing = new Set<string>();

  private readonly pageElements = new Map<string, HTMLElement>();
  private readonly objectContainers = new Map<string, HTMLElement>();

  /**
   * Runtime asset URLs. Owned here because its lifetime is the view's: the object URLs it
   * mints are session-scoped and must be revoked when the view goes away, which is the
   * concrete reason a blob URL can never be an asset's identity (ADR 0006).
   */
  readonly assets: AssetResolver;

  constructor(
    private readonly elements: DocumentViewElements,
    options: DocumentViewOptions = {},
  ) {
    this.assets = new AssetResolver({ assets: () => this.lastDocument?.assets ?? {} });
    const registry = new ObjectTypeRegistry();
    registry.register(shapeRenderer);
    registry.register(textFrameRenderer);
    registry.register(
      createImageRenderer({ assets: this.assets, onAssetStateChanged: options.onAssetStateChanged }),
    );
    this.reconciler = new Reconciler(registry);
  }

  /**
   * Tells the resolver that an asset's bytes changed under the same id.
   *
   * Called by the mutation path that replaces an asset, because the resolver keys on
   * *identity*: without this it would keep handing out the old URL and the screen would
   * show the previous image while the document claimed the new one.
   */
  invalidateAsset(id: AssetId): void {
    this.assets.invalidate(id);
  }

  /** Releases every runtime URL. The view is unusable afterwards. */
  dispose(): void {
    this.assets.dispose();
  }

  /**
   * Marks a node as being text-edited, so the renderer withholds its content.
   *
   * This is the whole of the fence as far as the render layer is concerned: the
   * model stays authoritative for everything else, and this one element becomes the
   * browser's until the session ends.
   *
   * The DOM marker is written **here**, immediately, rather than being left to the
   * next `render`. Entering a session changes nothing in the model, so waiting for a
   * render meant the fence was recorded but not yet in effect — the frame looked
   * editable to the user a frame later, and a re-render in between would have fought
   * the browser for the element. The fence takes effect at the moment it is set.
   */
  setTextEditing(nodeId: string, active: boolean): void {
    if (active) {
      this.textEditing.add(nodeId);
    } else {
      this.textEditing.delete(nodeId);
    }

    const element = this.elementFor(nodeId);
    if (element === undefined) return;
    if (active) element.dataset['editing'] = 'true';
    else delete element.dataset['editing'];
  }

  isTextEditing(nodeId: string): boolean {
    return this.textEditing.has(nodeId);
  }

  /**
   * Project `doc` into the DOM.
   *
   * `gap` is the space between pages, in document px. It comes from the caller
   * rather than being read from the model because it is view state (§3.7), not
   * document state.
   */
  render(doc: Document, gap: number): void {
    const started = performance.now();
    const ctx = createRenderContext(doc, {
      isTextEditing: (nodeId) => this.textEditing.has(nodeId),
    });

    // Published **before** reconciling, not after.
    //
    // The asset resolver reads the document through `lastDocument` while a renderer is
    // mid-projection, and anything else added later will do the same. Assigning it after
    // the reconcile loop meant every renderer's reads saw the *previous* document — so a
    // freshly inserted image resolved against a document that did not contain its asset,
    // and rendered as an empty box. The failure was silent and looked like a decode
    // problem, because the node existed and was correctly sized; only the pixels were
    // missing.
    this.lastDocument = doc;

    this.syncPages(doc, gap);

    for (const [index, page] of doc.pages.entries()) {
      const objects = this.objectContainers.get(page.id);
      const pageElement = this.pageElements.get(page.id);
      if (objects === undefined || pageElement === undefined) continue;

      applyPageGeometry(pageElement, doc, page);
      pageElement.style.top = `${pageOffsetY(index, doc.pages.length, pageHeight(doc), gap)}px`;
      // Groups are flattened here and nowhere else. A group's transform becomes part of
      // each descendant's placement, and its position in the page's `objects` array becomes the
      // position its children occupy in the flat list -- so `A, Group[B, C], D` renders as
      // `A, B, C, D`, which is the paint order ADR 0012 §5 specifies.
      //
      // `placementsOnPage` returns **leaves only**, so no `group` node ever reaches the
      // reconciler and the object-type registry never needs a group entry. That is not an
      // accident to rely on quietly: a group has no visual form of its own, so a registry entry
      // would have to render an empty box and silently occupy a paint slot. The filter is
      // explicit below for the same reason the comment is.
      const projected = placementsOnPage(page).map(projectPlacement);
      if (projected.some((node) => node.type === 'group')) {
        throw new Error('a group reached the renderer: placements must be leaves');
      }
      this.reconciler.reconcile(objects, projected, ctx);
    }

    this.lastGap = gap;
    this.lastRenderMs = performance.now() - started;
  }

  /** Re-project the last rendered document with a new gap. */
  setGap(gap: number): void {
    this.rerender();
    this.lastGap = gap;
  }

  /** Re-project the last rendered document. */
  rerender(): void {
    if (this.lastDocument === null) throw new Error('Nothing has been rendered yet');
    this.render(this.lastDocument, this.lastGap);
  }

  private syncPages(doc: Document, gap: number): void {
    const height = pageHeight(doc);
    const seen = new Set<string>();

    for (const [index, page] of doc.pages.entries()) {
      seen.add(page.id);
      let pageElement = this.pageElements.get(page.id);

      if (pageElement === undefined) {
        pageElement = document.createElement('div');
        pageElement.className = 'page';
        pageElement.dataset['page'] = page.id;
        pageElement.style.left = '0px';

        const objects = document.createElement('div');
        objects.className = 'objects';
        // Test and devtools hook: identifies an object's container regardless of
        // which page it belongs to.
        objects.dataset['objects'] = '';
        pageElement.append(objects);

        this.pageElements.set(page.id, pageElement);
        this.objectContainers.set(page.id, objects);
        this.elements.pages.append(pageElement);
      }

      pageElement.style.top = `${pageOffsetY(index, doc.pages.length, height, gap)}px`;
      applyPageGeometry(pageElement, doc, page);
    }

    for (const [id, element] of this.pageElements) {
      if (!seen.has(id)) {
        element.remove();
        this.pageElements.delete(id);
        this.objectContainers.delete(id);
      }
    }

    // Keep DOM order equal to document order so page order is never ambiguous.
    const ordered = doc.pages
      .map((page) => this.pageElements.get(page.id))
      .filter((element): element is HTMLElement => element !== undefined);

    let cursor: ChildNode | null = this.elements.pages.firstChild;
    for (const element of ordered) {
      if (element === cursor) {
        cursor = cursor.nextSibling;
      } else {
        this.elements.pages.insertBefore(element, cursor);
      }
    }
  }

  /** The mounted page element for a page id, if any. */
  pageElementFor(pageId: string): HTMLElement | undefined {
    return this.pageElements.get(pageId);
  }

  /** Mounted page ids, in DOM order. Used by tests and the pages panel. */
  mountedPageIds(): string[] {
    return [...this.elements.pages.children]
      .map((element) => (element as HTMLElement).dataset['page'])
      .filter((id): id is string => id !== undefined);
  }

  /** Exposed for hit-testing and, later, overlay maths. */
  elementFor(nodeId: string): HTMLElement | undefined {
    return this.reconciler.elementFor(nodeId);
  }

  get pageCount(): number {
    return this.pageElements.size;
  }

  get nodeCount(): number {
    return this.reconciler.size;
  }
}

function pageHeight(doc: Document): number {
  return pageExtentPx(doc.pageSize).height;
}