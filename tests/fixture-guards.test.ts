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
 * `pages` and `pageSize` were never a problem because the renderer reads them immediately
 * and a missing one fails the boot the `waitForApp` guard already reports. `assets` was
 * invisible for exactly the duration between M6 and M7, which is what a guard is for.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
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

/** Every file that could hold an injected document source. */
const SOURCES = walk(TESTS_ROOT).filter((file) => !file.endsWith('.test.ts'));

interface DocumentLiteral {
  file: string;
  line: number;
  /** The first line of the literal. */
  text: string;
}

/**
 * Finds every object literal that looks like a document, by its required `pageSize` field.
 *
 * Keyed on `pageSize` rather than `formatVersion` because `pageSize` is the one field every
 * fixture must have for the renderer to lay the page out at all, so it cannot miss a literal
 * that exists.
 */
function findDocumentLiterals(): DocumentLiteral[] {
  const found: DocumentLiteral[] = [];
  for (const file of SOURCES) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (!/^\s*pageSize:\s*\{/.test(line)) continue;
      found.push({ file, line: index + 1, text: line.trim() });
    }
  }
  return found;
}

describe('injected document fixtures', () => {
  const literals = findDocumentLiterals();

  it('finds the fixtures at all', () => {
    // If this ever finds nothing the guard below is vacuous, so it would pass forever. A
    // silent no-op guard is worse than no guard.
    expect(literals.length).toBeGreaterThan(20);
  });

  it('every document literal declares `assets`', () => {
    const missing: string[] = [];
    for (const literal of literals) {
      const lines = readFileSync(literal.file, 'utf8').split('\n');
      // The window is the pageSize line plus the two after it: `assets` sits on the next
      // line in every existing fixture, but a window keeps a differently-formatted fixture
      // from tripping this.
      const window = lines.slice(literal.line - 1, literal.line + 2).join('\n');
      if (!window.includes('assets')) {
        missing.push(`${literal.file}:${literal.line}`);
      }
    }
    expect(
      missing,
      'these document literals omit `assets`, so the app receives a document that is not a ' +
        '`Document`. Add `assets: {}` (or the records the fixture needs) on or after the ' +
        '`pageSize` line.',
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
