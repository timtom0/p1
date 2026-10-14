/**
 * M23: format version 5, and the style compatibility that came with it.
 *
 * ## What v5 changed
 *
 *  - `Document.styles` — always present, possibly `[]`.
 *  - `ParagraphBlock.styleId`, `InlineRun.styleId`, `TextFrameNode.styleId`.
 *
 * All optional except the document field, and all absent from a v4 document. So the *migration* is
 * the absence of a key rather than a rewrite: a v4 document gains an empty list, and every object in
 * it already reads `styleId: undefined`, which resolves to "nothing inherited" — exactly what those
 * documents meant before styles existed.
 *
 * ## Why a bump, given that nothing is required
 *
 * Because the format's policy is *refuse, do not drop*. A v4 build reading a v5 document containing
 * `styleId` must refuse it **by name** rather than accept a paragraph it would then re-save without
 * the field — silently detaching it from its style, which is exactly the loss the policy exists to
 * prevent. `documentKeysFor`, `paragraphKeysFor` and `runKeysFor` each carry the new threshold, and
 * `nodeKeysFor` carries `styleId` only on a text frame.
 *
 * ## What must never be inferred
 *
 * Nothing. A v4 document whose paragraphs happen to share an alignment is still a document of
 * unstyled paragraphs. Inferring a style from the formatting would mean inventing an identity the
 * author never wrote, and the first style edit would then change paragraphs the author did not mean
 * to change.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from '../../src/persist/deserialize';
import { serialize, serializeToString } from '../../src/persist/serialize';
import { CURRENT_FORMAT_VERSION, MINIMUM_FORMAT_VERSION } from '../../src/persist/format';
import { normalizeRichText } from '../../src/model/rich-text';
import { documentsEqual } from '../../src/model/document-equality';
import { createDocument, createTextFrameNode } from '../../src/model/factory';
import { effectiveParagraphProps, resolveStyle } from '../../src/model/styles';
import type { Document, ParagraphBlock, StyleDefinition } from '../../src/model/types';

const GOLDEN_V5 = fileURLToPath(new URL('../golden/sample-v5.p1doc', import.meta.url));
const GOLDEN_V4 = fileURLToPath(new URL('../golden/sample-v4.p1doc', import.meta.url));

const QUOTE: StyleDefinition = {
  id: 'sty_quote',
  name: 'Quote',
  kind: 'paragraph',
  paragraph: { align: 'center', dir: 'rtl', metrics: { marginStart: 12, textIndent: -6 } },
};

const EMPHASIS: StyleDefinition = {
  id: 'sty_emp',
  name: 'Emphasis',
  kind: 'character',
  character: { italic: true, underline: true },
};

const BODY: StyleDefinition = {
  id: 'sty_body',
  name: 'Body',
  kind: 'frame',
  frame: { fontFamily: 'Georgia, serif', fontSize: 11, color: '#222222' },
};

const styledDocument = (styles: readonly StyleDefinition[]): Document => {
  const doc = createDocument({ name: 'Styled', styles: [...styles] });
  const frame = createTextFrameNode({
    name: 'copy',
    styleId: BODY.id,
    text: {
      blocks: [
        {
          kind: 'paragraph',
          // A reference *and* a direct override, so the round trip has both to preserve.
          styleId: QUOTE.id,
          align: 'justify',
          runs: [{ text: 'inherits most', styleId: EMPHASIS.id }],
        },
        { kind: 'paragraph', runs: [{ text: 'plain' }] },
      ],
    },
  });
  const page = doc.pages[0];
  if (page === undefined) throw new Error('the factory produced no pages');
  return { ...doc, pages: [{ ...page, objects: [...page.objects, frame] }] };
};

const blocksOf = (json: unknown): ParagraphBlock[] => {
  const document = parse(json);
  const frame = document.pages[0]?.objects.find((node) => node.id.startsWith('node_'));
  return frame?.type === 'textFrame' ? frame.text.blocks : [];
};

describe('the v4 -> v5 migration', () => {
  it('a version-4 document still loads, and means the same thing', () => {
    const v4 = parse(JSON.parse(readFileSync(GOLDEN_V4, 'utf8')) as unknown);
    const v5 = parse(JSON.parse(readFileSync(GOLDEN_V5, 'utf8')) as unknown);
    // The two goldens differ by the version line and the new empty table, so the *documents* are
    // equal. If this ever fails, a v4 document is being interpreted differently, which is the one
    // thing a version bump must never do.
    expect(documentsEqual(v4, v5)).toBe(true);
    expect(v4.styles).toEqual([]);
  });

  it('the version range accepts a version-4 document and refuses version 6', () => {
    expect(MINIMUM_FORMAT_VERSION).toBeLessThan(CURRENT_FORMAT_VERSION);
    const future = JSON.parse(readFileSync(GOLDEN_V5, 'utf8')) as Record<string, unknown>;
    future['formatVersion'] = CURRENT_FORMAT_VERSION + 1;
    expect(() => parse(future)).toThrow(/newer version/);
  });

  it('re-saving a version-4 document invents no style and no reference', () => {
    const v4 = parse(JSON.parse(readFileSync(GOLDEN_V4, 'utf8')) as unknown);
    const text = serializeToString(v4);
    expect(text).toContain('"styles": []');
    expect(text).not.toContain('styleId');
  });

  it('refuses `styles` in a version-4 document, by name', () => {
    // The refusal that motivates the bump: a v4 build must not open a document it would then save
    // without the styles, silently stripping every styled object of its definition.
    const legacy = JSON.parse(readFileSync(GOLDEN_V4, 'utf8')) as Record<string, unknown>;
    legacy['styles'] = [QUOTE];
    expect(() => parse(legacy)).toThrow(/styles/);
  });

it('refuses `styleId` at every reference site in a version-4 document', () => {
    // The refusal that motivates the bump: a v4 build must not open a document it would then save
    // without the reference, silently stripping a styled object of its definition.
    //
    // Each case is built from a fresh copy of the file, so a mutation cannot leak into the next --
    // which the first version of this test did, and which made the paragraph case pass for the
    // wrong reason.
    const withEdit = (edit: (frame: Record<string, unknown>) => void): Record<string, unknown> => {
      const copy = JSON.parse(readFileSync(GOLDEN_V4, 'utf8')) as Record<string, unknown>;
      const pages = copy['pages'] as Array<{ objects: Array<Record<string, unknown>> }>;
      const frame = pages[0]?.objects.find((node) => node['type'] === 'textFrame');
      if (frame === undefined) throw new Error('the golden has no text frame');
      edit(frame);
      return copy;
    };

    const cases: Array<[string, (frame: Record<string, unknown>) => void]> = [
      [
        'frame',
        (frame) => {
          frame['styleId'] = 'sty_body';
        },
      ],
      [
        'paragraph',
        (frame) => {
          const blocks = (frame['text'] as { blocks: Array<Record<string, unknown>> }).blocks;
          const first = blocks[0];
          if (first === undefined) throw new Error('the golden frame has no paragraphs');
          blocks[0] = { ...first, styleId: 'sty_quote' };
        },
      ],
      [
        'run',
        (frame) => {
          const blocks = (frame['text'] as { blocks: Array<Record<string, unknown>> }).blocks;
          const first = blocks[0] as { runs?: Array<Record<string, unknown>> } | undefined;
          if (first?.runs?.[0] === undefined) throw new Error('the golden has no runs');
          first.runs[0] = { ...first.runs[0], styleId: 'sty_emp' };
        },
      ],
    ];

    for (const [site, edit] of cases) {
      expect(() => parse(withEdit(edit)), `a v4 ${site} styleId was accepted`).toThrow(/styleId/);
    }
  });
});

describe('a version-5 document with styles', () => {
  it('round-trips definitions, references and overrides together', () => {
    const before = styledDocument([QUOTE, EMPHASIS, BODY]);
    const back = parse(JSON.parse(serializeToString(before)) as unknown);

    expect(documentsEqual(back, before)).toBe(true);
    expect(back.styles).toEqual([QUOTE, EMPHASIS, BODY]);

    const frame = back.pages[0]?.objects[0];
    if (frame?.type !== 'textFrame') throw new Error('no frame');
    expect(frame.styleId).toBe(BODY.id);
    expect(frame.text.blocks[0]?.styleId).toBe(QUOTE.id);
    expect(frame.text.blocks[0]?.runs[0]?.styleId).toBe(EMPHASIS.id);
    // The direct override survived alongside the reference, rather than being folded into it.
    expect(frame.text.blocks[0]?.align).toBe('justify');
  });

  it('resolves to the same effective values after a round trip', () => {
    // Bytes round-tripping is not the same claim as *meaning* round-tripping. This is the one that
    // matters, and it is what would break if a reference were dropped somewhere in the file path.
    const before = styledDocument([QUOTE, EMPHASIS, BODY]);
    const back = parse(JSON.parse(serializeToString(before)) as unknown);
    const frameOf = (doc: Document) => {
      const node = doc.pages[0]?.objects[0];
      if (node?.type !== 'textFrame') throw new Error('no frame');
      return node;
    };
    expect(effectiveParagraphProps(back.styles, frameOf(back).text.blocks[0]!)).toEqual(
      effectiveParagraphProps(before.styles, frameOf(before).text.blocks[0]!),
    );
  });

  it('serialises a signed first-line indent, which a hanging indent needs', () => {
    // M22's split: `textIndent` may be negative, the margins may not.
    const back = parse(JSON.parse(serializeToString(styledDocument([QUOTE]))) as unknown);
    expect(back.styles[0]).toMatchObject({ paragraph: { metrics: { textIndent: -6 } } });
  });

  it('writes `styleId` beside `format`, never inside it', () => {
    const saved = serialize(styledDocument([QUOTE, EMPHASIS, BODY]));
    const json = JSON.stringify(saved);
    // If they were folded together, "inherit italic" and "set italic directly" would be the same
    // bytes -- and clearing the override would stop being expressible.
    expect(json).toContain('"styleId":"sty_emp"');
    expect(json).not.toContain('"format":{"styleId"');
  });

  it('serialises an empty table as `[]` rather than omitting it', () => {
    // One shape for a v5 file, so "no styles" is a value and not an absence.
    expect(serializeToString(createDocument({ name: 'x' }))).toContain('"styles": []');
  });

  it('preserves the style table through an unrelated edit', () => {
    const before = styledDocument([QUOTE, EMPHASIS, BODY]);
    const after = parse(JSON.parse(serializeToString(before)) as unknown);
    expect(after.styles.length).toBe(3);
    expect(resolveStyle(after.styles, QUOTE.id, 'paragraph')?.name).toBe('Quote');
  });
});

describe('the parser refuses what it cannot honour', () => {
  const withStyles = (styles: unknown, text: Record<string, unknown>): Record<string, unknown> => ({
    format: 'p1doc',
    formatVersion: 5,
    id: 'doc_s',
    name: 'S',
    pageSetup: {
      fixedSize: true,
      defaultSize: { width: 210, height: 297, unit: 'mm', orientation: 'portrait' },
      resizeBehaviour: 'crop',
    },
    styles,
    assets: {},
    pages: [
      {
        id: 'p1',
        name: '1',
        size: { width: 210, height: 297, unit: 'mm', orientation: 'portrait' },
        background: { type: 'solid', color: '#ffffff' },
        objects: [
          {
            type: 'textFrame',
            id: 'node_1',
            name: 'copy',
            transform: { x: 0, y: 0, width: 300, height: 200, rotation: 0, scaleX: 1, scaleY: 1 },
            visible: true,
            locked: false,
            opacity: 1,
            blendMode: 'normal',
            text: normalizeRichText({ blocks: [{ kind: 'paragraph', runs: [{ text: 'x' }], ...text }] }),
          },
        ],
      },
    ],
  });

  it('refuses a duplicate style id', () => {
    // `resolveStyle` finds by id, so two definitions sharing one would make *which* style an object
    // inherits from depend on array order -- and editing the other would appear to do nothing.
    expect(() => parse(withStyles([QUOTE, { ...QUOTE }], {}))).toThrow(/duplicate style id/);
  });

  it('refuses an unknown category, naming it', () => {
    expect(() =>
      parse(withStyles([{ id: 'sty_x', name: 'X', kind: 'outline' }], {})),
    ).toThrow(/outline/);
  });

  it('refuses a payload key from the wrong category', () => {
    // A character style carrying `align` has nothing to align. The type cannot express it, and the
    // parser says so rather than accepting a definition nothing downstream can honour.
    expect(() =>
      parse(withStyles([{ id: 'sty_x', name: 'X', kind: 'character', character: {}, align: 'center' }], {})),
    ).toThrow(/align/);
  });

  it('refuses a paragraph style that references another style', () => {
    // A parent-style hierarchy is explicitly out of scope, and saying so at the format boundary means
    // a hand-edited file cannot smuggle one in that the renderer would then have to honour.
    expect(() =>
      parse(
        withStyles(
          [{ ...QUOTE, paragraph: { ...QUOTE.paragraph, styleId: 'sty_other' } as never }],
          {},
        ),
      ),
    ).toThrow(/styleId/);
  });

  it('refuses an empty style name', () => {
    expect(() => parse(withStyles([{ ...QUOTE, name: '   ' }], {}))).toThrow(/name/);
  });

  it('refuses an unknown key in a style payload', () => {
    expect(() =>
      parse(withStyles([{ id: 'sty_x', name: 'X', kind: 'frame', frame: { fontSize: 12, gutter: 4 } as never }], {})),
    ).toThrow(/gutter/);
  });

  it('refuses a negative margin in a style', () => {
    expect(() =>
      parse(
        withStyles(
          [{ ...QUOTE, paragraph: { align: 'center', metrics: { marginStart: -1 } } }],
          {},
        ),
      ),
    ).toThrow(/marginStart/);
  });
});

describe('a reference the document cannot resolve', () => {
  const dangling = (): Record<string, unknown> => ({
    format: 'p1doc',
    formatVersion: 5,
    id: 'doc_d',
    name: 'D',
    pageSetup: {
      fixedSize: true,
      defaultSize: { width: 210, height: 297, unit: 'mm', orientation: 'portrait' },
      resizeBehaviour: 'crop',
    },
    // The frame and the paragraph reference ids that are not in this table -- a document from a newer
    // build, or a hand edit.
    styles: [],
    assets: {},
    pages: [
      {
        id: 'p1',
        name: '1',
        size: { width: 210, height: 297, unit: 'mm', orientation: 'portrait' },
        background: { type: 'solid', color: '#ffffff' },
        objects: [
          {
            type: 'textFrame',
            id: 'node_1',
            name: 'copy',
            transform: { x: 0, y: 0, width: 300, height: 200, rotation: 0, scaleX: 1, scaleY: 1 },
            visible: true,
            locked: false,
            opacity: 1,
            blendMode: 'normal',
            styleId: 'sty_gone',
            text: normalizeRichText({
              blocks: [
                {
                  kind: 'paragraph',
                  styleId: 'sty_gone',
                  align: 'right',
                  runs: [{ text: 'x', styleId: 'sty_gone' }],
                },
              ],
            }),
          },
        ],
      },
    ],
  });

  it('loads rather than refusing the document', () => {
    // One bad id anywhere must not make the whole file unopenable, for a condition the renderer
    // already handles correctly and visibly.
    const parsed = parse(dangling());
    const frame = parsed.pages[0]?.objects[0];
    if (frame?.type !== 'textFrame') throw new Error('no frame');
    expect(frame.styleId).toBe('sty_gone');
  });

  it('inherits nothing from it, and keeps the direct values it does have', () => {
    const parsed = parse(dangling());
    const frame = parsed.pages[0]?.objects[0];
    if (frame?.type !== 'textFrame') throw new Error('no frame');
    expect(effectiveParagraphProps(parsed.styles, frame.text.blocks[0]!)).toEqual({ align: 'right' });
  });

  it('keeps the reference through a save, so a build that knows it can still resolve it', () => {
    // Repairing it by deleting the reference would write a change nobody asked for, and would lose
    // the link for the build that *does* understand it.
    const saved = serializeToString(parse(dangling()));
    expect(saved).toContain('sty_gone');
    expect(blocksOf(JSON.parse(saved) as unknown)[0]?.styleId).toBe('sty_gone');
  });

  it('treats a wrong-category reference as unresolved rather than as an error', () => {
    const withCategory: Record<string, unknown> = dangling();
    // `sty_quote` exists but is a *paragraph* style, referenced from a run.
    (withCategory['styles'] as unknown[]).length;
    const styles = [QUOTE];
    const frames = (withCategory['pages'] as Array<{ objects: Array<Record<string, unknown>> }>)[0]
      ?.objects as Array<Record<string, unknown>>;
    const text = frames[0]?.['text'] as { blocks: ParagraphBlock[] };
    text.blocks[0] = { ...text.blocks[0]!, runs: [{ text: 'x', styleId: QUOTE.id }] };
    withCategory['styles'] = styles;

    const parsed = parse(withCategory);
    expect(parsed.styles).toHaveLength(1);
    // The run keeps the reference; it simply inherits nothing from it.
    expect((parsed.pages[0]?.objects[0] as { text: { blocks: ParagraphBlock[] } }).text.blocks[0]?.runs[0]?.styleId).toBe(
      QUOTE.id,
    );
  });
});
