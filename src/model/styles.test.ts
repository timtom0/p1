/**
 * M23: style resolution -- the per-property rule, and merging.
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
import { normalizeRichText, runsCompatible } from './rich-text';
import type {
  InlineRun,
  ParagraphBlock,
  StyleDefinition,
  TextFrameNode,
} from './types';

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
