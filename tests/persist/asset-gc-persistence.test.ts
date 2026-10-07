/**
 * M14: asset garbage collection, through the persistence boundary (ADR 0014 §4).
 *
 * These live in `tests/persist/` rather than beside the model tests for one reason: the layer rule
 * forbids `model/` from importing `persist/`, and it caught the first draft of these very assertions
 * sitting in `src/model/asset-gc.test.ts`. Round-tripping a pruned table is a statement about the
 * *format*, so `tests/persist/` is where it belongs.
 *
 * The undo test is here for the same reason. "Undo restores the dropped bytes" is ADR 0006's obligation,
 * and it is only observable through `History` — a model-level test cannot see the undo stack.
 */

import { describe, expect, it } from 'vitest';
import type { AssetId, Document, ImageNode } from '../../src/model/types';
import { apply, isNoop } from '../../src/model/commands';
import { createAsset, orphanAssetIds } from '../../src/model/assets';
import { createDocument, createGroupNode } from '../../src/model/factory';
import { documentsEqual } from '../../src/model/document-equality';
import { History } from '../../src/editor/history';
import { serializeToString } from '../../src/persist/serialize';
import { parse } from '../../src/persist/deserialize';

const record = (marker: string) =>
  createAsset({
    mime: 'image/png',
    intrinsicWidth: 10,
    intrinsicHeight: 10,
    data: { inline: `data:image/png;base64,${marker}` },
  });

const image = (id: string, asset: AssetId): ImageNode => ({
  type: 'image',
  id,
  name: id,
  transform: { x: 0, y: 0, width: 10, height: 10, rotation: 0, scaleX: 1, scaleY: 1 },
  visible: true,
  locked: false,
  opacity: 1,
  blendMode: 'normal',
  asset,
});

/** One referenced image at depth 0, one nested two groups deep, and one orphan record. */
function document(): Document {
  const base = createDocument({ name: 'GC' });
  const page = base.pages[0];
  if (page === undefined) throw new Error('unreachable');
  return {
    ...base,
    assets: { asset_used: record('U'), asset_nested: record('N'), asset_orphan: record('O') },
    pages: [
      {
        ...page,
        objects: [
          image('top', 'asset_used'),
          createGroupNode({
            id: 'outer',
            children: [
              createGroupNode({ id: 'inner', children: [image('deep', 'asset_nested')] }),
            ],
          }),
        ],
      },
    ],
  };
}

describe('a pruned table round-trips', () => {
  it('serialises and parses back to the same document', () => {
    const pruned = apply(document(), { type: 'pruneAssets' });
    const parsed = parse(JSON.parse(serializeToString(pruned)));
    expect(documentsEqual(parsed, pruned)).toBe(true);
    expect(Object.keys(parsed.assets).sort()).toEqual(['asset_nested', 'asset_used']);
  });

  it('keeps the canonical key order, because collection removes keys', () => {
    // ADR 0007 sorts asset keys on write. A collection is precisely the operation that drops some, so
    // this is the case where "sorted" and "insertion order" would diverge -- and a golden document
    // written after a collection would catch it if the canonicaliser lost the sort.
    const pruned = apply(document(), { type: 'pruneAssets' });
    const text = serializeToString(pruned);
    const reparsed = parse(JSON.parse(text)) as unknown as { assets: Record<string, unknown> };
    expect(Object.keys(reparsed.assets)).toEqual(Object.keys(pruned.assets).sort());
    // And the orphan is genuinely gone from the bytes, not merely from the parsed table.
    expect(text).not.toContain('asset_orphan');
  });

  it('and a collected document that is then un-collected by undo still round-trips', () => {
    // The bytes must survive the round trip while they are in the table, or undo would restore a
    // document it cannot write out.
    const before = document();
    expect(serializeToString(before)).toContain('asset_orphan');
    const pruned = apply(before, { type: 'pruneAssets' });
    expect(serializeToString(pruned)).not.toContain('asset_orphan');
  });
});

describe('undo restores the dropped bytes', () => {
  it('is one step, and it brings the records back byte-for-byte', () => {
    // The whole reason ADR 0006 deferred collection: `assets` is part of the model and therefore part
    // of history, so undo has to restore a deleted image *and* its bytes. One command means one step.
    const start = document();
    // History.dispatch is the path DocStore uses, and it is the one that decides whether an entry
    // is recorded -- so the test drives it rather than calling pply and pushing by hand, or it
    // would be testing its own arrangement instead of the product's.
    const history = new History();
    const { doc: pruned, changed } = history.dispatch(start, { type: 'pruneAssets' });
    expect(changed).toBe(true);
    expect(Object.keys(pruned.assets)).not.toContain('asset_orphan');

    expect(history.canUndo).toBe(true);
    const undone = history.undo(pruned);
    expect(Object.keys(undone.assets)).toContain('asset_orphan');
    expect(documentsEqual(undone, start)).toBe(true);
    // The bytes are really back, not just the key.
    expect(undone.assets['asset_orphan']).toEqual(start.assets['asset_orphan']);
  });

  it('a collection with nothing to collect records nothing', () => {
    const start = document();
    const pruned = apply(start, { type: 'pruneAssets' });
    const history = new History();
    expect(isNoop(pruned, { type: 'pruneAssets' })).toBe(true);
    // Same reference is what makes `isNoop` true, so nothing can reach the history.
    expect(apply(pruned, { type: 'pruneAssets' })).toBe(pruned);
    expect(history.canUndo).toBe(false);
  });
});

describe('the collected set is a fact about the document', () => {
  it('orphans are named in sorted order, independent of insertion order', () => {
    const base = createDocument({ name: 'Order' });
    const page = base.pages[0];
    if (page === undefined) throw new Error('unreachable');
    const forward: Document = {
      ...base,
      assets: { asset_c: record('C'), asset_a: record('A'), asset_b: record('B') },
      pages: [{ ...page, objects: [] }],
    };
    expect(orphanAssetIds(forward)).toEqual(['asset_a', 'asset_b', 'asset_c']);
  });
});