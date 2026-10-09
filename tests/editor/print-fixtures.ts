/**
 * Fixtures for M19's print suite.
 *
 * ## What a print fixture has to contain that an editing fixture does not
 *
 * Every editing fixture so far has been a single page of a couple of boxes. Printing is the first
 * feature whose correctness depends on things the *document* does not otherwise exercise together:
 *
 * - **More than one page**, because "one document page per sheet" and "no extra sheet from the stack
 *   gap" are only observable with a stack.
 * - **A non-default page size and unit**, because the sheet has to come from the document and not from
 *   a hardcoded A4. A4 portrait in mm and A4 landscape in inches together pin both the unit and the
 *   orientation swap.
 * - **A coloured page background**, because browsers drop backgrounds by default and a page that
 *   prints white is the single most visible way for a print profile to fail.
 * - **Content that is clipped**, so that a change which rescues the content by disabling
 *   `overflow: hidden` would be caught rather than rewarded.
 * - **An image**, `decode()`d before printing, because an unloaded image prints as an empty box.
 * - **A rotated object and a group**, because both are transforms the print sheet must not flatten.
 */

import type { Page } from '@playwright/test';
import { mountFixture } from '../visual/harness';

/**
 * A 1x1 transparent PNG, inlined.
 *
 * Tiny on purpose: this suite asserts that the image *element* carries its authored geometry in the
 * print view, not what a photograph looks like. A large fixture would make the test slower without
 * testing more.
 */
export const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * Three pages, 120x80mm, portrait.
 *
 * 120x80 rather than A4 so the document page is small: at 96px/in that is 453.5 x 302.4 CSS px, which
 * keeps the whole stack inside the default 1280x900 test viewport at zoom 1 and therefore lets the
 * tests compare geometry without first having to fit.
 *
 * Deliberately awkward content:
 * - page 1 has an object hanging **past the right edge** (x 300, width 120 against a 453.5px page) so
 *   clipping is observable;
 * - page 2 is a dark background, the case a browser will happily print as white;
 * - page 3 holds a rotated object, a group, and the image.
 *
 * Page order is the array order: index 0 paints first and is printed first.
 */
export const PRINT_THREE_PAGES = `() => ({
  formatVersion: 2, id: 'm19print', name: 'Print three pages',
  pageSize: { width: 120, height: 80, unit: 'mm', orientation: 'portrait' },
  assets: {
    dot: {
      kind: 'image', mime: 'image/png',
      intrinsicWidth: 1, intrinsicHeight: 1,
      data: { inline: '${TINY_PNG}' },
    },
  },
  pages: [
    {
      id: 'p1', name: 'One',
      background: { type: 'solid', color: '#ffffff' },
      objects: [
        { type: 'shape', id: 'bleed', name: 'bleed',
          transform: { x: 300, y: 40, width: 120, height: 60, rotation: 0, scaleX: 1, scaleY: 1 },
          visible: true, locked: false, opacity: 1, blendMode: 'normal',
          shape: { kind: 'rect', cornerRadius: 0 },
          fill: { type: 'solid', color: '#ff3366' } },
        { type: 'shape', id: 'inside', name: 'inside',
          transform: { x: 20, y: 20, width: 80, height: 40, rotation: 0, scaleX: 1, scaleY: 1 },
          visible: true, locked: false, opacity: 1, blendMode: 'normal',
          shape: { kind: 'ellipse', },
          fill: { type: 'solid', color: '#3366ff' } },
      ],
    },
    {
      id: 'p2', name: 'Two',
      background: { type: 'solid', color: '#102030' },
      objects: [],
    },
    {
      id: 'p3', name: 'Three',
      background: { type: 'solid', color: '#f0f0f0' },
      objects: [
        { type: 'shape', id: 'turned', name: 'turned',
          transform: { x: 20, y: 20, width: 60, height: 30, rotation: 0.5, scaleX: 1, scaleY: 1 },
          visible: true, locked: false, opacity: 1, blendMode: 'normal',
          shape: { kind: 'rect', cornerRadius: 0 },
          fill: { type: 'solid', color: '#22aa55' } },
        { type: 'group', id: 'grp', name: 'Group',
          transform: { x: 140, y: 20, width: 0, height: 0, rotation: 0, scaleX: 1, scaleY: 1 },
          visible: true, locked: false, opacity: 1, blendMode: 'normal',
          children: [
            { type: 'shape', id: 'kid', name: 'kid',
              transform: { x: 0, y: 0, width: 40, height: 20, rotation: 0, scaleX: 1, scaleY: 1 },
              visible: true, locked: false, opacity: 1, blendMode: 'normal',
              shape: { kind: 'rect', cornerRadius: 0 },
              fill: { type: 'solid', color: '#aa22aa' } },
          ] },
        { type: 'image', id: 'pic', name: 'pic',
          transform: { x: 20, y: 120, width: 40, height: 40, rotation: 0, scaleX: 1, scaleY: 1 },
          visible: true, locked: false, opacity: 1, blendMode: 'normal',
          asset: 'dot' },
      ],
    },
  ],
})`;

/**
 * One page, 8.5x11 inches, **landscape**.
 *
 * A different unit *and* a different orientation from {@link PRINT_THREE_PAGES}, so a sheet that
 * hardcodes either one cannot pass both.
 */
export const PRINT_LANDSCAPE_INCHES = `() => ({
  formatVersion: 2, id: 'm19land', name: 'Landscape inches',
  pageSize: { width: 8.5, height: 11, unit: 'in', orientation: 'landscape' },
  assets: {},
  pages: [
    {
      id: 'p1', name: 'One',
      background: { type: 'solid', color: '#ffffff' },
      objects: [
        { type: 'shape', id: 'box', name: 'box',
          transform: { x: 40, y: 40, width: 120, height: 80, rotation: 0, scaleX: 1, scaleY: 1 },
          visible: true, locked: false, opacity: 1, blendMode: 'normal',
          shape: { kind: 'rect', cornerRadius: 0 },
          fill: { type: 'solid', color: '#334455' } },
      ],
    },
  ],
})`;

/** Three pages, 120x80mm, portrait. */
export async function mountPrintThreePages(page: Page): Promise<void> {
  await mountFixture(page, PRINT_THREE_PAGES);
}

/** One landscape page, 8.5x11in. */
export async function mountPrintLandscapeInches(page: Page): Promise<void> {
  await mountFixture(page, PRINT_LANDSCAPE_INCHES);
}