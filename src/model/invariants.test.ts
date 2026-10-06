import { describe, expect, it } from 'vitest';
import { resetIds } from '../core/ids';
import { createRectNode, createSampleDocument, createTransform } from './factory';
import { validateDocument } from './invariants';
import { apply } from './commands';
import type { Document, Page } from './types';

/**
 * The sample document's contents are a *fixture*, not a contract.
 *
 * These tests assert behaviour, so they address objects by index relative to what is
 * already there rather than by absolute count. Pinning the count meant adding a text
 * frame to the sample — a content change with no architectural meaning — broke four
 * tests that were never about the number of objects.
 */
const page0 = (doc: Document): Page => doc.pages[0]!;
const firstRectId = (doc: Document): string => {
  const shape = page0(doc).objects.find((node) => node.type === 'shape');
  if (shape === undefined) throw new Error('The sample document has no shape');
  return shape.id;
};
const names = (doc: Document): string[] => page0(doc).objects.map((node) => node.name);

describe('invariants', () => {
  it('accepts the sample document', () => {
    resetIds();
    expect(validateDocument(createSampleDocument())).toEqual([]);
  });

  it('rejects a negative size', () => {
    resetIds();
    const doc = createSampleDocument();
    const node = doc.pages[0]!.objects[0]!;
    doc.pages[0]!.objects[0] = { ...node, transform: { ...node.transform, width: -1 } };
    expect(validateDocument(doc)).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/non-negative/) }),
    ]);
  });

  it('rejects a zero scale, which would make the matrix non-invertible', () => {
    resetIds();
    const doc = createSampleDocument();
    const node = doc.pages[0]!.objects[0]!;
    doc.pages[0]!.objects[0] = { ...node, transform: { ...node.transform, scaleX: 0 } };
    expect(validateDocument(doc)[0]?.message).toMatch(/non-invertible/);
  });

  it('rejects duplicate node ids across pages', () => {
    resetIds();
    const doc = createSampleDocument();
    const node = doc.pages[0]!.objects[0]!;
    doc.pages.push({ ...doc.pages[0]!, id: 'page_2', objects: [{ ...node }] });
    expect(validateDocument(doc)[0]?.message).toMatch(/duplicate or cyclic/);
  });

  it('rejects a document with no pages', () => {
    resetIds();
    expect(validateDocument({ ...createSampleDocument(), pages: [] })).toEqual([
      { path: 'pages', message: 'document has no pages' },
    ]);
  });
});

/**
 * Invariants must hold across the command funnel, not just on hand-built documents.
 *
 * These use `apply` rather than the M0 `model/mutations.ts` helpers, which M2
 * removed. A parallel set of mutators alongside the funnel is exactly the second
 * path into the model that §4.2 exists to prevent — and a test using it would have
 * been exercising a route nothing in the application can take.
 */
describe('invariants across the command funnel', () => {
  const insert = (doc: Document, name: string, index?: number): Document => {
    const objects = page0(doc).objects;
    return apply(doc, {
      type: 'insert',
      pageId: page0(doc).id,
      index: index ?? objects.length,
      nodes: [createRectNode({ name })],
    });
  };

  it('inserts a node without touching the original document', () => {
    resetIds();
    const doc = createSampleDocument();
    const before = page0(doc).objects.length;
    const next = insert(doc, 'probe');

    expect(page0(doc).objects).toHaveLength(before);
    expect(page0(next).objects).toHaveLength(before + 1);
    expect(next).not.toBe(doc);
    expect(page0(next)).not.toBe(page0(doc));
  });

  it('clones the inserted node so later edits do not alias it', () => {
    resetIds();
    const doc = createSampleDocument();
    const probe = createRectNode({ name: 'probe' });
    const next = apply(doc, {
      type: 'insert',
      pageId: page0(doc).id,
      index: page0(doc).objects.length,
      nodes: [probe],
    });

    const inserted = page0(next).objects[page0(next).objects.length - 1];
    expect(inserted).not.toBe(probe);
    expect(inserted).toEqual(probe);
  });

  it('inserts at an explicit index', () => {
    resetIds();
    let doc = createSampleDocument();
    const firstName = page0(doc).objects[0]?.name ?? '';
    doc = insert(doc, 'a');
    doc = insert(doc, 'b', 0);

    const all = names(doc);
    expect(all[0]).toBe('b');
    expect(all[all.length - 1]).toBe('a');
    expect(all).toContain(firstName);
  });

  it('patches a transform immutably', () => {
    resetIds();
    const doc = createSampleDocument();
    const id = firstRectId(doc);
    const node = page0(doc).objects.find((candidate) => candidate.id === id)!;
    const next = apply(doc, { type: 'setTransform', ids: [id], patch: { x: 99 } });

    const patched = page0(next).objects.find((candidate) => candidate.id === id)!;
    expect(node.transform.x).not.toBe(99);
    expect(patched.transform.x).toBe(99);
    // Unspecified fields are preserved.
    expect(patched.transform.y).toBe(node.transform.y);
  });

  it('is inert for a node that does not exist, rather than throwing', () => {
    resetIds();
    const doc = createSampleDocument();
    // The funnel is total: a stale id from a race is a no-op, not a crash. This is a
    // behaviour change from the M0 mutators, which threw, and it is deliberate.
    expect(apply(doc, { type: 'setTransform', ids: ['nope'], patch: { x: 1 } })).toBe(doc);
  });

  it('removes by id', () => {
    resetIds();
    const doc = createSampleDocument();
    const id = firstRectId(doc);
    const remaining = page0(doc).objects.length - 1;

    const next = apply(doc, { type: 'remove', ids: [id] });
    expect(page0(next).objects).toHaveLength(remaining);
    expect(names(next)).not.toContain('Rectangle 1');
  });

  it('reverses paint order without mutating', () => {
    resetIds();
    const original = createSampleDocument();
    const targetId = page0(original).objects[0]!.id;
    const targetName = page0(original).objects[0]!.name;
    const originalNames = names(original);

    const doc = insert(original, 'top');

    // Move the original object one slot towards the end, then the one that was
    // ahead of it into the gap. Two single-node moves — `reorder` moves one object,
    // which is what a layers panel needs; there is no bulk reverse.
    const first = apply(doc, {
      type: 'reorder',
      pageId: page0(doc).id,
      id: targetId,
      toIndex: 1,
    });
    const secondId = page0(first).objects[0]!.id;
    const reversed = apply(first, {
      type: 'reorder',
      pageId: page0(first).id,
      id: secondId,
      toIndex: 0,
    });

    const after = names(reversed);
    expect(after[0]).not.toBe(targetName);
    expect(after).toContain(targetName);

    // Immutability: the insert left `original` alone, and neither move touched the
    // document it was given.
    expect(names(original)).toEqual(originalNames);
    expect(names(doc)).toEqual([...originalNames, 'top']);
  });

  it('keeps the sample document valid through a sequence of commands', () => {
    resetIds();
    let doc = createSampleDocument();
    doc = insert(doc, 'probe');
    doc = apply(doc, {
      type: 'setTransform',
      ids: [page0(doc).objects[0]!.id],
      patch: { x: 10 },
    });
    doc = apply(doc, {
      type: 'reorder',
      pageId: page0(doc).id,
      id: page0(doc).objects[0]!.id,
      toIndex: 1,
    });
    doc = apply(doc, { type: 'remove', ids: [page0(doc).objects[0]!.id] });

    expect(validateDocument(doc)).toEqual([]);
    expect(createTransform()).toMatchObject({ scaleX: 1, scaleY: 1 });
  });
});