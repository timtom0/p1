/**
 * Short, readable, deterministic ids. Debuggability beats cryptographic
 * uniqueness here: a document is a local file, and `page_1` in a stack trace is
 * worth more than a UUID.
 */

const counters = new Map<string, number>();

export function createId(prefix: string): string {
  const next = (counters.get(prefix) ?? 0) + 1;
  counters.set(prefix, next);
  return `${prefix}_${next.toString(36)}`;
}

/**
 * Advances each prefix's counter past every id in `ids`.
 *
 * ## Why this exists
 *
 * Ids are minted from module-level counters that no document seeds, which is fine until a
 * document can be loaded. Then:
 *
 * ```
 * // a document whose last node is node_4, opened in a fresh tab
 * counters.get('node')  // undefined -> 0
 * createId('node')      // "node_1"  -- a duplicate
 * ```
 *
 * and a duplicate id is not cosmetic: `validateDocument` reports "duplicate or cyclic node
 * id", and `mapNodesById` resolves the collision to whichever node it visits first, so an
 * edit to the new object silently edits the old one.
 *
 * The load path therefore calls this with **every id in the document** — the document, its
 * pages, every node, and every asset.
 *
 * ## What this is not
 *
 * It is not deriving identity from an id. Identity still comes from the document; this only
 * stops the generator re-minting a name that is already in use. It parses only the numeric
 * suffix of ids this module produced, and **ignores anything it does not recognise** — an
 * id from some other producer is left alone rather than guessed at.
 *
 * Cost is one pass over the document's ids on load, which is negligible next to parsing it.
 */
export function reserveIds(ids: Iterable<string>): void {
  for (const id of ids) {
    const separator = id.lastIndexOf('_');
    if (separator <= 0 || separator === id.length - 1) continue;
    const prefix = id.slice(0, separator);
    const suffix = id.slice(separator + 1);
    // `toString(36)` output is lowercase alphanumerics; anything else was not ours.
    if (!/^[0-9a-z]+$/.test(suffix)) continue;
    const value = Number.parseInt(suffix, 36);
    if (!Number.isSafeInteger(value) || value < 1) continue;
    if (value > (counters.get(prefix) ?? 0)) counters.set(prefix, value);
  }
}

/** Test helper: makes ids deterministic across test files. */
export function resetIds(): void {
  counters.clear();
}