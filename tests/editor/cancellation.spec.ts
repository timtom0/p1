/**
 * Gesture cancellation: every path that must leave the document exactly as it was.
 *
 * ## The invariant, stated once
 *
 * > A cancelled gesture leaves the document **byte-identical** to how the gesture found it, and
 * > records **nothing** in the history.
 *
 * Not "roughly unchanged" and not "one undo step away from unchanged". A gesture dispatches its
 * commands into an open transaction and rolls that transaction back, so the strong form is the
 * one worth asserting — and it is checkable, because the saved bytes are a total function of the
 * document. Every test here compares **bytes**, not a selection or a bounding box.
 *
 * ## Why the comparison is bytes and not geometry
 *
 * A cancelled drag that rolled back 59 of 60 pixels would pass a `toBeCloseTo` on one axis and
 * fail on nothing else. Reading the serialiser's output catches partial rollback, a wrong page,
 * a stray node, and an unintended property change — all of which a geometry assertion is blind
 * to. It is the same reason M7 compares byte identity across a save boundary.
 *
 * ## Which events these tests drive, and which they refuse to invent
 *
 * Every cancellation here is reachable in a real browser:
 *
 * - <kbd>Esc</kbd> — the user pressing a key.
 * - `window` `blur` — alt-tabbing, or clicking the devtools.
 * - `pointercancel` — the browser taking the pointer back, which it does when a press also
 *   starts a native text selection.
 * - `pointerup` — the ordinary end, which for a *draw* gesture is also a cancel path (releasing
 *   off the page).
 *
 * Synthesised, and therefore legitimate: `blur` and `pointercancel` are dispatched explicitly
 * because Chromium will not produce them on demand in a headless run. Not synthesised, and
 * therefore absent: pointer *removal* mid-gesture, a second `pointerdown` for a different
 * pointer id, `lostpointercapture` without a cancel. Those cannot happen to this editor, and a
 * test for them would only assert that a mock works.
 */

import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import {
  beginDrag,
  clickAt,
  endDrag,
  expect,
  moveDragTo,
  selectionIds,
  settle,
  test,
  undoDisabled,
  undoLabel,
} from './helpers';
import { mountFixture } from '../visual/harness';

// ---------------------------------------------------------------------------
// Reading the whole document, not a corner of it
// ---------------------------------------------------------------------------

/**
 * The document as bytes, via the real save path.
 *
 * The gateway, the serialiser and the download all participate, so a rollback that corrupted
 * something the renderer would have papered over still shows up. The alternative — reading
 * `[data-oid]` positions — sees the projection, not the document, and a projection is exactly
 * what a failed rollback leaves looking plausible.
 */
async function documentBytes(page: Page): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-doc="save"]').click(),
  ]);
  const path = await download.path();
  if (path === null) throw new Error('the download produced no file');
  return readFile(path, 'utf8');
}

/** The rendered box of an object, for the "did anything visibly move" half of a claim. */
function boxOf(page: Page, id: string): Promise<{ left: string; top: string; width: string }> {
  return page
    .locator(`[data-page] [data-oid="${id}"]`)
    .evaluate((el) => {
      const node = el as HTMLElement;
      return { left: node.style.left, top: node.style.top, width: node.style.width };
    });
}

// ---------------------------------------------------------------------------
// The cancellation triggers
// ---------------------------------------------------------------------------

/**
 * Fires `window`'s `blur`, which is what alt-tabbing and clicking the devtools do.
 *
 * A real event, dispatched explicitly only because a headless run will not produce one on
 * demand. The handler under test is the same one the browser calls.
 */
async function loseWindowFocus(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await settle(page);
}

/**
 * Fires `pointercancel` on the viewport, which is the browser taking the pointer back.
 *
 * Dispatched on the element that holds the capture, because that is where the browser sends it
 * and because the handler is registered there. The `pointerId` is the one the mouse uses.
 */
async function cancelPointer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const root = document.querySelector('main.viewport');
    if (!(root instanceof HTMLElement)) throw new Error('no viewport root');
    root.dispatchEvent(
      new PointerEvent('pointercancel', { bubbles: true, pointerId: 1, button: 0 }),
    );
  });
  await settle(page);
}

// ---------------------------------------------------------------------------
// Move
// ---------------------------------------------------------------------------

test.describe('a cancelled move', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, CANCEL_FIXTURE);
  });

  test('Escape after a partial move restores the document and records nothing', async ({ page }) => {
    const before = await documentBytes(page);
    await clickAt(page, 100, 80);
    expect(await selectionIds(page)).toEqual(['node_a']);

    await beginDrag(page, { x: 100, y: 80 });
    await moveDragTo(page, { x: 160, y: 110 }, 3);
    // The move really happened, or the rest of the test proves nothing.
    expect((await boxOf(page, 'node_a')).left).not.toBe('40px');

    await page.keyboard.press('Escape');
    await endDrag(page);

    expect(await documentBytes(page), 'the document is byte-identical to before the drag').toBe(
      before,
    );
    expect(await undoDisabled(page), 'a cancelled gesture is not an action').toBe(true);
  });

  test('losing window focus after a partial move restores the document', async ({ page }) => {
    // The one that was broken. `blur` cleared the space-pan cursor and did nothing else, so the
    // gesture stayed open: the object was left at a partial position, the pointer capture was
    // still held, and no further `pointermove` was acted on. The drag was dead while the editor
    // still believed it was live — which is why <kbd>Esc</kbd> after the blur rolled it back.
    const before = await documentBytes(page);
    await clickAt(page, 100, 80);

    await beginDrag(page, { x: 100, y: 80 });
    await moveDragTo(page, { x: 160, y: 110 }, 3);
    expect((await boxOf(page, 'node_a')).left).not.toBe('40px');

    await loseWindowFocus(page);
    await endDrag(page);

    expect(await documentBytes(page), 'blur ended the gesture and rolled it back').toBe(before);
    expect(await undoDisabled(page)).toBe(true);
  });

  test('a cancelled pointer after a partial move restores the document', async ({ page }) => {
    const before = await documentBytes(page);
    await clickAt(page, 100, 80);

    await beginDrag(page, { x: 100, y: 80 });
    await moveDragTo(page, { x: 160, y: 110 }, 3);

    await cancelPointer(page);
    await endDrag(page);

    expect(await documentBytes(page)).toBe(before);
    expect(await undoDisabled(page)).toBe(true);
  });

  test('all three triggers agree, which is the point of routing them to one method', async ({
    page,
  }) => {
    // Three separate code paths reaching the same rollback is a place for them to disagree, so
    // the claim is made once over all three rather than three times over one.
    const before = await documentBytes(page);
    for (const cancel of [
      async (p: Page) => p.keyboard.press('Escape'),
      loseWindowFocus,
      cancelPointer,
    ]) {
      await clickAt(page, 100, 80);
      await beginDrag(page, { x: 100, y: 80 });
      await moveDragTo(page, { x: 160, y: 110 }, 3);
      await cancel(page);
      await endDrag(page);

      expect(await documentBytes(page), 'the document came back').toBe(before);
      expect(await undoDisabled(page), 'nothing was recorded').toBe(true);
    }
  });

  test('a gesture that never moved records nothing at all', async ({ page }) => {
    // The other half of the no-op rule: a press that dispatched no command must not open a
    // history entry, which is `History.flush`'s empty-command guard rather than a cancellation.
    const before = await documentBytes(page);
    await clickAt(page, 100, 80);
    expect(await documentBytes(page)).toBe(before);
    expect(await undoDisabled(page)).toBe(true);
    expect(await undoLabel(page)).toBe('Undo');
  });

  test('a move that goes out and comes back records nothing', async ({ page }) => {
    // Distinct from a cancellation: the gesture ran to completion and produced a document equal
    // to the one it started from. `flush` catches that by re-applying, and a compensating edit
    // could not — an out-and-back drag *equals* the start by value but is not it by reference.
    const before = await documentBytes(page);
    await clickAt(page, 100, 80);

    await beginDrag(page, { x: 100, y: 80 });
    await moveDragTo(page, { x: 160, y: 110 }, 2);
    await moveDragTo(page, { x: 100, y: 80 }, 2);
    await endDrag(page);

    expect(await documentBytes(page)).toBe(before);
    expect(await undoDisabled(page), 'an out-and-back drag is not an action').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Resize and rotate
// ---------------------------------------------------------------------------

test.describe('a cancelled resize or rotate', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, CANCEL_FIXTURE);
    await clickAt(page, 100, 80);
  });

  test('Escape mid-resize restores width and height exactly', async ({ page }) => {
    const before = await documentBytes(page);
    const handle = await page
      .locator('.p1-overlay-group--selection [data-handle="se"]')
      .boundingBox();
    if (handle === null) throw new Error('no bottom-right handle');

    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + 70, handle.y + 50, { steps: 4 });
    expect((await boxOf(page, 'node_a')).width).not.toBe('120px');

    await page.keyboard.press('Escape');
    await page.mouse.up();

    expect(await documentBytes(page)).toBe(before);
    expect(await undoDisabled(page)).toBe(true);
  });

  test('Escape mid-rotate restores the rotation exactly', async ({ page }) => {
    // Rotation is the case a partial rollback shows up in most visibly: the model holds
    // `rotation` in radians, so "almost back" is a number that looks fine and is wrong.
    const before = await documentBytes(page);
    const grip = await page.locator('.p1-overlay-rotate').boundingBox();
    if (grip === null) throw new Error('no rotation handle');

    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + 80, grip.y + 90, { steps: 4 });
    // The rotation really changed, or the rollback below proves nothing.
    const during = await page
      .locator('[data-page] [data-oid="node_a"]')
      .evaluate((el) => (el as HTMLElement).style.transform);
    expect(during).not.toBe('none');

    await page.keyboard.press('Escape');
    await page.mouse.up();

    expect(await documentBytes(page)).toBe(before);
    expect(await undoDisabled(page)).toBe(true);
  });

  test('losing window focus mid-resize restores the document', async ({ page }) => {
    const before = await documentBytes(page);
    const handle = await page
      .locator('.p1-overlay-group--selection [data-handle="se"]')
      .boundingBox();
    if (handle === null) throw new Error('no bottom-right handle');

    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + 70, handle.y + 50, { steps: 4 });

    await loseWindowFocus(page);
    await page.mouse.up();

    expect(await documentBytes(page)).toBe(before);
    expect(await undoDisabled(page)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Marquee
// ---------------------------------------------------------------------------

test.describe('a cancelled marquee', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, CANCEL_FIXTURE);
  });

  test('Escape mid-marquee selects nothing and changes nothing', async ({ page }) => {
    // A marquee is the interesting case because it commits on *release*, not during the drag:
    // the preview rect is overlay geometry, so there is no transaction to roll back and a
    // cancellation has nothing to undo. What it must still not do is select.
    const before = await documentBytes(page);
    await beginDrag(page, { x: 20, y: 20 });
    await moveDragTo(page, { x: 300, y: 200 }, 3);

    await page.keyboard.press('Escape');
    await endDrag(page);

    expect(await selectionIds(page), 'a cancelled marquee selects nothing').toHaveLength(0);
    expect(await documentBytes(page)).toBe(before);
    expect(await undoDisabled(page)).toBe(true);
  });

  test('losing window focus mid-marquee selects nothing', async ({ page }) => {
    await beginDrag(page, { x: 20, y: 20 });
    await moveDragTo(page, { x: 300, y: 200 }, 3);

    await loseWindowFocus(page);
    await endDrag(page);

    expect(await selectionIds(page)).toHaveLength(0);
  });

  test('a click on the background is not a marquee', async ({ page }) => {
    // M5's rule, and the reason `moved` exists: a press with no movement must not select, or
    // clicking the page to deselect would instead select everything it touched.
    await clickAt(page, 300, 250);
    expect(await selectionIds(page)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Draw
// ---------------------------------------------------------------------------

test.describe('a cancelled draw', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, CANCEL_FIXTURE);
  });

  test('Escape mid-draw creates nothing and selects nothing', async ({ page }) => {
    const before = await documentBytes(page);
    await page.locator('[data-shape="rect"]').click();

    await beginDrag(page, { x: 300, y: 200 });
    await moveDragTo(page, { x: 400, y: 260 }, 3);
    await page.keyboard.press('Escape');
    await endDrag(page);

    expect(await selectionIds(page)).toHaveLength(0);
    expect(await documentBytes(page), 'no object was inserted').toBe(before);
    expect(await undoDisabled(page)).toBe(true);
  });

  test('releasing off the page creates nothing rather than clamping', async ({ page }) => {
    // A cancel path with no key involved: the drag is fine, the *release point* is not on a page.
    // Clamping would silently create an object somewhere the user is not pointing.
    const before = await documentBytes(page);
    await page.locator('[data-shape="rect"]').click();

    await beginDrag(page, { x: 300, y: 200 });
    // Well past the bottom of the 300pt page, in the inter-page gutter.
    await moveDragTo(page, { x: 400, y: 700 }, 3);
    await endDrag(page);

    expect(await selectionIds(page)).toHaveLength(0);
    expect(await documentBytes(page)).toBe(before);
    expect(await undoDisabled(page)).toBe(true);
  });

  test('a click with a draw tool armed creates a default-sized object', async ({ page }) => {
    // Not a cancellation, and the opposite of what this file's other draw tests assert — so it
    // is here to name the boundary. `creationRect` gives a click a default extent for the kinds
    // that would otherwise be degenerate, and the *registry* decides which those are. The
    // threshold state ("pressed, not yet moved") therefore has two legitimate outcomes, and
    // which one you get depends on the kind rather than on the gesture.
    await page.locator('[data-shape="rect"]').click();
    await clickAt(page, 300, 200);

    expect(await selectionIds(page), 'the click created and selected one object').toHaveLength(1);
    expect((await boxOf(page, 'node_1')).width).not.toBe('0px');
  });

  test('a click with a line tool armed creates nothing, because a line needs a drag', async ({
    page,
  }) => {
    // The other half of the same boundary. A zero-width line is not a line, so the registry
    // declines the default extent and the click is refused rather than committing an object the
    // user could not then select.
    const before = await documentBytes(page);
    await page.locator('[data-shape="line"]').click();
    await clickAt(page, 300, 200);

    expect(await selectionIds(page)).toHaveLength(0);
    expect(await documentBytes(page)).toBe(before);
    expect(await undoDisabled(page)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Idempotence
// ---------------------------------------------------------------------------

test.describe('cancellation is idempotent', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, CANCEL_FIXTURE);
  });

  test('two cancels and a pointerup leave the document alone', async ({ page }) => {
    // Real, because the triggers arrive independently: a `pointercancel` can be followed by a
    // `blur` from the same alt-tab that caused it. Whichever order they land in, the second one
    // must find nothing to do rather than rolling back a transaction it does not own.
    const before = await documentBytes(page);
    await clickAt(page, 100, 80);
    await beginDrag(page, { x: 100, y: 80 });
    await moveDragTo(page, { x: 160, y: 110 }, 3);

    await cancelPointer(page);
    await loseWindowFocus(page);
    await page.keyboard.press('Escape');
    await endDrag(page);

    expect(await documentBytes(page)).toBe(before);
    expect(await undoDisabled(page)).toBe(true);
  });

  test('a cancel with nothing in flight does nothing', async ({ page }) => {
    // The idle guard on `cancelGesture`. Without it, a stray `blur` would call
    // `abortTransaction` and reach for whatever transaction happened to be open — which, during
    // a text session, is not the gesture's business.
    const before = await documentBytes(page);
    await clickAt(page, 100, 80);
    await loseWindowFocus(page);
    await cancelPointer(page);
    expect(await documentBytes(page)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// A cancelled gesture and an open text session are different things
// ---------------------------------------------------------------------------

test.describe('a text session is not cancelled by a window blur', () => {
  test('losing focus keeps the session and its text', async ({ page }) => {
    // The reason `cancelGesture` is guarded rather than unconditional. A `blur` during a text
    // session must not roll back the session's pending text: the browser owns that subtree, and
    // the editor has not been told anything yet.
    await mountFixture(page, CANCEL_FIXTURE);
    const frame = page.locator('[data-page] [data-type="textFrame"]').first();
    await frame.click();
    await page.keyboard.press('Enter');
    expect(await page.locator('[data-editing="true"]').count()).toBe(1);

    await page.keyboard.type('hello');
    await loseWindowFocus(page);

    expect(
      await page.locator('[data-editing="true"]').count(),
      'the session survived the blur',
    ).toBe(1);
    await page.keyboard.press('Escape');
    await settle(page);
    expect(await page.locator('[data-type="textFrame"]').first().innerText()).toContain('hello');
  });
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * One rect and one text frame, non-overlapping, on a single page.
 *
 * The rect is the drag target and the frame is there so the text-session test has a fence to
 * lose focus inside — a cancellation bug that only shows up with an open session is exactly the
 * kind that a rect-only fixture cannot find.
 */
const CANCEL_FIXTURE = `() => {
  const rect = (id, name, x, y, width, height) => ({
    type: 'shape', id, name,
    transform: { x, y, width, height, rotation: 0, scaleX: 1, scaleY: 1 },
    visible: true, locked: false, opacity: 1, blendMode: 'normal',
    shape: { kind: 'rect', cornerRadius: 0 },
    fill: { type: 'solid', color: '#3366ff' },
  });
  return {
    formatVersion: 1, id: 'cancel', name: 'Cancel',
    pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
    assets: {},
    pages: [{
      id: 'p1', name: '1',
      background: { type: 'solid', color: '#ffffff' },
      objects: [
        rect('node_a', 'A', 40, 40, 120, 80),
        { type: 'textFrame', id: 'node_t', name: 'T',
          transform: { x: 40, y: 160, width: 220, height: 50, rotation: 0, scaleX: 1, scaleY: 1 },
          visible: true, locked: false, opacity: 1, blendMode: 'normal',
          text: { blocks: [{ kind: 'paragraph', runs: [{ text: 'seed' }] } ] } },
      ],
    }],
  };
}`;
