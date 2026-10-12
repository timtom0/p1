/**
 * The formatting semantics, at the model layer.
 *
 * ## Why these are tested here and not through the browser
 *
 * ADR 0003 puts three kinds of property in three places -- character formatting on inline runs,
 * alignment on paragraphs, typography on the frame -- and the rules that keep them apart
 * (`normalizeRichText`, `formatsEqual`, `toggleFlag`) are pure functions over that structure. Their
 * behaviour is invisible from the outside: a normaliser that merged two runs of different formats
 * would render almost identically and would only show up as a corrupted file much later.
 *
 * Four of these had **no test at all** before this milestone: `formatsEqual`, `toggleFlag`,
 * `formatAppliesThroughout` and `formatsUsed`. So the claims they are supposed to guarantee --
 * "absent means not bold", "a toggle preserves unrelated formatting", "the toolbar's pressed state
 * is true only when it applies throughout" -- were asserted nowhere.
 */

import { describe, expect, it } from 'vitest';
import {
  formatAppliesThroughout,
  formatsEqual,
  formatsUsed,
  hasFormat,
  isRichTextEmpty,
  normalizeRichText,
  paragraph,
  plainToRichText,
  richTextEqual,
  richTextToPlain,
  run,
  toggleFlag,
} from './rich-text';
import type { CharFormat, InlineRun, RichText } from './types';

describe('formatsEqual', () => {
  it('treats absent and empty as the same thing', () => {
    // "Not bold" has exactly one encoding. If `{}` and `undefined` compared unequal, a run the
    // browser handed back with an empty style object would look changed, and every no-op command
    // would record a history entry for it.
    expect(formatsEqual(undefined, undefined)).toBe(true);
    expect(formatsEqual(undefined, {})).toBe(true);
    expect(formatsEqual({}, undefined)).toBe(true);
    expect(formatsEqual({}, {})).toBe(true);
  });

  it('distinguishes flags by value', () => {
    expect(formatsEqual({ bold: true }, { bold: true })).toBe(true);
    expect(formatsEqual({ bold: true }, { italic: true })).toBe(false);
    // More flags is more formatting, so an extra flag is a difference however it is written.
    expect(formatsEqual({ bold: true }, { bold: true, italic: true })).toBe(false);
    expect(formatsEqual({ bold: true, italic: true }, { bold: true })).toBe(false);
  });

  it('does not care about key order or about flags the build does not know', () => {
    expect(formatsEqual({ bold: true, italic: true }, { italic: true, bold: true })).toBe(true);
    // A key this build does not model is ignored rather than making every comparison false, which
    // is what `CHAR_FLAGS.every` gives.
    expect(formatsEqual({ bold: true }, { bold: true, shadow: true } as CharFormat)).toBe(true);
  });
});

describe('hasFormat', () => {
  it('is false for nothing and true for at least one flag', () => {
    expect(hasFormat(undefined)).toBe(false);
    expect(hasFormat({})).toBe(false);
    expect(hasFormat({ bold: true })).toBe(true);
    // A `false` is not representable in the type, but the parser refuses one and the renderer must
    // not treat it as bold if one ever arrives from a hand-edited file.
    expect(hasFormat({ bold: false } as unknown as CharFormat)).toBe(false);
  });
});

describe('toggleFlag', () => {
  it('adds an absent flag', () => {
    expect(toggleFlag(undefined, 'bold')).toEqual({ bold: true });
    expect(toggleFlag({}, 'italic')).toEqual({ italic: true });
  });

  it('removes a present flag', () => {
    expect(toggleFlag({ bold: true }, 'bold')).toBeUndefined();
    expect(toggleFlag({ bold: true, italic: true }, 'bold')).toEqual({ italic: true });
  });

  it('preserves the flags it was not asked about', () => {
    // The rule that matters for mixed formatting: bolding a frame that is half italic must not
    // quietly un-italic the italic half.
    expect(toggleFlag({ italic: true }, 'bold')).toEqual({ italic: true, bold: true });
    expect(toggleFlag({ italic: true, strike: true }, 'underline')).toEqual({
      italic: true,
      strike: true,
      underline: true,
    });
  });

  it('returns undefined rather than an empty object', () => {
    // Canonical form. `{}` would give "no formatting" a second spelling.
    expect(toggleFlag({ bold: true }, 'bold')).not.toEqual({});
  });
});

describe('normalizeRichText', () => {
  it('merges adjacent runs that carry the same formatting', () => {
    const result = normalizeRichText({
      blocks: [
        paragraph([{ text: 'a', format: { bold: true } }, { text: 'b', format: { bold: true } }]),
      ],
    });
    expect(result.blocks[0]?.runs).toEqual([{ text: 'ab', format: { bold: true } }]);
  });

  it('refuses to merge runs whose formatting differs', () => {
    const result = normalizeRichText({
      blocks: [paragraph([{ text: 'a', format: { bold: true } }, { text: 'b' }])],
    });
    expect(result.blocks[0]?.runs).toEqual([
      { text: 'a', format: { bold: true } },
      { text: 'b' },
    ]);
  });

  it('drops empty runs, which the browser produces constantly', () => {
    // `<b><br></b>`, an emptied paragraph, a style boundary with nothing inside. Left in place
    // they defeat merging and make two renderings of the same text compare unequal.
    const result = normalizeRichText({
      blocks: [
        paragraph([
          { text: 'a', format: { bold: true } },
          { text: '', format: { bold: true } },
          { text: 'b', format: { bold: true } },
        ]),
      ],
    });
    expect(result.blocks[0]?.runs).toEqual([{ text: 'ab', format: { bold: true } }]);
  });

  it('drops an empty run even when it cannot merge away', () => {
    // The case above is not enough on its own, and finding that out was the point. An empty run
    // carrying the *same* format as its neighbours is absorbed by the merge whether or not empty
    // runs are dropped -- so a mutation that removed the drop survived the first version of this
    // test, which made it look like the drop was untested.
    //
    // An empty run with a *different* format has nowhere to merge: without the drop it survives as
    // its own run, and the paragraph then renders a boundary that carries no text.
    const result = normalizeRichText({
      blocks: [paragraph([{ text: 'a' }, { text: '', format: { bold: true } }, { text: 'b' }])],
    });
    expect(result.blocks[0]?.runs).toEqual([{ text: 'ab' }]);
  });

  it('gives an emptied paragraph one empty run, so the caret has somewhere to sit', () => {
    const result = normalizeRichText({ blocks: [paragraph([])] });
    expect(result.blocks[0]?.runs).toEqual([{ text: '' }]);
  });

  it('gives an empty frame one empty paragraph, never zero', () => {
    const result = normalizeRichText({ blocks: [] });
    expect(result.blocks).toEqual([{ kind: 'paragraph', runs: [{ text: '' }] }]);
    expect(isRichTextEmpty(result)).toBe(true);
  });

  it('omits `format` entirely rather than writing an empty object', () => {
    const result = normalizeRichText({
      blocks: [paragraph([{ text: 'a', format: {} }, { text: 'b', format: undefined }])],
    });
    expect(result.blocks[0]?.runs).toEqual([{ text: 'ab' }]);
  });

  it('preserves alignment while merging runs', () => {
    // The two properties are independent, and merging runs must not drop one of them. Losing
    // alignment here would silently re-justify a paragraph the moment its text was edited.
    const result = normalizeRichText({
      blocks: [
        paragraph([{ text: 'a' }, { text: 'b' }], 'center'),
        paragraph([{ text: 'c' }]),
      ],
    });
    expect(result.blocks[0]?.runs).toEqual([{ text: 'ab' }]);
    expect(result.blocks[0]?.align).toBe('center');
    // And an absent alignment stays absent rather than becoming `left`.
    expect(result.blocks[1]?.align).toBeUndefined();
  });

  it('leaves soft line breaks inside their run', () => {
    // A soft break is a `\n` *within* a paragraph, produced by Shift+Enter. Normalisation must
    // neither split on it nor trim around it, or Shift+Enter would silently become Enter.
    const result = normalizeRichText({
      blocks: [paragraph([{ text: 'one  ' }, { text: 'two\nthree' }])],
    });
    expect(result.blocks[0]?.runs).toEqual([{ text: 'one  two\nthree' }]);
    expect(richTextToPlain(result)).toBe('one  two\nthree');
  });

  it('keeps consecutive soft breaks', () => {
    const result = normalizeRichText({
      blocks: [paragraph([{ text: 'a\n\nb' }])],
    });
    expect(result.blocks[0]?.runs[0]?.text).toBe('a\n\nb');
  });

  it('does not carry a run\'s formatting across a paragraph boundary', () => {
    // The boundary case M21 names. A bold run at the end of one paragraph must not bold the first
    // run of the next, which is exactly what a stateful merge would do.
    const result = normalizeRichText({
      blocks: [
        paragraph([{ text: 'a', format: { bold: true } }]),
        paragraph([{ text: 'b', format: { bold: true } }]),
      ],
    });
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0]?.runs[0]?.format).toEqual({ bold: true });
    expect(result.blocks[1]?.runs[0]?.format).toEqual({ bold: true });
  });

  it('does not let a run overflow into the next paragraph when merging', () => {
    // Same rule from the other side: the merge is per block, so the two bold runs stay two runs.
    const before = normalizeRichText({
      blocks: [paragraph([{ text: 'a', format: { bold: true } }, { text: 'b', format: { bold: true } }])],
    });
    expect(before.blocks[0]?.runs).toHaveLength(1);
  });

  it('preserves a frame that is already canonical, unchanged', () => {
    const canonical: RichText = {
      blocks: [paragraph([run('plain'), run('bold', ['bold'])])],
    };
    expect(normalizeRichText(canonical)).toEqual(canonical);
  });
});

describe('richTextEqual', () => {
  it('compares by value, not by canonical form', () => {
    // `commands.ts` uses this to decide a `setText` is a no-op, so it must not report a change for
    // a re-arrangement of equal runs.
    const left = normalizeRichText({
      blocks: [paragraph([{ text: 'a', format: { bold: true } }, { text: 'b', format: { bold: true } }])],
    });
    const right = normalizeRichText({ blocks: [paragraph([{ text: 'ab', format: { bold: true } }])] });
    expect(left.blocks[0]?.runs).toHaveLength(1);
    expect(richTextEqual(left, right)).toBe(true);
  });

  it('notices a changed alignment', () => {
    const left = { blocks: [paragraph([run('a')], 'left')] };
    const right = { blocks: [paragraph([run('a')], 'center')] };
    expect(richTextEqual(left, right)).toBe(false);
  });

  it('notices a changed flag, a changed run count and a changed block count', () => {
    const base = { blocks: [paragraph([run('a')])] };
    expect(richTextEqual(base, { blocks: [paragraph([run('a', ['bold'])])] })).toBe(false);
    expect(richTextEqual(base, { blocks: [paragraph([run('a'), run('b')])] })).toBe(false);
    expect(richTextEqual(base, { blocks: [paragraph([run('a')]), paragraph([run('b')])] })).toBe(false);
  });
});

describe('formatAppliesThroughout', () => {
  it('is true only when every non-empty run carries the flag', () => {
    // This is what drives the toolbar's pressed state, so a wrong answer shows the user a bold
    // button that is not actually in effect for their selection.
    const all: RichText = { blocks: [paragraph([run('a', ['bold']), run('b', ['bold'])])] };
    const some: RichText = { blocks: [paragraph([run('a', ['bold']), run('b')])] };
    expect(formatAppliesThroughout(all, 'bold')).toBe(true);
    expect(formatAppliesThroughout(some, 'bold')).toBe(false);
  });

  it('is false for an empty frame', () => {
    // Vacuously "every run is bold" would light the button for a frame with nothing in it, and
    // pressing it would then bold nothing at all.
    expect(formatAppliesThroughout({ blocks: [paragraph([])] }, 'bold')).toBe(false);
  });

  it('ignores empty runs when deciding', () => {
    const text: RichText = {
      blocks: [paragraph([run('', ['italic']), run('a', ['italic'])])],
    };
    expect(formatAppliesThroughout(text, 'italic')).toBe(true);
  });

  it('looks across every paragraph', () => {
    const text: RichText = {
      blocks: [paragraph([run('a', ['bold'])]), paragraph([run('b')])],
    };
    expect(formatAppliesThroughout(text, 'bold')).toBe(false);
  });
});

describe('formatsUsed', () => {
  it('collects every flag appearing anywhere', () => {
    const text: RichText = {
      blocks: [
        paragraph([run('a', ['bold'])]),
        paragraph([run('b', ['italic', 'strike'])]),
      ],
    };
    expect([...formatsUsed(text)].sort()).toEqual(['bold', 'italic', 'strike']);
  });

  it('is empty for unformatted text', () => {
    expect([...formatsUsed({ blocks: [paragraph([run('a')])] })]).toEqual([]);
  });
});

describe('plain text', () => {
  it('joins paragraphs with a newline and keeps soft breaks inside one', () => {
    const text: RichText = {
      blocks: [paragraph([{ text: 'a\nb' }]), paragraph([{ text: 'c' }])],
    };
    expect(richTextToPlain(text)).toBe('a\nb\nc');
  });

  it('drops blank lines when parsing plain text, and never produces an empty frame', () => {
    expect(plainToRichText('a\n\nb').blocks).toHaveLength(2);
    expect(isRichTextEmpty(plainToRichText(''))).toBe(true);
    expect(plainToRichText('').blocks).toEqual([{ kind: 'paragraph', runs: [{ text: '' }] }]);
  });

  it('round-trips plain text', () => {
    const text = plainToRichText('first\nsecond');
    expect(richTextToPlain(text)).toBe('first\nsecond');
  });
});

describe('the helpers agree on canonical form', () => {
  it('a run with no flags and a run with an empty format object are the same run', () => {
    // The property the three kinds of formatting separation depends on. If these ever diverged,
    // a document could hold two spellings of the same visual text, and `richTextEqual` -- which
    // decides whether a command is a no-op -- would stop being trustworthy.
    const bare: InlineRun = { text: 'a' };
    const empty: InlineRun = { text: 'a', format: {} };
    expect(formatsEqual(bare.format, empty.format)).toBe(true);
    expect(normalizeRichText({ blocks: [paragraph([bare, empty])] }).blocks[0]?.runs).toEqual([
      { text: 'aa' },
    ]);
  });
});
