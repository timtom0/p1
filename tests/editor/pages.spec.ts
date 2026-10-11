/**
 * Page management through the real UI.
 *
 * ## Why this is a browser suite and not more model tests
 *
 * `page-commands.test.ts` proves the model does the right thing. It cannot prove the *panel* does:
 * that the buttons are wired, that the minimum-page invariant reaches the control as a disabled state
 * rather than as a silent no-op, that undo covers a page operation, or that the status bar stops
 * claiming a single paper size once the document is mixed. Those are exactly the failures that are
 * invisible from the model, and they are the same class of gap `tool-shortcuts.spec.ts` documents --
 * a title attribute asserting an interface that nothing implements.
 *
 * ## The duplicate-attribute bug this suite was written against
 *
 * The panel and the document-setup dialog both used `data-setup-preset` and `data-setup-resize`. A
 * `querySelector` for either was ambiguous, and a strict-mode locator threw rather than guessing. The
 * panel's controls now carry `data-pages-*`; the dialog keeps `data-setup-*`. That is asserted here by
 * construction -- every selector below is expected to resolve to exactly one element, so a future
 * collision fails the suite rather than quietly breaking whichever test runs next.
 */

import type { Page } from '@playwright/test';

import { expect, settle, test } from './helpers';

/** The page rows currently listed, as their rendered size labels. */
async function pageLabels(page: Page): Promise<string[]> {
  return page.locator('.p1-pages__size').allTextContents();
}

async function pageCount(page: Page): Promise<number> {
  return page.locator('[data-page-row]').count();
}

/** The status bar's page-stack readout, which is where a mixed document has to admit itself. */
async function stackStat(page: Page): Promise<string> {
  return ((await page.locator('[data-stat="stack"]').textContent()) ?? '').trim();
}

/** Opens the New-document dialog and returns once it is modal. */
async function openSetup(page: Page): Promise<void> {
  await page.click('[data-doc="new"]');
  await page.waitForSelector('[data-document-setup][open]');
}

/** Creates a document from the dialog with whatever it currently shows. */
async function confirmSetup(page: Page): Promise<void> {
  await page.click('[data-setup-create]');
  await page.waitForSelector('[data-document-setup]', { state: 'hidden' });
  await settle(page);
}

test.describe('the pages panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-pages-panel] [data-page-row]');
  });

  test('lists the document pages with their sizes', async ({ page }) => {
    expect(await pageCount(page)).toBe(1);
    // The label prefers a preset name over raw numbers, so this asserts the user-facing form.
    expect((await pageLabels(page))[0]).toContain('A4');
  });

  test('adds a page, which takes the document default under a fixed-size setup', async ({ page }) => {
    await page.click('[data-page-action="add"]');
    await settle(page);
    const labels = await pageLabels(page);
    expect(labels).toHaveLength(2);
    expect(labels[1]).toBe(labels[0]);
  });

  test('duplicates the focused page', async ({ page }) => {
    await page.click('[data-page-action="add"]');
    await settle(page);
    await page.click('[data-page-row]:nth-child(2) [data-page-select]');
    await settle(page);
    await page.click('[data-page-action="duplicate"]');
    await settle(page);
    expect(await pageCount(page)).toBe(3);
  });

  test('deletes a page', async ({ page }) => {
    await page.click('[data-page-action="add"]');
    await settle(page);
    await page.click('[data-page-action="delete"]');
    await settle(page);
    expect(await pageCount(page)).toBe(1);
  });

  test('disables delete on the last page rather than failing silently', async ({ page }) => {
    // The model refuses by returning the same document, which is invisible from here. The control has
    // to say so, and the title has to give a reason -- an unexplained disabled button is a bug report.
    const button = page.locator('[data-page-action="delete"]');
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', /at least one page/);
  });

  test('reorders pages', async ({ page }) => {
    await page.click('[data-page-action="add"]');
    await settle(page);
    await page.click('[data-page-row]:nth-child(2) [data-page-select]');
    await settle(page);
    await page.click('[data-page-action="up"]');
    await settle(page);

    // Reordering renames pages by position, so the moved page is now first.
    await expect(page.locator('[data-page-row]:first-child')).toHaveAttribute('aria-current', 'true');
  });

  test('resizes one page, and the chrome then admits the document is mixed', async ({ page }) => {
    // Two pages first: a one-page document cannot be mixed, and asserting "mixed" on one would be
    // asserting a lie rather than the feature.
    await page.click('[data-page-action="add"]');
    await settle(page);
    expect(await stackStat(page)).not.toContain('mixed');

    await page.locator('[data-page-width]').fill('100');
    await page.locator('[data-page-width]').press('Tab');
    await settle(page);

    expect(await stackStat(page)).toContain('mixed');
  });

  test('undo covers a page operation', async ({ page }) => {
    await page.click('[data-page-action="add"]');
    await settle(page);
    expect(await pageCount(page)).toBe(2);

    await page.click('[data-edit="undo"]');
    await settle(page);
    expect(await pageCount(page)).toBe(1);
  });

  test('the document defaults are editable, and say what fixed size does', async ({ page }) => {
    // The label has to be honest: `fixedSize` governs the *next* page, not every existing one.
    await expect(page.locator('[data-pages-fixed-size]')).toBeChecked();
    await expect(page.locator('.p1-pages__section').last()).toContainText('copies the page you are on');
  });
});

test.describe('document setup', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-pages-panel] [data-page-row]');
  });

  test('opens pre-filled from the open document', async ({ page }) => {
    // Not the factory default. Someone working in A5 who presses New almost always wants A5 again.
    await openSetup(page);
    await expect(page.locator('[data-setup-width]')).toHaveValue('210');
    await expect(page.locator('[data-setup-height]')).toHaveValue('297');
  });

  test('a preset fills the custom fields', async ({ page }) => {
    await openSetup(page);
    await page.selectOption('[data-setup-preset]', 'a5');
    await expect(page.locator('[data-setup-width]')).toHaveValue('148');
    await expect(page.locator('[data-setup-height]')).toHaveValue('210');
  });

  test('creates a document at the chosen preset', async ({ page }) => {
    await openSetup(page);
    await page.selectOption('[data-setup-preset]', 'a5');
    await confirmSetup(page);
    expect((await pageLabels(page))[0]).toContain('A5');
  });

  test('cancelling leaves the document alone', async ({ page }) => {
    const before = await pageLabels(page);
    await openSetup(page);
    await page.selectOption('[data-setup-preset]', 'a5');
    await page.click('[data-setup-cancel]');
    await settle(page);
    expect(await pageLabels(page)).toEqual(before);
  });

  test('Escape cancels too', async ({ page }) => {
    // The dialog is a native <dialog>, so Escape is dismissal for free; this asserts it stays free.
    const before = await pageLabels(page);
    await openSetup(page);
    await page.keyboard.press('Escape');
    await settle(page);
    expect(await pageLabels(page)).toEqual(before);
  });

  test('refuses a non-positive width, and stays open', async ({ page }) => {
    await openSetup(page);
    await page.locator('[data-setup-width]').fill('0');
    await page.click('[data-setup-create]');
    await expect(page.locator('[data-setup-error]')).not.toHaveText('');
    await expect(page.locator('[data-document-setup]')).toHaveAttribute('open', '');
  });

  test('an independently-sized document continues from the page it was added after', async ({ page }) => {
    await openSetup(page);
    await page.selectOption('[data-setup-preset]', 'a5');
    await page.uncheck('[data-setup-fixed-size]');
    await confirmSetup(page);

    // Resize the only page to something else, then add: the new page follows the page it follows.
    await page.locator('[data-page-width]').fill('100');
    await page.locator('[data-page-width]').press('Tab');
    await settle(page);
    await page.click('[data-page-action="add"]');
    await settle(page);

    const labels = await pageLabels(page);
    expect(labels[1]).toContain('100');
  });

  test('a fixed-size document ignores the preceding page', async ({ page }) => {
    // The converse, and the one a reader is most likely to assume wrongly.
    await openSetup(page);
    await page.selectOption('[data-setup-preset]', 'a4');
    await confirmSetup(page);

    await page.locator('[data-page-width]').fill('100');
    await page.locator('[data-page-width]').press('Tab');
    await settle(page);
    await page.click('[data-page-action="add"]');
    await settle(page);

    const labels = await pageLabels(page);
    expect(labels[1]).toContain('A4');
  });
});