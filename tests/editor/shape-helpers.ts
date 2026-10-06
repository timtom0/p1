import { expect, test, type Page } from '@playwright/test';

/**
 * Observable state for graphical objects.
 *
 * Every accessor here reads something the renderer or the editor actually produced. There
 * is no `window.__p1` hook and no second read of the model: if these read the wrong thing,
 * the tests fail rather than agreeing with a bug.
 *
 * The one place a *structural* claim needs more than a DOM read is `elementFromPoint`,
 * used deliberately and labelled as such — see `browserHitAt`.
 */

/** The object element for a node id, scoped to the document surface. */
export function shapeElement(page: Page, id: string) {
  return page.locator(`[data-objects] [data-oid="${id}"]`);
}

/**
 * The layout geometry Chromium reports for an object, in **document px**.
 *
 * `offsetWidth/Height` rather than `getBoundingClientRect` for a reason that is now
 * load-bearing: ADR 0004 established that the layout APIs are transform- and
 * zoom-invariant, so these equal the model's `width`/`height` even for a rotated object.
 * `getBoundingClientRect` would return the painted bounding box — 143.3 for a 200×50 box
 * rotated 30°, not 50 — and every assertion here is about the model.
 */
export async function layoutBox(page: Page, id: string) {
  return shapeElement(page, id).evaluate((el) => {
    if (!(el instanceof HTMLElement)) throw new Error('shape element is not an HTMLElement');
    const style = getComputedStyle(el);
    return {
      offset: [el.offsetWidth, el.offsetHeight] as const,
      client: [el.clientWidth, el.clientHeight] as const,
      cssWidth: style.width,
      cssHeight: style.height,
      backgroundColor: style.backgroundColor,
      borderRadius: style.borderTopLeftRadius,
      borderWidths: {
        top: style.borderTopWidth,
        right: style.borderRightWidth,
        bottom: style.borderBottomWidth,
        left: style.borderLeftWidth,
      },
      borderColor: style.borderTopColor,
      opacity: style.opacity,
      /** Present only on a line. */
      svgStroke: el.querySelector('svg > line')?.getAttribute('stroke') ?? null,
      svgStrokeWidth: el.querySelector('svg > line')?.getAttribute('stroke-width') ?? null,
      svgBox: (() => {
        const svg = el.querySelector('svg');
        return svg === null ? null : { width: svg.getAttribute('width'), height: svg.getAttribute('height') };
      })(),
    };
  });
}

/**
 * What *Chromium* considers to be at a page-local document point.
 *
 * `object:<id>`, `page`, `outside` or `nothing`. This is the browser's own answer, which
 * is a different question from the editor's — see `tests/editor/shapes.spec.ts`, "where
 * the editor and the browser agree, and where they do not".
 */
export async function browserHitAt(page: Page, docX: number, docY: number): Promise<string> {
  return page.evaluate(
    ({ x, y }) => {
      const pageElement = document.querySelector('[data-page]') as HTMLElement;
      const box = pageElement.getBoundingClientRect();
      const stack = document.querySelector('[data-pages]') as HTMLElement;
      const scale = new DOMMatrixReadOnly(getComputedStyle(stack).transform).a;
      if (x < 0 || y < 0 || x >= box.width / scale || y >= box.height / scale) return 'outside';

      const target = document.elementFromPoint(box.x + x * scale, box.y + y * scale);
      if (target === null) return 'nothing';
      // `closest` reaches the SVG island's `<line>` up to its owning object element, so
      // this answers "which object is on top" for every kind including a line.
      const object = target.closest('[data-objects] > *');
      if (object !== null) return `object:${object.getAttribute('data-oid')}`;
      return 'page';
    },
    { x: docX, y: docY },
  );
}

/** The selection outline the overlay drew, in screen px, as reported by its own dataset. */
export async function outlineGeometry(page: Page) {
  return page
    .locator('.p1-overlay-group--selection')
    .first()
    .evaluate((el) => ({
      rect: el.getAttribute('d'),
      x: el.getAttribute('data-x'),
      y: el.getAttribute('data-y'),
      width: el.getAttribute('data-w'),
      height: el.getAttribute('data-h'),
    }))
    .catch(() => null);
}

/** How many objects the page element currently has. */
export function objectCount(page: Page): Promise<number> {
  return page.locator('[data-objects] > *').count();
}

/** An inspector appearance field's **input**, addressed by its model path. */
export function propertyField(page: Page, path: string) {
  return page.locator(`[data-inspector] input[data-property="${path}"]`);
}

/** An inspector appearance field's value, exactly as shown. */
export function propertyValue(page: Page, path: string): Promise<string> {
  return propertyField(page, path).inputValue();
}

/**
 * Whether an inspector appearance field's **row** is currently shown.
 *
 * The row, not the input: a hidden row's input still exists and still holds a stale value,
 * so asking the input would report "visible" for a field the panel has decided does not
 * apply — which is the opposite of the thing worth asserting.
 */
export function propertyVisible(page: Page, path: string): Promise<boolean> {
  return page.locator(`[data-inspector] [data-property-row="${path}"]`).isVisible();
}

/**
 * Types a value into an inspector field and commits it.
 *
 * Enter rather than blur, because both commit but Enter is deterministic — a blur also
 * fires when a test moves focus elsewhere for an unrelated assertion, which is a
 * reliable way to get a history entry that the test did not mean to create.
 */
export async function commitProperty(page: Page, path: string, value: string): Promise<void> {
  const field = propertyField(page, path);
  await field.click();
  await field.fill(value);
  await field.press('Enter');
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

/** Arms a creation tool by clicking its toolbar button, as a user would. */
export async function armTool(page: Page, kind: 'rect' | 'ellipse' | 'line'): Promise<void> {
  await page.locator(`[data-shape="${kind}"]`).click();
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

/** Whether a toolbar tool button is drawn pressed. */
export function toolArmed(page: Page, selector: string): Promise<boolean> {
  return page.locator(selector).getAttribute('aria-pressed').then((v) => v === 'true');
}

export { expect, test };