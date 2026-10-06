/**
 * The command funnel (§4.2).
 *
 * Every mutation to the document — from a tool, the inspector, a menu, paste, or a
 * future script — is a `Command`. `apply` is pure and total. That single property
 * is what makes undo, re-rendering, and future automation fall out for free, and it
 * is what makes it impossible for a change to bypass history.
 *
 * Commands are plain data: no functions, no DOM, no classes. That keeps them
 * cheap to compare, cheap to log, and serializable later for persistence (M8).
 */

import type {
  AssetRecord,
  Document,
  GroupNode,
  Node,
  Page,
  ParagraphAlign,
  RichText,
  ShapeNode,
  TextFrameNode,
  TextStyle,
  Transform2D,
} from './types';
import { createTransform, createGroupNode } from './factory';
import { normalizeRichText, richTextEqual as richTextEquals } from './rich-text';
import { worldTransformIn } from './transform';
import { isGroup, locateNode, mapNodesByIdIn, removeNodesById } from './tree';
import type { NodeLocation } from './tree';

/**
 * Mutating a single node's transform.
 *
 * `Patch` rather than a full transform so callers can nudge one axis without
 * restating the rest.
 */
export interface TransformPatch {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
}

export type Command =
  | { type: 'setTransform'; ids: readonly string[]; patch: TransformPatch }
  | { type: 'setProps'; ids: readonly string[]; props: Record<string, unknown> }
  | { type: 'insert'; pageId: string; index: number; nodes: readonly Node[] }
  | { type: 'remove'; ids: readonly string[] }
  | { type: 'reorder'; pageId: string; id: string; toIndex: number }
  | { type: 'restack'; pageId: string; ids: readonly string[]; direction: RestackDirection }
  | { type: 'setText'; nodeId: string; text: TextFrameNode['text'] }
  | { type: 'setTextStyle'; ids: readonly string[]; patch: TextStylePatch }
  | { type: 'setTextAlign'; nodeId: string; align: ParagraphAlign | null }
  | { type: 'setPageProps'; pageId: string; props: Partial<Omit<Page, 'id' | 'objects'>> }
  /**
   * Adds or replaces asset records, keyed by id.
   *
   * The whole of the asset mutation surface, and it is a **map** rather than a set of
   * add/remove commands on purpose:
   *
   *  - Replacing an asset's bytes is a *write to the same id*, not a delete plus an add.
   *    Two commands would make it possible for the document to be observed between them
   *    with a reference to bytes that no longer exist, and it would put two entries on the
   *    undo stack for one user action.
   *  - No `removeAsset` exists, because deleting an asset that a node still references
   *    would produce a dangling reference, and garbage collecting unreferenced assets is
   *    deferred (ADR 0006's named gap). Leaving orphans is recoverable; dangling
   *    references are not.
   */
  | { type: 'setAssets'; assets: Readonly<Record<string, AssetRecord>> }
  /**
   * Wraps sibling nodes in a new group, in place.
   *
   * A **structural** command, and the reason it needs no geometry of its own is M12's theorem: a group
   * authored at the transparent frame (`x=0, y=0, rotation=0, scaleX=scaleY=1`) is the identity in
   * page space whatever its `width`/`height`, so `worldTransformIn(child, group) === child`
   * bit-for-bit. Grouping therefore **moves node objects into an array** and rewrites no transform at
   * all -- no inverse matrix, no coordinate conversion, no second geometry system. Ungrouping is the
   * same move in reverse.
   *
   * `ids` may name groups as well as leaves; nesting is legal and untouched.
   */
  | { type: 'group'; ids: readonly string[] }
  /** Lifts each group's direct children into the group's own parent, and removes the group. */
  | { type: 'ungroup'; ids: readonly string[] }
  | { type: 'batch'; cmds: readonly Command[]; label?: string };

/**
 * A partial change to a text frame's typography.
 *
 * A `Partial` rather than a whole `TextStyle` so that "change the size" does not
 * have to restate the family, line height and colour — the same reason `setTransform`
 * patches rather than replaces.
 */
export type TextStylePatch = Partial<TextStyle>;

/**
 * Applies a command, returning a new document.
 *
 * Returns the *same reference* when the command is a no-op, which lets
 * `DocumentView`'s `prev`-based skip treat "nothing changed" as free, and lets
 * history avoid recording empty transactions.
 */
export function apply(doc: Document, command: Command): Document {
  switch (command.type) {
    case 'batch':
      return command.cmds.reduce(apply, doc);

    case 'setTransform':
      return mapNodesById(doc, command.ids, (node) => {
        // Comparing the *merged* transform against the current one is what makes
        // "set X to the value it already has" a no-op. Without this, every dispatch
        // produces a fresh document, every gesture records an undo step for a drag
        // that moved nothing, and the renderer's reference-equality skip never fires.
        const merged = createTransform({ ...node.transform, ...command.patch });
        if (transformsEqual(merged, node.transform)) return node;
        return { ...node, transform: merged };
      });

    case 'setProps':
      return mapNodesById(doc, command.ids, (node) => {
        // No-op detection, which this command did not have.
        //
        // It returned `{ ...node, ...props }` unconditionally, so writing a value the
        // node already held produced a *new* object — and §4.2's rule is that `apply`
        // returns the same reference when nothing changed, because `History` treats
        // reference identity as "nothing happened". The visible symptom was the
        // inspector's fill field putting an undo entry on the stack for re-committing
        // the colour already displayed, which is the exact bug the rule exists to
        // prevent.
        //
        // M5 made this load-bearing: fill, stroke, stroke width and opacity all commit
        // through `setProps`, and every one of them is re-committed whenever the field
        // loses focus.
        if (Object.entries(command.props).every(([key, value]) => isSameValue(node, key, value))) {
          return node;
        }
        return { ...node, ...command.props } as Node;
      });

    case 'insert': {
      if (command.nodes.length === 0) return doc;
      return replacePages(
        doc,
        doc.pages.map((page) => {
          if (page.id !== command.pageId) return page;
          const objects = [...page.objects];
          const index = Math.max(0, Math.min(command.index, objects.length));
          objects.splice(index, 0, ...command.nodes.map(clone));
          return { ...page, objects };
        }),
      );
    }

    case 'remove': {
      const removing = new Set(command.ids);
      if (removing.size === 0) return doc;
      // Recursive, so deleting a group child works. Removing a group removes its whole subtree,
      // because the children are *in* it — they are not separately named in `command.ids` and they
      // must not be left behind pointing at nothing.
      return removeNodesById(doc, removing);
    }

    case 'reorder': {
      return replacePages(
        doc,
        doc.pages.map((page) => {
          if (page.id !== command.pageId) return page;
          const from = page.objects.findIndex((node) => node.id === command.id);
          if (from < 0) return page;
          const objects = [...page.objects];
          const [moved] = objects.splice(from, 1);
          if (moved === undefined) return page;
          // `to` is measured in the array *after* removal, so a same-position move
          // is `to === from - 1`, not `to === from`.
          const to = Math.max(0, Math.min(command.toIndex, objects.length));
          if (to === from || to === from - 1) return page;
          objects.splice(to, 0, moved);
          return { ...page, objects };
        }),
      );
    }

    case 'restack': {
      return replacePages(
        doc,
        doc.pages.map((page) => {
          if (page.id !== command.pageId) return page;
          const restacked = restackObjects(page.objects, command.ids, command.direction);
          // Reference-identical when nothing moved, which is what makes `isNoop` and therefore
          // `History` treat "the topmost object cannot come further forward" as no change at
          // all, rather than as an undo step that does nothing.
          if (restacked === page.objects) return page;
          return { ...page, objects: [...restacked] };
        }),
      );
    }

    case 'group':
      return groupSiblings(doc, command.ids);

    case 'ungroup':
      return ungroupNodes(doc, command.ids);

    case 'setText': {
      return mapNodesById(doc, [command.nodeId], (node) => {
        if (node.type !== 'textFrame') return node;
        // Same no-op rule as `setTransform`: writing the text the frame already holds
        // must not produce a new document, or a session that ended without editing
        // would leave an undo step that does nothing. The comparison is
        // format-aware, so bolding a word is a change and re-writing it is not.
        if (richTextEqual(node.text, command.text)) return node;
        return { ...node, text: normalizeRichText(clone(command.text)) };
      });
    }

    case 'setTextStyle': {
      return mapNodesById(doc, command.ids, (node) => {
        if (node.type !== 'textFrame') return node;
        const next: TextStyle = { ...node.style, ...command.patch };
        // An all-undefined style is the same as no style, so collapse it rather than
        // leaving an empty object in the document.
        const style = Object.values(next).some((value) => value !== undefined) ? next : undefined;
        if (textStyleEqual(node.style, style)) return node;
        return { ...node, style };
      });
    }

    case 'setTextAlign': {
      return mapNodesById(doc, [command.nodeId], (node) => {
        if (node.type !== 'textFrame') return node;
        const align = command.align;

        // Every paragraph already at this alignment means there is nothing to do.
        if (node.text.blocks.every((block) => block.align === align)) return node;

        // Alignment is per paragraph (ADR 0003), so a frame-level change rewrites
        // every paragraph. `null` clears it, returning the text to the CSS default.
        return {
          ...node,
          text: normalizeRichText({
            blocks: node.text.blocks.map((block) => ({
              kind: block.kind,
              ...(align === null ? {} : { align }),
              runs: block.runs,
            })),
          }),
        };
      });
    }

    case 'setPageProps': {
      return replacePages(
        doc,
        doc.pages.map((page) => {
          if (page.id !== command.pageId) return page;
          const next = { ...page, ...command.props };
          return pagePropsEqual(page, next) ? page : next;
        }),
      );
    }

    case 'setAssets': {
      // Merged per key rather than replacing the table, so `setAssets` can add one asset
      // without restating the others. The no-op check is per key for the reason M5's
      // `setProps` fix established: re-importing identical bytes must not put an undo step
      // on the stack.
      let changed = false;
      const assets = { ...doc.assets };
      for (const [id, asset] of Object.entries(command.assets)) {
        if (payloadEqual(assets[id], asset)) continue;
        assets[id] = asset;
        changed = true;
      }
      return changed ? { ...doc, assets } : doc;
    }

    default: {
      const exhaustive: never = command;
      throw new Error(`Unknown command: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Rebuilds the document only if some page actually changed.
 *
 * Every command funnels through this so that "nothing happened" is observable as
 * reference equality. That is not a micro-optimisation: `History.dispatch` refuses
 * to record a no-op, and `History.commitExternal` treats identity as "no change".
 * If a command quietly produced a new object anyway, the user would get undo steps
 * for actions that did nothing.
 */
function replacePages(doc: Document, pages: Document['pages']): Document {
  for (let index = 0; index < pages.length; index += 1) {
    if (pages[index] !== doc.pages[index]) return { ...doc, pages };
  }
  return doc;
}

/**
 * Field-by-field transform comparison.
 *
 * Deliberately not `JSON.stringify`: that would silently start reporting "changed"
 * if a field were added to `Transform2D` without updating this list, which is the
 * worst possible failure mode for a no-op check.
 */
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

/**
 * Field-by-field page comparison for the properties `setPageProps` can change.
 *
 * Explicit rather than generic so that adding a page property to the model forces a
 * decision here, instead of silently reporting "no change".
 */
function pagePropsEqual(a: Page, b: Page): boolean {
  // The `objects` reference check is **sound here and only here**, and M12 is the reason that
  // distinction now has to be stated rather than assumed.
  //
  // Its sole caller is `setPageProps`, which spreads `{ ...page, name }` and therefore carries the
  // *same* `objects` array through. No group child's field can have changed on the way, because
  // nothing in this command touches a node. So "same array identity" does imply "same contents"
  // for this one call site.
  //
  // It does **not** hold for the `pagesEqual` in `document-equality.ts`, which compares arbitrary
  // page pairs: there, a group child's edit rebuilds the enclosing group while `page.objects` keeps
  // its identity, so the same shortcut would report differing pages as equal — and that function
  // decides whether the document is dirty. Two functions, one shape, opposite soundness. The
  // difference is the caller, so it is recorded at both.
  return (
    a.id === b.id && a.name === b.name && a.background === b.background && a.objects === b.objects
  );
}

/**
 * Structural rich-text comparison.
 *
 * Delegates to `richTextEqual` in `model/rich-text.ts`, which owns both the
 * comparison and the canonical form it is compared against. Keeping them apart means
 * a change to canonicalisation cannot silently stop being applied here.
 */
function richTextEqual(a: RichText, b: RichText): boolean {
  return richTextEquals(a, b);
}

/**
 * Field-by-field typography comparison.
 *
 * Explicit rather than generic, so adding a property to `TextStyle` forces a decision
 * here rather than silently reporting "no change".
 */
function textStyleEqual(a: TextStyle | undefined, b: TextStyle | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.fontFamily === b.fontFamily &&
    a.fontSize === b.fontSize &&
    a.lineHeight === b.lineHeight &&
    a.letterSpacing === b.letterSpacing &&
    a.color === b.color
  );
}

/** True when applying the command would not change the document. */
export function isNoop(doc: Document, command: Command): boolean {
  return apply(doc, command) === doc;
}

/**
 * The sibling array a node lives in -- a page's `objects` or a group's `children`.
 *
 * One function rather than a `type === 'group'` branch at each use, because the whole of grouping is
 * "find the array, splice it", and the array is the only thing that differs between the two owners.
 */
function siblingsOf(owner: Page | GroupNode): readonly Node[] {
  // `Page` is not a `Node` (it has no `type`, `transform` or `children`), so the narrowing has to
  // happen here rather than being asserted at the call sites.
  return isGroup(owner as Node) ? (owner as GroupNode).children : (owner as Page).objects;
}

/**
 * Writes a rebuilt sibling array back into the document at the owner's location.
 *
 * Goes through `locateNode` rather than searching `page.objects`, because after grouping the owner is
 * usually a group and a page-level scan cannot see it -- which is the failure ADR 0012 §2 exists to
 * prevent ("the object renders but every command on it is inert").
 */
function replaceOwner(
  doc: Document,
  owner: Page | GroupNode,
  nodes: readonly Node[],
): Document {
  if (isGroup(owner as Node)) {
    // The group itself lives somewhere: in a page's `objects` or in another group's `children`.
    return mapNodesByIdIn(doc, new Set([owner.id]), (node) => {
      if (!isGroup(node) || node.id !== owner.id) return node;
      return { ...node, children: [...nodes] };
    });
  }
  return replacePages(
    doc,
    doc.pages.map((page) => (page.id === owner.id ? { ...page, objects: [...nodes] } : page)),
  );
}

/**
 * Wraps the selected siblings in a new group.
 *
 * ## Why this is a pure array move
 *
 * M12 proved that a group authored at the transparent frame is the identity in page space, so
 * `worldTransformIn(child, group) === child` bit-for-bit. Every child therefore keeps **the same object
 * with the same transform**; nothing here reads a matrix, computes an inverse, or touches geometry.
 * The renderer, hit testing and chrome all keep working because the *same* nodes are simply one level
 * deeper, and their world matrices are unchanged.
 *
 * ## The contiguous span, and why it is not optional
 *
 * A group's children occupy one contiguous run of its parent's array, because paint order is that array
 * (`tree.ts` flattens depth-first). So a selection of `A` and `C` from `[A, B, C, D]` cannot become a
 * group holding `A, C` without moving `B` -- and any arrangement of the group relative to `B` changes
 * the paint order, hence the rendered result. Three ways out were available:
 *
 * - **refuse** a non-contiguous selection: predictable, but silently does nothing for a user who
 *   shift-clicked two shapes with a third between them;
 * - **reorder** `B` around the group: preserves the group's members, changes what the user sees;
 * - **absorb the span**: the group takes everything from the first to the last selected node.
 *
 * The third is chosen, because "grouping preserves the rendered appearance exactly" is a requirement
 * and the other two cannot both keep it and keep the selection meaningful. `B` was between the user's
 * two picks, so being inside the group is the least surprising reading of "group these two". It is
 * documented rather than silent because it is a real expansion of the selection, and it is
 * deterministic: the span depends only on the array, never on selection order.
 *
 * ## Refusals, all of them no-ops
 *
 * Fewer than two nodes; a node that does not exist; nodes in different parents; nodes in different
 * pages. Returning `doc` makes `isNoop` true, so a refused group is not an undo step.
 */
function groupSiblings(doc: Document, ids: readonly string[]): Document {
  const wanted = new Set(ids);
  if (wanted.size < 2) return doc;

  const found: NodeLocation[] = [];
  for (const id of wanted) {
    const location = locateNode(doc, id);
    if (location === null) return doc;
    found.push(location);
  }
  // One parent, or it is not a group but a reparenting.
  const first = found[0];
  if (first === undefined) return doc;
  const owner = first.owner;
  if (!found.every((location) => location.owner === owner)) return doc;
  if (!found.every((location) => location.pageId === first.pageId)) return doc;

  const siblings = siblingsOf(owner);
  // The span, by array index. `wanted` is a Set, so selection order cannot leak into this.
  const indices = found
    .map((location) => siblings.findIndex((node) => node.id === location.node.id))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);
  const start = indices[0];
  const end = indices[indices.length - 1];
  if (start === undefined || end === undefined || end - start + 1 < 2) return doc;

  // The existing objects, in their existing order. Not cloned: identity is what lets the renderer's
  // `prev`-based skip treat an untouched leaf as unchanged, and it is what a grouping test can assert.
  const children = siblings.slice(start, end + 1);
  const group = createGroupNode({ children: [...children] });

  const out = [...siblings];
  out.splice(start, children.length, group);
  return replaceOwner(doc, owner, out);
}

/**
 * Lifts each group's direct children into the group's own parent and removes the group.
 *
 * The exact inverse of {@link groupSiblings} at the same array position, and it is again a pure array
 * move: a child's `transform` is group-local, and after the move it is page-local, which is only
 * correct if the group was transparent. A group that has been **moved** is no longer transparent, so
 * ungrouping it must compose -- and it does so through `worldTransformIn`, the one function that owns
 * that composition, rather than through a matrix this file would have to get right.
 *
 * Nested groups are children too and are lifted as-is: ungrouping is one level, never recursive.
 */
function ungroupNodes(doc: Document, ids: readonly string[]): Document {
  const wanted = new Set(ids);
  if (wanted.size === 0) return doc;

  let out = doc;
  for (const id of wanted) {
    const location = locateNode(out, id);
    if (location === null || !isGroup(location.node)) return doc;
    const siblings = siblingsOf(location.owner);
    const index = siblings.findIndex((node) => node.id === id);
    if (index < 0) return doc;
    const next = [...siblings];
    next.splice(index, 1, ...promotedChildren(location.node));
    out = replaceOwner(out, location.owner, next);
  }
  return out;
}

/**
 * A group whose frame is the transparent one: `x=0, y=0, rotation=0, scaleX=scaleY=1`.
 *
 * At that frame `worldMatrix` is exactly the identity, so a child's group-local transform is already
 * its page-local transform -- bit for bit, not to a tolerance.
 */
function isTransparentGroup(group: GroupNode): boolean {
  const t = group.transform;
  return t.x === 0 && t.y === 0 && t.rotation === 0 && t.scaleX === 1 && t.scaleY === 1;
}

/**
 * A group's children, ready to sit in the group's own parent.
 *
 * For a **transparent** group this returns the *same child objects*. That is not just an optimisation:
 * it is what makes "group then ungroup" restore the document exactly -- by reference as well as by
 * canonical equality -- and it is why the common case needs no arithmetic at all.
 *
 * For a group that has been **moved**, the transparency is gone and the children's transforms are
 * group-local, so they must be composed through the group's own frame. `worldTransformIn` is used for
 * that: it is the one function that owns parent/child composition, and it is already the thing the
 * renderer and the selection chrome use. Adding a matrix here instead would be a second geometry
 * system for a conversion that already has an owner.
 */
function promotedChildren(group: GroupNode): Node[] {
  if (isTransparentGroup(group)) return [...group.children];
  return group.children.map((child) => {
    const transform = worldTransformIn(child.transform, group.transform);
    return transformsEqual(transform, child.transform) ? child : { ...child, transform };
  });
}

/**
 * Whether `node[key]` already holds `value`.
 *
 * One key, not a dotted path — deliberately, and the two are not the same thing.
 * `apply` spreads the payload over the node, so `props` keys are *top-level property
 * names*: `'fill.color'` would be stored as a literal key called `fill.color`, leaving
 * `fill` untouched. Walking a dotted path here would therefore compare the nested value
 * the command is **not** going to write, and could report "no change" for a command that
 * would have added a junk key. A caller wanting a nested write sends the whole value:
 * `{ fill: { type: 'solid', color } }`.
 */
function isSameValue(node: Node, key: string, value: unknown): boolean {
  return payloadEqual((node as unknown as Record<string, unknown>)[key], value);
}

/**
 * Deep enough, for the payloads `setProps` actually carries.
 *
 * ## Why this exists at all
 *
 * Comparing object-valued props by identity was tried first and it does not work: the
 * inspector builds `{ fill: { type: 'solid', color } }` from its own copy, so a *fresh*
 * object holding the *same* colour is never `===` to the node's. Re-committing the value
 * already on screen would then be recorded as a change, which is precisely the bug the
 * no-op check exists to prevent.
 *
 * ## Why it is bounded rather than general
 *
 * `setProps` carries plain document data — colours as strings, numbers, small literals —
 * and this is the only place that needs a structural comparison. So:
 *
 *  - **Depth-capped.** A cycle in a payload ends the walk as "different", which is the
 *    safe answer: a history entry that should not exist, rather than a hang.
 *  - **Own enumerable keys only.** Inherited properties are not part of the value.
 *  - **`undefined` and `null` are equivalent**, because "absent" is how the model spells
 *    "cleared" — so clearing an already-clear property is a no-op.
 *  - **Non-object leaves compare by `Object.is`,** which also covers `NaN` correctly.
 */
const MAX_PAYLOAD_DEPTH = 8;

function payloadEqual(current: unknown, value: unknown, depth = 0): boolean {
  if (Object.is(current, value)) return true;

  if (depth >= MAX_PAYLOAD_DEPTH) return false;
  if (typeof current !== 'object' || typeof value !== 'object') {
    return isAbsent(current) && isAbsent(value);
  }
  if (current === null || value === null) return isAbsent(current) && isAbsent(value);
  if (Array.isArray(current) !== Array.isArray(value)) return false;

  const a = current as Record<string, unknown>;
  const b = value as Record<string, unknown>;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => key in b && payloadEqual(a[key], b[key], depth + 1));
}

/** Whether a value is the model's spelling of "absent". */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

/**
 * Human-readable label for history and menus.
 *
 * Lives beside the command definitions so a new command cannot forget to describe
 * itself — an unlabelled entry shows up in the Edit menu as "Undo", which is a
 * worse bug than no undo.
 */
export function describeCommand(command: Command): string {
  switch (command.type) {
    case 'batch':
      return command.label ?? describeCommands(command.cmds);
    case 'setTransform':
      return command.ids.length > 1 ? 'Move' : 'Transform';
    case 'setProps':
      return describeProps(command);
    case 'setTextStyle':
      return command.ids.length > 1 ? 'Text style' : 'Typography';
    case 'setTextAlign':
      return 'Align';
    case 'insert':
      return command.nodes.length > 1 ? `Insert ${command.nodes.length} objects` : 'Insert';
    case 'remove':
      return command.ids.length > 1 ? `Delete ${command.ids.length} objects` : 'Delete';
    case 'reorder':
      return 'Reorder';
    case 'restack':
      return describeRestack(command.direction, command.ids.length);
    case 'setText':
      return 'Edit text';
    case 'setPageProps':
      return 'Change page';
    case 'group':
      // Past tense, like every label here: this is what the Edit menu says *after* the fact.
      return 'Group';
    case 'ungroup':
      return 'Ungroup';
    case 'setAssets':
      // Past tense, like every other label here: this is what the Edit menu says *after*
      // the fact. 'Import image' would read as a pending action.
      return 'Import image';
    default:
      return 'Change';
  }
}

/**
 * Collapses a batch's labels into one.
 *
 * A batch of one keeps that command's label, which is what makes a drag read as
 * "Move" rather than "1 change". A batch of several distinct labels becomes a
 * count, because a menu item reading "Undo Move Change Delete" is worse than one
 * reading "Undo 3 changes".
 */
function describeCommands(commands: readonly Command[]): string {
  if (commands.length === 0) return 'Change';
  const labels = new Set(commands.map(describeCommand));
  if (labels.size === 1) return [...labels][0] ?? 'Change';
  return `${labels.size} changes`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Applies `fn` to every node whose id is in `ids`, **at any depth**.
 *
 * Returns the original document if nothing matched, so a command targeting a
 * deleted node is inert rather than a fresh object identity — which matters,
 * because the renderer treats reference equality as "unchanged".
 *
 * ## Why this is the one place recursion happens (M12)
 *
 * Every field-level command — `setTransform`, `setPaint`, `setStroke`, `setText`,
 * `setTextStyle`, `setVisible`, `setLocked`, `setOpacity`, `setBlendMode` — is a `mapNodesById`.
 * Making *this* recursive gives all of them group-child support at once, and it is why none of them
 * needed a "is this node inside a group?" branch: they never asked where the node is, they asked
 * for a node with an id and got one.
 *
 * The alternative — resolving a node's owner once and rewriting a single array — is what
 * `locateNode` exists for, and it is the wrong tool for a *field* change: a transform edit that
 * rebuilt only the child array would leave the enclosing group holding a stale child, and every
 * consumer walking the tree would see the old value.
 *
 * So: rebuild every array on the path from a changed leaf up to the page, and no others. That is
 * what `mapNodesByIdIn` does, and it keeps the "unchanged" reference signal intact at every level.
 */
function mapNodesById(doc: Document, ids: readonly string[], fn: (node: Node) => Node): Document {
  if (ids.length === 0) return doc;
  return mapNodesByIdIn(doc, new Set(ids), fn);
}

// ---------------------------------------------------------------------------
// Layer order
// ---------------------------------------------------------------------------

/**
 * Which way a set of objects moves through the paint order.
 *
 * Relative on purpose. `reorder` takes an absolute `toIndex` measured in the array *after*
 * the node is removed, which is a sharp edge for a caller: "one position forward" is a
 * different number for every object in a multi-selection, and the number goes stale the
 * moment anything is inserted. A direction does not.
 */
export type RestackDirection = 'forward' | 'backward' | 'front' | 'back';

const RESTACK_LABELS: Readonly<Record<RestackDirection, string>> = {
  forward: 'Bring forward',
  backward: 'Send backward',
  front: 'Bring to front',
  back: 'Send to back',
};

function describeRestack(direction: RestackDirection, count: number): string {
  const label = RESTACK_LABELS[direction];
  return count > 1 ? `${label} ${count} objects` : label;
}

/**
 * Moves objects through the paint order, preserving their relative order.
 *
 * ## The rules, stated so they cannot be re-derived differently
 *
 * - Ids are taken **in current array order**, and that order is preserved. Paint order is
 *   meaningful, so a set's internal order is never scrambled: bringing five objects to the
 *   front puts them at the front in the order they were already stacked.
 * - `forward` moves each one position towards the end, processed **front to back**, so no two
 *   selected objects swap with each other. `backward` is the mirror.
 * - **An object does not move into a slot held by another selected object.** Front to back is
 *   not enough on its own: a selected object that is already at the end of the stack cannot
 *   move, and the one behind it would step straight over it and invert their order. So
 *   `forward` skips an object whose neighbour in front is also selected, and `backward` skips
 *   one whose neighbour behind is. The whole selected set keeps its relative order, always,
 *   and a consequence worth stating: with *every* object selected, "bring forward" and "send
 *   backward" are both no-ops, because nothing has an unselected neighbour to trade with.
 * - `front`/`back` remove the whole set and re-insert it at the end/start.
 * - Ids not on this page are **ignored**, not an error: a multi-page selection restacks per
 *   page and the caller batches.
 * - The original array is returned when nothing moves, so `isNoop` drops the command by
 *   reference identity. That is the whole no-op rule: "the topmost object cannot come further
 *   forward" is no change, not an undo step that does nothing.
 *
 * ## Why the processing order is load-bearing
 *
 * `out` is mutated as the loop goes, so each index must be read *after* the objects in front
 * of it have already moved. Processing the other way round makes two adjacent selected
 * objects trade places -- which looks like a bug, and is the most likely way to get this
 * wrong.
 */
function restackObjects(
  objects: Node[],
  ids: readonly string[],
  direction: RestackDirection,
): Node[] | readonly Node[] {
  if (ids.length === 0) return objects;

  const moving = new Set(ids);
  // Current array order, not command order: a selection has no order, the stack does.
  const indices = objects
    .map((node, index) => (moving.has(node.id) ? index : -1))
    .filter((index) => index >= 0);
  if (indices.length === 0) return objects;

  const out = [...objects];
  const last = out.length - 1;

  if (direction === 'front' || direction === 'back') {
    // `selected` is already in stack order, so the two directions differ only in which end
    // the block goes on.
    const selected = indices.map((index) => out[index] as Node);
    const rest = out.filter((node) => !moving.has(node.id));
    const moved = direction === 'front' ? [...rest, ...selected] : [...selected, ...rest];
    return sameOrder(moved, objects) ? objects : moved;
  }

  const step = direction === 'forward' ? 1 : -1;
  // The *ids* in stack order, reversed for a forward move.
  //
  // Reversed is load-bearing: an object must be visited only after everything between it and
  // its target has already moved, or two adjacent selected objects trade places.
  const stackOrder = indices.map((index) => objects[index]?.id).filter((id) => id !== undefined);
  const order = direction === 'forward' ? [...stackOrder].reverse() : stackOrder;

  for (const id of order) {
    // The position is re-read every time rather than taken from `indices`. A precomputed list
    // would in fact stay valid, because a step of one makes the remove and the insert adjacent
    // and no other element's index changes -- but that is an argument every reader then has
    // to reconstruct, and it stops being true the moment a step is ever larger than one.
    const index = out.findIndex((node) => node.id === id);
    if (index < 0) continue;
    const target = index + step;
    if (target < 0 || target > last) continue;

    // The neighbour that would be displaced must not itself be selected. See the rules above:
    // without this, an object steps over a selected neighbour that could not move, and the
    // set's relative order inverts -- which is the one thing this command promises never to do.
    const occupant = out[target];
    if (occupant !== undefined && moving.has(occupant.id)) continue;

    const [moved] = out.splice(index, 1);
    if (moved === undefined) continue;
    out.splice(target, 0, moved);
  }

  return sameOrder(out, objects) ? objects : out;
}

/**
 * Whether two arrays hold the same nodes in the same positions.
 *
 * Position, not set membership: the node objects are the same references either way, so
 * comparing them would say nothing. And identity of the *array* is what the caller needs --
 * returning a fresh but equal array is not a no-op, it is an undo step that does nothing,
 * which is exactly what the §4.2 rule exists to prevent.
 */
function sameOrder(candidate: readonly Node[], original: readonly Node[]): boolean {
  if (candidate.length !== original.length) return false;
  return candidate.every((node, index) => node === original[index]);
}

/**
 * Readable names for the top-level node properties a `setProps` payload can carry.
 *
 * Read by key, and a key with no entry falls back to "Change" rather than showing a raw
 * field name: the history menu is read by people, so `Undo stroke` is better than
 * `Undo Change` while `Undo stroke.paint` would be worse than either.
 *
 * Before this, every `setProps` command was labelled "Change" -- so every appearance-field
 * commit (fill colour, stroke width, corner radius) already read "Undo Change". M8 made
 * `setProps` the path for four more properties, which turned a cosmetic gap into a wrong
 * label on every commit a user can now make from the inspector.
 */
const PROP_LABELS: Readonly<Record<string, string>> = {
  name: 'Name',
  visible: 'Visible',
  locked: 'Locked',
  opacity: 'Opacity',
  blendMode: 'Blend mode',
  fill: 'Fill',
  stroke: 'Stroke',
  shape: 'Shape',
  extensions: 'Extensions',
};

function describeProps(command: {
  ids: readonly string[];
  props: Record<string, unknown>;
}): string {
  const keys = Object.keys(command.props);
  // More than one key is a compound edit, and naming it would mean guessing which part
  // mattered. `setProps` is a spread, so the keys *are* the properties -- and the
  // inspector's path-based payloads always reduce to exactly one.
  if (keys.length !== 1) return 'Change';
  const label = PROP_LABELS[keys[0] ?? ''];
  if (label === undefined) return 'Change';
  return command.ids.length > 1 ? `${label} ${command.ids.length} objects` : label;
}

/** Convenience for tools: patch the transform of one node. */
export function setTransform(
  nodeId: string,
  patch: TransformPatch,
): Command {
  return { type: 'setTransform', ids: [nodeId], patch };
}

/** Convenience: the shape of a node, if it is one. */
export function asShape(node: Node): ShapeNode | null {
  return node.type === 'shape' ? node : null;
}

/** Convenience: the transform of any node. */
export function transformOf(node: Node): Transform2D {
  return node.transform;
}