// @vitest-environment happy-dom

/**
 * The reconciler is the load-bearing piece of M0: if it is wrong, every feature
 * built on top of it is wrong. These tests assert the four paths it must handle
 * (insert / update / remove / reorder), element identity across renders, and the
 * style-diff cache.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetIds } from '../core/ids';
import { createPage, createRectNode, createSampleDocument, createDocument, createTransform } from '../model/factory';
import { apply } from '../model/commands';
import type { Document, Node } from '../model/types';
import { DocumentView } from './document-view';

/** Gap between pages in document px; matches the app's M1 value. */
const GAP = 32;

function mount() {
  const pages = document.createElement('div');
  const view = new DocumentView({ pages });
  return { view, pages };
}

/** The single page element of a one-page document. */
function onlyPage(view: DocumentView): HTMLElement {
  const [id] = pageIdsOf(view);
  if (id === undefined) throw new Error('No page mounted');
  const element = view.pageElementFor(id);
  if (element === undefined) throw new Error('Page element missing');
  return element;
}

/** Mounted page ids, in DOM order. */
function pageIdsOf(view: DocumentView): string[] {
  return view.mountedPageIds();
}

/** The objects container inside a page element. */
function objectsOf(page: HTMLElement): HTMLElement {
  const objects = page.querySelector('.objects');
  if (objects === null) throw new Error('Page has no objects container');
  return objects as HTMLElement;
}

function idsOf(doc: Document): string[] {
  return doc.pages[0]!.objects.map((n) => n.id);
}

/**
 * A one-shape document for the reconciler tests.
 *
 * Deliberately not the sample document. These tests assert diffing behaviour, and the
 * sample now carries a text frame too — so every object count here became a
 * tripwire on unrelated content. A fixture that says what it contains makes the
 * assertions mean what they say.
 */
function oneShape(transform = createTransform({ x: 24, y: 32, width: 120, height: 68 })) {
  return createDocument({
    pages: [
      createPage({
        objects: [
          createRectNode({
            name: 'Rectangle 1',
            transform,
            shape: { cornerRadius: 8 },
            fill: { type: 'solid', color: '#4f7cff' },
          }),
        ],
      }),
    ],
  });
}

/**
 * Test-local document builders, expressed as commands.
 *
 * These replace the M0 `model/mutations.ts` helpers, which M2 deleted. They used to
 * be production code; keeping them here rather than in `model/` is the point — the
 * funnel is the only way into the document, so a test that mutated the model by
 * another route would have been testing something the application cannot do.
 */

function insertNode(doc: Document, node: Node, index?: number): Document {
  const page = doc.pages[0]!;
  return apply(doc, {
    type: 'insert',
    pageId: page.id,
    index: index ?? page.objects.length,
    nodes: [node],
  });
}

function removeNode(doc: Document, id: string): Document {
  return apply(doc, { type: 'remove', ids: [id] });
}

/**
 * Reverses paint order as the two single-node moves it actually is.
 *
 * There is no bulk "reverse" command, and adding one for a test would be the tail
 * wagging the dog — `reorder` moves one object, which is what a layers panel needs.
 * Reversing `[a,b,c]` is `a → 2` then `b → 1`.
 */
function reversePaintOrder(doc: Document): Document {
  const page = doc.pages[0]!;
  const [first, second] = page.objects;
  if (first === undefined || second === undefined) return doc;

  const afterFirst = apply(doc, {
    type: 'reorder',
    pageId: page.id,
    id: first.id,
    toIndex: page.objects.length - 1,
  });
  return apply(afterFirst, { type: 'reorder', pageId: page.id, id: second.id, toIndex: 1 });
}

/** A rotated, offset rectangle, so a probe is never confused with its neighbour. */
function makeProbeNode(index: number) {
  return createRectNode({
    name: `Probe ${index}`,
    transform: createTransform({
      x: 40 + index * 18,
      y: 140 + index * 14,
      width: 90,
      height: 52,
      rotation: (index * 15 * Math.PI) / 180,
    }),
    shape: { cornerRadius: 4 },
    fill: { type: 'solid', color: index % 2 === 0 ? '#f2994a' : '#27ae60' },
  });
}

describe('DocumentView rendering', () => {
  beforeEach(() => {
    resetIds();
  });

  it('projects a rect onto CSS that matches the model', () => {
    const { view } = mount();
    const doc = oneShape();
    view.render(doc, GAP);

    const objects = objectsOf(onlyPage(view));
    const node = doc.pages[0]!.objects[0]!;
    const el = view.elementFor(node.id);
    expect(el).toBeDefined();
    expect(objects.children).toHaveLength(1);
    expect(objects.firstElementChild).toBe(el);

    expect(el!.style.left).toBe(`${node.transform.x}px`);
    expect(el!.style.top).toBe(`${node.transform.y}px`);
    expect(el!.style.width).toBe(`${node.transform.width}px`);
    expect(el!.style.height).toBe(`${node.transform.height}px`);
    // rotation 0, scale 1 → the identity matrix
    expect(el!.style.transform).toBe('matrix(1, 0, 0, 1, 0, 0)');
    expect(el!.style.backgroundColor).toBe('#4f7cff');
    expect(el!.style.borderRadius).toBe('8px');
  });

  it('projects a text frame onto CSS, including typography', () => {
    const { view } = mount();
    const doc = createSampleDocument();
    view.render(doc, GAP);

    const text = doc.pages[0]!.objects.find((node) => node.type === 'textFrame');
    if (text?.type !== 'textFrame') throw new Error('The sample document has no text frame');

    const frame = view.elementFor(text.id);
    expect(frame).toBeDefined();

    // Geometry comes from the transform, like any other object.
    expect(frame!.style.left).toBe(`${text.transform.x}px`);
    expect(frame!.style.width).toBe(`${text.transform.width}px`);

    const content = frame!.querySelector('.p1-text-content') as HTMLElement;
    expect(content).not.toBeNull();
    // Typography is projected onto the content element, not the frame: the frame is
    // a box, the content is where the browser lays out lines.
    expect(content.style.fontSize).toBe('16px');
    // Unitless, so it survives a font-size change.
    expect(content.style.lineHeight).toBe('1.5');
    expect(content.style.letterSpacing).toBe('0.005em');
    expect(content.style.fontFamily).toContain('Georgia');
    // Written verbatim: the renderer passes colour through rather than parsing and
    // re-serialising it, so any CSS colour string is legal.
    expect(content.style.color).toBe('#1a1a1a');

    // Content is the model's HTML, with alignment written as an inline style.
    const paragraphs = content.querySelectorAll('p');
    expect(paragraphs.length).toBe(text.text.blocks.length);
    expect(paragraphs[2]?.style.textAlign).toBe('center');
  });

  it('sizes the page in document px from the physical page size', () => {
    const { view } = mount();
    view.render(createSampleDocument(), GAP);
    const page = onlyPage(view);
    // A4 portrait: 210mm × 297mm at 96px/in.
    expect(parseFloat(page.style.width)).toBeCloseTo(793.7, 1);
    expect(parseFloat(page.style.height)).toBeCloseTo(1122.5, 1);
  });

  it('writes a rotation matrix with stable rounding', () => {
    const { view } = mount();
    let doc = createSampleDocument();
    const id = idsOf(doc)[0]!;
    doc = apply(doc, { type: 'setTransform', ids: [id], patch: { rotation: Math.PI / 2 } });
    view.render(doc, GAP);

    // cos(π/2) is 6.1e-17, which must round to exactly 0 or the style cache
    // would see a "change" on every render.
    expect(view.elementFor(id)!.style.transform).toBe('matrix(0, 1, -1, 0, 0, 0)');
  });

  it('hides invisible nodes without removing them', () => {
    const { view } = mount();
    const doc = createSampleDocument();
    const id = idsOf(doc)[0]!;
    view.render(
      {
        ...doc,
        pages: [
          { ...doc.pages[0]!, objects: [{ ...doc.pages[0]!.objects[0]!, visible: false }] },
        ],
      },
      GAP,
    );
    expect(view.elementFor(id)!.style.display).toBe('none');
    expect(view.nodeCount).toBe(1);
  });

  it('applies blend mode and opacity', () => {
    const { view } = mount();
    const doc = createSampleDocument();
    const id = idsOf(doc)[0]!;
    view.render(
      {
        ...doc,
        pages: [
          {
            ...doc.pages[0]!,
            objects: [{ ...doc.pages[0]!.objects[0]!, opacity: 0.5, blendMode: 'multiply' }],
          },
        ],
      },
      GAP,
    );
    const el = view.elementFor(id)!;
    expect(el.style.opacity).toBe('0.5');
    expect(el.style.mixBlendMode).toBe('multiply');
  });
});

describe('Reconciler diffing', () => {
  // Every test below builds its document through the funnel from oneShape, so the
  // object counts they assert are counts they created.
  beforeEach(() => {
    resetIds();
  });

  it('reuses elements on update rather than recreating them', () => {
    const { view } = mount();
    const doc = oneShape();
    view.render(doc, GAP);

    const id = idsOf(doc)[0]!;
    const before = view.elementFor(id);
    view.render(apply(doc, { type: 'setTransform', ids: [id], patch: { x: 99 } }), GAP);

    expect(view.elementFor(id)).toBe(before);
    expect(objectsOf(onlyPage(view)).children).toHaveLength(1);
    expect(view.elementFor(id)!.style.left).toBe('99px');
  });

  it('inserts a new element and keeps existing ones', () => {
    const { view } = mount();
    let doc = oneShape();
    view.render(doc, GAP);
    const firstEl = view.elementFor(idsOf(doc)[0]!);

    doc = insertNode(doc, makeProbeNode(1));
    view.render(doc, GAP);

    expect(objectsOf(onlyPage(view)).children).toHaveLength(2);
    expect(view.elementFor(idsOf(doc)[0]!)).toBe(firstEl);
    expect(view.nodeCount).toBe(2);
  });

  it('removes elements that leave the model', () => {
    const { view } = mount();
    let doc = oneShape();
    doc = insertNode(doc, makeProbeNode(1));
    view.render(doc, GAP);
    expect(objectsOf(onlyPage(view)).children).toHaveLength(2);

    doc = removeNode(doc, idsOf(doc)[1]!);
    view.render(doc, GAP);

    expect(objectsOf(onlyPage(view)).children).toHaveLength(1);
    expect(view.nodeCount).toBe(1);
    expect(view.elementFor(idsOf(doc)[1]!)).toBeUndefined();
  });

  it('keeps DOM order equal to model order (paint order)', () => {
    const { view } = mount();
    let doc = oneShape();
    doc = insertNode(doc, makeProbeNode(1));
    doc = insertNode(doc, makeProbeNode(2));
    view.render(doc, GAP);

    const originalOrder = idsOf(doc);
    const originalElements = originalOrder.map((id) => view.elementFor(id));
    expect(originalElements.every((el) => el !== undefined)).toBe(true);

    doc = reversePaintOrder(doc);
    view.render(doc, GAP);

    const reversedOrder = idsOf(doc);
    expect(reversedOrder).toEqual([...originalOrder].reverse());

    // DOM position i holds the element for model position i — DOM order *is*
    // paint order. Elements are moved, not recreated, which is what keyed
    // diffing buys us.
    const objects = objectsOf(onlyPage(view));
    reversedOrder.forEach((id, index) => {
      const originalIndex = originalOrder.indexOf(id);
      expect(objects.children[index]).toBe(originalElements[originalIndex] as HTMLElement);
    });
  });

  it('reorders when a node is inserted at the front', () => {
    const { view } = mount();
    let doc = oneShape();
    doc = insertNode(doc, makeProbeNode(1));
    view.render(doc, GAP);
    const original = view.elementFor(idsOf(doc)[0]!);

    doc = insertNode(doc, createRectNode({ name: 'front' }), 0);
    view.render(doc, GAP);

    expect(original).toBeDefined();
    expect([...objectsOf(onlyPage(view)).children].indexOf(original as HTMLElement)).toBe(1);
    expect(view.elementFor(idsOf(doc)[0]!)).not.toBe(original);
  });

  it('handles an empty page and repopulating it', () => {
    const { view } = mount();
    const doc = createDocument({ pages: [createPage({ objects: [] })] });
    view.render(doc, GAP);
    expect(objectsOf(onlyPage(view)).children).toHaveLength(0);

    const populated = insertNode(doc, makeProbeNode(1));
    view.render(populated, GAP);
    expect(objectsOf(onlyPage(view)).children).toHaveLength(1);

    view.render(doc, GAP);
    expect(objectsOf(onlyPage(view)).children).toHaveLength(0);
    expect(view.nodeCount).toBe(0);
  });

  it('rejects duplicate ids in a sibling list', () => {
    const { view } = mount();
    const doc = oneShape();
    const node = doc.pages[0]!.objects[0]!;
    const bad = { ...doc, pages: [{ ...doc.pages[0]!, objects: [node, { ...node }] }] };
    expect(() => view.render(bad, GAP)).toThrow(/Duplicate node id/);
  });

  it('reports an unregistered object type clearly', () => {
    const { view } = mount();
    const doc = oneShape();
    // The assertion is about the *error*, not about any particular type -- so this uses
    // a type that will never be registered. An earlier version used `image`, which was
    // correct when images were unimplemented and stopped being correct the moment they
    // were: the test then failed for having been right about the code and wrong about
    // the future. Naming a fictional type makes the test's intent survive M6 and any
    // milestone after it.
    const bad = {
      ...doc,
      pages: [
        {
          ...doc.pages[0]!,
          objects: [
            { ...doc.pages[0]!.objects[0]!, type: 'hologram' } as unknown as Node,
          ],
        },
      ],
    };
    expect(() => view.render(bad, GAP)).toThrow(/No renderer registered for object type "hologram"/);
  });
});

describe('Style diff cache', () => {
  beforeEach(() => {
    resetIds();
  });

  it('writes nothing when the model is unchanged', () => {
    const { view } = mount();
    const doc = oneShape();
    view.render(doc, GAP);

    const el = view.elementFor(idsOf(doc)[0]!)!;
    const setProperty = vi.spyOn(el.style, 'setProperty');
    view.render(doc, GAP);
    expect(setProperty).not.toHaveBeenCalled();
  });

  it('writes only the properties that actually changed', () => {
    const { view } = mount();
    const doc = oneShape();
    view.render(doc, GAP);
    const id = idsOf(doc)[0]!;

    const el = view.elementFor(id)!;
    const setProperty = vi.spyOn(el.style, 'setProperty');
    view.render(apply(doc, { type: 'setTransform', ids: [id], patch: { x: 77 } }), GAP);

    const written = setProperty.mock.calls.map(([property]) => property);
    expect(written).toContain('left');
    expect(written).not.toContain('top');
    expect(written).not.toContain('width');
    expect(written).not.toContain('background-color');
  });
});
