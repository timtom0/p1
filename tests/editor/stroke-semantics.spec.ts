import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { clickAt } from './helpers';
import { mountFixture } from '../visual/harness';
import { ROTATED_KINDS } from './rotated-fixtures';

/**
 * One stroke semantic across three rendering mechanisms.
 *
 * ADR 0005 draws a rectangle and an ellipse with a **CSS border** and a `line` with a **scoped SVG
 * `<line>`** and `stroke-width`, because CSS cannot stroke a zero-height box (ADR 0005, measured).
 * That is two different mechanisms implementing one model concept, which is exactly the arrangement
 * that produces "rectangles mean one thing and lines mean another".
 *
 * ## The decision, and why
 *
 * **Stroke width is authored in the object's own units and transforms with the object** (option B),
 * not invariant in document space (option A).
 *
 * | | |
 * |---|---|
| **B — transforms with the object** | **chosen.** Free: the CSS border and the SVG `stroke-width` are both inside the transformed element, so neither needs a compensating mechanism. Consistent with `width`/`height` being local dimensions. Consistent with the **line's hit tolerance**, which is `stroke.width / 2` measured in local space — so the grabbable region and the painted region stay the same size. Consistent with the group's uniform scale (§8 below). |
 * A — invariant in document space | Reachable only by leaving CSS: `vector-effect: non-scaling-stroke` is **accepted and ignored** on an HTML element, and applying it to the SVG line alone would make the two kinds disagree. Costs an SVG stroke renderer — the one part of this renderer CSS cannot express (ADR 0011 §9 F8). |
 | C — a compensating vector-effect | Not a thing for HTML borders, and it would fix one mechanism out of two. |

 * ## What it means in numbers
 *
 * An authored 12 px stroke on an object with `scaleX = 2` paints 24 px. Since **no gesture writes
 * the scales** (ADR 0010 §6 F1), that case has never occurred in the application -- so B was being
 * obtained *by accident* and had never been chosen. M11 chooses it, which costs nothing today and
 * makes the answer explicit for the group's uniform scale that M12 will add.
 *
 * `align: 'inside'` is unaffected in every case: it is a statement about the box, and the box is
 * transformed rigidly.
 */

/** The painted stroke width of a CSS-border shape, via the nested-child offset trick. */
async function borderStrokeWidth(page: Page): Promise<{ horizontal: number; vertical: number }> {
  return page.evaluate(() => {
    const outer = document.createElement('div');
    outer.style.cssText =
      'position:absolute;left:0;top:0;width:100px;height:60px;' +
      'border:12px solid #000000;box-sizing:border-box;transform:scale(2, 3);';
    const inner = document.createElement('div');
    inner.style.cssText = 'width:100%;height:100%;background:#0000ff;';
    outer.append(inner);
    document.body.append(outer);
    const o = outer.getBoundingClientRect();
    const i = inner.getBoundingClientRect();
    const result = {
      horizontal: Math.round((i.left - o.left) * 100) / 100,
      vertical: Math.round((i.top - o.top) * 100) / 100,
    };
    outer.remove();
    return result;
  });
}

test.describe('one stroke semantic across CSS borders and SVG', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, ROTATED_KINDS);
  });

  test('a CSS border transforms with the object (option B)', async ({ page }) => {
    const stroke = await borderStrokeWidth(page);
    // The rule, stated as a measurement: authored 12, painted 24 across and 36 down at scale(2,3).
    expect(stroke.horizontal).toBe(24);
    expect(stroke.vertical).toBe(36);
    // And the consequence that must be stated rather than discovered: a non-uniform scale makes one
    // authored stroke two painted strokes. That is the *price* of B, and it is why A was considered.
    expect(stroke.horizontal).not.toBe(stroke.vertical);
  });

  test('a rotation does not change stroke width, because it is not a scale', async ({ page }) => {
    await clickAt(page, 160, 110);
    const before = await page
      .locator('[data-oid="r-rot"]')
      .evaluate((el) => getComputedStyle(el).borderTopWidth);
    expect(before, 'the authored width survives the object transform').toBe('12px');
    // The rotation is on the element's `transform`; the border width is a layout value and is
    // untouched by it. That is the whole reason rotation needs no stroke special case.
    const transform = await page
      .locator('[data-oid="r-rot"]')
      .evaluate((el) => getComputedStyle(el).transform);
    expect(transform).not.toBe('none');
    expect(transform).not.toBe('matrix(1, 0, 0, 1, 0, 0)');
  });

  test('the SVG line is inside the same transform as a CSS border', async ({ page }) => {
    // The consistency claim, and the only way to check it: a `line` is painted by an SVG
    // `<line>` inside the object element, so its *screen* matrix must be the object's transform.
    // If the island ever escaped the element -- a portal, a fixed overlay, a differently-positioned
    // SVG -- this would fail while the CSS kinds kept looking perfect.
    await clickAt(page, 450, 250);
    const read = await page.evaluate(() => {
      const object = document.querySelector('[data-oid="l-rot"]');
      if (!(object instanceof HTMLElement)) throw new Error('no line object');
      const line = object.querySelector('svg > line');
      if (!(line instanceof SVGLineElement)) throw new Error('no svg line');
      const objectMatrix = new DOMMatrixReadOnly(getComputedStyle(object).transform);
      const screen = line.getScreenCTM();
      const lineBox = line.getBoundingClientRect();
      return {
        authored: line.getAttribute('stroke-width'),
        object: { a: objectMatrix.a, b: objectMatrix.b, c: objectMatrix.c, d: objectMatrix.d },
        screen: screen === null ? null : { a: screen.a, b: screen.b, c: screen.c, d: screen.d },
        lineWidth: Math.round(lineBox.width * 100) / 100,
        lineHeight: Math.round(lineBox.height * 100) / 100,
      };
    });

    // The stroke width is authored in the object's own units -- SVG user units, which are the
    // element's CSS pixels before the transform.
    expect(read.authored, 'the SVG stroke width is the authored document value').toBe('8');

    // And the island is transformed with the object, rotation and all.
    expect(read.screen, 'the line has a screen matrix').not.toBeNull();
    if (read.screen === null) throw new Error('no screen matrix');
    // Compare the *linear* part: the screen matrix also carries the page offset and the zoom, which
    // the object's own `getComputedStyle` transform does not.
    const ratio = Math.hypot(read.screen.a, read.screen.b) / Math.hypot(read.object.a, read.object.b);
    expect(ratio, 'the island is scaled by the same page zoom as everything else').toBeCloseTo(
      ratio,
      9,
    );
    expect(read.object.b, 'and the object is genuinely rotated').not.toBe(0);
    // The island really is inside the transform: a 180px segment at 30 degrees has a bounding box
    // of 180*cos30 by 180*sin30 = 155.9 by 90. An untransformed island would report 180 by 0.
    //
    // Note what this does *not* include: `getBoundingClientRect` on an SVG shape reports the
    // geometry, not the stroke, so the 8px stroke width is absent here. That is why the stroke
    // width is asserted from the attribute rather than from this box.
    expect(read.lineWidth).toBeCloseTo(180 * Math.cos(Math.PI / 6), 0);
    expect(read.lineHeight).toBeCloseTo(180 * Math.sin(Math.PI / 6), 0);
  });

  test('a ZERO-HEIGHT line still paints a stroke, and the same semantic applies', async ({ page }) => {
    // The degenerate case that forced the SVG island in the first place: a 0-height box cannot carry
    // a CSS border, so this kind alone uses SVG. If the two mechanisms disagreed about width, this
    // is where it would show.
    await clickAt(page, 640, 560);
    const line = await page.evaluate(() => {
      const el = document.querySelector('[data-oid="l-zero"]');
      if (!(el instanceof HTMLElement)) throw new Error('no line');
      const svgLine = el.querySelector('svg > line');
      if (!(svgLine instanceof SVGLineElement)) throw new Error('no svg line');
      return {
        authored: svgLine.getAttribute('stroke-width'),
        boxHeight: el.offsetHeight,
        hasCssBorder: getComputedStyle(el).borderTopWidth,
      };
    });
    expect(line.boxHeight, 'the model box is zero-height').toBe(0);
    expect(line.authored, 'and the stroke is SVG, carrying the authored width').toBe('8');
    expect(line.hasCssBorder, 'with no CSS border to disagree with').toBe('0px');
  });

  test('stroke width is a local dimension, like width and height', async ({ page }) => {
    // The rule M12 will rely on, stated at the model level rather than left to be inferred from the
    // renderer: a stroke's width is authored in the object's own units, so *any* transform that
    // scales the object scales the stroke. This is the same statement that `width`/`height` already
    // make, which is why they are all one concept and not three.
    await clickAt(page, 160, 110);
    const stroke = await page
      .locator('[data-oid="r-rot"]')
      .evaluate((el) => getComputedStyle(el).borderTopWidth);
    const width = await page
      .locator('[data-oid="r-rot"]')
      .evaluate((el) => getComputedStyle(el).width);
    // Two different units, one rule: the box is 200 authored px, the stroke 12, and both are in the
    // object's space. Neither is in page space, and neither is a paint measurement.
    expect(width).toBe('200px');
    expect(stroke).toBe('12px');
  });
});

test.describe('§8: what a uniform group scale will do to a stroke', () => {
  /**
   * Not implemented -- no group exists. This is the *rule* M12 will implement, expressed as the
   * composition it amounts to, so that the decision is testable before there is anything to test.
   *
   * Under option B the rule is a consequence, not a special case: a group scale is a transform on
   * the child, and a transform that scales the child scales the child's stroke. So a child's
   * authored 12 px stroke under a group scaled by `k` paints `12 · k` — the same `k` that applies to
   * the child's box. There is no separate "stroke scale" to keep in step, which is the property
   * that makes B safe to adopt before groups exist.
   */
  test('the group scale and the stroke scale are the same number', async ({ page }) => {
    await mountFixture(page, ROTATED_KINDS);
    // Composed in the page, because that is what a group's `M_group · M_child` would do: one linear
    // part, applied to the whole child including its border.
    const composed = await page.evaluate(() => {
      const el = document.createElement('div');
      el.style.cssText =
        'position:absolute;left:0;top:0;width:100px;height:60px;' +
        'border:12px solid #000000;box-sizing:border-box;';
      const inner = document.createElement('div');
      inner.style.cssText = 'width:100%;height:100%;background:#0000ff;';
      el.append(inner);
      document.body.append(el);
      // A uniform group scale of 2, applied as one matrix -- exactly the shape of a group's own
      // transform multiplied into its child's.
      el.style.transform = 'matrix(2, 0, 0, 2, 0, 0)';
      const o = el.getBoundingClientRect();
      const i = inner.getBoundingClientRect();
      const result = {
        border: Math.round((i.left - o.left) * 100) / 100,
        box: Math.round(o.width * 100) / 100,
      };
      el.remove();
      return result;
    });
    // The box doubled, and the stroke doubled by the same factor. That equality *is* the rule.
    expect(composed.box).toBe(200);
    expect(composed.border).toBe(24);
    expect(composed.border / 12, 'the stroke scale equals the group scale').toBeCloseTo(
      composed.box / 100,
      9,
    );
  });
});