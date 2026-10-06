import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { clickAt, drag, selectionCount, settle } from './helpers';
import { mountFixture } from '../visual/harness';
import { GEOMETRY, SHAPES } from './shape-fixtures';

/**
 * Nothing the application paints is ever a shear.
 *
 * ADR 0005 fixes the transform as `R(t) * S(sx, sy)`, so the model's linear part always has
 * perpendicular columns. ADR 0008 proved that this blocks a non-uniform multi-object resize, and
 * ADR 0010 shows it blocks group-local coordinates under a non-uniform group scale. Both of those
 * were *design decisions taken in the model layer*, and nothing so far checks that the running
 * application respects them.
 *
 * That is the gap this file closes. The proofs are static: they say `Transform2D` cannot hold a
 * shear. This says the live document never contains one, after every gesture the editor can
 * actually perform. A future gesture that composes a page-frame scale with a member's own rotation
 * -- which is exactly what "resize two selected objects with a corner handle" would be -- fails
 * here rather than shipping a skewed rectangle that every other test would accept, because a skew
 * of 0.4 still moves the object and still changes its width.
 *
 * ## Why it can be true today
 *
 * Not by luck. `resizeTransform` unprojects the pointer into the object's *own* space
 * (`src/editor/transform.ts`) and changes `width`/`height`, which is a scale about the object's
 * own axes: `R * S`, always representable. The page-frame composition only appears when the
 * handles belong to something other than the object -- a multi-selection's bounding box, or a
 * group's frame. That is the same distinction M8 and M10 turn on, observed here from the outside.
 *
 * ## The checker checks itself
 *
 * A sweep that finds nothing proves nothing unless the sweep can fail. So the last test injects a
 * known shear into a live element and requires the same sweep to reject it. If the predicate, the
 * matrix parsing, or the selector silently stopped working, that test fails -- which is the only
 * thing that makes the sweep above trustworthy.
 */

interface PaintedMatrix {
  id: string;
  type: string;
  a: number;
  b: number;
  c: number;
  d: number;
  /** Dot product of the linear part's columns: zero for anything `Transform2D` can produce. */
  shear: number;
  /** True when the matrix is not the identity, so the sweep is not passing on nothing. */
  nonIdentity: boolean;
  /** True when the matrix carries a real rotation. */
  rotated: boolean;
  /** True when the matrix carries a real non-unit scale. */
  scaled: boolean;
  /**
   * The model's `x`/`y`, which the renderer writes as `left`/`top` rather than as a matrix
   * translation -- `cssMatrix` carries the linear part only. Read from here because it is
   * zoom-invariant (ADR 0004) and therefore comparable against a gesture delta directly, where
   * `getBoundingClientRect` would report a rotated, scaled box.
   */
  left: number;
  top: number;
  /**
   * The model's `width`/`height`, from the layout APIs rather than the rect, for the same reason.
   *
   * This is what a *resize* actually changes. It is not the same thing as the matrix scale: no
   * gesture in the application writes `scaleX`/`scaleY` (see the ADR), so a resized object's
   * matrix keeps unit scale while its box grows. Confusing the two is how a "the scale changed"
   * assertion ends up testing nothing.
   */
  boxWidth: number;
  boxHeight: number;
  /** Axis lengths of the linear part, which stay at 1 for every gesture the app has today. */
  axisX: number;
  axisY: number;
}

/** Reads every object's computed matrix and classifies it. */
function paintedMatrices(page: Page): Promise<PaintedMatrix[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-objects] [data-oid]')).map((el) => {
      const style = getComputedStyle(el);
      const m = new DOMMatrixReadOnly(style.transform === 'none' ? undefined : style.transform);
      const identity = m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1;
      const unitX = Math.abs(Math.hypot(m.a, m.b) - 1) > 1e-6;
      const unitY = Math.abs(Math.hypot(m.c, m.d) - 1) > 1e-6;
      return {
        id: el.getAttribute('data-oid') ?? '?',
        type: el.getAttribute('data-type') ?? '?',
        a: m.a,
        b: m.b,
        c: m.c,
        d: m.d,
        shear: m.a * m.c + m.b * m.d,
        nonIdentity: !identity,
        rotated: Math.abs(m.b) > 1e-6 || Math.abs(m.c) > 1e-6,
        scaled: unitX || unitY,
        left: Number.parseFloat((el as HTMLElement).style.left),
        top: Number.parseFloat((el as HTMLElement).style.top),
        boxWidth: el instanceof HTMLElement ? el.offsetWidth : 0,
        boxHeight: el instanceof HTMLElement ? el.offsetHeight : 0,
        axisX: Math.hypot(m.a, m.b),
        axisY: Math.hypot(m.c, m.d),
      };
    }),
  );
}

/** A failure message that names the object and the magnitude, since "a shear" alone is useless. */
function describeShears(matrices: readonly PaintedMatrix[]): string {
  return matrices
    .filter((m) => Math.abs(m.shear) > 1e-12)
    .map((m) => `${m.type} "${m.id}" shear=${m.shear.toExponential(3)}`)
    .join('; ');
}

async function expectNoShear(page: Page): Promise<PaintedMatrix[]> {
  const matrices = await paintedMatrices(page);
  expect(matrices.length, 'the sample document has objects to check').toBeGreaterThan(0);
  const sheared = describeShears(matrices);
  expect(sheared, `sheared objects: ${sheared}`).toBe('');
  return matrices;
}

/** The one rotated, on-page object this file drives. `rect-rotated` is *not* it: the fixture
 * places that one at y=320 on a 300-high page, so it is outside the page, unselectable, and an
 * earlier draft of this file passed its "move" test without the click ever landing. */
const ROTATED = 'ellipse-rotated';

async function matrixFor(page: Page, id: string): Promise<PaintedMatrix> {
  const matrices = await paintedMatrices(page);
  const found = matrices.find((m) => m.id === id);
  if (found === undefined) throw new Error(`no painted object "${id}"`);
  return found;
}

/**
 * Selects an object by clicking the centre of its model box, in **document px**.
 *
 * `clickAt` and `drag` take document coordinates and convert internally, so passing client
 * coordinates -- which is what `getBoundingClientRect` hands back -- silently aims at the wrong
 * place. The first draft of this file did exactly that and selected nothing, which reads as
 * "the drag does not work" rather than "the click missed".
 */
async function selectById(page: Page, id: keyof typeof GEOMETRY): Promise<void> {
  const box = GEOMETRY[id];
  await clickAt(page, box.x + box.width / 2, box.y + box.height / 2);
  expect(await selectionCount(page), `"${id}" was really selected`).toBe(1);
}

/** The centre of an object's model box, in document px. */
function centreOf(id: keyof typeof GEOMETRY): { x: number; y: number } {
  const box = GEOMETRY[id];
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.describe('the live document never contains a shear', () => {
  test('the sample document, as loaded', async ({ page }) => {
    await mountFixture(page, SHAPES);
    const matrices = await expectNoShear(page);

    // The negative control for the sweep: it must be looking at matrices that are actually
    // doing something. An all-identity sweep would pass the check above for free.
    expect(matrices.filter((m) => m.rotated).length, 'some object is rotated').toBeGreaterThan(0);
    expect(matrices.filter((m) => m.nonIdentity).length).toBeGreaterThan(0);
  });

  test('after moving a rotated object', async ({ page }) => {
    await mountFixture(page, SHAPES);
    await selectById(page, ROTATED);

    const before = await matrixFor(page, ROTATED);
    expect(before.rotated, 'the subject really is rotated before the drag').toBe(true);

    const centre = centreOf(ROTATED);
    const DX = 40;
    const DY = 15;
    await drag(page, centre, { x: centre.x + DX, y: centre.y + DY });

    await expectNoShear(page);
    const after = await matrixFor(page, ROTATED);
    // The **full** delta, not "it moved". A drag that lost its pointer halfway still moves the
    // object, and 7.5px of an intended 40px satisfies a truthiness check -- which is exactly how
    // M8's live `pointercancel` bug stayed green.
    expect(after.left - before.left, 'x moved by the whole drag').toBeCloseTo(DX, 0);
    expect(after.top - before.top, 'y moved by the whole drag').toBeCloseTo(DY, 0);
    expect(after.rotated, 'and a move must not un-rotate it').toBe(true);
    // A pure translation: the linear part is untouched, which is the strongest form of the claim.
    expect(after.a).toBeCloseTo(before.a, 9);
    expect(after.b).toBeCloseTo(before.b, 9);
    expect(after.c).toBeCloseTo(before.c, 9);
    expect(after.d).toBeCloseTo(before.d, 9);
  });

  test('after a non-uniform resize of a rotated object', async ({ page }) => {
    await mountFixture(page, SHAPES);
    await selectById(page, ROTATED);

    const before = await matrixFor(page, ROTATED);
    const handle = await page
      .locator('.p1-overlay-group--selection [data-handle="se"]')
      .boundingBox();
    if (handle === null) throw new Error('no se handle');

    // Asymmetric, so a uniform scale cannot explain the result.
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + 90, handle.y + 20, { steps: 6 });
    await page.mouse.up();
    await settle(page);

    await expectNoShear(page);
    const resized = await matrixFor(page, ROTATED);
    expect(resized.rotated, 'still rotated').toBe(true);
    // The non-vacuity assertions for this gesture: the object is off-axis *and* its box changed.
    // Note what a resize does *not* change -- the matrix scale. No gesture in the application
    // writes `scaleX`/`scaleY` (ADR 0010 §6), so "the box grew" and "the matrix scaled" are
    // different claims, and an earlier draft of this test asserted the second one and so checked
    // nothing at all.
    expect(resized.boxWidth, 'the box really grew, so this is not the fixture again').not.toBe(
      before.boxWidth,
    );
    expect(resized.boxHeight, 'and by a different amount, so the resize is not uniform').not.toBe(
      before.boxHeight,
    );
    // The mechanism, made explicit: `resizeTransform` unprojects the pointer into the object's
    // own space and changes the box, so the linear part is untouched. That is the whole reason a
    // rotated object can be resized at all without shearing, and it is the same distinction
    // M8 §4 and ADR 0010 turn on -- the object's own axes versus the page's.
    expect(resized.a).toBeCloseTo(before.a, 9);
    expect(resized.b).toBeCloseTo(before.b, 9);
    expect(resized.c).toBeCloseTo(before.c, 9);
    expect(resized.d).toBeCloseTo(before.d, 9);
  });

  test('after rotating an unrotated object', async ({ page }) => {
    await mountFixture(page, SHAPES);
    await selectById(page, 'rect-plain');

    const before = await matrixFor(page, 'rect-plain');
    expect(
      before.rotated,
      'starts unrotated, which is the only state from which the rotate handle is offered',
    ).toBe(false);

    const grip = await page.locator('.p1-overlay-rotate').boundingBox();
    if (grip === null) throw new Error('no rotation handle');
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + 70, grip.y + 55, { steps: 6 });
    await page.mouse.up();
    await settle(page);

    await expectNoShear(page);
    const turned = await matrixFor(page, 'rect-plain');
    expect(turned.rotated, 'the rotate really took').toBe(true);
    // And the box did not move, which is the other half of what rotation means here.
    expect(turned.left).toBeCloseTo(before.left, 1);
  });

  test('a rotation gesture exists for a single selection, rotated or not', async ({ page }) => {
    // M10 recorded this as "the handle is emitted only while `rotation === 0`" and read the condition
    // as a capability limit. It was not: it was a workaround for the selection frame not following
    // the rotation (ADR 0011 §8 F6). M11 fixed the frame, so the condition is gone and this test now
    // pins the corrected rule.
    //
    // What is left is a genuine capability limit, stated as one: the grip's pivot is the single
    // selected object's frame centre, so with several objects selected there is no coherent point to
    // rotate about -- because M8 deliberately has no aggregate selection frame.
    await mountFixture(page, SHAPES);

    await selectById(page, 'rect-plain');
    expect(await page.locator('.p1-overlay-rotate').isVisible(), 'unrotated single').toBe(true);

    const grip = await page.locator('.p1-overlay-rotate').boundingBox();
    if (grip === null) throw new Error('no rotation handle');
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + 70, grip.y + 55, { steps: 6 });
    await page.mouse.up();
    await settle(page);
    expect(await page.locator('.p1-overlay-rotate').isVisible(), 'and still, once rotated').toBe(true);

    // And the subject really is rotated, so this is not a handle that survived on an unchanged
    // document.
    const rotated = await page
      .locator('[data-objects] [data-oid="rect-plain"]')
      .evaluate((el) => Math.abs(new DOMMatrixReadOnly(getComputedStyle(el).transform).b));
    expect(rotated, 'the subject is genuinely rotated').toBeGreaterThan(0.1);

    // A multi-selection: still withheld, and now for the stated reason rather than by accident.
    await page.keyboard.press('Escape');
    await selectById(page, 'rect-stroked');
    await page.keyboard.press('Control+a');
    await settle(page);
    expect(await selectionCount(page), 'several objects selected').toBeGreaterThan(1);
    expect(
      await page.locator('.p1-overlay-rotate').isVisible(),
      'no rotation gesture for a multi-selection, because there is no aggregate frame',
    ).toBe(false);

    await expectNoShear(page);
  });
});

test.describe('the sweep can fail', () => {
  test('a deliberately sheared element is rejected', async ({ page }) => {
    await mountFixture(page, SHAPES);

    // The self-test. `matrix(2, 0, 1, 1, 0, 0)` is a textbook shear: x scaled by 2, y left alone,
    // columns (2, 0) and (1, 1) with dot product 2. It is a perfectly valid CSS transform, which
    // is exactly why the model has to be the thing that forbids it.
    await page.evaluate(() => {
      const el = document.querySelector('[data-objects] [data-oid="rect-plain"]');
      if (el instanceof HTMLElement) el.style.transform = 'matrix(2, 0, 1, 1, 0, 0)';
    });

    const matrices = await paintedMatrices(page);
    const injected = matrices.find((m) => m.id === 'rect-plain');
    expect(injected, 'the injected element was found by the same selector').toBeDefined();
    expect(Math.abs(injected?.shear ?? 0), 'and the sweep reports it').toBeGreaterThan(1e-3);
    expect(describeShears(matrices), 'so the sweep would have failed').not.toBe('');
  });

  test('a pure rotation and a pure non-uniform scale are both accepted', async ({ page }) => {
    await mountFixture(page, SHAPES);

    // The other half of the self-test: the sweep must not be rejecting everything. Both of these
    // are things `Transform2D` can express and things the app legitimately paints.
    await page.evaluate(() => {
      const plain = document.querySelector('[data-objects] [data-oid="rect-plain"]');
      if (plain instanceof HTMLElement) plain.style.transform = 'rotate(0.4rad)';
      const ellipse = document.querySelector('[data-objects] [data-oid="ellipse-rotated"]');
      if (ellipse instanceof HTMLElement) ellipse.style.transform = 'scale(3, 0.5)';
    });

    const matrices = await paintedMatrices(page);
    expect(describeShears(matrices)).toBe('');
    expect(matrices.find((m) => m.id === 'rect-plain')?.rotated).toBe(true);
    expect(matrices.find((m) => m.id === 'ellipse-rotated')?.scaled).toBe(true);
  });
});
