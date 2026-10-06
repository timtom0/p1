/**
 * Style writes that skip redundant assignments.
 *
 * Naïve per-frame style writes are the main cause of style thrash while
 * dragging. Each element carries a cache of the last value written per property,
 * so a gesture that re-renders the same unchanged values touches nothing.
 *
 * This is also what lets the reconciler treat `update()` as an idempotent
 * function of `(node, prev)` rather than a diffing algorithm in its own right.
 */

const caches = new WeakMap<HTMLElement, Map<string, string>>();

export function setStyle(el: HTMLElement, property: string, value: string): void {
  let cache = caches.get(el);
  if (cache === undefined) {
    cache = new Map();
    caches.set(el, cache);
  }
  if (cache.get(property) === value) return;
  cache.set(property, value);
  el.style.setProperty(property, value);
}

/** Forget an element's cache. Call before reusing an element for a different node. */
export function resetStyleCache(el: HTMLElement): void {
  caches.delete(el);
}