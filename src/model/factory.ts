/**
 * Factories for model values. Everything here produces plain, immutable-friendly
 * data; cloning goes through `structuredClone`, which is safe because the model
 * contains only JSON-compatible values.
 */

import { createId } from '../core/ids';
import type {
  Document,
  GroupNode,
  Node,
  Page,
  RichText,
  ShapeGeometry,
  ShapeKind,
  ShapeNode,
  TextFrameNode,
  Transform2D,
} from './types';

export const IDENTITY_TRANSFORM: Readonly<Transform2D> = Object.freeze({
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
});

export function createTransform(init: Partial<Transform2D> = {}): Transform2D {
  return { ...IDENTITY_TRANSFORM, ...init };
}

/**
 * Creates a shape node of any registered kind.
 *
 * The kind-specific default geometry is exhaustive-checked against `ShapeGeometry`, so a
 * new kind is a compile error here until its defaults exist — the same guarantee the
 * renderer's `Record<ShapeKind, Projector>` gives, and for the same reason.
 *
 * `createRectNode` is kept because it is used everywhere else in the codebase, and a
 * rectangle with an overridable `cornerRadius` is more than this can express.
 */
export function createShapeNode(
  kind: ShapeKind,
  init: Partial<Omit<ShapeNode, 'type' | 'shape'>> = {},
): ShapeNode {
  const shape = ((): ShapeGeometry => {
    switch (kind) {
      case 'rect':
        return { kind: 'rect', cornerRadius: 0 };
      case 'ellipse':
        return { kind: 'ellipse' };
      case 'line':
        return { kind: 'line' };
      default: {
        const unreachable: never = kind;
        throw new Error(`No default geometry for shape kind "${String(unreachable)}"`);
      }
    }
  })();

  return {
    id: createId('node'),
    type: 'shape',
    name: shapeLabel(kind),
    transform: createTransform(),
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    shape,
    ...init,
  };
}

export function createRectNode(init: Partial<Omit<ShapeNode, 'type' | 'shape'>> & {
  shape?: Partial<ShapeNode['shape']>;
} = {}): ShapeNode {
  const { shape, ...rest } = init;
  return {
    id: createId('node'),
    type: 'shape',
    name: 'Rectangle',
    transform: createTransform(),
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    shape: { kind: 'rect', cornerRadius: 0, ...shape },
    ...rest,
  };
}

/**
 * A group node.
 *
 * ## `children` defaults to `[]`, never to something derived
 *
 * A group's extent is **authored**. `createGroupNode` does not fit `width`/`height` to its children,
 * and there is no "fit to contents" helper, because a group's frame is what it says it is:
 *
 * - the frame is the rotation pivot, so it must be an authored value;
 * - deriving it from children would make the parent a function of its members, which puts layout in
 *   the authored document and breaks `Transform2D`'s meaning (§1.3);
 * - it would also be circular the moment a child is itself a group.
 *
 * The consequence is that a group is permitted to be larger or smaller than its members, and that is
 * not an error. Nothing in `validateDocument` objects. ADR 0012 §3.
 *
 * ## There is no `createGroupNode` caller that groups
 *
 * This constructor exists so tests and fixtures can *build* a group, and so M12+ has one place to
 * add a grouping command to. It creates no user-facing behaviour: there is no gesture, no menu item
 * and no inspector row for a group in this milestone. A constructor is not a feature.
 */
export function createGroupNode(
  init: Partial<Omit<GroupNode, 'type' | 'children'>> & { children?: Node[] } = {},
): GroupNode {
  const { children, ...rest } = init;
  return {
    id: createId('group'),
    type: 'group',
    name: 'Group',
    // A zero-size frame at the origin: a group's local space starts as nothing, and a caller that
    // wants an extent must author one. Not 100x100 -- an invented default would be a group's
    // *size*, which is exactly the derived geometry the design refuses.
    transform: createTransform({ width: 0, height: 0 }),
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    children: children === undefined ? [] : children,
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/*
 * `richTextToPlain` and `plainToRichText` used to live here as part of the text
 * spike. They are plain-text projections of `RichText` and nothing more, so they
 * moved to `rich-text.ts` beside `normalizeRichText` — keeping canonicalisation and
 * its two plain-text accessors in one file, so a change to the canonical form cannot
 * be made in one and forgotten in the other.
 *
 * Re-exported here so existing importers keep working.
 */
import { normalizeRichText, plainToRichText, richTextToPlain } from './rich-text';
import { shapeLabel } from './shapes';

export { richTextToPlain, plainToRichText };

/** Canonicalises a `RichText` literal. Used by fixtures so they cannot be non-canonical. */
export function rich(blocks: RichText['blocks']): RichText {
  return normalizeRichText({ blocks });
}


export function createTextFrameNode(
  init: Partial<Omit<TextFrameNode, 'type' | 'text'>> & { text?: RichText } = {},
): TextFrameNode {
  const { text, ...rest } = init;
  return {
    id: createId('node'),
    type: 'textFrame',
    name: 'Text',
    transform: createTransform(),
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    text: text ?? { blocks: [{ kind: 'paragraph', runs: [{ text: '' }] }] },
    ...rest,
  };
}

export function createPage(init: Partial<Omit<Page, 'id'>> = {}): Page {
  return {
    id: createId('page'),
    name: 'Page 1',
    background: { type: 'solid', color: '#ffffff' },
    objects: [],
    ...init,
  };
}

/**
 * The `formatVersion` a newly created document carries.
 *
 * ## It lives here, not in `persist/`
 *
 * `persist/` is a leaf *beside* `model/` and may not be imported from it (ADR 0007), so the version
 * cannot be owned by `persist/format.ts` and read by `createDocument`. And it cannot simply be
 * written twice, which is what happened until M12:
 *
 * ```
 * factory.ts    formatVersion: 1,                        // a literal
 * format.ts     export const CURRENT_FORMAT_VERSION = 1, // another literal
 * ```
 *
 * Those agreed by coincidence and were *both* right, which is why nothing failed for seven
 * milestones. The moment the parser's value became 2 and the factory's stayed 1, every round-trip
 * test failed at once — and the failure was "the document is not equal to itself after a round
 * trip", which says nothing about the version and everything about having two sources for one
 * fact.
 *
 * So the single literal lives here, `persist/format.ts` imports it, and
 * `tests/persist/version-ownership.test.ts` asserts the two cannot drift. A layer rule that forces
 * a duplication is a reason to move the *constant*, not a reason to write it down twice.
 */
export const CURRENT_FORMAT_VERSION = 2;

export function createDocument(init: Partial<Omit<Document, 'id' | 'pages'>> & {
  pages?: Page[];
} = {}): Document {
  return {
    // Not a literal. See above.
    formatVersion: CURRENT_FORMAT_VERSION,
    id: createId('doc'),
    name: 'Untitled',
    pageSize: { width: 210, height: 297, unit: 'mm', orientation: 'portrait' },
    // Empty by default rather than absent, so `Document.assets` needs no optional
    // handling anywhere -- including in a deserializer, where a missing field would
    // otherwise be a special case at every read site.
    assets: {},
    ...init,
    pages: init.pages ?? [createPage()],
  };
}

export function cloneNode<T extends Node>(node: T): T {
  return structuredClone(node);
}

/**
 * The default document.
 *
 * Carries a text frame with real typography — several paragraphs, a soft break, four
 * different character formats and mixed alignment — so the default document exercises
 * the model rather than presenting an empty grey box. A sample that only proves empty
 * frames render would not have caught the round-trip, canonical-form or empty
 * paragraph bugs, which is exactly what M3 found.
 */
export function createSampleDocument(): Document {
  const page = createPage({ name: '1' });
  page.objects = [
    createRectNode({
      name: 'Rectangle 1',
      transform: createTransform({ x: 24, y: 32, width: 120, height: 68 }),
      shape: { cornerRadius: 8 },
      fill: { type: 'solid', color: '#4f7cff' },
      stroke: { paint: { type: 'solid', color: '#1b3a8f' }, width: 2, align: 'inside' },
    }),
    createTextFrameNode({
      name: 'Text 1',
      transform: createTransform({ x: 24, y: 130, width: 300, height: 160 }),
      style: {
        fontFamily: 'Georgia, "Times New Roman", serif',
        fontSize: 16,
        lineHeight: 1.5,
        letterSpacing: 0.005,
        color: '#1a1a1a',
      },
      text: rich([
        {
          kind: 'paragraph',
          runs: [
            { text: 'The ' },
            { text: 'quick brown fox', format: { bold: true } },
            { text: ' jumps over the ' },
            { text: 'lazy dog', format: { italic: true } },
            { text: '.' },
          ],
        },
        {
          kind: 'paragraph',
          runs: [{ text: 'Soft break mid-sentence,\nthen the rest of it.' }],
        },
        {
          kind: 'paragraph',
          align: 'center',
          runs: [
            { text: 'Centred, ', format: { underline: true } },
            { text: 'struck through', format: { strike: true } },
            { text: '.' },
          ],
        },
        { kind: 'paragraph', align: 'justify', runs: [{ text: '' }] },
      ]),
    }),
  ];
  return createDocument({ name: 'Untitled', pages: [page] });
}