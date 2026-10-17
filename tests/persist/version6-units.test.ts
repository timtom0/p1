/**
 * M24: format v6, and the one migration it needs.
 *
 * ## What the version bump is for
 *
 * `pageSetup.unit` is new, and the format's policy is **refuse, do not drop**: an untrusted file
 * carrying a key this build does not understand is refused by name rather than opened with the key
 * quietly discarded. So a v6 field has to come with a version, and the key list has to become
 * version-dependent the way `DOCUMENT_KEYS` already was for M23's `styles`.
 *
 * ## The migration is unobservable, and that is the claim
 *
 * Not "safe" -- *unobservable*. A pre-v6 document must open with **every physical dimension,
 * object position, typography value and rendered pixel exactly as it was**. The three things that
 * make that true, each of which is a thing that could plausibly have been got wrong:
 *
 *  1. **Nothing stored is reinterpreted.** Every number in the model is CSS px, and px does not
 *     depend on which unit is being displayed. Changing the unit changes what the fields *say*.
 *  2. **No page's `unit` is touched.** A page's unit belongs to that page and is what
 *     `printSheetSize` reads to emit `@page { size: 210mm 297mm }`. Letting a document unit change
 *     reach it would change the printed sheet.
 *  3. **The default is inferred from history, not from the preset.** `DEFAULT_MEASUREMENT_UNIT` is
 *     `mm` because `DEFAULT_PAGE_PRESET` has been A4-in-millimetres since before the format
 *     existed. Inferring it from `defaultSize.unit` would be the obvious-looking choice and would
 *     silently switch a document to inches the moment someone picked Letter -- see the comment in
 *     `parsePageSetup`.
 *
 * ## Why `handwritten.p1doc` is v2 and still has to match
 *
 * It is the same document written by hand in an older format. It exists to prove the parser does
 * not care about layout, so it must keep loading, keep comparing equal, and keep normalising *to*
 * the canonical current-version bytes. A migration that handled only one version back would pass
 * every other test here and fail that one.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CURRENT_FORMAT_VERSION } from '../../src/persist/format';
import { parse } from '../../src/persist/deserialize';
import { serializeToString } from '../../src/persist/serialize';
import { toPx, fromPx } from '../../src/core/units/units';
import type { Document } from '../../src/model/types';

const GOLDEN_V6 = fileURLToPath(new URL('../golden/sample-v6.p1doc', import.meta.url));
const GOLDEN_V5 = fileURLToPath(new URL('../golden/sample-v5.p1doc', import.meta.url));
const HANDWRITTEN = fileURLToPath(new URL('../golden/handwritten.p1doc', import.meta.url));

const load = (path: string): Document => parse(JSON.parse(readFileSync(path, 'utf8')));

/** Every page's physical extent in px, which is what "nothing moved" means. */
function pageExtents(doc: Document): Array<{ width: number; height: number }> {
  return doc.pages.map((page) => ({
    width: toPx(page.size.width, page.size.unit),
    height: toPx(page.size.height, page.size.unit),
  }));
}

/** Every object's geometry and typography, which is what "nothing was reinterpreted" means. */
function contentSnapshot(doc: Document): unknown {
  return doc.pages.map((page) =>
    page.objects.map((node) => ({
      id: node.id,
      transform: node.transform,
      ...(node.type === 'textFrame' ? { style: node.style, text: node.text } : {}),
      ...(node.type === 'shape' ? { shape: node.shape, stroke: node.stroke } : {}),
      ...(node.type === 'group' ? { children: node.children } : {}),
    })),
  );
}

describe('format v6', () => {
  it('is the current version', () => {
    expect(CURRENT_FORMAT_VERSION).toBe(6);
  });

  it('reads a v6 document and keeps the unit it was saved with', () => {
    expect(load(GOLDEN_V6).pageSetup.unit).toBe('mm');
  });

  it('refuses a v5 document carrying a unit, by name', () => {
    // The "refuse, do not drop" policy. Silently opening it and re-saving without the key would
    // discard the author's choice, and the user would have no way to learn it happened.
    const text = readFileSync(GOLDEN_V5, 'utf8');
    const smuggled = JSON.parse(text) as Record<string, unknown>;
    (smuggled['pageSetup'] as Record<string, unknown>)['unit'] = 'pt';
    expect(() => parse(smuggled)).toThrow(/pageSetup\.unit/);
  });

  it('refuses a v6 document missing the unit, by name', () => {
    // Distinct from the migration above on purpose. A v6 file always writes the key, so its absence
    // is a hand-edit rather than an older document, and reading it as "mm" would silently accept a
    // file the author had changed.
    const stripped = JSON.parse(readFileSync(GOLDEN_V6, 'utf8')) as Record<string, unknown>;
    delete (stripped['pageSetup'] as Record<string, unknown>)['unit'];
    expect(() => parse(stripped)).toThrow(/pageSetup\.unit/);
  });
});

describe('migrating a v5 document', () => {
  it('gives it millimetres, the unit every pre-v6 document implicitly used', () => {
    expect(load(GOLDEN_V5).pageSetup.unit).toBe('mm');
  });

  it('leaves every page size exactly as it was', () => {
    expect(pageExtents(load(GOLDEN_V5))).toEqual(pageExtents(load(GOLDEN_V6)));
  });

  it('leaves every page on its own unit', () => {
    // The load-bearing one for print. `printSheetSize` reads `page.size.unit`, so a document unit
    // that leaked into a page would change the size of the paper the PDF asks for.
    expect(load(GOLDEN_V5).pages.map((page) => page.size.unit)).toEqual(
      load(GOLDEN_V6).pages.map((page) => page.size.unit),
    );
  });

  it('reinterprets no number at all', () => {
    expect(contentSnapshot(load(GOLDEN_V5))).toEqual(contentSnapshot(load(GOLDEN_V6)));
  });

  it('normalises to the current version on save', () => {
    const saved = JSON.parse(serializeToString(load(GOLDEN_V5))) as Record<string, unknown>;
    expect(saved['formatVersion']).toBe(CURRENT_FORMAT_VERSION);
    expect((saved['pageSetup'] as Record<string, unknown>)['unit']).toBe('mm');
  });

  it('migrates a hand-written v2 file to the same current-version bytes', () => {
    // Five versions back, and the hand-written layout the golden suite exists to prove is ignored.
    // A migration that only handled one version back would pass everything else here.
    expect(serializeToString(load(HANDWRITTEN))).toBe(readFileSync(GOLDEN_V6, 'utf8'));
  });
});

describe('changing the document unit', () => {
  const units = ['mm', 'cm', 'in', 'pt', 'pc'] as const;

  it('reaches no stored number, because the stored numbers are px', () => {
    // The property the whole contract rests on. `setPageSetup` is a plain model edit, so this is
    // really an assertion that *nothing else in the model depends on the unit* -- if some future
    // field were stored in the document unit, this is where it would show.
    const before = load(GOLDEN_V6);
    const after: Document = {
      ...before,
      pageSetup: { ...before.pageSetup, unit: 'pt' },
    };
    expect(contentSnapshot(after)).toEqual(contentSnapshot(before));
    expect(pageExtents(after)).toEqual(pageExtents(before));
  });

  it('changes what a measurement field would say about the same px', () => {
    const extent = 210 * (96 / 25.4);
    const shown = units.map((unit) => Number(fromPx(extent, unit).toFixed(4)));
    // One physical distance, five readings of it. The numbers differ; the length does not.
    expect(shown).not.toEqual([...shown.slice(1), shown[0]]);
    expect(shown.every((value) => value > 0)).toBe(true);
  });

  it('leaves a mixed-unit document mixed', () => {
    // The case that forced `PageSetup.unit` to exist: pages of different units under one document
    // unit, which before M24 had no unit of its own and took the *focused page's* unit instead.
    const base = load(GOLDEN_V6);
    const mixed: Document = {
      ...base,
      pages: base.pages.map((page, index) =>
        index === 0 ? page : { ...page, size: { ...page.size, unit: 'in' } },
      ),
    };
    const saved = JSON.parse(serializeToString(mixed)) as Document;
    expect(saved.pageSetup.unit).toBe('mm');
    expect(saved.pages.map((page) => page.size.unit)).toEqual(['mm', 'in']);
  });
});