/**
 * One source for `formatVersion`, and a structural argument for why.
 *
 * ## F15, in one line
 *
 * `createDocument` wrote `formatVersion: 1` and `persist/format.ts` declared `CURRENT_FORMAT_VERSION
 * = 1`. Two literals for one fact, in two files, in two layers, agreeing **by coincidence**. M12
 * changed the second to 2 and seventeen round-trip tests failed at once with *"the document is not
 * equal to itself after a round trip"* — a message that says nothing about versions and everything
 * about the duplication.
 *
 * ## Why the literal lives in `model/factory.ts`
 *
 * `persist/` is a leaf *beside* `model/` (ADR 0007) and `model` may not import it. So the version
 * cannot be owned by `persist/format.ts` and read by `createDocument`.
 *
 * The two honest options were:
 *
 * 1. write it down twice;
 * 2. move the constant.
 *
 * **A layer rule that forces a duplication is a reason to move the constant, not to write it down
 * twice.** So `CURRENT_FORMAT_VERSION` lives beside `createDocument` — which is where a document is
 * stamped — and `persist/format.ts` re-exports it so every existing import keeps working.
 *
 * ## What these tests are for
 *
 * Not the numbers. The numbers are checked in `validation.test.ts` and `golden-roundtrip.test.ts`.
 * These are for the *coupling*: that the two spellings are the same value, and — the part that
 * cannot be asserted from a value — that the layering permits the coupling rather than merely
 * tolerating it.
 */

import { describe, expect, it } from 'vitest';

import { CURRENT_FORMAT_VERSION as fromFactory } from '../../src/model/factory';
import { CURRENT_FORMAT_VERSION as fromFormat, MINIMUM_FORMAT_VERSION } from '../../src/persist/format';
import { createDocument } from '../../src/model/factory';
import { parse } from '../../src/persist/deserialize';
import { serializeToString } from '../../src/persist/serialize';
import { documentsEqual } from '../../src/model/document-equality';
import type { PersistedDocument } from '../../src/persist/format';

describe('the version has one owner', () => {
  it('the two spellings are the same value', () => {
    expect(fromFormat).toBe(fromFactory);
  });

  it('a document created by the factory and one parsed from bytes agree', () => {
    // The failure F15 produced, as a standing check. `documentsEqual` compares `formatVersion`, so
    // a duplicated literal shows up here as "the document I just made is not equal to the document I
    // just made" -- which is exactly as unhelpful as it was in M12.
    const created = createDocument({ name: 'Owned' });
    const parsed = parse(JSON.parse(serializeToString(created)) as PersistedDocument);
    expect(documentsEqual(parsed, created)).toBe(true);
    expect(parsed.formatVersion).toBe(created.formatVersion);
    expect(parsed.id).toBe(created.id);
    expect(parsed.name).toBe(created.name);
  });

  it('the factory re-export is the same binding, not a copy', () => {
    // A copy would pass the first test today and drift tomorrow. `===` on two imports of the same
    // primitive cannot distinguish them -- so this asserts the *intent*: that `persist/format` does
    // not declare its own. If someone replaces the re-export with a literal, the first test still
    // passes and this one's comment is the warning.
    //
    // The structural half of the argument lives in `eslint.config.js`'s layer rules: `model` may not
    // import `persist`, which is precisely why the constant had to move. A test cannot check a lint
    // rule, so it is stated here instead of pretended to be verified.
    expect(fromFormat).toBe(2);
    expect(MINIMUM_FORMAT_VERSION).toBeLessThan(fromFormat);
  });

  it('the accepted range is contiguous and covers the current version', () => {
    // One consequence of a *range* rather than a set, which is easy to forget when adding the next
    // version: a gap would mean a file from that version is silently unreadable, with no message
    // distinguishing "old" from "impossible".
    expect(MINIMUM_FORMAT_VERSION).toBe(1);
    expect(fromFormat).toBe(MINIMUM_FORMAT_VERSION + 1);
  });
});