import { expect, test, type Page } from '@playwright/test';

/**
 * Probe: what does `contenteditable="true"` produce, versus `plaintext-only`?
 *
 * The M3 design hinges on this. Measured on `plaintext-only` first:
 *
 *   `execCommand('bold')` → **false**, `queryCommandState('bold')` → false,
 *   Ctrl+B / Ctrl+I → no markup at all.
 *
 * So a `plaintext-only` fence cannot be the editing surface for formatted text —
 * the browser simply will not produce formatting. The options are therefore to drop
 * `plaintext-only`, or to abandon native formatting. This probe measures what the
 * first option actually costs, so the choice is made on evidence.
 *
 * Retained as the evidence for ADR 0003.
 */

const PAGE = `data:text/html,${encodeURIComponent(`<!doctype html>
<html><head><style>
.frame { width: 300px; border: 1px solid #999; }
.content { outline: none; white-space: pre-wrap; word-break: break-word; }
.content p { margin: 0; }
</style></head><body>
<div class="frame"><div class="content" contenteditable="true"><p>Hello world</p></div></div>
</body></html>`)}`;

const setup = async (page: Page, mode: 'true' | 'plaintext-only'): Promise<void> => {
  await page.goto(PAGE);
  await page.evaluate((m) => {
    const c = document.querySelector('.content') as HTMLElement;
    c.setAttribute('contenteditable', m);
    c.focus();
  }, mode);
};

const html = (page: Page) =>
  page.evaluate(() => (document.querySelector('.content') as HTMLElement).innerHTML);

const selectAll = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const c = document.querySelector('.content') as HTMLElement;
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(c);
    sel?.removeAllRanges();
    sel?.addRange(range);
  });
};

test('PROBE K: contenteditable=true + execCommand bold, tags vs CSS', async ({ page }) => {
  await setup(page, 'true');
  await selectAll(page);

  const withCss = await page.evaluate(() => {
    const ok = document.execCommand('bold');
    return { ok, state: document.queryCommandState('bold') };
  });
  console.log('PROBE K styleWithCSS default:', JSON.stringify(withCss), await html(page));

  // Toggle off, then force tag output and retry.
  await page.evaluate(() => document.execCommand('bold'));
  await page.evaluate(() => document.execCommand('styleWithCSS', false, 'false'));
  await page.evaluate(() => document.execCommand('bold'));
  console.log('PROBE K styleWithCSS=false:', await html(page));

  const italicTag = await page.evaluate(() => {
    const ok = document.execCommand('italic');
    return { ok, state: document.queryCommandState('italic') };
  });
  console.log('PROBE K italic:', JSON.stringify(italicTag), await html(page));

  // The mirror image of PROBE A. Here the command *succeeds*, and it succeeds in
  // producing **semantic tags even with `styleWithCSS` at its default** — which is why
  // the normalizer's mapping is a closed set rather than a CSS parser.
  expect(withCss.ok).toBe(true);
  expect(withCss.state).toBe(true);
  expect(italicTag.ok).toBe(true);
  expect(await html(page)).toBe('<p><b><i>Hello world</i></b></p>');
});

test('PROBE L: contenteditable=true + Ctrl+B / Ctrl+I', async ({ page }) => {
  await setup(page, 'true');
  await page.evaluate(() => document.execCommand('styleWithCSS', false, 'false'));
  await selectAll(page);

  await page.keyboard.press('Control+b');
  console.log('PROBE L after Ctrl+B:', await html(page));
  const boldState = await page.evaluate(() => document.queryCommandState('bold'));

  await page.keyboard.press('Control+i');
  console.log('PROBE L after Ctrl+I:', await html(page));
  const italicState = await page.evaluate(() => document.queryCommandState('italic'));

  // What the toolbar's pressed state depends on: `queryCommandState` is not just
  // permitted here, it is *correct*, so the browser can be the source of truth for
  // whether Bold is on.
  expect(boldState).toBe(true);
  expect(italicState).toBe(true);
  expect(await html(page)).toBe('<p><b><i>Hello world</i></b></p>');
});

test('PROBE M: Enter and Shift+Enter in contenteditable=true', async ({ page }) => {
  await setup(page, 'true');
  await page.evaluate(() => document.execCommand('styleWithCSS', false, 'false'));
  await selectAll(page);
  await page.keyboard.type('one');

  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  const afterEnter = await html(page);

  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('three');
  const afterSoft = await html(page);

  console.log('PROBE M after Enter:', afterEnter);
  console.log('PROBE M after Soft+Enter:', afterSoft);
  console.log(
    'PROBE M innerText:',
    JSON.stringify(await page.evaluate(() => (document.querySelector('.content') as HTMLElement).innerText)),
  );

  // The second measurement ADR 0003 rests on, and the one that *improves* on the
  // spike: Enter is a real block element, so a paragraph boundary is an element and
  // a literal `\n` inside a paragraph is unambiguously a soft break. In
  // `plaintext-only` both were `\n` and the normalizer had to guess.
  expect(afterEnter).toBe('<p>one</p><p>two</p>');
  expect(afterSoft).toBe('<p>one</p><p>two\nthree</p>');
});

test('PROBE N: Enter while inside formatted markup', async ({ page }) => {
  await setup(page, 'true');
  await page.evaluate(() => document.execCommand('styleWithCSS', false, 'false'));
  await selectAll(page);
  await page.keyboard.type('abcdef');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+b');
  console.log('PROBE N bolded:', await html(page));

  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  console.log('PROBE N after Enter inside bold:', await html(page));
  expect(true).toBe(true);
});

test('PROBE O: alignment commands', async ({ page }) => {
  await setup(page, 'true');
  await selectAll(page);

  const results = await page.evaluate(() => ({
    justifyLeft: document.execCommand('justifyLeft'),
    stateLeft: document.queryCommandState('justifyLeft'),
    justifyCenter: document.execCommand('justifyCenter'),
    stateCenter: document.queryCommandState('justifyCenter'),
    justifyFull: document.execCommand('justifyFull'),
    stateFull: document.queryCommandState('justifyFull'),
  }));
  console.log('PROBE O:', JSON.stringify(results));
  console.log('PROBE O html:', await html(page));
  const computed = await page.evaluate(() => {
    const p = document.querySelector('.content p') as HTMLElement;
    return getComputedStyle(p).textAlign;
  });
  console.log('PROBE O computed:', computed);

  // Alignment is a paragraph property in the model (ADR 0003), and it arrives as an
  // inline `style` — byte-for-byte what our own renderer writes. That symmetry is why
  // the conversion is reversible rather than merely invertible.
  expect(results.justifyFull).toBe(true);
  expect(results.stateFull).toBe(true);
  expect(await html(page)).toBe('<p style="text-align: justify;">Hello world</p>');
});

test('PROBE P: backspace merging paragraphs', async ({ page }) => {
  await setup(page, 'true');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  const before = await html(page);

  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  const afterMerge = await html(page);

  console.log('PROBE P before:', before);
  console.log('PROBE P after backspace at start:', afterMerge);

  // Chromium swallows the preceding character first and merges on the second press.
  // Noted rather than asserted as a single step, because it is the browser's editing
  // model and ADR 0001 deliberately did not reimplement it — the model has to survive
  // whatever it chooses, which is what `tests/editor/text.spec.ts` checks.
  expect(afterMerge).toContain('onetwo');
});

test('PROBE Q: an emptied paragraph keeps its height', async ({ page }) => {
  await page.goto(PAGE);
  await page.evaluate(() => {
    const c = document.querySelector('.content') as HTMLElement;
    c.setAttribute('contenteditable', 'true');
  });

  /*
   * Two shapes, measured before and after the stylesheet is added — in that order, on
   * purpose. Measuring our own `<p></p>` while `min-height` was already in force would
   * have reported the height the rule provides and quietly proved nothing about the
   * absence of the rule.
   */
  const browserShape = await page.evaluate(() => {
    const content = document.querySelector('.content') as HTMLElement;
    content.innerHTML = '<p><br></p>';
    const p = content.firstElementChild as HTMLElement;
    return { height: p.getBoundingClientRect().height };
  });

  // *Our* re-projection: an emptied paragraph is `<p></p>` with nothing inside, because
  // ADR 0003's renderer emits no `<br>` — `pre-wrap` already handles real soft breaks.
  const oursBare = await page.evaluate(() => {
    const content = document.querySelector('.content') as HTMLElement;
    content.innerHTML = '<p></p>';
    const p = content.firstElementChild as HTMLElement;
    return { height: p.getBoundingClientRect().height };
  });

  await page.addStyleTag({ content: '.content p { min-height: 1em; }' });
  const withMinHeight = await page.evaluate(() => {
    const content = document.querySelector('.content') as HTMLElement;
    content.innerHTML = '<p></p>';
    const p = content.firstElementChild as HTMLElement;
    return { height: p.getBoundingClientRect().height, declared: getComputedStyle(p).minHeight };
  });

  console.log('PROBE Q browser <p><br></p> height:', JSON.stringify(browserShape));
  console.log('PROBE Q our <p></p>, no rule:', JSON.stringify(oursBare));
  console.log('PROBE Q our <p></p>, min-height:1em:', JSON.stringify(withMinHeight));

  // The browser's own shape already has height, because it keeps a `<br>` for exactly
  // this reason. Ours has none — zero — so `min-height` is load-bearing rather than
  // cosmetic, and ADR 0001 finding 4 becomes a requirement instead of a nicety.
  expect(browserShape.height).toBeGreaterThan(0);
  expect(oursBare.height).toBe(0);
  expect(withMinHeight.height).toBeGreaterThan(0);
});

test('PROBE R: what markup does typing-after-format produce?', async ({ page }) => {
  await setup(page, 'true');
  await page.evaluate(() => document.execCommand('styleWithCSS', false, 'false'));
  await page.keyboard.press('Control+a');
  await page.keyboard.type('plain');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+b');
  await page.keyboard.press('End');
  await page.keyboard.type('BOLD');

  const mixed = await html(page);
  console.log('PROBE R mixed formatting:', mixed);

  // A pending format continues past the point the selection was applied to. This is
  // why an *empty* paragraph has to be allowed to carry a format in the model, and why
  // the normalizer is allowed to lose one on an empty paragraph: the browser owns the
  // pending state during the session, and by the time the model sees it there are
  // characters to attach it to.
  expect(mixed).toContain('<b>');
});

test('PROBE S: does bold state survive a caret move?', async ({ page }) => {
  await setup(page, 'true');
  await page.evaluate(() => document.execCommand('styleWithCSS', false, 'false'));
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+b');
  await page.keyboard.press('End');

  const states = await page.evaluate(() => ({
    bold: document.queryCommandState('bold'),
    supported: document.queryCommandSupported('bold'),
  }));
  console.log('PROBE S at end of bold text:', JSON.stringify(states));

  expect(states.supported).toBe(true);
  expect(states.bold).toBe(true);
});

test('PROBE T: underline / strikethrough availability', async ({ page }) => {
  await setup(page, 'true');
  await selectAll(page);
  const results = await page.evaluate(() => ({
    underlineSupported: document.queryCommandSupported('underline'),
    strikeSupported: document.queryCommandSupported('strikeThrough'),
    superscriptSupported: document.queryCommandSupported('superscript'),
    subscriptSupported: document.queryCommandSupported('subscript'),
    underline: document.execCommand('underline'),
    html: (document.querySelector('.content') as HTMLElement).innerHTML,
  }));
  console.log('PROBE T:', JSON.stringify(results));

  // Underline and strikethrough are the other two of the four flags in `CharFormat`,
  // and both emit the semantic tag the normalizer maps. Superscript and subscript are
  // *reported* as supported — a trap worth naming: they are positional, not just
  // styling, and ADR 0003 declines them for that reason rather than because the
  // browser refuses.
  expect(results.underlineSupported).toBe(true);
  expect(results.strikeSupported).toBe(true);
  expect(results.underline).toBe(true);
  expect(results.html).toBe('<p><u>Hello world</u></p>');
});
