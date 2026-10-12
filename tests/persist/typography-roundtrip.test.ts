/**
 * M21 §5: every typography property survives the file boundary.
 *
 * ## Why this is a unit test and not a browser test
 *
 * The claim is about a *value in a file*: does a stack of one and a half line heights come back as
 * `1.5`, and does an em letter-spacing come back as em rather than as the pixels it happened to
 * render at. A browser could only show that indirectly, through computed style, which would hide
 * exactly the bug worth catching -- a property converted from relative to absolute units survives a
 * render unchanged and only shows up the next time the font size moves.
 *
 * So each case is asserted on the **parsed document**, and where a relative unit is involved the
 * assertion is specifically that it is still relative.
 *
 * The "empty and partially formatted" cases are here rather than as an afterthought: they are where
 * canonicalisation is most likely to invent content or drop a flag, and `normalizeRichText` is the
 * code that would do it.
 */

import { describe, expect, it } from 'vitest';
import { parse } from '../../src/persist/deserialize';
import { serialize, serializeToString } from '../../src/persist/serialize';
import { documentsEqual } from '../../src/model/document-equality';
import { normalizeRichText } from '../../src/model/rich-text';
import { createDocument, createPage, createTextFrameNode } from '../../src/model/factory';
import type { Document, PageSize, ParagraphBlock, TextFrameNode } from '../../src/model/types';

const A4: PageSize = { width: 210, height: 297, unit: 'mm', orientation: 'portrait' };

function frame(style: TextFrameNode['style'], blocks: ParagraphBlock[]): TextFrameNode {
  return createTextFrameNode({
    ...(style === undefined ? {} : { style }),
    text: normalizeRichText({ blocks }),
  });
}

/** A one-frame document, so a round-trip cannot be confused with a structural difference. */
function documentWith(node: TextFrameNode): Document {
  return createDocument({
    pageSize: A4,
    pages: [{ ...createPage({ size: A4 }), objects: [node] }],
  });
}

/** Serialize then parse, returning the frame as it comes back out of the file. */
function throughFile(node: TextFrameNode): TextFrameNode {
  const bytes = serialize(documentWith(node));
  const back = parse(JSON.parse(JSON.stringify(bytes)));
  const found = back.pages[0]?.objects[0];
  if (found === undefined || found.type !== 'textFrame') throw new Error('the frame did not survive');
  return found;
}

describe('typography round-trips through the file', () => {
  it('keeps a font stack exactly as authored', () => {
    const back = throughFile(
      frame({ fontFamily: '"Times New Roman", Times, serif' }, [{ kind: 'paragraph', runs: [{ text: 'x' }] }]),
    );
    expect(back.style?.fontFamily).toBe('"Times New Roman", Times, serif');
  });

  it('keeps every frame-level property together', () => {
    const style = {
      fontFamily: 'Georgia, serif',
      fontSize: 18,
      lineHeight: 1.4,
      letterSpacing: 0.005,
      color: '#1a1a1a',
    };
    const back = throughFile(frame(style, [{ kind: 'paragraph', runs: [{ text: 'x' }] }]));
    expect(back.style).toEqual(style);
  });

  it('keeps line height unitless and letter spacing in em', () => {
    // The regression this guards is silent and one-directional: converting `1.4` to `19.2px` and
    // `0.005em` to `0.32px` would render identically today and quietly break the next time a font
    // size changed, because the values stopped being relative to anything.
    const back = throughFile(
      frame({ lineHeight: 1.4, letterSpacing: 0.005 }, [{ kind: 'paragraph', runs: [{ text: 'x' }] }]),
    );
    expect(back.style?.lineHeight).toBe(1.4);
    expect(back.style?.letterSpacing).toBe(0.005);
    expect(typeof back.style?.letterSpacing).toBe('number');
  });

  it('keeps distinct properties distinct across frames', () => {
    const a = frame({ fontFamily: 'Georgia, serif', fontSize: 12 }, [{ kind: 'paragraph', runs: [{ text: 'a' }] }]);
    const b = frame({ fontFamily: 'Courier New, monospace', fontSize: 30 }, [{ kind: 'paragraph', runs: [{ text: 'b' }] }]);
    const back = parse(
      JSON.parse(JSON.stringify(serialize({ ...documentWith(a), pages: [documentWith(a).pages[0]!, { ...documentWith(b).pages[0]!, objects: [b] }] }))),
    );
    const styles = back.pages.map((page) => (page.objects[0] as TextFrameNode).style);
    expect(styles[0]).toEqual({ fontFamily: 'Georgia, serif', fontSize: 12 });
    expect(styles[1]).toEqual({ fontFamily: 'Courier New, monospace', fontSize: 30 });
  });

  it('keeps all four character flags, and keeps them independent', () => {
    const blocks: TextFrameNode['text']['blocks'] = [
      {
        kind: 'paragraph',
        runs: [
          { text: 'b', format: { bold: true } },
          { text: 'i', format: { italic: true } },
          { text: 'u', format: { underline: true } },
          { text: 's', format: { strike: true } },
          { text: 'bi', format: { bold: true, italic: true } },
          { text: 'plain' },
        ],
      },
    ];
    const back = throughFile(frame(undefined, blocks));
    expect(back.text.blocks[0]?.runs).toEqual([
      { text: 'b', format: { bold: true } },
      { text: 'i', format: { italic: true } },
      { text: 'u', format: { underline: true } },
      { text: 's', format: { strike: true } },
      { text: 'bi', format: { bold: true, italic: true } },
      { text: 'plain' },
    ]);
  });

  it('keeps every paragraph alignment, per paragraph', () => {
    const back = throughFile(
      frame(undefined, [
        { kind: 'paragraph', runs: [{ text: 'a' }] },
        { kind: 'paragraph', align: 'center', runs: [{ text: 'b' }] },
        { kind: 'paragraph', align: 'right', runs: [{ text: 'c' }] },
        { kind: 'paragraph', align: 'justify', runs: [{ text: 'd' }] },
        { kind: 'paragraph', align: 'left', runs: [{ text: 'e' }] },
      ]),
    );
    expect(back.text.blocks.map((block) => block.align)).toEqual([
      undefined,
      'center',
      'right',
      'justify',
      'left',
    ]);
  });

  it('keeps soft line breaks inside a paragraph and paragraphs apart', () => {
    // The distinction is invisible in plain text unless it is the *only* thing distinguishing them,
    // so the case puts both in one frame: a paragraph with two soft breaks, and a following
    // paragraph. A round-trip that flattened them would produce the same string here, which is
    // precisely why the counts are asserted and not just the text.
    const back = throughFile(
      frame(undefined, [
        { kind: 'paragraph', runs: [{ text: 'one  two\nthree\nfour' }] },
        { kind: 'paragraph', runs: [{ text: 'next' }] },
      ]),
    );
    expect(back.text.blocks).toHaveLength(2);
    expect(back.text.blocks[0]?.runs[0]?.text).toBe('one  two\nthree\nfour');
    expect(back.text.blocks[1]?.runs[0]?.text).toBe('next');
  });

  it('keeps empty text as empty rather than inventing or dropping content', () => {
    const back = throughFile(frame(undefined, [{ kind: 'paragraph', runs: [{ text: '' }] }]));
    expect(back.text.blocks).toHaveLength(1);
    expect(back.text.blocks[0]?.runs).toEqual([{ text: '' }]);
  });

  it('keeps partially formatted text, including the unformatted part', () => {
    const back = throughFile(
      frame(undefined, [
        { kind: 'paragraph', runs: [{ text: 'plain ' }, { text: 'bold', format: { bold: true } }, { text: ' plain' }] },
      ]),
    );
    expect(back.text.blocks[0]?.runs).toEqual([
      { text: 'plain ' },
      { text: 'bold', format: { bold: true } },
      { text: ' plain' },
    ]);
  });

  it('does not invent a style object for a frame that has none', () => {
    const back = throughFile(frame(undefined, [{ kind: 'paragraph', runs: [{ text: 'x' }] }]));
    expect(back.style, 'an empty style object appeared in the file').toBeUndefined();
    expect(serializeToString(documentWith(back))).not.toContain('"style"');
  });
});

describe('the whole document survives, not just the frame', () => {
  it('is byte-stable across a second round-trip', () => {
    // The property that decides whether the format is stable at all: a document that re-serialises
    // differently on each pass would make every golden-file comparison flaky and every save a diff.
    const original = documentWith(
      frame(
        { fontFamily: 'Georgia, serif', fontSize: 18, lineHeight: 1.4, letterSpacing: 0.005 },
        [
          { kind: 'paragraph', align: 'center', runs: [{ text: 'a', format: { bold: true } }, { text: 'b\nc' }] },
          { kind: 'paragraph', runs: [{ text: '' }] },
        ],
      ),
    );

    const once = serializeToString(original);
    const twice = serializeToString(parse(JSON.parse(once)));
    const thrice = serializeToString(parse(JSON.parse(twice)));

    expect(twice).toBe(once);
    expect(thrice).toBe(twice);
    expect(documentsEqual(original, parse(JSON.parse(once)))).toBe(true);
  });
});
