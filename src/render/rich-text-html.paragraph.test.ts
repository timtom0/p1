// @vitest-environment happy-dom

/**
 * M22: the DOM -> model direction, for the properties M22 added.
 *
 * ## Why this file is the load-bearing one for the milestone
 *
 * M21's `dir="auto"` was a *rendering* attribute: nothing read it back, because nothing had to --
 * it was derived. M22 makes direction an authored field, indents and spacing an authored field,
 * and superscript and subscript authored flags. Every one of those now has to survive the trip the
 * `setText` command makes at the end of every editing session:
 *
 *     rendered DOM  ->  domToRichText  ->  RichText  ->  command  ->  document
 *
 * If the walker cannot read a property back, the *first keystroke anywhere in that frame* silently
 * deletes it, with no error and no visible symptom until the next reload. That is the failure these
 * tests exist to make impossible, and it is why the round-trip is asserted for every property
 * rather than only for the ones that seemed interesting.
 *
 * ## The happy-dom constraint, which shaped the implementation
 *
 * `readAlign` parses the `style` *attribute* rather than reading `element.style`, and says why: a
 * computed `CSSStyleDeclaration` depends on the stylesheet having been applied, and happy-dom does
 * not populate one from `innerHTML`. The same reasoning is why `readMetrics` and `readDirection`
 * parse the attribute. Reading the CSSOM would have made every metric invisibly `undefined` under
 * this suite while looking perfectly correct in Chromium -- a test suite that quietly stops testing.
 */

import { describe, expect, it } from 'vitest';
import { domToRichText, richTextToHtml } from '../../src/render/rich-text-html';
import { normalizeRichText } from '../../src/model/rich-text';
import type { CharFormat, ParagraphBlock } from '../../src/model/types';

const container = (): HTMLElement => {
  const host = document.createElement('div');
  document.body.append(host);
  return host;
};

/** Renders a model to a real DOM fragment and walks it straight back. */
const roundTrip = (blocks: ParagraphBlock[]): ParagraphBlock[] => {
  const host = container();
  const html = richTextToHtml(normalizeRichText({ blocks })).childNodes.length;
  expect(html).toBeGreaterThan(0);
  host.innerHTML = '';
  host.append(richTextToHtml(normalizeRichText({ blocks })));
  return domToRichText(host).blocks;
};

const one = (extra: Partial<ParagraphBlock>): ParagraphBlock => ({
  kind: 'paragraph',
  runs: [{ text: 'Hello' }],
  ...extra,
});

describe('paragraph direction survives a round trip', () => {
  it('each direction comes back as itself', () => {
    for (const dir of ['ltr', 'rtl'] as const) {
      expect(roundTrip([one({ dir })])[0]?.dir, `dir "${dir}" was lost`).toBe(dir);
    }
  });

  it('an absent direction stays absent, rather than becoming an explicit `auto`', () => {
    // The distinction that makes the v3 migration exact: `auto` and absent are one paragraph, so
    // committing an edit to a pre-M22 document must not write `dir: "auto"` into it.
    expect(roundTrip([one({})])[0]?.dir).toBeUndefined();
  });

  it('an explicit `auto` reads back as absent', () => {
    // The same one-encoding rule, from the other side. `auto` is what every v3 document meant; if
    // an explicit `auto` came back as `auto`, then setting and clearing the control would produce
    // two different files describing one paragraph.
    expect(roundTrip([one({ dir: 'auto' })])[0]?.dir).toBeUndefined();
  });

  it('reads `direction` from an inline style, which is how pasted HTML arrives', () => {
    const host = container();
    host.innerHTML = '<p style="direction: rtl;">مرحبا</p>';
    expect(domToRichText(host).blocks[0]?.dir).toBe('rtl');
  });

  it('direction is per paragraph, not per frame', () => {
    // The whole point of putting it on the block: mixed-direction publishing cannot be expressed
    // otherwise, and a document-level switch would make this test impossible to write.
    const blocks = roundTrip([
      one({ runs: [{ text: 'English' }], dir: 'ltr' }),
      one({ runs: [{ text: 'العربية' }], dir: 'rtl' }),
      one({ runs: [{ text: 'auto' }] }),
    ]);
    expect(blocks.map((block) => block.dir)).toEqual(['ltr', 'rtl', undefined]);
  });

  it('direction and alignment are independent', () => {
    // "This paragraph is right-to-left" and "this paragraph is centred" are different questions, and
    // an author may want both. Inferring one from the other is the failure this test forbids.
    const blocks = roundTrip([one({ dir: 'rtl', align: 'center' })]);
    expect(blocks[0]?.dir).toBe('rtl');
    expect(blocks[0]?.align).toBe('center');

    // And the reverse: centring says nothing about direction.
    expect(roundTrip([one({ align: 'center' })])[0]?.dir).toBeUndefined();
  });
});

describe('paragraph metrics survive a round trip', () => {
  it('each metric comes back as itself', () => {
    const metrics = {
      textIndent: 24,
      marginStart: 12,
      marginEnd: 8,
      marginBefore: 4,
      marginAfter: 6,
    };
    expect(roundTrip([one({ metrics })])[0]?.metrics).toEqual(metrics);
  });

  it('one metric does not drag the others along, and unset ones stay unset', () => {
    // A patch command that cleared one metric must not reappear with the rest filled in, and must
    // not leave the cleared one behind from the previous value.
    const blocks = roundTrip([one({ metrics: { textIndent: 18 } })]);
    expect(blocks[0]?.metrics).toEqual({ textIndent: 18 });
    expect(blocks[0]?.metrics?.marginBefore).toBeUndefined();
  });

  it('absent metrics stay absent', () => {
    expect(roundTrip([one({})])[0]?.metrics).toBeUndefined();
  });

  it('a zero is a value, not an absence', () => {
    // `0` and unset must not collapse. An author who types `0` has said "no indent", which renders
    // identically to unset today but means something different to a future margin-collapsing rule.
    expect(roundTrip([one({ metrics: { textIndent: 0 } })])[0]?.metrics).toEqual({ textIndent: 0 });
  });

  it('a fractional value is not rounded away', () => {
    expect(roundTrip([one({ metrics: { marginStart: 10.5 } })])[0]?.metrics?.marginStart).toBe(10.5);
  });

  it('mixed settings inside one frame each keep their own', () => {
    const blocks = roundTrip([
      one({ runs: [{ text: 'a' }], metrics: { textIndent: 24 } }),
      one({ runs: [{ text: 'b' }], metrics: { marginStart: 12 } }),
      one({ runs: [{ text: 'c' }] }),
    ]);
    expect(blocks.map((block) => block.metrics)).toEqual([
      { textIndent: 24 },
      { marginStart: 12 },
      undefined,
    ]);
  });

  it('an unparseable length is skipped rather than stored as NaN', () => {
    // `NaN` serialises to `null`, which the parser refuses -- so storing one would make a document
    // unsaveable because of a declaration pasted from somewhere else.
    const host = container();
    host.innerHTML = '<p style="text-indent: nonsense; margin-block-start: 9px;">x</p>';
    expect(domToRichText(host).blocks[0]?.metrics).toEqual({ marginBefore: 9 });
  });

  it('a physical margin spelling is not reinterpreted as a logical one', () => {
    // Deliberate. Deciding that `margin-left` means "start" needs the resolved direction, and a
    // wrong guess moves an author's indent to the wrong side of an Arabic paragraph. Only the
    // logical spellings this renderer writes are read.
    const host = container();
    host.innerHTML = '<p style="margin-left: 30px;">x</p>';
    expect(domToRichText(host).blocks[0]?.metrics).toBeUndefined();
  });
});

describe('superscript and subscript survive a round trip', () => {
  const withFormat = (format: CharFormat): ParagraphBlock =>
    one({ runs: [{ text: 'x2', format }] });

  it('each flag comes back as itself', () => {
    expect(roundTrip([withFormat({ super: true })])[0]?.runs[0]?.format).toEqual({ super: true });
    expect(roundTrip([withFormat({ sub: true })])[0]?.runs[0]?.format).toEqual({ sub: true });
  });

  it('combines with the four existing flags without disturbing them', () => {
    const format: CharFormat = { bold: true, italic: true, underline: true, strike: true, super: true };
    expect(roundTrip([withFormat(format)])[0]?.runs[0]?.format).toEqual(format);
  });

  it('both at once is a distinct paragraph from either alone', () => {
    // The model permits it, so the renderer must not silently collapse it into one of them -- that
    // would be the second spelling of one visual value, which ADR 0003 exists to prevent.
    const blocks = roundTrip([withFormat({ super: true, sub: true })]);
    expect(blocks[0]?.runs[0]?.format).toEqual({ super: true, sub: true });
  });

  it('reads `vertical-align` from a span, which is how pasted superscript arrives', () => {
    const host = container();
    host.innerHTML = '<p><span style="vertical-align: super;">2</span></p>';
    expect(domToRichText(host).blocks[0]?.runs[0]?.format).toEqual({ super: true });

    host.innerHTML = '<p><span style="vertical-align: sub">n</span></p>';
    expect(domToRichText(host).blocks[0]?.runs[0]?.format).toEqual({ sub: true });
  });

  it('an empty paragraph keeps its direction and metrics', () => {
    // An emptied line is still a paragraph. Losing its properties on emptying would mean the user
    // cannot press Enter, fix a typo, delete it and get the paragraph back.
    const blocks = roundTrip([one({ runs: [{ text: '' }], dir: 'rtl', metrics: { textIndent: 20 } })]);
    expect(blocks[0]?.dir).toBe('rtl');
    expect(blocks[0]?.metrics).toEqual({ textIndent: 20 });
  });
});