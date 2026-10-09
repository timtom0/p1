/**
 * M13: the pointerdown `preventDefault()` contract.
 *
 * ## Why this file exists
 *
 * The mutation corpus carried an entry for "the browser may start its own selection during an editor
 * gesture". For most of a milestone it **survived**, and the reason is a gap in the suite rather than
 * in the code: every other selection test drags across *shapes*, and a shape has no text in the DOM
 * for the browser to select. Nothing could observe the browser's native selection, because nothing
 * was there to select. A drag over an empty box starts no selection whether or not the default is
 * prevented, so the contract was untestable as written.
 *
 * This file makes it observable by putting **real text** under the pointer.
 *
 * ## The contract, and why it is load-bearing
 *
 * `src/ui/app.ts` documents it at the pointerdown listener: without `preventDefault()`, when a press
 * also begins a native selection, Chromium answers by firing `pointercancel` and then delivering **no
 * further events for that pointer**. The gesture cannot continue and cannot finish — the objects stop
 * a third of the way across and the editor is stuck mid-drag.
 *
 * So there are two assertions, and they are not the same one:
 *
 * 1. **No native selection is created.** The direct observation of the browser's behaviour, and the
 *    one that names what the contract is *for*.
 * 2. **The drag completes.** The consequence the comment describes. Worth its own assertion because a
 *    fix that suppressed the selection some other way would pass (1) and still strand the gesture —
 *    and because `pointercancel` is the specific symptom, so this fails for the documented reason
 *    rather than for an incidental one.
 *
 * ## The carve-out is tested too
 *
 * `preventDefault` is deliberately **skipped inside a text session**, where the browser's default is
 * precisely what places the caret. Testing only the suppressed case would leave the carve-out
 * unverified, and "always prevent" is the mutation that a suppression-only test cannot see.
 */

import type { Page } from '@playwright/test';
import {
  clickAt,
  drag,
  dragWithoutSnapping,
  expect,
  frameIsEditing,
  selectionIds,
  test,
} from './helpers';
import { mountFixture } from '../visual/harness';

/**
 * One text frame with enough prose to be selected across, plus a shape to drag.
 *
 * `plain` is the frame a native selection would swallow; `tile` is a shape, so a drag that starts on
 * it and crosses `plain` is a gesture with real text underneath it.
 */
const FIXTURE = `() => ({
  formatVersion: 1, id: 'f', name: 'F',
  pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [
      {
        type: 'shape', id: 'tile', name: 'tile',
        transform: { x: 20, y: 20, width: 90, height: 60, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#c8d8f0' },
      },
      {
        id: 'copy', type: 'textFrame', name: 'copy',
        transform: { x: 40, y: 120, width: 360, height: 120, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        style: {
          fontFamily: 'Georgia, serif', fontSize: 18, lineHeight: 1.4,
          letterSpacing: 0.005, color: '#1a1a1a',
        },
        text: { blocks: [
          { kind: 'paragraph', runs: [{ text: 'selectable prose that spans the drag' }] },
          { kind: 'paragraph', runs: [{ text: 'a second line of ordinary document text' }] },
        ] },
      },
    ],
  }],
})`;

/** What the browser's own selection holds, read straight off the document. */
interface NativeSelection {
  text: string;
  ranges: number;
}

async function nativeSelection(page: Page): Promise<NativeSelection> {
  return page.evaluate(() => {
    const selection = window.getSelection();
    if (selection === null) return { text: '', ranges: 0 };
    return { text: selection.toString(), ranges: selection.rangeCount };
  });
}

test.describe('pointerdown suppresses the browser native selection', () => {
  test('a drag across real text creates no native selection', async ({ page }) => {
    await mountFixture(page, FIXTURE);

    // Start on the shape, cross the text frame, and release well past it. Real pointer input, because
    // a synthesised event would take the listener's `preventDefault` branch without the browser ever
    // acting on it -- and it is the browser's *reaction* that is under test.
    await drag(page, { x: 60, y: 50 }, { x: 380, y: 200 });

    const selection = await nativeSelection(page);
    expect(selection.ranges, 'the browser started a selection of the page text').toBe(0);
    expect(selection.text, 'the browser selected document text during an editor gesture').toBe('');
  });

  test('and the gesture still completes rather than being cancelled part way', async ({ page }) => {
    await mountFixture(page, FIXTURE);
    await clickAt(page, 60, 50);
    expect(await selectionIds(page)).toEqual(['tile']);

    // Start and end clear of any text, so this one is only about the gesture surviving.
    await dragWithoutSnapping(page, { x: 60, y: 50 }, { x: 220, y: 60 });

    // The dragged shape must sit where it was dropped. The documented failure leaves it a fraction of
    // the way there -- `pointercancel` arrives and no further pointermove is delivered.
    const left = await page.evaluate(() => {
      const element = document.querySelector('[data-oid="tile"]') as HTMLElement | null;
      return element === null ? null : parseFloat(element.style.left);
    });
    // `drag` was 160 document px in x; `left` is the box's left edge, 20px at rest, so ~180 expected.
    expect(left, 'the shape did not travel the whole way -- the drag was cancelled').toBeCloseTo(180, 0);
  });

  test('a click on empty page leaves no selection either', async ({ page }) => {
    await mountFixture(page, FIXTURE);
    await clickAt(page, 420, 270);
    expect((await nativeSelection(page)).ranges).toBe(0);
  });

  test('inside a text session the default is left alone, so a click places a caret', async ({
    page,
  }) => {
    // The carve-out. Without it, editing text is impossible -- a click cannot position the caret --
    // and this is the mutation a suppression-only test cannot detect.
    await mountFixture(page, FIXTURE);
    await clickAt(page, 120, 145);
    await page.keyboard.press('Enter');
    expect(await frameIsEditing(page, 'copy'), 'the frame should be in a text session').toBe(true);

    // Clicking *inside* the frame leaves the browser's default alone. A **double**-click is the
    // observable, not a single one: a single click only collapses a caret (`rangeCount` is 1 but
    // `toString()` is empty), which proves nothing about whether the default ran. A double-click
    // selects a word, and that selection is the browser's own behaviour.
    //
    // With `preventDefault()` applied unconditionally -- "always prevent" -- the word would never be
    // selected, and the editor would be uneditable by double-click. That is the mutation this
    // assertion exists to catch.
    //
    // Targeted at the element rather than at coordinates: `page.mouse` takes **client** pixels while
    // `clickAt`/`drag` take **document** pixels, and passing a document point to `dblclick` silently
    // clicked empty page. This is the third time that trap has cost a test in this repo.
    await page.locator('[data-objects] [data-oid="copy"] .p1-text-content').dblclick();
    const inSession = await nativeSelection(page);
    expect(
      inSession.text.length,
      'a double-click inside a live text session selected no word',
    ).toBeGreaterThan(0);
  });
});