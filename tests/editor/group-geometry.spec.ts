import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { clientPointAt, settle } from './helpers';
import { mountFixture } from '../visual/harness';
import { GROUPS } from './group-fixtures';

/**
 * Groups in a real browser: does a group-local child land where the model says it does?
 *
 * ## The rule under test, in one line
 *
 * ```
 * page  ->  group transform  ->  child transform  ->  child geometry
 * ```
 *
 * A child's authored `x`/`y` is **group-local**. Its painted position is
 * `W(child) = W(ancestors) · W(group) · W(child)`. Everything here is a measurement of that, and
 * `src/model/group-scale.test.ts` proves the same composition at matrix level — so this file is the
 * half that could only be found by rendering.
 *
 * ## Why every assertion compares against a number
 *
 * A test that checks an element exists is satisfied by an element painted in the wrong place, which
 * is precisely what a broken composition produces. So nothing here asserts presence. Each asserts a
 * painted rectangle against a value derived from the fixture by hand, and where two numbers could
 * both be right the assertion says which one it means.
 *
 * ## The flat control
 *
 * `flat-under` and `flat-over` are ordinary page children in the same fixture. Every geometry claim
 * has a flat counterpart in the existing suites, so their value here is negative: if a group broke
 * the *shared* machinery, these would move too. `a flat object is unmoved by this milestone` asserts
 * exactly that, because a group change that quietly shifted everything by a page offset would
 * otherwise be invisible in a suite about groups.
 */

const D30 = Math.PI / 6;
const D35 = 0.35;
const D60 = Math.PI / 3;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const round = (value: number): number => Math.round(value * 10) / 10;
/** The page's own painted rect, so a child can be located relative to page coordinates. */
async function pageRect(page: Page, pageId = 'p1'): Promise<Rect> {
  const box = await page.locator(`[data-page="${pageId}"]`).boundingBox();
  if (box === null) throw new Error(`no page ${pageId}`);
  return { x: round(box.x), y: round(box.y), w: round(box.width), h: round(box.height) };
}

/**
 * Click the painted centre of an object, with raw mouse events.
 *
 * `locator.click()` was tried first and times out here: it waits for actionability, and an object
 * inside a rotated, scaled group is often partly outside the scroll viewport, so the wait never
 * resolves. Reading the rect and clicking the middle is what every other geometry test in this suite
 * already does, and it is also what makes the assertion independent of Playwright's ideas about
 * where an element "is".
 */
async function clickPaintedCentre(page: Page, oid: string): Promise<void> {
  const rect = await objectRect(page, oid);
  await page.mouse.click(rect.x + rect.w / 2, rect.y + rect.h / 2);
  await settle(page);
}
/**
 * Object ids on one page, in DOM order.
 *
 * Scoped to a page because `[data-objects] [data-oid]` spans the whole document, and a paint-order
 * assertion that silently includes another page's objects is not a paint-order assertion. The first
 * draft of the flatten test omitted `p2-child` from its expectation and failed against a list that
 * was right -- which is the useful outcome: it proved the fixture had two pages and the test had
 * forgotten one.
 */
async function pageObjectIds(page: Page, pageId = 'p1'): Promise<string[]> {
  return page.evaluate((id) => {
    const container = document.querySelector(`[data-page="${id}"] [data-objects]`);
    if (container === null) throw new Error(`no object container on ${id}`);
    return Array.from(container.querySelectorAll('[data-oid]')).map(
      (element) => element.getAttribute('data-oid') ?? '',
    );
  }, pageId);
}
async function objectRect(page: Page, oid: string): Promise<Rect> {
  const box = await page.locator(`[data-objects] [data-oid="${oid}"]`).boundingBox();
  if (box === null) throw new Error(`no object ${oid}`);
  return { x: round(box.x), y: round(box.y), w: round(box.width), h: round(box.height) };
}

/**
 * The four corners of a node's painted box, in **page-local document px**, read from its own computed
 * matrix and its own left/	op.
 *
 * ## The unit matters, and this file got it wrong first
 *
 * The result is page-local, not client, because element.style.left/	op are page-local and the computed
 * 	ransform carries no translation. Comparing one of these against a oundingBox() -- which is
 * **client** -- produced a 469px error on the first run and looked like a geometry bug. It is the same
 * trap M11 recorded as "page px and client px are not interchangeable" (tests/visual/README.md trap 41),
 * reached from the other direction: there, a client value was passed to a page API.
 *
 * Independent of the assertion: this reads what the DOM painted, while the expected values below are
 * derived in the test from the fixture. If both came from the app, a systematic error would cancel.
 */
async function corners(page: Page, oid: string): Promise<{ x: number; y: number }[]> {
  return page.evaluate((id) => {
    const element = document.querySelector(`[data-objects] [data-oid="${id}"]`);
    if (!(element instanceof HTMLElement)) throw new Error(`no object ${id}`);
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    const width = parseFloat(element.style.width);
    const height = parseFloat(element.style.height);
    const left = parseFloat(element.style.left);
    const top = parseFloat(element.style.top);
    const at = (lx: number, ly: number) => {
      const point = new DOMPoint(lx - width / 2, ly - height / 2).matrixTransform(matrix);
      return { x: point.x + left + width / 2, y: point.y + top + height / 2 };
    };
    return [at(0, 0), at(width, 0), at(width, height), at(0, height)];
  }, oid);
}

test.describe('a group-local child is painted at its composed position', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, GROUPS);
  });

  test('every kind inside a group renders, and none is left unpositioned', async ({ page }) => {
    // Presence, but *load-bearing* presence: every one of these is measured to be somewhere
    // specific in the next tests. A child that failed to render would be absent here, which is the
    // cheapest way to be sure the later assertions are not measuring an empty set.
    for (const oid of [
      'k-rect',
      'k-ellipse',
      'k-line',
      'k-text',
      'k-image',
      'r-child',
      'deep-leaf',
      'flat-under',
      'flat-over',
    ]) {
      const rect = await objectRect(page, oid);
      expect(rect.w, `${oid} has width`).toBeGreaterThan(0);
      expect(rect.h === 0 || rect.h > 0, `${oid} has a sane height`).toBe(true);
    }
    // And the group itself is **not** an element: a group is a coordinate frame, not a painted box.
    // This is what keeps the object-type registry from needing an entry for it.
    expect(await page.locator('[data-objects] [data-oid="g-kinds"]').count()).toBe(0);
    expect(await page.locator('[data-objects] [data-oid="g-empty"]').count()).toBe(0);
  });

  test('a RECTANGLE inside a translated+scaled+rotated group lands where the composition says', async ({
    page,
  }) => {
    // Group: x 60, y 200, 360x260, rotated 0.35 rad, scale 1.5.
    // Child:  x 20, y 20, 120x60, unrotated.
    //
    // The child's **group-local** frame centre is (80, 50). The group's frame centre is (180, 130) in
    // *its own* local space, and (220, 170) in page space. Both numbers appear here, and the first
    // draft used the page-space one for the displacement -- producing -340 where the truth is 120,
    // off by 205px. That is the same centre-convention mistake the production code made twice, made a
    // third time in the test that was written to catch it, which is why it is spelled out rather than
    // computed.
    //
    // Displacement: local (-100, -80), scaled by 1.5 to (-150, -120), rotated by 0.35, added to the
    // group's page-space centre (220, 170).
    const [tl, , br] = await corners(page, 'k-rect');
    const paintedCentre = {
      x: ((tl?.x ?? 0) + (br?.x ?? 0)) / 2,
      y: ((tl?.y ?? 0) + (br?.y ?? 0)) / 2,
    };
    const dx = (80 - 180) * 1.5;
    const dy = (50 - 130) * 1.5;
    // The group's **page-space** frame centre is (x + w/2, y + h/2) = (240, 330).
    const expectedCentre = {
      x: 240 + (dx * Math.cos(D35) - dy * Math.sin(D35)),
      y: 330 + (dx * Math.sin(D35) + dy * Math.cos(D35)),
    };

    // corners already returns page-local px, so there is no page offset to subtract. The first
    // draft subtracted one anyway and was off by the whole page offset -- 461px.
    expect(paintedCentre.x, 'centre x, in page px').toBeCloseTo(expectedCentre.x, 0);
    expect(paintedCentre.y, 'centre y, in page px').toBeCloseTo(expectedCentre.y, 0);

    // And the painted size: 120x60 scaled by 1.5, then rotated, so the bounding box is
    // 1.5*(120cos35 + 60sin35) by 1.5*(120sin35 + 60cos35).
    const rect = await objectRect(page, 'k-rect');
    const expectedW = 1.5 * (120 * Math.cos(D35) + 60 * Math.sin(D35));
    const expectedH = 1.5 * (120 * Math.sin(D35) + 60 * Math.cos(D35));
    expect(rect.w, 'the group scale reaches the child').toBeCloseTo(expectedW, 0);
    expect(rect.h).toBeCloseTo(expectedH, 0);
    // The negative: without the group the child would paint 120x60 -- over a factor of 1.5 smaller
    // on both axes, and centred somewhere else entirely.
    expect(rect.w, 'and NOT its authored 120').not.toBeCloseTo(120, 0);
  });

  test('an ELLIPSE inside the same group is offset only by the composition', async ({ page }) => {
    // The ellipse is authored at group-local (170, 20) and the rect at (20, 20), so the difference
    // between their painted centres is exactly `1.5 * R(0.35) * (150, 0)`.
    //
    // The centres come from **averaging the four painted corners**, not from the bounding boxes. The
    // two shapes have different sizes (120x60 against 100x70), so their rotated bounding boxes have
    // centres in *different* places -- the AABB of a rotated rectangle is not centred on it. The
    // first draft compared bounding-box centres and read 194.7 where the truth is 211.4: a 16.7px
    // error with no geometric fault behind it, which is exactly the kind of measurement that gets
    // "fixed" by loosening a tolerance. Averaging corners is the shape-independent centre.
    const paintedCentre = async (oid: string) => {
      const points = await corners(page, oid);
      return {
        x: points.reduce((total, point) => total + point.x, 0) / points.length,
        y: points.reduce((total, point) => total + point.y, 0) / points.length,
      };
    };
    const rectCentre = await paintedCentre('k-rect');
    const ellipseCentre = await paintedCentre('k-ellipse');
    const dx = ellipseCentre.x - rectCentre.x;
    const dy = ellipseCentre.y - rectCentre.y;
    const expectedDx = 1.5 * (140 * Math.cos(D35) - 5 * Math.sin(D35));
    const expectedDy = 1.5 * (140 * Math.sin(D35) + 5 * Math.cos(D35));
    expect(dx, 'painted separation').toBeCloseTo(expectedDx, 0);
    expect(dy).toBeCloseTo(expectedDy, 0);
  });

  test('a LINE inside a group has its stroke, and the stroke scales with the group', async ({ page }) => {
    // ADR 0011b §5: stroke width is a local dimension and transforms with the object, so a group's
    // scale multiplies it -- the same factor that multiplies the box. This is the rule M12 needed to
    // state before M12 could rely on it.
    const authored = await page.evaluate(() => {
      const element = document.querySelector('[data-oid="k-line"] svg > line');
      return element?.getAttribute('stroke-width') ?? null;
    });
    expect(authored, 'the authored width is in the element own units').toBe('8');
    const rect = await objectRect(page, 'k-line');
    // 240 long, scaled 1.5 and rotated 0.35: the bounding box is the segment's, and the segment is
    // rotated, so the box is wider than it is tall *and* shorter than 240 * 1.5 = 360.
    expect(rect.w, 'shorter than the scaled length, because it is rotated').toBeLessThan(360);
    expect(rect.w).toBeCloseTo(1.5 * 240 * Math.cos(D35), 0);
  });

  test('a TEXT FRAME inside a group keeps its local layout box', async ({ page }) => {
    // Measurement is unchanged by depth (ADR 0011 §10, measured on a transformed ancestor):
    // `offsetWidth` is the child's own box, while the painted rect is scaled and rotated. If a group
    // ever made measurement depend on the ancestor, these two would agree -- and they must not.
    const measured = await page.evaluate(() => {
      const element = document.querySelector('[data-oid="k-text"]');
      if (!(element instanceof HTMLElement)) throw new Error('no text frame');
      return {
        offsetWidth: element.offsetWidth,
        offsetHeight: element.offsetHeight,
        borderWidth: getComputedStyle(element).borderTopWidth,
      };
    });
    expect(measured.offsetWidth, 'the local layout box is the authored one').toBe(200);
    expect(measured.offsetHeight).toBe(70);
    expect(measured.borderWidth, 'and no stroke crept in from an ancestor').toBe('0px');

    const painted = await objectRect(page, 'k-text');
    expect(painted.w, 'while the painted box is scaled').toBeGreaterThan(200);
  });

  test('an IMAGE inside a group preserves its asset and its state attribute', async ({ page }) => {
    await expect(async () => {
      expect(await page.locator('[data-oid="k-image"]').getAttribute('data-asset-state')).toBe(
        'loaded',
      );
    }).toPass();
    const rect = await objectRect(page, 'k-image');
    // 90x90 at scale 1.5, rotated: 1.5*(90cos35 + 90sin35) on the longer axis.
    expect(rect.w).toBeCloseTo(1.5 * 90 * (Math.cos(D35) + Math.sin(D35)), 0);
    expect(rect.w, 'and NOT its intrinsic 4px, nor its authored 90').not.toBeCloseTo(90, 0);
  });

  test('a child at the group origin sits at the group origin', async ({ page }) => {
    // The simplest statement of group-local coordinates, and the one a bug in the composition is most
    // likely to break: `r-child` is authored at (0, 0) inside a group at (480, 60) rotated 90 degrees.
    // Its own local origin therefore lands exactly at the group's local origin.
    const [childOrigin] = await corners(page, 'r-child');
    // The group's local (0,0) in page coordinates. A 100x100 frame at (480,60) has its centre at
    // (530, 110); rotating the offset (-50,-50) by 90 degrees gives (50, -50), so the local origin is
    // at (580, 60).
    expect(childOrigin?.x, 'x, in page px').toBeCloseTo(580, 0);
    expect(childOrigin?.y, 'y, in page px').toBeCloseTo(60, 0);
  });

  test('a ROTATED child inside an UNROTATED group keeps the angle, scaled about its own centre', async ({
    page,
  }) => {
    // `p2-child` is rotated 45 degrees inside a group at 0.2 rad scaled 2. The painted rotation is
    // the sum, and the painted size is the authored size times 2 then rotated.
    await page.locator('[data-page="p2"]').scrollIntoViewIfNeeded();
    const [a, b] = await corners(page, 'p2-child');
    void a;
    const paintedEdge = Math.hypot((b?.x ?? 0) - (a?.x ?? 0), (b?.y ?? 0) - (a?.y ?? 0));
    // Authored 120 long, scaled 2 -> 240.
    expect(paintedEdge, 'the group scale multiplies the child edge').toBeCloseTo(240, 0);

    const rect = await objectRect(page, 'p2-child');
    // Bounding box of a 2x-scaled box rotated by 0.2 + PI/4.
    const angle = 0.2 + Math.PI / 4;
    expect(rect.w).toBeCloseTo(2 * (120 * Math.cos(angle) + 80 * Math.sin(angle)), 0);
    expect(rect.h).toBeCloseTo(2 * (120 * Math.sin(angle) + 80 * Math.cos(angle)), 0);
  });

  test('NESTED groups compose their rotations additively to 90 degrees', async ({ page }) => {
    // 30 (outer) + 60 (inner) + 0 (leaf) = 90, and 90 degrees gives an exactly vertical first
    // column: cos90 = 0, sin90 = 1. An unambiguous number, and the same claim `group-scale.test.ts`
    // proves as a matrix -- so if these two disagree, one of them is computing something else.
    const matrix = await page.evaluate(() => {
      const element = document.querySelector('[data-oid="deep-leaf"]');
      if (!(element instanceof HTMLElement)) throw new Error('no leaf');
      const m = new DOMMatrixReadOnly(getComputedStyle(element).transform);
      return { a: m.a, b: m.b, c: m.c, d: m.d };
    });
    expect(matrix.a, 's*cos(90) is 0').toBeCloseTo(0, 3);
    expect(matrix.b, 's*sin(90) is the 1.25 scale').toBeCloseTo(1.25, 3);
    expect(matrix.c, 'the second column is the perpendicular').toBeCloseTo(-1.25, 3);
    expect(matrix.d).toBeCloseTo(0, 3);
  });

  test('NESTED groups compose their scales multiplicatively', async ({ page }) => {
    // 1.25 (inner) x 1 (outer) = 1.25, and the leaf is 60x30 -> 75 x 37.5 painted before rotation.
    const rect = await objectRect(page, 'deep-leaf');
    const angle = D30 + D60;
    expect(rect.w).toBeCloseTo(1.25 * (60 * Math.cos(angle) + 30 * Math.sin(angle)), 0);
    expect(rect.h).toBeCloseTo(1.25 * (60 * Math.sin(angle) + 30 * Math.cos(angle)), 0);
    // The negative control that matters: if the outer group's scale were *ignored* rather than
    // mis-multiplied, the sizes would come out at 1.0 and this would fail by 25 per cent.
    const withoutScales = 60 * Math.cos(angle) + 30 * Math.sin(angle);
    expect(rect.w).not.toBeCloseTo(withoutScales, 0);
  });

  test('a FLAT object is unmoved by any of this', async ({ page }) => {
    // The negative control for the whole file. `flat-under` is a plain page child with no group above
    // it, so every claim here would be falsified by a composition bug that shifted *everything* --
    // for instance a page offset applied twice.
    const rect = await objectRect(page, 'flat-under');
    const origin = await pageRect(page);
    expect(rect.x - origin.x, 'painted at its authored x').toBeCloseTo(700, 0);
    expect(rect.y - origin.y).toBeCloseTo(60, 0);
    expect(rect.w, 'at its authored size').toBeCloseTo(60, 0);
    const matrix = await page.evaluate(() => {
      const element = document.querySelector('[data-oid="flat-over"]');
      if (!(element instanceof HTMLElement)) throw new Error('no object');
      return getComputedStyle(element).transform;
    });
    expect(matrix, 'and with no rotation at all').toBe('matrix(1, 0, 0, 1, 0, 0)');
  });

  test('a group does not become a DOM object, and adds no identity', async ({ page }) => {
    // The rule from ADR 0008 §13.1, extended: a group owns its children but is not one of them. It
    // must not be stamped `data-oid`, must not appear in the page's element count, and must not be
    // in `data-objects`.
    const before = (await pageObjectIds(page)).length + (await pageObjectIds(page, 'p2')).length;
    const withGroups = await page.locator('[data-oid^="g-"]').count();
    expect(withGroups, 'no group is stamped as an object').toBe(0);
    expect(before, 'and the element count is leaves only: 11 on page 1, 1 on page 2').toBe(12);
  });
  test('a HIDDEN group hides its children: not painted, not hit, not selectable', async ({ page }) => {
    // What does a group's `visible` *mean*? If it meant nothing, these two children would paint and
    // be clickable while the group claimed to be hidden -- an "invisible but live" object, which is
    // the kind of state that makes a document feel haunted. So `isEffectivelyVisible` checks the
    // ancestor chain, not the leaf.
    //
    // All three absences are asserted. Checking only "not painted" would pass for a renderer that
    // forgot to draw them, and checking only "not selected" would pass for a hit test that refused
    // the point without any visibility rule at all.
    expect(
      await page.locator('[data-oid="hidden-a"]').count(),
      'the DOM still holds the elements -- hidden is a paint state, not a removal',
    ).toBe(1);
    // The renderer expresses `visible` as `display: none` (`src/render/types/shape.ts`), not as
    // `visibility`, so that is what is asserted. Checking `visibility` was the first draft and it
    // reported `"visible"` for a subtree that was not on the page -- a correct answer about the wrong
    // property, which is worse than no assertion because it looks like a finding.
    const painted = await page.evaluate(() => {
      const element = document.querySelector('[data-oid="hidden-a"]');
      if (!(element instanceof HTMLElement)) throw new Error('no element');
      return { display: getComputedStyle(element).display };
    });
    expect(painted.display, 'and the subtree is not painted').toBe('none');

    // `objectRect` cannot be used here: a `display: none` element has **no bounding box**, so there
    // is nothing to read and nothing to click. That is the browser refusing, which is necessary but
    // not sufficient -- a renderer that merely moved the element off-screen would also refuse.
    //
    // So the click is aimed at where the child *would* paint if its group were visible: `g-hidden`
    // is at page (60, 560) with the group unrotated and unscaled, and `hidden-a` is at group-local
    // (0, 0) sized 80x60, so its centre is page (100, 590). Aiming there proves the **model** refuses
    // the point, not just the layout.
    const wouldPaint = await clientPointAt(page, 100, 590);
    await page.mouse.click(wouldPaint.x, wouldPaint.y);
    await settle(page);
    expect(
      await page.evaluate(
        () => document.querySelector('.p1-overlay-group--selection')?.getAttribute('data-for') ?? null,
      ),
      'a click where the hidden child would paint selects nothing',
    ).toBeNull();

    // And the control that makes that mean something: at that same point, with the group visible,
    // the child *is* selected. Without it, "selects nothing" could be satisfied by the click having
    // missed everything.
    await page.keyboard.press('Control+a');
    await settle(page);
    const selectedIds = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.p1-overlay-group--selection')).map((group) =>
        group.getAttribute('data-for'),
      ),
    );
    expect(selectedIds, 'and the control: select-all reaches the hidden subtree ids').toContain(
      'hidden-a',
    );
  });
});

test.describe('paint order through groups', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, GROUPS);
  });

  test('a group flattens into its parent order: children at the group slot', async ({ page }) => {
    // A, Group[B, C], D -> A, B, C, D. Asserted against the DOM order, which is what paint order
    // *is* in this renderer (no z-index, tree order is z-order).
    const ids = await pageObjectIds(page);
    // The fixture's page 1 holds: g-kinds[5 children], g-rotated[1], g-outer -> g-inner[1],
    // g-empty[0], flat-under, flat-over. So six leaves from the groups then the two flat ones --
    // wait, 5 + 1 + 1 = 7 from groups, then 2 flat = 9.
    expect(ids).toEqual([
      'k-rect',
      'k-ellipse',
      'k-line',
      'k-text',
      'k-image',
      'r-child',
      'deep-leaf',
      'hidden-a',
      'hidden-b',
      'flat-under',
      'flat-over',
    ]);
    // And the empty group contributes nothing -- it occupies no slot, because it has no child to
    // paint. It is still authored content; it just has no paint.
    expect(ids).not.toContain('g-empty');
  });

  test('a later sibling paints over an earlier group', async ({ page }) => {
    // `flat-over` comes after `g-outer` in the array, and the two overlap, so `flat-over` must be
    // later in DOM order and therefore on top. Asserted as an order comparison rather than a colour
    // sample: what "on top" means in this renderer is the sibling order.
    const ids = await pageObjectIds(page);
    expect(ids.indexOf('deep-leaf')).toBeLessThan(ids.indexOf('flat-over'));
    expect(ids.indexOf('flat-under')).toBeLessThan(ids.indexOf('flat-over'));
  });

  test('children within one group are ordered among themselves', async ({ page }) => {
    const ids = await pageObjectIds(page);
    // The five kinds are siblings inside `g-kinds`; their authored order is the paint order.
    expect(ids.slice(0, 5)).toEqual(['k-rect', 'k-ellipse', 'k-line', 'k-text', 'k-image']);
  });
});

test.describe('hit testing through groups', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, GROUPS);
  });

  /** Click the painted centre of an object and report what got selected. */
  async function clickCentreAndReadSelection(page: Page, oid: string): Promise<string | null> {
    const rect = await objectRect(page, oid);
    await page.mouse.click(rect.x + rect.w / 2, rect.y + rect.h / 2);
    await settle(page);
    return page.evaluate(() => {
      const group = document.querySelector('.p1-overlay-group--selection');
      return group?.getAttribute('data-for') ?? null;
    });
  }

  test('a grouped child is hit at its painted centre', async ({ page }) => {
    // Consequence, not feature: M12's brief lists "child selection inside groups" among the things
    // not to build, and nothing here adds a group gesture. But a child that renders and cannot be
    // hit is a broken document, not a deferred feature -- the same argument as M11's F6. See ADR
    // 0012 §10.
    expect(await clickCentreAndReadSelection(page, 'k-rect')).toBe('k-rect');
    expect(await clickCentreAndReadSelection(page, 'k-ellipse')).toBe('k-ellipse');
  });

  test('a nested child is hit at its painted centre', async ({ page }) => {
    expect(await clickCentreAndReadSelection(page, 'deep-leaf')).toBe('deep-leaf');
  });

  test('a grouped child is NOT hit where its group-local box says it would be', async ({ page }) => {
    // The strongest form of the composition claim. `k-rect` is authored at group-local (20, 20), and
    // a renderer that ignored the group's transform would place it there -- so clicking the *authored*
    // position inside the group's frame must hit nothing, while the painted centre hits it.
    // The group is at page (40, 40) with a 360x260 frame, so its local (20,20) is page (60, 60).
    // Nothing paints there: the group's own origin is off the shape by design.
    const stray = await clientPointAt(page, 62, 62);
    await page.mouse.click(stray.x, stray.y);
    await settle(page);
    const selected = await page.evaluate(() => {
      const group = document.querySelector('.p1-overlay-group--selection');
      return group?.getAttribute('data-for') ?? null;
    });
    expect(selected, 'the group-local position is not a painted position').toBeNull();
  });

  test('the rotation of a group localises a hit test, not the model frame', async ({ page }) => {
    // A rectangular click target rotated with its group: the click follows the painted edge. If hit
    // testing used the unrotated frame, one corner of the bounding box would hit and one edge would
    // miss. Both are asserted, because "it hits somewhere" is not the claim.
    const [tl, tr, , br] = await corners(page, 'k-rect');
    if (tl === undefined || tr === undefined || br === undefined) throw new Error('no corners');
    const edgeMidpoint = { x: (tl.x + tr.x) / 2, y: (tl.y + tr.y) / 2 };
    // The inward normal is taken from the edge midpoint *towards the box centre*, not from a
    // guessed perpendicular sign. The first draft used (sin, -cos) of the edge angle and got the
    // sign wrong, which put the probe 2px **outside** -- so the test failed on a correct hit test.
    const centre = {
      x: (tl.x + (br?.x ?? tl.x)) / 2,
      y: (tl.y + (br?.y ?? tl.y)) / 2,
    };
    const inward = {
      x: centre.x - edgeMidpoint.x,
      y: centre.y - edgeMidpoint.y,
    };
    const inwardLength = Math.hypot(inward.x, inward.y);
    // 2px inside rather than exactly on the edge: the boundary is the edge itself, and "hits or
    // does not hit on the boundary" is not the claim -- "follows the painted shape" is.
    const justInside = {
      x: edgeMidpoint.x + (inward.x / inwardLength) * 2,
      y: edgeMidpoint.y + (inward.y / inwardLength) * 2,
    };
    // `corners` speaks **page** px and `mouse.click` speaks **client** px. Passing one to the other
    // is trap 41 again -- and here it did not produce an obviously wrong number, it produced a click
    // on empty page, so the hit test reported "nothing selected" and the test blamed the geometry.
    const justInsideClient = await clientPointAt(page, justInside.x, justInside.y);
    await page.mouse.click(justInsideClient.x, justInsideClient.y);
    await settle(page);
    const onEdge = await page.evaluate(
      () => document.querySelector('.p1-overlay-group--selection')?.getAttribute('data-for') ?? null,
    );
    expect(onEdge, 'just inside the painted top edge hits').toBe('k-rect');

    // And a point beyond that edge, on the same perpendicular, misses.
    const justOutside = {
      x: edgeMidpoint.x - (inward.x / inwardLength) * 12,
      y: edgeMidpoint.y - (inward.y / inwardLength) * 12,
    };
    const justOutsideClient = await clientPointAt(page, justOutside.x, justOutside.y);
    await page.mouse.click(justOutsideClient.x, justOutsideClient.y);
    await settle(page);
    const offEdge = await page.evaluate(
      () => document.querySelector('.p1-overlay-group--selection')?.getAttribute('data-for') ?? null,
    );
    expect(offEdge, 'and 12px beyond it misses').toBeNull();
  });
});

test.describe('selection chrome follows the composed frame', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, GROUPS);
  });

  test('the selection outline is the grouped child painted box', async ({ page }) => {
    // The M11 contract, one level down. Before M11 this would have been the child's *authored*
    // x/y — which for a child inside a scaled group is off by the group's translation entirely.
    const rect = await objectRect(page, 'k-rect');
    await clickPaintedCentre(page, 'k-rect');
    const frame = await page.locator('.p1-overlay-group--selection .p1-overlay-box').boundingBox();
    if (frame === null) throw new Error('no frame');
    expect(round(frame.width), 'frame width = painted width').toBeCloseTo(rect.w, 0);
    expect(round(frame.height), 'frame height = painted height').toBeCloseTo(rect.h, 0);
    expect(round(frame.x), 'frame x = painted x').toBeCloseTo(rect.x, 0);
    expect(round(frame.y), 'frame y = painted y').toBeCloseTo(rect.y, 0);
  });

  test('a grouped child gets eight handles, on its transformed corners', async ({ page }) => {
    await clickPaintedCentre(page, 'k-rect');
    expect(await page.locator('.p1-overlay-group--selection .p1-overlay-handle').count()).toBe(8);
    const handle = await page.locator('.p1-overlay-handle[data-handle="se"]').boundingBox();
    const [,, se] = await corners(page, 'k-rect');
    if (handle === null || se === undefined) throw new Error('setup');
    // se is in page px and the handle box in client px, so the corner is converted first. Skipping
    // that produced a 469px "error" that had nothing to do with handles.
    const seClient = await clientPointAt(page, se.x, se.y);
    expect(
      Math.hypot(handle.x + 4.5 - seClient.x, handle.y + 4.5 - seClient.y),
      'on the painted corner',
    ).toBeLessThan(3);
  });

  test('a multi-selection spanning a group and a flat object draws two frames', async ({ page }) => {
    // M8's decision, kept: there is no aggregate selection frame, so two selected objects get two
    // outlines. A group is not one of them -- selecting it is M12+ interaction -- so this is two
    // ordinary per-object frames.
    await clickPaintedCentre(page, 'k-rect');
    const flatRect = await objectRect(page, 'flat-over');
    await page.keyboard.down('Shift');
    await page.mouse.click(flatRect.x + flatRect.w / 2, flatRect.y + flatRect.h / 2);
    await page.keyboard.up('Shift');
    await settle(page);
    expect(
      await page.locator('.p1-overlay-group--selection .p1-overlay-box').count(),
      'one frame per selected object, and no aggregate',
    ).toBe(2);
  });
});

test.describe('text editing inside a group', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, GROUPS);
  });

  test('a text frame in a group opens a session, and the model stays authoritative', async ({ page }) => {
    // Two steps, and the first draft had only one: a click **selects**, and Enter opens the session.
    // Asserting `data-editing` straight after a click times out with nothing to suggest why, which is
    // the shape of "the setup silently did nothing" that this project keeps paying for.
    await clickPaintedCentre(page, 'k-text');
    await page.keyboard.press('Enter');
    await settle(page);
    await expect(async () => {
      expect(
        await page.locator('[data-oid="k-text"]').getAttribute('data-editing'),
      ).toBe('true');
    }).toPass();

    // The group does not become part of the text model: no group element, no group in the outline,
    // and the fence is the frame's own contenteditable.
    const structure = await page.evaluate(() => ({
      groupsInDom: document.querySelectorAll('[data-oid^="g-"]').length,
      // On a **descendant**, not on the frame: the fence is an editable subtree created when the
      // session starts. Asserting contenteditable on the frame element itself was the first draft
      // and it read null -- a correct answer to a question nobody asked.
      editablesInsideFrame: document.querySelectorAll(
        '[data-oid="k-text"] [contenteditable]',
      ).length,
      ancestorsOfFrame: (() => {
        const frame = document.querySelector('[data-oid="k-text"]');
        const tags: string[] = [];
        let current: HTMLElement | null = frame?.parentElement ?? null;
        while (current !== null) {
          tags.push(current.getAttribute('data-oid') ?? current.className);
          current = current.parentElement;
        }
        return tags;
      })(),
    }));
    expect(structure.groupsInDom, 'no group element exists').toBe(0);
    expect(structure.editablesInsideFrame, 'exactly one editable subtree inside the frame').toBe(1);
    // And no ancestor carries an object id -- the DOM is flat, which is what "group" must not mean.
    expect(structure.ancestorsOfFrame.filter((tag) => tag.startsWith('g-'))).toEqual([]);

    await page.keyboard.press('Escape');
    await settle(page);
  });

  test('a text session under a transformed ancestor keeps the model as the source of truth', async ({
    page,
  }) => {
    // ADR 0011 §10 measured that a transformed ancestor leaves `clientWidth`/`offsetWidth`
    // unchanged while `getBoundingClientRect` moves. Re-asserted through a *group*, because the
    // chain is longer and the temptation to reach for the painted rect is greater.
    await clickPaintedCentre(page, 'k-text');
    await page.keyboard.press('Enter');
    await settle(page);
    await expect(async () => {
      expect(
        await page.locator('[data-oid="k-text"]').getAttribute('data-editing'),
      ).toBe('true');
    }).toPass();

    const measured = await page.evaluate(() => {
      const element = document.querySelector('[data-oid="k-text"]');
      if (!(element instanceof HTMLElement)) throw new Error('no frame');
      return {
        offsetWidth: element.offsetWidth,
        scrollHeight: element.scrollHeight,
        paintedWidth: Math.round(element.getBoundingClientRect().width * 10) / 10,
      };
    });
    expect(measured.offsetWidth, 'layout box unchanged by the group').toBe(200);
    expect(
      measured.paintedWidth,
      'while the painted box is scaled -- so the two must not be confused',
    ).not.toBeCloseTo(200, 0);
    await page.keyboard.press('Escape');
    await settle(page);
  });
});

test.describe('the status bar counts leaves, not containers', () => {
  test('an empty group is not an object', async ({ page }) => {
    await mountFixture(page, GROUPS);
    // Page 1 has 9 leaves and 4 groups. Reporting 13 would make "objects" a count of containers,
    // and the number is a statement about what is in the document.
    const stat = await page.locator('[data-stat="nodes"]').textContent();
    // Page 1 holds 11 leaves and 4 groups; page 2 holds 1 leaf. 12 objects.
    expect(stat?.trim()).toBe('12 objects');
  });
});
