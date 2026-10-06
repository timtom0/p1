/**
 * M13: the ancestor/descendant selection invariant.
 *
 * The invariant is **a selection never contains both a node and one of its descendants**. It is
 * enforced in `Editor.setSelection`, which every producer of a selection passes through; these tests
 * are about `normaliseSelection`, the function that does it, and about the commands it exists to keep
 * unambiguous.
 *
 * The specific harm it prevents is documented at `normaliseSelection`. The short version: `group`,
 * `ungroup` and `remove` all stop having determinate answers, and `remove` in particular would name a
 * node that its own ancestor's deletion already took.
 */

import { describe, expect, it } from 'vitest';
import type { Document, GroupNode } from '../../src/model/types';
import { apply } from '../../src/model/commands';
import { createDocument, createGroupNode, createShapeNode } from '../../src/model/factory';
import { resetIds } from '../../src/core/ids';
import { locateNode } from '../../src/model/tree';
import { emptySelection, normaliseSelection, selectionOf } from '../../src/editor/selection';
import type { SelectionState } from '../../src/editor/selection';

function nested(): Document {
  resetIds();
  const doc = createDocument({ name: 'N' });
  const page = doc.pages[0];
  if (page === undefined) throw new Error('unreachable');
  const inner = createGroupNode({
    id: 'inner',
    children: [createShapeNode('rect', { id: 'leaf', name: 'leaf', transform: { x: 5, y: 5, width: 20, height: 20, rotation: 0, scaleX: 1, scaleY: 1 } })],
  });
  return {
    ...doc,
    pages: [
      {
        ...page,
        objects: [
          createShapeNode('rect', { id: 'outside', name: 'outside', transform: { x: 90, y: 5, width: 20, height: 20, rotation: 0, scaleX: 1, scaleY: 1 } }),
          createGroupNode({ id: 'outer', children: [inner] }),
        ],
      },
    ],
  };
}

const sel = (...ids: string[]): SelectionState => selectionOf(ids);

/** Indexing that throws rather than returning `undefined`, so a missing element cannot pass a test. */
const at = <T>(list: readonly T[], index: number): T => {
  const value = list[index];
  if (value === undefined) throw new Error(`unreachable: index ${index}`);
  return value;
};

describe('normaliseSelection', () => {
  it('drops a descendant when its ancestor is also selected', () => {
    const out = normaliseSelection(nested(), sel('outer', 'leaf'));
    expect([...out.ids]).toEqual(['outer']);
  });

  it('keeps the ancestor, not the descendant -- the more useful of the two', () => {
    // Dropping the ancestor instead would keep a node the user cannot see or drag as a unit, and
    // every command that applies to it applies to the group too.
    const out = normaliseSelection(nested(), sel('leaf', 'outer'));
    expect([...out.ids]).toEqual(['outer']);
  });

  it('catches the pair through a non-adjacent ancestor', () => {
    const out = normaliseSelection(nested(), sel('outer', 'outside', 'inner'));
    // `inner` is a descendant of `outer`; `outside` is unrelated and must survive.
    expect([...out.ids].sort()).toEqual(['outer', 'outside']);
  });

  it('leaves an ordinary multi-selection untouched', () => {
    const doc = nested();
    const before = sel('outside', 'leaf');
    expect(normaliseSelection(doc, before)).toBe(before);
  });

  it('leaves a single selection untouched', () => {
    const doc = nested();
    expect(normaliseSelection(doc, sel('leaf'))).toEqual(sel('leaf'));
  });

  it('re-points the primary when the primary is the one dropped', () => {
    const out = normaliseSelection(nested(), { ...sel('outer', 'leaf'), primary: 'leaf' });
    expect(out.primary).toBe('outer');
  });

  it('keeps a primary that survived', () => {
    const out = normaliseSelection(nested(), { ...sel('outer', 'leaf'), primary: 'outer' });
    expect(out.primary).toBe('outer');
  });

  it('ignores ids that do not exist rather than dropping the rest', () => {
    const out = normaliseSelection(nested(), sel('outer', 'ghost'));
    expect([...out.ids].sort()).toEqual(['ghost', 'outer']);
  });

  it('handles the empty selection', () => {
    const doc = nested();
    expect(normaliseSelection(doc, emptySelection())).toEqual(emptySelection());
  });
});

describe('the invariant makes the structural commands determinate', () => {
  it('ungrouping a normalised selection cannot name both a group and its own child', () => {
    // This is the ambiguity the invariant removes: `{outer, leaf}` has no single answer for ungroup,
    // because `leaf`'s fate depends on whether the user meant the group or the child.
    const doc = nested();
    const normalised = normaliseSelection(doc, sel('outer', 'leaf'));
    expect([...normalised.ids]).toEqual(['outer']);
    const after = apply(doc, { type: 'ungroup', ids: [...normalised.ids] });
    // Deterministic: the outer group is gone, its inner group is lifted intact, and the leaf is
    // still there because the inner group was not asked to ungroup.
    expect(locateNode(after, 'outer')).toBeNull();
    expect(locateNode(after, 'inner')).not.toBeNull();
    expect(locateNode(after, 'leaf')).not.toBeNull();
  });

  it('deleting a normalised selection leaves nothing behind', () => {
    const doc = nested();
    const normalised = normaliseSelection(doc, sel('outer', 'leaf'));
    const after = apply(doc, { type: 'remove', ids: [...normalised.ids] });
    expect(locateNode(after, 'outer')).toBeNull();
    expect(locateNode(after, 'inner')).toBeNull();
    expect(locateNode(after, 'leaf')).toBeNull();
    expect(locateNode(after, 'outside')).not.toBeNull();
  });

  it('grouping a nested child together with an unrelated sibling is refused, not silently reparented', () => {
    // Different parents, so there is no single array to splice. Refusing is the only answer that does
    // not move a node across a boundary the user did not name.
    const doc = nested();
    const normalised = normaliseSelection(doc, sel('leaf', 'outside'));
    const after = apply(doc, { type: 'group', ids: [...normalised.ids] });
    expect(documentsUnchanged(doc, after)).toBe(true);
  });
});

function documentsUnchanged(a: Document, b: Document): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

describe('nested ownership is still single', () => {
  it('a node has exactly one parent even after grouping twice', () => {
    const before = nested();
    const doc = apply(before, { type: 'group', ids: ['outside', 'outer'] });
    // `outside` and `outer` were adjacent siblings, so the group took them and nothing else.
    const created = at(doc.pages[0]?.objects ?? [], 0);
    if (created.type !== 'group') throw new Error('unreachable');
    expect(created.children.map((child) => child.id)).toEqual(['outside', 'outer']);
    // `inner` is now three deep, and reachable by exactly one chain: the new group, then `outer`.
    // The new group's id is whatever `createGroupNode` minted, so it is read rather than guessed.
    const inner = locateNode(doc, 'inner');
    expect(inner?.ancestors.map((group: GroupNode) => group.id)).toEqual([created.id, 'outer']);
    expect(locateNode(doc, 'leaf')?.ancestors.map((group: GroupNode) => group.id)).toEqual([
      created.id,
      'outer',
      'inner',
    ]);
  });
});