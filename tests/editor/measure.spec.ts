import type { Page } from '@playwright/test';
import { FIXTURE, IDS, clickAt, expect, settle, test } from './helpers';
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
  UNSTYLED,
  WRAPPED,
} from '../spike/measure-fixtures';

/**
 * The ADR 0004 measurement contract, in a real browser.
 *
 * Every claim here depends on actual layout, so none of it can be checked in
 * happy-dom — a DOM emulator has no line breaking, no integer rounding and no zoom
 * transform. The probe file records the measurements; this file *asserts the contract*
 * so that a probe that drifts and a contract that drifts fail differently.
 *
 * ## Negative controls
 *
 * The instruction "avoid false-confidence tests" is load-bearing here, because
 * measurement is unusually easy to assert wrongly: `expect(height).toBeGreaterThan(0)`
 * passes for every implementation including a broken one. So each structural claim is
 * paired with a **mutation that must change the result**:
 *
 * | Claim | Control |
 * |---|---|
 * | height reflects the text | change the text, expect a different height |
 * | height is zoom-invariant | measure at four zooms, expect one value |
 * | height is rotation-invariant | rotate, expect the same value |
 * | integer rounding really happens | a fractional line height reports ≠ its exact value |
 * | `ResizeObserver` is fractional | the observer's value has a fractional part where `clientHeight` does not |
 * | `hidden` is not `0` | a hidden frame's status is `hidden`, and an `ok` frame's height is > 0 |
 * | `stale` is reachable | measure against a deliberately mismatched host |
 * | the document does not inherit chrome type | an unstyled frame is not 13px |
 */

/** The frame under test in every measurement fixture. */
const FRAME = '[data-objects] [data-oid="copy"]';
/** The measurement surface: the inspector's read-only note. */
const note = '[data-inspector] [data-layout="text"]';

/** Its `data-status`, which is the contract's status union made assertable. */
const noteStatus = (page: Page): Promise<string | null> =>
  page.locator(note).getAttribute('data-status');

/**
 * The note's height, in **document px**.
 *
 * The inspector displays values in the page's *authored* unit, so it shows `14.25pt`
 * for a 19px line. Converting here rather than asserting in points keeps every
 * expectation in the contract's own unit, and keeps the assertions independent of the
 * fixture's authored unit — a measurement suite that silently only worked in points
 * would be a measurement suite that had not been checked.
 */
const noteHeightPx = async (page: Page): Promise<number> => {
  const text = (await page.locator(note).textContent()) ?? '';
  const match = /Text height ([\d.]+)(mm|pt|px)/.exec(text);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`Could not read a height from "${text}"`);
  }
  const value = Number.parseFloat(match[1]);
  const pxPerUnit = match[2] === 'px' ? 1 : match[2] === 'pt' ? 96 / 72 : 96 / 25.4;
  return value * pxPerUnit;
};

/** Clicks a point and settles, without asserting that anything got selected. */
const clickPoint = async (page: Page, x: number, y: number): Promise<void> => {
  await clickAt(page, x, y);
  await settle(page);
};

/**
 * Selects the *frame* and waits for the inspector to re-read the measurement.
 *
 * Asserts that the frame really was selected, because the alternative is a test that
 * reads an empty note and fails with "Could not read a height" — an error that points at
 * the note rather than at the click. That is not hypothetical: the rotated-frame test
 * clicked (60, 60), which lies outside a frame rotated 30° about its centre, and only
 * *appeared* to select it because a zero-size marquee used to select anything whose
 * bounding box contained the point. That marquee was a bug in its own right, and this
 * suite had come to depend on it.
 */
const selectFrame = async (page: Page, x: number, y: number): Promise<void> => {
  await clickPoint(page, x, y);
  const selected = await page.locator(`.p1-overlay-group--selection[data-for="copy"]`).count();
  if (selected !== 1) {
    throw new Error(
      `selectFrame(${x}, ${y}) did not select "copy" (selection outlines: ${selected}). ` +
        `The point is outside the frame's painted shape; pick one inside it.`,
    );
  }
};

// ---------------------------------------------------------------------------
// The happy path, and the control that proves it is not a constant
// ---------------------------------------------------------------------------

test.describe('text height', () => {
  test('reports the text height, in document px', async ({ page }) => {
    await mountFixture(page, SIMPLE);
    await selectFrame(page, 60, 60);

    expect(await noteStatus(page)).toBe('ok');
    // One line at 16px with the document's own default line-height of 1.2 → 19.2px,
    // rounded by `clientHeight` to 19. Shown in the page's authored unit (pt).
    expect(await noteHeightPx(page)).toBeCloseTo(19, 0);
  });

  test('changes when the text changes — the control for the test above', async ({ page }) => {
    await mountFixture(page, SIMPLE);
    await selectFrame(page, 60, 60);
    const oneLine = await noteHeightPx(page);

    // A second *line*, not a second run. `End` on a one-line frame appends to that
    // same line, so the height could not change and this control would have proved
    // nothing. Enter is what adds a line.
    //
    // Driven through the real editing session, so this exercises the whole chain:
    // model -> render -> measure -> display.
    await page.keyboard.press('Enter');
    await page.locator(`${FRAME} .p1-text-content`).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('second');
    await page.keyboard.press('Escape');
    await settle(page);

    expect(await noteHeightPx(page)).toBeGreaterThan(oneLine);
  });

  test('is the same at every zoom level', async ({ page }) => {
    await mountFixture(page, WRAPPED);
    await selectFrame(page, 60, 60);

    const heights: number[] = [];
    const scales: number[] = [];
    for (const step of ['out', 'out', 'actual', 'in', 'in'] as const) {
      await page.locator(`[data-zoom="${step}"]`).click();
      await settle(page);
      scales.push(
        await page.evaluate(() => {
          const stack = document.querySelector('[data-pages]') as HTMLElement;
          return Number.parseFloat(/scale\(([\d.]+)\)/.exec(stack.style.transform)?.[1] ?? 'NaN');
        }),
      );
      heights.push(await noteHeightPx(page));
    }

    // The control: the scales really did differ. Without this, "all equal" could mean
    // "the zoom buttons did nothing".
    expect(new Set(scales).size).toBeGreaterThan(2);
    expect(new Set(heights).size).toBe(1);
  });

  test('is the same under object rotation — the control for "zoom-invariant"', async ({ page }) => {
    // The frame is at (40, 40, 200, 50), so its centre is (140, 65). Clicking *there*
    // matters: rotated 30° about that centre, the point (60, 60) this test used to click
    // lands outside the shape's local box entirely. The click only appeared to select the
    // frame because a zero-size marquee used to select anything whose bounding box
    // contained the point — a bug in its own right, now fixed, and one this test had
    // come to depend on.
    await mountFixture(page, ROTATED);
    await selectFrame(page, 140, 65);
    const rotated = await noteHeightPx(page);

    // `getBoundingClientRect` would report ~3× the height here (the painted AABB of a
    // 30°-rotated 200×50 box). The contract must not use it, so the height must not move.
    await mountFixture(page, SIMPLE);
    await selectFrame(page, 140, 65);
    const unrotated = await noteHeightPx(page);

    expect(rotated).toBe(unrotated);

    const paintedHeight = await page
      .locator(FRAME)
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(paintedHeight).toBeGreaterThan(unrotated * 2);
  });
});

// ---------------------------------------------------------------------------
// The four statuses
// ---------------------------------------------------------------------------

test.describe('refusals', () => {
  test('a hidden frame is not selectable, which is why `hidden` needs no UI', async ({ page }) => {
    await mountFixture(page, HIDDEN_FRAME);

    // The frame is `display: none`, so every layout API reports 0 — which is why the
    // contract has a `hidden` status rather than returning 0.
    const raw = await page.locator(FRAME).evaluate((el) => {
      const node = el as HTMLElement;
      return {
        offsetWidth: node.offsetWidth,
        clientHeight: node.clientHeight,
        display: getComputedStyle(node).display,
      };
    });
    expect(raw.display).toBe('none');
    expect(raw.offsetWidth).toBe(0);
    expect(raw.clientHeight).toBe(0);

    // And the model hit test refuses it, so a user cannot select a frame whose size
    // cannot be measured. That is what makes the `hidden` branch unreachable through
    // the inspector, which is why it is covered by unit tests in
    // `src/editor/measure.test.ts` rather than here: a browser test that cannot reach
    // the branch would be asserting nothing.
    // `clickPoint`, not `selectFrame`: the whole point of this test is that the click
    // selects nothing.
    await clickPoint(page, 60, 60);
    expect(await page.locator('[data-inspector]').getAttribute('data-state')).toBe('empty');
    await expect(page.locator(note)).toBeHidden();
  });

  test('an unmeasured selection shows no note at all rather than a stale one', async ({ page }) => {
    await mountFixture(page, FIXTURE);
    // A shape, not a text frame: the Text section is hidden, so the note must be too.
    // Also not `selectFrame` — that asserts a frame named "copy" was selected, and this
    // test selects a shape on purpose.
    await clickPoint(page, IDS.alpha.x + 20, IDS.alpha.y + 20);
    await expect(page.locator(note)).toBeHidden();
  });

  test('`stale` is reported when the DOM does not match the model', async ({ page }) => {
    await mountFixture(page, SIMPLE);
    await selectFrame(page, 60, 60);
    expect(await noteStatus(page)).toBe('ok');

    // Move the element without touching the model — exactly what a projection that
    // has not caught up looks like. The status must flip rather than report the
    // previous document's layout.
    await page.locator(FRAME).evaluate((el) => {
      el.style.width = '400px';
    });
    // The inspector has not re-synced, so read the measurement through a fresh sync by
    // re-selecting — which does not re-render, so the mismatch survives.
    await selectFrame(page, 61, 61);
    expect(await noteStatus(page)).toBe('stale');
  });
});

// ---------------------------------------------------------------------------
// Precision
// ---------------------------------------------------------------------------

test.describe('precision', () => {
  test('the synchronous path rounds to an integer', async ({ page }) => {
    await mountFixture(page, FRACTIONAL_LINES);
    await selectFrame(page, 60, 60);

    // Three lines at 16px × 1.35 = 64.8px exactly. `clientHeight` reports 65.
    const exact = 64.8;
    const measured = await noteHeightPx(page);
    expect(measured).toBe(65);

    // The control: the rounding is real, not the fixture being accidentally integral.
    expect(measured).not.toBeCloseTo(exact, 3);
  });

  test('ResizeObserver reports the fractional value', async ({ page }) => {
    await mountFixture(page, FRACTIONAL_LINES);

    const observed = await page.evaluate(() => {
      const content = document.querySelector('.p1-text-content') as HTMLElement;
      return new Promise<{ blockSize: number; clientHeight: number }>((resolve) => {
        const observer = new ResizeObserver((entries) => {
          const entry = entries[entries.length - 1];
          if (entry === undefined) return;
          resolve({
            blockSize: entry.contentBoxSize?.[0]?.blockSize ?? entry.contentRect.height,
            clientHeight: content.clientHeight,
          });
          observer.disconnect();
        });
        observer.observe(content);
      });
    });

    // 64.78125, which is 64.8 quantised to Chromium's 1/64px LayoutUnit.
    expect(observed.blockSize).toBeCloseTo(64.8, 1);
    expect(observed.blockSize).not.toBe(Math.trunc(observed.blockSize));
    // The control: the integer API really did round, so the observer is adding
    // information rather than reporting the same number twice.
    expect(observed.clientHeight).toBe(65);
  });

  test('rotation does not move an observed size', async ({ page }) => {
    await mountFixture(page, FRACTIONAL_LINES);

    const sizes = await page.evaluate(async () => {
      const content = document.querySelector('.p1-text-content') as HTMLElement;
      const frame = document.querySelector('[data-oid="copy"]') as HTMLElement;
      const seen: number[] = [];

      const observer = new ResizeObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (entry === undefined) return;
        seen.push(entry.contentBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
      });
      observer.observe(content);

      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      frame.style.transform = 'matrix(0.866025, 0.5, -0.5, 0.866025, 0, 0)';
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      observer.disconnect();

      return { seen, paintedHeight: content.getBoundingClientRect().height };
    });

    expect(sizes.seen.every((size) => Math.abs(size - sizes.seen[0]!) < 0.001)).toBe(true);
    // The control: the painted box really did grow, so the invariance is meaningful.
    expect(sizes.paintedHeight).toBeGreaterThan(sizes.seen[0]! * 1.4);
  });
});

// ---------------------------------------------------------------------------
// Content shapes
// ---------------------------------------------------------------------------

test.describe('content shapes', () => {
  const cases: { name: string; source: string; x: number; y: number }[] = [
    { name: 'wrapped text', source: WRAPPED, x: 60, y: 60 },
    { name: 'soft breaks', source: SOFT_BREAKS, x: 60, y: 60 },
    { name: 'several paragraphs', source: MULTI_PARAGRAPH, x: 60, y: 60 },
    { name: 'an empty frame', source: EMPTY, x: 60, y: 60 },
    { name: 'trailing whitespace', source: TRAILING_SPACES, x: 60, y: 60 },
    { name: 'overflowing text', source: OVERFLOW, x: 60, y: 60 },
  ];

  for (const { name, source, x, y } of cases) {
    test(`reports a positive height for ${name}`, async ({ page }) => {
      await mountFixture(page, source);
      await selectFrame(page, x, y);
      expect(await noteStatus(page)).toBe('ok');
      expect(await noteHeightPx(page)).toBeGreaterThan(0);
    });
  }

  test('an empty frame reports the paragraph minimum, not zero', async ({ page }) => {
    await mountFixture(page, EMPTY);
    await selectFrame(page, 60, 60);

    // `min-height: 1em` on the paragraph, at the document's own 16px default.
    // A Range would report nothing at all here — no rects, and a 0×0 bounding box.
    const rangeFacts = await page.locator(`${FRAME} .p1-text-content p`).evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return { rects: range.getClientRects().length };
    });
    expect(rangeFacts.rects).toBe(0);

    expect(await noteHeightPx(page)).toBeCloseTo(16, 0);
  });

  test('overflowing text reports its full height, and says so', async ({ page }) => {
    await mountFixture(page, OVERFLOW);
    await selectFrame(page, 60, 60);

    const text = (await page.locator(note).textContent()) ?? '';
    // 8 lines at 16px × 1.2 = 153.6px of text in a 40px frame.
    expect(await noteHeightPx(page)).toBeGreaterThan(100);
    expect(text).toContain('overflowing');

    // The control: the frame really is smaller than the text it holds.
    const frameHeight = await page.locator(FRAME).evaluate((el) => el.clientHeight);
    expect(frameHeight).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// Typography independence
// ---------------------------------------------------------------------------

test.describe('typography independence', () => {
  test('an unstyled frame does not inherit the editor chrome’s font size', async ({ page }) => {
    // `body` declares `font: 13px/1.5 system-ui`, and `line-height` is a number, so it
    // inherits as a factor. Before this was fixed, a frame with no `TextStyle`
    // rendered at 13px — the toolbar's font — which made every measurement conditional
    // on chrome CSS. This is the regression test for that.
    await mountFixture(page, UNSTYLED);
    await selectFrame(page, 60, 60);

    const fonts = await page
      .locator(`${FRAME} .p1-text-content`)
      .evaluate((el) => ({
        fontSize: getComputedStyle(el).fontSize,
        lineHeight: getComputedStyle(el).lineHeight,
        bodyFontSize: getComputedStyle(document.body).fontSize,
      }));

    expect(fonts.bodyFontSize).toBe('13px');
    expect(fonts.fontSize).not.toBe('13px');
    expect(fonts.fontSize).toBe('16px');
    // 16 × 1.2 = 19.2, so the line box is the document's, not the chrome's 19.5.
    expect(fonts.lineHeight).toBe('19.2px');
  });
});

// ---------------------------------------------------------------------------
// The fence
// ---------------------------------------------------------------------------

test.describe('the editing session', () => {
  test('measurement does not disturb the caret, and typing still lands', async ({ page }) => {
    await mountFixture(page, MULTI_PARAGRAPH);

    const caret = () =>
      page.evaluate(() => {
        const selection = window.getSelection();
        if (selection === null || selection.rangeCount === 0) return null;
        const range = selection.getRangeAt(0);
        const host =
          range.startContainer.nodeType === 3
            ? (range.startContainer.parentElement as HTMLElement | null)
            : (range.startContainer as HTMLElement | null);
        return { offset: range.startOffset, text: host?.textContent ?? '' };
      });

    await selectFrame(page, 60, 60);
    await page.keyboard.press('Enter');
    await page.locator(`${FRAME} .p1-text-content`).click();
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowLeft');
    await settle(page);

    const before = await caret();

    // Force the inspector to re-measure, which is the real read path.
    //
    // A hover, not a click on a field. Clicking the colour input is a legitimate
    // focus change, so the caret afterwards would be in the field and the comparison
    // would fail for a reason that has nothing to do with measurement. Hovering
    // reaches the same chrome refresh without touching focus.
    await page.mouse.move(400, 400);
    await page.mouse.move(410, 410);
    await settle(page);

    const after = await caret();
    expect(after).toEqual(before);

    await page.keyboard.type('ZZ');
    await settle(page);
    expect(await page.locator(`${FRAME} .p1-text-content`).textContent()).toContain('ZZ');
  });

  test('measuring during a session creates no history entry', async ({ page }) => {
    await mountFixture(page, MULTI_PARAGRAPH);

    await selectFrame(page, 60, 60);
    await page.keyboard.press('Enter');
    await page.locator(`${FRAME} .p1-text-content`).click();
    await page.keyboard.press('End');
    await page.keyboard.type('EDITED');
    await settle(page);

    const undo = page.locator('[data-edit="undo"]');
    // ADR 0002: during a session the button is delegated to the browser's stack, which
    // reports nothing — so it is enabled. What matters is that *after* the session
    // there is exactly one entry, the session's own commit.
    expect(await undo.isDisabled()).toBe(false);

    await page.keyboard.press('Escape');
    await settle(page);
    expect(await undo.textContent()).toBe('Undo Edit text');

    // And one undo restores the original text, proving there was exactly one entry.
    await page.locator('[data-edit="undo"]').click();
    await settle(page);
    expect(await page.locator(`${FRAME} .p1-text-content`).textContent()).toBe(
      'firstsecondthird',
    );
    expect(await undo.isDisabled()).toBe(true);
  });

  test('the readout holds the committed height while a session is open', async ({ page }) => {
    await mountFixture(page, MULTI_PARAGRAPH);
    await selectFrame(page, 60, 60);
    const before = await noteHeightPx(page);

    await page.keyboard.press('Enter');
    await page.locator(`${FRAME} .p1-text-content`).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('a fourth paragraph of text');
    await settle(page);

    // Mid-session the DOM really does hold more text, and measurement could read it --
    // every API in the contract is a read, and reads are safe mid-session. But the
    // readout does not move, because publishing it means writing to the DOM, and a DOM
    // write during an editing session costs the user their undo granularity.
    //
    // Asserting the *live* value here would pin a behaviour that measurably breaks
    // Ctrl+Z, which is the whole basis of ADR 0002.
    expect(await noteHeightPx(page)).toBe(before);

    // The uncommitted text is still there, and is still measured correctly once the
    // session ends and the model moves.
    const live = await page
      .locator(`${FRAME} .p1-text-content`)
      .evaluate((el) => (el as HTMLElement).clientHeight);
    expect(live).toBeGreaterThan(before);

    await page.keyboard.press('Escape');
    await settle(page);

    expect(await noteStatus(page)).toBe('ok');
    expect(await noteHeightPx(page)).toBeGreaterThan(before);
  });
});
