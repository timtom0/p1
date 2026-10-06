import {
  expect,
  expectPageScreenshot,
  hitTestAt,
  mountFixture,
  mountSample,
  test,
} from './harness';
import { clickAt, selectionCount } from '../editor/helpers';
import { BLANK_LINE_FIXTURE, OVERFLOW_FIXTURE, TEXT_FIXTURE } from '../editor/text-fixtures';

/**
 * Visual verification of text (ADR 0003).
 *
 * A text frame is the one place where the model, CSS and the browser's own editing
 * all meet, so the interesting claims here are not "there are words on the page" but
 * the ones geometry alone cannot establish:
 *
 *  - `white-space: pre-wrap` really is in force, so four spaces occupy four spaces
 *    and a `\n` really is a line break — the model and the pixels agree.
 *  - An empty paragraph occupies a line, because we emit `<p></p>` with no `<br>`.
 *  - Overflowing text is *visible*, not clipped by its own frame, and still clipped
 *    by the page.
 *  - Overlapping text and shapes resolve by paint order like anything else.
 *
 * The fixtures are imported from `tests/editor/text-fixtures.ts` rather than copied,
 * so a baseline can never be recorded against one document and asserted against
 * another — the failure mode `tests/visual/README.md` warns about.
 *
 * Every mount runs at 1:1, because these assertions are in absolute document pixels.
 */

test('character formatting, alignment and a soft break render from the model', async ({ page }) => {
  await mountFixture(page, TEXT_FIXTURE);
  await expectPageScreenshot(page, 'text-formats');
});

test('an empty paragraph still occupies a line', async ({ page }) => {
  // The blank line comes *first*, so the image records the gap it leaves above the
  // text below it. An empty-only fixture would screenshot as blank white either way.
  await mountFixture(page, BLANK_LINE_FIXTURE);
  await expectPageScreenshot(page, 'text-empty-paragraph');
});

test('overflowing text is visible, and is clipped only by the page', async ({ page }) => {
  await mountFixture(page, OVERFLOW_FIXTURE);
  await expectPageScreenshot(page, 'text-overflow');
});

test('the shipped sample document renders with its text frame', async ({ page }) => {
  // The end-to-end path: `createSampleDocument()` through the real composition root.
  // The sample deliberately carries four character formats, a soft break and mixed
  // alignment, so this baseline would move if any of them stopped rendering.
  await mountSample(page);
  await expectPageScreenshot(page, 'sample-document-with-text');
});

test('a text frame is hit-testable as one object, not per glyph', async ({ page }) => {
  // Hit testing is against the model (§3.4), so a point on a letter resolves to the
  // frame — never to the `<p>` or `<b>` the browser put there.
  await mountFixture(page, TEXT_FIXTURE);
  expect(await hitTestAt(page, 62, 70)).toBe('object:copy');
  expect(await hitTestAt(page, 20, 20)).toBe('page');
  expect(await hitTestAt(page, -1, 70)).toBe('outside');
});

test('overflowing text paints outside the frame, and the frame is still only its box', async ({
  page,
}) => {
  await mountFixture(page, OVERFLOW_FIXTURE);

  // The *browser* hits the object below the frame, because the text really is painted
  // there — that is what `overflow: visible` means, and the baseline above shows it.
  expect(await hitTestAt(page, 80, 200)).toBe('object:copy');

  // The *editor* does not, because its hit test is against the model's box (§3.4) and
  // only the model knows an object's real extent. Clicking the overflow selects
  // nothing: selection count stays at zero rather than picking up the frame.
  //
  // Stating both is the point. A browser hit test is the wrong answer to "what did
  // the user click", and this is the case where the two visibly disagree.
  await clickAt(page, 80, 200);
  expect(await selectionCount(page)).toBe(0);

  // Inside the box, it selects as usual.
  await clickAt(page, 80, 70);
  expect(await selectionCount(page)).toBe(1);
});
