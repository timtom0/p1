/**
 * A minimal element builder: `el('button', { type: 'button' }, 'Add')`.
 *
 * ## Why this is shared
 *
 * It started life local to `document-setup.ts`, and M23 needed the same thing in three more files.
 * Four copies of a DOM builder is four places for an attribute to be escaped differently, and the
 * copy in `document-setup.ts` documents a behaviour the others would silently lack: attributes go
 * through `setAttribute`, so a value containing spaces is fine but a value containing a quote is
 * not. That is a property of *the builder*, so it belongs to the builder rather than to whichever
 * panel happens to be using it.
 *
 * ## Children
 *
 * Variadic rather than a single `text` argument because most of these panels are small trees -- a
 * row that is a button containing two spans -- and an `el` that took one string would need an
 * `append` after every nested element. Strings become text nodes, so a child is either an
 * `HTMLElement` or a string and never a bare value that could be stringified by accident.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}