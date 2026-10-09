/**
 * Fixtures for M17's snapping suite.
 *
 * ## Why snapping needs its own
 *
 * The property under test is a *distance to a nearby edge*, so the fixtures are laid out with known gaps
 * rather than with a pleasing composition. A box has to be a few pixels from a target and far from everything
 * else, or the drag lands on a different (equally valid) candidate and the test asserts the wrong thing --
 * which happened twice while writing `src/model/snap.test.ts`.
 *
 * `tests/editor/align-fixtures.ts` could not serve: its boxes are deliberately unequal so that *alignment*
 * is well defined, and several sit within 10px of each other, so almost every drag there would snap.
 *
 * ## Coordinates
 *
 * Document px at 1:1. The page is 600x400, so page edges and centre are 0 / 300 / 600 and 0 / 200 / 400.
 */

import type { Page } from '@playwright/test';
import { mountFixture } from '../visual/harness';

/**
 * Two boxes of **different widths**, far apart, so exactly one snap candidate is ever within the threshold.
 *
 * `a` is 100x50 at (60, 60), so its x features are left `60`, centre `110`, right `160`.
 * `b` is **60**x50 at (400, 250), so its x features are `400`, `430`, `460`.
 * The page is 600 wide, so page features are `0`, `300`, `600`.
 *
 * The unequal width is the point, and it is not cosmetic. With `b` also 100 wide, aligning `a`'s left edge
 * to `b`'s left (400) also puts `a`'s right edge 4 px from `b`'s right (500) -- the pair of 100-wide boxes 300
 * apart have a 100 px periodicity, so *two* features always qualify and the tie-break, not the geometry,
 * decides the answer. Every drag distance below is checked against all nine candidates.
 *
 * | drag | `a`'s features | within 10 of |
 * |---|---|---|
 * | +337 | 397 / 447 / 497 | `b`.left 400 (3) — **only** this one |
 * | +160 | 220 / 270 / 320 | nothing: 30 is the smallest distance |
 */
export const TWO_WELL_SEPARATED = `() => ({
  formatVersion: 1, id: 'm17sep', name: 'Separated',
  pageSize: { width: 600, height: 400, unit: 'px', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [
      { type: 'shape', id: 'a', name: 'a',
        transform: { x: 60, y: 60, width: 100, height: 50, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#a8c8f0' } },
      { type: 'shape', id: 'b', name: 'b',
        transform: { x: 400, y: 250, width: 60, height: 50, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#f0c8a8' } },
    ],
  }],
})`;

/**
 * A box close to the page's left edge, for page-edge snapping.
 *
 * `a` is 100x50 at (6, 200), so its x features are `6`, `56`, `106`. The page's are `0`, `300`, `600`, and
 * `far` (60x40 at 450) contributes `450`, `480`, `510`.
 *
 * | drag | `a`'s features | within 10 of |
 * |---|---|---|
 * | -4 | 2 / 52 / 102 | page left `0` (2) — **only** this one |
 * | +160 | 166 / 216 / 266 | nothing: 34 is the smallest distance |
 */
export const NEAR_PAGE_LEFT = `() => ({
  formatVersion: 1, id: 'm17page', name: 'Near page edge',
  pageSize: { width: 600, height: 400, unit: 'px', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [
      { type: 'shape', id: 'a', name: 'a',
        transform: { x: 6, y: 200, width: 100, height: 50, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#a8c8f0' } },
      { type: 'shape', id: 'far', name: 'far',
        transform: { x: 450, y: 40, width: 60, height: 40, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#c8f0b0' } },
    ],
  }],
})`;

/**
 * One child inside a group that is **rotated and uniformly scaled**, plus a loose top-level box.
 *
 * The regression M16 asked for explicitly. The group is at (300, 180) with `rotation 0.4` and `scale 1.2`,
 * so the child's *painted* position is nowhere near its authored local `(40, 40)` -- and a drag of the child
 * must follow the page axis through the M16 conversion, not the group's local one.
 *
 * `loose` sits at (120, 330) 90x50, far from the group, so a drag of `child` towards it has one candidate.
 */
export const NESTED_ROTATED_CHILD = `() => ({
  formatVersion: 1, id: 'm17nested', name: 'Nested rotated',
  pageSize: { width: 600, height: 420, unit: 'px', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [
      { type: 'group', id: 'grp', name: 'Group',
        transform: { x: 300, y: 60, width: 0, height: 0, rotation: 0.4, scaleX: 1.2, scaleY: 1.2 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        children: [
          { type: 'shape', id: 'child', name: 'child',
            transform: { x: 40, y: 40, width: 60, height: 50, rotation: 0, scaleX: 1, scaleY: 1 },
            visible: true, locked: false, opacity: 1, blendMode: 'normal',
            shape: { kind: 'rect', cornerRadius: 0 },
            fill: { type: 'solid', color: '#f0c8a8' } },
        ] },
      { type: 'shape', id: 'loose', name: 'loose',
        transform: { x: 120, y: 340, width: 90, height: 50, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#c8f0b0' } },
    ],
  }],
})`;

/**
 * Three boxes for the multi-selection tests: two that move together and one static target.
 *
 * `a` at (60,60) 90x50 and `b` at (180,140) 90x50 are 30px apart horizontally and 30 vertically, so their
 * union spans x 60..270, y 60..190. `target` at (450,260) 80x50 is far from both. Dragging `a`+`b` right by
 * 180 puts the union's left edge at 240 -- far from everything -- and by 186 puts it at 246, 4 from
 * `target`'s left, which snaps by +4.
 */
export const THREE_FOR_MULTI = `() => ({
  formatVersion: 1, id: 'm17multi', name: 'Multi selection',
  pageSize: { width: 620, height: 400, unit: 'px', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [
      { type: 'shape', id: 'a', name: 'a',
        transform: { x: 60, y: 60, width: 90, height: 50, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#a8c8f0' } },
      { type: 'shape', id: 'b', name: 'b',
        transform: { x: 180, y: 140, width: 90, height: 50, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#c8f0b0' } },
      { type: 'shape', id: 'target', name: 'target',
        transform: { x: 450, y: 260, width: 80, height: 50, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#f0c8a8' } },
    ],
  }],
})`;

/** Two well-separated boxes. */
export async function mountTwoWellSeparated(page: Page): Promise<void> {
  await mountFixture(page, TWO_WELL_SEPARATED);
}

/** A box 6px from the page's left edge, and a distant one. */
export async function mountNearPageLeft(page: Page): Promise<void> {
  await mountFixture(page, NEAR_PAGE_LEFT);
}

/** A child inside a rotated, scaled group, plus a loose box. */
export async function mountNestedRotatedChild(page: Page): Promise<void> {
  await mountFixture(page, NESTED_ROTATED_CHILD);
}

/** Two boxes that move together and one static target. */
export async function mountThreeForMulti(page: Page): Promise<void> {
  await mountFixture(page, THREE_FOR_MULTI);
}

/**
 * A pair placed close to the page origin, for the zoom-invariance test.
 *
 * ## Why this exists separately
 *
 * The invariance test has to drag a *document* gap of a few px at both 25% and 400%. In
 * `TWO_WELL_SEPARATED` the boxes are 340 document px apart, which at 3.81x is 1295 **client** px of
 * travel -- the pointer leaves the viewport, no further `pointermove` is delivered, and the object simply
 * never moves. That reads as "snapping is broken at high zoom" and is not a product defect at all.
 *
 * So both boxes sit in the top-left of the page, where they are still on screen at 4x:
 *
 * At 4x the page is 2286 client px wide in a viewport far narrower than that, so it is centred and its
 * left edge sits off-screen. Only the **dragged** box has to be visible, and it is placed at
 *
 * - `a` is 40x50 at (150, 100) -- x features `150`, `170`, `190`; y features `100`, `125`, `150`.
 * - `b` is 60x50 at (167, 250) -- x features `167`, `197`, `227`; y features `250`, `275`, `300`.
 *
 * which lands `a` around client (68, 19)..(362, 209) at 3.81x -- on screen. Keeping them away from the
 * page's own centre features (`300`, `200`) by more than the low-zoom threshold is why they are not placed
 * more centrally, where the page edges would compete with `b` for the snap.
 *
 * The boxes are **offset vertically on purpose**. Sharing a y range would make a's and b's vertical
 * features coincide exactly, so the y axis would snap by a distance of **zero** at any zoom -- drawing a
 * guide even where the threshold says nothing should snap, and making a "no guide at high zoom" assertion
 * impossible to satisfy.
 *
 * Dragging `a` right by 40 puts its x features at `190`, `210`, `230`. The nearest candidate is then
 * `b`.right at 3 -- comfortably inside the threshold at 25% (38.5 doc px) and comfortably outside it at
 * 400% (2.6 doc px), with `b`.centre at 13 and `b`.left at 7 behind it. Vertically nothing is within 50,
 * so the y axis never snaps and "no guide at high zoom" is a statement about x alone.
 */
export const ZOOM_INVARIANCE = `() => ({
  formatVersion: 1, id: 'm17zoom', name: 'Zoom invariance',
  pageSize: { width: 600, height: 400, unit: 'px', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [
      { type: 'shape', id: 'a', name: 'a',
        transform: { x: 150, y: 100, width: 40, height: 50, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#a8c8f0' } },
      { type: 'shape', id: 'b', name: 'b',
        transform: { x: 167, y: 250, width: 60, height: 50, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#f0c8a8' } },
    ],
  }],
})`;

/** The zoom-invariance pair. */
export async function mountZoomInvariance(page: Page): Promise<void> {
  await mountFixture(page, ZOOM_INVARIANCE);
}