import { expect, test, type Page } from '@playwright/test';

/**
 * Probe: what does the browser actually do for native text undo?
 *
 * The ADR decision depends on these facts, so they are measured rather than
 * assumed. Each probe records observed behaviour into the test output.
 */

async function instrument(page: Page) {
  await page.goto('/spike.html');
  await page.waitForFunction(() => typeof window.__spike !== 'undefined');

  // Record every beforeinput/input the browser emits, with the detail the ADR needs.
  await page.evaluate(() => {
    const log: Array<Record<string, unknown>> = [];
    (window as unknown as { __log: typeof log }).__log = log;

    const content = document.querySelector('.p1-text-content') as HTMLElement;
    content.addEventListener(
      'beforeinput',
      (e) => {
        const ev = e as InputEvent;
        log.push({
          phase: 'beforeinput',
          inputType: ev.inputType,
          cancelable: ev.cancelable,
          defaultPrevented: ev.defaultPrevented,
          isComposing: ev.isComposing,
          data: ev.data,
        });
      },
      true,
    );
    content.addEventListener(
      'input',
      (e) => {
        const ev = e as InputEvent;
        log.push({
          phase: 'input',
          inputType: ev.inputType,
          cancelable: ev.cancelable,
          defaultPrevented: ev.defaultPrevented,
          data: ev.data,
          text: (content as HTMLElement).innerText,
        });
      },
      true,
    );
  });
}

const readLog = (page: Page) =>
  page.evaluate(() => (window as unknown as { __log: Array<Record<string, unknown>> }).__log);

test('PROBE: native undo emits which events?', async ({ page }) => {
  await instrument(page);
  await page.evaluate(() => window.__spike.enterEdit());
  const el = page.locator('.p1-text-frame [contenteditable]').first();
  await el.click();

  await page.keyboard.type('abc');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');

  const log = await readLog(page);
  const text = await page.evaluate(() => window.__spike.domText());
  console.log('UNDO PROBE log:', JSON.stringify(log, null, 2));
  console.log('UNDO PROBE final text:', JSON.stringify(text));

  const historyEvents = log.filter(
    (e) => typeof e['inputType'] === 'string' && String(e['inputType']).startsWith('history'),
  );
  console.log('UNDO PROBE history events:', JSON.stringify(historyEvents, null, 2));
  expect(log.length).toBeGreaterThan(0);
});

test('PROBE: is native beforeinput historyUndo cancelable?', async ({ page }) => {
  await instrument(page);
  await page.evaluate(() => window.__spike.enterEdit());
  const el = page.locator('.p1-text-frame [contenteditable]').first();
  await el.click();
  await page.keyboard.type('abc');

  // Try to suppress the browser's undo by cancelling the beforeinput.
  await page.evaluate(() => {
    const content = document.querySelector('.p1-text-content') as HTMLElement;
    content.addEventListener(
      'beforeinput',
      (e) => {
        const ev = e as InputEvent;
        if (ev.inputType === 'historyUndo') ev.preventDefault();
      },
      true,
    );
  });

  await page.keyboard.press('Control+z');
  const text = await page.evaluate(() => window.__spike.domText());
  const log = await readLog(page);
  const undoEvent = log.find((e) => e['inputType'] === 'historyUndo');
  console.log('CANCEL PROBE text after Ctrl+Z:', JSON.stringify(text));
  console.log('CANCEL PROBE historyUndo event:', JSON.stringify(undoEvent));
  expect(undoEvent).toBeDefined();
});

test('PROBE: can the app trigger native undo programmatically?', async ({ page }) => {
  await instrument(page);
  await page.evaluate(() => window.__spike.enterEdit());
  const el = page.locator('.p1-text-frame [contenteditable]').first();
  await el.click();
  await page.keyboard.type('abc');
  const before = await page.evaluate(() => window.__spike.domText());

  const result = await page.evaluate(() => {
    const content = document.querySelector('.p1-text-content') as HTMLElement;
    content.focus();
    let threw: string | null = null;
    let ok = false;
    try {
      ok = document.execCommand('undo');
    } catch (e) {
      threw = String(e);
    }
    return { ok, threw, text: content.innerText };
  });

  console.log('EXEC PROBE before:', JSON.stringify(before));
  console.log('EXEC PROBE result:', JSON.stringify(result));
  expect(true).toBe(true);
});

test('PROBE: does native undo survive leaving the session?', async ({ page }) => {
  await instrument(page);
  await page.evaluate(() => window.__spike.enterEdit());
  const el = page.locator('.p1-text-frame [contenteditable]').first();
  await el.click();
  await page.keyboard.type('abc');
  await page.evaluate(() => window.__spike.exitEdit());
  const afterExit = await page.evaluate(() => window.__spike.modelText());

  // Re-enter and try to redo: the browser's stack should be gone.
  await page.evaluate(() => window.__spike.enterEdit());
  await page.keyboard.press('Control+Shift+z');
  const afterRedo = await page.evaluate(() => window.__spike.domText());

  console.log('SURVIVE PROBE afterExit:', JSON.stringify(afterExit));
  console.log('SURVIVE PROBE afterRedo:', JSON.stringify(afterRedo));
  expect(true).toBe(true);
});

test('PROBE: what happens to the browser stack on undo past the start?', async ({ page }) => {
  await instrument(page);
  await page.evaluate(() => window.__spike.enterEdit());
  const el = page.locator('.p1-text-frame [contenteditable]').first();
  await el.click();
  await page.keyboard.type('abc');

  const results: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press('Control+z');
    results.push(await page.evaluate(() => window.__spike.domText()));
  }
  console.log('EXHAUST PROBE undo x5:', JSON.stringify(results));

  const log = await readLog(page);
  const undos = log.filter((e) => e['inputType'] === 'historyUndo').length;
  console.log('EXHAUST PROBE historyUndo events:', undos);
  expect(results.length).toBe(5);
});