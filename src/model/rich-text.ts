/**
 * Pure operations on `RichText`.
 *
 * These exist because the model needs three things that are easy to get subtly wrong
 * and impossible to inline everywhere: a **canonical form**, a **total equality**, and
 * a **plain-text projection**.
 *
 * ## Why canonical form is not optional
 *
 * `a` followed by `<b>b</b>` and `<b>ab</b>` are the same page. If both were
 * representable, two documents would render identically and compare unequal — and
 * since `History` skips commands that return the same document reference (§4.4),
 * an editor would fill its undo stack with steps that appear to do nothing.
 *
 * So `normalizeRichText` merges adjacent runs whose formats match, and both the
 * renderer and the normalizer run it. The invariant is: **every visual text has
 * exactly one run-sequence.**
 *
 * This module knows nothing about HTML or the DOM. The conversion lives in
 * `render/rich-text-html.ts`.
 */

import type {
  CharFormat,
  InlineRun,
  ParagraphAlign,
  ParagraphBlock,
  RichText,
  TextBlock,
} from './types';

/** The four character-formatting flags, in canonical nesting order. */
export const CHAR_FLAGS = ['bold', 'italic', 'underline', 'strike'] as const;

export type CharFlag = (typeof CHAR_FLAGS)[number];

/** The empty frame: one paragraph, one empty run. See ADR 0003. */
export function emptyRichText(): RichText {
  return { blocks: [{ kind: 'paragraph', runs: [{ text: '' }] }] };
}

/** True when `format` would change how `text` is drawn. */
export function hasFormat(format: CharFormat | undefined): format is CharFormat {
  if (format === undefined) return false;
  return CHAR_FLAGS.some((flag) => format[flag] === true);
}

/** Total equality on `CharFormat`, treating absent and `undefined` alike. */
export function formatsEqual(a: CharFormat | undefined, b: CharFormat | undefined): boolean {
  const left = hasFormat(a) ? a : undefined;
  const right = hasFormat(b) ? b : undefined;
  if (left === undefined || right === undefined) return left === right;
  return CHAR_FLAGS.every((flag) => left[flag] === right[flag]);
}

/**
 * Structural equality on `RichText`.
 *
 * Total, and independent of canonical form: two non-canonical but equal-valued
 * structures compare equal here, and `normalizeRichText` makes them identical. Both
 * properties are needed — `commands.ts` uses this to skip no-op `setText` commands,
 * so it must not report a change for a re-ordering of equal runs.
 */
export function richTextEqual(a: RichText, b: RichText): boolean {
  if (a.blocks.length !== b.blocks.length) return false;

  for (let index = 0; index < a.blocks.length; index += 1) {
    const left = a.blocks[index];
    const right = b.blocks[index];
    if (left === undefined || right === undefined) return false;
    if (left.kind !== right.kind) return false;
    if (left.align !== right.align) return false;
    if (left.runs.length !== right.runs.length) return false;

    for (let run = 0; run < left.runs.length; run += 1) {
      const leftRun = left.runs[run];
      const rightRun = right.runs[run];
      if (leftRun === undefined || rightRun === undefined) return false;
      if (leftRun.text !== rightRun.text) return false;
      if (!formatsEqual(leftRun.format, rightRun.format)) return false;
    }
  }
  return true;
}

/**
 * Merges adjacent runs with equal formats and drops empty ones.
 *
 * Dropping empty runs is not just tidiness: the browser produces them constantly
 * (`<b><br></b>`, an emptied paragraph, a style boundary with nothing inside), and
 * left in place they would defeat run merging and make two renderings unequal.
 */
export function normalizeRichText(text: RichText): RichText {
  const blocks: TextBlock[] = text.blocks.map((block) => {
    const runs: InlineRun[] = [];

    for (const run of block.runs) {
      if (run.text.length === 0) continue;

      const previous = runs[runs.length - 1];
      if (previous !== undefined && formatsEqual(previous.format, run.format)) {
        runs[runs.length - 1] = {
          text: previous.text + run.text,
          ...(hasFormat(run.format) ? { format: { ...run.format } } : {}),
        };
        continue;
      }

      runs.push({
        text: run.text,
        ...(hasFormat(run.format) ? { format: { ...run.format } } : {}),
      });
    }

    // A paragraph with no runs still needs one, or `min-height` has nothing to size
    // and the caret has nowhere to sit.
    if (runs.length === 0) runs.push({ text: '' });

    return {
      kind: block.kind,
      ...(block.align === undefined ? {} : { align: block.align }),
      runs,
    };
  });

  // An empty frame is one empty paragraph, never zero paragraphs.
  if (blocks.length === 0) return emptyRichText();
  return { blocks };
}

/** The frame's text as a user would read it, paragraphs joined by `\n`. */
export function richTextToPlain(rich: RichText): string {
  return rich.blocks.map((block) => block.runs.map((run) => run.text).join('')).join('\n');
}

/** True when the frame holds no visible characters. */
export function isRichTextEmpty(rich: RichText): boolean {
  return richTextToPlain(rich).trim().length === 0;
}

/** Splits plain text into paragraphs, dropping blank lines. */
export function plainToRichText(text: string): RichText {
  const blocks: TextBlock[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    blocks.push({ kind: 'paragraph', runs: [{ text: trimmed }] });
  }
  return normalizeRichText(blocks.length === 0 ? emptyRichText() : { blocks });
}

/** A run with the given text and flags set. */
export function run(text: string, flags?: readonly CharFlag[]): InlineRun {
  if (flags === undefined || flags.length === 0) return { text };
  const format: CharFormat = {};
  for (const flag of flags) format[flag] = true;
  return { text, format };
}

/** One paragraph, optionally aligned. */
export function paragraph(
  runs: readonly InlineRun[],
  align?: ParagraphAlign,
): ParagraphBlock {
  return {
    kind: 'paragraph',
    ...(align === undefined ? {} : { align }),
    runs: [...runs],
  };
}

/**
 * Returns a copy of `format` with `flag` toggled.
 *
 * Used when applying inline formatting to a whole frame outside a session. Toggling
 * rather than setting is what makes a second press of the same toolbar button
 * behave as "remove", matching what the browser does inside a session.
 */
export function toggleFlag(
  format: CharFormat | undefined,
  flag: CharFlag,
): CharFormat | undefined {
  const next: CharFormat = { ...format };
  if (next[flag] === true) delete next[flag];
  else next[flag] = true;
  return hasFormat(next) ? next : undefined;
}

/** Every flag set anywhere in the frame — what the inspector shows for a mixed selection. */
export function formatsUsed(rich: RichText): Set<CharFlag> {
  const used = new Set<CharFlag>();
  for (const block of rich.blocks) {
    for (const r of block.runs) {
      if (r.format === undefined) continue;
      for (const flag of CHAR_FLAGS) {
        if (r.format[flag] === true) used.add(flag);
      }
    }
  }
  return used;
}

/** True when every run in the frame carries `flag`. Drives the toolbar's pressed state. */
export function formatAppliesThroughout(rich: RichText, flag: CharFlag): boolean {
  let sawRun = false;
  for (const block of rich.blocks) {
    for (const r of block.runs) {
      if (r.text.length === 0) continue;
      sawRun = true;
      if (r.format?.[flag] !== true) return false;
    }
  }
  return sawRun;
}
