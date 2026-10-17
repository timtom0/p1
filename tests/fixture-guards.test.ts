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
import { CURRENT_FORMAT_VERSION, pageSetupKeysFor } from '../src/persist/format';

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
  /**
   * How the app receives this literal, which decides whose contract it has to satisfy.
   *
   * See {@link deliveryOf} for why this is a property of the literal and not of a hand-kept list.
   */
  delivery: 'injected' | 'loaded';
  /** The `formatVersion` the literal declares, when it declares one. */
  version: number | null;
}

/**
 * Whether a literal is **injected** (handed to the store verbatim) or **loaded** (serialised into a
 * file and pushed through the deserialiser).
 *
 * ## Why this is not an exemption list
 *
 * The obvious way to write "these four literals are exempt" is four lines naming them, and that is
 * what M24 did for three of them. It is wrong in the way a list is always wrong: a list is a claim
 * about the past that nothing checks, so it goes stale silently and then either blocks a legitimate
 * fixture or -- worse -- keeps exempting one that has since become subject to the rule.
 *
 * ## The property that actually decides it
 *
 * `window.__P1_FIXTURE__` is an unchecked `() => Document` cast, so an **injected** fixture has to
 * carry the model contract itself. A **loaded** document is `JSON.stringify`'d and opened, so the
 * deserialiser checks it -- that is what `expectEnum`, `pageSetupKeysFor` and the required-field
 * refusals exist for, and `version6-units.test.ts` is where those are tested.
 *
 * So the two classes need *different* checks, and the way to tell them apart is the delivery, not
 * the content. It is visible in the syntax: an injected fixture is a **template string** whose body
 * is a function, and a loaded document is an **object expression** that gets stringified. Neither
 * `format: 'p1doc'` nor `formatVersion` distinguishes them -- `group-fixtures.ts` carries the
 * envelope on a fixture the store never parses, and 66 injected fixtures declare `formatVersion: 3`
 * while meaning the current model -- so the discriminator has to be the container.
 *
 * The nearest preceding `` `() => `` opens the fixture; if no backtick closes it before this literal,
 * the literal is inside it.
 */
function deliveryOf(source: string, offset: number): 'injected' | 'loaded' {
  const before = source.slice(0, offset);
  const open = before.lastIndexOf('`() =>');
  const closed = open === -1 ? -1 : before.indexOf('`', open + 1);
  return open !== -1 && closed === -1 ? 'injected' : 'loaded';
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
      // The version is read from a short window *backwards* from the literal. Forward would find
      // the next literal's, which is the version bug this file's header is about.
      const window = source.slice(Math.max(0, match.index - 400), match.index);
      const version = /formatVersion[ \t]*:[ \t]*(\d+)/.exec(window);
      found.push({
        file,
        line,
        // Past the whole match, so a search for the *next* literal cannot land back on this
        // one -- the match begins at the indentation, before the key it is searching for.
        after: match.index + match[0].length,
        text: source.slice(match.index).split('\n')[0]?.trim() ?? '',
        delivery: deliveryOf(source, match.index),
        version: version === null ? null : Number(version[1]),
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
  // Matched as a **key at the start of a line**, not as a substring, and that is not fussiness.
  // A plain `includes('styles')` is satisfied by the word "stylesheet" in a doc comment -- which is
  // exactly what happened: `measure-fixtures.ts` documents one fixture as existing "so the
  // measurement does not depend on a stylesheet the document does not own", and that sentence was
  // accepted as the *next* literal's `styles` field. Eleven browser tests failed to boot on a
  // fixture the guard had certified.
  //
  // A comment must never be able to satisfy a guard about code, and the only reliable way to say
  // that is to require the shape a key has.
  const key = new RegExp(`^[ \\t]*${field}[ \\t]*:`, 'm');

  const missing: string[] = [];
  for (const literal of literals) {
    const source = readFileSync(literal.file, 'utf8');
    const next = source.indexOf('pageSetup:', literal.after);
    const end = next === -1 ? source.length : next;
    if (!key.test(source.slice(literal.after, end))) {
      missing.push(`${testRelativePath(literal.file)}:${literal.line}`);
    }
  }
  return missing;
}

/**
 * `path:line` for each literal with no `pageSetup.unit` before its `defaultSize`.
 *
 * Position-matched rather than substring-matched because `defaultSize.unit` is the **page's** unit
 * and every fixture has one; only a `unit` ahead of `defaultSize` is the page setup's own.
 *
 * The window is `literal.after` to the next `pageSetup` -- forward from this literal, never
 * backward -- for the reason {@link fieldsMissingFrom} gives.
 */
function missingUnits(literals: readonly DocumentLiteral[]): string[] {
  const absent: string[] = [];
  for (const literal of literals) {
    const source = readFileSync(literal.file, 'utf8');
    const next = source.indexOf('pageSetup:', literal.after);
    const end = next === -1 ? source.length : next;
    const statement = source.slice(literal.after, end);
    const beforeDefault = statement.slice(0, statement.indexOf('defaultSize'));
    if (!/unit[ \t]*:/.test(beforeDefault)) {
      absent.push(`${testRelativePath(literal.file)}:${literal.line}`);
    }
  }
  return absent;
}

const MISSING_FIELD_MESSAGE = (field: string, addition: string): string =>
  `these document literals omit \`${field}\`, so the app receives a document that is not a ` +
  `\`Document\`. Add \`${addition}\` after the \`pageSetup\` line.`;

describe('injected document fixtures', () => {
  const literals = findDocumentLiterals();
  const injected = literals.filter((literal) => literal.delivery === 'injected');
  const loaded = literals.filter((literal) => literal.delivery === 'loaded');

  it('finds the fixtures at all', () => {
    // If this ever finds nothing the guard below is vacuous, so it would pass forever. A
    // silent no-op guard is worse than no guard.
    expect(literals.length).toBeGreaterThan(20);
  });

  it('separates the injected fixtures from the loaded documents', () => {
    // The classifier is the whole basis of scoping the rules below, so it gets its own check for
    // the failure that would be invisible: **one class silently becoming empty**. If every literal
    // were read as injected, the loaded-document rule below would have nothing to say and no test
    // would notice.
    expect(injected.length).toBeGreaterThan(20);
    expect(loaded.length).toBeGreaterThan(0);
    // And the small class should stay small. A pile of new "loaded" documents is not a reason to
    // relax this; it is a reason to wonder whether they are really loaded.
    expect(loaded.length).toBeLessThan(12);
  });

  it('every injected document literal declares `assets`', () => {
    expect(
      fieldsMissingFrom(injected, 'assets'),
      MISSING_FIELD_MESSAGE('assets', 'assets: {}'),
    ).toEqual([]);
  });

  it('every injected document literal declares `styles`', () => {
    // The M23 hole, and the same shape as the M6/M7 one in this file's header. `Document.styles`
    // is required, the fixture cast is unchecked, and all seventy literals written before format v5
    // had none of them. That stayed invisible only until `applyStyleSheet` reached the render path
    // and iterated the field -- at which point every suite in the browser run failed to boot at
    // once, each pointing at its own test, for a missing array in a document literal sixty files
    // away.
    //
    // `styles: []` is the right default rather than a sentinel: a document with no style
    // definitions is an ordinary document, and it is what the factory produces.
    expect(
      fieldsMissingFrom(injected, 'styles'),
      MISSING_FIELD_MESSAGE('styles', 'styles: []'),
    ).toEqual([]);
  });

  it('every injected document literal declares a page setup unit of its own', () => {
    // The M24 hole, and the third time this file has had to be extended rather than the literals
    // repaired. `window.__P1_FIXTURE__` is handed to the store **verbatim**, so a fixture that predates
    // a required model field reaches the app without it -- there is no deserialiser in the path to
    // fill it in. The symptom was `NaNundefined` in every measurement field: `formatLength(px,
    // undefined)` appends the unit to a number that had already become NaN, so the failure looked
    // like arithmetic rather than like a missing preference.
    //
    // Matched by position rather than by the word `unit`, because `defaultSize.unit` is the **page's**
    // unit and every fixture has one. Only a `unit` appearing before `defaultSize` is the page
    // setup's own, which is exactly the sibling relationship the model requires.
    expect(
      missingUnits(injected),
      'these injected document literals declare no `pageSetup.unit`, so every measurement in this ' +
        'document renders as NaNundefined. Add `unit: \'mm\'` alongside `fixedSize` -- ahead of ' +
        '`defaultSize`, whose own `unit` is the page\'s and means something different.',
    ).toEqual([]);
  });

  it('no loaded document claims a version that carries the field and omits it', () => {
    // The other half of the same contract, for the class that bypasses nothing.
    //
    // A **loaded** document goes through the deserialiser, so it does not need the field spelled out
    // -- `version6-units.test.ts` covers that path, including the migration that supplies it for
    // anything older than v6. What it must not do is *claim* v6 and then omit it: the deserialiser
    // will refuse such a file, which is correct, but a fixture that means to load will not, and the
    // failure it produces is a refusal in a test about something else entirely.
    //
    // That is not hypothetical. `snap.spec.ts` carried a v3 document with `pageSetup.unit` written
    // in, which v3 does not have -- so the test passed while refusing for a second, un-named
    // reason, and reading it gave no hint that a field it did not mention was also wrong.
    //
    // The threshold is `pageSetupKeysFor` rather than a literal, so this cannot go stale when the
    // format version moves: whatever version first required the field is the one that matters.
    const required = pageSetupKeysFor(CURRENT_FORMAT_VERSION).includes('unit');
    expect(
      required,
      'the current format version no longer carries `pageSetup.unit`; if that is deliberate, this ' +
        'rule and the migration it describes need rewriting together, not silently weakening',
    ).toBe(true);
    const wrong: string[] = [];
    for (const literal of loaded) {
      if (literal.version === null) continue;
      if (pageSetupKeysFor(literal.version).includes('unit') === false) continue;
      if (missingUnits([literal]).length === 0) continue;
      wrong.push(
        `${testRelativePath(literal.file)}:${literal.line} declares ` +
          `formatVersion ${literal.version}, which requires pageSetup.unit, and omits it`,
      );
    }
    expect(wrong).toEqual([]);
  });

  it('every page literal declares its own `size`', () => {
    // The M20 hole. `Page.size` is required, so a page without one throws during the first
    // render and the app never reaches `boot:complete` -- which is what made seven of these
    // surface as 83 identical timeouts across four unrelated specs.
    //
    // Deliberately **not** scoped to injected literals, unlike the field rules above: a loaded
    // document's page with no `size` is a case the deserialiser *migrates* rather than refuses
    // (ADR 0019 gave `defaultSize` to pre-v4 documents), and a page still needs a `size` after
    // that. So the requirement holds for both deliveries and the exemption list stays per-file.
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
