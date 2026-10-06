/**
 * `RichText` ⇄ HTML conversion.
 *
 * This module is the trust boundary between the document and the browser. Everything
 * the browser can produce must survive `domToRichText`, and `richTextToHtml` must
 * produce the HTML the browser itself would produce for the same content, so the
 * round trip is exact rather than merely invertible.
 *
 * ```
 *   RichText.blocks[i]  ⇄  <p>            one per paragraph
 *   block.align         ⇄  style="text-align:…"
 *   InlineRun           ⇄  <b>/<i>/<u>/<strike> wrappers around a text node
 *   '\n' inside run.text ⇄  a literal newline, rendered by white-space: pre-wrap
 * ```
 *
 * ## The three asymmetries, all deliberate
 *
 * 1. **No `<br>` on the way out.** `white-space: pre-wrap` renders a literal `\n` as
 *    a line break, so `<br>` is redundant in the render direction. The browser *does*
 *    write `<br>` (Shift+Enter, emptied paragraphs), and the walker turns it into `\n`
 *    on the way in. One direction is many-to-one, so there is no `<br>`-doubling class
 *    of bug.
 * 2. **Unknown block kinds throw.** Silently skipping one would render an empty frame,
 *    which is far worse than refusing.
 * 3. **Formatting the model does not carry is discarded, deliberately and tested.**
 *    Inline colour and size reach the DOM as `<font color>` and `<span style>`, and
 *    are dropped. Making that explicit is what keeps adding them a one-line change.
 */

import type { CharFormat, InlineRun, ParagraphAlign, RichText, TextBlock } from '../model/types';
import { formatsEqual, hasFormat, normalizeRichText } from '../model/rich-text';

/**
 * Canonical nesting order for run wrappers.
 *
 * Bold outermost, then italic, underline, strike. The browser emits these in a
 * consistent order and we force the same one, so a given model value has exactly one
 * HTML form — the model-side half of the "one representation" rule in ADR 0003.
 */
const WRAPPERS: ReadonlyArray<{ flag: keyof CharFormat; tag: string }> = [
  { flag: 'bold', tag: 'b' },
  { flag: 'italic', tag: 'i' },
  { flag: 'underline', tag: 'u' },
  { flag: 'strike', tag: 's' },
];

/** Tags that carry no model meaning and are dropped wholesale. */
const IGNORED_TAGS = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'HEAD', 'NOSCRIPT']);

/** Elements that end the current paragraph and start a new one. */
const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'LI',
  'UL',
  'OL',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'PRE',
  'BLOCKQUOTE',
  'SECTION',
  'ARTICLE',
  'HEADER',
  'FOOTER',
  'FIGURE',
  'TABLE',
  'TR',
  'DD',
  'DT',
]);

// ---------------------------------------------------------------------------
// Model → HTML
// ---------------------------------------------------------------------------

export function richTextToHtml(rich: RichText): DocumentFragment {
  const fragment = document.createDocumentFragment();

  for (const block of rich.blocks) {
    if (block.kind !== 'paragraph') {
      throw new Error(
        `Cannot render block kind "${(block as { kind: string }).kind}". ` +
          `Only "paragraph" is implemented; refusing rather than rendering an empty frame.`,
      );
    }

    const paragraph = document.createElement('p');
    if (block.align !== undefined) paragraph.style.textAlign = block.align;

    for (const r of block.runs) {
      paragraph.append(runToNode(r));
    }
    fragment.append(paragraph);
  }

  return fragment;
}

/** One run: its text node, wrapped once per set flag, in canonical order. */
function runToNode(r: InlineRun): Node {
  // A literal `\n`, not `<br>`: `white-space: pre-wrap` renders it. See the header.
  const text = document.createTextNode(r.text);

  if (!hasFormat(r.format)) return text;

  // Innermost first, so the *first* flag in `WRAPPERS` ends up outermost. Iterating
  // forwards produced `<s><i><b>` — inverted, and a second HTML form for the same
  // model value, which is exactly what the canonical order exists to prevent.
  let node: Node = text;
  for (let index = WRAPPERS.length - 1; index >= 0; index -= 1) {
    const wrapper = WRAPPERS[index];
    if (wrapper === undefined || r.format?.[wrapper.flag] !== true) continue;
    const element = document.createElement(wrapper.tag);
    element.append(node);
    node = element;
  }
  return node;
}

// ---------------------------------------------------------------------------
// HTML → model
// ---------------------------------------------------------------------------

/** Folds CRLF/CR to LF and U+00A0 to a normal space. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\u00A0/g, ' ');
}

/**
 * Reduces edited DOM to `RichText`, preserving character formatting.
 *
 * A **stack-based walk**, replacing the flat string extraction the spike used. The
 * old version produced one string and had nowhere to record a format; this one
 * carries a format stack down the tree and accumulates runs.
 *
 * Structure it produces:
 *  - a block element ends the current paragraph and starts a new one;
 *  - `<br>` and literal `\n` both become `\n` in run text (a soft break);
 *  - whitespace is preserved exactly — a trailing space the user typed is content,
 *    and `white-space: pre-wrap` renders it;
 *  - adjacent equal-format runs are merged, giving canonical form.
 */
export function domToRichText(root: Node): RichText {
  const blocks: TextBlock[] = [];
  let runs: InlineRun[] = [];
  let align: ParagraphAlign | undefined;

  /**
   * Ends the current paragraph.
   *
   * `force` distinguishes the two cases an empty run list can mean. Leaving a block
   * element forces, because `<p></p>` *is* a paragraph — the one the browser leaves
   * behind when a line is emptied — and dropping it would make consecutive blank
   * lines vanish. Entering one does not, because the text before it may be nothing
   * at all.
   */
  const flush = (force = false): void => {
    if (!force && runs.length === 0) {
      align = undefined;
      return;
    }
    blocks.push({
      kind: 'paragraph',
      ...(align === undefined ? {} : { align }),
      runs: runs.length === 0 ? [{ text: '' }] : runs,
    });
    runs = [];
    align = undefined;
  };

  const appendText = (value: string, format: CharFormat): void => {
    const text = normalizeNewlines(value);
    if (text.length === 0) return;

    const previous = runs[runs.length - 1];
    if (previous !== undefined && formatsEqual(previous.format, format)) {
      runs[runs.length - 1] = { text: previous.text + text, ...(hasFormat(format) ? { format: { ...format } } : {}) };
      return;
    }
    runs.push({ text, ...(hasFormat(format) ? { format: { ...format } } : {}) });
  };

  const visit = (node: Node, format: CharFormat): void => {
    if (node.nodeType === 3) {
      appendText(node.nodeValue ?? '', format);
      return;
    }
    if (node.nodeType !== 1) return;

    const element = node as Element;
    const tag = element.nodeName;
    if (IGNORED_TAGS.has(tag)) return;

    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock) flush();

    if (tag === 'BR') {
      appendText('\n', format);
      return;
    }

    const next = applyTag(element, format);
    // `text-align` is read from the block itself. Descendants inherit it in CSS, so
    // reading it from an inner wrapper would be guessing.
    if (isBlock) align = readAlign(element) ?? align;

    // A block that contains other blocks is a *container*, not a paragraph. `<div>`
    // wrapping two `<p>`s contributes no text of its own, and flushing it would emit a
    // phantom empty paragraph before and after — which is how one real paragraph
    // became three.
    let container = false;
    const children = Array.from(element.childNodes);
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (child === undefined) continue;
      if (isBlock && child.nodeType === 1 && BLOCK_TAGS.has(child.nodeName)) container = true;
      // Chromium keeps a trailing `<br>` so the caret's line stays visible, and leaves
      // `<p><br></p>` behind when a line is emptied. Those are layout placeholders, not
      // content: reading one as a soft break turned an emptied frame into a paragraph
      // containing `"\n"`, which then re-projected as a permanent blank line.
      //
      // Only a *trailing* `<br>` is a placeholder. `<p>a<br>b</p>` is a real soft break
      // and must survive, so the position in the block is what decides — not the tag.
      if (isBlock && index === children.length - 1 && child.nodeName === 'BR') continue;
      visit(child, next);
    }

    if (!isBlock) return;
    if (container) {
      runs = [];
      align = undefined;
    } else {
      flush(true);
    }
  };

  const format: CharFormat = {};
  for (const child of Array.from(root.childNodes)) visit(child, format);
  flush();

  return normalizeRichText({ blocks });
}

/** Extends the active format for one element. */
function applyTag(element: Element, inherited: CharFormat): CharFormat {
  const tag = element.nodeName;
  let next: CharFormat | undefined;

  const extend = (): CharFormat => (next ?? { ...inherited });

  switch (tag) {
    case 'B':
    case 'STRONG':
      next = { ...extend(), bold: true };
      break;
    case 'I':
    case 'EM':
    case 'CITE':
    case 'DFN':
    case 'VAR':
      next = { ...extend(), italic: true };
      break;
    case 'U':
    case 'INS':
      next = { ...extend(), underline: true };
      break;
    case 'S':
    case 'STRIKE':
    case 'DEL':
      next = { ...extend(), strike: true };
      break;
    case 'FONT': {
      const weight = element.getAttribute('weight')?.toLowerCase();
      if (weight !== null && weight !== undefined && weight !== 'normal') {
        next = { ...extend(), bold: true };
      }
      const face = element.getAttribute('style')?.toLowerCase() ?? '';
      if (face.includes('italic') || face.includes('oblique')) {
        next = { ...extend(), italic: true };
      }
      // `face` and `color` are deliberately dropped: font family and colour are
      // frame-level for M3 (ADR 0003). Recorded so extending them is one line.
      break;
    }
    case 'SPAN':
    case 'P':
    case 'DIV': {
      const style = element.getAttribute('style');
      if (style !== null && style !== undefined) next = applyInlineStyle(style, extend());
      break;
    }
    default:
      break;
  }

  return next !== undefined && hasFormat(next) ? next : inherited;
}

/**
 * Reads the four supported flags out of an inline `style` attribute.
 *
 * `styleWithCSS=false` means Chromium emits tags rather than styles, so this path
 * is mostly for pasted HTML. It is nonetheless load-bearing: pasted content is the
 * most common way `<span style="font-weight:700">` arrives.
 */
function applyInlineStyle(style: string, base: CharFormat): CharFormat {
  const lowered = style.toLowerCase();
  const weight = /(?:^|;)\s*font-weight\s*:\s*([^;]+)/.exec(lowered)?.[1]?.trim() ?? '';
  const face = /(?:^|;)\s*font-style\s*:\s*([^;]+)/.exec(lowered)?.[1]?.trim() ?? '';
  const decoration = /(?:^|;)\s*text-decoration(?:-line)?\s*:\s*([^;]+)/.exec(lowered)?.[1] ?? '';

  const format: CharFormat = { ...base };

  if (weight === 'bold' || weight === 'bolder' || /^[6-9]00$/.test(weight)) format.bold = true;
  if (face === 'italic' || face === 'oblique') format.italic = true;
  if (decoration.includes('underline')) format.underline = true;
  if (decoration.includes('line-through')) format.strike = true;

  return format;
}

/**
 * Reads `text-align` from a block element's inline style.
 *
 * Parsed from the attribute rather than read from `element.style`: a computed
 * `CSSStyleDeclaration` depends on the environment having applied the stylesheet,
 * and happy-dom does not populate one from `innerHTML`. Parsing the attribute is
 * both environment-independent and closer to what the browser actually wrote.
 */
function readAlign(element: Element): ParagraphAlign | undefined {
  const style = element.getAttribute('style');
  if (style === null) return undefined;

  const value = /(?:^|;)\s*text-align\s*:\s*([^;]+)/i.exec(style)?.[1]?.trim().toLowerCase();
  if (value === 'center' || value === 'right' || value === 'justify') return value;
  if (value === 'left' || value === 'start') return 'left';
  return undefined;
}

/** The frame's current DOM text, for diagnostics and tests. Not a model projection. */
export function domTextContent(root: Node): string {
  return normalizeRichLines(root);
}

function normalizeRichLines(root: Node): string {
  const parts: string[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      parts.push(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = (node as Element).nodeName;
    if (IGNORED_TAGS.has(tag)) return;
    if (tag === 'BR') {
      parts.push('\n');
      return;
    }
    if (BLOCK_TAGS.has(tag)) parts.push('\n');
    for (const child of Array.from(node.childNodes)) visit(child);
    if (BLOCK_TAGS.has(tag)) parts.push('\n');
  };
  for (const child of Array.from(root.childNodes)) visit(child);

  return parts
    .join('')
    .replace(/\n{2,}/g, '\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}
