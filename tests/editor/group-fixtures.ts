/**
 * A document whose objects live inside groups, at several depths.
 *
 * ## Why a dedicated fixture
 *
 * Every general fixture in this project is flat, so every general test is a flat test. That is not a
 * criticism of them — a flat document is the overwhelmingly common case — but it means a hierarchy
 * has no coverage at all unless something deliberately builds one. M11's F6 survived nine
 * milestones for exactly this reason, and the browser suite could not see it.
 *
 * ## Two habits this fixture exists to keep
 *
 * 1. **Every object is inside its page.** `SHAPES`' `rect-rotated` sits at `y: 320` on a 300-high
 *    page: it renders and cannot be clicked, so a test that selects it does nothing and passes
 *    vacuously. Rotated extents are checked against the page bounds here for that reason.
 * 2. **Injected fixtures bypass the parser** (ADR 0011b §10 F12), so shapes written here that are
 *    wrong will *crash* rather than be refused. The shapes are therefore built from the same
 *    declaration style the persistence tests use, and the browser suite asserts geometry rather
 *    than DOM existence.
 */

/** A 4x4 PNG. Solid, never transparent, so hit tests and painted-bounds probes are unambiguous. */
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mP8z8Dwn4GBgYEJRsAAI4EBvFqxbjAAAAAElFTkSuQmCC';

export const GROUPS = `() => {
  const tf = (x, y, width, height, rotation, scale) => ({
    x, y, width, height, rotation,
    scaleX: scale === undefined ? 1 : scale,
    // Uniform by default. A *leaf* may be non-uniform and one fixture child is, but a group may
    // not, and writing it uniformly by default means a test that needs a non-uniform group has to
    // say so -- which is what the parser refuses.
    scaleY: scale === undefined ? 1 : scale,
  });
  const base = (id, type, extra) => ({
    id, type, name: id, visible: true, locked: false, opacity: 1, blendMode: 'normal', ...extra,
  });
  const group = (id, children, transform, extra) =>
    // The fourth argument exists so a group can be hidden or locked, which is the whole point of
    // those fields on a *container*: without a way to author them, the semantics they are supposed
    // to have cannot be tested.
    base(id, 'group', { transform, children, ...extra });
  const solid = (color) => ({ type: 'solid', color });
  const paragraph = (...runs) => ({ kind: 'paragraph', runs });

  return {
    formatVersion: 2,
    format: 'p1doc',
    id: 'grouped',
    name: 'Grouped kinds',
    pageSize: { width: 900, height: 800, unit: 'pt', orientation: 'portrait' },
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
          // A group holding one of every kind, rotated and uniformly scaled by 1.5. Nothing inside
          // it is rotated on its own, so every painted position in this group is the product of the
          // group's transform alone -- which is the case a test can predict by hand.
          group('g-kinds', [
            base('k-rect', 'shape', {
              transform: tf(20, 20, 120, 60, 0),
              shape: { kind: 'rect', cornerRadius: 0 },
              fill: solid('#4f7cff'),
              stroke: { paint: solid('#111111'), width: 8, align: 'inside' },
            }),
            base('k-ellipse', 'shape', {
              transform: tf(170, 20, 100, 70, 0),
              shape: { kind: 'ellipse' },
              fill: solid('#ffd166'),
            }),
            base('k-line', 'shape', {
              transform: tf(20, 120, 240, 0, 0),
              shape: { kind: 'line' },
              stroke: { paint: solid('#111111'), width: 8, align: 'inside' },
            }),
            base('k-text', 'textFrame', {
              transform: tf(20, 160, 200, 70, 0),
              text: { blocks: [paragraph({ text: 'inside a group' })] },
            }),
            base('k-image', 'image', {
              transform: tf(250, 150, 90, 90, 0),
              asset: 'a1',
            }),
          ], tf(60, 200, 360, 260, 0.35, 1.5)),

          // A group rotated 90 degrees, holding a single unrotated rectangle. The simplest
          // composition to verify by hand: the child ends up at the group's own orientation.
          group('g-rotated', [
            base('r-child', 'shape', {
              transform: tf(0, 0, 80, 40, 0),
              shape: { kind: 'rect', cornerRadius: 0 },
              fill: solid('#8ac926'),
            }),
          ], tf(480, 60, 100, 100, Math.PI / 2, 1)),

          // Nesting: an outer group rotated 30 degrees holding an inner group rotated 60 degrees
          // holding a leaf. The leaf's world rotation is 90 degrees exactly, which is an
          // unambiguous number to assert -- and the same sum is proved at matrix level in
          // src/model/group-scale.test.ts, so the two are a pair rather than a duplicate.
          //
          // (No backticks in this comment: they would terminate the fixture's own template literal.
          // That is not a style note, it is a bug this file already had.)
          group('g-outer', [
            group('g-inner', [
              base('deep-leaf', 'shape', {
                transform: tf(10, 10, 60, 30, 0),
                shape: { kind: 'rect', cornerRadius: 0 },
                fill: solid('#ff595e'),
              }),
            ], tf(20, 20, 100, 100, Math.PI / 3, 1.25)),
          ], tf(470, 250, 150, 150, Math.PI / 6, 1)),

          // own visibility means: if it meant nothing, these two would paint on the page
          // and be clickable while the group claims to be hidden.
          group('g-hidden', [
            base('hidden-a', 'shape', {
              transform: tf(0, 0, 80, 60, 0),
              shape: { kind: 'rect', cornerRadius: 0 },
              fill: solid('#aaaaaa'),
            }),
            base('hidden-b', 'shape', {
              transform: tf(120, 0, 80, 60, 0),
              shape: { kind: 'rect', cornerRadius: 0 },
              fill: solid('#bbbbbb'),
            }),
          ], tf(60, 560, 240, 100, 0, 1), { visible: false }),

          // An empty group. Legal, authored, invisible: it round-trips and contributes nothing to
          // the paint order. Pinned so a later "tidy up" cannot decide to discard it.
          group('g-empty', [], tf(700, 700, 0, 0, 0, 1)),

          // Flat neighbours, so paint-order tests have something to interleave with.
          base('flat-under', 'shape', {
            transform: tf(700, 60, 60, 60, 0),
            shape: { kind: 'rect', cornerRadius: 0 },
            fill: solid('#cccccc'),
          }),
          base('flat-over', 'shape', {
            transform: tf(740, 100, 60, 60, 0),
            shape: { kind: 'rect', cornerRadius: 0 },
            fill: solid('#333333'),
          }),
        ],
      },
      {
        id: 'p2', name: '2',
        background: { type: 'solid', color: '#ffffff' },
        objects: [
          group('p2-group', [
            base('p2-child', 'shape', {
              transform: tf(60, 60, 120, 80, Math.PI / 4),
              shape: { kind: 'rect', cornerRadius: 0 },
              fill: solid('#4f7cff'),
            }),
          ], tf(200, 200, 200, 200, 0.2, 2)),
        ],
      },
    ],
  };
}`;

/**
 * There is deliberately **no** fixture for a non-uniform group scale.
 *
 * The obvious thing to add is one, to prove the renderer copes. That would be the wrong test: the
 * renderer must never see such a document, because `validateDocument` refuses it at load and in the
 * dev overlay, so a fixture proving the renderer copes would be asserting that a bug has a graceful
 * failure mode rather than that the bug cannot happen. The refusal is tested where it is decided —
 * `tests/persist/group-persistence.test.ts` ("a non-uniform group scale, and the message says why")
 * and `src/model/group-scale.test.ts` (the shear arithmetic, executed).
 */