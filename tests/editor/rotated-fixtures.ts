/**
 * A document with one **rotated** object of every kind, on two pages.
 *
 * Built for `selection-frame.spec.ts` and for nothing else. It exists because the interesting cases
 * are all rotated or degenerate, and the general fixtures are axis-aligned — which is precisely why
 * M10b's finding survived nine milestones (ADR 0011 §8 F6).
 *
 * Every object is **inside its page**, unlike `SHAPES`' `rect-rotated` at `y: 320` on a 300-high
 * page, which renders but cannot be clicked. That trap cost an M10b test a vacuous pass.
 *
 * ## Injected fixtures bypass the parser
 *
 * Worth knowing before writing one: `window.__P1_FIXTURE__` is used **as given**. It is not run
 * through `deserialize`, so `expectOnlyKeys` never sees it, `normalizeRichText` never runs, and a
 * wrong shape is not *refused* — it reaches the renderer and throws. This fixture's first draft used
 * `text.paragraphs` and an asset record of `{ id, inline, ... }`; both produced a bare page error
 * (`rich.blocks is not iterable`, `Cannot use 'in' operator to search for 'inline' in undefined`)
 * and **zero objects**, with no indication that the document was malformed.
 *
 * So the shapes below are the ones `src/persist/format.ts` declares, not the ones that read
 * naturally: `RichText` is `{ blocks: [{ kind: 'paragraph', runs: [{ text, format? }] }] }`, and an
 * asset record is `{ kind, mime, intrinsicWidth, intrinsicHeight, data: { inline } }`. Use the
 * builders in `tests/editor/image-fixtures.ts` for anything involving assets — they exist precisely
 * so this cannot drift.
 */

/** A 4×4 red PNG as a data URL. Small, solid, and never transparent, so hit tests are unambiguous. */
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mP8z8Dwn4GBgYEJRsAAI4EBvFqxbjAAAAAElFTkSuQmCC';

export const ROTATED_KINDS = `() => {
  const tf = (x, y, width, height, rotation) => ({
    x, y, width, height, rotation, scaleX: 1, scaleY: 1,
  });
  const solid = (color) => ({ type: 'solid', color });
  const base = (id, type, extra) => ({
    id, type, name: id, visible: true, locked: false, opacity: 1, blendMode: 'normal', ...extra,
  });
  const paragraph = (...runs) => ({ kind: 'paragraph', runs });
  const run = (text, format) => (format === undefined ? { text } : { text, format });

  return {
    formatVersion: 1, id: 'rotated', name: 'Rotated kinds',
    pageSize: { width: 900, height: 700, unit: 'pt', orientation: 'portrait' },
    assets: {
      a1: {
        kind: 'image', mime: 'image/png',
        intrinsicWidth: 4, intrinsicHeight: 4,
        data: { inline: ${JSON.stringify(PIXEL)} },
      },
    },
    pages: [
      {
        id: 'p1', name: '1',
        background: { type: 'solid', color: '#ffffff' },
        objects: [
          // Thirty degrees, on every kind. Enough to make a 1px chrome outline miss by tens of
          // pixels, which is what makes the difference measurable rather than arguable.
          base('r-rot', 'shape', {
            transform: tf(60, 60, 200, 100, Math.PI / 6),
            shape: { kind: 'rect', cornerRadius: 0 },
            fill: solid('#4f7cff'),
            // Stroked as well as filled, because ADR 0011 asks whether the stroke semantic is
            // the same for every kind, and this is the rotated CSS-border subject.
            stroke: { paint: solid('#111111'), width: 12, align: 'inside' },
          }),
          base('r-flat', 'shape', {
            transform: tf(60, 260, 200, 100, 0),
            shape: { kind: 'rect', cornerRadius: 0 },
            fill: solid('#4f7cff'),
          }),
          base('e-rot', 'shape', {
            transform: tf(340, 70, 160, 100, -Math.PI / 5),
            shape: { kind: 'ellipse' },
            fill: solid('#ffd166'),
          }),
          base('l-rot', 'shape', {
            transform: tf(360, 250, 180, 0, Math.PI / 6),
            shape: { kind: 'line' },
            stroke: { paint: solid('#111111'), width: 8, align: 'inside' },
          }),
          base('t-rot', 'textFrame', {
            transform: tf(60, 430, 220, 90, Math.PI / 6),
            text: {
              blocks: [
                paragraph(run('Frame one')),
                paragraph(run('Frame two', { bold: true })),
              ],
            },
          }),
          base('i-rot', 'image', {
            transform: tf(340, 430, 160, 160, Math.PI / 6),
            asset: 'a1',
            fit: 'fill',
          }),
          // Degenerate on purpose: a zero-height line, which is a legitimate object and has to get a
          // frame and a grip like any other.
          base('l-zero', 'shape', {
            transform: tf(560, 560, 160, 0, 0),
            shape: { kind: 'line' },
            stroke: { paint: solid('#111111'), width: 8, align: 'inside' },
          }),
        ],
      },
      {
        id: 'p2', name: '2',
        background: { type: 'solid', color: '#ffffff' },
        objects: [
          base('r-rot-p2', 'shape', {
            transform: tf(80, 80, 180, 90, Math.PI / 5),
            shape: { kind: 'rect', cornerRadius: 0 },
            fill: solid('#8ac926'),
          }),
        ],
      },
    ],
  };
}`;