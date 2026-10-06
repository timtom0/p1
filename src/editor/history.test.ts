/**
 * History: transactions, coalescing, and the undo/redo cursor.
 *
 * Split out from the command-funnel tests because of the layering rule in
 * ``eslint.config.js``: ``model`` may not import from ``editor``. History is an
 * editor concern that happens to be pure, so its tests live with it.
 */

import { describe, expect, it } from 'vitest';
import type { Document, Page, Transform2D } from '../model/types';
import { apply } from '../model/commands';
import { createDocument, createRectNode, createTransform } from '../model/factory';
import { History } from './history';

/** Two pages, three objects, with non-round positions so a patch cannot be a no-op. */
function makeDoc(): Document {
  const page = (id: string, objects: Page['objects']): Page => ({
    id,
    name: id,
    background: { type: 'solid', color: '#ffffff' },
    objects,
  });

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

function transformOf(d: Document, id: string): Transform2D {
  for (const page of d.pages) {
    const node = page.objects.find((candidate) => candidate.id === id);
    if (node !== undefined) return node.transform;
  }
  throw new Error(`no node ${id}`);
}

const doc = makeDoc;

function ids(d: Document): string[] {
  return d.pages.flatMap((page) => page.objects.map((node) => node.id));
}

describe('history', () => {
  const setup = () => {
    const start = doc();
    return { start, history: new History(), id: ids(start)[0] ?? '' };
  };

  it('starts empty and says so', () => {
    const { start, history } = setup();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(history.undoLabel).toBeNull();
    expect(history.undo(start)).toBe(start);
  });

  it('undo and redo round-trip', () => {
    const { start, history, id } = setup();
    const moved = history.dispatch(start, { type: 'setTransform', ids: [id], patch: { x: 40 } }).doc;

    expect(history.canUndo).toBe(true);
    expect(history.undoLabel).toBe('Transform');

    const undone = history.undo(moved);
    expect(undone).toBe(start);

    const redone = history.redo(undone);
    expect(transformOf(redone, id).x).toBe(40);
    expect(history.canRedo).toBe(false);
  });

  it('a no-op records nothing', () => {
    const { start, history, id } = setup();

    // Targeting a node that does not exist.
    expect(history.dispatch(start, { type: 'setTransform', ids: ['missing'], patch: { x: 1 } }).changed).toBe(false);

    // Targeting a node that does, with the values it already holds. This is the case
    // a click-without-drag produces, and it is why the funnel compares fields.
    expect(history.dispatch(start, { type: 'setTransform', ids: [id], patch: { x: 12.5 } }).changed).toBe(false);

    expect(history.canUndo).toBe(false);
    expect(history.depth).toBe(0);
  });

  it('coalesces a gesture into one entry', () => {
    const { start, history, id } = setup();
    history.begin(start, { label: 'Move', mergeKey: 'g' });

    let current = start;
    for (const x of [10, 20, 30, 40]) {
      current = history.dispatch(current, {
        type: 'setTransform',
        ids: [id],
        patch: { x },
      }).doc;
    }
    history.end();

    expect(history.depth).toBe(1);
    expect(history.undoLabel).toBe('Move');
    expect(history.undo(current)).toBe(start);
  });

  it('a changed merge key starts a new entry inside one transaction', () => {
    const { start, history, id } = setup();
    history.begin(start, { mergeKey: 'first' });
    let current = history.dispatch(start, { type: 'setTransform', ids: [id], patch: { x: 10 } }).doc;
    current = history.dispatch(current, { type: 'setTransform', ids: [id], patch: { x: 20 } }).doc;
    current = history.dispatch(current, { type: 'setTransform', ids: [id], patch: { x: 30 } }, { mergeKey: 'second' }).doc;
    history.end();

    expect(history.depth).toBe(2);
    // One step back lands between the two gestures, not at the start.
    const once = history.undo(current);
    expect(transformOf(once, id).x).toBe(20);
    expect(history.undo(once)).toBe(start);
  });

  it('an empty transaction leaves no entry', () => {
    const { start, history } = setup();
    history.begin(start, { label: 'Move' });
    history.end();
    expect(history.depth).toBe(0);
  });

  it('ignores a nested begin, so the outermost transaction owns the entry', () => {
    const { start, history, id } = setup();
    history.begin(start, { label: 'Outer', mergeKey: 'outer' });
    history.begin(start, { label: 'Inner', mergeKey: 'inner' });
    const current = history.dispatch(start, { type: 'setTransform', ids: [id], patch: { x: 11 } }).doc;
    history.end();

    expect(history.depth).toBe(1);
    expect(history.undoLabel).toBe('Outer');
    expect(history.undo(current)).toBe(start);
  });

  it('closes the transaction even when the body throws', () => {
    const { start, history } = setup();
    expect(() =>
      history.transact(start, { label: 'Boom' }, () => {
        throw new Error('gesture failed');
      }),
    ).toThrow('gesture failed');

    expect(history.isTransactionOpen).toBe(false);
    // A leaked transaction would merge every later action into one entry.
    expect(history.depth).toBe(0);
  });

  it('drops the redo branch when new work arrives', () => {
    const { start, history, id } = setup();
    const first = history.dispatch(start, { type: 'setTransform', ids: [id], patch: { x: 55 } }).doc;
    history.undo(first);
    expect(history.canRedo).toBe(true);

    history.dispatch(start, { type: 'setTransform', ids: [id], patch: { x: 99 } });
    expect(history.canRedo).toBe(false);
  });

  it('honours the depth limit, dropping the oldest entries', () => {
    const start = doc();
    const history = new History({ limit: 3 });
    const id = ids(start)[0] ?? '';

    let current = start;
    for (let x = 1; x <= 5; x += 1) {
      current = history.dispatch(current, {
        type: 'setTransform',
        ids: [id],
        patch: { x },
      }).doc;
    }

    expect(history.depth).toBe(3);
    // Three undos from the tip reach the state before the oldest surviving entry.
    // Entries for x=1 and x=2 were dropped, so x=2 is as far back as undo can go.
    let state = current;
    for (let i = 0; i < 3; i += 1) state = history.undo(state);
    expect(history.canUndo).toBe(false);
    expect(transformOf(state, id).x).toBe(2);
  });

  it('commitExternal records a discovered change as one entry', () => {
    const { start, history, id } = setup();
    const edited = apply(start, { type: 'setTransform', ids: [id], patch: { x: 77 } });
    const after = history.commitExternal(start, edited, {
      type: 'setTransform',
      ids: [id],
      patch: { x: 77 },
    });

    expect(after).toBe(edited);
    expect(history.depth).toBe(1);
    expect(history.undoLabel).toBe('Transform');
    expect(history.undo(after)).toBe(start);
  });

  it('commitExternal ignores a change that is not one', () => {
    const { start, history } = setup();
    expect(history.commitExternal(start, start, { type: 'remove', ids: [] })).toBe(start);
    expect(history.depth).toBe(0);
  });

  it('clear forgets everything', () => {
    const { start, history, id } = setup();
    history.dispatch(start, { type: 'setTransform', ids: [id], patch: { x: 5 } });
    history.clear();
    expect(history.canUndo).toBe(false);
    expect(history.depth).toBe(0);
  });

  it('a dispatch may name its own entry', () => {
    const { start, history, id } = setup();
    history.dispatch(start, { type: 'setTransform', ids: [id], patch: { x: 55 } }, { label: 'Move 3 objects' });
    expect(history.undoLabel).toBe('Move 3 objects');
  });

  it('a cancelled gesture records nothing, even though it dispatched commands', () => {
    const { start, history, id } = setup();

    // This is `Editor.cancelGesture` exactly: the transaction opened on pointer-down is
    // still open and the drag has moved the object. Aborting must return the document
    // to where it started and leave no entry.
    history.begin(start, { label: 'Move 1 object', mergeKey: 'gesture' });
    const moved = history.dispatch(start, { type: 'setTransform', ids: [id], patch: { x: 90 } }).doc;
    expect(transformOf(moved, id).x).toBe(90);

    const restored = history.abort();

    expect(restored).toBe(start);
    expect(history.depth).toBe(0);
    expect(history.canUndo).toBe(false);
  });

  it('abort discards entries a mid-gesture flush already created', () => {
    const { start, history, id } = setup();

    history.begin(start, { mergeKey: 'first' });
    const first = history.dispatch(start, { type: 'setTransform', ids: [id], patch: { x: 20 } }).doc;
    // A merge-key change flushes the first entry into the list mid-transaction.
    const second = history.dispatch(first, { type: 'setTransform', ids: [id], patch: { x: 40 } }, {
      mergeKey: 'second',
    }).doc;
    expect(history.depth).toBe(1);

    const restored = history.abort();

    expect(restored).toBe(start);
    expect(history.depth).toBe(0);
    expect(transformOf(second, id).x).toBe(40);
  });

  it('abort with no open transaction does nothing', () => {
    const { history } = setup();
    expect(history.abort()).toBeNull();
    expect(history.depth).toBe(0);
  });

  it('a gesture that really moved still records one entry', () => {
    const { start, history, id } = setup();
    const startTransform = transformOf(start, id);

    history.begin(start, { label: 'Move 1 object', mergeKey: 'gesture' });
    const moved = history.dispatch(start, { type: 'setTransform', ids: [id], patch: { x: 90 } }).doc;
    // A partial retreat, not a full return: this is a real action.
    history.dispatch(moved, { type: 'setTransform', ids: [id], patch: { ...startTransform, x: 40 } }, {
      mergeKey: 'gesture',
    });
    history.end();

    expect(history.depth).toBe(1);
    expect(history.undo(start)).toBe(start);
  });
});

