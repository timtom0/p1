/**
 * The save/load rules, tested without a browser.
 *
 * Everything here is a rule rather than a mechanic: what dirty means, what a save does to an
 * open text session, and what an open is allowed to change when it fails. The browser
 * mechanics are behind {@link DocumentGateway}, and the round trip through *real bytes* is
 * the browser suite's job (`tests/editor/persistence.spec.ts`).
 *
 * The fake gateway is deliberately dumb -- it records what it was handed -- so a passing
 * assertion is about this module's decisions and not about the fake's.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { resetIds } from '../../src/core/ids';
import {
  createDocument,
  createPage,
  createRectNode,
  createTextFrameNode,
} from '../../src/model/factory';
import { plainToRichText } from '../../src/model/rich-text';
import { documentsEqual } from '../../src/model/document-equality';
import type { Command } from '../../src/model/commands';
import type { Document, Node, Page } from '../../src/model/types';
import { DocStore } from '../../src/editor/store/doc-store';
import {
  DocumentSession,
  type DocumentGateway,
  type OpenedDocument,
} from '../../src/ui/persistence';
import { CURRENT_FORMAT_VERSION, DOCUMENT_FORMAT } from '../../src/persist/format';
import { parse } from '../../src/persist/deserialize';
import { serializeToString } from '../../src/persist/serialize';

// ---------------------------------------------------------------------------
// A gateway that records rather than transfers
// ---------------------------------------------------------------------------

interface Recorded {
  name: string;
  text: string;
}

class FakeGateway implements DocumentGateway {
  readonly writes: Recorded[] = [];

  /** What the next `read` hands back. An `Error` means "reading threw". */
  next: OpenedDocument | Error | null = null;

  async write(name: string, text: string): Promise<void> {
    this.writes.push({ name, text });
  }

  async read(): Promise<OpenedDocument | null> {
    const next = this.next;
    if (next instanceof Error) throw next;
    return next;
  }

  get lastWrite(): Recorded {
    const last = this.writes[this.writes.length - 1];
    if (last === undefined) throw new Error('nothing was written');
    return last;
  }
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

function pageWith(...objects: Node[]): Page {
  const page = createPage({ name: '1' });
  page.objects = objects;
  return page;
}

function documentWithRect(name = 'Doc'): Document {
  return createDocument({
    name,
    pages: [
      pageWith(
        createRectNode({
          name: 'R',
          transform: { x: 1, y: 2, width: 10, height: 10, rotation: 0, scaleX: 1, scaleY: 1 },
        }),
      ),
    ],
  });
}

function textDocument(text: string): Document {
  return createDocument({
    pages: [pageWith(createTextFrameNode({ name: 'T', text: plainToRichText(text) }))],
  });
}

/**
 * Stands in for `Editor.endTextEdit()`.
 *
 * The real one discovers the session's text from the DOM and commits it through the funnel
 * as a single undo entry. This does the same thing through the same two calls, so the test
 * exercises the real shape of the interaction -- synchronous, funnel-mediated, one undo
 * entry -- rather than a stub that only sets a flag.
 */
function commitText(store: DocStore, text: string): void {
  const node = store.state.pages[0]?.objects[0];
  if (node === undefined || node.type !== 'textFrame') throw new Error('expected a text frame');
  const command: Command = { type: 'setText', nodeId: node.id, text: plainToRichText(text) };
  store.commitExternal(
    createDocument({ ...store.state, pages: [pageWith({ ...node, text: plainToRichText(text) })] }),
    command,
    'Edit text',
  );
}

/** A real dispatch through the funnel, so no-op dropping is exercised too. */
function moveRect(store: DocStore, x: number): void {
  const node = store.state.pages[0]?.objects[0];
  if (node === undefined) throw new Error('unreachable');
  store.dispatch({
    type: 'setTransform',
    ids: [node.id],
    patch: { x },
  });
}

function setup(options: { commit?: () => void; name?: string } = {}): {
  store: DocStore;
  gateway: FakeGateway;
  session: DocumentSession;
} {
  resetIds();
  const store = new DocStore(documentWithRect(options.name));
  const gateway = new FakeGateway();
  const session = new DocumentSession(store, gateway, options.commit ?? (() => {}));
  return { store, gateway, session };
}

/** A minimal valid persisted document, for cases that only care about the version. */
function persisted(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: DOCUMENT_FORMAT,
    formatVersion: CURRENT_FORMAT_VERSION,
    id: 'doc_x',
    name: 'X',
    pageSize: { width: 210, height: 297, unit: 'mm', orientation: 'portrait' },
    assets: {},
    pages: [
      {
        id: 'page_1',
        name: '1',
        background: { type: 'solid', color: '#ffffff' },
        objects: [],
      },
    ],
    ...overrides,
  });
}

beforeEach(() => {
  resetIds();
});

// ---------------------------------------------------------------------------
// Dirty state
// ---------------------------------------------------------------------------

describe('dirty state', () => {
  it('is clean for a document that has just been created', () => {
    const { session } = setup();
    expect(session.isDirty).toBe(false);
  });

  it('becomes dirty after an edit', () => {
    const { store, session } = setup();
    moveRect(store, 50);
    expect(session.isDirty).toBe(true);
  });

  it('returns to clean when the edit is undone, with no save in between', () => {
    // The property that makes the indicator trustworthy, and the reason dirty state is a
    // derived read rather than a stored flag: undo restores the previous `Document`, so
    // canonical equality settles it with no bookkeeping.
    const { store, session } = setup();
    expect(session.isDirty).toBe(false);
    moveRect(store, 50);
    expect(session.isDirty).toBe(true);
    store.undo();
    expect(session.isDirty).toBe(false);
  });

  it('is clean after save, edit, and undo back to the saved state', async () => {
    // The exact sequence in the milestone brief. Getting this wrong means either a
    // permanently-dirty indicator or one that misses real changes.
    const { store, gateway, session } = setup();
    await session.save();
    expect(session.isDirty).toBe(false);

    // The edit has to come *after* the save, or the assertion below would be about undo
    // alone -- which is the other test.
    moveRect(store, 50);
    expect(session.isDirty).toBe(true);

    store.undo();
    expect(session.isDirty).toBe(false);
    expect(gateway.writes).toHaveLength(1);
  });

  it('is dirty when an edit is undone back to a state other than the baseline', async () => {
    // The negative control for the test above. Undo restores the previous `Document`, not
    // "the saved one", so undoing an edit made after a save must not accidentally look
    // clean just because undo worked.
    const { store, session } = setup();
    await session.save();
    moveRect(store, 50);
    moveRect(store, 60);
    store.undo();
    // Back to x=50, which is not the saved x=1.
    expect(session.isDirty).toBe(true);
  });

  it('stays clean for a command the funnel drops as a no-op', () => {
    // Setting the x the object already has. `isNoop` returns the same document reference,
    // the store's `commit` short-circuits, and the session never sees a change -- so an
    // inspector field re-committed with its existing value must not light the indicator.
    const { store, session } = setup();
    moveRect(store, 1);
    expect(session.isDirty).toBe(false);
  });

  it('does not consider a document equal under a different key order dirty', () => {
    const { store, session } = setup();
    const current = store.state;
    // Rebuild every node with its keys back to front: the same document, a different
    // insertion order. A dirty check that stringified would call this dirty.
    const rebuilt = createDocument({
      ...current,
      pages: current.pages.map((page) => ({
        ...page,
        // Cast: the reversal is type-preserving, but `Object.fromEntries` cannot know that.
        objects: page.objects.map(
          (node) => Object.fromEntries(Object.entries(node).reverse()) as Node,
        ),
      })),
    });
    expect(JSON.stringify(rebuilt)).not.toBe(JSON.stringify(current));
    expect(documentsEqual(rebuilt, current)).toBe(true);

    store.reset(rebuilt);
    expect(session.isDirty).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

describe('save', () => {
  it('writes the canonical bytes', async () => {
    const { store, gateway, session } = setup();
    moveRect(store, 7);
    await session.save();
    expect(gateway.lastWrite.text).toBe(serializeToString(store.state));
  });

  it('names the file after the document, with the extension added once', async () => {
    const { gateway, session } = setup({ name: 'Poster' });
    await session.save();
    expect(gateway.lastWrite.name).toBe('Poster.p1doc');

    // A second save must not produce `Poster.p1doc.p1doc`.
    await session.save();
    expect(gateway.lastWrite.name).toBe('Poster.p1doc');
  });

  it('keeps a name that already carries the extension', async () => {
    const { gateway, session } = setup({ name: 'Poster.p1doc' });
    await session.save();
    expect(gateway.lastWrite.name).toBe('Poster.p1doc');
  });

  it('makes the document clean', async () => {
    const { store, session } = setup();
    moveRect(store, 3);
    expect(session.isDirty).toBe(true);
    await session.save();
    expect(session.isDirty).toBe(false);
  });

  it('reports a delivery failure and stays dirty', async () => {
    // The gateway is the one thing that can fail, and if it does the document must *not* be
    // marked clean -- otherwise the indicator claims the work is safe when it is not.
    resetIds();
    const store = new DocStore(documentWithRect());
    const failing: DocumentGateway = {
      write: () => Promise.reject(new Error('disk full')),
      read: () => Promise.resolve(null),
    };
    const session = new DocumentSession(store, failing);
    moveRect(store, 3);

    expect(await session.save()).toBe('cancelled');
    expect(session.isDirty).toBe(true);
    expect(session.error).toContain('disk full');
  });

  it('clears a previous error on success', async () => {
    const { gateway, session } = setup();
    gateway.next = new Error('nope');
    await session.open();
    expect(await session.save()).toBe('saved');
    expect(session.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Saving during a text session
// ---------------------------------------------------------------------------

describe('save during a text session', () => {
  // The fence rule (ADR 0001) applied at save time: the browser owns the editable subtree,
  // so the model's text is stale while a session is open.

  it('commits the session first, so the saved text is not stale', async () => {
    resetIds();
    const store = new DocStore(textDocument('before'));
    const gateway = new FakeGateway();
    let commits = 0;
    const session = new DocumentSession(store, gateway, () => {
      commits += 1;
      commitText(store, 'typed by the user');
    });

    expect(await session.save()).toBe('saved');
    expect(commits).toBe(1);

    const written = parse(JSON.parse(gateway.lastWrite.text));
    const node = written.pages[0]?.objects[0];
    if (node?.type !== 'textFrame') throw new Error('unreachable');
    // The decisive assertion: the file carries the typed text, not the pre-session text.
    // Serializing the stale model instead would pass every other test in this suite.
    expect(node.text.blocks[0]?.runs[0]?.text).toBe('typed by the user');

    // And the commit went through the funnel, so it is undoable -- one entry, not two.
    expect(store.canUndo).toBe(true);
    store.undo();
    const after = store.state.pages[0]?.objects[0];
    if (after?.type !== 'textFrame') throw new Error('unreachable');
    expect(after.text.blocks[0]?.runs[0]?.text).toBe('before');
  });

  it('is clean afterwards, because saving adopts the committed document as the baseline', async () => {
    resetIds();
    const store = new DocStore(textDocument('a'));
    const session = new DocumentSession(store, new FakeGateway(), () => {
      commitText(store, 'ab');
    });
    await session.save();
    expect(session.isDirty).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

describe('open', () => {
  it('replaces the document and becomes clean', async () => {
    const { store, gateway, session } = setup();
    gateway.next = {
      name: 'incoming.p1doc',
      text: serializeToString(documentWithRect('Incoming')),
    };

    expect(await session.open()).toBe('saved');
    expect(store.state.name).toBe('Incoming');
    expect(session.isDirty).toBe(false);
    expect(session.filename).toBe('incoming.p1doc');
    expect(session.hasFile).toBe(true);
  });

  it('clears history, because undoing across documents would jump between them', async () => {
    const { store, gateway, session } = setup();
    moveRect(store, 99);
    expect(store.canUndo).toBe(true);
    gateway.next = {
      name: 'other.p1doc',
      text: serializeToString(documentWithRect('Other')),
    };

    await session.open();
    expect(store.canUndo).toBe(false);
    expect(store.canRedo).toBe(false);
  });

  it('leaves everything untouched when the document is refused', async () => {
    // The critical failure path. A half-opened document would leave the user unsure what
    // they were editing -- and the baseline in particular must keep describing the document
    // that is actually open, or dirty state starts lying immediately.
    const { store, gateway, session } = setup();
    moveRect(store, 42);
    const before = store.state;
    gateway.next = { name: 'broken.p1doc', text: '{ "format": "p1doc" }' };

    expect(await session.open()).toBe('cancelled');
    expect(store.state).toBe(before);
    expect(session.isDirty).toBe(true);
    expect(session.error).toContain('formatVersion');
    // The name is untouched too, so the next save still writes where the user expects.
    expect(session.filename).toBe('Doc.p1doc');
  });

  it('distinguishes "not JSON" from "JSON this build refuses"', async () => {
    const { gateway, session } = setup();

    gateway.next = { name: 'x.p1doc', text: 'this is not json' };
    await session.open();
    expect(session.error).toContain('not a readable document');

    // A document with no pages: valid JSON, refused by the parser.
    gateway.next = { name: 'x.p1doc', text: persisted({ pages: [] }) };
    await session.open();
    expect(session.error).toContain('pages');
    expect(session.error).not.toContain('not a readable document');
  });

  it('refuses an unsupported version with a message naming both versions', async () => {
    const { gateway, session } = setup();
    gateway.next = {
      name: 'future.p1doc',
      text: persisted({ formatVersion: CURRENT_FORMAT_VERSION + 1 }),
    };
    await session.open();
    expect(session.error).toContain('newer version');
    expect(session.error).toContain(String(CURRENT_FORMAT_VERSION + 1));
  });

  it('refuses an unknown object type, naming it and where', async () => {
    const { gateway, session } = setup();
    const text = persisted({
      pages: [
        {
          id: 'page_1',
          name: '1',
          background: { type: 'solid', color: '#ffffff' },
          objects: [{ type: 'sticker', id: 'node_1', name: 'S' }],
        },
      ],
    });
    gateway.next = { name: 'x.p1doc', text };
    await session.open();
    expect(session.error).toContain('unknown object type "sticker"');
    expect(session.error).toContain('pages[0].objects[0].type');
  });

  it('refuses an unknown shape kind', async () => {
    const { gateway, session } = setup();
    const text = persisted({
      pages: [
        {
          id: 'page_1',
          name: '1',
          background: { type: 'solid', color: '#ffffff' },
          objects: [
            {
              type: 'shape',
              id: 'node_1',
              name: 'S',
              transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0, scaleX: 1, scaleY: 1 },
              visible: true,
              locked: false,
              opacity: 1,
              blendMode: 'normal',
              shape: { kind: 'polygon' },
            },
          ],
        },
      ],
    });
    gateway.next = { name: 'x.p1doc', text };
    await session.open();
    expect(session.error).toContain('unknown shape kind "polygon"');
  });

  it('refuses an image whose asset reference resolves to nothing', async () => {
    const { gateway, session } = setup();
    const text = persisted({
      pages: [
        {
          id: 'page_1',
          name: '1',
          background: { type: 'solid', color: '#ffffff' },
          objects: [
            {
              type: 'image',
              id: 'node_1',
              name: 'I',
              transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0, scaleX: 1, scaleY: 1 },
              visible: true,
              locked: false,
              opacity: 1,
              blendMode: 'normal',
              asset: 'asset_missing',
            },
          ],
        },
      ],
    });
    gateway.next = { name: 'x.p1doc', text };
    await session.open();
    expect(session.error).toContain('asset_missing');
  });

  it('does not clear a previous error when the dialog is cancelled', async () => {
    // Cancelling is not a failure, and must not turn a real message into "no problem".
    const { gateway, session } = setup();
    gateway.next = new Error('read failed');
    await session.open();

    gateway.next = null;
    expect(await session.open()).toBe('cancelled');
    expect(session.error).toContain('read failed');
  });

  it('leaves the document alone when the dialog is cancelled', async () => {
    const { store, gateway, session } = setup();
    moveRect(store, 3);
    gateway.next = null;
    expect(await session.open()).toBe('cancelled');
    expect(session.isDirty).toBe(true);
    expect(session.filename).toBe('Doc.p1doc');
  });

  it('opens a document whose image asset cannot be resolved', async () => {
    // `{ external }` round-trips verbatim and is never fetched, so a document referencing a
    // file that is not there is still a *valid document*. Opening must succeed; the
    // renderer is what reports the missing asset.
    resetIds();
    const { store, gateway, session } = setup();
    const incoming = createDocument({
      name: 'External',
      assets: {
        asset_1: {
          kind: 'image',
          mime: 'image/png',
          intrinsicWidth: 4,
          intrinsicHeight: 4,
          data: { external: './nowhere.png' },
        },
      },
    });
    gateway.next = { name: 'external.p1doc', text: serializeToString(incoming) };

    expect(await session.open()).toBe('saved');
    const asset = store.state.assets['asset_1'];
    expect(asset).toBeDefined();
    expect('external' in (asset?.data ?? {})).toBe(true);
    expect(session.isDirty).toBe(false);
  });

  it('round-trips its own bytes', async () => {
    // The unit-level version of the browser round trip: save, take the bytes, open them in
    // a second session. Cheap, and it drives the same functions the UI does.
    const { store, gateway, session } = setup();
    moveRect(store, 21);
    await session.save();
    const text = gateway.lastWrite.text;

    const other = new DocStore(store.state);
    const second = new DocumentSession(other, gateway);
    gateway.next = { name: gateway.lastWrite.name, text };
    await second.open();

    expect(documentsEqual(other.state, store.state)).toBe(true);
    expect(second.isDirty).toBe(false);
  });
});

describe('resetTo', () => {
  it('replaces the document, clears history, and reports clean', () => {
    const { store, session } = setup();
    moveRect(store, 5);
    session.resetTo(documentWithRect('Fresh'));
    expect(store.state.name).toBe('Fresh');
    expect(store.canUndo).toBe(false);
    expect(session.isDirty).toBe(false);
    expect(session.hasFile).toBe(false);
  });
});