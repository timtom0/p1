import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { frameIsEditing, frameText } from './helpers';
import { mountSample } from '../visual/harness';

/**
 * Invariance of measurement and the text fence under a transformed *ancestor*.
 *
 * ADR 0004 proved that measurement ignores a CSS transform on the page stack, which is the only
 * transformed ancestor the application currently has. ADR 0008 assumed that result generalised to
 * an arbitrary nesting transform and declined to build groups on it, saying the question was
 * unproven. M10 tested it instead of assuming it, because the answer decides whether groups can
 * avoid DOM nesting.
 *
 * The answer is yes, and for a reason worth stating plainly: a CSS transform changes **paint**,
 * and every API the measurement boundary is built on is a **layout** API. `clientWidth`,
 * `offsetWidth` and `scrollHeight` describe the box the browser laid out; `getBoundingClientRect`
 * describes where it ended up on screen. Only the second kind moves.
 *
 * The second half is the text fence, which is a stronger claim than measurement: it says the
 * browser still owns the editable subtree under a transform, that a keystroke still produces
 * exactly one model commit at session exit, and that the committed text is what was typed.
 *
 * ## Why the transform is written by hand
 *
 * The page stack's `transform` is owned by the zoom control. Overwriting it here is deliberate
 * and safe: each test gets a fresh page, and these tests read no visual baseline. Using the real
 * zoom control instead would only prove the unrotated case, which ADR 0004 already covers.
 */

const ROTATE_AND_STRETCH = 'matrix(0.92, 0.39, -0.39, 0.92, 0, 0) scale(1.4, 0.8)';

/**
 * One text frame, read two ways: the layout metrics the measurement boundary uses, and the
 * paint-space rect, which is the only one of these a CSS transform can move.
 */
interface BoxMetrics {
  clientWidth: number;
  clientHeight: number;
  offsetWidth: number;
  offsetHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  rectWidth: number;
  rectHeight: number;
}

/** Applies a transform to the page stack, standing in for a group container. */
function transformStack(page: Page, value: string): Promise<unknown> {
  return page.evaluate((v) => {
    const stack = document.querySelector('[data-pages]');
    if (!(stack instanceof HTMLElement)) throw new Error('no page stack');
    stack.style.transform = v;
  }, value);
}

/** The layout metrics, plus the paint-space rect for contrast. */
function readBox(page: Page, id: string): Promise<BoxMetrics> {
  return page
    .locator(`[data-objects] [data-oid="${id}"]`)
    .evaluate((el) => {
      if (!(el instanceof HTMLElement)) throw new Error('frame is not an HTMLElement');
      const frame = el;
      const content = frame.querySelector('.p1-text-content');
      if (!(content instanceof HTMLElement)) throw new Error('no text content');
      const rect = frame.getBoundingClientRect();
      return {
        clientWidth: frame.clientWidth,
        clientHeight: frame.clientHeight,
        offsetWidth: frame.offsetWidth,
        offsetHeight: frame.offsetHeight,
        scrollWidth: content.scrollWidth,
        scrollHeight: content.scrollHeight,
        rectWidth: rect.width,
        rectHeight: rect.height,
      };
    });
}

async function firstTextFrameId(page: Page): Promise<string> {
  const id = await page
    .locator('[data-objects] [data-type="textFrame"]')
    .first()
    .getAttribute('data-oid');
  if (id === null) throw new Error('the sample document has no text frame');
  return id;
}

/** Opens a text-editing session the way a user does: select, then Enter. */
async function beginEditing(page: Page, id: string): Promise<void> {
  await page.locator(`[data-objects] [data-oid="${id}"]`).click();
  await page.keyboard.press('Enter');
  await expect(async () => {
    expect(await frameIsEditing(page, id)).toBe(true);
  }).toPass();
}

test.describe('measurement under a transformed ancestor', () => {
  test('layout metrics are invariant while the painted rect is not', async ({ page }) => {
    await mountSample(page);
    const id = await firstTextFrameId(page);

    const plain = await readBox(page, id);

    await transformStack(page, 'scale(1.6)');
    const scaled = await readBox(page, id);

    await transformStack(page, 'rotate(0.4rad)');
    const rotated = await readBox(page, id);

    // Every layout metric is byte-identical across all three.
    for (const [label, now] of [
      ['scaled', scaled],
      ['rotated', rotated],
    ] as const) {
      expect(now, label).toEqual({ ...plain, rectWidth: now.rectWidth, rectHeight: now.rectHeight });
    }

    // And the negative control: the transform really did reach the screen. Without this the test
    // would pass just as happily if the style write did nothing, which is trap 21 all over again.
    expect(scaled.rectWidth).not.toBeCloseTo(plain.rectWidth, 1);
    expect(rotated.rectWidth).not.toBeCloseTo(plain.rectWidth, 1);
  });
});

test.describe('the text fence under a transformed ancestor', () => {
  test('editing, commit and measurement all survive', async ({ page }) => {
    await mountSample(page);
    const id = await firstTextFrameId(page);
    const original = await frameText(page, id);

    // Baseline: one session, no ancestor transform, so the expected commit is known exactly.
    await beginEditing(page, id);
    await page.keyboard.type('hello');
    await page.keyboard.press('Escape');
    await expect(async () => {
      expect(await frameText(page, id)).toBe(`${original}hello`);
    }).toPass();

    // Now the same thing under a rotation and a non-uniform stretch -- the transform that would
    // shear a child if it were authored in the ancestor's local space (ADR 0010).
    await transformStack(page, ROTATE_AND_STRETCH);
    const before = await readBox(page, id);

    // Counted *inside* the session, because the editable subtree is created when the session
    // starts and removed when it ends. Asserting before opening would prove nothing.
    await beginEditing(page, id);
    const editables = await page
      .locator(`[data-objects] [data-oid="${id}"] [contenteditable]`)
      .count();
    expect(editables, 'exactly one editable subtree').toBe(1);

    await page.keyboard.type('world');
    const during = await readBox(page, id);
    await page.keyboard.press('Escape');

    await expect(async () => {
      expect(await frameText(page, id)).toBe(`${original}helloworld`);
    }).toPass();

    // Measurement never moved, even though the session grew the text onto a new line.
    expect(during.clientWidth).toBe(before.clientWidth);
    expect(during.offsetWidth).toBe(before.offsetWidth);

    // The model is the source of truth: the DOM's own text was never read as authority, and the
    // committed value is the concatenation of both sessions, each exactly once.
    const committed = await frameText(page, id);
    expect(committed.split('hello').length - 1).toBe(1);
    expect(committed.split('world').length - 1).toBe(1);
  });
});