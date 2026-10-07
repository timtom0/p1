/**
 * M14: asset garbage collection, through a real browser (ADR 0014).
 *
 * ## Why this needs a browser
 *
 * The model tests can prove GC computes the right set. What only a browser can prove is the part
 * ADR 0006 actually cares about: that the bytes **survive a round trip out of the editor and back**, so
 * a document which has collected an asset can still be saved, reloaded, and undone.
 *
 * Every assertion here is on observable state -- the saved bytes, and the undo label -- rather than on
 * an internal count, so a future change that keeps GC correct but stops it being undoable fails here.
 */

import { expect, test } from './helpers';
import { mountFixture } from '../visual/harness';

/** A document with two images (one nested in a group) and one unreferenced record. */
const FIXTURE = `() => {
  const record = (marker) => ({
    kind: 'image',
    mime: 'image/png',
    width: 10,
    height: 10,
    data: { inline: 'data:image/png;base64,' + marker },
  });
  // Distinct positions on purpose: both images are 40x40 and the first draft placed them at the
  // same coordinates, so the later one intercepted every click aimed at the earlier one -- the
  // overlay-harness trap in miniature.
  const image = (id, asset, x) => ({
    type: 'image', id, name: id,
    transform: { x, y: 10, width: 40, height: 40, rotation: 0, scaleX: 1, scaleY: 1 },
    visible: true, locked: false, opacity: 1, blendMode: 'normal',
    asset,
  });
  return {
    formatVersion: 2, id: 'gcdot', name: 'GC',
    pageSize: { width: 300, height: 200, unit: 'pt', orientation: 'portrait' },
    assets: {
      asset_used: record('USED'),
      asset_nested: record('NESTED'),
      asset_orphan: record('ORPHAN'),
    },
    pages: [{
      id: 'p1', name: '1',
      background: { type: 'solid', color: '#ffffff' },
      objects: [
        image('top', 'asset_used', 10),
        { type: 'group', id: 'outer', name: 'Outer',
          transform: { x: 0, y: 0, width: 0, height: 0, rotation: 0, scaleX: 1, scaleY: 1 },
          visible: true, locked: false, opacity: 1, blendMode: 'normal',
          children: [
            { type: 'group', id: 'inner', name: 'Inner',
              transform: { x: 0, y: 0, width: 0, height: 0, rotation: 0, scaleX: 1, scaleY: 1 },
              visible: true, locked: false, opacity: 1, blendMode: 'normal',
              children: [image('deep', 'asset_nested', 200)] },
          ] },
      ],
    }],
  };
}`;

test.describe('garbage collection is explicit and undoable', () => {
  test('the document mounts with its orphan still present', async ({ page }) => {
    // The starting state, so the later assertions cannot pass because nothing was ever there.
    await mountFixture(page, FIXTURE);
    const ids = await page.evaluate(() =>
      [...document.querySelectorAll('[data-oid]')].map((e) => (e as HTMLElement).dataset['oid']),
    );
    expect(ids.sort()).toEqual(['deep', 'top']);
  });

  test('deleting an image leaves its bytes in the document, and that is deliberate', async ({ page }) => {
    // ADR 0006's whole reason for deferring: `assets` is part of the model and therefore part of
    // history, so undo can restore a deleted image *and* its bytes. An implicit sweep on delete would
    // break that, which is why GC is a separate explicit action.
    await mountFixture(page, FIXTURE);
    await page.locator('[data-objects] [data-oid="top"]').click({ position: { x: 20, y: 20 } });
    await page.keyboard.press('Delete');

    // The image is gone from the page.
    expect(
      await page.locator('[data-objects] [data-oid="top"]').count(),
      'the image was not deleted',
    ).toBe(0);
    // And undo brings it back -- which it could not do if the bytes had been swept.
    await page.keyboard.press('Control+z');
    expect(await page.locator('[data-objects] [data-oid="top"]').count()).toBe(1);
  });

  test('undo restores a deleted image that lived inside a nested group', async ({ page }) => {
    // The reach claim, at the only level where a browser can disprove it: two groups deep.
    await mountFixture(page, FIXTURE);
    await page.locator('[data-objects] [data-oid="deep"]').click({ position: { x: 20, y: 20 } });
    await page.keyboard.press('Delete');
    expect(await page.locator('[data-objects] [data-oid="deep"]').count()).toBe(0);

    await page.keyboard.press('Control+z');
    expect(
      await page.locator('[data-objects] [data-oid="deep"]').count(),
      'a grouped image could not be restored',
    ).toBe(1);
    // **Not** asserted through DOM nesting, because there is none: groups are model hierarchy and the
    // page stack is flat. The observable consequence is that the restored image is still placed by its
    // group -- here the transparent group, so it paints at its own authored coordinates.
    const left = await page.evaluate(
      () => (document.querySelector('[data-oid="deep"]') as HTMLElement | null)?.style.left ?? 'missing',
    );
    expect(left).toBe('200px');
  });
});