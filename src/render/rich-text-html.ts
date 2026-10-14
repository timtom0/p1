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

import type {
  CharFormat,
  InlineRun,
  ParagraphAlign,
  ParagraphDirection,
  ParagraphMetrics,
  RichText,
  TextBlock,
  StyleDefinition,
} from '../model/types';
import { styleParagraphProps } from '../model/styles';
import { STYLE_REF_ATTRIBUTE } from './style-sheet';
import {
  hasFormat,
  normalizeRichText,
  PARAGRAPH_METRIC_KEYS,
  runsCompatible,
} from '../model/rich-text';
import { setStyle } from './dom-style';
import { cssLength } from './num';

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
  // M22. `<sup>`/`<sub>` rather than a `vertical-align` span, for the reason the other four use
  // tags: the browser both produces and consumes these, so a superscript made by the user *inside*
  // a session and one restored from the model are the same DOM, and there is no second spelling.
  { flag: 'super', tag: 'sup' },
  { flag: 'sub', tag: 'sub' },
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

/**
 * @param styles The document's style table (M23). Optional and defaulted, because every existing
 * caller and test renders a fragment with no styles in play, and making it required would put a
 * ceremony in front of the common case for a document that has no styles. A caller that *does* have
 * styles must pass them: the reference attribute is only written when the id resolves, so omitting
 * them here would silently drop every reference rather than fail.
 */
export function richTextToHtml(
  rich: RichText,
  styles: readonly StyleDefinition[] = [],
): DocumentFragment {
  const fragment = document.createDocumentFragment();

  for (const block of rich.blocks) {
    if (block.kind !== 'paragraph') {
      throw new Error(
        `Cannot render block kind "${(block as { kind: string }).kind}". ` +
          `Only "paragraph" is implemented; refusing rather than rendering an empty frame.`,
      );
    }

    const paragraph = document.createElement('p');
    // `dir="auto"` per paragraph, rather than one direction for the document.
    //
    // Without it the base paragraph direction is whatever the document says, which is nothing --
    // so left-to-right. The Unicode bidirectional algorithm still orders *strong* characters
    // correctly either way, which is why an all-Arabic paragraph looks right: `typography-bidi`
    // measures that case and it passes. What it gets wrong is the **neutrals**, because a neutral
    // character resolves against the base direction. A full stop after Arabic is neutral, so with
    // an LTR base it lands to the *right* of the sentence it belongs to, and a line of Arabic
    // ending in a colon puts the colon on the wrong side of the page.
    //
    // Measured, not assumed: the test asserting the trailing full stop lands with the Arabic
    // failed at x=806 against a first character at x=796, and passes once this is set.
    //
    // `auto` is the browser's own first-strong heuristic -- the standard, non-custom answer.
    //
    // M22 makes it *authorable*: `block.dir` overrides it, and only `auto` stays a rendering-only
    // answer. Absent is `auto`, which is what every pre-M22 paragraph meant, so a document written
    // before this milestone renders here exactly as it always did. An explicit `auto` is written the
    // same way rather than omitted, so the attribute and the field cannot disagree.
    //
    // M23: omitted entirely when the direction is *inherited* from a paragraph style. The stylesheet
    // supplies `direction` as a real CSS declaration, and a `dir` attribute is only a presentational
    // hint for the same property -- so leaving it in place would make the paragraph's correctness
    // depend on which origin wins. Stating it in one place is worth more than the uniformity.
    const inheritsDirection =
      block.dir === undefined && styleParagraphProps(styles, block).dir !== undefined;
    if (!inheritsDirection) paragraph.setAttribute('dir', block.dir ?? 'auto');
    if (block.align !== undefined) paragraph.style.textAlign = block.align;

    // M22. Logical properties throughout, so the start edge follows this paragraph's own direction
    // and there is no `if (dir === 'rtl')` anywhere in the codebase to get wrong. Writing them
    // unconditionally, like `applyTypography` does, because a partial write would leave a previous
    // paragraph's indent behind on a paragraph the user has just re-aligned.
    //
    // M23: only the paragraph's **own** metrics. Anything the style supplies lives in the stylesheet
    // rule keyed by the attribute set below, because the walker reads exactly these five properties
    // out of the inline style -- so an inherited value written here would be read back as a direct
    // override on the next edit and detach the paragraph from its style for good.
    const metrics = block.metrics;
    setStyle(paragraph, 'text-indent', optionalLength(metrics?.textIndent));
    setStyle(paragraph, 'margin-inline-start', optionalLength(metrics?.marginStart));
    setStyle(paragraph, 'margin-inline-end', optionalLength(metrics?.marginEnd));
    setStyle(paragraph, 'margin-block-start', optionalLength(metrics?.marginBefore));
    setStyle(paragraph, 'margin-block-end', optionalLength(metrics?.marginAfter));

    // The reference itself, written whenever the model carries one -- **including** when it does
    // not resolve.
    //
    // An earlier version wrote the attribute only for a resolvable id, on the reasoning that a
    // dangling one had nothing to contribute. That quietly dropped it from the DOM: the walker read
    // nothing, and the next save wrote a document that had lost the reference. The model kept it and
    // the file did not, which is silent corruption, and M23 explicitly forbids it.
    //
    // An unresolvable id has no rule and so no effect here, which is the correct reading. It just
    // must not evaporate -- the reference has to survive the round trip so that a build which *does*
    // know the style can still resolve it.
    if (block.styleId !== undefined) {
      paragraph.setAttribute(STYLE_REF_ATTRIBUTE, block.styleId);
    }

    for (const r of block.runs) {
      paragraph.append(runToNode(r));
    }
    fragment.append(paragraph);
  }

  return fragment;
}

/**
 * A paragraph metric as an inline CSS length, or `''` to unset it.
 *
 * The `''` case is not a formatting convenience: `setStyle` calls `setProperty(name, '')`, which
 * *removes* the property. Writing nothing instead would leave the previous paragraph's indent on an
 * element the reconciler reused, which is the exact bug `applyTypography`'s "write every property
 * unconditionally" note is about.
 */
function optionalLength(value: number | undefined): string {
  return value === undefined ? '' : cssLength(value);
}

/** One run: its text node, wrapped once per set flag, in canonical order. */
function runToNode(r: InlineRun): Node {
  // A literal `\n`, not `<br>`: `white-space: pre-wrap` renders it. See the header.
  const text = document.createTextNode(r.text);

  // M23: the style reference becomes a `<span>` *carrying the attribute*, and the style's own
  // properties live in the stylesheet. Deliberately not `<b>`/`<i>` wrappers: those are how the
  // walker recognises a *direct* flag, so a style's flags written as wrappers would be read back as
  // direct overrides on the next edit and detach the run from its style permanently.
  // Written whenever the model carries a reference, resolvable or not -- for the same
  // reason as the paragraph case: dropping an unresolvable one loses it from the saved document.
  let node: Node = text;
  if (r.styleId !== undefined) {
    const span = document.createElement('span');
    span.setAttribute(STYLE_REF_ATTRIBUTE, r.styleId);
    span.append(node);
    node = span;
  }

  if (!hasFormat(r.format)) return node;

  // Innermost first, so the *first* flag in `WRAPPERS` ends up outermost. Iterating
  // forwards produced `<s><i><b>` — inverted, and a second HTML form for the same
  // model value, which is exactly what the canonical order exists to prevent.
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
  // M22. Held in step with `align`, and for the same reason: they are paragraph properties, read
  // from the block element and re-emitted when the paragraph is flushed.
  let dir: ParagraphDirection | undefined;
  let metrics: ParagraphMetrics | undefined;
  let paragraphStyleId: string | undefined;

  /**
   * Ends the current paragraph.
   *
   * `force` distinguishes the two cases an empty run list can mean. Leaving a block
   * element forces, because `<p></p>` *is* a paragraph - the one the browser leaves
   * behind when a line is emptied - and dropping it would make consecutive blank
   * lines vanish. Entering one does not, because the text before it may be nothing
   * at all.
   */
  const flush = (force = false): void => {
    if (!force && runs.length === 0) {
      align = undefined;
      dir = undefined;
      metrics = undefined;
      paragraphStyleId = undefined;
      return;
    }
    blocks.push({
      kind: 'paragraph',
      ...(align === undefined ? {} : { align }),
      ...(dir === undefined ? {} : { dir }),
      ...(metrics === undefined ? {} : { metrics }),
      ...(paragraphStyleId === undefined ? {} : { styleId: paragraphStyleId }),
      runs: runs.length === 0 ? [{ text: '' }] : runs,
    });
    runs = [];
    align = undefined;
    dir = undefined;
    metrics = undefined;
    paragraphStyleId = undefined;
  };

  /**
 * M23: `styleId` rides alongside `format` rather than inside it.
 *
 * A styled span carries **no** inline style and **no** tag the walker recognises as a flag, so the
 * format arrives unchanged and only the reference is new — which is the whole point of rendering a
 * style as an attribute rather than as wrappers. Two runs with equal formats and different styles
 * must not merge, so the merge test is `runsCompatible` rather than `formatsEqual`.
 */
const appendText = (value: string, format: CharFormat, styleId: string | undefined): void => {
    const text = normalizeNewlines(value);
    if (text.length === 0) return;

    const previous = runs[runs.length - 1];
    if (previous !== undefined && runsCompatible(previous, { text, format, styleId })) {
      runs[runs.length - 1] = {
        text: previous.text + text,
        ...(hasFormat(format) ? { format: { ...format } } : {}),
        ...(styleId === undefined ? {} : { styleId }),
      };
      return;
    }
    runs.push({
      text,
      ...(hasFormat(format) ? { format: { ...format } } : {}),
      ...(styleId === undefined ? {} : { styleId }),
    });
  };

  const visit = (node: Node, format: CharFormat, styleId: string | undefined): void => {
    if (node.nodeType === 3) {
      appendText(node.nodeValue ?? '', format, styleId);
      return;
    }
    if (node.nodeType !== 1) return;

    const element = node as Element;
    const tag = element.nodeName;
    if (IGNORED_TAGS.has(tag)) return;

    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock) flush();

    if (tag === 'BR') {
      appendText('\n', format, styleId);
      return;
    }

    const next = applyTag(element, format);
    // Paragraph properties are read from the block itself. Descendants inherit them in CSS, so
    // reading from an inner wrapper would be guessing -- `align` has always worked this way, and
    // M22's `dir` and `metrics` join it for the same reason.
    if (isBlock) {
      align = readAlign(element) ?? align;
      dir = readDirection(element) ?? dir;
      metrics = readMetrics(element) ?? metrics;
      paragraphStyleId = readStyleRef(element) ?? paragraphStyleId;
    }

    // A styled span: the reference moves inwards for its children, and nothing else about the
    // element changes -- it has no inline style and no recognised tag, so the format arrives
    // untouched. That is what keeps a style's properties from being read back as direct flags.
    const innerStyleId =
      (tag === 'SPAN' ? readStyleRef(element) : undefined) ?? styleId;

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
      visit(child, next, innerStyleId);
    }

    if (!isBlock) return;
    if (container) {
      runs = [];
      align = undefined;
      dir = undefined;
      metrics = undefined;
      paragraphStyleId = undefined;
    } else {
      flush(true);
    }
  };

  const format: CharFormat = {};
  for (const child of Array.from(root.childNodes)) visit(child, format, undefined);
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
    // M22. The mirror of the two entries in `WRAPPERS`, and load-bearing in the same way: a
    // superscript the browser produced during a session and one this renderer produced from the
    // model have to be the same tag, or an edit would rewrite one spelling into the other and the
    // comparison would be a lie.
    //
    // `vertical-align` is read as the alternative spelling pasted HTML uses. `<sup>` wins when both
    // are present, because that is the one this renderer writes.
    case 'SUP':
    case 'SUB':
      next = { ...extend(), ...(tag === 'SUP' ? { super: true } : { sub: true }) };
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
  // M22. `vertical-align` is the alternative spelling for super and subscript, and the one
  // word processors' HTML uses. Read here so pasted superscript arrives as `super: true` instead of
  // being flattened into plain text.
  const baseline = /(?:^|;)\s*vertical-align\s*:\s*([^;]+)/.exec(lowered)?.[1]?.trim() ?? '';

  const format: CharFormat = { ...base };

  if (weight === 'bold' || weight === 'bolder' || /^[6-9]00$/.test(weight)) format.bold = true;
  if (face === 'italic' || face === 'oblique') format.italic = true;
  if (decoration.includes('underline')) format.underline = true;
  if (decoration.includes('line-through')) format.strike = true;
  if (baseline === 'super') format.super = true;
  if (baseline === 'sub') format.sub = true;

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

/**
 * M23: reads the style reference off an element.
 *
 * The **only** thing the walker learns about a style. It reads the attribute and nothing else -- no
 * computed value, no rule text -- which is precisely why a style's properties cannot be mistaken for
 * authored ones: the walker has no way to see them even if it wanted to.
 *
 * An empty attribute is read as absent, so `data-style-id=""` is "no style" rather than a reference
 * to a style with an empty id. The parser refuses such an id anyway; this is belt and braces for a
 * hand-edited file.
 */
function readStyleRef(element: Element): string | undefined {
  const value = element.getAttribute(STYLE_REF_ATTRIBUTE)?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Reads a block element's base direction.
 *
 * `auto` and absent are the same answer, and returning `undefined` for `auto` is what makes the
 * round-trip exact: a paragraph that was never given a direction reads back with no direction, so
 * committing an edit does not write an explicit `auto` into a document that did not have one.
 *
 * The CSS `direction` property is read as well as the `dir` attribute, because pasted rich text
 * carries it that way. Parsed from the attribute rather than through `getComputedStyle`, for the
 * reason {@link readAlign} gives: a computed declaration depends on the stylesheet having been
 * applied, and happy-dom does not populate one.
 */
function readDirection(element: Element): ParagraphDirection | undefined {
  const style = element.getAttribute('style');

  const attribute = element.getAttribute('dir')?.trim().toLowerCase();
  if (attribute === 'ltr' || attribute === 'rtl') return attribute;
  if (attribute === 'auto') return undefined;

  const declared = style === null ? '' : /(?:^|;)\s*direction\s*:\s*([^;]+)/i.exec(style)?.[1]?.trim().toLowerCase() ?? '';
  if (declared === 'ltr' || declared === 'rtl') return declared;
  return undefined;
}

/**
 * Reads a block element's indents and spacing back out of its inline style.
 *
 * Parsed from the `style` **attribute**, not through `element.style`, for exactly the reason
 * {@link readAlign} states: a computed `CSSStyleDeclaration` depends on the environment having
 * applied the stylesheet, and happy-dom does not populate one from `innerHTML`. Reading the CSSOM
 * would have made every metric invisibly `undefined` under the unit suite while looking correct in
 * the browser -- a test suite that quietly stops testing.
 *
 * Only the *logical* spellings are read. This renderer writes those, so they are what a round-trip
 * sees, and interpreting a physical `margin-left` would mean deciding which edge is "start" --
 * which depends on the resolved direction, and a wrong guess silently moves an author's indent to
 * the wrong side of an Arabic paragraph. Recorded as a limitation rather than guessed at.
 *
 * A value CSS accepted but `parseFloat` cannot read is skipped. Persisting it as `NaN` would be
 * worse: `NaN` serialises to `null`, which the parser then refuses, so one odd declaration pasted
 * from a stranger would make the document unsaveable.
 */
function readMetrics(element: Element): ParagraphMetrics | undefined {
  const style = element.getAttribute('style');
  if (style === null) return undefined;

  const metrics: ParagraphMetrics = {};
  let any = false;

  for (const key of PARAGRAPH_METRIC_KEYS) {
    const property = METRIC_CSS_PROPERTY[key];
    const raw = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'i').exec(style)?.[1]?.trim();
    if (raw === undefined) continue;
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value)) continue;
    metrics[key] = value;
    any = true;
  }

  return any ? metrics : undefined;
}

/**
 * Model metric key to the CSS property that carries it.
 *
 * All five are **logical**, which is the whole reason paragraph direction needs no branch anywhere:
 * the start edge is whichever edge the paragraph's own `dir` says it is. A first-line indent on an
 * Arabic paragraph therefore indents from the right because CSS says so, not because this file
 * knows what Arabic is.
 */
const METRIC_CSS_PROPERTY: Readonly<Record<keyof ParagraphMetrics, string>> = {
  marginBefore: 'margin-block-start',
  marginAfter: 'margin-block-end',
  marginStart: 'margin-inline-start',
  marginEnd: 'margin-inline-end',
  textIndent: 'text-indent',
};

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
