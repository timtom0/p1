/**
 * M23: the style commands, and the semantics the milestone is built on.
 *
 * ## What this file is really about
 *
 * **One transaction.** `deleteStyle` returns a *batch command*, so deleting a style that many
 * paragraphs and runs reference is one history entry. The tests below assert the batch shape rather
 * than trusting it, because "it is one undo step" is a claim about how a user experiences it, and a
 * fixture that happens to have three references proves nothing about a document with three hundred.
 *
 * **Remove and unlink do different things.** The worked example is M23's own: a paragraph style
 * provides centred alignment, RTL direction and a 12px start indent. After *remove* the paragraph
 * loses all three and has nothing written down in their place; after *unlink* it keeps all three as
 * direct formatting. Both are asserted from the same starting document, because the interesting part
 * is that they differ and neither is "the" operation.
 *
 * **A delete must not disturb references it was not asked about.** Clearing every `styleId` would be
 * the easy version and would silently unstyle the frame and the character style along with it.
 */

import { describe, expect, it } from 'vitest';
import { apply, describeCommand, isNoop } from '../../src/model/commands';
import { History } from '../../src/editor/history';
import { applyDeleteStyle, deleteStyleCommand, newStyleId } from '../../src/model/style-commands';
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

const ALL = [QUOTE, EMPHASIS, BODY];

const paragraph = (extra: Partial<ParagraphBlock> = {}): ParagraphBlock => ({
  kind: 'paragraph',
  runs: [{ text: 'Hello' }],
  ...extra,
});

/**
 * One text frame holding: two styled paragraphs, one styled run, one plain paragraph, and a styled
 * frame. Three categories in one document, because "deleting one style must not touch the others" is
 * only testable when they are all present.
 */
const styled = (styles: readonly StyleDefinition[]): { doc: Document; frameId: string } => {
  const doc = createDocument({ name: 'M23', styles: [...styles] });
  const frame = createTextFrameNode({
    name: 'copy',
    styleId: BODY.id,
    text: {
      blocks: [
        paragraph({ styleId: QUOTE.id, runs: [{ text: 'inherits everything' }] }),
        paragraph({ styleId: QUOTE.id, runs: [{ text: 'second' }] }),
        paragraph({ runs: [{ text: 'styled run', styleId: EMPHASIS.id }] }),
        paragraph({ runs: [{ text: 'plain' }] }),
      ],
    },
  });
  const page = doc.pages[0];
  if (page === undefined) throw new Error('the factory produced no pages');
  return {
    doc: { ...doc, pages: [{ ...page, objects: [...page.objects, frame] }] },
    frameId: frame.id,
  };
};

/** The same fixture with a direct override the style does not supply, for the remove/unlink pair. */
const withOverride = (): { doc: Document; frameId: string } => {
  const doc = createDocument({ name: 'M23', styles: [...ALL] });
  const frame = createTextFrameNode({
    name: 'copy',
    styleId: BODY.id,
    // The frame's own blue, which the style does not set: the M23 worked example's direct override.
    style: { color: '#0000ff' },
    text: { blocks: [paragraph({ styleId: QUOTE.id, runs: [{ text: 'Hello' }] })] },
  });
  const page = doc.pages[0];
  if (page === undefined) throw new Error('the factory produced no pages');
  return {
    doc: { ...doc, pages: [{ ...page, objects: [...page.objects, frame] }] },
    frameId: frame.id,
  };
};

const frameOf = (doc: Document, id: string): TextFrameNode => {
  const node = doc.pages.flatMap((page) => page.objects).find((candidate) => candidate.id === id);
  if (node === undefined || node.type !== 'textFrame') throw new Error('no text frame');
  return node;
};

const blocksOf = (doc: Document, id: string): ParagraphBlock[] => frameOf(doc, id).text.blocks;

describe('creating, renaming and updating a definition', () => {
  it('adds a definition without touching any object', () => {
    const { doc } = styled([]);
    const after = apply(doc, { type: 'addStyle', style: { ...QUOTE, id: newStyleId() } });
    expect(after.styles).toHaveLength(1);
    // Adding a definition changes nothing that references anything -- there is nothing yet, and the
    // point is that it stays that way.
    expect(after.pages).toEqual(doc.pages);
  });

  it('a minted id is fresh and does not collide with the fixture ids', () => {
    // Minted through the same factory as every other object, so `resetIds` in the test suite keeps
    // working and a style id is indistinguishable in provenance from a node id.
    expect(newStyleId()).not.toBe(QUOTE.id);
    expect(newStyleId()).not.toBe(newStyleId());
  });

  it('renaming changes the name and nothing else', () => {
    const { doc } = styled(ALL);
    const after = apply(doc, { type: 'renameStyle', id: QUOTE.id, name: 'Pull quote' });
    const renamed = after.styles.find((style) => style.id === QUOTE.id);
    expect(renamed?.name).toBe('Pull quote');
    // The id is the identity. A rename that minted a new one would dangle every reference, which is
    // exactly what the spec forbids.
    expect(renamed?.id).toBe(QUOTE.id);
  });

  it('renaming to the same name is a no-op, so no history is recorded for a keystroke', () => {
    const { doc, frameId } = styled(ALL);
    const command: Command = { type: 'renameStyle', id: QUOTE.id, name: QUOTE.name };
    expect(isNoop(doc, command)).toBe(true);
    expect(blocksOf(apply(doc, command), frameId)[0]?.styleId).toBe(QUOTE.id);
  });

  it('renaming to an empty name is refused rather than applied', () => {
    const { doc } = styled(ALL);
    // An empty label is not a name, and accepting one would put a style in the UI that reads as
    // nothing. Refused as a no-op, so no history entry either.
    expect(isNoop(doc, { type: 'renameStyle', id: QUOTE.id, name: '   ' })).toBe(true);
  });

  it('two styles may share a name, because ids are the identity', () => {
    // Deliberate. Refusing it would make a constraint the model does not have, and would stop the
    // user renaming a style to something they can read.
    const { doc } = styled(ALL);
    const after = apply(doc, { type: 'renameStyle', id: EMPHASIS.id, name: QUOTE.name });
    expect(after.styles.filter((style) => style.name === QUOTE.name)).toHaveLength(2);
  });

  it('editing a definition replaces it and reaches every user on the next resolve', () => {
    const { doc, frameId } = styled(ALL);
    const after = apply(doc, {
      type: 'updateStyle',
      id: QUOTE.id,
      style: { ...QUOTE, paragraph: { align: 'right', metrics: { marginStart: 30 } } },
    });
    const block = blocksOf(after, frameId)[0];
    expect(block?.styleId, 'the reference was disturbed by an edit').toBe(QUOTE.id);
    // The point of a live reference: the definition moved and the object's *own* values did not.
    // `updateStyle` **replaces**, so a property the new definition omits is genuinely gone. Asserting
    // the opposite would have been a test that pinned merge semantics the command does not have --
    // and merge would be wrong here, because a category change has to be expressible.
    expect(effectiveParagraphProps(after.styles, block!)).toEqual({
      align: 'right',
      metrics: { marginStart: 30 },
    });
  });

  it('every style command has a history label that says what it did', () => {
    expect(describeCommand({ type: 'addStyle', style: QUOTE })).toBe('Create style Quote');
    expect(describeCommand({ type: 'renameStyle', id: 'x', name: 'y' })).toBe('Rename style');
    expect(describeCommand({ type: 'applyStyle', ids: [], category: 'frame', styleId: 'x' })).toBe(
      'Apply style',
    );
    expect(describeCommand({ type: 'applyStyle', ids: [], category: 'frame', styleId: null })).toBe(
      'Remove style',
    );
    expect(describeCommand({ type: 'deleteStyle', id: 'x', mode: 'remove' })).toBe('Delete style');
    expect(describeCommand({ type: 'deleteStyle', id: 'x', mode: 'unlink' })).toBe(
      'Unlink style and delete',
    );
  });
});

describe('applying a style writes only the site its category owns', () => {
  it('a paragraph style to a frame lands on every paragraph, converging them', () => {
    const { doc, frameId } = styled(ALL);
    const after = apply(doc, {
      type: 'applyStyle',
      ids: [frameId],
      category: 'paragraph',
      styleId: QUOTE.id,
    });
    // Every paragraph, including the two that referenced nothing: applying to a frame means applying
    // to each paragraph, because that is where the reference lives.
    expect(blocksOf(after, frameId).map((block) => block.styleId)).toEqual([
      QUOTE.id,
      QUOTE.id,
      QUOTE.id,
      QUOTE.id,
    ]);
  });

  it('a character style to a frame lands on every run', () => {
    const { doc, frameId } = styled(ALL);
    const after = apply(doc, {
      type: 'applyStyle',
      ids: [frameId],
      category: 'character',
      styleId: EMPHASIS.id,
    });
    expect(blocksOf(after, frameId)[0]?.runs[0]?.styleId).toBe(EMPHASIS.id);
  });

  it('a frame style reaches only the frame', () => {
    const { doc, frameId } = styled(ALL);
    const after = apply(doc, {
      type: 'applyStyle',
      ids: [frameId],
      category: 'frame',
      styleId: BODY.id,
    });
    expect(frameOf(after, frameId).styleId).toBe(BODY.id);
    // ...and not the paragraphs or the runs, because the three sites are separate.
    expect(blocksOf(after, frameId)[0]?.styleId).toBe(QUOTE.id);
  });

  it('an id of the wrong category is refused rather than written', () => {
    const { doc, frameId } = styled(ALL);
    // Writing it would put a reference in the document that nothing can resolve -- invisible until
    // someone tried to unlink it.
    expect(
      isNoop(doc, { type: 'applyStyle', ids: [frameId], category: 'character', styleId: QUOTE.id }),
    ).toBe(true);
    expect(
      isNoop(doc, { type: 'applyStyle', ids: [frameId], category: 'frame', styleId: 'sty_missing' }),
    ).toBe(true);
  });

  it('re-applying the style a frame already has is a no-op', () => {
    const { doc, frameId } = styled(ALL);
    expect(
      isNoop(doc, { type: 'applyStyle', ids: [frameId], category: 'frame', styleId: BODY.id }),
    ).toBe(true);
  });

  it('applying one style over another replaces the reference and keeps the text', () => {
    const { doc, frameId } = styled([...ALL, { ...QUOTE, id: 'sty_alt', paragraph: { align: 'right' } }]);
    const after = apply(doc, {
      type: 'applyStyle',
      ids: [frameId],
      category: 'paragraph',
      styleId: 'sty_alt',
    });
    const block = blocksOf(after, frameId)[0];
    expect(block?.styleId).toBe('sty_alt');
    // Applying a style is not a reformat: the text survives, and so do any direct values.
    expect(block?.runs[0]?.text).toBe('inherits everything');
  });

  it('applies to every object in a multi-selection as one command', () => {
    const base = styled(ALL);
    const second = createTextFrameNode({
      name: 'second',
      text: { blocks: [paragraph({ runs: [{ text: 'other' }] })] },
    });
    const page = base.doc.pages[0];
    if (page === undefined) throw new Error('no pages');
    const withTwo: Document = {
      ...base.doc,
      pages: [{ ...page, objects: [...page.objects, second] }],
    };
    const after = apply(withTwo, {
      type: 'applyStyle',
      ids: [base.frameId, second.id],
      category: 'frame',
      styleId: BODY.id,
    });
    expect(frameOf(after, base.frameId).styleId).toBe(BODY.id);
    expect(frameOf(after, second.id).styleId).toBe(BODY.id);
  });
});

describe('remove style and unlink style are different operations', () => {
  it('remove drops the reference and keeps every direct value', () => {
    const { doc, frameId } = withOverride();
    const after = apply(doc, {
      type: 'applyStyle',
      ids: [frameId],
      category: 'paragraph',
      styleId: null,
    });
    const block = blocksOf(after, frameId)[0];
    expect(block?.styleId, 'the reference survived').toBeUndefined();
    // The frame's own blue is untouched -- it belongs to the frame, not to the paragraph.
    expect(frameOf(after, frameId).style).toEqual({ color: '#0000ff' });
    // And the definition itself is untouched: removing a style *from an object* is not deleting it.
    expect(after.styles.map((style) => style.id)).toEqual([QUOTE.id, EMPHASIS.id, BODY.id]);
  });

  it('remove leaves inherited properties genuinely gone rather than frozen', () => {
    const { doc, frameId } = withOverride();
    const after = apply(doc, {
      type: 'applyStyle',
      ids: [frameId],
      category: 'paragraph',
      styleId: null,
    });
    const block = blocksOf(after, frameId)[0];
    // Nothing was copied down. That is the whole difference from unlink, and the reason `remove`
    // makes the document *smaller* rather than larger.
    expect(block?.align, 'an inherited alignment was frozen').toBeUndefined();
    expect(block?.dir, 'an inherited direction was frozen').toBeUndefined();
    expect(block?.metrics, 'inherited metrics were frozen').toBeUndefined();
    // And with the reference gone, they really do resolve to nothing.
    expect(effectiveParagraphProps(after.styles, block!)).toEqual({});
  });

  it('unlink writes the effective values down and then drops the reference', () => {
    const { doc, frameId } = withOverride();
    const after = applyDeleteStyle(doc, QUOTE.id, 'unlink');
    const block = blocksOf(after, frameId)[0];
    expect(block?.styleId).toBeUndefined();
    expect(block?.align).toBe('center');
    expect(block?.dir).toBe('rtl');
    expect(block?.metrics).toEqual({ marginStart: 12 });
    // The direct colour is untouched: neither operation touches what it did not inherit.
    expect(frameOf(after, frameId).style).toEqual({ color: '#0000ff' });
  });

  it('unlink does not flatten a property the object had already overridden', () => {
    const doc = createDocument({ name: 'M23', styles: [...ALL] });
    const frame = createTextFrameNode({
      name: 'copy',
      text: {
        blocks: [
          paragraph({
            styleId: QUOTE.id,
            // Its own alignment, which the style also sets.
            align: 'justify',
            runs: [{ text: 'Hello' }],
          }),
        ],
      },
    });
    const page = doc.pages[0];
    if (page === undefined) throw new Error('no pages');
    const withTwo: Document = { ...doc, pages: [{ ...page, objects: [frame] }] };

    const after = applyDeleteStyle(withTwo, QUOTE.id, 'unlink');
    const block = blocksOf(after, frame.id)[0];
    // `justify`, not the style's `center`. `effectiveParagraphProps` resolves each property to the
    // overriding value, so writing the result back preserves the override rather than replacing it.
    expect(block?.align).toBe('justify');
    // ...while the properties it did *not* override come down from the style.
    expect(block?.dir).toBe('rtl');
  });

  it('the two operations produce different documents from the same starting point', () => {
    const { doc, frameId } = withOverride();
    const removed = apply(doc, {
      type: 'applyStyle',
      ids: [frameId],
      category: 'paragraph',
      styleId: null,
    });
    const unlinked = applyDeleteStyle(doc, QUOTE.id, 'unlink');

    expect(blocksOf(removed, frameId)[0]?.metrics).toBeUndefined();
    expect(blocksOf(unlinked, frameId)[0]?.metrics).toEqual({ marginStart: 12 });
    // Same direct colour in both: neither operation touches what it did not inherit.
    expect(frameOf(removed, frameId).style).toEqual(frameOf(unlinked, frameId).style);
  });

  it('a property override does not disturb the reference', () => {
    const { doc, frameId } = withOverride();
    const after = apply(doc, {
      type: 'setStyleOverride',
      ids: [frameId],
      category: 'paragraph',
      key: 'marginStart',
      value: 40,
    });
    const block = blocksOf(after, frameId)[0];
    expect(block?.metrics).toEqual({ marginStart: 40 });
    expect(block?.styleId, 'the reference was lost by an override').toBe(QUOTE.id);
    // The style's other properties are still inherited, which is the entire promise.
    expect(effectiveParagraphProps(after.styles, block!)).toEqual({
      align: 'center',
      dir: 'rtl',
      metrics: { marginStart: 40 },
    });
  });

  it('clearing an override restores the inherited value and keeps the reference', () => {
    const { doc, frameId } = withOverride();
    const overridden = apply(doc, {
      type: 'setStyleOverride',
      ids: [frameId],
      category: 'paragraph',
      key: 'marginStart',
      value: 40,
    });
    const cleared = apply(overridden, {
      type: 'setStyleOverride',
      ids: [frameId],
      category: 'paragraph',
      key: 'marginStart',
      value: null,
    });
    const block = blocksOf(cleared, frameId)[0];
    expect(block?.styleId, 'clearing an override dropped the reference').toBe(QUOTE.id);
    expect(block?.metrics, 'the override was not cleared').toBeUndefined();
    // Back to inheriting the style's 12.
    expect(effectiveParagraphProps(cleared.styles, block!).metrics).toEqual({ marginStart: 12 });
  });

  it('setting an override to the value it already has is a no-op', () => {
    const { doc, frameId } = withOverride();
    expect(
      isNoop(doc, {
        type: 'setStyleOverride',
        ids: [frameId],
        category: 'paragraph',
        key: 'marginStart',
        value: 12,
      }),
      'the inherited value was mistaken for an authored one',
    ).toBe(false);
    // Twice the same value *is* a no-op, which is what a keystroke that re-enters a number needs.
    const twice = apply(doc, {
      type: 'setStyleOverride',
      ids: [frameId],
      category: 'paragraph',
      key: 'marginStart',
      value: 40,
    });
    expect(
      isNoop(twice, {
        type: 'setStyleOverride',
        ids: [frameId],
        category: 'paragraph',
        key: 'marginStart',
        value: 40,
      }),
    ).toBe(true);
  });

  it('a character override sets the flag and leaves the style reference alone', () => {
    const { doc, frameId } = styled(ALL);
    const after = apply(doc, {
      type: 'setStyleOverride',
      ids: [frameId],
      category: 'character',
      key: 'bold',
      value: true,
    });
    expect(blocksOf(after, frameId)[2]?.runs[0]).toEqual({
      text: 'styled run',
      format: { bold: true },
      styleId: EMPHASIS.id,
    });
  });

  it('a key the category does not have is refused rather than stored', () => {
    const { doc, frameId } = styled(ALL);
    // `align` is not a character property and `bold` is not a paragraph property. Accepting either
    // would put a key in the model that the renderer has no way to honour.
    expect(
      isNoop(doc, {
        type: 'setStyleOverride',
        ids: [frameId],
        category: 'character',
        key: 'align',
        value: 'center',
      }),
    ).toBe(true);
    expect(
      isNoop(doc, {
        type: 'setStyleOverride',
        ids: [frameId],
        category: 'paragraph',
        key: 'bold',
        value: true,
      }),
    ).toBe(true);
  });
});

describe('deleting a definition', () => {
  // One fixture, read through both halves. Two helpers each calling `styled` would mint a *different*
  // frame id for every call -- and then every lookup would quietly fail to find its frame.
  const fixture = styled(ALL);
  const doc = () => fixture.doc;
  const id = () => fixture.frameId;

  it('is one batched command, whatever the reference count', () => {
    // The requirement stated as architecture: one coherent undo step rather than a parade of tiny
    // mutations. Asserted on the command's shape, because that is what determines the history depth
    // -- and a fixture with three references proves nothing about a document with three hundred.
    const command = deleteStyleCommand(QUOTE.id, 'remove');
    expect(command.type).toBe('batch');
    if (command.type !== 'batch') throw new Error('unreachable');
    expect(command.cmds).toHaveLength(1);
    expect(command.cmds[0]?.type).toBe('deleteStyle');
  });

  it('remove leaves no dangling reference anywhere', () => {
    const after = applyDeleteStyle(doc(), QUOTE.id, 'remove');
    expect(after.styles.map((style) => style.id)).toEqual([EMPHASIS.id, BODY.id]);
    expect(blocksOf(after, id()).some((block) => block.styleId === QUOTE.id)).toBe(false);
  });

  it('unlink leaves no dangling reference either, and preserves the appearance', () => {
    const after = applyDeleteStyle(doc(), QUOTE.id, 'unlink');
    expect(blocksOf(after, id()).some((block) => block.styleId === QUOTE.id)).toBe(false);
    // Only the paragraphs that *referenced* the style. The other two never did, so they correctly
    // resolve to nothing -- and asserting on all four would have hidden that distinction.
    const styled = blocksOf(after, id()).filter((block) => block.align === 'center');
    expect(styled).toHaveLength(2);
    for (const block of styled) {
      expect(effectiveParagraphProps(after.styles, block)).toEqual({
        align: 'center',
        dir: 'rtl',
        metrics: { marginStart: 12 },
      });
    }
  });

  it('deletes only the style it was given, and only its references', () => {
    // Clearing every `styleId` would be the easy version, and would silently unstyle the frame and
    // the character style along with it.
    const after = applyDeleteStyle(doc(), QUOTE.id, 'remove');
    const frameId = id();
    expect(after.styles.map((style) => style.id)).toEqual([EMPHASIS.id, BODY.id]);
    expect(frameOf(after, frameId).styleId, 'the frame style was disturbed').toBe(BODY.id);
    expect(blocksOf(after, frameId)[2]?.runs[0]?.styleId, 'the character style was disturbed').toBe(
      EMPHASIS.id,
    );
  });

  it('preserves the text of every affected paragraph', () => {
    const base = doc();
    const frameId = id();
    const before = blocksOf(base, frameId).map((block) => block.runs[0]?.text);
    for (const mode of ['remove', 'unlink'] as const) {
      expect(blocksOf(applyDeleteStyle(base, QUOTE.id, mode), frameId).map((b) => b.runs[0]?.text)).toEqual(
        before,
      );
    }
  });

  it('unlinking a character style writes its flags down as direct formatting', () => {
    const after = applyDeleteStyle(doc(), EMPHASIS.id, 'unlink');
    expect(blocksOf(after, id())[2]?.runs[0]).toEqual({ text: 'styled run', format: { italic: true } });
  });

  it('removing a character style writes nothing down', () => {
    const after = applyDeleteStyle(doc(), EMPHASIS.id, 'remove');
    expect(blocksOf(after, id())[2]?.runs[0]).toEqual({ text: 'styled run' });
  });

  it('deleting a style nothing references removes only the definition', () => {
    const orphan: StyleDefinition = { ...QUOTE, id: 'sty_orphan' };
    const withOrphan = apply(doc(), { type: 'addStyle', style: orphan });
    const after = applyDeleteStyle(withOrphan, orphan.id, 'remove');
    expect(after.styles.map((style) => style.id)).toEqual([QUOTE.id, EMPHASIS.id, BODY.id]);
    expect(after.pages).toEqual(withOrphan.pages);
  });

  it('deleting a style that does not exist is a no-op', () => {
    expect(isNoop(doc(), { type: 'deleteStyle', id: 'sty_missing', mode: 'remove' })).toBe(true);
  });

it('undo restores the definition and every reference, exactly', () => {
    // Driven through the **real** `History`, not by inspecting the before-state, because the claim
    // is about what the user gets back and "the before document still looks right" is not the same
    // claim -- it would pass even if the history entry never captured the references.
    //
    // Deep equality against the original, rather than a check that the values happen to look the
    // same: that difference is the point. A reconstruction which merely looked equivalent would let a
    // later edit behave differently from one made before the deletion ever happened.
    for (const mode of ['remove', 'unlink'] as const) {
      const base = doc();
      const history = new History();
      const { doc: deleted, changed } = history.dispatch(base, deleteStyleCommand(QUOTE.id, mode));

      expect(changed, `mode ${mode} recorded no history`).toBe(true);
      expect(deleted.styles.some((style) => style.id === QUOTE.id), 'the style survived deletion').toBe(
        false,
      );

      const undone = history.undo(deleted);
      // One step. The whole point of the batched command: `depth` would be far larger if each
      // referencing object had its own entry.
      expect(history.canUndo, 'a second undo step was needed').toBe(false);
      expect(undone.styles.find((style) => style.id === QUOTE.id), 'undo lost the definition').toEqual(
        QUOTE,
      );
      expect(undone).toEqual(base);
      expect(blocksOf(undone, id())[0]?.styleId).toBe(QUOTE.id);

      // And redo puts it back to exactly the deleted state, so a second edit on top of the undone
      // document behaves the same as it did before the deletion ever happened.
      expect(history.redo(undone)).toEqual(deleted);
    }
  });

  it('re-deleting an already-deleted style is a no-op rather than an error', () => {
    // The follow-up edit the spec cares about: after undoing a delete and redoing other work, a
    // second delete must behave like the first did.
    const base = doc();
    const deleted = applyDeleteStyle(base, QUOTE.id, 'remove');
    expect(isNoop(deleted, { type: 'deleteStyle', id: QUOTE.id, mode: 'remove' })).toBe(true);
  });
});
