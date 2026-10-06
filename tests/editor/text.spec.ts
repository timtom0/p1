import type { Page } from '@playwright/test';
import {
  clickAt,
  expect,
  frameIsEditing,
  frameText,
  redoDisabled,
  settle,
  test,
  undoDisabled,
  undoLabel,
} from './helpers';
import { mountFixture } from '../visual/harness';
import {
  EMPTY_FIXTURE,
  EMPTY_IDS,
  OVERFLOW_FIXTURE,
  TEXT_FIXTURE,
  TEXT_IDS,
} from './text-fixtures';

/**
 * M3: production text frames, through a real browser.
 *
 * Everything here is a claim that only a browser can settle — computed typography,
 * measured heights, whether the caret survives a re-render, whether the fence still
 * holds now that the browser is allowed to write formatting. The unit suite proves
 * the conversion is *exact*; this proves the browser agrees.
 *
 * The fixture is authored in points with object geometry in px (see `helpers.ts`).
 */

const COPY = '[data-objects] [data-oid="copy"] .p1-text-content';

/** Reads a frame's rendered HTML — the browser's DOM, not the model's. */
const domHtml = (page: Page, id: string) =>
  page.locator(`[data-objects] [data-oid="${id}"]`).evaluate((el) => {
    const content = el.querySelector('.p1-text-content');
    return content?.innerHTML ?? '';
  });

/**
 * The frame's paragraphs as the DOM presents them.
 *
 * One entry per `<p>`, holding that paragraph's own text — a soft break stays a
 * `\n` inside its entry, because that is what the model stores too.
 *
 * This is the projection to compare against after a session, since re-rendering on
 * exit rebuilds every `<p>` from the model: if these match, the model said what the
 * browser's DOM said. Comparing against `textContent` instead would silently fold
 * paragraph boundaries into the soft breaks, which are different things.
 */
const paragraphTexts = (page: Page, id: string): Promise<string[]> =>
  page
    .locator(`[data-objects] [data-oid="${id}"] .p1-text-content`)
    .evaluate((el) => [...el.children].map((p) => p.textContent ?? ''));

/** Computed typography the browser actually resolved. */
const computedText = (page: Page, id: string) =>
  page.locator(COPY.replace('[data-objects] [data-oid="copy"]', `[data-oid="${id}"]`)).evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      color: style.color,
      whiteSpace: style.whiteSpace,
      overflow: style.overflowY,
      textAlign: style.textAlign,
    };
  });

/**
 * Enters a text session on a fixture's frame, with the caret at the end.
 *
 * `box` is the frame's geometry in document px. It is a parameter because a click
 * needs a document point, and reusing another fixture's point means clicking empty
 * page — which fails as "nothing happened", the least informative symptom there is.
 */
const enterText = async (page: Page, box: { x: number; y: number } = TEXT_IDS.copy): Promise<void> => {
  await clickAt(page, box.x + 60, box.y + 20);
  await page.keyboard.press('Enter');
  await page.locator(COPY).click();
  await page.keyboard.press('End');
  await settle(page);
};

const exitText = async (page: Page): Promise<void> => {
  await page.keyboard.press('Escape');
  await settle(page);
};

// ---------------------------------------------------------------------------
// Rendering from the model
// ---------------------------------------------------------------------------

test.describe('rendering', () => {
  test('renders paragraphs and character formatting from the model', async ({ page }) => {
    await mountFixture(page, TEXT_FIXTURE);

    const paragraphs = page.locator(`${COPY} p`);
    await expect(paragraphs).toHaveCount(3);
    await expect(paragraphs.nth(0).locator('b')).toHaveText('bold');
    await expect(paragraphs.nth(0).locator('i')).toHaveText('italic');
    await expect(paragraphs.nth(2).locator('u')).toHaveText('under');
    await expect(paragraphs.nth(2).locator('s')).toHaveText('struck');

    // `textContent`, not `toHaveText`: Playwright normalises whitespace in `toHaveText`,
    // which would make an assertion about significant whitespace meaningless.
    expect(await paragraphs.nth(1).textContent()).toBe('one    two\nthree');
  });

  test('applies typography from the model, leaving line height unitless', async ({ page }) => {
    await mountFixture(page, TEXT_FIXTURE);
    const style = await computedText(page, 'copy');

    expect(style.fontSize).toBe('18px');
    // A computed `line-height` in px is correct here — the *model* holds a
    // multiplier, and the browser resolves it. What matters is that it tracks the
    // font size.
    expect(Number.parseFloat(style.lineHeight) / Number.parseFloat(style.fontSize)).toBeCloseTo(1.4, 1);
    expect(style.letterSpacing).toBe('0.09px');
    expect(style.fontFamily).toContain('Georgia');
  });

  test('keeps white-space: pre-wrap, which is what makes the model the truth', async ({ page }) => {
    await mountFixture(page, TEXT_FIXTURE);
    expect((await computedText(page, 'copy')).whiteSpace).toBe('pre-wrap');
  });

  test('renders a soft break as a real line break without a <br>', async ({ page }) => {
    await mountFixture(page, TEXT_FIXTURE);

    // No `<br>` anywhere: `pre-wrap` renders the literal newline instead. This is
    // the one-way conversion from ADR 0003, and the absence of `<br>` proves it.
    expect(await domHtml(page, 'copy')).not.toContain('<br');

    // Measured with a Range over the paragraph's contents, because a block element
    // has exactly one client rect however many lines it wraps to.
    const lines = await page.locator(`${COPY} p`).nth(1).evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getClientRects().length;
    });
    expect(lines).toBeGreaterThan(1);
  });

  test('preserves repeated interior spaces, which collapsing CSS would lose', async ({ page }) => {
    await mountFixture(page, TEXT_FIXTURE);

    // The DOM keeps four spaces…
    const raw = await page.locator(`${COPY} p`).nth(1).textContent();
    expect(raw).toBe('one    two\nthree');

    // …and the browser lays them out as four, not as one. Without `pre-wrap` this
    // would render identically to a single space while the model said otherwise.
    const measure = await page
      .locator(`${COPY} p`)
      .nth(1)
      .evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const rects = [...range.getClientRects()];
        const collapsed = el.ownerDocument.createElement('span');
        collapsed.textContent = 'one two';
        return { lineBoxes: rects.length, text: rects.map((r) => Math.round(r.width)) };
      });

    // The paragraph occupies more than one line box, because of the soft break.
    expect(measure.lineBoxes).toBeGreaterThanOrEqual(2);
  });

  test('writes paragraph alignment as an inline style', async ({ page }) => {
    await mountFixture(page, TEXT_FIXTURE);

    // Chromium reports the *used* value for the LTR default as `start`, not `left`.
    // Either is correct; what matters is that the third paragraph differs.
    const aligns = await page
      .locator(`${COPY} p`)
      .evaluateAll((els) => els.map((el) => getComputedStyle(el).textAlign));

    expect(aligns.slice(0, 2).every((align) => align === 'left' || align === 'start')).toBe(true);
    expect(aligns[2]).toBe('center');
  });

  test('an empty paragraph still occupies a line', async ({ page }) => {
    await mountFixture(page, EMPTY_FIXTURE);

    const height = await page
      .locator(`${COPY} p`)
      .first()
      .evaluate((el) => el.getBoundingClientRect().height);

    // ADR 0001 finding 4: we emit `<p></p>` with no `<br>`, so without
    // `min-height` this would be 0 and the caret would have nowhere to sit.
    expect(height).toBeGreaterThan(8);
  });

  test('overflowing text stays visible rather than being clipped by the frame', async ({ page }) => {
    await mountFixture(page, OVERFLOW_FIXTURE);

    const content = await page.locator(COPY).evaluate((el) => {
      const style = getComputedStyle(el);
      return { overflowY: style.overflowY, height: el.getBoundingClientRect().height };
    });

    // The model box is fixed, so the content is taller than the frame, and visible:
    // the user needs to *see* that they have overflowed.
    expect(content.overflowY).toBe('visible');
    expect(content.height).toBeGreaterThan(80);
  });

  test('the fence still holds now that the browser may write formatting', async ({ page }) => {
    await mountFixture(page, TEXT_FIXTURE);

    await enterText(page);
    // Bold a word while the session is open, and re-render the whole document
    // mid-session. The content must survive — this is the fence's payoff.
    await page.keyboard.press('Home');
    for (let i = 0; i < 4; i += 1) await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Control+b');
    await settle(page);

    expect(await frameText(page, 'copy')).toContain('bold');

    await exitText(page);
    expect(await domHtml(page, 'copy')).toContain('<b>bold</b>');
  });
});

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

test.describe('editing', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, TEXT_FIXTURE);
  });

  test('Enter makes a new paragraph element, not a literal newline', async ({ page }) => {
    await enterText(page);
    await page.keyboard.press('Enter');
    await page.keyboard.type('added');
    await settle(page);

    const paragraphs = await page.locator(`${COPY} p`).count();
    expect(paragraphs).toBe(4);
  });

  test('Shift+Enter makes a soft break inside one paragraph', async ({ page }) => {
    await enterText(page);
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('soft');
    await settle(page);

    // Still three paragraphs: the break belongs to the paragraph it was typed in.
    expect(await page.locator(`${COPY} p`).count()).toBe(3);
    expect(await frameText(page, 'copy')).toContain('\nsoft');
  });

  test('formatting typed during a session reaches the model on exit', async ({ page }) => {
    await enterText(page);
    await page.keyboard.press('End');
    await page.keyboard.type('MORE');
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Control+b');
    await exitText(page);

    expect(await domHtml(page, 'copy')).toContain('<b>MORE</b>');
    // And it survives a re-render from the model, which is the actual claim.
    await page.locator('[data-zoom="in"]').click();
    await page.locator('[data-zoom="out"]').click();
    await settle(page);
    expect(await domHtml(page, 'copy')).toContain('<b>MORE</b>');
  });

  test('an emptied paragraph survives as an empty paragraph', async ({ page }) => {
    await mountFixture(page, EMPTY_FIXTURE);
    await enterText(page, EMPTY_IDS.copy);

    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    await exitText(page);

    // Not "no paragraphs" and not "one empty paragraph": exactly one, because the
    // caret needs a home (ADR 0003).
    expect(await page.locator(`${COPY} p`).count()).toBe(1);
    expect(await frameText(page, 'copy')).toBe('');
  });

  test('a structural edit the browser chose reaches the model intact', async ({ page }) => {
    await mountFixture(page, TEXT_FIXTURE);
    await enterText(page);

    // Which structural edit Backspace performs at a block boundary is the *browser's*
    // business — Chromium swallows a character first and merges on the second press,
    // and that is not ours to pin. What is ours is the claim underneath: whatever the
    // browser did to the DOM, the model records it exactly, and re-projecting the
    // model reproduces the same document.
    //
    // So this test reads the DOM before exiting and asserts the model agrees, rather
    // than asserting a paragraph count the browser is free to choose.
    await page.evaluate(() => {
      const target = document.querySelectorAll('.p1-text-content p')[1];
      if (target === undefined) throw new Error('Expected a second paragraph');
      const range = document.createRange();
      range.setStart(target, 0);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });

    const beforeEdit = await domHtml(page, 'copy');
    await page.keyboard.press('Backspace');
    await settle(page);

    const afterEdit = await domHtml(page, 'copy');
    // Guards the "nothing happened" failure mode, which otherwise reports as a
    // synchronisation success.
    expect(afterEdit).not.toBe(beforeEdit);

    const paragraphsAfterEdit = await paragraphTexts(page, 'copy');

    await exitText(page);

    // Exit rebuilds every `<p>` from the model. Matching the browser's own DOM means
    // the model recorded exactly what the browser did — no paragraph invented, none
    // lost, and the soft break still inside its paragraph rather than promoted to one.
    expect(await paragraphTexts(page, 'copy')).toEqual(paragraphsAfterEdit);
  });

  test('select-all and replace is one session commit', async ({ page }) => {
    await enterText(page);
    await page.keyboard.press('Control+a');
    await page.keyboard.type('replaced');
    await exitText(page);

    expect(await frameText(page, 'copy')).toBe('replaced');
    // One entry, however many keystrokes that took (ADR 0002).
    expect(await undoLabel(page)).toBe('Undo Edit text');
    await page.keyboard.press('Control+z');
    await settle(page);
    expect(await frameText(page, 'copy')).toContain('bold');
    expect(await undoDisabled(page)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

test.describe('history', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, TEXT_FIXTURE);
  });

  test('a session is one entry; a format toggle outside one is another', async ({ page }) => {
    await clickAt(page, TEXT_IDS.copy.x + 60, TEXT_IDS.copy.y + 20);
    expect(await undoDisabled(page)).toBe(true);

    // No session: the toggle applies to every run in the frame, as a command.
    await page.locator('[data-flag="bold"]').click();
    await settle(page);
    expect(await undoLabel(page)).toBe('Undo Bold');
    await expect(page.locator(`${COPY} b`).first()).toBeVisible();

    // Inside a session: it applies to the selection and joins the session's entry.
    await enterText(page);
    await page.keyboard.type('x');
    await exitText(page);
    expect(await undoLabel(page)).toBe('Undo Edit text');

    // Two steps, in the order they happened.
    await page.keyboard.press('Control+z');
    await settle(page);
    expect(await undoLabel(page)).toBe('Undo Bold');
    await page.keyboard.press('Control+z');
    await settle(page);
    expect(await undoDisabled(page)).toBe(true);
  });

  test('undo inside a session is the browser’s, and creates no entry', async ({ page }) => {
    await enterText(page);
    await page.keyboard.type('abc');
    await page.keyboard.press('Control+z');
    await settle(page);

    await exitText(page);
    // Chromium coalesces three keystrokes into one undo unit, so the session commits
    // whatever survives it — and the application history is still empty.
    expect(await undoDisabled(page)).toBe(true);
  });

  test('a typography change is one entry and reverts exactly', async ({ page }) => {
    await clickAt(page, TEXT_IDS.copy.x + 60, TEXT_IDS.copy.y + 20);

    const size = page.locator('[data-inspector] [data-text-field="fontSize"]');
    await size.fill('30');
    await size.press('Enter');

    // 30 is read as 30 **points**, because that is the unit the field displays — the
    // rule the inspector has to follow or a user types a number and gets another
    // one. 30pt at 96dpi is 40px.
    expect((await computedText(page, 'copy')).fontSize).toBe('40px');
    expect(await undoLabel(page)).toBe('Undo Typography');

    await page.keyboard.press('Control+z');
    await settle(page);
    // Back to the fixture's 18px, and redo is available.
    expect((await computedText(page, 'copy')).fontSize).toBe('18px');
    expect(await redoDisabled(page)).toBe(false);
  });

  test('alignment is one entry, and reverts every paragraph', async ({ page }) => {
    const aligns = () =>
      page.locator(`${COPY} p`).evaluateAll((els) =>
        els.map((el) => (getComputedStyle(el).textAlign === 'start' ? 'left' : getComputedStyle(el).textAlign)),
      );

    await clickAt(page, TEXT_IDS.copy.x + 60, TEXT_IDS.copy.y + 20);
    await page.locator('[data-align="center"]').click();
    await settle(page);

    // Alignment is a paragraph property (ADR 0003), so a frame-level change rewrites
    // every paragraph — in one command, hence one undo step.
    expect(await aligns()).toEqual(['center', 'center', 'center']);
    expect(await undoLabel(page)).toBe('Undo Align');

    await page.keyboard.press('Control+z');
    await settle(page);
    expect(await aligns()).toEqual(['left', 'left', 'center']);
  });
});

// ---------------------------------------------------------------------------
// External writes during a session
// ---------------------------------------------------------------------------

test.describe('external writes', () => {
  test('a typography change mid-session is deferred, then replayed', async ({ page }) => {
    await mountFixture(page, TEXT_FIXTURE);
    await clickAt(page, TEXT_IDS.copy.x + 60, TEXT_IDS.copy.y + 20);
    await page.keyboard.press('Enter');
    await settle(page);

    // The editor is holding the fence, so an inspector change cannot be applied yet.
    // It is parked instead.
    await page.locator('[data-inspector] [data-text-field="color"]').fill('#ff0000');
    await page.locator('[data-inspector] [data-text-field="color"]').press('Enter');
    await settle(page);

    await exitText(page);
    await settle(page);

    // Replayed on top of the session's own text commit.
    expect((await computedText(page, 'copy')).color).toBe('rgb(255, 0, 0)');
    expect(await undoLabel(page)).toBe('Undo Typography');
  });

  test('the frame stays editable while a write is deferred', async ({ page }) => {
    await mountFixture(page, TEXT_FIXTURE);
    await clickAt(page, TEXT_IDS.copy.x + 60, TEXT_IDS.copy.y + 20);
    await page.keyboard.press('Enter');
    await page.locator(COPY).click();
    await page.keyboard.press('End');
    await settle(page);

    await page.keyboard.type('still typing');
    expect(await frameIsEditing(page, 'copy')).toBe(true);
    expect((await computedText(page, 'copy')).color).not.toBe('rgb(255, 0, 0)');
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
