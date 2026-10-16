/**
 * The v1/v2 → v3 page-size migration.
 *
 * ## Why this file exists and why it is mostly positive
 *
 * `validation.test.ts` is deliberately a list of things the parser must *refuse*, because that is what
 * a strict parser is for. Migration is the opposite: it is a list of things the parser must **accept
 * and understand**, and a migration that quietly produces a document with the wrong page size is not a
 * parse failure — it is a document that opens, looks plausible, and prints on the wrong paper.
 *
 * So these tests assert values, not just "it did not throw". The load-bearing ones are:
 *
 *  - a legacy document's pages come out at **exactly** the size it declared, including orientation;
 *  - `fixedSize` comes out `true`, which is a fact about legacy files rather than a guess;
 *  - saving produces version 3 with a per-page `size`, so the migration runs once and not again.
 *
 * ## The protected fixtures are version 2
 *
 * `tests/golden/*.p1doc` are version 2 and are **not** re-stamped by this milestone. They are the only
 * real documents of the old shape in the repository, and re-stamping them would delete the evidence
 * that migration works. They are asserted here as *legacy inputs*, which is what makes them more
 * valuable than before.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from '../../src/persist/deserialize';
import { serializeToString } from '../../src/persist/serialize';
import { DocumentParseError } from '../../src/persist/format';
import { CURRENT_FORMAT_VERSION } from '../../src/model/factory';
import { pageExtentPx } from '../../src/model/page';

const golden = (name: string): unknown =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../golden/${name}.p1doc`, import.meta.url)), 'utf8'),
  );

/** A minimal version-2 document, which is the smallest thing the migration must handle. */
function legacyDoc(overrides: Record<string, unknown> = {}): unknown {
  return {
    format: 'p1doc',
    formatVersion: 2,
    id: 'doc_legacy',
    name: 'Legacy',
    pageSize: { width: 210, height: 297, unit: 'mm', orientation: 'portrait' },
    assets: {},
    pages: [
      { id: 'page_1', name: '1', background: { type: 'solid', color: '#ffffff' }, objects: [] },
      { id: 'page_2', name: '2', background: { type: 'solid', color: '#ffffff' }, objects: [] },
    ],
    ...overrides,
  };
}

/**
 * A minimal **version-3** document.
 *
 * Built from scratch rather than by deleting a key off the version-2 one, because
 * `{ pageSize: undefined }` leaves the key *present* with an undefined value -- which `expectOnlyKeys`
 * correctly refuses. An earlier draft of these tests did exactly that, so the parser was right and the
 * test was wrong. Worth writing down rather than quietly fixing.
 */
function currentDoc(overrides: Record<string, unknown> = {}): unknown {
  return {
    format: 'p1doc',
    formatVersion: 3,
    id: 'doc_current',
    name: 'Current',
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
        objects: [],
      },
    ],
    ...overrides,
  };
}

describe('migrating a version-1/2 document', () => {
  it('gives every page the size the document declared', () => {
    const doc = parse(legacyDoc());
    expect(doc.pages).toHaveLength(2);
    for (const page of doc.pages) {
      expect(page.size).toEqual({ width: 210, height: 297, unit: 'mm', orientation: 'portrait' });
    }
  });

  it('preserves orientation rather than normalising it', () => {
    // The one field where a migration could plausibly go wrong: `pageSizeToPx` *swaps* width and
    // height for landscape, so a migration that reconstructed the size from the pixel extent instead
    // of copying the authored values would produce a landscape page measuring 210x297 -- which renders
    // and prints at half the intended area.
    const doc = parse(
      legacyDoc({
        pageSize: { width: 210, height: 297, unit: 'mm', orientation: 'landscape' },
      }),
    );
    expect(doc.pages[0]?.size).toEqual({
      width: 210,
      height: 297,
      unit: 'mm',
      orientation: 'landscape',
    });
    // And the extent really is the swapped one, i.e. the migration did not alter the meaning.
    expect(pageExtentPx(doc.pages[0]!.size)).toEqual({ width: 297 * (96 / 25.4), height: 210 * (96 / 25.4) });
  });

  it('preserves the authored unit, so an inch document still prints in inches', () => {
    const doc = parse(
      legacyDoc({
        pageSize: { width: 8.5, height: 11, unit: 'in', orientation: 'portrait' },
      }),
    );
    expect(doc.pages[0]?.size.unit).toBe('in');
    expect(doc.pages[0]?.size.width).toBe(8.5);
  });

  it('copies the size per page rather than sharing one object', () => {
    // A shared reference would make resizing one page of a migrated document resize all of them --
    // reintroducing the document-wide coupling M20 removed, one indirection away, and invisibly.
    const doc = parse(legacyDoc());
    expect(doc.pages[0]!.size).not.toBe(doc.pages[1]!.size);
    expect(doc.pageSetup.defaultSize).not.toBe(doc.pages[0]!.size);
  });

  it('migrates to fixedSize, because a legacy document could not have been anything else', () => {
    // Not an assumption: with one `pageSize` for the whole document, "all pages the same size" is a
    // fact about the file. `false` would describe existing pages identically and differ only for the
    // next page added -- a silent behaviour change nobody asked for.
    expect(parse(legacyDoc()).pageSetup.fixedSize).toBe(true);
  });

  it('migrates to the crop resize policy, the one that moves nothing', () => {
    expect(parse(legacyDoc()).pageSetup.resizeBehaviour).toBe('crop');
  });

  it('re-stamps the version, so the migration runs once', () => {
    expect(parse(legacyDoc()).formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(CURRENT_FORMAT_VERSION).toBe(6);
  });

  it('writes a version-3 file whose pages carry their own size', () => {
    const saved = JSON.parse(serializeToString(parse(legacyDoc()))) as Record<string, unknown>;
    expect(saved['formatVersion']).toBe(CURRENT_FORMAT_VERSION);
    expect(saved['pageSetup']).toBeDefined();
    expect(saved['pageSize']).toBeUndefined();
    const pages = saved['pages'] as Array<Record<string, unknown>>;
    expect(pages[0]!['size']).toEqual({
      width: 210,
      height: 297,
      unit: 'mm',
      orientation: 'portrait',
    });
  });

  it('round-trips a migrated document without changing it again', () => {
    const once = parse(legacyDoc());
    const twice = parse(JSON.parse(serializeToString(once)));
    expect(twice.pages.map((p) => p.size)).toEqual(once.pages.map((p) => p.size));
    expect(twice.pageSetup).toEqual(once.pageSetup);
  });

  it('reads a version-1 document, which is the same shape without groups', () => {
    const doc = parse(legacyDoc({ formatVersion: 1 }));
    expect(doc.pages[0]?.size.width).toBe(210);
  });
});

describe('the protected golden fixtures', () => {
  // These are version 2 on disk and are deliberately left that way. Asserting they *migrate* is the
  // point: they are real documents, not synthesised ones, and a migration that only works on a
  // hand-built minimal input is not a migration.
  for (const name of ['handwritten', 'sample'] as const) {
    it(`${name}.p1doc loads, and every page keeps the fixture's size`, () => {
      const raw = golden(name) as { pageSize: unknown; pages: unknown[] };
      const doc = parse(golden(name));
      expect(doc.pages).toHaveLength(raw.pages.length);
      for (const page of doc.pages) expect(page.size).toEqual(raw.pageSize);
      expect(doc.pageSetup.fixedSize).toBe(true);
    });
  }
});

describe('refusals around the version boundary', () => {
  it('refuses a legacy document with no pageSize at all', () => {
    const bad = legacyDoc();
    delete (bad as Record<string, unknown>)['pageSize'];
    expect(() => parse(bad)).toThrow(DocumentParseError);
    expect(() => parse(bad)).toThrow(/pageSize/);
  });

  it('refuses a version-3 document that still carries pageSize', () => {
    // The unknown-key rule is what stops a half-migrated file loading: `pageSize` is not silently
    // ignored, because a document whose pages disagree with its declared size is exactly the state
    // this milestone exists to remove.
    const bad = legacyDoc({ formatVersion: 3 });
    expect(() => parse(bad)).toThrow(/pageSize/);
  });

  it('refuses a version-3 page with no size', () => {
    const page = { id: 'page_1', name: '1', background: { type: 'solid', color: '#ffffff' }, objects: [] };
    expect(() => parse(currentDoc({ pages: [page] }))).toThrow(/pages\[0\]\.size/);
  });

  it('refuses an unknown resize behaviour', () => {
    expect(() =>
      parse(
        currentDoc({
          pageSetup: {
            fixedSize: true,
            defaultSize: { width: 210, height: 297, unit: 'mm', orientation: 'portrait' },
            resizeBehaviour: 'squish',
          },
        }),
      ),
    ).toThrow(/pageSetup\.resizeBehaviour/);
  });
  it('still refuses a document from the future', () => {
    expect(() => parse(legacyDoc({ formatVersion: CURRENT_FORMAT_VERSION + 1 }))).toThrow(
      /newer version/,
    );
  });
});
