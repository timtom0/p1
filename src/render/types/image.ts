/**
 * Renderer for `type: 'image'`.
 *
 * A projection, like every other renderer: model → HTML/CSS, with the browser owning
 * everything it already owns (decoding, painting, compositing). There is no geometry maths
 * beyond formatting.
 *
 * ## Why a wrapper `div` rather than a bare `<img>`
 *
 * Measured, and the deciding factor is not geometry — the two are identical for `offset*`
 * size, computed transform and painted box (ADR 0006 PROBE AA). It is that an `<img>` is a
 * **replaced element**: it has no content box in which descendants render, so a bare
 * `<img>` has nowhere to put a "missing image" state. Appending a marker to one keeps it in
 * the DOM and paints nothing.
 *
 * So the object element stays a `div`, like every other object type. That uniformity is
 * worth more than the saved element: `data-oid`, ADR 0004's `stale` check, the overlay's
 * element lookup and the creation gesture all treat an image exactly as they treat a
 * rectangle, with no special cases.
 *
 * ## The wrapper is also where the state lives
 *
 * `data-asset-state` is **rendering output, not document state**. The model records a
 * reference; whether that reference currently resolves is a property of this browser
 * session, not of the document. So the state is derived from the `<img>` and published on
 * the element, and the inspector *reads* it rather than owning it — the same arrangement
 * as ADR 0004's measurement note.
 *
 * `complete` is not the success test: it is `true` for a failed load too (measured, ADR
 * 0006 PROBE Z). Only `naturalWidth > 0` distinguishes a decoded image from a missing one,
 * which is why `deriveAssetState` exists.
 */

import type { ImageNode } from '../../model/types';
import type { AssetState } from '../../model/assets';
import { localMatrix } from '../../model/transform';
import { setStyle } from '../dom-style';
import { cssLength, cssMatrix } from '../num';
import type { RenderCtx } from '../render-context';
import type { ObjectRenderer } from '../reconciler';
import type { AssetResolver } from '../assets';

/** Class on the object wrapper, alongside `.p1-object`. */
const IMAGE_CLASS = 'p1-image';
/** Class on the `<img>` inside it. */
const IMAGE_CONTENT_CLASS = 'p1-image-content';

/** Attribute carrying the derived load state, readable by the inspector and by tests. */
export const ASSET_STATE_ATTRIBUTE = 'data-asset-state';

/**
 * Records that resolution itself failed, as distinct from the browser failing to load.
 *
 * Separate from `data-asset-state` because the two answer different questions: "did we get
 * a URL?" and "are there pixels yet?". Without it, a failed resolution is indistinguishable
 * from an attempt still in flight — the element has no `src` either way, and reporting
 * `idle` would promise a load that will never arrive.
 */
const RESOLUTION_ATTRIBUTE = 'data-asset-resolution';

export interface ImageRenderOptions {
  /** Mints runtime URLs. Supplied per-document so the cache is disposed with the view. */
  assets: AssetResolver;
  /**
   * Called when the browser's own answer about an asset differs from what the renderer
   * last published — i.e. an image finished loading or failed *after* the document settled.
   *
   * This is the only way the model learns anything about loading, and it does not: it
   * redraws chrome so the inspector can report the new state. The document is unchanged.
   */
  onAssetStateChanged?: (nodeId: string) => void;
}

export function createImageRenderer(options: ImageRenderOptions): ObjectRenderer<ImageNode> {
  /** The URL each element last used, so `src` is only written when it really changes. */
  const lastUrl = new WeakMap<HTMLElement, string>();
  /** The state each element last published, so `onAssetStateChanged` fires once. */
  const lastState = new WeakMap<HTMLElement, AssetState>();

  /**
   * Publishes an element's derived state, and notifies once per transition.
   *
   * Assigned to the `<img>`'s `load` and `error` events rather than polled, because the
   * document gives no reason to re-render when an image finishes decoding — nothing about
   * it changed.
   */
  const publishState = (element: HTMLElement, node: ImageNode): void => {
    const state = deriveAssetState(element);
    if (state === lastState.get(element)) return;
    lastState.set(element, state);
    element.setAttribute(ASSET_STATE_ATTRIBUTE, state);
    options.onAssetStateChanged?.(node.id);
  };

  return {
    type: 'image',

    create(_ctx: RenderCtx, node: ImageNode): HTMLElement {
      const element = document.createElement('div');
      element.className = `p1-object ${IMAGE_CLASS}`;
      // `data-oid` and `data-type` are stamped by the reconciler, which owns object identity
      // (ADR 0009 §4).

      const img = document.createElement('img');
      img.className = IMAGE_CONTENT_CLASS;
      // Not decorative: it is the object's content, and it must be the hit target the
      // browser already is.
      img.alt = node.name;
      // `dragstart` on an image drags the *file* out of the document in Chromium, which
      // is a data-loss gesture in an editor. Suppressed at the element the browser honours.
      img.draggable = false;
      img.addEventListener('load', () => publishState(element, node));
      img.addEventListener('error', () => publishState(element, node));
      element.append(img);

      return element;
    },

    update(element, node, _prev, _ctx): void {
      const { transform } = node;

      // Geometry: identical to shapes and text frames. `transform.x/y/width/height` is the
      // border box, and the `<img>` fills it, so the authored box is the model's box --
      // measured for every asset state including rotated and failed (ADR 0006 PROBE AB).
      setStyle(element, 'left', cssLength(transform.x));
      setStyle(element, 'top', cssLength(transform.y));
      setStyle(element, 'width', cssLength(transform.width));
      setStyle(element, 'height', cssLength(transform.height));
      setStyle(element, 'transform', cssMatrix(localMatrix(transform)));

      const img = contentOf(element);
      if (img === null) return;

      // `object-fit` changes only the paint inside the box -- measured across all five
      // values, `offsetWidth/Height` and the hit region are identical (PROBE X). So it is
      // authored state that is not geometry, and it belongs here rather than in
      // `transform`.
      setStyle(img, 'object-fit', node.fit ?? 'fill');

      // Compositing and visibility, as for every object type. `display: none` is reserved
      // for `visible: false`, so a *missing asset* and a *deliberately hidden* object can
      // never look alike: one keeps its box and gains a placeholder, the other has no box.
      setStyle(element, 'opacity', String(node.opacity));
      setStyle(element, 'mix-blend-mode', node.blendMode);
      setStyle(element, 'display', node.visible ? '' : 'none');

      // `src` last, and only when it really changes. A stable URL is the point of the
      // resolver: re-assigning `src` makes the browser drop and re-fetch the image, so a
      // stable value is what stops an unrelated document edit flickering every image.
      const resolution = options.assets.resolve(node.asset);
      if (resolution.state === 'ready') {
        // Recording success by *removing* the marker, rather than writing 'ok', keeps
        // there exactly one way for the element to be in a bad state and one way out.
        element.removeAttribute(RESOLUTION_ATTRIBUTE);
        if (lastUrl.get(element) !== resolution.url) {
          lastUrl.set(element, resolution.url);
          img.src = resolution.url;
        }
      } else {
        // Refusing to write a `src` we do not have is not enough on its own: an `<img>`
        // with no `src` still occupies its box and is still hit-testable (measured, ADR
        // 0006 PROBE Z), so the element has to *say* that resolution failed. Without
        // this marker a failed resolution derives as `idle` — "still loading" — which is
        // a promise the browser will never keep.
        //
        // That was the second bug this slice found: the first version reported `idle` for
        // a missing asset, which reads as in-progress rather than broken.
        element.setAttribute(RESOLUTION_ATTRIBUTE, 'failed');
      }

      publishState(element, node);
    },
  };
}

/** The `<img>` inside an image object element, or `null` if the element is malformed. */
export function contentOf(element: HTMLElement): HTMLImageElement | null {
  return element.querySelector<HTMLImageElement>(`.${IMAGE_CONTENT_CLASS}`);
}

/**
 * The asset state of a mounted image element, derived from the browser.
 *
 * A pure function of the element, which is what makes it safe for `Editor.assetStateOf`
 * and for tests to read without re-deriving anything: the published attribute and this
 * function are the same rule, not two.
 *
 * > `complete` is not a success test. It is `true` for a missing `src`, an unreachable
 * > URL and non-image data alike (measured). Only `naturalWidth > 0` means "decoded".
 *
 * Order matters: a resolution failure is checked first, because a failed resolution
 * leaves the `<img>` with no `src` and would otherwise be indistinguishable from an
 * attempt that has not finished.
 *
 * An element with no `<img>` is `error`, not `idle`: a wrapper that cannot hold its
 * content is broken, and `idle` would read as "still loading".
 */
export function deriveAssetState(element: HTMLElement): AssetState {
  if (element.getAttribute(RESOLUTION_ATTRIBUTE) === 'failed') return 'error';
  const img = contentOf(element);
  if (img === null) return 'error';
  if (img.getAttribute('src') === null) return 'idle';
  if (!img.complete) return 'loading';
  return img.naturalWidth > 0 ? 'loaded' : 'error';
}