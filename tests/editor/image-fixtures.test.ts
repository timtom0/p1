import { expect, it } from 'vitest';
import { ALL_FIXTURES, documentWithImages } from './image-fixtures';

/**
 * Guards for the image fixture builders.
 *
 * The builders exist because the image suite needs documents with *specific asset
 * states* — loaded, missing, external — and hand-writing that JSON is how a fixture ends
 * up disagreeing with the test's description of it.
 */

/**
 * Evaluates injected source and returns the **factory**.
 *
 * `new Function('return (' + source + ');')()` wraps the source in parentheses, so what
 * comes back is the arrow function itself; the document is one more call away. A first
 * version of the tests forgot that call and reported `assets` as `undefined` on a
 * perfectly good fixture — which is worth a comment, because the symptom points at the
 * fixture rather than at the mistake.
 */
function factory(source: string): () => unknown {
  return new Function(`return (${source});`)() as () => unknown;
}

it('every image fixture parses as an injected factory', () => {
  for (const [name, source] of Object.entries(ALL_FIXTURES)) {
    let built: unknown;
    try {
      built = factory(source);
    } catch (error) {
      throw new Error(`Fixture ${name} is not valid injected source: ${(error as Error).message}`);
    }
    expect(typeof built, `${name} should be a function`).toBe('function');
    expect((built as () => unknown)(), `${name} should return a document`).toHaveProperty('pages');
  }
});

interface FixtureDocument {
  assets: Record<string, unknown>;
  pages: { objects: { asset: string }[] }[];
}

it('a generated document declares assets for the nodes that reference them', () => {
  const source = documentWithImages(
    JSON.stringify({
      asset_1: {
        kind: 'image',
        mime: 'image/png',
        intrinsicWidth: 4,
        intrinsicHeight: 2,
        data: { inline: 'data:image/png;base64,AA' },
      },
    }),
    '[{ "id": "n1", "type": "image", "asset": "asset_1" }]',
  );
  const doc = factory(source)() as FixtureDocument;

  expect(Object.keys(doc.assets)).toEqual(['asset_1']);
  // Every node's asset must exist. A dangling reference renders as an empty box, which is
  // the exact silent failure the contract is designed to prevent — so the *fixture* must
  // not be able to contain one by accident.
  for (const page of doc.pages) {
    for (const object of page.objects) {
      expect(doc.assets, `asset "${object.asset}" must exist`).toHaveProperty(object.asset);
    }
  }
});

it('a document with no assets still parses, for insertion tests', () => {
  const doc = factory(ALL_FIXTURES['EMPTY_PAGE'] ?? '')() as FixtureDocument;
  expect(doc.assets).toEqual({});
  expect(doc.pages).toHaveLength(1);
});