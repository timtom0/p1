/**
 * Model invariants (docs/ARCHITECTURE.md §1.6).
 *
 * `validateDocument` returns a list of human-readable problems rather than
 * throwing, so that both the dev overlay and a future deserializer can report
 * everything wrong at once instead of one failure per attempt.
 */

import type { Document, Node } from './types';
import { MAX_GROUP_DEPTH } from './tree';

export interface InvariantViolation {
  path: string;
  message: string;
}

/**
 * How close two scales must be before a group is considered non-uniform.
 *
 * Absolute, not relative, and that is a choice: a relative epsilon would make the rule depend on
 * the magnitude of the scale, so `0.001` on a scale of 1000 would pass where it fails at 1. The
 * numbers here are authored by a person typing into a field, so absolute is the honest granularity.
 */
export const UNIFORM_SCALE_EPSILON = 1e-9;

function checkNode(
  node: Node,
  path: string,
  seen: Set<string>,
  out: InvariantViolation[],
  depth: number,
  assets: Record<string, unknown> | null,
): void {
  if (seen.has(node.id)) {
    // One rule catches two things, and that is not a shortcut.
    //
    // A node that appears twice is a duplicate **id**. A node that appears twice because it is its
    // own ancestor is a **cycle**. The second necessarily contains the first: any cycle in a value
    // tree revisits a node, and revisiting a node means its id is in `seen`. So the traversal needs
    // no cycle detector, and — more importantly — it cannot loop, because this line returns before
    // recursing.
    //
    // The message says both because the *cause* is not recoverable from the value alone, and a
    // parser that only said "duplicate" would send an author looking for a copy they did not make.
    // A hand-built cyclic model is reachable from JavaScript even though JSON cannot express one,
    // so this path is not theoretical.
    out.push({ path, message: `duplicate or cyclic node id "${node.id}"` });
    return;
  }
  seen.add(node.id);

  const { transform } = node;
  if (!Number.isFinite(transform.x) || !Number.isFinite(transform.y)) {
    out.push({ path, message: 'transform position must be finite' });
  }
  if (!(transform.width >= 0) || !(transform.height >= 0)) {
    out.push({ path, message: `size must be non-negative (got ${transform.width}×${transform.height})` });
  }
  if (transform.scaleX === 0 || transform.scaleY === 0) {
    out.push({ path, message: 'scale of 0 makes the transform non-invertible' });
  }
  if (!Number.isFinite(transform.rotation)) {
    out.push({ path, message: 'rotation must be finite' });
  }

  // The asset reference, here rather than in a walk of its own. `Object.hasOwn`, never `in` and never
  // a truthiness test: an asset whose id is `toString` must not resolve against `Object.prototype`.
  // The path is the full path, so a group child reports
  // `pages[0].objects[2].children[1].children[0].asset` -- a check that cannot be located is a check
  // that cannot be acted on.
  if (node.type === 'image') {
    if (assets !== null && Object.hasOwn(assets, node.asset)) return;
    out.push({ path: `${path}.asset`, message: `no asset record for id "${node.asset}"` });
    return;
  }

  if (node.type !== 'group') return;

  // A group's scale must be uniform. This is the whole of ADR 0011's refusal expressed as a
  // validation rule, and it is checked *here* rather than in the type system because TypeScript
  // cannot express "two independent numbers that must agree" — a `Transform2D` with equal scales is
  // the only expressible form, so the invariant is a runtime fact about a value that can arrive
  // from a file, from a fixture, or from a future group-scale command.
  //
  // The message names the consequence rather than restating the rule, because "scaleX must equal
  // scaleY" leaves an author to work out why a value they think is valid is refused:
  //
  //   a non-uniform group scale on a rotated child is a shear, and shear is not
  //   representable in Transform2D (ADR 0011 §2). Use a uniform scale, or rotate the
  //   child instead of scaling the group.
  if (Math.abs(transform.scaleX - transform.scaleY) > UNIFORM_SCALE_EPSILON) {
    out.push({
      path: `${path}.transform`,
      message:
        `a group's scale must be uniform (scaleX ${transform.scaleX}, scaleY ${transform.scaleY}): ` +
        'a non-uniform group scale on a rotated child is a shear, which Transform2D cannot ' +
        'represent (ADR 0011 §2). Scale the child, or rotate the group.',
    });
  }

  // Nesting is permitted to arbitrary depth (ADR 0012 §4), so this is not a rule about *how many*
  // groups a document may have. It bounds reachability only: a hand-built cyclic model would
  // otherwise recurse until the stack gave out, and the duplicate-id rule above already rejects the
  // cycle before this fires — so reaching here at all means a genuinely deep document, and the
  // message says so rather than implying something is wrong with the depth.
  if (depth >= MAX_GROUP_DEPTH) {
    out.push({
      path,
      message: `group nesting exceeds the maximum depth of ${MAX_GROUP_DEPTH}`,
    });
    return;
  }

  node.children.forEach((child, childIndex) => {
    checkNode(child, `${path}.children[${childIndex}]`, seen, out, depth + 1, assets);
  });
}

export function validateDocument(doc: Document): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  const seen = new Set<string>();

  if (doc.pageSize.width <= 0 || doc.pageSize.height <= 0) {
    out.push({ path: 'pageSize', message: 'page size must be positive' });
  }

  // `assets` is required and has been since M6, but nothing checked it, so a document that
  // omitted it was indistinguishable from one with no assets. The cost was paid in M7, when
  // `documentsEqual` started reading the table on every pointer move and a missing key threw
  // a `TypeError` from inside `refreshChrome` -- breaking selection, undo and every visual
  // baseline, and reported as ten unrelated failures.
  //
  // Also checked: that every `ImageNode.asset` resolves. A dangling reference is not a
  // rendering state to be discovered later, it is a document that says something is there and
  // is not.
  //
  // This used to be a **second** traversal of its own, parallel to `checkNode`. M12 folded it into
  // `checkNode`, and that was not tidiness: the parallel walk had no cycle guard, so a cyclic model
  // overflowed the stack *inside the asset check* -- and `validateDocument` is precisely the
  // function everything else relies on to **refuse** such a model. The enforcement point had become
  // the thing that crashed on the thing it enforces against, which is worse than having no guard at
  // all, because it looked like one.
  //
  // One traversal, one guard, one path per node.
  const assets = doc.assets;
  if (assets === undefined || assets === null || typeof assets !== 'object') {
    out.push({ path: 'assets', message: 'the asset table is missing; it is required' });
  }
  const assetTable: Record<string, unknown> | null =
    assets === undefined || assets === null || typeof assets !== 'object' ? null : assets;

  if (doc.pages.length === 0) {
    out.push({ path: 'pages', message: 'document has no pages' });
  }

  const pageIds = new Set<string>();
  doc.pages.forEach((page, pageIndex) => {
    const pagePath = `pages[${pageIndex}]`;
    if (pageIds.has(page.id)) {
      out.push({ path: pagePath, message: `duplicate page id "${page.id}"` });
    }
    pageIds.add(page.id);

    page.objects.forEach((node, nodeIndex) => {
      checkNode(node, `${pagePath}.objects[${nodeIndex}]`, seen, out, 0, assetTable);
    });
  });

  return out;
}
