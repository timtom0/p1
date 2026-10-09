import { expect, test, type Page } from '@playwright/test';

/**
 * Shared helpers for the M2 editor suite.
 *
 * ## Everything is read from the DOM, deliberately
 *
 * There is no `window.__p1` test hook. Every assertion below reads something a user
 * can see — an overlay outline, an inspector field, a button label — because that is
 * the surface the tests are supposed to be pinning down.
 *
 * The one thing not directly visible is document space: the overlay is drawn in
 * *screen* space (§3.8), so its pixel values are zoom-dependent. The inspector is the
 * surface that reports model coordinates, so that is what geometry assertions use.
 */

/**
 * A document with geometry chosen so nothing overlaps and every edge is unambiguous.
 *
 * Two deliberate choices about units:
 *
 *  - `pageSize` is authored in **points**, so the page renders at 600×400px and every
 *    geometry assertion in this suite also exercises the unit conversion (§1.2).
 *  - Object transforms are in **CSS px**, because px is the model's internal unit and
 *    only `pageSize` crosses the authoring boundary. Conflating the two would make the
 *    fixture quietly disagree with the renderer.
 *
 * The inspector reports values in the page's authored unit, so 40px displays as
 * "30pt". `inspectorPx` below converts back.
 */
export const FIXTURE = `() => {
  const tf = (x, y, width, height, rotation = 0) => ({
    x, y, width, height, rotation, scaleX: 1, scaleY: 1,
  });
  const rect = (id, x, y, width, height, extra = {}) => ({
    id,
    type: 'shape',
    name: id,
    transform: tf(x, y, width, height),
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    shape: { kind: 'rect', cornerRadius: 0 },
    fill: { type: 'solid', color: '#4f7cff' },
    ...extra,
  });
  const text = (id, x, y, width, height, value) => ({
    id,
    type: 'textFrame',
    name: id,
    transform: tf(x, y, width, height),
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    text: { blocks: [{ kind: 'paragraph', runs: [{ text: value }] }] },
  });

  return {
    formatVersion: 1,
    id: 'fixture',
    name: 'Fixture',
    pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
    assets: {},
    pages: [{
      id: 'p1',
      name: '1',
      background: { type: 'solid', color: '#ffffff' },
      objects: [
        rect('alpha', 40, 40, 120, 80),
        rect('beta', 240, 40, 120, 80),
        rect('gamma', 40, 220, 120, 80),
        rect('locked-one', 240, 220, 120, 80, { locked: true }),
        text('copy', 240, 320, 200, 50, 'Hello world'),
      ],
    }],
  };
}`;

/** The fixture's authored unit, and how many CSS px one of it is worth. */
export const FIXTURE_UNIT = 'pt';
const PX_PER_UNIT = 96 / 72;

/** Object geometry in **document px**, which is the space every assertion works in. */
export const IDS = {
  alpha: { x: 40, y: 40, width: 120, height: 80 },
  beta: { x: 240, y: 40, width: 120, height: 80 },
  gamma: { x: 40, y: 220, width: 120, height: 80 },
  copy: { x: 240, y: 320, width: 200, height: 50 },
} as const;

/**
 * Where a page-local document point lands on screen, as a clickable point.
 *
 * Derived from the page element's own client rect plus the live stack scale, rather
 * than by re-deriving the stack layout (page height, gap, canvas margin). The DOM
 * already knows the answer; recomputing it here would be a second implementation
 * that could disagree with the first.
 */
export async function clientPointAt(
  page: Page,
  docX: number,
  docY: number,
  pageIndex = 0,
): Promise<{ x: number; y: number }> {
  const point = await page.evaluate(
    ({ x, y, index }) => {
      const pageElement = document.querySelectorAll('[data-page]')[index];
      if (!(pageElement instanceof HTMLElement)) throw new Error(`no page at index ${index}`);

      const stack = document.querySelector('[data-pages]');
      if (!(stack instanceof HTMLElement)) throw new Error('no page stack');
      const scale = new DOMMatrixReadOnly(getComputedStyle(stack).transform).a;

      const box = pageElement.getBoundingClientRect();
      return { x: box.x + x * scale, y: box.y + y * scale };
    },
    { x: docX, y: docY, index: pageIndex },
  );

  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error(`clientPointAt produced a non-finite point: ${JSON.stringify(point)}`);
  }
  return point;
}

/** Clicks a page-local document point. */
export async function clickAt(
  page: Page,
  docX: number,
  docY: number,
  modifiers: ('Shift' | 'Alt' | 'Control')[] = [],
): Promise<void> {
  const point = await clientPointAt(page, docX, docY);
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  await page.mouse.click(point.x, point.y);
  for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
  await settle(page);
}

/** Presses, moves through intermediate points, and releases — a real drag. */
export async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  modifiers: ('Shift' | 'Alt')[] = [],
  steps = 8,
): Promise<void> {
  const start = await clientPointAt(page, from.x, from.y);
  const end = await clientPointAt(page, to.x, to.y);

  for (const modifier of modifiers) await page.keyboard.down(modifier);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps });
  await page.mouse.up();
  for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
  await settle(page);
}

/** Presses and holds, so a test can inspect a gesture mid-flight. */
export async function beginDrag(
  page: Page,
  from: { x: number; y: number },
  modifiers: ('Shift' | 'Alt')[] = [],
): Promise<void> {
  const start = await clientPointAt(page, from.x, from.y);
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
}

/** Moves a held drag to a document point. */
export async function moveDragTo(
  page: Page,
  to: { x: number; y: number },
  steps = 6,
): Promise<void> {
  const end = await clientPointAt(page, to.x, to.y);
  await page.mouse.move(end.x, end.y, { steps });
  await settle(page);
}

/** Releases a held drag and releases modifiers. */
export async function endDrag(
  page: Page,
  modifiers: ('Shift' | 'Alt')[] = [],
): Promise<void> {
  await page.mouse.up();
  for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
  await settle(page);
}

/**
 * Drags with snapping suppressed, by holding Alt **after** the press.
 *
 * ## Why the modifier goes down late
 *
 * Alt is not free for the whole gesture. At pointer-down it means "select the containing group instead of
 * the leaf" (`selectableIdFor`), so passing `['Alt']` to {@link drag} would change *what is grabbed* — which
 * is exactly wrong for a test that grabs a child inside a transformed group and needs that child.
 *
 * ADR 0017 §4 resolves this by splitting Alt's two uses in time: it is read at pointer-down to choose what is
 * grabbed and during the drag to choose whether to snap. Pressing first and holding Alt afterwards is the
 * interaction the ADR describes ("the user presses to grab the leaf, then holds Alt to drag it freely"), so
 * this helper is also the honest way to test that the split works.
 *
 * ## Why a test would want this
 *
 * Snapping is now part of every move gesture (ADR 0017), so a drag that happens to pass within the threshold
 * of a page edge or another object legitimately lands somewhere other than the pointer. Tests about
 * *movement* — that a group moves every child, that a nested child follows the page axis, that a rotated
 * object gains no shear — are not about snapping, and their exact-delta assertions should keep measuring
 * movement. Suppressing the snap isolates the property under test instead of quietly widening it.
 */
export async function dragWithoutSnapping(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 8,
): Promise<void> {
  await beginDrag(page, from);
  await page.keyboard.down('Alt');
  await moveDragTo(page, to, steps);
  await endDrag(page, ['Alt']);
}

/**
 * Waits for the app to stop changing.
 *
 * The app renders synchronously inside its event handlers, so this is only here to
 * let Playwright flush a frame before reading the DOM. A fixed short wait beats
 * `expect.poll` here because there is no asynchronous work to wait *for* — adding a
 * timeout-based poll would imply there is.
 */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

// ---------------------------------------------------------------------------
// Observable state
// ---------------------------------------------------------------------------

/** How many objects are selected, as drawn by the overlay. */
export function selectionCount(page: Page): Promise<number> {
  return page.locator('.p1-overlay-group--selection').count();
}

/**
 * Ids of the selected objects, from the overlay.
 *
 * The overlay's per-object marker is `data-for`, not `data-oid`: `data-oid` stamps the
 * *document* object, and an earlier version wrote it on the overlay group too, so a bare
 * `[data-oid="x"]` matched one element in the document and one in the chrome.
 */
export function selectionIds(page: Page): Promise<string[]> {
  return page.locator('.p1-overlay-group--selection').evaluateAll((groups) =>
    groups.map((group) => (group as HTMLElement).dataset['for'] ?? '?'),
  );
}

/**
 * The first selected object id, or `null` when nothing is selected.
 *
 * The single-id convenience, for tests that select one object and want to name it. Reading
 * `null` for "nothing selected" is what makes a failed click fail as a failed click rather than
 * as a comparison against `undefined`.
 */
export function firstSelectionId(page: Page): Promise<string | null> {
  return selectionIds(page).then((ids) => ids[0] ?? null);
}

/** The id of the object the overlay is showing a hover outline for, if any. */
export function hoverId(page: Page): Promise<string | null> {
  return page
    .locator('.p1-overlay-group--hover')
    .evaluateAll((groups) => {
      const first = groups[0] as HTMLElement | undefined;
      return first === undefined ? null : (first.dataset['for'] ?? null);
    });
}

/** The inspector's current value for a field, exactly as shown to the user. */
export function inspectorValue(page: Page, field: string): Promise<string> {
  return page.locator(`[data-inspector] [data-field="${field}"]`).inputValue();
}

/**
 * The inspector's value for a field, converted to **document px**.
 *
 * The field shows the authored unit ("40pt"), but every assertion in this suite is
 * written in document px. Parsing here rather than in each test keeps the unit
 * boundary in one place — and makes it visible, since the conversion cannot be
 * forgotten.
 */
export async function inspectorPx(page: Page, field: string): Promise<number> {
  const raw = await inspectorValue(page, field);
  const match = /^(-?[\d.]+)([a-z]*)$/i.exec(raw.trim());
  if (match === null || match[1] === undefined) {
    throw new Error(`Inspector field "${field}" is not a length: ${JSON.stringify(raw)}`);
  }
  const unit = match[2] ?? FIXTURE_UNIT;
  if (unit !== FIXTURE_UNIT) {
    throw new Error(`Inspector field "${field}" is in ${unit}, not the fixture's ${FIXTURE_UNIT}`);
  }
  return Number.parseFloat(match[1]) * PX_PER_UNIT;
}

/** The inspector's `data-state`, distinguishing empty from mixed from single. */
export function inspectorState(page: Page): Promise<string | null> {
  return page
    .locator('[data-inspector]')
    .evaluate((el) => (el as HTMLElement).dataset['state'] ?? null);
}

/** Placeholder text, which is how the inspector says "Mixed". */
export function inspectorPlaceholder(page: Page, field: string): Promise<string> {
  return page.locator(`[data-inspector] [data-field="${field}"]`).getAttribute('placeholder').then((v) => v ?? '');
}

/** Label on the undo button, e.g. "Undo Move 1 object". */
export function undoLabel(page: Page): Promise<string> {
  return page.locator('[data-edit="undo"]').textContent().then((t) => t ?? '');
}

export function redoLabel(page: Page): Promise<string> {
  return page.locator('[data-edit="redo"]').textContent().then((t) => t ?? '');
}

export function undoDisabled(page: Page): Promise<boolean> {
  return page.locator('[data-edit="undo"]').isDisabled();
}

export function redoDisabled(page: Page): Promise<boolean> {
  return page.locator('[data-edit="redo"]').isDisabled();
}

/** Which handles the overlay drew for the current selection. */
export function handleCount(page: Page): Promise<number> {
  return page.locator('.p1-overlay-group--selection .p1-overlay-handle').count();
}

export function rotateHandleVisible(page: Page): Promise<boolean> {
  return page.locator('.p1-overlay-rotate').isVisible();
}

/**
 * The text a frame currently shows, which is the model's projection of it.
 *
 * Scoped to `[data-objects]` because the overlay layer carries `data-oid` too, and an
 * unscoped selector would match the chrome instead of the document.
 */
export function frameText(page: Page, id: string): Promise<string> {
  return page
    .locator(`[data-objects] [data-oid="${id}"] .p1-text-content`)
    .textContent()
    .then((t) => (t ?? '').trim());
}

/** Whether the frame is currently inside a text-editing session. */
export function frameIsEditing(page: Page, id: string): Promise<boolean> {
  return page
    .locator(`[data-objects] [data-oid="${id}"]`)
    .evaluate((el) => (el as HTMLElement).dataset['editing'] === 'true');
}

/** Puts the caret at the end of a frame's text and focuses it. */
export async function focusFrameCaretEnd(page: Page, id: string): Promise<void> {
  await page.locator(`[data-objects] [data-oid="${id}"] .p1-text-content`).click();
  await page.keyboard.press('End');
  await settle(page);
}

/**
 * Re-exported so a spec imports Playwright's `test`/`expect` and this project's
 * helpers from one place — which also makes the boundary obvious: nothing here
 * defines a test.
 */
export { expect, test };

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/**
 * Waits for an image to have genuinely decoded, or fails naming what it found instead.
 *
 * ## Why this exists, and why it is not optional
 *
 * Measured (ADR 0006 PROBE Z): an `<img>` with no `src`, an unreachable URL, or non-image
 * data still occupies its full authored box, is still hit-testable across all of it, and
 * still reports `complete === true`. So "an element with `data-type=image` exists" passes
 * against a completely broken image, and every geometry assertion after it would be about
 * an empty box.
 *
 * `data-asset-state` is the only thing that distinguishes the two, and it is *rendering
 * output*, which is exactly why it has to be asked for rather than assumed.
 */
export async function waitForAssetLoaded(page: Page, oid: string, timeout = 8000): Promise<void> {
  try {
    await page.waitForFunction(
      (id) => {
        const el = document.querySelector(`[data-oid="${id}"]`);
        return el instanceof HTMLElement && el.getAttribute('data-asset-state') === 'loaded';
      },
      oid,
      { timeout },
    );
  } catch (cause) {
    const found = await page.evaluate((id) => {
      const el = document.querySelector(`[data-oid="${id}"]`) as HTMLElement | null;
      const img = el?.querySelector('img') as HTMLImageElement | null;
      return {
        present: el !== null,
        state: el?.getAttribute('data-asset-state') ?? null,
        natural: img === null ? null : [img.naturalWidth, img.naturalHeight],
        complete: img?.complete ?? null,
      };
    }, oid);
    throw new Error(
      `Image "${oid}" never decoded. Found: ${JSON.stringify(found)}. ` +
        `An assertion about its geometry would have passed against an empty box.`,
      { cause },
    );
  }
}

/** Waits for the *first* image on the page to decode. */
export async function waitForAnyAssetLoaded(page: Page, timeout = 8000): Promise<void> {
  try {
    await page.waitForFunction(
      () =>
        document.querySelector('[data-type="image"][data-asset-state="loaded"]') !== null,
      undefined,
      { timeout },
    );
  } catch (cause) {
    const found = await page.evaluate(() =>
      [...document.querySelectorAll('[data-type="image"]')].map((el) => ({
        oid: (el as HTMLElement).dataset['oid'],
        state: el.getAttribute('data-asset-state'),
      })),
    );
    throw new Error(
      `No image reached data-asset-state="loaded". Found: ${JSON.stringify(found)}.`,
      { cause },
    );
  }
}

/** Waits for an image to have finished *failing*, which is also a settled state. */
export async function waitForAssetSettled(page: Page, oid: string, timeout = 8000): Promise<void> {
  try {
    await page.waitForFunction(
      (id) => {
        const el = document.querySelector(`[data-oid="${id}"]`);
        const state = el?.getAttribute('data-asset-state');
        return state === 'loaded' || state === 'error';
      },
      oid,
      { timeout },
    );
  } catch (cause) {
    const found = await page.evaluate(
      (id) => document.querySelector(`[data-oid="${id}"]`)?.getAttribute('data-asset-state') ?? null,
      oid,
    );
    throw new Error(`Image "${oid}" never settled (state was ${JSON.stringify(found)}).`, {
      cause,
    });
  }
}