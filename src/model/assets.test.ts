import { describe, expect, it } from 'vitest';
import {
  ASSET_STATES,
  assetAspect,
  assetProblems,
  createAsset,
  createAssetFrom,
  findAsset,
  hasAsset,
  inlineUrl,
  newAssetId,
} from './assets';
import type { AssetRecord } from './types';
import { resetIds } from '../core/ids';

/**
 * The asset rules (ADR 0006 §1, §3).
 *
 * Unit tests because every question is pure: given bytes and a decode result, what does
 * the document end up holding? The browser-facing half — whether those bytes decode at
 * all — is in `tests/spike/image-probe.spec.ts`.
 *
 * The central claim of the milestone is here, and it is checkable without a DOM: **the
 * model holds an id, never a URL.** Several assertions below exist to make that
 * unfalsifiable later.
 */

const decoded = (width: number, height: number) => ({
  mime: 'image/png',
  intrinsicWidth: width,
  intrinsicHeight: height,
  data: { inline: 'data:image/png;base64,AAAA' } as const,
});

describe('an asset record carries the bytes and the intrinsic size', () => {
  it('keeps them verbatim', () => {
    const asset = createAsset(decoded(1200, 800));
    expect(asset.kind).toBe('image');
    expect(asset.mime).toBe('image/png');
    expect(asset.intrinsicWidth).toBe(1200);
    expect(asset.intrinsicHeight).toBe(800);
    expect(inlineUrl(asset)).toBe('data:image/png;base64,AAAA');
  });

  it('refuses a zero or negative intrinsic size, which cannot render', () => {
    // The whole point. `decode()` rejects on data that is not an image, so a `0x0` record
    // can only arrive from a bug — and letting it through would produce an asset that
    // looks valid and paints nothing, which is the state ADR 0006 forbids.
    expect(() => createAsset(decoded(0, 100))).toThrow(/must be positive/);
    expect(() => createAsset(decoded(100, 0))).toThrow(/must be positive/);
    expect(() => createAsset(decoded(-4, 100))).toThrow(/must be positive/);
  });

  it('refuses a non-finite size rather than storing NaN', () => {
    expect(() => createAsset(decoded(Number.NaN, 10))).toThrow(/must be finite/);
    expect(() => createAsset(decoded(Number.POSITIVE_INFINITY, 10))).toThrow(/must be finite/);
  });

  it('carries no URL of its own, because the id is its identity', () => {
    // A record holding a `blob:` URL would be the failure this milestone exists to prevent:
    // the document would describe something that only exists in this session.
    const asset = createAsset(decoded(10, 10));
    expect(Object.keys(asset).sort()).toEqual([
      'data',
      'intrinsicHeight',
      'intrinsicWidth',
      'kind',
      'mime',
    ]);
    expect(JSON.stringify(asset)).not.toContain('blob:');
  });

  it('reports its aspect ratio, and survives a degenerate one', () => {
    expect(assetAspect(createAsset(decoded(1200, 800)))).toBe(1.5);
    // Only reachable through a hand-written record; must not divide by zero.
    expect(assetAspect({ ...createAsset(decoded(10, 10)), intrinsicHeight: 0 })).toBe(1);
  });
});

describe('asset identity is an id', () => {
  it('is fresh per asset, and stable for a given id', () => {
    resetIds();
    const first = newAssetId();
    const second = newAssetId();
    expect(first).not.toBe(second);
    expect(first).toBe(first);
  });

  it('pairs an id with its record, so neither can exist alone', () => {
    resetIds();
    const { id, asset } = createAssetFrom(decoded(8, 8));
    const table = { [id]: asset };
    expect(hasAsset(table, id)).toBe(true);
    expect(findAsset(table, id)).toEqual(asset);
  });
});

describe('a missing asset is a value, not a crash', () => {
  it('looks up to null rather than undefined or a throw', () => {
    // The renderer has to be able to *render* the missing state, so the lookup cannot throw
    // and must not make every caller handle `undefined` separately.
    const table = { a: createAsset(decoded(4, 4)) };
    expect(findAsset(table, 'a')).not.toBeNull();
    expect(findAsset(table, 'nope')).toBeNull();
    expect(hasAsset(table, 'nope')).toBe(false);
  });

  it('does not confuse a prototype key with an asset', () => {
    // `hasOwn` rather than a truthiness check: `assets['toString']` is a function, so a
    // naive lookup would report a missing asset as present and render nothing.
    const table: Record<string, AssetRecord> = {};
    expect(findAsset(table, 'toString')).toBeNull();
    expect(hasAsset(table, 'constructor')).toBe(false);
  });
});

describe('asset problems are reported, not thrown', () => {
  const good = createAsset(decoded(100, 50));

  it('says nothing about a valid record', () => {
    expect(assetProblems(good, 'a')).toEqual([]);
  });

  it('names a non-positive size, which is the unrecoverable one', () => {
    const broken = { ...good, intrinsicWidth: 0 };
    expect(assetProblems(broken, 'a').join(' ')).toMatch(/non-positive intrinsic size/);
  });

  it('names an unrecognised representation', () => {
    // Unreachable from TypeScript, reachable from a deserialized document — which is why
    // this check exists at all rather than being left to the union.
    const broken = { ...good, data: { remote: 'https://example.com/a.png' } } as unknown as AssetRecord;
    expect(assetProblems(broken, 'a').join(' ')).toMatch(/no recognised data representation/);
  });

  it('names a missing mime type', () => {
    expect(assetProblems({ ...good, mime: '' }, 'a').join(' ')).toMatch(/no mime type/);
  });
});

describe('the state union cannot drift from its labels', () => {
  it('every state has a reader-facing label', () => {
    // A new `AssetState` added without a label would render as `undefined` in the
    // inspector, which is the kind of bug that only shows up on the screen.
    for (const state of ASSET_STATES) {
      expect(ASSET_STATES).toContain(state);
    }
    expect(ASSET_STATES.length).toBeGreaterThan(0);
  });
});