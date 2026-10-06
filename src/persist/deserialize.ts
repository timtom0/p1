/**
 * Deserialization: persisted data in, a `Document` out -- or a refusal.
 *
 * ## Total, not lenient
 *
 * `parse` either returns a valid document or throws a {@link DocumentParseError} naming the
 * path of the field at fault. It never returns a partially valid document and **never
 * repairs**. That is a deliberate departure from §6.2's sketch, which proposed "a repair
 * path that collects rather than throws on recoverable problems"; the reasoning is in ADR
 * 0007 §5 and the short version is that silently dropping one bad node out of a
 * three-hundred-object document is a data-loss decision the user never made.
 *
 * ## Three things happen here, in this order
 *
 * 1. **Version first**, before any field is looked at, so a file from another build gets a
 *    message about versions rather than about whichever field happens to differ.
 * 2. **Validate and rebuild.** Every object is constructed field by field, which validates
 *    it *and* gives it the canonical key order -- so a parsed document is already canonical
 *    and `serialize` has nothing left to fix up.
 * 3. **Cross-reference checks**: unique ids, and every `ImageNode.asset` resolving to a
 *    record. These need the whole document, so they cannot live in a per-field reader.
 *
 * ## Nothing here executes anything the document provides
 *
 * Plain JSON in; literal key matches; values copied out. No `eval`, no `Function`, no
 * property access by a computed path string. The `persist/` layer cannot even see the DOM,
 * so there is no `innerHTML` to reach for either.
 *
 * @module
 */

import { reserveIds } from '../core/ids';
import { IMAGE_FITS } from '../model/assets';
import { normalizeRichText } from '../model/rich-text';
import { shapeKinds } from '../model/shapes';
import type {
  AssetData,
  AssetId,
  AssetRecord,
  BlendMode,
  CharFormat,
  Document,
  GroupNode,
  ImageFit,
  ImageNode,
  Node,
  Orientation,
  Page,
  PageSize,
  Paint,
  ParagraphAlign,
  ParagraphBlock,
  RichText,
  ShapeGeometry,
  ShapeKind,
  ShapeNode,
  Stroke,
  StrokeAlign,
  TextFrameNode,
  TextStyle,
  Transform2D,
} from '../model/types';
import {
  ASSET_RECORD_KEYS,
  BLEND_MODES,
  CHAR_FLAGS,
  CURRENT_FORMAT_VERSION,
  DOCUMENT_FORMAT,
  DOCUMENT_KEYS,
  DocumentParseError,
  GROUP_NODE_KEYS,
  MINIMUM_FORMAT_VERSION,
  ORIENTATIONS,
  PAGE_KEYS,
  PAGE_SIZE_KEYS,
  PAINT_KEYS,
  PARAGRAPH_ALIGNS,
  PARAGRAPH_KEYS,
  RICH_TEXT_KEYS,
  RUN_KEYS,
  SHARED_NODE_KEYS,
  STROKE_ALIGNS,
  STROKE_KEYS,
  TEXT_STYLE_KEYS,
  TRANSFORM_KEYS,
  expectArray,
  expectBoolean,
  expectEnum,
  expectFinite,
  expectId,
  expectNonNegative,
  expectNonZero,
  expectNumber,
  expectOnlyKeys,
  expectOpacity,
  expectPhysicalUnit,
  expectPositiveNumber,
  expectRecord,
  expectString,
} from './format';
import { validateDocument } from '../model/invariants';

/**
 * Reads a persisted document, or throws.
 *
 * Also reserves every id in the result with the generator, which is what stops the editor
 * minting a `node_1` that the loaded document already uses. Done **after** validation on
 * purpose: a rejected file must not move the counter, or reading a bad file would change
 * the ids of every document opened afterwards in the same tab.
 */
export function parse(input: unknown): Document {
  const root = expectRecord(input, '');
  expectOnlyKeys(root, '', DOCUMENT_KEYS);
  assertFormatMarker(root['format']);
  assertVersion(root['formatVersion']);

  const doc = parseDocument(root);
  assertDocumentIsConsistent(doc);

  reserveIds(collectIds(doc));
  return doc;
}

/**
 * Every id in a document, for the generator to reserve.
 *
 * Includes the document, its pages, **every node at every depth**, and every asset key. The
 * generator keeps one counter *per prefix*, so each prefix has to be represented or a new node
 * could collide with a loaded asset.
 *
 * Recursive, and it has to be: a group child's id that went unreserved could be handed out by
 * `createId` on the next insert, producing a document with two nodes claiming one id. That is the
 * exact failure `assertDocumentIsConsistent` exists to prevent on load, reintroduced by the
 * generator — which is why this uses the same traversal rather than a parallel walk.
 */
export function collectIds(doc: Document): string[] {
  const ids: string[] = [doc.id];
  for (const page of doc.pages) {
    ids.push(page.id);
    collectNodeIds(page.objects, ids);
  }
  for (const id of Object.keys(doc.assets)) ids.push(id);
  return ids;
}

function collectNodeIds(nodes: readonly Node[], out: string[]): void {
  for (const node of nodes) {
    out.push(node.id);
    if (node.type === 'group') collectNodeIds(node.children, out);
  }
}

// ---------------------------------------------------------------------------
// Whole-document checks
// ---------------------------------------------------------------------------

function assertFormatMarker(input: unknown): void {
  const format = expectString(input, 'format');
  if (format !== DOCUMENT_FORMAT) {
    throw new DocumentParseError(
      'format',
      `expected "${DOCUMENT_FORMAT}", got "${format}"; this is not a P1 document`,
    );
  }
}

function assertVersion(input: unknown): void {
  const version = expectNumber(input, 'formatVersion');
  if (!Number.isInteger(version)) {
    throw new DocumentParseError('formatVersion', 'must be an integer');
  }
  if (version > CURRENT_FORMAT_VERSION) {
    // Never silently downgraded: a file written by a build that knows fields this one does
    // not may mean anything at all here.
    throw new DocumentParseError(
      'formatVersion',
      `saved by a newer version of P1 (this file is ${version}, this build reads ` +
        `${CURRENT_FORMAT_VERSION}); open it with a newer P1`,
    );
  }
  if (version < MINIMUM_FORMAT_VERSION) {
    // No migrations exist, by design (ADR 0007 §4). The two directions get different
    // messages because they need different actions from the user.
    //
    // The lower bound is 1, and it is *not* "no older files accepted": version 1 falls through
    // this check and is read normally. Only a file older than 1 is refused, and for it there is
    // genuinely nothing to migrate from. ADR 0012 §7.
    throw new DocumentParseError(
      'formatVersion',
      `saved by an older version of P1 (this file is ${version}, this build reads ` +
        `${MINIMUM_FORMAT_VERSION}-${CURRENT_FORMAT_VERSION}); there is no migration for it`,
    );
  }
  // `MINIMUM_FORMAT_VERSION <= version <= CURRENT_FORMAT_VERSION` is accepted, and the parser
  // produces a document stamped with `CURRENT_FORMAT_VERSION`.
  //
  // That stamp is the *only* difference between reading version 1 and version 2, and it is
  // deliberate rather than incidental: a version-1 document has no groups, so there is nothing to
  // convert, and re-stamping it says "this is now written in the current format" without altering
  // a single authored value. It is not a migration (ADR 0007 §4) because no authored content
  // changes; it is a re-stamp.
  //
  // A version-2 document containing a group is **not** silently interpreted by an older build --
  // that build stops at the version check above. And a version-1 document cannot contain a group at
  // all, because `expectOnlyKeys` rejects the unknown `type` at a named path.
}

/**
 * The checks that need the whole document before they can mean anything.
 *
 * **Unique ids** is not a modelling nicety: `mapNodesById` resolves a collision to
 * whichever node it visits first, so an edit to a newly created object would silently
 * apply to the loaded one.
 *
 * **Asset references** are checked here rather than left to the renderer, so opening a
 * document with a dangling reference is a load failure with a path rather than an image
 * that silently renders as a placeholder with no explanation anywhere.
 */
function assertDocumentIsConsistent(doc: Document): void {
  const seen = new Set<string>();
  for (const id of collectIds(doc)) {
    if (seen.has(id)) {
      throw new DocumentParseError(
        'id',
        `"${id}" is used more than once in this document; ids must be unique`,
      );
    }
    seen.add(id);
  }

  for (const [pageIndex, page] of doc.pages.entries()) {
    assertAssetReferences(page.objects, `pages[${pageIndex}].objects`, doc.assets);
  }

  // The model's invariants, as a load failure with a path. `validateDocument` returns a list for
  // the dev overlay; a *file* must not mount in a state the model forbids, so each violation becomes
  // a `DocumentParseError` instead.
  //
  // This is the rule that stops a non-uniform group scale from arriving at all: the format
  // validates a *number*, the invariant validates the *relationship*, and only one of the two is
  // expressible in the key list. Without this pass, `parse` would happily return a group whose
  // scale is `(2, 1)` — a shear, on a rotated child — and the first symptom would be an object
  // painted at an angle nobody asked for. ADR 0012 §8.
  for (const violation of validateDocument(doc)) {
    throw new DocumentParseError(violation.path, violation.message);
  }
}

/**
 * Every `ImageNode.asset` resolves, at any depth.
 *
 * A path built as it descends, so a failure names
 * `pages[0].objects[2].children[1].asset` rather than "some image". An error the author cannot
 * locate is an error they cannot fix.
 *
 * `Object.hasOwn`, never `in`: an asset id of `toString` must not resolve against
 * `Object.prototype`. Same rule as `model/invariants.ts`, and it is written twice on purpose —
 * the parser's job is to be total on *arbitrary input*, which a loaded file is and a hand-built
 * model is not.
 */
function assertAssetReferences(
  nodes: readonly Node[],
  path: string,
  assets: Record<string, AssetRecord>,
): void {
  nodes.forEach((node, index) => {
    const at = `${path}[${index}]`;
    if (node.type === 'image') {
      if (Object.hasOwn(assets, node.asset)) return;
      throw new DocumentParseError(`${at}.asset`, `no asset record for id "${node.asset}"`);
    }
    if (node.type === 'group') {
      assertAssetReferences(node.children, `${at}.children`, assets);
    }
  });
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

function parseDocument(root: Record<string, unknown>): Document {
  return {
    formatVersion: CURRENT_FORMAT_VERSION,
    id: expectId(root['id'], 'id'),
    name: expectString(root['name'], 'name'),
    pageSize: parsePageSize(root['pageSize']),
    assets: parseAssets(root['assets']),
    pages: parsePages(root['pages']),
  };
}

function parsePageSize(input: unknown): PageSize {
  const record = expectRecord(input, 'pageSize');
  expectOnlyKeys(record, 'pageSize', PAGE_SIZE_KEYS);
  return {
    width: expectPositiveNumber(record['width'], 'pageSize.width'),
    height: expectPositiveNumber(record['height'], 'pageSize.height'),
    unit: expectPhysicalUnit(record['unit'], 'pageSize.unit'),
    orientation: expectEnum(record['orientation'], 'pageSize.orientation', ORIENTATIONS) as
      Orientation,
  };
}

function parseAssets(input: unknown): Record<AssetId, AssetRecord> {
  const record = expectRecord(input, 'assets');
  const out: Record<AssetId, AssetRecord> = {};
  // Sorted on the way in as well as on the way out, so a parsed document's key order is
  // already canonical. Duplicate keys cannot survive `JSON.parse` at all, which is why
  // "are duplicate asset records legal" has a structural answer and not a policy one.
  for (const id of Object.keys(record).sort()) {
    if (id === '') throw new DocumentParseError('assets', 'an asset id must not be empty');
    out[id] = parseAsset(record[id], `assets.${id}`);
  }
  return out;
}

function parseAsset(input: unknown, path: string): AssetRecord {
  const record = expectRecord(input, path);
  expectOnlyKeys(record, path, ASSET_RECORD_KEYS);
  const kind = expectString(record['kind'], `${path}.kind`);
  if (kind !== 'image') {
    throw new DocumentParseError(`${path}.kind`, `unknown asset kind "${kind}"`);
  }
  const mime = expectString(record['mime'], `${path}.mime`);
  if (mime === '') throw new DocumentParseError(`${path}.mime`, 'must not be empty');

  // ADR 0006's invariant, re-checked at the boundary: an asset that cannot paint must not
  // be representable, whatever produced it. `createAsset` refuses a non-positive size at
  // import; this refuses it on disk.
  return {
    kind: 'image',
    mime,
    intrinsicWidth: expectPositiveNumber(record['intrinsicWidth'], `${path}.intrinsicWidth`),
    intrinsicHeight: expectPositiveNumber(record['intrinsicHeight'], `${path}.intrinsicHeight`),
    data: parseAssetData(record['data'], `${path}.data`),
  };
}

function parseAssetData(input: unknown, path: string): AssetData {
  const record = expectRecord(input, path);
  const keys = Object.keys(record);
  expectOnlyKeys(record, path, ['inline', 'external']);
  if (keys.length !== 1) {
    // Exactly one arm. A record carrying both, or neither, has no defined meaning, and
    // guessing which was meant is how bytes get lost.
    throw new DocumentParseError(
      path,
      `must carry exactly one of "inline" or "external" (found ${
        keys.length === 0 ? 'neither' : keys.join(' and ')
      })`,
    );
  }
  if (keys[0] === 'inline') {
    // Preserved exactly, and **not** validated as a data URL. An `inline` payload this
    // build cannot render is a *load* failure the document already knows how to show (ADR
    // 0006 §5); refusing the file over it would discard the user's work to avoid a cosmetic
    // complaint.
    return { inline: expectString(record['inline'], `${path}.inline`) };
  }
  // An external reference round-trips verbatim and is never fetched (ADR 0007 §4).
  return { external: expectString(record['external'], `${path}.external`) };
}

function parsePages(input: unknown): Page[] {
  const list = expectArray(input, 'pages');
  if (list.length === 0) {
    throw new DocumentParseError('pages', 'a document has at least one page');
  }
  return list.map((page, index) => parsePage(page, `pages[${index}]`));
}

function parsePage(input: unknown, path: string): Page {
  const record = expectRecord(input, path);
  expectOnlyKeys(record, path, PAGE_KEYS);
  const objects = expectArray(record['objects'], `${path}.objects`);
  return {
    id: expectId(record['id'], `${path}.id`),
    name: expectString(record['name'], `${path}.name`),
    background: parsePaint(record['background'], `${path}.background`),
    objects: objects.map((node, index) => parseNode(node, `${path}.objects[${index}]`)),
  };
}

/** Everything a node carries whatever its type, minus the type-specific tail. */
type SharedNode = Omit<ShapeNode, 'type' | 'shape' | 'fill' | 'stroke'>;

function parseNode(input: unknown, path: string): Node {
  const record = expectRecord(input, path);
  const type = expectString(record['type'], `${path}.type`);

  switch (type) {
    case 'shape': {
      expectOnlyKeys(record, path, [...SHARED_NODE_KEYS, 'shape', 'fill', 'stroke', 'extensions']);
      const node: ShapeNode = {
        type: 'shape',
        ...parseSharedNode(record, path),
        shape: parseShapeGeometry(record['shape'], `${path}.shape`),
      };
      // Optional means absent. A `fill: null` on disk would otherwise come back as
      // `fill: undefined`, which quietly changes the document's equality.
      if (record['fill'] !== undefined) {
        node.fill = parsePaint(record['fill'], `${path}.fill`);
      }
      if (record['stroke'] !== undefined) {
        node.stroke = parseStroke(record['stroke'], `${path}.stroke`);
      }
      if (record['extensions'] !== undefined) {
        node.extensions = expectRecord(record['extensions'], `${path}.extensions`);
      }
      return node;
    }
    case 'textFrame': {
      expectOnlyKeys(record, path, [...SHARED_NODE_KEYS, 'text', 'style', 'extensions']);
      const node: TextFrameNode = {
        type: 'textFrame',
        ...parseSharedNode(record, path),
        text: parseRichText(record['text'], `${path}.text`),
      };
      if (record['style'] !== undefined) {
        node.style = parseTextStyle(record['style'], `${path}.style`);
      }
      if (record['extensions'] !== undefined) {
        node.extensions = expectRecord(record['extensions'], `${path}.extensions`);
      }
      return node;
    }
    case 'image': {
      expectOnlyKeys(record, path, [...SHARED_NODE_KEYS, 'asset', 'fit', 'extensions']);
      const node: ImageNode = {
        type: 'image',
        ...parseSharedNode(record, path),
        asset: expectId(record['asset'], `${path}.asset`),
      };
      // Absent stays absent: `fit: 'fill'` and no `fit` are authored differently even though
      // they render identically, and the format must not collapse them.
      if (record['fit'] !== undefined) {
        node.fit = expectEnum(record['fit'], `${path}.fit`, IMAGE_FITS) as ImageFit;
      }
      if (record['extensions'] !== undefined) {
        node.extensions = expectRecord(record['extensions'], `${path}.extensions`);
      }
      return node;
    }
    case 'group': {
      // `children` is **required, never optional**. An absent `children` would have to default to
      // `[]`, and "absent means no children" is exactly the kind of ambiguity ADR 0007 exists to
      // remove: two spellings, one meaning. A group with no children is written as `children: []`.
      expectOnlyKeys(record, path, [...SHARED_NODE_KEYS, ...GROUP_NODE_KEYS, 'extensions']);
      const node: GroupNode = {
        type: 'group',
        ...parseSharedNode(record, path),
        children: expectArray(record['children'], `${path}.children`).map((child, index) =>
          parseNode(child, `${path}.children[${index}]`),
        ),
      };
      if (record['extensions'] !== undefined) {
        node.extensions = expectRecord(record['extensions'], `${path}.extensions`);
      }
      // The recursion above is the *structural* half. The two things it cannot check are a
      // non-uniform scale and a duplicate id, and neither is a key-list question:
      //
      //  - `scaleX`/`scaleY` are both valid numbers; only their *relationship* is wrong. That is
      //    `UNIFORM_SCALE_EPSILON` in `validateDocument`, run from `assertDocumentIsConsistent`.
      //  - a duplicate id is invisible to any single-node parse. That is `collectIds`.
      //
      // So this function stays local and the whole-document facts stay in the whole-document
      // checks. Splitting them differently would either duplicate the rule or lose it.
      return node;
    }
    default:
      // ADR 0003's rule, and the reason this refuses rather than skipping: an unrecognised
      // kind must not come back as an object that renders as nothing.
      throw new DocumentParseError(`${path}.type`, `unknown object type "${type}"`);
  }
}

function parseSharedNode(record: Record<string, unknown>, path: string): SharedNode {
  return {
    id: expectId(record['id'], `${path}.id`),
    name: expectString(record['name'], `${path}.name`),
    transform: parseTransform(record['transform'], `${path}.transform`),
    visible: expectBoolean(record['visible'], `${path}.visible`),
    locked: expectBoolean(record['locked'], `${path}.locked`),
    opacity: expectOpacity(record['opacity'], `${path}.opacity`),
    blendMode: expectEnum(record['blendMode'], `${path}.blendMode`, BLEND_MODES) as BlendMode,
  };
}

function parseTransform(input: unknown, path: string): Transform2D {
  const record = expectRecord(input, path);
  expectOnlyKeys(record, path, TRANSFORM_KEYS);
  return {
    x: expectFinite(record['x'], `${path}.x`),
    y: expectFinite(record['y'], `${path}.y`),
    // Zero is legal and meaningful -- a horizontal line has height 0 -- while negative is
    // not, and that asymmetry is the invariant the geometry contract rests on (ADR 0005).
    width: expectNonNegative(record['width'], `${path}.width`),
    height: expectNonNegative(record['height'], `${path}.height`),
    rotation: expectFinite(record['rotation'], `${path}.rotation`),
    // Zero scale is not invertible, so the transform could not be inverted for hit testing,
    // which every object type does (ADR 0004).
    scaleX: expectNonZero(record['scaleX'], `${path}.scaleX`),
    scaleY: expectNonZero(record['scaleY'], `${path}.scaleY`),
  };
}

function parseShapeGeometry(input: unknown, path: string): ShapeGeometry {
  const record = expectRecord(input, path);
  const kind = expectString(record['kind'], `${path}.kind`);
  if (!isKnownShapeKind(kind)) {
    throw new DocumentParseError(`${path}.kind`, `unknown shape kind "${kind}"`);
  }
  if (kind === 'rect') {
    return {
      kind: 'rect',
      cornerRadius: expectNonNegative(record['cornerRadius'], `${path}.cornerRadius`),
    };
  }
  // Rejects a key that belongs to a *different* kind: `{ kind: 'ellipse', cornerRadius: 8 }`
  // is meaningless, and accepting it would store a field no renderer ever reads.
  expectOnlyKeys(record, path, ['kind']);
  return { kind };
}

/** Read off the registry, so a kind added to `model/shapes.ts` is accepted automatically. */
function isKnownShapeKind(kind: string): kind is ShapeKind {
  return (shapeKinds() as readonly string[]).includes(kind);
}

function parsePaint(input: unknown, path: string): Paint {
  const record = expectRecord(input, path);
  const type = expectString(record['type'], `${path}.type`);
  if (type !== 'solid') {
    throw new DocumentParseError(`${path}.type`, `unknown paint type "${type}"`);
  }
  expectOnlyKeys(record, path, PAINT_KEYS);
  // Not validated as a CSS colour, for the same reason an `inline` payload is not validated
  // as a data URL: an unrenderable colour is a rendering state, and refusing the file over
  // it would discard the document.
  return { type: 'solid', color: expectString(record['color'], `${path}.color`) };
}

function parseStroke(input: unknown, path: string): Stroke {
  const record = expectRecord(input, path);
  expectOnlyKeys(record, path, STROKE_KEYS);
  const align = expectEnum(record['align'], `${path}.align`, STROKE_ALIGNS);
  if (align !== 'inside') {
    // The type carries all three so a document can express intent, but only `inside`
    // renders (ADR 0005 §2). Refusing here means the user is told at *load* rather than
    // discovering it when a renderer throws in the middle of a projection.
    throw new DocumentParseError(
      `${path}.align`,
      `stroke alignment "${align}" is not supported by this build (only "inside")`,
    );
  }
  return {
    paint: parsePaint(record['paint'], `${path}.paint`),
    width: expectNonNegative(record['width'], `${path}.width`),
    align: align as StrokeAlign,
  };
}

function parseRichText(input: unknown, path: string): RichText {
  const record = expectRecord(input, path);
  expectOnlyKeys(record, path, RICH_TEXT_KEYS);
  const blocks = expectArray(record['blocks'], `${path}.blocks`);
  if (blocks.length === 0) {
    // An empty frame is one empty paragraph, never an empty list: the caret needs somewhere
    // to live and `Enter` needs somewhere to go (ADR 0003).
    throw new DocumentParseError(`${path}.blocks`, 'a frame has at least one block');
  }
  const parsed = blocks.map((block, index) => parseParagraph(block, `${path}.blocks[${index}]`));
  // Re-applied on load, so a hand-edited file with adjacent equal-format runs comes back
  // canonical instead of staying non-canonical forever (ADR 0003).
  return normalizeRichText({ blocks: parsed });
}

function parseParagraph(input: unknown, path: string): ParagraphBlock {
  const record = expectRecord(input, path);
  const kind = expectString(record['kind'], `${path}.kind`);
  if (kind !== 'paragraph') {
    throw new DocumentParseError(`${path}.kind`, `unknown block kind "${kind}"`);
  }
  expectOnlyKeys(record, path, PARAGRAPH_KEYS);
  const runs = expectArray(record['runs'], `${path}.runs`);
  const block: ParagraphBlock = {
    kind: 'paragraph',
    runs: runs.map((run, index) => parseRun(run, `${path}.runs[${index}]`)),
  };
  if (record['align'] !== undefined) {
    block.align = expectEnum(record['align'], `${path}.align`, PARAGRAPH_ALIGNS) as ParagraphAlign;
  }
  return block;
}

function parseRun(input: unknown, path: string): ParagraphBlock['runs'][number] {
  const record = expectRecord(input, path);
  expectOnlyKeys(record, path, RUN_KEYS);
  const run: ParagraphBlock['runs'][number] = {
    text: expectString(record['text'], `${path}.text`),
  };
  if (record['format'] !== undefined) {
    run.format = parseFormat(record['format'], `${path}.format`);
  }
  return run;
}

function parseFormat(input: unknown, path: string): CharFormat {
  const record = expectRecord(input, path);
  expectOnlyKeys(record, path, CHAR_FLAGS);
  // One encoding of "not bold": the flag is present-and-true or absent. A `false` would give
  // every run two spellings, which makes equality non-total -- and equality is what decides
  // whether a command is a no-op (ADR 0003).
  const format: CharFormat = {};
  for (const flag of CHAR_FLAGS) {
    const value = record[flag];
    if (value === undefined) continue;
    if (value !== true) {
      throw new DocumentParseError(`${path}.${flag}`, `must be true or absent, got ${
        typeof value
      }`);
    }
    format[flag] = true;
  }
  return format;
}

function parseTextStyle(input: unknown, path: string): TextStyle {
  const record = expectRecord(input, path);
  expectOnlyKeys(record, path, TEXT_STYLE_KEYS);
  // Built field by field so an absent property stays absent. Copying the whole record would
  // write `undefined` into the model, and "absent" is a value that both the renderer and the
  // equality function depend on.
  const style: TextStyle = {};
  if (record['fontFamily'] !== undefined) {
    style.fontFamily = expectString(record['fontFamily'], `${path}.fontFamily`);
  }
  if (record['fontSize'] !== undefined) {
    style.fontSize = expectPositiveNumber(record['fontSize'], `${path}.fontSize`);
  }
  if (record['lineHeight'] !== undefined) {
    style.lineHeight = expectPositiveNumber(record['lineHeight'], `${path}.lineHeight`);
  }
  if (record['letterSpacing'] !== undefined) {
    style.letterSpacing = expectFinite(record['letterSpacing'], `${path}.letterSpacing`);
  }
  if (record['color'] !== undefined) {
    style.color = expectString(record['color'], `${path}.color`);
  }
  return style;
}