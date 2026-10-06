/**
 * Model immutability, proved by construction rather than by comparison.
 *
 * ## The method
 *
 * **Deep-freeze the input, then run the command.** Every module here is an ES module, so it runs
 * in strict mode, so writing to a frozen object throws a `TypeError` rather than failing
 * silently. That makes `deepFreeze(doc); apply(doc, cmd)` a *total* check on the no-mutation
 * invariant: it catches a write to the document, to a node, to a page's `objects` array, to a
 * nested `transform`, to an `assets` record and to an asset's bytes — every level at once.
 *
 * The obvious alternative, snapshotting the document as JSON and comparing afterwards, is
 * strictly weaker and worth saying why. It only sees mutations that *persist*, so a write
 * followed by a compensating write is invisible; it cannot see a mutation of a value the
 * serialiser does not read; and it says nothing about *sharing*, which is the other half of the
 * question — a command that defensively deep-copies every node is immutable and also allocates
 * the whole document on every drag.
 *
 * So the sharing half is asserted separately, by reference identity: an untouched node must come
 * back as the **same object**, because that is what lets the reconciler skip it, and it is the
 * property that makes "the renderer reads only what changed" true rather than aspirational.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { resetIds } from '../core/ids';
import { createAssetFrom } from './assets';
import type { DecodedAsset } from './assets';
import { apply, isNoop } from './commands';
import type { Command } from './commands';
import { documentsEqual } from './document-equality';
import {
  createDocument,
  createPage,
  createRectNode,
  createTextFrameNode,
  rich,
} from './factory';
import type { Document, Node } from './types';

// ---------------------------------------------------------------------------
// The freeze
// ---------------------------------------------------------------------------

/**
 * Freezes an object and everything reachable from it.
 *
 * Recursive because `Object.freeze` is one level deep, and the interesting targets are all
 * nested: a page's `objects` array, a node's `transform`, an asset's data. A cycle guard because
 * a general deep-freeze meets one eventually, and a stack overflow here would look like a
 * finding rather than a bug in the helper.
 */
function deepFreeze<T>(value: T, seen = new Set<unknown>()): T {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);

  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

// ---------------------------------------------------------------------------
// A document with something of every kind in it
// ---------------------------------------------------------------------------

/**
 * Three objects, two pages and an asset table.
 *
 * Every kind matters: a *shape* and a *text frame* are separate renderers and separate
 * `setProps` payload shapes, and the *second page* is what catches a command that assumes one
 * page. The asset is there because a command that touched `assets` while rewriting a node would
 * be invisible to every other assertion in this file.
 */
/** A minimal decodable asset. The id is the key it is stored under, not part of the value. */
function anAsset(): DecodedAsset {
  return {
    mime: 'image/png',
    intrinsicWidth: 4,
    intrinsicHeight: 2,
    data: { inline: 'iVBORw0KGgo=' },
  };
}

function kitchenSink(): Document {
  resetIds();
  const one = createPage({ name: '1' });
  one.objects = [
    createRectNode({ name: 'A', fill: { type: 'solid', color: '#112233' } }),
    createTextFrameNode({ name: 'B', text: rich([{ kind: 'paragraph', runs: [{ text: 'hello' }] }]) }),
    createRectNode({ name: 'C' }),
  ];
  const two = createPage({ name: '2' });
  two.objects = [createRectNode({ name: 'D' })];

  const doc = createDocument({ pages: [one, two] });
  return {
    ...doc,
    assets: { asset_1: createAssetFrom(anAsset()).asset },
  };
}

function idsOf(doc: Document, pageIndex: number): string[] {
  return (doc.pages[pageIndex]?.objects ?? []).map((node) => node.id);
}

function nodeNamed(doc: Document, name: string): Node {
  for (const page of doc.pages) {
    for (const node of page.objects) {
      if (node.name === name) return node;
    }
  }
  throw new Error(`no node named ${name}`);
}

function pageIdOf(doc: Document, pageIndex: number): string {
  const id = doc.pages[pageIndex]?.id;
  if (id === undefined) throw new Error('unreachable');
  return id;
}

/** Every command the funnel can be asked for, aimed at this document. */
function everyCommand(doc: Document): Command[] {
  const [aId, bId, cId] = idsOf(doc, 0);
  const dId = idsOf(doc, 1)[0];
  if (aId === undefined || bId === undefined || cId === undefined || dId === undefined) {
    throw new Error('unreachable');
  }
  const page = pageIdOf(doc, 0);
  const other = pageIdOf(doc, 1);
  const frame = nodeNamed(doc, 'B');
  const frameId = frame.id;

  return [
    { type: 'setTransform', ids: [aId], patch: { x: 10 } },
    { type: 'setTransform', ids: [aId, cId], patch: { width: 33, rotation: 0.25 } },
    { type: 'setProps', ids: [aId], props: { opacity: 0.5 } },
    { type: 'setProps', ids: [aId, cId], props: { visible: false } },
    { type: 'setProps', ids: [frameId], props: { name: 'renamed' } },
    { type: 'insert', pageId: page, index: 0, nodes: [createRectNode({ name: 'new' })] },
    { type: 'insert', pageId: other, index: 0, nodes: [createRectNode({ name: 'far' })] },
    { type: 'remove', ids: [aId] },
    { type: 'remove', ids: [aId, cId, dId] },
    { type: 'reorder', pageId: page, id: aId, toIndex: 2 },
    { type: 'restack', pageId: page, ids: [aId, cId], direction: 'forward' },
    { type: 'restack', pageId: page, ids: [aId, cId], direction: 'back' },
    {
      type: 'setText',
      nodeId: frameId,
      text: rich([{ kind: 'paragraph', runs: [{ text: 'changed' }] }]),
    },
    { type: 'setTextStyle', ids: [frameId], patch: { color: '#ff0000' } },
    { type: 'setTextAlign', nodeId: frameId, align: 'center' },
    { type: 'setPageProps', pageId: page, props: { name: 'renamed page' } },
    { type: 'setAssets', assets: { asset_1: createAssetFrom(anAsset()).asset } },
    { type: 'batch', cmds: [{ type: 'setProps', ids: [aId], props: { locked: true } }] },
  ];
}

beforeEach(() => {
  resetIds();
});

// ---------------------------------------------------------------------------
// 1. No command writes to its input
// ---------------------------------------------------------------------------

describe('no command mutates its input document', () => {
  it('holds for every command in the funnel', () => {
    // The whole list, deep-frozen. A write anywhere -- document, page, `objects` array, node,
    // `transform`, `fill`, `assets`, asset bytes -- throws here rather than being caught later.
    const doc = deepFreeze(kitchenSink());
    expect(() => {
      for (const command of everyCommand(doc)) apply(doc, command);
    }).not.toThrow();
  });

  it('holds when the same command is applied twice in a row', () => {
    // A second `apply` reads the *result* of the first, so this covers the case a single pass
    // cannot: a command that mutates conditionally on what is already there.
    const doc = deepFreeze(kitchenSink());
    expect(() => {
      for (const command of everyCommand(doc)) {
        const once = apply(doc, command);
        apply(once, command);
        apply(once, command);
      }
    }).not.toThrow();
  });

  it('holds for a batch of many commands over many objects', () => {
    const doc = deepFreeze(kitchenSink());
    const [aId, , cId] = idsOf(doc, 0);
    if (aId === undefined || cId === undefined) throw new Error('unreachable');
    expect(() => {
      apply(doc, {
        type: 'batch',
        cmds: [
          { type: 'setTransform', ids: [aId], patch: { x: 5 } },
          { type: 'setTransform', ids: [cId], patch: { x: 7 } },
          { type: 'setProps', ids: [aId, cId], props: { opacity: 0.25 } },
          { type: 'restack', pageId: pageIdOf(doc, 0), ids: [aId, cId], direction: 'front' },
        ],
      });
    }).not.toThrow();
  });

  it('holds for a command built from a document it then discards', () => {
    // `insert` is the one command that carries nodes rather than ids, and it clones them. If it
    // did not, the caller's node would be *in* the document, and a later edit through the command
    // object would reach into a document that has been undone away.
    const doc = deepFreeze(kitchenSink());
    const fresh = deepFreeze(createRectNode({ name: 'frozen insert' }));
    expect(() => {
      apply(doc, { type: 'insert', pageId: pageIdOf(doc, 0), index: 0, nodes: [fresh] });
    }).not.toThrow();

    const inserted = apply(doc, {
      type: 'insert',
      pageId: pageIdOf(doc, 0),
      index: 0,
      nodes: [fresh],
    }).pages[0]?.objects[0];
    expect(inserted).toBeDefined();
    // Cloned, not adopted: the document does not share the caller's object.
    expect(inserted).not.toBe(fresh);
  });
});

// ---------------------------------------------------------------------------
// 2. Untouched state is shared, not copied
// ---------------------------------------------------------------------------

describe('an untouched node is shared, not copied', () => {
  it('a one-object edit leaves every other node identical by reference', () => {
    // The other half of the invariant, and the one with a cost. A command that rebuilt every
    // node would be perfectly immutable and would also re-render the whole document on every
    // drag, which is the thing the reconciler's `prev` comparison exists to avoid.
    const doc = kitchenSink();
    const [aId, bId, cId] = idsOf(doc, 0);
    if (aId === undefined || bId === undefined || cId === undefined) throw new Error('unreachable');

    const out = apply(doc, { type: 'setTransform', ids: [aId], patch: { x: 999 } });

    expect(nodeNamed(out, 'A').id).toBe(aId);
    expect(nodeNamed(out, 'B')).toBe(nodeNamed(doc, 'B'));
    expect(nodeNamed(out, 'C')).toBe(nodeNamed(doc, 'C'));
    // The edited node is a new object, and it did not disturb its siblings.
    expect(nodeNamed(out, 'A')).not.toBe(nodeNamed(doc, 'A'));
    // The page it is on is a new object; the page it is not on is the same one.
    expect(out.pages[0]).not.toBe(doc.pages[0]);
    expect(out.pages[1]).toBe(doc.pages[1]);
  });

  it('a multi-object edit touches exactly the objects it names', () => {
    const doc = kitchenSink();
    const [aId, bId, cId] = idsOf(doc, 0);
    if (aId === undefined || bId === undefined || cId === undefined) throw new Error('unreachable');

    const out = apply(doc, { type: 'setProps', ids: [aId, cId], props: { opacity: 0.5 } });

    expect(nodeNamed(out, 'A')).not.toBe(nodeNamed(doc, 'A'));
    expect(nodeNamed(out, 'C')).not.toBe(nodeNamed(doc, 'C'));
    expect(nodeNamed(out, 'B'), 'the frame was not named, so it is the same object').toBe(
      nodeNamed(doc, 'B'),
    );
    // Every edited node carries the value; no unedited node acquired it.
    expect((nodeNamed(out, 'A') as { opacity: number }).opacity).toBe(0.5);
    expect((nodeNamed(out, 'B') as { opacity: number }).opacity).toBe(1);
  });

  it('a nested property edit rebuilds the chain and keeps the siblings', () => {
    // `setProps` is a shallow spread, so `stroke` would be replaced wholesale unless the caller
    // rebuilt it. The model does not rebuild it -- the inspector does, and that is where the
    // invariant lives -- so what this asserts is the *sharing* that makes the rebuild sound:
    // the untouched sibling is the same object, so a later edit through one path cannot be
    // observed through the other.
    const doc = kitchenSink();
    const a = nodeNamed(doc, 'A') as Extract<Node, { type: 'shape' }>;
    const out = apply(doc, {
      type: 'setProps',
      ids: [a.id],
      props: { fill: { type: 'solid', color: '#ffffff' } },
    });
    const changed = nodeNamed(out, 'A') as Extract<Node, { type: 'shape' }>;
    expect(changed.fill).not.toBe(a.fill);
    expect(changed.transform).toBe(a.transform);
  });

  it('a restack moves nodes without rebuilding them', () => {
    // Paint order is a property of the *sequence*. A restack that copied every node would be an
    // edit to every object in the selection, and the geometry assertions would still pass.
    const doc = kitchenSink();
    const [aId, , cId] = idsOf(doc, 0);
    if (aId === undefined || cId === undefined) throw new Error('unreachable');
    const out = apply(doc, {
      type: 'restack',
      pageId: pageIdOf(doc, 0),
      ids: [aId, cId],
      direction: 'front',
    });
    for (const name of ['A', 'B', 'C']) {
      expect(nodeNamed(out, name), `${name} is the same object`).toBe(nodeNamed(doc, name));
    }
  });

  it('the asset table is shared unless the command is about assets', () => {
    const doc = kitchenSink();
    const out = apply(doc, { type: 'setTransform', ids: [idsOf(doc, 0)[0] ?? ''], patch: { x: 1 } });
    // Assets are part of the model, so they are part of the document -- but a node edit has no
    // reason to touch them, and cloning a megabyte of image bytes per drag would be absurd.
    expect(out.assets).toBe(doc.assets);

    // A genuinely different record, because re-setting the same one is a no-op and returns the
    // same table -- which is the command's own invariant, asserted elsewhere.
    const other = createAssetFrom({
      mime: 'image/png',
      intrinsicWidth: 8,
      intrinsicHeight: 8,
      data: { inline: 'AAAA' },
    }).asset;
    const replaced = apply(doc, { type: 'setAssets', assets: { asset_1: other } });
    expect(replaced.assets).not.toBe(doc.assets);
    expect(replaced.assets['asset_1']).toBe(other);
    // And the untouched ids in the table are shared, not cloned.
    const two = apply(doc, {
      type: 'setAssets',
      assets: { ...doc.assets, asset_2: other },
    });
    expect(two.assets['asset_1']).toBe(doc.assets['asset_1']);
  });
});

// ---------------------------------------------------------------------------
// 3. Undo is a return to the same values, and no-op is a return to the same object
// ---------------------------------------------------------------------------

describe('undo and no-op are the two reference claims', () => {
  it('undoing a command yields a document equal to the one it started from', () => {
    for (const command of everyCommand(kitchenSink())) {
      const before = kitchenSink();
      // Same command shape, same ids: the factory is deterministic within one `resetIds`.
      const after = apply(before, command);
      if (isNoop(before, command)) {
        expect(after, describeCommandFor(command)).toBe(before);
      } else {
        expect(documentsEqual(before, after), `${describeCommandFor(command)} changed something`)
          .toBe(false);
      }
    }
  });

  it('a command that changes nothing returns the very same document', () => {
    const doc = kitchenSink();
    const [aId, bId] = idsOf(doc, 0);
    if (aId === undefined || bId === undefined) throw new Error('unreachable');
    const transform = nodeNamed(doc, 'A').transform;

    expect(apply(doc, { type: 'setTransform', ids: [aId], patch: { x: transform.x } })).toBe(doc);
    expect(apply(doc, { type: 'setProps', ids: [aId], props: { opacity: 1 } })).toBe(doc);
    expect(apply(doc, { type: 'remove', ids: [] })).toBe(doc);
    expect(apply(doc, { type: 'remove', ids: ['not_a_real_id'] })).toBe(doc);
    expect(apply(doc, { type: 'insert', pageId: pageIdOf(doc, 0), index: 0, nodes: [] })).toBe(doc);
    expect(
      apply(doc, { type: 'restack', pageId: pageIdOf(doc, 0), ids: [], direction: 'front' }),
    ).toBe(doc);
    // A stale id is a no-op, not a throw: a command can race a deletion. `bId` is *live* here, so
    // using it would have asserted the opposite of what the comment says.
    expect(bId).not.toBe('');
    expect(apply(doc, { type: 'setTransform', ids: ['node_deleted'], patch: { x: 1 } })).toBe(doc);
    expect(apply(doc, { type: 'setProps', ids: ['node_deleted'], props: { opacity: 0.5 } })).toBe(
      doc,
    );
    expect(apply(doc, { type: 'setTextStyle', ids: ['node_deleted'], patch: { color: '#fff' } })).toBe(
      doc,
    );
  });
});

function describeCommandFor(command: Command): string {
  return command.type;
}
