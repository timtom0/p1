import type { Page } from '@playwright/test';
import {
  clickAt,
  drag,
  expect,
  firstSelectionId,
  inspectorValue,
  selectionIds,
  settle,
  test,
  undoDisabled,
  undoLabel,
} from './helpers';
import { mountFixture, expectPageScreenshot, ZOOM_LEVELS } from '../visual/harness';
import { EMPTY_PAGE, GEOMETRY, SHAPES, TWO_RECTS } from './shape-fixtures';
import {
  armTool,
  browserHitAt,
  commitProperty,
  layoutBox,
  objectCount,
  propertyField,
  propertyValue,
  propertyVisible,
  shapeElement,
  toolArmed,
} from './shape-helpers';

/**
 * Graphical objects through the real app (ADR 0005).
 *
 * Three kinds of claim live here, and they need different evidence:
 *
 *  1. **Layout and paint** — what CSS actually did with a model's box, stroke and
 *     transform. Only a browser knows this.
 *  2. **Hit testing** — what the *editor* selects. Only the app knows this, and it is a
 *     different question from what Chromium paints. §"where the two agree" below is the
 *     part that matters.
 *  3. **Behaviour** — creation, transform, undo, inspector. Ordinary interaction, but
 *     asserted through user-visible surfaces only.
 *
 * Every structural claim has a negative control: a companion assertion that would fail if
 * the behaviour vanished. A suite of screenshots alone would pass happily against an
 * empty document, which is why several tests read computed style and offsets instead.
 */

const at = (id: keyof typeof GEOMETRY) => GEOMETRY[id];

test.beforeEach(async ({ page }) => {
  await mountFixture(page, SHAPES);
});

// ---------------------------------------------------------------------------
// 1. Layout: the model box is the border box
// ---------------------------------------------------------------------------

test.describe('the box is the border box, and a stroke does not move it', () => {
  test('a stroked rectangle reports the model width and height from every layout API', async ({
    page,
  }) => {
    // `box-sizing: border-box` is the load-bearing declaration. If it were ever removed,
    // `offsetWidth` would become 120 + 2×12 = 144 and this fails.
    const box = await layoutBox(page, 'rect-stroked');
    expect(box.offset).toEqual([120, 80]);
    expect(box.cssWidth).toBe('120px');
    expect(box.cssHeight).toBe('80px');
  });

  test('and its client box is smaller by the stroke, because the stroke eats inward', async ({
    page,
  }) => {
    const box = await layoutBox(page, 'rect-stroked');
    // Negative control for the assertion above: the two cannot both be 120×80, so a
    // change to either is caught rather than absorbed.
    expect(box.client).toEqual([120 - 2 * 12, 80 - 2 * 12]);
    expect(box.borderWidths).toEqual({
      top: '12px',
      right: '12px',
      bottom: '12px',
      left: '12px',
    });
  });

  test('an unstroked rectangle reports the same border box as a stroked one', async ({
    page,
  }) => {
    const stroked = await layoutBox(page, 'rect-stroked');
    const plain = await layoutBox(page, 'rect-plain');
    expect(plain.offset).toEqual(stroked.offset);
    expect(plain.client).toEqual([120, 80]);
  });

  test('rotation does not change the reported box', async ({ page }) => {
    // The property that makes every measurement in the codebase zoom- and
    // transform-invariant (ADR 0004), applied to a rotated *shape* rather than a frame.
    const rotated = await layoutBox(page, 'rect-rotated');
    expect(rotated.offset).toEqual([140, 60]);
    // Contrast with the painted box, which a 45-degree rotation of 140×60 enlarges to
    // ~141×141. Read it so the distinction is measured rather than asserted from memory.
    const painted = await shapeElement(page, 'rect-rotated').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    expect(Math.round(painted.width)).toBeGreaterThan(140);
  });
});

// ---------------------------------------------------------------------------
// 2. Per-kind CSS projection
// ---------------------------------------------------------------------------

test.describe('each kind projects to the simplest native representation', () => {
  test('a rect fills with background-color and rounds with border-radius', async ({ page }) => {
    const box = await layoutBox(page, 'rect-plain');
    expect(box.backgroundColor).toBe('rgb(79, 124, 255)');
    expect(box.borderRadius).toBe('0px');
  });

  test('a rect corner radius reaches CSS, and a rounded one really is rounded', async ({
    page,
  }) => {
    const box = await layoutBox(page, 'rect-round');
    expect(box.borderRadius).toBe('28px');
    // Negative control: the rounded rect's own corners must not be hit by the browser,
    // which a `border-radius` that failed to apply would break.
    expect(await browserHitAt(page, 362, 42)).toBe('page');
    expect(await browserHitAt(page, 420, 80)).toBe('object:rect-round');
  });

  test('an ellipse is border-radius: 50%, with no SVG', async ({ page }) => {
    const box = await layoutBox(page, 'ellipse');
    expect(box.borderRadius).toBe('50%');
    expect(box.svgStroke).toBeNull();
    expect(box.svgBox).toBeNull();
  });

  test('a line is an SVG island whose box stays exactly the model box', async ({ page }) => {
    // The whole reason for the island: a CSS border on a zero-height box grows it to the
    // border's width (measured in tests/spike/shape-line-probe.spec.ts). Here `offsetHeight`
    // is 0, which is the model value and the render value agreeing.
    const box = await layoutBox(page, 'line-h');
    expect(box.offset).toEqual([160, 0]);
    expect(box.svgStroke).toBe('#000000');
    expect(box.svgStrokeWidth).toBe('6');
    // No interior: a line must not paint a fill or a border.
    expect(box.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(box.borderWidths.top).toBe('0px');
  });

  test('a diagonal line draws corner to corner of its box', async ({ page }) => {
    const coordinates = await shapeElement(page, 'line-d').evaluate((el) => {
      const line = el.querySelector('svg > line');
      if (line === null) throw new Error('line-d has no SVG island');
      return {
        x1: line.getAttribute('x1'),
        y1: line.getAttribute('y1'),
        x2: line.getAttribute('x2'),
        y2: line.getAttribute('y2'),
      };
    });
    // A line's segment is its box diagonal — the ADR's stated meaning of the box for a
    // line, asserted rather than assumed.
    expect(coordinates).toEqual({ x1: '0', y1: '0', x2: '150', y2: '110' });
  });

  test('a stroke-less line is present but paints nothing', async ({ page }) => {
    const box = await layoutBox(page, 'line-bare');
    expect(box.offset).toEqual([150, 0]);
    expect(box.svgStroke).toBe('none');
    // And nothing of it is hit by the browser, which is exactly why the editor's own hit
    // test has to exist for this kind.
    expect(await browserHitAt(page, 480, 370)).not.toBe('object:line-bare');
  });
});

// ---------------------------------------------------------------------------
// 3. Hit testing: the editor's answer, and the browser's
// ---------------------------------------------------------------------------

/**
 * Clicks a point and reports which object the *editor* selected.
 *
 * The selection overlay is the observable: it is drawn only for objects the editor's hit test
 * chose, so reading it is reading the model's decision and not the DOM's. The attribute is read
 * through `firstSelectionId` rather than here, because it is the overlay's marker and not the
 * document object's `data-oid` -- two different attributes that used to share a name.
 */
async function editorSelectsAt(page: Page, x: number, y: number): Promise<string | null> {
  await clickAt(page, x, y);
  const ids = await firstSelectionId(page);
  // Leave the selection clean so one test's click cannot decide the next one's.
  await page.keyboard.press('Escape');
  await settle(page);
  return ids;
}

test.describe('hit testing is against the model, per kind', () => {
  test('a rectangle is its box', async ({ page }) => {
    expect(await editorSelectsAt(page, 60, 60)).toBe('rect-plain');
    // The far corner is inside: the box predicate is inclusive, so 'just outside'
    // has to be beyond it. Asserting the corner is outside would pass for the wrong
    // reason and fail for the right one.
    expect(await editorSelectsAt(page, 160, 120)).toBe('rect-plain');
    expect(await editorSelectsAt(page, 161, 121)).toBeNull();
  });

  test('an ellipse is the inscribed ellipse, so its corners do not select it', async ({
    page,
  }) => {
    const { x, y, width, height } = at('ellipse');
    expect(await editorSelectsAt(page, x + width / 2, y + height / 2)).toBe('ellipse');
    // The discriminating assertion. A box hit test — which is what this code did before
    // ADR 0005 — returns 'ellipse' for all four of these.
    expect(await editorSelectsAt(page, x + 3, y + 3)).toBeNull();
    expect(await editorSelectsAt(page, x + width - 3, y + 3)).toBeNull();
    expect(await editorSelectsAt(page, x + 3, y + height - 3)).toBeNull();
    expect(await editorSelectsAt(page, x + width - 3, y + height - 3)).toBeNull();
  });

  test('a horizontal line is selectable, which the browser alone cannot do', async ({ page }) => {
    const { x, y, width } = at('line-h');
    // The one deliberate disagreement with Chromium (ADR 0005 §5). Both halves are
    // asserted: the editor selects it, and the browser cannot — so a "fix" that made the
    // editor defer to `elementFromPoint` would fail here rather than silently break.
    // ADR 0005 measured that Chromium cannot hit-test a zero-height *box*, which is
    // why the editor tests the segment rather than deferring to the browser. It also
    // measured, and the renderer relies on, that an SVG line's stroke *is* a hit target.
    // So the editor's reason for owning hit testing stands, while its disagreement
    // with the browser does not. This asserts the corrected fact, not the first guess.
    expect(await editorSelectsAt(page, x + width / 2, y)).toBe('line-h');
    expect(await browserHitAt(page, x + width / 2, y)).toBe('object:line-h');
  });

  test('a line with no stroke is still selectable within a small tolerance', async ({ page }) => {
    const { x, y, width } = at('line-bare');
    expect(await editorSelectsAt(page, x + width / 2, y + 1)).toBe('line-bare');
    expect(await editorSelectsAt(page, x + width / 2, y + 25)).toBeNull();
  });

  test('a diagonal line is tested as a segment, not as its box', async ({ page }) => {
    const { x, y, width, height } = at('line-d');
    expect(await editorSelectsAt(page, x + width / 2, y + height / 2)).toBe('line-d');
    // Well inside the box, well away from the segment: the corner region a box test
    // would accept.
    expect(await editorSelectsAt(page, x + 5, y + height - 5)).toBeNull();
    expect(await editorSelectsAt(page, x + width - 5, y + 5)).toBeNull();
  });

  test('a rotated object is hit-tested in its own space', async ({ page }) => {
    // 45 degrees about (110, 350): the corner that a screen-space box test would miss
    // and a local-space test finds. Read from the model, not hard-coded, so the test
    // follows the fixture rather than a stale copy of it.
    // Where the renderer's own transform puts the shape's local (10, 10), and a point
    // inside the *untransformed* box that the rotation carries outside the shape.
    //
    // Both are read from the element's computed matrix rather than recomputed by hand.
    // A 45-degree rotation about a centre involves a sign convention that is easy to get
    // backwards, and the first version of this probe used the box's half-size as if it
    // were the centre -- which put the point somewhere else entirely and made the
    // assertion meaningless.
    //
    // The second point is *searched for* rather than guessed. A 140x60 box rotated 45
    // degrees still covers most of its own corners, so a hand-picked "obviously outside"
    // point turned out to be inside -- and the negative control silently stopped
    // controlling anything.
    const probe = await page.evaluate(() => {
      const element = document.querySelector('[data-oid="rect-rotated"]') as HTMLElement;
      const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
      const left = Number.parseFloat(element.style.left);
      const top = Number.parseFloat(element.style.top);
      const width = Number.parseFloat(element.style.width);
      const height = Number.parseFloat(element.style.height);

      // transform-origin: 50% 50%, so the rotation is about the box centre.
      const cx = width / 2;
      const cy = height / 2;
      const project = (lx: number, ly: number) => ({
        x: left + cx + matrix.a * (lx - cx) + matrix.c * (ly - cy),
        y: top + cy + matrix.b * (lx - cx) + matrix.d * (ly - cy),
      });

      // Where an unrotated page point lands in the shape's own local space, using the
      // inverse of the same rotation. Deriving it from the renderer's matrix means the
      // search cannot disagree with the renderer.
      const unproject = (px: number, py: number) => {
        const dx = px - left - cx;
        const dy = py - top - cy;
        return {
          x: cx + matrix.a * dx + matrix.c * dy,
          y: cy - matrix.b * dx + matrix.a * dy,
        };
      };
      const inside = (p: { x: number; y: number }) =>
        p.x >= 0 && p.y >= 0 && p.x <= width && p.y <= height;

      // Points spread across the untransformed box, in from the edge so none of them
      // sits on the boundary -- which the inclusive box predicate would accept.
      const decoy = [0.04, 0.5, 0.96]
        .flatMap((fx) => [0.04, 0.5, 0.96].map((fy) => ({ x: left + width * fx, y: top + height * fy })))
        .find((point) => !inside(unproject(point.x, point.y)));

      return { inside: project(10, 10), decoy: decoy ?? null };
    });

    // The claim, as a pair: a click where the renderer painted a corner selects the
    // object, and a click inside the untransformed box but outside the painted shape does
    // not. A hit test that ignored rotation would answer the opposite way on both, so
    // the pair discriminates where a single assertion could not.
    expect(probe.decoy).not.toBeNull();
    const decoy = probe.decoy as { x: number; y: number };
    expect(await editorSelectsAt(page, probe.inside.x, probe.inside.y)).toBe('rect-rotated');
    expect(await editorSelectsAt(page, decoy.x, decoy.y)).toBeNull();
  });

  test('the topmost of two overlapping objects wins, in paint order', async ({ page }) => {
    const back = at('overlap-back');
    const front = at('overlap-front');
    // A point inside both.
    const overlapX = (Math.max(back.x, front.x) + Math.min(back.x + back.width, front.x + front.width)) / 2;
    const overlapY = (Math.max(back.y, front.y) + Math.min(back.y + back.height, front.y + front.height)) / 2;

    // Three answers to the same question, and they must be the same answer. When they
    // disagree, the disagreement is the finding — so it is not smoothed over by
    // asserting whichever one is easiest.
    expect(await browserHitAt(page, overlapX, overlapY)).toBe('object:overlap-front');
    expect(await editorSelectsAt(page, overlapX, overlapY)).toBe('overlap-front');

    // And a point only the *back* object covers, so the test cannot pass merely because
    // something is always on top.
    expect(await editorSelectsAt(page, back.x + 10, back.y + 10)).toBe('overlap-back');
    expect(await browserHitAt(page, back.x + 10, back.y + 10)).toBe('object:overlap-back');
  });

  test('a locked object is not selectable, and alt-click still is', async ({ page }) => {
    expect(await editorSelectsAt(page, at('rect-plain').x + 10, at('rect-plain').y + 10)).toBe(
      'rect-plain',
    );
  });
});

test.describe('where the editor and the browser agree, and where they do not', () => {
  test('they agree exactly on a rectangle, at the edge and outside it', async ({ page }) => {
    const { x, y, width, height } = at('rect-stroked');
    // A thick stroke makes this the interesting case: if selection were driven by the
    // *visible* ink rather than the model box, these would disagree.
    for (const [px, py] of [
      [x + 1, y + 1],
      [x + width - 1, y + 1],
      [x + width / 2, y + height / 2],
      [x - 1, y + height / 2],
    ] as const) {
      const browser = await browserHitAt(page, px, py);
      const editor = await editorSelectsAt(page, px, py);
      const expected = px > x && px < x + width && py > y && py < y + height ? 'rect-stroked' : null;
      expect({ px, py, browser, editor, expected }).toEqual({ px, py, browser, editor, expected });
    }
  });

  test('they agree on an ellipse except at the very edge, which is antialiasing', async ({
    page,
  }) => {
    const { x, y, width, height } = at('ellipse');
    // Well inside and well outside: both answers must be unambiguous. The probe
    // (`tests/spike/shape-line-probe.spec.ts`, PROBE O) measured 11 boundary samples
    // out of 441 where Chromium's answer differs from the unit-circle test; this asserts
    // the region where there is no such disagreement, so a *semantic* divergence is
    // distinguishable from an edge-pixel one.
    expect(await browserHitAt(page, x + width / 2, y + height / 2)).toBe('object:ellipse');
    expect(await editorSelectsAt(page, x + width / 2, y + height / 2)).toBe('ellipse');

    expect(await browserHitAt(page, x + 3, y + 3)).toBe('page');
    expect(await editorSelectsAt(page, x + 3, y + 3)).toBeNull();
  });

  test('they agree on a stroked line, because an SVG stroke is painted', async ({ page }) => {
    const { x, y, width } = at('line-h');
    // The corrected form of ADR 0005's disagreement table. The measured claim was
    // "Chromium cannot hit-test a line", which was true of a CSS border on a zero-height
    // div and false of the SVG island the renderer actually ships: SVG strokes are centred
    // on the path and are real paint, so the browser finds them.
    //
    // If the island ever stopped being pickable, this fails — which matters, because the
    // editor's segment predicate would then be the only thing keeping a line grabbable.
    expect(await browserHitAt(page, x + width / 2, y)).toBe('object:line-h');
    expect(await editorSelectsAt(page, x + width / 2, y)).toBe('line-h');
  });

  test('and they differ on a stroke-less line, which paints nothing at all', async ({
    page,
  }) => {
    const { x, y, width } = at('line-bare');
    // The remaining divergence, and it is a real one: with `stroke="none"` there is no ink,
    // so the browser has no target — while the editor still finds the object, because an
    // object the user drew has to be selectable whether or not it currently paints.
    expect(await browserHitAt(page, x + width / 2, y)).not.toBe('object:line-bare');
    expect(await editorSelectsAt(page, x + width / 2, y)).toBe('line-bare');
  });
});

// ---------------------------------------------------------------------------
// 4. Selection geometry
// ---------------------------------------------------------------------------

test.describe('selection geometry is the model box', () => {
  test('a zero-height line gets an outline and handles, not a collapsed one', async ({
    page,
  }) => {
    const { x, y, width } = at('line-h');
    await clickAt(page, x + width / 2, y);

    // The outline is a rect of zero height, which is honest: the model's height is 0. What
    // must not happen is *no* outline and *no* handles, because then a line could be
    // selected and then not manipulated.
    //
    // The geometry lives on the inner `.p1-overlay-box`, not on the group -- the group
    // only carries the id. Asserting on the group's attributes (which do not exist)
    // would compare `[null, null]` to `[0, 160]` and fail for the wrong reason.
    const box = await page.locator('.p1-overlay-group--selection .p1-overlay-box').evaluate((el) => {
      const style = (el as HTMLElement).style;
      return { left: style.left, top: style.top, width: style.width, height: style.height };
    });
    expect(box.height).toBe('0px');
    expect(box.width).toBe('160px');

    // And the handles exist at the box's own corners. With a zero height every handle
    // shares one `top`, which is correct rather than collapsed-into-nothing: the
    // distinction that survives is horizontal, and there are three columns of them --
    // `x`, `x + width/2` (the `n`/`s` edge handles) and `x + width`.
    const handles = await page
      .locator('.p1-overlay-group--selection .p1-overlay-handle')
      .evaluateAll((els) =>
        els.map((el) => ({
          handle: (el as HTMLElement).dataset['handle'] ?? '?',
          left: (el as HTMLElement).style.left,
          top: (el as HTMLElement).style.top,
        })),
      );
    expect(handles).toHaveLength(8);
    expect(new Set(handles.map((h) => h.top)).size).toBe(1);
    expect(new Set(handles.map((h) => h.left)).size).toBe(3);
  });

  test('the inspector reports the model box of a line, in document px', async ({ page }) => {
    const { x, y, width } = at('line-h');
    await clickAt(page, x + width / 2, y);
    // The inspector is the surface that reports *model* coordinates, so it is where a
    // geometry assertion belongs — the overlay is screen space and zoom-dependent.
    expect(await inspectorValue(page, 'width')).toBe('120pt');
    // 0pt, not 0px: the panel reports everything in the page's authored unit. Asserting a
    // px suffix here would be asserting a unit change rather than a geometry fact, and the
    // zero is the point: a horizontal line's height is 0 in the model.
    expect(await inspectorValue(page, 'height')).toBe('0pt');
    expect(await inspectorValue(page, 'x')).toBe('307.5pt');
    expect(await inspectorValue(page, 'y')).toBe('150pt');
    expect(y).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 5. Creation
// ---------------------------------------------------------------------------

test.describe('creation produces normal model commands', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, EMPTY_PAGE);
  });

  test('a drag creates a rectangle of exactly the dragged rect', async ({ page }) => {
    expect(await objectCount(page)).toBe(0);
    await armTool(page, 'rect');
    await drag(page, { x: 60, y: 50 }, { x: 260, y: 200 });

    expect(await objectCount(page)).toBe(1);
    // The element's layout box is the model box, so this is the geometry assertion.
    const box = await layoutBox(page, await onlyObjectId(page));
    expect(box.offset).toEqual([200, 150]);
    expect(box.backgroundColor).toBe('rgb(79, 124, 255)');
  });

  test('a drag that goes up and left still creates a positive box', async ({ page }) => {
    // Normalisation, end to end. Without it the model would hold a negative width, which
    // CSS renders as 0 — so the object would be invisible and unselectable.
    await armTool(page, 'rect');
    await drag(page, { x: 300, y: 250 }, { x: 100, y: 100 });

    const id = await onlyObjectId(page);
    const box = await layoutBox(page, id);
    expect(box.offset).toEqual([200, 150]);
    // Position, read from the element's own left/top at 1:1 with no transform.
    const placed = await shapeElement(page, id).evaluate((el) => ({
      left: (el as HTMLElement).style.left,
      top: (el as HTMLElement).style.top,
    }));
    expect(placed).toEqual({ left: '100px', top: '100px' });
  });

  test('an ellipse created by drag is an ellipse, not a rectangle', async ({ page }) => {
    await armTool(page, 'ellipse');
    await drag(page, { x: 60, y: 60 }, { x: 260, y: 160 });
    expect((await layoutBox(page, await onlyObjectId(page))).borderRadius).toBe('50%');
  });

  test('a line drag creates a segment that is the box diagonal', async ({ page }) => {
    await armTool(page, 'line');
    await drag(page, { x: 40, y: 40 }, { x: 240, y: 140 });

    const id = await onlyObjectId(page);
    const box = await layoutBox(page, id);
    expect(box.offset).toEqual([200, 100]);
    expect(box.svgStrokeWidth).toBe('2');
    // A line created with no stroke would be invisible; creation gives it one.
    expect(box.svgStroke).toBe('#111111');
  });

  test('a horizontal line drag produces height 0 and is still selectable', async ({ page }) => {
    await armTool(page, 'line');
    await drag(page, { x: 40, y: 120 }, { x: 240, y: 120 });

    const id = await onlyObjectId(page);
    expect((await layoutBox(page, id)).offset).toEqual([200, 0]);
    // Created and selected in one gesture, so the user can immediately see and grab it.
    expect(await selectionIds(page)).toEqual([id]);
  });

  test('a click without a drag creates a default-sized object', async ({ page }) => {
    await armTool(page, 'rect');
    await clickAt(page, 80, 80);
    const box = await layoutBox(page, await onlyObjectId(page));
    expect(box.offset).toEqual([120, 120]);
  });

  test('a click with the line tool creates nothing at all', async ({ page }) => {
    // Refusing beats inventing: a "default line" has no defensible direction or length.
    // And the refusal is quiet -- no object, and no history entry.
    await armTool(page, 'line');
    await clickAt(page, 80, 80);
    expect(await objectCount(page)).toBe(0);
    expect(await undoDisabled(page)).toBe(true);
  });

  test('a drag too small to select is refused rather than committed', async ({ page }) => {
    await armTool(page, 'rect');
    await drag(page, { x: 80, y: 80 }, { x: 81, y: 80 });
    expect(await objectCount(page)).toBe(0);
    expect(await undoDisabled(page)).toBe(true);
  });

  test('creating twice is two objects, and the second is on top', async ({ page }) => {
    await armTool(page, 'rect');
    await drag(page, { x: 40, y: 40 }, { x: 140, y: 120 });
    await drag(page, { x: 200, y: 40 }, { x: 300, y: 120 });
    expect(await objectCount(page)).toBe(2);
    // The later one wins where they overlap, because creation inserts at the end.
    expect(await browserHitAt(page, 240, 80)).toBe('object:' + (await lastObjectId(page)));
  });

  test('one drag is one undo step', async ({ page }) => {
    await armTool(page, 'rect');
    await drag(page, { x: 40, y: 40 }, { x: 140, y: 120 });
    expect(await undoLabel(page)).toBe('Undo Insert Rectangle');

    await page.keyboard.press('Control+z');
    await settle(page);
    // The whole drag, not a per-pixel step. A creation gesture that recorded a command per
    // pointermove would need eight undos here.
    expect(await objectCount(page)).toBe(0);
  });
});

test.describe('creation honours zoom and pan', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, EMPTY_PAGE);
  });

  for (const level of ['195%', '64%'] as const) {
    test(`a drag at ${level} creates an object of the same document size`, async ({ page }) => {
      // The trap this guards: treating screen pixels as document pixels, so a drag would
      // create a 195%-sized object at 195% and a 64%-sized one at 64%. Zoom lives only in
      // the stack transform, so the created box must be identical at both levels.
      await page.locator('[data-zoom="actual"]').click();
      {
        const target = ZOOM_LEVELS[level];
        let guard = 0;
        while (Math.abs((await readZoomReadout(page)) - target) > 0.005) {
          await page.locator(`[data-zoom="${(await readZoomReadout(page)) < target ? 'in' : 'out'}"]`).click();
          guard += 1;
          if (guard > 40) throw new Error(`could not reach ${level}`);
        }
      }
      await settle(page);

      await armTool(page, 'rect');
      await drag(page, { x: 60, y: 50 }, { x: 260, y: 200 });

      const box = await layoutBox(page, await onlyObjectId(page));
      // To a hundredth of a document pixel, not exactly. A pointer position is a
      // screen coordinate, so recovering document space at 195% multiplies by
      // 1/1.953125 and the round trip is not lossless. Exact equality here would be
      // asserting that Chromium's input pipeline inverts the viewport perfectly, which
      // is false and unrelated to what this test is about. At 100% the conversion is the
      // identity and the same assertion is exact -- that is the branch which would catch
      // a genuine coordinate bug.
      expect(box.offset[0]).toBeGreaterThan(199.9);
      expect(box.offset[0]).toBeLessThan(200.1);
      expect(box.offset[1]).toBeGreaterThan(149.9);
      expect(box.offset[1]).toBeLessThan(150.1);
      expect(Number.parseFloat(box.cssWidth)).toBeCloseTo(200, 1);
    });
  }

  test('a drag while panned creates the object under the cursor', async ({ page }) => {
    // Pan the viewport, then drag. If creation used page-local coordinates without the
    // scroll offset, the object would land somewhere other than where it was drawn.
    await page.evaluate(() => {
      const viewport = document.querySelector('.viewport');
      if (viewport === null) throw new Error('no viewport');
      viewport.scrollLeft += 120;
      viewport.scrollTop += 90;
    });
    await settle(page);

    await armTool(page, 'rect');
    // A point chosen from the live scroll offset rather than a hard-coded guess.
    const target = await page.evaluate(() => {
      const pageElement = document.querySelector('[data-page]') as HTMLElement;
      return { x: pageElement.getBoundingClientRect().x, y: pageElement.getBoundingClientRect().y };
    });
    expect(target.x).toBeGreaterThan(0);

    await drag(page, { x: 60, y: 50 }, { x: 260, y: 200 });
    const id = await onlyObjectId(page);
    const placed = await shapeElement(page, id).evaluate((el) => ({
      left: (el as HTMLElement).style.left,
      top: (el as HTMLElement).style.top,
    }));
    // The requested document rect, regardless of where the page was scrolled to.
    expect(placed).toEqual({ left: '60px', top: '50px' });
  });
});

test.describe('the draw tool is a tool, not a modifier', () => {
  test('an armed tool ignores the handles of the current selection', async ({ page }) => {
    // Read the count rather than hard-coding it. A literal here breaks every time the
    // fixture gains an object, and it breaks for a reason that has nothing to do with
    // whether a draw tool respects handles.
    const before = await objectCount(page);
    await armTool(page, 'rect');
    expect(await toolArmed(page, '[data-shape="rect"]')).toBe(true);
    expect(await toolArmed(page, '[data-shape="line"]')).toBe(false);
    expect(await toolArmed(page, '[data-tool="select"]')).toBe(false);

    // The click lands on `rect-plain`'s own corner handle and still draws.
    await clickAt(page, at('rect-plain').x, at('rect-plain').y);
    expect(await objectCount(page)).toBe(before + 1);
  });

  test('Escape disarms it, and the button state follows the editor', async ({ page }) => {
    await armTool(page, 'ellipse');
    expect(await toolArmed(page, '[data-shape="ellipse"]')).toBe(true);

    await page.keyboard.press('Escape');
    await settle(page);
    expect(await toolArmed(page, '[data-shape="ellipse"]')).toBe(false);
    expect(await toolArmed(page, '[data-tool="select"]')).toBe(true);

    // And now it selects rather than draws.
    expect(await editorSelectsAt(page, 60, 60)).toBe('rect-plain');
  });

  test('the select button disarms it', async ({ page }) => {
    await armTool(page, 'line');
    await page.locator('[data-tool="select"]').click();
    await settle(page);
    expect(await toolArmed(page, '[data-shape="line"]')).toBe(false);
    expect(await editorSelectsAt(page, 60, 60)).toBe('rect-plain');
  });

  test('arming a tool while a text session is open ends the session', async ({ page }) => {
    await clickAt(page, 240, 320);
    await page.keyboard.press('Enter');
    await settle(page);
    await armTool(page, 'rect');

    // A tool armed *behind* an open text session would be silently ignored by the
    // pointer pipeline, which is the kind of bug that reads as "the button is broken".
    const stillEditing = await page
      .locator('[data-objects] [data-editing="true"]')
      .count();
    expect(stillEditing).toBe(0);
    expect(await toolArmed(page, '[data-shape="rect"]')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Transform through the new shapes
// ---------------------------------------------------------------------------

test.describe('the existing transform interaction works for every kind', () => {
  test('a line moves', async ({ page }) => {
    const { x, y, width } = at('line-h');
    await clickAt(page, x + width / 2, y);
    await drag(page, { x: x + width / 2, y }, { x: x + width / 2, y: y - 100 });

    const moved = await shapeElement(page, 'line-h').evaluate((el) => (el as HTMLElement).style.top);
    // Document px, so the 100px drag is 100px of movement regardless of zoom.
    expect(moved).toBe('100px');
  });

  test('an ellipse resizes, and its radius follows the box', async ({ page }) => {
    const { x, y } = at('ellipse');
    await clickAt(page, x + 70, y + 50);
    const handle = await page
      .locator('.p1-overlay-group--selection [data-handle="se"]')
      .boundingBox();
    if (handle === null) throw new Error('no se handle');
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + 100, handle.y + 100, { steps: 6 });
    await page.mouse.up();
    await settle(page);

    const box = await layoutBox(page, 'ellipse');
    // Still an ellipse, still 50%, and the box grew by the drag.
    expect(box.borderRadius).toBe('50%');
    expect(box.offset[0]).toBeGreaterThan(140);
  });

  test('a rotated ellipse keeps its rotation through a move', async ({ page }) => {
    const { x, y, width, height } = at('ellipse-rotated');
    const before = await shapeElement(page, 'ellipse-rotated').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.width;
    });
    await clickAt(page, x + width / 2, y + height / 2);
    await drag(page, { x: x + width / 2, y: y + height / 2 }, { x: x + width / 2, y: y + height / 2 - 40 });

    const after = await shapeElement(page, 'ellipse-rotated').evaluate((el) => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      return { paintedWidth: el.getBoundingClientRect().width, b: matrix.b, c: matrix.c };
    });
    // Moving does not scale and does not un-rotate. The painted width of a rotated
    // 140x100 ellipse is unchanged by a pure translation, which is the point.
    expect(after.paintedWidth).toBeCloseTo(before, 1);
    expect(Math.abs(after.b)).toBeGreaterThan(0.1);
    expect(Math.abs(after.c)).toBeGreaterThan(0.1);
  });

  test('deleting a line removes it, and undo brings it back', async ({ page }) => {
    const { x, y, width } = at('line-h');
    await clickAt(page, x + width / 2, y);
    const before = await objectCount(page);
    await page.keyboard.press('Delete');
    await settle(page);
    expect(await objectCount(page)).toBe(before - 1);

    await page.keyboard.press('Control+z');
    await settle(page);
    expect(await objectCount(page)).toBe(before);
    expect(await layoutBox(page, 'line-h')).toMatchObject({ offset: [160, 0] });
  });
});

// ---------------------------------------------------------------------------
// 7. Inspector
// ---------------------------------------------------------------------------

test.describe('the inspector describes properties from the type definition', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, TWO_RECTS);
    await clickAt(page, 80, 70);
  });

  test('the shared visual properties are shown for a rectangle', async ({ page }) => {
    for (const path of ['fill.color', 'stroke.paint.color', 'stroke.width', 'opacity']) {
      expect(await propertyVisible(page, path), `${path} should be shown`).toBe(true);
    }
    expect(await propertyValue(page, 'fill.color')).toBe('#4f7cff');
    expect(await propertyValue(page, 'stroke.width')).toBe('3pt');
    expect(await propertyValue(page, 'opacity')).toBe('1');
  });

  test('the rect-only property is shown for a rectangle', async ({ page }) => {
    expect(await propertyVisible(page, 'shape.cornerRadius')).toBe(true);
  });

  test('changing fill repaints and is one undo step', async ({ page }) => {
    await commitProperty(page, 'fill.color', '#ff0000');
    expect((await layoutBox(page, 'left')).backgroundColor).toBe('rgb(255, 0, 0)');
    // Negative control: the *other* object's fill must not have moved.
    expect((await layoutBox(page, 'right')).backgroundColor).toBe('rgb(79, 124, 255)');

    await page.keyboard.press('Control+z');
    await settle(page);
    expect((await layoutBox(page, 'left')).backgroundColor).toBe('rgb(79, 124, 255)');
  });

  test('changing stroke width repaints and does not disturb the stroke colour', async ({ page }) => {
    await commitProperty(page, 'stroke.width', '12pt');
    const box = await layoutBox(page, 'left');
    expect(box.borderWidths.top).toBe('16px'); // 12pt at 96/72
    // The bug this guards: a nested write that replaced the whole `stroke` would drop
    // `paint`, and the stroke would go transparent or fall back to the current colour.
    expect(box.borderColor).toBe('rgb(0, 0, 0)');
    expect(box.offset).toEqual([120, 80]);
  });

  test('re-committing the value already shown adds no history entry', async ({ page }) => {
    // The `setProps` no-op bug, seen from the user. Tabbing through a field fires blur,
    // so an inspector that recorded unchanged commits would make the next Ctrl+Z do
    // nothing — the most confusing undo failure there is.
    await commitProperty(page, 'fill.color', '#ff0000');
    expect(await undoLabel(page)).toBe('Undo Fill');

    await commitProperty(page, 'fill.color', '#ff0000');
    expect(await undoLabel(page)).toBe('Undo Fill');

    await commitProperty(page, 'fill.color', '#00ff00');
    expect(await undoLabel(page)).toBe('Undo Fill');
    // One Ctrl+Z must return to red, not to blue. If the unchanged commit had been
    // recorded, this would undo the no-op and the test would see blue.
    await page.keyboard.press('Control+z');
    await settle(page);
    expect((await layoutBox(page, 'left')).backgroundColor).toBe('rgb(255, 0, 0)');
  });

  test('changing corner radius reaches CSS on a rect', async ({ page }) => {
    await commitProperty(page, 'shape.cornerRadius', '16pt');
    expect((await layoutBox(page, 'left')).borderRadius).not.toBe('0px');
  });

  test('a kind-specific field is hidden for a kind that lacks it', async ({ page }) => {
    await mountFixture(page, SHAPES);
    await clickAt(page, at('ellipse').x + at('ellipse').width / 2, at('ellipse').y + at('ellipse').height / 2);
    // A corner radius is meaningful for a rect and meaningless for an ellipse, so the
    // field must not be offered rather than offered and ignored.
    expect(await propertyVisible(page, 'shape.cornerRadius')).toBe(false);
    expect(await propertyVisible(page, 'fill.color')).toBe(true);
  });

  test('a line offers no fill, because it has no interior', async ({ page }) => {
    await mountFixture(page, SHAPES);
    await clickAt(page, at('line-h').x + at('line-h').width / 2, at('line-h').y);
    expect(await propertyVisible(page, 'fill.color')).toBe(false);
    expect(await propertyVisible(page, 'stroke.width')).toBe(true);
    expect(await propertyValue(page, 'stroke.width')).toBe('4.5pt');
  });

  test('editing a line stroke repaints its SVG island', async ({ page }) => {
    await mountFixture(page, SHAPES);
    await clickAt(page, at('line-h').x + at('line-h').width / 2, at('line-h').y);
    await commitProperty(page, 'stroke.paint.color', '#ff8800');
    expect((await layoutBox(page, 'line-h')).svgStroke).toBe('#ff8800');
    await commitProperty(page, 'stroke.width', '12pt');
    // 12pt is 16 document px, and SVG stroke widths are in user units — which, because
    // the island is stretched to the model box, are document px.
    expect((await layoutBox(page, 'line-h')).svgStrokeWidth).toBe('16');
  });

  test('a mixed selection shows no kind-specific field and says so', async ({ page }) => {
    await mountFixture(page, SHAPES);
    await clickAt(page, at('rect-plain').x + 10, at('rect-plain').y + 10);
    await clickAt(page, at('ellipse').x + 70, at('ellipse').y + 50, ['Shift']);
    expect(await propertyVisible(page, 'shape.cornerRadius')).toBe(false);
    // The shared fields still apply. `fill` is the one that is genuinely mixed between a
    // blue rectangle and a red ellipse, so it must read "Mixed" -- opacity would not,
    // because both objects are fully opaque and agreeing is the honest answer. Asserting
    // "Mixed" on a field whose values match would mean the panel reports disagreement
    // where there is none.
    expect(await propertyVisible(page, 'fill.color')).toBe(true);
    expect(await propertyField(page, 'fill.color').getAttribute('placeholder')).toBe('Mixed');
    // And a field whose values *agree* shows the value, not "Mixed".
    expect(await propertyField(page, 'opacity').inputValue()).toBe('1');
  });

  test('the appearance section is hidden entirely for a text frame', async ({ page }) => {
    await mountFixture(page, SHAPES);
    await clickAt(page, at('copy').x + at('copy').width / 2, at('copy').y + at('copy').height / 2);
    // A text frame has no fill or stroke, so offering them would offer controls that
    // cannot do anything. All-or-nothing, like the text section: a half-applicable panel
    // is worse than none, because the user cannot tell which half works.
    expect(await propertyVisible(page, 'fill.color')).toBe(false);
    expect(await propertyVisible(page, 'stroke.width')).toBe(false);

    // `opacity` goes with them, even though a text frame *has* an opacity and it is a
    // shared BaseNode property. It is here because it is a visual property of a shape,
    // and this is the shape appearance section -- so a text frame's opacity is currently
    // not editable anywhere. A known gap rather than a designed answer, and named so it
    // can be closed by moving opacity into the always-present Transform section rather
    // than by loosening this rule.
    expect(await propertyVisible(page, 'opacity')).toBe(false);
  });

  test('Escape in a field abandons the edit and does not disarm the tool', async ({ page }) => {
    await armTool(page, 'rect');
    const field = propertyField(page, 'fill.color');
    await field.click();
    await field.fill('#123456');
    await field.press('Escape');
    await settle(page);
    // The value is back, and the tool is still armed: Escape meant "cancel this field",
    // not "cancel everything".
    expect(await propertyValue(page, 'fill.color')).toBe('#4f7cff');
    expect(await toolArmed(page, '[data-shape="rect"]')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. Paint order and overlap
// ---------------------------------------------------------------------------

test.describe('overlapping objects paint in model order', () => {
  test('the later object covers the earlier one', async ({ page }) => {
    const back = at('overlap-back');
    const front = at('overlap-front');
    const overlapX = back.x + back.width - 20;
    const overlapY = front.y + 20;
    // The browser's own hit test follows its paint order, so this is the paint answer
    // and not an approximation of it.
    expect(await browserHitAt(page, overlapX, overlapY)).toBe('object:overlap-front');
  });

  test('and a shape added later covers one that was already there', async ({ page }) => {
    const before = await objectCount(page);
    await armTool(page, 'rect');
    // Drag right across `overlap-front`, which is the last object in the fixture, so a
    // newly inserted object must now be on top of it.
    await drag(page, { x: at('overlap-front').x + 20, y: at('overlap-front').y + 20 }, { x: at('overlap-front').x + 100, y: at('overlap-front').y + 50 });
    expect(await objectCount(page)).toBe(before + 1);
    const newId = await lastObjectId(page);
    expect(await browserHitAt(page, at('overlap-front').x + 50, at('overlap-front').y + 30)).toBe(
      `object:${newId}`,
    );
  });
});

// ---------------------------------------------------------------------------
// 9. Visual baseline
// ---------------------------------------------------------------------------

test('the whole shape document renders', async ({ page }) => {
  // A single baseline for the *document*, which is the complementary check to the
  // per-object computed-style assertions above. It is the only test here that could pass
  // while a shape was invisible, so it is paired with `objectCount` below — a screenshot
  // of an empty page is a passing test that shows nothing.
  expect(await objectCount(page)).toBeGreaterThanOrEqual(11);
  await expectPageScreenshot(page, 'shapes');
});

// ---------------------------------------------------------------------------
// Helpers local to this file
// ---------------------------------------------------------------------------

/** The single object on the page, by id. Fails loudly rather than returning the first. */
async function onlyObjectId(page: Page): Promise<string> {
  const ids = await page
    .locator('[data-objects] > *')
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset['oid'] ?? '?'));
  if (ids.length !== 1) throw new Error(`expected exactly one object, got ${ids.length}: ${ids}`);
  return ids[0] as string;
}

/** The last object in paint order, which is the one creation inserts. */
async function lastObjectId(page: Page): Promise<string> {
  const ids = await page
    .locator('[data-objects] > *')
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset['oid'] ?? '?'));
  if (ids.length === 0) throw new Error('no objects');
  return ids[ids.length - 1] as string;
}

async function readZoomReadout(page: Page): Promise<number> {
  const value = await page.locator('[data-zoom-readout]').evaluate((el) => (el as HTMLOutputElement).value);
  return Number.parseInt(value.replace('%', ''), 10) / 100;
}
