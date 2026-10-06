/**
 * The real save/load lifecycle, through the real app (ADR 0007).
 *
 * ## What "real" means here
 *
 * Save is a **download** and open is an **upload**: a Blob, an object URL, a synthetic
 * anchor click, and a hidden file input. Every test in this file drives those exact
 * mechanics through the toolbar buttons or the input the button drives. Nothing here
 * reaches into the app: there is no `window.__p1` hook, and the only injection point
 * remains `window.__P1_FIXTURE__` for *rendering* fixtures.
 *
 * ## How "identical document" is established
 *
 * By **byte identity across a real round trip**, not by reading the DOM:
 *
 * ```
 * page A: edit -> Save -> bytes B1
 * page B: a fresh browser context -> Open B1 -> Save -> bytes B2
 * B1 === B2
 * ```
 *
 * Two reasons. First, it is the strongest available statement: the bytes a user would put
 * back on disk after opening a file are the bytes they started with. Second, reading the
 * DOM for equality is ambiguous -- `getBoundingClientRect().height / zoom` is never a size
 * for a rotated box, and it cannot see the document's `name` or its asset table at all.
 * Targeted DOM assertions are still made, to prove the *renderer* also agrees.
 *
 * ## The image rule still applies
 *
 * Measured in M6: a failed image keeps its full authored box, stays hit-testable across all
 * of it, and reports `complete === true`. So nothing here asserts on an image element
 * existing -- every image assertion goes through `waitForAssetLoaded`, which reads
 * `data-asset-state` and fails naming what it found. An assertion about an image that never
 * decoded would be an assertion about an empty box.
 */

import { readFile } from 'node:fs/promises';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import {
  expect,
  frameText,
  settle,
  test,
  waitForAnyAssetLoaded,
  waitForAssetLoaded,
} from './helpers';
import { mountFixture, mountSample } from '../visual/harness';

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/**
 * Clicks Save and returns the bytes the browser actually downloaded.
 *
 * `waitForEvent('download')` is what makes this real: the app's only save path is an anchor
 * click, so if the download never fires the test fails here rather than silently asserting
 * against a string the app produced some other way.
 */
async function saveText(page: Page): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-doc="save"]').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.p1doc$/);
  const path = await download.path();
  if (path === null) throw new Error('the download produced no file');
  return readFile(path, 'utf8');
}

/** Saves and parses, so a test can make claims about the format through the UI. */
async function saveDocument(page: Page): Promise<Record<string, unknown>> {
  return JSON.parse(await saveText(page)) as Record<string, unknown>;
}

/**
 * Opens a document from bytes through the same hidden input the Open button drives, and
 * waits for it to settle.
 *
 * Reading the file is asynchronous (`file.text()`), so a fixed number of animation frames
 * would be a race. The wait is instead on the *visible consequence*, which is also what
 * makes it a real assertion: a successful open adopts the file's name in the status bar, and
 * a refusal marks the message with `data-error`.
 */
async function openBytes(page: Page, name: string, bytes: string | Buffer): Promise<void> {
  await page.locator('[data-file-input="document"]').setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes,
  });
  try {
    await page.waitForFunction(
      (expected) => {
        const shown = document.querySelector('[data-stat="name"]')?.textContent ?? '';
        const errored =
          document.querySelector('[data-doc-message]')?.getAttribute('data-error') === 'true';
        return errored || shown === expected;
      },
      name,
      { timeout: 8000 },
    );
  } catch (cause) {
    const state = await page.evaluate(() => ({
      name: document.querySelector('[data-stat="name"]')?.textContent ?? null,
      message: document.querySelector('[data-doc-message]')?.textContent ?? null,
    }));
    throw new Error(
      `Opening "${name}" never settled. Status bar shows: ${JSON.stringify(state)}`,
      { cause },
    );
  }
  await settle(page);
}

async function openText(page: Page, text: string): Promise<void> {
  await openBytes(page, 'fixture.p1doc', text);
}

/** Whether the status bar says there are unsaved changes. */
async function isDirty(page: Page): Promise<boolean> {
  return (await page.locator('[data-doc-state]').getAttribute('data-dirty')) === 'true';
}

function dirtyLabel(page: Page): Promise<string> {
  return page.locator('[data-doc-state]').innerText();
}

function message(page: Page): Promise<string> {
  return page.locator('[data-doc-message]').innerText();
}

async function hasError(page: Page): Promise<boolean> {
  return (await page.locator('[data-doc-message]').getAttribute('data-error')) === 'true';
}

/** Every rendered object, in paint order, as `{ id, type }`. */
function renderedObjects(page: Page): Promise<Array<{ id: string; type: string }>> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-oid]')].map((el) => ({
      id: (el as HTMLElement).dataset['oid'] ?? '',
      type: (el as HTMLElement).dataset['type'] ?? '',
    })),
  );
}

function objectCount(page: Page): Promise<number> {
  return page.locator('[data-oid]').count();
}

// ---------------------------------------------------------------------------
// A fresh browser, which is what "close the tab and open it again" means
// ---------------------------------------------------------------------------

/**
 * Opens a saved file in a **new browser context**.
 *
 * A new context rather than a reload on purpose: `page.addInitScript` is registered on the
 * context and re-applies to every navigation, so a reload would re-inject the rendering
 * fixture and the "opened" document would never be the document under test. A fresh context
 * has no init scripts, which is exactly the state a user is in after closing the tab.
 */
/**
 * A second, independent browser context with no fixture injected.
 *
 * `browser.newContext()` rather than a reload, and not the `page` fixture's own context: the
 * fixture's context carries the rendering `addInitScript`, which re-applies on every
 * navigation, so "reopening" a document there would still be running under the fixture. A
 * fresh context is the state a user is in after closing the tab.
 */
async function freshContext(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await mountSample(page);
  return { context, page };
}

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------

test.describe('save and reopen', () => {

  test('save -> close -> open yields the identical document', async ({ browser }) => {
    const { context: first, page } = await freshContext(browser);
    const original = await saveText(page);
    await first.close();

    const { context: second, page: reopened } = await freshContext(browser);
    await openText(reopened, original);
    const roundTripped = await saveText(reopened);
    await second.close();

    // Byte identity, not `toContain`: a serializer that reordered a key, dropped an absent
    // optional, or canonicalised a run would produce a document that *looks* the same and
    // would pass every other assertion in this file.
    expect(roundTripped).toBe(original);
  });

  test('the reopened document renders the same objects, in the same order', async ({
    browser,
  }) => {
    const before = await browser.newContext();
    const page = await before.newPage();
    await mountSample(page);
    const objectsBefore = await renderedObjects(page);
    const textBefore = await page.evaluate(() => {
      const frame = document.querySelector('[data-type="textFrame"] [data-p1-text]');
      return frame?.textContent ?? null;
    });
    const bytes = await saveText(page);
    await before.close();

    const after = await browser.newContext();
    const reopened = await after.newPage();
    await mountSample(reopened);
    await openText(reopened, bytes);

    expect(await renderedObjects(reopened)).toEqual(objectsBefore);
    expect(await objectCount(reopened)).toBeGreaterThan(0);
    expect(
      await reopened.evaluate(() => {
        const frame = document.querySelector('[data-type="textFrame"] [data-p1-text]');
        return frame?.textContent ?? null;
      }),
    ).toBe(textBefore);
    await after.close();
  });

  test('an empty document round-trips', async ({ browser }) => {
    const first = await browser.newContext();
    const page = await first.newPage();
    await mountSample(page);
    // `New` asks before discarding, and there is nothing to discard yet, so it proceeds
    // without a dialog. If that ever stops being true the test fails here, which is where
    // the surprise belongs.
    await page.locator('[data-doc="new"]').click();
    await settle(page);
    expect(await objectCount(page)).toBe(0);

    const empty = await saveDocument(page);
    expect(empty['pages']).toEqual([
      expect.objectContaining({ objects: [] }),
    ]);
    await first.close();

    const second = await browser.newContext();
    const reopened = await second.newPage();
    await mountSample(reopened);
    await openText(reopened, JSON.stringify(empty, null, 2));
    expect(await objectCount(reopened)).toBe(0);
    expect(await saveText(reopened)).toBe(JSON.stringify(empty, null, 2) + '\n');
    await second.close();
  });

  test('a multi-page document round-trips, and every page is still rendered', async ({
    browser,
  }) => {
    // Injected for *rendering*, which is what `__P1_FIXTURE__` is for. Nothing downstream
    // depends on it: the document is saved from the running app like any other.
    const source = `() => ({
      formatVersion: 1, id: 'multi', name: 'Multi',
      pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
      assets: {},
      pages: [
        { id: 'p1', name: 'One', background: { type: 'solid', color: '#ffffff' }, objects: [
          { type: 'shape', id: 'n1', name: 'R', transform: { x: 10, y: 10, width: 40, height: 20, rotation: 0, scaleX: 1, scaleY: 1 },
            visible: true, locked: false, opacity: 1, blendMode: 'normal',
            shape: { kind: 'rect', cornerRadius: 3 }, fill: { type: 'solid', color: '#ff0000' } },
        ] },
        { id: 'p2', name: 'Two', background: { type: 'solid', color: '#eeeeee' }, objects: [
          { type: 'shape', id: 'n2', name: 'E', transform: { x: 10, y: 10, width: 30, height: 30, rotation: 0, scaleX: 1, scaleY: 1 },
            visible: true, locked: false, opacity: 1, blendMode: 'normal',
            shape: { kind: 'ellipse' }, fill: { type: 'solid', color: '#00ff00' } },
        ] },
        { id: 'p3', name: 'Three', background: { type: 'solid', color: '#ffffff' }, objects: [] },
      ],
    })`;

    const first = await browser.newContext();
    const page = await first.newPage();
    await mountFixture(page, source);
    expect(await page.locator('[data-page]').count()).toBe(3);

    const bytes = await saveText(page);
    const saved = JSON.parse(bytes) as { pages: unknown[] };
    expect(saved.pages).toHaveLength(3);
    await first.close();

    const second = await browser.newContext();
    const reopened = await second.newPage();
    await mountSample(reopened);
    await openText(reopened, bytes);

    expect(await reopened.locator('[data-page]').count()).toBe(3);
    expect(await objectCount(reopened)).toBe(2);
    expect(await saveText(reopened)).toBe(bytes);
    await second.close();
  });

  test('rich text round-trips with its inline formatting and paragraph alignment', async ({
    page,
  }) => {
    // The shipped sample already carries three paragraphs and bold / italic / underline /
    // strike, so this needs no fixture and therefore cannot be testing a fixture.
    await mountSample(page);
    const frameId = await page
      .locator('[data-type="textFrame"]')
      .first()
      .getAttribute('data-oid');
    expect(frameId).not.toBeNull();

    const before = await frameText(page, frameId!);
    const saved = await saveDocument(page);
    const frame = (saved['pages'] as Array<{ objects: unknown[] }>)[0]?.objects
      .find((node) => (node as { type?: string }).type === 'textFrame') as
      | { text: { blocks: Array<{ runs: Array<{ format?: object }>; align?: string }> } }
      | undefined;

    expect(frame).toBeDefined();
    const blocks = frame?.text.blocks ?? [];
    expect(blocks.length).toBeGreaterThan(1);
    // Every flag the sample authors, re-read from the file rather than from the DOM.
    const formats = blocks.flatMap((block) => block.runs.map((run) => Object.keys(run.format ?? {})));
    expect(formats.some((keys) => keys.includes('bold'))).toBe(true);
    expect(formats.some((keys) => keys.includes('italic'))).toBe(true);
    expect(formats.some((keys) => keys.includes('underline'))).toBe(true);
    expect(formats.some((keys) => keys.includes('strike'))).toBe(true);
    expect(blocks.some((block) => block.align !== undefined)).toBe(true);

    // And the rendered text is unchanged, which is the part a user would notice.
    await openText(page, JSON.stringify(saved, null, 2) + '\n');
    expect(await frameText(page, frameId!)).toBe(before);
  });

  test('every shape kind round-trips, and each is still hit-testable where it was', async ({
    browser,
  }) => {
    const source = `() => ({
      formatVersion: 1, id: 'kinds', name: 'Kinds',
      pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
      assets: {},
      pages: [{ id: 'p1', name: '1', background: { type: 'solid', color: '#ffffff' }, objects: [
        { type: 'shape', id: 'n_rect', name: 'Rect', transform: { x: 20, y: 20, width: 60, height: 40, rotation: 0, scaleX: 1, scaleY: 1 },
          visible: true, locked: false, opacity: 1, blendMode: 'normal',
          shape: { kind: 'rect', cornerRadius: 5 }, fill: { type: 'solid', color: '#3366ff' },
          stroke: { paint: { type: 'solid', color: '#000000' }, width: 2, align: 'inside' } },
        { type: 'shape', id: 'n_ellipse', name: 'Ellipse', transform: { x: 20, y: 90, width: 50, height: 50, rotation: 0, scaleX: 1, scaleY: 1 },
          visible: true, locked: false, opacity: 1, blendMode: 'normal',
          shape: { kind: 'ellipse' }, fill: { type: 'solid', color: '#ff9900' } },
        { type: 'shape', id: 'n_line', name: 'Line', transform: { x: 20, y: 170, width: 120, height: 0, rotation: 0, scaleX: 1, scaleY: 1 },
          visible: true, locked: false, opacity: 1, blendMode: 'normal',
          shape: { kind: 'line' },
          stroke: { paint: { type: 'solid', color: '#111111' }, width: 3, align: 'inside' } },
      ] }],
    })`;

    const first = await browser.newContext();
    const page = await first.newPage();
    await mountFixture(page, source);
    const bytes = await saveText(page);
    await first.close();

    const second = await browser.newContext();
    const reopened = await second.newPage();
    await mountSample(reopened);
    await openText(reopened, bytes);

    expect(await objectCount(reopened)).toBe(3);
    // A line's geometry lives in an SVG island, so its presence is asserted by the stroke
    // rather than by a background -- and by its zero-height box, which is the case a
    // "must have extent" shortcut would drop.
    expect(await reopened.locator('[data-oid="n_line"] svg line').count()).toBe(1);
    expect(await reopened.locator('[data-oid="n_rect"]').getAttribute('data-type')).toBe('shape');
    expect(await saveText(reopened)).toBe(bytes);
    await second.close();
  });

  test('transformed objects round-trip, including rotation and scale', async ({ browser }) => {
    const source = `() => ({
      formatVersion: 1, id: 'xf', name: 'Transformed',
      pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
      assets: {},
      pages: [{ id: 'p1', name: '1', background: { type: 'solid', color: '#ffffff' }, objects: [
        { type: 'shape', id: 'n_rot', name: 'Rotated', transform: { x: 40, y: 40, width: 80, height: 40, rotation: 0.5235987755982988, scaleX: 1.25, scaleY: 0.75 },
          visible: true, locked: false, opacity: 0.6, blendMode: 'multiply',
          shape: { kind: 'rect', cornerRadius: 0 }, fill: { type: 'solid', color: '#123456' } },
        { type: 'shape', id: 'n_flat', name: 'Zero extent', transform: { x: 40, y: 140, width: 0, height: 0, rotation: 0, scaleX: 1, scaleY: 1 },
          visible: true, locked: false, opacity: 1, blendMode: 'normal',
          shape: { kind: 'rect', cornerRadius: 0 }, fill: { type: 'solid', color: '#654321' } },
      ] }],
    })`;

    const first = await browser.newContext();
    const page = await first.newPage();
    await mountFixture(page, source);
    const bytes = await saveText(page);

    const saved = JSON.parse(bytes) as {
      pages: Array<{ objects: Array<{ id: string; transform: Record<string, number> }> }>;
    };
    const rotated = saved.pages[0]?.objects.find((node) => node.id === 'n_rot');
    // Asserted on the number itself: a serializer that rounded or reformatted it would
    // produce a document that still renders, and `toBeCloseTo` would not notice.
    expect(rotated?.transform['rotation']).toBe(0.5235987755982988);
    expect(rotated?.transform['scaleX']).toBe(1.25);
    expect(saved.pages[0]?.objects.find((n) => n.id === 'n_flat')?.transform['width']).toBe(0);
    await first.close();

    const second = await browser.newContext();
    const reopened = await second.newPage();
    await mountSample(reopened);
    await openText(reopened, bytes);
    expect(await saveText(reopened)).toBe(bytes);
    await second.close();
  });
});

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

test.describe('assets', () => {
  test('an inline image round-trips and still decodes in the reopened document', async ({
    browser,
  }) => {
    // The image is inserted through the real file input, so the document carries a
    // genuinely decodable asset rather than a hand-written data URL -- the M6 lesson.
    const first = await browser.newContext();
    const page = await first.newPage();
    await mountSample(page);

    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 24;
      canvas.height = 12;
      const g = canvas.getContext('2d');
      if (g === null) throw new Error('no 2d context');
      g.fillStyle = '#22aa66';
      g.fillRect(0, 0, 24, 12);
      return canvas.toDataURL('image/png');
    });
    await page.locator('[data-file-input="image"]').setInputFiles({
      name: 'green.png',
      mimeType: 'image/png',
      buffer: Buffer.from(png.split(',')[1] ?? '', 'base64'),
    });
    await waitForAnyAssetLoaded(page);

    const imageId = await page.evaluate(
      () => document.querySelector('[data-type="image"]')?.getAttribute('data-oid') ?? null,
    );
    expect(imageId).not.toBeNull();

    const bytes = await saveText(page);
    const saved = JSON.parse(bytes) as {
      assets: Record<string, { intrinsicWidth: number; intrinsicHeight: number; data: object }>;
      pages: Array<{ objects: Array<{ type: string; asset?: string }> }>;
    };
    expect(Object.keys(saved.assets)).toHaveLength(1);
    const [assetId] = Object.keys(saved.assets);
    expect(saved.assets[assetId!]?.intrinsicWidth).toBe(24);
    expect(saved.assets[assetId!]?.intrinsicHeight).toBe(12);
    expect(saved.assets[assetId!]?.data).toHaveProperty('inline');
    await first.close();

    const second = await browser.newContext();
    const reopened = await second.newPage();
    await mountSample(reopened);
    await openText(reopened, bytes);

    // The load-bearing assertion: the renderer resolved the asset **from the document it just
    // opened**. If it resolved against a stale document, or against nothing, the image would
    // not reach `loaded` -- and an element would still exist, which is exactly the trap.
    await waitForAssetLoaded(reopened, imageId!);
    expect(await reopened.locator('[data-type="image"]').count()).toBe(1);
    expect(await saveText(reopened)).toBe(bytes);
    await second.close();
  });

  test('an unresolvable external asset opens, keeps its reference, and reports an error', async ({
    browser,
  }) => {
    const first = await browser.newContext();
    const page = await first.newPage();
    await mountSample(page);

    const external = JSON.stringify({
      format: 'p1doc',
      formatVersion: 1,
      id: 'doc_ext',
      name: 'External',
      pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
      assets: {
        asset_x: {
          kind: 'image',
          mime: 'image/png',
          intrinsicWidth: 10,
          intrinsicHeight: 10,
          // A path that cannot resolve: there is no project folder and nothing is fetched.
          data: { external: './assets/nowhere.png' },
        },
      },
      pages: [
        {
          id: 'p1',
          name: '1',
          background: { type: 'solid', color: '#ffffff' },
          objects: [
            {
              type: 'image',
              id: 'n_ext',
              name: 'Missing',
              transform: { x: 20, y: 20, width: 40, height: 40, rotation: 0, scaleX: 1, scaleY: 1 },
              visible: true,
              locked: false,
              opacity: 1,
              blendMode: 'normal',
              asset: 'asset_x',
            },
          ],
        },
      ],
    });
    await openText(page, external);

    // Opened, not refused: a document that references a file it cannot find is still a valid
    // document, and refusing it would throw away everything else the user authored.
    expect(await hasError(page)).toBe(false);
    expect(await isDirty(page)).toBe(false);
    await page.locator('[data-oid="n_ext"]').waitFor();

    // The reference survives verbatim, and nothing was fetched.
    const bytes = await saveText(page);
    const saved = JSON.parse(bytes) as { assets: Record<string, { data: object }> };
    expect(saved.assets['asset_x']?.data).toEqual({ external: './assets/nowhere.png' });

    // And the renderer says so rather than pretending the image is fine.
    await page
      .waitForFunction(() => {
        const el = document.querySelector('[data-oid="n_ext"]');
        const state = el?.getAttribute('data-asset-state');
        return state === 'error' || state === 'loaded';
      })
      .catch(() => {
        throw new Error('the asset never settled; the document claimed an image it cannot show');
      });
    const state = await page
      .locator('[data-oid="n_ext"]')
      .getAttribute('data-asset-state');
    expect(state).toBe('error');
    await first.close();
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test.describe('refused documents', () => {
  /** A minimal document with one object, used as the base for each mutation. */
  function base(): Record<string, unknown> {
    return {
      format: 'p1doc',
      formatVersion: 1,
      id: 'doc_1',
      name: 'Base',
      pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
      assets: {},
      pages: [
        {
          id: 'page_1',
          name: '1',
          background: { type: 'solid', color: '#ffffff' },
          objects: [
            {
              type: 'shape',
              id: 'node_1',
              name: 'R',
              transform: { x: 10, y: 10, width: 40, height: 20, rotation: 0, scaleX: 1, scaleY: 1 },
              visible: true,
              locked: false,
              opacity: 1,
              blendMode: 'normal',
              shape: { kind: 'rect', cornerRadius: 0 },
            },
          ],
        },
      ],
    };
  }

  /**
   * The shared shape of every refusal test.
   *
   * Each one asserts **four** things, because "it showed an error" is satisfied by a wrong
   * error:
   *
   *  1. the current document is untouched (an object count, not a reference),
   *  2. the dirty state is untouched,
   *  3. a message is shown and marked as an error,
   *  4. the message names the actual fault.
   */
  async function expectRefused(
    page: Page,
    payload: Record<string, unknown> | string,
    fragment: string,
  ): Promise<void> {
    const objectsBefore = await objectCount(page);
    const dirtyBefore = await isDirty(page);
    const nameBefore = await page.locator('[data-stat="name"]').innerText();

    await openText(page, typeof payload === 'string' ? payload : JSON.stringify(payload));

    expect(await objectCount(page), 'the open document must not have replaced anything').toBe(
      objectsBefore,
    );
    expect(await isDirty(page), 'a refused open must not change dirty state').toBe(dirtyBefore);
    expect(await page.locator('[data-stat="name"]').innerText()).toBe(nameBefore);
    expect(await hasError(page)).toBe(true);
    expect(await message(page)).toContain(fragment);
  }

  test('a document missing a required field is refused and named', async ({ page }) => {
    await mountSample(page);
    // Valid JSON, wrong shape: this is the "malformed document" case, and it has to be
    // distinguished from "not JSON at all" below, because the two need different messages.
    await expectRefused(page, '{ "format": "p1doc" }', 'formatVersion');
  });

  test('a truncated document is refused', async ({ page }) => {
    await mountSample(page);
    await expectRefused(page, '{ "format": "p1doc", "pages": [', 'not a readable document');
  });

  test('a document that is not JSON is refused', async ({ page }) => {
    await mountSample(page);
    await expectRefused(page, 'this is not json at all', 'not a readable document');
  });

  test('an unsupported format version is refused in both directions', async ({ page }) => {
    await mountSample(page);

    await expectRefused(page, { ...base(), formatVersion: 99 }, 'newer version');
    expect(await message(page)).toContain('99');

    // The older direction gets a *different* message, because it needs a different action.
    await expectRefused(page, { ...base(), formatVersion: 0 }, 'older version');
  });

  test('an unknown object type is refused, not rendered as an empty object', async ({ page }) => {
    await mountSample(page);
    const payload = base();
    const pages = payload['pages'] as Array<{ objects: Array<Record<string, unknown>> }>;
    const objects = pages[0]!.objects;
    objects[0] = { ...objects[0]!, type: 'sticker' };

    await expectRefused(page, payload, 'unknown object type "sticker"');
    // The path too, so the user knows where to look rather than only what went wrong.
    expect(await message(page)).toContain('objects[0].type');
  });

  test('an unknown shape kind is refused', async ({ page }) => {
    await mountSample(page);
    const payload = base();
    const pages = payload['pages'] as Array<{ objects: Array<Record<string, unknown>> }>;
    const objects = pages[0]!.objects;
    objects[0] = { ...objects[0]!, shape: { kind: 'polygon' } };

    await expectRefused(page, payload, 'unknown shape kind "polygon"');
  });

  test('an image referencing a missing asset is refused', async ({ page }) => {
    await mountSample(page);
    const payload = base();
    const pages = payload['pages'] as Array<{ objects: Array<Record<string, unknown>> }>;
    const objects = pages[0]!.objects;
    objects[0] = {
      type: 'image',
      id: 'node_1',
      name: 'I',
      transform: { x: 10, y: 10, width: 40, height: 40, rotation: 0, scaleX: 1, scaleY: 1 },
      visible: true,
      locked: false,
      opacity: 1,
      blendMode: 'normal',
      asset: 'asset_absent',
    };

    await expectRefused(page, payload, 'asset_absent');
  });

  test('an undeclared field is refused rather than dropped', async ({ page }) => {
    await mountSample(page);
    // The load-bearing policy of the format: a key this build does not know is either a
    // version mismatch or a hand-edit, and dropping it would let the document look fine
    // while having quietly lost authored state.
    await expectRefused(page, { ...base(), guides: [] }, 'guides');
  });

  test('a refused open leaves a good document saveable', async ({ page }) => {
    // The user-visible consequence of "nothing changed": Save still works and still writes
    // the document that is actually open.
    await mountSample(page);
    const before = await saveText(page);
    await openText(page, '{ "nope": true }');
    expect(await saveText(page)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Dirty state, through the UI
// ---------------------------------------------------------------------------

test.describe('the dirty indicator', () => {
  test('starts clean, becomes dirty on an edit, and returns to clean after save', async ({
    page,
  }) => {
    await mountSample(page);
    expect(await isDirty(page)).toBe(false);
    expect(await dirtyLabel(page)).toBe('Saved');

    // Drawn through the real tool, so the edit is a command like any other.
    await page.locator('[data-shape="rect"]').click();
    await page.mouse.move(600, 400);
    await page.mouse.down();
    await page.mouse.move(700, 480, { steps: 6 });
    await page.mouse.up();
    await settle(page);

    expect(await isDirty(page)).toBe(true);
    expect(await dirtyLabel(page)).toBe('Unsaved changes');

    await saveText(page);
    expect(await isDirty(page)).toBe(false);
    expect(await dirtyLabel(page)).toBe('Saved');
  });

  test('scrolling, zooming and selecting do not make a document dirty', async ({ page }) => {
    // The negative half of the claim. Dirty state is about authored state, so the three most
    // common things a user does that touch *nothing* authored must leave the indicator alone.
    await mountSample(page);

    await page.locator('[data-zoom="in"]').click();
    await page.locator('[data-zoom="out"]').click();
    await page.locator('[data-zoom="fit"]').click();
    await page.mouse.move(600, 500);
    await settle(page);
    expect(await isDirty(page)).toBe(false);

    // A click that selects, and a drag on empty page that moves nothing.
    await page.locator('[data-oid]').first().click();
    await settle(page);
    expect(await isDirty(page)).toBe(false);

    await page.mouse.move(1200, 200);
    await page.mouse.down();
    await page.mouse.move(1240, 240, { steps: 4 });
    await page.mouse.up();
    await settle(page);
    expect(await isDirty(page)).toBe(false);
  });

  test('undo back to the saved state makes the document clean again', async ({ page }) => {
    await mountSample(page);
    await saveText(page);

    // Move an object by dragging it: a real gesture, so the history entry is a real one.
    const target = page.locator('[data-oid]').first();
    const box = (await target.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 8 });
    await page.mouse.up();
    await settle(page);
    expect(await isDirty(page)).toBe(true);

    await page.locator('[data-edit="undo"]').click();
    await settle(page);
    expect(await isDirty(page)).toBe(false);
  });

  test('undoing to a state other than the saved one leaves the document dirty', async ({
    page,
  }) => {
    // The negative control for the test above. Undo restores the previous document, not "the
    // saved one", so this must not look clean merely because undo worked.
    await mountSample(page);
    await saveText(page);

    const target = page.locator('[data-oid]').first();
    for (const [dx, dy] of [
      [40, 30],
      [80, 60],
    ] as const) {
      const box = (await target.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 6 });
      await page.mouse.up();
      await settle(page);
    }
    expect(await isDirty(page)).toBe(true);

    await page.locator('[data-edit="undo"]').click();
    await settle(page);
    expect(await isDirty(page)).toBe(true);
  });

  test('opening a document clears history, so undo cannot cross documents', async ({ page }) => {
    await mountSample(page);
    await page.locator('[data-shape="rect"]').click();
    await page.mouse.move(600, 400);
    await page.mouse.down();
    await page.mouse.move(700, 480, { steps: 6 });
    await page.mouse.up();
    await settle(page);
    expect(await page.locator('[data-edit="undo"]').isEnabled()).toBe(true);

    await openText(page, await saveText(page));
    expect(await isDirty(page)).toBe(false);
    // History entries hold `Document` snapshots, so an undo stack spanning two documents
    // would make undo jump between them. This is the visible consequence.
    expect(await page.locator('[data-edit="undo"]').isDisabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The text fence, at save time
// ---------------------------------------------------------------------------

test.describe('saving during a text session', () => {
  test('the file carries the typed text, not the text from before the session', async ({
    page,
  }) => {
    await mountSample(page);
    const frameId = await page
      .locator('[data-type="textFrame"]')
      .first()
      .getAttribute('data-oid');

    // Enter the frame and type, leaving the session open. Click then <kbd>Enter</kbd> is the
    // real affordance -- a double click lands inside the frame's own content and is absorbed
    // by the browser rather than reaching the editor.
    const frameBox = (await page.locator(`[data-oid="${frameId}"]`).boundingBox())!;
    await page.mouse.click(frameBox.x + 8, frameBox.y + 8);
    await page.keyboard.press('Enter');
    await page.waitForSelector(`[data-oid="${frameId}"][data-editing="true"]`);
    await page.keyboard.type('TYPED');
    await settle(page);
    expect(await page.locator(`[data-oid="${frameId}"][data-editing="true"]`).count()).toBe(1);

    // Save *without* leaving the session first. The rule is that the session is committed
    // first, so the serialized text is the typed text -- serializing the stale model would
    // write the text from before the session, which is silent data loss.
    const saved = JSON.parse(await saveText(page)) as {
      pages: Array<{ objects: Array<{ id: string; text?: { blocks: Array<{ runs: Array<{ text: string }> }> } }> }>;
    };
    const frame = saved.pages
      .flatMap((page) => page.objects)
      .find((node) => node.id === frameId);
    const text = frame?.text?.blocks.flatMap((block) => block.runs.map((run) => run.text)).join('');
    expect(text).toContain('TYPED');

    // And the session is closed by the save, because committing it is how the text got there.
    expect(await page.locator(`[data-oid="${frameId}"][data-editing="true"]`).count()).toBe(0);
    // The commit is one undo entry through the funnel, so it is undoable as a single step.
    expect(await page.locator('[data-edit="undo"]').isEnabled()).toBe(true);
  });

  test('saving during a session that changed nothing leaves the document clean', async ({
    page,
  }) => {
    await mountSample(page);
    await saveText(page);
    const frameId = await page
      .locator('[data-type="textFrame"]')
      .first()
      .getAttribute('data-oid');

    // Enter and leave without typing. The funnel drops the no-op commit, so nothing was
    // authored and the indicator must not move.
    const frameBox = (await page.locator(`[data-oid="${frameId}"]`).boundingBox())!;
    await page.mouse.click(frameBox.x + 8, frameBox.y + 8);
    await page.keyboard.press('Enter');
    await page.waitForSelector(`[data-oid="${frameId}"][data-editing="true"]`);
    await page.keyboard.press('Escape');
    await settle(page);

    expect(await isDirty(page)).toBe(false);
    await saveText(page);
    expect(await isDirty(page)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The file mechanics themselves
// ---------------------------------------------------------------------------

test.describe('the file boundary', () => {
  test('the Open button drives the file input, so the user path is the tested path', async ({
    page,
  }) => {
    await mountSample(page);
    const bytes = await saveText(page);

    const chooser = page.waitForEvent('filechooser');
    await page.locator('[data-doc="open"]').click();
    const fileChooser = await chooser;
    // Asserted rather than assumed: the button and the input must be the same path, or the
    // tests would be exercising something a user cannot reach.
    expect(fileChooser.isMultiple()).toBe(false);
    await fileChooser.setFiles({
      name: 'reopened.p1doc',
      mimeType: 'application/json',
      buffer: Buffer.from(bytes, 'utf8'),
    });
    await settle(page);
    expect(await isDirty(page)).toBe(false);
  });

  test('Ctrl+S saves through the same path as the button', async ({ page }) => {
    await mountSample(page);
    await page.locator('[data-shape="rect"]').click();
    await page.mouse.move(600, 400);
    await page.mouse.down();
    await page.mouse.move(700, 480, { steps: 6 });
    await page.mouse.up();
    await settle(page);
    expect(await isDirty(page)).toBe(true);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.keyboard.press('Control+s'),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.p1doc$/);
    await settle(page);
    expect(await isDirty(page)).toBe(false);
  });

  test('the saved filename follows the document and is not doubled up', async ({ page }) => {
    await mountSample(page);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('[data-doc="save"]').click(),
    ]);
    const name = download.suggestedFilename();
    expect(name.endsWith('.p1doc')).toBe(true);
    // One extension, not `Name.p1doc.p1doc` on the second save.
    expect(name.indexOf('.p1doc')).toBe(name.length - '.p1doc'.length);

    const [again] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('[data-doc="save"]').click(),
    ]);
    expect(again.suggestedFilename()).toBe(name);
  });

  test('New asks before discarding unsaved work, and does nothing when refused', async ({
    page,
  }) => {
    await mountSample(page);
    await page.locator('[data-shape="rect"]').click();
    await page.mouse.move(600, 400);
    await page.mouse.down();
    await page.mouse.move(700, 480, { steps: 6 });
    await page.mouse.up();
    await settle(page);
    const count = await objectCount(page);

    // One handler, driven by a flag: registering `on` and then `once` means the persistent
    // handler also fires for the second dialog, after `once` has already dealt with it.
    let asked = 0;
    let accept = false;
    page.on('dialog', (dialog) => {
      asked += 1;
      if (accept) void dialog.accept();
      else void dialog.dismiss();
    });

    // First the refused path, which is what Playwright does by default.
    await page.locator('[data-doc="new"]').click();
    await settle(page);
    expect(asked).toBe(1);
    expect(await objectCount(page)).toBe(count);
    expect(await isDirty(page)).toBe(true);

    // And the accepted path really does replace the document.
    accept = true;
    await page.locator('[data-doc="new"]').click();
    await settle(page);
    expect(asked).toBe(2);
    expect(await objectCount(page)).toBe(0);
    expect(await isDirty(page)).toBe(false);
  });

  test('a saved file carries no runtime state', async ({ page }) => {
    // The list of things that must not be in the file, checked against real output rather
    // than against the schema: a selector that matches nothing proves nothing about what the
    // serializer chose to emit.
    await mountSample(page);
    await page.locator('[data-oid]').first().click();
    await page.locator('[data-zoom="in"]').click();
    await settle(page);

    const text = await saveText(page);
    for (const forbidden of [
      'zoom',
      'pan',
      'scroll',
      'selection',
      'contenteditable',
      'blob:',
      'file:',
      'lastRender',
      'asset-state',
      'dirty',
    ]) {
      expect(text.toLowerCase(), `"${forbidden}" must not appear in a saved document`).not.toContain(
        forbidden,
      );
    }
    // And the things that must be there, so the check above is not satisfied by an empty file.
    expect(text).toContain('"format": "p1doc"');
    expect(text).toContain('"formatVersion"');
    expect(text).toContain('"objects"');
  });
});
