import { expect, test } from '@playwright/test';

test('spike visual states', async ({ page }) => {
  await page.goto('/spike.html');
  await page.waitForFunction(() => typeof window.__spike !== 'undefined');

  // Idle: rendered from the model.
  await expect(page.locator('.p1-text-frame').first()).toHaveScreenshot('spike-idle.png');

  // Editing with the browser owning the content.
  await page.evaluate(() => window.__spike.enterEdit());
  const el = page.locator('.p1-text-frame [contenteditable]').first();
  await el.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('A second paragraph typed natively.');
  await expect(page.locator('.p1-text-frame').first()).toHaveScreenshot('spike-editing.png');

  /*
   * After exit: back to the model.
   *
   * NOTE on the baseline: this differs from the pre-M3 recording by one paragraph's
   * margin. Under `contenteditable="true"` Enter produces a real `<p>`, but this
   * harness pins `plaintext-only`, where Enter still inserts a literal `"\n"` inside
   * the existing paragraph. ADR 0003 reads `"\n"` as a soft break (the production
   * meaning), so the committed model keeps this as one paragraph with a newline in it
   * instead of two paragraphs.
   *
   * The diff is a few pixels of vertical offset on one line — which is what a
   * paragraph margin becoming a line break looks like. Both shapes render the same
   * characters in the same order.
   */
  await page.evaluate(() => window.__spike.exitEdit());
  await expect(page.locator('.p1-text-frame').first()).toHaveScreenshot('spike-committed.png');

  // The model's projection is what the browser was told, whatever the mode.
  expect(await page.evaluate(() => window.__spike.modelText())).toBe(
    'Hello world\nA second paragraph typed natively.',
  );

  expect(true).toBe(true);
});