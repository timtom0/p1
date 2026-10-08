import { expect, test, type Page } from '@playwright/test';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Test fixtures and helpers for the renderer verification suite.
 *
 * Two ways to reach a document:
 *
 *  - `mountSample()` loads the real app, which renders `createSampleDocument()`
 *    through the real reconciler. This is the honest end-to-end path.
 *
 *  - `mountFixture()` injects an explicit document via `addInitScript`, which the
 *    app's composition root consumes. Used where a test needs a specific geometry
 *    (overhang for clipping, overlapping rects for paint order) that the one
 *    shipped sample document cannot express.
 *
 * The injected path deliberately reuses the app's own composition root rather than
 * reimplementing rendering, so a fixture can never pass while the real app fails.
 *
 * ## Readiness
 *
 * `waitForApp` waits for the app's own `boot:complete` step. An earlier version waited on
 * `readout.value !== ''` plus a `[data-page]` element, documenting the readout as "only populated
 * after `project()` and `viewport.fit()` run -- a reliable end-of-boot marker". That was false:
 * `index.html` ships the readout pre-populated with `100%`. The term was therefore always true and
 * contributed nothing while looking like corroboration, and it made a boot that never *started*
 * indistinguishable from one that started and stalled. See `src/ui/boot-diagnostics.ts`.
 *
 * ## Zoom normalisation
 *
 * The app boots with `viewport.fit()`, so a fresh page is *not* at 1:1. Every
 * geometry assertion in this suite states absolute document pixels, which is only
 * meaningful at 1:1. Both mount helpers therefore reset zoom to actual size by
 * default; a test that wants another level opts in via `zoom`.
 */

export interface MountOptions {
  /**
   * Target zoom, as a fraction of actual size. Defaults to 1. Must be one of
   * `ZOOM_LEVELS`: the toolbar steps by a fixed ratio, so intermediate values
   * are not reachable through the UI.
   */
  zoom?: number;
}

/**
 * Reachable zoom levels, as exact fractions of actual size.
 *
 * The toolbar only steps by a fixed ratio, so not every level is reachable: 1.25³
 * is 1.953125, and asking for exactly 2 would loop forever between 1.953125 and
 * 2.4414. Tests pick from this ladder rather than naming arbitrary values.
 */
export const ZOOM_LEVELS = {
  '100%': 1,
  '125%': 1.25,
  '156%': 1.5625,
  '195%': 1.953125,
  '80%': 0.8,
  '64%': 0.64,
  '51%': 0.512,
  '41%': 0.4096,
} as const;

export type ZoomLevelName = keyof typeof ZOOM_LEVELS;

/** A4 portrait in px. 210mm × 297mm at 96px/in. */
export const A4_PX = { width: 793.7007874015748, height: 1122.5196850393702 };

/** Padding the viewport leaves on *each* side of a fitted page, in screen px. */
export const FIT_PADDING = 48;

/**
 * Waits until the app has booted and performed its first render.
 *
 * Readiness is signalled by the zoom readout being populated, which only happens after
 * `project()` and `viewport.fit()` run — a reliable end-of-boot marker. Waiting on object
 * count instead would hang on a legitimately empty document.
 *
 * The second condition is a *guard*, not the readiness signal: if the readout is
 * populated there must be at least one page element. Requiring both means a boot that
 * half-completes fails here, naming itself, rather than three calls later as
 * "no page at index 0" — which points at the test's geometry and not at the boot.
 *
 * That guard was added after two full-suite runs each lost one test to a boot that never
 * completed, in two different files, at roughly 1 in 150. It could not be reproduced in
 * isolation (65 deliberate boots, none), which points at the dev server under sustained
 * load rather than at the application — but "probably the environment" is not a
 * diagnosis. So a failure here now reports the page's own errors, which is the only
 * thing that would settle it next time.
 */
/**
 * The boot budget. Fixed by policy and not tuned: it exists so a stalled boot is
 * reported rather than waited on forever.
 */
export const BOOT_TIMEOUT_MS = 15_000;

/**
 * Waits until the app has booted.
 *
 * Readiness is the product's own `boot:complete` step, published on `__P1_BOOT__`.
 * It cannot be half-true, which matters because the check it replaced could be.
 *
 * `timeoutMs` is injectable so tests can exercise the failure path -- which is the
 * path this milestone exists to understand -- without spending the real 15s
 * budget on every such test. Production callers take the default.
 */
export async function waitForApp(page: Page, timeoutMs: number = BOOT_TIMEOUT_MS): Promise<void> {
  const errors: string[] = [];
  const record = (message: string): void => {
    errors.push(message);
  };
  page.on('pageerror', (error) => record(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') record(`console.error: ${message.text()}`);
  });
  page.on('requestfailed', (request) =>
    record(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`),
  );

  try {
    // Readiness is the **app's own** `boot:complete` step, not a conjunction of DOM side-effects.
    //
    // The old condition required `readout.value !== ''`, documented here as "only happens after
    // `project()` and `viewport.fit()` run — a reliable end-of-boot marker". **That was false.**
    // `index.html` ships `<output data-zoom-readout>100%</output>` as static markup, so the value was
    // `"100%"` before a single line of application JavaScript ran. The condition was therefore always
    // half-true, and its second half — a `[data-page]` element — was the only thing doing any work.
    //
    // That is not a cosmetic correction. The one recorded occurrence of this failure reported
    // `readout: "100%"` alongside `pages: 0`, which I first read as a contradiction and built a whole
    // diagnosis on: an app that had painted chrome but no document. The trace settled it — the module
    // graph had loaded 23 of its ~49 modules and then stalled, so `app.ts` had never been evaluated
    // and the readout was the HTML default. A readiness check that cannot tell "booted" from "never
    // started" is the defect that made this undiagnosable, so the predicate now waits on a signal the
    // product sets itself, at one step, which cannot be half-true.
    await page.waitForFunction(
      () => {
        const surface = (window as unknown as Record<string, unknown>)['__P1_BOOT__'] as
          | { read: () => { timeline: { step: string }[] } }
          | undefined;
        return (
          surface !== undefined &&
          surface.read().timeline.some((entry) => entry.step === 'boot:complete')
        );
      },
      undefined,
      { timeout: timeoutMs },
    );
  } catch (cause) {
    const state = await page
      .evaluate(() => {
        const surface = (window as unknown as Record<string, unknown>)['__P1_BOOT__'] as
          | { read: () => unknown }
          | undefined;
        return {
          pages: document.querySelectorAll('[data-page]').length,
          objects: document.querySelectorAll('[data-objects]').length,
          readout:
            (document.querySelector('[data-zoom-readout]') as HTMLOutputElement | null)?.value ??
            null,
          // The product's own account of what it did during boot. Present only if the module loaded.
          boot: surface === undefined ? 'no boot surface' : (surface.read() ?? null),
        };
      })
      .catch(() => null);
    // Appended, never overwritten.
    //
    // Playwright wipes `test-results/` at the start of each run, so a snapshot of the one run that
    // reproduced this is gone by the time anyone goes looking -- which is exactly what happened: the
    // error-context file from the real reproduction was overwritten by later clean runs before it was
    // read. This log is append-only and survives, so the *first* failure is preserved no matter how
    // many clean runs follow.
    const record = JSON.stringify({ when: new Date().toISOString(), state, errors });
    try {
      appendFileSync(join(process.cwd(), 'test-results', 'boot-failures.jsonl'), `${record}\n`);
    } catch {
      // Recording is best-effort and must never replace the real failure with a different one.
    }
    // The message names which of the two states was reached, because they have different causes and a
    // single message made them indistinguishable: a module graph that stalled before evaluating
    // `app.ts`, and a boot that started and did not finish.
    const surfaceMissing =
      typeof state === 'object' && state !== null && state.boot === 'no boot surface';
    throw new Error(
      (surfaceMissing
        ? 'The app module never evaluated: the page loaded but the module graph did not finish.\n'
        : `The app started but did not reach boot:complete within ${timeoutMs / 1000}s.\n`) +
        `  page state: ${JSON.stringify(state)}\n` +
        `  page errors: ${errors.length === 0 ? '(none reported)' : errors.slice(0, 8).join('\n    ')}`,
      { cause },
    );
  }

  await page.evaluate(() => document.fonts.ready);
}

async function readZoomValue(page: Page): Promise<number> {
  const value = await page
    .locator('[data-zoom-readout]')
    .evaluate((el) => (el as HTMLOutputElement).value);
  return Number.parseInt(value.replace('%', ''), 10) / 100;
}

/**
 * Drives zoom to a target level through the real toolbar buttons, so the test
 * exercises the same path a user would. Steps by ZOOM_STEP because that is what
 * the controls do — there is no "set zoom to an arbitrary value" affordance in
 * the UI yet, which is a fair reflection of M0's scope.
 */
async function setZoomByStepping(page: Page, target: number): Promise<void> {
  const tolerance = 0.005;
  let guard = 0;

  while (Math.abs((await readZoomValue(page)) - target) > tolerance) {
    if (guard > 40) {
      throw new Error(
        `Could not reach zoom ${target}; stuck at ${await readZoomValue(page)}. ` +
          `Only toolbar-stepped levels are reachable — see ZOOM_LEVELS.`,
      );
    }
    const current = await readZoomValue(page);
    const direction = target > current ? 'in' : 'out';
    await page.locator(`[data-zoom="${direction}"]`).click();
    guard += 1;
  }
}

/** Resets to 1:1, then steps to the requested level. */
async function normaliseZoom(page: Page, options: MountOptions): Promise<void> {
  await page.locator('[data-zoom="actual"]').click();
  if (options.zoom !== undefined && options.zoom !== 1) {
    await setZoomByStepping(page, options.zoom);
  }
  await page.waitForTimeout(20);
}

export async function mountSample(page: Page, options: MountOptions = {}): Promise<void> {
  await page.goto('/');
  await waitForApp(page);
  await normaliseZoom(page, options);
  await page.evaluate(() => {
    (document.querySelector('[data-zoom-readout]') as HTMLElement).style.visibility = 'hidden';
  });
}

/**
 * Mounts an explicit document. `source` is a function expression evaluated in the
 * page before the app boots; it must be a factory returning a document.
 */
export async function mountFixture(
  page: Page,
  source: string,
  options: MountOptions = {},
): Promise<void> {
  await page.addInitScript(`window.__P1_FIXTURE__ = (${source});`);
  await page.goto('/');
  await waitForApp(page);
  await normaliseZoom(page, options);
  await page.evaluate(() => {
    (document.querySelector('[data-zoom-readout]') as HTMLElement).style.visibility = 'hidden';
  });
}

/**
 * Like `mountFixture`, but leaves the app's boot-time fit alone.
 *
 * For multi-page stacks this is usually what a test wants: fitting a 4-page stack
 * gives a zoom well below 1, and forcing 1:1 would push most of the document out of
 * the viewport. Tests that assert absolute document pixels should still use
 * `mountFixture`.
 */
export async function mountFixtureAsBooted(page: Page, source: string): Promise<void> {
  await page.addInitScript(`window.__P1_FIXTURE__ = (${source});`);
  await page.goto('/');
  await waitForApp(page);
  await page.evaluate(() => {
    (document.querySelector('[data-zoom-readout]') as HTMLElement).style.visibility = 'hidden';
  });
}

/**
 * Selector for a single page element.
 *
 * Since M1 a document has many pages, so `[data-page]` matches several elements and
 * Playwright's strict mode rejects a bare use. Every helper here therefore targets
 * one page explicitly via `pageAt`.
 */
export function pageAt(page: Page, index = 0) {
  return page.locator('[data-page]').nth(index);
}

/** How many page elements are mounted. */
export function pageCount(page: Page): Promise<number> {
  return page.locator('[data-page]').count();
}

/**
 * Screenshots one page's exact border box.
 *
 * Two constraints shape this:
 *
 *  1. Not a locator screenshot. An A4 page is 1122px tall, so Playwright has to
 *     scroll-and-stitch, which took over 30s per capture and timed the suite out.
 *
 *  2. Never `fullPage`. That expands the *document*, but the editor scrolls
 *     internally (`.viewport` is the scroll container), so the document is only
 *     as tall as the window. A clip taller than the document gets silently padded
 *     with white — which produced an all-white `page-clip` baseline that looked
 *     like a passing test while showing none of the content.
 *
 * Instead the browser viewport is sized (see playwright.config.ts) so a whole A4
 * page at 1:1 fits on screen, and the capture is a single clipped viewport shot.
 */
export async function screenshotPage(page: Page, index = 0): Promise<Buffer> {
  const box = await pageAt(page, index).boundingBox();
  if (box === null) throw new Error('Page has no bounding box');

  // The clip is taken in *client* coordinates, so any part of the page scrolled
  // out of the viewport would be captured as whatever is behind it — app chrome,
  // rulers, the neighbouring page. That silently produced a baseline containing
  // the toolbar. Refuse rather than record a misleading image.
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error('No viewport size');
  const fitsVertically = box.y >= 0 && box.y + box.height <= viewport.height;
  const fitsHorizontally = box.x >= 0 && box.x + box.width <= viewport.width;
  if (!fitsVertically || !fitsHorizontally) {
    throw new Error(
      `Page ${index} (${Math.round(box.width)}×${Math.round(box.height)} at ` +
        `${Math.round(box.x)},${Math.round(box.y)}) does not fit the ` +
        `${viewport.width}×${viewport.height} viewport. ` +
        `The clip would capture chrome instead of the page. ` +
        `Zoom out, or increase VIEWPORT in playwright.config.ts.`,
    );
  }

  return page.screenshot({
    clip: {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    },
    animations: 'disabled',
  });
}

/**
 * Compares the page against a stored baseline.
 *
 * `expect(buffer).toMatchSnapshot` rather than `expect(locator).toHaveScreenshot`
 * for the speed reason above.
 */
export async function expectPageScreenshot(page: Page, name: string, index = 0): Promise<void> {
  await expect(await screenshotPage(page, index)).toMatchSnapshot(`${name}.png`);
}

/**
 * Asks the browser what is under a page-local document coordinate.
 *
 * Returns one of:
 *   `object:<id>` — that object is topmost there
 *   `page`         — inside the page, no object under the point
 *   `outside`      — beyond the page's bounds
 *   `nothing`      — no element there at all (e.g. scrolled out of the viewport)
 *
 * This replaces screenshot-and-decode pixel probing, which cost ~35s per capture
 * in this environment. It is also a better assertion: for positioned elements the
 * browser's hit-test order *is* its paint order, and `overflow: hidden` clips hit
 * targets exactly as it clips painting. So one call answers both "is this object
 * clipped away here?" and "which object is on top here?" without a baseline file.
 *
 * The screenshot baselines remain in place as the complementary visual check.
 */
export async function hitTestAt(page: Page, docX: number, docY: number): Promise<string> {
  return page.evaluate(
    ({ x, y }) => {
      const pageElement = document.querySelector('[data-page]') as HTMLElement;
      const box = pageElement.getBoundingClientRect();
      // Recover the live scale from the stack's applied transform, so this works at
      // any zoom. Pages no longer carry a transform themselves.
      const stack = document.querySelector('[data-pages]') as HTMLElement;
      const scale = new DOMMatrixReadOnly(getComputedStyle(stack).transform).a;
      const screenX = box.x + x * scale;
      const screenY = box.y + y * scale;

      // Page-local bounds, in document px.
      const width = box.width / scale;
      const height = box.height / scale;
      if (x < 0 || y < 0 || x >= width || y >= height) return 'outside';

      const target = document.elementFromPoint(screenX, screenY);
      if (target === null) return 'nothing';

      const object = target.closest('[data-objects] > *');
      if (object !== null) return `object:${object.getAttribute('data-oid')}`;
      return 'page';
    },
    { x: docX, y: docY },
  );
}

/**
 * The page element. Used for `toHaveScreenshot` baselines.
 *
 * Safe now that the page carries no box-shadow (the paper edge moved to the
 * canvas), so a locator screenshot is confined to the page's own paint.
 */
export function pageRegion(page: Page, index = 0) {
  return pageAt(page, index);
}

/** Reads computed geometry straight from the browser's layout engine. */
export async function measure(page: Page, selector: string) {
  // `.first()` throughout: since M1 `[data-page]` matches every page, and these
  // assertions are about a single page's box.
  return page.locator(selector).first().evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      transform: style.transform,
      transformOrigin: style.transformOrigin,
      overflow: style.overflow,
      backgroundColor: style.backgroundColor,
    };
  });
}

/**
 * The page's *untransformed layout size* — i.e. document px, independent of zoom.
 *
 * Uses `getBoundingClientRect` divided by the live scale rather than
 * `offsetWidth`, because `offsetWidth` is rounded to an integer and would hide the
 * sub-pixel precision that the unit conversion is supposed to preserve.
 */
export async function measurePageLayout(page: Page, index = 0) {
  const zoom = await readZoom(page);
  const element = pageAt(page, index);
  const rect = await element.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  });
  return {
    transform: await page.locator('[data-pages]').evaluate((el) => (el as HTMLElement).style.transform),
    zoom,
    width: rect.width / zoom,
    height: rect.height / zoom,
    offsetWidth: await element.evaluate((el) => (el as HTMLElement).offsetWidth),
  };
}

/**
 * Current zoom, read from the transform the viewport actually wrote.
 *
 * The transform lives on the page *stack*, not on any individual page — since M1
 * there are many pages and exactly one transformed element.
 */
export async function readZoom(page: Page): Promise<number> {
  const transform = await page
    .locator('[data-pages]')
    .evaluate((el) => (el as HTMLElement).style.transform);
  const match = /scale\(([\d.]+)\)/.exec(transform);
  if (match === null || match[1] === undefined) {
    throw new Error(`Could not read zoom from stack transform: "${transform}"`);
  }
  return Number.parseFloat(match[1]);
}

/** Zoom as reported by the toolbar, i.e. the controller's own state. */
export async function readZoomReadout(page: Page): Promise<number> {
  return readZoomValue(page);
}

export { expect, test };