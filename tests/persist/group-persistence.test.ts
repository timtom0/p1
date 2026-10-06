/**
 * Groups on disk: the schema, the round trip, and what the parser refuses.
 *
 * ## Why a group is a version bump and not merely a new node type
 *
 * ADR 0012 §7 argues it at length. The short form here, because the test has to know which side of the
 * boundary it is on:
 *
 * - the **schema** can represent a recursive node without changing -- a discriminated union admits a
 *   new member without disturbing its siblings;
 * - the project's **rule** says bump anyway, so an older build refuses the file deliberately rather
 *   than incidentally.
 *
 * The observable consequences, all asserted below: a version-2 document with a group parses; a
 * version-1 document parses and is re-stamped on write; anything below version 1 is refused as
 * *older*; anything above 2 is refused as *newer*; and a **group** is still refused at a named path
 * if any part of it is malformed.
 *
 * ## Everything here goes through the parser
 *
 * M12's F12 (ADR 0011b §10) recorded that injected browser fixtures **bypass** the parser, so a
 * malformed fixture crashes the renderer instead of being refused. Persistence-level fixtures
 * therefore have no such escape: every input below is a literal passed to `parse`, so every refusal
 * is the parser's own.
 */

import { describe, expect, it } from 'vitest';

import { parse, collectIds } from '../../src/persist/deserialize';
import { serializeToString } from '../../src/persist/serialize';
import {
  CURRENT_FORMAT_VERSION,
  DOCUMENT_FORMAT,
  GROUP_NODE_KEYS,
  MINIMUM_FORMAT_VERSION,
} from '../../src/persist/format';
import { documentsEqual } from '../../src/model/document-equality';
import { validateDocument } from '../../src/model/invariants';
import { nodeIdsInPaintOrder } from '../../src/model/tree';
import type { DocumentParseError, PersistedDocument } from '../../src/persist/format';
import type { Document } from '../../src/model/types';

// ---------------------------------------------------------------------------
// Builders. `children` order is significant, so they take arrays in order.
// ---------------------------------------------------------------------------

const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mP8z8Dwn4GBgYEJRsAAI4EBvFqxbjAAAAAElFTkSuQmCC';

function transform(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    ...over,
  };
}

function leaf(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: 'shape',
    name: id,
    transform: transform(),
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    shape: { kind: 'rect', cornerRadius: 0 },
    fill: { type: 'solid', color: '#4f7cff' },
    ...over,
  };
}

function group(id: string, children: unknown[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: 'group',
    name: id,
    transform: transform(),
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    children,
    ...over,
  };
}

function documentWith(objects: unknown[], assets: Record<string, unknown> = {}): PersistedDocument {
  return {
    format: DOCUMENT_FORMAT,
    formatVersion: CURRENT_FORMAT_VERSION,
    id: 'doc_1',
    name: 'Groups',
    pageSize: { width: 400, height: 300, unit: 'pt', orientation: 'portrait' },
    assets,
    pages: [
      {
        id: 'p1',
        name: '1',
        background: { type: 'solid', color: '#ffffff' },
        objects,
      },
    ],
  } as unknown as PersistedDocument;
}

function assetRecord(): Record<string, unknown> {
  return {
    kind: 'image',
    mime: 'image/png',
    intrinsicWidth: 4,
    intrinsicHeight: 4,
    data: { inline: PIXEL },
  };
}

/** Round trip: parse -> serialise -> parse -> serialise, and every claim compared. */
function roundTrips(input: PersistedDocument): { first: Document; text: string } {
  const first = parse(input);
  const text = serializeToString(first);
  const second = parse(JSON.parse(text) as PersistedDocument);
  // Byte stability: a second trip must not change the bytes. This is the ADR 0007 guarantee and it
  // is what "canonical" means.
  expect(serializeToString(second)).toBe(text);
  expect(documentsEqual(second, first)).toBe(true);
  return { first, text };
}

describe('the serialized group', () => {
  it('is a node with a children array, and nothing else', () => {
    const { text } = roundTrips(documentWith([group('g1', [leaf('a'), leaf('b')])]));
    const parsed = JSON.parse(text) as PersistedDocument;
    const page = parsed.pages[0];
    if (page === undefined) throw new Error('no page');
    const node = (page as unknown as { objects: Record<string, unknown>[] }).objects[0]!;
    expect(node['type']).toBe('group');
    expect(Array.isArray(node['children'])).toBe(true);
    // Exactly the shared keys plus `children`. An extra key would be refused on read, so this
    // asserts the write side of the same rule.
    const keys = Object.keys(node).sort();
    expect(keys).toEqual(
      [...['id', 'type', 'name', 'transform', 'visible', 'locked', 'opacity', 'blendMode'], ...GROUP_NODE_KEYS].sort(),
    );
  });

  it('keeps child order, because child order is paint order', () => {
    const { first, text } = roundTrips(documentWith([group('g1', [leaf('b'), leaf('a')])]));
    expect(nodeIdsInPaintOrder(first)).toEqual(['b', 'a']);
    expect(text.indexOf('"b"')).toBeLessThan(text.indexOf('"a"'));
  });

  it('preserves a nested group, and its order, through the file', () => {
    const nested = documentWith([
      leaf('before'),
      group('outer', [leaf('x'), group('inner', [leaf('y'), leaf('z')]), leaf('after')]),
      leaf('last'),
    ]);
    const { first, text } = roundTrips(nested);
    // A, Group[B, Group[Y, Z], C], D flattens to the same list the renderer paints.
    expect(nodeIdsInPaintOrder(first)).toEqual(['before', 'x', 'y', 'z', 'after', 'last']);
    // The nesting survives structurally, not just in the flattened order.
    const page = first.pages[0]!;
    const outer = page.objects[1];
    if (outer?.type !== 'group') throw new Error('setup');
    expect(outer.children.map((child) => child.id)).toEqual(['x', 'inner', 'after']);
    const inner = outer.children[1];
    if (inner?.type !== 'group') throw new Error('setup');
    expect(inner.children.map((child) => child.id)).toEqual(['y', 'z']);
    // And it appears in the bytes as nested `children`, not flattened.
    expect(text).toContain('"children"');
  });

  it('round-trips an empty group as `children: []`, never as absent', () => {
    // The rule from ADR 0007: absent means absent, so "no children" has exactly one spelling. Two
    // spellings would be an ambiguity the format exists to remove.
    const { first, text } = roundTrips(documentWith([group('empty', [])]));
    const page = first.pages[0]!;
    expect(page.objects[0]?.type).toBe('group');
    expect(text).toContain('"children": []');
  });

  it('round-trips every kind of child inside a group', () => {
    const textFrame = {
      id: 't',
      type: 'textFrame',
      name: 'T',
      transform: transform(),
      visible: true,
      locked: false,
      opacity: 1,
      blendMode: 'normal',
      text: { blocks: [{ kind: 'paragraph', runs: [{ text: 'inside' }] }] },
    };
    const image = {
      id: 'i',
      type: 'image',
      name: 'I',
      transform: transform(),
      visible: true,
      locked: false,
      opacity: 1,
      blendMode: 'normal',
      asset: 'a1',
    };
    const ellipse = leaf('e', {
      shape: { kind: 'ellipse' },
      fill: undefined,
    });
    delete ellipse['fill'];
    const line = leaf('l', { shape: { kind: 'line' } });
    delete line['fill'];

    const { first } = roundTrips(
      documentWith(
        [group('g', [leaf('r', { shape: { kind: 'rect', cornerRadius: 4 } }), ellipse, line, textFrame, image])],
        { a1: assetRecord() },
      ),
    );
    const outer = first.pages[0]!.objects[0];
    if (outer?.type !== 'group') throw new Error('setup');
    expect(outer.children.map((child) => child.type)).toEqual([
      'shape',
      'shape',
      'shape',
      'textFrame',
      'image',
    ]);
    const text = outer.children[3];
    if (text?.type !== 'textFrame') throw new Error('setup');
    expect(text.text.blocks[0]?.runs[0]?.text).toBe('inside');
    const imageNode = outer.children[4];
    if (imageNode?.type !== 'image') throw new Error('setup');
    expect(imageNode.asset, 'the asset reference survives').toBe('a1');
    // And `fit` stays absent -- an image inside a group is no different from one outside.
    expect(imageNode.fit).toBeUndefined();
    // Asset records survive by reference, not by inlining.
    expect(first.assets['a1']?.data).toBeDefined();
  });

  it('keeps a node absent inside a group absent', () => {
    const bare = leaf('bare', { fill: undefined });
    delete bare['fill'];
    const { first } = roundTrips(documentWith([group('g', [bare])]));
    const outer = first.pages[0]!.objects[0];
    if (outer?.type !== 'group') throw new Error('setup');
    const child = outer.children[0];
    if (child?.type !== 'shape') throw new Error('setup');
    expect(child.fill, 'absent, not defaulted to a fill').toBeUndefined();
    expect(child.stroke).toBeUndefined();
  });

  it('preserves an image inside a nested group, and the asset reference resolves', () => {
    const image = {
      id: 'i',
      type: 'image',
      name: 'I',
      transform: transform(),
      visible: true,
      locked: false,
      opacity: 1,
      blendMode: 'normal',
      asset: 'a1',
      fit: 'contain',
    };
    const { first } = roundTrips(
      documentWith([group('outer', [group('inner', [image])])], { a1: assetRecord() }),
    );
    expect(validateDocument(first)).toEqual([]);
    const inner = first.pages[0]!.objects[0];
    if (inner?.type !== 'group') throw new Error('setup');
    const nested = inner.children[0];
    if (nested?.type !== 'group') throw new Error('setup');
    const imageNode = nested.children[0];
    if (imageNode?.type !== 'image') throw new Error('setup');
    expect(imageNode.asset).toBe('a1');
    expect(imageNode.fit, 'fit survives the nesting').toBe('contain');
  });

  it('collects group ids and group child ids for the id generator', () => {
    // `collectIds` recurses because a reserved-but-not-collected id could be handed out again by
    // `createId`, producing a document with two nodes claiming one id -- the exact failure
    // `assertDocumentIsConsistent` prevents on load, reintroduced by the generator.
    const doc = parse(
      documentWith([
        leaf('top'),
        group('g', [leaf('a'), group('h', [leaf('deep')])]),
      ]),
    );
    const ids = collectIds(doc);
    for (const id of ['top', 'g', 'a', 'h', 'deep']) {
      expect(ids, `${id} is reserved`).toContain(id);
    }
    expect(new Set(ids).size, 'and no id appears twice').toBe(ids.length);
  });

  it('is byte-stable across a second write, which is what canonical means', () => {
    const { text } = roundTrips(
      documentWith([group('g', [leaf('a'), leaf('b'), group('h', [leaf('c')])])]),
    );
    const first = parse(JSON.parse(text) as PersistedDocument);
    expect(serializeToString(first)).toBe(text);
    expect(serializeToString(parse(JSON.parse(serializeToString(first)) as PersistedDocument))).toBe(text);
  });

  it('does not reorder a group with respect to its siblings on either side', () => {
    const { first, text } = roundTrips(
      documentWith([leaf('a'), group('g', [leaf('b')]), leaf('c')]),
    );
    // A group occupies one slot and its children paint at that slot, so `a, b, c`.
    expect(nodeIdsInPaintOrder(first)).toEqual(['a', 'b', 'c']);
    expect(text.indexOf('"a"')).toBeLessThan(text.indexOf('"g"'));
    expect(text.indexOf('"g"')).toBeLessThan(text.indexOf('"c"'));
  });
});

describe('the version', () => {
  it('writes the current version', () => {
    const doc = parse(documentWith([group('g', [])]));
    expect(doc.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    // Pretty-printed, with a space after the colon. A string assertion that omits the space would
    // fail on formatting rather than on the version, which is the wrong reason to fail.
    expect(serializeToString(doc)).toContain(`"formatVersion": ${CURRENT_FORMAT_VERSION}`);
  });

  it('reads the previous version and re-stamps it, which is not a migration', () => {
    // ADR 0007 said "no migrations". This is the case that could have broken that, and it does not:
    // a version-1 document has no groups, so nothing is converted, defaulted or dropped. The only
    // difference is the stamp.
    const previous = {
      ...(documentWith([leaf('a')]) as unknown as Record<string, unknown>),
      formatVersion: MINIMUM_FORMAT_VERSION,
    };
    const parsed = parse(previous as unknown as PersistedDocument);
    expect(parsed.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(parsed.pages[0]?.objects).toHaveLength(1);
    expect(parsed.assets).toEqual({});
  });

  it('refuses anything below the oldest version it reads, as an older file', () => {
    const tooOld = {
      ...(documentWith([]) as unknown as Record<string, unknown>),
      formatVersion: MINIMUM_FORMAT_VERSION - 1,
    };
    const error = refusal(tooOld);
    expect(error.message).toContain('older version');
    expect(error.message).toContain('no migration');
  });

  it('refuses anything above the current version, as a newer file', () => {
    const tooNew = {
      ...(documentWith([]) as unknown as Record<string, unknown>),
      formatVersion: CURRENT_FORMAT_VERSION + 1,
    };
    const error = refusal(tooNew);
    expect(error.message).toContain('newer version');
  });

  it('keeps the two version messages distinct', () => {
    // They need different actions from the user -- "update P1" versus "this file is stale" -- and
    // collapsing them into one "unsupported version" would take that away.
    const older = refusal({
      ...(documentWith([]) as unknown as Record<string, unknown>),
      formatVersion: MINIMUM_FORMAT_VERSION - 1,
    }).message;
    const newer = refusal({
      ...(documentWith([]) as unknown as Record<string, unknown>),
      formatVersion: CURRENT_FORMAT_VERSION + 1,
    }).message;
    expect(older).not.toBe(newer);
    expect(older).not.toContain('newer');
    expect(newer).not.toContain('older');
  });
});

describe('what the parser refuses', () => {
  // Each of these asserts the **path**, not merely that something was thrown. A parser that refused
  // every input would pass a suite that only checked for a throw, and could not produce
  // `pages[0].objects[0].children[1].transform.scaleY`.

  it('an unknown key on a group, at the offending key', () => {
    const error = refusal(documentWith([group('g', [], { extra: 1 })]));
    // The path reaches the **key**, not just the record. My first draft asserted
    // `pages[0].objects[0]` and failed against a strictly better answer: a report naming `extra`
    // tells an author which of several undeclared keys to delete.
    expect(error.path).toBe('pages[0].objects[0].extra');
    expect(error.message).toContain('extra');
  });

  it('a group with no `children` key', () => {
    // `children` is required. Defaulting it to `[]` would give "absent" and "empty" two spellings,
    // which is exactly what ADR 0007 exists to prevent.
    const withoutChildren = group('g', []);
    delete withoutChildren['children'];
    const error = refusal(documentWith([withoutChildren]));
    expect(error.path).toContain('children');
  });

  it('`children` that is not an array', () => {
    const error = refusal(documentWith([group('g', [], { children: {} as never })]));
    expect(error.path).toContain('children');
  });

  it('a malformed transform on a group, naming the field', () => {
    const error = refusal(
      documentWith([group('g', [], { transform: transform({ width: -5 }) })]),
    );
    expect(error.path).toBe('pages[0].objects[0].transform.width');
  });

  it('a non-uniform group scale, and the message says why', () => {
    // The one refusal that is not a *key* question. `scaleX` and `scaleY` are both valid numbers;
    // only their relationship is wrong, and only the invariant can see that. This is the assertion
    // that the format does not admit a shear, rather than merely rendering one oddly.
    const error = refusal(
      documentWith([
        group('g', [leaf('r', { transform: transform({ rotation: 0.5 }) })], {
          transform: transform({ scaleX: 2, scaleY: 1 }),
        }),
      ]),
    );
    expect(error.path).toBe('pages[0].objects[0].transform');
    expect(error.message).toContain('uniform');
    expect(error.message).toContain('shear');
  });

  it('a group whose scale differs by less than the epsilon, which is allowed', () => {
    // The other side of the same rule. A test that only asserted the refusal could be satisfied by a
    // parser comparing scales with `!==` and refusing a document nobody could author.
    const parsed = parse(
      documentWith([group('g', [], { transform: transform({ scaleX: 2, scaleY: 2 + 1e-12 }) })]),
    );
    expect(parsed.formatVersion).toBe(CURRENT_FORMAT_VERSION);
  });

  it('a duplicate id, anywhere in the tree', () => {
    const error = refusal(
      documentWith([group('g', [leaf('dup')]), group('h', [leaf('dup')])]),
    );
    expect(error.message).toContain('used more than once');
    expect(error.message).toContain('dup');
  });

  it('a duplicate id between a group and its own child', () => {
    // The same id as its own container: a cycle in everything but reference, and the check that
    // catches it is the uniqueness one rather than a separate cycle detector.
    const error = refusal(documentWith([group('g', [leaf('g')])]));
    expect(error.message).toContain('used more than once');
  });

  it('an unknown node type inside a group, at the child path', () => {
    const error = refusal(documentWith([group('g', [{ ...leaf('x'), type: 'blob' }])]));
    expect(error.path).toBe('pages[0].objects[0].children[0].type');
    expect(error.message).toContain('blob');
  });

  it('an unknown key on a node inside a group, at the child key', () => {
    const error = refusal(documentWith([group('g', [leaf('x', { wobble: 1 })])]));
    expect(error.path).toBe('pages[0].objects[0].children[0].wobble');
  });

  it('an undeclared key deep inside a nested group, with the full path', () => {
    // The path must be walkable to the field. "Some node has a bad key" is not actionable; this is.
    const error = refusal(
      documentWith([group('o', [group('i', [leaf('x', { wobble: 1 })])])]),
    );
    expect(error.path).toBe('pages[0].objects[0].children[0].children[0].wobble');
  });

  it('a dangling asset reference inside a nested group', () => {
    const image = {
      id: 'i',
      type: 'image',
      name: 'I',
      transform: transform(),
      visible: true,
      locked: false,
      opacity: 1,
      blendMode: 'normal',
      asset: 'missing',
    };
    const error = refusal(documentWith([group('g', [group('h', [image])])]));
    expect(error.path).toBe('pages[0].objects[0].children[0].children[0].asset');
    expect(error.message).toContain('missing');
  });

  it('repairs nothing: a bad child refuses the whole document', () => {
    // ADR 0007 §5. Silently dropping one bad node out of a document is a data-loss decision the
    // user never made, so the parser tells them which field to fix and stops.
    let error: DocumentParseError | null = null;
    try {
      parse(documentWith([group('g', [leaf('good'), leaf('bad', { transform: transform({ width: 'wide' as never }) })])]));
    } catch (caught) {
      error = caught as DocumentParseError;
    }
    expect(error).not.toBeNull();
    expect((error as unknown as DocumentParseError).path).toBe(
      'pages[0].objects[0].children[1].transform.width',
    );
  });

  it('accepts a valid group document, so the refusals above are not "refuse everything"', () => {
    // The negative control for the whole section. A parser that refused every group would pass all
    // of the above.
    const parsed = parse(
      documentWith([leaf('a'), group('g', [leaf('b'), group('h', [leaf('c')])]), leaf('d')]),
    );
    expect(validateDocument(parsed)).toEqual([]);
    expect(nodeIdsInPaintOrder(parsed)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('a group and the things that must not leak into it', () => {
  it('selection, hover and gesture state are not authored', () => {
    // Stated as a round trip rather than as a comment: anything in the model is in the file, so the
    // file is the place to check.
    const { text } = roundTrips(documentWith([group('g', [leaf('a')])]));
    for (const forbidden of ['selection', 'primary', 'hover', 'dom', 'measurement', 'session']) {
      expect(text.toLowerCase(), `"${forbidden}" is not authored`).not.toContain(forbidden);
    }
  });

  it('an image inside a group does not fetch during parse', () => {
    // Parse is pure and synchronous: it must not touch the network, must not decode, and must not
    // record anything about a decode. Asserted structurally -- the parsed node has nowhere to put
    // such a thing, and every key on it is one this format declares. (The first draft built the
    // image by spreading a *shape* literal, so the parser correctly refused an undeclared `shape`
    // key -- which is a good sign about the parser and no evidence at all about fetching.)
    const image = {
      id: 'i',
      type: 'image',
      name: 'I',
      transform: transform(),
      visible: true,
      locked: false,
      opacity: 1,
      blendMode: 'normal',
      asset: 'a1',
    };
    const parsed = parse(documentWith([group('g', [image])], { a1: assetRecord() }));
    const outer = parsed.pages[0]!.objects[0];
    if (outer?.type !== 'group') throw new Error('setup');
    const imageNode = outer.children[0];
    if (imageNode?.type !== 'image') throw new Error('setup');
    expect(Object.keys(imageNode).sort()).toEqual(
      [
        'asset',
        'blendMode',
        'id',
        'locked',
        'name',
        'opacity',
        'transform',
        'type',
        'visible',
      ].sort(),
    );
    // And nothing about the asset's *content* has been touched: the record is still the record, and
    // the intrinsic size is metadata the model holds rather than something it measured.
    expect(parsed.assets['a1']?.intrinsicWidth).toBe(4);
  });
});

function refusal(input: unknown): DocumentParseError {
  try {
    parse(input as PersistedDocument);
  } catch (caught) {
    return caught as DocumentParseError;
  }
  throw new Error('expected a refusal');
}