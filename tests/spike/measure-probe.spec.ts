import type { Page } from '@playwright/test';
import { clickAt, expect, settle, test, undoDisabled, undoLabel } from '../editor/helpers';
import { mountFixture } from '../visual/harness';
import {
  EMPTY,
  FRACTIONAL_LINES,
  HIDDEN_FRAME,
  MULTI_PARAGRAPH,
  OVERFLOW,
  ROTATED,
  SIMPLE,
  SOFT_BREAKS,
  TRAILING_SPACES,
  TRAILING_TRIMMED,
  WRAPPED,
} from './measure-fixtures';

/**
 * PROBE: what can the browser tell us about a rendered document?
 *
 * The investigation behind ADR 0004 (the measurement boundary). Every architectural
 * claim M3 deferred — auto-size, columns, fit-to-content, baseline snapping — needs
 * numbers the document does not contain, because line breaking, line boxes and glyph
 * positions are delegated to CSS by design. This probe establishes which APIs can
 * supply them, and which of the obvious ones are traps.
 *
 * Runs against the **real app** through `mountFixture`, so the page-stack
 * `transform: scale(z)`, the reconciler and the stylesheet are all real. A standalone
 * data-URL page would answer a different question.
 *
 * Largely observational: each test records what the browser did. The claims the design
 * then rests on are asserted in `tests/editor/measure.spec.ts`, so that a probe that
 * drifts and a contract that drifts fail differently.
 */

const FRAME = '[data-objects] [data-oid="copy"]';
const CONTENT = `${FRAME} .p1-text-content`;
const PARAGRAPH = `${CONTENT} p`;

/** Every candidate API for one element, plus a Range over its contents. */
const readApis = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (!(element instanceof HTMLElement)) throw new Error(`no element for ${sel}`);

    const border = element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    const rangeRects = [...range.getClientRects()].map((r) => ({
      x: +r.x.toFixed(3),
      y: +r.y.toFixed(3),
      width: +r.width.toFixed(3),
      height: +r.height.toFixed(3),
    }));

    return {
      rect: {
        x: +border.x.toFixed(3),
        y: +border.y.toFixed(3),
        width: +border.width.toFixed(3),
        height: +border.height.toFixed(3),
      },
      offset: [element.offsetWidth, element.offsetHeight],
      client: [element.clientWidth, element.clientHeight],
      scroll: [element.scrollWidth, element.scrollHeight],
      rangeBox: (() => {
        const box = range.getBoundingClientRect();
        return { width: +box.width.toFixed(3), height: +box.height.toFixed(3) };
      })(),
      rangeRects,
      text: element.textContent ?? '',
      whiteSpace: getComputedStyle(element).whiteSpace,
      overflowY: getComputedStyle(element).overflowY,
      display: getComputedStyle(element).display,
    };
  }, selector);

/** The live stack scale, read from the transform the viewport wrote. */
const readScale = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const stack = document.querySelector('[data-pages]') as HTMLElement;
    return Number.parseFloat(/scale\(([\d.]+)\)/.exec(stack.style.transform)?.[1] ?? 'NaN');
  });

// ---------------------------------------------------------------------------
// A. Which APIs are zoom-invariant?
// ---------------------------------------------------------------------------

test('PROBE A: control case at zoom 1', async ({ page }) => {
  await mountFixture(page, SIMPLE);
  console.log('PROBE A frame  :', JSON.stringify(await readApis(page, FRAME)));
  console.log('PROBE A content:', JSON.stringify(await readApis(page, CONTENT)));
  expect(true).toBe(true);
});

test('PROBE B: the same element at four zoom levels', async ({ page }) => {
  await mountFixture(page, SIMPLE);

  for (const step of ['out', 'actual', 'in', 'in'] as const) {
    await page.locator(`[data-zoom="${step}"]`).click();
    const scale = await readScale(page);
    console.log(`PROBE B scale=${scale}`, JSON.stringify(await readApis(page, FRAME)));
  }

  expect(true).toBe(true);
});

test('PROBE C: rotation — layout box vs painted box', async ({ page }) => {
  await mountFixture(page, ROTATED);
  console.log('PROBE C frame  :', JSON.stringify(await readApis(page, FRAME)));
  console.log('PROBE C content:', JSON.stringify(await readApis(page, CONTENT)));
  expect(true).toBe(true);
});

// ---------------------------------------------------------------------------
// D. Text content bounds
// ---------------------------------------------------------------------------

test('PROBE D: wrapped text', async ({ page }) => {
  await mountFixture(page, WRAPPED);
  console.log('PROBE D content:', JSON.stringify(await readApis(page, CONTENT)));
  expect(true).toBe(true);
});

test('PROBE E: soft breaks', async ({ page }) => {
  await mountFixture(page, SOFT_BREAKS);
  console.log('PROBE E content:', JSON.stringify(await readApis(page, CONTENT)));
  expect(true).toBe(true);
});

test('PROBE F: multiple paragraphs, and per-paragraph ranges', async ({ page }) => {
  await mountFixture(page, MULTI_PARAGRAPH);
  console.log('PROBE F content:', JSON.stringify(await readApis(page, CONTENT)));

  const perParagraph = await page.locator(PARAGRAPH).evaluateAll((els) =>
    els.map((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const box = range.getBoundingClientRect();
      return {
        text: el.textContent,
        y: +box.y.toFixed(2),
        height: +box.height.toFixed(2),
        rects: range.getClientRects().length,
        offsetHeight: (el as HTMLElement).offsetHeight,
        scrollHeight: (el as HTMLElement).scrollHeight,
      };
    }),
  );
  console.log('PROBE F per-paragraph:', JSON.stringify(perParagraph));
  expect(true).toBe(true);
});

test('PROBE G: empty frame — is there any rect at all?', async ({ page }) => {
  await mountFixture(page, EMPTY);
  console.log('PROBE G content  :', JSON.stringify(await readApis(page, CONTENT)));
  console.log('PROBE G paragraph:', JSON.stringify(await readApis(page, PARAGRAPH)));
  expect(true).toBe(true);
});

test('PROBE H: trailing whitespace, against the same text trimmed', async ({ page }) => {
  await mountFixture(page, TRAILING_SPACES);
  const withSpaces = await readApis(page, CONTENT);
  console.log('PROBE H spaces :', JSON.stringify(withSpaces));

  await mountFixture(page, TRAILING_TRIMMED);
  console.log('PROBE H trimmed:', JSON.stringify(await readApis(page, CONTENT)));
  expect(true).toBe(true);
});

test('PROBE I: overflow', async ({ page }) => {
  await mountFixture(page, OVERFLOW);
  console.log('PROBE I frame  :', JSON.stringify(await readApis(page, FRAME)));
  console.log('PROBE I content:', JSON.stringify(await readApis(page, CONTENT)));
  expect(true).toBe(true);
});

test('PROBE N: a frame the model has hidden', async ({ page }) => {
  await mountFixture(page, HIDDEN_FRAME);
  console.log('PROBE N frame  :', JSON.stringify(await readApis(page, FRAME)));
  expect(true).toBe(true);
});

// ---------------------------------------------------------------------------
// J. Precision: integers vs fractions
// ---------------------------------------------------------------------------

test('PROBE J: fractional line height separates integer from fractional APIs', async ({ page }) => {
  await mountFixture(page, FRACTIONAL_LINES);
  const scale = await readScale(page);
  const content = await readApis(page, CONTENT);
  console.log('PROBE J scale:', scale);
  console.log('PROBE J content:', JSON.stringify(content));

  // 3 lines at 16px × 1.35 = 21.6px each, so 64.8px in total.
  console.log(
    'PROBE J expected total:',
    JSON.stringify({ exact: 64.8, offsetSays: content.offset[1], clientSays: content.client[1] }),
  );
  expect(true).toBe(true);
});

test('PROBE K: ResizeObserver reports fractional layout size', async ({ page }) => {
  await mountFixture(page, FRACTIONAL_LINES);

  const observed = await page.evaluate(async () => {
    const content = document.querySelector('.p1-text-content') as HTMLElement;
    const seen: { blockSize: number; inlineSize: number; from: string }[] = [];

    const collect = (from: string) => {
      const entry = pending[0];
      if (entry === undefined) return;
      seen.push({
        blockSize: entry.contentBoxSize?.[0]?.blockSize ?? Number.NaN,
        inlineSize: entry.contentBoxSize?.[0]?.inlineSize ?? Number.NaN,
        from,
      });
    };

    let pending: ResizeObserverEntry[] = [];
    const observer = new ResizeObserver((entries) => {
      pending = [...entries];
    });
    observer.observe(content);

    // Let the first observation land.
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    collect('initial');

    // A width change re-wraps the same text, so the block size must move.
    content.style.width = '80px';
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    collect('after width 80');

    // Rotation is a transform, so it must NOT move an observed layout size.
    const frame = document.querySelector('[data-oid="copy"]') as HTMLElement;
    frame.style.transform = 'matrix(0.866025, 0.5, -0.5, 0.866025, 0, 0)';
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    collect('after rotation');

    observer.disconnect();
    return {
      seen,
      finalRectHeight: content.getBoundingClientRect().height,
      finalClientHeight: content.clientHeight,
    };
  });

  console.log('PROBE K:', JSON.stringify(observed));
  expect(true).toBe(true);
});

// ---------------------------------------------------------------------------
// L. Fonts
// ---------------------------------------------------------------------------

test('PROBE L: font readiness', async ({ page }) => {
  await mountFixture(page, SIMPLE);

  const result = await page.evaluate(async () => {
    const content = document.querySelector('.p1-text-content') as HTMLElement;
    const before = content.getBoundingClientRect().width;
    const statusBefore = document.fonts.status;
    const size = document.fonts.size;

    await document.fonts.ready;

    return {
      statusBefore,
      statusAfter: document.fonts.status,
      faceRuleCount: size,
      widthBefore: before,
      widthAfter: content.getBoundingClientRect().width,
      // A family that does not exist. `check` answering `true` here is the trap: it
      // reports whether *pending loads* are done, not whether a family resolved.
      checkKnown: document.fonts.check('16px Georgia'),
      checkUnknown: document.fonts.check('16px NoSuchFamilyExistsAtAll'),
    };
  });

  console.log('PROBE L:', JSON.stringify(result));
  expect(true).toBe(true);
});

// ---------------------------------------------------------------------------
// M. Timing and lifecycle
// ---------------------------------------------------------------------------

test('PROBE M: read-after-write in the same task', async ({ page }) => {
  await mountFixture(page, WRAPPED);

  const result = await page.evaluate(async () => {
    const content = document.querySelector('.p1-text-content') as HTMLElement;
    const read = () => ({
      rectWidth: content.getBoundingClientRect().width,
      scrollHeight: content.scrollHeight,
      clientHeight: content.clientHeight,
    });

    const initial = read();
    content.style.width = '70px';
    const sameTask = read();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    const afterRaf = read();

    content.style.display = 'none';
    const hidden = read();

    return { initial, sameTask, afterRaf, hidden };
  });

  console.log('PROBE M:', JSON.stringify(result));
  expect(true).toBe(true);
});

test('PROBE O: repeated measurement is stable', async ({ page }) => {
  await mountFixture(page, WRAPPED);

  const samples = await page.evaluate(() => {
    const content = document.querySelector('.p1-text-content') as HTMLElement;
    const heights: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      content.getBoundingClientRect();
      heights.push(content.clientHeight);
    }
    return heights;
  });

  console.log('PROBE O:', JSON.stringify(samples));
  expect(true).toBe(true);
});

// ---------------------------------------------------------------------------
// P. The fence: can measurement observe a live editing session?
// ---------------------------------------------------------------------------

test('PROBE P: measuring during a session does not disturb the caret', async ({ page }) => {
  await mountFixture(page, MULTI_PARAGRAPH);

  const caretAt = () =>
    page.evaluate(() => {
      const selection = window.getSelection();
      if (selection === null || selection.rangeCount === 0) return null;
      const range = selection.getRangeAt(0);
      const host = range.startContainer
        .nodeType === 3
        ? (range.startContainer.parentElement as HTMLElement | null)
        : (range.startContainer as HTMLElement | null);
      return {
        offset: range.startOffset,
        text: (host?.textContent ?? '').slice(0, 40),
        inEditable: host?.closest('[contenteditable]') !== null,
      };
    });

  // Enter a session on the frame.
  await clickAt(page, 60, 60);
  await page.keyboard.press('Enter');
  await page.locator(CONTENT).click();
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft');
  await settle(page);

  const before = await caretAt();

  // Measure aggressively: element rects, scroll dims, a Range over the live DOM, and
  // a fresh Range per paragraph. All read-only, all forcing layout.
  const during = await page.evaluate(() => {
    const content = document.querySelector('.p1-text-content') as HTMLElement;
    const frame = document.querySelector('[data-oid="copy"]') as HTMLElement;

    const rangeRects: number[] = [];
    const range = document.createRange();
    range.selectNodeContents(content);
    rangeRects.push(range.getClientRects().length);

    for (const paragraph of content.querySelectorAll('p')) {
      const perParagraph = document.createRange();
      perParagraph.selectNodeContents(paragraph);
      rangeRects.push(perParagraph.getClientRects().length);
    }

    return {
      frameRect: frame.getBoundingClientRect().height,
      contentRect: content.getBoundingClientRect().height,
      clientHeight: content.clientHeight,
      scrollHeight: content.scrollHeight,
      editable: content.getAttribute('contenteditable'),
      stillFenced: frame.dataset['editing'],
      rangeRects,
    };
  });

  const after = await caretAt();

  // And typing still lands where it should, which is the real proof that measuring
  // did not disturb the browser's own state.
  await page.keyboard.type('ZZ');
  await settle(page);
  const typed = await page.evaluate(
    () => document.querySelector('.p1-text-content')?.textContent ?? '',
  );

  console.log('PROBE P before :', JSON.stringify(before));
  console.log('PROBE P during :', JSON.stringify(during));
  console.log('PROBE P after  :', JSON.stringify(after));
  console.log('PROBE P typed  :', JSON.stringify(typed));

  expect(true).toBe(true);
});

test('PROBE Q: does measuring mid-session change the model?', async ({ page }) => {
  await mountFixture(page, MULTI_PARAGRAPH);

  await clickAt(page, 60, 60);
  await page.keyboard.press('Enter');
  await page.locator(CONTENT).click();
  await page.keyboard.press('End');
  await page.keyboard.type('EDITED');
  await settle(page);

  // Undo must still be disabled: the model has not been touched, because a session has
  // not exited. Measurement must not have been mistaken for a commit.
  const undoDisabledMid = await undoDisabled(page);
  const labelMid = await undoLabel(page);

  console.log('PROBE Q undoDisabled:', undoDisabledMid, 'label:', JSON.stringify(labelMid));

  // After exit, exactly one entry, for the one session.
  await page.keyboard.press('Escape');
  await settle(page);
  console.log(
    'PROBE Q after exit:',
    JSON.stringify({ disabled: await undoDisabled(page), label: await undoLabel(page) }),
  );

  expect(true).toBe(true);
});
