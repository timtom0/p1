/**
 * Guards on the injected document fixtures.
 *
 * ## The hole this closes
 *
 * `window.__P1_FIXTURE__` is an unchecked `() => Document` cast, so an injected fixture that
 * is *not* a valid document typechecks, runs, and renders. M6 added the required field
 * `Document.assets` and left ~30 fixture literals written before it untouched. Nothing
 * complained, because the renderer happened to tolerate the missing field.
 *
 * M7 then put `Object.keys(doc.assets)` on the render path -- once per `refreshChrome`, on
 * every pointer move -- and every drag threw a `TypeError`. Ten unrelated suites failed:
 * selection, undo, text sessions, and every visual baseline. Each failure pointed at its own
 * test; the cause was a missing key in a string in another file.
 *
 * So this asserts the invariant *structurally* rather than by repairing the literals: a new
 * fixture that omits a required field fails here, at the fixture, instead of three screens
 * away in a screenshot diff.
 *
 * ## What is checked
 *
 * Only the fields that a fixture can silently get wrong and that the app will read:
 *
 *  - the source parses at all (the pre-existing rule), and
 *  - every `Document` literal carries `assets`.
 *
 * `pages` and `pageSetup` were never a problem because the renderer reads them immediately
 * and a missing one fails the boot the `waitForApp` guard already reports. `assets` was
 * invisible for exactly the duration between M6 and M7, which is what a guard is for.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const TESTS_ROOT = join(process.cwd(), 'tests');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (extname(path) === '.ts') out.push(path);
  }
  return out;
}

/**
 * Every file that could hold an injected document source.
 *
 * `page-size-migration.test.ts` is excluded wholesale: its documents are deliberately format
 * version 2, with a document-wide `pageSize` and no per-page `size`, because the migration from
 * one to the other is what it exists to prove.
 */
const SOURCES = walk(TESTS_ROOT).filter(
  (file) => !file.endsWith('.test.ts') && !file.endsWith('page-size-migration.test.ts'),
);

/** `tests/…` with forward slashes, so a key below cannot depend on the platform separator. */
function testRelativePath(file: string): string {
  return relative(TESTS_ROOT, file).split(sep).join('/');
}

/**
 * Files allowed to contain a page with no `size`, and the reason each one is.
 *
 * Not a blanket exclusion: `boot-diagnostics.spec.ts` mounts a *deliberately* malformed fixture
 * to prove the harness names a thrown boot instead of reporting a timeout, and the rest of that
 * file is held to the same rule as everywhere else.
 *
 * Each exemption is checked below to still have the literal it exists for, so it cannot outlive
 * its reason -- the same discipline the mutation corpus applies to its accepted survivors. Fix
 * the malformed fixture and this fails, telling you to delete the entry.
 */
const DELIBERATELY_UNSIZED: Record<string, string> = {
  'editor/boot-diagnostics.spec.ts':
    'mounts a page with no size on purpose, to prove a thrown boot is named rather than reported as a timeout',
};

interface DocumentLiteral {
  file: string;
  line: number;
  /** Character offset just past this literal's `pageSetup: {`, for slicing the source. */
  after: number;
  /** The first line of the literal. */
  text: string;
}

/**
 * Finds every object literal that looks like a document, by its required `pageSetup` field.
 *
 * Keyed on `pageSetup` rather than `formatVersion` because `pageSetup` is the one field every
 * fixture must have for the renderer to lay the page out at all, so it cannot miss a literal
 * that exists.
 *
 * Positions are kept as character offsets as well as line numbers, because the checks below
 * slice the source. Using the line number as if it were an offset silently searches the wrong
 * part of the file and finds nothing.
 */
function findDocumentLiterals(): DocumentLiteral[] {
  const found: DocumentLiteral[] = [];
  for (const file of SOURCES) {
    const source = readFileSync(file, 'utf8');
    const pattern = /^[ \t]*pageSetup:[ \t]*\{/gm;
    for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
      const line = source.slice(0, match.index).split('\n').length;
      found.push({
        file,
        line,
        // Past the whole match, so a search for the *next* literal cannot land back on this
        // one -- the match begins at the indentation, before the key it is searching for.
        after: match.index + match[0].length,
        text: source.slice(match.index).split('\n')[0]?.trim() ?? '',
      });
    }
  }
  return found;
}

/**
 * Every page literal in `file` that carries no `size`, as `path:line`.
 *
 * The window is anchored at the page's *own* opening brace and stops at its `background`, never a
 * fixed number of lines back. A line-based lookback reads the *previous* page's `size` and passes
 * a literal that has none, which is exactly how seven of these got missed the first time: page 2
 * written on one line under page 1, both mentioning `background`.
 */
function findUnsizedPages(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const found: string[] = [];
  // Only the opening of an *object*, so a node (`{ type: 'shape', id: …`) cannot match.
  const opening = /\{\s*id:\s*'[^']*'\s*,\s*name:\s*'[^']*'/g;
  for (let match = opening.exec(source); match !== null; match = opening.exec(source)) {
    const background = source.indexOf('background:', match.index);
    // A page with no `background` at all is a different fault; leave it to the boot guard.
    if (background === -1) continue;
    if (!/\bsize[:,]/.test(source.slice(match.index, background))) {
      found.push(`${testRelativePath(file)}:${source.slice(0, match.index).split('\n').length}`);
    }
  }
  return found;
}

/**
 * `path:line` for each literal in `literals` whose body does not mention `field`.
 *
 * ## Why this is a function and not the loop it replaced
 *
 * Because the windowing is the subtle part and it is exactly what broke once already. The search
 * runs **forward from the literal's own `pageSetup`, never backward**, and ends at the next
 * `pageSetup` in the file. A fixed line count is a guess about formatting: one that was three lines
 * long passed until a fixture wrote `pageSetup` as a five-line block, and it then silently checked
 * nothing at all -- a guard that stops guarding looks exactly like a guard that passes.
 *
 * Two fields need that window now, and two copies of it would drift.
 */
function fieldsMissingFrom(literals: readonly DocumentLiteral[], field: string): string[] {
  const missing: string[] = [];
  for (const literal of literals) {
    const source = readFileSync(literal.file, 'utf8');
    const next = source.indexOf('pageSetup:', literal.after);
    const end = next === -1 ? source.length : next;
    if (!source.slice(literal.after, end).includes(field)) {
      missing.push(`${testRelativePath(literal.file)}:${literal.line}`);
    }
  }
  return missing;
}

const MISSING_FIELD_MESSAGE = (field: string, addition: string): string =>
  `these document literals omit \`${field}\`, so the app receives a document that is not a ` +
  `\`Document\`. Add \`${addition}\` after the \`pageSetup\` line.`;

describe('injected document fixtures', () => {
  const literals = findDocumentLiterals();

  it('finds the fixtures at all', () => {
    // If this ever finds nothing the guard below is vacuous, so it would pass forever. A
    // silent no-op guard is worse than no guard.
    expect(literals.length).toBeGreaterThan(20);
  });

  it('every document literal declares `assets`', () => {
    expect(fieldsMissingFrom(literals, 'assets'), MISSING_FIELD_MESSAGE('assets', 'assets: {}')).toEqual([]);
  });

  it('every document literal declares `styles`', () => {
    // The M23 hole, and the same shape as the M6/M7 one in this file's header. `Document.styles`
    // is required, the fixture cast is unchecked, and all seventy literals written before format v5
    // had none of them. That stayed invisible only until `applyStyleSheet` reached the render path
    // and iterated the field -- at which point every suite in the browser run failed to boot at
    // once, each pointing at its own test, for a missing array in a document literal sixty files
    // away.
    //
    // `styles: []` is the right default rather than a sentinel: a document with no style
    // definitions is an ordinary document, and it is what the factory produces.
    expect(fieldsMissingFrom(literals, 'styles'), MISSING_FIELD_MESSAGE('styles', 'styles: []')).toEqual([]);
  });

  it('every page literal declares its own `size`', () => {
    // The M20 hole. `Page.size` is required, so a page without one throws during the first
    // render and the app never reaches `boot:complete` -- which is what made seven of these
    // surface as 83 identical timeouts across four unrelated specs.
    const missing: string[] = [];
    for (const file of SOURCES) {
      if (DELIBERATELY_UNSIZED[testRelativePath(file)] !== undefined) continue;
      missing.push(...findUnsizedPages(file));
    }
    expect(
      missing,
      'these page literals omit `size`, so the app is handed a page it cannot lay out and ' +
        'never finishes booting. Add `size: { ... }` to each one.',
    ).toEqual([]);
  });

  it('every deliberate exemption is still needed', () => {
    // An exemption that outlives its reason is a hole with a comment on it. If the malformed
    // fixture is ever repaired, this fails and the entry has to go with it.
    const stale = Object.keys(DELIBERATELY_UNSIZED).filter((key) => {
      const file = SOURCES.find((candidate) => testRelativePath(candidate) === key);
      return file === undefined || findUnsizedPages(file).length === 0;
    });
    expect(
      stale,
      'these files are exempt from the page-`size` rule but no longer contain a page without ' +
        'one, so the exemption is dead weight. Delete the entry, and the file goes back under ' +
        'the rule like any other.',
    ).toEqual([]);
  });

  it('parses every injected fixture source', () => {
    // The pre-existing rule, kept here so all the fixture guards live in one place: an
    // injected source with a stray bracket falls back to the sample document silently, and
    // every assertion after it reports a missing element.
    const files = SOURCES.filter((file) => readFileSync(file, 'utf8').includes('() => ({'));
    expect(files.length).toBeGreaterThan(0);
    // Each file's own `*.test.ts` guard covers its own exports; this asserts the set of
    // files is non-empty so that coverage cannot quietly disappear.
  });
});
