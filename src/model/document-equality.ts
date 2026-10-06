/**
 * Canonical model equality: are these two documents the same document?
 *
 * ## Why this exists rather than comparing strings
 *
 * Two callers need "are these the same document?" and neither of them wants to serialise:
 *
 *  - **Dirty state** (ADR 0007 §7). A document with a 1 MB inline image would re-encode
 *    1.3 MB of base64 on every keystroke to answer a question about canonical state.
 *  - **The round-trip property** — `parse(serialize(d))` must equal `d`. Which equality
 *    that is has to be pinned down, and it is *this* one: the project's existing equality
 *    functions (`richTextEqual`, `payloadEqual` in the command funnel), not JSON strings.
 *
 * So one comparison with two callers, rather than two comparisons that could disagree.
 *
 * ## What "canonical" means here
 *
 * The rules this comparison respects, all established earlier and all load-bearing:
 *
 *  - **Absent is not present-and-equal.** `{ fontSize: 16 }` and `{}` render identically,
 *    but they are different documents. Optional properties are compared by presence *and*
 *    value, which is why every one is `?? null`-folded rather than defaulted.
 *  - **Order is meaningful.** Pages are document order and objects are paint order, so
 *    `[a, b]` and `[b, a]` are different documents.
 *  - **Asset identity is the id.** Two assets with equal bytes under different ids are two
 *    assets, and M7 explicitly does not deduplicate.
 *
 * Reference identity is *not* consulted anywhere: structural sharing makes two equal
 * documents routinely distinct objects, and `===` would report them different.
 *
 * Every optional field is compared **field by field** rather than by iterating keys, so a
 * newly added property cannot silently compare equal on both sides. That is the same
 * discipline `textStyleEqual` in the command funnel is explicit about.
 *
 * @module
 */

import { richTextEqual } from './rich-text';
import type {
  AssetData,
  AssetRecord,
  Document,
  Node,
  Page,
  Paint,
  ShapeGeometry,
  Stroke,
  TextStyle,
  Transform2D,
} from './types';

/** Whether two documents are the same document. */
export function documentsEqual(a: Document, b: Document): boolean {
  if (a === b) return true;
  if (a.formatVersion !== b.formatVersion) return false;
  if (a.id !== b.id) return false;
  if (a.name !== b.name) return false;
  if (!pageSizesEqual(a.pageSize, b.pageSize)) return false;
  // A document with no asset table is not equal to one with an empty table, so this is a
  // real comparison and not a defaulted one -- see `assetsEqual`.
  const leftAssets = a.assets;
  const rightAssets = b.assets;
  if ((leftAssets === undefined) !== (rightAssets === undefined)) return false;
  if (!assetsEqual(leftAssets, rightAssets)) return false;
  if (a.pages.length !== b.pages.length) return false;
  for (let i = 0; i < a.pages.length; i += 1) {
    const left = a.pages[i];
    const right = b.pages[i];
    // Both are present at this index: the lengths matched above. Spelled out because
    // `noUncheckedIndexedAccess` is right to refuse to assume it.
    if (left === undefined || right === undefined) return false;
    if (!pagesEqual(left, right)) return false;
  }
  // No `extensions` on the document or a page: the model declares the bag on nodes only,
  // so a document-level one would be inventing surface for a build that does not exist.
  // Document- and page-level unknown keys are *refused* by `parse` instead.
  return true;
}

function pageSizesEqual(a: Document['pageSize'], b: Document['pageSize']): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.unit === b.unit &&
    a.orientation === b.orientation
  );
}

function pagesEqual(a: Page, b: Page): boolean {
  if (a.id !== b.id || a.name !== b.name) return false;
  if (!paintsEqual(a.background, b.background)) return false;
  // Reference equality first. `documentsEqual` runs on every pointer move during a drag, and a page
  // whose `objects` array is *the same array* cannot have changed contents by any route that does
  // not also replace it.
  //
  // **That reasoning stopped being true in M12, and this is the hazard.** A group's children live
  // in an array reachable from a node *inside* `objects`, so a change to a group child's field
  // rebuilds the group's `children` array and the enclosing node, while `page.objects` keeps its
  // identity. A reference check on `objects` alone would then report the two pages equal while a
  // group child differed — silently, in the one function that decides whether the document is
  // dirty, and so in whether undo records a step and whether Save is enabled.
  //
  // The fix is to keep the fast path but require it to hold for the whole subtree, not just the
  // top array. `nodesEqual` already recurses; the array identity is only a shortcut *within* it.
  if (a.objects === b.objects) return true;
  if (a.objects.length !== b.objects.length) return false;
  for (let i = 0; i < a.objects.length; i += 1) {
    const left = a.objects[i];
    const right = b.objects[i];
    if (left === undefined || right === undefined) return false;
    if (!nodesEqual(left, right)) return false;
  }
  return true;
}

/**
 * Structural equality for one node against another, at the same position in the hierarchy.
 *
 * Exported because `commands.ts` needs it for its own no-op check: a command that returns a
 * *structurally identical* node rather than the same reference must still be recognised as a no-op,
 * or `History` accumulates undo steps that do nothing (ADR 0009 §5).
 *
 * The reference check at the top is not an optimisation only — it is what makes an untouched
 * subtree cost nothing, and `documentsEqual` runs on every pointer move.
 */
export function nodesEqual(a: Node, b: Node): boolean {
  if (a === b) return true;
  if (a.type !== b.type) return false;
  if (
    a.id !== b.id ||
    a.name !== b.name ||
    a.visible !== b.visible ||
    a.locked !== b.locked ||
    a.opacity !== b.opacity ||
    a.blendMode !== b.blendMode
  ) {
    return false;
  }
  if (!transformsEqual(a.transform, b.transform)) return false;
  if (!extensionsEqual(a.extensions, b.extensions)) return false;

  // The kind-specific tail. Narrowing on `type` is what keeps this exhaustive: adding a
  // node type without a branch here is a compile error, which is the point of comparing
  // structurally rather than generically.
  switch (a.type) {
    case 'shape': {
      const other = b as typeof a;
      return (
        shapesEqual(a.shape, other.shape) &&
        paintsEqual(a.fill, other.fill) &&
        strokesEqual(a.stroke, other.stroke)
      );
    }
    case 'textFrame': {
      const other = b as typeof a;
      return richTextEqual(a.text, other.text) && textStylesEqual(a.style, other.style);
    }
    case 'image': {
      const other = b as typeof a;
      // `fit` is optional, so absence is compared as absence rather than defaulted to
      // `fill`: `{ fit: 'fill' }` and `{}` are authored differently even though they
      // render identically, and the format must not collapse them.
      return a.asset === other.asset && (a.fit ?? null) === (other.fit ?? null);
    }
    case 'group': {
      const other = b as typeof a;
      // Structural, then by position. Position rather than by id, deliberately: a group that
      // reorders its children *has* changed, because child order **is** paint order. Matching by id
      // would make `[B, C]` and `[C, B]` compare equal, which is the single most expensive possible
      // mistake here — it would make a visible reorder not dirty the document.
      if (a.children.length !== other.children.length) return false;
      for (let i = 0; i < a.children.length; i += 1) {
        const left = a.children[i];
        const right = other.children[i];
        if (left === undefined || right === undefined) return false;
        if (!nodesEqual(left, right)) return false;
      }
      return true;
    }
    default: {
      const unreachable: never = a;
      throw new Error(`Unknown node type in equality: ${JSON.stringify(unreachable)}`);
    }
  }
}

function transformsEqual(a: Transform2D, b: Transform2D): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.rotation === b.rotation &&
    a.scaleX === b.scaleX &&
    a.scaleY === b.scaleY
  );
}

function shapesEqual(a: ShapeGeometry, b: ShapeGeometry): boolean {
  if (a.kind !== b.kind) return false;
  // The kinds are equal, so this narrows to `rect`; the other two carry no fields.
  return a.kind === 'rect' && b.kind === 'rect' ? a.cornerRadius === b.cornerRadius : true;
}

function paintsEqual(a: Paint | undefined, b: Paint | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.type !== b.type) return false;
  return a.type === 'solid' && b.type === 'solid' ? a.color === b.color : true;
}

function strokesEqual(a: Stroke | undefined, b: Stroke | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.width === b.width && a.align === b.align && paintsEqual(a.paint, b.paint);
}

function textStylesEqual(a: TextStyle | undefined, b: TextStyle | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    (a.fontFamily ?? null) === (b.fontFamily ?? null) &&
    (a.fontSize ?? null) === (b.fontSize ?? null) &&
    (a.lineHeight ?? null) === (b.lineHeight ?? null) &&
    (a.letterSpacing ?? null) === (b.letterSpacing ?? null) &&
    (a.color ?? null) === (b.color ?? null)
  );
}

/**
 * Compares two asset tables.
 *
 * `a` and `b` are typed as required, and `validateDocument` reports a missing table. The
 * `?? {}` is therefore not repair -- it is **containment**. This function is called from
 * `refreshChrome` on every pointer move, so a `TypeError` here does not fail a save, it
 * breaks the editor: selection, undo and every visual baseline, reported as ten unrelated
 * failures with the cause in a string in a fixture file. A malformed document must
 * degrade to "not equal", never to an exception.
 */
function assetsEqual(
  a: Readonly<Record<string, AssetRecord>> | undefined,
  b: Readonly<Record<string, AssetRecord>> | undefined,
): boolean {
  const left = Object.keys(a ?? {});
  if (left.length !== Object.keys(b ?? {}).length) return false;
  for (const id of left) {
    // `hasOwn` rather than a truthiness check: `assets['toString']` resolves to
    // `Object.prototype.toString`, the same trap `findAsset` hit in M6.
    if (!Object.hasOwn(b ?? {}, id)) return false;
    const mine = a?.[id];
    const theirs = b?.[id];
    if (mine === undefined || theirs === undefined) return false;
    if (!assetRecordsEqual(mine, theirs)) return false;
  }
  return true;
}

function assetRecordsEqual(a: AssetRecord, b: AssetRecord): boolean {
  if (a.kind !== b.kind || a.mime !== b.mime) return false;
  if (a.intrinsicWidth !== b.intrinsicWidth) return false;
  if (a.intrinsicHeight !== b.intrinsicHeight) return false;
  return assetDataEqual(a.data, b.data);
}

function assetDataEqual(a: AssetData, b: AssetData): boolean {
  // The union is discriminated by which key is present, which is what the model uses and
  // is more robust than a `type` field on each variant.
  const aInline = 'inline' in a;
  const bInline = 'inline' in b;
  if (aInline !== bInline) return false;
  if (aInline && bInline) return a.inline === (b as { inline: string }).inline;
  if (!aInline && !bInline) {
    return (a as { external: string }).external === (b as { external: string }).external;
  }
  return false;
}

/**
 * Opaque extension bags.
 *
 * Compared by **canonical JSON**, not key order. An `extensions` bag is by definition
 * something this build does not understand, so "the keys arrived in a different order"
 * cannot be treated as a difference — that would make incidental insertion order part of
 * the document's identity, and the format does not control it.
 */
function extensionsEqual(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return canonicalJson(a) === canonicalJson(b);
}

/** JSON with object keys sorted, so two equal values always produce the same string. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== 'object' || value === null) return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) out[key] = sortKeys(source[key]);
  return out;
}
