import type { Page } from '@playwright/test';
import {
  FIXTURE,
  IDS,
  clickAt,
  drag,
  expect,
  frameIsEditing,
  frameText,
  inspectorPx,
  redoDisabled,
  redoLabel,
  settle,
  test,
  undoDisabled,
  undoLabel,
} from './helpers';
import { mountFixture } from '../visual/harness';

/**
 * History through real input, and the ADR 0002 composition rule through a real
 * browser.
 *
 * The unit tests in `src/editor/history.test.ts` cover the data structures
 * exhaustively and instantly. These cover the parts that only exist in a browser:
 * that Ctrl+Z reaches the right target, that the browser's own undo stack is what
 * handles text, and that the two compose across a session boundary.
 */

test.beforeEach(async ({ page }) => {
  await mountFixture(page, FIXTURE);
});

// ---------------------------------------------------------------------------
// Basic history
// ---------------------------------------------------------------------------

test.describe('application history', () => {
  test('starts with nothing to undo or redo', async ({ page }) => {
    expect(await undoDisabled(page)).toBe(true);
    expect(await redoDisabled(page)).toBe(true);
    expect(await undoLabel(page)).toBe('Undo');
  });

  test('a move is one undo step however many pointer moves it took', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    await drag(
      page,
      { x: IDS.alpha.x + 60, y: IDS.alpha.y + 40 },
      { x: IDS.alpha.x + 200, y: IDS.alpha.y + 60 },
    );

    expect(await undoLabel(page)).toBe('Undo Move 1 object');

    await page.keyboard.press('Control+z');
    expect(await inspectorPx(page, 'x')).toBeCloseTo(40, 6);
    // One press undid the whole drag, so there is nothing left.
    expect(await undoDisabled(page)).toBe(true);
  });

  test('undo and redo round-trip', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    await drag(
      page,
      { x: IDS.alpha.x + 60, y: IDS.alpha.y + 40 },
      { x: IDS.alpha.x + 140, y: IDS.alpha.y + 40 },
    );
    const moved = await inspectorPx(page, 'x');
    expect(await redoDisabled(page)).toBe(true);

    await page.keyboard.press('Control+z');
    expect(await inspectorPx(page, 'x')).toBeCloseTo(40, 6);
    expect(await redoDisabled(page)).toBe(false);
    // The button names what redo will bring back, which is the same action.
    expect(await redoLabel(page)).toBe('Redo Move 1 object');

    await page.keyboard.press('Control+y');
    expect(await inspectorPx(page, 'x')).toBeCloseTo(moved, 6);
    expect(await redoDisabled(page)).toBe(true);
  });

  test('the redo branch is discarded by new work', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    await drag(
      page,
      { x: IDS.alpha.x + 60, y: IDS.alpha.y + 40 },
      { x: IDS.alpha.x + 140, y: IDS.alpha.y + 40 },
    );
    await page.keyboard.press('Control+z');
    expect(await redoDisabled(page)).toBe(false);

    await page.keyboard.press('ArrowRight');
    expect(await redoDisabled(page)).toBe(true);
  });

  test('undo walks back through separate gestures', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    await drag(
      page,
      { x: IDS.alpha.x + 60, y: IDS.alpha.y + 40 },
      { x: IDS.alpha.x + 100, y: IDS.alpha.y + 40 },
    );
    await page.keyboard.press('Control+z');
    await page.keyboard.press('ArrowRight');
    expect(await inspectorPx(page, 'x')).toBeCloseTo(41, 6);

    await page.keyboard.press('Control+z');
    expect(await inspectorPx(page, 'x')).toBeCloseTo(40, 6);
    await page.keyboard.press('Control+z');
    expect(await inspectorPx(page, 'x')).toBeCloseTo(40, 6);
    expect(await undoDisabled(page)).toBe(true);
  });

  test('the toolbar undo button does the same thing as the keyboard', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    await drag(
      page,
      { x: IDS.alpha.x + 60, y: IDS.alpha.y + 40 },
      { x: IDS.alpha.x + 140, y: IDS.alpha.y + 40 },
    );
    // The pointer moved 80 document px, so the origin moved with it.
    expect(await inspectorPx(page, 'x')).toBeCloseTo(120, 6);

    await page.locator('[data-edit="undo"]').click();
    expect(await inspectorPx(page, 'x')).toBeCloseTo(40, 6);

    await page.locator('[data-edit="redo"]').click();
    expect(await inspectorPx(page, 'x')).toBeCloseTo(120, 6);
  });

  test('undo is ignored while a field has focus, so typing is not intercepted', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    await drag(
      page,
      { x: IDS.alpha.x + 60, y: IDS.alpha.y + 40 },
      { x: IDS.alpha.x + 140, y: IDS.alpha.y + 40 },
    );

    const field = page.locator('[data-inspector] [data-field="x"]');
    await field.click();
    await page.keyboard.press('Control+z');

    // Focus is in an input, so the shortcut must stand down rather than undo.
    expect(await field.inputValue()).not.toBe('');
    expect(await inspectorPx(page, 'x')).toBeCloseTo(120, 6);
  });
});

// ---------------------------------------------------------------------------
// ADR 0002: text undo composition
// ---------------------------------------------------------------------------

test.describe('text undo composition (ADR 0002)', () => {
  /** Enters a text session on the fixture's text frame. */
  const enterText = async (page: Page): Promise<void> => {
    await clickAt(page, IDS.copy.x + 60, IDS.copy.y + 20);
    await page.keyboard.press('Enter');
    await page.locator('[data-objects] [data-oid="copy"] .p1-text-content').click();
    await page.keyboard.press('End');
    await settle(page);
  };

  test('a session commits one entry labelled "Edit text"', async ({ page }) => {
    await enterText(page);
    expect(await frameIsEditing(page, 'copy')).toBe(true);

    await page.keyboard.type('!!');
    await page.keyboard.press('Escape');
    await settle(page);

    expect(await frameIsEditing(page, 'copy')).toBe(false);
    expect(await frameText(page, 'copy')).toBe('Hello world!!');
    expect(await undoLabel(page)).toBe('Undo Edit text');
  });

  test('undo after a session reverts the whole edit, not one keystroke', async ({ page }) => {
    await enterText(page);
    // Three separate keystrokes inside one session.
    await page.keyboard.type('abc');
    await page.keyboard.press('Escape');
    await settle(page);
    expect(await frameText(page, 'copy')).toBe('Hello worldabc');

    await page.keyboard.press('Control+z');
    await settle(page);

    // All three keystrokes went at once. This is the assertion that distinguishes
    // "the session is one transaction" from "the browser's stack leaked through".
    expect(await frameText(page, 'copy')).toBe('Hello world');
    expect(await undoDisabled(page)).toBe(true);
  });

  test('redo restores the text after undoing a session', async ({ page }) => {
    await enterText(page);
    await page.keyboard.type('abc');
    await page.keyboard.press('Escape');
    await settle(page);

    await page.keyboard.press('Control+z');
    await settle(page);
    expect(await redoDisabled(page)).toBe(false);

    await page.keyboard.press('Control+y');
    await settle(page);
    expect(await frameText(page, 'copy')).toBe('Hello worldabc');
  });

  test('Ctrl+Z inside a session is the browser undo, and creates no history entry', async ({ page }) => {
    await enterText(page);
    await page.keyboard.type('abc');
    await settle(page);

    // Undo inside the session. The application history is still empty — the browser
    // owns this stack, and nothing about it belongs in our entries.
    await page.keyboard.press('Control+z');
    await settle(page);

    await page.keyboard.press('Escape');
    await settle(page);

    // Chromium coalesces the three keystrokes into one undo unit, so the session
    // commits whatever remains after that single undo.
    expect(await frameText(page, 'copy')).toBe('Hello world');
    expect(await undoDisabled(page)).toBe(true);
  });

  test('the undo button is delegated to the browser during a session', async ({ page }) => {
    await enterText(page);
    await page.keyboard.type('abc');
    await settle(page);

    // Session labels are verb phrases like every `History` label, so the button reads
    // "Undo text" rather than doubling the prefix. This assertion previously pinned
    // "Undo Undo text": the test recorded what the button showed instead of what it
    // should have shown.
    expect(await undoLabel(page)).toBe('Undo text');
    expect(await undoDisabled(page)).toBe(false);

    // The button forwards to the browser rather than popping application history.
    await page.locator('[data-edit="undo"]').click();
    await settle(page);

    await page.keyboard.press('Escape');
    await settle(page);
    expect(await frameText(page, 'copy')).toBe('Hello world');
  });

  test('after a session, the button targets application history again', async ({ page }) => {
    await enterText(page);
    await page.keyboard.type('abc');
    await page.keyboard.press('Escape');
    await settle(page);

    expect(await undoLabel(page)).toBe('Undo Edit text');

    await page.locator('[data-edit="undo"]').click();
    await settle(page);
    expect(await frameText(page, 'copy')).toBe('Hello world');
  });

  test('a session that changed nothing leaves no entry', async ({ page }) => {
    await enterText(page);
    await page.keyboard.press('Escape');
    await settle(page);

    expect(await undoDisabled(page)).toBe(true);
    expect(await frameText(page, 'copy')).toBe('Hello world');
  });

  test('a text edit and a shape move are two separate steps', async ({ page }) => {
    await enterText(page);
    await page.keyboard.type('!');
    await page.keyboard.press('Escape');
    await settle(page);

    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    await drag(
      page,
      { x: IDS.alpha.x + 60, y: IDS.alpha.y + 40 },
      { x: IDS.alpha.x + 100, y: IDS.alpha.y + 40 },
    );
    expect(await undoLabel(page)).toBe('Undo Move 1 object');

    // Undo the move, then the text edit: two steps, in the order they happened.
    await page.keyboard.press('Control+z');
    await settle(page);
    expect(await inspectorPx(page, 'x')).toBeCloseTo(40, 6);
    expect(await undoLabel(page)).toBe('Undo Edit text');

    await page.keyboard.press('Control+z');
    await settle(page);
    expect(await frameText(page, 'copy')).toBe('Hello world');
  });

  test('native redo does not survive leaving the session', async ({ page }) => {
    // Native behaviour, accepted in the ADR: the browser's redo stack is per editing
    // host and is destroyed when the frame is no longer being edited.
    await enterText(page);
    await page.keyboard.type('abc');
    await page.keyboard.press('Escape');
    await settle(page);
    expect(await frameText(page, 'copy')).toBe('Hello worldabc');

    await clickAt(page, IDS.copy.x + 60, IDS.copy.y + 20);
    await page.keyboard.press('Enter');
    await page.locator('[data-objects] [data-oid="copy"] .p1-text-content').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Control+Shift+z');
    await settle(page);

    // Nothing came back from the browser's stack.
    expect(await frameText(page, 'copy')).toBe('Hello worldabc');
    // And leaving again re-committed the same text, so still no new entry.
    await page.keyboard.press('Escape');
    await settle(page);
    expect(await undoLabel(page)).toBe('Undo Edit text');
  });

  test('leaving a session by clicking elsewhere still commits', async ({ page }) => {
    await enterText(page);
    await page.keyboard.type('z');
    await settle(page);

    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    await settle(page);

    expect(await frameIsEditing(page, 'copy')).toBe(false);
    expect(await frameText(page, 'copy')).toBe('Hello worldz');
    expect(await undoLabel(page)).toBe('Undo Edit text');
  });

  test('clicking inside the frame does not end the session', async ({ page }) => {
    await enterText(page);
    await page.keyboard.type('q');
    await settle(page);

    // A click within the edited frame's own bounds.
    await clickAt(page, IDS.copy.x + 20, IDS.copy.y + 20);
    await settle(page);

    expect(await frameIsEditing(page, 'copy')).toBe(true);
  });
});
