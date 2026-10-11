/**
 * Page management commands, and what a resize does to content.
 *
 * ## Why the resize behaviour is tested so hard here
 *
 * `crop`, `scale` and `push` are three different claims about what "resize this page" means to the
 * objects on it, and two of the obvious implementations are wrong in ways that only show up under a
 * specific kind of object. So this file is deliberately not satisfied with rectangles:
 *
 *  - **Groups**, because scaling a group's box scales its whole subtree, and a resize that also walked
 *    the children would scale them twice. `grouping-probe` exists for exactly this class of mistake.
 *  - **Text frames**, because a frame whose box scaled while its type did not does not "scale" in any
 *    sense a user would recognise. That is a real limitation, so it is pinned here rather than left to
 *    be discovered at export.
 *  - **Rotated objects**, because a non-uniform ratio shears them, and ADR 0011 proved a sheared
 *    rotated child is not representable in this model at all.
 *
 * ## Coordinates are px, page sizes are millimetres
 *
 * Page sizes are authored in a physical unit and object transforms are in document px (96/inch). A4 is
 * 210x297 **mm** but 793.7x1122.5 **px**. An earlier draft of these tests placed "near the bottom"
 * rectangles at y=250 as though the page were 297 units tall, so nothing overflowed and the `push`
 * cases passed vacuously against an unchanged page. The overflow fixtures below are computed from
 * {@link pageExtentPx} instead, so they stay correct if the unit conversion ever changes.
 *
 * ## Freshness of ids
 *
 * `duplicatePage` is asserted to produce a document where **no id appears twice**, not merely that the
 * duplicate has a different page id. A copy sharing its descendants' ids would pass that weaker test
 * and produce a document in which editing the duplicate edits the original.
 */

import { describe, expect, it } from 'vitest';
import { apply, canDeletePage, isNoop } from './commands';
import type { Command } from './commands';
import {
  createDocument,
  createPage,
  createRectNode,
  createTextFrameNode,
  createGroupNode,
  createTransform,
  rich,
} from './factory';
import { pageExtentPx } from './page';
import { nodeIdsInPaintOrder } from './tree';
import { pageSizesEqual } from './page-setup';
import type { Document, Page, PageSize } from './types';

const A4: PageSize = { width: 210, height: 297, unit: 'mm', orientation: 'portrait' };
const A5: PageSize = { width: 148, height: 210, unit: 'mm', orientation: 'portrait' };

const A4_PX = pageExtentPx(A4);
const A5_PX = pageExtentPx(A5);

/**
 * The uniform factor `scale` will apply for an A4 -> A5 resize.
 *
 * Hoisted to module scope because two describes need it and a block-scoped copy was a
 * `ReferenceError` waiting for anyone who added a third.
 */
const A4_TO_A5 = Math.min(A5_PX.width / A4_PX.width, A5_PX.height / A4_PX.height);

const run = (doc: Document, ...cmds: Command[]): Document => cmds.reduce(apply, doc);

/** A page holding a rectangle, a text frame, and a group containing a rectangle. */
function richPage(id = 'page_1'): Page {
  const inner = createRectNode({
    name: 'Inner',
    transform: createTransform({ x: 20, y: 20, width: 40, height: 40 }),
  });
  return page(id, {
    name: 'Cover',
    objects: [
      createRectNode({
        name: 'Rect',
        transform: createTransform({ x: 40, y: 60, width: 200, height: 100 }),
      }),
      createTextFrameNode({
        name: 'Text',
        transform: createTransform({ x: 40, y: 200, width: 300, height: 80 }),
        style: { fontSize: 16 },
        text: rich([{ kind: 'paragraph', runs: [{ text: 'hello' }] }]),
      }),
      createGroupNode({
        name: 'Group',
        transform: createTransform({ x: 300, y: 60, width: 100, height: 100 }),
        children: [inner],
      }),
    ],
  });
}

/**
 * A page literal with a known id.
 *
 * Built by hand rather than through `createPage`, which mints its own id and deliberately does not
 * accept one -- an id that comes from the generator is what stops a hand-written id colliding with a
 * loaded document. Tests need *named* pages to address them with, and the existing suites
 * (`tree.test.ts`) already build literals for exactly this reason.
 */
function page(id: string, init: Partial<Omit<Page, 'id' | 'size'>> = {}): Page {
  return {
    id,
    name: id,
    size: A4,
    background: { type: 'solid', color: '#ffffff' },
    objects: [],
    ...init,
  };
}
function doc(...pages: Page[]): Document {
  return createDocument({ pages: pages.length > 0 ? pages : [createPage({ size: A4 })] });
}

describe('addPage', () => {
  it('appends by default', () => {
    const before = doc(createPage({ size: A4 }));
    const after = apply(before, { type: 'addPage' });
    expect(after.pages).toHaveLength(2);
    expect(after.pages[1]?.id).not.toBe(before.pages[0]?.id);
  });

  it('inserts at an index', () => {
    const after = run(doc(richPage('a'), page('b')), { type: 'addPage', index: 0 });
    expect(after.pages.map((p) => p.id)).toEqual([after.pages[0]!.id, 'a', 'b']);
  });

  it('clamps an out-of-range index rather than splicing past the end', () => {
    const after = run(doc(page('a')), { type: 'addPage', index: 99 });
    expect(after.pages).toHaveLength(2);
  });

  it('names the page for its position', () => {
    const after = run(doc(createPage({ size: A4 })), { type: 'addPage' });
    expect(after.pages[1]?.name).toBe('Page 2');
  });
});

describe('the fixed-size page setup', () => {
  // The behaviour asked for: a fixed-size document keeps giving the same size, and an
  // independently-sized one continues from the page it was added after.
  it('fixedSize: true gives the document default, not the preceding page', () => {
    // Preceding page is A5, the document default is A4, and fixed-size means the default wins.
    // Asserted explicitly because the opposite is the plausible guess.
    const d = run(
      createDocument({ pages: [createPage({ size: A5 })], fixedSize: true, pageSize: A4 }),
      { type: 'addPage' },
    );
    expect(pageSizesEqual(d.pages[1]!.size, A4)).toBe(true);
  });

  it('fixedSize: true on a default document reproduces the default size', () => {
    const d = run(createDocument({ pages: [createPage({ size: A4 })] }), { type: 'addPage' });
    expect(pageSizesEqual(d.pages[1]!.size, A4)).toBe(true);
  });

  it('fixedSize: false inherits the preceding page size', () => {
    const d = run(
      createDocument({ pages: [createPage({ size: A5 })], fixedSize: false, pageSize: A4 }),
      { type: 'addPage' },
    );
    expect(pageSizesEqual(d.pages[1]!.size, A5)).toBe(true);
  });

  it('fixedSize: false falls back to the default at index 0, where nothing precedes', () => {
    const d = run(
      createDocument({ pages: [createPage({ size: A5 })], fixedSize: false, pageSize: A4 }),
      { type: 'addPage', index: 0 },
    );
    expect(pageSizesEqual(d.pages[0]!.size, A4)).toBe(true);
  });

  it('stays uniform across several additions, because the default is what each one takes', () => {
    const d = run(
      createDocument({ pages: [createPage({ size: A4 })], fixedSize: true, pageSize: A4 }),
      { type: 'addPage' },
      { type: 'addPage' },
    );
    for (const page of d.pages) expect(pageSizesEqual(page.size, A4)).toBe(true);
  });

  it('produces a mixed document as soon as one page is resized', () => {
    // The point of the split: `fixedSize` governs the *next* page, not a claim about all of them.
    const first = createPage({ size: A4 });
    const d = run(
      createDocument({ pages: [first], fixedSize: true }),
      { type: 'setPageSize', pageId: first.id, size: A5 },
    );
    expect(pageSizesEqual(d.pages[0]!.size, A5)).toBe(true);
    expect(d.pageSetup.fixedSize).toBe(true);
  });
});

describe('duplicatePage', () => {
  it('inserts the copy directly after the original', () => {
    const after = apply(doc(richPage('a'), page('b')), {
      type: 'duplicatePage',
      pageId: 'a',
    });
    expect(after.pages.map((p) => p.id)).toEqual(['a', after.pages[1]!.id, 'b']);
  });

  it('preserves the page dimensions', () => {
    const after = apply(doc(richPage('a')), { type: 'duplicatePage', pageId: 'a' });
    expect(pageSizesEqual(after.pages[1]!.size, A4)).toBe(true);
  });

  it('gives every node a fresh id, at every depth', () => {
    const after = apply(doc(richPage('a')), { type: 'duplicatePage', pageId: 'a' });
    const ids = nodeIdsInPaintOrder(after);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives the page itself a fresh id', () => {
    const after = apply(doc(richPage('a')), { type: 'duplicatePage', pageId: 'a' });
    expect(after.pages[1]?.id).not.toBe('a');
  });

  it('preserves the structure, including nested groups', () => {
    const after = apply(doc(richPage('a')), { type: 'duplicatePage', pageId: 'a' });
    const copy = after.pages[1]!;
    expect(copy.objects).toHaveLength(3);
    const group = copy.objects[2]!;
    expect(group.type).toBe('group');
    if (group.type === 'group') expect(group.children).toHaveLength(1);
  });

  it('keeps the duplicate independent of the original', () => {
    // The failure this guards: if ids were shared, this edit would hit both copies.
    const after = run(doc(richPage('a')), { type: 'duplicatePage', pageId: 'a' });
    const copyId = after.pages[1]!.objects[0]!.id;
    const edited = apply(after, { type: 'setTransform', ids: [copyId], patch: { x: 999 } });
    expect(edited.pages[1]!.objects[0]!.transform.x).toBe(999);
    expect(edited.pages[0]!.objects[0]!.transform.x).toBe(40);
  });

  it('is a no-op for an unknown page', () => {
    const before = doc(richPage('a'));
    expect(apply(before, { type: 'duplicatePage', pageId: 'nope' })).toBe(before);
  });
});

describe('deletePage', () => {
  it('removes the page', () => {
    const after = apply(doc(page('a'), page('b')), {
      type: 'deletePage',
      pageId: 'a',
    });
    expect(after.pages.map((p) => p.id)).toEqual(['b']);
  });

  it('refuses to remove the last page', () => {
    const before = doc(page('a'));
    expect(apply(before, { type: 'deletePage', pageId: 'a' })).toBe(before);
    expect(isNoop(before, { type: 'deletePage', pageId: 'a' })).toBe(true);
  });

  it('reports the minimum through canDeletePage', () => {
    expect(canDeletePage(doc(page('a')))).toBe(false);
    expect(canDeletePage(doc(page('a'), page('b')))).toBe(true);
  });
});

describe('movePage', () => {
  const three = () =>
    doc(page('a'), page('b'), page('c'));

  it('reorders', () => {
    const after = apply(three(), { type: 'movePage', pageId: 'a', toIndex: 2 });
    expect(after.pages.map((p) => p.id)).toEqual(['b', 'c', 'a']);
  });

  it('is a no-op when the page is already there', () => {
    const before = three();
    expect(apply(before, { type: 'movePage', pageId: 'b', toIndex: 1 })).toBe(before);
  });
});

describe('renamePage, through setPageProps', () => {
  it('renames without touching the size', () => {
    const after = apply(doc(page('a')), {
      type: 'setPageProps',
      pageId: 'a',
      props: { name: 'Cover' },
    });
    expect(after.pages[0]?.name).toBe('Cover');
    expect(pageSizesEqual(after.pages[0]!.size, A4)).toBe(true);
  });

  it('cannot be used to resize, which would skip the resize policy', () => {
    // `PagePropsPatch` omits `size` at the type level. The runtime assertion below is the belt: a
    // caller who casts their way past the type must not be able to resize without a policy either.
    const after = apply(doc(page('a', {
        objects: [createRectNode()] })), {
      type: 'setPageProps',
      pageId: 'a',
      props: { size: A5 } as never,
    });
    expect(pageSizesEqual(after.pages[0]!.size, A4)).toBe(true);
  });
});

describe('setPageSize -- crop', () => {
  it('changes only the size', () => {
    const before = doc(richPage('a'));
    const after = apply(before, { type: 'setPageSize', pageId: 'a', size: A5, behaviour: 'crop' });
    expect(after.pages[0]?.objects).toBe(before.pages[0]?.objects);
    expect(pageSizesEqual(after.pages[0]!.size, A5)).toBe(true);
  });

  it('is the document default, so no behaviour need be passed', () => {
    const after = run(createDocument({ pages: [richPage('a')], resizeBehaviour: 'crop' }), {
      type: 'setPageSize',
      pageId: 'a',
      size: A5,
    });
    expect(after.pages[0]!.objects[0]!.transform.x).toBe(40);
  });
});

describe('setPageSize -- scale', () => {
  const scaleTo = (d: Document, size: PageSize) => apply(d, { type: 'setPageSize', pageId: 'a', size, behaviour: 'scale' });
  const ratio = A4_TO_A5;

  it('scales positions and boxes by the uniform ratio', () => {
    const rect = scaleTo(doc(richPage('a')), A5).pages[0]!.objects[0]!;
    expect(rect.transform.x).toBeCloseTo(40 * A4_TO_A5, 6);
    expect(rect.transform.width).toBeCloseTo(200 * ratio, 6);
  });

  it('uses the smaller of the two axis ratios', () => {
    // A4 -> A5: width shrinks by 0.7048 and height by 0.7071, so the width ratio is the binding one.
    expect(ratio).toBeCloseTo(Math.min(A5_PX.width / A4_PX.width, A5_PX.height / A4_PX.height), 6);
  });

  it('leaves rotation and the scale factors alone', () => {
    // Scaling the scale factors as well would be scaling twice; see `scaleTransform`.
    const rotated = page('a', {
        objects: [
        createRectNode({
          transform: createTransform({ x: 10, y: 10, width: 50, height: 50, rotation: 0.7, scaleX: 2 }),
        }),
      ],
    });
    const after = scaleTo(doc(rotated), A5);
    expect(after.pages[0]!.objects[0]!.transform.rotation).toBe(0.7);
    expect(after.pages[0]!.objects[0]!.transform.scaleX).toBe(2);
  });

  it('scales a group exactly once, not once per level', () => {
    // A child's world transform is W(group)·W(child), so scaling the group scales the subtree. Walking
    // into the group as well would double the child's displacement.
    const group = scaleTo(doc(richPage('a')), A5).pages[0]!.objects[2]!;
    expect(group.transform.x).toBeCloseTo(300 * ratio, 6);
    if (group.type === 'group') {
      // Untouched: its position is expressed in group-local space, which the group transform scales.
      expect(group.children[0]!.transform.x).toBe(20);
    }
  });

  it('does not shear when the aspect ratio changes', () => {
    // Portrait to landscape: the two axis ratios differ and only one may be applied.
    const after = scaleTo(doc(richPage('a')), { ...A4, orientation: 'landscape' });
    const rect = after.pages[0]!.objects[0]!;
    expect(rect.transform.scaleX).toBe(1);
    expect(rect.transform.scaleY).toBe(1);
  });

  it('does not scale typography, and says so here', () => {
    // The known limitation. `fontSize` is an authored value (ADR 0003); scaling it would silently
    // rewrite something the user typed, and a frame whose box grew while its type did not re-wraps
    // rather than scales. Pinned so a future change has to decide about it deliberately.
    const frame = scaleTo(doc(richPage('a')), A5).pages[0]!.objects[1]!;
    expect(frame.type).toBe('textFrame');
    if (frame.type === 'textFrame') {
      expect(frame.style?.fontSize).toBe(16);
      // The frame itself *does* scale -- which is exactly what makes this a limitation worth stating
      // rather than a no-op.
      expect(frame.transform.width).toBeCloseTo(300 * ratio, 6);
    }
  });
});

describe('setPageSize -- push', () => {
  // Coordinates derived from the real px extent. A4 is 1122.5px tall and A5 is 793.7px, so a
  // rectangle at y=1000 with height 50 fits A4 and cannot fit A5.
  const bottomY = A4_PX.height - 120;
  expect(bottomY + 50).toBeGreaterThan(A5_PX.height);

  const withOverflow = () =>
    doc(
      page('a', {
        objects: [
          createRectNode({ transform: createTransform({ x: 10, y: 10, width: 50, height: 50 }) }),
          createRectNode({ transform: createTransform({ x: 10, y: bottomY, width: 50, height: 30 }) }),
        ],
      }),
      page('b'),
    );

  it('moves what no longer fits to the next page', () => {
    const after = apply(withOverflow(), { type: 'setPageSize', pageId: 'a', size: A5, behaviour: 'push' });
    expect(after.pages[0]!.objects).toHaveLength(1);
    expect(after.pages[1]!.objects).toHaveLength(1);
  });

  it('leaves what still fits where it was', () => {
    const after = apply(withOverflow(), { type: 'setPageSize', pageId: 'a', size: A5, behaviour: 'push' });
    expect(after.pages[0]!.objects[0]!.transform.y).toBe(10);
  });

  it('keeps the moved objects at the same page-local coordinates', () => {
    const after = apply(withOverflow(), { type: 'setPageSize', pageId: 'a', size: A5, behaviour: 'push' });
    expect(after.pages[1]!.objects[0]!.transform.y).toBe(bottomY);
  });

  it('creates a following page when the resized page was the last', () => {
    const single = doc(
      page('a', {
        objects: [createRectNode({ transform: createTransform({ x: 10, y: bottomY, width: 50, height: 30 }) })],
      }),
    );
    const after = apply(single, { type: 'setPageSize', pageId: 'a', size: A5, behaviour: 'push' });
    expect(after.pages).toHaveLength(2);
    expect(pageSizesEqual(after.pages[1]!.size, A5)).toBe(true);
  });

  it('moves nothing when everything still fits', () => {
    const fits = doc(
      page('a', {
        objects: [createRectNode({ transform: createTransform({ x: 10, y: 10, width: 50, height: 50 }) })],
      }),
    );
    const after = apply(fits, { type: 'setPageSize', pageId: 'a', size: A5, behaviour: 'push' });
    expect(after.pages).toHaveLength(1);
    expect(after.pages[0]!.objects).toHaveLength(1);
  });

  it('does not cascade: a page whose content is pushed on to is not itself re-pushed', () => {
    // One hop, deliberately. Cascading would make one resize edit an unbounded number of pages.
    const threePages = doc(
      page('a'),
      page('', {
        objects: [createRectNode({ transform: createTransform({ x: 10, y: bottomY, width: 50, height: 30 }) })],
      }),
      page('a'),
    );
    const after = apply(threePages, { type: 'setPageSize', pageId: 'a', size: A5, behaviour: 'push' });
    expect(after.pages).toHaveLength(3);
  });

  it('judges a group by where it paints, and moves its children with it', () => {
    const d = doc(
      page('a', {
        objects: [
          createGroupNode({
            transform: createTransform({ x: 10, y: bottomY, width: 100, height: 80 }),
            children: [createRectNode({ transform: createTransform({ x: 0, y: 0, width: 40, height: 40 }) })],
          }),
        ],
      }),
      page('a'),
    );
    const after = apply(d, { type: 'setPageSize', pageId: 'a', size: A5, behaviour: 'push' });
    expect(after.pages[0]!.objects).toHaveLength(0);
    expect(after.pages[1]!.objects).toHaveLength(1);
    expect(after.pages[1]!.objects[0]!.type).toBe('group');
  });
});

describe('setPageSize -- refusals and no-ops', () => {
  it('is a no-op when the size is unchanged', () => {
    const before = doc(page('a'));
    expect(apply(before, { type: 'setPageSize', pageId: 'a', size: A4 })).toBe(before);
  });

  it('refuses a size outside the printable range', () => {
    const before = doc(page('a'));
    const bad: PageSize = { width: 0.01, height: 297, unit: 'mm', orientation: 'portrait' };
    expect(apply(before, { type: 'setPageSize', pageId: 'a', size: bad })).toBe(before);
  });

  it('does not treat a rotated size as the same size', () => {
    const before = doc(page('a'));
    const rotated: PageSize = { ...A4, orientation: 'landscape' };
    expect(apply(before, { type: 'setPageSize', pageId: 'a', size: rotated })).not.toBe(before);
  });
});

describe('setPageSetup', () => {
  it('changes the default size', () => {
    expect(pageSizesEqual(apply(doc(), { type: 'setPageSetup', setup: { defaultSize: A5 } }).pageSetup.defaultSize, A5)).toBe(
      true,
    );
  });

  it('toggles fixedSize', () => {
    expect(apply(doc(), { type: 'setPageSetup', setup: { fixedSize: false } }).pageSetup.fixedSize).toBe(false);
  });

  it('changes the resize policy', () => {
    expect(apply(doc(), { type: 'setPageSetup', setup: { resizeBehaviour: 'push' } }).pageSetup.resizeBehaviour).toBe(
      'push',
    );
  });

  it('is a no-op when nothing changes', () => {
    const before = doc();
    expect(apply(before, { type: 'setPageSetup', setup: { fixedSize: true } })).toBe(before);
  });
});

describe('immutability', () => {
  it('never mutates the document it was given', () => {
    const before = doc(richPage('a'), page('b'));
    const snapshot = JSON.stringify(before);
    run(
      before,
      { type: 'addPage' },
      { type: 'duplicatePage', pageId: 'a' },
      { type: 'movePage', pageId: 'b', toIndex: 0 },
      { type: 'setPageSize', pageId: 'a', size: A5, behaviour: 'scale' },
      { type: 'setPageSetup', setup: { fixedSize: false } },
      { type: 'deletePage', pageId: 'b' },
    );
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('leaves earlier results untouched, because each apply copies', () => {
    const start = doc(richPage('a'));
    const added = apply(start, { type: 'addPage' });
    expect(added.pages).toHaveLength(2);
    const resized = apply(added, { type: 'setPageSize', pageId: 'a', size: A5, behaviour: 'scale' });
    // `added` still has the original, unscaled rectangle; `resized` has the scaled one.
    expect(added.pages[0]!.objects[0]!.transform.x).toBe(40);
    expect(resized.pages[0]!.objects[0]!.transform.x).toBeCloseTo(40 * A4_TO_A5, 6);
  });
});
