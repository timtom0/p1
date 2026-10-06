import { expect, test, type Page } from '@playwright/test';

/**
 * Probe: can `plaintext-only` produce inline formatting at all?
 *
 * This is the single measurement M3's model design hinges on. ADR 0001 established
 * that inline formatting is "discarded" and that supporting it means extending both
 * directions of `rich-text-html.ts`. It did **not** establish whether the browser
 * will *emit* formatting in `plaintext-only` mode — and if it will not, a
 * format-preserving normalizer would be dead code and formatted text could only
 * arrive by paste.
 *
 * Every assertion here is observational (`console.log` + a trivially-true expect), so
 * the file records behaviour without asserting an answer I have not decided yet.
 * It is retained as the evidence for ADR 0003.
 */

const probe = async (page: Page): Promise<void> => {
  await page.goto('/spike.html');
  await page.waitForFunction(() => typeof window.__spike !== 'undefined');
};

const enter = async (page: Page): Promise<void> => {
  await page.evaluate(() => window.__spike.enterEdit());
  await page.locator('.p1-text-content').first().click();
};

const html = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector('.p1-text-content') as HTMLElement;
    return c.innerHTML;
  });

const info = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector('.p1-text-content') as HTMLElement;
    return { editable: c.getAttribute('contenteditable'), text: c.innerText };
  });

test('PROBE A: execCommand bold in plaintext-only', async ({ page }) => {
  await probe(page);
  await enter(page);

  await page.evaluate(() => {
    const c = document.querySelector('.p1-text-content') as HTMLElement;
    c.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(c);
    sel?.removeAllRanges();
    sel?.addRange(range);
  });

  const result = await page.evaluate(() => {
    const out: Record<string, unknown> = {};
    out.queryStateBold = document.queryCommandState('bold');
    out.execBold = document.execCommand('bold');
    out.execBoldWithCss = document.execCommand('styleWithCSS', false, 'false');
    out.execBold2 = document.execCommand('bold');
    out.queryStateBoldAfter = document.queryCommandState('bold');
    return out;
  });

  console.log('PROBE A result:', JSON.stringify(result));
  console.log('PROBE A html:', await html(page));
  console.log('PROBE A info:', JSON.stringify(await info(page)));

  // The decisive measurement of ADR 0003. `execCommand` *refuses*: it returns false
  // and writes nothing, so no model reachable from this mode could ever carry a
  // character format. `styleWithCSS` is accepted (true) because it is not a formatting
  // command — it configures how formatting would be written.
  expect(result['execBold']).toBe(false);
  expect(result['execBold2']).toBe(false);
  expect(result['queryStateBold']).toBe(false);
  expect(result['queryStateBoldAfter']).toBe(false);
  expect(await html(page)).not.toMatch(/<\/?[biu]/);
});

test('PROBE B: Ctrl+B / Ctrl+I keyboard in plaintext-only', async ({ page }) => {
  await probe(page);
  await enter(page);

  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+b');
  const afterBold = await html(page);

  await page.keyboard.press('Control+i');
  const afterItalic = await html(page);

  console.log('PROBE B after Ctrl+B:', afterBold);
  console.log('PROBE B after Ctrl+I:', afterItalic);
  console.log('PROBE B info:', JSON.stringify(await info(page)));

  // Ctrl+B routes through the same refused command, so the keyboard is no escape
  // hatch either. This is what rules out "keep `plaintext-only` and add formatting".
  expect(afterBold).not.toMatch(/<\/?[biu]/);
  expect(afterItalic).not.toMatch(/<\/?[biu]/);
});

/**
 * Selects `count` characters from the start of the frame's first text node.
 *
 * Walked rather than assumed: `content.firstChild` is a `<p>`, not a text node, and
 * an offset into the wrong kind of node throws `IndexSizeError` — which is how the
 * first version of these two probes failed, with an error that said nothing about the
 * thing being measured.
 */
const selectFirstCharacters = async (page: Page, count: number): Promise<void> => {
  await page.evaluate((n) => {
    const content = document.querySelector('.p1-text-content') as HTMLElement;
    content.focus();

    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    if (node === null) throw new Error('The frame holds no text');
    if ((node.nodeValue ?? '').length < n) {
      throw new Error(`The first text node holds ${(node.nodeValue ?? '').length} characters, need ${n}`);
    }

    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, n);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, count);
};

test('PROBE C: does Enter still make \\n when inside formatted markup?', async ({ page }) => {
  await probe(page);
  await enter(page);

  // Formatting cannot be applied in `plaintext-only`, so the premise of this probe is
  // false and the answer is "nothing happened" — which is the point. It is retained
  // because the *contrast* with PROBE N in the contenteditable probe is the evidence
  // ADR 0003 rests on.
  await selectFirstCharacters(page, 5);
  const applied = await page.evaluate(() => document.execCommand('bold'));

  const beforeEnter = await html(page);
  await page.keyboard.press('Enter');
  const afterEnter = await html(page);
  await page.keyboard.type('X');

  console.log('PROBE C execCommand(bold) returned:', applied);
  console.log('PROBE C before Enter:', beforeEnter);
  console.log('PROBE C after Enter:', afterEnter);
  console.log('PROBE C after typing:', await html(page));

  // The substantive claim, asserted rather than merely logged: no markup, ever.
  expect(applied).toBe(false);
  expect(await html(page)).not.toMatch(/<\/?[biu]/);
});

test('PROBE D: what does queryCommandState report for a partial selection?', async ({ page }) => {
  await probe(page);
  await enter(page);

  await selectFirstCharacters(page, 4);

  const states = await page.evaluate(() => {
    const before = document.queryCommandState('bold');
    const applied = document.execCommand('bold');
    const after = document.queryCommandState('bold');
    return { before, applied, after, fontName: document.queryCommandValue('fontName') };
  });

  console.log('PROBE D:', JSON.stringify(states));
  console.log('PROBE D html:', await html(page));

  // `queryCommandState` cannot report a state the command cannot apply, so it never
  // becomes true — which is why a `plaintext-only` toolbar would have no pressed
  // state to show even if `execCommand` were allowed to fail silently.
  expect(states.before).toBe(false);
  expect(states.applied).toBe(false);
  expect(states.after).toBe(false);
});

test('PROBE E: does the fence survive formatting — i.e. does exit produce readable text?', async ({ page }) => {
  await probe(page);
  await enter(page);

  await page.keyboard.press('Control+a');
  await page.keyboard.type('Formatted');
  await page.keyboard.press('Control+b');
  await page.keyboard.press('End');
  await page.keyboard.type(' tail');

  const domHtml = await html(page);
  await page.evaluate(() => window.__spike.exitEdit());

  console.log('PROBE E dom html before exit:', domHtml);
  console.log('PROBE E model text after exit:', await page.evaluate(() => window.__spike.modelText()));
  expect(true).toBe(true);
});

test('PROBE F: paste of formatted HTML', async ({ page }) => {
  await probe(page);
  await enter(page);

  await page.evaluate(() => {
    const c = document.querySelector('.p1-text-content') as HTMLElement;
    c.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(c);
    sel?.removeAllRanges();
    sel?.addRange(range);
  });

  await page.evaluate(() => {
    const c = document.querySelector('.p1-text-content') as HTMLElement;
    const dt = new DataTransfer();
    dt.setData(
      'text/html',
      '<p>one <b>two</b> <span style="font-style:italic">three</span></p><p><i>four</i></p>',
    );
    dt.setData('text/plain', 'one two three\nfour');
    c.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });

  console.log('PROBE F html after paste:', await html(page));
  console.log('PROBE F info:', JSON.stringify(await info(page)));
  expect(true).toBe(true);
});

test('PROBE G: nbsp, br, and div normalisation on exit', async ({ page }) => {
  await probe(page);
  await enter(page);

  await page.evaluate(() => {
    const c = document.querySelector('.p1-text-content') as HTMLElement;
    c.innerHTML = 'a&nbsp;b<div>c</div>d<br>e';
  });

  const domHtml = await html(page);
  await page.evaluate(() => window.__spike.exitEdit());
  console.log('PROBE G dom html:', domHtml);
  console.log('PROBE G model text:', await page.evaluate(() => window.__spike.modelText()));
  expect(true).toBe(true);
});

test('PROBE H: an empty paragraph — what DOM does the session leave?', async ({ page }) => {
  await probe(page);
  await enter(page);

  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  const afterDelete = await html(page);

  await page.keyboard.type('a');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  const twoBreaks = await html(page);
  await page.keyboard.type('b');

  console.log('PROBE H after select-all delete:', afterDelete);
  console.log('PROBE H after Enter Enter:', twoBreaks);
  console.log('PROBE H final html:', await html(page));
  await page.evaluate(() => window.__spike.exitEdit());
  console.log('PROBE H model text:', JSON.stringify(await page.evaluate(() => window.__spike.modelText())));
  expect(true).toBe(true);
});

test('PROBE I: how does the renderer round-trip an empty paragraph?', async ({ page }) => {
  await probe(page);

  // Drive the model to an empty paragraph through the spike's own external-write
  // hook, which is the only model write the spike exposes.
  await page.evaluate(() => window.__spike.externalText());
  await page.evaluate(() => window.__spike.rerenderWhileEditing());

  const contentHtml = await html(page);
  const box = await page
    .locator('.p1-text-content')
    .first()
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      const inner = el.firstElementChild as HTMLElement | null;
      return {
        contentHeight: r.height,
        firstChildTag: inner?.tagName ?? null,
        firstChildHeight: inner?.getBoundingClientRect().height ?? null,
      };
    });

  console.log('PROBE I html:', contentHtml);
  console.log('PROBE I box:', JSON.stringify(box));
  expect(true).toBe(true);
});

test('PROBE J: computed typography is readable for measurement', async ({ page }) => {
  await probe(page);
  const styles = await page.evaluate(() => {
    const c = document.querySelector('.p1-text-content') as HTMLElement;
    const s = getComputedStyle(c);
    return {
      fontFamily: s.fontFamily,
      fontSize: s.fontSize,
      lineHeight: s.lineHeight,
      whiteSpace: s.whiteSpace,
      display: s.display,
    };
  });
  console.log('PROBE J:', JSON.stringify(styles));
  expect(true).toBe(true);
});
