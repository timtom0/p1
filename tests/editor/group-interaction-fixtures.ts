/**
 * Fixtures for M13's group **interaction** suite.
 *
 * ## Why this file exists rather than additions to `group-fixtures.ts`
 *
 * `group-fixtures.ts` is a protected, hand-maintained M12 artefact with 26 browser tests pinned to its
 * exact painted geometry. It was overwritten during M13 and recovered byte-for-byte from the session
 * store; this file exists so that cannot recur. Nothing here is imported by `group-geometry.spec.ts`,
 * and nothing in that file was changed to accommodate M13.
 *
 * ## Coordinates
 *
 * All positions are **document** px. `a`, `b` and `c` are laid out so that:
 *
 * - `a` and `b` are **adjacent siblings**, so grouping them absorbs no third node;
 * - `a` and `c` have `b` between them, which is the non-contiguous case;
 * - every box is 100x100, so a midpoint is unambiguous for a click.
 */

import type { Page } from '@playwright/test';
import { mountFixture } from '../visual/harness';

/** Three rects: `a` top-left, `b` top-right, `c` below `a`. */
const THREE_RECTS = `() => ({
  formatVersion: 1, id: 'gdoc', name: 'Groups',
  pageSize: { width: 400, height: 300, unit: 'pt', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [
      { type: 'shape', id: 'a', name: 'a',
        transform: { x: 20, y: 20, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#a8c8f0' } },
      { type: 'shape', id: 'b', name: 'b',
        transform: { x: 140, y: 20, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#f0c8a8' } },
      { type: 'shape', id: 'c', name: 'c',
        transform: { x: 20, y: 140, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#c8f0b0' } },
    ],
  }],
})`;

/** `THREE_RECTS` with `a` and `b` already wrapped in a group, authored at the transparent frame. */
const GROUPED = `() => ({
  formatVersion: 1, id: 'gdoc', name: 'Groups',
  pageSize: { width: 400, height: 300, unit: 'pt', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [
      { type: 'group', id: 'g1', name: 'Group',
        transform: { x: 0, y: 0, width: 0, height: 0, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        children: [
          { type: 'shape', id: 'a', name: 'a',
            transform: { x: 20, y: 20, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1 },
            visible: true, locked: false, opacity: 1, blendMode: 'normal',
            shape: { kind: 'rect', cornerRadius: 0 },
            fill: { type: 'solid', color: '#a8c8f0' } },
          { type: 'shape', id: 'b', name: 'b',
            transform: { x: 140, y: 20, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1 },
            visible: true, locked: false, opacity: 1, blendMode: 'normal',
            shape: { kind: 'rect', cornerRadius: 0 },
            fill: { type: 'solid', color: '#f0c8a8' } },
        ] },
      { type: 'shape', id: 'c', name: 'c',
        transform: { x: 20, y: 140, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#c8f0b0' } },
    ],
  }],
})`;

/** `GROUPED`, with the group moved, rotated, and uniformly scaled -- the hard movement case. */
export const TRANSFORMED_GROUP_FIXTURE = `() => {
  const base = ${GROUPED.slice('() => '.length)};
  const group = base.pages[0].objects[0];
  group.transform = { x: 60, y: 40, width: 0, height: 0, rotation: 0.4, scaleX: 1.5, scaleY: 1.5 };
  return base;
}`;

/** A group nested two deep, so entry and movement have somewhere to go. */
export const NESTED_GROUP_FIXTURE = `() => {
  const base = ${GROUPED.slice('() => '.length)};
  const inner = base.pages[0].objects[0];
  base.pages[0].objects.unshift({
    type: 'group', id: 'g_outer', name: 'Outer',
    transform: { x: 0, y: 0, width: 0, height: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    visible: true, locked: false, opacity: 1, blendMode: 'normal',
    children: [inner],
  });
  base.pages[0].objects = base.pages[0].objects.filter((node) => node.id !== 'g1');
  return base;
}`;

/** The group hidden, so M12's hidden-ancestor chain is reachable through a group. */
export const HIDDEN_GROUP_FIXTURE = `() => {
  const base = ${GROUPED.slice('() => '.length)};
  base.pages[0].objects[0].visible = false;
  return base;
}`;

/** Three rects, nothing grouped. The starting point for every grouping test. */
export async function mountGroupFixture(page: Page): Promise<void> {
  await mountFixture(page, THREE_RECTS);
}

/** `a` and `b` already inside a transparent group. */
export async function mountGroupedFixture(page: Page): Promise<void> {
  await mountFixture(page, GROUPED);
}

/** The group moved, rotated 0.4 rad, uniformly scaled 1.5. */
export async function mountTransformedGroupFixture(page: Page): Promise<void> {
  await mountFixture(page, TRANSFORMED_GROUP_FIXTURE);
}

/** A group inside a group. */
export async function mountNestedGroupFixture(page: Page): Promise<void> {
  await mountFixture(page, NESTED_GROUP_FIXTURE);
}

/** The group hidden. */
export async function mountHiddenGroupFixture(page: Page): Promise<void> {
  await mountFixture(page, HIDDEN_GROUP_FIXTURE);
}