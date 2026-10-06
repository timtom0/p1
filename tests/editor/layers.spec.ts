/**
 * Layer order and multi-object editing, through the real app.
 *
 * ## How paint order is observed
 *
 * By **DOM order inside the page element**. That is not a shortcut: the renderer appends
 * objects in array order and CSS paints in DOM order, so the rendered sequence *is* the
 * model's paint order *is* the persisted order (ADR 0007 §2). One observation therefore covers
 * all three claims, and it is a user-visible surface rather than a test hook.
 *
 * Reading it through the overlay instead would be weaker: the overlay draws outlines in
 * selection order, not stack order, so it could not distinguish a restack from a reselect.
 *
 * ## Every test asserts its own setup
 *
 * A restack test that did not confirm the object was selected would pass against a document
 * where the click missed — the M5 lesson about helpers that silently no-op, and the M7 one
 * about ten suites failing for a reason three files away. `selectOnly` and `selectExactly`
 * assert the selection, and every geometry test names what it found.
 *
 * ## A trap this file fell into, and what caught it
 *
 * `a drag moves every selected object…` selects the second object with a **shift-click** and
 * then drags. That combination used to move the objects one increment and no further, because
 * a shift-click press also began a native text selection, Chromium answered with
 * `pointercancel`, and a cancelled pointer delivers no further events at all. The drag never
 * finished and the editor stayed mid-gesture.
 *
 * The reason no earlier test caught it is that the pre-existing multi-object drag assertion
 * only checked that the inspector went mixed, which one increment satisfies. This one asserts
 * the **full** delta, and that is the only reason the bug is visible. A geometry assertion that
 * checks the *end* of a drag, not merely that something changed, is the whole difference
 * between finding this and shipping it.
 *
 * ## What is deliberately absent
 *
 * No group resize, because a non-uniform resize of a rotated object is a shear and
 * `Transform2D` has no shear (ADR 0008 §4, pinned by
 * `src/model/group-resize-limit.test.ts`). The resize test below is therefore *single* object,
 * and one of them asserts that a multi-selection's handle resizes only the pressed object —
 * the existing, deliberate behaviour, worth pinning rather than assuming.
 */

import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import {
  clickAt,
  drag,
  expect,
  selectionCount,
  selectionIds,
  test,
  undoDisabled,
  undoLabel,
} from './helpers';
import { mountFixture, mountSample } from '../visual/harness';

// ---------------------------------------------------------------------------
// Reading the stack
// ---------------------------------------------------------------------------

/** Object ids in rendered order within the first page, which is paint order. */
function paintOrder(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-page] [data-oid]')].map(
      (el) => (el as HTMLElement).dataset['oid'] ?? '',
    ),
  );
}

/**
 * The same order, with the fixture's own names attached.
 *
 * Worth the extra step: `expect(['node_gamma', 'node_beta'])` names two ids and no geometry,
 * and a failure would send a reader to the fixture to work out what moved.
 */
async function namedOrder(page: Page): Promise<string[]> {
  return nameById(await paintOrder(page), IDS);
}

function nameById(ids: readonly string[], table: readonly { id: string; name: string }[]) {
  const byId = new Map(table.map((entry) => [entry.id, entry.name]));
  return ids.map((id) => byId.get(id) ?? id);
}

// ---------------------------------------------------------------------------
// Selecting, with the assertion every restack test depends on
// ---------------------------------------------------------------------------

/**
 * Clears the selection the way a user would, and asserts it worked.
 *
 * Focus is dropped first because `editing-shortcuts.ts` ignores every shortcut while a field
 * has focus — so straight after committing an inspector field, Escape does nothing at all.
 * That is correct behaviour, and an easy thing to mistake for a broken selection.
 */
async function clearSelection(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Escape');
  expect(await selectionCount(page), 'the selection is empty before selecting').toBe(0);
}

/**
 * Selects exactly the named objects, and asserts the selection really is exactly those.
 *
 * The selection is cleared first, and that detail is load-bearing rather than tidiness: a
 * plain click on an object that is *already selected* deliberately keeps the whole selection
 * rather than reducing it to that object, because that is what makes dragging a selected
 * object work. So a helper that clicked the first object and then shift-clicked the rest would
 * inherit whatever was selected before it, and a test would quietly act on a different
 * selection than it asked for.
 */
async function selectExactly(page: Page, entries: readonly LayerRect[]): Promise<void> {
  await clearSelection(page);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) throw new Error('unreachable');
    await clickAt(page, entry.x + 40, entry.y + 40, index === 0 ? [] : ['Shift']);
  }
  const selected = await selectionIds(page);
  expect([...selected].sort(), 'the objects the restack will act on').toEqual(
    entries.map((entry) => entry.id).sort(),
  );
}

/** Selects one object, and asserts the selection really is that object. */
async function selectOnly(page: Page, entry: LayerRect): Promise<void> {
  await selectExactly(page, [entry]);
}

const layer = (page: Page, direction: string) => page.locator(`[data-layer="${direction}"]`);

const objectField = (page: Page, key: string) =>
  page.locator(`[data-object-field="${key}"]`);

/**
 * The history entry's label, with the button's leading "Undo " removed.
 *
 * The shared `undoLabel` helper returns the button's *text*, which is `Undo <label>`, so
 * comparing it against a bare label is a category error that happened to look plausible.
 */
async function historyLabel(page: Page): Promise<string> {
  return (await undoLabel(page)).replace(/^Undo\s+/, '');
}

/** Whether the button carries the `disabled` *attribute*, as opposed to `aria-disabled`. */
async function hardDisabled(page: Page, direction: string): Promise<boolean> {
  return layer(page, direction).evaluate((el) => (el as HTMLButtonElement).disabled);
}

// ---------------------------------------------------------------------------
// The four operations
// ---------------------------------------------------------------------------

test.describe('layer order', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, LAYER_FIXTURE);
    // The fixture's paint order is the premise of every test below, so it is asserted once
    // here rather than assumed. A fixture or renderer that changed the order would otherwise
    // fail with a diff nobody could interpret.
    expect(await namedOrder(page)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
  });

  test('bring forward swaps with the object above, and is one undo step', async ({ page }) => {
    await selectOnly(page, LAYER.beta);
    await layer(page, 'forward').click();

    // Beta was under Gamma; now it is over it.
    const after = await namedOrder(page);
    expect(after.indexOf('Beta')).toBe(after.indexOf('Gamma') + 1);
    // One swap, not a shuffle: the same four objects in a different sequence.
    expect([...after].sort()).toEqual(['Alpha', 'Beta', 'Delta', 'Gamma']);

    expect(await historyLabel(page)).toBe('Bring forward');
    await page.locator('[data-edit="undo"]').click();
    expect(await namedOrder(page)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
  });

  test('send backward swaps with the object below, and is undoable and redoable', async ({ page }) => {
    await selectOnly(page, LAYER.gamma);
    await layer(page, 'backward').click();

    const after = await namedOrder(page);
    expect(after.indexOf('Gamma')).toBe(after.indexOf('Beta') - 1);
    expect(await historyLabel(page)).toBe('Send backward');

    // Undo *then* redo. Redo alone is not available here: nothing has been undone yet, so a
    // populated redo stack would be a different bug.
    await page.locator('[data-edit="undo"]').click();
    expect(await namedOrder(page)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
    await page.locator('[data-edit="redo"]').click();
    expect(await namedOrder(page)).toEqual(after);
  });

  test('bring to front moves one object to the end of the stack', async ({ page }) => {
    await selectOnly(page, LAYER.alpha);
    await layer(page, 'front').click();

    const after = await namedOrder(page);
    expect(after[after.length - 1]).toBe('Alpha');
    expect(after.slice(0, 3)).toEqual(['Beta', 'Gamma', 'Delta']);
    expect(await historyLabel(page)).toBe('Bring to front');
  });

  test('send to back moves one object to the start of the stack', async ({ page }) => {
    await selectOnly(page, LAYER.delta);
    await layer(page, 'back').click();

    const after = await namedOrder(page);
    expect(after[0]).toBe('Delta');
    expect(after.slice(1)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(await historyLabel(page)).toBe('Send to back');
  });

  test('a multi-selection restacks as one step and keeps its relative order', async ({ page }) => {
    // The claim that needs the most machinery: several objects, one command, and no
    // scrambling of the order they were already in.
    await selectExactly(page, [LAYER.alpha, LAYER.beta, LAYER.gamma]);

    // Stack order of the selection — which is what "keeps its relative order" refers to.
    const selectedBefore = (await namedOrder(page)).filter((name) =>
      ['Alpha', 'Beta', 'Gamma'].includes(name),
    );
    expect(selectedBefore).toEqual(['Alpha', 'Beta', 'Gamma']);

    await layer(page, 'front').click();

    const after = await namedOrder(page);
    expect(after.slice(-3)).toEqual(selectedBefore);
    expect(after.slice(0, 1)).toEqual(['Delta']);

    // **One** history entry for three objects, and the label says so.
    expect(await historyLabel(page)).toBe('Bring to front 3 objects');
    await page.locator('[data-edit="undo"]').click();
    expect(await namedOrder(page)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
  });

  test('a multi-selection moved one position moves only what can move', async ({ page }) => {
    // The negative control for "keeps its relative order", and the case that found a real bug.
    // `Delta` is frontmost and cannot move, so `Gamma` is blocked by it rather than stepping
    // over it — which is what front-to-back processing alone would have done, inverting the
    // order of two objects the user had selected together.
    await selectExactly(page, [LAYER.alpha, LAYER.gamma, LAYER.delta]);
    await layer(page, 'forward').click();

    const after = await namedOrder(page);
    expect(after).toEqual(['Beta', 'Alpha', 'Gamma', 'Delta']);
    expect(after.indexOf('Alpha')).toBeLessThan(after.indexOf('Gamma'));
    expect(after.indexOf('Gamma')).toBeLessThan(after.indexOf('Delta'));
  });

  test('the topmost object cannot come further forward, and nothing is recorded', async ({ page }) => {
    // The no-op rule, observed where it matters. A command that returned a fresh but *equal*
    // array would not change the order on screen — only the history — which is the half a
    // paint-order assertion cannot see.
    await selectOnly(page, LAYER.delta);
    const before = await namedOrder(page);
    expect(await undoDisabled(page)).toBe(true);

    await layer(page, 'forward').click();
    expect(await namedOrder(page)).toEqual(before);
    expect(await undoDisabled(page)).toBe(true);
  });

  test('a single object already at the front is a no-op for `front`', async ({ page }) => {
    await selectOnly(page, LAYER.delta);
    const before = await namedOrder(page);
    await layer(page, 'front').click();
    expect(await namedOrder(page)).toEqual(before);
    expect(await undoDisabled(page)).toBe(true);
  });

  test('the layer buttons are marked unavailable with nothing selected', async ({ page }) => {
    expect(await selectionCount(page)).toBe(0);
    for (const direction of ['front', 'forward', 'backward', 'back']) {
      expect(
        await layer(page, direction).getAttribute('aria-disabled'),
        `${direction} with an empty selection`,
      ).toBe('true');
    }
    // And *not* the `disabled` attribute. `disabled` drops the button out of the tab order and
    // loses its tooltip, so a user tabbing through the toolbar would find four buttons simply
    // missing with no way to discover the shortcut. `aria-disabled` keeps them focusable and
    // discoverable, which is the whole reason for the choice.
    expect(await hardDisabled(page, 'front')).toBe(false);
  });

  test('the buttons become available once something is selected', async ({ page }) => {
    expect(await layer(page, 'forward').getAttribute('aria-disabled')).toBe('true');
    await selectOnly(page, LAYER.beta);
    expect(await layer(page, 'forward').getAttribute('aria-disabled')).toBe('false');
  });

  test('even a click that gets through with nothing selected changes nothing', async ({ page }) => {
    // `aria-disabled` is feedback, not a gate: the click handler still runs and the model still
    // drops the command. Forced past Playwright's actionability check precisely because the
    // point is to prove the *handler* is harmless, not that the button is unreachable.
    const before = await namedOrder(page);
    await layer(page, 'front').click({ force: true });
    expect(await namedOrder(page)).toEqual(before);
    expect(await undoDisabled(page)).toBe(true);
  });

  test('] and [ move one position, and the command key moves to the ends', async ({ page }) => {
    await selectOnly(page, LAYER.beta);

    await page.keyboard.press(']');
    const forwarded = await namedOrder(page);
    expect(forwarded.indexOf('Beta')).toBe(forwarded.indexOf('Gamma') + 1);

    await page.keyboard.press('[');
    expect(await namedOrder(page)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);

    await page.keyboard.press('Control+]');
    const front = await namedOrder(page);
    expect(front[front.length - 1]).toBe('Beta');

    // "To back" is not "undo". It puts Beta at the *start* of the stack, which is where it
    // already was in this fixture, so the order only looks unchanged by coincidence — and
    // comparing it to the original would be asserting the fixture rather than the command.
    await page.keyboard.press('Control+[');
    expect(await namedOrder(page)).toEqual(['Beta', 'Alpha', 'Gamma', 'Delta']);
  });

  test('with everything selected, none of the four operations can change anything', async ({
    page,
  }) => {
    // The set is already the whole stack, so "to the ends" cannot reorder it — and neither can
    // "one position", because every object's neighbour is itself selected and there is nothing
    // to trade with. A naive implementation that removed and re-appended for `front`, or that
    // ignored the blocked move for `forward`, would produce a *new array* and a new document:
    // `documentsEqual` would call it unchanged, so the order on screen would match while the
    // saved file differed. This is the case that pins both.
    await page.keyboard.press('Control+a');
    expect(await selectionCount(page)).toBe(4);

    const before = await namedOrder(page);
    for (const direction of ['front', 'forward', 'backward', 'back']) {
      await layer(page, direction).click();
      expect(await namedOrder(page), `${direction} with everything selected`).toEqual(before);
      expect(await undoDisabled(page), `${direction} recorded something`).toBe(true);
    }
  });

  test('a restack does not move, resize or restyle anything', async ({ page }) => {
    // Paint order is a property of the sequence, not of the objects. A restack that rewrote a
    // node would be an edit to every object in the selection, and every geometry assertion
    // here would still pass.
    const geometryBefore = await readGeometry(page);
    const styleBefore = await readStyles(page);
    await selectOnly(page, LAYER.beta);
    await layer(page, 'front').click();
    expect(await readGeometry(page)).toEqual(geometryBefore);
    expect(await readStyles(page)).toEqual(styleBefore);
  });
});

// ---------------------------------------------------------------------------
// Overlapping objects: paint order decides what a click finds
// ---------------------------------------------------------------------------

/**
 * A restack acts on the **current selection**, so a test that clicks between restacks is
 * restacking whatever the last click selected. Stated because getting it wrong produces a
 * failure that looks like a bug in the command.
 */
test.describe('paint order decides hit testing', () => {
  test('the frontmost object wins a click on the overlap', async ({ page }) => {
    await mountFixture(page, OVERLAP_FIXTURE);
    const shared = { x: OVERLAP_UNDER.x + 50, y: OVERLAP_UNDER.y + 50 };

    // `Over` is later in the array, so it paints on top and hit testing finds it first.
    await clickAt(page, shared.x, shared.y);
    expect(await selectionIds(page)).toEqual([OVERLAP_OVER.id]);
  });

  test('a locked object on top is skipped, and alt-click is how you reach it', async ({ page }) => {
    // The strongest available statement of "a click is not a marquee" and "the editor is the
    // authority": `Over` is painted on top, so `document.elementFromPoint` at this point
    // returns it and nothing else. The editor returns `Under`, because hit testing is a walk of
    // the model that skips locked objects. Alt-click includes them again.
    await mountFixture(page, LOCKED_OVERLAP_FIXTURE);
    const shared = { x: LOCKED_UNDER.x + 50, y: LOCKED_UNDER.y + 50 };

    const topmost = await page.evaluate((point) => {
      const el = document.elementFromPoint(point.x, point.y);
      return el === null ? null : ((el as HTMLElement).dataset['oid'] ?? el.className);
    }, await clientPoint(page, shared));
    expect(topmost, 'the browser would find the locked, painted-on-top object').toBe(
      LOCKED_OVER.id,
    );

    await clickAt(page, shared.x, shared.y);
    expect(await selectionIds(page), 'the editor skips it').toEqual([LOCKED_UNDER.id]);

    await clickAt(page, shared.x, shared.y, ['Alt']);
    expect(await selectionIds(page), 'alt includes locked objects').toEqual([LOCKED_OVER.id]);
  });

  test('restacking does not change which object a locked one hides', async ({ page }) => {
    await mountFixture(page, LOCKED_OVERLAP_FIXTURE);
    const shared = { x: LOCKED_UNDER.x + 50, y: LOCKED_UNDER.y + 50 };

    await clickAt(page, shared.x, shared.y);
    expect(await selectionIds(page)).toEqual([LOCKED_UNDER.id]);

    // `Under` is the selection, so `front` moves *it* to the end -- past the locked object that
    // is painted over it.
    await layer(page, 'front').click();
    expect(await namedLockedOverlapOrder(page)).toEqual(['Over', 'Under']);

    // Paint order has changed and the answer has not, which is the claim: a locked object is
    // skipped because the model says so, not because of where it happens to sit.
    await clickAt(page, shared.x, shared.y);
    expect(await selectionIds(page), 'still the un-locked one, frontmost or not').toEqual([
      LOCKED_UNDER.id,
    ]);
  });

  test('sending the top object to the back hands the click to the one below', async ({ page }) => {
    await mountFixture(page, OVERLAP_FIXTURE);
    const shared = { x: OVERLAP_UNDER.x + 50, y: OVERLAP_UNDER.y + 50 };

    await clickAt(page, shared.x, shared.y);
    expect(await selectionIds(page)).toEqual([OVERLAP_OVER.id]);
    await layer(page, 'back').click();
    expect(await namedOverlapOrder(page)).toEqual(['Over', 'Under']);

    // Now a plain click finds `Under`, which is frontmost.
    await clickAt(page, shared.x, shared.y);
    expect(await selectionIds(page)).toEqual([OVERLAP_UNDER.id]);
  });

  test('a restack acts on the selection, so two in a row are not inverses', async ({ page }) => {
    // The rule that is easy to get wrong in a test and worth stating: `restack` moves the
    // *current selection*, and the click in between changes the selection. So `back` then
    // `front` is not a round trip -- the second one acts on whatever the click found.
    await mountFixture(page, OVERLAP_FIXTURE);
    const shared = { x: OVERLAP_UNDER.x + 50, y: OVERLAP_UNDER.y + 50 };
    // Inside `Over` but outside `Under`, so this point names one object and not the other.
    const onlyOver = { x: OVERLAP_OVER.x + OVERLAP_OVER.width - 20, y: OVERLAP_OVER.y + 110 };

    await clickAt(page, shared.x, shared.y);
    expect(await selectionIds(page)).toEqual([OVERLAP_OVER.id]);
    await layer(page, 'back').click();
    expect(await namedOverlapOrder(page)).toEqual(['Over', 'Under']);

    // A plain click on the overlap now finds `Under`, because it is frontmost.
    await clickAt(page, shared.x, shared.y);
    expect(await selectionIds(page)).toEqual([OVERLAP_UNDER.id]);

    // `front` acts on `Under`, which is already at the end: a no-op. The evidence is the
    // *label*, not an empty history -- the `back` above is still on the stack, so a fresh entry
    // would show as a different top label rather than as an enabled undo button.
    await layer(page, 'front').click();
    expect(await namedOverlapOrder(page)).toEqual(['Over', 'Under']);
    expect(await historyLabel(page), 'the no-op restack went on the stack').toBe('Send to back');

    // Selecting `Over` explicitly and bringing it forward does move it, which is what makes the
    // line above a no-op about the *object* rather than about the command.
    await clickAt(page, onlyOver.x, onlyOver.y);
    expect(await selectionIds(page)).toEqual([OVERLAP_OVER.id]);
    await layer(page, 'front').click();
    expect(await namedOverlapOrder(page)).toEqual(['Under', 'Over']);
    await clickAt(page, shared.x, shared.y);
    expect(await selectionIds(page)).toEqual([OVERLAP_OVER.id]);
  });

  test('shift-clicking a different object adds it, and shift-clicking a selected one removes it', async ({
    page,
  }) => {
    // "A click is not a marquee" has to survive the new buttons. Two claims, and the second has
    // a rule worth stating: shift on an *unselected* object adds it, shift on a *selected* one
    // removes it — deferred to pointer-up, because until the pointer moves the two are
    // indistinguishable, and a drag has to move the selection rather than shrink it.
    await mountFixture(page, OVERLAP_FIXTURE);
    const shared = { x: OVERLAP_UNDER.x + 50, y: OVERLAP_UNDER.y + 50 };
    const elsewhere = { x: OVERLAP_UNDER.x + OVERLAP_UNDER.width - 10, y: OVERLAP_UNDER.y + 10 };

    await clickAt(page, shared.x, shared.y);
    expect(await selectionIds(page)).toEqual([OVERLAP_OVER.id]);

    await clickAt(page, elsewhere.x, elsewhere.y, ['Shift']);
    expect((await selectionIds(page)).length, 'shift on a new object adds it').toBe(2);

    await clickAt(page, shared.x, shared.y, ['Shift']);
    expect(
      await selectionIds(page),
      'shift on a selected object removes it, leaving the other',
    ).toEqual([OVERLAP_UNDER.id]);
  });
});

// ---------------------------------------------------------------------------
// The document layer and the chrome layer
// ---------------------------------------------------------------------------

test.describe('the document and the chrome do not share attribute names', () => {
  test('one element per object carries `data-oid`', async ({ page }) => {
    // The overlay used to write `data-oid` on its outline group as well as the renderer writing
    // it on the object, so `[data-oid="x"]` matched two elements in two different layers and
    // Playwright reported a strict-mode violation on a locator that had looked reasonable. The
    // overlay's marker is `data-for` now.
    //
    // Asserted as a count rather than as "the selector works", because the failure mode is two
    // matches: any test that reads `data-oid` and happens to be looking at a selection would
    // have got a plausible wrong answer instead of an error.
    await mountFixture(page, LAYER_FIXTURE);
    await selectExactly(page, [LAYER.beta, LAYER.gamma]);

    const counts = await page.evaluate((ids) => {
      const out: Record<string, number> = {};
      for (const id of ids) {
        out[id] = document.querySelectorAll(`[data-oid="${id}"]`).length;
      }
      return out;
    }, IDS.map((entry) => entry.id));

    for (const entry of IDS) {
      expect(counts[entry.id], `${entry.name} is stamped exactly once`).toBe(1);
    }
    // And the overlay does mark the selection, under its own name.
    expect(
      await page.locator('.p1-overlay-group--selection[data-for]').count(),
      'the selection overlay marks which object each outline is for',
    ).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Multi-selection: what is already true, pinned so it cannot quietly regress
// ---------------------------------------------------------------------------

// No `beforeEach`: the rotated case mounts its own document, and a shared mount would leave two
// init scripts registered on the page, with the later one silently winning.
test.describe('multi-selection still behaves', () => {
  test('a drag moves every selected object by the same delta, keeping relative positions', async ({
    page,
  }) => {
    await mountFixture(page, LAYER_FIXTURE);
    await selectExactly(page, [LAYER.alpha, LAYER.gamma]);
    const before = await readGeometry(page);

    // One gesture, on one of the selected objects. The second was selected with a shift-click,
    // which is the combination that used to lose every pointer event after the first.
    await drag(
      page,
      { x: LAYER.alpha.x + 40, y: LAYER.alpha.y + 40 },
      { x: LAYER.alpha.x + 100, y: LAYER.alpha.y + 40 },
    );

    const after = await readGeometry(page);
    const dx = boxOf(after, LAYER.alpha).x - boxOf(before, LAYER.alpha).x;
    const dy = boxOf(after, LAYER.alpha).y - boxOf(before, LAYER.alpha).y;

    // The **full** delta, not merely "something moved". A cancelled pointer applied exactly
    // one-eighth of an eight-step drag, which is more than zero and not obviously wrong.
    expect(dx, 'the whole 60px drag was applied').toBeCloseTo(60, 1);
    expect(dy, 'a horizontal drag moves nothing vertically').toBeCloseTo(0, 1);

    // Relative positions preserved.
    expect(boxOf(after, LAYER.gamma).x - boxOf(before, LAYER.gamma).x).toBeCloseTo(dx, 1);
    expect(boxOf(after, LAYER.gamma).y - boxOf(before, LAYER.gamma).y).toBeCloseTo(dy, 1);
    // And the one that was not selected stayed put.
    expect(boxOf(after, LAYER.beta).x).toBeCloseTo(boxOf(before, LAYER.beta).x, 1);

    // One entry for the whole gesture.
    expect(await historyLabel(page)).toBe('Move 2 objects');
    await page.locator('[data-edit="undo"]').click();
    expect(await readGeometry(page)).toEqual(before);
  });

  test('deleting a multi-selection is one undo step', async ({ page }) => {
    await mountFixture(page, LAYER_FIXTURE);
    await selectExactly(page, [LAYER.alpha, LAYER.delta]);

    await page.keyboard.press('Delete');
    expect(await selectionCount(page)).toBe(0);
    expect(await namedOrder(page)).toEqual(['Beta', 'Gamma']);
    expect(await historyLabel(page)).toBe('Delete 2 objects');

    await page.locator('[data-edit="undo"]').click();
    expect(await namedOrder(page)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
  });

  test('selecting all, then shift-clicking one, removes just that one', async ({ page }) => {
    await mountFixture(page, LAYER_FIXTURE);
    await page.keyboard.press('Control+a');
    expect(await selectionCount(page)).toBe(4);

    await clickAt(page, LAYER.gamma.x + 40, LAYER.gamma.y + 40, ['Shift']);
    const selected = (await selectionIds(page)).sort();
    expect(selected.length).toBe(3);
    expect(selected).not.toContain(LAYER.gamma.id);
  });

  test('a resize handle resizes only the object it belongs to, even in a multi-selection', async ({
    page,
  }) => {
    // Existing and deliberate: a handle belongs to one box, and resizing all of them from one
    // box's corner is not what the user grabbed. Pinned because M8 considered group resize and
    // rejected it (ADR 0008 §4), and this is the line that rejection rests on.
    await mountFixture(page, LAYER_FIXTURE);
    await selectExactly(page, [LAYER.alpha, LAYER.gamma]);
    const before = await readGeometry(page);

    const handle = await page
      .locator('.p1-overlay-group--selection[data-for="node_alpha"] [data-handle="se"]')
      .boundingBox();
    if (handle === null) throw new Error('alpha has no bottom-right handle');

    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + 60, handle.y + 40, { steps: 6 });
    await page.mouse.up();

    const after = await readGeometry(page);
    expect(boxOf(after, LAYER.alpha).width).toBeGreaterThan(boxOf(before, LAYER.alpha).width);
    // Gamma untouched. A "resize everything" implementation fails exactly here.
    expect(boxOf(after, LAYER.gamma).width).toBeCloseTo(boxOf(before, LAYER.gamma).width, 1);
    expect(boxOf(after, LAYER.gamma).x).toBeCloseTo(boxOf(before, LAYER.gamma).x, 1);
  });

  test('a rotated object is selected by its own box, not by its painted extent', async ({ page }) => {
    // The rotated case in the milestone's list. The object's *painted* extent is larger than
    // its box, but selection is against the model box, so a click clear of the box selects
    // nothing even though ink is nearby. This is the M2 rule, stated as a test.
    await mountFixture(page, ROTATED_FIXTURE);

    await clickAt(page, ROTATED.x + ROTATED.width / 2, ROTATED.y + ROTATED.height / 2);
    expect(await selectionIds(page)).toEqual([ROTATED.id]);

    // Well clear of the box, on the side the rotation sweeps into.
    await page.keyboard.press('Escape');
    await clickAt(page, ROTATED.x + ROTATED.width + 40, ROTATED.y + ROTATED.height + 30);
    expect(await selectionCount(page)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test.describe('a restacked document survives a reload', () => {
  test('the paint order on disk is the paint order on screen', async ({ browser }) => {
    const first = await browser.newContext();
    const page = await first.newPage();
    await mountSample(page);

    // A real edit first, so the round trip is not a document that never changed.
    await page.locator('[data-shape="rect"]').click();
    await drag(page, { x: 500, y: 400 }, { x: 600, y: 480 });
    await page.keyboard.press('Control+a');
    expect(await selectionCount(page), 'the sample plus the drawn rect are both selected').toBe(3);

    await layer(page, 'backward').click();
    const onScreen = await paintOrder(page);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('[data-doc="save"]').click(),
    ]);
    const path = await download.path();
    if (path === null) throw new Error('the download produced no file');
    const text = await readFile(path, 'utf8');

    // The claim, read off the file rather than the model: the order the editor showed is the
    // order that was written.
    const onDisk = (
      JSON.parse(text) as { pages: Array<{ objects: Array<{ id: string }> }> }
    ).pages[0]?.objects.map((node) => node.id);
    expect(onDisk).toEqual(onScreen);
    await first.close();

    // And it comes back in a fresh browser, in that order. A *new context*, not a reload:
    // `addInitScript` is context-level, so a reload would still be running under the sample.
    const second = await browser.newContext();
    const reopened = await second.newPage();
    await mountSample(reopened);
    await reopened.locator('[data-file-input="document"]').setInputFiles({
      name: 'reordered.p1doc',
      mimeType: 'application/json',
      buffer: Buffer.from(text, 'utf8'),
    });
    await reopened.waitForFunction(
      (name) => document.querySelector('[data-stat="name"]')?.textContent === name,
      'reordered.p1doc',
    );
    expect(await paintOrder(reopened)).toEqual(onScreen);
    await second.close();
  });

  test('saving a restacked document and reopening it gives identical bytes', async ({ browser }) => {
    const first = await browser.newContext();
    const page = await first.newPage();
    await mountFixture(page, LAYER_FIXTURE);
    await selectExactly(page, [LAYER.beta, LAYER.gamma]);
    await layer(page, 'front').click();
    const expected = await namedOrder(page);
    expect(expected, 'the restack actually happened').not.toEqual([
      'Alpha',
      'Beta',
      'Gamma',
      'Delta',
    ]);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('[data-doc="save"]').click(),
    ]);
    const path = await download.path();
    if (path === null) throw new Error('the download produced no file');
    const saved = await readFile(path, 'utf8');
    await first.close();

    const second = await browser.newContext();
    const reopened = await second.newPage();
    await mountSample(reopened);
    await reopened.locator('[data-file-input="document"]').setInputFiles({
      name: 'reordered.p1doc',
      mimeType: 'application/json',
      buffer: Buffer.from(saved, 'utf8'),
    });
    await reopened.waitForFunction(
      (name) => document.querySelector('[data-stat="name"]')?.textContent === name,
      'reordered.p1doc',
    );
    expect(await namedOrder(reopened), 'the order survived the file').toEqual(expected);

    const [again] = await Promise.all([
      reopened.waitForEvent('download'),
      reopened.locator('[data-doc="save"]').click(),
    ]);
    const againPath = await again.path();
    if (againPath === null) throw new Error('the second download produced no file');
    expect(await readFile(againPath, 'utf8'), 'byte identity across a real boundary').toBe(saved);
    await second.close();
  });
});

// ---------------------------------------------------------------------------
// Shared object properties, multi-selection aware
// ---------------------------------------------------------------------------

// No `beforeEach`: two tests here need a document this one does not, and a shared mount would
// register a second init script that silently wins.
test.describe('mixed object properties', () => {
  test('opacity is editable for a shape', async ({ page }) => {
    await mountFixture(page, LAYER_FIXTURE);
    await selectOnly(page, LAYER.beta);
    await objectField(page, 'opacity').fill('0.5');
    await objectField(page, 'opacity').blur();

    expect(await objectField(page, 'opacity').inputValue()).toBe('0.5');
    expect(await readStyle(page, LAYER.beta.id, 'opacity')).toBe('0.5');
  });

  test('every object field is reachable for a text frame', async ({ page }) => {
    // The limitation M3 recorded and M8 closes. These live in the Transform section precisely
    // because that is the only section shown for a selection of mixed types — the Appearance
    // section is filtered to shapes, which is why a text frame's opacity was unreachable.
    await mountSample(page);
    const frame = page.locator('[data-page] [data-type="textFrame"]').first();
    const frameId = await frame.getAttribute('data-oid');
    expect(frameId, 'the sample document has a text frame').not.toBeNull();
    await frame.click();

    for (const key of ['visible', 'locked', 'opacity', 'blendMode']) {
      expect(await objectField(page, key).count(), `${key} is reachable for a text frame`).toBe(1);
    }
    await objectField(page, 'opacity').fill('0.4');
    await objectField(page, 'opacity').blur();
    expect(await readStyle(page, frameId ?? '', 'opacity')).toBe('0.4');
  });

  test('a disagreeing property reads Mixed and never a member value', async ({ page }) => {
    await mountFixture(page, LAYER_FIXTURE);
    await selectOnly(page, LAYER.alpha);
    await objectField(page, 'opacity').fill('0.25');
    await objectField(page, 'opacity').blur();
    await selectOnly(page, LAYER.beta);
    await objectField(page, 'opacity').fill('0.75');
    await objectField(page, 'opacity').blur();

    await selectExactly(page, [LAYER.alpha, LAYER.beta]);

    const field = objectField(page, 'opacity');
    expect(await field.inputValue(), 'a mixed field shows no value').toBe('');
    expect(await field.getAttribute('placeholder')).toBe('Mixed');
    expect(await field.getAttribute('data-mixed')).toBe('true');
    // The negative control: neither member's value leaked in.
    expect(await field.inputValue()).not.toBe('0.25');
    expect(await field.inputValue()).not.toBe('0.75');
    // The section agrees.
    expect(await page.locator('[data-inspector="transform"]').getAttribute('data-state')).toBe(
      'mixed',
    );
  });

  test('an agreeing property is shown once, for any number of objects', async ({ page }) => {
    await mountFixture(page, LAYER_FIXTURE);
    await selectExactly(page, [LAYER.alpha, LAYER.gamma, LAYER.delta]);
    expect(await objectField(page, 'opacity').inputValue()).toBe('1');
    expect(await objectField(page, 'opacity').getAttribute('data-mixed')).toBe('false');
    expect(await objectField(page, 'visible').isChecked()).toBe(true);
  });

  test('one commit sets the property on every selected object, as one undo step', async ({ page }) => {
    await mountFixture(page, LAYER_FIXTURE);
    await selectExactly(page, [LAYER.alpha, LAYER.gamma]);
    await objectField(page, 'opacity').fill('0.3');
    await objectField(page, 'opacity').blur();

    await selectExactly(page, [LAYER.alpha, LAYER.beta, LAYER.gamma]);
    await objectField(page, 'opacity').fill('0.8');
    await objectField(page, 'opacity').blur();

    for (const entry of [LAYER.alpha, LAYER.beta, LAYER.gamma]) {
      expect(await readStyle(page, entry.id, 'opacity'), `${entry.name} took the value`).toBe('0.8');
    }
    // One entry for the three objects, and undo takes all three back together.
    expect(await historyLabel(page)).toBe('Opacity 3 objects');
    await page.locator('[data-edit="undo"]').click();
    expect(await readStyle(page, LAYER.alpha.id, 'opacity')).toBe('0.3');
    expect(await readStyle(page, LAYER.gamma.id, 'opacity')).toBe('0.3');
    expect(await readStyle(page, LAYER.beta.id, 'opacity'), 'untouched by the first commit').toBe(
      '1',
    );
    // The first commit is still on the stack, which is the check that the second was a single
    // entry rather than three.
    expect(await historyLabel(page)).toBe('Opacity 2 objects');
  });

  test('re-committing the value already shown records nothing', async ({ page }) => {
    // The §4.2 no-op rule, reached through the new fields. Every inspector field is
    // re-committed whenever it loses focus, so a field that recorded an entry for the value
    // already displayed would fill the history with steps that do nothing.
    await mountFixture(page, LAYER_FIXTURE);
    await selectOnly(page, LAYER.beta);
    await objectField(page, 'opacity').fill('0.5');
    await objectField(page, 'opacity').blur();
    expect(await historyLabel(page)).toBe('Opacity');

    // Focus and blur again without changing anything.
    await objectField(page, 'opacity').click();
    await objectField(page, 'opacity').blur();
    await page.locator('[data-edit="undo"]').click();
    expect(
      await readStyle(page, LAYER.beta.id, 'opacity'),
      'the one real change is all the history holds',
    ).toBe('1');
    expect(await undoDisabled(page)).toBe(true);
  });

  test('a hidden object cannot be clicked, but a marquee still reaches it', async ({ page }) => {
    // The recovery path, and the reason it exists. Hiding an object is one click in the
    // inspector, so an object that could not be selected afterwards could never be un-hidden:
    // the field would be a one-way door. A click is a point gesture and there is nothing to
    // click; a marquee is a region gesture, and drawing a box around it is unambiguous.
    await mountFixture(page, LAYER_FIXTURE);
    await selectOnly(page, LAYER.beta);
    await objectField(page, 'visible').uncheck();
    expect(await readStyle(page, LAYER.beta.id, 'display')).toBe('none');

    await clearSelection(page);
    await clickAt(page, LAYER.beta.x + 40, LAYER.beta.y + 40);
    expect(await selectionCount(page), 'a hidden object cannot be clicked').toBe(0);

    // A marquee across the whole page takes it, hidden or not.
    await drag(page, { x: 20, y: 20 }, { x: 420, y: 280 });
    expect(await selectionIds(page), 'the marquee reached the hidden object').toContain(
      LAYER.beta.id,
    );

    // And with it selected, the way back is the same field that hid it.
    await objectField(page, 'visible').check();
    expect(await readStyle(page, LAYER.beta.id, 'display')).toBe('');
  });

  test('a mixed boolean is indeterminate, and setting it applies to both', async ({ page }) => {
    // One object hidden, one not, both selected -- which needs the marquee, for the reason in
    // the test above. An unchecked box is the only honest rendering of a disagreement, and
    // setting it must apply to *both*.
    await mountFixture(page, LAYER_FIXTURE);
    await selectOnly(page, LAYER.beta);
    await objectField(page, 'visible').uncheck();

    await clearSelection(page);
    await drag(page, { x: 20, y: 20 }, { x: 420, y: 280 });
    const selected = await selectionIds(page);
    expect(selected.length, 'both objects are selected').toBe(4);

    const box = objectField(page, 'visible');
    expect(await box.getAttribute('data-mixed'), 'one hidden, three not').toBe('true');
    expect(await box.isChecked(), 'a mixed boolean is not simply checked').toBe(false);

    await box.check();
    for (const entry of IDS) {
      expect(await readStyle(page, entry.id, 'display'), `${entry.name} is shown`).toBe('');
    }
  });

  test('a locked object is reachable with alt-click but not with a marquee', async ({ page }) => {
    // The asymmetry with `visible`, stated so the two are not confused. Locking is a barrier
    // rather than a hiding place: alt-click is the way through, and a marquee honours it.
    await mountFixture(page, LOCKED_OVERLAP_FIXTURE);
    const shared = { x: LOCKED_UNDER.x + 50, y: LOCKED_UNDER.y + 50 };

    await clearSelection(page);
    await drag(page, { x: 20, y: 20 }, { x: 420, y: 280 });
    expect(await selectionIds(page), 'the marquee skipped the locked object').not.toContain(
      LOCKED_OVER.id,
    );

    await clickAt(page, shared.x, shared.y, ['Alt']);
    expect(await selectionIds(page)).toEqual([LOCKED_OVER.id]);
  });

  test('an unparseable value restores what was shown and writes nothing', async ({ page }) => {
    await mountFixture(page, LAYER_FIXTURE);
    await selectOnly(page, LAYER.beta);
    await objectField(page, 'opacity').fill('0.5');
    await objectField(page, 'opacity').blur();

    await objectField(page, 'opacity').fill('half');
    await objectField(page, 'opacity').blur();
    // Restored rather than clamped or zeroed.
    expect(await objectField(page, 'opacity').inputValue()).toBe('0.5');
    expect(await readStyle(page, LAYER.beta.id, 'opacity')).toBe('0.5');

    // And out of range is refused too: 0..1 is the model's range, and clamping would write
    // something the user did not ask for.
    await objectField(page, 'opacity').fill('4');
    await objectField(page, 'opacity').blur();
    expect(await readStyle(page, LAYER.beta.id, 'opacity')).toBe('0.5');

    // An unrecognised blend mode is refused the same way, rather than written as a string the
    // renderer would silently ignore. The *field* is the evidence: the renderer omits
    // `mix-blend-mode` entirely for `normal`, so the computed style cannot distinguish "normal"
    // from "never written".
    expect(await objectField(page, 'blendMode').inputValue()).toBe('normal');
    await objectField(page, 'blendMode').fill('not-a-blend-mode');
    await objectField(page, 'blendMode').blur();
    expect(await objectField(page, 'blendMode').inputValue()).toBe('normal');

    await objectField(page, 'blendMode').fill('multiply');
    await objectField(page, 'blendMode').blur();
    expect(await objectField(page, 'blendMode').inputValue()).toBe('multiply');
    // `getPropertyValue` takes the CSS name, not the DOM property name. `opacity` and `display`
    // are single words so both spellings work, which is exactly why this one is worth a
    // comment: writing `mixBlendMode` here reads correctly and silently returns nothing.
    expect(await readStyle(page, LAYER.beta.id, 'mix-blend-mode')).toBe('multiply');
  });

  test('selecting a mix of node types still answers every object field', async ({ page }) => {
    // A rect and a text frame have no shared answer for a *shape* property, but the object
    // properties are on every node, so they must answer.
    await mountFixture(page, MIXED_FIXTURE);
    const rect = await page
      .locator('[data-page] [data-type="shape"]')
      .first()
      .getAttribute('data-oid');
    const frame = await page
      .locator('[data-page] [data-type="textFrame"]')
      .first()
      .getAttribute('data-oid');
    expect(rect).not.toBeNull();
    expect(frame).not.toBeNull();

    await page.locator(`[data-page] [data-oid="${rect}"]`).click();
    await page.locator(`[data-page] [data-oid="${frame}"]`).click({ modifiers: ['Shift'] });
    expect(await selectionCount(page)).toBe(2);

    expect(await objectField(page, 'opacity').inputValue()).toBe('1');
    await objectField(page, 'opacity').fill('0.6');
    await objectField(page, 'opacity').blur();
    expect(await readStyle(page, rect ?? '', 'opacity')).toBe('0.6');
    expect(await readStyle(page, frame ?? '', 'opacity')).toBe('0.6');
  });
});

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/** An inline style property off the rendered object, so the DOM is the evidence. */
function readStyle(page: Page, id: string, property: string): Promise<string> {
  return page
    .locator(`[data-page] [data-oid="${id}"]`)
    .evaluate((el, name) => (el as HTMLElement).style.getPropertyValue(name), property);
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Geometry = Record<string, Box>;

/** One object's box, or a failure naming the id that is not there. */
function boxOf(geometry: Geometry, entry: { id: string; name: string }): Box {
  const box = geometry[entry.id];
  if (box === undefined) {
    throw new Error(
      `"${entry.name}" (${entry.id}) is not rendered. Rendered ids: ${JSON.stringify(
        Object.keys(geometry),
      )}`,
    );
  }
  return box;
}

/**
 * Every object's transform, read off the rendered style — so a restack cannot fake it.
 *
 * Scoped to the page: the overlay is chrome, and carries its own per-object marker.
 */
function readGeometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const out: Record<string, { x: number; y: number; width: number; height: number }> = {};
    for (const el of document.querySelectorAll('[data-page] [data-oid]')) {
      const node = el as HTMLElement;
      const id = node.dataset['oid'] ?? '';
      const left = Number.parseFloat(node.style.left);
      const top = Number.parseFloat(node.style.top);
      const width = Number.parseFloat(node.style.width);
      const height = Number.parseFloat(node.style.height);
      if (!Number.isFinite(left)) throw new Error(`object "${id}" has no readable left`);
      out[id] = { x: left, y: top, width, height };
    }
    return out;
  });
}

/** Every object's fill and opacity, to catch a restack that rewrote a node. */
function readStyles(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const el of document.querySelectorAll('[data-page] [data-oid]')) {
      const node = el as HTMLElement;
      const id = node.dataset['oid'] ?? '';
      out[id] = `${node.style.backgroundColor}|${node.style.opacity}`;
    }
    return out;
  });
}

/** A page-local document point in client coordinates, for `elementFromPoint` comparisons. */
async function clientPoint(page: Page, point: { x: number; y: number }) {
  return page.evaluate((doc) => {
    const pageElement = document.querySelector('[data-page]');
    const stack = document.querySelector('[data-pages]');
    if (!(pageElement instanceof HTMLElement) || !(stack instanceof HTMLElement)) {
      throw new Error('no page stack');
    }
    const scale = new DOMMatrixReadOnly(getComputedStyle(stack).transform).a;
    const box = pageElement.getBoundingClientRect();
    return { x: box.x + doc.x * scale, y: box.y + doc.y * scale };
  }, point);
}

/** The overlap fixture's order by name, for the tests that use only that document. */
async function namedOverlapOrder(page: Page): Promise<string[]> {
  return nameById(await paintOrder(page), [
    { id: OVERLAP_UNDER.id, name: 'Under' },
    { id: OVERLAP_OVER.id, name: 'Over' },
  ]);
}

/** The locked-overlap fixture's order by name. */
async function namedLockedOverlapOrder(page: Page): Promise<string[]> {
  return nameById(await paintOrder(page), [
    { id: LOCKED_UNDER.id, name: 'Under' },
    { id: LOCKED_OVER.id, name: 'Over' },
  ]);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface LayerRect {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Four non-overlapping rects in a known paint order.
 *
 * Written here rather than imported from another suite's fixture, because this file's tests
 * assert *the order*, and a shared constant would make a change there a failure here three
 * files away. Ids are stated in the source and restated in `LAYER` below, which is redundant on
 * purpose: a wrong id in a click helper fails as "nothing was selected", which is the least
 * informative symptom there is.
 */
const LAYER_FIXTURE = `() => {
  const node = (id, name, x, y, width, height) => ({
    type: 'shape', id, name,
    transform: { x, y, width, height, rotation: 0, scaleX: 1, scaleY: 1 },
    visible: true, locked: false, opacity: 1, blendMode: 'normal',
    shape: { kind: 'rect', cornerRadius: 0 },
    fill: { type: 'solid', color: '#3366ff' },
  });
  return {
    formatVersion: 1, id: 'layers', name: 'Layers',
    pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
    assets: {},
    pages: [{
      id: 'p1', name: '1',
      background: { type: 'solid', color: '#ffffff' },
      // Paint order: alpha, beta, gamma, delta.
      objects: [
        node('node_alpha', 'Alpha', 40, 40, 120, 80),
        node('node_beta', 'Beta', 200, 40, 120, 80),
        node('node_gamma', 'Gamma', 40, 170, 120, 80),
        node('node_delta', 'Delta', 200, 170, 120, 80),
      ],
    }],
  };
}`;

const LAYER = {
  alpha: { id: 'node_alpha', name: 'Alpha', x: 40, y: 40, width: 120, height: 80 },
  beta: { id: 'node_beta', name: 'Beta', x: 200, y: 40, width: 120, height: 80 },
  gamma: { id: 'node_gamma', name: 'Gamma', x: 40, y: 170, width: 120, height: 80 },
  delta: { id: 'node_delta', name: 'Delta', x: 200, y: 170, width: 120, height: 80 },
} as const satisfies Record<string, LayerRect>;

const IDS: readonly LayerRect[] = [LAYER.alpha, LAYER.beta, LAYER.gamma, LAYER.delta];

/** Two rects occupying the same pixels, so hit testing has to choose between them. */
const OVERLAP_UNDER = { id: 'node_under', name: 'Under', x: 60, y: 60, width: 160, height: 120 };
const OVERLAP_OVER = { id: 'node_over', name: 'Over', x: 100, y: 90, width: 160, height: 120 };

/** The same two rects, with the one painted on top locked. */
const LOCKED_UNDER = { id: 'node_lunder', name: 'Under', x: 60, y: 60, width: 160, height: 120 };
const LOCKED_OVER = { id: 'node_lover', name: 'Over', x: 100, y: 90, width: 160, height: 120 };

/**
 * One fixture builder for both overlap documents.
 *
 * The `locked` flag is the whole difference between them, and sharing the builder keeps the two
 * definitions from drifting apart in a way that would quietly change what the locked test is
 * testing.
 */
const overlapFixture = (underId: string, overId: string, lockOver: boolean) => `() => {
  const node = (id, name, x, y, width, height, color, locked) => ({
    type: 'shape', id, name,
    transform: { x, y, width, height, rotation: 0, scaleX: 1, scaleY: 1 },
    visible: true, locked, opacity: 1, blendMode: 'normal',
    shape: { kind: 'rect', cornerRadius: 0 },
    fill: { type: 'solid', color },
  });
  return {
    formatVersion: 1, id: 'overlap', name: 'Overlap',
    pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
    assets: {},
    pages: [{
      id: 'p1', name: '1',
      background: { type: 'solid', color: '#ffffff' },
      // The later entry paints on top.
      objects: [
        node('${underId}', 'Under', ${OVERLAP_UNDER.x}, ${OVERLAP_UNDER.y}, ${OVERLAP_UNDER.width}, ${OVERLAP_UNDER.height}, '#ff0000', false),
        node('${overId}', 'Over', ${OVERLAP_OVER.x}, ${OVERLAP_OVER.y}, ${OVERLAP_OVER.width}, ${OVERLAP_OVER.height}, '#00ff00', ${lockOver}),
      ],
    }],
  };
}`;

const OVERLAP_FIXTURE = overlapFixture(OVERLAP_UNDER.id, OVERLAP_OVER.id, false);

// The locked, painted-on-top object is the strongest available case of the editor and the
// browser disagreeing about what was clicked: `elementFromPoint` can only ever return it.
const LOCKED_OVERLAP_FIXTURE = overlapFixture(LOCKED_UNDER.id, LOCKED_OVER.id, true);

/** A rotated rect, for the "selection is the model box, not the painted extent" case. */
const ROTATED = { id: 'node_rot', name: 'Rot', x: 80, y: 80, width: 200, height: 50 };

const ROTATED_FIXTURE = `() => ({
  formatVersion: 1, id: 'rot', name: 'Rotated',
  pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [{
      type: 'shape', id: 'node_rot', name: 'Rot',
      transform: { x: ${ROTATED.x}, y: ${ROTATED.y}, width: ${ROTATED.width}, height: ${ROTATED.height},
                   rotation: 0.5235987755982988, scaleX: 1, scaleY: 1 },
      visible: true, locked: false, opacity: 1, blendMode: 'normal',
      shape: { kind: 'rect', cornerRadius: 0 },
      fill: { type: 'solid', color: '#3366ff' },
    }],
  }],
})`;

/** A rect and a text frame, for the mixed-type selection. */
const MIXED_FIXTURE = `() => ({
  formatVersion: 1, id: 'mixed', name: 'Mixed',
  pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [
      { type: 'shape', id: 'node_mix_rect', name: 'Rect',
        transform: { x: 40, y: 40, width: 120, height: 60, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#3366ff' } },
      { type: 'textFrame', id: 'node_mix_text', name: 'Text',
        transform: { x: 40, y: 140, width: 200, height: 60, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        text: { blocks: [{ kind: 'paragraph', runs: [{ text: 'Hello' }] } ] } },
    ],
  }],
})`;
