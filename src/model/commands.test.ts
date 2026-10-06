/**
 * Command funnel and history — the pure core of M2.
 *
 * These are unit tests rather than browser tests on purpose: everything here is
 * plain data in and plain data out, so the interesting questions ("does one drag
 * become one undo step?", "does a no-op leave history alone?") can be answered
 * exhaustively and instantly, with no DOM and no timing.
 */

import { describe, expect, it } from 'vitest';
import type { Document, Node, Page, Transform2D } from './types';
import { apply, describeCommand, isNoop } from './commands';
import { createDocument, createRectNode, createTransform } from './factory';

/** `createPage` generates its own id, and these tests address pages by name. */
const page = (id: string, objects: Page['objects']): Page => ({
  id,
  name: id,
  background: { type: 'solid', color: '#ffffff' },
  objects,
});

/**
 * A purpose-built two-page, three-object fixture.
 *
 * Deliberately not `createSampleDocument()`: these tests assert on exact ids and
 * counts, so they should not break because a demo document grew a shape. The
 * non-round coordinates also mean a test cannot accidentally write a value the node
 * already holds and get a no-op instead of a change.
 */
function makeDoc(): Document {
  return createDocument({
    pages: [
      page('p1', [
        createRectNode({ id: 'a', transform: createTransform({ x: 12.5, y: 8, width: 100, height: 50 }) }),
        createRectNode({ id: 'b', transform: createTransform({ x: 240, y: 8, width: 100, height: 50 }) }),
      ]),
      page('p2', [createRectNode({ id: 'c' })]),
    ],
  });
}

const doc = makeDoc;

function ids(d: Document): string[] {
  return d.pages.flatMap((page) => page.objects.map((node) => node.id));
}

function transformOf(d: Document, id: string): Transform2D {
  for (const page of d.pages) {
    const node = page.objects.find((candidate) => candidate.id === id);
    if (node !== undefined) return node.transform;
  }
  throw new Error(`no node ${id}`);
}

describe('command funnel', () => {
  it('returns the same document reference for a no-op', () => {
    const start = doc();
    const id = ids(start)[0];
    if (id === undefined) throw new Error('sample document has no objects');

    // The identity patch: every field already holds this value.
    const current = transformOf(start, id);
    const next = apply(start, { type: 'setTransform', ids: [id], patch: current });

    expect(next).toBe(start);
    expect(isNoop(start, { type: 'setTransform', ids: [id], patch: current })).toBe(true);
  });

  it('is inert for ids that do not exist, preserving reference identity', () => {
    const start = doc();
    const next = apply(start, { type: 'setTransform', ids: ['nope'], patch: { x: 10 } });
    expect(next).toBe(start);
  });

  it('does not mutate the input document', () => {
    const start = doc();
    const before = JSON.stringify(start);
    const id = ids(start)[0] ?? '';
    apply(start, { type: 'setTransform', ids: [id], patch: { x: 999 } });
    expect(JSON.stringify(start)).toBe(before);
  });

  it('structurally shares untouched pages', () => {
    const start = doc();
    const id = ids(start)[0] ?? '';
    const next = apply(start, { type: 'setTransform', ids: [id], patch: { x: 1 } });
    const changedIndex = start.pages.findIndex((page) =>
      page.objects.some((node) => node.id === id),
    );
    expect(next.pages[changedIndex]).not.toBe(start.pages[changedIndex]);
    start.pages.forEach((page, index) => {
      if (index !== changedIndex) expect(next.pages[index]).toBe(page);
    });
  });

  it('applies a batch left to right', () => {
    const start = doc();
    const [a, b] = ids(start);
    if (a === undefined || b === undefined) throw new Error('need two objects');

    const next = apply(start, {
      type: 'batch',
      cmds: [
        { type: 'setTransform', ids: [a], patch: { x: 50 } },
        { type: 'setTransform', ids: [a], patch: { x: 70 } },
        { type: 'setTransform', ids: [b], patch: { x: 20 } },
      ],
    });

    expect(transformOf(next, a).x).toBe(70);
    expect(transformOf(next, b).x).toBe(20);
  });

  it('removes across every page', () => {
    const start = doc();
    const removed = ids(start).slice(0, 2);
    const next = apply(start, { type: 'remove', ids: removed });
    for (const id of removed) expect(ids(next)).not.toContain(id);
  });

  it('reorders within a page and clamps the index', () => {
    const start = doc();
    const page = start.pages[0];
    if (page === undefined) throw new Error('no pages');
    const first = page.objects[0];
    if (first === undefined) throw new Error('no objects');

    const last = apply(start, {
      type: 'reorder',
      pageId: page.id,
      id: first.id,
      toIndex: 999,
    });
    const moved = last.pages[0]?.objects;
    expect(moved?.[moved.length - 1]?.id).toBe(first.id);

    // Reordering to its own index is a no-op, not a fresh document.
    const same = apply(start, { type: 'reorder', pageId: page.id, id: first.id, toIndex: 0 });
    expect(same).toBe(start);
  });

  it('clones inserted nodes so the caller cannot mutate the document later', () => {
    const start = doc();
    const page = start.pages[0];
    if (page === undefined) throw new Error('no pages');

    const node: Node = createRectNode({
      id: 'injected',
      name: 'Injected',
      transform: createTransform({ x: 1, y: 2, width: 10, height: 10 }),
    });

    const next = apply(start, { type: 'insert', pageId: page.id, index: 0, nodes: [node] });
    node.transform.x = 999;
    expect(transformOf(next, 'injected').x).toBe(1);
  });

  it('setText only touches text frames', () => {
    const start = doc();
    const text = { blocks: [{ kind: 'paragraph' as const, runs: [{ text: 'hello' }] }] };
    const next = apply(start, { type: 'setText', nodeId: 'definitely-not-a-node', text });
    expect(next).toBe(start);
  });

  it('labels every command', () => {
    const id = 'x';
    expect(describeCommand({ type: 'setTransform', ids: [id], patch: {} })).toBe('Transform');
    expect(describeCommand({ type: 'setTransform', ids: [id, 'y'], patch: {} })).toBe('Move');
    expect(describeCommand({ type: 'remove', ids: [id] })).toBe('Delete');
    expect(describeCommand({ type: 'remove', ids: [id, 'y'] })).toBe('Delete 2 objects');
    expect(describeCommand({ type: 'setText', nodeId: id, text: { blocks: [] } })).toBe('Edit text');
    expect(describeCommand({ type: 'batch', cmds: [] })).toBe('Change');
    expect(describeCommand({ type: 'batch', cmds: [{ type: 'remove', ids: [id] }] })).toBe('Delete');
  });
});
