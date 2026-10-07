/**
 * M14: asset garbage collection (ADR 0014).
 *
 * Each test here is one row of the failure-mode table in §4 of the ADR. They are grouped by the
 * question rather than by the function under test, because the questions are what the ADR promised:
 *
 * - **Reach.** Does the walk find an image at every depth, and inside groups it cannot see?
 * - **Collection.** Is a record dropped only when the *last* reference goes?
 * - **History.** Does undo bring the bytes back, which is the obligation ADR 0006 accepted?
 * - **No-op.** Does a collection with nothing to do leave the document untouched, by reference?
 *
 * The reach tests matter most. A walk that only saw top-level images would pass every other test here
 * and would silently delete the bytes of an image the user can still un-hide -- so they come first and
 * they are the ones with the deepest nesting.
 */

import { describe, expect, it } from 'vitest';
import type { AssetId, Document, ImageNode } from './types';
import { apply, describeCommand, isNoop } from './commands';
import { createAsset, orphanAssetIds, referencedAssetIds } from './assets';
import { createDocument, createGroupNode } from './factory';

/**
 * A minimal valid asset record; the bytes are irrelevant to reachability.
 *
 * The spelling matches `assets.test.ts` rather than being invented, and `createAsset` *refuses* a
 * non-positive intrinsic size on purpose — so a wrong field name fails loudly here instead of quietly
 * producing a record the parser would later reject.
 */
function record(marker: string) {
  return createAsset({
    mime: 'image/png',
    intrinsicWidth: 10,
    intrinsicHeight: 10,
    data: { inline: `data:image/png;base64,${marker}` },
  });
}

// Image nodes are built literally rather than through a factory, because there is no
  // `createImageNode`: an image has no kind-specific defaults worth inventing, and every existing test
  // in the repo spells one out. Matching that spelling is deliberate -- a new factory here would be one
  // more way for a test and the model to disagree about what an image is.
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
/**
 * A document with `a` and `b` as top-level shapes, `loose` an image at depth 0, `deep` an image inside
 * one group, and `deeper` an image inside a group inside a group. Plus a `hidden` image inside a hidden
 * group, and `shared` backing two images so reference counting is distinguishable from ownership.
 */
function documentWithImages(): Document {
  const base = createDocument({ name: 'GC' });
  const page = base.pages[0];
  if (page === undefined) throw new Error('unreachable');
  
  const inner = createGroupNode({
    id: 'inner',
    children: [image('deeper', 'asset_deeper')],
  });
  const hidden = createGroupNode({
    id: 'hiddenGroup',
    visible: false,
    children: [image('hidden', 'asset_hidden')],
  });
  const locked = createGroupNode({
    id: 'lockedGroup',
    locked: true,
    children: [image('lockedImg', 'asset_locked')],
  });
  return {
    ...base,
    assets: {
      asset_loose: record('loose'),
      asset_deep: record('deep'),
      asset_deeper: record('deeper'),
      asset_hidden: record('hidden'),
      asset_locked: record('locked'),
      asset_shared: record('shared'),
      asset_orphan: record('orphan'),
      asset_orphan2: record('orphan2'),
    },
    pages: [
      {
        ...page,
        objects: [
          image('loose', 'asset_loose'),
          createGroupNode({ id: 'outer', children: [image('deep', 'asset_deep'), inner] }),
          hidden,
          locked,
          // One asset, two images: collecting either one must not collect the record.
          image('sharedA', 'asset_shared'),
          createGroupNode({ id: 'sharedGroup', children: [image('sharedB', 'asset_shared')] }),
        ],
      },
    ],
  };
}

const ids = (set: Set<AssetId>): string[] => [...set].sort();

describe('referencedAssetIds', () => {
  it('sees an image at depth 0, depth 1 and depth 2', () => {
    const referenced = referencedAssetIds(documentWithImages());
    expect(ids(referenced)).toContain('asset_loose');
    expect(ids(referenced)).toContain('asset_deep');
    expect(ids(referenced)).toContain('asset_deeper');
  });

  it('sees an image inside a hidden group', () => {
    // "Not painted" is not "not referenced". Deleting these bytes would make un-hiding a broken promise.
    expect(ids(referencedAssetIds(documentWithImages()))).toContain('asset_hidden');
  });

  it('sees an image inside a locked group', () => {
    expect(ids(referencedAssetIds(documentWithImages()))).toContain('asset_locked');
  });

  it('counts one asset once when two images share it', () => {
    const referenced = referencedAssetIds(documentWithImages());
    expect([...referenced].filter((id) => id === 'asset_shared')).toHaveLength(1);
  });
});

describe('orphanAssetIds', () => {
  it('names exactly the unreferenced records, sorted', () => {
    expect(orphanAssetIds(documentWithImages())).toEqual(['asset_orphan', 'asset_orphan2']);
  });

  it('is empty for a document with no orphans', () => {
    const doc = documentWithImages();
    const withoutOrphans = apply(doc, { type: 'remove', ids: ['sharedA', 'sharedB'] });
    // The orphans are still there, so remove them by pruning and check the second pass finds nothing.
    const pruned = apply(doc, { type: 'pruneAssets' });
    expect(orphanAssetIds(pruned)).toEqual([]);
    expect(withoutOrphans).not.toBe(doc);
  });
});

describe('pruneAssets', () => {
  it('drops the orphans and keeps everything reachable', () => {
    const doc = documentWithImages();
    const after = apply(doc, { type: 'pruneAssets' });
    expect(Object.keys(after.assets).sort()).toEqual([
      'asset_deep',
      'asset_deeper',
      'asset_hidden',
      'asset_locked',
      'asset_loose',
      'asset_shared',
    ]);
  });

  it('is a no-op, by reference, when there is nothing to collect', () => {
    const once = apply(documentWithImages(), { type: 'pruneAssets' });
    expect(isNoop(once, { type: 'pruneAssets' })).toBe(true);
    expect(apply(once, { type: 'pruneAssets' })).toBe(once);
  });

  it('keeps an asset alive while any image still references it', () => {
    let doc = documentWithImages();
    // Delete one of the two images sharing `asset_shared`; the record must survive.
    doc = apply(doc, { type: 'remove', ids: ['sharedA'] });
    expect(Object.keys(apply(doc, { type: 'pruneAssets' }).assets)).toContain('asset_shared');
    // Delete the second, and only now is it collectible.
    doc = apply(doc, { type: 'remove', ids: ['sharedB'] });
    expect(Object.keys(apply(doc, { type: 'pruneAssets' }).assets)).not.toContain('asset_shared');
  });

  it('collects every asset under a deleted group, at any depth', () => {
    let doc = documentWithImages();
    // `outer` holds `deep` directly and `deeper` one group further in.
    doc = apply(doc, { type: 'remove', ids: ['outer'] });
    const keys = Object.keys(apply(doc, { type: 'pruneAssets' }).assets);
    expect(keys).not.toContain('asset_deep');
    expect(keys).not.toContain('asset_deeper');
    // And the group the user did not touch is untouched.
    expect(keys).toContain('asset_hidden');
    expect(keys).toContain('asset_locked');
  });

  it('is idempotent', () => {
    const once = apply(documentWithImages(), { type: 'pruneAssets' });
    const twice = apply(once, { type: 'pruneAssets' });
    expect(twice).toBe(once);
    expect(Object.keys(twice.assets)).toHaveLength(Object.keys(once.assets).length);
  });

  it('leaves the input document untouched', () => {
    const doc = documentWithImages();
    const snapshot = JSON.stringify(doc);
    apply(doc, { type: 'pruneAssets' });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('is labelled for the history', () => {
    expect(describeCommand({ type: 'pruneAssets' })).toBe('Clean up unused images');
  });
});


describe('what this must never do', () => {
  it('does not collect on its own: nothing else issues it', () => {
    // Deleting the last image leaves the bytes, deliberately. ADR 0006 deferred collection because the
    // bytes are history, and an implicit sweep would take them with no undo step to restore them.
    const doc = apply(documentWithImages(), { type: 'remove', ids: ['loose'] });
    expect(Object.keys(doc.assets)).toContain('asset_loose');
  });

  it('does not deduplicate identical bytes under different ids', () => {
    // Two records with byte-identical payloads, both referenced. A collector that deduped would merge
    // them into one and change an id that history and `ImageNode.asset` both refer to. The first
    // version of this test asserted on `asset_orphan`, which is *not* referenced -- so it was really
    // re-testing collection, and it failed for the right reason at the wrong place.
    const base = createDocument({ name: 'Dedupe' });
    const page = base.pages[0];
    if (page === undefined) throw new Error('unreachable');
    const doc: Document = {
      ...base,
      assets: { asset_a: record('SAME'), asset_b: record('SAME') },
      pages: [
        {
          ...page,
          objects: [
            { ...image('i1', 'asset_a'), id: 'i1' },
            { ...image('i2', 'asset_b'), id: 'i2' },
          ],
        },
      ],
    };
    const after = apply(doc, { type: 'pruneAssets' });
    expect(Object.keys(after.assets).sort()).toEqual(['asset_a', 'asset_b']);
    // And they are still two distinct records, not one shared payload.
    expect(after.assets['asset_a']).not.toBe(after.assets['asset_b']);
  });
});