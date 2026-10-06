/**
 * The persistence boundary, from the editor's side.
 *
 * M9 §7 asks for every piece of state to be classified as authored, derived, or editor-only, and
 * §9 for the seams where those classifications are most likely to be quietly wrong. This file is
 * the browser half of that: it drives real workflows and asserts that nothing crosses the line.
 *
 * ## The classification, asserted rather than described
 *
 * | State | Class | Why it is safe, and what would break it |
 * |---|---|---|
 * | `Page.objects` order | **authored** | paint order *is* the array order, so it is in the file |
 * | `transform`, `visible`, `locked`, `opacity`, `blendMode` | **authored** | read from the model, never from the DOM |
 * | `text` | **authored** | canonical in the model; the DOM is authoritative only *during* a session |
 * | intrinsic image size | **authored** | asset metadata recorded once at import (ADR 0006) |
 * | `data-asset-state` | **derived** | rendering output, published on the element, never read back |
 * | element `style` | **derived** | a projection; saving reads the model |
 * | `selection` (`ids`, `primary`, `hover`) | **editor-only** | no field in the format |
 * | the drag preview rect | **derived** | overlay geometry, committed on release |
 * | pointer capture, gesture, `moved` | **editor-only** | never leaves the editor |
 * | measured text size | **derived** | a status union, refused when stale (ADR 0004) |
 * | caret, selection, IME state | **browser** | owned by the browser inside a session |
 *
 * The dangerous direction is **authored state that only exists in the DOM**, because it looks
 * fine in the editor and vanishes on reload. So the tests below are built around that shape:
 * do something, save, reload in a *fresh browser context*, and ask whether it survived when it
 * should not have — or, for the two that must survive, whether it did.
 */

import { readFile } from 'node:fs/promises';
import type { Browser, Page } from '@playwright/test';
import {
  clickAt,
  drag,
  expect,
  selectionCount,
  selectionIds,
  test,
  undoDisabled,
} from './helpers';
import { mountFixture, mountSample } from '../visual/harness';
import { assetRecord, documentWithImages, imageNode } from './image-fixtures';

// ---------------------------------------------------------------------------
// Reading things
// ---------------------------------------------------------------------------

async function documentBytes(page: Page): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-doc="save"]').click(),
  ]);
  const path = await download.path();
  if (path === null) throw new Error('the download produced no file');
  return readFile(path, 'utf8');
}

function order(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-page] [data-oid]')].map(
      (el) => (el as HTMLElement).dataset['oid'] ?? '',
    ),
  );
}

/** Whether the document-chrome indicator reports unsaved work. */
function dirty(page: Page): Promise<boolean> {
  return page
    .locator('[data-doc-state]')
    .evaluate((el) => (el as HTMLElement).dataset['dirty'] === 'true');
}

/**
 * Reopens bytes in a **new browser context**.
 *
 * A context, not a reload: `addInitScript` is context-level, so a reload would still be running
 * under the rendering fixture and the test would prove nothing about a clean boot. This is M7's
 * rule and it is the reason the round trip is a real boundary.
 */
async function reopenIn(
  browser: Browser,
  bytes: string,
  name = 'seam.p1doc',
): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await mountSample(page);
  await page.locator('[data-file-input="document"]').setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(bytes, 'utf8'),
  });
  await page.waitForFunction(
    (wanted) => document.querySelector('[data-stat="name"]')?.textContent === wanted,
    name,
  );
  return page;
}

// ---------------------------------------------------------------------------
// Authored state survives; editor state does not
// ---------------------------------------------------------------------------

test.describe('what crosses the file boundary', () => {
  test('authored state survives a save and a clean reopen', async ({ browser }) => {
    const first = await browser.newContext();
    const page = await first.newPage();
    await mountFixture(page, SEAM_FIXTURE);

    // Authored changes of three different kinds: geometry, order, and a property.
    await clickAt(page, 80, 80);
    await drag(page, { x: 80, y: 80 }, { x: 140, y: 110 });
    await page.locator('[data-layer="front"]').click();
    await page.locator('[data-object-field="opacity"]').fill('0.4');
    await page.locator('[data-object-field="opacity"]').blur();

    const bytes = await documentBytes(page);
    const before = await order(page);

    const reopened = await reopenIn(browser, bytes);
    expect(await order(reopened), 'paint order is authored, so it is in the file').toEqual(before);
    expect(
      await reopened
        .locator('[data-page] [data-oid="node_a"]')
        .evaluate((el) => (el as HTMLElement).style.opacity),
      'and so is the property',
    ).toBe('0.4');
    // A freshly opened document is clean, whatever the previous session was doing.
    expect(await dirty(reopened), 'an opened document is not dirty').toBe(false);
    await reopened.context().close();
    await first.close();
  });

  test('the selection does not survive, and neither does the hover', async ({ browser }) => {
    const first = await browser.newContext();
    const page = await first.newPage();
    await mountFixture(page, SEAM_FIXTURE);

    await clickAt(page, 80, 80);
    await page.locator('[data-layer="front"]').click();
    // Leave a hover outline behind too, so both editor-only fields are set. A raw mouse event
    // takes *client* coordinates, which is a different space from everything else in this file.
    const over = await clientOf(page, { x: 280, y: 90 });
    await page.mouse.move(over.x, over.y);
    expect(await selectionIds(page)).toHaveLength(1);
    expect(await page.locator('.p1-overlay-group--hover').count()).toBe(1);

    const bytes = await documentBytes(page);
    const reopened = await reopenIn(browser, bytes);

    // Neither the selection nor the hover is in the format, and neither is in the document.
    expect(await selectionIds(reopened), 'selection is editor-only').toHaveLength(0);
    expect(
      await reopened.locator('.p1-overlay-group--hover').count(),
      'a reopened document has no hover at all',
    ).toBe(0);
    // Nor is anything about the pointer or the gesture. Naming the fields is the assertion that
    // would notice one being added to the format, which is the failure this classification exists
    // to prevent.
    for (const field of ['ids', 'primary', 'hover', 'anchor', 'gesture', 'moved']) {
      expect(bytes, 'no ' + field + ' in the format').not.toContain('"' + field + '"');
    }
    await reopened.context().close();
    await first.close();
  });

  test('a cancelled gesture leaves no trace in the file', async ({ browser }) => {
    const first = await browser.newContext();
    const page = await first.newPage();
    await mountFixture(page, SEAM_FIXTURE);
    const before = await documentBytes(page);

    // A long drag, cancelled after it has already moved a long way. The document returns to
    // exactly where it was, so the file has nothing to carry and the history nothing to hold.
    // Cancelling a gesture that has *finished* would prove nothing, which is what the first
    // version of this test did.
    await clickAt(page, 80, 80);
    const start = await clientOf(page, { x: 80, y: 80 });
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 200, start.y + 40, { steps: 6 });
    await page.keyboard.press('Escape');
    await page.mouse.up();

    expect(await documentBytes(page), 'the file is byte-identical').toBe(before);
    expect(await undoDisabled(page), 'and nothing was recorded').toBe(true);
    expect(await dirty(page), 'and the document is still clean').toBe(false);
    await first.close();
  });
});

// ---------------------------------------------------------------------------
// Dirty state against a real save
// ---------------------------------------------------------------------------

test.describe('dirty state is authored state, against a real save', () => {
  test('save, mutate, undo reports clean', async ({ browser }) => {
    // The claim M7's `documentsEqual` exists for, driven through the whole loop rather than at
    // the model boundary. A flag that forgot to clear would leave a clean document looking
    // dirty; a flag set by the wrong thing would leave a dirty one looking clean.
    const first = await browser.newContext();
    const page = await first.newPage();
    await mountFixture(page, SEAM_FIXTURE);
    expect(await dirty(page), 'a freshly mounted document is clean').toBe(false);

    // Save *first*, so the baseline is the state the undo will return to. The first version of
    // this test saved after the move, which made "undo" land before the baseline and the
    // expectation wrong rather than the code.
    await documentBytes(page);
    expect(await dirty(page), 'a saved document is clean').toBe(false);

    await clickAt(page, 80, 80);
    await drag(page, { x: 80, y: 80 }, { x: 140, y: 110 });
    expect(await dirty(page), 'the move made it dirty').toBe(true);

    await page.locator('[data-edit="undo"]').click();
    expect(await dirty(page), 'undoing back to the saved state is clean again').toBe(false);
    expect(await undoDisabled(page)).toBe(true);

    // And a save with nothing changed is still a no-op for the flag, not a re-dirtying.
    await documentBytes(page);
    expect(await dirty(page)).toBe(false);

    // And forwards again, which is the branch a stored flag usually gets wrong.
    await page.locator('[data-edit="redo"]').click();
    expect(await dirty(page), 'redo past the saved state is dirty').toBe(true);
    await first.close();
  });

  test('a multi-object command is dirty as one step and clean as one step', async ({ page }) => {
    // Three objects, one command, one undo. A dirty flag that counted commands rather than
    // comparing documents would still pass this — so the negative half matters: after the undo
    // there must be *nothing* left to save.
    await mountFixture(page, SEAM_FIXTURE);
    await clickAt(page, 80, 80);
    await clickAt(page, 240, 80, ['Shift']);
    expect((await selectionIds(page)).length).toBe(2);

    // Two of three, not all three: with the whole stack selected every layer operation is a
    // no-op by M8's rule, so the first version of this test asserted "not dirty" for a reason
    // that had nothing to do with multi-object commands.
    const before = await order(page);
    await page.locator('[data-layer="front"]').click();
    expect(await order(page), 'the restack really did something').not.toEqual(before);
    expect(await dirty(page)).toBe(true);

    // One undo, and clean. No save in the middle: the baseline is the document the gesture
    // started from, which is what a single undo returns to. Saving after the restack and then
    // undoing would land *before* the baseline, and "dirty" would be the correct answer.
    await page.locator('[data-edit="undo"]').click();
    expect(await dirty(page), 'one undo covered both objects').toBe(false);
    expect(await undoDisabled(page)).toBe(true);
  });

  test('selecting, hovering and zooming are not dirty', async ({ page }) => {
    // The three things most likely to be mistaken for edits, and the reason dirty state is a
    // derived read rather than a flag.
    await mountFixture(page, SEAM_FIXTURE);
    await clickAt(page, 80, 80);
    await page.mouse.move(240, 210);
    await page.locator('[data-zoom="actual"]').click();
    await page.keyboard.press('Control+a');
    expect(await dirty(page), 'none of that is an authored change').toBe(false);
  });

  test('a cancelled gesture leaves the dirty flag alone', async ({ page }) => {
    await mountFixture(page, SEAM_FIXTURE);
    await clickAt(page, 80, 80);
    await drag(page, { x: 80, y: 80 }, { x: 140, y: 110 });
    await documentBytes(page);
    expect(await dirty(page)).toBe(false);

    await clickAt(page, 80, 80);
    await drag(page, { x: 80, y: 80 }, { x: 200, y: 150 });
    await page.keyboard.press('Escape');
    expect(await dirty(page), 'a cancelled drag is not a change').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Undo and redo around multi-object commands
// ---------------------------------------------------------------------------

test.describe('undo and redo around multi-object commands', () => {
  test('a multi-object move round-trips through undo and redo', async ({ page }) => {
    await mountFixture(page, SEAM_FIXTURE);
    await clickAt(page, 80, 80);
    await clickAt(page, 240, 80, ['Shift']);
    const before = await geometry(page);

    await drag(page, { x: 80, y: 80 }, { x: 160, y: 120 });
    const moved = await geometry(page);
    expect(moved.node_a, 'both objects moved').not.toEqual(before.node_a);
    expect(
      Math.round((moved.node_b?.x ?? 0) - (before.node_b?.x ?? 0)),
      'and by the same delta',
    ).toBe(Math.round((moved.node_a?.x ?? 0) - (before.node_a?.x ?? 0)));

    await page.locator('[data-edit="undo"]').click();
    expect(await geometry(page), 'undo restored both').toEqual(before);
    await page.locator('[data-edit="redo"]').click();
    expect(await geometry(page), 'redo re-applied both').toEqual(moved);
    expect(await undoDisabled(page)).toBe(false);
  });

  test('undo and redo after a restack round-trip the order, not the objects', async ({ page }) => {
    await mountFixture(page, SEAM_FIXTURE);
    const before = await order(page);
    await clickAt(page, 80, 80);
    await page.locator('[data-layer="front"]').click();
    const restacked = await order(page);
    expect(restacked).not.toEqual(before);

    await page.locator('[data-edit="undo"]').click();
    expect(await order(page)).toEqual(before);
    await page.locator('[data-edit="redo"]').click();
    expect(await order(page)).toEqual(restacked);
    // And the objects are the same elements, so a restack is not a rebuild.
    expect((await order(page)).sort()).toEqual([...before].sort());
  });

  test('a second command after an undo discards the redo branch', async ({ page }) => {
    await mountFixture(page, SEAM_FIXTURE);
    await clickAt(page, 80, 80);
    await page.locator('[data-layer="front"]').click();
    await page.locator('[data-edit="undo"]').click();

    // Undo does not restore the selection (M2's rule), so the second command needs one. Without
    // this the restack acted on nothing, no entry was pushed, and the redo branch correctly
    // survived -- so the test was measuring the wrong thing.
    expect(await selectionCount(page), 'undo did not restore or clear the selection').toBe(1);
    // `front`, not `back`: the undo put node_a back at index 0, which is already the back, so
    // sending it there would be a no-op and would push nothing.
    await clickAt(page, 80, 80);
    await page.locator('[data-layer="front"]').click();
    const redoDisabled = await page
      .locator('[data-edit="redo"]')
      .evaluate((el) => (el as HTMLButtonElement).disabled);
    expect(redoDisabled, 'the redo branch is gone').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A text session and an external render
// ---------------------------------------------------------------------------

test.describe('a text session against an external change', () => {
  test('clicking outside a session commits the text and leaves no gesture behind', async ({
    page,
  }) => {
    // The reachable seam, and it is the fence doing its job. While a session is open the editor
    // intercepts `pointerDown`: it ends the session and *returns*, so the click that ends the
    // session cannot also start a drag. The first version of this test assumed a drag could run
    // straight through an open session, and the shape it was checking never moved -- correctly.
    await mountFixture(page, SESSION_FIXTURE);
    const frame = page.locator('[data-page] [data-type="textFrame"]').first();
    await frame.click();
    await page.keyboard.press('Enter');
    expect(await page.locator('[data-editing="true"]').count()).toBe(1);

    await page.keyboard.type('hello');
    expect(await dirty(page), 'typing is not an authored change yet').toBe(false);

    // One click on the shape: ends the session, selects the shape, starts nothing.
    // The click that ends a session is *intercepted*: `pointerDown` ends the session and
    // returns, so the press has no selection effect at all. The frame stays selected, and the
    // shape is not picked up by the same click. That is the fence, and it is worth asserting
    // rather than working around — a second click selects the shape normally.
    await clickAt(page, 300, 220);
    expect(await page.locator('[data-editing="true"]').count(), 'the session ended').toBe(0);
    expect(
      await selectionIds(page),
      'the intercepting click changed no selection',
    ).toEqual(['node_frame']);

    const text = await page
      .locator('[data-page] [data-type="textFrame"]')
      .first()
      .innerText();
    expect(text, 'the typed text committed on the way out').toContain('hello');
    expect(text, 'exactly once').not.toContain('hellohello');
    expect(await dirty(page), 'and it is now an authored change').toBe(true);

    // A drag works immediately afterwards, so no gesture was left half-open by the interception.
    await drag(page, { x: 300, y: 220 }, { x: 360, y: 260 });
    expect(
      await page
        .locator('[data-page] [data-oid="node_shape"]')
        .evaluate((el) => (el as HTMLElement).style.left),
      'the shape moved',
    ).not.toBe('280px');
  });

  test('a session that changes nothing leaves the document clean', async ({ page }) => {
    await mountFixture(page, SESSION_FIXTURE);
    expect(await dirty(page)).toBe(false);
    const frame = page.locator('[data-page] [data-type="textFrame"]').first();
    await frame.click();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    expect(await dirty(page), 'opening and leaving a session is not an edit').toBe(false);
    expect(await undoDisabled(page)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A failed image across the boundary
// ---------------------------------------------------------------------------

test.describe('a failed image is a rendering state, not a document change', () => {
  test('its asset state is not authored, and the node still round-trips', async ({ browser }) => {
    // Generous: this one mounts, decodes, saves, opens a *second* browser context, reopens and
    // reads. The default 30s budget is spent on two app boots and an image decode.
    test.setTimeout(90_000);
    const first = await browser.newContext();
    const page = await first.newPage();
    // A document with a real inline image. The sample carries none, so the first version of this
    // test asserted against a document that could not satisfy it.
    await mountFixture(page, IMAGE_FIXTURE);
    await page.waitForSelector('[data-page] [data-type="image"][data-asset-state]');

    const bytes = await documentBytes(page);
    // The runtime asset state never appears in the file: it is published on the element as
    // `data-asset-state` and read from nowhere but the renderer.
    expect(bytes, 'no runtime asset state is serialized').not.toContain('asset-state');
    expect(bytes, 'and no asset status is either').not.toContain('"status"');
    // The reference is: the image's id appears, and so does the asset it points at.
    const parsed = JSON.parse(bytes) as {
      assets: Record<string, unknown>;
      pages: Array<{ objects: Array<{ id?: string; asset?: string }> }>;
    };
    const image = parsed.pages[0]?.objects.find((node) => node.asset !== undefined);
    expect(image, 'the image is a node in the file').toBeDefined();
    expect(Object.keys(parsed.assets), 'and its asset is in the table').toContain(image?.asset);

    const reopened = await reopenIn(browser, bytes);
    // A reopened document resolves its own assets; the previous session's state is not carried.
    // Read it off the *node* -- the asset id names the bytes, and the node id names the object.
    const state = await reopened
      .locator(`[data-page] [data-oid="${image?.id ?? ''}"]`)
      .getAttribute('data-asset-state');
    expect(['idle', 'loading', 'loaded', 'error'], 'a real state, not the old one').toContain(
      state,
    );
    await reopened.context().close();
    await first.close();
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A page-local document point in client coordinates, for raw mouse events. */
async function clientOf(page: Page, spot: { x: number; y: number }): Promise<{ x: number; y: number }> {
  return page.evaluate((doc) => {
    const pageElement = document.querySelector('[data-page]');
    const stack = document.querySelector('[data-pages]');
    if (!(pageElement instanceof HTMLElement) || !(stack instanceof HTMLElement)) {
      throw new Error('no page stack');
    }
    const scale = new DOMMatrixReadOnly(getComputedStyle(stack).transform).a;
    const box = pageElement.getBoundingClientRect();
    return { x: box.x + doc.x * scale, y: box.y + doc.y * scale };
  }, spot);
}

type Geometry = Record<string, { x: number; y: number } | undefined>;

function geometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const out: Geometry = {};
    for (const el of document.querySelectorAll('[data-page] [data-oid]')) {
      const node = el as HTMLElement;
      out[node.dataset['oid'] ?? ''] = {
        x: Number.parseFloat(node.style.left),
        y: Number.parseFloat(node.style.top),
      };
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SEAM_FIXTURE = `() => {
  const rect = (id, name, x, y) => ({
    type: 'shape', id, name,
    transform: { x, y, width: 120, height: 80, rotation: 0, scaleX: 1, scaleY: 1 },
    visible: true, locked: false, opacity: 1, blendMode: 'normal',
    shape: { kind: 'rect', cornerRadius: 0 },
    fill: { type: 'solid', color: '#3366ff' },
  });
  return {
    formatVersion: 1, id: 'seam', name: 'Seam',
    pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
    assets: {},
    pages: [{
      id: 'p1', name: '1',
      background: { type: 'solid', color: '#ffffff' },
      objects: [
        rect('node_a', 'A', 40, 40),
        rect('node_b', 'B', 200, 40),
        rect('node_c', 'C', 40, 170),
      ],
    }],
  };
}`;

/**
 * A 1x1 PNG as a whole data URL.
 *
 * `AssetData.inline` holds the *data URL*, not bare base64: the renderer hands it to `src`
 * unchanged, which is also why the format does not validate it as one (ADR 0007 -- an
 * unrenderable payload is a rendering state the document already knows how to show).
 */
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * A document with one real inline image.
 *
 * Built with the shared helper rather than by hand: a hand-written asset record has to get the
 * id shape, the `inline` data URL, the intrinsic size and the node's `fit` right, and a fixture
 * the parser refuses fails thirty seconds later as a bare timeout with no hint at all. The
 * helper carries the same guards the format enforces.
 */
const IMAGE_FIXTURE = documentWithImages(
  `{${assetRecord('a1', PIXEL, 1, 1)}}`,
  `[${imageNode('node_img', 'a1', 40, 40, 120, 80, { fit: 'fill' })}]`,
);

const SESSION_FIXTURE = `() => ({
  formatVersion: 1, id: 'session', name: 'Session',
  pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [
      { type: 'textFrame', id: 'node_frame', name: 'Frame',
        transform: { x: 40, y: 40, width: 220, height: 60, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        text: { blocks: [{ kind: 'paragraph', runs: [{ text: 'seed' }] } ] } },
      { type: 'shape', id: 'node_shape', name: 'Shape',
        transform: { x: 280, y: 200, width: 120, height: 80, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#3366ff' } },
    ],
  }],
})`;
