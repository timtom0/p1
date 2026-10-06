import { expect, it } from 'vitest';
import { ALL_FIXTURES } from './measure-fixtures';

/**
 * Every measurement fixture must parse as the injected source it claims to be.
 *
 * `mountFixture` evaluates `window.__P1_FIXTURE__ = (<source>)` before the app boots.
 * A malformed source throws, and the app *silently falls back to the sample document* —
 * so the probe then reports "no element for [data-oid=\"copy\"]" and the real cause is
 * a bracket three screens away.
 *
 * Three of these fixtures were broken that way and cost a debugging cycle. The symptom
 * was a missing element, which points at the probe; the cause was a typo in a fixture,
 * which points nowhere. So the fixtures are guarded here, where the failure names
 * itself.
 */
it('every measurement fixture parses as an injected factory', () => {
  for (const [name, source] of Object.entries(ALL_FIXTURES)) {
    let built: unknown;
    try {
      // Parsing injected source is the entire point of this guard.
      built = new Function(`return (${source});`)();
    } catch (error) {
      throw new Error(
        `Fixture ${name} is not valid injected source: ${(error as Error).message}`,
      );
    }
    expect(typeof built, `${name} should be a function`).toBe('function');
    expect((built as () => unknown)(), `${name} should return a document`).toHaveProperty('pages');
  }
});

it('every measurement fixture names its frame "copy", which the selectors assume', () => {
  for (const [name, source] of Object.entries(ALL_FIXTURES)) {
    const factory = new Function(`return (${source});`)() as () => {
      pages: { objects: { id: string; type: string }[] }[];
    };
    for (const page of factory().pages) {
      for (const object of page.objects) {
        expect(object.id, `${name} object id`).toBe('copy');
      }
    }
  }
});
