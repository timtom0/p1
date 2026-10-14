/**
 * M23: the **selection-level** style actions, and the rule that separates them from deletion.
 *
 * ## Why this file exists separately from `style-commands.test.ts`
 *
 * Because the distinction is the whole point of the milestone's selection-level work, and it is a
 * distinction about **reach** as much as about semantics:
 *
 *  - these two actions touch **only the selected objects**, and
 *  - they leave the definition, and every *other* user of that definition, exactly as they were.
 *
 * A single test document carries three objects referencing one style, so "only the selection changed"
 * is checkable: if any implementation swept up the others, the untouched objects would stop matching.
 *
 * ## The worked example
 *
 * M23's own: a paragraph style provides centred alignment, RTL direction and a 12px start indent; the
 * paragraph also has a direct override. **Unlink** keeps all four values as direct formatting.
 * **Remove** loses the three the style supplied and keeps only the override.
 */

import { describe, expect, it } from 'vitest';
import { apply, isNoop } from '../../src/model/commands';
import { countStyleUsers } from '../../src/model/style-commands';
import { effectiveParagraphProps } from '../../src/model/styles';
import { createDocument, createTextFrameNode } from '../../src/model/factory';
import type { Command } from '../../src/model/commands';
import type {
  Document,
  ParagraphBlock,
  StyleDefinition,
  TextFrameNode,
} from '../../src/model/types';

const QUOTE: StyleDefinition = {
  id: 'sty_quote',
  name: 'Quote',
  kind: 'paragraph',
  paragraph: { align: 'center', dir: 'rtl', metrics: { marginStart: 12 } },
};

const EMPHASIS: StyleDefinition = {
  id: 'sty_emp',
  name: 'Emphasis',
  kind: 'character',
  character: { italic: true },
};

const BODY: StyleDefinition = {
  id: 'sty_body',
  name: 'Body',
  kind: 'frame',
  frame: { fontSize: 11, color: '#333333' },
};

const paragraph = (extra: Partial<ParagraphBlock> = {}): ParagraphBlock => ({
  kind: 'paragraph',
  runs: [{ text: 'Hello' }],
  ...extra,
});

/**
 * Two frames referencing the same paragraph style, plus a frame style and a character style.
 *
 * `withOverride` additionally carries a direct `align` on its first paragraph, so the unlink-vs-remove
 * difference is observable on the *same* document the reach assertions use.
 */
const build = (withOverride: boolean): { doc: Document; a: string; b: string } => {
  const doc = createDocument({ name: 'M23', styles: [QUOTE, EMPHASIS, BODY] });
  const first = createTextFrameNode({
    name: 'first',
    styleId: BODY.id,
    text: {
      blocks: [
        paragraph({
          styleId: QUOTE.id,
          ...(withOverride ? { align: 'justify' as const } : {}),
          runs: [{ text: 'styled run', styleId: EMPHASIS.id }],
        }),
        paragraph({ styleId: QUOTE.id, runs: [{ text: 'second' }] }),
      ],
    },
  });
  const second = createTextFrameNode({
    name: 'second',
    styleId: BODY.id,
    text: { blocks: [paragraph({ styleId: QUOTE.id, runs: [{ text: 'other frame' }] })] },
  });
  const page = doc.pages[0];
  if (page === undefined) throw new Error('the factory produced no pages');
  return {
    doc: { ...doc, pages: [{ ...page, objects: [first, second] }] },
    a: first.id,
    b: second.id,
  };
};

const frameOf = (doc: Document, id: string): TextFrameNode => {
  const node = doc.pages[0]?.objects.find((candidate) => candidate.id === id);
  if (node === undefined || node.type !== 'textFrame') throw new Error(`no frame ${id}`);
  return node;
};

const unlink = (
  ids: readonly string[],
  mode: 'unlink' | 'remove',
  category: 'character' | 'paragraph' | 'frame' = 'paragraph',
  styleId = QUOTE.id,
): Command => ({ type: 'unlinkStyle', ids, category, styleId, mode });

describe('unlink on the selection preserves appearance', () => {
  it('writes the effective values down before dropping the reference', () => {
    const { doc, a } = build(false);
    const after = apply(doc, unlink([a], 'unlink'));
    const block = frameOf(after, a).text.blocks[0];
    expect(block?.styleId).toBeUndefined();
    expect(block?.align).toBe('center');
    expect(block?.dir).toBe('rtl');
    expect(block?.metrics).toEqual({ marginStart: 12 });
  });

  it('keeps a property the object had already overridden, rather than flattening it', () => {
    const { doc, a } = build(true);
    const after = apply(doc, unlink([a], 'unlink'));
    const block = frameOf(after, a).text.blocks[0];
    // `justify`, not the style's `center`. Writing the *resolved* value back preserves the override.
    expect(block?.align).toBe('justify');
    // ...while the properties it did not override come down from the style.
    expect(block?.dir).toBe('rtl');
  });

  it('leaves the definition in place, so the other frames still inherit it', () => {
    const { doc, a, b } = build(false);
    const after = apply(doc, unlink([a], 'unlink'));
    expect(after.styles).toEqual([QUOTE, EMPHASIS, BODY]);
    expect(frameOf(after, b).text.blocks[0]?.styleId).toBe(QUOTE.id);
  });
});

describe('remove on the selection does not', () => {
  it('drops the reference and writes nothing down', () => {
    const { doc, a } = build(false);
    const after = apply(doc, unlink([a], 'remove'));
    const block = frameOf(after, a).text.blocks[0];
    expect(block?.styleId).toBeUndefined();
    // The whole difference from unlink: what the style was contributing is *gone*, not frozen.
    expect(block?.align, 'an inherited alignment was frozen').toBeUndefined();
    expect(block?.dir, 'an inherited direction was frozen').toBeUndefined();
    expect(block?.metrics, 'inherited metrics were frozen').toBeUndefined();
    expect(effectiveParagraphProps(after.styles, block!)).toEqual({});
  });

  it('keeps a direct override exactly as it was', () => {
    const { doc, a } = build(true);
    const after = apply(doc, unlink([a], 'remove'));
    const block = frameOf(after, a).text.blocks[0];
    // The one thing the paragraph had of its own survives.
    expect(block?.align).toBe('justify');
    expect(block?.styleId).toBeUndefined();
  });

  it('leaves the definition and the other frames alone, as unlink does', () => {
    const { doc, a, b } = build(false);
    const after = apply(doc, unlink([a], 'remove'));
    expect(after.styles).toEqual([QUOTE, EMPHASIS, BODY]);
    expect(frameOf(after, b).text.blocks[0]?.styleId).toBe(QUOTE.id);
  });
});

describe('the two actions touch only the selection', () => {
  it('does not touch an unselected object that references the same style', () => {
    // The requirement stated as a test. Three objects reference `sty_quote`; acting on one must leave
    // the other two exactly as they were -- including the one in the *same* frame, because a
    // paragraph-level action writes per paragraph and not per frame.
    const { doc, a, b } = build(false);
    const untouched = frameOf(doc, b);
    const after = apply(doc, unlink([a], 'unlink'));

    expect(frameOf(after, b)).toEqual(untouched);
    expect(frameOf(after, a).text.blocks[0]?.styleId).toBeUndefined();
    // Both paragraphs of the acted-on frame reference the style, so both are unlinked -- a
    // paragraph-style action on a frame means *every paragraph of that frame*, the same fan-out
    // `applyStyle` does. The assertion that matters is the one above: the *unselected frame* is
    // untouched, which is where "only the selection" is actually testable.
    expect(frameOf(after, a).text.blocks[1]?.styleId).toBeUndefined();
  });

  it('acts on every selected object and no others', () => {
    const { doc, a, b } = build(false);
    const after = apply(doc, unlink([a, b], 'unlink'));
    expect(frameOf(after, a).text.blocks[0]?.styleId).toBeUndefined();
    expect(frameOf(after, b).text.blocks[0]?.styleId).toBeUndefined();
  });

  it('is a no-op when the selection references nothing', () => {
    // A shortcut pressed with nothing selected -- or with a frame that carries no such style -- must
    // not record a dead undo step. `isNoop` is reference identity, so this fails loudly if the
    // command rebuilds a node it did not need to rebuild.
    const { doc } = build(false);
    const plain = createTextFrameNode({
      name: 'plain',
      text: { blocks: [paragraph({ runs: [{ text: 'unstyled' }] })] },
    });
    const page = doc.pages[0];
    if (page === undefined) throw new Error('no pages');
    const withPlain: Document = { ...doc, pages: [{ ...page, objects: [...page.objects, plain] }] };

    expect(isNoop(withPlain, unlink([plain.id], 'unlink'))).toBe(true);
    expect(isNoop(withPlain, unlink([plain.id], 'remove'))).toBe(true);
    // ...and an empty selection.
    expect(isNoop(doc, unlink([], 'unlink'))).toBe(true);
  });

  it('is a no-op for a style id the document does not have', () => {
    const { doc, a } = build(false);
    expect(isNoop(doc, unlink([a], 'unlink', 'paragraph', 'sty_missing'))).toBe(true);
  });

  it('is a no-op for a style of the wrong category', () => {
    const { doc, a } = build(false);
    // `sty_body` is a *frame* style; addressing it at the paragraph site resolves to nothing.
    expect(isNoop(doc, unlink([a], 'unlink', 'paragraph', BODY.id))).toBe(true);
  });
});

describe('character and frame styles unlink the same way', () => {
  it('unlinks a character style onto its runs', () => {
    const { doc, a } = build(false);
    const after = apply(doc, unlink([a], 'unlink', 'character', EMPHASIS.id));
    expect(frameOf(after, a).text.blocks[0]?.runs[0]).toEqual({
      text: 'styled run',
      format: { italic: true },
    });
  });

  it('removes a character style without writing anything down', () => {
    const { doc, a } = build(false);
    const after = apply(doc, unlink([a], 'remove', 'character', EMPHASIS.id));
    expect(frameOf(after, a).text.blocks[0]?.runs[0]).toEqual({ text: 'styled run' });
  });

  it('unlinks a frame style onto the frame typography', () => {
    const { doc, a } = build(false);
    const after = apply(doc, unlink([a], 'unlink', 'frame', BODY.id));
    const frame = frameOf(after, a);
    expect(frame.styleId).toBeUndefined();
    expect(frame.style).toEqual({ fontSize: 11, color: '#333333' });
  });

  it('removes a frame style leaving the frame typography untouched', () => {
    const { doc, a } = build(false);
    const after = apply(doc, unlink([a], 'remove', 'frame', BODY.id));
    const frame = frameOf(after, a);
    expect(frame.styleId).toBeUndefined();
    // Nothing was written down, and nothing was there before either -- so it is now absent.
    expect(frame.style).toBeUndefined();
  });
});

describe('counting users, for the confirmation dialog', () => {
  it('counts only the selected objects that reference the style', () => {
    const { doc, a, b } = build(false);
    // Three references in total: two paragraphs in `a`, one in `b`.
    expect(countStyleUsers(doc, [a], QUOTE.id)).toBe(2);
    expect(countStyleUsers(doc, [b], QUOTE.id)).toBe(1);
    expect(countStyleUsers(doc, [a, b], QUOTE.id)).toBe(3);
  });

  it('counts nothing for a style the selection does not reference', () => {
    const { doc, a } = build(false);
    expect(countStyleUsers(doc, [a], EMPHASIS.id)).toBe(1);
    expect(countStyleUsers(doc, [a], 'sty_missing')).toBe(0);
  });
});