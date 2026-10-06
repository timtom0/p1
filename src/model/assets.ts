/**
 * Asset rules: creating, validating and reading asset records (ADR 0006).
 *
 * Pure model-side logic with no DOM and no `Blob` handling, so it can be unit-tested
 * exhaustively. The browser-facing half -- decoding bytes into intrinsic dimensions --
 * lives in `render/assets.ts`, because that is the only place allowed to touch the DOM.
 *
 * The two halves are separated by one question: *what does the document know about an
 * asset?* This module answers it from data. `render/assets.ts` answers *what did the
 * browser make of the bytes?*, and feeds the answer in.
 */

import type { AssetData, AssetId, AssetRecord, ImageFit } from './types';
import { createId } from '../core/ids';

/**
 * Whether an asset has resolved, **in this browser session**.
 *
 * Rendering output, never document state -- see ADR 0006 §5. The model records a
 * reference; "currently resolves" is not a property of a document.
 *
 * It is a union rather than a boolean pair because "not attempted yet" and "attempted and
 * failed" are different states, and a placeholder that cannot say which is lying.
 *
 * - `idle` — no `src` yet; resolution has not been attempted.
 * - `loading` — `src` set, the browser has not finished.
 * - `loaded` — decoded. The only state in which pixels are guaranteed.
 * - `error` — the browser finished and there is nothing: a missing `src`, an unreachable
 *   URL, non-image data, or an unimplemented representation.
 *
 * The last row is the reason `complete` cannot be the success test. It is `true` for every
 * failure.
 */
export type AssetState = 'idle' | 'loading' | 'loaded' | 'error';

/** Every state, so a UI can label them all without a second list. */
export const ASSET_STATES: readonly AssetState[] = ['idle', 'loading', 'loaded', 'error'];

/**
 * Every ImageFit value, derived from the union so it cannot drift from the model.
 *
 * Exported rather than written out in the inspector: a fit the UI cannot offer
 * is a fit no user can choose, and a hard-coded list is exactly how that happens.
 */
export const IMAGE_FITS = ['fill', 'contain', 'cover', 'none', 'scale-down'] as const satisfies readonly ImageFit[];

/** What each fit means, for a reader rather than a user typing CSS. */
export const IMAGE_FIT_LABELS: Readonly<Record<ImageFit, string>> = {
  fill: 'Fill',
  contain: 'Fit',
  cover: 'Fill page',
  none: 'None',
  'scale-down': 'Fit or smaller',
};

/** What an asset state means to a reader. Used by the inspector. */
export const ASSET_STATE_LABELS: Readonly<Record<AssetState, string>> = {
  idle: 'not loaded',
  loading: 'loading…',
  loaded: 'loaded',
  error: 'missing',
};

/** What importing bytes produced, before it is trusted. */
export interface DecodedAsset {
  readonly mime: string;
  readonly intrinsicWidth: number;
  readonly intrinsicHeight: number;
  /** The bytes, in the form the document will carry. */
  readonly data: AssetData;
}

/**
 * Builds an asset record from a successful decode.
 *
 * **Refuses a zero or non-positive intrinsic size**, which is the point of the function.
 *
 * Measured: `await img.decode()` *rejects* with an `EncodingError` on data that is not a
 * decodable image, so a caller that reached this function with `0x0` has a bug. Letting it
 * through would produce an asset that looks valid and cannot paint -- exactly the state
 * ADR 0006 forbids, reached by a different route.
 *
 * The id is *not* a parameter and the record does not carry one: an asset's identity is
 * its key in `Document.assets`, so storing it inside the value as well would be two
 * sources of truth for one name, free to disagree.
 */
export function createAsset(decoded: DecodedAsset): AssetRecord {
  assertPositiveSize(decoded.intrinsicWidth, decoded.intrinsicHeight);
  return {
    kind: 'image',
    mime: decoded.mime,
    intrinsicWidth: decoded.intrinsicWidth,
    intrinsicHeight: decoded.intrinsicHeight,
    data: decoded.data,
  };
}

/** A fresh asset id. Separate from `createAsset` so a caller can pre-allocate one. */
export function newAssetId(): AssetId {
  return createId('asset');
}

/**
 * A fresh asset id, and the record that goes with it.
 *
 * The two are produced together on purpose: an id with no record is a dangling reference,
 * and a record with no id is unreachable. Anything that wants them separately can still
 * call `newAssetId()` then `createAsset`.
 */
export function createAssetFrom(decoded: DecodedAsset): { id: AssetId; asset: AssetRecord } {
  const id = newAssetId();
  return { id, asset: createAsset(decoded) };
}

function assertPositiveSize(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error(`asset intrinsic size must be finite (got ${width}x${height})`);
  }
  if (width <= 0 || height <= 0) {
    throw new Error(
      `asset intrinsic size must be positive (got ${width}x${height}). ` +
        `A zero-sized asset is unreachable: it paints nothing and cannot be selected, so ` +
        `it must be refused at import rather than stored. See ADR 0006.`,
    );
  }
}

/** The asset's aspect ratio, or `1` for a degenerate record. */
export function assetAspect(asset: AssetRecord): number {
  return asset.intrinsicHeight === 0 ? 1 : asset.intrinsicWidth / asset.intrinsicHeight;
}

/**
 * A lookup that cannot return `undefined` for an id the document owns.
 *
 * Returns `null` rather than throwing, because a *missing* asset is a designed state
 * (ADR 0006 §5) and the renderer must be able to render that state. Throwing here would
 * make an unresolvable reference a crash instead of a visible placeholder.
 */
export function findAsset(
  assets: Readonly<Record<AssetId, AssetRecord>>,
  id: AssetId,
): AssetRecord | null {
  // `hasOwn` rather than `assets[id] ?? null`, and the difference is not theoretical:
  // `assets['toString']` resolves to `Object.prototype.toString`, so a truthiness check
  // reports a missing asset as *present* and hands the renderer a function where it
  // expects a record. Ids are generated as `asset_1` so it cannot happen from our own
  // factory — but a deserialized document can carry any key at all, which is exactly
  // where a lookup has to be defensive.
  return Object.hasOwn(assets, id) ? assets[id] ?? null : null;
}

/** Whether the document can resolve this reference at all. */
export function hasAsset(
  assets: Readonly<Record<AssetId, AssetRecord>>,
  id: AssetId,
): boolean {
  return Object.hasOwn(assets, id);
}

/**
 * Problems with an asset record, as human-readable strings.
 *
 * A list rather than a throw, matching `validateDocument`: a document can arrive from a
 * file with several broken assets, and reporting all of them at once beats one failure per
 * attempt.
 */
export function assetProblems(asset: AssetRecord, id: AssetId): string[] {
  const problems: string[] = [];

  if (asset.kind !== 'image') {
    problems.push(`asset "${id}" has unknown kind "${String(asset.kind)}"`);
  }
  if (!(asset.intrinsicWidth > 0) || !(asset.intrinsicHeight > 0)) {
    problems.push(
      `asset "${id}" has a non-positive intrinsic size ` +
        `(${asset.intrinsicWidth}x${asset.intrinsicHeight}); it cannot render`,
    );
  }
  if (asset.mime.length === 0) {
    problems.push(`asset "${id}" has no mime type`);
  }
  if (!('inline' in asset.data) && !('external' in asset.data)) {
    // Union-exhaustive in the type system, but a deserialized document is not.
    problems.push(`asset "${id}" has no recognised data representation`);
  }

  return problems;
}

/**
 * The data URL for an asset, if it carries its own bytes.
 *
 * The only place a URL is produced from the model, and it is a **data** URL -- a stable
 * function of the bytes, not a session handle. Object URLs are minted by
 * `render/assets.ts` and never appear here or in the document.
 */
export function inlineUrl(asset: AssetRecord): string | null {
  return 'inline' in asset.data ? asset.data.inline : null;
}
