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

import type { AssetData, AssetId, AssetRecord, Document, ImageFit } from './types';
import { createId } from '../core/ids';
import { placementsInDocument } from './tree';

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
/**
 * Every asset id an image node still points at, **at any depth**.
 *
 * ## Why this is the traversal `tree.ts` already owns
 *
 * "Which assets are referenced" is the same question as "which nodes exist", asked with a filter. And
 * `tree.ts` exports four look-alike lookups with *different* reachability: `placementOf` finds leaves
 * only, `nodeById` finds everything, `locateNode` finds everything and reports the owner, and
 * `pageIdOf` is built on the leaf-only `placementOnPage` and so answers `null` for a group.
 *
 * That disagreement has already cost once. M13 shipped a selected group that drew **no outline**, with
 * no error anywhere, because a consumer reached for `pageIdOf` and concluded the group was not on the
 * page. So this function uses `placementsInDocument` — the same list rendering and hit testing walk —
 * rather than adding a fourth answer to the question.
 *
 * The cost is a matrix per leaf, which is irrelevant for an explicit user action. The benefit is the
 * guarantee that actually matters: **GC sees exactly the objects the editor can see**, so an image
 * inside a hidden group, a locked group, or a group nested in a group is still found.
 *
 * ## What "referenced" does *not* mean
 *
 * Not painted, not unlocked, not selected: none of those. A hidden image still needs its bytes to be
 * restored the moment it is unhidden, and treating "invisible" as "unreferenced" would delete them and
 * leave the un-hide a broken promise. Visibility is a paint state (ADR 0012), not ownership.
 *
 * A `Set`, because one asset may back several images and must survive until the last one goes.
 */
export function referencedAssetIds(doc: Document): Set<AssetId> {
  const out = new Set<AssetId>();
  for (const placement of placementsInDocument(doc)) {
    if (placement.node.type === 'image') out.add(placement.node.asset);
  }
  return out;
}

/**
 * The asset ids present in the table that nothing references.
 *
 * Pure and side-effect free, so "what would be collected" is answerable without mutating the document
 * — which is what lets the editor confirm the action rather than performing it silently.
 *
 * Returned in **sorted** order because a collection order is user-visible (it is the order records
 * disappear from the table, and the order of any diagnostic naming them), and `Object.keys` order is
 * insertion order rather than anything meaningful. Note this is a genuine sort of a *set of ids*, not of
 * a document array: paint order lives in `Page.objects` and ADR 0007 forbids sorting arrays.
 */
export function orphanAssetIds(doc: Document): AssetId[] {
  const referenced = referencedAssetIds(doc);
  return Object.keys(doc.assets)
    .filter((id) => !referenced.has(id))
    .sort();
}

/**
 * A copy of `doc.assets` with every unreferenced record removed, or `null` when there is nothing to do.
 *
 * Returns `null` rather than the same table so the caller can propagate reference identity without
 * knowing what "nothing to do" looks like — the M11 rule, applied to a table instead of an array.
 * Note it returns the **table**, not the document: deciding what a command does is the command's job.
 */
export function prunedAssetTable(doc: Document): Record<AssetId, AssetRecord> | null {
  const orphans = orphanAssetIds(doc);
  if (orphans.length === 0) return null;
  const out: Record<AssetId, AssetRecord> = {};
  for (const id of Object.keys(doc.assets)) {
    if (orphans.includes(id)) continue;
    out[id] = doc.assets[id] as AssetRecord;
  }
  return out;
}

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
