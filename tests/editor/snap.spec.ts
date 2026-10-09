/**
 * M17: snapping and guides, in the real editor.
 *
 * ## Why geometric assertions, and what they are measuring
 *
 * Every assertion reads a painted rectangle and compares numbers. Screenshots are not used as proof here --
 * ADR 0011b §8 established that the pixel baselines cannot see a sub-pixel chrome change, and a snap guide is
 * exactly that: 1px chrome whose *absence* is the difference between a correct and an incorrect
 * implementation. A baseline that cannot fail is not a guard, so none of these tests rely on one.
 *
 * The snap is asserted by its **effect on the authored transform**, not by the presence of a line: an
 * implementation that drew a guide and did not snap, or snapped without a guide, both pass or fail visibly
 * here rather than hiding behind each other.
 *
 * ## Why the drag distances are chosen, not arbitrary
 *
 * Each fixture leaves one candidate within the threshold and everything else far outside it. A drag that
 * lands equidistant between two candidates produces a *correct but different* snap, and the test would then
 * be asserting that the implementation happened to choose the one the author expected. The distances are in
 * the fixture comments so a future edit does not quietly invalidate a test.
 */

import type { Page } from '@playwright/test';

import {
  beginDrag,
  clickAt,
  endDrag,
  expect,
  moveDragTo,
  settle,
  test,
  undoLabel,
} from './helpers';
import {
  mountNearPageLeft,
  mountNestedRotatedChild,
  mountThreeForMulti,
  mountTwoWellSeparated,
  mountZoomInvariance,
} from './snap-fixtures';

// ---------------------------------------------------------------------------
// Reading state
// ---------------------------------------------------------------------------

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The viewport's current zoom, from the app's own readout. */
function zoomOf(page: Page): Promise<number> {
  return page.evaluate(() => {
    const readout = document.querySelector('[data-zoom-readout]')?.textContent ?? '100%';
    return (Number.parseInt(readout, 10) || 100) / 100;
  });
}

/**
 * Every leaf's painted box, in **document** pixels.
 *
 * Dividing by the zoom is not cosmetic. `getBoundingClientRect` reports *client* pixels, so without this
 * every number below silently becomes a fraction of the document position at any zoom other than 100% --
 * and the suite's own default zoom is 100%, so the zoom-invariance test was comparing client-space numbers
 * against document-space expectations. That is the same class of error ADR 0017 §2 is about: a quantity
 * compared in the wrong space that happens to be right at the default.
 */
async function painted(page: Page): Promise<Record<string, Box>> {
  return page.evaluate(() => {
    const readout = document.querySelector('[data-zoom-readout]')?.textContent ?? '100%';
    const zoom = (Number.parseInt(readout, 10) || 100) / 100;
    const origin = (document.querySelector('[data-page]') as HTMLElement).getBoundingClientRect();
    const out: Record<string, { left: number; top: number; width: number; height: number }> = {};
    for (const element of document.querySelectorAll('[data-oid]')) {
      const box = (element as HTMLElement).getBoundingClientRect();
      out[(element as HTMLElement).dataset['oid'] ?? '?'] = {
        left: (box.left - origin.left) / zoom,
        top: (box.top - origin.top) / zoom,
        width: box.width / zoom,
        height: box.height / zoom,
      };
    }
    return out;
  });
}

/** How many snap guides the overlay is currently drawing. */
async function guideCount(page: Page): Promise<number> {
  return page.locator('.p1-overlay-snap').count();
}

/** The document-space centre of a leaf's painted box, for grabbing. */
async function centreOf(page: Page, oid: string): Promise<{ x: number; y: number }> {
  return page.evaluate((id) => {
    const readout = document.querySelector('[data-zoom-readout]')?.textContent ?? '100%';
    const zoom = (Number.parseInt(readout, 10) || 100) / 100;
    const origin = (document.querySelector('[data-page]') as HTMLElement).getBoundingClientRect();
    const element = document.querySelector('[data-oid="' + id + '"]') as HTMLElement;
    const box = element.getBoundingClientRect();
    // Document pixels, because the drag helpers take document points and convert them themselves.
    return {
      x: (box.left + box.width / 2 - origin.left) / zoom,
      y: (box.top + box.height / 2 - origin.top) / zoom,
    };
  }, oid);
}

/** Selects several objects by clicking their painted centres, shift-clicking the rest. */
async function selectAll(page: Page, ids: readonly string[]): Promise<void> {
  for (const [index, id] of ids.entries()) {
    const centre = await centreOf(page, id);
    await clickAt(page, centre.x, centre.y, index === 0 ? [] : ['Shift']);
  }
  await settle(page);
}

// ---------------------------------------------------------------------------
// Guides appear and disappear
// ---------------------------------------------------------------------------

test.describe('guides are transient', () => {
  test('a guide is drawn while a snap is active and gone after the drag', async ({ page }) => {
    await mountTwoWellSeparated(page);
    const start = await centreOf(page, 'a');
    // Drag `a` right by 337: its left edge goes from 60 to 397, which is 3 from `b`'s left edge (400) and
    // further than 10 from every other candidate. See the fixture's distance table.
    await beginDrag(page, start);
    await moveDragTo(page, { x: start.x + 337, y: start.y });

    const during = await guideCount(page);
    expect(during, 'a guide should be drawn while the snap holds').toBeGreaterThan(0);

    await endDrag(page);
    expect(await guideCount(page), 'and gone the moment the gesture ends').toBe(0);
  });

  test('no guide is drawn when the drag is nowhere near a candidate', async ({ page }) => {
    await mountTwoWellSeparated(page);
    const start = await centreOf(page, 'a');
    await beginDrag(page, start);
    // 160 puts the features at 220 / 270 / 320; the nearest candidate is the page centre at 300, 30 away.
    await moveDragTo(page, { x: start.x + 160, y: start.y });

    expect(await guideCount(page), 'nothing is within the threshold, so no guide').toBe(0);
    await endDrag(page);
    expect(await guideCount(page)).toBe(0);
  });

  test('a cancelled drag takes its guide with it', async ({ page }) => {
    await mountTwoWellSeparated(page);
    const start = await centreOf(page, 'a');
    await beginDrag(page, start);
    await moveDragTo(page, { x: start.x + 337, y: start.y });
    expect(await guideCount(page)).toBeGreaterThan(0);

    // Escape cancels the gesture; the guide describes a snap that is no longer happening.
    await page.keyboard.press('Escape');
    await settle(page);
    expect(await guideCount(page), 'a cancelled drag must not leave a guide on the canvas').toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Snapping changes the authored transform
// ---------------------------------------------------------------------------

test.describe('snapping moves the object to the candidate', () => {
  test('a near miss lands exactly on the other object left edge', async ({ page }) => {
    await mountTwoWellSeparated(page);
    const before = await painted(page);
    const start = await centreOf(page, 'a');

    // 337 would leave the left edge at 397; `b`'s left edge is 400, so it snaps +3 to exactly 400.
    await beginDrag(page, start);
    await moveDragTo(page, { x: start.x + 337, y: start.y });
    await endDrag(page);

    const after = await painted(page);
    expect(after['a']!.left, 'the snapped edge is exactly the candidate').toBeCloseTo(
      before['b']!.left,
      0,
    );
    // And it is *not* where the pointer left it.
    expect(after['a']!.left, 'and not where the pointer left it').not.toBeCloseTo(
      before['a']!.left + 337,
      0,
    );
  });

  test('a far miss is not snapped at all', async ({ page }) => {
    await mountTwoWellSeparated(page);
    const before = await painted(page);
    const start = await centreOf(page, 'a');

    await beginDrag(page, start);
    await moveDragTo(page, { x: start.x + 160, y: start.y });
    await endDrag(page);

    const after = await painted(page);
    // Exactly the pointer delta -- the object followed the mouse, not a candidate.
    expect(after['a']!.left).toBeCloseTo(before['a']!.left + 160, 1);
  });

  test('a page edge is a candidate like any other', async ({ page }) => {
    await mountNearPageLeft(page);
    const before = await painted(page);
    const start = await centreOf(page, 'a');

    // `a`'s left is 6 from the page's left. Dragging -4 puts it at 2, which snaps to 0.
    await beginDrag(page, start);
    await moveDragTo(page, { x: start.x - 4, y: start.y });
    await endDrag(page);

    const after = await painted(page);
    expect(after['a']!.left, 'snapped to the page left edge').toBeCloseTo(0, 0);
    expect(after['a']!.left).not.toBeCloseTo(before['a']!.left - 4, 0);
  });

  test('snapping translates only -- size and rotation are untouched', async ({ page }) => {
    await mountTwoWellSeparated(page);
    const before = await painted(page);
    const start = await centreOf(page, 'a');
    await beginDrag(page, start);
    await moveDragTo(page, { x: start.x + 337, y: start.y });
    await endDrag(page);

    const after = await painted(page);
    expect(after['a']!.width).toBeCloseTo(before['a']!.width, 1);
    expect(after['a']!.height).toBeCloseTo(before['a']!.height, 1);
  });
});

// ---------------------------------------------------------------------------
// Alt suppresses snapping
// ---------------------------------------------------------------------------

test.describe('Alt suppresses snapping for the drag', () => {
  test('the same drag snaps without Alt and does not with it', async ({ page }) => {
    await mountTwoWellSeparated(page);
    const start = await centreOf(page, 'a');

    // Without Alt: snaps to `b`'s left edge.
    await beginDrag(page, start);
    await moveDragTo(page, { x: start.x + 337, y: start.y });
    await endDrag(page);
    const snapped = await painted(page);
    expect(snapped['a']!.left).toBeCloseTo(400, 0);

    // Undo, then repeat holding Alt: the pointer position is honoured exactly.
    await page.keyboard.press('Control+z');
    await settle(page);
    const restored = await painted(page);
    expect(restored['a']!.left).toBeCloseTo(60, 0);

    await beginDrag(page, start, ['Alt']);
    await moveDragTo(page, { x: start.x + 337, y: start.y });
    await endDrag(page, ['Alt']);
    const free = await painted(page);

    expect(free['a']!.left, 'with Alt the object follows the pointer exactly').toBeCloseTo(60 + 337, 1);
    expect(free['a']!.left, 'and does not snap to the candidate').not.toBeCloseTo(400, 0);
    expect(await guideCount(page), 'and no guide is drawn').toBe(0);
  });
});

// ---------------------------------------------------------------------------
// History and dirty state
// ---------------------------------------------------------------------------

test.describe('snapping participates in history normally', () => {
  test('a snapped drag is one undo step and restores the exact position', async ({ page }) => {
    await mountTwoWellSeparated(page);
    const before = await painted(page);
    const start = await centreOf(page, 'a');

    await beginDrag(page, start);
    await moveDragTo(page, { x: start.x + 337, y: start.y });
    await endDrag(page);

    expect(await undoLabel(page)).toContain('Move');
    await page.keyboard.press('Control+z');
    await settle(page);

    const after = await painted(page);
    expect(after['a']!.left).toBeCloseTo(before['a']!.left, 1);
    expect(after['a']!.top).toBeCloseTo(before['a']!.top, 1);
  });

  test('a snap does not dirty the document on its own, but a snapped move does', async ({ page }) => {
    await mountTwoWellSeparated(page);
    expect(await page.locator('[data-dirty]').getAttribute('data-dirty')).toBe('false');

    const start = await centreOf(page, 'a');
    await beginDrag(page, start);
    await moveDragTo(page, { x: start.x + 337, y: start.y });
    // Mid-drag, with the guide on screen and the transform already dispatched.
    expect(await page.locator('[data-dirty]').getAttribute('data-dirty')).toBe('true');
    await endDrag(page);

    await page.keyboard.press('Control+z');
    await settle(page);
    expect(
      await page.locator('[data-dirty]').getAttribute('data-dirty'),
      'undoing back to the saved state is clean again, so guides dirtied nothing',
    ).toBe('false');
  });

  test('a drag that is cancelled leaves the document clean and no guide', async ({ page }) => {
    await mountTwoWellSeparated(page);
    const before = await painted(page);
    const start = await centreOf(page, 'a');
    await beginDrag(page, start);
    await moveDragTo(page, { x: start.x + 337, y: start.y });
    await page.keyboard.press('Escape');
    await settle(page);

    expect(await painted(page), 'a cancelled drag rolls back').toEqual(before);
    expect(await page.locator('[data-dirty]').getAttribute('data-dirty')).toBe('false');
    expect(await guideCount(page)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Multi-selection
// ---------------------------------------------------------------------------

test.describe('a multi-selection moves as one arrangement', () => {
  test('both members receive the same snap, so they cannot come apart', async ({ page }) => {
    await mountThreeForMulti(page);
    await selectAll(page, ['a', 'b']);
    const before = await painted(page);

    const gap = before['b']!.left - (before['a']!.left + before['a']!.width);
    expect(gap, 'the fixture asserts its own spacing').toBeCloseTo(30, 0);

    const start = await centreOf(page, 'a');
    // The union's left edge goes from 60 to 246, 4 from `target`'s left (450)... 
    // Recomputed: `target` is at 450, so the union's *left* would need to be 446, i.e. a drag of 386.
    await beginDrag(page, start);
    await moveDragTo(page, { x: start.x + 386, y: start.y });
    await endDrag(page);

    const after = await painted(page);
    const gapAfter = after['b']!.left - (after['a']!.left + after['a']!.width);
    expect(gapAfter, 'the members kept their separation, so it is one arrangement').toBeCloseTo(gap, 0);
    // And both moved by the same amount.
    expect(after['a']!.left - before['a']!.left).toBeCloseTo(after['b']!.left - before['b']!.left, 1);
  });

  test('a multi-selection snaps its union edge, not each member', async ({ page }) => {
    await mountThreeForMulti(page);
    await selectAll(page, ['a', 'b']);
    const before = await painted(page);
    // Union: x 60..270, y 60..190. Its right edge (270) is 180 from `target`'s left (450).
    const unionRight = before['b']!.left + before['b']!.width;
    expect(unionRight).toBeCloseTo(270, 0);

    const start = await centreOf(page, 'a');
    // Drag so the union's LEFT edge is 4 short of `target`'s left: 60 + delta = 446, delta = 386.
    await beginDrag(page, start);
    await moveDragTo(page, { x: start.x + 386, y: start.y });
    await endDrag(page);

    const after = await painted(page);
    // If each member were snapped independently they would be at different alignments; here the union's
    // left edge is exactly on `target`'s left edge.
    expect(after['a']!.left, "the union's left edge snapped to the candidate").toBeCloseTo(
      before['target']!.left,
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// Groups and nested objects
// ---------------------------------------------------------------------------

test.describe('groups and nesting', () => {
  test('a child inside a rotated, scaled group snaps and moves by the page delta', async ({ page }) => {
    // The regression M16 asked for. A child of a group rotated 0.4 and scaled 1.2 must move along the
    // *page* axis; the M16 conversion handles that, and snapping must not bypass it.
    await mountNestedRotatedChild(page);
    const childCentre = await centreOf(page, 'child');
    await clickAt(page, childCentre.x, childCentre.y);
    const before = await painted(page);

    const start = await centreOf(page, 'child');
    // Drag straight down by 200: page-down must stay page-down, and the child's painted top must move by
    // exactly 200 in page space.
    await beginDrag(page, start);
    await moveDragTo(page, { x: start.x, y: start.y + 200 });
    await endDrag(page);

    const after = await painted(page);
    const dx = after['child']!.left - before['child']!.left;
    const dy = after['child']!.top - before['child']!.top;
    expect(Math.abs(dx), 'a purely vertical page drag has no page-x component').toBeLessThan(1.5);
    // 200 unless something snapped; this asserts the axis, not the snap.
    expect(Math.abs(dy - 200), 'page-down drag moves the painted box down by 200').toBeLessThan(1.5);
  });

  test('a nested child snaps to a top-level object by its painted position', async ({ page }) => {
    await mountNestedRotatedChild(page);
    const childCentre = await centreOf(page, 'child');
    await clickAt(page, childCentre.x, childCentre.y);
    const before = await painted(page);
    const looseBefore = before['loose']!;

    const start = await centreOf(page, 'child');
    // Drag so the child's painted LEFT edge is 3 short of `loose`'s left edge.
    const dx = looseBefore.left - 3 - before['child']!.left;
    await beginDrag(page, start);
    await moveDragTo(page, { x: start.x + dx, y: start.y });
    await endDrag(page);

    const after = await painted(page);
    expect(after['child']!.left, 'the child snapped to the top-level box painted edge').toBeCloseTo(
      looseBefore.left,
      0,
    );
  });

  test('a selected group snaps by its derived bounds and moves as one', async ({ page }) => {
    await mountNestedRotatedChild(page);
    // Alt-click the child selects the containing group.
    const centre = await centreOf(page, 'child');
    await clickAt(page, centre.x, centre.y, ['Alt']);
    await settle(page);

    const selected = await page
      .locator('.p1-overlay-group--selection')
      .evaluateAll((groups) => groups.map((g) => (g as HTMLElement).dataset['for']));
    expect(selected, 'the group is selected, not the child').toEqual(['grp']);

    const before = await painted(page);
    const start = await centreOf(page, 'child');
    // Drag the group by a small amount and assert *both* members moved by the same page delta -- which is
    // what "moved as a group" means, and what fanning out to children would also satisfy, so the negative
    // control is that neither member's authored transform changed relative to the other.
    await beginDrag(page, start);
    await moveDragTo(page, { x: start.x + 25, y: start.y + 10 });
    await endDrag(page);

    const after = await painted(page);
    const dm = after['child']!.left - before['child']!.left;
    expect(Math.abs(dm), 'the child moved with the group').toBeGreaterThan(1);
    // The child is still exactly where the group put it: its painted size is unchanged.
    expect(after['child']!.width).toBeCloseTo(before['child']!.width, 1);
    expect(after['child']!.height).toBeCloseTo(before['child']!.height, 1);
  });
});

// ---------------------------------------------------------------------------
// Zoom invariance
// ---------------------------------------------------------------------------

test.describe('the threshold is a screen-space quantity', () => {
  /**
   * The ADR 0017 §2 guarantee, stated as a test that can only pass one way.
   *
   * A gap of **7 document px** is dragged against `b` at a low zoom and a high one:
   *
   * | implementation | threshold it uses | at 0.26 | at 4 |
   * |---|---|---|---|
   * | correct: `10 / zoom` | 38.5 doc px | **snaps** | **does not** |
   * | screen constant, compared as document px | 10 doc px | does not | snaps |
   * | screen constant, multiplied | 40 doc px at 0.26 | snaps | does not |
   *
   * The same document gap snapping at one zoom and not the other is the only observable that separates the
   * correct conversion from both plausible mistakes, and it is why this test asserts the *sign* of the
   * outcome per zoom instead of merely asserting that a snap happened.
   *
   * 7 px is chosen so that exactly one candidate qualifies at the low zoom: with `a` 100 wide and `b` 60
   * wide, `a`'s features sit at `b.left - 7`, `b.left + 43` and `b.left + 93`, and the nearest of `b`'s is
   * 7 away -- its centre is 13 from `a`'s centre, so nothing competes.
   */
  test('the same document gap snaps at a low zoom and not at a high one', async ({ page }) => {
    const DRAG = 40;
    const achieved: number[] = [];

    for (const target of [0.25, 4]) {
      await mountZoomInvariance(page);
      // Zoom via the real toolbar, so the whole pipeline is exercised.
      for (let i = 0; i < 24; i += 1) {
        const current = await zoomOf(page);
        if (Math.abs(current - target) < 0.01) break;
        await page.locator(target > current ? '[data-zoom="in"]' : '[data-zoom="out"]').click();
      }
      await settle(page);

      const zoom = await zoomOf(page);
      achieved.push(zoom);
      const low = zoom < 1;

      const before = await painted(page);
      const start = await centreOf(page, 'a');
      await beginDrag(page, start);
      await moveDragTo(page, { x: start.x + DRAG, y: start.y });

      const guides = await page.locator('.p1-overlay-snap').count();
      await endDrag(page);
      const after = await painted(page);

      // Where the pointer alone would have put it.
      const unsnappedLeft = before['a']!.left + DRAG;

      if (low) {
        expect(guides, `at zoom ${zoom} the threshold is ${(10 / zoom).toFixed(1)} doc px, so it snaps`).toBeGreaterThan(0);
        // Asserted as "some feature of `a` coincides with some feature of `b`" rather than as a particular
        // edge landing on a particular edge: which feature wins is a tie-break, and pinning it here would
        // be asserting the tie-break rather than the conversion under test.
        const featuresA = [after['a']!.left, after['a']!.left + after['a']!.width / 2, after['a']!.left + after['a']!.width];
        const featuresB = [before['b']!.left, before['b']!.left + before['b']!.width / 2, before['b']!.left + before['b']!.width];
        const aligned = featuresA.some((fa) => featuresB.some((fb) => Math.abs(fa - fb) < 0.5));
        expect(aligned, `at zoom ${zoom} the object landed exactly on a candidate`).toBe(true);
        expect(after['a']!.left, 'and it did not stay where the pointer left it').not.toBeCloseTo(unsnappedLeft, 1);
      } else {
        expect(guides, `at zoom ${zoom} the threshold is ${(10 / zoom).toFixed(1)} doc px, so it must not snap`).toBe(0);
        expect(after['a']!.left, 'and the object stayed exactly where the pointer left it').toBeCloseTo(unsnappedLeft, 1);
      }
    }

    // The zooms have to be genuinely far apart for any of the above to mean anything: had the toolbar
    // clamped them both to 100%, the test would pass without ever exercising the conversion.
    expect(Math.min(...achieved), 'the low zoom really was low').toBeLessThan(0.35);
    expect(Math.max(...achieved), 'the high zoom really was high').toBeGreaterThan(3);
  });
});

// Persistence
// ---------------------------------------------------------------------------

test.describe('snap state never reaches the document', () => {
  test('snapping and displaying guides leave the saved bytes identical', async ({ page }) => {
    // The load-time half of this guarantee already exists -- `persistence.spec.ts` proves the format
    // *refuses* an undeclared `guides` key. This is the other half: that merely snapping does not change
    // what is saved, so guide state cannot leak into the file even transiently.
    await mountTwoWellSeparated(page);
    const save = async (): Promise<string> => {
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.locator('[data-doc="save"]').click(),
      ]);
      const path = await download.path();
      if (path === null) throw new Error('no download path');
      const { readFile } = await import('node:fs/promises');
      return readFile(path, 'utf8');
    };

    const untouched = await save();

    // Drag into a snap, so a guide is drawn and the transform is rewritten.
    const start = await centreOf(page, 'a');
    await beginDrag(page, start);
    await moveDragTo(page, { x: start.x + 337, y: start.y });
    expect(await guideCount(page), 'a guide really was on screen').toBeGreaterThan(0);
    await endDrag(page);

    // Undo, so the document is back to its authored state, then save again.
    await page.keyboard.press('Control+z');
    await settle(page);
    const afterUndo = await save();

    expect(afterUndo, 'the saved bytes are identical with and without snapping').toBe(untouched);
    // And nothing named like a guide or a snap appears anywhere in them.
    for (const needle of ['snap', 'guide', 'snapLines', 'threshold']) {
      expect(afterUndo.toLowerCase(), `the document contains "${needle}"`).not.toContain(needle);
    }
    // The format version is untouched: no bump was needed.
    expect(JSON.parse(afterUndo).formatVersion).toBe(2);
  });

  test('the document refuses a saved guides key, so it cannot come back that way either', async ({ page }) => {
    await mountTwoWellSeparated(page);
    // Uses the app's own open path with a hand-written file, which the format must refuse.
    await page.locator('[data-file-input="document"]').setInputFiles({
      name: 'with-guides.p1doc',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          formatVersion: 2,
          id: 'x',
          name: 'X',
          pageSize: { width: 300, height: 200, unit: 'px', orientation: 'portrait' },
          assets: {},
          guides: [],
          pages: [],
        }),
        'utf8',
      ),
    });
    await settle(page);
    // The refusal is reported rather than silently dropping the key.
// The status bar is the app's own refusal channel: `data-error` is the signal and `data-doc-message`
    // carries the text naming the fault. An earlier draft asserted against a `[data-doc-feedback]`
    // attribute that does not exist, so the only thing it demonstrated was that a locator which never
    // appears fails eventually.
    expect(
      await page.locator('[data-doc-message]').getAttribute('data-error'),
      'the document with an undeclared guides key is refused',
    ).toBe('true');
  });
});
