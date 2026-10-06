/**
 * Hit testing and selection state.
 *
 * The load-bearing claim being tested is that hit testing answers from the **model**
 * and never from `document.elementFromPoint`. The tests below prove that by
 * constructing cases where the two would disagree: a locked object under a
 * transparent-looking one, an invisible object sitting on top, and overlapping
 * objects where paint order must decide.
 */

import { describe, expect, it } from 'vitest';
import type { Document, Page } from '../model/types';
import { createDocument, createRectNode, createTransform } from '../model/factory';

/** `createPage` generates its own id, and these tests address pages by name. */
const page = (id: string, objects: Page['objects']): Page => ({
  id,
  name: id,
  background: { type: 'solid', color: '#ffffff' },
  objects,
});
import {
  commonFrame,
  emptySelection,
  findNode,
  hitTestPage,
  pageIdOfNode,
  pageNodeIds,
  selectedNodes,
  selectionOf,
} from './selection';

function makeDoc(): Document {
  return createDocument({
    pages: [
      page('p1', [
        // Paint order: index 0 is furthest back.
        createRectNode({ id: 'back', transform: createTransform({ x: 0, y: 0, width: 200, height: 200 }) }),
        createRectNode({
          id: 'front',
          transform: createTransform({ x: 100, y: 100, width: 200, height: 200 }),
        }),
        createRectNode({
          id: 'hidden',
          transform: createTransform({ x: 20, y: 20, width: 40, height: 40 }),
          visible: false,
        }),
        createRectNode({
          id: 'shut',
          transform: createTransform({ x: 240, y: 20, width: 40, height: 40 }),
          locked: true,
        }),
        createRectNode({
          id: 'turned',
          transform: createTransform({ x: 400, y: 400, width: 100, height: 100, rotation: Math.PI / 4 }),
        }),
      ]),
      page('p2', [createRectNode({ id: 'other-page' })]),
    ],
  });
}

const doc = makeDoc;

describe('hitTestPage', () => {
  it('returns the topmost object, not the first', () => {
    // (150, 150) is inside both `back` and `front`; `front` paints on top.
    expect(hitTestPage(doc(), 'p1', { x: 150, y: 150 })?.nodeId).toBe('front');
    expect(hitTestPage(doc(), 'p1', { x: 10, y: 10 })?.nodeId).toBe('back');
  });

  it('ignores invisible objects', () => {
    // `hidden` sits on top of `back` in paint order but must not be selectable.
    expect(hitTestPage(doc(), 'p1', { x: 30, y: 30 })?.nodeId).toBe('back');
  });

  it('ignores locked objects by default, and finds them on request', () => {
    expect(hitTestPage(doc(), 'p1', { x: 250, y: 30 })).toBeNull();
    expect(hitTestPage(doc(), 'p1', { x: 250, y: 30 }, { includeLocked: true })?.nodeId).toBe('shut');
  });

  it('treats the boundary as inside, so edge clicks are not dead zones', () => {
    expect(hitTestPage(doc(), 'p1', { x: 0, y: 0 })?.nodeId).toBe('back');
    expect(hitTestPage(doc(), 'p1', { x: 199.999, y: 199.999 })).not.toBeNull();
    // Just outside both overlapping boxes.
    expect(hitTestPage(doc(), 'p1', { x: 350, y: 250 })).toBeNull();
  });

  it('misses empty space', () => {
    expect(hitTestPage(doc(), 'p1', { x: 350, y: 350 })).toBeNull();
  });

  it('returns null for an unknown page', () => {
    expect(hitTestPage(doc(), 'nope', { x: 0, y: 0 })).toBeNull();
  });

  it('hits a rotated object by its true shape, not its bounding box', () => {
    const turned = hitTestPage(doc(), 'p1', { x: 450, y: 450 });
    expect(turned?.nodeId).toBe('turned');

    // The axis-aligned bounding box of a 45°-rotated square would include this
    // point; the object's own box, mapped back through the inverse matrix, does not.
    expect(hitTestPage(doc(), 'p1', { x: 403, y: 403 })).toBeNull();
  });

  it('only searches the page it was given', () => {
    expect(hitTestPage(doc(), 'p2', { x: 150, y: 150 })).toBeNull();
  });
});

describe('lookup helpers', () => {
  it('finds a node anywhere in the document', () => {
    expect(findNode(doc(), 'other-page')?.id).toBe('other-page');
    expect(findNode(doc(), 'missing')).toBeNull();
  });

  it('reports which page holds a node', () => {
    expect(pageIdOfNode(doc(), 'other-page')).toBe('p2');
    expect(pageIdOfNode(doc(), 'back')).toBe('p1');
    expect(pageIdOfNode(doc(), 'missing')).toBeNull();
  });

  it('lists a page in paint order', () => {
    expect(pageNodeIds(doc(), 'p1')).toEqual(['back', 'front', 'hidden', 'shut', 'turned']);
    expect(pageNodeIds(doc(), 'missing')).toEqual([]);
  });
});

describe('selection state', () => {
  it('starts empty', () => {
    const state = emptySelection();
    expect(state.ids.size).toBe(0);
    expect(state.primary).toBeNull();
    expect(state.hover).toBeNull();
  });

  it('has exactly three fields, and none of them is an ordering', () => {
    // M9 removed `anchor`, which was written as `null`, read by nothing, and documented as the
    // anchor for a shift-extend and an alt-cycle that do not exist. Asserting the *shape* rather
    // than the absence of one field is what stops the next one being added by the same route:
    // a field with a comment describing unimplemented behaviour is how a reader comes to rely
    // on it.
    expect(Object.keys(emptySelection()).sort()).toEqual(['hover', 'ids', 'primary']);
    expect(Object.keys(selectionOf(['a', 'b'])).sort()).toEqual(['hover', 'ids', 'primary']);
  });

  it('defaults the primary to the first id', () => {
    expect(selectionOf(['a', 'b']).primary).toBe('a');
    expect(selectionOf(['a', 'b'], 'b').primary).toBe('b');
  });

  it('collects selected nodes in document order, not click order', () => {
    const selected = selectedNodes(doc(), selectionOf(['front', 'back']));
    expect(selected.map((node) => node.id)).toEqual(['back', 'front']);
  });

  it('ignores ids that no longer exist', () => {
    const selected = selectedNodes(doc(), selectionOf(['back', 'deleted']));
    expect(selected.map((node) => node.id)).toEqual(['back']);
  });
});

describe('commonFrame', () => {
  it('is null with nothing selected', () => {
    expect(commonFrame(doc(), emptySelection())).toBeNull();
  });

  it('reports shared values once', () => {
    const frame = commonFrame(doc(), selectionOf(['back', 'front']));
    // Both boxes are 200×200 and neither is rotated.
    expect(frame?.['width']).toBe(200);
    expect(frame?.['height']).toBe(200);
    expect(frame?.['rotation']).toBe(0);
  });

  it('reports differing values as null, so the inspector shows "Mixed"', () => {
    const frame = commonFrame(doc(), selectionOf(['back', 'front']));
    // `back` starts at (0,0); `front` starts at (100,100).
    expect(frame?.['x']).toBeNull();
    expect(frame?.['y']).toBeNull();
  });

  it('reports rotation, which is rarely shared', () => {
    expect(commonFrame(doc(), selectionOf(['turned']))?.['rotation']).toBeCloseTo(Math.PI / 4);
  });
});
