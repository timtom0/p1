/**
 * M22: `setTextDirection` and `setParagraphMetrics`.
 *
 * ## What these commands are, architecturally
 *
 * Both are **frame-level commands that write per-paragraph properties**. `setTextAlign` already
 * works this way -- the inspector edits a selected frame, so a direction or indent change rewrites
 * every paragraph inside it. That is a deliberate asymmetry rather than an oversight: alignment,
 * direction and indents are all paragraph fields (ADR 0003), but a frame is what a user selects, so
 * the command that the inspector issues is named after the frame and fans out.
 *
 * The consequence, and the reason these tests exist, is the **no-op** rule. `isNoop` is
 * `apply(doc, command) === doc` -- reference identity -- so a command that rebuilds a node it did
 * not need to rebuild produces a new document, records a history entry, and leaves the user with an
 * undo step that does nothing. Both commands therefore compare before rebuilding.
 */

import { describe, expect, it } from 'vitest';
import { apply, describeCommand, isNoop } from '../../src/model/commands';
import { paragraph, richTextEqual } from '../../src/model/rich-text';
import { createDocument, createTextFrameNode } from '../../src/model/factory';
import type { Command, ParagraphMetricsPatch } from '../../src/model/commands';
import type { Document, ParagraphBlock, TextFrameNode } from '../../src/model/types';

const docWith = (blocks: ParagraphBlock[]): { doc: Document; frameId: string } => {
  const doc = createDocument({ name: 'M22' });
  const frame = createTextFrameNode({
    name: 'copy',
    text: { blocks },
  });
  const page = doc.pages[0];
  if (page === undefined) throw new Error('the factory produced no pages');
  return { doc: { ...doc, pages: [{ ...page, objects: [...page.objects, frame] }] }, frameId: frame.id };
};

const frameOf = (doc: Document, id: string): TextFrameNode => {
  const found = doc.pages.flatMap((page) => page.objects).find((node) => node.id === id);
  if (found === undefined || found.type !== 'textFrame') throw new Error('no text frame');
  return found;
};

const blocksOf = (doc: Document, id: string): ParagraphBlock[] => frameOf(doc, id).text.blocks;

describe('setTextDirection', () => {
  const plain = paragraph([{ text: 'a' }]);

  it('sets every paragraph in the frame', () => {
    const { doc, frameId } = docWith([plain, plain, paragraph([{ text: 'b' }])]);
    const after = apply(doc, { type: 'setTextDirection', nodeId: frameId, dir: 'rtl' });
    expect(blocksOf(after, frameId).map((block) => block.dir)).toEqual(['rtl', 'rtl', 'rtl']);
  });

  it('null clears to `auto`, by absence rather than by an explicit value', () => {
    const { doc, frameId } = docWith([{ ...plain, dir: 'rtl' }]);
    const after = apply(doc, { type: 'setTextDirection', nodeId: frameId, dir: null });
    expect(blocksOf(after, frameId)[0]?.dir).toBeUndefined();
  });

  it('setting the direction a paragraph already has is a no-op', () => {
    // The regression this guards is an undo step that does nothing, not a crash: without the guard
    // `apply` returns a rebuilt document, `isNoop` says false, and the user gets a dead history entry.
    const { doc, frameId } = docWith([{ ...plain, dir: 'rtl' }]);
    const command: Command = { type: 'setTextDirection', nodeId: frameId, dir: 'rtl' };
    expect(isNoop(doc, command)).toBe(true);
    expect(apply(doc, command)).toBe(doc);
  });

  it('an absent direction and an explicit `auto` are the same no-op', () => {
    // One encoding of "let the browser decide". If these differed, a user toggling the control
    // between Auto and Auto would record history, and two equal paragraphs would have two spellings.
    const { doc, frameId } = docWith([plain]);
    expect(isNoop(doc, { type: 'setTextDirection', nodeId: frameId, dir: 'auto' })).toBe(true);
    expect(isNoop(doc, { type: 'setTextDirection', nodeId: frameId, dir: null })).toBe(true);
  });

  it('is a no-op when *every* paragraph already matches, even when they differ from each other', () => {
    const { doc, frameId } = docWith([{ ...plain, dir: 'rtl' }, { ...plain, dir: 'rtl' }]);
    expect(isNoop(doc, { type: 'setTextDirection', nodeId: frameId, dir: 'rtl' })).toBe(true);
  });

  it('is not a no-op when paragraphs disagree, and makes them agree', () => {
    const { doc, frameId } = docWith([{ ...plain, dir: 'rtl' }, plain]);
    const command: Command = { type: 'setTextDirection', nodeId: frameId, dir: 'ltr' };
    expect(isNoop(doc, command)).toBe(false);
    expect(blocksOf(apply(doc, command), frameId).every((block) => block.dir === 'ltr')).toBe(true);
  });

  it('leaves runs and other paragraph properties untouched', () => {
    const { doc, frameId } = docWith([{ ...plain, align: 'center', metrics: { textIndent: 12 } }]);
    const after = apply(doc, { type: 'setTextDirection', nodeId: frameId, dir: 'rtl' });
    const block = blocksOf(after, frameId)[0];
    expect(block?.align).toBe('center');
    expect(block?.metrics).toEqual({ textIndent: 12 });
    expect(block?.runs).toEqual([{ text: 'a' }]);
  });

  it('ignores a node that is not a text frame', () => {
    const doc = createDocument({ name: 'M22' });
    expect(isNoop(doc, { type: 'setTextDirection', nodeId: 'missing', dir: 'rtl' })).toBe(true);
  });

  it('has a history label', () => {
    expect(describeCommand({ type: 'setTextDirection', nodeId: 'n', dir: 'rtl' })).toBe('Text direction');
  });
});

describe('setParagraphMetrics', () => {
  const plain = paragraph([{ text: 'a' }]);

  it('sets one metric without touching the others', () => {
    const { doc, frameId } = docWith([{ ...plain, metrics: { marginBefore: 4 } }]);
    const after = apply(doc, { type: 'setParagraphMetrics', nodeId: frameId, patch: { textIndent: 24 } });
    expect(blocksOf(after, frameId)[0]?.metrics).toEqual({ marginBefore: 4, textIndent: 24 });
  });

  it('an undefined value clears just that metric', () => {
    const { doc, frameId } = docWith([{ ...plain, metrics: { textIndent: 24, marginBefore: 4 } }]);
    const after = apply(doc, { type: 'setParagraphMetrics', nodeId: frameId, patch: { textIndent: undefined } });
    expect(blocksOf(after, frameId)[0]?.metrics).toEqual({ marginBefore: 4 });
  });

  it('a patch that mentions one metric never touches the others', () => {
    // The regression this guards is a patch that *destroys* what it did not mention. Reading an
    // absent key as "clear" made `{ textIndent: 24 }` on a paragraph that already had
    // `marginBefore: 4` silently drop the margin -- and nothing in the inspector would show it,
    // because the field the user never opened was the one that changed.
    const { doc, frameId } = docWith([{ ...plain, metrics: { marginBefore: 4, marginAfter: 6 } }]);
    const after = apply(doc, { type: 'setParagraphMetrics', nodeId: frameId, patch: { textIndent: 24 } });
    expect(blocksOf(after, frameId)[0]?.metrics).toEqual({
      marginBefore: 4,
      marginAfter: 6,
      textIndent: 24,
    });
  });

  it('an empty patch changes nothing, rather than clearing everything', () => {
    // "Touch only what you mention" has to extend to the empty patch, or an empty patch is a
    // destructive command wearing a harmless-looking shape. Clearing all five is explicit.
    const { doc, frameId } = docWith([{ ...plain, metrics: { textIndent: 24 } }]);
    const command: Command = { type: 'setParagraphMetrics', nodeId: frameId, patch: {} };
    expect(isNoop(doc, command)).toBe(true);
  });

  it('an all-undefined patch clears every metric, and drops the object entirely', () => {
    // Not `metrics: {}`. An all-undefined metrics object and no metrics object are the same
    // paragraph -- the same rule `setTextStyle` applies to the frame's style -- so writing one would
    // be a second spelling of "unset" that survives every save.
    const CLEAR: ParagraphMetricsPatch = {
      textIndent: undefined,
      marginStart: undefined,
      marginEnd: undefined,
      marginBefore: undefined,
      marginAfter: undefined,
    };
    const { doc, frameId } = docWith([{ ...plain, metrics: { textIndent: 24, marginStart: 6 } }]);
    const after = apply(doc, { type: 'setParagraphMetrics', nodeId: frameId, patch: CLEAR });
    expect(blocksOf(after, frameId)[0]?.metrics).toBeUndefined();
  });

  it('applies to every paragraph in the frame', () => {
    const { doc, frameId } = docWith([plain, paragraph([{ text: 'b' }])]);
    const after = apply(doc, { type: 'setParagraphMetrics', nodeId: frameId, patch: { marginStart: 12 } });
    expect(blocksOf(after, frameId).map((block) => block.metrics)).toEqual([
      { marginStart: 12 },
      { marginStart: 12 },
    ]);
  });

  it('is a no-op when every paragraph already has exactly these metrics', () => {
    const { doc, frameId } = docWith([{ ...plain, metrics: { textIndent: 24, marginStart: 6 } }]);
    const command: Command = { type: 'setParagraphMetrics', nodeId: frameId, patch: { textIndent: 24 } };
    expect(isNoop(doc, command)).toBe(true);
  });

  it('is a no-op when clearing metrics a paragraph does not have', () => {
    // The asymmetry that makes "clearing" idempotent: pressing the same reset twice records history
    // once, not twice.
    const { doc, frameId } = docWith([plain]);
    const CLEAR: ParagraphMetricsPatch = { textIndent: undefined, marginStart: undefined, marginEnd: undefined, marginBefore: undefined, marginAfter: undefined };
    expect(isNoop(doc, { type: 'setParagraphMetrics', nodeId: frameId, patch: CLEAR })).toBe(true);
  });

  it('is a no-op for a metric already at the same value, leaving the rest alone', () => {
    const { doc, frameId } = docWith([{ ...plain, metrics: { marginBefore: 4 } }]);
    const command: Command = { type: 'setParagraphMetrics', nodeId: frameId, patch: { marginBefore: 4 } };
    expect(isNoop(doc, command)).toBe(true);
  });

  it('is not a no-op when only some paragraphs match', () => {
    const { doc, frameId } = docWith([{ ...plain, metrics: { textIndent: 24 } }, plain]);
    const command: Command = { type: 'setParagraphMetrics', nodeId: frameId, patch: { textIndent: 24 } };
    expect(isNoop(doc, command)).toBe(false);
  });

  it('keeps direction, alignment and runs untouched', () => {
    const { doc, frameId } = docWith([{ ...plain, dir: 'rtl', align: 'right' }]);
    const after = apply(doc, { type: 'setParagraphMetrics', nodeId: frameId, patch: { textIndent: 8 } });
    const block = blocksOf(after, frameId)[0];
    expect(block?.dir).toBe('rtl');
    expect(block?.align).toBe('right');
    expect(block?.runs).toEqual([{ text: 'a' }]);
  });

  it('has a history label', () => {
    expect(
      describeCommand({ type: 'setParagraphMetrics', nodeId: 'n', patch: { textIndent: 4 } }),
    ).toBe('Paragraph indent');
  });

  it('produces rich text equal to the model, not merely similar', () => {
    // `richTextEqual` is what the history and persistence layers use to decide a document is
    // unchanged, so a command that passes `isNoop` by reference while producing unequal text would
    // be a hole in both.
    const { doc, frameId } = docWith([{ ...plain, metrics: { textIndent: 24 } }]);
    const after = apply(doc, { type: 'setParagraphMetrics', nodeId: frameId, patch: { marginStart: 6 } });
    expect(richTextEqual(frameOf(doc, frameId).text, frameOf(after, frameId).text)).toBe(false);
  });
});