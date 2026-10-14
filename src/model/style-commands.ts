/**
 * M23: the style commands.
 *
 * ## One transaction per user action
 *
 * Every command here returns a **single** `Document`, and `deleteStyle` covers the definition *and*
 * every referencing object in one batched command. That is the user's requirement stated as
 * architecture: deleting a style that three hundred runs reference is one undo step, not a parade of
 * tiny mutations. There is deliberately no per-object deletion command, because there is no
 * per-object operation to perform -- `deleteStyle` finds its users itself.
 *
 * ## Remove and unlink are separate commands, not a flag
 *
 * This distinction is the one M23 is built around, and keeping them apart is the point:
 *
 *  - **Remove** clears the reference and keeps the object's own values. What the style was
 *    contributing falls back to the application's defaults. Nothing is copied anywhere; the document
 *    gets *smaller*.
 *  - **Unlink** resolves the style's contribution into the object's direct values first, then clears
 *    the reference. The appearance is preserved; the object gets *bigger*.
 *
 * Separate cases rather than one command with a `mode` field, because a boolean at a call site makes
 * the destructive reading the default-shaped one -- and these two have opposite consequences for the
 * user's text. A reviewer should see which one a button fires without following a flag.
 *
 * ## Nothing is materialised implicitly
 *
 * The only place a resolved value is ever written onto an object is inside an explicit unlink or an
 * unlink-mode deletion. Rendering and saving never do it, and neither does this file as a side effect
 * of anything else.
 */

import { createId } from '../core/ids';
import { CHAR_FLAGS, normalizeRichText } from './rich-text';
import {
  documentReferences,
  resolveStyle,
  effectiveCharFormat,
  effectiveParagraphProps,
  effectiveTextStyle,
  type StyleCategory,
} from './styles';
import type { Command } from './commands';
import type {
  CharFormat,
  Document,
  Node,
  ParagraphBlock,
  StyleDefinition,
  TextFrameNode,
} from './types';

/** What a removal should do to the objects that referenced the style. */
export type StyleRemovalMode = 'remove' | 'unlink';

/** A new id for a style, from the same factory as every other object so `resetIds` covers it. */
export function newStyleId(): string {
  return createId('style');
}

/** Appends a definition. A duplicate id is a no-op rather than an error, matching every other command. */
export function addStyle(doc: Document, style: StyleDefinition): Document {
  if (doc.styles.some((existing) => existing.id === style.id)) return doc;
  return { ...doc, styles: [...doc.styles, style] };
}

/**
 * Replaces one definition, by id.
 *
 * Replaces rather than merges, because a category change (`paragraph` to `frame`) has to be
 * expressible and merging would leave the old payload's keys behind for the parser to refuse. A
 * missing id is a no-op, so a command aimed at a style deleted a moment ago records no history.
 */
export function replaceStyle(doc: Document, id: string, next: StyleDefinition): Document {
  if (!doc.styles.some((style) => style.id === id)) return doc;
  return { ...doc, styles: doc.styles.map((style) => (style.id === id ? next : style)) };
}

/**
 * Renames a definition. The id -- which is what every reference points at -- is untouched.
 *
 * Compared on the name alone: a rename that produced a new object for an unchanged name would make
 * every keystroke in a name field a history entry, which is the defect the no-op guards on the
 * property commands exist to prevent.
 */
export function renameStyle(doc: Document, id: string, name: string): Document {
  const target = doc.styles.find((style) => style.id === id);
  if (target === undefined || name.trim() === '') return doc;
  if (target.name === name) return doc;
  return {
    ...doc,
    styles: doc.styles.map((style) => (style.id === id ? { ...style, name } : style)),
  };
}

/**
 * Deletes a definition and settles every reference to it, as **one** command.
 *
 * The mode is carried into the single inner command rather than expanded into one command per user.
 * That is what makes "one coherent undo step" true by construction rather than by a caller
 * remembering to batch: there is no list for a caller to get wrong or truncate.
 *
 * Refusing a delete that would leave a reference is not an option -- the operation settles every
 * reference it finds, or does nothing at all.
 */
export function deleteStyleCommand(id: string, mode: StyleRemovalMode): Command {
  return {
    type: 'batch',
    label: mode === 'remove' ? 'Delete style' : 'Unlink style and delete',
    cmds: [{ type: 'deleteStyle', id, mode }],
  };
}

/**
 * The one real command behind {@link deleteStyleCommand}.
 *
 * Undo restores the definition **and** every reference exactly, because the whole operation is a
 * single command over the whole document: the previous `Document` *is* the before-state and carries
 * both. Nothing is reconstructed or re-derived, which is what makes a later edit on top of the undone
 * state behave the same as one made before the deletion ever happened.
 */
export function applyDeleteStyle(doc: Document, id: string, mode: StyleRemovalMode): Document {
  if (!doc.styles.some((style) => style.id === id)) return doc;

  const withoutDefinition: Document = {
    ...doc,
    styles: doc.styles.filter((style) => style.id !== id),
  };

  const targets = new Set(
    documentReferences(doc)
      .filter((reference) => reference.styleId === id)
      .map((reference) => reference.nodeId),
  );
  if (targets.size === 0) return withoutDefinition;

  return {
    ...withoutDefinition,
    pages: withoutDefinition.pages.map((page) => ({
      ...page,
      objects: page.objects.map((node) =>
        targets.has(node.id) ? rewriteNode(node, id, mode, doc.styles) : node,
      ),
    })),
  };
}

/** Rewrites one node's references to `id`, leaving every other reference alone. */
function rewriteNode(
  node: Node,
  id: string,
  mode: StyleRemovalMode,
  styles: readonly StyleDefinition[],
): Node {
  if (node.type === 'group') {
    const children = node.children.map((child) =>
      // Only descend where the style is actually used. A group with no styled descendant comes back
      // by identity, so the renderer's reference-equality skip still fires for the untouched parts.
      subtreeReferencesStyle(child, id, styles)
        ? rewriteNode(child, id, mode, styles)
        : child,
    );
    return children.some((child, index) => child !== node.children[index]) ? { ...node, children } : node;
  }

  if (node.type !== 'textFrame') return node;
  const touches = frameReferencesStyle(node, id);
  if (!touches) return node;

  const next: TextFrameNode = { ...node };

  if (node.styleId === id) {
    next.styleId = undefined;
    // `unlink` writes the resolved typography down before the reference goes, so the frame looks the
    // same afterwards. `remove` leaves `style` exactly as it was -- untouched is the whole promise.
    if (mode === 'unlink') next.style = effectiveTextStyle(node, styles);
  }

  next.text = normalizeRichText(rewriteText(node, styles, id, mode));
  return next;
}

function rewriteText(
  node: TextFrameNode,
  styles: readonly StyleDefinition[],
  id: string,
  mode: StyleRemovalMode,
): { blocks: ParagraphBlock[] } {
  return {
    blocks: node.text.blocks.map((block) => {
      const nextBlock: ParagraphBlock =
        block.styleId === id ? unlinkParagraph(block, styles, mode) : block;
      return {
        ...nextBlock,
        runs: nextBlock.runs.map((run) =>
          run.styleId === id ? unlinkRun(run, styles, mode) : run,
        ),
      };
    }),
  };
}

/**
 * `remove` drops the reference and nothing else.
 *
 * Written as a fresh object rather than `{ ...block, styleId: undefined }` so the surviving keys are
 * visible: the block's own alignment, direction and metrics are what the user still has, and the
 * whole claim of `remove` is that they are left exactly as they were.
 */
/**
 * Drops `styleId` without materialising anything.
 *
 * `Remove` has to remove the reference and nothing else, and the two ways to spell that are both
 * bad here: a rest-destructure needs a throwaway binding the linter rightly objects to, and
 * `delete` on a typed optional is a mutation the type system cannot see. This says what it does in
 * one line and has exactly one call shape to get wrong.
 */
function dropStyleId<T extends { styleId?: string }>(value: T): T {
  const next: T = { ...value };
  delete next.styleId;
  return next;
}

function unlinkParagraph(
  block: ParagraphBlock,
  styles: readonly StyleDefinition[],
  mode: StyleRemovalMode,
): ParagraphBlock {
  if (mode === 'remove') return dropStyleId(block);

  // Unlink: the style's share is resolved in and written down. Properties the block already overrode
  // are not flattened -- `effectiveParagraphProps` resolves each one to the overriding value, so
  // writing the result back preserves the override *as a direct value*, which is what the user had.
  const resolved = effectiveParagraphProps(styles, block);
  const next: ParagraphBlock = { ...block, styleId: undefined };
  if (resolved.align !== undefined) next.align = resolved.align;
  if (resolved.dir !== undefined) next.dir = resolved.dir;
  if (resolved.metrics !== undefined) next.metrics = resolved.metrics;
  return next;
}

function unlinkRun(
  run: ParagraphBlock['runs'][number],
  styles: readonly StyleDefinition[],
  mode: StyleRemovalMode,
): ParagraphBlock['runs'][number] {
  if (mode === 'remove') return dropStyleId(run);

  // A character style's flags are `true`-only and additive, so the resolved format is the union and
  // writing it down is the whole of unlink here. Emitted in canonical flag order so two equal runs
  // serialise equally.
  const resolved = effectiveCharFormat(styles, run) ?? {};
  const format: CharFormat = {};
  for (const flag of CHAR_FLAGS) {
    if (resolved[flag] === true) format[flag] = true;
  }
  return {
    text: run.text,
    ...(Object.keys(format).length > 0 ? { format } : {}),
  };
}

/** Whether anything inside this frame references `id` anywhere -- frame, paragraph or run. */
function frameReferencesStyle(node: TextFrameNode, id: string): boolean {
  if (node.styleId === id) return true;
  return node.text.blocks.some(
    (block) =>
      block.styleId === id || block.runs.some((run) => run.styleId === id),
  );
}

/**
 * Whether a subtree references `id`, used to avoid rebuilding groups that cannot have changed.
 *
 * `styles` is passed rather than looked up, so a node's resolution never depends on which traversal
 * happened to reach it.
 */
function subtreeReferencesStyle(node: Node, id: string, styles: readonly StyleDefinition[]): boolean {
  if (node.type === 'group') return node.children.some((child) => subtreeReferencesStyle(child, id, styles));
  return node.type === 'textFrame' && frameReferencesStyle(node, id);
}

/** Re-exported so `commands.ts` gets the one reducer it needs without reaching into `styles.ts`. */
export { effectiveCharFormat as resolveCharacterStyle };
/**
 * M23: **selection-level** unlink. Distinct from `applyDeleteStyle`, which is document-wide.
 *
 * ## Why this is a separate function and not a `deleteStyle` with a scope
 *
 * Because the two have different reach and different blast radius, and conflating them is exactly
 * the mistake the milestone warns about. `deleteStyle` settles **every** reference in the document
 * because it removes the definition, and a dangling reference is the one outcome neither operation
 * permits. Unlinking a style from the selection touches **only the selected objects**, and leaves the
 * definition and every other user exactly as they were -- including other objects that reference the
 * same style.
 *
 * "Only the selection" is the whole contract here. An unlink that swept up every user of a style
 * would change objects the user did not select and never asked about, which is why the two are not
 * one command with a flag.
 */
export function applyUnlinkStyle(
  doc: Document,
  ids: readonly string[],
  category: StyleCategory,
  styleId: string,
): Document {
  // Nothing to do unless the style exists and the category matches, so a shortcut aimed at a style
  // that was deleted a moment ago is inert rather than an error.
  if (resolveStyle(doc.styles, styleId, category) === undefined) return doc;
  if (ids.length === 0) return doc;

  return mapSelectedNodes(doc, ids, (node: Node) => {
    if (node.type !== 'textFrame') return node;
    const next = unlinkNode(node, doc.styles, styleId, category, 'unlink');
    return next === node ? node : { ...next, text: normalizeRichText(next.text) };
  });
}

/**
 * Unlinks `styleId` from one frame's site for `category`, leaving every other reference alone.
 *
 * A frame that does not reference the style is returned by identity, so the renderer's
 * reference-equality skip still fires for the untouched majority of a multi-selection.
 */
function unlinkNode(
  node: TextFrameNode,
  styles: readonly StyleDefinition[],
  styleId: string,
  category: StyleCategory,
  mode: StyleRemovalMode,
): TextFrameNode {
  if (category === 'frame') {
    if (node.styleId !== styleId) return node;
    // `mode` is threaded rather than assumed. An earlier version hardcoded `unlink` here, which made
    // the selection-level **Remove** action behave exactly like Unlink -- the one distinction this
    // milestone exists to keep, failing in the direction that silently *preserves* formatting the
    // user asked to lose.
    return mode === 'unlink'
      ? { ...node, style: effectiveTextStyle(node, styles), styleId: undefined }
      : { ...node, styleId: undefined };
  }

  const blocks = node.text.blocks.map((block) => {
    const nextBlock =
      category === 'paragraph' && block.styleId === styleId
        ? unlinkParagraph(block, styles, mode)
        : block;
    if (category !== 'character') return nextBlock;

    const runs = nextBlock.runs.map((run) =>
      run.styleId === styleId ? unlinkRun(run, styles, mode) : run,
    );
    return runs.some((run, index) => run !== nextBlock.runs[index])
      ? { ...nextBlock, runs }
      : nextBlock;
  });

  return blocks.some((block, index) => block !== node.text.blocks[index])
    ? { ...node, text: { blocks } }
    : node;
}

/**
 * M23: **selection-level** remove -- the same semantics as `applyStyle` with a null id, named for the
 * place the UI reaches it from.
 *
 * Kept as a function rather than only as the null form of `applyStyle` because the confirmation
 * dialog has to be able to ask "how many of the selection actually reference this style?" before the
 * user commits to the destructive reading, and that question needs one place to be asked.
 *
 * Returns how many objects it actually changed, so the caller can tell the user what happened rather
 * than guessing -- a shortcut pressed with nothing selected should say so, not claim success.
 */
export function applyRemoveStyle(
  doc: Document,
  ids: readonly string[],
  category: StyleCategory,
  styleId: string,
): { doc: Document; changed: number } {
  if (resolveStyle(doc.styles, styleId, category) === undefined) return { doc, changed: 0 };
  if (ids.length === 0) return { doc, changed: 0 };

  let changed = 0;
  const next = mapSelectedNodes(doc, ids, (node: Node) => {
    if (node.type !== 'textFrame') return node;
    const updated = unlinkNode(node, doc.styles, styleId, category, 'remove');
    if (updated === node) return node;
    changed += 1;
    return { ...updated, text: normalizeRichText(updated.text) };
  });

  return { doc: changed === 0 ? doc : next, changed };
}

/**
 * How many of `ids` reference `styleId` at the given site.
 *
 * For the confirmation dialog, which must be able to say "this affects 3 of your 5 selected objects"
 * rather than implying the whole selection is involved. Counting *references* rather than objects,
 * because a frame whose three paragraphs all reference the style is one object and three references,
 * and the user is choosing per object.
 */
export function countStyleUsers(
  doc: Document,
  ids: readonly string[],
  styleId: string,
): number {
  return documentReferences(doc).filter(
    (reference) => reference.styleId === styleId && ids.includes(reference.nodeId),
  ).length;
}
/**
 * Applies `visit` to the selected nodes, descending into groups.
 *
 * Written here rather than imported because `commands.ts`' `mapNodesById` is deliberately not
 * exported -- it is an implementation detail of that switch statement, and a second copy of it
 * drifting from the first would be a class of bug this file has no reason to take on. A style action
 * that silently skipped a styled object *inside a group* would be exactly that.
 *
 * Nodes are returned by identity when `visit` returns them unchanged, so an untouched page or group
 * costs nothing and the renderer's reference-equality skip still fires.
 */
function mapSelectedNodes(
  doc: Document,
  ids: readonly string[],
  visit: (node: Node) => Node,
): Document {
  const wanted = new Set(ids);

  const walk = (nodes: readonly Node[]): Node[] => {
    let changed = false;
    const next = nodes.map((node) => {
      if (node.type === 'group') {
        const children = walk(node.children);
        if (children.every((child, index) => child === node.children[index])) return node;
        changed = true;
        return { ...node, children };
      }
      if (!wanted.has(node.id)) return node;
      const updated = visit(node);
      if (updated !== node) changed = true;
      return updated;
    });
    return changed ? next : (nodes as Node[]);
  };

  let anyPage = false;
  const pages = doc.pages.map((page) => {
    const objects = walk(page.objects);
    if (objects.every((node, index) => node === page.objects[index])) return page;
    anyPage = true;
    return { ...page, objects };
  });

  return anyPage ? { ...doc, pages } : doc;
}
