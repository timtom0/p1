/**
 * M16: alignment and distribution, in the real editor.
 *
 * ## What these tests are for, given the unit suite already exists
 *
 * `src/model/arrange.test.ts` proves the geometry. This file proves the parts that only exist once there
 * is an application: that the buttons reach the command, that a click is **one** undo step, that undo
 * restores the authored transforms exactly, that the document survives a save/load round trip, that the
 * dirty indicator behaves, that the selection survives, and that a group is moved as a whole.
 *
 * ## Every assertion is geometric
 *
 * Read rectangles and compare them, never screenshot baselines. ADR 0011b §8 established that the
 * overlay baselines cannot detect a sub-pixel chrome change -- `maxDiffPixelRatio: 0.002` is thousands of
 * pixels of tolerance -- so a pixel baseline here could not tell a correct alignment from one that is
 * several pixels out. `getBoundingClientRect` on the painted element is the thing the user sees, and it is
 * compared numerically.
 *
 * ## Sizes differ on purpose
 *
 * The fixtures use deliberately unequal widths and heights. An implementation that aligned by centre when
 * asked to align by edge, or that equalised sizes while lining up edges, passes on equal-size boxes and
 * fails on these.
 */

import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';

import {
  clickAt,
  dragWithoutSnapping,
  expect,
  selectionIds,
  settle,
  test,
  undoLabel,
} from './helpers';
import {
  mountAlreadyDistributed,
  mountNestedGroup,
  mountOverlappingRects,
  mountRotatedGroupMembers,
  mountRotatedSized,
  mountThreeSizedRects,
  mountTwoRects,
} from './align-fixtures';

// ---------------------------------------------------------------------------
// Reading painted geometry
// ---------------------------------------------------------------------------

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Every leaf's painted box, in **page** space.
 *
 * The page element's own client rect is subtracted so the numbers are document coordinates rather than
 * viewport ones. At 1:1 zoom -- which every mount helper establishes -- one document pixel is one client
 * pixel, so no zoom factor appears anywhere here. Comparing *deltas* would have worked at any zoom, but
 * the anchors below are absolute numbers, so the conversion is done explicitly rather than assumed.
 */
async function painted(page: Page): Promise<Record<string, Box>> {
  return page.evaluate(() => {
    const pageElement = document.querySelector('[data-page]') as HTMLElement;
    const origin = pageElement.getBoundingClientRect();
    const out: Record<string, Box> = {};
    for (const element of document.querySelectorAll('[data-oid]')) {
      const box = element.getBoundingClientRect();
      out[(element as HTMLElement).dataset['oid'] ?? '?'] = {
        left: box.left - origin.left,
        top: box.top - origin.top,
        width: box.width,
        top_: 0,
        height: box.height,
      } as unknown as Box;
    }
    return out;
  });
}

/** Selects several objects by clicking their painted centres in turn, shift-clicking the rest. */
async function selectAll(page: Page, ids: readonly string[]): Promise<void> {
  const centres = await page.evaluate((wanted) => {
    const pageElement = document.querySelector('[data-page]') as HTMLElement;
    const origin = pageElement.getBoundingClientRect();
    return wanted.map((id) => {
      const element = document.querySelector(`[data-oid="${id}"]`) as HTMLElement | null;
      if (element === null) throw new Error(`no leaf ${id} to select`);
      const box = element.getBoundingClientRect();
      return {
        x: box.left + box.width / 2 - origin.left,
        y: box.top + box.height / 2 - origin.top,
      };
    });
  }, ids);
  for (const [index, centre] of centres.entries()) {
    await clickAt(page, centre.x, centre.y, index === 0 ? [] : ['Shift']);
  }
  await settle(page);
}

/**
 * Clicks a toolbar align or distribute button by its data attribute.
 *
 * The attribute is `data-object-align`, **not** `data-align`. That name is already taken by the
 * inspector's paragraph-alignment control, which writes `data-align` with the values `left`/`center`/
 * `right` (ADR 0003, and `tests/editor/text.spec.ts` selects it). Using it here made every
 * `[data-align="left"]` locator in this suite resolve to two elements. The namespaced name is also the
 * more accurate one: these buttons operate on objects, where the inspector's operate on the text inside
 * one.
 */
async function arrange(page: Page, attribute: 'align' | 'distribute', value: string): Promise<void> {
  // `objectAlign` is the attribute suffix, not `align` -- see the note above. Building the selector from
  // the caller's short name and prefixing `data-object-` keeps every call site reading naturally while
  // producing the namespaced attribute the toolbar actually uses.
  const suffix = attribute === 'align' ? 'object-align' : 'object-distribute';
  await page.locator(`[data-${suffix}="${value}"]`).click();
  await settle(page);
}

/** The `aria-disabled` state of every align/distribute button, as a map. */
async function arrangeButtonState(page: Page): Promise<Record<string, boolean>> {
  return page.evaluate(() => {
    const out: Record<string, boolean> = {};
    for (const button of document.querySelectorAll('[data-object-align], [data-object-distribute]')) {
      const key = button.getAttribute('data-object-align') ?? `distribute:${button.getAttribute('data-object-distribute')}`;
      out[key] = button.getAttribute('aria-disabled') === 'true';
    }
    return out;
  });
}

/** The saved document bytes, through the app's real save path. */
async function savedBytes(page: Page): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-doc="save"]').click(),
  ]);
  const path = await download.path();
  if (path === null) throw new Error('the download produced no file');
  return readFile(path, 'utf8');
}

// ---------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------

test.describe('aligning', () => {
  test('aligns left edges of three differently sized boxes', async ({ page }) => {
    await mountThreeSizedRects(page);
    await selectAll(page, ['a', 'b', 'c']);

    await arrange(page, 'align', 'left');

    const after = await painted(page);
    expect(after['a']!.left).toBeCloseTo(after['b']!.left, 0);
    expect(after['b']!.left).toBeCloseTo(after['c']!.left, 0);
    // `a` is the leftmost and is the anchor, so it has not moved at all.
    expect(after['a']!.left).toBeCloseTo(40, 0);
    // Sizes are untouched: aligning edges does not equalise widths.
    expect(after['a']!.width).toBeCloseTo(60, 0);
    expect(after['b']!.width).toBeCloseTo(100, 0);
    expect(after['c']!.width).toBeCloseTo(50, 0);
  });

  test('aligns right edges, and the rightmost box is the anchor', async ({ page }) => {
    await mountThreeSizedRects(page);
    await selectAll(page, ['a', 'b', 'c']);

    await arrange(page, 'align', 'right');

    const after = await painted(page);
    const right = (id: string): number => after[id]!.left + after[id]!.width;
    expect(right('a')).toBeCloseTo(right('b'), 0);
    expect(right('b')).toBeCloseTo(right('c'), 0);
    expect(right('c'), 'the rightmost box did not move').toBeCloseTo(430, 0);
  });

  test('aligns horizontal centres', async ({ page }) => {
    await mountThreeSizedRects(page);
    await selectAll(page, ['a', 'b', 'c']);

    await arrange(page, 'align', 'center-h');

    const after = await painted(page);
    const centre = (id: string): number => after[id]!.left + after[id]!.width / 2;
    expect(centre('a')).toBeCloseTo(centre('b'), 0);
    expect(centre('b')).toBeCloseTo(centre('c'), 0);
  });

  test('aligns top, vertical centres and bottom', async ({ page }) => {
    for (const [mode, read] of [
      ['top', (b: Box): number => b.top],
      ['center-v', (b: Box): number => b.top + b.height / 2],
      ['bottom', (b: Box): number => b.top + b.height],
    ] as Array<[string, (b: Box) => number]>) {
      await mountThreeSizedRects(page);
      await selectAll(page, ['a', 'b', 'c']);
      await arrange(page, 'align', mode!);
      const after = await painted(page);
      expect(read(after['a']!), `${mode}: a`).toBeCloseTo(read(after['b']!), 0);
      expect(read(after['b']!), `${mode}: b`).toBeCloseTo(read(after['c']!), 0);
    }
  });

  test('aligns a rotated object by its painted bounds, not its model frame', async ({ page }) => {
    await mountRotatedSized(page);
    await selectAll(page, ['a', 'b', 'c']);

    const before = await painted(page);
    // The 45-degree box paints wider than its model frame, which is the whole point: if the implementation
    // used the model frame, this assertion on painted edges would fail by several pixels.
    expect(before['c']!.width, 'the rotated box paints wider than 100').toBeGreaterThan(108);

    await arrange(page, 'align', 'left');

    const after = await painted(page);
    expect(after['a']!.left).toBeCloseTo(after['b']!.left, 0);
    expect(after['a']!.left).toBeCloseTo(after['c']!.left, 0);
    // And the rotated box kept its size -- a rotation plus a translation is not a resize.
    expect(after['c']!.width).toBeCloseTo(before['c']!.width, 0);
    expect(after['c']!.height).toBeCloseTo(before['c']!.height, 0);
  });

  test('aligns exactly two objects', async ({ page }) => {
    await mountTwoRects(page);
    await selectAll(page, ['a', 'b']);

    await arrange(page, 'align', 'top');

    const after = await painted(page);
    expect(after['a']!.top).toBeCloseTo(after['b']!.top, 0);
    expect(after['a']!.top, 'the topmost is the anchor').toBeCloseTo(40, 0);
  });

  test('is one undo step, and undo restores the exact transforms', async ({ page }) => {
    await mountThreeSizedRects(page);
    await selectAll(page, ['a', 'b', 'c']);
    const before = await painted(page);

    await arrange(page, 'align', 'left');
    const moved = await painted(page);
    expect(moved['b']!.left, 'the alignment actually did something').not.toBeCloseTo(before['b']!.left, 0);

    // One operation, one entry -- so a single undo returns everything.
    expect(await undoLabel(page)).toContain('Align 3');
    await page.keyboard.press('Control+z');
    await settle(page);

    const after = await painted(page);
    for (const id of ['a', 'b', 'c']) {
      expect(after[id]!.left, `${id} restored`).toBeCloseTo(before[id]!.left, 1);
      expect(after[id]!.top, `${id} restored`).toBeCloseTo(before[id]!.top, 1);
      expect(after[id]!.width, `${id} restored`).toBeCloseTo(before[id]!.width, 1);
      expect(after[id]!.height, `${id} restored`).toBeCloseTo(before[id]!.height, 1);
    }

    // And redo puts it back.
    await page.keyboard.press('Control+Shift+z');
    await settle(page);
    const redone = await painted(page);
    expect(redone['b']!.left).toBeCloseTo(moved['b']!.left, 1);
  });

  test('preserves the selection, so aligning twice is a no-op rather than a surprise', async ({ page }) => {
    await mountThreeSizedRects(page);
    await selectAll(page, ['a', 'b', 'c']);
    expect(await selectionIds(page)).toEqual(['a', 'b', 'c']);

    const before = await painted(page);

    await arrange(page, 'align', 'left');
    expect(await selectionIds(page), 'the selection survived the alignment').toEqual(['a', 'b', 'c']);
    const once = await painted(page);

    // Second click: everything is already aligned, so nothing moves and no history entry appears.
    await arrange(page, 'align', 'left');
    const twice = await painted(page);
    for (const id of ['a', 'b', 'c']) {
      expect(twice[id]!.left, `${id} did not move on the second align`).toBeCloseTo(once[id]!.left, 1);
    }
    // Undo once returns to the original: the second click recorded nothing, so one undo is still enough.
    await page.keyboard.press('Control+z');
    await settle(page);
    const undone = await painted(page);
    expect(undone['b']!.left, 'one undo went all the way back').toBeCloseTo(before['b']!.left, 1);
  });

  test('an already-aligned selection records no history entry at all', async ({ page }) => {
    await mountThreeSizedRects(page);
    await selectAll(page, ['a', 'b', 'c']);
    await arrange(page, 'align', 'left');

    const labelAfterFirst = await undoLabel(page);
    await arrange(page, 'align', 'left');
    expect(await undoLabel(page), 'the second no-op added no entry').toBe(labelAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// Distribution
// ---------------------------------------------------------------------------

test.describe('distributing', () => {
  test('spaces three boxes into equal horizontal gaps', async ({ page }) => {
    await mountThreeSizedRects(page);
    await selectAll(page, ['a', 'b', 'c']);

    await arrange(page, 'distribute', 'horizontal');

    const after = await painted(page);
    const gapAB = after['b']!.left - (after['a']!.left + after['a']!.width);
    const gapBC = after['c']!.left - (after['b']!.left + after['b']!.width);
    expect(gapAB, 'equal gaps, not equal centres').toBeCloseTo(gapBC, 0);
    // Sorted a(40,w60) b(200,w100) c(380,w50): span 390, widths 210, gap 90.
    expect(gapAB).toBeCloseTo(90, 0);
  });

  test('spaces three boxes into equal vertical gaps', async ({ page }) => {
    await mountThreeSizedRects(page);
    await selectAll(page, ['a', 'b', 'c']);

    await arrange(page, 'distribute', 'vertical');

    const after = await painted(page);
    const gapAB = after['b']!.top - (after['a']!.top + after['a']!.height);
    const gapBC = after['c']!.top - (after['b']!.top + after['b']!.height);
    expect(gapAB).toBeCloseTo(gapBC, 0);
  });

  test('keeps the outermost two fixed as anchors', async ({ page }) => {
    await mountThreeSizedRects(page);
    await selectAll(page, ['a', 'b', 'c']);
    const before = await painted(page);

    await arrange(page, 'distribute', 'horizontal');

    const after = await painted(page);
    expect(after['a']!.left, 'the left anchor did not move').toBeCloseTo(before['a']!.left, 1);
    expect(after['c']!.left, 'the right anchor did not move').toBeCloseTo(before['c']!.left, 1);
    expect(after['b']!.left, 'only the middle object moved').not.toBeCloseTo(before['b']!.left, 0);
  });

  test('distributes an overlapping selection, allowing a negative gap', async ({ page }) => {
    await mountOverlappingRects(page);
    await selectAll(page, ['a', 'b', 'c']);

    await arrange(page, 'distribute', 'horizontal');

    const after = await painted(page);
    // a(40,w100) b(100,w100) c(200,w100): span 260, widths 300, so the gap is -20.
    const gapAB = after['b']!.left - (after['a']!.left + after['a']!.width);
    const gapBC = after['c']!.left - (after['b']!.left + after['b']!.width);
    expect(gapAB, 'a negative gap is produced, not a refusal').toBeCloseTo(-20, 0);
    expect(gapBC).toBeCloseTo(-20, 0);
    expect(after['b']!.left, 'the middle object really moved').toBeCloseTo(120, 0);
  });

  test('is a no-op when the boxes are already evenly spaced', async ({ page }) => {
    await mountAlreadyDistributed(page);
    await selectAll(page, ['a', 'b', 'c']);
    const before = await painted(page);

    await arrange(page, 'distribute', 'horizontal');

    const after = await painted(page);
    for (const id of ['a', 'b', 'c']) {
      expect(after[id]!.left, `${id} did not move`).toBeCloseTo(before[id]!.left, 1);
    }
    // No history entry, so undo has nothing to undo.
    expect(await undoLabel(page)).not.toContain('Distribute');
  });

  test('does nothing at all with only two objects', async ({ page }) => {
    await mountTwoRects(page);
    await selectAll(page, ['a', 'b']);
    const before = await painted(page);

    // `force`, because Playwright honours `aria-disabled` and would otherwise wait forever on a control
    // this test deliberately clicks while it is unavailable.
    await page.locator('[data-object-distribute="horizontal"]').click({ force: true });
    await settle(page);

    const after = await painted(page);
    expect(after['a']!.left).toBeCloseTo(before['a']!.left, 1);
    expect(after['b']!.left).toBeCloseTo(before['b']!.left, 1);
    expect(await undoLabel(page)).not.toContain('Distribute');
  });

  test('is one undo step', async ({ page }) => {
    await mountThreeSizedRects(page);
    await selectAll(page, ['a', 'b', 'c']);
    const before = await painted(page);

    await arrange(page, 'distribute', 'horizontal');
    expect(await undoLabel(page)).toContain('Distribute 3 objects horizontally');

    await page.keyboard.press('Control+z');
    await settle(page);
    const after = await painted(page);
    for (const id of ['a', 'b', 'c']) {
      expect(after[id]!.left, `${id} restored by one undo`).toBeCloseTo(before[id]!.left, 1);
    }
  });
});

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

test.describe('groups', () => {
  test('aligns a group by its painted bounds and moves it as a whole', async ({ page }) => {
    await mountRotatedGroupMembers(page);
    // Alt-click selects the containing group rather than the leaf (M12).
    const centre = await page.evaluate(() => {
      const pageElement = document.querySelector('[data-page]') as HTMLElement;
      const origin = pageElement.getBoundingClientRect();
      const element = document.querySelector('[data-oid="m1"]') as HTMLElement;
      const box = element.getBoundingClientRect();
      return {
        x: box.left + box.width / 2 - origin.left,
        y: box.top + box.height / 2 - origin.top,
      };
    });
    await clickAt(page, centre.x, centre.y, ['Alt']);
    await clickAt(page, 90, 70, ['Shift']);
    expect(await selectionIds(page)).toEqual(expect.arrayContaining(['grp', 'plain']));

    const before = await painted(page);
    await arrange(page, 'align', 'left');
    const after = await painted(page);

    // `plain` sits at x=40 and the group's painted box starts around x=283, so `plain` is the leftmost and
    // is therefore the anchor. The group has to travel *left* to reach it, so the delta is negative -- and
    // it has to be exactly the distance between the two painted left edges, which is what proves the
    // group's box was the union of its members' rather than its own transparent frame.
    expect(after['plain']!.left, 'the anchor did not move').toBeCloseTo(before['plain']!.left, 0);

    const dm1 = after['m1']!.left - before['m1']!.left;
    const dm2 = after['m2']!.left - before['m2']!.left;
    expect(dm1, 'both members moved by the same page-space delta').toBeCloseTo(dm2, 0);
    expect(dm1, 'the group travelled left to reach the anchor').toBeLessThan(0);
    expect(
      after['m1']!.left,
      'and the members landed exactly on the anchor painted edge',
    ).toBeCloseTo(after['plain']!.left, 0);
    // The group's own transform is what moved; the members' authored transforms were not rewritten.
    expect(after['m1']!.width, 'member sizes untouched').toBeCloseTo(before['m1']!.width, 0);
    expect(after['m2']!.width).toBeCloseTo(before['m2']!.width, 0);
  });

  test('aligns a leaf two groups deep against a top-level box', async ({ page }) => {
    // The two-level case. `outside` is at depth 0 and is the leftmost painted box, so it is the anchor;
    // `leaf` is two groups deep and has to convert its page-space delta through a composed chain. If the
    // conversion were skipped -- the defect this milestone also fixed in the drag gesture -- `leaf` would
    // land short along x and off along y, and these two edges would not line up.
    await mountNestedGroup(page);
    await selectAll(page, ['leaf', 'outside']);

    const before = await painted(page);
    await arrange(page, 'align', 'left');

    const after = await painted(page);
    // Whichever object was leftmost is the anchor and must not have moved. In this fixture that is the
    // nested leaf, which sits near the middle of the page while `outside` is at (400,320) -- so the leaf
    // stays put and the depth-0 box travels to it.
    const leftmost = before['leaf']!.left <= before['outside']!.left ? 'leaf' : 'outside';
    const moved = leftmost === 'leaf' ? 'outside' : 'leaf';
    expect(after[leftmost]!.left, `${leftmost} is the anchor and did not move`).toBeCloseTo(
      before[leftmost]!.left,
      0,
    );
    expect(
      after[moved]!.left,
      `${moved} reached the anchor painted edge, which needs the composed conversion`,
    ).toBeCloseTo(after[leftmost]!.left, 0);
    expect(after[moved]!.left, 'and it really moved').not.toBeCloseTo(before[moved]!.left, 0);
    expect(after['leaf']!.width, 'the nested leaf kept its size').toBeCloseTo(before['leaf']!.width, 0);
    expect(after['leaf']!.height).toBeCloseTo(before['leaf']!.height, 0);
    // Selection preserved.
    expect(await selectionIds(page)).toEqual(expect.arrayContaining(['leaf', 'outside']));
  });

  test('one object cannot align with itself', async ({ page }) => {
    await mountNestedGroup(page);
    await selectAll(page, ['leaf']);

    const before = await painted(page);
    // `force` for the same reason as elsewhere: alignment needs two objects, so this button is
    // `aria-disabled` and Playwright would otherwise refuse to click it.
    await page.locator('[data-object-align="left"]').click({ force: true });
    await settle(page);
    const after = await painted(page);

    expect(after['leaf']!.left, 'nothing moved').toBeCloseTo(before['leaf']!.left, 1);
    expect(await undoLabel(page)).not.toContain('Align');
    expect(await selectionIds(page), 'and the selection was preserved').toEqual(['leaf']);
  });
});

// ---------------------------------------------------------------------------
// Control availability
// ---------------------------------------------------------------------------

test.describe('the controls represent what is unavailable', () => {
  test('with nothing selected, every align and distribute button is unavailable', async ({ page }) => {
    await mountThreeSizedRects(page);
    await page.keyboard.press('Escape');
    await settle(page);

    const state = await arrangeButtonState(page);
    for (const [key, disabled] of Object.entries(state)) {
      expect(disabled, `${key} should be unavailable with an empty selection`).toBe(true);
    }
  });

  test('with two objects, align is available and distribute is not', async ({ page }) => {
    await mountTwoRects(page);
    await selectAll(page, ['a', 'b']);

    const state = await arrangeButtonState(page);
    for (const mode of ['left', 'center-h', 'right', 'top', 'center-v', 'bottom']) {
      expect(state[mode], `${mode} should be available with two objects`).toBe(false);
    }
    expect(state['distribute:horizontal'], 'distribution needs three').toBe(true);
    expect(state['distribute:vertical'], 'distribution needs three').toBe(true);
  });

  test('with three objects, everything is available', async ({ page }) => {
    await mountThreeSizedRects(page);
    await selectAll(page, ['a', 'b', 'c']);

    const state = await arrangeButtonState(page);
    for (const [key, disabled] of Object.entries(state)) {
      expect(disabled, `${key} should be available with three objects`).toBe(false);
    }
  });

  test('the buttons stay reachable rather than being removed from the tab order', async ({ page }) => {
    // `aria-disabled` rather than the native `disabled` attribute, so the control stays in the tab order
    // and a keyboard user can reach it and read why it is unavailable. Same reasoning as the layer buttons.
    //
    // Note that `aria-disabled` is *also* what tooling honours: Playwright's actionability check treats an
    // `aria-disabled="true"` element as disabled, so an ordinary `.click()` on it waits rather than
    // clicking. That is the contract working, and the next test exercises the app's own guard underneath
    // it using `force`.
    await mountThreeSizedRects(page);
    const button = page.locator('[data-object-align="left"]');
    expect(await button.getAttribute('aria-disabled'), 'nothing is selected yet').toBe('true');
    expect(
      await button.evaluate((el) => el.hasAttribute('disabled')),
      'but the native disabled attribute is absent, so it stays focusable',
    ).toBe(false);
    expect(
      await button.evaluate((el) => (el as HTMLElement).tabIndex >= 0),
      'and it is still in the tab order',
    ).toBe(true);
    // Tooling honours the ARIA state, which is the point of using it.
    expect(await button.isDisabled(), 'aria-disabled reads as disabled to actionability checks').toBe(true);
  });

  test('an unavailable control changes nothing even when clicked', async ({ page }) => {
    await mountTwoRects(page);
    await selectAll(page, ['a']);
    const before = await painted(page);

    // `force` because Playwright refuses to click an `aria-disabled` element -- see the note above. What is
    // under test is the application's own guard, not Playwright's.
    await page.locator('[data-object-distribute="horizontal"]').click({ force: true });
    await settle(page);

    const after = await painted(page);
    expect(after['a']!.left).toBeCloseTo(before['a']!.left, 1);
    expect(after['a']!.top).toBeCloseTo(before['a']!.top, 1);
    expect(await undoLabel(page)).not.toContain('Distribute');
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test.describe('persistence', () => {
  test('aligned transforms survive a save and reload byte-for-byte', async ({ page }) => {
    await mountThreeSizedRects(page);
    await selectAll(page, ['a', 'b', 'c']);
    await arrange(page, 'align', 'left');
    await arrange(page, 'distribute', 'vertical');

    const aligned = await painted(page);
    const saved = await savedBytes(page);
    const parsed = JSON.parse(saved) as {
      formatVersion: number;
      pages: Array<{ objects: Array<{ id: string; transform: Record<string, number> }> }>;
    };

    // No format bump: alignment changes existing transforms and nothing else.
    expect(parsed.formatVersion, 'alignment must not require a format version bump').toBe(2);

    const objects = parsed.pages[0]?.objects ?? [];
    const byId = new Map(objects.map((node) => [node.id, node.transform]));
    for (const [id, box] of Object.entries(aligned)) {
      const transform = byId.get(id);
      expect(transform, `${id} is in the saved document`).toBeDefined();
      // The saved `x`/`y` are the model frame, which for an unrotated box is its painted left/top.
      expect(transform?.['x'], `${id} saved x`).toBeCloseTo(box.left, 1);
      expect(transform?.['y'], `${id} saved y`).toBeCloseTo(box.top, 1);
    }
  });

  test('the dirty indicator follows an alignment', async ({ page }) => {
    await mountThreeSizedRects(page);
    await selectAll(page, ['a', 'b', 'c']);
    const clean = await page.locator('[data-dirty]').getAttribute('data-dirty');
    expect(clean, 'a freshly opened document is not dirty').toBe('false');

    await arrange(page, 'align', 'left');
    expect(
      await page.locator('[data-dirty]').getAttribute('data-dirty'),
      'aligning changes the document, so it is dirty',
    ).toBe('true');

    await page.keyboard.press('Control+z');
    await settle(page);
    expect(
      await page.locator('[data-dirty]').getAttribute('data-dirty'),
      'undoing back to the saved state makes it clean again',
    ).toBe('false');
  });

  test('a saved aligned document reloads with the alignment intact', async ({ page }) => {
    await mountThreeSizedRects(page);
    await selectAll(page, ['a', 'b', 'c']);
    await arrange(page, 'align', 'left');
    const aligned = await painted(page);
    const saved = await savedBytes(page);

    // Reopen the same bytes through the app's own open path.
    await page.locator('[data-doc="new"]').click();
    await settle(page);
    const emptied = await painted(page);
    expect(Object.keys(emptied).length, 'a new document has no leaves from the fixture').toBe(0);

    await page.locator('[data-file-input="document"]').setInputFiles({
      name: 'aligned.p1doc',
      mimeType: 'application/json',
      buffer: Buffer.from(saved, 'utf8'),
    });
    await settle(page);

    const reloaded = await painted(page);
    for (const [id, box] of Object.entries(aligned)) {
      expect(reloaded[id]!.left, `${id} reloaded left`).toBeCloseTo(box.left, 0);
      expect(reloaded[id]!.top, `${id} reloaded top`).toBeCloseTo(box.top, 0);
    }
  });
});

// ---------------------------------------------------------------------------
// Mixed selections
// ---------------------------------------------------------------------------

test.describe('mixed selections', () => {
  test('aligns a rotated box together with unrotated ones', async ({ page }) => {
    await mountRotatedSized(page);
    await selectAll(page, ['a', 'b', 'c']);
    const before = await painted(page);

    await arrange(page, 'align', 'center-v');

    const after = await painted(page);
    const centre = (id: string): number => after[id]!.top + after[id]!.height / 2;
    expect(centre('a')).toBeCloseTo(centre('b'), 0);
    expect(centre('a')).toBeCloseTo(centre('c'), 0);
    // Every box kept its own height, rotated or not.
    expect(after['c']!.height).toBeCloseTo(before['c']!.height, 0);
    expect(after['a']!.height).toBeCloseTo(before['a']!.height, 0);
  });

  test('a drag after an alignment still moves the object by the pointer delta', async ({ page }) => {
    // Alignment must leave the object's gesture behaviour intact -- if it had rewritten more than `x`/`y`
    // this would drift, because the drag converts a page delta into a parent-local one.
    await mountThreeSizedRects(page);
    await selectAll(page, ['a', 'b', 'c']);
    await arrange(page, 'align', 'left');
    await clickAt(page, 70, 60);

    const before = await painted(page);
    // Snapping is suppressed: this asserts the *movement* after an alignment, and a snap would move the
    // object somewhere other than the pointer for reasons that have nothing to do with alignment.
    await dragWithoutSnapping(page, { x: 70, y: 60 }, { x: 110, y: 90 });
    const after = await painted(page);

    expect(after['a']!.left - before['a']!.left).toBeCloseTo(40, 0);
    expect(after['a']!.top - before['a']!.top).toBeCloseTo(30, 0);
  });
});
