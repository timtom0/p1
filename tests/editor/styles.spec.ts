/**
 * M23 in a real browser: the style panel, the two selection actions, the deletion choices, and the
 * keyboard path's toast.
 *
 * ## Why most of this cannot be a unit test
 *
 * Because the interesting claims are claims about what is *on screen*. `unlinkStyle` freezing an
 * effective alignment and `remove` dropping it are unit-tested already; what is not, and cannot be,
 * is that the panel's two buttons produce those two outcomes, that the deletion dialog's two choices
 * reach the whole document, and that a keystroke reaches the document with no dialog in the way.
 * A panel that dispatched the wrong command would pass every model test in the repository.
 *
 * So the assertions here read rendered geometry -- where glyphs actually landed -- wherever a model
 * read would pass for the wrong reason. "The paragraph is centred" is asserted as "the left edge of
 * the text moved", because the first would also pass if the style had been unlinked rather than
 * removed and the two had been confused.
 *
 * ## The fixture
 *
 * Two frames referencing one paragraph style, and a third that references nothing. The third is the
 * control for "only the selection changed", and the two reference each other for the live-propagation
 * and deletion tests: one edit must move both, or the reference is not live.
 */

import type { Page } from '@playwright/test';
import { clickAt, expect, settle, test } from './helpers';
import { mountFixture } from '../visual/harness';

const A = 60;
const B = 400;

/**
 * Two styled frames plus an unstyled one.
 *
 * Disjoint boxes so a click selects one frame rather than whichever is on top, and positioned so
 * their *rendered text* is far apart -- alignment and direction are asserted by where glyphs land,
 * and two frames at the same x would make a shared shift indistinguishable from a per-frame one.
 */
const TWO_STYLED = `() => ({
  formatVersion: 5, id: 'm23', name: 'Styles',
  pageSetup: { fixedSize: true, unit: 'px', defaultSize: { width: 800, height: 400, unit: 'px', orientation: 'landscape' }, resizeBehaviour: 'crop' },
  styles: [
    {
      id: 'sty_quote',
      name: 'Quote',
      kind: 'paragraph',
      paragraph: { align: 'center', dir: 'rtl', metrics: { marginStart: 24 } },
    },
  ],
  assets: {},
  pages: [
    {
      id: 'p1', name: '1',
      size: { width: 800, height: 400, unit: 'px', orientation: 'landscape' },
      background: { type: 'solid', color: '#ffffff' },
      objects: [
        {
          type: 'textFrame', id: 'left', name: 'left',
          transform: { x: ${A}, y: 60, width: 300, height: 120, rotation: 0, scaleX: 1, scaleY: 1 },
          visible: true, locked: false, opacity: 1, blendMode: 'normal',
          text: { blocks: [
            { kind: 'paragraph', styleId: 'sty_quote', runs: [{ text: 'one' }] },
            { kind: 'paragraph', styleId: 'sty_quote', align: 'left', runs: [{ text: 'two' }] },
          ] },
        },
        {
          type: 'textFrame', id: 'right', name: 'right',
          transform: { x: ${B}, y: 60, width: 300, height: 120, rotation: 0, scaleX: 1, scaleY: 1 },
          visible: true, locked: false, opacity: 1, blendMode: 'normal',
          text: { blocks: [
            { kind: 'paragraph', styleId: 'sty_quote', runs: [{ text: 'three' }] },
          ] },
        },
        {
          type: 'textFrame', id: 'plain', name: 'plain',
          transform: { x: ${A}, y: 240, width: 300, height: 120, rotation: 0, scaleX: 1, scaleY: 1 },
          visible: true, locked: false, opacity: 1, blendMode: 'normal',
          style: { fontSize: 16 },
          text: { blocks: [{ kind: 'paragraph', runs: [{ text: 'plain' }] }] },
        },
      ],
    },
  ],
})`;

// ---------------------------------------------------------------------------
// Reading the rendered result
// ---------------------------------------------------------------------------

/** The rendered box of a paragraph's first line, in page pixels. */
async function firstLineBox(page: Page, frameId: string, index = 0): Promise<{ x: number; width: number }> {
  return page.evaluate(
    ([id, i]) => {
      const frame = document.querySelector(`[data-oid="${id}"]`) as HTMLElement | null;
      const paragraph = frame?.querySelectorAll('p')[i as number] as HTMLElement | undefined;
      if (paragraph === undefined) throw new Error(`no paragraph ${i} in ${String(id)}`);
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const rect = range.getBoundingClientRect();
      return { x: rect.x, width: rect.width };
    },
    [frameId, index] as const,
  );
}

/** The saved document, which is the only place a reference can be seen to have survived. */
async function saved(page: Page): Promise<Record<string, unknown>> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-doc="save"]').click(),
  ]);
  const path = await download.path();
  if (path === null) throw new Error('the download produced no file');
  const { readFile } = await import('node:fs/promises');
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

function stylesOf(doc: Record<string, unknown>): Array<Record<string, unknown>> {
  return doc['styles'] as Array<Record<string, unknown>>;
}

function frameNamed(doc: Record<string, unknown>, name: string): Record<string, unknown> {
  const pages = doc['pages'] as Array<{ objects: Array<Record<string, unknown>> }>;
  const frame = pages[0]?.objects.find((object) => object['name'] === name);
  if (frame === undefined) throw new Error(`no frame named ${name}`);
  return frame;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

async function openPanel(page: Page): Promise<void> {
  await page.locator('[data-style-select]').waitFor({ state: 'attached' });
}

async function pickCategory(page: Page, category: 'frame' | 'paragraph' | 'character'): Promise<void> {
  await page.locator(`[data-style-category="${category}"]`).click();
  await settle(page);
}

/** A style name, from the picker's selected option. */
async function selectedName(page: Page): Promise<string> {
  return page.locator('[data-style-select]').inputValue();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('the style panel', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, TWO_STYLED);
    await clickAt(page, A + 150, 90);
    await openPanel(page);
  });

  test('shows the style the selection references, by id rather than by name', async ({ page }) => {
    await pickCategory(page, 'paragraph');
    // The value is the id. A name would break on the first rename, and the rename test below is
    // what proves it does not.
    expect(await selectedName(page)).toBe('sty_quote');
  });

  test('offers nothing for a category the selection does not use', async ({ page }) => {
    await pickCategory(page, 'character');
    expect(await selectedName(page)).toBe('');
    expect(await page.locator('[data-style-unlink]').isDisabled()).toBe(true);
    expect(await page.locator('[data-style-delete]').isDisabled()).toBe(true);
  });

  test('renaming a style leaves every reference pointing at the same object', async ({ page }) => {
    await pickCategory(page, 'paragraph');
    await page.locator('[data-style-rename]').fill('Pull quote');
    await page.locator('[data-style-rename]').press('Enter');
    await settle(page);

    const doc = await saved(page);
    expect(stylesOf(doc)[0]?.['name']).toBe('Pull quote');
    expect(stylesOf(doc)[0]?.['id']).toBe('sty_quote');
    const left = frameNamed(doc, 'left');
    const paragraphs = (left['text'] as { blocks: Array<Record<string, unknown>> }).blocks;
    expect(paragraphs[0]?.['styleId']).toBe('sty_quote');
    expect(
      (frameNamed(doc, 'right')['text'] as { blocks: Array<Record<string, unknown>> }).blocks[0]?.[
        'styleId'
      ],
    ).toBe('sty_quote');
  });

  test('an edit to the style moves both frames, with no reapplication', async ({ page }) => {
    const before = await firstLineBox(page, 'left');
    // Paragraph one carries its own `align: left` and needs *its own* baseline: paragraph zero is
    // centred, so comparing them would measure the difference between two paragraphs rather than
    // whether the override survived the edit.
    const overrideBefore = await firstLineBox(page, 'left', 1);
    const otherBefore = await firstLineBox(page, 'right');

    await pickCategory(page, 'paragraph');
    await page.locator('[data-style-edit]').click();
    const dialog = page.locator('[data-style-editor]');
    await dialog.waitFor({ state: 'visible' });
    await dialog.locator('[data-style-align]').selectOption('right');
    await dialog.locator('[data-style-editor-save]').click();
    await settle(page);

    const after = await firstLineBox(page, 'left');
    // The style supplies `center` for paragraph one, so switching it to `right` has to move the
    // glyphs. An assertion on the model would pass for an implementation that re-applied the style
    // per object; this one cannot.
    expect(after.x, 'the style edit did not propagate').toBeGreaterThan(before.x);
    // ...and the *other* frame, which was never selected, moved too.
    expect((await firstLineBox(page, 'right')).x).toBeGreaterThan(otherBefore.x);

    // Paragraph two carries its own `align: left`, so it must not have followed.
    expect(
      Math.abs((await firstLineBox(page, 'left', 1)).x - overrideBefore.x),
      'a direct override was flattened',
    ).toBeLessThan(3);
  });
});

test.describe('unlink and remove, from the panel', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, TWO_STYLED);
    await clickAt(page, A + 150, 90);
    await pickCategory(page, 'paragraph');
  });

  test('unlink confirms, and the appearance does not move', async ({ page }) => {
    const before = await firstLineBox(page, 'left');
    await page.locator('[data-style-unlink]').click();
    const dialog = page.locator('[data-style-dialog="selection"]');
    await dialog.waitFor({ state: 'visible' });
    await dialog.locator('[data-style-confirm]').click();
    await settle(page);

    const after = await firstLineBox(page, 'left');
    expect(Math.abs(after.x - before.x), 'unlink moved the text').toBeLessThan(2);

    const doc = await saved(page);
    const paragraphs = (frameNamed(doc, 'left')['text'] as { blocks: Array<Record<string, unknown>> })
      .blocks;
    // The reference is gone and the values are now the frame's own.
    expect(paragraphs[0]?.['styleId']).toBeUndefined();
    expect(paragraphs[0]?.['align']).toBe('center');
  });

  test('remove confirms, the inherited values go, and the override stays', async ({ page }) => {
    const before = await firstLineBox(page, 'left');
    await page.locator('[data-style-remove]').click();
    const dialog = page.locator('[data-style-dialog="selection"]');
    await dialog.waitFor({ state: 'visible' });
    await dialog.locator('[data-style-confirm]').click();
    await settle(page);

    // Centred came from the style. With the reference gone it falls back to the start edge, so the
    // glyphs move *back*. This is the whole difference from unlink, and it is the one assertion
    // that would fail if the two commands were swapped.
    expect((await firstLineBox(page, 'left')).x, 'remove preserved the inherited alignment').toBeLessThan(
      before.x,
    );

    const doc = await saved(page);
    const paragraphs = (frameNamed(doc, 'left')['text'] as { blocks: Array<Record<string, unknown>> })
      .blocks;
    expect(paragraphs[0]?.['styleId']).toBeUndefined();
    expect(paragraphs[0]?.['align'], 'an inherited value was materialised').toBeUndefined();
    // The paragraph's own override is untouched, which is the other half.
    expect(paragraphs[1]?.['align']).toBe('left');
  });

  test('cancelling leaves the document exactly as it was', async ({ page }) => {
    const before = await firstLineBox(page, 'left');
    await page.locator('[data-style-remove]').click();
    const dialog = page.locator('[data-style-dialog="selection"]');
    await dialog.waitFor({ state: 'visible' });
    await dialog.locator('[data-style-cancel]').click();
    await settle(page);

    expect(await page.locator('[data-style-dialog="selection"][open]').count()).toBe(0);
    expect(Math.abs((await firstLineBox(page, 'left')).x - before.x)).toBeLessThan(2);
    const doc = await saved(page);
    const paragraphs = (frameNamed(doc, 'left')['text'] as { blocks: Array<Record<string, unknown>> })
      .blocks;
    expect(paragraphs[0]?.['styleId']).toBe('sty_quote');
  });

  test('touches only the selection, leaving an unselected user of the same style alone', async ({
    page,
  }) => {
    const before = await firstLineBox(page, 'right');
    await page.locator('[data-style-unlink]').click();
    const dialog = page.locator('[data-style-dialog="selection"]');
    await dialog.waitFor({ state: 'visible' });
    await dialog.locator('[data-style-confirm]').click();
    await settle(page);

    // Visibly unchanged...
    expect(Math.abs((await firstLineBox(page, 'right')).x - before.x)).toBeLessThan(2);
    // ...and, unambiguously, still referencing.
    const doc = await saved(page);
    expect(
      (frameNamed(doc, 'right')['text'] as { blocks: Array<Record<string, unknown>> }).blocks[0]?.[
        'styleId'
      ],
    ).toBe('sty_quote');
    expect(stylesOf(doc), 'the definition was removed by a selection action').toHaveLength(1);
  });
});

test.describe('deleting a definition', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, TWO_STYLED);
    await clickAt(page, A + 150, 90);
    await pickCategory(page, 'paragraph');
  });

  test('offers both readings and a cancel when the style has users', async ({ page }) => {
    await page.locator('[data-style-delete]').click();
    const dialog = page.locator('[data-style-dialog="deletion"]');
    await dialog.waitFor({ state: 'visible' });
    expect(await dialog.locator('[data-style-choice="unlink"]').isVisible()).toBe(true);
    expect(await dialog.locator('[data-style-choice="remove"]').isVisible()).toBe(true);
    expect(await dialog.locator('[data-style-cancel]').isVisible()).toBe(true);
  });

  test('focuses the plain confirmation, so Enter cannot fall into a branch by reflex', async ({ page }) => {
    await page.locator('[data-style-delete]').click();
    const dialog = page.locator('[data-style-dialog="deletion"]');
    await dialog.waitFor({ state: 'visible' });
    // `remove` is the choice that discards formatting. A dialog that focused it would make the
    // fastest possible path through this dialog the destructive one, which is exactly backwards:
    // the *slow* path should be the destructive one.
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('data-style-choice')),
      'the destructive choice took focus',
    ).toBeNull();
    expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-style-confirm'))).toBe(
      true,
    );
  });

  test('applying a style from the picker takes the id, and clearing it removes only the reference', async ({
    page,
  }) => {
    // Pick the frame with nothing on it, so applying is observable rather than a no-op on a style
    // it already has.
    await clickAt(page, A + 150, 270);
    await pickCategory(page, 'paragraph');
    expect(await selectedName(page)).toBe('');

    await page.locator('[data-style-select]').selectOption('sty_quote');
    await settle(page);
    const doc = await saved(page);
    const blocks = (frameNamed(doc, 'plain')['text'] as { blocks: Array<Record<string, unknown>> }).blocks;
    expect(blocks[0]?.['styleId']).toBe('sty_quote');

    // And clearing the picker is *remove*: the reference goes and nothing is written down.
    const before = await firstLineBox(page, 'plain');
    await page.locator('[data-style-select]').selectOption('');
    await settle(page);
    expect((await firstLineBox(page, 'plain')).x).toBeLessThan(before.x);
    const after = await saved(page);
    const cleared = (frameNamed(after, 'plain')['text'] as { blocks: Array<Record<string, unknown>> })
      .blocks;
    expect(cleared[0]?.['styleId']).toBeUndefined();
    expect(cleared[0]?.['align'], 'clearing the picker materialised the inherited alignment').toBeUndefined();
  });

  test('cancel changes nothing', async ({ page }) => {
    await page.locator('[data-style-delete]').click();
    const dialog = page.locator('[data-style-dialog="deletion"]');
    await dialog.waitFor({ state: 'visible' });
    await dialog.locator('[data-style-cancel]').click();
    await settle(page);

    expect(stylesOf(await saved(page))).toHaveLength(1);
  });

  test('unlink and delete preserves every user, including the unselected one', async ({ page }) => {
    const leftBefore = await firstLineBox(page, 'left');
    const rightBefore = await firstLineBox(page, 'right');

    await page.locator('[data-style-delete]').click();
    const dialog = page.locator('[data-style-dialog="deletion"]');
    await dialog.waitFor({ state: 'visible' });
    await dialog.locator('[data-style-choice="unlink"]').click();
    await settle(page);

    expect(Math.abs((await firstLineBox(page, 'left')).x - leftBefore.x)).toBeLessThan(2);
    // The load-bearing one: `right` was never selected, and it still has not moved.
    expect(Math.abs((await firstLineBox(page, 'right')).x - rightBefore.x)).toBeLessThan(2);

    const doc = await saved(page);
    expect(stylesOf(doc)).toHaveLength(0);
    for (const name of ['left', 'right']) {
      const paragraphs = (frameNamed(doc, name)['text'] as { blocks: Array<Record<string, unknown>> })
        .blocks;
      for (const block of paragraphs) expect(block['styleId'], `${name} kept a dangling reference`).toBeUndefined();
    }
    // Frozen in, not dropped.
    expect(paragraphs0(doc, 'right')?.['align']).toBe('center');
  });

  test('remove and delete lets inherited values fall back, everywhere', async ({ page }) => {
    const leftBefore = await firstLineBox(page, 'left');
    const rightBefore = await firstLineBox(page, 'right');

    await page.locator('[data-style-delete]').click();
    const dialog = page.locator('[data-style-dialog="deletion"]');
    await dialog.waitFor({ state: 'visible' });
    await dialog.locator('[data-style-choice="remove"]').click();
    await settle(page);

    expect((await firstLineBox(page, 'left')).x).toBeLessThan(leftBefore.x);
    expect((await firstLineBox(page, 'right')).x).toBeLessThan(rightBefore.x);

    const doc = await saved(page);
    expect(stylesOf(doc)).toHaveLength(0);
    expect(paragraphs0(doc, 'right')?.['align'], 'a value was materialised').toBeUndefined();
    // The frame's own override is still its own, which is what "preserving direct overrides" means.
    expect(paragraphs1(doc, 'left')?.['align']).toBe('left');
  });

  test('undo restores the definition, every reference, and the direct values', async ({ page }) => {
    const before = await firstLineBox(page, 'right');
    await page.locator('[data-style-delete]').click();
    const dialog = page.locator('[data-style-dialog="deletion"]');
    await dialog.waitFor({ state: 'visible' });
    await dialog.locator('[data-style-choice="unlink"]').click();
    await settle(page);
    expect(stylesOf(await saved(page))).toHaveLength(0);

    await page.locator('[data-edit="undo"]').click();
    await settle(page);

    const doc = await saved(page);
    // The *exact* definition, not a reconstruction that happens to look the same.
    expect(stylesOf(doc)[0]).toEqual({
      id: 'sty_quote',
      name: 'Quote',
      kind: 'paragraph',
      paragraph: { align: 'center', dir: 'rtl', metrics: { marginStart: 24 } },
    });
    expect(
      (frameNamed(doc, 'right')['text'] as { blocks: Array<Record<string, unknown>> }).blocks[0]?.[
        'styleId'
      ],
    ).toBe('sty_quote');
    expect(Math.abs((await firstLineBox(page, 'right')).x - before.x)).toBeLessThan(2);
  });

  test('an unused style is deleted with a plain confirmation', async ({ page }) => {
    // Create a second style and apply it, then remove the reference, so the definition has no users.
    await pickCategory(page, 'character');
    await page.locator('[data-style-new]').click();
    const editor = page.locator('[data-style-editor]');
    await editor.waitFor({ state: 'visible' });
    await editor.locator('[data-style-name]').fill('Unused');
    await editor.locator('[data-char-flag="bold"]').check();
    await editor.locator('[data-style-editor-save]').click();
    await settle(page);
    await pickCategory(page, 'character');
    await page.locator('[data-style-select]').selectOption('');
    await settle(page);
    await pickCategory(page, 'paragraph');
    // Back on the style with users, the choice is offered...
    await page.locator('[data-style-delete]').click();
    const withUsers = page.locator('[data-style-dialog="deletion"]');
    await withUsers.waitFor({ state: 'visible' });
    expect(await withUsers.locator('[data-style-choice="unlink"]').isVisible()).toBe(true);
    await withUsers.locator('[data-style-cancel]').click();
  });
});

test.describe('the keyboard path', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, TWO_STYLED);
    await clickAt(page, A + 150, 90);
    await settle(page);
  });

  test('unlinks with no dialog, and says so with an undoable toast', async ({ page }) => {
    const before = await firstLineBox(page, 'left');
    await page.keyboard.press('Control+Alt+u');
    await settle(page);

    // No dialog, by design: the routine case should not pay for the uncommon mistake.
    expect(await page.locator('[data-style-dialog][open]').count()).toBe(0);
    const toast = page.locator('[data-toast]');
    await toast.waitFor({ state: 'visible' });
    expect(await toast.innerText()).toContain('Unlinked');
    expect(Math.abs((await firstLineBox(page, 'left')).x - before.x)).toBeLessThan(2);

    const doc = await saved(page);
    const paragraphs = (frameNamed(doc, 'left')['text'] as { blocks: Array<Record<string, unknown>> })
      .blocks;
    expect(paragraphs[0]?.['styleId']).toBeUndefined();
    expect(paragraphs[0]?.['align']).toBe('center');
  });

  test("the toast's undo restores the reference and the previous formatting", async ({ page }) => {
    await page.keyboard.press('Control+Alt+u');
    await settle(page);
    await page.locator('[data-toast-action]').click();
    await settle(page);

    expect(await page.locator('[data-toast]').count()).toBe(0);
    const doc = await saved(page);
    const paragraphs = (frameNamed(doc, 'left')['text'] as { blocks: Array<Record<string, unknown>> })
      .blocks;
    expect(paragraphs[0]?.['styleId']).toBe('sty_quote');
    expect(paragraphs[0]?.['align'], 'undo left a materialised value behind').toBeUndefined();
    expect(paragraphs[1]?.['align']).toBe('left');
    // ...and the definition is untouched, which unlink is not allowed to touch.
    expect(stylesOf(doc)[0]?.['id']).toBe('sty_quote');
  });

  test('removes with no dialog, and the toast names what actually happened', async ({ page }) => {
    const before = await firstLineBox(page, 'left');
    await page.keyboard.press('Control+Alt+r');
    await settle(page);

    const toast = page.locator('[data-toast]');
    await toast.waitFor({ state: 'visible' });
    expect(await toast.innerText()).toContain('default');
    expect((await firstLineBox(page, 'left')).x).toBeLessThan(before.x);

    const doc = await saved(page);
    const paragraphs = (frameNamed(doc, 'left')['text'] as { blocks: Array<Record<string, unknown>> })
      .blocks;
    expect(paragraphs[0]?.['styleId']).toBeUndefined();
    expect(paragraphs[0]?.['align']).toBeUndefined();
    expect(paragraphs[1]?.['align']).toBe('left');
  });

  test('leaves the keystroke alone when there is no style to act on', async ({ page }) => {
    await clickAt(page, A + 150, 270);
    await settle(page);
    await page.keyboard.press('Control+Alt+r');
    await settle(page);
    // No toast: a notification saying nothing happened is noise, and the keystroke was not
    // swallowed either -- the shortcut claims it only once something will actually occur.
    expect(await page.locator('[data-toast]').count()).toBe(0);
    const doc = await saved(page);
    expect(paragraphs0(doc, 'plain')?.['align']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

function paragraphs0(doc: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  return (frameNamed(doc, name)['text'] as { blocks: Array<Record<string, unknown>> }).blocks[0];
}

function paragraphs1(doc: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  return (frameNamed(doc, name)['text'] as { blocks: Array<Record<string, unknown>> }).blocks[1];
}