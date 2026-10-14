// @vitest-environment happy-dom

/**
 * M23: style resolution, and the round trip through the DOM.
 *
 * ## What is under test, and why it is split this way
 *
 * Two claims that fail differently and are easy to conflate:
 *
 *  1. **Resolution** — for each property independently, the object's own value wins, otherwise the
 *     style's, otherwise whatever the application already did. That is `model/styles.ts`, and it is
 *     a pure function of `(document, object)`, so it is tested without a DOM.
 *  2. **The round trip** — a style *reference* survives an edit session, and a style's *properties*
 *     do not come back with it. That is the property M22 spent a milestone establishing for
 *     paragraph properties, extended to styles, and it is the one that silently breaks.
 *
 * The second has a specific failure mode worth stating: if a style's values were rendered as inline
 * styles, the walker would read them back and store them as **direct overrides**, detaching the
 * object from its style on the first keystroke. Nothing would look wrong and editing the style would
 * quietly stop working. So the tests here assert not only that `styleId` round-trips but that the
 * object's own `format`, `align`, `dir` and `metrics` are **unchanged** by a round trip through a
 * styled element.
 */

import { describe, expect, it } from 'vitest';
import {
  documentReferences,
  effectiveCharFormat,
  effectiveParagraphProps,
  effectiveTextStyle,
  resolveStyle,
} from './styles';
import { domToRichText, richTextToHtml } from '../render/rich-text-html';
import { styleSheetCss } from '../render/style-sheet';
import { normalizeRichText, runsCompatible } from '../model/rich-text';
import type {
  InlineRun,
  ParagraphBlock,
  StyleDefinition,
  TextFrameNode,
} from './types';

const host = (): HTMLElement => {
  const element = document.createElement('div');
  document.body.append(element);
  return element;
};

/** Renders a model with a style table and walks it straight back. */
const roundTrip = (
  blocks: ParagraphBlock[],
  styles: readonly StyleDefinition[],
): ParagraphBlock[] => {
  const element = host();
  element.append(richTextToHtml(normalizeRichText({ blocks }), styles));
  return domToRichText(element).blocks;
};

const CHARACTER: StyleDefinition = {
  id: 'sty_emp',
  name: 'Emphasis',
  kind: 'character',
  character: { italic: true },
};

const PARAGRAPH: StyleDefinition = {
  id: 'sty_quote',
  name: 'Quote',
  kind: 'paragraph',
  // The worked example from M23 §3: size, colour and a start indent, overridable one at a time.
  paragraph: { align: 'center', dir: 'rtl', metrics: { marginStart: 24, textIndent: 8 } },
};

const FRAME: StyleDefinition = {
  id: 'sty_body',
  name: 'Body',
  kind: 'frame',
  frame: { fontFamily: 'Georgia, serif', fontSize: 12, color: '#222222' },
};

const paragraph = (extra: Partial<ParagraphBlock> = {}): ParagraphBlock => ({
  kind: 'paragraph',
  runs: [{ text: 'Hello' }],
  ...extra,
});

const frame = (extra: Partial<TextFrameNode> = {}): TextFrameNode =>
  ({
    id: 'node_1',
    type: 'textFrame',
    name: 'copy',
    transform: { x: 0, y: 0, width: 300, height: 200, rotation: 0, scaleX: 1, scaleY: 1 },
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    text: { blocks: [paragraph()] },
    ...extra,
  }) as TextFrameNode;

describe('a style id resolves only to a definition of the right category', () => {
  const styles = [CHARACTER, PARAGRAPH, FRAME];

  it('resolves within its own category', () => {
    expect(resolveStyle(styles, 'sty_emp', 'character')?.name).toBe('Emphasis');
    expect(resolveStyle(styles, 'sty_quote', 'paragraph')?.name).toBe('Quote');
    expect(resolveStyle(styles, 'sty_body', 'frame')?.name).toBe('Body');
  });

  it('resolves to nothing across categories', () => {
    // The wrong-category reference is inert, not an error: a hand-edited file or a future build may
    // produce one, and refusing the document would make it unopenable for a condition the renderer
    // already handles correctly.
    expect(resolveStyle(styles, 'sty_quote', 'character')).toBeUndefined();
    expect(resolveStyle(styles, 'sty_emp', 'paragraph')).toBeUndefined();
    expect(resolveStyle(styles, 'sty_body', 'frame')).toBeDefined();
  });

  it('resolves nothing for an unknown or absent id', () => {
    expect(resolveStyle(styles, 'sty_missing', 'paragraph')).toBeUndefined();
    expect(resolveStyle(styles, undefined, 'paragraph')).toBeUndefined();
    expect(resolveStyle(styles, '', 'paragraph')).toBeUndefined();
  });

  it('finds every reference in the document, and says where each one is', () => {
    const doc = {
      styles,
      pages: [
        {
          id: 'page_1',
          name: '1',
          size: { width: 210, height: 297, unit: 'mm', orientation: 'portrait' },
          background: { type: 'solid', color: '#ffffff' },
          objects: [
            frame({
              styleId: 'sty_body',
              text: {
                blocks: [
                  paragraph({ styleId: 'sty_quote', runs: [{ text: 'a', styleId: 'sty_emp' }] }),
                  paragraph(),
                ],
              },
            }),
          ],
        },
      ],
    } as unknown as Parameters<typeof documentReferences>[0];

    expect(documentReferences(doc)).toEqual([
      { styleId: 'sty_body', kind: 'frame', site: 'frame', nodeId: 'node_1' },
      { styleId: 'sty_quote', kind: 'paragraph', site: 'paragraph', nodeId: 'node_1' },
      { styleId: 'sty_emp', kind: 'character', site: 'run', nodeId: 'node_1' },
    ]);
  });
});

describe('each property resolves independently', () => {
  it('an object with no overrides inherits everything', () => {
    expect(effectiveParagraphProps([PARAGRAPH], paragraph({ styleId: 'sty_quote' }))).toEqual({
      align: 'center',
      dir: 'rtl',
      metrics: { marginStart: 24, textIndent: 8 },
    });
  });

  it('overriding one property leaves the others inherited', () => {
    // The worked example: override the colour, keep the size and the indent.
    const resolved = effectiveParagraphProps(
      [PARAGRAPH],
      paragraph({ styleId: 'sty_quote', metrics: { marginStart: 40 } }),
    );
    expect(resolved.align, 'align stopped being inherited').toBe('center');
    expect(resolved.dir, 'direction stopped being inherited').toBe('rtl');
    // The overridden key takes the object's value; the style's *other* key survives. This is the
    // key-by-key merge, and a wholesale replacement would lose `textIndent` here.
    expect(resolved.metrics).toEqual({ marginStart: 40, textIndent: 8 });
  });

  it('overriding alignment does not disturb direction or the metrics', () => {
    const resolved = effectiveParagraphProps(
      [PARAGRAPH],
      paragraph({ styleId: 'sty_quote', align: 'justify' }),
    );
    expect(resolved.align).toBe('justify');
    expect(resolved.dir).toBe('rtl');
    expect(resolved.metrics).toEqual({ marginStart: 24, textIndent: 8 });
  });

  it('an unresolvable reference inherits nothing and leaves the direct values alone', () => {
    expect(effectiveParagraphProps([PARAGRAPH], paragraph({ styleId: 'sty_gone', align: 'right' }))).toEqual({
      align: 'right',
    });
    expect(effectiveParagraphProps([], paragraph({ align: 'right' }))).toEqual({ align: 'right' });
  });

  it('with neither a style nor an override, the properties are simply absent', () => {
    // The application's pre-M23 default behaviour has to survive untouched, and "absent" is how that
    // is spelled -- not `null`, and not an empty metrics object.
    expect(effectiveParagraphProps([], paragraph())).toEqual({});
  });

  it('character flags are inherited and overridable without unsetting one another', () => {
    const styles: StyleDefinition[] = [
      { id: 'sty_bi', name: 'Bold italic', kind: 'character', character: { bold: true, italic: true } },
    ];
    const inherited = effectiveCharFormat(styles, { text: 'x', styleId: 'sty_bi' });
    expect(inherited).toEqual({ bold: true, italic: true });

    // A direct flag *adds* to the style's. There is no "unset" for a flag -- the model is
    // `true`-or-absent -- so an override can only ever add, which is what makes the merge total.
    const added = effectiveCharFormat(styles, {
      text: 'x',
      styleId: 'sty_bi',
      format: { underline: true },
    });
    expect(added).toEqual({ bold: true, italic: true, underline: true });
  });

  it('frame typography resolves per property, with the same rule', () => {
    expect(effectiveTextStyle(frame({ styleId: 'sty_body' }), [FRAME])).toEqual({
      fontFamily: 'Georgia, serif',
      fontSize: 12,
      color: '#222222',
    });
    expect(effectiveTextStyle(frame({ styleId: 'sty_body', style: { fontSize: 20 } }), [FRAME])).toEqual({
      fontFamily: 'Georgia, serif',
      fontSize: 20,
      color: '#222222',
    });
  });
});

describe('runs merge only when their styles match too', () => {
  const plain = (extra: Partial<InlineRun> = {}): InlineRun => ({ text: 'a', ...extra });

  it('merges equal formatting with equal styles', () => {
    expect(runsCompatible(plain(), plain())).toBe(true);
    expect(runsCompatible(plain({ styleId: 's' }), plain({ styleId: 's' }))).toBe(true);
  });

  it('does not merge equal formatting across different styles', () => {
    // The distinction that would otherwise be unrecoverable: editing one style must not change the
    // other, so a merged run could no longer say which it was.
    expect(runsCompatible(plain({ styleId: 'a' }), plain({ styleId: 'b' }))).toBe(false);
    expect(runsCompatible(plain({ styleId: 'a' }), plain())).toBe(false);
  });

  it('still refuses to merge differing formats within one style', () => {
    expect(runsCompatible(plain({ styleId: 's', format: { bold: true } }), plain({ styleId: 's' }))).toBe(
      false,
    );
  });

  it('normalisation keeps the boundary between two adjacent styles', () => {
    // *Adjacent* is the word that matters, and the one my first version of this test left out:
    // merging only ever considers the previous run. What has to hold is that two different styles do
    // not collapse into one.
    const merged = normalizeRichText({
      blocks: [
        paragraph({
          runs: [
            { text: 'one', styleId: 'sty_a' },
            { text: 'two', styleId: 'sty_b' },
          ],
        }),
      ],
    }).blocks[0]?.runs;
    expect(merged, 'two differently-styled runs were merged').toHaveLength(2);
    expect(merged?.[0]?.styleId).toBe('sty_a');
    expect(merged?.[1]?.styleId).toBe('sty_b');
  });

  it('normalisation does not merge across a style boundary even when the styles alternate', () => {
    // Spelled out because `a b a` staying at three runs is the surprising half, and it is easy to
    // "fix" by comparing against every earlier run rather than the previous one.
    const merged = normalizeRichText({
      blocks: [
        paragraph({
          runs: [
            { text: 'one', styleId: 'sty_a' },
            { text: 'two', styleId: 'sty_b' },
            { text: 'three', styleId: 'sty_a' },
          ],
        }),
      ],
    }).blocks[0]?.runs;
    expect(merged?.map((run) => run.styleId)).toEqual(['sty_a', 'sty_b', 'sty_a']);
  });

  it('normalisation still merges two runs of the same style', () => {
    const merged = normalizeRichText({
      blocks: [
        paragraph({ runs: [{ text: 'one', styleId: 'sty_a' }, { text: 'two', styleId: 'sty_a' }] }),
      ],
    }).blocks[0]?.runs;
    expect(merged).toHaveLength(1);
    expect(merged?.[0]?.text).toBe('onetwo');
  });
});

describe('the DOM round trip keeps the reference and drops the properties', () => {
  it('a paragraph style reference survives, and its properties do not come back', () => {
    const blocks = roundTrip(
      [paragraph({ styleId: 'sty_quote', runs: [{ text: 'Hello' }] })],
      [PARAGRAPH],
    );
    expect(blocks[0]?.styleId, 'the reference was lost').toBe('sty_quote');
    // The load-bearing half. `align`, `dir` and `metrics` came from the style, so if any of them had
    // been written inline the walker would have read them back and written them here -- as direct
    // values, permanently shadowing the style.
    expect(blocks[0]?.align, 'an inherited alignment was materialised').toBeUndefined();
    expect(blocks[0]?.dir, 'an inherited direction was materialised').toBeUndefined();
    expect(blocks[0]?.metrics, 'inherited metrics were materialised').toBeUndefined();
  });

  it('a direct override *is* read back, because it is authored on the element', () => {
    const blocks = roundTrip(
      [paragraph({ styleId: 'sty_quote', align: 'justify', runs: [{ text: 'Hello' }] })],
      [PARAGRAPH],
    );
    expect(blocks[0]?.styleId).toBe('sty_quote');
    expect(blocks[0]?.align, 'the authored override was lost').toBe('justify');
    // ...and the style's *other* properties are still inherited, which is the whole promise.
    expect(blocks[0]?.dir).toBeUndefined();
  });

  it('a character style reference survives and contributes no flags', () => {
    const blocks = roundTrip(
      [paragraph({ runs: [{ text: 'x', styleId: 'sty_emp' }] })],
      [CHARACTER],
    );
    expect(blocks[0]?.runs[0]?.styleId).toBe('sty_emp');
    expect(blocks[0]?.runs[0]?.format, 'the inherited flags were materialised').toBeUndefined();
  });

  it('a styled run and a directly-italic run stay distinct', () => {
    const blocks = roundTrip(
      [
        paragraph({
          runs: [
            { text: 'a', styleId: 'sty_emp' },
            { text: 'b', format: { italic: true } },
          ],
        }),
      ],
      [CHARACTER],
    );
    // They *look* identical, and they are not: one inherits italic, the other has it directly.
    // Merging them would make it impossible to tell, so the boundary has to survive.
    expect(blocks[0]?.runs, 'a styled run merged with an identically-formatted one').toHaveLength(2);
  });

  it('a dangling reference renders as an unstyled paragraph rather than throwing', () => {
    const blocks = roundTrip([paragraph({ styleId: 'sty_gone', align: 'right' })], [PARAGRAPH]);
    expect(blocks[0]?.styleId, 'a dangling reference was silently dropped').toBe('sty_gone');
    expect(blocks[0]?.align).toBe('right');
  });
});

describe('the generated stylesheet', () => {
  it('writes a character style as declarations, not tags', () => {
    // `<i>` would be read back as a *direct* flag, so the style's formatting would be
    // materialised. A declaration in a rule is invisible to the walker's inline-style path.
    expect(styleSheetCss([CHARACTER])).toContain('font-style: italic');
  });

  it('combines underline and strike into one declaration', () => {
    const both: StyleDefinition = {
      id: 'sty_u',
      name: 'Marked',
      kind: 'character',
      character: { underline: true, strike: true },
    };
    const css = styleSheetCss([both]);
    expect(css).toContain('text-decoration-line: underline line-through');
    expect((css.match(/text-decoration-line/g) ?? []).length, 'the property was written twice').toBe(1);
  });

  it('writes paragraph metrics as logical properties', () => {
    const css = styleSheetCss([PARAGRAPH]);
    expect(css).toContain('margin-inline-start: 24px');
    expect(css).toContain('text-indent: 8px');
    // `dir: auto` is the absence of an override, not a declaration -- the renderer's `dir="auto"`
    // already says it, and emitting `direction: auto` would be invalid CSS.
    expect(css).not.toContain('auto');
  });

  it('escapes an id that would otherwise end the selector', () => {
    // `expectId` accepts any non-empty string, so a hand-edited file can carry a quote. Unescaped,
    // the selector ends early and the rest is parsed as CSS -- a document injecting rules into the
    // application's own stylesheet.
    const hostile: StyleDefinition = {
      id: 'a"] , * { color: red } [x="',
      name: 'Hostile',
      kind: 'character',
      character: { bold: true },
    };
    const css = styleSheetCss([hostile]);
    // The hostile text *is* present -- it has to be, it is the id -- but only inside the quoted
    // attribute value, where it is inert. An injection would mean something *outside* a string
    // became a selector, so that is what is checked: with every quoted string blanked out, exactly
    // one `{` survives, and the only declaration in the rule is ours.
    const outsideStrings = css.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    expect((outsideStrings.match(/\{/g) ?? []).length, 'the id escaped its string and became a rule').toBe(1);
    expect(css.startsWith('[data-style-id="a\\"]'), 'the id was not escaped').toBe(true);
    // The opening brace is found from the *end*: the id itself contains one, inside the quoted string,
// and taking the first would slice the declaration out of the middle of the selector.
    const body = css.slice(css.lastIndexOf('{') + 1, css.lastIndexOf('}'));
    expect(body.trim()).toBe('font-weight: 700');
  });

  it('is empty for a document with no styles', () => {
    expect(styleSheetCss([])).toBe('');
  });
});
