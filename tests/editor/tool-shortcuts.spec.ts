/**
 * Tool keyboard shortcuts.
 *
 * ## Why this test exists at all
 *
 * The four tool buttons in the toolbar have always carried `title` attributes promising
 * <kbd>V</kbd>, <kbd>R</kbd>, <kbd>E</kbd> and <kbd>L</kbd>. Nothing bound them. The mismatch was
 * invisible to every other test because it is the *absence* of behaviour: no suite pressed a key and
 * expected a tool to change, because the feature was documented in a tooltip and implemented
 * nowhere.
 *
 * That is the same failure shape ADR 0011b §8 describes — something the pixel baselines cannot see —
 * and it survived for the same reason. A title attribute asserts an interface; only a press can test
 * one.
 *
 * ## What is asserted
 *
 * Each key arms its tool, <kbd>V</kbd> disarms, and **a modified chord does not** — because
 * <kbd>ctrl</kbd>+<kbd>R</kbd> and <kbd>cmd</kbd>+<kbd>L</kbd> belong to the browser and the OS, and a
 * binding that ignored modifiers would steal them.
 *
 * The last test is the one that would be easy to get wrong. The keys live in `editing-shortcuts.ts`
 * rather than `shortcuts.ts` specifically so that the text-session early return applies: pressing
 * <kbd>R</kbd> with a text frame open must type an "r", not swap the draw tool out from under the
 * session.
 */

import type { Page } from '@playwright/test';

import { beginDrag, clickAt, expect, frameIsEditing, settle, test } from './helpers';
import { mountFixture, mountSample } from '../visual/harness';
import { TEXT_FIXTURE, TEXT_IDS } from './text-fixtures';

/** Which tool button, if any, currently reports itself as pressed. */
async function armedTool(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const pressed = [...document.querySelectorAll('[data-tool][aria-pressed="true"], [data-shape][aria-pressed="true"]')];
    return pressed.length === 0 ? null : String((pressed[0] as HTMLElement).dataset['tool'] ?? (pressed[0] as HTMLElement).dataset['shape']);
  });
}

test.describe('tool shortcuts', () => {
  test('each letter arms the tool its toolbar title promises', async ({ page }) => {
    await mountSample(page);

    for (const [key, expected] of [
      ['r', 'rect'],
      ['e', 'ellipse'],
      ['l', 'line'],
    ] as const) {
      await page.keyboard.press(key);
      await settle(page);
      expect(await armedTool(page), `${key} should arm ${expected}`).toBe(expected);
    }
  });

  test('V returns to the select tool by disarming the draw tool', async ({ page }) => {
    await mountSample(page);

    await page.keyboard.press('r');
    await settle(page);
    expect(await armedTool(page)).toBe('rect');

    await page.keyboard.press('v');
    await settle(page);
    // Disarmed means the Select button, not "nothing is pressed" -- the two would look identical if
    // the binding silently failed to find a tool at all.
    expect(await armedTool(page)).toBe('select');
  });

  test('a modified chord does not arm a tool, because those keys belong to the browser', async ({ page }) => {
    await mountSample(page);

    for (const chord of ['Control+r', 'Shift+r', 'Alt+r']) {
      await page.keyboard.press(chord);
      await settle(page);
      expect(await armedTool(page), `${chord} must not arm a tool`).toBe('select');
    }
  });

  test('an armed tool still creates the object it is armed for', async ({ page }) => {
    // The binding is not cosmetic: it must reach the same `armDrawTool` the button reaches.
    await mountSample(page);

    await page.keyboard.press('r');
    await settle(page);
    const before = await page.locator('[data-oid]').count();
    await beginDrag(page, { x: 80, y: 80 });
    await page.mouse.move(180, 160, { steps: 4 });
    await page.mouse.up();
    await settle(page);

    expect(await page.locator('[data-oid]').count(), 'the drag created an object').toBeGreaterThan(before);
  });

  test('a letter types into an open text session instead of changing the tool', async ({ page }) => {
    // The reason these live in `editing-shortcuts.ts`. With a text frame being edited, "r" is a
    // character; a binding in `shortcuts.ts` would arm a draw tool mid-session.
    // A dedicated text fixture, because the *sample* document's first object is a rectangle: pressing
    // Enter on a shape opens no session, so the test would have passed for the wrong reason -- or, as it
    // did on the first attempt, failed while the binding was correct.
    await mountFixture(page, TEXT_FIXTURE);
    const frame = TEXT_IDS.copy;

    // Enter the text fence, type, and check the tool did not change underneath.
    await clickAt(page, frame.x + 60, frame.y + 20);
    await page.keyboard.press('Enter');
    await settle(page);
    await page.keyboard.press('r');
    await page.keyboard.type('r');
    await settle(page);

    expect(await armedTool(page), 'no draw tool was armed during the text session').toBe('select');

    await page.keyboard.press('Escape');
    await settle(page);
  });

  test('a letter does not change the tool when focus has left an open text session', async ({ page }) => {
    // The case the mutation corpus caught and the previous version of this file missed.
    //
    // `editing-shortcuts.ts` guards twice: an explicit `currentMode === 'textEdit'` return, and a generic
    // "is this a typing target" return. With the caret in the frame the *second* guard already stops the
    // key, so a test that only does that cannot tell the two apart — and a mutation that disables the first
    // guard survives it.
    //
    // Moving focus off the contenteditable while the session stays open is what only the first guard
    // covers, and it is reachable by a user: click a toolbar button, then press a letter.
    await mountFixture(page, TEXT_FIXTURE);
    const frame = TEXT_IDS.copy;

    await clickAt(page, frame.x + 60, frame.y + 20);
    await page.keyboard.press('Enter');
    await settle(page);
    expect(await frameIsEditing(page, 'copy'), 'the session is open').toBe(true);

    // Focus leaves the frame without clicking anything that would act -- `focus()`, not `click()`.
    await page.evaluate(() => {
      (document.querySelector('[data-tool="select"]') as HTMLElement | null)?.focus();
    });
    await settle(page);

    await page.keyboard.press('r');
    await settle(page);

    expect(
      await armedTool(page),
      'the textEdit guard, not the typing-target guard, is what stops this',
    ).toBe('select');
    expect(await frameIsEditing(page, 'copy'), 'and the session survived').toBe(true);

    await page.keyboard.press('Escape');
    await settle(page);
  });
});