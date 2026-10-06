/**
 * Fixtures for the measurement probe (ADR 0004).
 *
 * Separate from the spec for two reasons:
 *
 *  - These are *injected source strings*, so a stray bracket is invisible until the
 *    browser silently falls back to the sample document and the probe reports "no
 *    element". That happened to three of them. `tests/spike/measure-fixtures.test.ts`
 *    parses every one, so a malformed fixture fails as a syntax error rather than as
 *    a mystery.
 *  - Each varies **exactly one** thing against `SIMPLE`, so every number in the probe
 *    output is attributable.
 *
 * Object geometry is in CSS px (the model's internal unit); `pageSize` is in points,
 * which is the only thing that crosses the authoring boundary.
 */

/** One short line, unrotated, no wrapping, no overflow. The control case. */
export const SIMPLE = `() => ({
  formatVersion: 1, id: 'f', name: 'F',
  pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [{
      id: 'copy', type: 'textFrame', name: 'copy',
      transform: { x: 40, y: 40, width: 200, height: 50, rotation: 0, scaleX: 1, scaleY: 1 },
      visible: true, locked: false, opacity: 1, blendMode: 'normal',
      style: { fontSize: 16 },
      text: { blocks: [{ kind: 'paragraph', runs: [{ text: 'Hello' }] }] },
    }],
  }],
})`;

/** `SIMPLE` rotated 30° about its centre, to separate layout box from painted box. */
export const ROTATED = SIMPLE.replace('rotation: 0', 'rotation: 0.5235987755982988');

/** Narrow frame, so the same sentence wraps onto several lines. */
export const WRAPPED = `() => ({
  formatVersion: 1, id: 'f', name: 'F',
  pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [{
      id: 'copy', type: 'textFrame', name: 'copy',
      transform: { x: 40, y: 40, width: 120, height: 120, rotation: 0, scaleX: 1, scaleY: 1 },
      visible: true, locked: false, opacity: 1, blendMode: 'normal',
      style: { fontSize: 16, lineHeight: 1.5 },
      text: { blocks: [{ kind: 'paragraph', runs: [{
        text: 'The quick brown fox jumps over the lazy dog again and again',
      }] }] },
    }],
  }],
})`;

/** A soft break per line, inside one paragraph. Contrast with `WRAPPED`. */
export const SOFT_BREAKS = `() => ({
  formatVersion: 1, id: 'f', name: 'F',
  pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [{
      id: 'copy', type: 'textFrame', name: 'copy',
      transform: { x: 40, y: 40, width: 300, height: 120, rotation: 0, scaleX: 1, scaleY: 1 },
      visible: true, locked: false, opacity: 1, blendMode: 'normal',
      style: { fontSize: 16, lineHeight: 1.5 },
      text: { blocks: [{ kind: 'paragraph', runs: [{ text: 'one\\ntwo\\nthree' }] }] },
    }],
  }],
})`;

/** Three paragraphs, each its own `<p>`. Contrast with `SOFT_BREAKS`. */
export const MULTI_PARAGRAPH = `() => ({
  formatVersion: 1, id: 'f', name: 'F',
  pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [{
      id: 'copy', type: 'textFrame', name: 'copy',
      transform: { x: 40, y: 40, width: 300, height: 120, rotation: 0, scaleX: 1, scaleY: 1 },
      visible: true, locked: false, opacity: 1, blendMode: 'normal',
      style: { fontSize: 16, lineHeight: 1.5 },
      text: { blocks: [
        { kind: 'paragraph', runs: [{ text: 'first' }] },
        { kind: 'paragraph', runs: [{ text: 'second' }] },
        { kind: 'paragraph', runs: [{ text: 'third' }] },
      ] },
    }],
  }],
})`;

/** One empty paragraph. The case where a Range has nothing to select. */
export const EMPTY = `() => ({
  formatVersion: 1, id: 'f', name: 'F',
  pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [{
      id: 'copy', type: 'textFrame', name: 'copy',
      transform: { x: 40, y: 40, width: 200, height: 50, rotation: 0, scaleX: 1, scaleY: 1 },
      visible: true, locked: false, opacity: 1, blendMode: 'normal',
      style: { fontSize: 16 },
      text: { blocks: [{ kind: 'paragraph', runs: [{ text: '' }] }] },
    }],
  }],
})`;

/**
 * Trailing spaces, which `white-space: pre-wrap` must render.
 *
 * Paired with `TRAILING_TRIMMED` so the difference in measured width is attributable
 * to the spaces alone.
 */
export const TRAILING_SPACES = `() => ({
  formatVersion: 1, id: 'f', name: 'F',
  pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [{
      id: 'copy', type: 'textFrame', name: 'copy',
      transform: { x: 40, y: 40, width: 200, height: 50, rotation: 0, scaleX: 1, scaleY: 1 },
      visible: true, locked: false, opacity: 1, blendMode: 'normal',
      style: { fontSize: 16 },
      text: { blocks: [{ kind: 'paragraph', runs: [{ text: 'ab      ' }] }] },
    }],
  }],
})`;

export const TRAILING_TRIMMED = TRAILING_SPACES.replace("text: 'ab      '", "text: 'ab'");

/** Eight lines in a 40px-tall frame: the overflow case. */
export const OVERFLOW = `() => {
  const blocks = [];
  for (let i = 0; i < 8; i += 1) {
    blocks.push({ kind: 'paragraph', runs: [{ text: 'Line ' + i }] });
  }
  return {
    formatVersion: 1, id: 'f', name: 'F',
    pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
    assets: {},
    pages: [{
      id: 'p1', name: '1',
      background: { type: 'solid', color: '#ffffff' },
      objects: [{
        id: 'copy', type: 'textFrame', name: 'copy',
        transform: { x: 40, y: 40, width: 200, height: 40, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        style: { fontSize: 16, lineHeight: 1.5 },
        text: { blocks },
      }],
    }],
  };
}`;

/**
 * Fractional line height, to separate integer layout APIs from fractional ones.
 *
 * 1.35 × 16px = 21.6px per line, which no integer API can represent. Three lines make
 * the divergence 64.8px, so it cannot be rounding either.
 */
export const FRACTIONAL_LINES = `() => ({
  formatVersion: 1, id: 'f', name: 'F',
  pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [{
      id: 'copy', type: 'textFrame', name: 'copy',
      transform: { x: 40, y: 40, width: 300, height: 200, rotation: 0, scaleX: 1, scaleY: 1 },
      visible: true, locked: false, opacity: 1, blendMode: 'normal',
      style: { fontSize: 16, lineHeight: 1.35 },
      text: { blocks: [
        { kind: 'paragraph', runs: [{ text: 'one' }] },
        { kind: 'paragraph', runs: [{ text: 'two' }] },
        { kind: 'paragraph', runs: [{ text: 'three' }] },
      ] },
    }],
  }],
})`;

/** A frame hidden with `visible: false`, which the renderer writes as `display: none`. */
export const HIDDEN_FRAME = SIMPLE.replace('visible: true', 'visible: false');

/**
 * A frame with no `style` at all.
 *
 * Exists to test whether the *document* inherits typography from the editor *chrome*:
 * `body` declares `font: 13px/1.5 system-ui`, and `line-height` is a number, so it
 * inherits as a factor and recomputes against each element's own size. A frame that
 * sets no `fontSize` therefore renders at whatever the chrome happens to be — which
 * would make every measurement conditional on a stylesheet the document does not own.
 */
export const UNSTYLED = `() => ({
  formatVersion: 1, id: 'f', name: 'F',
  pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [{
      id: 'copy', type: 'textFrame', name: 'copy',
      transform: { x: 40, y: 40, width: 200, height: 80, rotation: 0, scaleX: 1, scaleY: 1 },
      visible: true, locked: false, opacity: 1, blendMode: 'normal',
      text: { blocks: [{ kind: 'paragraph', runs: [{ text: 'Hello' }] }] },
    }],
  }],
})`;

/** Every fixture, so the syntax guard can check them all. */
export const ALL_FIXTURES: Record<string, string> = {
  SIMPLE,
  ROTATED,
  WRAPPED,
  SOFT_BREAKS,
  MULTI_PARAGRAPH,
  EMPTY,
  TRAILING_SPACES,
  TRAILING_TRIMMED,
  OVERFLOW,
  FRACTIONAL_LINES,
  HIDDEN_FRAME,
  UNSTYLED,
};
