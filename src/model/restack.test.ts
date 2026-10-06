/**
 * Layer order.
 *
 * `restack` is the one command where the *processing order* is the behaviour, so most of
 * these tests are about what does **not** happen: two adjacent selected objects must not swap,
 * a set's internal order must survive, and an impossible move must return the same array
 * reference so the funnel drops it.
 *
 * That last one is the load-bearing no-op rule. `isNoop` decides by reference identity, so
 * "returns a fresh but equal array" is not a no-op — it is an undo step that does nothing,
 * which is the exact failure §4.2's rule exists to prevent. Each no-op case therefore asserts
 * identity, not equality, and the mutation that would break this is in `mutation-check.ps1`.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { resetIds } from '../core/ids';
import { createDocument, createPage, createRectNode } from './factory';
import { apply, describeCommand, isNoop } from './commands';
import type { Command, RestackDirection } from './commands';
import type { Document, Node } from './types';

/** A stack of `count` rects, named `a`, `b`, `c`... in paint order. */
function stackOf(count: number): Document {
  const names = ['a', 'b', 'c', 'd', 'e', 'f'];
  const page = createPage({ name: '1' });
  page.objects = [];
  for (let index = 0; index < count; index += 1) {
    page.objects.push(createRectNode({ name: names[index] ?? `n${index}` }));
  }
  return createDocument({ pages: [page] });
}

function pageId(doc: Document): string {
  const id = doc.pages[0]?.id;
  if (id === undefined) throw new Error('unreachable');
  return id;
}

function ids(doc: Document, ...names: string[]): string[] {
  const objects = doc.pages[0]?.objects ?? [];
  return names.map((name) => {
    const node = objects.find((candidate) => candidate.name === name);
    if (node === undefined) throw new Error(`no object named ${name}`);
    return node.id;
  });
}

function restack(doc: Document, direction: RestackDirection, ...names: string[]): Document {
  return apply(doc, { type: 'restack', pageId: pageId(doc), ids: ids(doc, ...names), direction });
}

/** Paint order as names: index 0 is furthest back. */
function order(doc: Document): string[] {
  return (doc.pages[0]?.objects ?? []).map((node) => node.name);
}

function objectAt(doc: Document, index: number): Node {
  const node = doc.pages[0]?.objects[index];
  if (node === undefined) throw new Error(`no object at ${index}`);
  return node;
}

beforeEach(() => {
  resetIds();
});

describe('restack: one position', () => {
  it('brings a middle object forward past the one above it', () => {
    const doc = stackOf(4);
    expect(order(restack(doc, 'forward', 'b'))).toEqual(['a', 'c', 'b', 'd']);
  });

  it('sends a middle object backward past the one below it', () => {
    const doc = stackOf(4);
    expect(order(restack(doc, 'backward', 'c'))).toEqual(['a', 'c', 'b', 'd']);
  });

  it('does not swap two adjacent selected objects with each other', () => {
    // The negative control for the processing order. Both `a` and `b` move forward one
    // position; if the loop visited them the other way round they would trade places, which
    // looks like a bug and is the most likely way to get this wrong.
    const doc = stackOf(4);
    const out = order(restack(doc, 'forward', 'a', 'b'));
    expect(out).toEqual(['c', 'a', 'b', 'd']);
    expect(out.indexOf('a')).toBeLessThan(out.indexOf('b'));
  });

  it('mirrors that for backward', () => {
    // `c` and `d` are adjacent and both move one position down. Each swaps with whatever is
    // directly in front of it, so the two stay adjacent and keep their relative order:
    //   c: [a,b,c,d,e] -> [a,c,b,d,e]   (swapped with b)
    //   d: [a,c,b,d,e] -> [a,c,d,b,e]   (swapped with c, which it has just displaced)
    const doc = stackOf(5);
    const out = order(restack(doc, 'backward', 'c', 'd'));
    expect(out).toEqual(['a', 'c', 'd', 'b', 'e']);
    expect(out.indexOf('c')).toBeLessThan(out.indexOf('d'));
  });

  it('does not swap two adjacent selected objects for backward either', () => {
    // The negative control for the backward direction, and the reason the iteration order is
    // reversed for forward and *not* reversed for backward. Visited the other way round, `b`
    // and `c` would end up the wrong way up: `a,c,b,d` instead of `b,c,a,d`.
    const doc = stackOf(4);
    const out = order(restack(doc, 'backward', 'b', 'c'));
    expect(out).toEqual(['b', 'c', 'a', 'd']);
    expect(out.indexOf('b')).toBeLessThan(out.indexOf('c'));
  });

  it('does not step over a selected object that cannot move itself', () => {
    // The rule that front-to-back ordering alone does not give. `d` is frontmost, so it has
    // nowhere to go; without an explicit check, `c` moves into the slot `d` is still sitting
    // in and the two end up the wrong way up -- the one thing this command promises never to
    // happen. Found by the browser suite, not by reasoning: see ADR 0008 §6.
    const doc = stackOf(4);
    const out = order(restack(doc, 'forward', 'a', 'c', 'd'));
    // Only `a` moves, because only `a` has an unselected neighbour in front of it.
    expect(out).toEqual(['b', 'a', 'c', 'd']);
    expect(out.indexOf('c')).toBeLessThan(out.indexOf('d'));
  });

  it('mirrors that for backward, at the bottom of the stack', () => {
    // The mirror image: `a` is backmost and cannot move, so `b` and `c` are blocked by it.
    // Note that the selected set must *include* the blocked object -- selecting `b`, `c` and
    // `d` from `[a,b,c,d]` leaves `a` unselected and free to trade with, and all three of them
    // move down exactly one.
    const doc = stackOf(4);
    const out = order(restack(doc, 'backward', 'a', 'b', 'c'));
    expect(out).toEqual(['a', 'b', 'c', 'd']);
    expect(out.indexOf('a')).toBeLessThan(out.indexOf('b'));
  });

  it('does move each of them when the blocked end is not selected', () => {
    // The negative control for the test above, and the reason the rule is about *selected*
    // neighbours rather than about neighbours: `a` is unselected here, so it trades with all
    // three and the whole set slides down one while keeping its order.
    const doc = stackOf(4);
    const out = order(restack(doc, 'backward', 'b', 'c', 'd'));
    expect(out).toEqual(['b', 'c', 'd', 'a']);
    expect(out.indexOf('b')).toBeLessThan(out.indexOf('c'));
    expect(out.indexOf('c')).toBeLessThan(out.indexOf('d'));
  });

  it('is a no-op for the whole stack, in either direction', () => {
    // A consequence worth stating rather than leaving to be discovered: with every object
    // selected there is no unselected neighbour to trade with, so nothing can move. The
    // browser suite asserts this through the UI too.
    const doc = stackOf(4);
    for (const direction of ['forward', 'backward'] as const) {
      const command: Command = {
        type: 'restack',
        pageId: pageId(doc),
        ids: ids(doc, 'a', 'b', 'c', 'd'),
        direction,
      };
      expect(isNoop(doc, command), direction).toBe(true);
      expect(apply(doc, command), direction).toBe(doc);
    }
  });

  it('does not let a selected object jump over a gap left by a moving neighbour', () => {
    // `b` and `d`, with `c` between them and not selected. `b` swaps with `c`; `d` then has
    // to step up into the slot `c` vacated, not into the slot `b` vacated. A "move each to
    // its original index + 1" implementation gets this wrong.
    const doc = stackOf(5);
    expect(order(restack(doc, 'forward', 'b', 'd'))).toEqual(['a', 'c', 'b', 'e', 'd']);
  });
});

describe('restack: to the ends', () => {
  it('brings several objects to the front, preserving their relative order', () => {
    const doc = stackOf(5);
    expect(order(restack(doc, 'front', 'a', 'c'))).toEqual(['b', 'd', 'e', 'a', 'c']);
  });

  it('sends several objects to the back, preserving their relative order', () => {
    const doc = stackOf(5);
    expect(order(restack(doc, 'back', 'c', 'e'))).toEqual(['c', 'e', 'a', 'b', 'd']);
  });

  it('brings every object to the front and changes nothing', () => {
    // Already at the front as a set, so the order is identical. A naive implementation that
    // removed and re-appended would produce a *new array* and an undo step that does nothing;
    // the reference-identity check below is what catches that.
    const doc = stackOf(4);
    const command: Command = {
      type: 'restack',
      pageId: pageId(doc),
      ids: ids(doc, 'a', 'b', 'c', 'd'),
      direction: 'front',
    };
    const out = apply(doc, command);
    expect(order(out)).toEqual(['a', 'b', 'c', 'd']);
    expect(isNoop(doc, command)).toBe(true);
    expect(out).toBe(doc);
  });

  it('ignores the order ids were given in', () => {
    // A selection has no order; the stack does. Stacking order is the only order.
    const doc = stackOf(4);
    const command: Command = {
      type: 'restack',
      pageId: pageId(doc),
      ids: ids(doc, 'd', 'a', 'c'),
      direction: 'front',
    };
    expect(order(apply(doc, command))).toEqual(['b', 'a', 'c', 'd']);
  });
});

describe('restack: no-ops', () => {
  it('is a no-op for the topmost object brought forward', () => {
    const doc = stackOf(3);
    const command: Command = {
      type: 'restack',
      pageId: pageId(doc),
      ids: ids(doc, 'c'),
      direction: 'forward',
    };
    expect(isNoop(doc, command)).toBe(true);
    expect(apply(doc, command)).toBe(doc);
  });

  it('is a no-op for the bottom-most object sent backward', () => {
    const doc = stackOf(3);
    const command: Command = {
      type: 'restack',
      pageId: pageId(doc),
      ids: ids(doc, 'a'),
      direction: 'backward',
    };
    expect(isNoop(doc, command)).toBe(true);
  });

  it('is a no-op for a single object already at the front or the back', () => {
    const doc = stackOf(3);
    // The frontmost object brought to the front, and the back-most sent to the back. Note the
    // pairing: `front` on `a` is a *real* move, because `a` is the furthest back.
    for (const [direction, name] of [
      ['front', 'c'],
      ['back', 'a'],
    ] as const) {
      const command: Command = {
        type: 'restack',
        pageId: pageId(doc),
        ids: ids(doc, name),
        direction,
      };
      expect(isNoop(doc, command), `${direction} ${name}`).toBe(true);
    }
  });

  it('is a no-op for an empty id list', () => {
    const doc = stackOf(3);
    const command: Command = { type: 'restack', pageId: pageId(doc), ids: [], direction: 'front' };
    expect(isNoop(doc, command)).toBe(true);
    expect(apply(doc, command)).toBe(doc);
  });

  it('ignores ids that are not on the page', () => {
    // A multi-page selection restacks per page, and the caller batches, so an id belonging
    // to another page must be a no-op rather than an error.
    const doc = stackOf(2);
    const command: Command = {
      type: 'restack',
      pageId: pageId(doc),
      ids: ['node_does_not_exist'],
      direction: 'front',
    };
    expect(isNoop(doc, command)).toBe(true);
    expect(apply(doc, command)).toBe(doc);
  });

  it('leaves other pages alone', () => {
    resetIds();
    const one = createPage({ name: '1' });
    one.objects = [createRectNode({ name: 'a' }), createRectNode({ name: 'b' })];
    const two = createPage({ name: '2' });
    two.objects = [createRectNode({ name: 'x' }), createRectNode({ name: 'y' })];
    const doc = createDocument({ pages: [one, two] });

    const first = doc.pages[0];
    if (first === undefined) throw new Error('unreachable');
    const a = first.objects[0];
    if (a === undefined) throw new Error('unreachable');
    // `b` is already frontmost on page 1, so this moves `a` instead: a restack of the
    // bottom-most object, which is a real move rather than a no-op that would leave nothing
    // to observe.
    const out = apply(doc, {
      type: 'restack',
      pageId: first.id,
      ids: [a.id],
      direction: 'front',
    });

    expect(out.pages[0]?.objects.map((node) => node.name)).toEqual(['b', 'a']);
    // The second page's array is the *same reference*, not merely equal: nothing touched it.
    expect(out.pages[1]).toBe(doc.pages[1]);
  });
});

describe('restack: identity', () => {
  it('moves the node objects themselves, never copies', () => {
    // Paint order is a property of the stack, not of the objects. A defensive `{ ...node }`
    // here would make every restack look like an edit to every node.
    const doc = stackOf(3);
    const before = doc.pages[0]?.objects ?? [];
    const out = restack(doc, 'front', 'a');
    const after = out.pages[0]?.objects ?? [];

    for (const node of before) {
      expect(after).toContain(node);
    }
    expect(objectAt(out, 2)).toBe(before[0]);
    expect(objectAt(out, 0)).toBe(before[1]);
  });

  it('preserves every property of a moved node', () => {
    resetIds();
    const page = createPage({ name: '1' });
    page.objects = [
      createRectNode({ name: 'a' }),
      createRectNode({
        name: 'b',
        transform: { x: 5, y: 6, width: 7, height: 8, rotation: 0.5, scaleX: 2, scaleY: 3 },
        opacity: 0.25,
        locked: true,
      }),
    ];
    const doc = createDocument({ pages: [page] });
    const out = restack(doc, 'front', 'b');
    const moved = out.pages[0]?.objects.find((node) => node.name === 'b');
    const original = doc.pages[0]?.objects.find((node) => node.name === 'b');
    expect(moved).toBe(original);
    expect(moved?.transform).toEqual({
      x: 5,
      y: 6,
      width: 7,
      height: 8,
      rotation: 0.5,
      scaleX: 2,
      scaleY: 3,
    });
  });
});

describe('restack: labels', () => {
  it.each([
    ['forward', 'Bring forward'],
    ['backward', 'Send backward'],
    ['front', 'Bring to front'],
    ['back', 'Send to back'],
  ] as const)('labels %s as "%s"', (direction, label) => {
    const doc = stackOf(3);
    expect(describeCommand({ type: 'restack', pageId: pageId(doc), ids: ids(doc, 'a'), direction })).toBe(
      label,
    );
  });

  it('counts several objects, as `remove` does', () => {
    const doc = stackOf(3);
    expect(
      describeCommand({ type: 'restack', pageId: pageId(doc), ids: ids(doc, 'a', 'b'), direction: 'front' }),
    ).toBe('Bring to front 2 objects');
  });
});
