/**
 * M22: format version 4, and the compatibility that came with it.
 *
 * ## What v4 changed, and why it is worth a version
 *
 * Three additions, all optional:
 *
 *  - `ParagraphBlock.dir` -- `'auto' | 'ltr' | 'rtl'`, closing M21's documented limitation that an
 *    author could not state a paragraph's direction.
 *  - `ParagraphBlock.metrics` -- indents and spacing, applied through CSS *logical* properties so
 *    the start edge follows the paragraph's own direction.
 *  - `CharFormat.super` / `.sub` -- two more true-only flags.
 *
 * Optional is what makes the *migration* trivial and is the reason this file is short. A v3 document
 * simply carries none of the three, and absence already means exactly what it meant in v3: `auto`
 * direction, no indents, no superscript. So migrating is the absence of keys rather than a rewrite,
 * and a v3 document re-saved as v4 gains no field it did not already mean.
 *
 * ## Why a version bump at all, if nothing is required
 *
 * Because the format's policy is *refuse, do not drop*. `expectOnlyKeys` means a v3 build reading a
 * v4 document containing `dir` must refuse it by name rather than accept a paragraph it would then
 * re-save without the field -- a silent loss of authored state. That refusal needs a version to be
 * refused *by*. `paragraphKeysFor` is the paragraph-level counterpart of `documentKeysFor`.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from '../../src/persist/deserialize';
import { serializeToString } from '../../src/persist/serialize';
import { CURRENT_FORMAT_VERSION, MINIMUM_FORMAT_VERSION } from '../../src/persist/format';
import { normalizeRichText } from '../../src/model/rich-text';
import { documentsEqual } from '../../src/model/document-equality';
import type { ParagraphBlock, TextFrameNode } from '../../src/model/types';

const GOLDEN_V4 = fileURLToPath(new URL('../golden/sample-v4.p1doc', import.meta.url));
const GOLDEN_V3 = fileURLToPath(new URL('../golden/sample-v3.p1doc', import.meta.url));

const blocksOf = (json: unknown): ParagraphBlock[] => {
  const document = parse(json);
  const frame = document.pages[0]?.objects.find((node) => node.type === 'textFrame');
  return (frame as TextFrameNode | undefined)?.text.blocks ?? [];
};

describe('the v3 -> v4 migration', () => {
  it('the two golden fixtures differ by exactly the version line', () => {
    // The format change is meant to be *visible*. If a future bump adds a required field, this
    // fails and the next person knows the golden is no longer a copy but a migration in its own
    // right -- at which point it needs a regeneration step and a stated reason.
    const v3 = readFileSync(GOLDEN_V3, 'utf8').split('\n');
    const v4 = readFileSync(GOLDEN_V4, 'utf8').split('\n');
    expect(v4.length, 'the goldens are different lengths').toBe(v3.length);

    const differing = v3
      .map((line, index) => [line, v4[index]] as const)
      .filter(([before, after]) => before !== after);
    expect(differing).toHaveLength(1);
    expect(differing[0]?.[0]?.trim()).toBe('"formatVersion": 3,');
    expect(differing[0]?.[1]?.trim()).toBe('"formatVersion": 4,');
  });

  it('a version-3 document still loads, and means the same thing', () => {
    const v3 = parse(JSON.parse(readFileSync(GOLDEN_V3, 'utf8')) as unknown);
    const v4 = parse(JSON.parse(readFileSync(GOLDEN_V4, 'utf8')) as unknown);

    // Documents equal: the migration is the absence of keys, so the two versions describe the same
    // document. If this ever fails, a v3 document is being *interpreted* differently, which is the
    // one thing a version bump must never do.
    expect(documentsEqual(v3, v4)).toBe(true);
  });

  it('a version-3 paragraph carries no direction and no metrics', () => {
    // What "absent means auto" looks like from the inside.
    for (const block of blocksOf(JSON.parse(readFileSync(GOLDEN_V3, 'utf8')) as unknown)) {
      expect(block.dir, 'a v3 paragraph acquired a direction').toBeUndefined();
      expect(block.metrics, 'a v3 paragraph acquired metrics').toBeUndefined();
    }
  });

  it('re-saving a version-3 document adds no field it did not already mean', () => {
    const v3 = parse(JSON.parse(readFileSync(GOLDEN_V3, 'utf8')) as unknown);
    const saved = JSON.parse(serializeToString(v3)) as {
      formatVersion: number;
      pages: Array<{ objects: TextFrameNode[] }>;
    };

    expect(saved.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    const text = JSON.stringify(saved);
    expect(text, 'saving invented an explicit direction').not.toContain('"dir"');
    expect(text, 'saving invented paragraph metrics').not.toContain('"metrics"');
  });

  it('the version range still accepts a version-3 document and refuses version 5', () => {
    // The bound is `MINIMUM_FORMAT_VERSION` to current, unchanged by a bump -- only the top moved.
    expect(MINIMUM_FORMAT_VERSION).toBeLessThan(CURRENT_FORMAT_VERSION);
    const future = { ...(JSON.parse(readFileSync(GOLDEN_V4, 'utf8')) as Record<string, unknown>) };
    future['formatVersion'] = CURRENT_FORMAT_VERSION + 1;
    expect(() => parse(future)).toThrow(/newer version/);
  });
});

describe('version-4 paragraph properties', () => {
  const documentWith = (block: ParagraphBlock): Record<string, unknown> => ({
    format: 'p1doc',
    formatVersion: 4,
    id: 'doc_v4',
    name: 'V4',
    pageSetup: {
      fixedSize: true,
      defaultSize: { width: 210, height: 297, unit: 'mm', orientation: 'portrait' },
      resizeBehaviour: 'crop',
    },
    assets: {},
    pages: [
      {
        id: 'page_1',
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
            // `normalizeRichText` returns the whole `RichText`, not a block -- wrapping it in
            // `blocks` again is a paragraph whose only field is another document's text, and the
            // parser's "kind: expected a string, got missing" is a long way round saying so.
            text: normalizeRichText({ blocks: [block] }),
          },
        ],
      },
    ],
  });

  const paragraph = (extra: Partial<ParagraphBlock>): Record<string, unknown> =>
    documentWith({ kind: 'paragraph', runs: [{ text: 'x' }], ...extra });

  it('accepts every direction', () => {
    for (const dir of ['auto', 'ltr', 'rtl'] as const) {
      expect(blocksOf(paragraph({ dir }))[0]?.dir, `dir "${dir}" did not survive`).toBe(dir);
    }
  });

  it('refuses a direction this build does not know', () => {
    // Refused rather than ignored: a typo in a direction is a document whose layout differs from
    // what its author believes, and there is no safe default to substitute.
    expect(() => parse(paragraph({ dir: 'sideways' as ParagraphBlock['dir'] }))).toThrow(/dir/);
  });

  it('accepts all five metrics', () => {
    const parsed = blocksOf(
      paragraph({
        metrics: {
          textIndent: 24,
          marginStart: 12,
          marginEnd: 8,
          marginBefore: 4,
          marginAfter: 6,
        },
      }),
    )[0]?.metrics;
    expect(parsed).toEqual({ textIndent: 24, marginStart: 12, marginEnd: 8, marginBefore: 4, marginAfter: 6 });
  });

  it('accepts a negative first-line indent, because that is what a hanging indent is', () => {
    // The signed/unsigned split is the model speaking. A negative `textIndent` against a positive
    // `marginStart` is how every book sets a hanging indent, and no other combination of these five
    // fields expresses it.
    expect(blocksOf(paragraph({ metrics: { textIndent: -24, marginStart: 24 } }))[0]?.metrics).toEqual({
      textIndent: -24,
      marginStart: 24,
    });
  });

  it('refuses a negative margin, naming the key', () => {
    // A negative margin means "overlap the neighbouring paragraph" -- a different feature, which a
    // fixed-size frame cannot honour safely. Refused rather than clamped: a silently clamped file
    // is a document that does not say what its author wrote.
    expect(() => parse(paragraph({ metrics: { marginStart: -1 } }))).toThrow(/marginStart/);
    expect(() => parse(paragraph({ metrics: { marginBefore: -1 } }))).toThrow(/marginBefore/);
  });

  it('refuses a non-finite metric rather than storing NaN or Infinity', () => {
    // `NaN` serialises to `null` and `Infinity` survives it, so accepting either produces a file
    // this build cannot read back.
    expect(() => parse(paragraph({ metrics: { textIndent: Number.NaN } }))).toThrow(/textIndent/);
    expect(() => parse(paragraph({ metrics: { marginAfter: Number.POSITIVE_INFINITY } }))).toThrow(
      /marginAfter/,
    );
  });

  it('refuses a metric key it does not know, rather than dropping it', () => {
    expect(() =>
      parse(paragraph({ metrics: { gutter: 10 } as unknown as ParagraphBlock['metrics'] })),
    ).toThrow(/gutter/);
  });

  it('round-trips both properties through the file', () => {
    const saved = serializeToString(
      parse(paragraph({ dir: 'rtl', metrics: { textIndent: 18, marginBefore: 6 } })),
    );
    const back = blocksOf(JSON.parse(saved) as unknown)[0];
    expect(back?.dir).toBe('rtl');
    expect(back?.metrics).toEqual({ textIndent: 18, marginBefore: 6 });
  });

  it('refuses `dir` and `metrics` in a version-3 paragraph', () => {
    // The refusal that motivates the version bump: a v3 build must not accept a paragraph it would
    // then re-save without the field.
    const v3 = { ...(JSON.parse(readFileSync(GOLDEN_V3, 'utf8')) as Record<string, unknown>) };
    const pages = v3['pages'] as Array<{ objects: Array<Record<string, unknown>> }>;
    const frame = pages[0]?.objects.find((node) => node['type'] === 'textFrame') as
      | Record<string, unknown>
      | undefined;
    const blocks = (frame?.['text'] as { blocks: ParagraphBlock[] }).blocks;
    blocks[0] = { ...blocks[0]!, dir: 'rtl' };

    expect(() => parse(v3)).toThrow(/dir/);
  });
});
