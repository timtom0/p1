import type { Page } from '@playwright/test';
import { clickAt, expect, settle, test } from '../editor/helpers';
import { mountFixture } from '../visual/harness';
import { SIMPLE } from './measure-fixtures';

/**
 * PROBE S: which per-keystroke work degrades the browser's undo grouping?
 *
 * ADR 0002 measured that Chromium coalesces consecutive keystrokes into one undo unit,
 * and the application delegates to it. That grouping is load-bearing: "type a word,
 * press Ctrl+Z once, get the original text" depends on it.
 *
 * Wiring the session's `onDomChange` to a full chrome refresh broke exactly that —
 * Ctrl+Z went to one character per press, which would have made ADR 0002's delegation
 * useless. So this probe exists to turn "don't do that" into a rule precise enough to
 * act on.
 *
 * Scenarios, each applying work *between* keystrokes:
 *
 *   none       nothing (the baseline that must undo the whole word)
 *   layout     a forced layout read (`clientHeight`)
 *   selection  a selection query (`queryCommandState`)
 *   overlay    rebuilding the overlay's DOM
 *   chrome     rewriting a toolbar button's text
 *   full       the actual `Editor.onChange` refresh, all three at once
 *
 * Measured result: reads are safe, mutations are not. See the note on `full` below.
 */

const CONTENT = '[data-objects] [data-oid="copy"] .p1-text-content';

type Scenario =
  | 'none'
  | 'layout'
  | 'selection'
  | 'overlay'
  | 'chrome'
  | 'both-reads'
  | 'full';

const SCENARIOS: readonly Scenario[] = [
  'none',
  'layout',
  'selection',
  'both-reads',
  'overlay',
  'chrome',
  'full',
];

async function scenario(page: Page, which: Scenario): Promise<{ after: string; undone: boolean }> {
  for (const key of ['a', 'b', 'c']) {
    await page.keyboard.type(key);

    if (which === 'layout' || which === 'both-reads' || which === 'full') {
      await page.evaluate(() => {
        void (document.querySelector('.p1-text-content') as HTMLElement).clientHeight;
      });
    }
    if (which === 'selection' || which === 'both-reads' || which === 'full') {
      await page.evaluate(() => {
        document.queryCommandState('bold');
      });
    }
    if (which === 'overlay' || which === 'full') {
      await page.evaluate(() => {
        const layer = document.querySelector('[data-overlay]') as HTMLElement | null;
        if (layer === null) return;
        // The same shape of work `Overlay.render` does: throw the subtree away and
        // build it again.
        const scratch = document.createElement('div');
        scratch.textContent = '0';
        layer.replaceChildren(scratch);
      });
    }
    if (which === 'chrome' || which === 'full') {
      await page.evaluate(() => {
        const button = document.querySelector('[data-edit="undo"]') as HTMLElement | null;
        if (button === null) return;
        button.textContent = button.textContent ?? '';
      });
    }
  }

  await page.keyboard.press('Control+z');
  const after = await page.evaluate(
    () => (document.querySelector('.p1-text-content') as HTMLElement).textContent ?? '',
  );
  return { after, undone: after === 'Hello' };
}

for (const which of SCENARIOS) {
  test(`PROBE S: undo granularity with ${which} work per keystroke`, async ({ page }) => {
    await mountFixture(page, SIMPLE);
    await clickAt(page, 60, 60);
    await page.keyboard.press('Enter');
    await page.locator(CONTENT).click();
    await page.keyboard.press('End');
    await settle(page);

    const result = await scenario(page, which);
    console.log(`PROBE S ${which}: ${JSON.stringify(result)}`);
    expect(true).toBe(true);
  });
}
