/**
 * M21: the typography inspector controls, and the semantics they claim.
 *
 * ## Why a browser test and not a unit test
 *
 * Everything here is about a *control*: whether the field exists, what it displays for a value the
 * model calls "unset", whether committing reaches the store, and whether undo reverses it. None of
 * that is observable from the model alone -- a `fontFamily` field that renders nothing would leave
 * every model test green. So each case drives the real inspector and then reads the real saved
 * document back, which is the only artefact that proves persistence at the same time.
 *
 * ## The defect this file was written for
 *
 * `commitText` treated an empty field as a typo and reverted it, so **no `TextStyle` property could
 * ever be unset from the UI**. The model defines an absent property as "the renderer emits nothing
 * and CSS decides"; the section already displayed that state as an empty field with a `-`
 * placeholder; and `setTextStyle` already collapses an all-undefined style to no style. The command
 * could express "unset" the whole time -- the inspector simply could not reach it. You could set a
 * value and never take it back.
 *
 * `clearing` is therefore the load-bearing group here, not an edge case.
 */

import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { clickAt, expect, settle, test } from './helpers';
import { mountFixture } from '../visual/harness';
import { TEXT_FIXTURE, TEXT_IDS } from './text-fixtures';

/**
 * The frame's node id.
 *
 * `TEXT_IDS.copy` is that frame's *geometry* in document px, not its id. The id is the literal in
 * `TEXT_FIXTURE`, so it is written out here and checked against the fixture by the assertions
 * below rather than imported from somewhere that does not carry it.
 */
const COPY_ID = 'copy';

/** Saves through the real Save button and returns the parsed document. */
async function saveDocument(page: Page): Promise<Record<string, unknown>> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-doc="save"]').click(),
  ]);
  const path = await download.path();
  if (path === null) throw new Error('the download produced no path');
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

/** The frame's `style` out of the saved document, so claims go through the file boundary. */
async function savedStyle(page: Page): Promise<Record<string, unknown> | undefined> {
  const document = await saveDocument(page);
  const pages = document['pages'] as Array<{ objects: Array<Record<string, unknown>> }>;
  const frame = pages[0]?.objects.find((node) => node['id'] === COPY_ID);
  return frame?.['style'] as Record<string, unknown> | undefined;
}

/**
 * Selects the copy frame by clicking it, the way a user picks it up.
 *
 * The point is in **document px**, because `clickAt` converts from the document's coordinate space
 * and a client rect would be silently off by the zoom and the scroll. `TEXT_IDS.copy` carries that
 * geometry precisely so a click lands on the frame; the offset keeps it inside the frame but clear
 * of the text, because a click on the glyphs enters a session and these tests want a selection.
 */
async function selectCopy(page: Page): Promise<void> {
  await clickAt(page, TEXT_IDS.copy.x + 60, TEXT_IDS.copy.y + 20);
  await settle(page);
}

function field(page: Page, key: string) {
  return page.locator(`[data-text-field="${key}"]`);
}

/** Types into a field and blurs it, which is how a field commits. */
async function commitField(page: Page, key: string, value: string): Promise<void> {
  const input = field(page, key);
  await input.click();
  await input.fill(value);
  await input.blur();
  await settle(page);
}

test.describe('the typography inspector', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, TEXT_FIXTURE);
  });

  test('every TextStyle property has a control, including font family', async ({ page }) => {
    // The gap this closes: `fontFamily` was in the model, in the parser and in the renderer, and
    // had no control at all. Every other property had one. A model capability nobody can reach is
    // indistinguishable from one that does not exist.
    for (const key of ['fontFamily', 'fontSize', 'lineHeight', 'letterSpacing', 'color']) {
      expect(await field(page, key).count(), `${key} has no control`).toBe(1);
    }
  });

  test('the font family control shows the value the model holds', async ({ page }) => {
    await selectCopy(page);
    // The stored stack is shown verbatim rather than resolved to a single face: the document
    // records what was authored, and the browser does the resolving.
    expect(await field(page, 'fontFamily').inputValue()).toBe('Georgia, serif');
    expect(await field(page, 'fontSize').inputValue()).not.toBe('');
  });

  test('every control is labelled for a screen reader', async ({ page }) => {
    await selectCopy(page);
    for (const [key, name] of [
      ['fontFamily', 'Font'],
      ['fontSize', 'Size'],
      ['lineHeight', 'Line'],
      ['letterSpacing', 'Track'],
      ['color', 'Colour'],
    ] as const) {
      const label = await field(page, key).getAttribute('aria-label');
      expect(label, `${key} has no accessible name`).toContain(name);
    }
  });

  test('changing the font family reaches the saved document', async ({ page }) => {
    await selectCopy(page);
    await commitField(page, 'fontFamily', '"Times New Roman", Times, serif');
    expect((await savedStyle(page))?.['fontFamily']).toBe('"Times New Roman", Times, serif');
  });

  test('changing the font family is one undo step and redo restores it', async ({ page }) => {
    await selectCopy(page);
    await commitField(page, 'fontFamily', 'Courier New, monospace');

    await page.keyboard.press('Control+z');
    await settle(page);
    expect((await savedStyle(page))?.['fontFamily']).toBe('Georgia, serif');

    await page.keyboard.press('Control+y');
    await settle(page);
    expect((await savedStyle(page))?.['fontFamily']).toBe('Courier New, monospace');
  });

  test('changing the font family leaves the character formatting alone', async ({ page }) => {
    // The failure this guards is a quiet one: if the commit path rewrote the frame's `text`, the
    // bold and italic runs could survive as bytes yet change shape on the next normalise, or a run
    // boundary could move.
    //
    // Asserted on the *paragraphs*, not the frame element's `innerHTML`. The content element
    // carries the frame's typography in a `style` attribute, so changing the font legitimately
    // changes that markup -- comparing the whole element would fail on the one change under test
    // and would not notice a run being dropped, which is what matters here.
    const runs = () =>
      page
        .locator(`[data-objects] [data-oid="${COPY_ID}"] .p1-text-content`)
        .evaluate((element) =>
          [...element.querySelectorAll('p')].map((paragraph) => paragraph.innerHTML),
        );

    const before = await runs();
    expect(before.join('|'), 'the fixture should already carry formatted runs').toContain('<b>');

    await selectCopy(page);
    await commitField(page, 'fontFamily', 'Verdana, sans-serif');

    expect(await runs(), 'the rendered runs changed when only the frame style did').toEqual(before);
    // And the model agrees, which is the claim that actually matters -- the DOM could agree while
    // the document lost the runs.
    const document = await saveDocument(page);
    const pages = document['pages'] as Array<{ objects: Array<Record<string, unknown>> }>;
    const frame = pages[0]?.objects.find((node) => node['id'] === COPY_ID);
    expect(JSON.stringify(frame?.['text'])).toContain('"bold":true');
  });

  test('a malformed font stack is refused rather than silently not applying', async ({ page }) => {
    await selectCopy(page);
    // An unbalanced quote makes CSS discard the declaration, so the frame would render in the
    // default font with no message. Rejecting at the field puts the error where the typo is.
    await commitField(page, 'fontFamily', "'Georgia, serif");
    expect((await savedStyle(page))?.['fontFamily']).toBe('Georgia, serif');
    expect(await field(page, 'fontFamily').inputValue()).toBe('Georgia, serif');
  });

  test('a font stack that merely names an unavailable font is accepted', async ({ page }) => {
    // The opposite case, and the one that must NOT be rejected: there is no portable way to ask
    // whether a font is installed, so guessing would reject valid work. The browser falls through,
    // which is CSS doing its job.
    await selectCopy(page);
    await commitField(page, 'fontFamily', 'Definitely Not Installed 12345, serif');
    expect((await savedStyle(page))?.['fontFamily']).toBe('Definitely Not Installed 12345, serif');
  });
});

test.describe('clearing a typography property', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, TEXT_FIXTURE);
    await selectCopy(page);
  });

  test('an emptied field unsets the property instead of snapping back', async ({ page }) => {
    await commitField(page, 'letterSpacing', '');
    const style = await savedStyle(page);
    expect(
      style?.['letterSpacing'],
      'letterSpacing survived being cleared, so the frame cannot return to the CSS default',
    ).toBeUndefined();
  });

  test('clearing font size unsets it and leaves the other properties', async ({ page }) => {
    await commitField(page, 'fontSize', '');
    const style = await savedStyle(page);
    expect(style?.['fontSize']).toBeUndefined();
    expect(style?.['fontFamily'], 'clearing one property disturbed another').toBe('Georgia, serif');
    expect(style?.['lineHeight']).toBe(1.4);
  });

  test('clearing is one undo step', async ({ page }) => {
    await commitField(page, 'fontSize', '');
    expect((await savedStyle(page))?.['fontSize']).toBeUndefined();

    await page.keyboard.press('Control+z');
    await settle(page);
    expect((await savedStyle(page))?.['fontSize']).toBe(18);
  });

  test('clearing every property removes the style entirely rather than leaving an empty object', async ({ page }) => {
    // `setTextStyle` collapses an all-undefined style to `undefined`. If that ever stopped
    // happening, the document would carry `style: {}` -- equal in value but not in bytes, so every
    // save would differ from the file it was compared against.
    for (const key of ['fontFamily', 'fontSize', 'lineHeight', 'letterSpacing', 'color']) {
      await commitField(page, key, '');
    }
    expect(await savedStyle(page), 'an empty style object was left in the document').toBeUndefined();
  });

  test('a half-typed number is still a typo, not a value to clear', async ({ page }) => {
    // The counterpart to the clear behaviour, because "empty means unset" must not turn every
    // malformed entry into a silent reset.
    //
    // Captured rather than written out: the field shows the value in the *current unit*, so 18
    // document px is displayed as `13.5pt` on a pt document. Hard-coding either would make this a
    // test of the unit preference rather than of the revert.
    const shown = await field(page, 'fontSize').inputValue();
    const stored = (await savedStyle(page))?.['fontSize'];

    await commitField(page, 'fontSize', '0.');

    expect((await savedStyle(page))?.['fontSize'], 'a half-typed number reached the document').toBe(
      stored,
    );
    expect(await field(page, 'fontSize').inputValue()).toBe(shown);
  });
});
