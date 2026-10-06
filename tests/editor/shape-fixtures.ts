/**
 * Fixtures for the graphical-object suite (ADR 0005).
 *
 * Separate from `helpers.ts`'s `FIXTURE` for two reasons:
 *
 *  - These are **injected source strings**, so a stray bracket is invisible until the app
 *    silently falls back to the sample document and every assertion reports a missing
 *    element. `shape-fixtures.test.ts` parses them, so a typo names itself.
 *  - The M2 fixture must not change. Geometry, navigation and typography baselines are
 *    written against it, so adding shapes there would invalidate work that is not about
 *    shapes.
 *
 * Object geometry is in **CSS px** (the model's internal unit); `pageSize` is in points,
 * the only thing that crosses the authoring boundary. The page is 450×300pt = 600×400px,
 * which fits a 1:1 screenshot.
 *
 * Every object is placed so no two *properties under test* overlap, unless overlap is the
 * thing being tested. The one deliberate overlap is `overlap-back`/`overlap-front`, and a
 * click inside it is only ever asserted as a paint-order result.
 */

/**
 * Every shape kind, plus the awkward cases.
 *
 * The fixture is deliberately *one* document rather than several: paint order, overlap
 * and rotation only mean anything relative to each other, and a suite that asserted
 * them across separate mounts would be asserting nothing about them together.
 */
export const SHAPES = `() => {
  const tf = (x, y, width, height, rotation = 0) => ({
    x, y, width, height, rotation, scaleX: 1, scaleY: 1,
  });
  const solid = (color) => ({ type: 'solid', color });
  const stroke = (color, width) => ({ paint: solid(color), width, align: 'inside' });
  const node = (id, kind, transform, extra = {}) => ({
    id, type: 'shape', name: id, transform,
    visible: true, locked: false, opacity: 1, blendMode: 'normal',
    shape: kind, ...extra,
  });

  return {
    formatVersion: 1, id: 'shapes', name: 'Shapes',
    pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
    assets: {},
    pages: [{
      id: 'p1', name: '1',
      background: { type: 'solid', color: '#ffffff' },
      objects: [
        // A plain filled rectangle: the control case for fill.
        node('rect-plain', { kind: 'rect', cornerRadius: 0 }, tf(40, 40, 120, 80), {
          fill: solid('#4f7cff'),
        }),

        // The same box with a thick inside stroke. Its border box must still be
        // 120x80 - that is the geometry contract, not a rendering detail.
        node('rect-stroked', { kind: 'rect', cornerRadius: 0 }, tf(200, 40, 120, 80), {
          fill: solid('#ffd166'),
          stroke: stroke('#000000', 12),
        }),

        // A corner radius, for the CSS projection of a rect-only model field.
        node('rect-round', { kind: 'rect', cornerRadius: 28 }, tf(360, 40, 120, 80), {
          fill: solid('#06d6a0'),
        }),

        // 140x100, so the ellipse's corners are unambiguously inside the box and
        // outside the shape - the disagreement this geometry exists to expose.
        node('ellipse', { kind: 'ellipse' }, tf(40, 170, 140, 100), {
          fill: solid('#ef476f'),
        }),

        // Rotated 30 degrees about its centre. Every layout API is transform-invariant,
        // so its offsetWidth is still the model width.
        node('ellipse-rotated', { kind: 'ellipse' }, tf(230, 170, 140, 100, 0.5235987755982988), {
          fill: solid('#8b5cf6'),
        }),

        // A horizontal line: height 0. The browser cannot hit-test this; the editor can.
        node('line-h', { kind: 'line' }, tf(410, 200, 160, 0), {
          stroke: stroke('#000000', 6),
        }),

        // A diagonal line, so the segment is not the box's long axis.
        node('line-d', { kind: 'line' }, tf(410, 240, 150, 110), {
          stroke: stroke('#000000', 6),
        }),

        // A stroke-less line: nothing is painted, but it must still be findable, because
        // a line the user cannot click is a line they cannot fix.
        node('line-bare', { kind: 'line' }, tf(410, 370, 150, 0), {}),

        // A rotated rectangle, for the rotated hit test.
        node('rect-rotated', { kind: 'rect', cornerRadius: 0 }, tf(40, 320, 140, 60, 0.7853981633974483), {
          fill: solid('#118ab2'),
        }),

        // A text frame, so the suite can assert that the appearance section offers nothing
        // for a node that has no fill or stroke. Without one, "the section is hidden for
        // the wrong kind of selection" would be indistinguishable from "the section is
        // hidden for a shape".
        {
          id: 'copy', type: 'textFrame', name: 'copy',
          transform: { x: 490, y: 40, width: 90, height: 70, rotation: 0, scaleX: 1, scaleY: 1 },
          visible: true, locked: false, opacity: 1, blendMode: 'normal',
          style: { fontSize: 16 },
          text: { blocks: [{ kind: 'paragraph', runs: [{ text: 'Notes' }] }] },
        },

        // Two overlapping rectangles. The front one is later in paint order.
        node('overlap-back', { kind: 'rect', cornerRadius: 0 }, tf(210, 300, 120, 80), {
          fill: solid('#ff0000'),
        }),
        node('overlap-front', { kind: 'rect', cornerRadius: 0 }, tf(270, 330, 120, 60), {
          fill: solid('#00ff00'),
        }),
      ],
    }],
  };
}`;

/**
 * An empty page, for creation.
 *
 * Creation assertions need an uncluttered surface: with objects already present, "the
 * drag created a rectangle" and "the drag selected something" are the same observation,
 * and a test that cannot tell them apart is not testing creation.
 */
export const EMPTY_PAGE = `() => ({
  formatVersion: 1, id: 'empty', name: 'Empty',
  pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [],
  }],
})`;

/** `EMPTY_PAGE` with one stroked rectangle, for inspector and multi-select tests. */
export const TWO_RECTS = `() => ({
  formatVersion: 1, id: 'two', name: 'Two',
  pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [
      {
        id: 'left', type: 'shape', name: 'left',
        transform: { x: 40, y: 40, width: 120, height: 80, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#4f7cff' },
        stroke: { paint: { type: 'solid', color: '#000000' }, width: 4, align: 'inside' },
      },
      {
        id: 'right', type: 'shape', name: 'right',
        transform: { x: 240, y: 180, width: 120, height: 80, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        shape: { kind: 'rect', cornerRadius: 0 },
        fill: { type: 'solid', color: '#4f7cff' },
        // A *different* stroke width, so a test can tell whether committing one object's
        // weight accidentally overwrote the other's.
        stroke: { paint: { type: 'solid', color: '#000000' }, width: 9, align: 'inside' },
      },
    ],
  }],
})`;

/** Every fixture, so the syntax guard can check them all. */
export const ALL_FIXTURES: Record<string, string> = {
  SHAPES,
  EMPTY_PAGE,
  TWO_RECTS,
};

/**
 * The fixture's object geometry in **document px** — the space every assertion is in.
 *
 * Kept beside the fixture rather than in each test, because a test that re-typed the
 * numbers would no longer be checking the geometry against anything.
 */
export const GEOMETRY = {
  'rect-plain': { x: 40, y: 40, width: 120, height: 80 },
  'rect-stroked': { x: 200, y: 40, width: 120, height: 80 },
  'rect-round': { x: 360, y: 40, width: 120, height: 80 },
  ellipse: { x: 40, y: 170, width: 140, height: 100 },
  'ellipse-rotated': { x: 230, y: 170, width: 140, height: 100 },
  'line-h': { x: 410, y: 200, width: 160, height: 0 },
  'line-d': { x: 410, y: 240, width: 150, height: 110 },
  'line-bare': { x: 410, y: 370, width: 150, height: 0 },
  'rect-rotated': { x: 40, y: 320, width: 140, height: 60 },
  'overlap-back': { x: 210, y: 300, width: 120, height: 80 },
  'overlap-front': { x: 270, y: 330, width: 120, height: 60 },
  copy: { x: 490, y: 40, width: 90, height: 70 },
} as const;