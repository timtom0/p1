/**
 * The golden fixture and the round-trip property.
 *
 * ## What this suite is protecting
 *
 * Three separate claims, which are easy to conflate and each of which fails differently:
 *
 * 1. **Round-trip equality.** `parse(serialize(doc))` is the *same document* as `doc`, in
 *    the project's own sense -- `documentsEqual`, the canonical model equality that also
 *    decides dirty state. Not JSON string equality: that would be a stronger claim about
 *    bytes, asserted separately below.
 * 2. **Byte stability.** The checked-in fixture is *exactly* what this build writes. That
 *    is what makes the fixture reviewable -- a diff in it is a real format change, not a
 *    reordering -- and it is the assertion that would catch a new field being added to the
 *    canonicaliser without being added to the parser.
 * 3. **Determinism.** Serialising twice gives identical bytes, and two documents built
 *    differently but describing the same thing give identical bytes.
 *
 * ## Why the fixture is a file, not a fixture helper
 *
 * `tests/golden/sample.p1doc` is hand-written, readable, and independent of the renderer:
 * no imports, no `createShapeNode`, no browser. If a future renderer changes, or the model
 * factories are renamed, the file still stands on its own -- which is what a format
 * contract needs. It is also the artefact a user would actually hand-edit, so it is
 * written to be hand-editable.
 *
 * A fixture built from the model factories would prove something weaker: that the format
 * can carry what the factories happen to produce, which is not the same question as whether
 * it can carry a document someone wrote by hand.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { documentsEqual } from '../../src/model/document-equality';
import {
  createDocument,
  createPage,

  createShapeNode,
  createTextFrameNode,
  rich,
} from '../../src/model/factory';
import { createId, reserveIds, resetIds } from '../../src/core/ids';
import type { CharFormat, Document, InlineRun, Node, ParagraphBlock } from '../../src/model/types';
import { parse, collectIds } from '../../src/persist/deserialize';
import { serialize, serializeToString } from '../../src/persist/serialize';
import {
  CURRENT_FORMAT_VERSION,
  DOCUMENT_FORMAT,
  DocumentParseError,
} from '../../src/persist/format';

const FIXTURE_PATH = fileURLToPath(new URL('../golden/sample.p1doc', import.meta.url));
const HANDWRITTEN_PATH = fileURLToPath(new URL('../golden/handwritten.p1doc', import.meta.url));
const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, 'utf8');

function loadFixture(): Document {
  return parse(JSON.parse(FIXTURE_TEXT));
}

/**
 * Both round trips at once, as a helper so every caller gets the same definition.
 *
 * `documentsEqual` is the project's canonical equality; the `toEqual` is Vitest's
 * structural equality, which additionally pins key *presence* (`undefined` versus absent)
 * and array order. Both matter, and they fail differently: `documentsEqual` would not notice
 * a `fit: undefined` appearing on a node, and `toEqual` would not notice a semantic change
 * it considers equal.
 */
function expectRoundTrips(doc: Document): Document {
  const text = serializeToString(doc);
  const restored = parse(JSON.parse(text));

  expect(documentsEqual(restored, doc)).toBe(true);
  expect(restored).toEqual(doc);

  // Byte stability: a second trip through the parser must not change the bytes.
  expect(serializeToString(restored)).toBe(text);

  return restored;
}

describe('the golden fixture', () => {
  it('parses', () => {
    const doc = loadFixture();
    expect(doc.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(doc.name).toBe('Golden fixture');
  });

  it('is already in canonical form, so the checked-in file is what this build writes', () => {
    // The strongest available statement about the format: a checked-in file survives
    // untouched. If this fails, the diff in `sample.p1doc` *is* the change -- no re-record,
    // no approve-a-new-golden-file step, which is how golden files stop being trustworthy.
    expect(serializeToString(loadFixture())).toBe(FIXTURE_TEXT);
  });

  it('loads a hand-written file, formatted differently, to the same document', () => {
    // `handwritten.p1doc` is the same document written by hand with objects collapsed onto
    // one line. It exists because "hand-inspectable" is a promise about what a *user* can
    // write, and a canonicaliser that only round-trips its own output would not honour it:
    // if the parser were sensitive to layout, a person editing the file by hand would be
    // unable to reformat it.
    const handwritten = parse(JSON.parse(readFileSync(HANDWRITTEN_PATH, 'utf8')));
    expect(documentsEqual(handwritten, loadFixture())).toBe(true);
    // And the hand-written file is normalised *to* the canonical one, rather than merely
    // comparing equal -- so saving it back produces the canonical bytes.
    expect(serializeToString(handwritten)).toBe(FIXTURE_TEXT);
  });

  it('covers everything the milestone asks a representative document to contain', () => {
    const doc = loadFixture();
    const nodes = doc.pages.flatMap((page) => page.objects);

    expect(doc.pages.length).toBeGreaterThan(1);

    const byType = (type: Node['type']) => nodes.filter((node) => node.type === type);
    expect(byType('textFrame').length).toBeGreaterThan(0);
    expect(byType('image').length).toBeGreaterThan(0);
    expect(byType('shape').length).toBeGreaterThan(0);

    // Every shape kind.
    const kinds = new Set(
      byType('shape').map((node) => (node.type === 'shape' ? node.shape.kind : '')),
    );
    expect([...kinds].sort()).toEqual(['ellipse', 'line', 'rect']);

    // Multiple paragraphs and genuinely rich inline formatting in one frame.
    const rich = nodes.find(
      (node) => node.type === 'textFrame' && node.text.blocks.length > 1,
    );
    expect(rich).toBeDefined();
    if (rich?.type !== 'textFrame') throw new Error('unreachable');
    const formats = new Set(
      rich.text.blocks.flatMap((block) =>
        block.runs.map((run) => Object.keys(run.format ?? {}).sort().join('+')),
      ),
    );
    expect(formats.has('bold')).toBe(true);
    expect(formats.has('italic')).toBe(true);
    expect(formats.has('underline')).toBe(true);
    expect(formats.has('strike')).toBe(true);
    // All four at once, so flag *order* has something to be canonical about.
    expect(formats.has('bold+italic+strike+underline')).toBe(true);

    // Rotated and scaled geometry, plus a zero-extent box that must stay legal.
    expect(nodes.some((node) => node.transform.rotation !== 0)).toBe(true);
    expect(nodes.some((node) => node.transform.scaleX !== 1 || node.transform.scaleY !== 1)).toBe(
      true,
    );
    expect(nodes.some((node) => node.transform.height === 0)).toBe(true);

    // Non-default authored visibility, lock and opacity.
    expect(nodes.some((node) => !node.visible)).toBe(true);
    expect(nodes.some((node) => node.locked)).toBe(true);
    expect(nodes.some((node) => node.opacity !== 1)).toBe(true);
    expect(nodes.some((node) => node.blendMode !== 'normal')).toBe(true);

    // Multiple assets, both storage kinds, and a shared reference across two nodes.
    expect(Object.keys(doc.assets).length).toBeGreaterThan(1);
    expect(Object.values(doc.assets).some((asset) => 'inline' in asset.data)).toBe(true);
    expect(Object.values(doc.assets).some((asset) => 'external' in asset.data)).toBe(true);
    const referenced = nodes
      .filter((node) => node.type === 'image')
      .map((node) => (node.type === 'image' ? node.asset : ''));
    expect(new Set(referenced).size).toBeLessThan(referenced.length);

    // The opaque bag, which is the only forward-compat path a node has.
    expect(nodes.some((node) => node.extensions !== undefined)).toBe(true);
  });
});

describe('round-trip', () => {
  it('restores the golden fixture exactly', () => {
    expectRoundTrips(loadFixture());
  });

  it('restores an empty document', () => {
    resetIds();
    const empty = createDocument({ name: 'Empty' });
    expect(empty.pages[0]?.objects).toEqual([]);
    expectRoundTrips(empty);
  });

  it('restores a document with no assets at all', () => {
    resetIds();
    const doc = createDocument({ name: 'No assets', assets: {} });
    expectRoundTrips(doc);
  });

  it('restores nodes with optional properties absent, and does not materialise them', () => {
    resetIds();
    // A shape with neither fill nor stroke and a text frame with no style. These are the
    // cases where a defaulting deserializer would quietly change what the document means,
    // so each is asserted on the way *back* rather than only on the way there.
    const page = createPage({ name: 'Sparse' });
    page.objects = [
      createShapeNode('rect', { name: 'Bare' }),
      createTextFrameNode({ name: 'Unstyled' }),
    ];

    const doc = createDocument({ name: 'Sparse', pages: [page] });
    const restored = expectRoundTrips(doc);

    const bare = restored.pages[0]?.objects[0];
    expect(bare).not.toHaveProperty('fill');
    expect(bare).not.toHaveProperty('stroke');
    expect(bare).not.toHaveProperty('extensions');
    const unstyled = restored.pages[0]?.objects[1];
    expect(unstyled).not.toHaveProperty('style');
    expect(unstyled).not.toHaveProperty('extensions');
  });

  it('keeps an image without an authored `fit` without one', () => {
    // `fit` absent means "the renderer uses CSS's default", and the format must not
    // materialise `'fill'` for it -- the two render identically but are authored
    // differently, and a document that gained a key on load would diff on every save.
    resetIds();
    const doc = createDocument({
      assets: {
        asset_a: {
          kind: 'image',
          mime: 'image/png',
          intrinsicWidth: 2,
          intrinsicHeight: 2,
          data: { inline: 'data:image/png;base64,AAA' },
        },
      },
    });
    const page = doc.pages[0];
    if (page === undefined) throw new Error('unreachable');
    page.objects = [
      {
        type: 'image',
        id: 'node_1',
        name: 'No fit',
        transform: { x: 0, y: 0, width: 10, height: 10, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true,
        locked: false,
        opacity: 1,
        blendMode: 'normal',
        asset: 'asset_a',
      },
    ];

    const restored = expectRoundTrips(doc);
    const node = restored.pages[0]?.objects[0];
    expect(node).not.toHaveProperty('fit');
    // The persisted form agrees -- checked on the way *out*, since an absent key that only
    // appears in the model would survive this test and break every future save.
    expect(serializeToString(restored)).not.toContain('"fit"');
  });

  it('keeps a text style sparse: an absent property does not come back defaulted', () => {
    resetIds();
    const page = createPage({ name: 'P' });
    page.objects = [
      createTextFrameNode({
        name: 'Only a size',
        style: { fontSize: 13 },
      }),
    ];
    const doc = createDocument({ pages: [page] });
    const restored = expectRoundTrips(doc);

    const node = restored.pages[0]?.objects[0];
    if (node?.type !== 'textFrame') throw new Error('unreachable');
    expect(node.style).toEqual({ fontSize: 13 });
    // The proof that the parser built it field by field rather than copying the record:
    // a copied record would carry every *other* key as `undefined`.
    expect(Object.keys(node.style ?? {})).toEqual(['fontSize']);
  });

  it('keeps adjacent equal-format runs merged', () => {
    resetIds();
    const page = createPage({ name: 'P' });
    page.objects = [
      createTextFrameNode({
        name: 'Runs',
        // `rich()` canonicalises the literal, so this document is canonical to begin with
        // -- see the next test for what happens when it is not.
        text: rich([
          {
            kind: 'paragraph',
            runs: [
              { text: 'a', format: { bold: true } },
              { text: 'b', format: { bold: true } },
              { text: 'c' },
            ],
          },
        ]),
      }),
    ];
    const doc = createDocument({ pages: [page] });
    const restored = expectRoundTrips(doc);

    const node = restored.pages[0]?.objects[0];
    if (node?.type !== 'textFrame') throw new Error('unreachable');
    expect(node.text.blocks[0]?.runs).toEqual([
      { text: 'ab', format: { bold: true } },
      { text: 'c' },
    ]);
  });

  it('canonicalises a non-canonical document on load, then becomes stable', () => {
    // The honest form of the round-trip property, found while testing it.
    //
    // `parse` re-applies `normalizeRichText`, so a file carrying adjacent equal-format runs
    // comes back canonical. That means `parse(serialize(d))` equals `d` **only when `d` is
    // already canonical** -- which the funnel guarantees for anything the user did, but not
    // for a document assembled by hand. For a non-canonical one the first trip canonicalises
    // and the second is the identity.
    //
    // Asserted rather than papered over, because "round trip changes the document" is the
    // kind of thing that gets quietly excused once and then relied on.
    resetIds();
    const page = createPage({ name: 'P' });
    page.objects = [
      createTextFrameNode({
        name: 'Unmerged',
        text: {
          blocks: [
            {
              kind: 'paragraph',
              runs: [
                { text: 'a', format: { bold: true } },
                { text: 'b', format: { bold: true } },
              ],
            },
          ],
        },
      }),
    ];
    const doc = createDocument({ pages: [page] });

    const once = parse(JSON.parse(serializeToString(doc)));
    expect(documentsEqual(once, doc)).toBe(false);

    const node = once.pages[0]?.objects[0];
    if (node?.type !== 'textFrame') throw new Error('unreachable');
    expect(node.text.blocks[0]?.runs).toEqual([{ text: 'ab', format: { bold: true } }]);

    // Second trip: identity, on both readings.
    const twice = parse(JSON.parse(serializeToString(once)));
    expect(documentsEqual(twice, once)).toBe(true);
    expect(twice).toEqual(once);
    expect(serializeToString(twice)).toBe(serializeToString(once));
  });

  it('preserves object ordering, because ordering is paint order', () => {
    resetIds();
    const page = createPage({ name: 'P' });
    page.objects = [
      createShapeNode('rect', { name: 'back' }),
      createShapeNode('ellipse', { name: 'middle' }),
      createShapeNode('line', { name: 'front' }),
    ];
    const doc = createDocument({ pages: [page] });
    const restored = expectRoundTrips(doc);
    expect(restored.pages[0]?.objects.map((node) => node.name)).toEqual([
      'back',
      'middle',
      'front',
    ]);
  });

  it('preserves asset references exactly, including a shared reference', () => {
    resetIds();
    const doc = loadFixture();
    const restored = expectRoundTrips(doc);
    const assets = (source: Document): string[] =>
      source.pages
        .flatMap((page) => page.objects)
        .filter((node) => node.type === 'image')
        .map((node) => (node.type === 'image' ? node.asset : ''));

    expect(assets(restored)).toEqual(assets(doc));
    expect(Object.keys(restored.assets).sort()).toEqual(Object.keys(doc.assets).sort());
  });

  it('preserves two distinct assets that hold equal bytes', () => {
    // Deduplication is explicitly out of scope, so this is the property that would break
    // first if a future build started canonicalising by content.
    resetIds();
    const bytes = 'data:image/png;base64,iVBORw0KGgo=';
    const record = {
      kind: 'image' as const,
      mime: 'image/png',
      intrinsicWidth: 2,
      intrinsicHeight: 2,
      data: { inline: bytes },
    };
    const doc = createDocument({ assets: { asset_x: record, asset_y: record } });
    const restored = expectRoundTrips(doc);
    expect(Object.keys(restored.assets).sort()).toEqual(['asset_x', 'asset_y']);
  });

  it('round-trips numeric geometry exactly, not approximately', () => {
    resetIds();
    const doc = loadFixture();
    const restored = expectRoundTrips(doc);
    const geometry = (source: Document): number[] =>
      source.pages.flatMap((page) =>
        page.objects.flatMap((node) => [
          node.transform.x,
          node.transform.y,
          node.transform.width,
          node.transform.height,
          node.transform.rotation,
        ]),
      );
    // `toBe` per value, so a rounded number cannot pass as equal.
    geometry(restored).forEach((value, index) => {
      expect(value).toBe(geometry(doc)[index]);
    });
  });

  it('preserves the version and the format marker', () => {
    const doc = loadFixture();
    const persisted = serialize(doc);
    expect(persisted.format).toBe(DOCUMENT_FORMAT);
    expect(persisted.formatVersion).toBe(CURRENT_FORMAT_VERSION);
  });
});

describe('determinism', () => {
  it('serialises the same document to identical bytes every time', () => {
    const doc = loadFixture();
    expect(serializeToString(doc)).toBe(serializeToString(doc));
  });

  it('sorts asset keys, so insertion order does not reach the file', () => {
    const record = (n: number) => ({
      kind: 'image' as const,
      mime: 'image/png',
      intrinsicWidth: n,
      intrinsicHeight: n,
      data: { inline: `data:image/png;base64,${n}` },
    });
    resetIds();
    const forwards = createDocument({
      assets: { asset_1: record(1), asset_2: record(2), asset_3: record(3) },
    });
    resetIds();
    const backwards = createDocument({
      assets: { asset_3: record(3), asset_2: record(2), asset_1: record(1) },
    });

    // Same assets, added in opposite orders: the files must be identical. Arrays would
    // *not* be sorted, because object order is paint order -- so this is specific to the
    // asset map, and asserted as such.
    expect(serializeToString(backwards)).toBe(serializeToString(forwards));
    expect(Object.keys(serialize(forwards).assets)).toEqual(['asset_1', 'asset_2', 'asset_3']);
  });

  it('does not depend on the key order of *nested* objects either', () => {
    // The companion to the test above, and the one that was missing.
    //
    // Shuffling a node's own keys is caught by the node-level test, but almost every
    // canonicaliser in `serialize.ts` works one level *down*: `canonicalStroke`,
    // `canonicalPaint`, `canonicalShape`, `canonicalRichText`, `canonicalTextStyle` and
    // `canonicalTransform` each rebuild their own value. Shuffling only the node would leave
    // every one of them untested -- and a `canonicalTransform` written as `{ ...transform }`
    // passes the byte-stability test anyway, because the parser hands it keys that are
    // already in order.
    //
    // So this reverses key order at *every* depth of one document and requires identical
    // bytes. Every nested canonicaliser is on the hook at once.
    const doc = loadFixture();
    const reordered = reverseKeysDeep(doc) as Document;

    // The inputs really do differ, or the test would be asserting nothing.
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(doc));
    expect(documentsEqual(reordered, doc)).toBe(true);
    expect(serializeToString(reordered)).toBe(FIXTURE_TEXT);
  });

  it('does not depend on the key order the model happened to be built with', () => {
    resetIds();
    const node = createShapeNode('rect', { name: 'Built' });
    resetIds();
    // The same node with its keys inserted back to front. Semantically identical, and
    // `documentsEqual` says so -- but a naive `JSON.stringify(model)` would emit different
    // bytes, which is the whole reason the canonicaliser exists.
    const shuffled: Node = {
      stroke: node.type === 'shape' ? node.stroke : undefined,
      shape: node.type === 'shape' ? node.shape : undefined,
      name: node.name,
      locked: node.locked,
      visible: node.visible,
      transform: node.transform,
      id: node.id,
      type: node.type,
      blendMode: node.blendMode,
      opacity: node.opacity,
    } as Node;


    // Both documents are written out literally rather than built through the factories, so
    // they share ids and differ in exactly one thing: the key order of one node. Building
    // them through `createDocument` would mint a second `doc_` and `page_` id and the
    // comparison would fail for a reason that has nothing to do with key order.
    const withNode = (objects: Node[]): Document => ({
      formatVersion: CURRENT_FORMAT_VERSION,
      id: 'doc_1',
      name: 'Key order',
      pageSize: { width: 210, height: 297, unit: 'mm', orientation: 'portrait' },
      assets: {},
      pages: [{ id: 'page_1', name: 'P', background: { type: 'solid', color: '#ffffff' }, objects }],
    });
    const ordered = withNode([node]);
    const reversed = withNode([shuffled]);

    expect(documentsEqual(reversed, ordered)).toBe(true);
    expect(serializeToString(reversed)).toBe(serializeToString(ordered));
  });

  it('holds over many generated documents', () => {
    // A deterministic generator rather than `Math.random`, so a failure is reproducible.
    // It exists because the interesting format bugs are in the corners -- absent optionals,
    // empty strings, zero geometry, exotic flags -- and a hand-written list of documents
    // only covers the corners its author thought of.
    for (let seed = 1; seed <= 60; seed += 1) {
      resetIds();
      const doc = generateDocument(seed);
      const text = serializeToString(doc);
      const restored = parse(JSON.parse(text));
      expect(documentsEqual(restored, doc), `seed ${seed}: round trip changed the document`);
      expect(serializeToString(restored), `seed ${seed}: round trip changed the bytes`);
    }
  });
});

describe('ids', () => {
  it('reserves every id in the document so the generator cannot re-mint one', () => {
    resetIds();
    const doc = parse({
      format: DOCUMENT_FORMAT,
      formatVersion: CURRENT_FORMAT_VERSION,
      id: 'doc_9',
      name: 'Ids',
      pageSize: { width: 210, height: 297, unit: 'mm', orientation: 'portrait' },
      assets: {},
      pages: [
        {
          id: 'page_4',
          name: '1',
          background: { type: 'solid', color: '#ffffff' },
          objects: [
            {
              type: 'shape',
              id: 'node_7',
              name: 'S',
              transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0, scaleX: 1, scaleY: 1 },
              visible: true,
              locked: false,
              opacity: 1,
              blendMode: 'normal',
              shape: { kind: 'rect', cornerRadius: 0 },
            },
          ],
        },
      ],
    });

    expect(collectIds(doc).sort()).toEqual(['doc_9', 'node_7', 'page_4']);

    // The whole point. Without reservation the counter would still be at 0 in a fresh tab,
    // so the next node would be `node_1` -- a duplicate of nothing here, but `node_7` is
    // already in use, and the next-minted name has to clear it. Two calls, because one
    // would pass even with a reservation that merely landed on the right value by luck.
    expect(createId('node')).toBe('node_8');
    expect(createId('node')).toBe('node_9');
    expect(createId('page')).toBe('page_5');
    expect(createId('doc')).toBe('doc_a');
  });

  it('leaves the counter alone when a document is refused', () => {
    // A rejected file must not move the generator, or opening a bad file would change the
    // ids of the next document opened in the same tab. An off-by-one here is invisible
    // until a document's ids shift for no reason.
    resetIds();
    createId('node'); // node_1
    createId('node'); // node_2

    expect(() =>
      parse({ format: DOCUMENT_FORMAT, formatVersion: CURRENT_FORMAT_VERSION, id: 'doc_1' }),
    ).toThrow(DocumentParseError);

    expect(createId('node')).toBe('node_3');
  });

  it('ignores ids it did not mint rather than guessing at them', () => {
    resetIds();
    // Nothing here is `prefix_base36`, so nothing is reserved and nothing is guessed.
    reserveIds(['not-ours', 'node_', '_1', 'x', 'node_ZZZ', 'node_!!', '']);
    expect(createId('node')).toBe('node_1');
  });
});

/**
 * Rebuilds every plain object with its keys in reverse order, at every depth.
 *
 * Arrays keep their order -- order is meaning for objects (paint order) and pages, so a
 * reversal there would be a *different document* rather than a differently-spelled one.
 * Extension bags are left alone as well: they are opaque, and the fixture's bag would be
 * compared by canonical JSON anyway.
 */
function reverseKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeysDeep);
  if (typeof value !== 'object' || value === null) return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).reverse()) {
    out[key] = key === 'extensions' ? source[key] : reverseKeysDeep(source[key]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The generated documents
// ---------------------------------------------------------------------------

/** A tiny linear congruential generator, so every document is reproducible from its seed. */
function makeRandom(seed: number): () => number {
  let state = seed * 2654435761;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  const value = values[Math.floor(random() * values.length)];
  if (value === undefined) throw new Error('pick from an empty list');
  return value;
}

function generateDocument(seed: number): Document {
  const random = makeRandom(seed);
  const doc = createDocument({ name: `Generated ${seed}` });

  // Assets, in a deliberately jumbled insertion order so the sorted-key path is exercised.
  const assetCount = Math.floor(random() * 3);
  for (let index = 0; index < assetCount; index += 1) {
    const id = `gen_${index}`;
    doc.assets[id] = {
      kind: 'image',
      mime: 'image/png',
      // Intrinsic sizes stay positive and integral: the format refuses anything else, and a
      // generator that produced invalid documents would only test the refusals.
      intrinsicWidth: 1 + Math.floor(random() * 40),
      intrinsicHeight: 1 + Math.floor(random() * 40),
      data:
        random() < 0.25
          ? { external: `./assets/${id}.png` }
          : { inline: `data:image/png;base64,AAA${id}` },
    };
  }

  const nodeCount = Math.floor(random() * 6);
  for (let index = 0; index < nodeCount; index += 1) {
    doc.pages[0]?.objects.push(generateNode(random, doc, index));
  }
  return doc;
}

function generateNode(random: () => number, doc: Document, index: number): Node {
  const name = `n${index}`;
  const roll = random();
  const assetIds = Object.keys(doc.assets);

  if (roll < 0.25 && assetIds.length > 0) {
    return {
      type: 'image',
      id: `node_${index}`,
      name,
      transform: {
        // Zero extent is legal and must survive; so is a zero-ish rotation.
        x: Math.round(random() * 100),
        y: Math.round(random() * 100),
        width: Math.floor(random() * 4) * 10,
        height: Math.floor(random() * 4) * 10,
        rotation: pick(random, [0, Math.PI / 6, -Math.PI / 4, 2 * Math.PI]),
        scaleX: pick(random, [1, -1, 0.5, 2]),
        scaleY: pick(random, [1, -1, 1.25]),
      },
      visible: random() < 0.8,
      locked: random() < 0.2,
      opacity: random(),
      blendMode: pick(random, ['normal', 'multiply', 'screen', 'luminosity'] as const),
      asset: pick(random, assetIds),
      // `fit` deliberately omitted half the time, so absent-vs-authored is covered.
      ...(random() < 0.5 ? {} : { fit: pick(random, ['fill', 'contain', 'cover', 'none'] as const) }),
      ...(random() < 0.2 ? { extensions: { 'com.example': { i: index } } } : {}),
    };
  }

  if (roll < 0.55) {
    const kind = pick(random, ['rect', 'ellipse', 'line'] as const);
    return {
      type: 'shape',
      id: `node_${index}`,
      name,
      transform: {
        x: Math.round(random() * 100),
        y: Math.round(random() * 100),
        width: Math.floor(random() * 5) * 8,
        height: Math.floor(random() * 5) * 8,
        rotation: pick(random, [0, 0.5, -1.25]),
        scaleX: pick(random, [1, -2, 0.25]),
        scaleY: pick(random, [1, 3]),
      },
      visible: true,
      locked: false,
      opacity: pick(random, [1, 0, 0.5]),
      blendMode: pick(random, ['normal', 'difference'] as const),
      shape: kind === 'rect' ? { kind: 'rect', cornerRadius: Math.round(random() * 20) } : { kind },
      // `fill` and `stroke` independently absent, which is the case a defaulting
      // deserializer gets wrong.
      ...(random() < 0.5 ? { fill: { type: 'solid' as const, color: '#123456' } } : {}),
      ...(random() < 0.5
        ? {
            stroke: {
              paint: { type: 'solid' as const, color: '#654321' },
              width: Math.round(random() * 6),
              align: 'inside' as const,
            },
          }
        : {}),
    };
  }

  const blockCount = 1 + Math.floor(random() * 3);
  const blocks: ParagraphBlock[] = [];
  for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
    const runCount = 1 + Math.floor(random() * 4);
    const runs: InlineRun[] = [];
    for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
      // Empty strings included on purpose: an empty run is legal and must survive, and
      // `normalizeRichText` decides what happens to it.
      // `CharFormat` flags are `true | undefined` -- a flag is present-and-true or absent,
      // never `false` (ADR 0003), so the generator has to build it that way too. Emitting a
      // `false` here would produce a document the parser rightly refuses.
      const format: CharFormat = {};
      if (random() < 0.5) format.bold = true;
      if (random() < 0.3) format.italic = true;
      if (random() < 0.2) format.underline = true;
      if (random() < 0.2) format.strike = true;
      runs.push({
        text: pick(random, ['', 'a', 'bb', 'ccc', ' ', 'hello world']),
        ...(Object.keys(format).length > 0 ? { format } : {}),
      });
    }
    blocks.push({
      kind: 'paragraph' as const,
      runs,
      ...(random() < 0.5 ? { align: pick(random, ['left', 'center', 'right', 'justify'] as const) } : {}),
    });
  }

  return {
    type: 'textFrame',
    id: `node_${index}`,
    name,
    transform: {
      x: Math.round(random() * 100),
      y: Math.round(random() * 100),
      width: 40 + Math.round(random() * 200),
      height: 20 + Math.round(random() * 100),
      rotation: pick(random, [0, 0.25]),
      scaleX: 1,
      scaleY: 1,
    },
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    text: { blocks },
    ...(random() < 0.7
      ? {
          style: {
            ...(random() < 0.7 ? { fontSize: 8 + Math.round(random() * 32) } : {}),
            ...(random() < 0.5 ? { lineHeight: 1 + random() } : {}),
            ...(random() < 0.3 ? { letterSpacing: -0.5 + random() } : {}),
            ...(random() < 0.4 ? { color: '#0f172a' } : {}),
            ...(random() < 0.2 ? { fontFamily: 'Georgia' } : {}),
          },
        }
      : {}),
  };
}