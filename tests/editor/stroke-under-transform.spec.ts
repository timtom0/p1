import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { mountFixture } from '../visual/harness';
import { SHAPES } from './shape-fixtures';

/**
 * What happens to a stroke when the object's transform stops being a rotation.
 *
 * ADR 0011 §9 gates the affine decision on this, because every stroke in the project is a CSS
 * `border` on the object element (`render/paint.ts`), and a border is *inside* the element's box --
 * so it is transformed along with the box. Three candidate semantics were on the table:
 *
 * - **A. invariant in document space** — a 12 px stroke is 12 px whatever the object does;
 * - **B. transformed with the object** — the stroke scales and shears like everything else;
 * - **C. geometrically transformed, compensated with `vector-effect`** — SVG only.
 *
 * Measured, with a nested pair rather than a lone element: a border does not change the parent's
 * rect, but a child that starts at the padding edge does, so *the offset from the parent's painted
 * edge to the child's is the border's painted width*.
 *
 * | | `innerOffsetLeft` | `innerOffsetTop` |
 * |---|---|---|
 * | no transform | **12** | **12** |
 * | `scale(2, 3)` | **24** | **36** |
 * | `matrix(1, 0.6, 0, 1, 0, 0)` | 12 | **19.2** |
 *
 * Three conclusions, and the third is why this is a gate rather than a footnote:
 *
 * 1. **B is what CSS does.** The border scales with the element, for free.
 * 2. **A is not available without abandoning the projection.** It needs `outline` or `box-shadow`
 *    (which do not paint inside the box) or SVG with `vector-effect="non-scaling-stroke"` -- the
 *    last of which contradicts the project's "HTML + CSS is the rendering backbone" premise for
 *    this object kind.
 * 3. **Under a non-uniform scale the stroke stops being a stroke.** One authored width becomes 24
 *    on one axis and 36 on the other, and under shear the painted extent is 19.2 with no single
 *    "width" at all. Neither shape has an authored meaning yet.
 *
 * **And the finding that makes it a live decision rather than a theoretical one:** since M10
 * established that no gesture writes `scaleX`/`scaleY`, A and B are currently *indistinguishable* --
 * every object's scale is 1, so the border is always exactly its authored width. The project has
 * never chosen between A and B; it has been getting B by accident. Introducing affine would make the
 * choice visible for the first time, which is why ADR 0011 does not treat it as a detail.
 */

interface Probe {
  outerWidth: number;
  outerHeight: number;
  innerOffsetLeft: number;
  innerOffsetTop: number;
  innerWidth: number;
}

function measureStroke(page: Page, transform: string): Promise<Probe> {
  return page.evaluate((t) => {
    const outer = document.createElement('div');
    outer.style.cssText =
      'position:absolute;left:0;top:0;width:100px;height:60px;' +
      'border:12px solid #000000;box-sizing:border-box;';
    const inner = document.createElement('div');
    inner.style.cssText = 'width:100%;height:100%;background:#0000ff;';
    outer.append(inner);
    document.body.append(outer);
    if (t !== '') outer.style.transform = t;

    const o = outer.getBoundingClientRect();
    const i = inner.getBoundingClientRect();
    const probe: Probe = {
      outerWidth: Math.round(o.width * 100) / 100,
      outerHeight: Math.round(o.height * 100) / 100,
      innerOffsetLeft: Math.round((i.left - o.left) * 100) / 100,
      innerOffsetTop: Math.round((i.top - o.top) * 100) / 100,
      innerWidth: Math.round(i.width * 100) / 100,
    };
    outer.remove();
    return probe;
  }, transform);
}

test.describe('stroke width under a general transform', () => {
  test('an untransformed border paints at its authored width', async ({ page }) => {
    await mountFixture(page, SHAPES);
    const probe = await measureStroke(page, '');
    // The control: the probe measures what it claims to measure. Without it, every assertion below
    // could be explained by the offset being insensitive to the transform.
    expect(probe.innerOffsetLeft, 'the horizontal border').toBe(12);
    expect(probe.innerOffsetTop, 'the vertical border').toBe(12);
    expect(probe.outerWidth).toBe(100);
  });

  test('a uniform scale multiplies the painted stroke width', async ({ page }) => {
    await mountFixture(page, SHAPES);
    const probe = await measureStroke(page, 'scale(2)');
    // Semantics B, and the cheapest case: one authored width, one painted width.
    expect(probe.innerOffsetLeft).toBe(24);
    expect(probe.innerOffsetTop).toBe(24);
  });

  test('a NON-uniform scale makes one authored stroke two different painted strokes', async ({ page }) => {
    await mountFixture(page, SHAPES);
    const probe = await measureStroke(page, 'scale(2, 3)');
    // The finding that gates the decision. `border-width: 12px` cannot mean "12" under this
    // transform, and there is no single number that describes what is painted.
    expect(probe.innerOffsetLeft, 'horizontal border, doubled').toBe(24);
    expect(probe.innerOffsetTop, 'vertical border, tripled').toBe(36);
    expect(probe.innerOffsetTop, 'so the stroke is no longer uniform').not.toBe(
      probe.innerOffsetLeft,
    );
  });

  test('a shear turns the stroke into a parallelogram with no single width', async ({ page }) => {
    await mountFixture(page, SHAPES);
    // `matrix(1, 0.6, 0, 1, 0, 0)` shears y by 0.6 per unit x. The horizontal axis is untouched,
    // so the left border keeps its width; the vertical extent of the *top* border grows to
    // 12 * (1 + 0.6) because the border's own thickness is now measured along a slanted edge.
    const probe = await measureStroke(page, 'matrix(1, 0.6, 0, 1, 0, 0)');
    expect(probe.innerOffsetLeft, 'unsheared axis is unaffected').toBe(12);
    expect(probe.innerOffsetTop, 'the sheared axis is not 12 any more').toBeCloseTo(19.2, 1);
    expect(probe.innerOffsetTop).not.toBe(12);
  });

  test('vector-effect cannot rescue a CSS border', async ({ page }) => {
    await mountFixture(page, SHAPES);

    // The negative control for the whole file, and the reason the project should not adopt affine
    // expecting stroke invariance for free: invariance is not achievable by adjusting a number.
    //
    // Chromium *accepts* `vector-effect` on an HTML element -- it is a CSS property name, so
    // `'vectorEffect' in style` is true and a first draft of this test asserted it was false. The
    // property is accepted and then ignored, because it is defined for SVG geometry. So the only
    // route to semantics A is to render strokes as SVG, which ADR 0005 declined for every kind
    // except `line` and which would make stroke rendering the one part of the renderer that CSS
    // cannot express.
    const withVectorEffect = await page.evaluate(() => {
      const outer = document.createElement('div');
      outer.style.cssText =
        'position:absolute;left:0;top:0;width:100px;height:60px;' +
        'border:12px solid #000000;box-sizing:border-box;transform:scale(2, 3);' +
        'vector-effect:non-scaling-stroke;';
      const inner = document.createElement('div');
      inner.style.cssText = 'width:100%;height:100%;background:#0000ff;';
      outer.append(inner);
      document.body.append(outer);
      const offset = inner.getBoundingClientRect().left - outer.getBoundingClientRect().left;
      outer.remove();
      return Math.round(offset * 100) / 100;
    });

    // The property is honoured syntactically...
    const accepted = await page.evaluate(() => {
      const el = document.createElement('div');
      el.style.vectorEffect = 'non-scaling-stroke';
      const value = el.style.vectorEffect;
      el.remove();
      return value;
    });
    expect(accepted, 'Chromium accepts the property on an HTML element').toBe('non-scaling-stroke');

    // ...and has no effect on a border, which is the point.
    expect(withVectorEffect, 'the stroke still scales').toBe(24);
  });
});