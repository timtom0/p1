/**
 * The browser half of the asset contract: decoding bytes, and minting runtime URLs.
 *
 * `model/assets.ts` decides what a document *knows* about an asset. This module decides
 * what the browser *made of the bytes*, and hands the answer back. Keeping them apart is
 * what lets the model layer stay DOM-free while the decode -- which is unavoidably a DOM
 * API -- happens exactly once, at import.
 *
 * ## Why object URLs, at all
 *
 * A document could point every image at its inline data URL directly, and for small
 * documents that is simpler. The reason not to: the reconciler projects the document on
 * every change, and re-assigning `src` to a *different string* makes the browser drop and
 * re-fetch the image. A stable object URL per asset makes `src` a stable value, so an
 * unrelated edit elsewhere in the document cannot make every image on the page flicker.
 *
 * That is the entire justification. The URL is a cache key, nothing more:
 *
 * > A blob URL may be a runtime projection; it may never be an asset's identity.
 *
 * `revoke()` is called when an asset's bytes are replaced and when the resolver is
 * disposed, so the URLs do not outlive the session that made them.
 *
 * @module
 */

import type { AssetId, AssetRecord } from '../model/types';
import { inlineUrl } from '../model/assets';

/**
 * A resolver's view of one asset.
 *
 * A union rather than a boolean pair, because "not resolved yet" and "resolved to nothing"
 * are different states and the placeholder must say which. `pending` is what the renderer
 * paints while the first resolution is in flight.
 */
export type Resolution =
  | { readonly state: 'pending' }
  | { readonly state: 'ready'; readonly url: string }
  | { readonly state: 'failed'; readonly reason: string };

export interface AssetResolverHost {
  /** The document's asset table. Read on every resolve, so replacement is seen. */
  assets(): Readonly<Record<AssetId, AssetRecord>>;
}

/**
 * Resolves an asset id to something an `<img>` can load, or says why it cannot.
 *
 * ## An inline asset resolves to its own data URL — no object URL, on purpose
 *
 * The first version of this wrapped the asset's bytes in a `Blob` and handed out
 * `URL.createObjectURL`. That was wrong in a way the browser found immediately: a Blob
 * built from `[dataUrlString]` contains the *text* `data:image/png;base64,…`, which is not
 * an image, so every image failed to load. Decoding the base64 by hand would have fixed
 * that and added a decoder for no benefit.
 *
 * There is no benefit, because the thing the object URL was introduced for — a **stable
 * `src`** that does not change when an unrelated part of the document re-renders — is
 * already true of a data URL. A data URL is a pure function of the bytes, so the same
 * asset always yields the same string, and `src` is only rewritten when the bytes change.
 *
 * So inline assets pass straight through. The id-keyed cache below is kept because it is
 * where the *external* case will live: those will need a real object URL, minted once and
 * revoked on replacement, because a filesystem path is not a URL the browser can fetch.
 *
 * > A blob URL may be a runtime projection; it may never be an asset's identity. With this
 * > arrangement, inline assets never mint one at all.
 */
export class AssetResolver {
  /** Only populated by representations that need a minted URL. */
  private readonly minted = new Map<AssetId, string>();
  /** Ids whose bytes changed since they were last handed out. */
  private readonly stale = new Set<AssetId>();
  private readonly host: AssetResolverHost;

  constructor(host: AssetResolverHost) {
    this.host = host;
  }

  /**
   * A usable `src` for an asset, or why there is not one.
   *
   * Synchronous by design. Every implemented representation resolves without asynchronous
   * work, and making the renderer `await` would mean an image node's `src` is briefly empty
   * on every render — which is exactly the "looks like a valid box with nothing in it"
   * state the contract forbids.
   */
  resolve(id: AssetId): Resolution {
    const asset = this.host.assets()[id];
    if (asset === undefined) {
      return { state: 'failed', reason: `no asset "${id}" in this document` };
    }

    const inline = inlineUrl(asset);
    if (inline !== null) return { state: 'ready', url: inline };

    // `{ external }` is typed and modelled but deliberately not implemented. Refusing
    // with a named reason is what makes that visible instead of an empty box.
    return { state: 'failed', reason: `asset "${id}" is external, which is not implemented yet` };
  }

  /**
   * Marks an asset's bytes as replaced.
   *
   * The id is unchanged, so every node referencing it re-renders against the new bytes
   * without any node changing. That is what keeps "the document says X" from drifting away
   * from "the screen shows Y".
   *
   * A no-op for inline assets — a new data URL is a different string, so `src` changes by
   * itself. It matters for minted URLs, which would otherwise keep being handed out.
   */
  invalidate(id: AssetId): void {
    this.stale.add(id);
    this.release(id);
  }

  /** Releases a minted URL, if any. A no-op for inline assets. */
  release(id: AssetId): void {
    const url = this.minted.get(id);
    if (url === undefined) return;
    URL.revokeObjectURL(url);
    this.minted.delete(id);
  }

  /** Releases every minted URL. The resolver is unusable afterwards, by design. */
  dispose(): void {
    for (const url of this.minted.values()) URL.revokeObjectURL(url);
    this.minted.clear();
    this.stale.clear();
  }

  /** How many URLs this resolver minted. Zero for a document of inline assets. */
  get mintedCount(): number {
    return this.minted.size;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** A file offered by the user, reduced to what the model needs. */
export interface ImportedAsset {
  readonly mime: string;
  readonly intrinsicWidth: number;
  readonly intrinsicHeight: number;
  /** A data URL, which is what the document will carry. */
  readonly inline: string;
}

/**
 * Reads a picked file into an importable asset.
 *
 * **Rejects anything the browser cannot decode**, which is the contract's guarantee that a
 * failed image never becomes an asset with size `0×0`:
 *
 *  - `img.decode()` **rejects** with an `EncodingError` on data that is not a decodable
 *    image (measured), so this is a real check and not a guess.
 *  - A zero or non-positive intrinsic size is refused even if decode somehow succeeded.
 *
 * The image is decoded **detached** — never added to the document — so importing an asset
 * has no effect on layout and needs no render pass.
 */
export async function importImageFile(file: Blob, name: string): Promise<ImportedAsset> {
  const inline = await readAsDataUrl(file);

  const image = new Image();
  image.src = inline;
  try {
    await image.decode();
  } catch (error) {
    throw new Error(
      `"${name}" is not a decodable image (${describe(error)}). ` +
        `Nothing was added to the document.`,
    );
  }

  const { naturalWidth, naturalHeight } = image;
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) {
    throw new Error(
      `"${name}" decoded with no intrinsic size (${naturalWidth}x${naturalHeight}); ` +
        `nothing was added to the document.`,
    );
  }

  return {
    mime: file.type.length === 0 ? 'application/octet-stream' : file.type,
    intrinsicWidth: naturalWidth,
    intrinsicHeight: naturalHeight,
    inline,
  };
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('could not read the file'));
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('expected a data URL from the file reader'));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsDataURL(blob);
  });
}