/**
 * Fixtures for the image suite (ADR 0006).
 *
 * Two rules, both learned the hard way:
 *
 *  - These are **injected source strings**, so a stray bracket is invisible until the app
 *    silently falls back to the sample document and every assertion reports a missing
 *    element. `image-fixtures.test.ts` parses them.
 *  - **The PNG data URLs are generated in the test, not written here.** Round 1 of the
 *    image probe used a hand-written base64 PNG that did not decode, so every case
 *    meant to exercise a *loaded* image was silently exercising the *failure* path — and
 *    the conclusion drawn from it (that Chromium is alpha-aware) was the opposite of the
 *    truth. A fixture that can be wrong about being an image is a fixture that will be.
 */

/** A document with no objects, for insertion tests. */
export const EMPTY_PAGE = `() => ({
  formatVersion: 1, id: 'empty', name: 'Empty',
  pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [],
  }],
})`;

/**
 * Builds an injected document containing images.
 *
 * A function rather than a constant, so a test can state exactly which asset state it
 * wants — a valid image, a reference to a missing id, an unimplemented external asset —
 * without hand-editing JSON. That matters because a fixture which cannot be *wrong* about
 * its assets cannot be trusted to contain a dangling reference.
 *
 * Both parameters are **source strings** rather than values: the asset table has to carry
 * a data URL generated at test time, and threading that through a second builder function
 * would buy nothing. `image-fixtures.test.ts` parses the result and checks that every node's
 * asset exists, so a typo here fails as a fixture error rather than as an empty box.
 */
export function documentWithImages(assets: string, objects: string): string {
  return `() => ({
  formatVersion: 1, id: 'images', name: 'Images',
  pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
  assets: ${assets},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: ${objects},
  }],
})`;
}

/**
 * An asset record as injected source, referencing a PNG produced at test time.
 *
 * `dataUrl` is spliced in by the caller, so no base64 ever lives in this file.
 */
export function assetRecord(
  id: string,
  dataUrl: string,
  width: number,
  height: number,
): string {
  return `${JSON.stringify(id)}: {
      kind: 'image', mime: 'image/png',
      intrinsicWidth: ${width}, intrinsicHeight: ${height},
      data: { inline: ${JSON.stringify(dataUrl)} },
    }`;
}

/**
 * An image node as injected source.
 *
 * `rotation` is a named parameter rather than something callers append to `extra`,
 * because an earlier version did the latter and produced `transform: undefined,` inside
 * an already-complete transform object — invalid injected source, which fails as "the app
 * did not boot" three steps from the cause.
 */
export function imageNode(
  id: string,
  assetId: string,
  x: number,
  y: number,
  width: number,
  height: number,
  options: { rotation?: number; fit?: string; visible?: boolean } = {},
): string {
  const parts = [
    `        id: ${JSON.stringify(id)}, type: 'image', name: ${JSON.stringify(id)},`,
    `        transform: { x: ${x}, y: ${y}, width: ${width}, height: ${height},`,
    `                     rotation: ${options.rotation ?? 0}, scaleX: 1, scaleY: 1 },`,
    `        visible: ${options.visible === false ? 'false' : 'true'}, locked: false,`,
    `        opacity: 1, blendMode: 'normal',`,
    `        asset: ${JSON.stringify(assetId)}`,
  ];
  if (options.fit !== undefined) parts.push(`        , fit: ${JSON.stringify(options.fit)}`);
  return `{ ${parts.join(' ')} }`;
}

/** Every fixture, so the syntax guard can check them all. */
export const ALL_FIXTURES: Record<string, string> = { EMPTY_PAGE };
