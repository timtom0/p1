/**
 * Model-aware measurement: the boundary between the document and the browser.
 *
 * `render/measure.ts` knows how to read layout out of an element. This module knows
 * *which* element corresponds to a node, and whether that element is showing the
 * current document — the two things only the editor layer can answer.
 *
 * The split exists so that `render/` never imports `editor/` and `ui/` never imports
 * `render/`; both are enforced by `eslint.config.js`, and this is the arrangement that
 * satisfies them without an exemption. `ui` reaches measurement through `Editor`.
 *
 * ## Why the result is a status union
 *
 * The tempting shape is `{ height: number }`, and it is wrong three times over. A
 * hidden frame measures `0` from every layout API, which is indistinguishable from a
 * genuinely empty one. A frame measured before the render pass reports the *previous*
 * document's layout, which is worse than reporting nothing because it looks right. And
 * a node that is not mounted has no answer at all.
 *
 * So: **a measurement never returns a number it cannot stand behind.** See
 * `docs/adr/0004-measurement-boundary.md`.
 *
 * @module
 */

import { findNode } from './selection';
import { contentOf } from '../render/types/text-frame';
import {
  contentBoxSize,
  isRendered,
  observeContentBox,
  overflowOf,
  paddingBoxSize,
  type LayoutSize,
  type Overflow,
  type PreciseSize,
} from '../render/measure';
import type { Document, Node } from '../model/types';
import { placementsInDocument } from '../model/tree';
import type { DocStore } from './store/doc-store';

/** A node's laid-out geometry, in document px. */
export type Measurement =
  | { readonly status: 'ok'; readonly size: LayoutSize; readonly overflow: Overflow }
  /** No element for this node: it is not mounted, or the document is not projected. */
  | { readonly status: 'unmounted' }
  /**
   * The node is `display: none`, so every layout API reports `0`.
   *
   * Distinct from a zero size on purpose. `visible: false` is a common state and `0`
   * would be read as "this frame has no size", which is a different and wrong claim.
   */
  | { readonly status: 'hidden' }
  /**
   * The DOM does not match the model, so any number read now describes a *previous*
   * document.
   *
   * Checkable, which is the point: a node's rendered box must equal the model's
   * `transform.width`/`height` (ADR 0003 §1.5.1 — the frame is a box the model sizes).
   * Two integer reads turn "did you measure the document or a memory of it?" from a
   * convention into a property.
   */
  | { readonly status: 'stale' };

/** What a measurement needs in order to resolve a node to an element and check it. */
export interface MeasurementHost {
  readonly store: DocStore;
  /** The node's mounted element, or `undefined` when it is not in the document. */
  elementFor(nodeId: string): HTMLElement | undefined;
}

/**
 * The laid-out geometry of a node's own box.
 *
 * Returns the **padding box** (`offsetWidth`/`offsetHeight`), which for every object
 * type today is identical to the model's `transform.width`/`height`. That redundancy is
 * deliberate and is the point of the `stale` check: the DOM reproducing the model
 * exactly is the precondition for trusting the *content* measurement below.
 *
 * `getBoundingClientRect` is deliberately not used. Under a 30° rotation it returns
 * 198×143 for a 200×50 box — the bounding box of the painted result — and it is scaled
 * by zoom besides. Measured; see ADR 0004.
 */
export function measureNode(host: MeasurementHost, nodeId: string): Measurement {
  const element = host.elementFor(nodeId);
  if (element === undefined) return { status: 'unmounted' };

  // `display` before size, so a hidden element never reaches an API that would lie.
  if (!isRendered(element)) return { status: 'hidden' };

  const node = findNode(host.store.state, nodeId);
  if (node === null) return { status: 'unmounted' };
  if (!matchesModelGeometry(element, node)) return { status: 'stale' };

  return {
    status: 'ok',
    size: paddingBoxSize(element),
    overflow: overflowOf(element),
  };
}

/**
 * The laid-out size of a text frame's **text**, in document px.
 *
 * This is the auto-size number, and it is simply the content element's laid-out height:
 * the content element has `height: auto`, so its height *is* the text's height, with
 * no overflow arithmetic and no dependence on whether the text fits the frame
 * (measured for one line, wrapped text, soft breaks, several paragraphs, an empty
 * paragraph, and overflowing text).
 *
 * Returns the same status union as {@link measureNode}, for the same reasons. The
 * `stale` check runs against the frame's box first, so a stale projection is reported
 * before anything is read out of the text.
 *
 * **During a text session this measures the browser's uncommitted DOM**, not the model.
 * Reading it is safe and non-disturbing — verified, including that the caret is
 * unchanged and typing still lands where it was — but a caller must not feed it back
 * into authored state, because it describes text the user has not committed. ADR 0004 §5.
 */
export function measureTextContent(host: MeasurementHost, nodeId: string): Measurement {
  const frame = host.elementFor(nodeId);
  if (frame === undefined) return { status: 'unmounted' };
  if (!isRendered(frame)) return { status: 'hidden' };

  const node = findNode(host.store.state, nodeId);
  if (node === null) return { status: 'unmounted' };
  if (!matchesModelGeometry(frame, node)) return { status: 'stale' };

  const content = contentOf(frame);
  if (content === null) return { status: 'unmounted' };

  return {
    status: 'ok',
    size: contentBoxSize(content),
    overflow: overflowOf(content),
  };
}

/**
 * Observes a text frame's content box at the browser's own precision.
 *
 * `measureTextContent` rounds to an integer, and a 19.5px line height reports `20` —
 * so three lines of text measure 58.5px and are reported as 60. This is the only source
 * of a fractional, zoom-invariant, transform-invariant size, and it is asynchronous.
 *
 * That combination is why auto-size must be a *converging* operation rather than a pure
 * command: change the width, render, measure, dispatch the fitted height, render, measure
 * again. The loop guard is not defensive there, it is what makes the sequence terminate.
 * ADR 0004 §"Auto-size implications".
 *
 * Not implemented here. Provided so the consumer does not have to reach for
 * `ResizeObserver` directly, and so the disposal contract is settled: the returned
 * disposer must be called, or the observer keeps a detached subtree alive.
 */
export function observeTextContent(
  host: MeasurementHost,
  nodeId: string,
  onChange: (size: PreciseSize) => void,
): () => void {
  const frame = host.elementFor(nodeId);
  const content = frame === undefined ? null : contentOf(frame);
  if (content === null) return () => undefined;
  return observeContentBox(content, onChange);
}

/**
 * Whether the DOM's box for `node` still agrees with the model.
 *
 * The staleness check. It compares the rendered padding box against the model's
 * transform, which is legitimate precisely because geometry is *authored* state: the
 * model owns it, so the DOM reproducing it exactly is expected, and any disagreement
 * means the projection is behind.
 *
 * It cannot detect a stale *text* projection — the content element's size is the thing
 * being asked about, so there is nothing independent to compare it against. That is a
 * real limit of the check and is recorded in ADR 0004 rather than papered over.
 */
function matchesModelGeometry(element: HTMLElement, node: Node): boolean {
  const { transform } = node;
  // Layout APIs are integers, and the model allows fractional geometry, so this is a
  // tolerance rather than an equality. Half a pixel is below what the model can express
  // meaningfully and far below what a layout API can report differently.
  const within = (measured: number, expected: number): boolean =>
    Math.abs(measured - expected) <= 0.5;

  return (
    within(element.offsetWidth, transform.width) && within(element.offsetHeight, transform.height)
  );
}

/**
 * Every text frame in the document, at any depth, in paint order.
 *
 * Exists because the obvious loop — "measure every text frame" — is the shape a future
 * feature wants, and it should not require each caller to re-derive the node list.
 *
 * Recursive since M12. A text frame inside a group has the same measurement problem as any other:
 * its layout box is its own **local** box, and a CSS transform is a paint transform. So nothing
 * about measurement changes with depth — which is the point worth recording, because it means a
 * group's transform can never make a measurement wrong, and a future auto-size feature does not
 * need to know whether a frame is nested. ADR 0011 §10 measured this on a transformed *ancestor*
 * and found `clientWidth`/`offsetWidth`/`scrollHeight` unchanged while `getBoundingClientRect`
 * moved.
 */
export function textNodeIds(doc: Document): string[] {
  const ids: string[] = [];
  for (const placement of placementsInDocument(doc)) {
    if (placement.node.type === 'textFrame') ids.push(placement.node.id);
  }
  return ids;
}
