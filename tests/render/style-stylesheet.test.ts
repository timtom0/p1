// @vitest-environment happy-dom

/**
 * M23: the DOM round trip for styles, and the generated stylesheet.
 *
 * ## Why these live in `tests/` and not beside `model/styles.test.ts`
 *
 * Because they test the *renderer*, not the model, and the layering rule says so: `src/model` may
 * not import from `src/render`, and may not touch `document` at all. A file in `src/model/` that
 * built a host element was a boundary violation the linter was right about, whatever the test was
 * worth.
 *
 * The split is along the same line the model file's header draws -- resolution in `src/model`,
 * projection here -- and it is the same line the code itself is drawn along. `styleSheetCss` is the
 * reason this milestone works at all: inherited values go into a rule keyed by `data-style-id` while
 * the element carries only that attribute, so the walker has nothing to read back.
 *
 * ## The failure these tests exist to prevent
 *
 * If a style's values were rendered as **inline** styles, the DOM-to-model walker would read them
 * back on the first keystroke and store them as direct overrides. Nothing would look wrong, the
 * document would grow, and editing the style would quietly stop affecting that object -- the object
 * would have silently detached itself. So each round-trip test asserts both halves: the reference
 * survives *and* the object's own values are unchanged.
 */

import { describe, expect, it } from 'vitest';
import { domToRichText, richTextToHtml } from '../../src/render/rich-text-html';
import { styleSheetCss } from '../../src/render/style-sheet';
import { normalizeRichText } from '../../src/model/rich-text';
import type { ParagraphBlock, StyleDefinition } from '../../src/model/types';

const host = (): HTMLElement => {
  const element = document.createElement('div');
  document.body.append(element);
  return element;
};

/** Renders a model with a style table and walks it straight back. */
const roundTrip = (
  blocks: ParagraphBlock[],
  styles: readonly StyleDefinition[],
): ParagraphBlock[] => {
  const element = host();
  element.append(richTextToHtml(normalizeRichText({ blocks }), styles));
  return domToRichText(element).blocks;
};

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

const paragraph = (extra: Partial<ParagraphBlock> = {}): ParagraphBlock => ({
  kind: 'paragraph',
  runs: [{ text: 'Hello' }],
  ...extra,
});

describe('the DOM round trip keeps the reference and drops the properties', () => {
  it('a paragraph style reference survives, and its properties do not come back', () => {
    const blocks = roundTrip(
      [paragraph({ styleId: 'sty_quote', runs: [{ text: 'Hello' }] })],
      [PARAGRAPH],
    );
    expect(blocks[0]?.styleId, 'the reference was lost').toBe('sty_quote');
    // The load-bearing half. `align`, `dir` and `metrics` came from the style, so if any of them
    // had been written inline the walker would have read them back and stored them here -- as
    // direct overrides, permanently detaching this paragraph from its style.
    expect(blocks[0]?.align).toBeUndefined();
    expect(blocks[0]?.dir).toBeUndefined();
    expect(blocks[0]?.metrics).toBeUndefined();
  });

  it('a direct override *is* read back, because it is authored on the element', () => {
    const blocks = roundTrip(
      [paragraph({ styleId: 'sty_quote', align: 'justify', runs: [{ text: 'Hello' }] })],
      [PARAGRAPH],
    );
    // The asymmetry is the point: an override is authored here, so the walker reading it is
    // correct. What must never come back is a value the *style* supplied.
    expect(blocks[0]?.align).toBe('justify');
    expect(blocks[0]?.styleId).toBe('sty_quote');
  });

  it('a character style reference survives and contributes no flags', () => {
    const blocks = roundTrip(
      [paragraph({ runs: [{ text: 'Hello', styleId: 'sty_emp' }] })],
      [CHARACTER],
    );
    expect(blocks[0]?.runs[0]?.styleId).toBe('sty_emp');
    expect(blocks[0]?.runs[0]?.format, 'the style was materialised onto the run').toBeUndefined();
  });

  it('a styled run and a directly-italic run stay distinct', () => {
    const blocks = roundTrip(
      [
        paragraph({
          runs: [
            { text: 'styled', styleId: 'sty_emp' },
            { text: 'direct', format: { italic: true } },
          ],
        }),
      ],
      [CHARACTER],
    );
    // Two runs that look identical and must not merge: one inherits its italic, the other has it.
    // Merging them would attach the style to the direct run, and unlinking that run would then
    // silently inherit formatting the user had typed themselves.
    expect(blocks[0]?.runs).toHaveLength(2);
    expect(blocks[0]?.runs[0]?.styleId).toBe('sty_emp');
    expect(blocks[0]?.runs[1]?.styleId).toBeUndefined();
    expect(blocks[0]?.runs[1]?.format).toEqual({ italic: true });
  });

  it('a dangling reference renders as an unstyled paragraph rather than throwing', () => {
    const blocks = roundTrip([paragraph({ styleId: 'sty_gone', align: 'right' })], [PARAGRAPH]);
    // Preserved for recovery, per the model: a reference to a style this build does not have is
    // still a reference, and dropping it here would write a change nobody asked for.
    expect(blocks[0]?.styleId).toBe('sty_gone');
    expect(blocks[0]?.align).toBe('right');
  });
});

describe('the generated stylesheet', () => {
  it('writes a character style as declarations, not tags', () => {
    const css = styleSheetCss([CHARACTER]);
    expect(css).toContain('font-style: italic');
  });

  it('combines underline and strike into one declaration', () => {
    const both: StyleDefinition = {
      id: 'sty_marks',
      name: 'Marks',
      kind: 'character',
      character: { underline: true, strike: true },
    };
    const css = styleSheetCss([both]);
    expect(css).toContain('text-decoration-line: underline line-through');
    expect((css.match(/text-decoration-line/g) ?? []).length, 'the property was written twice').toBe(1);
  });

  it('writes paragraph metrics as logical properties', () => {
    const css = styleSheetCss([PARAGRAPH]);
    // Logical, not physical: the whole reason M22 introduced them. A physical `margin-left` here
    // would put the indent on the wrong edge for an RTL paragraph.
    expect(css).toContain('margin-inline-start: 24px');
    expect(css).toContain('text-indent: 8px');
    // `dir: auto` is the absence of an override, not a declaration -- the renderer's `dir="auto"`
    // already says it, and emitting `direction: auto` would be invalid CSS.
    expect(css).not.toContain('auto');
  });

  it('escapes an id that would otherwise end the selector', () => {
    // `expectId` accepts any non-empty string, so a hand-edited file can carry a quote. Unescaped,
    // the selector ends early and the rest is parsed as CSS -- a document injecting rules into the
    // application's own stylesheet.
    const hostile: StyleDefinition = {
      id: 'a"] , * { color: red } [x="',
      name: 'Hostile',
      kind: 'character',
      character: { bold: true },
    };
    const css = styleSheetCss([hostile]);
    // The hostile text *is* present -- it has to be, it is the id -- but only inside the quoted
    // attribute value, where it is inert. An injection would mean something *outside* a string
    // became a selector, so that is what is checked: with every quoted string blanked out, exactly
    // one `{` survives, and the only declaration in the rule is ours.
    const outsideStrings = css.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    expect((outsideStrings.match(/\{/g) ?? []).length, 'the id escaped its string and became a rule').toBe(1);
    expect(css.startsWith('.p1-text-content [data-style-id="a\\"]'), 'the id was not escaped').toBe(true);
    // The opening brace is found from the *end*: the id itself contains one, inside the quoted
    // string, and taking the first would slice the declaration out of the middle of the selector.
    const body = css.slice(css.lastIndexOf('{') + 1, css.lastIndexOf('}'));
    expect(body.trim()).toBe('font-weight: 700');
  });

  it('is empty for a document with no styles', () => {
    expect(styleSheetCss([])).toBe('');
  });

  it('out-specifies the renderer base rule, which is what makes a margin render at all', () => {
    // The defect this pins, found in a browser and not in any unit test.
    //
    // `.p1-text-content p { margin: 0 }` is specificity (0,1,1). A bare `[data-style-id]` selector
    // is (0,1,0) and loses, so every logical margin a paragraph style supplied computed to zero --
    // silently, and while the same rule's `text-align` and `direction` *did* apply. It surfaced as
    // "unlink moved the text", which is the one thing unlink must never do.
    //
    // Asserted here as a shape rather than as a cascade: the stylesheet module has no access to the
    // chrome stylesheet, so what it can promise is that its selectors are qualified. The browser
    // suite is where the two actually meet.
    const css = styleSheetCss([PARAGRAPH]);
    expect(css.startsWith('.p1-text-content [data-style-id=')).toBe(true);
    // Every rule, not just the first: a stylesheet where one category qualified and another did not
    // would reintroduce the same bug for frame styles.
    for (const style of [CHARACTER, PARAGRAPH, { ...PARAGRAPH, kind: 'frame', frame: {} } as const]) {
      const rule = styleSheetCss([style as never]);
      if (rule !== '') expect(rule.startsWith('.p1-text-content [data-style-id=')).toBe(true);
    }
  });
});