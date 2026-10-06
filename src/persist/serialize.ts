/**
 * Serialization: a `Document` in, canonical persisted data out.
 *
 * ## Why the bytes go through a canonicaliser
 *
 * `JSON.stringify` preserves object key insertion order, which means "the same document"
 * would otherwise depend on **how the model was built**. A node constructed by
 * `createRectNode` and the same node re-read from a file would stringify differently, and
 * a format that reorders itself is a format whose diffs lie.
 *
 * So the model is not stringified directly. It is rebuilt field by field in a declared
 * order first, which makes determinism a property of the code rather than a hope about how
 * every call site happened to construct its objects:
 *
 *  - **Object keys** in a declared order, from {@link ../persist/format}'s field lists.
 *  - **Arrays** keep their order. Objects are paint order and pages are document order;
 *    both are meaningful, so neither is sorted.
 *  - **Assets** are sorted by id. They are a map, so key order carries no meaning, and
 *    sorting makes two documents holding the same assets byte-identical regardless of the
 *    order they were imported in.
 *
 * The other half of the design is that `deserialize` also rebuilds field by field, so a
 * parsed document is already in canonical form. The two agreeing is a *property*, and it
 * is checked rather than assumed -- see `tests/golden/p1doc-roundtrip.test.ts`.
 *
 * ## Determinism is not the same as idempotence
 *
 * `serialize` emits absent optional properties as **absent**. It does not fill them in
 * with defaults, because "absent" is a value the renderer and the equality function both
 * depend on: `{ fit: 'fill' }` and `{}` render identically but are authored differently, and
 * a format that materialised the first as the second would quietly change what a document
 * means.
 *
 * @module
 */

import type {
  AssetId,
  AssetRecord,
  CharFormat,
  Document,
  GroupNode,
  Node,
  Page,
  PageSize,
  Paint,
  ParagraphBlock,
  RichText,
  ShapeGeometry,
  ShapeNode,
  Stroke,
  TextFrameNode,
  TextStyle,
  Transform2D,
  ImageNode,
} from '../model/types';
import { CHAR_FLAGS, CURRENT_FORMAT_VERSION, DOCUMENT_FORMAT } from './format';
import type { PersistedDocument } from './format';

/**
 * The canonical persisted form of a document.
 *
 * Not the file: that is {@link serializeToString}. Keeping them apart means the canonical
 * value is testable without parsing a string, and a test that wants to compare the shape
 * rather than the text does not have to re-parse.
 */
export function serialize(doc: Document): PersistedDocument {
  return {
    format: DOCUMENT_FORMAT,
    formatVersion: CURRENT_FORMAT_VERSION,
    id: doc.id,
    name: doc.name,
    pageSize: canonicalPageSize(doc.pageSize),
    assets: canonicalAssets(doc.assets),
    pages: doc.pages.map(canonicalPage),
  };
}

/**
 * The persisted string, and the only thing that should ever touch a file.
 *
 * Two-space indentation because these files are **hand-inspectable by contract**: a
 * document the user cannot read is a document they cannot repair, and refusing to repair is
 * the other half of `deserialize`'s policy. The two are only coherent together -- a
 * strict parser with unreadable output would be an unhelpfully strict parser.
 *
 * A trailing newline, because these are text files people open in editors, and because
 * "the file lacks its final newline" is not a difference worth a round-trip test.
 */
export function serializeToString(doc: Document): string {
  return `${JSON.stringify(serialize(doc), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Canonicalising
// ---------------------------------------------------------------------------

function canonicalPageSize(size: PageSize): PageSize {
  return {
    width: size.width,
    height: size.height,
    unit: size.unit,
    orientation: size.orientation,
  };
}

function canonicalAssets(
  assets: Readonly<Record<AssetId, AssetRecord>>,
): Record<AssetId, AssetRecord> {
  const out: Record<AssetId, AssetRecord> = {};
  for (const id of Object.keys(assets).sort()) {
    const asset = assets[id];
    // Unreachable -- a JS object cannot hold a duplicate key -- but written out rather than
    // asserted, because a bare `continue` here would be a silent data loss, which is the
    // one failure this whole module is arranged to make impossible.
    if (asset === undefined) {
      throw new Error(`Asset "${id}" has no record`);
    }
    out[id] = {
      kind: asset.kind,
      mime: asset.mime,
      intrinsicWidth: asset.intrinsicWidth,
      intrinsicHeight: asset.intrinsicHeight,
      // The union is discriminated by which key is present, so the copy is too -- reading
      // `asset.data.inline` unconditionally would put `undefined` on the wire for an
      // external record.
      data: 'inline' in asset.data
        ? { inline: asset.data.inline }
        : { external: (asset.data as { external: string }).external },
    };
  }
  return out;
}

function canonicalPage(page: Page): Page {
  return {
    id: page.id,
    name: page.name,
    background: canonicalPaint(page.background),
    objects: page.objects.map(canonicalNode),
  };
}

function canonicalNode(node: Node): Node {
  switch (node.type) {
    case 'shape': {
      const out: ShapeNode = {
        type: 'shape',
        id: node.id,
        name: node.name,
        transform: canonicalTransform(node.transform),
        visible: node.visible,
        locked: node.locked,
        opacity: node.opacity,
        blendMode: node.blendMode,
        shape: canonicalShape(node.shape),
      };
      if (node.fill !== undefined) out.fill = canonicalPaint(node.fill);
      if (node.stroke !== undefined) out.stroke = canonicalStroke(node.stroke);
      if (node.extensions !== undefined) out.extensions = node.extensions;
      return out;
    }
    case 'textFrame': {
      const out: TextFrameNode = {
        type: 'textFrame',
        id: node.id,
        name: node.name,
        transform: canonicalTransform(node.transform),
        visible: node.visible,
        locked: node.locked,
        opacity: node.opacity,
        blendMode: node.blendMode,
        text: canonicalRichText(node.text),
      };
      if (node.style !== undefined) out.style = canonicalTextStyle(node.style);
      if (node.extensions !== undefined) out.extensions = node.extensions;
      return out;
    }
    case 'image': {
      const out: ImageNode = {
        type: 'image',
        id: node.id,
        name: node.name,
        transform: canonicalTransform(node.transform),
        visible: node.visible,
        locked: node.locked,
        opacity: node.opacity,
        blendMode: node.blendMode,
        asset: node.asset,
      };
      if (node.fit !== undefined) out.fit = node.fit;
      if (node.extensions !== undefined) out.extensions = node.extensions;
      return out;
    }
    case 'group': {
      const out: GroupNode = {
        type: 'group',
        id: node.id,
        name: node.name,
        transform: canonicalTransform(node.transform),
        visible: node.visible,
        locked: node.locked,
        opacity: node.opacity,
        blendMode: node.blendMode,
        // `.map`, never `.sort`: **child order is paint order**, so `[B, C]` and `[C, B]` are
        // different documents and the canonical form must preserve whichever was authored. This is
        // the one place where a "tidy up" would be a silent data loss rather than a style change.
        children: node.children.map(canonicalNode),
      };
      if (node.extensions !== undefined) out.extensions = node.extensions;
      return out;
    }
    default: {
      const unreachable: never = node;
      throw new Error(`Unknown node type in canonicalisation: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * The transform, field by field in the declared order.
 *
 * Deliberately **not** a spread. A spread copies whatever order the source object happened
 * to have, which is exactly the non-determinism the canonicaliser exists to remove: one
 * transform built by `createTransform` and the same transform read back from a file would
 * then serialize to different bytes, and a golden file could not be required to be
 * byte-stable.
 */
function canonicalTransform(transform: Transform2D): Transform2D {
  return {
    x: transform.x,
    y: transform.y,
    width: transform.width,
    height: transform.height,
    rotation: transform.rotation,
    scaleX: transform.scaleX,
    scaleY: transform.scaleY,
  };
}

function canonicalShape(shape: ShapeGeometry): ShapeGeometry {
  return shape.kind === 'rect'
    ? { kind: 'rect', cornerRadius: shape.cornerRadius }
    : { kind: shape.kind };
}

function canonicalPaint(paint: Paint): Paint {
  return paint.type === 'solid' ? { type: 'solid', color: paint.color } : paint;
}

function canonicalStroke(stroke: Stroke): Stroke {
  return {
    paint: canonicalPaint(stroke.paint),
    width: stroke.width,
    align: stroke.align,
  };
}

function canonicalRichText(text: RichText): RichText {
  return {
    blocks: text.blocks.map((block) => {
      const out: ParagraphBlock = {
        kind: 'paragraph',
        runs: block.runs.map((run) => {
          const copy: ParagraphBlock['runs'][number] = { text: run.text };
          if (run.format !== undefined) {
            // Flag order fixed from the shared list, so two runs with equal formats always
            // serialize equally no matter what order the format object was built in.
            const format: CharFormat = {};
            for (const flag of CHAR_FLAGS) {
              if (run.format[flag] === true) format[flag] = true;
            }
            copy.format = format;
          }
          return copy;
        }),
      };
      if (block.align !== undefined) out.align = block.align;
      return out;
    }),
  };
}

function canonicalTextStyle(style: TextStyle): TextStyle {
  const out: TextStyle = {};
  if (style.fontFamily !== undefined) out.fontFamily = style.fontFamily;
  if (style.fontSize !== undefined) out.fontSize = style.fontSize;
  if (style.lineHeight !== undefined) out.lineHeight = style.lineHeight;
  if (style.letterSpacing !== undefined) out.letterSpacing = style.letterSpacing;
  if (style.color !== undefined) out.color = style.color;
  return out;
}