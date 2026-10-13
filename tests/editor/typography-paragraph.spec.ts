/**
 * M22 §2 and §3: authored paragraph direction, indents and spacing, in a real browser.
 *
 * ## Why this cannot be a unit test
 *
 * The interesting claims about direction and indents are *layout* claims. `dir="rtl"` being on the
 * element is not the feature; the feature is that the first character of an Arabic paragraph now
 * sits at the right edge of the frame, and that a first-line indent moves to the right on that same
 * paragraph while staying on the left for an English one. Neither is observable from the model, and
 * neither is observable from a `style` attribute -- only from where the glyphs actually landed.
 *
 * So the assertions below measure rectangles. Where a cheaper assertion would pass for the wrong
 * reason, the measuring one is used instead; where it is stated that a cheaper assertion is
 * genuinely enough, that is said.
 *
 * ## The round-trip is tested *here* and not only in the unit suite
 *
 * `rich-text-html.paragraph.test.ts` proves the walker reads `dir` and metrics back under happy-dom.
 * That is the property most likely to break silently, and it deserves a second witness in the
 * environment where it actually matters: a real contenteditable, where the browser may normalise,
 * reorder or drop inline style declarations on elements the user has touched. The `editing` group
 * below types into a live frame and then reads the *saved* document, so a browser that discards an
 * authored indent on the first keystroke fails here rather than in production.
 *
 * ## What is deliberately not claimed
 *
 * Nothing here promises professional Arabic typesetting. Kerning, justification quality, mark
 * positioning and font selection are the browser's, and this architecture keeps them there
 * deliberately. What is claimed is narrower and checkable: the author can state a direction, the
 * indents follow that direction, the text is not reordered by anything in *this* pipeline, and all
 * of it survives a save.
 */

import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { clickAt, expect, selectionIds, settle, test } from './helpers';
import { mountFixture } from '../visual/harness';

const COPY_ID = 'copy';

/** Arabic, with a full stop. Deterministic, so a failure names a specific string. */
const ARABIC = 'مرحبا بالعالم.';
/** Begins with a *neutral* -- a full stop -- so `auto` has no strong character to go on. */
const NEUTRAL_FIRST = '. ابتداء';
const LATIN = 'Plain English opening.';

/**
 * A document with three paragraphs, one per direction case.
 *
 * Built by concatenation rather than as a literal, for the reason `typography-bidi.spec.ts` gives:
 * a fixture that re-encodes its own Arabic is a test of the encoder. The paragraph fields are
 * spliced in as a string so each one is visible at the call site.
 */
function fixtureWith(paragraphFields: readonly string[], text: readonly string[]): string {
  const blocks = paragraphFields
    .map((fields, index) => `{ kind: 'paragraph'${fields}, runs: [{ text: ${JSON.stringify(text[index] ?? '')} }] }`)
    .join(', ');
  return `() => ({
    formatVersion: 4, id: 'para', name: 'Paragraphs',
    pageSetup: { fixedSize: true, defaultSize: { width: 210, height: 297, unit: 'mm', orientation: 'portrait' }, resizeBehaviour: 'crop' },
    assets: {},
    pages: [{
      id: 'p1', name: '1',
      size: { width: 210, height: 297, unit: 'mm', orientation: 'portrait' },
      background: { type: 'solid', color: '#ffffff' },
      objects: [{
        id: 'copy', type: 'textFrame', name: 'copy',
        transform: { x: 60, y: 60, width: 400, height: 240, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        text: { blocks: [${blocks}] },
      }],
    }],
  })`;
}

/** The three shapes most of this file needs. */
const AUTO = fixtureWith(['', '', ''], [ARABIC, LATIN, NEUTRAL_FIRST]);
const FORCED_RTL = fixtureWith([", dir: 'rtl'", '', ''], [ARABIC, LATIN, NEUTRAL_FIRST]);
const INDENTED = fixtureWith([', metrics: { textIndent: 40 }', '', ''], [LATIN, ARABIC, LATIN]);

/**
 * Every paragraph carrying the same indent, unlike `INDENTED`.
 *
 * Separate because the clearing test needs a field that actually *displays* a value. With
 * `INDENTED` the first paragraph has an indent and the other two do not, so the field correctly
 * reads "Mixed" and is already empty -- typing an empty string into an empty field is not a change,
 * no `change` event fires, and the test would be measuring nothing at all. That failure is
 * informative: it is what a correct Mixed display looks like to a test written against the wrong
 * assumption.
 */
const UNIFORMLY_INDENTED = fixtureWith(
  [', metrics: { textIndent: 40 }', ', metrics: { textIndent: 40 }', ', metrics: { textIndent: 40 }'],
  [LATIN, ARABIC, LATIN],
);

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

interface SavedBlock {
  align?: string;
  dir?: string;
  metrics?: Record<string, number>;
  runs: Array<{ text: string; format?: Record<string, boolean> }>;
}

async function savedBlocks(page: Page): Promise<SavedBlock[]> {
  const saved = await saveDocument(page);
  const pages = saved['pages'] as Array<{ objects: Array<Record<string, unknown>> }>;
  const frame = pages[0]?.objects.find((node) => node['id'] === COPY_ID);
  const text = frame?.['text'] as { blocks: SavedBlock[] } | undefined;
  return text?.blocks ?? [];
}

/** The rendered `<p>` elements, in order. */
function paragraphs(page: Page) {
  return page.locator(`[data-oid="${COPY_ID}"] .p1-text-content p`);
}

/**
 * Where a paragraph's glyphs actually start, in **document px**.
 *
 * A `Range` around the first text node rather than the paragraph's own box: the paragraph box is the
 * full frame width either way, so it cannot distinguish an RTL paragraph from an LTR one. The
 * first character's rectangle is the thing that actually moves.
 *
 * Returned as `{ left, right }` so "starts at the left" and "starts at the right" are both a simple
 * comparison, with no arithmetic in the assertions themselves.
 */
async function firstCharacterBox(
  page: Page,
  index: number,
): Promise<{ left: number; right: number; width: number }> {
  return paragraphs(page)
    .nth(index)
    .evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const first = walker.nextNode();
      if (first === null) return { left: 0, right: 0, width: 0 };
      const range = document.createRange();
      range.selectNodeContents(first);
      const box = range.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width };
    });
}

/** The paragraph's own content box, so the two rectangles can be compared. */
async function paragraphBox(page: Page, index: number): Promise<{ left: number; right: number }> {
  return paragraphs(page)
    .nth(index)
    .evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right };
    });
}

/**
 * Selects the frame without entering a text session.
 *
 * The click lands at the *bottom* of the frame, well below the three short paragraphs these
 * fixtures hold. `typography-inspector.spec.ts` has the same problem to solve and clicks above the
 * text; below is chosen here because two of the three fixtures put their first paragraph at the
 * right-hand edge under `rtl`, so "above" and "left" are not reliably empty. Landing low is
 * unambiguous regardless of direction.
 *
 * A click on the glyphs would open a session instead of a selection, and every inspector control in
 * this file is unreachable while a session is open.
 */
async function selectCopy(page: Page): Promise<void> {
  await clickAt(page, 100, 285);
  await settle(page);
  // Asserted rather than assumed: a silently failed selection produces a failure later and further
  // away with nothing to connect it back to this click. The marker is the overlay's
  // `data-for`, per `selectionIds` -- `data-oid` stamps the document object, so counting those
  // would have counted every node on the page.
  expect(await selectionIds(page), 'the click did not select the frame').toEqual([COPY_ID]);
}

/**
 * Enters a text session with the caret at the end of the frame.
 *
 * Three steps, all needed, and the sequence is `typography-bidi.spec.ts`'s rather than one worked out
 * here: select the frame, press Enter to open the session, then click the content and press End. A
 * click alone does not open a session -- which is exactly why a first attempt at this file typed
 * into nothing and reported three failures about absent text instead of about the thing under test.
 */
async function enterSessionAtEnd(page: Page): Promise<void> {
  await selectCopy(page);
  await page.keyboard.press('Enter');
  await settle(page);
  await page.locator(`[data-oid="${COPY_ID}"] .p1-text-content`).click();
  await page.keyboard.press('End');
  await settle(page);
}

/** Ends the session, which is what commits the edit the browser has been holding. */
async function endSession(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await settle(page);
}

function directionButton(page: Page, value: string) {
  return page.locator(`[data-direction-row] button[data-dir="${value}"]`);
}

function metricField(page: Page, key: string) {
  return page.locator(`[data-metric="${key}"]`);
}

async function commitMetric(page: Page, key: string, value: string): Promise<void> {
  const input = metricField(page, key);
  await input.click();
  await input.fill(value);
  await input.blur();
  await settle(page);
}

test.describe('authored paragraph direction', () => {
  test('an absent direction renders as `auto`, which is what a pre-M22 document meant', async ({
    page,
  }) => {
    await mountFixture(page, AUTO);
    // Three paragraphs, all with no `dir` in the model. `dir="auto"` on all three is the guarantee
    // that nothing about an untouched document changed.
    for (const index of [0, 1, 2]) {
      expect(await paragraphs(page).nth(index).getAttribute('dir')).toBe('auto');
    }
    expect((await savedBlocks(page))[0]?.dir, 'a direction was invented').toBeUndefined();
  });

  test('an explicit direction reaches both the DOM and the saved document', async ({ page }) => {
    await mountFixture(page, FORCED_RTL);
    expect(await paragraphs(page).nth(0).getAttribute('dir')).toBe('rtl');
    expect((await savedBlocks(page))[0]?.dir).toBe('rtl');
  });

  test('forced RTL puts Arabic at the right edge and leaves English at the left', async ({ page }) => {
    await mountFixture(page, FORCED_RTL);

    const arabic = await firstCharacterBox(page, 0);
    const arabicFrame = await paragraphBox(page, 0);
    // "Starts at the right" is asserted as a comparison against the frame, not against a hard-coded
    // x: the frame's position in the viewport depends on the zoom and the scroll, and a pixel
    // literal would be a test of the harness rather than of the layout.
    expect(arabic.right - arabicFrame.right, 'Arabic did not hug the frame\'s right edge').toBeLessThan(
      4,
    );

    const english = await firstCharacterBox(page, 1);
    const englishFrame = await paragraphBox(page, 1);
    expect(english.left - englishFrame.left, 'English did not hug the frame\'s left edge').toBeLessThan(
      4,
    );
  });

  test('an all-neutral paragraph is where auto and rtl visibly differ', async ({ page }) => {
    // The paragraph M21's `dir="auto"` could not fix, and getting to it required correcting a
    // misreading of what `auto` does.
    //
    // I first wrote this with a paragraph opening `. Arabic` and expected `auto` to fall back to
    // the document direction. It does not: HTML's `dir=auto` scans past leading neutrals to the
    // *first strong* character, so it found the Arabic and resolved RTL correctly all along. M21's
    // note about neutrals is about which *side* a neutral lands on, not about detection.
    //
    // The genuinely undecidable case is a paragraph with no strong character anywhere: digits,
    // punctuation and spaces only. There `auto` falls back to the element's inherited direction
    // (LTR here), while an explicit `rtl` resolves it. That is what an author needs to be able to
    // say, and it is what this asserts.
    const neutral = '2026 - 42 %';
    await mountFixture(page, fixtureWith(['', ''], [neutral, neutral]));
    const autoBox = await firstCharacterBox(page, 0);
    const autoFrame = await paragraphBox(page, 0);

    await selectCopy(page);
    await directionButton(page, 'rtl').click();
    await settle(page);

    const rtlBox = await firstCharacterBox(page, 0);
    expect(await paragraphs(page).nth(0).getAttribute('dir')).toBe('rtl');

    // Asserted as a side rather than a pixel literal, so the test survives any zoom or scroll the
    // harness happens to use.
    const autoSide = autoBox.left - autoFrame.left < 4 ? 'left' : 'right';
    const rtlSide = rtlBox.right - autoFrame.right < 4 ? 'right' : 'left';
    expect(autoSide, 'auto did not fall back to the document direction').toBe('left');
    expect(rtlSide, 'an explicit rtl did not move the paragraph to the right').toBe('right');
  });

  test('direction is per paragraph, so one frame can hold both', async ({ page }) => {
    await mountFixture(page, FORCED_RTL);
    expect(await paragraphs(page).nth(0).getAttribute('dir')).toBe('rtl');
    expect(await paragraphs(page).nth(1).getAttribute('dir')).toBe('auto');
    expect(await paragraphs(page).nth(2).getAttribute('dir')).toBe('auto');

    const first = await firstCharacterBox(page, 0);
    const second = await firstCharacterBox(page, 1);
    // Two adjacent paragraphs in one frame resolving to opposite edges: the property is the
    // paragraph's, and the frame did not acquire a direction of its own.
    expect(first.right).not.toBeCloseTo(second.right, 0);
  });

  test('direction is never inferred from alignment', async ({ page }) => {
    // Centring a right-to-left paragraph must not change its direction, and centring an LTR one
    // must not make it RTL. Direction answers "which way does this run"; alignment answers "where
    // does it sit". Conflating them is the specific mistake this test forbids.
    await mountFixture(page, FORCED_RTL);
    await selectCopy(page);

    await page.locator('[data-align="center"]').click();
    await settle(page);

    const blocks = await savedBlocks(page);
    expect(blocks[0]?.align, 'alignment was not applied').toBe('center');
    expect(blocks[0]?.dir, 'centring changed the direction').toBe('rtl');
    expect(blocks[1]?.align).toBe('center');
    expect(blocks[1]?.dir, 'an auto paragraph acquired a direction').toBeUndefined();
  });

  test('choosing RTL and then Auto returns the paragraph to no direction at all', async ({ page }) => {
    await mountFixture(page, FORCED_RTL);
    await selectCopy(page);

    await directionButton(page, 'auto').click();
    await settle(page);

    expect(await paragraphs(page).nth(0).getAttribute('dir')).toBe('auto');
    const text = JSON.stringify(await savedBlocks(page));
    // Not `"dir":"auto"`. A saved `auto` would mean "set to auto", which is a different state from
    // "never had a direction", and the round-trip test in the unit suite asserts they are one
    // paragraph. A file that disagreed with that would be the disagreement.
    expect(text).not.toContain('"dir"');
  });

  test('direction is one undo step and redo restores it', async ({ page }) => {
    await mountFixture(page, AUTO);
    await selectCopy(page);

    await directionButton(page, 'rtl').click();
    await settle(page);
    expect((await savedBlocks(page))[0]?.dir).toBe('rtl');

    await page.keyboard.press('Control+z');
    await settle(page);
    expect(await paragraphs(page).nth(0).getAttribute('dir')).toBe('auto');
    expect((await savedBlocks(page))[0]?.dir).toBeUndefined();

    await page.keyboard.press('Control+y');
    await settle(page);
    expect((await savedBlocks(page))[0]?.dir).toBe('rtl');
  });
});

test.describe('direction-aware indents', () => {
  test('a first-line indent moves to the right on an RTL paragraph', async ({ page }) => {
    // The payoff for using logical properties. There is no RTL branch anywhere in the codebase, so
    // this works because `text-indent` resolves against the paragraph's own base direction -- and
    // this test is what proves that it actually does.
    await mountFixture(
      page,
      fixtureWith([", dir: 'rtl', metrics: { textIndent: 40 }", ''], [ARABIC, ARABIC]),
    );

    const first = await firstCharacterBox(page, 0);
    const second = await firstCharacterBox(page, 1);
    const frame = await paragraphBox(page, 0);

    // The indented RTL paragraph's first line starts further from the right edge than the plain one.
    expect(frame.right - first.right).toBeGreaterThan(frame.right - second.right + 20);
  });

  test('the same indent moves to the left on an LTR paragraph', async ({ page }) => {
    await mountFixture(
      page,
      fixtureWith([", dir: 'ltr', metrics: { textIndent: 40 }", ''], [LATIN, LATIN]),
    );

    const first = await firstCharacterBox(page, 0);
    const second = await firstCharacterBox(page, 1);
    const frame = await paragraphBox(page, 0);

    expect(first.left - frame.left).toBeGreaterThan(second.left - frame.left + 20);
  });

  test('an indent-start margin insets from the right when the paragraph is RTL', async ({ page }) => {
    await mountFixture(
      page,
      fixtureWith([", dir: 'rtl', metrics: { marginStart: 50 }", ''], [ARABIC, ARABIC]),
    );
    const indented = await paragraphBox(page, 0);
    const plain = await paragraphBox(page, 1);
    expect(plain.right - indented.right).toBeGreaterThan(40);
  });

  test('metrics reach the saved document and the DOM together', async ({ page }) => {
    await mountFixture(page, AUTO);
    await selectCopy(page);
    await commitMetric(page, 'textIndent', '10mm');
    await commitMetric(page, 'marginBefore', '4mm');

    const blocks = await savedBlocks(page);
    expect(blocks[0]?.metrics?.['textIndent']).toBeCloseTo(37.795, 1);
    expect(blocks[0]?.metrics?.['marginBefore']).toBeCloseTo(15.118, 1);

    const applied = await paragraphs(page)
      .nth(0)
      .evaluate((element) => ({
        indent: element.style.getPropertyValue('text-indent'),
        before: element.style.getPropertyValue('margin-block-start'),
      }));
    expect(applied.indent).not.toBe('');
    expect(applied.before).not.toBe('');
  });

  test('setting one metric leaves the others alone', async ({ page }) => {
    // The defect this guards is invisible in the field the user did not open.
    await mountFixture(page, INDENTED);
    await selectCopy(page);
    await commitMetric(page, 'marginAfter', '3mm');

    const blocks = await savedBlocks(page);
    expect(blocks[0]?.metrics?.['textIndent']).toBeCloseTo(40, 1);
    expect(blocks[0]?.metrics?.['marginAfter']).toBeCloseTo(11.339, 1);
  });

  test('an empty field clears the metric, and the saved document loses the key', async ({ page }) => {
    await mountFixture(page, UNIFORMLY_INDENTED);
    await selectCopy(page);
    expect(await metricField(page, 'textIndent').inputValue(), 'the field did not show the shared value').not.toBe('');
    await commitMetric(page, 'textIndent', '');

    const blocks = await savedBlocks(page);
    expect(blocks[0]?.metrics?.['textIndent']).toBeUndefined();
    expect(JSON.stringify(blocks[0])).not.toContain('"textIndent"');
  });

  test('a negative first-line indent is accepted, because that is a hanging indent', async ({
    page,
  }) => {
    await mountFixture(page, INDENTED);
    await selectCopy(page);
    await commitMetric(page, 'textIndent', '-10mm');

    expect((await savedBlocks(page))[0]?.metrics?.['textIndent']).toBeCloseTo(-37.795, 1);
  });

  test('a negative margin is refused and the field reverts', async ({ page }) => {
    // A negative margin means "overlap the neighbouring paragraph", which a fixed-size frame cannot
    // honour safely. Reverting visibly beats committing a clamped value: a silent clamp is a
    // document that does not say what the panel showed.
    await mountFixture(page, INDENTED);
    await selectCopy(page);
    await commitMetric(page, 'marginStart', '-5mm');

    expect((await savedBlocks(page))[0]?.metrics?.['marginStart']).toBeUndefined();
    expect(
      await metricField(page, 'marginStart').evaluate((element) =>
        element.classList.contains('p1-inspector-field-input--invalid'),
      ),
      'the field did not report the refusal',
    ).toBe(true);
  });

  test('Clear indents removes all five in one undo step', async ({ page }) => {
    await mountFixture(
      page,
      fixtureWith(
        [', metrics: { textIndent: 40, marginStart: 10, marginEnd: 10, marginBefore: 5, marginAfter: 5 }'],
        [LATIN],
      ),
    );
    await selectCopy(page);
    await page.locator('.p1-inspector-metric-clear').click();
    await settle(page);

    expect((await savedBlocks(page))[0]).not.toHaveProperty('metrics');

    await page.keyboard.press('Control+z');
    await settle(page);
    // One step, not five: all five keys travel in a single batched command.
    expect((await savedBlocks(page))[0]?.metrics?.['textIndent']).toBeCloseTo(40, 1);
    expect((await savedBlocks(page))[0]?.metrics?.['marginBefore']).toBeCloseTo(5, 1);
  });

  test('the fields show Mixed for disagreeing paragraphs and a value for agreeing ones', async ({
    page,
  }) => {
    await mountFixture(
      page,
      fixtureWith(
        [', metrics: { textIndent: 40 }', ', metrics: { textIndent: 40 }', ''],
        [LATIN, LATIN, LATIN],
      ),
    );
    await selectCopy(page);

    // Two of three carry the indent, so the field cannot show a single value. Asserted through the
    // placeholder rather than the value, because "Mixed" is exactly the state under test.
    expect(await metricField(page, 'textIndent').inputValue()).toBe('');
    expect(await metricField(page, 'textIndent').getAttribute('placeholder')).toBe('Mixed');
    // ...and the Clear button is enabled precisely because there *is* something to clear, which is
    // the question it is keyed off rather than off what the field displays.
    expect(await page.locator('.p1-inspector-metric-clear').isDisabled()).toBe(false);
  });
});

test.describe('editing does not discard paragraph properties', () => {
  test('typing inside a frame keeps its direction and its indents', async ({ page }) => {
    // The property that makes this milestone more than adding a field. `setText` is issued at the
    // end of every session carrying whatever the walker produced; if the walker could not read a
    // property back, the first keystroke in the frame would delete it -- silently, and only
    // visibly after a reload.
    await mountFixture(page, fixtureWith([", dir: 'rtl', metrics: { textIndent: 20 }"], [ARABIC]));

    await enterSessionAtEnd(page);
    await page.keyboard.type('X');
    await endSession(page);

    const blocks = await savedBlocks(page);
    expect(blocks[0]?.dir, 'typing discarded the direction').toBe('rtl');
    expect(blocks[0]?.metrics?.['textIndent'], 'typing discarded the indent').toBeCloseTo(20, 1);
    // The text itself must be intact and in logical order: adding a character at the end must not
    // reorder the Arabic, which would mean something in this pipeline applied a visual transform.
    expect(blocks[0]?.runs[0]?.text).toBe(`${ARABIC}X`);
  });

  test('emptying a paragraph keeps its properties', async ({ page }) => {
    // An emptied line is still a paragraph. Losing its direction on emptying would mean the user
    // cannot press Enter, fix a typo, delete the line and get the paragraph back.
    await mountFixture(page, fixtureWith([", dir: 'rtl', metrics: { marginBefore: 12 }"], [ARABIC]));

    await enterSessionAtEnd(page);
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await endSession(page);

    const blocks = await savedBlocks(page);
    expect(blocks[0]?.dir).toBe('rtl');
    expect(blocks[0]?.metrics?.['marginBefore']).toBeCloseTo(12, 1);
  });

test('superscript reaches the saved document, applied to the frame outside a session', async ({
    page,
  }) => {
    // The outside-session path, because that is the one M21 proved for strike and the one the
    // inspector buttons use. A collapsed caret *inside* a session is deliberately not the subject
    // here: Chromium implements `execCommand('superscript')` on a collapsed caret as a pending
    // typing state, so it changes no DOM and there is nothing for `setText` to commit. That is the
    // browser's behaviour for every rich-text surface, and it is why this test drives the control
    // rather than the chord.
    await mountFixture(page, AUTO);
    await selectCopy(page);
    await page.locator('.p1-inspector-format-super').click();
    await settle(page);

    const blocks = await savedBlocks(page);
    expect(blocks[0]?.runs[0]?.format?.['super'], 'superscript was not applied').toBe(true);
  });

  test('subscript reaches the saved document from the toolbar', async ({ page }) => {
    await mountFixture(page, AUTO);
    await selectCopy(page);
    await page.locator('.p1-inspector-format-sub').click();
    await settle(page);

    const blocks = await savedBlocks(page);
    expect(blocks[0]?.runs[0]?.format?.['sub'], 'subscript was not applied').toBe(true);
    expect(
      blocks[0]?.runs[0]?.format?.['super'],
      'subscript also set superscript, which the model treats as a distinct pair',
    ).toBeUndefined();
  });

test('the super and subscript chords reach the browser inside a session', async ({ page }) => {
    // The case Chromium has no chord for, which is why M22 forwards it. Before that, the inspector
    // advertised a shortcut that silently did nothing for the whole time the user was typing --
    // which is when they most expect it to work.
    //
    // Asserted through `queryCommandState`, which is the only reliable witness here. Chromium
    // implements `execCommand('superscript')` on a *collapsed* caret as a pending typing state: it
    // changes no DOM, so there is nothing for `setText` to commit and nothing to measure, but
    // `queryCommandState` reports the browser is now in superscript. Waiting for the `<sup>` to
    // appear would time out, and asserting "nothing happened" would be true of the bug this test
    // was written for as well -- which is the trap worth avoiding.
    //
    // Latin content on purpose. What is under test is that the chord *reaches the browser*, and
    // Chromium's selection handling on this path is what these fixtures were calibrated against.
    // Folding bidi in would make a bidi difference look like a shortcut defect; the RTL paragraphs
    // are exercised by the layout tests above, where direction is the subject.
    await mountFixture(page, fixtureWith(['', '', ''], [LATIN, LATIN, LATIN]));
    await enterSessionAtEnd(page);

    const stateOf = (command: string): Promise<boolean> =>
      page.evaluate((name) => document.queryCommandState(name), command);

    await page.keyboard.press('Control+Shift+.');
    await settle(page);
    expect(
      await stateOf('superscript'),
      'the superscript chord did not reach the browser inside the session',
    ).toBe(true);

    await page.keyboard.press('Control+Shift+,');
    await settle(page);
    expect(
      await stateOf('subscript'),
      'the subscript chord did not reach the browser inside the session',
    ).toBe(true);
  });

  test('a superscript applied inside a session survives into the saved document', async ({ page }) => {
    // The consequence of the forwarding above, observed end to end.
    //
    // One paragraph, not three. A locator click aims at the *centre* of the element, so in a
    // three-paragraph frame it lands in the middle one -- and a test that then asserted on
    // `blocks[0]` was asserting about a paragraph nothing had been applied to. One paragraph makes
    // the click and the assertion name the same place, which is one less thing to hold in mind.
    await mountFixture(page, fixtureWith([''], [LATIN]));
    await enterSessionAtEnd(page);

    await page.keyboard.press('Home');
    for (let index = 0; index < 3; index += 1) await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Control+Shift+.');
    await settle(page);
    await endSession(page);

    const runs = (await savedBlocks(page))[0]?.runs ?? [];
    expect(runs.length, 'the selection did not split the run').toBeGreaterThan(1);
    expect(runs.filter((run) => run.format?.['super'] === true).length).toBe(1);
  });
});

test.describe('multilingual publishing', () => {
  test('mixed Arabic and Latin survive a save in logical order', async ({ page }) => {
    const mixed = 'Latin ثم العربية ثم Latin';
    await mountFixture(page, fixtureWith([', dir: "rtl"'], [mixed]));
    await enterSessionAtEnd(page);
    await page.keyboard.type('!');
    await endSession(page);

    const text = (await savedBlocks(page))[0]?.runs[0]?.text ?? '';
    // Compared to the *source* string, not to a rendering. The bidi algorithm's visual order is
    // correct by construction and is the browser's job; what this application must not do is reorder
    // the stored characters.
    expect(text).toBe(`${mixed}!`);
    expect([...text].length).toBe([...mixed].length + 1);
  });

  test('neutral characters at a paragraph boundary stay attached to the paragraph', async ({
    page,
  }) => {
    // Every neutral-leading string, which is the whole reason `dir` became authorable. One case,
    // because the property under test is the same for all of them.
    await mountFixture(page, fixtureWith([', dir: "rtl"'], ['2026 - ابتدائية']));
    const blocks = await savedBlocks(page);
    expect(blocks[0]?.runs[0]?.text).toBe('2026 - ابتدائية');
    expect(blocks[0]?.dir).toBe('rtl');
  });

  test('a combining mark survives alongside an RTL paragraph and an indent', async ({ page }) => {
    // A base character and its combining mark must stay in *one run*. Split across runs they land in
    // different inline boxes, which is where shaping breaks and the mark renders detached -- the one
    // way this architecture could plausibly damage text, so it is worth a case.
    const marked = 'مَرْحَبًا';
    await mountFixture(page, fixtureWith([', dir: "rtl", metrics: { textIndent: 20 }'], [marked]));
    await enterSessionAtEnd(page);
    await page.keyboard.type(' ');
    await endSession(page);

    const runs = (await savedBlocks(page))[0]?.runs ?? [];
    expect(runs, 'the combining sequence was split across runs').toHaveLength(1);
    expect([...(runs[0]?.text ?? '')].length).toBe([...marked].length + 1);
  });

  test('a font this machine lacks is preserved in the document', async ({ page }) => {
    // "Specified" and "installed" are different facts. The document records the request; whether it
    // renders is the browser's business, and rewriting an unavailable family to whatever *is*
    // installed would make the document lie and lose the author's intent on the next open.
    const wanted = 'This Font Does Not Exist 12345';
    await mountFixture(page, fixtureWith(["", ", style: { fontFamily: 'No Such Face', fontSize: 12 }"], [wanted, wanted]));
    await selectCopy(page);

    await metricField(page, 'textIndent').click();
    await page.locator('[data-text-field="fontFamily"]').fill('Also Missing, serif');
    await page.locator('[data-text-field="fontFamily"]').blur();
    await settle(page);

    const pages = (await saveDocument(page))['pages'] as Array<{
      objects: Array<{ style?: { fontFamily?: string } }>;
    }>;
    expect(pages[0]?.objects[0]?.style?.['fontFamily']).toBe('Also Missing, serif');
  });
});

test.describe('PDF export', () => {
  test('an RTL paragraph survives into the exported PDF', async ({ page }) => {
    await mountFixture(page, FORCED_RTL);

    // Cheap, and honestly so: the assertion is that the export pipeline *ran and produced a
    // well-formed PDF* for a document containing RTL text. Comparing screen layout to PDF layout is
    // not something this file claims -- the two are produced by different layout passes and no
    // evidence here supports pixel-identity between them. What is checked is that nothing in the
    // export path throws on an RTL paragraph and that a sheet is produced.
    const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
    expect(pdf.byteLength).toBeGreaterThan(1000);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  test('export succeeds for a document whose paragraphs carry indents and a signed indent', async ({
    page,
  }) => {
    await mountFixture(
      page,
      fixtureWith(
        [', dir: "rtl", metrics: { textIndent: -20, marginStart: 40, marginBefore: 6 }'],
        [ARABIC],
      ),
    );
    const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
