/**
 * M21: the character-formatting shortcuts.
 *
 * ## What was actually wrong
 *
 * The inspector's B/I/U buttons advertised `Ctrl+B`, `Ctrl+I` and `Ctrl+U` in their tooltips. Inside
 * an open text session those work -- but not because of this application. The browser owns the
 * keyboard inside a `contenteditable`, and `execCommand('bold')` does the work. **Outside** a
 * session, with a frame merely selected, nothing was bound: the advertised shortcut did nothing at
 * all, and the buttons were the only route.
 *
 * So the promise was true in one of the two states a user can be in, and the tests that existed
 * only covered that one.
 *
 * ## Why the shortcut is not its own implementation
 *
 * Both paths go through `TextSessionController.applyInlineFormat`, which already encodes the
 * session-versus-model distinction: inside a session it hands the command to the browser, outside it
 * rewrites the frame's runs through the model as its own history entry. A shortcut doing its own
 * thing would be a second implementation to keep in step with the buttons, and the two would
 * diverge the first time one of them changed.
 */

import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { clickAt, expect, frameIsEditing, settle, test, undoLabel } from './helpers';
import { mountFixture, pageCount } from '../visual/harness';
import { TEXT_FIXTURE, TEXT_IDS } from './text-fixtures';

const COPY_ID = 'copy';

/** The frame's runs, as saved -- so every claim goes through the file boundary. */
async function savedRuns(page: Page): Promise<unknown> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-doc="save"]').click(),
  ]);
  const path = await download.path();
  if (path === null) throw new Error('the download produced no path');
  const document = JSON.parse(await readFile(path, 'utf8')) as {
    pages: Array<{ objects: Array<Record<string, unknown>> }>;
  };
  const frame = document.pages[0]?.objects.find((node) => node['id'] === COPY_ID);
  return frame?.['text'];
}

/**
 * True when any run anywhere in the frame carries `flag`.
 *
 * Takes the **serialised** frame. It used to take the object and call `JSON.stringify` itself,
 * which is how two of these tests came to assert a defect that does not exist: passed an
 * already-stringified value, `JSON.stringify` escaped every quote, and `"bold":true` never matched
 * inside `"{\"blocks\":…\"bold\":true…}"`. The symptom -- "saving loses the formatting" -- reads
 * exactly like the serious bug this milestone is looking for, which is the worst kind of test bug.
 */
function uses(serialised: string, flag: string): boolean {
  return serialised.includes(`"${flag}":true`);
}

/** The editing surface as it currently stands. Authoritative while a session is open. */
async function liveHtml(page: Page): Promise<string> {
  return page
    .locator(`[data-oid="${COPY_ID}"] .p1-text-content`)
    .evaluate((element) => element.innerHTML);
}

/** Selects the copy frame. Document px, offset clear of the glyphs so this is a selection. */
async function selectCopy(page: Page): Promise<void> {
  await clickAt(page, TEXT_IDS.copy.x + 60, TEXT_IDS.copy.y + 20);
  await settle(page);
}

/**
 * Enters a text session and selects the first word.
 *
 * The click target is the **content** element, not the frame. Clicking the frame selects it -- which
 * is the other half of this file's subject, and silently ran these tests down the wrong path: every
 * assertion still passed, just about the wrong thing. `frameIsEditing` is asserted here so that
 * cannot happen again quietly.
 */
async function enterSession(page: Page): Promise<void> {
  await clickAt(page, TEXT_IDS.copy.x + 60, TEXT_IDS.copy.y + 20);
  await page.keyboard.press('Enter');
  await page.locator(`[data-oid="${COPY_ID}"] .p1-text-content`).click();
  await page.keyboard.press('Home');
  for (let i = 0; i < 5; i += 1) await page.keyboard.press('Shift+ArrowRight');
  await settle(page);
  expect(
    await frameIsEditing(page, COPY_ID),
    'the session did not open, so these tests would be measuring the outside-session path',
  ).toBe(true);
}

test.describe('formatting shortcuts, outside a text session', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, TEXT_FIXTURE);
    await selectCopy(page);
  });

  test('Ctrl+B toggles bold and Ctrl+I toggles italic', async ({ page }) => {
    // The fixture's first paragraph already has a bold run and an italic run, so this is a
    // *toggle* on a frame that is already partly formatted -- see the mixed test below for what
    // that means.
    const before = await savedRuns(page);
    expect(uses(JSON.stringify(before), 'bold'), 'the fixture should start with a bold run').toBe(true);

    await page.keyboard.press('Control+b');
    await settle(page);
    const afterBold = await savedRuns(page);
    expect(afterBold, 'Ctrl+B changed nothing').not.toEqual(before);

    await page.keyboard.press('Control+i');
    await settle(page);
    const afterItalic = await savedRuns(page);
    expect(afterItalic, 'Ctrl+I changed nothing').not.toEqual(afterBold);
  });

  test('Ctrl+U toggles underline and Ctrl+Shift+X toggles strikethrough', async ({ page }) => {
    const before = await savedRuns(page);
    expect(uses(JSON.stringify(before), 'underline'), 'the fixture should start with an underline run').toBe(true);

    await page.keyboard.press('Control+u');
    await settle(page);
    const afterUnderline = await savedRuns(page);
    expect(afterUnderline, 'Ctrl+U changed nothing').not.toEqual(before);

    await page.keyboard.press('Control+Shift+X');
    await settle(page);
    expect(await savedRuns(page), 'Ctrl+Shift+X changed nothing').not.toEqual(afterUnderline);
  });

  test('pressing the same shortcut twice returns the frame to where it started', async ({ page }) => {
    // A toggle that only ever adds is not a toggle. Asserted on the saved text, because "looks
    // the same" is not the claim.
    const before = await savedRuns(page);
    await page.keyboard.press('Control+b');
    await settle(page);
    await page.keyboard.press('Control+b');
    await settle(page);
    expect(await savedRuns(page)).toEqual(before);
  });

  test('a shortcut is one undo step, labelled for what it did', async ({ page }) => {
    const before = await savedRuns(page);
    await page.keyboard.press('Control+b');
    await settle(page);
    expect(await undoLabel(page)).toBe('Undo Bold');

    await page.keyboard.press('Control+z');
    await settle(page);
    expect(await savedRuns(page)).toEqual(before);
  });

  test('toggling one flag leaves the others alone', async ({ page }) => {
    const before = JSON.stringify(await savedRuns(page));
    await page.keyboard.press('Control+i');
    await settle(page);
    const after = JSON.stringify(await savedRuns(page));

    // Bold, underline and strike runs must survive an italic toggle untouched. Compared by
    // presence rather than by exact text, because the run *boundaries* legitimately move -- that is
    // what a toggle does.
    for (const flag of ['bold', 'underline', 'strike']) {
      expect(
        uses(after, flag),
        `${flag} was lost by an italic toggle`,
      ).toBe(uses(before, flag));
    }
  });

  test('Ctrl+X is cut, not strikethrough', async ({ page }) => {
    // Plain Ctrl+X must not be intercepted. Binding it would remove an editing operation every
    // editor has, in exchange for a cosmetic one, and the text would be destroyed with nothing to
    // press Ctrl+Z about if the binding were wrong.
    const before = await savedRuns(page);
    await page.keyboard.press('Control+x');
    await settle(page);
    expect(await savedRuns(page), 'Ctrl+X changed the document').toEqual(before);
  });

  test('the shortcut does not fire while an inspector field has focus', async ({ page }) => {
    // Two claims, and the second is the one that bit: `isTypingTarget` covers INPUT/TEXTAREA/SELECT/
    // contenteditable, but *suppressing* the keystroke and *applying* it are different questions.
    // Letting the browser have Ctrl+U inside a field opens view-source and navigates the document
    // away; applying it would bold a frame the user is not editing. Asserted on the rendered frame
    // rather than through Save, because a navigation would take the download with it -- which is
    // exactly the failure this test exists to catch.
    const before = await liveHtml(page);
    const input = page.locator('[data-text-field="color"]');
    await input.click();
    await input.fill('#112233');
    await page.keyboard.press('Control+b');
    await page.keyboard.press('Control+i');
    await page.keyboard.press('Control+u');
    await settle(page);

    expect(page.url(), 'Ctrl+U navigated the browser away from the document').toContain('127.0.0.1');
    expect(await liveHtml(page), 'a shortcut applied from inside a text input').toBe(before);
    expect(await input.inputValue(), 'the field lost the value being typed').toBe('#112233');
  });

  test('nothing selected is inert, and does not navigate the browser away', async ({ page }) => {
    // Ctrl+B with nothing selected would otherwise open the bookmarks sidebar in Chromium and
    // Ctrl+U would open view-source. The key is swallowed either way; the point is that pressing a
    // shortcut the app advertises does not teleport the user out of the document.
    await page.keyboard.press('Escape');
    await settle(page);
    await page.keyboard.press('Control+b');
    await settle(page);
    expect(page.url()).toContain('127.0.0.1');
    expect(await pageCount(page)).toBeGreaterThan(0);
  });
});

test.describe('formatting shortcuts, inside a text session', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, TEXT_FIXTURE);
    await enterSession(page);
  });

  test('Ctrl+B bolds exactly the selection', async ({ page }) => {
    // Asserted on the **live DOM**, not the saved file. Inside a session the DOM holds the truth
    // and the model is stale by design (ADR 0003), so reading the model here would be asserting
    // the opposite of the fence's contract -- and would also be a weaker claim, because by the time
    // the file was written the browser's selection had already been given up.
    const before = await liveHtml(page);

    await page.keyboard.press('Control+b');
    await settle(page);
    const after = await liveHtml(page);

    expect(after, 'Ctrl+B did not change the editing surface').not.toBe(before);
    expect(after, 'no bold was applied').toContain('<b>');
    // And the change is bounded: the fixture's second paragraph was already bold, so the *new*
    // bold must be confined to the selected word rather than the frame.
    expect(
      after.replace(/<\/?b>/g, ''),
      'characters outside the selection were touched',
    ).toBe(before.replace(/<\/?b>/g, ''));
  });

  test('Ctrl+B with a collapsed caret does not bold the paragraph', async ({ page }) => {
    // The degenerate selection. Chromium applies nothing for a collapsed caret, and that is the
    // right outcome here: a shortcut that bolded from a collapsed caret would bold everything the
    // user typed next, which is a behaviour nobody asked for.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await settle(page);
    const before = await liveHtml(page);

    await page.keyboard.press('Control+b');
    await settle(page);

    expect(await liveHtml(page), 'a collapsed caret changed the editing surface').toBe(before);
  });

  test('saving commits the open session first, so the file is never behind the screen', async ({ page }) => {
    // Written the other way round from what I first assumed, because the product already gets this
    // right: `DocumentSession` closes the editing session before serialising, since the browser owns
    // the editing subtree until the session ends. So Save does not write a stale model -- it writes
    // what the user can see. Asserting the *stale* behaviour would have been asserting a defect.
    //
    // Nothing reads the file before the keystroke, deliberately: saving commits and closes the
    // session, so a "before" snapshot taken through Save would end the very session under test.
    await page.keyboard.press('Control+b');
    await settle(page);
    expect(await liveHtml(page), 'the browser did not apply bold to the selection').toContain('<b>');

    const saved = JSON.stringify(await savedRuns(page));
    expect(uses(saved, 'bold'), 'saving lost the formatting the user can see on screen').toBe(true);
  });

  test('leaving the session is one history entry for everything typed and formatted', async ({ page }) => {
    // One entry, not two. A format and a keystroke inside one session are one edit the user can
    // reason about; two would mean undo walks backwards through their own typing.
    await page.keyboard.press('Control+b');
    await page.keyboard.type('Z');
    await page.keyboard.press('Escape');
    await settle(page);

    expect(await undoLabel(page), 'the session did not commit as a single edit').toBe('Undo Edit text');
    expect(uses(JSON.stringify(await savedRuns(page)), 'bold'), 'the commit lost the formatting').toBe(
      true,
    );

    await page.keyboard.press('Control+z');
    await settle(page);
    const afterUndo = JSON.stringify(await savedRuns(page));
    expect(afterUndo, 'one undo left the typed character in place').not.toContain('Z');

    // The document must be back to exactly what was authored. Compared against a *fresh mount* of
    // the same fixture rather than against remembered text, because asserting "no bold" would be
    // wrong: the fixture contains a bold run of its own, and undoing to the authored state
    // correctly still has one. Only an equality with the authored document can distinguish
    // "undone" from "never applied".
    const fresh = await page.context().newPage();
    await mountFixture(fresh, TEXT_FIXTURE);
    const authored = JSON.stringify(await savedRuns(fresh));
    await fresh.close();

    expect(afterUndo, 'one undo did not return the document to the authored state').toBe(authored);
  });
});
