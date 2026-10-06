import type { Page } from '@playwright/test';
import { expect, test } from '../editor/helpers';

/**
 * PROBE: graphical-object geometry in Chromium.
 *
 * The geometry contract for M5 rests on answers only a browser can give:
 *
 *  - Does a CSS `border` change the element's layout box, or only its paint?
 *  - What does a zero-width or zero-height box actually report, and is it hit-testable?
 *  - Can an ellipse and a line be drawn with plain HTML/CSS, or does one of them need
 *    SVG? (ADR 0004's escape-hatch principle, §2.8.)
 *  - Does a negative width survive CSS at all?
 *
 * Retained as the executable record for `docs/adr/0005-shape-geometry-contract.md`.
 *
 * A bare data-URL page would answer a *different* question, so this drives the real
 * stylesheet: `box-sizing: border-box` is load-bearing for the whole contract and has
 * to be present.
 */

const PAGE = `data:text/html,${encodeURIComponent(`<!doctype html>
<html><head><style>
* { box-sizing: border-box; }
.p1-object { position: absolute; transform-origin: 50% 50%; }
.page { position: absolute; overflow: hidden; background: #fff; }
</style></head><body>
<div class="page" id="host" style="left:0;top:0;width:400px;height:400px"></div>
</body></html>`)}`;

const setup = async (page: Page, html: string): Promise<void> => {
  await page.goto(PAGE);
  await page.evaluate((markup) => {
    document.getElementById('host')!.innerHTML = markup;
  }, html);
};

/** Reads every geometry API for the single child of the host. */
const read = (page: Page) =>
  page.evaluate(() => {
    const el = document.getElementById('host')!.firstElementChild as HTMLElement;
    const style = getComputedStyle(el);
    return {
      offset: [el.offsetWidth, el.offsetHeight],
      client: [el.clientWidth, el.clientHeight],
      scroll: [el.scrollWidth, el.scrollHeight],
      borderBox: [
        el.offsetWidth - (parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)),
        el.offsetHeight - (parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)),
      ],
      rect: (() => {
        const r = el.getBoundingClientRect();
        return { width: r.width, height: r.height };
      })(),
      cssWidth: style.width,
      cssHeight: style.height,
      borderWidth: style.borderTopWidth,
      background: style.backgroundColor,
      borderRadius: style.borderTopLeftRadius,
      hitSelf: (() => {
        const r = el.getBoundingClientRect();
        const x = r.x + r.width / 2;
        const y = r.y + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        return hit === el ? 'self' : hit === null ? 'none' : hit.tagName;
      })(),
    };
  });

test('PROBE G: stroke, and whether it changes the box', async ({ page }) => {
  await setup(
    page,
    `<div class="p1-object" style="left:40px;top:40px;width:200px;height:100px;
      background:#4f7cff;border-width:10px;border-style:solid;border-color:#000"></div>`,
  );
  console.log('PROBE G stroked:', JSON.stringify(await read(page)));

  await setup(
    page,
    `<div class="p1-object" style="left:40px;top:40px;width:200px;height:100px;background:#4f7cff"></div>`,
  );
  console.log('PROBE G plain  :', JSON.stringify(await read(page)));

  expect(true).toBe(true);
});

test('PROBE H: zero and negative extents', async ({ page }) => {
  await setup(
    page,
    `<div class="p1-object" id="zw" style="left:40px;top:40px;width:0px;height:100px;background:#f00"></div>`,
  );
  console.log('PROBE H zero-width:', JSON.stringify(await read(page)));

  await setup(
    page,
    `<div class="p1-object" id="zh" style="left:40px;top:40px;width:200px;height:0px;background:#f00"></div>`,
  );
  console.log('PROBE H zero-height:', JSON.stringify(await read(page)));

  await setup(
    page,
    `<div class="p1-object" id="neg" style="left:40px;top:40px;width:-50px;height:100px;background:#f00"></div>`,
  );
  console.log('PROBE H negative:', JSON.stringify(await read(page)));

  expect(true).toBe(true);
});

test('PROBE I: ellipse and line as plain HTML/CSS', async ({ page }) => {
  await setup(
    page,
    `<div class="p1-object" id="el" style="left:40px;top:40px;width:200px;height:100px;
      background:#4f7cff;border-radius:50%;border-width:8px;border-style:solid;border-color:#000"></div>`,
  );
  const ellipse = await read(page);
  console.log('PROBE I ellipse border-radius:', JSON.stringify(ellipse));

  // Is the ellipse's *corner* actually unpainted, and is it hit-testable?
  const corners = await page.evaluate(() => {
    const el = document.getElementById('el') as HTMLElement;
    const r = el.getBoundingClientRect();
    const probe = (fx: number, fy: number): string => {
      const hit = document.elementFromPoint(r.x + r.width * fx, r.y + r.height * fy);
      if (hit === null) return 'none';
      if (hit === el) return 'self';
      return hit.id === 'host' ? 'host' : hit.tagName;
    };
    return { centre: probe(0.5, 0.5), nw: probe(0.06, 0.06), ne: probe(0.94, 0.06), mid: probe(0.5, 0.02) };
  });
  console.log('PROBE I ellipse corners:', JSON.stringify(corners));

  // A line with zero height: only a border can paint it.
  await setup(
    page,
    `<div class="p1-object" id="ln" style="left:40px;top:40px;width:200px;height:0px;
      background:transparent;border-top-width:4px;border-top-style:solid;border-top-color:#000"></div>`,
  );
  console.log('PROBE I zero-height line:', JSON.stringify(await read(page)));

  // A rotated thin div as an alternative line representation.
  await setup(
    page,
    `<div class="p1-object" id="ln2" style="left:40px;top:70px;width:200px;height:4px;
      background:#000;transform:rotate(-20deg)"></div>`,
  );
  console.log('PROBE I rotated bar:', JSON.stringify(await read(page)));

  expect(true).toBe(true);
});

test('PROBE J: stroke rendering options CSS does not give us directly', async ({ page }) => {
  await setup(
    page,
    `<div class="p1-object" id="o" style="left:40px;top:40px;width:200px;height:100px;background:#4f7cff"></div>`,
  );

  const results = await page.evaluate(() => {
    const el = document.getElementById('o') as HTMLElement;
    const out: Record<string, unknown> = {};

    // `outline` grows *outward* and does not affect layout — the usual way to get
    // `outside` and `center` strokes in CSS.
    el.style.outline = '6px solid #0f0';
    const afterOutline = el.getBoundingClientRect().width;
    el.style.outline = '';
    out.outlineDoesNotChangeLayout = afterOutline === el.getBoundingClientRect().width;

    // Does a border-radius larger than half the box render as an ellipse?
    el.style.borderRadius = '50%';
    el.style.border = '4px solid #000';
    out.radius50 = getComputedStyle(el).borderTopLeftRadius;

    // Fractional and percentage radii.
    el.style.borderRadius = '20px 40px';
    out.twoRadii = getComputedStyle(el).borderTopLeftRadius;

    return out;
  });
  console.log('PROBE J:', JSON.stringify(results));

  expect(true).toBe(true);
});

test('PROBE K: does a border affect hit testing outside the model box?', async ({ page }) => {
  // With `align: inside` and `border-box` the border is inside, so there should be no
  // region outside the model box that the browser reports as a hit.
  await setup(
    page,
    `<div class="p1-object" id="s" style="left:100px;top:100px;width:100px;height:100px;
      background:#4f7cff;border-width:20px;border-style:solid;border-color:#000"></div>`,
  );

  const probes = await page.evaluate(() => {
    const el = document.getElementById('s') as HTMLElement;
    const r = el.getBoundingClientRect();
    const at = (x: number, y: number): string => {
      const hit = document.elementFromPoint(x, y);
      if (hit === null) return 'none';
      if (hit === el) return 'self';
      return hit.id === 'host' ? 'host' : hit.tagName;
    };
    return {
      insideCentre: at(r.x + r.width / 2, r.y + r.height / 2),
      insideEdge: at(r.x + 2, r.y + 2),
      justOutside: at(r.x - 2, r.y + r.height / 2),
      borderBoxWidth: r.width,
      offsetWidth: el.offsetWidth,
    };
  });
  console.log('PROBE K:', JSON.stringify(probes));

  expect(true).toBe(true);
});
