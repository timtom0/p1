/**
 * Text fixtures, shared by the behavioural and visual suites.
 *
 * Kept out of the spec files so a rendering assertion and its baseline are pinned to
 * the *same* document. A baseline recorded against one fixture and asserted against
 * another is the failure mode `tests/visual/README.md` warns about.
 *
 * Geometry is published alongside each fixture because clicking a document point
 * requires knowing where it is. Deriving it from a *different* fixture's table is how
 * twenty of these tests ended up clicking empty page and wondering why nothing
 * happened.
 */

/** Frame geometry of `TEXT_FIXTURE`, in document px. */
export const TEXT_IDS = {
  copy: { x: 60, y: 60, width: 320, height: 200 },
} as const;

/** Frame geometry of `EMPTY_FIXTURE`, in document px. */
export const EMPTY_IDS = {
  copy: { x: 60, y: 60, width: 200, height: 60 },
} as const;

/** Three paragraphs, four formats, a soft break, and frame typography. */
export const TEXT_FIXTURE = `() => ({
  formatVersion: 1, id: 'f', name: 'F',
  pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [{
      id: 'copy', type: 'textFrame', name: 'copy',
      transform: { x: 60, y: 60, width: 320, height: 200, rotation: 0, scaleX: 1, scaleY: 1 },
      visible: true, locked: false, opacity: 1, blendMode: 'normal',
      style: {
        fontFamily: 'Georgia, serif', fontSize: 18, lineHeight: 1.4,
        letterSpacing: 0.005, color: '#1a1a1a',
      },
      text: { blocks: [
        { kind: 'paragraph', runs: [
          { text: 'plain ' },
          { text: 'bold', format: { bold: true } },
          { text: ' and ' },
          { text: 'italic', format: { italic: true } },
        ] },
        { kind: 'paragraph', runs: [{ text: 'one    two\\nthree' }] },
        { kind: 'paragraph', align: 'center', runs: [
          { text: 'under', format: { underline: true } },
          { text: 'struck', format: { strike: true } },
        ] },
      ] },
    }],
  }],
})`;

/** A single empty paragraph. */
export const EMPTY_FIXTURE = `() => ({
  formatVersion: 1, id: 'f', name: 'F',
  pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [{
      id: 'copy', type: 'textFrame', name: 'copy',
      transform: { x: 60, y: 60, width: 200, height: 60, rotation: 0, scaleX: 1, scaleY: 1 },
      visible: true, locked: false, opacity: 1, blendMode: 'normal',
      style: { fontSize: 18 },
      text: { blocks: [{ kind: 'paragraph', runs: [{ text: '' }] }] },
    }],
  }],
})`;

/**
 * An empty first paragraph followed by visible text.
 *
 * A fixture whose only content is an empty paragraph screenshots as a blank white
 * page, which passes whether or not the empty line has any height — a baseline that
 * cannot fail is not a baseline. Putting text *below* the blank line makes the gap
 * visible, so the image records the `min-height` rule that gives it (ADR 0003,
 * following ADR 0001 finding 4).
 */
export const BLANK_LINE_FIXTURE = `() => ({
  formatVersion: 1, id: 'f', name: 'F',
  pageSize: { width: 450, height: 300, unit: 'pt', orientation: 'portrait' },
  assets: {},
  pages: [{
    id: 'p1', name: '1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [{
      id: 'copy', type: 'textFrame', name: 'copy',
      transform: { x: 60, y: 60, width: 200, height: 60, rotation: 0, scaleX: 1, scaleY: 1 },
      visible: true, locked: false, opacity: 1, blendMode: 'normal',
      style: { fontSize: 18 },
      text: { blocks: [
        { kind: 'paragraph', runs: [{ text: '' }] },
        { kind: 'paragraph', runs: [{ text: 'after the blank line' }] },
      ] },
    }],
  }],
})`;

/** More text than the frame is tall, to prove overflow stays visible. */
export const OVERFLOW_FIXTURE = `() => {
  const blocks = [];
  for (let i = 0; i < 12; i += 1) {
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
        transform: { x: 60, y: 60, width: 200, height: 60, rotation: 0, scaleX: 1, scaleY: 1 },
        visible: true, locked: false, opacity: 1, blendMode: 'normal',
        style: { fontSize: 18 },
        text: { blocks },
      }],
    }],
  };
}`;