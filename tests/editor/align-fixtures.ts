/**
 * Fixtures for M16's alignment and distribution suite, and for the nested-movement regression.
 *
 * ## Why this file exists
 *
 * `group-interaction-fixtures.ts` is the M13 artefact, deliberately created so that M13's additions could
 * not disturb `group-fixtures.ts`. Its fixtures are *composed for grouping questions* -- `a` and `b` are
 * adjacent siblings inside a group, `c` sits below them -- and that composition is the wrong shape for
 * the questions M16 asks.
 *
 * Concretely: `TRANSFORMED_GROUP_FIXTURE` puts the group at `rotation 0.4, scale 1.5`, which grows and
 * rotates the children until their axis-aligned bounding boxes overlap. Leaf `a`'s AABB centre then falls
 * inside leaf `c`, which paints above it, so clicking "the centre of `a`" selects `c`. Measured, not
 * assumed:
 *
 *     a's AABB centre -> (115.81, 177.59)   click there -> outlined ["c"]
 *
 * Editing that fixture to fix the overlap would change the painted geometry M13's tests are pinned to,
 * so these are new documents instead. Nothing in `group-interaction-fixtures.ts` or `group-fixtures.ts`
 * is modified.
 *
 * ## Coordinates
 *
 * All positions are **document** px, at the top-level page, matching the M13 convention. Every leaf is
 * given a size and a separation such that its painted centre is unambiguous and its painted box is
 * disjoint from its siblings' -- so a click at a centre always selects the leaf that was measured.
 *
 * ## Why the rotated fixtures use strong angles
 *
 * `ROTATED_GROUP_ONE_CHILD` and `NESTED_GROUP` use mild angles (0.4 and 0.3 rad) because they also carry
 * the **movement** regression, where the assertion has to survive a real pointer drag. Alignment and
 * distribution assert on geometry directly, with no gesture in the way, so they can afford angles that
 * separate a correct implementation from a wrong one by a wide margin -- which is what makes a negative
 * control worth having at all.
 */

import type { Page } from '@playwright/test';
import { mountFixture } from '../visual/harness';

/**
 * One leaf inside a group that is rotated **and** uniformly scaled.
 *
 * The hard case for movement, and the one ADR 0016's coordinate-space correction is about: the group's
 * matrix is neither the identity nor a pure rotation, so a page-space delta and a parent-space delta
 * differ in both magnitude and direction. A single leaf, so nothing overlaps it and the click target is
 * unambiguous.
 *
 * `child` is at local (40,40) 80x80. The group is at (200,150) with `rotation 0.4` and `scale 1.2`, so
 * the leaf's painted centre lands well inside the page and well clear of the group's own frame edges.
 */
export const ROTATED_GROUP_ONE_CHILD = `() => ({
  formatVersion: 1, id: 'm16rot', name: 'Rotated group',
  pageSize: { width: 500, height: 400, unit: 'pt', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [
      { type: 'group', id: 'g1', name: 'Group',
        transform: { x: 200, y: 150, width: 0, height: 0, rotation: 0.4, scaleX: 1.2, scaleY: 1.2 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        children: [
          { type: 'shape', id: 'child', name: 'child',
            transform: { x: 40, y: 40, width: 80, height: 80, rotation: 0, scaleX: 1, scaleY: 1 },
            visible: true, locked: false, opacity: 1, blendMode: 'normal',
            shape: { kind: 'rect', cornerRadius: 0 },
            fill: { type: 'solid', color: '#a8c8f0' } },
        ] },
      { type: 'shape', id: 'outside', name: 'outside',
        transform: { x: 40, y: 40, width: 60, height: 60, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#c8f0b0' } },
    ],
  }],
})`;

/**
 * A group nested two deep -- `inner` inside `outer`, `leaf` inside `inner` -- plus a plain top-level box.
 *
 * The extra top-level box is what makes the document useful for alignment: two objects are the minimum an
 * alignment needs, and without a second one every alignment here would be a refusal. It sits at (400,320)
 * 70x60, far from the group's own extent near the middle of the page, so the two painted boxes are
 * disjoint and each is independently clickable.
 *
 * Both levels of the chain carry a rotation and a uniform scale, so the page-to-local conversion has to
 * compose a matrix rather than invert one.
 */
export const NESTED_GROUP = `() => ({
  formatVersion: 1, id: 'm16nested', name: 'Nested groups',
  pageSize: { width: 560, height: 420, unit: 'pt', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [
      { type: 'group', id: 'outer', name: 'Outer',
        transform: { x: 120, y: 90, width: 0, height: 0, rotation: 0.3, scaleX: 1.1, scaleY: 1.1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        children: [
          { type: 'group', id: 'inner', name: 'Inner',
            transform: { x: 30, y: 20, width: 0, height: 0, rotation: -0.2, scaleX: 1.4, scaleY: 1.4 },
            visible: true, locked: false, opacity: 1, blendMode: 'normal',
            children: [
              { type: 'shape', id: 'leaf', name: 'leaf',
                transform: { x: 20, y: 20, width: 60, height: 60, rotation: 0, scaleX: 1, scaleY: 1 },
                visible: true, locked: false, opacity: 1, blendMode: 'normal',
                shape: { kind: 'rect', cornerRadius: 0 },
                fill: { type: 'solid', color: '#f0c8a8' } },
            ] },
        ] },
      { type: 'shape', id: 'outside', name: 'outside',
        transform: { x: 400, y: 320, width: 70, height: 60, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#c8f0b0' } },
    ],
  }],
})`;

/**
 * Two axis-aligned rectangles plus one rotated 45°, for aligning rotated objects.
 *
 * `a` at (40,40) 100x60, `b` at (300,200) 100x60, `c` at (120,300) 100x60 rotated by `Math.PI / 4`.
 *
 * The rotation is chosen so the negative control has room. A 45° rotation turns the 100x60 box into a
 * painted box of `100·cos45 + 60·sin45` by `100·sin45 + 60·cos45` = **113.1 × 113.1**, which is
 * comfortably different from the model's 100x60 -- so an implementation that aligned by the *model frame*
 * rather than the painted bounds moves `c` by several pixels away from the correct answer. At a mild angle
 * the two boxes nearly coincide and the distinction would be untestable.
 *
 * `c` sits well below and left of `a` and `b` so all three are independently clickable.
 */
export const ROTATED_SIZED = `() => ({
  formatVersion: 1, id: 'm16rot45', name: 'Rotated sizing',
  pageSize: { width: 500, height: 450, unit: 'pt', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [
      { type: 'shape', id: 'a', name: 'a',
        transform: { x: 40, y: 40, width: 100, height: 60, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#a8c8f0' } },
      { type: 'shape', id: 'b', name: 'b',
        transform: { x: 300, y: 200, width: 100, height: 60, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#f0c8a8' } },
      { type: 'shape', id: 'c', name: 'c',
        transform: { x: 120, y: 300, width: 100, height: 60, rotation: Math.PI / 4, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#c8f0b0' } },
    ],
  }],
})`;

/** `ROTATED_SIZED`, plus a group whose painted bounds are the union of two rotated children. */
export const ROTATED_GROUP_MEMBERS = `() => ({
  formatVersion: 1, id: 'm16rotgrp', name: 'Rotated group members',
  pageSize: { width: 600, height: 450, unit: 'pt', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [
      { type: 'shape', id: 'plain', name: 'plain',
        transform: { x: 40, y: 40, width: 100, height: 60, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#a8c8f0' } },
      { type: 'group', id: 'grp', name: 'Group',
        transform: { x: 300, y: 200, width: 0, height: 0, rotation: 0.3, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        children: [
          { type: 'shape', id: 'm1', name: 'm1',
            transform: { x: 0, y: 0, width: 70, height: 50, rotation: 0.5, scaleX: 1, scaleY: 1 },
            visible: true, locked: false, opacity: 1, blendMode: 'normal',
            shape: { kind: 'rect', cornerRadius: 0 },
            fill: { type: 'solid', color: '#f0c8a8' } },
          { type: 'shape', id: 'm2', name: 'm2',
            transform: { x: 90, y: 60, width: 70, height: 50, rotation: -0.4, scaleX: 1, scaleY: 1 },
            visible: true, locked: false, opacity: 1, blendMode: 'normal',
            shape: { kind: 'rect', cornerRadius: 0 },
            fill: { type: 'solid', color: '#c8f0b0' } },
        ] },
    ],
  }],
})`;

/**
 * Three axis-aligned rectangles with **deliberately different sizes**, for alignment.
 *
 * `a` 60x40 at (40,40), `b` 100x120 at (200,80), `c` 50x90 at (380,150). Their left edges are 40/200/380,
 * centres 70/250/405, right edges 100/300/430 -- all distinct, so every axis has a well-defined answer
 * and none of the six alignment operations is accidentally a no-op. The differing sizes matter: an
 * implementation that aligned by centre when asked to align by edge would pass on equal-size boxes.
 */
export const THREE_SIZED_RECTS = `() => ({
  formatVersion: 1, id: 'm16sized', name: 'Three sized rects',
  pageSize: { width: 500, height: 400, unit: 'pt', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [
      { type: 'shape', id: 'a', name: 'a',
        transform: { x: 40, y: 40, width: 60, height: 40, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#a8c8f0' } },
      { type: 'shape', id: 'b', name: 'b',
        transform: { x: 200, y: 80, width: 100, height: 120, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#f0c8a8' } },
      { type: 'shape', id: 'c', name: 'c',
        transform: { x: 380, y: 150, width: 50, height: 90, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#c8f0b0' } },
    ],
  }],
})`;

/**
 * Three rectangles whose **painted left edges are already equally spaced** -- 40, 140, 240 -- with gaps
 * of 40 between them (each is 60 wide), and whose heights deliberately differ so that horizontal
 * distribution is a genuine no-op while vertical distribution is not.
 *
 * Exists so "already distributed" has a fixture. Without one, a distribution test can only prove that
 * something moved, never that a correct implementation leaves it alone.
 */
export const ALREADY_DISTRIBUTED = `() => ({
  formatVersion: 1, id: 'm16dist', name: 'Already distributed',
  pageSize: { width: 500, height: 400, unit: 'pt', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [
      { type: 'shape', id: 'a', name: 'a',
        transform: { x: 40, y: 40, width: 60, height: 30, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#a8c8f0' } },
      { type: 'shape', id: 'b', name: 'b',
        transform: { x: 140, y: 120, width: 60, height: 90, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#f0c8a8' } },
      { type: 'shape', id: 'c', name: 'c',
        transform: { x: 240, y: 250, width: 60, height: 40, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#c8f0b0' } },
    ],
  }],
})`;

/**
 * Three rectangles that **overlap** on both axes, for distribution under overlap.
 *
 * `a` at (40,40) 100x100, `b` at (100,60) 100x100 -- so `b`'s left edge (100) is inside `a`'s span
 * (40..140) -- and `c` at (200,120) 100x100. Total painted span is 40..300 = 260, the three widths total
 * 300, so equal gaps come out **negative** (`(260 - 300) / 2 = -20`). That is the documented behaviour:
 * distribution separates what cannot be separated by moving the middle object, rather than refusing.
 */
export const OVERLAPPING_RECTS = `() => ({
  formatVersion: 1, id: 'm16overlap', name: 'Overlapping rects',
  pageSize: { width: 500, height: 400, unit: 'pt', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [
      { type: 'shape', id: 'a', name: 'a',
        transform: { x: 40, y: 40, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#a8c8f0' } },
      { type: 'shape', id: 'b', name: 'b',
        transform: { x: 100, y: 60, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#f0c8a8' } },
      { type: 'shape', id: 'c', name: 'c',
        transform: { x: 200, y: 120, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#c8f0b0' } },
    ],
  }],
})`;

/**
 * Two rectangles, for the two-object minimum.
 *
 * `a` at (40,40) 80x60, `b` at (200,150) 120x90. Different sizes on both axes, so alignment has a real
 * answer and distribution has none to give.
 */
export const TWO_RECTS = `() => ({
  formatVersion: 1, id: 'm16two', name: 'Two rects',
  pageSize: { width: 500, height: 400, unit: 'pt', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [
      { type: 'shape', id: 'a', name: 'a',
        transform: { x: 40, y: 40, width: 80, height: 60, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#a8c8f0' } },
      { type: 'shape', id: 'b', name: 'b',
        transform: { x: 200, y: 150, width: 120, height: 90, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#f0c8a8' } },
    ],
  }],
})`;

/** One leaf inside a group that is rotated but **not** scaled. */
export async function mountRotatedGroupOneChild(page: Page): Promise<void> {
  await mountFixture(page, ROTATED_GROUP_ONE_CHILD);
}

/** A leaf inside a group inside a group, with rotation and scale at both levels. */
export async function mountNestedGroup(page: Page): Promise<void> {
  await mountFixture(page, NESTED_GROUP);
}

/** Three rectangles of different sizes. */
export async function mountThreeSizedRects(page: Page): Promise<void> {
  await mountFixture(page, THREE_SIZED_RECTS);
}

/** Three rectangles already equally spaced horizontally. */
export async function mountAlreadyDistributed(page: Page): Promise<void> {
  await mountFixture(page, ALREADY_DISTRIBUTED);
}

/** Three rectangles that overlap, forcing negative distribution gaps. */
export async function mountOverlappingRects(page: Page): Promise<void> {
  await mountFixture(page, OVERLAPPING_RECTS);
}

/** Two rectangles of different sizes. */
export async function mountTwoRects(page: Page): Promise<void> {
  await mountFixture(page, TWO_RECTS);
}

/** Two axis-aligned rectangles and one rotated 45°. */
export async function mountRotatedSized(page: Page): Promise<void> {
  await mountFixture(page, ROTATED_SIZED);
}

/** A plain rectangle and a group of two rotated members. */
export async function mountRotatedGroupMembers(page: Page): Promise<void> {
  await mountFixture(page, ROTATED_GROUP_MEMBERS);
}
