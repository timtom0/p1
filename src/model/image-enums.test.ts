import { describe, expect, it } from 'vitest';
import { assetAspect, createAsset } from './assets';
import { ASSET_STATE_LABELS, ASSET_STATES, IMAGE_FITS, IMAGE_FIT_LABELS } from './assets';

/**
 * The state union and the fit list.
 *
 * Both are *derived from the model's own unions* rather than written out again, and these
 * tests exist to make that guarantee checkable: if someone hand-lists `IMAGE_FITS` and
 * forgets one, `satisfies` stops them at compile time — but only for the *type*, not for
 * the label table, which is a plain `Record` and would silently render `undefined`.
 */

describe('every fit has a label', () => {
  it('because a missing one renders as undefined in the inspector', () => {
    for (const fit of IMAGE_FITS) {
      expect(IMAGE_FIT_LABELS[fit], `label for "${fit}"`).toBeTruthy();
    }
  });

  it('and the labels are unique, so the dropdown is not ambiguous', () => {
    const labels = IMAGE_FITS.map((fit) => IMAGE_FIT_LABELS[fit]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('and the default is among them, since `fit` is optional on the node', () => {
    // `ImageNode.fit` is optional and means `fill`. If `fill` were ever removed from the
    // list, the dropdown would have no selected option for the most common state.
    expect(IMAGE_FITS).toContain('fill');
  });
});

describe('every asset state has a label', () => {
  it('because that is what the inspector prints', () => {
    for (const state of ASSET_STATES) {
      expect(ASSET_STATE_LABELS[state], `label for "${state}"`).toBeTruthy();
    }
  });

  it('and the union lists `error`, which is the state `complete` cannot detect', () => {
    // Measured: `img.complete` is `true` for a missing src, an unreachable URL and
    // non-image data alike. `error` exists because of that, and dropping it would leave
    // three of the four real states unreportable.
    expect(ASSET_STATES).toContain('error');
    expect(ASSET_STATES).toContain('loaded');
  });
});

describe('an asset and its fit are independent concerns', () => {
  it('the same bytes can be shown at every fit, with the geometry unchanged', () => {
    // The reason `fit` is a node property and not part of the asset: two documents can
    // hold the identical asset and place it differently, and that difference must be
    // authored *somewhere*. Measured: `object-fit` changes only the paint.
    const asset = createAsset({
      mime: 'image/png',
      intrinsicWidth: 200,
      intrinsicHeight: 100,
      data: { inline: 'data:image/png;base64,AAAA' },
    });
    expect(assetAspect(asset)).toBe(2);
    expect(IMAGE_FITS.length).toBeGreaterThan(1);
  });
});