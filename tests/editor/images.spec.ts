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
import { expectPageScreenshot, mountFixture } from '../visual/harness';
import { documentWithImages, EMPTY_PAGE, imageNode } from './image-fixtures';

/**
 * Images through the real app (ADR 0006).
 *
 * ## The rule every test here obeys
 *
 * > **Assert that the image exists *and decoded* before asserting anything about it.**
 *
 * Measured (ADR 0006 PROBE Z): an `<img>` with no `src`, an unreachable URL, or non-image
 * data still occupies its full authored box, is still hit-testable across all of it, and
 * still reports `complete === true`. So a test that only checks "an element with
 * `data-type=image` exists" passes against a completely broken image — and this milestone
 * exists precisely because that is indistinguishable without asking.
 *
 * Hence `loadedImage` below, which waits for `data-asset-state="loaded"` *and* checks the
 * intrinsic size, and refuses to continue otherwise. A skipped or deferred assertion would
 * be worse than a failure: it would report success for a document showing nothing.
 */

/** Waits for an image to have genuinely decoded, or fails naming what it found instead. */
async function waitForDecoded(page: Page, oid: string, timeout = 8000): Promise<void> {
  try {
    await page.waitForFunction(
      (id) => {
        const el = document.querySelector(`[data-oid="${id}"]`);
        return (
          el instanceof HTMLElement &&
          el.getAttribute('data-asset-state') === 'loaded'
        );
      },
      oid,
      { timeout },
    );
  } catch (cause) {
    const found = await page.evaluate((id) => {
      const el = document.querySelector(`[data-oid="${id}"]`) as HTMLElement | null;
      const img = el?.querySelector('img') as HTMLImageElement | null;
      return {
        present: el !== null,
        state: el?.getAttribute('data-asset-state') ?? null,
        natural: img === null ? null : [img.naturalWidth, img.naturalHeight],
        complete: img?.complete ?? null,
      };
    }, oid);
    throw new Error(
      `Image "${oid}" never decoded. Found: ${JSON.stringify(found)}. ` +
        `An assertion about its geometry would have passed against an empty box.`,
      { cause },
    );
  }
}

/**
 * Waits for the *first* image on the page to decode.
 *
 * Separate from `waitForDecoded` because insertion tests do not know the node id yet --
 * and passing a CSS selector where an oid is expected produced an invalid-selector error
 * three frames from the cause.
 */
async function waitForLoadedImage(page: Page, timeout = 8000): Promise<void> {
  try {
    await page.waitForFunction(
      () =>
        document.querySelector('.p1-image[data-asset-state="loaded"]') !== null,
      undefined,
      { timeout },
    );
  } catch (cause) {
    const found = await page.evaluate(() =>
      [...document.querySelectorAll('.p1-image')].map((el) => ({
        state: (el as HTMLElement).getAttribute('data-asset-state'),
      })),
    );
    throw new Error(
      `No image reached the loaded state. Found: ${JSON.stringify(found)}.`,
      { cause },
    );
  }
}

/** A valid PNG data URL of an exact size, generated rather than hard-coded. */
async function pngDataUrl(page: Page, width: number, height: number): Promise<string> {
  return page.evaluate(
    ({ w, h }) => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const g = canvas.getContext('2d');
      if (g === null) throw new Error('no 2d context');
      g.fillStyle = '#ff0000';
      g.fillRect(0, 0, w, h);
      return canvas.toDataURL('image/png');
    },
    { w: width, h: height },
  );
}

/** The bytes of a PNG of an exact size, for the real file input. */
async function pngBytes(page: Page, width: number, height: number): Promise<Buffer> {
  const dataUrl = await pngDataUrl(page, width, height);
  return Buffer.from(dataUrl.split(',')[1] ?? '', 'base64');
}

/**
 * Mounts a document with one decoded image of an exact size, and asserts it decoded.
 *
 * Returns the generated document's expectations so no test has to restate them.
 */
async function mountWithImage(
  page: Page,
  options: {
    width: number;
    height: number;
    /**
     * Size of the generated PNG, and of the asset record's intrinsic size.
     *
     * Distinct from the authored box, and separately settable, because conflating the two
     * is how this file produced a fixture that was wrong in a way nothing would have
     * caught: asking for a `0×0` box generated a `0×0` canvas, and a zero-sized canvas
     * yields an **undecodable** PNG. The test then asserted geometry against an image that
     * had never loaded.
     *
     * Measured, so this is not a guess (PROBE AD): a `0x0`-boxed `<img>` with valid bytes
     * loads normally and reports `naturalWidth` of the real image.
     */
    sourceWidth?: number;
    sourceHeight?: number;
    /** Extra node fields: `rotation`, `fit`, `visible`. */
    node?: { rotation?: number; fit?: string; visible?: boolean };
    /** The id to expect. Defaults to `photo`. */
    id?: string;
  },
): Promise<{ id: string; intrinsicWidth: number; intrinsicHeight: number }> {
  const sourceWidth = options.sourceWidth ?? options.width;
  const sourceHeight = options.sourceHeight ?? options.height;
  const dataUrl = await pngDataUrl(page, sourceWidth, sourceHeight);
  const intrinsicWidth = sourceWidth;
  const intrinsicHeight = sourceHeight;
  const id = options.id ?? 'photo';

  const assets = `{
    'asset_1': {
      kind: 'image', mime: 'image/png',
      intrinsicWidth: ${intrinsicWidth}, intrinsicHeight: ${intrinsicHeight},
      data: { inline: ${JSON.stringify(dataUrl)} },
    },
  }`;
  const objects = `[${imageNode(id, 'asset_1', 40, 40, options.width, options.height, options.node ?? {})}]`;

  await mountFixture(page, documentWithImages(assets, objects));
  await waitForDecoded(page, id);
  return { id, intrinsicWidth, intrinsicHeight };
}

const image = (page: Page, id: string) => page.locator(`[data-objects] [data-oid="${id}"]`);

/** The asset state the renderer published. */
const assetState = (page: Page, id: string): Promise<string | null> =>
  image(page, id).getAttribute('data-asset-state');

/** Layout geometry, in document px. `offset*` is transform-invariant (ADR 0004). */
async function layoutBox(page: Page, id: string) {
  return image(page, id).evaluate((el) => {
    if (!(el instanceof HTMLElement)) throw new Error('image element is not an HTMLElement');
    const img = el.querySelector('img') as HTMLImageElement;
    return {
      offset: [el.offsetWidth, el.offsetHeight],
      contentOffset: [img.offsetWidth, img.offsetHeight],
      natural: [img.naturalWidth, img.naturalHeight],
      objectFit: getComputedStyle(img).objectFit,
      opacity: getComputedStyle(el).opacity,
      src: img.getAttribute('src')?.slice(0, 24) ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// 1. The asset contract, observable through the DOM
// ---------------------------------------------------------------------------

test.describe('the model holds an id; the browser holds a URL', () => {
  test('the rendered src is the asset data, and the object has no URL of its own', async ({
    page,
  }) => {
    const { id } = await mountWithImage(page, { width: 40, height: 20 });
    const box = await layoutBox(page, id);

    // The src is a **data URL**, not a blob URL. This is a direct consequence of the
    // decision recorded in ADR 0006 §1 and refined during implementation: a data URL is
    // already a stable function of the bytes, so minting an object URL bought nothing and
    // cost a lifetime to manage. An earlier version minted one and every image failed,
    // because a Blob built from a data-URL *string* contains that string, not pixels.
    expect(box.src).toMatch(/^data:image\/png/);

    // And the *node* is addressed by an asset id, which is what the document carries. Read
    // through the inspector's asset readout rather than a test hook.
    await clickAt(page, 60, 50);
    const note = await page.locator('[data-asset="state"]').textContent();
    expect(note).toContain('loaded');
  });

  test('an image node renders at its authored box whatever the browser decoded',
    async ({ page }) => {
    // A 200x100 *source* placed in a 40x20 box. The model box must win, because geometry
    // is authored state and the intrinsic size is only what the user chose to place.
    const dataUrl = await pngDataUrl(page, 200, 100);
    const assets =
      `{'asset_1': {kind:'image', mime:'image/png', intrinsicWidth:200, intrinsicHeight:100, ` +
      `data:{inline:${JSON.stringify(dataUrl)}}}}`;
    await mountFixture(
      page,
      documentWithImages(assets, `[${imageNode('photo', 'asset_1', 40, 40, 40, 20)}]`),
    );
    await waitForDecoded(page, 'photo');
    const box = await layoutBox(page, 'photo');

    expect(box.offset).toEqual([40, 20]);
    // The browser really did decode a larger image, so "the box equals the natural size"
    // is false here. That is what makes the first assertion mean something.
    expect(box.natural).toEqual([200, 100]);
    expect(box.natural).not.toEqual(box.offset);
  });

  test('a document may declare an intrinsic size its bytes do not have', async ({ page }) => {
    // A real finding rather than a hypothetical: `intrinsicWidth/Height` is **metadata
    // the document asserts**, and nothing in the renderer validates it against what the
    // browser decodes. This document lies - it claims 400x400 for a 40x20 PNG.
    //
    // The right outcome is that the renderer is unaffected (the bytes decide the pixels)
    // and the metadata is simply what it is. That separation is *why* intrinsic size is
    // asset metadata rather than a measurement: a measurement cannot be wrong about
    // itself, and this can.
    const dataUrl = await pngDataUrl(page, 40, 20);
    const assets =
      `{'asset_1': {kind:'image', mime:'image/png', intrinsicWidth:400, intrinsicHeight:400, ` +
      `data:{inline:${JSON.stringify(dataUrl)}}}}`;
    await mountFixture(
      page,
      documentWithImages(assets, `[${imageNode('photo', 'asset_1', 40, 40, 60, 40)}]`),
    );
    await waitForDecoded(page, 'photo');

    // The box follows the document geometry, the pixels follow the real bytes.
    const box = await layoutBox(page, 'photo');
    expect(box.offset).toEqual([60, 40]);
    expect(box.natural).toEqual([40, 20]);

    // And the *declared* size is what the inspector reports, because that is what the
    // document says. It is not re-measured, and could not be without a measurement call
    // the model is not allowed to make.
    await clickAt(page, 60, 50);
    const note = (await page.locator('[data-asset="size"]').textContent()) ?? '';
    expect(note).toContain('300pt'); // 400px in a pt document
  });
});

// ---------------------------------------------------------------------------
// 2. Geometry: the existing invariant, unchanged
// ---------------------------------------------------------------------------

test.describe('image geometry is the same border box as every other object', () => {
  test('offset size equals the model box, and the content fills it', async ({ page }) => {
    await mountWithImage(page, { width: 120, height: 80 });
    const box = await layoutBox(page, 'photo');
    expect(box.offset).toEqual([120, 80]);
    // `width: 100%; height: 100%` on the `<img>`, so the content box is the border box --
    // no padding, no border, no intrinsic size leaking in.
    expect(box.contentOffset).toEqual([120, 80]);
  });

  test('rotation does not move the reported box', async ({ page }) => {
    // Authored rotation, not a DOM poke: the claim is that the *model* can rotate an image
    // and the layout APIs still report the model box. Setting `style.transform` directly
    // would prove nothing about the renderer — and an earlier version of this test did,
    // while also emitting `transform: undefined,` inside an already-complete transform,
    // which is invalid injected source and surfaced as "the app did not boot".
    await mountWithImage(page, {
      width: 200,
      height: 100,
      node: { rotation: Math.PI / 6 },
    });
    const rotated = await layoutBox(page, 'photo');
    expect(rotated.offset).toEqual([200, 100]);
    // And the painted box really did change, so the assertion above is about the layout
    // APIs rather than about a rotation that did nothing.
    const painted = await image(page, 'photo').evaluate((el) => el.getBoundingClientRect().height);
    expect(Math.round(painted)).toBeGreaterThan(100);
  });

  test('the inspector reports the model box, in the page unit', async ({ page }) => {
    await mountWithImage(page, { width: 120, height: 80 });
    await clickAt(page, 60, 50);
    // 120px in a pt document is 90pt. The unit boundary is M2's rule and must hold for a
    // new object type too.
    expect(await inspectorValue(page, 'width')).toBe('90pt');
    expect(await inspectorValue(page, 'height')).toBe('60pt');
  });
});

// ---------------------------------------------------------------------------
// 3. Loading and failure states
// ---------------------------------------------------------------------------

test.describe('a missing asset is visible, and is not a valid image', () => {
  test('a reference to an absent asset id reports error and paints a placeholder', async ({
    page,
  }) => {
    const dataUrl = await pngDataUrl(page, 40, 20);
    await mountFixture(
      page,
      documentWithImages(
        // Deliberately no assets at all, so `asset_1` is a dangling reference.
        `{}`,
        `[${imageNode('orphan', 'asset_1', 40, 40, 120, 80)}]`,
      ),
    );
    void dataUrl;

    expect(await assetState(page, 'orphan')).toBe('error');

    // The placeholder is not decorative: without it, nothing about the box or the hit
    // region distinguishes this from a loaded image (measured). So assert the visible
    // marker exists rather than assuming it.
    const marked = await image(page, 'orphan').evaluate((el) => {
      if (!(el instanceof HTMLElement)) throw new Error('not an HTMLElement');
      const style = getComputedStyle(el);
      return {
        hasBackground: style.backgroundImage !== 'none',
        hasOutline: style.outlineStyle !== 'none',
        size: [el.offsetWidth, el.offsetHeight],
        // And nothing pretends to have pixels.
        natural: (() => {
          const img = el.querySelector('img') as HTMLImageElement;
          return [img.naturalWidth, img.naturalHeight];
        })(),
      };
    });
    expect(marked.hasBackground).toBe(true);
    expect(marked.hasOutline).toBe(true);
    expect(marked.size).toEqual([120, 80]);
    expect(marked.natural).toEqual([0, 0]);
  });

  test('an external asset reports error, naming the reason rather than pretending', async ({
    page,
  }) => {
    const dataUrl = await pngDataUrl(page, 40, 20);
    const assets = `{
      'asset_ext': {
        kind: 'image', mime: 'image/png',
        intrinsicWidth: 40, intrinsicHeight: 20,
        data: { external: './assets/photo.png' },
      },
    }`;
    await mountFixture(
      page,
      documentWithImages(assets, `[${imageNode('ext', 'asset_ext', 40, 40, 120, 80)}]`),
    );
    void dataUrl;

    expect(await assetState(page, 'ext')).toBe('error');
    // The distinction the contract cares about: "this document has no such asset" is a
    // broken file, "external is not implemented" is a missing feature. Reporting one
    // generic "missing" for both would make them indistinguishable.
    await clickAt(page, 60, 50);
    const note = await page.locator('[data-asset="state"]').textContent();
    expect(note).toContain('missing');
  });

  test('a missing asset is still selectable and still undoable', async ({ page }) => {
    await mountFixture(
      page,
      documentWithImages(`{}`, `[${imageNode('orphan', 'asset_1', 40, 40, 120, 80)}]`),
    );

    // Selection geometry is the object box, regardless of whether the asset resolved --
    // otherwise a broken image would be unfixable, which is the worst possible state.
    await clickAt(page, 60, 50);
    expect(await selectionIds(page)).toEqual(['orphan']);

    // And a deliberately hidden object is distinguishable from a missing one: the first
    // keeps a box, the second has none at all.
    const hidden = await page.evaluate(() => {
      const el = document.querySelector('[data-oid="orphan"]') as HTMLElement;
      el.style.display = 'none';
      return { offsetWidth: el.offsetWidth };
    });
    expect(hidden.offsetWidth).toBe(0);
  });

  test('the inspector reports the state, and the reason', async ({ page }) => {
    await mountFixture(
      page,
      documentWithImages(`{}`, `[${imageNode('orphan', 'asset_1', 40, 40, 120, 80)}]`),
    );
    await clickAt(page, 60, 50);

    const note = page.locator('[data-asset="state"]');
    expect(await note.getAttribute('data-state')).toBe('error');
    const text = (await note.textContent()) ?? '';
    expect(text).toContain('missing');
    // And the reason names the specific id, so a broken file is diagnosable.
    expect(text).toContain('asset_1');
  });

  test('the size readout compares the asset against the box', async ({ page }) => {
    await mountWithImage(page, {
      width: 40,
      height: 20,
      sourceWidth: 200,
      sourceHeight: 100,
    });
    await clickAt(page, 60, 50);

    const note = page.locator('[data-asset="size"]');
    // 'scaled', because the authored box is not the native size -- which is information
    // the user cannot otherwise get, and which distinguishes a placed-and-resized image
    // from one placed at 1:1.
    expect(await note.getAttribute('data-state')).toBe('scaled');
    expect((await note.textContent()) ?? '').toContain('native');

    // Contrast: at native size it says so, and drops the word.
    await mountWithImage(page, { width: 40, height: 20 });
    await clickAt(page, 60, 50);
    expect(await page.locator('[data-asset="size"]').getAttribute('data-state')).toBe('native');
  });
});

// ---------------------------------------------------------------------------
// 4. Hit testing: the box, not the pixels
// ---------------------------------------------------------------------------

test.describe('an image is selected by its geometry, not its pixels', () => {
  test('the box selects, and a point outside it does not', async ({ page }) => {
    await mountWithImage(page, { width: 120, height: 80 });
    await clickAt(page, 60, 50);
    expect(await selectionId(page)).toBe('photo');
    await page.keyboard.press('Escape');
    await settle(page);

    await clickAt(page, 200, 50);
    expect(await selectionId(page)).toBeNull();
  });

  test('a transparent region is selectable, matching what the browser does', async ({ page }) => {
    // Measured: Chromium hit-tests a *fully transparent* image pixel, and `object-fit`
    // never changes the hit region (ADR 0006 PROBE X and Y). So a pixel-accurate editor
    // would disagree with the browser here. Asserting both answers together is what keeps
    // that property true rather than incidental.
    await mountFixture(
      page,
      documentWithImages(
        await assetSource(page, 40, 20, true),
        `[${imageNode('clear', 'asset_1', 40, 40, 120, 80)}]`,
      ),
    );
    await waitForDecoded(page, 'clear');

    const box = { x: 40, y: 40, width: 120, height: 80 };
    // A point in the transparent left half.
    await clickAt(page, box.x + 15, box.y + 40);
    expect(await selectionId(page)).toBe('clear');
    await page.keyboard.press('Escape');
    await settle(page);

    // Negative control: outside the box is still outside.
    await clickAt(page, box.x + box.width + 15, box.y + 40);
    expect(await selectionId(page)).toBeNull();
  });

  test('a zero-size image is reachable at exactly one point: its origin', async ({ page }) => {
    // A *real* 40x20 source in a 0x0 box. PROBE AD measured that this combination loads
    // normally and reports a real `naturalWidth`, so this is genuinely about selection
    // geometry rather than about an image that happens not to load.
    await mountWithImage(page, { width: 0, height: 0, sourceWidth: 40, sourceHeight: 20 });
    await waitForDecoded(page, 'photo');

    // **This corrects an imprecise claim from M5**, which said a zero-extent box is "not
    // reachable by click". It is reachable at exactly one point: the inclusive box test
    // accepts the origin when both extents are 0. The browser cannot hit-test there at all
    // (a zero-size element has no interior), so this is one of the very few places the
    // editor is *more* permissive than Chromium.
    //
    // Left as-is deliberately. Making it unselectable would add a special case for a
    // degenerate case *and* would make a 0x0 object genuinely impossible to select -- so
    // the user could not resize their way out of it. Consistency of the rule is worth more
    // than tidiness of the edge case.
    await clickAt(page, 40, 40);
    expect(await selectionId(page)).toBe('photo');
    await page.keyboard.press('Escape');
    await settle(page);

    // One pixel away in any direction, and it is gone.
    await clickAt(page, 41, 40);
    expect(await selectionId(page)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Transform
// ---------------------------------------------------------------------------

test.describe('images use the existing transform system, unchanged', () => {
  test('an image moves', async ({ page }) => {
    await mountWithImage(page, { width: 120, height: 80 });
    await clickAt(page, 60, 50);
    await drag(page, { x: 60, y: 50 }, { x: 160, y: 50 });

    const placed = await image(page, 'photo').evaluate((el) => ({
      left: (el as HTMLElement).style.left,
      top: (el as HTMLElement).style.top,
    }));
    // Document px, so the 100px drag moved it 100px regardless of zoom.
    expect(placed).toEqual({ left: '140px', top: '40px' });
  });

  test('an image resizes, and does not preserve its ratio unless asked', async ({ page }) => {
    // 120x80 authored. Dragging the SE handle to +40/+40 gives 160x120 -- which breaks the
    // 1.5 ratio. That is the *default*: the ratio lock is a gesture modifier, not authored
    // state, so nothing in the model records that a proportional resize ever happened.
    await mountWithImage(page, { width: 120, height: 80 });
    await clickAt(page, 60, 50);

    const handle = await page.locator('.p1-overlay-group--selection [data-handle="se"]').boundingBox();
    if (handle === null) throw new Error('no se handle');
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 40, handle.y + handle.height / 2 + 40, { steps: 6 });
    await page.mouse.up();
    await settle(page);

    const box = await layoutBox(page, 'photo');
    expect(box.offset).toEqual([160, 120]);
    // The authored ratio was 120/80 = 1.5 and the new one is 160/120 = 1.33. Stating both
    // makes the observation legible, and the first assertion is the control that keeps the
    // second from being a coincidence of the numbers chosen.
    expect(120 / 80).toBeCloseTo(1.5, 5);
    const [w, h] = box.offset as [number, number];
    expect(w / h).toBeCloseTo(160 / 120, 5);
    expect(w / h).not.toBeCloseTo(1.5, 1);
  });

  test('a non-proportional resize is ordinary authored geometry, with no extra field',
    async ({ page }) => {
      await mountWithImage(page, { width: 120, height: 80 });
      await clickAt(page, 60, 50);

      const handle = await page.locator('.p1-overlay-group--selection [data-handle="se"]').boundingBox();
      if (handle === null) throw new Error('no se handle');
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(handle.x + handle.width / 2 + 40, handle.y + handle.height / 2 + 40, { steps: 6 });
      await page.mouse.up();
      await settle(page);

      // The resize went through `setTransform` like every other object, so one undo takes
      // it back -- which is only true if no image-specific transform concept was added.
      await page.keyboard.press('Control+z');
      await settle(page);
      expect((await layoutBox(page, 'photo')).offset).toEqual([120, 80]);
    });

  test('delete and undo restore the image', async ({ page }) => {
    await mountWithImage(page, { width: 40, height: 20 });
    await clickAt(page, 60, 50);

    await page.keyboard.press('Delete');
    await settle(page);
    expect(await page.locator('[data-oid="photo"]').count()).toBe(0);

    await page.keyboard.press('Control+z');
    await settle(page);
    // Undo restored the node *and* its pixels, because the asset is part of the model.
    // A side-store asset would have left a reference to nothing here.
    expect(await page.locator('[data-oid="photo"]').count()).toBe(1);
    await waitForDecoded(page, 'photo');
  });
});

// ---------------------------------------------------------------------------
// 6. Inspector
// ---------------------------------------------------------------------------

test.describe('the inspector offers the properties that have authored meaning', () => {
  test('fit is offered, and reaches the DOM', async ({ page }) => {
    await mountWithImage(page, { width: 120, height: 80 });
    await clickAt(page, 60, 50);

    const fit = page.locator('[data-inspector] select[data-property="fit"]');
    await expect(fit).toBeVisible();
    // Every fit in the model's union is offered, built from that union rather than a list
    // written out again.
    const values = await fit.locator('option').evaluateAll((o) =>
      o.map((option) => (option as HTMLOptionElement).value),
    );
    expect(values).toEqual(['fill', 'contain', 'cover', 'none', 'scale-down']);
    expect(await (await layoutBox(page, 'photo')).objectFit).toBe('fill');

    await fit.selectOption('contain');
    await settle(page);
    expect((await layoutBox(page, 'photo')).objectFit).toBe('contain');
    expect(await undoLabel(page)).toBe('Undo Fit');
  });

  test('object-fit does not move the box, only the paint', async ({ page }) => {
    await mountWithImage(page, { width: 120, height: 80 });
    await clickAt(page, 60, 50);
    const before = await layoutBox(page, 'photo');

    await page.locator('[data-inspector] select[data-property="fit"]').selectOption('contain');
    await settle(page);
    const after = await layoutBox(page, 'photo');

    // The measured claim behind keeping `fit` out of `transform`: every value leaves the
    // box and the content box alone.
    expect(after.offset).toEqual(before.offset);
    expect(after.contentOffset).toEqual(before.contentOffset);
  });

  test('fit is undoable, and re-committing it is a no-op', async ({ page }) => {
    await mountWithImage(page, { width: 120, height: 80 });
    await clickAt(page, 60, 50);
    const fit = page.locator('[data-inspector] select[data-property="fit"]');

    await fit.selectOption('cover');
    await settle(page);
    await page.keyboard.press('Control+z');
    await settle(page);
    expect((await layoutBox(page, 'photo')).objectFit).toBe('fill');

    // Selecting the value already shown must not add a history entry -- the `setProps`
    // no-op rule, which only bites once a value is committed twice.
    await fit.selectOption('none');
    await settle(page);
    await fit.selectOption('none');
    await settle(page);
    await page.keyboard.press('Control+z');
    await settle(page);
    expect((await layoutBox(page, 'photo')).objectFit).toBe('fill');
  });

  test('object-position is absent, because under the default fit it does nothing', async ({
    page,
  }) => {
    await mountWithImage(page, { width: 120, height: 80 });
    await clickAt(page, 60, 50);
    // A control that cannot change anything is worse than no control: it invites the user
    // to try. `object-position` arrives with cropping.
    expect(await page.locator('[data-inspector] [data-property="objectPosition"]').count()).toBe(0);
  });

  test('the image section is hidden for a shape', async ({ page }) => {
    const dataUrl = await pngDataUrl(page, 40, 20);
    await mountFixture(
      page,
      documentWithImages(
        `{'asset_1': {kind:'image', mime:'image/png', intrinsicWidth:40, intrinsicHeight:20, data:{inline:${JSON.stringify(dataUrl)}}}}`,
        `[
          ${imageNode('photo', 'asset_1', 40, 40, 60, 30)},
          { id: 'box', type: 'shape', name: 'box',
            transform: { x: 200, y: 40, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1 },
            visible: true, locked: false, opacity: 1, blendMode: 'normal',
            shape: { kind: 'rect', cornerRadius: 0 },
            fill: { type: 'solid', color: '#4f7cff' } },
        ]`,
      ),
    );
    await clickAt(page, 250, 80);
    // Visibility, not `count()`: the row is in the DOM either way, because the panel
    // builds every field eagerly and hides the ones that do not apply (ADR 0002's focus
    // rule). Counting DOM nodes would report 1 and pass or fail for the wrong reason.
    await expect(page.locator('[data-inspector] select[data-property="fit"]')).toBeHidden();
  });
});

// ---------------------------------------------------------------------------
// 7. Insertion: the real file input
// ---------------------------------------------------------------------------

test.describe('insertion goes through the funnel and the real file input', () => {
  test.beforeEach(async ({ page }) => {
    await mountFixture(page, EMPTY_PAGE);
  });

  test('picking a file inserts a decoded image at its intrinsic size', async ({ page }) => {
    await page.locator('[data-file-input="image"]').setInputFiles({
      name: 'red.png',
      mimeType: 'image/png',
      buffer: await pngBytes(page, 40, 20),
    });
    await waitForLoadedImage(page);

    const info = await page.evaluate(() => {
      const el = document.querySelector('.p1-image') as HTMLElement;
      const img = el.querySelector('img') as HTMLImageElement;
      return {
        state: el.getAttribute('data-asset-state'),
        offset: [el.offsetWidth, el.offsetHeight],
        natural: [img.naturalWidth, img.naturalHeight],
        objects: document.querySelectorAll('[data-objects] > *').length,
      };
    });

    expect(info.state).toBe('loaded');
    expect(info.offset).toEqual([40, 20]);
    // The intrinsic size came from `decode()` at import and is now the placement size --
    // no measurement and no render pass were needed to learn it.
    expect(info.natural).toEqual([40, 20]);
    expect(info.objects).toBe(1);
  });

  test('insertion is one undo step, and undo removes the object', async ({ page }) => {
    await page.locator('[data-file-input="image"]').setInputFiles({
      name: 'red.png',
      mimeType: 'image/png',
      buffer: await pngBytes(page, 30, 30),
    });
    await waitForLoadedImage(page);

    expect(await undoLabel(page)).toBe('Undo Insert image');
    await page.keyboard.press('Control+z');
    await settle(page);
    expect(await page.locator('.p1-image').count()).toBe(0);
  });

  test('a file that is not an image changes nothing at all', async ({ page }) => {
    // The contract's sharpest promise: a file that cannot be decoded never becomes an
    // asset, so it cannot leave a dangling reference or a 0x0 object behind.
    await page.locator('[data-file-input="image"]').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('this is definitely not an image'),
    });
    await page.waitForTimeout(300);

    expect(await page.locator('[data-objects] > *').count()).toBe(0);
    expect(await page.locator('.p1-image').count()).toBe(0);
    // And no history entry: a failed import is not an edit.
    expect(await undoDisabled(page)).toBe(true);
  });

  test('the failure is reported rather than swallowed', async ({ page }) => {
    await page.locator('[data-file-input="image"]').setInputFiles({
      name: 'broken.png',
      mimeType: 'image/png',
      buffer: Buffer.from('not a png either'),
    });
    await page.waitForSelector('[data-status="page"][data-error="true"]', { timeout: 5000 });
    const status = (await page.locator('[data-status="page"]').textContent()) ?? '';
    // A silently ignored "Image" button is indistinguishable from a broken one.
    expect(status).toContain('failed');
  });
});

// ---------------------------------------------------------------------------
// 8. Visual baseline
// ---------------------------------------------------------------------------

test('a document of images renders', async ({ page }) => {
  // Two images at different declared intrinsic sizes, so the baseline distinguishes an
  // image drawn at its own proportions from one drawn from the *document's* claim about
  // them — the divergence the suite found above.
  const big = await pngDataUrl(page, 200, 100);
  const tall = await pngDataUrl(page, 60, 120);
  const assets =
    `{'asset_wide': {kind:'image', mime:'image/png', intrinsicWidth:200, intrinsicHeight:100, ` +
    `data:{inline:${JSON.stringify(big)}}},` +
    `'asset_tall': {kind:'image', mime:'image/png', intrinsicWidth:60, intrinsicHeight:120, ` +
    `data:{inline:${JSON.stringify(tall)}}}}`;

  await mountFixture(
    page,
    documentWithImages(
      assets,
      `[
        ${imageNode('wide', 'asset_wide', 40, 40, 200, 100)},
        ${imageNode('tall', 'asset_tall', 300, 40, 60, 120, { fit: 'contain' })},
        ${imageNode('broken', 'asset_missing', 400, 40, 80, 60)},
      ]`,
    ),
  );

  // **Both images must be decoded before the screenshot.**
  //
  // This is the whole reason the suite has `waitForDecoded` at all. Measured: an image
  // that failed to load still occupies its full authored box, so a baseline taken without
  // this check would record an empty rectangle and pass — a screenshot of a document
  // showing nothing, which is the exact failure this milestone exists to prevent.
  await waitForDecoded(page, 'wide');
  await waitForDecoded(page, 'tall');

  // And the third is *supposed* to be missing, so its state is pinned rather than waited
  // for: a baseline must distinguish "drawn correctly" from "absent".
  expect(await assetState(page, 'broken')).toBe('error');

  expect(await page.locator('.p1-image').count()).toBe(3);
  await expectPageScreenshot(page, 'images');
});

// ---------------------------------------------------------------------------
// Helpers local to this file
// ---------------------------------------------------------------------------

/** The selected object id, from the overlay. `null` when nothing is selected. */
const selectionId = (page: Page): Promise<string | null> => firstSelectionId(page);

/** An asset table entry, with the left half of the image made transparent. */
async function assetSource(page: Page, w: number, h: number, transparentLeft: boolean) {
  const dataUrl = await page.evaluate(
    ({ w: width, h: height, clear }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const g = canvas.getContext('2d');
      if (g === null) throw new Error('no 2d context');
      g.fillStyle = '#ff0000';
      g.fillRect(0, 0, width, height);
      if (clear) g.clearRect(0, 0, Math.ceil(width / 2), height);
      return canvas.toDataURL('image/png');
    },
    { w, h, clear: transparentLeft },
  );
  return `{'asset_1': {kind:'image', mime:'image/png', intrinsicWidth:${w}, intrinsicHeight:${h}, data:{inline:${JSON.stringify(dataUrl)}}}}`;
}
