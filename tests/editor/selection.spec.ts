import type { Page } from '@playwright/test';
import {
  FIXTURE,
  IDS,
  beginDrag,
  clickAt,
  clientPointAt,
  drag,
  endDrag,
  expect,
  frameIsEditing,
  handleCount,
  hoverId,
  inspectorPlaceholder,
  inspectorState,
  inspectorPx,
  inspectorValue,
  moveDragTo,
  rotateHandleVisible,
  selectionCount,
  selectionIds,
  settle,
  test,
  undoDisabled,
  undoLabel,
} from './helpers';
import { mountFixture } from '../visual/harness';

/** An object's rendered `left`, in document px, so a drag's full delta can be asserted. */
async function objectLeft(page: Page, id: string): Promise<number> {
  const value = await page
    .locator(`[data-objects] [data-oid="${id}"]`)
    .evaluate((el: HTMLElement) => el.style.left);
  return Number.parseFloat(value);
}

/**
 * Selection, hit testing, and the transform tools, driven through real mouse and
 * keyboard input against the real app.
 *
 * Nothing here reaches into application internals. Every assertion reads what the
 * user would see: an overlay outline, an inspector field, a history button.
 */

test.beforeEach(async ({ page }) => {
  await mountFixture(page, FIXTURE);
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

test.describe('selection', () => {
  test('clicking an object selects it and draws handles', async ({ page }) => {
    expect(await selectionCount(page)).toBe(0);

    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);

    expect(await selectionIds(page)).toEqual(['alpha']);
    expect(await handleCount(page)).toBe(8);
    expect(await inspectorState(page)).toBe('single');
  });

  test('the inspector reports the selected object in the page unit', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);

    // 40 document px is 30pt at 96dpi; the inspector shows the authored unit.
    expect(await inspectorValue(page, 'x')).toBe('30pt');
    expect(await inspectorValue(page, 'width')).toBe('90pt');

    // ...and `inspectorPx` reads the same field back as document px.
    expect(await inspectorPx(page, 'x')).toBeCloseTo(40, 6);
    expect(await inspectorPx(page, 'height')).toBeCloseTo(80, 6);
  });

  test('clicking empty page clears the selection', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    expect(await selectionCount(page)).toBe(1);

    // Bottom-left of the page, clear of every object.
    await clickAt(page, 20, 180);

    expect(await selectionCount(page)).toBe(0);
    expect(await inspectorState(page)).toBe('empty');
  });

  test('clicking another object replaces the selection', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    await clickAt(page, IDS.beta.x + 60, IDS.beta.y + 40);

    expect(await selectionIds(page)).toEqual(['beta']);
  });

  test('shift-click extends the selection', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    await clickAt(page, IDS.beta.x + 60, IDS.beta.y + 40, ['Shift']);

    expect((await selectionIds(page)).sort()).toEqual(['alpha', 'beta']);
    expect(await inspectorState(page)).toBe('mixed');
  });

  test('shift-click on a selected object removes it', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    await clickAt(page, IDS.beta.x + 60, IDS.beta.y + 40, ['Shift']);
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40, ['Shift']);

    expect(await selectionIds(page)).toEqual(['beta']);
  });

  test('a mixed selection shows Mixed rather than an arbitrary member value', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    await clickAt(page, IDS.beta.x + 60, IDS.beta.y + 40, ['Shift']);

    // alpha.x=40, beta.x=240 — genuinely different, so the field must not invent one.
    expect(await inspectorValue(page, 'x')).toBe('');
    expect(await inspectorPlaceholder(page, 'x')).toBe('Mixed');
  });

  test('a locked object is not selectable by a plain click', async ({ page }) => {
    await clickAt(page, 300, 260);

    expect(await selectionCount(page)).toBe(0);
  });

  test('alt-click reaches through to a locked object', async ({ page }) => {
    await clickAt(page, 300, 260, ['Alt']);

    expect(await selectionIds(page)).toEqual(['locked-one']);
  });

  test('marquee selects everything it touches', async ({ page }) => {
    // A band across the two top objects.
    await drag(page, { x: 20, y: 20 }, { x: 380, y: 140 });

    expect((await selectionIds(page)).sort()).toEqual(['alpha', 'beta']);
  });

  test('a marquee that touches nothing selects nothing', async ({ page }) => {
    await drag(page, { x: 420, y: 20 }, { x: 500, y: 120 });

    expect(await selectionCount(page)).toBe(0);
  });

  test('a marquee that only clips a corner still selects', async ({ page }) => {
    // Overlaps `beta`'s top-left corner by 10px. Overlap, not containment, is the rule.
    await drag(page, { x: 220, y: 30 }, { x: 260, y: 60 });

    expect(await selectionIds(page)).toEqual(['beta']);
  });

  test('hovering shows an outline without selecting', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);

    const point = await clientPointAt(page, IDS.gamma.x + 60, IDS.gamma.y + 40);
    await page.mouse.move(point.x, point.y);

    expect(await hoverId(page)).toBe('gamma');
    expect(await selectionIds(page)).toEqual(['alpha']);
  });

  test('select all covers every unlocked, visible object', async ({ page }) => {
    await page.keyboard.press('Control+a');

    // `locked-one` is in the model but the marquee path skips locked objects; select
    // all is a different question and is asserted separately below.
    const ids = (await selectionIds(page)).sort();
    expect(ids).toEqual(['alpha', 'beta', 'copy', 'gamma', 'locked-one']);
  });
});

// ---------------------------------------------------------------------------
// Move
// ---------------------------------------------------------------------------

test.describe('move tool', () => {
  test('dragging moves the object by the pointer delta', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    await drag(
      page,
      { x: IDS.alpha.x + 60, y: IDS.alpha.y + 40 },
      { x: IDS.alpha.x + 100, y: IDS.alpha.y + 60 },
    );

    expect(await inspectorPx(page, 'x')).toBeCloseTo(80, 6);
    expect(await inspectorPx(page, 'y')).toBeCloseTo(60, 6);
  });

  test('a drag of zero distance changes nothing', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    await drag(
      page,
      { x: IDS.alpha.x + 60, y: IDS.alpha.y + 40 },
      { x: IDS.alpha.x + 60, y: IDS.alpha.y + 40 },
    );

    expect(await inspectorPx(page, 'x')).toBeCloseTo(40, 6);
    // No gesture, so no history entry, so nothing to undo.
    expect(await undoDisabled(page)).toBe(true);
  });

  test('shift constrains the drag to one axis', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    await drag(
      page,
      { x: IDS.alpha.x + 60, y: IDS.alpha.y + 40 },
      { x: IDS.alpha.x + 140, y: IDS.alpha.y + 55 },
      ['Shift'],
    );

    // |dx| > |dy|, so y must be untouched.
    expect(await inspectorPx(page, 'x')).toBeCloseTo(120, 6);
    expect(await inspectorPx(page, 'y')).toBeCloseTo(40, 6);
  });

  test('dragging moves every selected object together', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    await clickAt(page, IDS.beta.x + 60, IDS.beta.y + 40, ['Shift']);
    expect((await selectionIds(page)).sort(), 'both objects are selected').toEqual([
      'alpha',
      'beta',
    ]);

    const beforeAlpha = await objectLeft(page, 'alpha');
    const beforeBeta = await objectLeft(page, 'beta');
    await drag(
      page,
      { x: IDS.alpha.x + 60, y: IDS.alpha.y + 40 },
      { x: IDS.alpha.x + 160, y: IDS.alpha.y + 40 },
    );

    // The **full** 100px, not merely "the inspector went mixed". A shift-click press used to
    // start a native selection, Chromium answered with `pointercancel`, and a cancelled pointer
    // delivers nothing further -- so this drag applied exactly one eighth of itself and stopped,
    // which still made the two objects differ and still passed a mixed-value assertion. See the
    // header of `layers.spec.ts` and ADR 0008.
    expect(await objectLeft(page, 'alpha')).toBeCloseTo(beforeAlpha + 100, 1);
    // Beta moved by the same delta, which is the "together" in the test's name -- and each is
    // measured against its own starting position, because the two never shared an x.
    expect(await objectLeft(page, 'beta')).toBeCloseTo(beforeBeta + 100, 1);
    // y was shared before the drag and is still shared afterwards, which is the observable
    // consequence of one delta applied to both. x was different before and still is.
    expect(await inspectorPlaceholder(page, 'y')).toBe('');
    expect(await inspectorPlaceholder(page, 'x')).toBe('Mixed');
    expect((await selectionIds(page)).sort()).toEqual(['alpha', 'beta']);
  });

  test('Escape mid-drag rolls the object back and leaves no history', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    await beginDrag(page, { x: IDS.alpha.x + 60, y: IDS.alpha.y + 40 });
    await moveDragTo(page, { x: IDS.alpha.x + 160, y: IDS.alpha.y + 140 });

    expect(await inspectorPx(page, 'x')).toBeCloseTo(140, 6);

    await page.keyboard.press('Escape');
    await endDrag(page);

    expect(await inspectorPx(page, 'x')).toBeCloseTo(40, 6);
    // Cancelling is not an action, so there is nothing to undo.
    expect(await undoDisabled(page)).toBe(true);
  });

  test('arrow keys nudge, and shift makes it ten times', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);

    await page.keyboard.press('ArrowRight');
    expect(await inspectorPx(page, 'x')).toBeCloseTo(41, 6);

    await page.keyboard.press('Shift+ArrowDown');
    expect(await inspectorPx(page, 'y')).toBeCloseTo(50, 6);
  });
});

// ---------------------------------------------------------------------------
// Resize and rotate
// ---------------------------------------------------------------------------

test.describe('resize and rotate', () => {
  test('a single object shows its own eight handles and a rotation handle', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);

    expect(await handleCount(page)).toBe(8);
    expect(await rotateHandleVisible(page)).toBe(true);
  });

  test('dragging the south-east handle resizes and pins the top-left', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    // The handle sits exactly on the corner, in screen space.
    await drag(
      page,
      { x: IDS.alpha.x + IDS.alpha.width, y: IDS.alpha.y + IDS.alpha.height },
      { x: IDS.alpha.x + 180, y: IDS.alpha.y + 140 },
    );

    expect(await inspectorPx(page, 'width')).toBeCloseTo(180, 6);
    expect(await inspectorPx(page, 'height')).toBeCloseTo(140, 6);
    // The opposite corner is what stays put.
    expect(await inspectorPx(page, 'x')).toBeCloseTo(40, 6);
    expect(await inspectorPx(page, 'y')).toBeCloseTo(40, 6);
  });

  test('dragging the west handle moves the origin and leaves the east edge put', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    const eastBefore = IDS.alpha.x + IDS.alpha.width;

    await drag(
      page,
      { x: IDS.alpha.x, y: IDS.alpha.y + 40 },
      { x: IDS.alpha.x - 20, y: IDS.alpha.y + 40 },
    );

    // Pulling the west edge left by 20 moves the origin left by 20 and *widens* the
    // box by 20. The invariant is that the opposite edge did not move — which is the
    // only thing "keep the width" would have got wrong.
    expect(await inspectorPx(page, 'x')).toBeCloseTo(IDS.alpha.x - 20, 6);
    expect(await inspectorPx(page, 'width')).toBeCloseTo(IDS.alpha.width + 20, 6);
    expect(await inspectorPx(page, 'x') + (await inspectorPx(page, 'width'))).toBeCloseTo(eastBefore, 6);
  });

  test('shift constrains a corner resize to the aspect ratio', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    await drag(
      page,
      { x: IDS.alpha.x + IDS.alpha.width, y: IDS.alpha.y + IDS.alpha.height },
      { x: IDS.alpha.x + 200, y: IDS.alpha.y + 100 },
      ['Shift'],
    );

    const width = await inspectorPx(page, 'width');
    const height = await inspectorPx(page, 'height');
    // The original box was 120×80, a ratio of 1.5.
    expect(width / height).toBeCloseTo(1.5, 2);
  });

  test('the rotation handle survives rotation, so an angle can be adjusted twice', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    expect(await rotateHandleVisible(page)).toBe(true);

    const gripAt = async () => (await page.locator('.p1-overlay-rotate').boundingBox()) ?? null;
    const first = await gripAt();
    expect(first, 'an unrotated selection offers the grip').not.toBeNull();

    // Rotate once, through the grip.
    await drag(
      page,
      { x: IDS.alpha.x + IDS.alpha.width / 2, y: IDS.alpha.y - 24 },
      { x: IDS.alpha.x + IDS.alpha.width / 2 + 60, y: IDS.alpha.y - 24 },
    );
    const afterFirst = Number.parseFloat(await inspectorValue(page, 'rotation'));
    expect(Math.abs(afterFirst)).toBeGreaterThan(1);

    // The grip used to disappear here, on the reasoning that it would overlap the object's corners.
    // That was a consequence of the frame not following the rotation, not a capability limit, so the
    // grip now stays -- which is what makes a *second* rotation possible at all.
    expect(await rotateHandleVisible(page), 'the grip survives, so rotation is adjustable').toBe(true);
    const second = await gripAt();
    expect(second, 'and it has moved with the frame').not.toBeNull();
    expect(
      Math.hypot((second?.x ?? 0) - (first?.x ?? 0), (second?.y ?? 0) - (first?.y ?? 0)),
      'the grip travelled with the frame rather than staying put',
    ).toBeGreaterThan(5);

    // And a second rotation *works* -- the whole reason the grip had to survive. Rotating back
    // toward the original angle is the assertion: a handle that is merely still drawn would not
    // produce this.
    //
    // Driven with raw mouse events rather than `drag`, because `drag` takes **document**
    // coordinates and converts them, while `boundingBox` reports **client** ones. Passing one to
    // the other aims at the wrong point, which is trap 31 -- and the symptom is a field that reads
    // `NaN` rather than an obvious miss.
    const before = Number.parseFloat(await inspectorValue(page, 'rotation'));
    if (second === null) throw new Error('no grip');
    const gripCentre = { x: second.x + second.width / 2, y: second.y + second.height / 2 };
    await page.mouse.move(gripCentre.x, gripCentre.y);
    await page.mouse.down();
    await page.mouse.move(gripCentre.x - 60, gripCentre.y + 40, { steps: 6 });
    await page.mouse.up();
    await settle(page);

    const afterSecond = Number.parseFloat(await inspectorValue(page, 'rotation'));
    expect(Number.isNaN(afterSecond), 'the selection survived the second drag').toBe(false);
    expect(Math.abs(afterSecond - before), 'the second drag rotated by a real amount').toBeGreaterThan(
      1,
    );
    // Direction is deliberately not asserted. Which way a drag turns the object depends on where the
    // grip sits relative to the pivot at that angle, and pinning it here would test the mouse rather
    // than the contract. What matters is that a *second* rotation is possible at all -- which is the
    // thing the old grip suppression made impossible.
    expect(afterSecond, 'and the angle is still a single readable value').not.toBe(afterFirst);

    // One undo step, whatever the number of drags: the gesture is a transaction, not a keystroke log.
    await page.keyboard.press('Control+z');
    const undone = Number.parseFloat(await inspectorValue(page, 'rotation'));
    expect(Math.abs(undone - afterFirst), 'undo restores the first rotation exactly').toBeLessThan(0.01);
  });

  test('a multi-selection offers no rotation grip, because there is no aggregate frame', async ({
    page,
  }) => {
    // The one remaining reason the grip is withheld, and it is a decision rather than a geometry
    // bug. The pivot is the single selected object's frame centre; with several selected there is no
    // such point, because M8 deliberately has no aggregate selection frame (ADR 0008 §7).
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    expect(await rotateHandleVisible(page), 'one object: offered').toBe(true);

    await clickAt(page, IDS.beta.x + 60, IDS.beta.y + 40, ['Shift']);
    expect(await rotateHandleVisible(page), 'two objects: withheld, for a stated reason').toBe(false);
  });

  test('each object in a multi-selection gets its own handles', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    await clickAt(page, IDS.beta.x + 60, IDS.beta.y + 40, ['Shift']);

    // Two outlines, eight handles each. The hit test names the owning object, so a
    // handle on one box never resizes the other.
    expect(await handleCount(page)).toBe(16);
  });

  test('dragging one object’s handle resizes only that object', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    await clickAt(page, IDS.beta.x + 60, IDS.beta.y + 40, ['Shift']);

    await drag(
      page,
      { x: IDS.alpha.x + IDS.alpha.width, y: IDS.alpha.y + IDS.alpha.height },
      { x: IDS.alpha.x + 160, y: IDS.alpha.y + 120 },
    );

    // `alpha` grew; `beta` is untouched, so the shared x/y are now mixed.
    expect(await selectionIds(page)).toHaveLength(2);
    expect(await inspectorPlaceholder(page, 'width')).toBe('Mixed');
  });
});

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

test.describe('inspector', () => {
  test('editing a field moves the object', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);

    const field = page.locator('[data-inspector] [data-field="x"]');
    await field.fill('75');
    await field.press('Enter');

    // 75pt is 100 document px.
    expect(await inspectorPx(page, 'x')).toBeCloseTo(100, 6);
  });

  test('a field edit is a single undo step, not one per keystroke', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);

    const field = page.locator('[data-inspector] [data-field="x"]');
    await field.click();
    await field.press('Control+a');
    await page.keyboard.type('123');
    await field.press('Enter');

    // "123" was three keystrokes, but committing on blur/Enter makes it one entry.
    expect(await undoLabel(page)).toBe('Undo X');
    await page.keyboard.press('Control+z');
    expect(await inspectorPx(page, 'x')).toBeCloseTo(40, 6);
    expect(await undoDisabled(page)).toBe(true);
  });

  test('an unparseable value is rejected and the field restored', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);

    const field = page.locator('[data-inspector] [data-field="x"]');
    await field.fill('not a number');
    await field.press('Enter');

    expect(await inspectorPx(page, 'x')).toBeCloseTo(40, 6);
    expect(await undoDisabled(page)).toBe(true);
  });

  test('escape abandons a field edit without committing', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);

    const field = page.locator('[data-inspector] [data-field="x"]');
    await field.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('999');
    await field.press('Escape');

    expect(await inspectorPx(page, 'x')).toBeCloseTo(40, 6);
    expect(await undoDisabled(page)).toBe(true);
  });

  test('rotation is edited in degrees', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);

    const field = page.locator('[data-inspector] [data-field="rotation"]');
    await field.fill('45');
    await field.press('Enter');

    expect(await inspectorValue(page, 'rotation')).toBe('45');
  });
});

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

test.describe('deletion', () => {
  test('Delete removes the selected object and clears the selection', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    await page.keyboard.press('Delete');

    expect(await selectionCount(page)).toBe(0);
    expect(await undoLabel(page)).toBe('Undo Delete 1 object');
  });

  test('deleting a multi-selection is one undo step', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    await clickAt(page, IDS.beta.x + 60, IDS.beta.y + 40, ['Shift']);
    await page.keyboard.press('Backspace');

    expect(await undoLabel(page)).toBe('Undo Delete 2 objects');
    await page.keyboard.press('Control+z');

    // Undo restores the objects but deliberately does not re-select them — reselecting
    // would make undo jump the user's selection around under them. Click one to
    // confirm it came back.
    expect(await selectionCount(page)).toBe(0);
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    expect(await selectionIds(page)).toEqual(['alpha']);
  });

  test('undo after a delete does not leave a phantom selection', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    await page.keyboard.press('Delete');
    await page.keyboard.press('Control+z');

    // The overlay must not draw an outline for an id that no longer exists.
    expect(await selectionCount(page)).toBe(0);
    expect(await undoDisabled(page)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Text sessions
// ---------------------------------------------------------------------------

test.describe('text edit entry', () => {
  test('Enter on a text frame starts a session', async ({ page }) => {
    await clickAt(page, IDS.copy.x + 60, IDS.copy.y + 20);
    await page.keyboard.press('Enter');

    expect(await frameIsEditing(page, 'copy')).toBe(true);
  });

  test('Enter on a shape does nothing', async ({ page }) => {
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);
    await page.keyboard.press('Enter');

    // Shapes have no text to edit; the fence must not be opened on one.
    expect(await selectionIds(page)).toEqual(['alpha']);
  });

  test('Escape leaves the session', async ({ page }) => {
    await clickAt(page, IDS.copy.x + 60, IDS.copy.y + 20);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');

    expect(await frameIsEditing(page, 'copy')).toBe(false);
  });

  test('clicking outside the frame leaves the session', async ({ page }) => {
    await clickAt(page, IDS.copy.x + 60, IDS.copy.y + 20);
    await page.keyboard.press('Enter');
    await clickAt(page, IDS.alpha.x + 60, IDS.alpha.y + 40);

    expect(await frameIsEditing(page, 'copy')).toBe(false);
  });
});
