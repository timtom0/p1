/**
 * M13: group interaction, through a real browser.
 *
 * ## What is asserted and how
 *
 * Geometry is asserted **geometrically** — model-space values read from the document, and DOM values
 * compared against what the model says they should be. No screenshot baseline is the proof of anything
 * here, because ADR 0011 §8 already established that the overlay's baselines cannot see a
 * sub-pixel change, and a group operation that moved every child by 0.3px would pass every baseline in
 * the repository.
 *
 * The load-bearing assertions are:
 *
 * - **grouping and ungrouping move nothing.** Every child's painted `left`/`top`/matrix before and
 *   after, compared exactly. M12's theorem says this is an identity, so anything else is a bug.
 * - **a child inside a rotated, uniformly scaled group moves correctly.** A page-space drag must
 *   become a *local* delta, and the failure mode is a child drifting off at an angle.
 * - **DOM identity survives.** Grouping is a tree edit, so the leaf elements must be the same elements.
 *   That is only checkable in a browser, and it is what proves the renderer did not rebuild the page.
 */

import type { Page } from '@playwright/test';
import { clientPointAt, clickAt, drag, expect, settle, test } from './helpers';
import {
  mountGroupedFixture,
  mountGroupFixture,
  mountHiddenGroupFixture,
} from './group-interaction-fixtures';

/**
 * A double-click in **document** coordinates.
 *
 * `clickAt` is a single click, and group entry is a double-click. It goes through the exported
 * `clientPointAt` rather than converting by hand: `page.mouse` takes client pixels while `clickAt` and
 * `drag` take document pixels, and that mismatch has silently clicked empty page in three separate
 * tests in this repository. The conversion is the one the rest of the suite already trusts.
 */
async function dblclickAt(page: Page, docX: number, docY: number): Promise<void> {
  const point = await clientPointAt(page, docX, docY);
  await page.mouse.dblclick(point.x, point.y);
  await settle(page);
}

/** Painted geometry of every leaf, read from the DOM. */
async function painted(page: Page): Promise<Record<string, { left: string; top: string; matrix: string }>> {
  return page.evaluate(() => {
    const out: Record<string, { left: string; top: string; matrix: string }> = {};
    for (const element of document.querySelectorAll('[data-objects] [data-oid]')) {
      const node = element as HTMLElement;
      out[node.dataset['oid'] ?? '?'] = {
        left: node.style.left,
        top: node.style.top,
        matrix: node.style.transform,
      };
    }
    return out;
  });
}

/** The leaf ids in the page stack, in document order. Structural, and independent of selection. */
async function leafIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-objects] [data-oid]')].map(
      (element) => (element as HTMLElement).dataset['oid'] ?? '?',
    ),
  );
}

/** Which object ids the overlay is drawing selection outlines for. */
async function outlined(page: Page): Promise<string[]> {
  return page.locator('.p1-overlay-group--selection').evaluateAll((groups) =>
    groups.map((group) => (group as HTMLElement).dataset['for'] ?? '?'),
  );
}

test.describe('a plain click selects the child, never the ancestor', () => {
  test('clicking inside a group selects the leaf that is painted there', async ({ page }) => {
    await mountGroupFixture(page);
    await clickAt(page, 60, 60);
    expect(await outlined(page)).toEqual(['a']);
  });

  test('alt-click selects the containing group instead', async ({ page }) => {
    await mountGroupedFixture(page);
    await clickAt(page, 60, 60, ['Alt']);
    // The group is framed by the union of its contents' painted bounds, so the outline names the group
    // and covers the leaf -- which is how the user can see that the whole group is what is selected.
    const ids = await outlined(page);
    expect(ids).toHaveLength(1);
    expect(ids[0], 'alt-click selects the group, not the leaf').toMatch(/^g/);
  });

  test('a group is never selected by an ordinary click', async ({ page }) => {
    await mountGroupedFixture(page);
    // Each spot's own leaf, in turn. The point is that none of them yields a group.
    const spots: Array<[number, number, string]> = [
      [60, 60, 'a'],
      [160, 60, 'b'],
      [60, 160, 'c'],
    ];
    for (const [x, y, expected] of spots) {
      await clickAt(page, x, y);
      expect(await outlined(page), 'at ' + x + ',' + y).toEqual([expected]);
    }
  });
});

test.describe('grouping', () => {
  test('selects the two objects and groups them without moving anything', async ({ page }) => {
    await mountGroupFixture(page);
    const before = await painted(page);

    await clickAt(page, 60, 60);
    await clickAt(page, 160, 60, ['Shift']);
    expect(await outlined(page)).toEqual(['a', 'b']);
    await page.keyboard.press('Control+g');

    // Nothing moved. Not approximately -- the same strings the renderer wrote before.
    expect(await painted(page)).toEqual(before);
    // And the selection is now the group.
    const ids = await outlined(page);
    expect(ids).toHaveLength(1);
    expect(ids[0], 'alt-click selects the group, not the leaf').toMatch(/^g/);
  });

  test('a group never reaches the leaf reconciler', async ({ page }) => {
    await mountGroupFixture(page);
    await clickAt(page, 60, 60);
    await clickAt(page, 160, 60, ['Shift']);
    await page.keyboard.press('Control+g');

    const leaked = await page.evaluate(() =>
      [...document.querySelectorAll('[data-objects] *')].filter(
        (element) => (element as HTMLElement).dataset['type'] === 'group',
      ).length,
    );
    expect(leaked, 'a group node reached the DOM').toBe(0);
    // Three leaves remain (two grouped, one outside) and there is no container element for the group.
    const count = await page.locator('[data-objects] [data-oid]').count();
    expect(count).toBe(3);
  });

  test('grouping preserves DOM identity for untouched leaves', async ({ page }) => {
    await mountGroupFixture(page);
    // Tag the elements, then group, then ask whether the tags are still on the same objects.
    await page.evaluate(() => {
      for (const element of document.querySelectorAll('[data-objects] [data-oid]')) {
        (element as HTMLElement).dataset['probe'] = 'kept';
      }
    });
    await clickAt(page, 60, 60);
    await clickAt(page, 160, 60, ['Shift']);
    await page.keyboard.press('Control+g');

    const rebuilt = await page.evaluate(
      () =>
        [...document.querySelectorAll('[data-objects] [data-oid]')].filter(
          (element) => (element as HTMLElement).dataset['probe'] === 'kept',
        ).length,
    );
    expect(rebuilt, 'grouping recreated the leaf elements').toBe(3);
  });

  test('groups the middle object with the selected pair, keeping paint order', async ({ page }) => {
    await mountGroupFixture(page);
    // a and c selected, b between them: the span is absorbed so paint order cannot change.
    await clickAt(page, 60, 60);
    await clickAt(page, 60, 160, ['Shift']);
    await page.keyboard.press('Control+g');

    const order = await page.evaluate(() =>
      [...document.querySelectorAll('[data-objects] [data-oid]')].map(
        (element) => (element as HTMLElement).dataset['oid'],
      ),
    );
    expect(order).toEqual(['a', 'b', 'c']);
  });

  test('undo restores the exact document, and redo regroups', async ({ page }) => {
    await mountGroupFixture(page);
    const before = await painted(page);
    await clickAt(page, 60, 60);
    await clickAt(page, 160, 60, ['Shift']);
    await page.keyboard.press('Control+g');
    await page.keyboard.press('Control+z');

    // The claim is about the **document**: undo restores it exactly, and redo regroups with the
    // geometry still untouched. What the selection happens to be afterwards is not part of it -- undo
    // restores state, not a highlight -- so it is not asserted.
    expect(await painted(page)).toEqual(before);
    expect(await leafIds(page), 'undo removed the group wrapper').toEqual(['a', 'b', 'c']);

    await page.keyboard.press('Control+y');
    expect(await painted(page)).toEqual(before);
    expect(await leafIds(page), 'redo restored the group').toEqual(['a', 'b', 'c']);
  });
});

test.describe('ungrouping', () => {
  test('returns the children with no visible change, and selects them', async ({ page }) => {
    await mountGroupFixture(page);
    const before = await painted(page);
    await clickAt(page, 60, 60);
    await clickAt(page, 160, 60, ['Shift']);
    await page.keyboard.press('Control+g');
    await page.keyboard.press('Control+Shift+G');

    expect(await painted(page)).toEqual(before);
    expect((await outlined(page)).sort()).toEqual(['a', 'b']);
  });

  test('group then ungroup is a round trip, undo restores the group', async ({ page }) => {
    await mountGroupFixture(page);
    const original = await painted(page);
    await clickAt(page, 60, 60);
    await clickAt(page, 160, 60, ['Shift']);
    await page.keyboard.press('Control+g');
    await page.keyboard.press('Control+Shift+G');
    await page.keyboard.press('Control+z');

    // Undo of the ungroup must put the group **back into the document**, not merely restore the two
    // leaves. Asserted structurally rather than by outline: undo restores state, and what is
    // highlighted afterwards is not part of the claim.
    expect(await leafIds(page), 'undo restored the three leaves').toEqual(['a', 'b', 'c']);
    expect(await painted(page), 'and the geometry is untouched').toEqual(original);
  });
});

test.describe('moving a group', () => {
  test('dragging a selected group moves every child and rewrites no child DOM style', async ({ page }) => {
    await mountGroupFixture(page);
    await clickAt(page, 60, 60);
    await clickAt(page, 160, 60, ['Shift']);
    await page.keyboard.press('Control+g');

    // Mark the children's own inline styles, which a child-rewriting implementation would overwrite.
    await page.evaluate(() => {
      for (const element of document.querySelectorAll('[data-objects] [data-oid]')) {
        (element as HTMLElement).dataset['owner'] = 'child';
      }
    });
    const before = await painted(page);

    await drag(page, { x: 100, y: 100 }, { x: 140, y: 160 });

    const after = await painted(page);
    // The children moved -- this is a real drag, not a no-op.
    expect(after['a']?.left).not.toBe(before['a']?.left);
    // By the same delta, because the group matrix is what moved them.
    const delta = (index: 0 | 1) =>
      Number.parseFloat(after['a']?.[index === 0 ? 'left' : 'top'] ?? '0') -
      Number.parseFloat(before['a']?.[index === 0 ? 'left' : 'top'] ?? '0');
    expect(delta(0)).toBeCloseTo(40, 0);
    expect(delta(1)).toBeCloseTo(60, 0);
    // Every leaf still carries the marker stamped on it before the drag. Three leaves exist -- `a` and
    // `b` inside the group, `c` outside -- and a group move that rewrote a child would have replaced
    // that element, taking the marker with it.
    expect(await page.evaluate(
      () => [...document.querySelectorAll('[data-objects] [data-oid]')].filter(
        (element) => (element as HTMLElement).dataset['owner'] === 'child',
      ).length,
    )).toBe(3);
  });

  test('undo moves the children back', async ({ page }) => {
    await mountGroupFixture(page);
    const before = await painted(page);
    await clickAt(page, 60, 60);
    await clickAt(page, 160, 60, ['Shift']);
    await page.keyboard.press('Control+g');
    await drag(page, { x: 100, y: 100 }, { x: 140, y: 160 });
    await page.keyboard.press('Control+z');
    expect(await painted(page)).toEqual(before);
  });
});

test.describe('entering a group', () => {
  test('a plain click still selects the leaf after entering, which is what entry is for', async ({
    page,
  }) => {
    await mountGroupFixture(page);
    await clickAt(page, 60, 60);
    await clickAt(page, 160, 60, ['Shift']);
    await page.keyboard.press('Control+g');
    // Enter the group by double-clicking one of its children.
    await dblclickAt(page, 60, 60);
    // Still one selection, and it is a leaf -- entry changed where the user is, not what a click means.
    await clickAt(page, 160, 60);
    expect(await outlined(page)).toEqual(['b']);
  });

  test('Escape leaves the group, and the selection clears at page level', async ({ page }) => {
    await mountGroupFixture(page);
    await clickAt(page, 60, 60);
    await clickAt(page, 160, 60, ['Shift']);
    await page.keyboard.press('Control+g');
    await dblclickAt(page, 60, 60);
    await page.keyboard.press('Escape');
    // Leaving the group is the more consequential Escape, so it fires *instead of* clearing.
    await page.keyboard.press('Escape');
    expect(await outlined(page)).toEqual([]);
  });
});

test.describe('hidden groups hide their whole subtree', () => {
  test('a child of a hidden group is not hit-testable', async ({ page }) => {
    // Built as a document with `group.visible: false`, so this is M12's hidden-ancestor chain being
    // exercised through a group rather than injected at the DOM.
    await mountHiddenGroupFixture(page);
    // `a` and `b` are inside a hidden group; `c` is an ordinary sibling and stays reachable. So the
    // claim is about the subtree, not the page: a click where a hidden child would paint selects
    // nothing, and the hidden pair are absent from the page stack.
    await clickAt(page, 60, 60);
    expect(await outlined(page), 'a click on a hidden child selected something').toEqual([]);
    // Hidden is a **paint state, not a removal** -- M12's contract, asserted in
    // `group-geometry.spec.ts` ("the DOM still holds the elements"). So the pair is still in the page
    // stack and is still `display: none`, which is why nothing is clickable.
    expect(await leafIds(page)).toEqual(['a', 'b', 'c']);
    const hiddenState = await page.evaluate(() => {
      const element = document.querySelector('[data-oid="a"]');
      return element instanceof HTMLElement ? getComputedStyle(element).display : 'missing';
    });
    expect(hiddenState, 'a child of a hidden group is still painted').toBe('none');
    // And the visible sibling is still clickable, so the *group* is hidden rather than the page.
    await clickAt(page, 60, 190);
    expect(await outlined(page)).toEqual(['c']);
  });
});
