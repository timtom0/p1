import type { Page } from '@playwright/test';
import { expect, test } from '../editor/helpers';

/**
 * PROBE: how should a stroked *line* be drawn, given the geometry contract?
 *
 * The measurements that force this question:
 *
 *  - `box-sizing: border-box` means a stroke drawn with `border` grows the box when
 *    the box is thinner than the border. A zero-height line with a 4px border becomes
 *    a 4px-tall box, so the model box and the rendered box disagree.
 *  - `outline` does *not* affect layout, so it can straddle a zero-height box without
 *    changing it -- but it is always centred/outside, so it cannot honour
 *    `align: 'inside'`.
 *
 * Candidates measured here: a `border-top` band, an `outline` band, and a scoped SVG
 * `<line>`. §2.8 sanctions an island renderer for exactly this case, so the question is
 * which one is actually needed.
 */

const PAGE = `data:text/html,${encodeURIComponent(`<!doctype html>
<html><head><style>
* { box-sizing: border-box; }
.p1-object { position: absolute; transform-origin: 50% 50%; }
#host { position: absolute; left: 0; top: 0; width: 500px; height: 500px; background: #fff; }
</style></head><body>
<div id="host"></div>
</body></html>`)}`;

const setup = async (page: Page, html: string): Promise<void> => {
  await page.goto(PAGE);
  await page.evaluate((markup) => {
    document.getElementById('host')!.innerHTML = markup;
  }, html);
};

/** Where is the paint, vertically, relative to the model's zero-height box top? */
const verticalExtent = (page: Page) =>
  page.evaluate(() => {
    const host = document.getElementById('host')!;
    const el = host.firstElementChild as HTMLElement;
    const r = el.getBoundingClientRect();
    const samples: number[] = [];
    // Sample a vertical strip through the middle and find where the host is NOT the hit.
    for (let dy = -12; dy <= 12; dy += 1) {
      const x = r.x + r.width / 2;
      const y = 132.5 + dy; // the host is at top 0; the line is placed at 132.5
      const hit = document.elementFromPoint(x, y);
      if (hit !== null && hit !== host) samples.push(dy);
    }
    return {
      boxTop: r.top,
      boxHeight: r.height,
      offsetHeight: el.offsetHeight,
      paintedFrom: samples.length > 0 ? Math.min(...samples) : null,
      paintedTo: samples.length > 0 ? Math.max(...samples) : null,
    };
  });

test('PROBE L: zero-height line via border-top (the CSS-native candidate)', async ({ page }) => {
  await setup(
    page,
    `<div class="p1-object" style="left:40px;top:132.5px;width:200px;height:0px;
      background:transparent;border-top-width:4px;border-top-style:solid;border-top-color:#000"></div>`,
  );
  console.log('PROBE L border-top:', JSON.stringify(await verticalExtent(page)));
  expect(true).toBe(true);
});

test('PROBE M: zero-height line via outline (does not affect layout)', async ({ page }) => {
  await setup(
    page,
    `<div class="p1-object" style="left:40px;top:132.5px;width:200px;height:0px;
      background:transparent;outline:4px solid #000"></div>`,
  );
  console.log('PROBE M outline:', JSON.stringify(await verticalExtent(page)));
  expect(true).toBe(true);
});

test('PROBE N: scoped SVG <line> as an island renderer', async ({ page }) => {
  await setup(
    page,
    `<div class="p1-object" style="left:40px;top:132.5px;width:200px;height:0px">
       <svg width="200" height="1" style="display:block;overflow:visible">
         <line x1="0" y1="0.5" x2="200" y2="0.5" stroke="#000" stroke-width="4"></line>
       </svg>
     </div>`,
  );
  const result = await page.evaluate(() => {
    const host = document.getElementById('host')!;
    const el = host.firstElementChild as HTMLElement;
    const r = el.getBoundingClientRect();
    const samples: number[] = [];
    for (let dy = -12; dy <= 12; dy += 1) {
      const x = r.x + r.width / 2;
      const y = 132.5 + dy;
      const hit = document.elementFromPoint(x, y);
      if (hit !== null && hit !== host) samples.push(dy);
    }
    return {
      offsetHeight: el.offsetHeight,
      rectHeight: r.height,
      paintedFrom: samples.length > 0 ? Math.min(...samples) : null,
      paintedTo: samples.length > 0 ? Math.max(...samples) : null,
    };
  });
  console.log('PROBE N svg line:', JSON.stringify(result));

  // Does a diagonal line work in the same island, and does the element keep the box?
  await setup(
    page,
    `<div class="p1-object" style="left:40px;top:132.5px;width:200px;height:100px">
       <svg width="200" height="100" style="display:block;overflow:visible">
         <line x1="0" y1="0" x2="200" y2="100" stroke="#000" stroke-width="4"></line>
       </svg>
     </div>`,
  );
  const diagonal = await page.evaluate(() => {
    const el = document.getElementById('host')!.firstElementChild as HTMLElement;
    const r = el.getBoundingClientRect();
    return { offset: [el.offsetWidth, el.offsetHeight], rect: { width: r.width, height: r.height } };
  });
  console.log('PROBE N diagonal:', JSON.stringify(diagonal));

  expect(true).toBe(true);
});

test('PROBE O: SVG ellipse vs border-radius — do the hit regions agree?', async ({ page }) => {
  // The editor will hit-test an ellipse mathematically. Chromium's answer for
  // `border-radius: 50%` happened to agree (probe I), but that is a coincidence worth
  // testing directly rather than assuming: sample a grid and compare.
  await setup(
    page,
    `<div class="p1-object" id="e" style="left:100px;top:100px;width:200px;height:100px;
      background:#4f7cff;border-radius:50%"></div>`,
  );

  const result = await page.evaluate(() => {
    const el = document.getElementById('e') as HTMLElement;
    const r = el.getBoundingClientRect();
    let agree = 0;
    let disagree = 0;
    const disagreements: string[] = [];

    for (let gx = 0; gx <= 20; gx += 1) {
      for (let gy = 0; gy <= 20; gy += 1) {
        const px = r.x + (r.width * gx) / 20;
        const py = r.y + (r.height * gy) / 20;
        const browserHit = document.elementFromPoint(px, py) === el;

        // The mathematical test, in normalised unit-circle coordinates.
        const nx = (gx / 20) * 2 - 1;
        const ny = (gy / 20) * 2 - 1;
        const modelHit = nx * nx + ny * ny <= 1;

        if (browserHit === modelHit) agree += 1;
        else {
          disagree += 1;
          if (disagreements.length < 6) {
            disagreements.push(`(${(gx / 20).toFixed(2)},${(gy / 20).toFixed(2)})`);
          }
        }
      }
    }
    return { agree, disagree, disagreements };
  });

  console.log('PROBE O ellipse grid:', JSON.stringify(result));
  expect(true).toBe(true);
});
