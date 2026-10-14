/**
 * M23: the document's stylesheet.
 *
 * ## Why a stylesheet at all, rather than inline styles
 *
 * This is the load-bearing decision of the milestone, and it is forced by an existing property.
 *
 * The DOM→model walker reads a paragraph's `text-align` and its logical margins back out of the
 * element's **inline style**, and it reads character flags back out of `<b>`/`<i>`/`<sup>` wrappers.
 * That is M22's round-trip discipline, and it is correct: an inline value is authored on that
 * element, so reading it back as a direct value loses nothing.
 *
 * A *style-derived* value is not authored on the element. If it were written inline, the next edit
 * anywhere in the frame would read it back and store it as a **direct override** -- silently and
 * permanently detaching the paragraph from its style. Editing the style would then do nothing, and
 * the document would carry a frozen copy of a value that is supposed to be shared. That is exactly
 * the "do not copy resolved values back" rule, and the only way to honour it here is to keep
 * inherited values somewhere the walker's inline-style path cannot see.
 *
 * So: a style's properties become a CSS rule keyed by `data-style-id`, and the object carries only
 * the attribute. The rule is authored CSS; the attribute is not. The walker reads the attribute (so
 * the *reference* round-trips) and reads nothing from the rule (so nothing is materialised).
 *
 * ## What this file is not allowed to do
 *
 * It writes a `<style>` element and nothing else. It never touches the document model, and it is
 * never called from a mutation — so "CSS is not the source of truth" is true by construction rather
 * than by discipline. Dropping the stylesheet on the floor would make every styled object fall back
 * to its direct values, which is recoverable; freezing resolved values into the model would not be.
 */

import { CHAR_FLAGS, PARAGRAPH_METRIC_KEYS } from '../model/rich-text';
import { resolveStyle } from '../model/styles';
import { cssLength, cssNumber } from './num';
import type {
  CharFormat,
  ParagraphStyleProps,
  StyleDefinition,
  TextStyle,
} from '../model/types';

/** The attribute an object carries to say "resolve me against this style". */
export const STYLE_REF_ATTRIBUTE = 'data-style-id';

/** Marks the injected element, so it can be found and rewritten rather than duplicated. */
const SHEET_ATTRIBUTE = 'data-p1-style-sheet';

/**
 * Escapes a style id for use inside a double-quoted CSS attribute selector.
 *
 * Not optional tidiness. `expectId` accepts **any** non-empty string, so a hand-edited file can
 * carry an id containing a quote or a bracket -- and an unescaped one would end the selector early
 * and let the rest of it be parsed as CSS, which is a document being able to inject rules into the
 * application's own stylesheet. Ids minted by `createId` are alphanumeric, so this costs nothing in
 * practice and closes the hole for the ids that are not.
 *
 * Escapes the two characters that are special inside a CSS *string* (`\` and `"`), plus newline
 * and CR, which would otherwise terminate the selector.
 */
export function escapeSelectorValue(id: string): string {
  return id.replace(/[\\"\r\n]/g, (character) => {
    switch (character) {
      case '\\':
        return '\\\\';
      case '"':
        return '\\"';
      case '\n':
        return '\\a ';
      case '\r':
        return '\\d ';
      default:
        return character;
    }
  });
}

/**
 * The CSS this document's styles imply, or `''` when it defines none.
 *
 * A pure function of the style table, which is what makes it testable without a DOM and what keeps
 * the element-writing half in {@link applyStyleSheet} down to three lines.
 *
 * **Only resolvable references produce rules, and only for resolvable styles.** A definition is
 * emitted regardless of whether anything references it — the sheet is a projection of the *table*,
 * not of its users — but a style of a category this renderer does not know would be a build
 * inconsistency rather than a document condition, so there are only ever three categories.
 */
export function styleSheetCss(styles: readonly StyleDefinition[]): string {
  const rules: string[] = [];

  for (const style of styles) {
    // Qualified by `.p1-text-content`, and the qualification is load-bearing rather than tidy.
    //
    // The renderer's own base rule is `.p1-text-content p { margin: 0 }`, which is specificity
    // (0,1,1). A bare attribute selector is (0,1,0) and loses. So a paragraph style's
    // `marginStart` and `marginEnd` computed to zero, silently, while its alignment and direction
    // applied -- which is the worst possible shape of bug, because half the style demonstrably
    // worked. It surfaced as "unlink moved the text", which is supposed to be impossible.
    //
    // Qualifying makes the rule (0,2,1) and says what it already was true of: these declarations
    // apply to document text content and to nothing else.
    const selector = `.p1-text-content [${STYLE_REF_ATTRIBUTE}="${escapeSelectorValue(style.id)}"]`;

    if (style.kind === 'character') {
      const declarations = characterDeclarations(style.character);
      // A character style that sets no flags would emit `[data-style-id="x"] {}`, which is not
      // valid CSS in every engine and says nothing. Skipped rather than emitted empty.
      if (declarations === '') continue;
      rules.push(`${selector} { ${declarations} }`);
      continue;
    }

    if (style.kind === 'paragraph') {
      rules.push(`${selector} { ${paragraphDeclarations(style.paragraph)} }`);
      continue;
    }

    rules.push(`${selector} { ${frameDeclarations(style.frame)} }`);
  }

  return rules.join('\n');
}

/**
 * Character flags as CSS.
 *
 * `text-decoration-line` is assembled rather than written twice, because `underline` and `strike`
 * are independent flags and the model permits both. Emitting the property twice would let the
 * second silently win, so two styled runs would come out looking identical when the document says
 * they differ.
 */
function characterDeclarations(format: CharFormat): string {
  const parts: string[] = [];
  if (format['bold'] === true) parts.push('font-weight: 700');
  if (format['italic'] === true) parts.push('font-style: italic');

  const lines: string[] = [];
  if (format['underline'] === true) lines.push('underline');
  if (format['strike'] === true) lines.push('line-through');
  if (lines.length > 0) parts.push(`text-decoration-line: ${lines.join(' ')}`);

  if (format['super'] === true) parts.push('vertical-align: super');
  if (format['sub'] === true) parts.push('vertical-align: sub');

  return parts.join('; ');
}

/**
 * Paragraph properties as CSS — **logical**, so the start edge follows the paragraph's own
 * direction (M22's decision, carried forward unchanged).
 *
 * `direction` rather than a `dir` attribute, and that distinction matters: the renderer writes
 * `dir="auto"` on every paragraph, and a `dir` attribute is a *presentational hint* that maps to
 * the same `direction` property. Relying on the hint losing to an author rule would work, but would
 * be a precedence argument rather than a stated rule. So {@link rich-text-html} omits the attribute
 * for a paragraph whose direction is inherited, and there is nothing to compete with.
 */
function paragraphDeclarations(props: ParagraphStyleProps): string {
  const parts: string[] = [];
  if (props.align !== undefined) parts.push(`text-align: ${props.align}`);
  if (props.dir !== undefined && props.dir !== 'auto') parts.push(`direction: ${props.dir}`);

  if (props.metrics !== undefined) {
    for (const key of PARAGRAPH_METRIC_KEYS) {
      const value = props.metrics[key];
      if (value === undefined) continue;
      parts.push(`${METRIC_PROPERTY[key]}: ${cssLength(value)}`);
    }
  }

  return parts.join('; ');
}

const METRIC_PROPERTY: Readonly<Record<(typeof PARAGRAPH_METRIC_KEYS)[number], string>> = {
  marginBefore: 'margin-block-start',
  marginAfter: 'margin-block-end',
  marginStart: 'margin-inline-start',
  marginEnd: 'margin-inline-end',
  textIndent: 'text-indent',
};

/** Frame typography as CSS. Geometry, padding and page properties are not styleable, by design. */
function frameDeclarations(style: TextStyle): string {
  const parts: string[] = [];
  if (style.fontFamily !== undefined) parts.push(`font-family: ${style.fontFamily}`);
  if (style.fontSize !== undefined) parts.push(`font-size: ${cssLength(style.fontSize)}`);
  if (style.lineHeight !== undefined) parts.push(`line-height: ${cssNumber(style.lineHeight)}`);
  // `em`, matching the inline path: letter spacing must keep scaling with the size it belongs to.
  if (style.letterSpacing !== undefined) parts.push(`letter-spacing: ${cssNumber(style.letterSpacing)}em`);
  if (style.color !== undefined) parts.push(`color: ${style.color}`);
  return parts.join('; ');
}

/**
 * Writes the document's stylesheet into the page, reusing one element.
 *
 * Same shape as `applyPrintProfile` and for the same reason: a new `<style>` per render would
 * accumulate, and rewriting unconditionally would touch the DOM on every keystroke for a document
 * whose styles have not changed. The text is compared first, so the common case writes nothing.
 *
 * Passing an empty table removes the rules by writing `''` rather than removing the element, which
 * keeps "one element, always present" true and avoids a re-parse on the next non-empty update.
 *
 * @returns the CSS now in the page, which is what tests assert against.
 */
export function applyStyleSheet(styles: readonly StyleDefinition[]): string {
  const css = styleSheetCss(styles);
  const existing = document.querySelector<HTMLStyleElement>(`style[${SHEET_ATTRIBUTE}]`);

  if (existing !== null) {
    if (existing.textContent !== css) existing.textContent = css;
    return css;
  }

  const element = document.createElement('style');
  element.setAttribute(SHEET_ATTRIBUTE, 'true');
  element.textContent = css;
  document.head.append(element);
  return css;
}

/** The injected stylesheet's CSS, or `null` if it has never been applied. */
export function currentStyleSheet(): string | null {
  return document.querySelector<HTMLStyleElement>(`style[${SHEET_ATTRIBUTE}]`)?.textContent ?? null;
}

/**
 * Whether a style id resolves to a definition of `kind`, for the renderer's reference sites.
 *
 * Thin on top of {@link resolveStyle} so the renderer has one way to ask the question rather than
 * re-implementing the category check at each of the three sites.
 */
export function styleExists(
  styles: readonly StyleDefinition[],
  id: string | undefined,
  kind: 'character' | 'paragraph' | 'frame',
): boolean {
  return resolveStyle(styles, id, kind) !== undefined;
}

/** Re-exported so the render layer does not import `CHAR_FLAGS` for one comparison. */
export { CHAR_FLAGS };