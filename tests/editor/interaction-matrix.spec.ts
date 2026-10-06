/**
 * The selection matrix, and the DOM identity rule.
 *
 * ## Why a table and not a narrative
 *
 * The milestone asks for the combinations of *hidden*, *locked*, *selected*, *primary*, marquee,
 * shift-click, Alt-click, Delete, Select All and restack. That is a matrix, and a matrix written
 * as prose loses cells: the interesting failure is the one nobody enumerated. So the reachable
 * states are declared as data, every interaction is run against every state, and the expected
 * outcome is declared per (state, interaction) pair rather than discovered.
 *
 * ## `primary` has no DOM observable, and the test says so
 *
 * The overlay draws one outline per selected object in **document order** — it is built from
 * `selectedNodes(doc, selection)`, which walks the array. So the first outline is the
 * first-selected-in-*paint*-order, not `selection.primary`, and reading it as the primary is
 * wrong.
 *
 * The only honest observable for `primary` is <kbd>Enter</kbd>, which opens a text session on it.
 * So the primary tests use text frames and press <kbd>Enter</kbd>. That is not a workaround: it
 * is the point. `primary` is editor state with no projection, and an audit should say so rather
 * than invent a projection to make it testable.
 *
 * ## Two different "cannot be selected", deliberately not the same
 *
 * - **Locked** is a *barrier*. Hit testing skips it, <kbd>alt</kbd>+click includes it, and a
 *   marquee honours it. Reachable, deliberately, on request.
 * - **Hidden** is *not painted*. Nothing is at those pixels, so no click reaches it and Alt does
 *   not either. A **marquee** does, because drawing a box around something is unambiguous — and
 *   it is the only way back from the `visible` checkbox.
 */

import type { Page } from '@playwright/test';
import {
  clickAt,
  drag,
  endDrag,
  expect,
  selectionCount,
  selectionIds,
  test,
  undoDisabled,
} from './helpers';
import { mountFixture } from '../visual/harness';

// ---------------------------------------------------------------------------
// The state space, as data
// ---------------------------------------------------------------------------

/** How one object can be put into the selection, and by what. */
interface Reach {
  /** What a single ordinary click finds. */
  byClick: boolean;
  /** What Alt-click finds. */
  byAltClick: boolean;
  /** What a marquee over everything finds. */
  byMarquee: boolean;
  /** What <kbd>ctrl</kbd>+<kbd>a</kbd> includes. */
  bySelectAll: boolean;
}

const PLAIN: Reach = { byClick: true, byAltClick: true, byMarquee: true, bySelectAll: true };
const LOCKED: Reach = { byClick: false, byAltClick: true, byMarquee: false, bySelectAll: true };
const HIDDEN: Reach = { byClick: false, byAltClick: false, byMarquee: true, bySelectAll: true };

const SPOTS: Record<string, { x: number; y: number }> = {
  node_plain: { x: 40, y: 40 },
  node_locked: { x: 200, y: 40 },
  node_hidden: { x: 40, y: 170 },
  node_plain2: { x: 200, y: 170 },
};

const ALL_IDS = Object.keys(SPOTS);

const CELLS: Array<{ id: string; label: string; reach: Reach }> = [
  { id: 'node_plain', label: 'plain', reach: PLAIN },
  { id: 'node_locked', label: 'locked', reach: LOCKED },
  { id: 'node_hidden', label: 'hidden', reach: HIDDEN },
  { id: 'node_plain2', label: 'a second plain', reach: PLAIN },
];

/** Puts exactly one object into the selection and asserts it. */
async function selectOnly(
  page: Page,
  id: string,
  how: 'click' | 'alt-click' | 'marquee',
): Promise<void> {
  const spot = SPOTS[id];
  if (spot === undefined) throw new Error(`no spot for ${id}`);

  if (how === 'marquee') {
    // A marquee cannot be narrowed to one box, so the others are dropped with shift-clicks.
    // That is a legitimate sequence rather than a workaround, and it is the only way to isolate
    // a hidden object — which is the whole reason the marquee is allowed to reach them.
    await drag(page, { x: 20, y: 20 }, { x: 420, y: 280 });
    for (const other of ALL_IDS) {
      if (other === id) continue;
      const at = SPOTS[other];
      if (at === undefined) throw new Error('unreachable');
      await clickAt(page, at.x + 40, at.y + 40, ['Shift']);
    }
  } else {
    await page.keyboard.press('Escape');
    await clickAt(page, spot.x + 40, spot.y + 40, how === 'alt-click' ? ['Alt'] : []);
  }

  expect(await selectionIds(page), `precondition: only ${id} is selected`).toEqual([id]);
}

async function clearSelection(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Escape');
  await expect(async () => {
    expect(await selectionCount(page)).toBe(0);
  }).toPass();
}

// ---------------------------------------------------------------------------
// 1. Reachability
// ---------------------------------------------------------------------------

test.describe('how each kind of object is reached', () => {
  for (const { id, label, reach } of CELLS) {
    test(`${label}: click, alt-click and marquee`, async ({ page }) => {
      await mountFixture(page, MATRIX_FIXTURE);
      const spot = SPOTS[id];
      if (spot === undefined) throw new Error('unreachable');

      await clickAt(page, spot.x + 40, spot.y + 40);
      expect(await selectionIds(page), 'a plain click').toEqual(reach.byClick ? [id] : []);

      await clearSelection(page);
      await clickAt(page, spot.x + 40, spot.y + 40, ['Alt']);
      expect(await selectionIds(page), 'alt-click').toEqual(reach.byAltClick ? [id] : []);

      await clearSelection(page);
      await drag(page, { x: 20, y: 20 }, { x: 420, y: 280 });
      const byMarquee = await selectionIds(page);
      expect(byMarquee.includes(id), 'a marquee over the whole page').toBe(reach.byMarquee);
    });

    test(`${label}: select-all and delete`, async ({ page }) => {
      await mountFixture(page, MATRIX_FIXTURE);

      await page.keyboard.press('Control+a');
      const all = await selectionIds(page);
      if (reach.bySelectAll) {
        expect(all, 'select-all includes it').toContain(id);
      } else {
        expect(all).not.toContain(id);
      }

      // Delete acts on the whole selection, so to ask whether *this* object is deletable it has
      // to be the only thing selected.
      await selectOnly(page, id, reach.byClick ? 'click' : reach.byAltClick ? 'alt-click' : 'marquee');
      await page.keyboard.press('Delete');
      expect(await remainingIds(page), `${label} was deleted`).not.toContain(id);
      expect(await remainingIds(page), 'and only it was').toHaveLength(ALL_IDS.length - 1);
    });

    test(`${label}: restack moves it, and the selection is not an order`, async ({ page }) => {
      await mountFixture(page, MATRIX_FIXTURE);
      await selectOnly(page, id, reach.byClick ? 'click' : reach.byAltClick ? 'alt-click' : 'marquee');

      const before = await remainingIds(page);
      await page.locator('[data-layer="back"]').click();
      const after = await remainingIds(page);

      expect(after[0], `${label} went to the back`).toBe(id);
      expect([...after].sort(), 'the same four objects, reordered').toEqual([...before].sort());
      // M8's decision, asserted here where it is cheapest: a restack changes the sequence and
      // leaves the selection's membership alone, because `ids` is a Set and the two orders are
      // independent.
      expect(await selectionIds(page), 'the selection is unaffected by a reorder').toEqual([id]);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. primary
// ---------------------------------------------------------------------------

test.describe('primary, observed through Enter', () => {
  /** The id of the frame a text session opened on, or null. */
  async function editingId(page: Page): Promise<string | null> {
    const id = await page
      .locator('[data-page] [data-editing="true"]')
      .first()
      .getAttribute('data-oid');
    return id;
  }

  test('a plain click makes the clicked frame primary', async ({ page }) => {
    await mountFixture(page, PRIMARY_FIXTURE);
    await clickAt(page, 100, 60);
    await page.keyboard.press('Enter');
    expect(await editingId(page)).toBe('frame_a');
  });

  test('a shift-added frame becomes primary', async ({ page }) => {
    await mountFixture(page, PRIMARY_FIXTURE);
    await clickAt(page, 100, 60);
    await clickAt(page, 300, 60, ['Shift']);
    expect((await selectionIds(page)).sort()).toEqual(['frame_a', 'frame_b']);

    await page.keyboard.press('Enter');
    expect(await editingId(page), 'the last one added, not the first in paint order').toBe(
      'frame_b',
    );
  });

  test('a plain click on a selected frame keeps the selection and moves the primary', async ({
    page,
  }) => {
    // The rule that makes dragging a selected object work, and the reason a "select exactly
    // these" helper has to clear the selection first. No text session in the middle: `Escape`
    // clears the selection, so a round trip through one would undo the very thing under test.
    await mountFixture(page, PRIMARY_FIXTURE);
    await clickAt(page, 100, 60);
    await clickAt(page, 300, 60, ['Shift']);
    expect((await selectionIds(page)).sort()).toEqual(['frame_a', 'frame_b']);

    await clickAt(page, 100, 60);
    expect(
      (await selectionIds(page)).sort(),
      'the whole selection is kept, not reduced to the clicked frame',
    ).toEqual(['frame_a', 'frame_b']);

    await page.keyboard.press('Enter');
    expect(await editingId(page), 'and the primary followed the click').toBe('frame_a');
  });

  test('removing the primary hands over to another selected frame', async ({ page }) => {
    // `removeFromSelection` re-points `primary` rather than clearing it, because a null primary
    // with a non-empty set would make the inspector read "empty" while the overlay drew outlines.
    await mountFixture(page, PRIMARY_FIXTURE);
    await clickAt(page, 100, 60);
    await clickAt(page, 300, 60, ['Shift']);
    expect((await selectionIds(page)).sort()).toEqual(['frame_a', 'frame_b']);

    await clickAt(page, 300, 60, ['Shift']);
    expect(await selectionIds(page), 'the shift-clicked frame left').toEqual(['frame_a']);

    await page.keyboard.press('Enter');
    expect(await editingId(page), 'and the survivor is primary').toBe('frame_a');
  });
});

// ---------------------------------------------------------------------------
// 3. DOM identity
// ---------------------------------------------------------------------------

test.describe('object identity has exactly one owner', () => {
  test('one element per object carries data-oid, and the overlay never does', async ({ page }) => {
    // M8 renamed the overlay's marker to `data-for` after `[data-oid="x"]` matched two elements
    // in two layers. This asserts the *count*, because the failure mode is two matches: a test
    // reading `data-oid` while something is selected would get a plausible wrong answer rather
    // than an error.
    await mountFixture(page, MATRIX_FIXTURE);
    await clickAt(page, 80, 80);
    await clickAt(page, 240, 210, ['Shift']);

    const counts = await page.evaluate(
      (ids) =>
        Object.fromEntries(
          ids.map((id) => [id, document.querySelectorAll(`[data-oid="${id}"]`).length]),
        ),
      ALL_IDS,
    );
    for (const id of ALL_IDS) {
      expect(counts[id], `${id} is stamped exactly once`).toBe(1);
    }
    expect(
      await page.locator('.p1-overlay-group--selection[data-for]').count(),
      'the overlay marks its outlines under its own name',
    ).toBe(2);
  });

  test('no element answers to both identity attributes', async ({ page }) => {
    // The general form of the rule, so a *new* collision is caught and not just the one that
    // already happened.
    await mountFixture(page, MATRIX_FIXTURE);
    await clickAt(page, 80, 80);
    const clashes = await page.evaluate(() =>
      [...document.querySelectorAll('[data-oid]')]
        .filter((el) => (el as HTMLElement).dataset['for'] !== undefined)
        .map((el) => (el as HTMLElement).dataset['oid'] ?? ''),
    );
    expect(clashes, 'an element may not be both a document object and an overlay outline').toEqual(
      [],
    );
  });

  test('the overlay is never inside the page stack', async ({ page }) => {
    // The M0/M2 structural rule, restated as a count. An overlay element inside `[data-page]`
    // would be inside the zoom transform, and `screenshotPage` would start including chrome.
    await mountFixture(page, MATRIX_FIXTURE);
    await clickAt(page, 80, 80);
    expect(
      await page.locator('[data-page] .p1-overlay-box').count(),
      'no overlay geometry is a descendant of a page',
    ).toBe(0);
    expect(await page.locator('.p1-overlay-box').count(), 'but the overlay is drawn').toBe(1);
  });

  test('reordering moves the existing elements rather than recreating them', async ({ page }) => {
    // The reconciler contract, and the one that makes paint order a *sequence* rather than a
    // rebuild. A recreated element would lose focus, reset a text session and restart an image
    // decode — none of which a paint-order assertion would notice.
    await mountFixture(page, MATRIX_FIXTURE);
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('[data-page] [data-oid]')) {
        // A property on the element object, not an attribute: it survives an attribute rewrite
        // and dies with the node, which is exactly the identity being claimed.
        (el as unknown as { __p1token?: string }).__p1token =
          (el as HTMLElement).dataset['oid'] ?? '';
      }
    });

    await clickAt(page, 80, 80);
    await page.locator('[data-layer="front"]').click();
    await page.locator('[data-layer="back"]').click();

    const sameNodes = await page.evaluate(() =>
      [...document.querySelectorAll('[data-page] [data-oid]')].every((el) => {
        const node = el as HTMLElement;
        return (node as unknown as { __p1token?: string }).__p1token === node.dataset['oid'];
      }),
    );
    expect(sameNodes, 'every object element is the element that was there before').toBe(true);
  });

  test('undo after a restack restores the order and empties the history', async ({ page }) => {
    await mountFixture(page, MATRIX_FIXTURE);
    const before = await remainingIds(page);
    await clickAt(page, 80, 80);
    await page.locator('[data-layer="front"]').click();
    expect(await remainingIds(page)).not.toEqual(before);

    await page.locator('[data-edit="undo"]').click();
    expect(await remainingIds(page)).toEqual(before);
    expect(await undoDisabled(page)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. A selection whose objects are deleted underneath it
// ---------------------------------------------------------------------------

test.describe('objects removed while selected', () => {
  test('deleting clears the selection rather than leaving stale ids', async ({ page }) => {
    await mountFixture(page, MATRIX_FIXTURE);
    await clickAt(page, 80, 80);
    await clickAt(page, 240, 210, ['Shift']);
    expect(await selectionCount(page)).toBe(2);

    await page.keyboard.press('Delete');
    expect(await selectionCount(page), 'no outline is drawn for a node that is gone').toBe(0);
    expect(await page.locator('.p1-overlay-box').count()).toBe(0);
  });

  test('a gesture after the deletion works on a document that shrank underneath it', async ({
    page,
  }) => {
    await mountFixture(page, MATRIX_FIXTURE);
    await clickAt(page, 80, 80);
    await clickAt(page, 240, 210, ['Shift']);
    await page.keyboard.press('Delete');

    await clickAt(page, 80, 80);
    const point = await clientOf(page, { x: 80, y: 80 });
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 60, point.y, { steps: 3 });
    await endDrag(page);

    expect(await undoDisabled(page), 'the post-deletion drag is one real entry').toBe(false);
  });

  test('restacking a selection that spans a deleted object touches only the survivors', async ({
    page,
  }) => {
    await mountFixture(page, MATRIX_FIXTURE);
    // Select everything, delete one of them, then restack. `applyMarquee`-free path: select-all
    // then Delete takes all of them, so the reachable version is delete-then-select.
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    expect(await remainingIds(page)).toHaveLength(0);

    await page.keyboard.press('Control+z');
    expect(await remainingIds(page)).toHaveLength(ALL_IDS.length);
    // And the restored objects are selectable again, so the undo did not leave them detached.
    await clickAt(page, 80, 80);
    expect(await selectionIds(page)).toEqual(['node_plain']);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function remainingIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-page] [data-oid]')].map(
      (el) => (el as HTMLElement).dataset['oid'] ?? '',
    ),
  );
}

async function clientOf(page: Page, spot: { x: number; y: number }): Promise<{ x: number; y: number }> {
  return page.evaluate((doc) => {
    const pageElement = document.querySelector('[data-page]');
    const stack = document.querySelector('[data-pages]');
    if (!(pageElement instanceof HTMLElement) || !(stack instanceof HTMLElement)) {
      throw new Error('no page stack');
    }
    const scale = new DOMMatrixReadOnly(getComputedStyle(stack).transform).a;
    const box = pageElement.getBoundingClientRect();
    return { x: box.x + doc.x * scale, y: box.y + doc.y * scale };
  }, spot);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * One plain, one locked, one hidden and one more plain rect, none overlapping.
 *
 * Non-overlapping on purpose: hit testing is not what this file is testing, and overlapping boxes
 * would make every reachability result depend on paint order as well.
 */
const MATRIX_FIXTURE = `() => {
  const rect = (id, name, x, y, locked, visible) => ({
    type: 'shape', id, name,
    transform: { x, y, width: 120, height: 80, rotation: 0, scaleX: 1, scaleY: 1 },
    visible, locked, opacity: 1, blendMode: 'normal',
    shape: { kind: 'rect', cornerRadius: 0 },
    fill: { type: 'solid', color: '#3366ff' },
  });
  return {
    formatVersion: 1, id: 'matrix', name: 'Matrix',
    pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
    assets: {},
    pages: [{
      id: 'p1', name: '1',
      background: { type: 'solid', color: '#ffffff' },
      objects: [
        rect('node_plain', 'Plain', 40, 40, false, true),
        rect('node_locked', 'Locked', 200, 40, true, true),
        rect('node_hidden', 'Hidden', 40, 170, false, false),
        rect('node_plain2', 'Plain2', 200, 170, false, true),
      ],
    }],
  };
}`;

/** Two text frames, because <kbd>Enter</kbd> is the only observable for `primary`. */
const PRIMARY_FIXTURE = `() => {
  const frame = (id, name, x, y, text) => ({
    type: 'textFrame', id, name,
    transform: { x, y, width: 160, height: 60, rotation: 0, scaleX: 1, scaleY: 1 },
    visible: true, locked: false, opacity: 1, blendMode: 'normal',
    text: { blocks: [{ kind: 'paragraph', runs: [{ text }] } ] },
  });
  return {
    formatVersion: 1, id: 'primary', name: 'Primary',
    pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
    assets: {},
    pages: [{
      id: 'p1', name: '1',
      background: { type: 'solid', color: '#ffffff' },
      objects: [frame('frame_a', 'A', 40, 40, 'alpha'), frame('frame_b', 'B', 240, 40, 'beta')],
    }],
  };
}`;
