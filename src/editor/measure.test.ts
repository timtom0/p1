// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import {
  measureNode,
  measureTextContent,
  observeTextContent,
  textNodeIds,
  type MeasurementHost,
} from './measure';
import { contentBoxSize, isRendered, observeContentBox, overflowOf } from '../render/measure';
import {
  createDocument,
  createPage,
  createRectNode,
  createTextFrameNode,
  createTransform,
} from '../model/factory';
import type { Document } from '../model/types';
import type { DocStore } from './store/doc-store';

/**
 * The ADR 0004 status union.
 *
 * These are the *branches*, and they are deliberately unit-tested rather than
 * browser-tested. Two of the four cannot be reached through the UI at all:
 *
 *  - `hidden` — a `display: none` frame is refused by the model hit test, so it cannot
 *    be selected, so the inspector never asks about it.
 *  - `stale` — it needs a DOM that disagrees with the model, which a correct
 *    application never produces.
 *
 * A browser test for either would have to break the application to reach it, and a
 * test that arranges for the bug it is looking for is not evidence. The *positive*
 * case and every layout claim live in `tests/editor/measure.spec.ts` and
 * `tests/spike/measure-probe.spec.ts` instead.
 *
 * happy-dom is sufficient here precisely because these branches are decided before any
 * layout is consulted: `hidden` short-circuits on `display`, and `stale` compares the
 * DOM against the model.
 */

interface Harness {
  host: MeasurementHost;
  doc: Document;
  frame: HTMLElement;
  content: HTMLElement;
  /** Mutable so a test can simulate a deletion racing the reconciler. */
  store: { state: Document };
}

/**
 * A document with one text frame, mounted into the document with a content element.
 *
 * `offsetWidth`/`offsetHeight` are stubbed because happy-dom performs no layout — which
 * is exactly the point: these tests are about the branches that decide whether to
 * trust a layout API, not about what layout returns.
 */
function harness(options: { width?: number; height?: number; display?: string } = {}): Harness {
  const width = options.width ?? 200;
  const height = options.height ?? 50;

  const frame = createTextFrameNode({
    id: 'text-1',
    transform: createTransform({ x: 0, y: 0, width, height }),
  });
  const page = createPage({ objects: [frame] });
  const doc = createDocument({ pages: [page] });

  const frameElement = document.createElement('div');
  frameElement.className = 'p1-object p1-text-frame';
  frameElement.dataset['oid'] = 'text-1';
  if (options.display !== undefined) frameElement.style.display = options.display;

  const contentElement = document.createElement('div');
  contentElement.className = 'p1-text-content';
  contentElement.dataset['p1Text'] = 'true';
  frameElement.append(contentElement);

  const pageElement = document.createElement('div');
  pageElement.dataset['objects'] = '';
  pageElement.append(frameElement);
  document.body.append(pageElement);

  // happy-dom computes no layout, so the geometry the staleness check compares against
  // has to be provided. A real browser supplies it; here it is the seam.
  Object.defineProperty(frameElement, 'offsetWidth', { value: width, configurable: true });
  Object.defineProperty(frameElement, 'offsetHeight', { value: height, configurable: true });
  Object.defineProperty(contentElement, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(contentElement, 'clientHeight', { value: 96, configurable: true });
  Object.defineProperty(contentElement, 'scrollWidth', { value: width, configurable: true });
  Object.defineProperty(contentElement, 'scrollHeight', { value: 96, configurable: true });

  const store = { state: doc };

  return {
    host: {
      store: store as unknown as DocStore,
      elementFor: (id) => (id === 'text-1' ? frameElement : undefined),
    },
    doc,
    frame: frameElement,
    content: contentElement,
    store,
  };
}

describe('measureTextContent', () => {
  it('reports the content box when the projection matches the model', () => {
    const { host } = harness();
    const result = measureTextContent(host, 'text-1');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    // 96, not the frame's 50: this is the text's height, which is the auto-size number.
    expect(result.size).toEqual({ width: 200, height: 96 });
    expect(result.overflow).toEqual({ x: false, y: false });
  });

  it('reports `unmounted` for a node with no element', () => {
    const { host } = harness();
    expect(measureTextContent(host, 'nope').status).toBe('unmounted');
  });

  it('reports `unmounted` when the element outlives the node that created it', () => {
    const { host, frame, store } = harness();
    // A real race: the reconciler has not removed the element yet, but the model no
    // longer has the node. The element's geometry would still match the *old* node, so
    // without this branch a deletion would be reported as a valid measurement.
    store.state = createDocument({ pages: [createPage()] });
    expect(frame.isConnected).toBe(true);
    expect(measureTextContent(host, 'text-1').status).toBe('unmounted');
  });
  it('reports `hidden` for a `display: none` frame, never a zero size', () => {
    const { host } = harness({ display: 'none' });
    const result = measureTextContent(host, 'text-1');

    // The distinction the whole status union exists for: every layout API would say
    // `0`, and `0` is a plausible height.
    expect(result.status).toBe('hidden');
    expect(result).not.toHaveProperty('size');
  });

  it('reports `stale` when the DOM box disagrees with the model', () => {
    // The model says 200x50; the DOM has been left at 400x50 by a projection that has
    // not caught up. Reporting 400 would be reporting the previous document.
    const { host, frame } = harness();
    Object.defineProperty(frame, 'offsetWidth', { value: 400, configurable: true });

    expect(measureTextContent(host, 'text-1').status).toBe('stale');
  });

  it('tolerates a sub-pixel disagreement, because layout APIs round', () => {
    const { host, frame } = harness({ width: 200 });
    Object.defineProperty(frame, 'offsetWidth', { value: 200.4, configurable: true });
    expect(measureTextContent(host, 'text-1').status).toBe('ok');
  });

  it('reports `unmounted` when the frame has no content element', () => {
    const { host, content } = harness();
    content.remove();
    expect(measureTextContent(host, 'text-1').status).toBe('unmounted');
  });
});

describe('measureNode', () => {
  it('reports the model geometry, and agrees with the model', () => {
    const { host } = harness();
    const result = measureNode(host, 'text-1');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    // Deliberately redundant with `transform.width`. That redundancy is the staleness
    // check's premise: geometry is authored state, so the DOM reproducing it exactly is
    // expected, and disagreement means the projection is behind.
    expect(result.size).toEqual({ width: 200, height: 50 });
  });

  it('reports `hidden` before consulting any size API', () => {
    const { host } = harness({ display: 'none' });
    expect(measureNode(host, 'text-1').status).toBe('hidden');
  });

  it('reports `stale` on disagreement', () => {
    const { host, frame } = harness();
    Object.defineProperty(frame, 'offsetHeight', { value: 999, configurable: true });
    expect(measureNode(host, 'text-1').status).toBe('stale');
  });

  it('reports overflow as booleans, never as raw scroll numbers', () => {
    const { host, content } = harness();
    Object.defineProperty(content, 'scrollHeight', { value: 300, configurable: true });
    Object.defineProperty(content, 'clientHeight', { value: 96, configurable: true });

    const result = measureTextContent(host, 'text-1');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.overflow).toEqual({ x: false, y: true });
  });
});

describe('the render-layer primitives', () => {
  it('`isRendered` is false for a detached element, not just a hidden one', () => {
    const { frame } = harness();
    expect(isRendered(frame)).toBe(true);
    frame.remove();
    expect(isRendered(frame)).toBe(false);
  });

  it('`contentBoxSize` reads the content box', () => {
    const { content } = harness();
    expect(contentBoxSize(content)).toEqual({ width: 200, height: 96 });
  });

  it('`overflowOf` compares strictly, so equal is not overflowing', () => {
    const { content } = harness();
    Object.defineProperty(content, 'scrollHeight', { value: 96, configurable: true });
    Object.defineProperty(content, 'clientHeight', { value: 96, configurable: true });
    expect(overflowOf(content)).toEqual({ x: false, y: false });
  });

  it('`observeContentBox` returns a disposer that is safe to call twice', () => {
    const { content } = harness();
    const seen: { width: number; height: number }[] = [];
    const dispose = observeContentBox(content, (size) => seen.push(size));

    // happy-dom has no ResizeObserver, so the disposer is a no-op — which must still be
    // callable, twice, without throwing. A disposer that throws on a second call is a
    // disposer callers start guarding against.
    expect(() => {
      dispose();
      dispose();
    }).not.toThrow();
    expect(seen).toEqual([]);
  });
});

describe('observeTextContent and textNodeIds', () => {
  it('observeTextContent is a no-op for an unknown node rather than throwing', () => {
    const { host } = harness();
    let called = 0;
    const dispose = observeTextContent(host, 'nope', () => {
      called += 1;
    });
    dispose();
    expect(called).toBe(0);
  });

  it('textNodeIds lists only text frames', () => {
    const page = createPage({
      objects: [
        createRectNode({ name: 'a' }),
        createTextFrameNode({ name: 'b' }),
        createRectNode({ name: 'c' }),
      ],
    });
    const doc = createDocument({ pages: [page] });
    const ids = textNodeIds(doc);

    expect(ids).toHaveLength(1);
    expect(ids[0]).toBe(page.objects[1]?.id);
  });
});
