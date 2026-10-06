/**
 * Canonical model equality.
 *
 * Two callers depend on this and both would be quietly wrong with a weaker function:
 * dirty state (ADR 0007 §7) and the round-trip property. So the tests here are as much
 * about **what must make two documents different** as about what makes them equal --
 * a comparator that is too permissive reports a dirty document as clean, which is the one
 * bug in this area that loses a user's work.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { resetIds } from '../core/ids';
import { canonicalJson, documentsEqual } from './document-equality';
import { createDocument, createPage, createRectNode, createShapeNode, createTextFrameNode, rich } from './factory';
import type { AssetRecord, Document, Node, ShapeNode } from './types';

function docWith(...objects: Node[]): Document {
  const page = createPage({ name: 'P' });
  page.objects = objects;
  return createDocument({ pages: [page] });
}

function shape(init: Partial<Omit<ShapeNode, 'type' | 'shape'>> = {}): ShapeNode {
  return createShapeNode('rect', init);
}

/**
 * Builds the same document twice, from a clean id counter each time.
 *
 * Necessary, and easy to get wrong: `createDocument` mints a fresh `doc_1` every call, so
 * "two documents built identically" would otherwise differ by id and the comparator would
 * be right to call them different. Resetting between the two builds is what makes the
 * assertion about *everything else*.
 */
function twice(build: (buildIndex: 0 | 1) => Document): [Document, Document] {
  resetIds();
  const first = build(0);
  resetIds();
  const second = build(1);
  return [first, second];
}

/** The single node of a one-node document, for narrow comparisons. */
function only(node: Node): Node {
  const document = docWith(node);
  const found = document.pages[0]?.objects[0];
  if (found === undefined) throw new Error('unreachable');
  return found;
}

beforeEach(() => {
  resetIds();
});

describe('documentsEqual', () => {
  it('is true for the same reference', () => {
    const doc = createDocument();
    expect(documentsEqual(doc, doc)).toBe(true);
  });

  it('is true for two documents built identically', () => {
    // Separate objects on purpose: structural sharing makes equal documents routinely
    // distinct references, and `===` would call these different.
    const [a, b] = twice(() => docWith(shape()));
    expect(documentsEqual(a, b)).toBe(true);
  });

  it.each([
    ['name', { name: 'Other' }],
    ['page size', { pageSize: { width: 210, height: 297, unit: 'in' as const, orientation: 'portrait' as const } }],
    ['page size orientation', { pageSize: { width: 210, height: 297, unit: 'mm' as const, orientation: 'landscape' as const } }],
  ])('is false when the %s differs', (_label, patch) => {
    expect(documentsEqual(createDocument(), createDocument(patch))).toBe(false);
  });

  it('is false when the document id differs', () => {
    const a = createDocument();
    const b = { ...createDocument(), id: `${a.id}x` };
    expect(documentsEqual(a, b)).toBe(false);
  });

  it('is false when the page count differs', () => {
    const one = docWith();
    const two = createDocument({ pages: [createPage({ name: '1' }), createPage({ name: '2' })] });
    expect(documentsEqual(one, two)).toBe(false);
  });

  it('treats object order as meaningful, because it is paint order', () => {
    const a = docWith(shape({ name: 'back' }), shape({ name: 'front' }));
    const b = docWith(shape({ name: 'front' }), shape({ name: 'back' }));
    expect(documentsEqual(a, b)).toBe(false);
  });

  it('treats page order as meaningful', () => {
    const pages = [createPage({ name: 'A' }), createPage({ name: 'B' })];
    const forwards = createDocument({ pages });
    const backwards = createDocument({ pages: [pages[1]!, pages[0]!] });
    expect(documentsEqual(forwards, backwards)).toBe(false);
  });
});

describe('shared node fields', () => {
  it.each([
    ['id', { id: 'other' }],
    ['name', { name: 'other' }],
    ['visible', { visible: false }],
    ['locked', { locked: true }],
    ['opacity', { opacity: 0.5 }],
    ['blendMode', { blendMode: 'multiply' as const }],
    ['x', { transform: { x: 99, y: 0, width: 0, height: 0, rotation: 0, scaleX: 1, scaleY: 1 } }],
    ['rotation', { transform: { x: 0, y: 0, width: 0, height: 0, rotation: 1, scaleX: 1, scaleY: 1 } }],
    ['scaleX', { transform: { x: 0, y: 0, width: 0, height: 0, rotation: 0, scaleX: 2, scaleY: 1 } }],
    ['scaleY', { transform: { x: 0, y: 0, width: 0, height: 0, rotation: 0, scaleX: 1, scaleY: 2 } }],
  ])('is false when %s differs', (_label, patch) => {
    expect(documentsEqual(docWith(shape()), docWith(shape(patch)))).toBe(false);
  });

  it('is false when the node type differs', () => {
    expect(documentsEqual(docWith(shape()), docWith(createTextFrameNode()))).toBe(false);
  });
});

describe('absent is not present-and-equal', () => {
  // The rule that makes dirty state trustworthy: `{ fontSize: 16 }` and `{}` render
  // identically but are different documents, so a document that gained a default is dirty.
  it('distinguishes an absent `fill` from an authored one', () => {
    expect(documentsEqual(docWith(shape()), docWith(shape({ fill: { type: 'solid', color: '#fff' } })))).toBe(
      false,
    );
  });

  it('distinguishes an absent `stroke` from an authored one', () => {
    const withStroke: Partial<ShapeNode> = {
      stroke: { paint: { type: 'solid', color: '#000' }, width: 1, align: 'inside' },
    };
    expect(documentsEqual(docWith(shape()), docWith(shape(withStroke)))).toBe(false);
  });

  it('distinguishes every text style property, one at a time', () => {
    const base = { fontSize: 16 };
    const variations: Array<[string, Record<string, unknown>]> = [
      ['fontFamily', { fontSize: 16, fontFamily: 'Georgia' }],
      ['lineHeight', { fontSize: 16, lineHeight: 1.5 }],
      ['letterSpacing', { fontSize: 16, letterSpacing: 0.1 }],
      ['color', { fontSize: 16, color: '#111' }],
    ];
    for (const [label, style] of variations) {
      const withStyle = createTextFrameNode({ name: 'T', style: style as never });
      const withoutStyle = createTextFrameNode({ name: 'T', style: base as never });
      expect(documentsEqual(docWith(withStyle), docWith(withoutStyle)), label).toBe(false);
    }
  });

  it('distinguishes an image `fit` of `fill` from no fit at all', () => {
    const asset = 'asset_1';
    const record = {
      kind: 'image' as const,
      mime: 'image/png',
      intrinsicWidth: 1,
      intrinsicHeight: 1,
      data: { inline: 'x' },
    };
    const image = (fit?: 'fill'): Node => ({
      type: 'image',
      id: 'node_i',
      name: 'I',
      transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0, scaleX: 1, scaleY: 1 },
      visible: true,
      locked: false,
      opacity: 1,
      blendMode: 'normal',
      asset,
      ...(fit === undefined ? {} : { fit }),
    });
    const a = createDocument({ assets: { [asset]: record }, pages: [pageOf(image())] });
    const b = createDocument({ assets: { [asset]: record }, pages: [pageOf(image('fill'))] });
    expect(documentsEqual(a, b)).toBe(false);
  });

  it('treats `extensions` as opaque, compared by canonical JSON', () => {
    // The two bags hold the same values with the keys inserted in opposite orders. Key
    // order in an opaque bag is not part of the document's identity: the bag is by
    // definition something this build does not understand, so it cannot claim that its
    // incidental insertion order is meaningful -- and the format does not control it either.
    const bags = [
      { plugin: { a: 1, b: 2 } },
      { plugin: { b: 2, a: 1 } },
    ];
    const [a, b] = twice((i) => docWith(shape({ extensions: bags[i] })));
    expect(documentsEqual(a, b)).toBe(true);

    // And the negative: same keys, different value.
    expect(
      documentsEqual(
        docWith(shape({ extensions: { plugin: { a: 1 } } })),
        docWith(shape({ extensions: { plugin: { a: 2 } } })),
      ),
    ).toBe(false);
  });

});

describe('shapes', () => {
  it('distinguishes the kinds', () => {
    expect(documentsEqual(docWith(createShapeNode('rect')), docWith(createShapeNode('ellipse')))).toBe(
      false,
    );
  });

  it('distinguishes corner radii', () => {
    const a = createRectNode({ shape: { cornerRadius: 0 } });
    const b = createRectNode({ shape: { cornerRadius: 4 } });
    expect(documentsEqual(docWith(a), docWith(b))).toBe(false);
  });

  it('does not invent a corner radius for kinds that have none', () => {
    const ellipse = only(createShapeNode('ellipse')) as ShapeNode;
    expect(ellipse.shape).toEqual({ kind: 'ellipse' });
  });

  it('distinguishes strokes that differ only in width or alignment', () => {
    const base = { paint: { type: 'solid' as const, color: '#000' }, align: 'inside' as const };
    expect(documentsEqual(docWith(shape({ stroke: { ...base, width: 1 } })), docWith(shape({ stroke: { ...base, width: 2 } })))).toBe(
      false,
    );
  });
});

describe('rich text', () => {
  it('is true for canonically equal text', () => {
    const build = (): Document =>
      docWith(
        createTextFrameNode({
          text: rich([{ kind: 'paragraph', runs: [{ text: 'hi', format: { bold: true } }] }]),
        }),
      );
    const [a, b] = twice(build);
    expect(documentsEqual(a, b)).toBe(true);
  });

  it('is false when the plain text differs', () => {
    const a = createTextFrameNode({ text: rich([{ kind: 'paragraph', runs: [{ text: 'a' }] }]) });
    const b = createTextFrameNode({ text: rich([{ kind: 'paragraph', runs: [{ text: 'b' }] }]) });
    expect(documentsEqual(docWith(a), docWith(b))).toBe(false);
  });

  it('is false when formatting differs', () => {
    const a = createTextFrameNode({ text: rich([{ kind: 'paragraph', runs: [{ text: 'a' }] }]) });
    const b = createTextFrameNode({
      text: rich([{ kind: 'paragraph', runs: [{ text: 'a', format: { italic: true } }] }]),
    });
    expect(documentsEqual(docWith(a), docWith(b))).toBe(false);
  });

  it('is false when the block count differs', () => {
    const a = createTextFrameNode({ text: rich([{ kind: 'paragraph', runs: [{ text: 'a' }] }]) });
    const b = createTextFrameNode({
      text: rich([
        { kind: 'paragraph', runs: [{ text: 'a' }] },
        { kind: 'paragraph', runs: [{ text: '' }] },
      ]),
    });
    expect(documentsEqual(docWith(a), docWith(b))).toBe(false);
  });

  it('is false when paragraph alignment differs', () => {
    const a = createTextFrameNode({
      text: rich([{ kind: 'paragraph', align: 'left', runs: [{ text: 'a' }] }]),
    });
    const b = createTextFrameNode({
      text: rich([{ kind: 'paragraph', align: 'center', runs: [{ text: 'a' }] }]),
    });
    expect(documentsEqual(docWith(a), docWith(b))).toBe(false);
  });
});

describe('assets', () => {
  const record: AssetRecord = {
    kind: 'image',
    mime: 'image/png',
    intrinsicWidth: 2,
    intrinsicHeight: 3,
    data: { inline: 'data:image/png;base64,AAA' },
  };

  function withAssets(assets: Record<string, AssetRecord>): Document {
    return createDocument({ assets });
  }

  it('is true for the same asset under the same id', () => {
    const [a, b] = twice(() => withAssets({ asset_a: { ...record } }));
    expect(documentsEqual(a, b)).toBe(true);
  });

  it('is false when an asset id differs, even for equal bytes', () => {
    // Identity is the id, never the content. Merging two equal assets would change two
    // nodes' `asset` fields, and deduplication is explicitly out of scope.
    expect(documentsEqual(withAssets({ asset_a: record }), withAssets({ asset_b: record }))).toBe(false);
  });

  it.each([
    ['mime', { mime: 'image/jpeg' }],
    ['intrinsicWidth', { intrinsicWidth: 9 }],
    ['intrinsicHeight', { intrinsicHeight: 9 }],
  ])('is false when %s differs', (_label, patch) => {
    expect(
      documentsEqual(withAssets({ asset_a: record }), withAssets({ asset_a: { ...record, ...patch } })),
    ).toBe(false);
  });

  it('distinguishes inline from external', () => {
    const external = { ...record, data: { external: './a.png' } };
    expect(documentsEqual(withAssets({ asset_a: record }), withAssets({ asset_a: external }))).toBe(false);
  });

  it('is false when one has an extra asset, even an unreferenced one', () => {
    // Orphans are legal and survive undo, so they are part of the document.
    expect(documentsEqual(withAssets({ asset_a: record }), withAssets({ asset_a: record, asset_b: record }))).toBe(
      false,
    );
  });

  it('is not fooled by a prototype member used as an asset id', () => {
    // `assets['toString']` resolves to `Object.prototype.toString` -- the same trap
    // `findAsset` hit in M6. A truthiness check here would compare a function to undefined
    // and call two documents different, or worse, call two identical ones different.
    const [plain, spread] = twice(() => withAssets({ asset_a: record }));
    // The same document, once copied with a spread. A comparator that reached for
    // `Object.prototype` through a key lookup would be comparing a function here.
    expect(documentsEqual({ ...plain }, spread)).toBe(true);
    expect(documentsEqual(withAssets({ asset_a: record }), withAssets({ asset_a: record, toString: record } as never))).toBe(
      false,
    );
  });

  it('is true for two external records with the same reference', () => {
    const external: AssetRecord = { ...record, data: { external: './a.png' } };
    const [a, b] = twice(() => withAssets({ asset_a: { ...external } }));
    expect(documentsEqual(a, b)).toBe(true);
  });
});

describe('an unknown node type', () => {
  // Adding a node type to the union without a branch here is a *compile* error; this is the
  // runtime counterpart, for a document that arrived from somewhere this build does not
  // know about.
  it('is simply not equal to a known type, without throwing', () => {
    const bogus = { ...only(shape()), type: 'sticker' } as unknown as Node;
    expect(documentsEqual(docWith(bogus), docWith(shape()))).toBe(false);
  });

  it('throws rather than reporting two identical unknown nodes as equal', () => {
    // The dangerous direction. Returning `true` here would say a document full of objects
    // this build cannot render is unchanged -- and dirty state would then report it clean.
    const sticker = () => ({ ...only(shape()), type: 'sticker' }) as unknown as Node;
    expect(() => {
      const [a, b] = twice(() => docWith(sticker()));
      documentsEqual(a, b);
    }).toThrow(/Unknown node type/);
  });
});

describe('canonicalJson', () => {
  it('sorts object keys so equal values produce equal strings', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('keeps array order, because order is meaning', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('distinguishes values a string comparison would conflate', () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: '1' }));
    expect(canonicalJson(null)).not.toBe(canonicalJson(undefined));
  });
});

function pageOf(...objects: Node[]) {
  const page = createPage({ name: 'P' });
  page.objects = objects;
  return page;
}
