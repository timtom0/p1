/**
 * M19: print output.
 *
 * ## Two complementary techniques, and why both
 *
 * **Print-media emulation** (`page.emulateMedia({ media: 'print' })`) resolves the stylesheet against
 * the print rules, so computed styles and geometry are directly assertable: is the toolbar displayed,
 * is the zoom transform gone, does each page carry a page break. These are precise and fast.
 *
 * **Real PDF generation** (`page.pdf()`) is the only thing that can answer "is there one sheet per
 * page?", because pagination happens in the browser's print engine, not in the DOM. Nothing in the
 * page reports how many sheets *will* be produced. Chromium's page count is then read out of the
 * generated file.
 *
 * Emulation alone would pass with a profile that hides the chrome but still emits a blank sheet per
 * page gap — which is the specific failure `@page { margin: 0 }` and `break-after` exist to prevent.
 *
 * `page.pdf()` is Chromium-only, which is the suite's only browser, so this needs no skip.
 */

import type { Page } from '@playwright/test';
import { inflateSync } from 'node:zlib';

import { expect, settle, test } from './helpers';
import { mountPrintLandscapeInches, mountPrintThreePages } from './print-fixtures';

/** Everything the print view looks like, read in one round trip. */
interface PrintView {
  pages: Array<{ id: string; top: number; left: number; width: number; height: number; position: string; background: string }>;
  hidden: Record<string, boolean>;
  pagesTransform: string;
  breakAfter: string[];
  bodyOverflow: string;
  surfaceOverflow: string;
  objects: Array<{ id: string; left: number; top: number; width: number; height: number; transform: string }>;
  profileCss: string;
}

async function readPrintView(page: Page): Promise<PrintView> {
  return page.evaluate(() => {
    const visible = (selector: string): boolean => {
      const element = document.querySelector(selector);
      if (element === null) return false;
      return getComputedStyle(element).display !== 'none';
    };
    const pageBoxes = [...document.querySelectorAll<HTMLElement>('.page')];
    const pageOrigin = pageBoxes[0]?.getBoundingClientRect();
    return {
      pages: pageBoxes.map((element) => {
        const box = element.getBoundingClientRect();
        return {
          id: element.dataset['page'] ?? '?',
          // Measured relative to the first page, so "is this a separate sheet" is a question about
          // these numbers differing by exactly one page height.
          top: box.top - (pageOrigin?.top ?? 0),
          left: box.left - (pageOrigin?.left ?? 0),
          width: box.width,
          height: box.height,
          position: getComputedStyle(element).position,
          background: getComputedStyle(element).backgroundColor,
        };
      }),
      hidden: {
        toolbar: visible('.toolbar'),
        ruler: visible('.ruler'),
        rulerCorner: visible('.ruler-corner'),
        inspector: visible('.inspector'),
        status: visible('.status'),
        overlay: visible('.overlay'),
      },
      pagesTransform: getComputedStyle(document.querySelector<HTMLElement>('.pages')!).transform,
      breakAfter: pageBoxes.map((element) => getComputedStyle(element).breakAfter),
      bodyOverflow: getComputedStyle(document.body).overflow,
      surfaceOverflow: getComputedStyle(document.querySelector<HTMLElement>('.surface')!).overflow,
      objects: [...document.querySelectorAll<HTMLElement>('[data-oid]')].map((element) => {
        const box = element.getBoundingClientRect();
        return {
          id: element.dataset['oid'] ?? '?',
          left: box.left - (pageOrigin?.left ?? 0),
          top: box.top - (pageOrigin?.top ?? 0),
          width: box.width,
          height: box.height,
          transform: getComputedStyle(element).transform,
        };
      }),
      profileCss:
        document.querySelector('style[data-print-profile]')?.textContent ?? '(no profile injected)',
    };
  });
}

/**
 * The page count of a Chromium-generated PDF.
 *
 * Chromium writes its page tree as uncompressed objects by default, so `/Type /Page` can be counted
 * directly. `/Count` in the catalog would be the other route, but it is not present when the catalog
 * lives in a compressed object stream -- hence the fallback below, and hence the `MediaBox` check,
 * which is what makes the assertion about *size* as well as number.
 */
/**
 * The inflated content of a generated PDF.
 *
 * Chromium writes page descriptions as Flate-compressed streams, so the colour operators a test wants
 * to assert on are not readable in the raw bytes. Inflating them is what makes "the dark page actually
 * reached the PDF" a check rather than a hope -- and it is how the sheet-count test's blind spot was
 * found: an earlier version of the background test asserted a byte count, which a 72-byte difference
 * could not distinguish from noise.
 */
function pdfContent(buffer: Buffer): string {
  const text = buffer.toString('latin1');
  const parts: string[] = [];
  const stream = /stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = stream.exec(text)) !== null) {
    const start = match.index + match[0].length;
    const end = text.indexOf('endstream', start);
    if (end === -1) continue;
    const raw = Buffer.from(text.slice(start, end), 'latin1');
    try {
      parts.push(inflateSync(raw).toString('latin1'));
    } catch {
      parts.push(raw.toString('latin1'));
    }
  }
  return parts.join('\n');
}

/** `#102030` -> the `rg` operand Chromium writes for it. */
const DARK_PAGE_RGB_OPERAND = '.0627 .1255 .1882 rg';

function readPdf(buffer: Buffer): { pageCount: number; mediaBoxes: string[] } {
  const text = buffer.toString('latin1');
  const count = (text.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  const mediaBoxes = [...text.matchAll(/\/MediaBox\s*\[\s*([\d.\s-]+?)\]/g)].map((m) =>
    (m[1] ?? '').trim().replace(/\s+/g, ' '),
  );
  return { pageCount: count, mediaBoxes };
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

test.describe('print hides the editor', () => {
  test('no editor chrome or overlay is displayed in print', async ({ page }) => {
    await mountPrintThreePages(page);
    await page.emulateMedia({ media: 'print' });
    await settle(page);

    const view = await readPrintView(page);
    for (const [what, shown] of Object.entries(view.hidden)) {
      expect(shown, `${what} must not be displayed when printing`).toBe(false);
    }
  });

  test('selection outlines, handles and snap guides go with the overlay', async ({ page }) => {
    // Not just "the overlay element is hidden" — the chrome is drawn *into* it, so a selection made
    // before printing must leave nothing behind.
    await mountPrintThreePages(page);
    // Clicked *inside* the page, located from the page element rather than hardcoded: the page is
    // centred in the viewport, so fixed client coordinates land outside it and select nothing.
    const spot = await page.evaluate(() => {
      const pageElement = document.querySelector<HTMLElement>('.page')!;
      const box = pageElement.getBoundingClientRect();
      return { x: box.left + 40, y: box.top + 30 };
    });
    await page.mouse.click(spot.x, spot.y);
    await settle(page);
    expect(await page.locator('.p1-overlay-box').count(), 'a selection really was drawn').toBeGreaterThan(0);

    await page.emulateMedia({ media: 'print' });
    await settle(page);
    // Asserted as *invisible*, not as absent. The overlay is hidden by the print stylesheet rather than
    // torn down, because entering print must not mutate editor state (M19 section 8) and re-rendering
    // the editor just to print it would be exactly that. Counting DOM nodes would be asserting the
    // wrong thing: the nodes are still there, and correctly so.
    for (const selector of ['.p1-overlay-box', '.p1-overlay-handle', '.p1-overlay-snap', '.overlay']) {
      const locator = page.locator(selector);
      if ((await locator.count()) > 0) {
        expect(await locator.first().isVisible(), `${selector} must not be visible when printing`).toBe(false);
      }
    }
  });

  test('the zoom transform and the clipping containers are neutralised', async ({ page }) => {
    await mountPrintThreePages(page);
    // Zoom in first: the transform is written inline by the viewport, so this is the case where a
    // stylesheet override without `!important` would silently do nothing.
    await page.locator('[data-zoom="in"]').click();
    await page.locator('[data-zoom="in"]').click();
    await settle(page);

    await page.emulateMedia({ media: 'print' });
    await settle(page);

    const view = await readPrintView(page);
    expect(view.pagesTransform, 'no zoom transform on the page stack').toBe('none');
    expect(view.bodyOverflow, 'the page must not be clipped to the window').toBe('visible');
    expect(view.surfaceOverflow, 'nor to the editor surface').toBe('visible');
  });

  test('pages are in document order, in flow, one page height apart', async ({ page }) => {
    await mountPrintThreePages(page);
    await page.emulateMedia({ media: 'print' });
    await settle(page);

    const view = await readPrintView(page);
    expect(view.pages.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);

    // Absolute stacking with a view gap is replaced by normal flow. If these were still absolute,
    // every page would sit at top 0 and print on top of each other.
    for (const p of view.pages) {
      expect(p.position, `${p.id} is in flow, not absolutely stacked`).toBe('relative');
    }
    const height = view.pages[0]!.height;
    expect(view.pages[1]!.top).toBeCloseTo(height, 1);
    expect(view.pages[2]!.top).toBeCloseTo(height * 2, 1);
  });

  test('every page but the last breaks, so no blank trailing sheet', async ({ page }) => {
    await mountPrintThreePages(page);
    await page.emulateMedia({ media: 'print' });
    await settle(page);

    const view = await readPrintView(page);
    expect(view.breakAfter.slice(0, -1)).toEqual(['page', 'page']);
    // The last one must not: `break-after: page` on the final page is the classic way to get N+1
    // sheets, and it is invisible in the DOM until you actually print.
    expect(view.breakAfter.at(-1), 'the last page does not force another sheet').toBe('auto');
  });
});

// ---------------------------------------------------------------------------
// Sheet geometry
// ---------------------------------------------------------------------------

test.describe('the sheet is the document page', () => {
  test('the injected @page rule matches the document size, unit and orientation', async ({ page }) => {
    await mountPrintThreePages(page);
    await settle(page);
    // 120x80mm portrait.
    expect(await readPrintView(page).then((v) => v.profileCss)).toBe('@page { size: 120mm 80mm; margin: 0; }');

    await mountPrintLandscapeInches(page);
    await settle(page);
    // 8.5x11in *landscape* -- the swap is the point of using a second fixture here.
    expect(await readPrintView(page).then((v) => v.profileCss)).toBe('@page { size: 11in 8.5in; margin: 0; }');
  });

  test('the profile follows a different document rather than going stale', async ({ page }) => {
    // The profile is derived from the model, so it has to be re-derived when the model changes.
    //
    // There is deliberately no page-size field to edit: page size is not authorable in the UI, it
    // arrives from the file or from New. So the honest test of staleness is the real path -- open a
    // document with a different sheet -- rather than an inspector edit that does not exist.
    await mountPrintThreePages(page);
    await settle(page);
    expect(await readPrintView(page).then((v) => v.profileCss)).toContain('120mm 80mm');

    await page.locator('[data-file-input="document"]').setInputFiles({
      name: 'other.p1doc',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          format: 'p1doc',
          formatVersion: 2,
          id: 'other',
          name: 'Other',
          pageSize: { width: 5, height: 7, unit: 'in', orientation: 'portrait' },
          assets: {},
          pages: [
            {
              id: 'p1',
              name: 'One',
              background: { type: 'solid', color: '#ffffff' },
              objects: [],
            },
          ],
        }),
        'utf8',
      ),
    });
    await settle(page);

    expect(
      await readPrintView(page).then((v) => v.profileCss),
      'the sheet tracked the newly opened document',
    ).toBe('@page { size: 5in 7in; margin: 0; }');
  });

  test('generated PDF: one sheet per document page, at the authored size', async ({ page }) => {
    await mountPrintThreePages(page);
    await settle(page);

    const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
    expect(pdf.subarray(0, 5).toString('latin1'), 'a real PDF was produced').toBe('%PDF-');

    const { pageCount, mediaBoxes } = readPdf(pdf);
    // Three document pages. The failure this catches: 5 sheets, from a default page margin per sheet
    // plus the stack gap becoming a break.
    expect(pageCount, 'exactly one sheet per document page').toBe(3);

    // 120mm x 80mm at 72 PDF points per inch: 120/25.4*72 = 340.157..., 80/25.4*72 = 226.771...
    const first = mediaBoxes[0] ?? '';
    expect(first).not.toBe('');
    const [, , width, height] = first.split(' ').map(Number) as [number, number, number, number];
    expect(Math.abs(width - 340.157)).toBeLessThan(1);
    expect(Math.abs(height - 226.771)).toBeLessThan(1);
  });

  test('generated PDF: a landscape inch page yields a landscape sheet', async ({ page }) => {
    await mountPrintLandscapeInches(page);
    await settle(page);

    const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
    const { pageCount, mediaBoxes } = readPdf(pdf);
    expect(pageCount, 'one page, one sheet').toBe(1);

    const [, , width, height] = (mediaBoxes[0] ?? '0 0 0 0').split(' ').map(Number) as [number, number, number, number];
    // 11in x 8.5in at 72pt/in: 792 x 612. Width greater than height is the orientation claim.
    expect(Math.abs(width - 792)).toBeLessThan(1);
    expect(Math.abs(height - 612)).toBeLessThan(1);
    expect(width, 'landscape means wider than tall').toBeGreaterThan(height);
  });
});

// ---------------------------------------------------------------------------
// Content survives
// ---------------------------------------------------------------------------

test.describe('document content survives print', () => {
  test('a dark page background is painted, not dropped', async ({ page }) => {
    await mountPrintThreePages(page);
    await page.emulateMedia({ media: 'print' });
    await settle(page);

    const view = await readPrintView(page);
    const second = view.pages.find((p) => p.id === 'p2');
    // Browsers drop backgrounds unless told not to; `print-color-adjust: exact` is the instruction.
    // #102030 is the fixture's authored page background.
    expect(second?.background, 'the authored page fill is still there').toBe('rgb(16, 32, 48)');
  });

  test('the print profile asks for backgrounds to be kept', async ({ page }) => {
    await mountPrintThreePages(page);
    await page.emulateMedia({ media: 'print' });
    await settle(page);

    // This asserts the *instruction*, and the distinction is not pedantry: `print-color-adjust` does
    // not change the computed `background-color`, so a test that only checked the colour would pass
    // with the instruction removed. And the instruction is genuinely the contract -- it is what makes
    // a browser print an authored fill rather than drop it as decoration.
    //
    // What cannot be verified from here is stated rather than assumed: Playwright's `printBackground`
    // is Chromium's *own* headless switch and does not consult `print-color-adjust`, so the observable
    // effect of this declaration can only be seen in a real print dialog. The next test covers what
    // *is* observable -- that the colour reaches the PDF at all.
    const adjust = await page.evaluate(() => {
      const read = (selector: string): string => {
        const element = document.querySelector<HTMLElement>(selector);
        return element === null ? '(absent)' : getComputedStyle(element).printColorAdjust;
      };
      return { page: read('.page'), objects: read('.objects'), object: read('.p1-object') };
    });
    expect(adjust.page).toBe('exact');
    expect(adjust.objects).toBe('exact');
    expect(adjust.object).toBe('exact');
  });

  test('the authored page colour reaches the generated PDF', async ({ page }) => {
    await mountPrintThreePages(page);
    await settle(page);

    // Asserted on the inflated content stream, as a colour operand, because that is the only thing in
    // the output that says "this fill was painted" rather than "this fill was in the DOM".
    const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
    expect(
      pdfContent(pdf),
      'the dark page background was painted, not dropped',
    ).toContain(DARK_PAGE_RGB_OPERAND);

    // And a document with no dark page must not acquire one: the operand above is specific to the
    // fixture, so this guards the assertion against becoming vacuous.
    await mountPrintLandscapeInches(page);
    await settle(page);
    const plain = await page.pdf({ printBackground: true, preferCSSPageSize: true });
    expect(pdfContent(plain), 'a document without that colour does not contain it').not.toContain(
      DARK_PAGE_RGB_OPERAND,
    );
  });

  test('objects keep their page-space geometry and their rotation', async ({ page }) => {
    await mountPrintThreePages(page);
    await page.emulateMedia({ media: 'print' });
    await settle(page);

    const view = await readPrintView(page);
    const byId = new Map(view.objects.map((o) => [o.id, o]));

    // Page 1's `inside` is at 20,20 80x40 with no rotation, so it is a straight geometry check.
    const inside = byId.get('inside')!;
    expect(inside.left).toBeCloseTo(20, 0);
    expect(inside.top).toBeCloseTo(20, 0);
    expect(inside.width).toBeCloseTo(80, 0);
    expect(inside.height).toBeCloseTo(40, 0);

    // The rotated one keeps a matrix. If print flattened or reset transforms this would be 'none'.
    const turned = byId.get('turned')!;
    expect(turned.transform, 'rotation survives').not.toBe('none');
    expect(turned.transform).toMatch(/matrix/);

    // And the group, positioned in page space rather than at the group's local origin.
    const kid = byId.get('kid')!;
    expect(kid.left).toBeGreaterThan(100);
  });

  test('content is still clipped to the page box', async ({ page }) => {
    await mountPrintThreePages(page);
    await page.emulateMedia({ media: 'print' });
    await settle(page);

    // The fixture's `bleed` rect starts at x=300 on a 453.5px-wide page, so it is half off the sheet.
    // The clip is `.page { overflow: hidden }`, which the print profile deliberately does not touch:
    // the one way to "rescue" that content would be to remove the clip, which would be a regression.
    const clip = await page.evaluate(() => {
      const element = document.querySelector<HTMLElement>('.page')!;
      return getComputedStyle(element).overflow;
    });
    expect(clip, 'page clipping is the same one rule as on screen').toBe('hidden');

    const bleed = (await readPrintView(page)).objects.find((o) => o.id === 'bleed')!;
    expect(bleed.left, 'and the element still extends past the page edge, so the clip is doing work').toBeCloseTo(
      300,
      0,
    );
  });

  test('the image is decoded before printing, so it is not an empty box', async ({ page }) => {
    await mountPrintThreePages(page);
    await settle(page);
    const image = await page.evaluate(() => {
      const element = document.querySelector<HTMLImageElement>('.page img');
      if (element === null) return null;
      return { complete: element.complete, w: element.naturalWidth };
    });
    expect(image, 'the fixture really has an image element').not.toBeNull();
    expect(image?.complete, 'and it has finished loading').toBe(true);
    expect(image?.w, 'with real intrinsic dimensions').toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// No side effects
// ---------------------------------------------------------------------------

test.describe('printing changes nothing', () => {
  test('the document, dirty state, selection and history are untouched', async ({ page }) => {
    await mountPrintThreePages(page);
    await settle(page);

    // Dirty the document, and make a selection, so "nothing changed" is a claim about a non-trivial
    // state rather than about an empty one.
    const spot = await page.evaluate(() => {
      const pageElement = document.querySelector<HTMLElement>('.page')!;
      const box = pageElement.getBoundingClientRect();
      return { x: box.left + 40, y: box.top + 30 };
    });
    await page.mouse.click(spot.x, spot.y);
    await settle(page);
    const dirtyBefore = await page.locator('[data-doc-state]').getAttribute('data-dirty');
    const nameBefore = await page.locator('[data-stat="name"]').innerText();
    const selectionBefore = await page.locator('.p1-overlay-group--selection').count();

    await page.emulateMedia({ media: 'print' });
    await settle(page);
    await page.emulateMedia({ media: 'screen' });
    await settle(page);

    expect(await page.locator('[data-doc-state]').getAttribute('data-dirty')).toBe(dirtyBefore);
    expect(await page.locator('[data-stat="name"]').innerText()).toBe(nameBefore);
    expect(await page.locator('.p1-overlay-group--selection').count()).toBe(selectionBefore);
  });

  test('the Export PDF button exists and does not dirty the document', async ({ page }) => {
    await mountPrintThreePages(page);
    await settle(page);

    const button = page.locator('[data-doc="export-pdf"]');
    await expect(button, 'the action is discoverable in the document toolbar').toBeVisible();

    // Clicking it calls `window.print()`, which in headless Chromium is a no-op that resolves
    // immediately. The point of the assertion is that reaching it changed nothing.
    const dirtyBefore = await page.locator('[data-doc-state]').getAttribute('data-dirty');
    await button.click();
    await settle(page);

    expect(await page.locator('[data-doc-state]').getAttribute('data-dirty')).toBe(dirtyBefore);
    // And it published the profile, which is the observable half of "export" available to a test.
    expect(await readPrintView(page).then((v) => v.profileCss)).toContain('120mm 80mm');
  });

  test('no undo entry is created by exporting', async ({ page }) => {
    await mountPrintThreePages(page);
    await settle(page);

    await page.locator('[data-doc="export-pdf"]').click();
    await settle(page);

    // Undo with nothing to undo must leave the button disabled, i.e. an empty history.
    const undo = page.locator('[data-doc="undo"], [data-history="undo"]').first();
    if ((await undo.count()) > 0) {
      expect(await undo.isDisabled(), 'export added no history entry').toBe(true);
    }
  });
});