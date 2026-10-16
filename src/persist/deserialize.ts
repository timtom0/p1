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
  ParagraphDirection,
  ParagraphMetrics,
  ParagraphBlock,
  ParagraphStyleProps,
  StyleDefinition,
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
  documentKeysFor,
  DocumentParseError,
  MINIMUM_FORMAT_VERSION,
  nodeKeysFor,
  ORIENTATIONS,
  PAGE_SIZE_KEYS,
  PAINT_KEYS,
  PARAGRAPH_ALIGNS,
  PARAGRAPH_DIRECTIONS,
  paragraphKeysFor,
  pageKeysFor,
  pageSetupKeysFor,
  PARAGRAPH_METRIC_KEYS,
  RICH_TEXT_KEYS,
  runKeysFor,
  styleKeysFor,
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
import { DEFAULT_MEASUREMENT_UNIT, MEASUREMENT_UNITS } from '../core/units/units';
import { validateDocument } from '../model/invariants';
import {
  clonePageSize,
  createPageSetup,
  pageSizeProblem,
  PAGE_RESIZE_BEHAVIOURS,
  type PageSetup,
} from '../model/page-setup';

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
  assertFormatMarker(root['format']);
  // **Version first**, because the version decides which keys are legal. `expectOnlyKeys` before this
  // would have rejected every pre-M20 file on its `pageSize`, which is the only place its page
  // dimensions exist — it is the data being migrated, not an unknown field.
  const version = assertVersion(root['formatVersion']);
  expectOnlyKeys(root, '', documentKeysFor(version));

  const doc = parseDocument(root, version);
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

/**
 * Returns the accepted version, having refused the two directions that cannot be read.
 *
 * The return value exists because M20 made the version load-bearing: {@link parse} uses it to choose
 * which keys are legal and {@link parseDocument} uses it to decide whether to migrate. Before this,
 * the accepted range was checked and then discarded.
 */
function assertVersion(input: unknown): number {
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
    // The two directions get different messages because they need different actions from the user.
    //
    // The lower bound is 1, and it is *not* "no older files accepted": version 1 and version 2 both
    // fall through this check and are read normally -- the latter through the per-page size migration
    // in `parseDocument`. Only a file older than 1 is refused, and for it there is genuinely nothing
    // to migrate from.
    throw new DocumentParseError(
      'formatVersion',
      `saved by an older version of P1 (this file is ${version}, this build reads ` +
        `${MINIMUM_FORMAT_VERSION}-${CURRENT_FORMAT_VERSION}); there is no migration for it`,
    );
  }
  // Accepted, and the parser produces a document stamped with `CURRENT_FORMAT_VERSION`.
  //
  // For version 1 that stamp was the *only* difference, because a version-1 document has no groups:
  // nothing to convert, and re-stamping says "now written in the current format" without altering an
  // authored value. For version 2 the stamp comes **with** a change — every page gains the `size`
  // the document used to imply — and that is a migration rather than a re-stamp. See ADR 0019 §4 and
  // the correction above `MINIMUM_FORMAT_VERSION`.
  return version;
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

/**
 * Builds the document, migrating a legacy one if that is what this is.
 *
 * ## The M20 migration, in full
 *
 * A version-1 or version-2 file has `Document.pageSize` and no `Page.size`. The dimensions those
 * pages had are exactly the document's, so the migration is to **copy** it onto every page rather
 * than to guess or to default: the pages were already that size, and recording the size they
 * already were is the only version of this that preserves appearance.
 *
 * Three decisions worth stating, because each had a plausible alternative:
 *
 *  - **`fixedSize: true`.** A legacy document was, by construction, uniform — there was no way for it
 *    to be otherwise. So "every page matches the default" is a *fact about the file*, not an
 *    assumption, and `true` reproduces the only behaviour that document could have had. `false` would
 *    mean the same thing for existing pages and differ only for the next page added, where it would
 *    be a silent behaviour change nobody asked for.
 *  - **`resizeBehaviour: 'crop'`.** The default, and the only option that moves no content.
 *  - **The size is copied, not shared.** Every page gets its own object. A shared reference would be
 *    cheaper and would make resizing one page of a uniform document resize all of them — reintroducing
 *    exactly the document-wide coupling M20 removed, one indirection away.
 */
function parseDocument(root: Record<string, unknown>, version: number): Document {
  const id = expectId(root['id'], 'id');
  const name = expectString(root['name'], 'name');

  if (version >= 3) {
    return {
      formatVersion: CURRENT_FORMAT_VERSION,
      id,
      name,
      pageSetup: parsePageSetup(root['pageSetup'], version),
      // M23. A pre-v5 document has no `styles` key at all, and `documentKeysFor` has already
      // refused a v4 document that *does* carry one. So this is the whole migration: the absence of
      // the field becomes an empty list, and every object in it already reads `styleId: undefined`,
      // which resolves to "nothing inherited" -- exactly what those documents meant before styles
      // existed. Nothing is rewritten and nothing is inferred from formatting.
      styles: version >= 5 ? parseStyles(root['styles']) : [],
      assets: parseAssets(root['assets']),
      pages: parsePages(root['pages'], version),
    };
  }

  const legacySize = parsePageSize(root['pageSize'], 'pageSize');
  return {
    formatVersion: CURRENT_FORMAT_VERSION,
    id,
    name,
    pageSetup: createPageSetup({
      fixedSize: true,
      defaultSize: clonePageSize(legacySize),
      resizeBehaviour: 'crop',
    }),
    styles: [],
    assets: parseAssets(root['assets']),
    // `parsePages` passes the inherited size down, so the page list itself has no version branch.
    pages: parsePages(root['pages'], version, legacySize),
  };
}

/**
 * M23: parses the document's style table.
 *
 * Two rules that are not obvious, and both are load-bearing.
 *
 * **Ids are validated for uniqueness here, at load.** A duplicate id is refused rather than
 * resolved first-wins, because `resolveStyle` finds by id: with two definitions sharing one id,
 * which one an object inherits from would depend on array order, so editing the other would appear
 * to do nothing. A duplicate is a corrupt file, not a document with a quirk.
 *
 * **References are *not* validated here.** A `styleId` naming nothing — or naming a style of the
 * wrong kind — is accepted, and resolves to "nothing inherited" at render time. The alternative,
 * refusing the document, would mean one bad id anywhere makes the whole file unopenable, for a
 * condition the renderer already handles correctly and visibly. Repairing it by deleting the
 * reference would be worse still: it would write a change the user never asked for. The condition is
 * assertable through `documentReferences`, which is what the tests use instead of expecting a crash.
 */
function parseStyles(input: unknown): StyleDefinition[] {
  const list = expectArray(input, 'styles');
  const seen = new Set<string>();

  return list.map((entry, index) => {
    const path = `styles[${index}]`;
    const record = expectRecord(entry, path);
    const kind = expectString(record['kind'], `${path}.kind`);
    expectOnlyKeys(record, path, styleKeysFor(kind));

    const id = expectId(record['id'], `${path}.id`);
    if (seen.has(id)) {
      throw new DocumentParseError(`${path}.id`, `duplicate style id "${id}"`);
    }
    seen.add(id);

    const name = expectString(record['name'], `${path}.name`);
    if (name.trim() === '') {
      throw new DocumentParseError(`${path}.name`, 'must not be empty');
    }

    if (kind === 'character') {
      return { id, name, kind, character: parseCharFormat(record['character'], `${path}.character`) };
    }
    if (kind === 'paragraph') {
      return { id, name, kind, paragraph: parseParagraphStyleProps(record['paragraph'], `${path}.paragraph`) };
    }
    if (kind === 'frame') {
      return { id, name, kind, frame: parseTextStyle(record['frame'], `${path}.frame`) };
    }
    // Reached only because `styleKeysFor` returns the identity keys for an unknown kind, so the
    // error names the *kind* -- the one thing the reader needs to know is wrong.
    throw new DocumentParseError(`${path}.kind`, `unknown style kind "${kind}"`);
  });
}

/**
 * The properties a paragraph style may define.
 *
 * The same shape as `ParagraphBlock` minus `kind`, `styleId` and `runs` -- and a paragraph style
 * holding a reference to another style is refused here, because that is a parent-style hierarchy and
 * M23 explicitly does not have one. Saying so at the format boundary means a hand-edited file cannot
 * introduce one that the renderer would then have to honour.
 */
function parseParagraphStyleProps(input: unknown, path: string): ParagraphStyleProps {
  const record = expectRecord(input, path);
  expectOnlyKeys(record, path, PARAGRAPH_STYLE_PROP_KEYS);
  const props: ParagraphStyleProps = {};

  if (record['align'] !== undefined) {
    props.align = expectEnum(record['align'], `${path}.align`, PARAGRAPH_ALIGNS) as ParagraphAlign;
  }
  if (record['dir'] !== undefined) {
    props.dir = expectEnum(record['dir'], `${path}.dir`, PARAGRAPH_DIRECTIONS) as ParagraphDirection;
  }
  if (record['metrics'] !== undefined) {
    props.metrics = parseParagraphMetrics(record['metrics'], `${path}.metrics`);
  }
  return props;
}

/** The keys a paragraph *style's* payload may carry. A style defines; it does not reference. */
export const PARAGRAPH_STYLE_PROP_KEYS = ['align', 'dir', 'metrics'] as const;

/** Reuses the run's flag parser, so a style's flags are validated by exactly the same rules. */
function parseCharFormat(input: unknown, path: string): CharFormat {
  const record = expectRecord(input, path);
  expectOnlyKeys(record, path, CHAR_FLAGS);
  const format: CharFormat = {};
  for (const flag of CHAR_FLAGS) {
    if (record[flag] === true) format[flag] = true;
  }
  return format;
}

function parsePageSetup(input: unknown, version: number): PageSetup {
  const record = expectRecord(input, 'pageSetup');
  expectOnlyKeys(record, 'pageSetup', pageSetupKeysFor(version));
  const resizeBehaviour = expectEnum(
    record['resizeBehaviour'],
    'pageSetup.resizeBehaviour',
    PAGE_RESIZE_BEHAVIOURS,
  );
  return createPageSetup({
    fixedSize: expectBoolean(record['fixedSize'], 'pageSetup.fixedSize'),
    defaultSize: parsePageSize(record['defaultSize'], 'pageSetup.defaultSize'),
    resizeBehaviour,
    // M24, and the whole of the migration. A pre-v6 document has no `unit`, and
    // `pageSetupKeysFor` has already refused one that *does* carry it -- so this is the absence
    // becoming `DEFAULT_MEASUREMENT_UNIT`, and nothing else in the document is touched.
    //
    // The default is `mm` because `DEFAULT_PAGE_PRESET` has been A4-in-millimetres since before the
    // format existed, which is what makes the migration **unobservable**: nothing stored is
    // reinterpreted, because everything stored is px, and the only field being filled in is a
    // display preference that previously had no value to lose.
    //
    // Deliberately *not* inferred from `defaultSize.unit`. That is the obvious-looking choice and it
    // is wrong twice over. It would make the document's authoring unit a function of which paper
    // preset happened to be selected, so choosing Letter would silently switch a millimetre document
    // to inches -- the exact confusion the milestone separates `PageSize.unit` from
    // `PageSetup.unit` in order to prevent. And it would let the unit of the *first* page leak into
    // a document whose later pages differ.
    //
    // The `version` test rather than an `undefined` test, so the two failure modes stay distinct: a
    // v6 document missing the key is refused by name, while a v5 document lacking it -- which is
    // every v5 document -- reads as the default. Reading `undefined` as the default instead would
    // make the required field optional in every version at once, and quietly accept a v6 file that
    // a hand-edit had stripped.
    unit:
      version >= 6
        ? expectEnum(record['unit'], 'pageSetup.unit', MEASUREMENT_UNITS)
        : DEFAULT_MEASUREMENT_UNIT,
  });
}

/**
 * Reads a page size, then applies the model's own bounds.
 *
 * `expectPositiveNumber` is kept because it is the rule that was already here and it names the
 * failure precisely; {@link pageSizeProblem} adds the *range*, which a document 0.01mm across would
 * otherwise pass and then render as nothing.
 */
function parsePageSize(input: unknown, path: string): PageSize {
  const record = expectRecord(input, path);
  expectOnlyKeys(record, path, PAGE_SIZE_KEYS);
  const size: PageSize = {
    width: expectPositiveNumber(record['width'], `${path}.width`),
    height: expectPositiveNumber(record['height'], `${path}.height`),
    unit: expectPhysicalUnit(record['unit'], `${path}.unit`),
    orientation: expectEnum(record['orientation'], `${path}.orientation`, ORIENTATIONS) as Orientation,
  };
  const problem = pageSizeProblem(size);
  if (problem !== null) {
    throw new DocumentParseError(path, problem);
  }
  return size;
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

function parsePages(input: unknown, version: number, inheritedSize?: PageSize): Page[] {
  const list = expectArray(input, 'pages');
  if (list.length === 0) {
    throw new DocumentParseError('pages', 'a document has at least one page');
  }
  return list.map((page, index) => parsePage(page, `pages[${index}]`, version, inheritedSize));
}

function parsePage(input: unknown, path: string, version: number, inheritedSize?: PageSize): Page {
  const record = expectRecord(input, path);
  expectOnlyKeys(record, path, pageKeysFor(version));
  const objects = expectArray(record['objects'], `${path}.objects`);
  return {
    id: expectId(record['id'], `${path}.id`),
    name: expectString(record['name'], `${path}.name`),
    // A version-3 page must state its own size; a legacy page takes the document's. Both branches
    // end with a `size`, because the `Document` this parser returns is a version-3 document and every
    // page in it has a size.
    size:
      version >= 3
        ? parsePageSize(record['size'], `${path}.size`)
        : clonePageSize(inheritedSize ?? parsePageSize(record['size'], `${path}.size`)),
    background: parsePaint(record['background'], `${path}.background`),
      objects: objects.map((node, index) => parseNode(node, `${path}.objects[${index}]`, version)),
  };
}

/** Everything a node carries whatever its type, minus the type-specific tail. */
type SharedNode = Omit<ShapeNode, 'type' | 'shape' | 'fill' | 'stroke'>;

function parseNode(input: unknown, path: string, version: number): Node {
  const record = expectRecord(input, path);
  const type = expectString(record['type'], `${path}.type`);

  switch (type) {
    case 'shape': {
      expectOnlyKeys(record, path, nodeKeysFor('shape', version));
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
      expectOnlyKeys(record, path, nodeKeysFor('textFrame', version));
      const node: TextFrameNode = {
        type: 'textFrame',
        ...parseSharedNode(record, path),
        text: parseRichText(record['text'], `${path}.text`, version),
      };
      if (record['style'] !== undefined) {
        node.style = parseTextStyle(record['style'], `${path}.style`);
      }
      // M23. The frame's style reference, beside its direct typography rather than inside it -- so
      // that "inherit the size, override the colour" stays two independent facts.
      //
      // Accepted without being checked against the style table, for the reason `parseParagraph`
      // gives: an unresolvable id inherits nothing, and refusing the document would make one bad id
      // anywhere unopenable. Repaired here it would write a change nobody asked for.
      if (record['styleId'] !== undefined) {
        node.styleId = expectId(record['styleId'], `${path}.styleId`);
      }
      if (record['extensions'] !== undefined) {
        node.extensions = expectRecord(record['extensions'], `${path}.extensions`);
      }
      return node;
    }
    case 'image': {
      expectOnlyKeys(record, path, nodeKeysFor('image', version));
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
      expectOnlyKeys(record, path, nodeKeysFor('group', version));
      const node: GroupNode = {
        type: 'group',
        ...parseSharedNode(record, path),
        children: expectArray(record['children'], `${path}.children`).map((child, index) =>
          parseNode(child, `${path}.children[${index}]`, version),
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

function parseRichText(input: unknown, path: string, version: number): RichText {
  const record = expectRecord(input, path);
  expectOnlyKeys(record, path, RICH_TEXT_KEYS);
  const blocks = expectArray(record['blocks'], `${path}.blocks`);
  if (blocks.length === 0) {
    // An empty frame is one empty paragraph, never an empty list: the caret needs somewhere
    // to live and `Enter` needs somewhere to go (ADR 0003).
    throw new DocumentParseError(`${path}.blocks`, 'a frame has at least one block');
  }
  const parsed = blocks.map((block, index) =>
    parseParagraph(block, `${path}.blocks[${index}]`, version),
  );
  // Re-applied on load, so a hand-edited file with adjacent equal-format runs comes back
  // canonical instead of staying non-canonical forever (ADR 0003).
  return normalizeRichText({ blocks: parsed });
}

function parseParagraph(input: unknown, path: string, version: number): ParagraphBlock {
  const record = expectRecord(input, path);
  const kind = expectString(record['kind'], `${path}.kind`);
  if (kind !== 'paragraph') {
    throw new DocumentParseError(`${path}.kind`, `unknown block kind "${kind}"`);
  }
  // Version first, so a v3 file carrying `dir` is refused by name as a future document rather than
  // accepted by a build that would silently drop the field on the next save.
  expectOnlyKeys(record, path, paragraphKeysFor(version));
  const runs = expectArray(record['runs'], `${path}.runs`);
  const block: ParagraphBlock = {
    kind: 'paragraph',
    runs: runs.map((run, index) => parseRun(run, `${path}.runs[${index}]`, version)),
  };
  if (record['align'] !== undefined) {
    block.align = expectEnum(record['align'], `${path}.align`, PARAGRAPH_ALIGNS) as ParagraphAlign;
  }
  // M22. Both are optional and both default by *absence*, which is what makes the v3 migration
  // trivial: a v3 document simply has neither, and `auto` plus no metrics is exactly what it meant
  // when it was written. Nothing is rewritten, so re-saving a v3 file as v4 adds nothing it did not
  // already say.
  if (record['dir'] !== undefined) {
    block.dir = expectEnum(record['dir'], `${path}.dir`, PARAGRAPH_DIRECTIONS) as ParagraphDirection;
  }
  if (record['metrics'] !== undefined) {
    block.metrics = parseParagraphMetrics(record['metrics'], `${path}.metrics`);
  }
  // M23. Accepted without being checked against the style table: an id naming nothing, or naming
  // the wrong category, resolves to "nothing inherited" rather than refusing the file. See
  // `parseStyles` for why the reference is not repaired or refused.
  if (record['styleId'] !== undefined) {
    block.styleId = expectId(record['styleId'], `${path}.styleId`);
  }
  return block;
}

/**
 * Every metric is a length, so every one is validated as finite -- but only `textIndent` is allowed
 * to be negative.
 *
 * That asymmetry is the model speaking, not a parsing detail. A negative first-line indent against a
 * positive margin is a hanging indent, which is ordinary publishing; a negative *margin* would mean
 * overlapping the neighbouring paragraph, which a fixed-size frame cannot make safe. The former is
 * accepted, the latter is refused by name rather than clamped.
 */
function parseParagraphMetrics(input: unknown, path: string): ParagraphMetrics {
  const record = expectRecord(input, path);
  expectOnlyKeys(record, path, PARAGRAPH_METRIC_KEYS);
  const metrics: ParagraphMetrics = {};
  for (const key of PARAGRAPH_METRIC_KEYS) {
    const value = record[key];
    if (value === undefined) continue;
    metrics[key] = key === 'textIndent' ? expectFinite(value, `${path}.${key}`) : expectNonNegative(value, `${path}.${key}`);
  }
  return metrics;
}

function parseRun(input: unknown, path: string, version: number): ParagraphBlock['runs'][number] {
  const record = expectRecord(input, path);
  expectOnlyKeys(record, path, runKeysFor(version));
  const run: ParagraphBlock['runs'][number] = {
    text: expectString(record['text'], `${path}.text`),
  };
  if (record['format'] !== undefined) {
    run.format = parseFormat(record['format'], `${path}.format`);
  }
  // M23: see `parseParagraph` -- accepted unchecked, resolves to nothing if unresolvable.
  if (record['styleId'] !== undefined) {
    run.styleId = expectId(record['styleId'], `${path}.styleId`);
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
