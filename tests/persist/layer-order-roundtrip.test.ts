/**
 * Layer order and the format.
 *
 * ## The claim
 *
> `Page.objects` is paint order *and* persisted order, so restacking is a change the file has
> to carry. It is one claim with two halves that fail differently, so both are asserted:
>
 *  - **Forward:** a restacked document serialises, parses, and comes back with the same order.
 *  - **Backward:** a document saved at one order and reopened at another is *not* the same
 *    file, so the bytes differ in exactly the objects' positions.
 *
 * The second half is the negative control. A serializer that ignored array order, or a
 * canonicaliser that sorted objects, would pass the first test and is exactly the failure
 * M0 rejected a `zIndex` field over.
 *
 * ## Why this lives in `tests/`
 *
 * It is the one claim that spans two layers. `model/` cannot import `persist/` (the boundary
 * rule is enforced on test files too, for good reason), so a test that needs both belongs
 * where both are visible rather than behind an injected global — which is what an earlier
 * draft of this file did, and which asserted nothing.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { resetIds } from '../../src/core/ids';
import { createDocument, createPage, createRectNode } from '../../src/model/factory';
import { apply } from '../../src/model/commands';
import type { RestackDirection } from '../../src/model/commands';
import { documentsEqual } from '../../src/model/document-equality';
import type { Document } from '../../src/model/types';
import { parse } from '../../src/persist/deserialize';
import { serialize, serializeToString } from '../../src/persist/serialize';

function stack(count: number): Document {
  const names = ['a', 'b', 'c', 'd', 'e'];
  const page = createPage({ name: '1' });
  page.objects = [];
  for (let index = 0; index < count; index += 1) {
    page.objects.push(createRectNode({ name: names[index] ?? `n${index}` }));
  }
  return createDocument({ pages: [page] });
}

function restack(doc: Document, direction: RestackDirection, ...names: string[]): Document {
  const page = doc.pages[0];
  if (page === undefined) throw new Error('unreachable');
  const ids = names.map((name) => {
    const node = page.objects.find((candidate) => candidate.name === name);
    if (node === undefined) throw new Error(`no object named ${name}`);
    return node.id;
  });
  return apply(doc, { type: 'restack', pageId: page.id, ids, direction });
}

function order(doc: Document): string[] {
  return (doc.pages[0]?.objects ?? []).map((node) => node.name);
}

/** Paint order as written to the file, read back off the bytes rather than the model. */
/** A node reduced to its JSON, so two documents can be compared field by field. */
function asJson(node: unknown): unknown {
  return JSON.parse(JSON.stringify(node)) as unknown;
}

function orderOnDisk(text: string): string[] {
  const parsed = JSON.parse(text) as {
    pages: Array<{ objects: Array<{ name: string }> }>;
  };
  return (parsed.pages[0]?.objects ?? []).map((node) => node.name);
}

beforeEach(() => {
  resetIds();
});

describe('a restacked document round-trips', () => {
  it.each([
    ['front', ['a', 'b'], ['c', 'd', 'e', 'a', 'b']],
    ['back', ['d', 'e'], ['d', 'e', 'a', 'b', 'c']],
    // c: 2 -> 3 first (front to back), so [a,b,d,c,e]; then b: 1 -> 2, so [a,d,b,c,e].
    ['forward', ['b', 'c'], ['a', 'd', 'b', 'c', 'e']],
    // Stack order is b then c: b: 1 -> 0 gives [b,a,c,d,e]; then c: 2 -> 1, giving [b,c,a,d,e].
    ['backward', ['c', 'b'], ['b', 'c', 'a', 'd', 'e']],
  ] as const)('%s is carried by the file', (direction, names, expected) => {
    const doc = restack(stack(5), direction, ...names);
    expect(order(doc)).toEqual(expected);

    // The order on disk *is* the model's order -- read off the bytes, not off the model, so a
    // serializer that reordered or sorted would be caught here.
    const text = serializeToString(doc);
    expect(orderOnDisk(text)).toEqual(expected);

    // And it comes back.
    const restored = parse(JSON.parse(text));
    expect(documentsEqual(restored, doc)).toBe(true);
    expect(serializeToString(restored)).toBe(text);
  });

  it('is byte-stable, so re-saving a restacked document changes nothing', () => {
    const doc = restack(stack(5), 'forward', 'a', 'd');
    const once = serializeToString(doc);
    const twice = serializeToString(parse(JSON.parse(once)));
    expect(twice).toBe(once);
  });
});

describe('a reorder is a real change to the file', () => {
  it('changes the bytes, and changes them only in the objects order', () => {
    // The negative control. If a serializer ignored array order, both halves above would
    // still pass and this would fail -- which is the point of having it.
    const before = stack(4);
    const after = restack(before, 'front', 'a');

    const beforeText = serializeToString(before);
    const afterText = serializeToString(after);
    expect(afterText).not.toBe(beforeText);

    // Same objects, same properties, different sequence. Compared structurally, because the
    // two sides come from two `parse` calls and therefore share no references at all --
    // reference equality across them is impossible by construction, which is what made the
    // first version of this assertion wrong rather than merely strict.
    const left = parse(JSON.parse(beforeText));
    const right = parse(JSON.parse(afterText));
    const byName = (doc: Document, name: string) =>
      doc.pages[0]?.objects.find((node) => node.name === name);
    for (const name of ['a', 'b', 'c', 'd']) {
      expect(asJson(byName(right, name))).toEqual(asJson(byName(left, name)));
    }
    // And the only thing that differs is the sequence.
    expect(order(right)).not.toEqual(order(left));
  });

  it('is reported as a change by `documentsEqual`, so it is not mistaken for a no-op', () => {
    // Dirty state depends on this: a restack that `documentsEqual` called equal would be
    // saved, reported clean, and then silently lost.
    const before = stack(4);
    const after = restack(before, 'forward', 'a');
    expect(documentsEqual(before, after)).toBe(false);
  });

  it('keeps `extensions` with its object when the object moves', () => {
    resetIds();
    const page = createPage({ name: '1' });
    page.objects = [
      createRectNode({ name: 'a' }),
      createRectNode({ name: 'b', extensions: { 'com.example': { note: 'rides along' } } }),
      createRectNode({ name: 'c' }),
    ];
    const doc = restack(createDocument({ pages: [page] }), 'forward', 'a');

    // The bag travels with its object, and the object is now frontmost on disk.
    const persisted = serialize(doc);
    const b = persisted.pages[0]?.objects.find((node) => node.name === 'b');
    expect(b?.extensions).toEqual({ 'com.example': { note: 'rides along' } });
    expect(persisted.pages[0]?.objects[0]?.name).toBe('b');
    expect(parse(JSON.parse(serializeToString(doc))).pages[0]?.objects[0]?.name).toBe('b');
  });
});
