import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { clickAt, clientPointAt, settle } from './helpers';
import { mountFixture } from '../visual/harness';
import { ROTATED_KINDS } from './rotated-fixtures';

/**
 * F6: the selection frame must be the object's **transformed** frame.
 *
 * ## What was wrong
 *
 * `toRect` returned the object's `x/y/width/height` and the overlay wrote them to
 * `left/top/width/height` with **no transform at all**. So a rotated object was framed by an
 * *unrotated* box at its model position, and its eight handles sat on that box's corners — points
 * that belong to no part of the object. M10b measured the gap on `SHAPES`: a rotated ellipse paints
 * 171.2 × 156.6 while its frame was 140 × 100 (ADR 0011 §8 F6).
 *
 * Two things were suppressed because of it, and both were workarounds rather than capability limits:
 * the rotation grip was hidden for any rotated selection, and multi-object resize was deferred.
 * The grip now works at any angle.
 *
 * ## How the fix works
 *
 * The outline is laid out at the model frame and then given **the node's own matrix** — the same
 * `matrix(...)` the renderer writes onto the object, with the same `transform-origin: 50% 50%`. The
 * outline is therefore the object by construction rather than by a second computation of it. Handles
 * are positioned from `Overlay.handlePoint`, which is also what the editor's hit test calls, so the
 * handle you see and the handle you grab cannot diverge.
 *
 * ## Why these tests assert *geometry*, not pixels
 *
 * The overlay suite's visual baselines **cannot** see this change. `maxDiffPixelRatio: 0.002` over
 * the surface clip is several thousand pixels of tolerance, and a 1px chrome outline rotating is
 * well under that — the stored baseline matched before and after the fix. Measured directly: the
 * `overlay-rotated` snapshot passes with a rotated outline and passes with an unrotated one. That is
 * trap 14 realised, and it is why every assertion below reads a rectangle rather than a picture.
 */

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The object's painted rect and its selection frame's painted rect, in client px. */
function probe(page: Page, oid: string): Promise<{
  object: Rect;
  frame: Rect;
  frameTransform: string;
  transformOrigin: string;
  handles: { handle: string; x: number; y: number }[];
  grip: { x: number; y: number } | null;
}> {
  return page.evaluate((id) => {
    const object = document.querySelector(`[data-objects] [data-oid="${id}"]`);
    if (!(object instanceof HTMLElement)) throw new Error(`no object ${id}`);
    const box = document.querySelector('.p1-overlay-group--selection .p1-overlay-box');
    if (!(box instanceof HTMLElement)) throw new Error('no selection frame');
    const grip = document.querySelector('.p1-overlay-rotate');
    const round = (r: DOMRect): { x: number; y: number; w: number; h: number } => ({
      x: Math.round(r.x * 10) / 10,
      y: Math.round(r.y * 10) / 10,
      w: Math.round(r.width * 10) / 10,
      h: Math.round(r.height * 10) / 10,
    });
    const gr = grip instanceof HTMLElement ? grip.getBoundingClientRect() : null;
    return {
      object: round(object.getBoundingClientRect()),
      frame: round(box.getBoundingClientRect()),
      frameTransform: getComputedStyle(box).transform,
      transformOrigin: getComputedStyle(box).transformOrigin,
      handles: Array.from(document.querySelectorAll('.p1-overlay-group--selection .p1-overlay-handle'))
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            handle: (el as HTMLElement).dataset['handle'] ?? '?',
            x: Math.round(r.x * 10) / 10,
            y: Math.round(r.y * 10) / 10,
          };
        }),
      grip: gr === null ? null : { x: Math.round(gr.x * 10) / 10, y: Math.round(gr.y * 10) / 10 },
    };
  }, oid);
}

/** Crossing-number point-in-polygon, for the shape's own quadrilateral in client px. */
function pointInPolygon(p: { x: number; y: number }, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a === undefined || b === undefined) continue;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Select an object by clicking the centre of its own client rect -- no coordinate guessing. */
async function selectByElement(page: Page, oid: string): Promise<void> {
  const box = await page
    .locator('[data-objects] [data-oid="' + oid + '"]')
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
  await page.mouse.click(box.x, box.y);
  await settle(page);
}

/** Select an object by clicking its painted centre, in document px. */
async function select(page: Page, docCentre: { x: number; y: number }): Promise<void> {
  await clickAt(page, docCentre.x, docCentre.y);
  await settle(page);
}

test.describe('F6: the selection frame is the transformed frame', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, ROTATED_KINDS);
  });

  test('a rotated RECTANGLE: frame and object agree, and the old placement would not', async ({
    page,
  }) => {
    // 200x100 at 30 degrees, at (60, 60). Selecting its centre.
    await select(page, { x: 160, y: 110 });
    const { object, frame, frameTransform, transformOrigin } = await probe(page, 'r-rot');

    // The frame carries the object's own rotation.
    expect(frameTransform, 'the outline is transformed, not merely laid out').not.toBe('none');
    // getComputedStyle resolves a percentage origin to px, so the assertion is that it lands on
    // the box's centre -- which is what the renderer rotates about.
    const [originX, originY] = transformOrigin.split(' ').map((v) => Number.parseFloat(v));
    // Compared against the box's *layout* size, because a percentage origin resolves against the
    // layout box -- not against the painted rect, which is the rotated bounding box.
    const layout = await page
      .locator('.p1-overlay-group--selection .p1-overlay-box')
      .evaluate((el) => ({ w: parseFloat((el as HTMLElement).style.width), h: parseFloat((el as HTMLElement).style.height) }));
    expect(originX, 'the rotation origin is the frame centre in x').toBeCloseTo(layout.w / 2, 0);
    expect(originY, 'and in y').toBeCloseTo(layout.h / 2, 0);

    // And it agrees with the object it outlines, to within antialiasing.
    expect(frame.w).toBeCloseTo(object.w, 0);
    expect(frame.h).toBeCloseTo(object.h, 0);
    expect(frame.x).toBeCloseTo(object.x, 0);
    expect(frame.y).toBeCloseTo(object.y, 0);

    // The negative control the brief asks for: what the OLD frame would have measured. It was laid
    // out at the *model* size -- `left = x`, `top = y`, `width = 200`, `height = 100`, no transform
    // -- so it reported the model's own dimensions while the object painted its bounding box. That
    // is the whole of F6, and the gap is not a rounding matter.
    //
    // (A first draft put the bounding-box formula here, which made the control vacuous: it computed
    // 223.2 and compared it against 223.2. The old frame never *was* the bounding box -- it was the
    // untransformed model box, which is why it was wrong.)
    expect(object.w, 'the object paints its bounding box').toBeCloseTo(223.2, 0);
    // 200*sin30 + 100*cos30 = 186.6. (A first draft wrote 173.2 here, which is the *width*
    // formula's cosine term -- the same number in the wrong place, and a reminder that a
    // remembered constant is not a derived one.)
    expect(object.h).toBeCloseTo(186.6, 0);
    expect(200, 'the old frame width was the model width').not.toBeCloseTo(object.w, 0);
    expect(100, 'and the old frame height the model height').not.toBeCloseTo(object.h, 0);
  });

  test('an UNROTATED rectangle is unchanged by the fix', async ({ page }) => {
    // The control. Without it, every assertion above could be explained by the probe measuring the
    // wrong pair of elements.
    await select(page, { x: 160, y: 310 });
    const { object, frame, frameTransform } = await probe(page, 'r-flat');
    expect(frameTransform, 'the identity matrix, not `none`').toBe('matrix(1, 0, 0, 1, 0, 0)');
    expect(frame.w).toBeCloseTo(object.w, 0);
    expect(frame.h).toBeCloseTo(object.h, 0);
    expect(frame.x).toBeCloseTo(object.x, 0);
    expect(frame.y).toBeCloseTo(object.y, 0);
  });

  test('a rotated ELLIPSE, which is the case M10b measured', async ({ page }) => {
    await select(page, { x: 420, y: 120 });
    const { object, frame, frameTransform } = await probe(page, 'e-rot');
    expect(frameTransform).not.toBe('none');
    // A 160x100 ellipse at -36 degrees. M10b recorded this object at 171.2 x 156.6 painted with a
    // 140 x 100 unrotated frame; the frame must now equal the paint.
    expect(frame.w).toBeCloseTo(object.w, 0);
    expect(frame.h).toBeCloseTo(object.h, 0);
    expect(frame.x).toBeCloseTo(object.x, 0);
    expect(frame.y).toBeCloseTo(object.y, 0);
    expect(object.w, 'and it is genuinely bigger than the model box').toBeGreaterThan(150);
  });

  test('a rotated IMAGE is framed by its box, not its pixels', async ({ page }) => {
    await select(page, { x: 420, y: 510 });
    const { object, frame } = await probe(page, 'i-rot');
    // ADR 0006: an image is selected by its object geometry. The frame says the same thing, which
    // is the point -- a pixel-accurate outline would contradict the hit test on any image with
    // transparency.
    expect(frame.w).toBeCloseTo(object.w, 0);
    expect(frame.h).toBeCloseTo(object.h, 0);
    expect(frame.x).toBeCloseTo(object.x, 0);
    expect(frame.y).toBeCloseTo(object.y, 0);
  });

  test('a rotated TEXT FRAME is framed, and editing stays fenced', async ({ page }) => {
    await select(page, { x: 170, y: 475 });
    const { object, frame } = await probe(page, 't-rot');
    expect(frame.w).toBeCloseTo(object.w, 0);
    expect(frame.h).toBeCloseTo(object.h, 0);

    // And the fence still holds with a transformed frame in place: Enter opens a session, the DOM
    // owns the caret, and the outline is chrome that never becomes model state.
    await page.keyboard.press('Enter');
    await expect(async () => {
      expect(
        await page
          .locator('[data-objects] [data-oid="t-rot"]')
          .evaluate((el) => (el as HTMLElement).dataset['editing']),
      ).toBe('true');
    }).toPass();
    await page.keyboard.press('Escape');
    await settle(page);
  });

  test('a ZERO-HEIGHT line still gets a frame and a grip', async ({ page }) => {
    // A collapsed object must remain serviceable: M2 established that a line with no height is a
    // legitimate horizontal line, and its outline is a rect of zero height -- which is honest, as
    // long as it is *drawn*.
    await select(page, { x: 640, y: 560 });
    const { object, frame, handles, grip } = await probe(page, 'l-zero');
    // The *layout* box is zero. The painted band is 2px, because .p1-overlay-box is
    // ox-sizing: border-box with a 1px border, so a collapsed box still shows a 1px line above and
    // below its own edge -- which is what makes a horizontal line findable at all.
    const layoutHeight = await page
      .locator('.p1-overlay-group--selection .p1-overlay-box')
      .evaluate((el) => (el as HTMLElement).style.height);
    expect(layoutHeight, 'the frame layout height is zero').toBe('0px');
    expect(frame.h, 'and the painted outline is the 1px border either side').toBeLessThanOrEqual(2.5);
    expect(frame.w).toBeCloseTo(object.w, 0);
    // Eight handles, all on one line -- three distinct columns, one row.
    expect(handles).toHaveLength(8);
    expect(new Set(handles.map((h) => h.y)).size, 'one row').toBe(1);
    expect(new Set(handles.map((h) => h.x)).size, 'three columns').toBe(3);
    expect(grip, 'and the rotation grip is offered').not.toBeNull();
  });

  test('handles sit on the TRANSFORMED corners, not the model frame corners', async ({ page }) => {
    await select(page, { x: 160, y: 110 });
    const { handles } = await probe(page, 'r-rot');

    // The four transformed corners, in page px, read from the object's own computed matrix -- the
    // same matrix the outline is given, so the two cannot disagree by construction.
    const corners = await page.evaluate(() => {
      const el = document.querySelector('[data-objects] [data-oid="r-rot"]');
      if (!(el instanceof HTMLElement)) throw new Error('no object');
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      const w = 200;
      const h = 100;
      const left = parseFloat(el.style.left);
      const top = parseFloat(el.style.top);
      const at = (lx: number, ly: number) => {
        const p = new DOMPoint(lx - w / 2, ly - h / 2).matrixTransform(m);
        return { x: p.x + left + w / 2, y: p.y + top + h / 2 };
      };
      return [at(0, 0), at(w, 0), at(w, h), at(0, h)];
    });

    // Page px -> client px, through the shared helper, so handle coordinates (client) and corner
    // coordinates (page) are finally in the same space.
    const clientCorners = await Promise.all(
      corners.map((c) => clientPointAt(page, c.x, c.y)),
    );

    // Handle order in `HANDLE_DIRECTIONS` is nw, n, ne, e, se, s, sw, w, so the corner handles are
    // indices 0, 2, 4, 6 -- matching corners 0..3.
    const cornerHandles = [0, 2, 4, 6].map((i) => handles[i]);
    const names = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    for (const [index, handle] of cornerHandles.entries()) {
      if (handle === undefined) throw new Error(`missing handle ${names[index * 2]}`);
      // The handle is a 9px box with a -5px margin, so its centre is at left+4.5, top+4.5.
      const hx = handle.x + 4.5;
      const hy = handle.y + 4.5;
      const corner = clientCorners[index];
      if (corner === undefined) throw new Error('missing corner');
      expect(
        Math.hypot(hx - corner.x, hy - corner.y),
        `${names[index * 2]} handle is on its transformed corner`,
      ).toBeLessThan(2);
    }

    // The negative control the brief asks for: assert the OLD placement would fail. The unrotated
    // frame's corners are (x, y) and (x + w, y + h); the top-left one is 50px above and 87px left of
    // the true corner for a 30-degree rotation, so it is nowhere near a handle.
    const oldTopLeft = await clientPointAt(page, 60, 60);
    const trueTopLeft = clientCorners[0];
    if (trueTopLeft === undefined) throw new Error('missing corner');
    expect(
      Math.hypot(oldTopLeft.x - trueTopLeft.x, oldTopLeft.y - trueTopLeft.y),
      'the old model-frame corner is far from the real one',
    ).toBeGreaterThan(20);

    // And the handles' own diagonal is the *shape's* diagonal -- invariant under rotation -- not
    // the painted bounding box's. That is the geometric signature of handles-on-the-corners.
    const nw = handles[0];
    const se = handles[4];
    if (nw === undefined || se === undefined) throw new Error('missing corners');
    const handleDiagonal = Math.hypot(se.x - nw.x, se.y - nw.y);
    expect(handleDiagonal, 'the handle diagonal is the shape diagonal').toBeCloseTo(Math.hypot(200, 100), 0);
  });

  test('the grip sits just outside the shape, on the frame own top edge', async ({ page }) => {
    await select(page, { x: 160, y: 110 });
    const { grip } = await probe(page, 'r-rot');
    if (grip === null) throw new Error('no grip');
    const gx = grip.x + 5.5;
    const gy = grip.y + 5.5;

    // The shape's own corners in **page** px, from the object's computed matrix. The grip is in
    // client px, so both are converted through `clientPointAt` before anything is compared --
    // mixing the two spaces is how the first draft of this test measured a 477px "distance" to a
    // point 24px away.
    const pageCorners = await page.evaluate(() => {
      const el = document.querySelector('[data-objects] [data-oid="r-rot"]');
      if (!(el instanceof HTMLElement)) throw new Error('no object');
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      const w = 200;
      const h = 100;
      const left = parseFloat(el.style.left);
      const top = parseFloat(el.style.top);
      const at = (lx: number, ly: number) => {
        const p = new DOMPoint(lx - w / 2, ly - h / 2).matrixTransform(m);
        return { x: p.x + left + w / 2, y: p.y + top + h / 2 };
      };
      return [at(0, 0), at(w, 0), at(w, h), at(0, h)];
    });
    const quad = await Promise.all(pageCorners.map((c) => clientPointAt(page, c.x, c.y)));

    // Crossing-number test against the *quadrilateral*, not its bounding box.
    //
    // The bounding box is the wrong test and the first draft used it: for a 200x100 box at 30 degrees
    // the AABB's top edge is 93px above the centre while the frame's top edge is only 50px above it,
    // so a grip 24px outside the *shape* is still inside the *box*. That is correct and normal --
    // every editor puts the grip just outside the shape's edge, not outside its bounding box -- and
    // an assertion demanding otherwise would have demanded a bug.
    const inside = pointInPolygon({ x: gx, y: gy }, quad);
    expect(inside, 'the grip is outside the rotated shape itself').toBe(false);

    // And it is genuinely near the shape: the grip is one handle-gap beyond the frame's top-edge
    // midpoint, so its distance from that midpoint is the gap.
    const topLeft = quad[0];
    const topRight = quad[1];
    if (topLeft === undefined || topRight === undefined) throw new Error('missing corners');
    const midpoint = { x: (topLeft.x + topRight.x) / 2, y: (topLeft.y + topRight.y) / 2 };
    const gap = Math.hypot(gx - midpoint.x, gy - midpoint.y);
    expect(gap, 'and it is clear of the top edge, not parked').toBeGreaterThan(10);
    expect(gap, 'by roughly the handle gap').toBeLessThan(40);

    // The negative control, stated accurately. The old placement was the frame's top-centre pushed
    // straight up, with no rotation -- so it landed *inside the object's bounding box* while
    // pointing at nothing on the object itself. (A first draft claimed it landed on the shape; for
    // 30 degrees it does not, it lands in the gap between the shape and its own bounding box. The
    // reason the grip was suppressed was that it was ambiguous, not that it overlapped.)
    const oldGrip = await clientPointAt(page, 60 + 100, 60 - 24);
    const xs = quad.map((q) => q.x);
    const ys = quad.map((q) => q.y);
    const aabb = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    };
    expect(
      oldGrip.x > aabb.x &&
        oldGrip.x < aabb.x + aabb.w &&
        oldGrip.y > aabb.y &&
        oldGrip.y < aabb.y + aabb.h,
      'the old unrotated grip sat inside the bounding box',
    ).toBe(true);
    expect(pointInPolygon(oldGrip, quad), 'while pointing at no part of the shape').toBe(false);
  });

  test('the frame survives ZOOM, in the right place', async ({ page }) => {
    await select(page, { x: 160, y: 110 });
    const atOne = await probe(page, 'r-rot');

    await page.locator('[data-zoom="out"]').click();
    await settle(page);
    const zoomed = await probe(page, 'r-rot');

    // The frame still tracks the object exactly -- that is the invariant that matters, and it is
    // zoom-independent because both are read in the same client space.
    expect(zoomed.frame.w).toBeCloseTo(zoomed.object.w, 0);
    expect(zoomed.frame.h).toBeCloseTo(zoomed.object.h, 0);
    expect(zoomed.frame.x).toBeCloseTo(zoomed.object.x, 0);

    // And the chrome itself did not scale: the outline is a 1px stroke and the handles are a
    // constant size, because the overlay lives outside the zoom transform (ADR 0009).
    await page.locator('[data-zoom="actual"]').click();
    await settle(page);
    expect(atOne.frame.w, 'and the document did shrink, so the test is not vacuous').not.toBeCloseTo(
      zoomed.frame.w,
      0,
    );
    expect(zoomed.frame.w / atOne.frame.w).toBeLessThan(0.95);
  });

  test('the frame works on the SECOND page', async ({ page }) => {
    // Page offsets go through a different conversion, so "one page works" says nothing about two.
    // Scrolled to by clicking the page element, then the object is clicked through its own client
    // rect. Guessing document coordinates for a second page was unreliable -- a mis-aimed click
    // lands on the background, which clears the selection, and the next assertion then reads a
    // *different* object's geometry and fails for the wrong reason.
    await page.locator('[data-page="p2"]').scrollIntoViewIfNeeded();
    await settle(page);
    await selectByElement(page, 'r-rot-p2');
    const { object, frame } = await probe(page, 'r-rot-p2');
    expect(frame.w).toBeCloseTo(object.w, 0);
    expect(frame.h).toBeCloseTo(object.h, 0);
    expect(frame.x).toBeCloseTo(object.x, 0);
    expect(frame.y).toBeCloseTo(object.y, 0);
  });

  test('the overlay never becomes document identity', async ({ page }) => {
    // The outline is chrome: it lives outside the zoomed stack, is marked `aria-hidden`, and carries
    // `data-for` rather than `data-oid` so no selector can confuse it with an object (ADR 0008 13.1).
    await select(page, { x: 160, y: 110 });

    const identity = await page.evaluate(() => {
      const group = document.querySelector('.p1-overlay-group--selection');
      return {
        for: group?.getAttribute('data-for') ?? null,
        oid: group?.getAttribute('data-oid'),
        insideStack: document.querySelector('[data-pages]')?.contains(group ?? null) ?? true,
        hidden: document.querySelector('.overlay')?.getAttribute('aria-hidden') ?? null,
        objectCount: document.querySelectorAll('[data-objects] [data-oid]').length,
      };
    });
    expect(identity.for).toBe('r-rot');
    expect(identity.oid, 'never answers to the document identifier').toBeNull();
    expect(identity.insideStack, 'lives outside the zoomed document').toBe(false);
    expect(identity.hidden).toBe('true');
    // Eight objects across the two pages. The outline added none: the count is the document's, not
    // the selection's.
    expect(identity.objectCount, 'and adds no document objects').toBe(8);
  });

  test('a marquee selects by PAINTED bounds, not by the model frame', async ({ page }) => {
    // The same F6 root cause one cause further out. `applyMarquee` used to test
    // `toRect(node.transform)` -- the model frame -- so a marquee could not select a rotated object
    // by a region that visibly covers it. That is the identical failure `applyMarquee`'s own comment
    // describes for an ellipse's transparent corner, one cause further out.
    //
    // The discriminating region is a strip along the **top of the painted bounding box**, which for
    // `r-rot` sits above the model frame entirely: the frame is y 60..160, and the rotated shape's
    // bounding box starts at y 16.7. The old code would not select; the new code does.
    //
    // (The opposite direction has no discriminating region: at 30 degrees the model frame is wholly
    // *inside* the painted bounds, so "a region inside the frame but outside the shape" always
    // still selects. Worth knowing, because it is why the first draft of this test picked a region
    // that could not fail.)
    const strip = await page.evaluate(() => {
      const el = document.querySelector('[data-oid="r-rot"]');
      if (!(el instanceof HTMLElement)) throw new Error('no object');
      const box = el.getBoundingClientRect();
      return {
        // A strip at the very top of the painted box, in **client** px.
        from: { x: box.x + box.width * 0.4, y: box.y + 2 },
        to: { x: box.x + box.width * 0.6, y: box.y + 8 },
        topY: box.y + 8,
      };
    });

    // The premise, asserted: the strip really is above the model frame. Compared in client px
    // against the frame's own client position, because page and client are different spaces and
    // mixing them measures a large meaningless distance.
    const frameTopLeft = await clientPointAt(page, 60, 60);
    expect(
      strip.topY,
      'the strip is above the model frame, so the old code could not select here',
    ).toBeLessThan(frameTopLeft.y);

    await page.mouse.move(strip.from.x, strip.from.y);
    await page.mouse.down();
    await page.mouse.move(strip.to.x, strip.to.y, { steps: 6 });
    await page.mouse.up();
    await settle(page);

    const selected = await page.evaluate(() => {
      const group = document.querySelector('.p1-overlay-group--selection');
      return group?.getAttribute('data-for') ?? null;
    });
    expect(selected, 'a region over the rotated shape selects it').toBe('r-rot');

    // And the control in the other direction: a region over genuinely empty page still selects
    // nothing, so the test is not passing because marquees select everything.
    //
    // The first draft used (20, 20) -- (60, 50), which looks empty but *overlaps* `r-rot`'s
    // painted bounds (they start at x 48.4, y 16.7, well above and left of the frame). The
    // control failed and was right to: the selection was correct. Clear space on a 900x700 page
    // with every object in the upper left is the bottom-right corner.
    const empty = await clientPointAt(page, 810, 630);
    await page.mouse.move(empty.x, empty.y);
    await page.mouse.down();
    await page.mouse.move(empty.x + 60, empty.y + 40, { steps: 4 });
    await page.mouse.up();
    await settle(page);
    const cleared = await page.evaluate(() => {
      const group = document.querySelector('.p1-overlay-group--selection');
      return group?.getAttribute('data-for') ?? null;
    });
    expect(cleared, 'a region over empty page still selects nothing').toBeNull();
  });

  test('the overlay still does not intercept pointer events', async ({ page }) => {
    // The fix moved geometry around inside a `pointer-events: none` layer. If anything in that layer
    // had been given `pointer-events: auto`, every click would start hitting chrome -- and the
    // rotated frame covers a *different* region than the old one did, so this had to be re-checked
    // rather than assumed.
    await select(page, { x: 160, y: 110 });
    const intercepts = await page.evaluate(() => {
      const box = document.querySelector('.p1-overlay-group--selection .p1-overlay-box');
      if (!(box instanceof HTMLElement)) throw new Error('no frame');
      const r = box.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return {
        onFrame: box.contains(hit) || hit === box,
        oid: hit?.closest('[data-oid]')?.getAttribute('data-oid') ?? null,
      };
    });
    expect(intercepts.onFrame, 'the frame does not swallow clicks').toBe(false);
    expect(intercepts.oid, 'the click reaches the object instead').toBe('r-rot');
  });
});