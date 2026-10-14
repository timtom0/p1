/**
 * M21 §6: Arabic, bidirectional text, combining marks, and font fallback.
 *
 * ## What this file is for, and what it deliberately does not claim
 *
 * The architecture already leans on the browser for shaping and bidi: the model stores *logical*
 * order -- the order the author typed -- and the renderer writes that string into the DOM, letting
 * the engine apply the Unicode bidirectional algorithm and shape the glyphs. M21 does not build a
 * shaping engine and does not promise professional-grade Arabic typesetting.
 *
 * So the question this file answers is narrow and answerable: **does editing, normalising,
 * round-tripping and exporting damage character order or break a combining sequence?** Every case
 * here is deterministic -- fixed strings with known code points -- so a failure names a specific
 * piece of text rather than "Arabic looked wrong".
 *
 * ## The three ways damage would actually show up
 *
 *  1. **Reordering.** Something in the pipeline applying a visual-order transform, or a
 *     normalisation pass that splits and rejoins runs and lets a `bidi` boundary leak between them.
 *  2. **Split shaping.** `normalizeRichText` merges and splits runs, and each run is rendered inside
 *     its own `<b>`/`<i>` wrapper. A base character and its combining mark landing in *different*
 *     runs puts them in different inline boxes, which is where shaping can break -- a mark that
 *     renders detached instead of composed.
 *  3. **Silent drop.** A normaliser that trims, or a `for..of` over UTF-16 units instead of code
 *     points, eating a surrogate pair or a mark.
 *
 * Case (2) is the one this architecture could plausibly get wrong, so there is a case for it.
 */

import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { clickAt, expect, settle, test } from './helpers';
import { mountFixture } from '../visual/harness';
import { TEXT_IDS } from './text-fixtures';

/** Arabic, with a diacritic and a combining mark that must stay attached. */
const ARABIC = 'مرحبا بالعالم';
/** Arabic with a harakat (combining fatha) on one letter. */
const ARABIC_MARKS = 'مَرْحَبًا';
/** Arabic followed by Latin digits, the classic bidi-boundary case. */
const MIXED_BIDI = 'عدد 123 قيمة';
/** Hebrew with Latin inside, to exercise the opposite direction. */
const RTL_LTR = 'שלום world שלום';
/** A base character plus a combining acute: U+0065 U+0301 must survive as two code points. */
const COMBINING = 'école';
/** An emoji outside the BMP, i.e. a surrogate pair in UTF-16. */
const ASTRAL = 'flag 🇵🇱 end';

const CASES: ReadonlyArray<{ name: string; text: string }> = [
  { name: 'Arabic', text: ARABIC },
  { name: 'Arabic with harakat', text: ARABIC_MARKS },
  { name: 'Arabic then Latin digits', text: MIXED_BIDI },
  { name: 'Hebrew with Latin inside', text: RTL_LTR },
  { name: 'Latin with a combining acute', text: COMBINING },
  { name: 'text with an astral-plane character', text: ASTRAL },
];

/** A document whose single frame holds `text`, with no frame typography at all. */
function fixtureFor(text: string): string {
  // Built by string concatenation rather than a literal so the text reaches the page exactly as
  // written here -- a test fixture that re-encodes its own subject is a test of the encoder.
  return `() => ({
    formatVersion: 3, id: 'bidi', name: 'Bidi',
    pageSetup: { fixedSize: true, defaultSize: { width: 210, height: 297, unit: 'mm', orientation: 'portrait' }, resizeBehaviour: 'crop' },
    styles: [],
    assets: {},
    pages: [{
      id: 'p1', name: '1',
      size: { width: 210, height: 297, unit: 'mm', orientation: 'portrait' },
      background: { type: 'solid', color: '#ffffff' },
      objects: [{
        id: 'copy', type: 'textFrame', name: 'copy',
        transform: { x: 60, y: 60, width: 400, height: 200, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        text: { blocks: [{ kind: 'paragraph', runs: [{ text: ${JSON.stringify(text)} }] }] },
      }],
    }],
  })`;
}

/** What the frame currently renders, read from the DOM rather than the model. */
async function renderedText(page: Page): Promise<string> {
  return page
    .locator('[data-oid="copy"] .p1-text-content')
    .evaluate((element) => element.textContent ?? '');
}

/** The shape of the saved document this file reads, named so the braces stay countable. */
interface SavedFrame {
  id: string;
  text?: { blocks: Array<{ runs: Array<{ text: string }> }> };
}
interface SavedDocument {
  pages: Array<{ objects: SavedFrame[] }>;
}

/** The frame's run text, read out of the saved document. */
async function savedText(page: Page): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-doc="save"]').click(),
  ]);
  const path = await download.path();
  if (path === null) throw new Error('the download produced no path');
  const document = JSON.parse(await readFile(path, 'utf8')) as SavedDocument;
  const frame = document.pages[0]?.objects.find((node) => node.id === 'copy');
  // Runs concatenate *within* a paragraph and paragraphs join with a newline -- the same rule
  // `richTextToPlain` uses. Flattening first and joining with `\n` looks equivalent and is not:
  // it puts a newline between every run, which for Arabic reads as four paragraphs.
  return (frame?.text?.blocks ?? [])
    .map((block) => block.runs.map((run) => run.text).join(''))
    .join('\n');
}

test.describe('bidi and shaping survive the model', () => {
  for (const subject of CASES) {
    test(`${subject.name} round-trips through the document unchanged`, async ({ page }) => {
      await mountFixture(page, fixtureFor(subject.text));

      // Rendered text content is compared, not visual order: the DOM holds the same logical string
      // the model holds, and the *visual* order is the bidi algorithm's business. Comparing
      // rendered glyph order would assert that the engine does not do its job.
      expect(await renderedText(page), 'the rendered text differs from the authored text').toBe(
        subject.text,
      );
      expect(await savedText(page), 'the saved text differs from the authored text').toBe(subject.text);
    });
  }

  test('a combining mark is not damaged, whether or not it shares a run with its base', async ({ page }) => {
    // The split-shaping risk, tested rather than assumed.
    //
    // A premise I got wrong first time: the loaded document is **not** canonicalised on load --
    // `DocStore` does not call `normalizeRichText` -- and that is deliberate, because
    // `richTextEqual` is documented as "independent of canonical form" precisely so a loaded
    // document compares equal to its normalised twin. So a base character and its mark in separate
    // runs stay in separate runs, and in separate text nodes.
    //
    // So the claim cannot be "they are merged". The claim is that **no character is lost or
    // reordered either way**, which is what "the application must not damage shaping" means here.
    const base = 'a';
    const mark = '́';

    await mountFixture(page, fixtureFor(`${base}${mark}`));
    expect(await renderedText(page), 'a composed pair was damaged in a single run').toBe(`${base}${mark}`);
    expect([...(await renderedText(page))].length, 'the pair lost a code point').toBe(2);

    // The split case, built as its own fixture so the run boundary is real rather than normalised
    // away before it can be observed.
    await mountFixture(
      page,
      fixtureFor('x').replace(
        `runs: [{ text: "x" }]`,
        `runs: [{ text: ${JSON.stringify(base)} }, { text: ${JSON.stringify(mark)} }]`,
      ),
    );
    const split = await renderedText(page);
    expect(split, 'splitting the pair lost or reordered a character').toBe(`${base}${mark}`);
    expect([...split].length, 'splitting the pair lost a code point').toBe(2);
    expect(await savedText(page), 'the split pair did not survive the file boundary').toBe(`${base}${mark}`);
  });

  test('an astral-plane character is not split by a surrogate boundary', async ({ page }) => {
    // `for (const character of raw)` in `parseFamily` and every string comparison in the model rely
    // on code-point iteration. A `split('')` or an index-based loop anywhere on this path would cut
    // the flag in half and leave two lone surrogates in the saved file.
    await mountFixture(page, fixtureFor(ASTRAL));
    const text = await renderedText(page);
    expect([...text].length, 'the flag is not one code point').toBe(1 + 'flag '.length + 1 + ' end'.length);
    expect(text, 'a lone surrogate reached the DOM').toBe(ASTRAL);
  });

  test('no character is lost when runs are merged across a formatting boundary', async ({ page }) => {
    // Arabic with a bold run in the middle: the merge in `normalizeRichText` is the code that could
    // drop a character, and this is the shape where it would.
    const subject = 'ابج';
    await mountFixture(
      page,
      `() => ({
        formatVersion: 3, id: 'mix', name: 'Mixed',
        pageSetup: { fixedSize: true, defaultSize: { width: 210, height: 297, unit: 'mm', orientation: 'portrait' }, resizeBehaviour: 'crop' },
        styles: [],
        assets: {},
        pages: [{
          id: 'p1', name: '1',
          size: { width: 210, height: 297, unit: 'mm', orientation: 'portrait' },
          background: { type: 'solid', color: '#ffffff' },
          objects: [{
            id: 'copy', type: 'textFrame', name: 'copy',
            transform: { x: 60, y: 60, width: 400, height: 200, rotation: 0, scaleX: 1, scaleY: 1 },
            visible: true, locked: false, opacity: 1, blendMode: 'normal',
            text: { blocks: [{ kind: 'paragraph', runs: [
              { text: 'ا' },
              { text: 'ب', format: { bold: true } },
              { text: '' },
              { text: 'ج' },
            ] }] },
          }],
        }],
      })`,
    );

    const saved = await savedText(page);
    expect(saved, 'a run was dropped or truncated by normalisation').toBe(subject);
  });
});

test.describe('visual order on screen', () => {
  test('an Arabic line is laid out right-to-left on screen, not just stored backwards', async ({ page }) => {
    // Everything else in this file compares *logical* order, because that is what the model holds
    // and the bidi algorithm's job is to turn it into something visual. Which means all of it would
    // pass on a page that rendered Arabic left-to-right with the letters in the right order and the
    // line in the wrong place -- a real and common failure, and invisible to a text comparison.
    //
    // So this one measures the screen. `Range` over each character gives its box, and for a
    // right-to-left line the *first* character must sit to the right of the last.
    await mountFixture(page, fixtureFor(ARABIC));

    const boxes = await page
      .locator('[data-oid="copy"] .p1-text-content p')
      .first()
      .evaluate((paragraph) => {
        const node = paragraph.firstChild;
        if (node === null || node.nodeType !== Node.TEXT_NODE) return null;
        const text = node.textContent ?? '';
        const rect = (index: number): number => {
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + 1);
          return range.getBoundingClientRect().x;
        };
        return { first: rect(0), last: rect(text.length - 1), length: text.length };
      });

    expect(boxes, 'the paragraph is not a single text node, so this cannot be measured').not.toBeNull();
    expect(
      boxes?.first,
      'the first Arabic character is not to the right of the last, so the line is laid out LTR',
    ).toBeGreaterThan(boxes?.last ?? 0);
  });

  test('neutral punctuation at the end of an RTL line stays with the text', async ({ page }) => {
    // The case a missing `dir` would actually break. With base direction left-to-right -- the
    // default, and nothing in this document sets otherwise -- a trailing full stop in an otherwise
    // Arabic paragraph is a *neutral* character, and neutrals resolve against the surrounding
    // strong type. Measured rather than assumed: the full stop must sit at the visual left, with
    // the Arabic, not off at the right where an LTR base would push it.
    await mountFixture(page, fixtureFor(`${ARABIC}.`));

    const dotX = await page
      .locator('[data-oid="copy"] .p1-text-content p')
      .first()
      .evaluate((paragraph) => {
        const node = paragraph.firstChild;
        if (node === null || node.nodeType !== Node.TEXT_NODE) return null;
        const text = node.textContent ?? '';
        const range = document.createRange();
        range.setStart(node, text.length - 1);
        range.setEnd(node, text.length);
        return range.getBoundingClientRect().x;
      });

    const firstCharX = await page
      .locator('[data-oid="copy"] .p1-text-content p')
      .first()
      .evaluate((paragraph) => {
        const node = paragraph.firstChild;
        if (node === null) return null;
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, 1);
        return range.getBoundingClientRect().x;
      });

    expect(dotX, 'the trailing full stop could not be located').not.toBeNull();
    expect(
      dotX,
      'the full stop was placed to the right of the Arabic, which is what an LTR base direction does',
    ).toBeLessThan(firstCharX ?? 0);
  });


});
test.describe('bidi and shaping survive editing', () => {
  test('typing into a bidi frame leaves the existing characters in order', async ({ page }) => {
    await mountFixture(page, fixtureFor(ARABIC));

    await clickAt(page, TEXT_IDS.copy.x + 60, TEXT_IDS.copy.y + 20);
    await page.keyboard.press('Enter');
    await page.locator('[data-oid="copy"] .p1-text-content').click();
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await page.keyboard.press('Escape');
    await settle(page);

    // Logical order: the typed character is appended, and nothing before it moved.
    expect(await savedText(page)).toBe(`${ARABIC}!`);
  });

  test('a frame with no font stack falls back rather than rendering nothing', async ({ page }) => {
    // The fixture carries no `style` at all, so `font-family` is never set and the browser's
    // default applies. Asserted by the text being present at all: a fallback that produced an
    // empty box would pass every claim about *which* font was chosen and fail this one.
    await mountFixture(page, fixtureFor(ARABIC));
    const visible = await page
      .locator('[data-oid="copy"] .p1-text-content')
      .evaluate((element) => element.getClientRects().length > 0 && (element.textContent ?? '') !== '');
    expect(visible, 'the frame rendered nothing, so no fallback happened').toBe(true);
  });

  test('an unavailable font family falls back instead of losing the text', async ({ page }) => {
    // A name no machine has. The document keeps what was authored, the browser substitutes a
    // fallback face, and the glyphs still appear -- which is the whole contract for `fontFamily`.
    await mountFixture(
      page,
      fixtureFor(ARABIC).replace(
        "visible: true, locked: false, opacity: 1, blendMode: 'normal',",
        "visible: true, locked: false, opacity: 1, blendMode: 'normal', style: { fontFamily: 'No Such Font 12345' },",
      ),
    );
    expect(await renderedText(page)).toBe(ARABIC);
  });
});
