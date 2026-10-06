import { expect, it } from 'vitest';
import { ALL_FIXTURES, GEOMETRY } from './shape-fixtures';
import { shapeKinds, shapeSpec, layoutBoxOf } from '../../src/model/shapes';
import type { ShapeNode } from '../../src/model/types';
import { createShapeNode } from '../../src/model/factory';

/**
 * Guards for the shape fixture and the registry it exercises.
 *
 * The fixture guard exists because a malformed injected source **fails silently**: the
 * app falls back to the sample document and every assertion then reports a missing
 * element, which points at the spec while the cause is a typo in a string three screens
 * away. Three measurement fixtures were lost to that once.
 */

interface FixtureShape {
  pages: { objects: { id: string; type: string }[] }[];
}

function build(source: string): unknown {
  // Parsing injected source is the entire point of this guard.
  return new Function(`return (${source});`)();
}

it('every shape fixture parses as an injected factory', () => {
  for (const [name, source] of Object.entries(ALL_FIXTURES)) {
    let built: unknown;
    try {
      built = build(source);
    } catch (error) {
      throw new Error(`Fixture ${name} is not valid injected source: ${(error as Error).message}`);
    }
    expect(typeof built, `${name} should be a function`).toBe('function');
    expect((built as () => unknown)(), `${name} should return a document`).toHaveProperty('pages');
  }
});

it('the shape fixture names every object the geometry table lists, and no others', () => {
  // A test asserting against `GEOMETRY` for an id the fixture does not contain would
  // click empty space and conclude the feature was broken.
  const doc = (build(ALL_FIXTURES['SHAPES'] ?? '') as () => FixtureShape)();
  const ids = doc.pages.flatMap((page) => page.objects.map((object) => object.id)).sort();
  expect(ids).toEqual(Object.keys(GEOMETRY).sort());
});

it('the shape fixture is paint-order stable, so overlap has a known answer', () => {
  const doc = (build(ALL_FIXTURES['SHAPES'] ?? '') as () => FixtureShape)();
  const objects = doc.pages[0]?.objects ?? [];
  // Later in the array is on top, so `overlap-front` must come after `overlap-back`.
  // Reversed, the paint-order assertion would still pass while meaning the opposite.
  expect(objects.findIndex((o) => o.id === 'overlap-back')).toBeLessThan(
    objects.findIndex((o) => o.id === 'overlap-front'),
  );
});

it('every registered kind has a label, and the labels are unique', () => {
  const labels = shapeKinds().map((kind) => shapeSpec(kind).label);
  expect(new Set(labels).size).toBe(labels.length);
  for (const label of labels) expect(label.length).toBeGreaterThan(0);
});

it('every registered kind can be created by the factory without a throw', () => {
  // The factory's default geometry is exhaustive-checked by TypeScript, so this is the
  // runtime half of the same guarantee: a kind that survives compilation still has to
  // produce a node the renderer and hit tester can handle.
  for (const kind of shapeKinds()) {
    const node = createShapeNode(kind);
    expect(node.type).toBe('shape');
    expect(node.shape.kind).toBe(kind);
    expect(layoutBoxOf(node as ShapeNode)).toEqual({ width: 0, height: 0 });
  }
});