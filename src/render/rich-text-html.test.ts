// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { domTextContent, domToRichText, normalizeNewlines, richTextToHtml } from './rich-text-html';
import type { CharFormat, ParagraphAlign, RichText } from '../model/types';
import { normalizeRichText, richTextEqual } from '../model/rich-text';

/**
 * The conversion, both directions.
 *
 * This is the load-bearing test file of ADR 0003. The normalizer is the trust
 * boundary: everything the browser can produce has to survive it, and everything the
 * model can express has to survive the render direction unchanged.
 *
 * The mess fed in below is deliberately the mess a real browser emits during
 * editing — including markup happy-dom would never generate — because that mess is
 * the whole risk.
 */

function el(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

/** The normalized HTML a model value produces, via a real fragment. */
function htmlOf(rich: RichText): string {
  const host = document.createElement('div');
  host.append(richTextToHtml(rich));
  return host.innerHTML;
}

/** Round-trips a model value through the DOM and back. */
function roundTrip(rich: RichText): RichText {
  return domToRichText(el(htmlOf(rich)));
}

function textOf(html: string): string {
  return domToRichText(el(html))
    .blocks.map((block) => block.runs.map((run) => run.text).join(''))
    .join('\n');
}

function runsOf(html: string): { text: string; format?: CharFormat }[] {
  return domToRichText(el(html)).blocks[0]?.runs ?? [];
}

const BOLD: CharFormat = { bold: true };
const ITALIC: CharFormat = { italic: true };

// ---------------------------------------------------------------------------
// The round-trip property — the strongest claim the design makes
// ---------------------------------------------------------------------------

describe('round trip', () => {
  /**
   * The corpus is the whole reason this test exists.
   *
   * It covers every block count from zero to three, every alignment, all four
   * flags, flag combinations, soft breaks, and — importantly — whitespace in every
   * position where it is easy to lose.
   */
  const corpus: { name: string; value: RichText }[] = [
    { name: 'empty frame', value: { blocks: [{ kind: 'paragraph', runs: [{ text: '' }] }] } },
    {
      name: 'single word',
      value: { blocks: [{ kind: 'paragraph', runs: [{ text: 'Hello' }] }] },
    },
    {
      name: 'two paragraphs',
      value: {
        blocks: [
          { kind: 'paragraph', runs: [{ text: 'One' }] },
          { kind: 'paragraph', runs: [{ text: 'Two' }] },
        ],
      },
    },
    {
      name: 'three paragraphs, the middle one empty',
      value: {
        blocks: [
          { kind: 'paragraph', runs: [{ text: 'One' }] },
          { kind: 'paragraph', runs: [{ text: '' }] },
          { kind: 'paragraph', runs: [{ text: 'Three' }] },
        ],
      },
    },
    {
      name: 'leading and trailing space',
      value: { blocks: [{ kind: 'paragraph', runs: [{ text: '  padded  ' }] }] },
    },
    {
      name: 'repeated interior spaces',
      value: { blocks: [{ kind: 'paragraph', runs: [{ text: 'a    b' }] }] },
    },
    {
      name: 'whitespace only',
      value: { blocks: [{ kind: 'paragraph', runs: [{ text: '   ' }] }] },
    },
    {
      name: 'soft break',
      value: { blocks: [{ kind: 'paragraph', runs: [{ text: 'line one\nline two' }] }] },
    },
    {
      name: 'trailing soft break',
      value: { blocks: [{ kind: 'paragraph', runs: [{ text: 'line\n' }] }] },
    },
    {
      name: 'bold run',
      value: {
        blocks: [{ kind: 'paragraph', runs: [{ text: 'plain' }, { text: 'loud', format: BOLD }] }],
      },
    },
    {
      name: 'italic run',
      value: { blocks: [{ kind: 'paragraph', runs: [{ text: 'quiet', format: ITALIC }] }] },
    },
    {
      name: 'underline and strike',
      value: {
        blocks: [
          {
            kind: 'paragraph',
            runs: [
              { text: 'u', format: { underline: true } },
              { text: 's', format: { strike: true } },
            ],
          },
        ],
      },
    },
    {
      name: 'all four flags on one run',
      value: {
        blocks: [
          {
            kind: 'paragraph',
            runs: [
              { text: 'everything', format: { bold: true, italic: true, underline: true, strike: true } },
            ],
          },
        ],
      },
    },
    {
      name: 'mixed formatting inside one paragraph',
      value: {
        blocks: [
          {
            kind: 'paragraph',
            runs: [
              { text: 'plain ' },
              { text: 'bold ' , format: BOLD },
              { text: 'italic', format: ITALIC },
              { text: ' plain' },
            ],
          },
        ],
      },
    },
    {
      name: 'formatting adjacent to whitespace',
      value: {
        blocks: [
          { kind: 'paragraph', runs: [{ text: 'a ', format: BOLD }, { text: ' b' }] },
        ],
      },
    },
    {
      name: 'formatting around a soft break',
      value: {
        blocks: [
          { kind: 'paragraph', runs: [{ text: 'bold\nbreak', format: BOLD }] },
        ],
      },
    },
    ...(['left', 'center', 'right', 'justify'] as ParagraphAlign[]).map((align) => ({
      name: `align ${align}`,
      value: { blocks: [{ kind: 'paragraph', align, runs: [{ text: 'aligned' }] }] } as RichText,
    })),
    {
      name: 'alignment plus formatting plus soft break',
      value: {
        blocks: [
          {
            kind: 'paragraph',
            align: 'center',
            runs: [{ text: 'a\nb', format: { bold: true } }, { text: 'c' }],
          },
        ],
      },
    },
    {
      name: 'several paragraphs with different alignment',
      value: {
        blocks: [
          { kind: 'paragraph', align: 'left', runs: [{ text: 'l' }] },
          { kind: 'paragraph', align: 'right', runs: [{ text: 'r' }] },
          { kind: 'paragraph', runs: [{ text: 'unset' }] },
        ],
      },
    },
  ];

  for (const { name, value } of corpus) {
    it(`is exact for: ${name}`, () => {
      expect(roundTrip(value)).toEqual(value);
    });
  }

  it('covers a corpus that would pass on flattened text alone', () => {
    // Guards the corpus itself. If every case collapsed to the same plain text the
    // tests above would be theatre.
    const distinct = new Set(corpus.map((entry) => richTextToPlainForTest(entry.value)));
    expect(distinct.size).toBeGreaterThan(corpus.length / 2);
  });
});

function richTextToPlainForTest(rich: RichText): string {
  return JSON.stringify(rich);
}

// ---------------------------------------------------------------------------
// Model → HTML
// ---------------------------------------------------------------------------

describe('richTextToHtml', () => {
  it('emits one paragraph per block', () => {
    const html = htmlOf({
      blocks: [
        { kind: 'paragraph', runs: [{ text: 'One' }] },
        { kind: 'paragraph', runs: [{ text: 'Two' }] },
      ],
    });
    expect(html).toBe('<p>One</p><p>Two</p>');
  });

  it('writes alignment as an inline style, the way the browser does', () => {
    const html = htmlOf({ blocks: [{ kind: 'paragraph', align: 'center', runs: [{ text: 'x' }] }] });
    expect(html).toContain('text-align: center');
  });

  it('omits the style when alignment is unset', () => {
    const html = htmlOf({ blocks: [{ kind: 'paragraph', runs: [{ text: 'x' }] }] });
    expect(html).toBe('<p>x</p>');
  });

  it('nests tags in a canonical order regardless of key order', () => {
    const html = htmlOf({
      blocks: [
        {
          kind: 'paragraph',
          runs: [{ text: 'x', format: { strike: true, italic: true, bold: true } }],
        },
      ],
    });
    expect(html).toBe('<p><b><i><s>x</s></i></b></p>');
  });

  it('emits no <br>: a soft break is a literal newline rendered by pre-wrap', () => {
    const html = htmlOf({ blocks: [{ kind: 'paragraph', runs: [{ text: 'a\nb' }] }] });
    expect(html).toBe('<p>a\nb</p>');
    expect(html).not.toContain('<br');
  });

  it('emits an empty paragraph with no filler element', () => {
    // CSS `min-height` gives it height; a `<br>` would be a second source of truth.
    expect(htmlOf({ blocks: [{ kind: 'paragraph', runs: [{ text: '' }] }] })).toBe('<p></p>');
  });

  it('refuses an unknown block kind rather than rendering an empty frame', () => {
    const bad = {
      blocks: [{ kind: 'heading', runs: [{ text: 'Title' }] }],
    } as unknown as RichText;
    expect(() => richTextToHtml(bad)).toThrow(/Only "paragraph" is implemented/);
  });
});

// ---------------------------------------------------------------------------
// HTML → model
// ---------------------------------------------------------------------------

describe('domToRichText', () => {
  it('reads a single paragraph', () => {
    expect(textOf('<p>Hello world</p>')).toBe('Hello world');
  });

  it('reads multiple paragraphs as separate blocks', () => {
    expect(textOf('<p>One</p><p>Two</p>')).toBe('One\nTwo');
  });

  it('keeps an empty paragraph between two others', () => {
    // Consecutive blank lines must survive: they are content, not noise.
    expect(domToRichText(el('<p>One</p><p></p><p>Two</p>')).blocks).toHaveLength(3);
  });

  it('keeps exactly one paragraph when everything is deleted', () => {
    const rich = domToRichText(el(''));
    expect(rich.blocks).toHaveLength(1);
    expect(rich.blocks[0]?.runs[0]?.text).toBe('');
  });

  it('treats <div> as a paragraph boundary', () => {
    expect(textOf('<div>One</div><div>Two</div>')).toBe('One\nTwo');
  });

  it('handles mixed p and div nesting', () => {
    expect(textOf('<div><p>One</p><p>Two</p></div>')).toBe('One\nTwo');
  });

  it('treats headings as paragraphs, preserving their text', () => {
    expect(textOf('<h1>Title</h1><p>Body</p>')).toBe('Title\nBody');
  });

  it('treats <br> as a soft break inside one paragraph', () => {
    const rich = domToRichText(el('<p>One<br>Two</p>'));
    expect(rich.blocks).toHaveLength(1);
    expect(rich.blocks[0]?.runs[0]?.text).toBe('One\nTwo');
  });

  describe('trailing <br> is a placeholder, not content', () => {
    /*
     * Chromium writes a trailing `<br>` to keep the caret's line visible, and leaves
     * `<p><br></p>` behind when a line is emptied. Reading those as soft breaks made an
     * emptied frame's model value `"\n"` — which re-projects as a permanent blank line,
     * so the frame is no longer empty and no longer round-trips. `tests/spike/
     * text-editing.spec.ts` caught this; these pin the rule so it cannot come back.
     */
    it('drops the <br> in an emptied paragraph', () => {
      expect(runsOf('<p><br></p>')).toEqual([{ text: '' }]);
    });

    it('drops the <br> a caret leaves at the end of a line', () => {
      expect(textOf('<p>one</p><p>two<br></p>')).toBe('one\ntwo');
    });

    it('keeps a soft break that is not last', () => {
      // The distinguishing case: same tag, different position.
      expect(runsOf('<p>one<br>two</p>')).toEqual([{ text: 'one\ntwo' }]);
    });

    it('keeps every soft break but the last', () => {
      expect(runsOf('<p>one<br><br></p>')).toEqual([{ text: 'one\n' }]);
    });

    it('drops it through a nested wrapper too', () => {
      expect(runsOf('<div><p>one<br></p></div>')).toEqual([{ text: 'one' }]);
    });

    it('leaves a <br> at top level alone, since it has no block to anchor to', () => {
      // Outside a block there is no "end of the paragraph" to be trailing of, so the
      // placeholder rule does not apply and the break is kept as content.
      expect(textOf('one<br>')).toBe('one\n');
    });
  });

  it('reads bold, italic, underline and strike tags', () => {
    expect(runsOf('<p><b>b</b><i>i</i><u>u</u><s>s</s></p>').map((r) => r.format)).toEqual([
      { bold: true },
      { italic: true },
      { underline: true },
      { strike: true },
    ]);
  });

  it('reads the semantic aliases the browser and paste both emit', () => {
    expect(runsOf('<p><strong>a</strong><em>b</em><ins>c</ins><del>d</del></p>').map((r) => r.format)).toEqual([
      { bold: true },
      { italic: true },
      { underline: true },
      { strike: true },
    ]);
  });

  it('reads formatting from an inline style, which is how paste arrives', () => {
    const runs = runsOf(
      '<p><span style="font-weight:700">a</span><span style="font-style:oblique">b</span>' +
        '<span style="text-decoration:line-through">c</span></p>',
    );
    expect(runs.map((r) => r.format)).toEqual([
      { bold: true },
      { italic: true },
      { strike: true },
    ]);
  });

  it('reads <font weight> and <font style>, and discards <font face>', () => {
    const runs = runsOf('<p><font weight="bold">a</font><font face="Georgia">b</font></p>');
    expect(runs.map((r) => r.format)).toEqual([{ bold: true }, undefined]);
  });

  it('discards inline colour, deliberately — it is frame-level for M3', () => {
    const runs = runsOf('<p><font color="#ff0000">a</font><span style="color:#00ff00">b</span></p>');
    // Both runs end up unformatted, so canonical form merges them into one. The text
    // is preserved; only the formatting is dropped.
    expect(runs).toEqual([{ text: 'ab' }]);
  });

  it('nests formats when tags nest', () => {
    const runs = runsOf('<p><b>bold <i>both</i></b></p>');
    expect(runs).toEqual([
      { text: 'bold ', format: { bold: true } },
      { text: 'both', format: { bold: true, italic: true } },
    ]);
  });

  it('merges adjacent runs that end up with the same format', () => {
    // `<b>a</b>` and a following unformatted `a` are different; `<b>a</b>` next to
    // `<b>b</b>` is not. Canonical form depends on telling those apart.
    expect(runsOf('<p><b>a</b><b>b</b></p>')).toEqual([{ text: 'ab', format: { bold: true } }]);
    expect(runsOf('<p><b>a</b>b</p>')).toEqual([
      { text: 'a', format: { bold: true } },
      { text: 'b' },
    ]);
  });

  it('treats unknown inline elements as transparent', () => {
    // An element the model has no concept of must not change the text or split the
    // paragraph. `<section>` is deliberately *not* used here: it is a block, and
    // would legitimately start a new paragraph.
    expect(textOf('<p><mark>a</mark><custom-tag>b</custom-tag><q>c</q></p>')).toBe('abc');
  });

  it('an empty formatted paragraph loses its format, which is documented', () => {
    // `{ text: '', format: { bold: true } }` has no visible effect and no characters
    // for the walker to attach a format to, so the format does not survive a round
    // trip. Acceptable: the browser tracks a pending format *during* a session, so
    // the only way to reach this state is to exit with an empty selection, where the
    // format has nothing to apply to anyway.
    expect(runsOf('<p><b></b></p>')).toEqual([{ text: '' }]);
  });

  it('drops script and style content entirely', () => {
    expect(textOf('<p>a</p><script>alert(1)</script><style>p{}</style>')).toBe('a');
  });

  it('reads alignment from the block, not from every descendant', () => {
    const rich = domToRichText(el('<p style="text-align: justify;">One</p><p>Two</p>'));
    expect(rich.blocks[0]?.align).toBe('justify');
    expect(rich.blocks[1]?.align).toBeUndefined();
  });

  it('preserves whitespace exactly, including a trailing space the user typed', () => {
    expect(textOf('<p>a </p>')).toBe('a ');
    expect(textOf('<p>  a</p>')).toBe('  a');
    expect(textOf('<p>a    b</p>')).toBe('a    b');
  });

  it('converts a non-breaking space to a normal one', () => {
    expect(textOf('<p>a&nbsp;b</p>')).toBe('a b');
  });

  it('is idempotent: normalising twice changes nothing', () => {
    const messy = [
      '<div><b>a</b><i>b</i></div>',
      '<p>One<br>Two</p>',
      '<p>a&nbsp;b<div>c</div>d<br>e</p>',
      '<p><span style="font-weight:700">x</span> plain</p>',
      '<p>   </p>',
      '',
    ];
    for (const html of messy) {
      const once = domToRichText(el(html));
      const html2 = htmlOf(once);
      expect(domToRichText(el(html2))).toEqual(once);
      expect(domToRichText(el(htmlOf(domToRichText(el(html2)))))).toEqual(once);
    }
  });
});

// ---------------------------------------------------------------------------
// Newlines
// ---------------------------------------------------------------------------

describe('normalizeNewlines', () => {
  it('folds CRLF and CR to LF', () => {
    expect(normalizeNewlines('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('folds U+00A0 to a normal space', () => {
    expect(normalizeNewlines('a\u00A0b')).toBe('a b');
  });

  it('leaves everything else alone', () => {
    expect(normalizeNewlines('plain text')).toBe('plain text');
  });
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

describe('domTextContent', () => {
  it('joins paragraphs with newlines', () => {
    expect(domTextContent(el('<p>a</p><p>b</p>'))).toBe('a\nb');
  });
});

// ---------------------------------------------------------------------------
// Canonical form
// ---------------------------------------------------------------------------

describe('canonical form', () => {
  it('two documents that render identically normalise to one value', () => {
    const split = normalizeRichText({
      blocks: [{ kind: 'paragraph', runs: [{ text: 'a' }, { text: 'b' }] }],
    });
    const whole = normalizeRichText({
      blocks: [{ kind: 'paragraph', runs: [{ text: 'ab' }] }],
    });
    expect(split).toEqual(whole);
    expect(richTextEqual(split, whole)).toBe(true);
  });

  it('the browser’s out-and-back markup converges on the model value', () => {
    // Chromium splits a bold run into adjacent tags; both must normalise to one run.
    const fromBrowser = domToRichText(el('<p><b>bo</b><b>ld</b></p>'));
    const fromModel = normalizeRichText({
      blocks: [{ kind: 'paragraph', runs: [{ text: 'bold', format: { bold: true } }] }],
    });
    expect(fromBrowser).toEqual(fromModel);
  });
});
