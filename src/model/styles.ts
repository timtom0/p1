/**
 * M23: style resolution.
 *
 * ## The rule, in one sentence
 *
 * For each property independently: **the object's own value wins; otherwise the referenced style's;
 * otherwise whatever the application already did when neither exists.**
 *
 * That is the entire resolution algorithm. There is no cascade, no specificity, no parent style, and
 * no ordering between competing definitions — a style is a shared source of values, not a rule in a
 * cascade, and this file is the only place the rule is written down.
 *
 * ## Why this is a pure function of `(document, object)` and not a field on either
 *
 * Because the persisted model must stay independent of resolution. Storing an effective value on the
 * object would mean saving freezes it, and then editing a style would not reach the objects that
 * reference it — which is the one thing a style is for. So nothing here writes to the document, and
 * nothing here is called from a mutation.
 *
 * ## Unresolvable references are ignored, not repaired
 *
 * A `styleId` naming a style that does not exist, or naming one of the wrong kind, resolves to
 * "nothing inherited". It does not throw and it does not repair the reference, because a reference
 * this build cannot resolve is a document from the future or a hand-edited file, and both deserve
 * to *load and render as far as they can* rather than to fail. {@link documentReferences} exists to
 * make the condition visible for tests, and the test suite asserts on it rather than on the absence
 * of a crash.
 */

import { CHAR_FLAGS, PARAGRAPH_METRIC_KEYS, paragraphMetricsEqual } from './rich-text';
import type {
  CharFormat,
  Document,
  InlineRun,
  ParagraphAlign,
  ParagraphBlock,
  ParagraphDirection,
  ParagraphMetrics,
  StyleDefinition,
  TextFrameNode,
  TextStyle,
} from './types';

/** The category of style a reference site may name, which fixes the definition's `kind`. */
export type StyleCategory = 'character' | 'paragraph' | 'frame';

/**
 * The style a `styleId` names, **if it names one of the right kind**.
 *
 * The kind check is what makes `InlineRun.styleId -> frame style` a non-event rather than a crash, and
 * it is why the model can be trusted to be internally consistent while still tolerating a file that
 * is not.
 */
export function resolveStyle(
  styles: readonly StyleDefinition[],
  id: string | undefined,
  kind: StyleCategory,
): StyleDefinition | undefined {
  if (id === undefined || id === '') return undefined;
  const found = styles.find((style) => style.id === id);
  if (found === undefined || found.kind !== kind) return undefined;
  return found;
}

/**
 * Every `styleId` in the document, paired with where it was found.
 *
 * Two uses, and no others: the **delete** command, which has to find every user of a style it is
 * removing, and the tests, which assert that a hand-edited file with a dangling reference loads and
 * renders rather than throwing. It is deliberately not used by the render path — resolving through
 * it would be the model depending on a traversal for something `resolveStyle` answers in O(1).
 */
export function documentReferences(doc: Document): Array<{
  styleId: string;
  kind: StyleCategory;
  /** Where the reference lives, so a test failure names the site rather than a count. */
  site: 'run' | 'paragraph' | 'frame';
  nodeId: string;
}> {
  const found: Array<{
    styleId: string;
    kind: StyleCategory;
    site: 'run' | 'paragraph' | 'frame';
    nodeId: string;
  }> = [];

  const walk = (nodes: readonly import('./types').Node[]): void => {
    for (const node of nodes) {
      if (node.type === 'group') {
        walk(node.children);
        continue;
      }
      if (node.type !== 'textFrame') continue;
      if (node.styleId !== undefined) {
        found.push({ styleId: node.styleId, kind: 'frame', site: 'frame', nodeId: node.id });
      }
      for (const block of node.text.blocks) {
        if (block.styleId !== undefined) {
          found.push({ styleId: block.styleId, kind: 'paragraph', site: 'paragraph', nodeId: node.id });
        }
        for (const run of block.runs) {
          if (run.styleId !== undefined) {
            found.push({ styleId: run.styleId, kind: 'character', site: 'run', nodeId: node.id });
          }
        }
      }
    }
  };

  for (const page of doc.pages) walk(page.objects);
  return found;
}

/**
 * A run's effective character format: its own flags over its style's.
 *
 * Flags are `true`-only and additive, so there is nothing to weigh -- a flag is either set directly
 * or inherited, and "both set it" and "only the style set it" are the same answer. That is a
 * consequence of M23's true-only convention and is the reason this is a spread rather than a merge
 * with conflict rules.
 */
export function effectiveCharFormat(
  styles: readonly StyleDefinition[],
  run: InlineRun,
): CharFormat | undefined {
  const style = resolveStyle(styles, run.styleId, 'character');
  if (style === undefined || style.kind !== 'character') return run.format;

  const merged: CharFormat = { ...style.character };
  for (const flag of CHAR_FLAGS) {
    if (run.format?.[flag] === true) merged[flag] = true;
  }
  return hasAnyFlag(merged) ? merged : undefined;
}

const hasAnyFlag = (format: CharFormat): boolean =>
  CHAR_FLAGS.some((flag) => format[flag] === true);

/**
 * A paragraph's effective alignment, direction and metrics.
 *
 * Returned as a plain object rather than a merged `ParagraphBlock`, because the caller is the
 * renderer and it must be able to tell *which* properties came from where if it ever needs to — and
 * more immediately because the renderer's stylesheet rule must contain only the *style's* share, so
 * that inline styles stay free of inherited values. {@link effectiveParagraphProps} gives the
 * total; {@link styleParagraphProps} gives the inherited share alone.
 */
export function effectiveParagraphProps(
  styles: readonly StyleDefinition[],
  block: ParagraphBlock,
): { align?: ParagraphAlign; dir?: ParagraphDirection; metrics?: ParagraphMetrics } {
  const inherited = styleParagraphProps(styles, block);
  const metrics = mergeMetrics(inherited.metrics, block.metrics);
  const align = block.align ?? inherited.align;
  const dir = block.dir ?? inherited.dir;

  return {
    ...(align === undefined ? {} : { align }),
    ...(dir === undefined ? {} : { dir }),
    ...(metrics === undefined ? {} : { metrics }),
  };
}

/**
 * The share of a paragraph's formatting that comes from its style — and **only** that share.
 *
 * This exists so the renderer can write a CSS rule containing exactly these values, and leave
 * `align` and the metrics *out* of the element's inline style. That omission is load-bearing rather
 * than tidy: the DOM→model walker reads `text-align` and the logical margins back out of inline
 * styles, so an inherited value written inline would be read back on the next edit and stored as a
 * direct override — silently and permanently detaching the paragraph from its style, which is
 * exactly the "do not copy resolved values back" rule. Keeping inherited values in a rule keyed by
 * `data-style-id` means the walker's inline-style path never sees them at all.
 */
export function styleParagraphProps(
  styles: readonly StyleDefinition[],
  block: ParagraphBlock,
): { align?: ParagraphAlign; dir?: ParagraphDirection; metrics?: ParagraphMetrics } {
  const style = resolveStyle(styles, block.styleId, 'paragraph');
  if (style === undefined || style.kind !== 'paragraph') return {};
  return style.paragraph;
}

/**
 * Metrics merged **key by key**, not wholesale.
 *
 * Wholesale replacement is the bug this avoids: a paragraph with a direct `marginBefore` and no
 * direct `textIndent` would lose the style's `textIndent` if assigning `metrics` replaced the
 * object. Each key resolves on its own, which is what makes "override one indent, inherit the
 * other" work — and it is the same rule `setParagraphMetrics`' patch obeys on the way in.
 */
function mergeMetrics(
  inherited: ParagraphMetrics | undefined,
  own: ParagraphMetrics | undefined,
): ParagraphMetrics | undefined {
  if (inherited === undefined) return own;
  if (own === undefined) return inherited;

  const merged: ParagraphMetrics = { ...inherited };
  for (const key of PARAGRAPH_METRIC_KEYS) {
    const value = own[key];
    if (value !== undefined) merged[key] = value;
  }
  return Object.values(merged).some((value) => value !== undefined) ? merged : undefined;
}

/**
 * A text frame's effective typography: its own `TextStyle` over its style's, property by property.
 *
 * Note the asymmetry with `effectiveParagraphProps`: this *is* the total, and it is written inline
 * by the renderer. That is safe because the walker has never read frame typography back out of the
 * DOM -- `domToRichText` reads runs and paragraph properties, and nothing else -- so an inline value
 * here has nothing to be mistaken for an authored one. No rule and no `data-style-id` are needed for
 * a frame, and adding them would be cost without a defect to prevent.
 */
export function effectiveTextStyle(node: TextFrameNode, styles: readonly StyleDefinition[]): TextStyle {
  const style = resolveStyle(styles, node.styleId, 'frame');
  if (style === undefined || style.kind !== 'frame') return node.style ?? {};

  // Spelled out key by key rather than `Object.assign`, because `Object.entries` on a
  // `TextStyle` widens every value to `string | number | undefined` and the assignment then fails.
  // Five keys is a small enough price for keeping the compiler's knowledge of the shape.
  const merged: TextStyle = { ...style.frame };
  const own = node.style;
  if (own === undefined) return merged;
  if (own.fontFamily !== undefined) merged.fontFamily = own.fontFamily;
  if (own.fontSize !== undefined) merged.fontSize = own.fontSize;
  if (own.lineHeight !== undefined) merged.lineHeight = own.lineHeight;
  if (own.letterSpacing !== undefined) merged.letterSpacing = own.letterSpacing;
  if (own.color !== undefined) merged.color = own.color;
  return merged;
}

// The run-merging predicate lives in rich-text.ts, beside formatsEqual: a run's identity is that
// module's business, and styles.ts already imports it -- a cycle between the two would make the
// dependency direction depend on evaluation order.

/**
 * Whether a frame's effective typography is empty, so the renderer can skip a write.
 *
 * Exists because {@link effectiveTextStyle} always returns an object: a frame with no style and no
 * reference resolves to `{}`, which must be distinguishable from "a style that sets nothing".
 */
export function textStyleIsEmpty(style: TextStyle): boolean {
  return !Object.values(style).some((value) => value !== undefined);
}

/**
 * Whether a paragraph's direct metrics equal another's, re-exported so callers need not reach into
 * `rich-text.ts` for a comparison that is about styles.
 */
export function metricsEqual(
  a: ParagraphMetrics | undefined,
  b: ParagraphMetrics | undefined,
): boolean {
  return paragraphMetricsEqual(a, b);
}
