/**
 * The shape-kind registry.
 *
 * One table, keyed by `shape.kind`, holding everything about a shape that is *pure
 * geometry about the model*: how to hit-test it, and which inspector properties it
 * contributes. Both answers are needed by three different layers — `render/` needs to
 * project it, `editor/` needs to hit-test it, `ui/` needs to describe it — so the table
 * lives in `model/`, which all three may import and which is forbidden from touching the
 * DOM (ADR 0005).
 *
 * Rendering is deliberately **not** here. A projection is inherently presentational, and
 * putting it in `model/` would make this file need `HTMLElement`. Instead
 * `render/types/shape.ts` holds a `Record<ShapeKind, Projector>`, which TypeScript
 * keeps exhaustive: adding a kind is a compile error until its projector exists.
 *
 * ## The rule this replaces
 *
 * `BaseNode.type` says it is "the discriminator for the object-type registry. Never
 * compared with `===` outside `render/`" — and `editor/selection.ts` did exactly that,
 * with a chain that would have grown by one branch per shape kind. The registry is how
 * that stops happening.
 *
 * @module
 */

import type { ShapeGeometry, ShapeKind, ShapeNode, Stroke } from './types';
import type { Vec2 } from '../core/geom/mat2d';

/** The node's own layout box in its local, unrotated space: always `(0, 0, w, h)`. */
export interface LayoutBox {
  readonly width: number;
  readonly height: number;
}

/** How the inspector should present a property. Data only — no DOM, no callbacks. */
export type PropertyKind = 'length' | 'colour' | 'boolean' | 'angle';

export interface PropertySpec {
  /**
   * Dotted path into the node, e.g. `fill.color` or `stroke.width`.
   *
   * A path rather than a getter/setter pair so the inspector can stay generic: it walks
   * the path to read a shared value across the selection and to build the patch. A
   * callback would have to be invoked for every selected node and would move the
   * multi-select logic into every kind.
   */
  readonly path: string;
  readonly label: string;
  readonly kind: PropertyKind;
}

export interface ShapeKindSpec {
  readonly kind: ShapeKind;
  /** Name used in the inspector and in history labels. */
  readonly label: string;
  /**
   * Hit test in the node's local box space.
   *
   * `node` is passed as well as the box because a line's tolerance is its stroke width —
   * the one visual property with a geometric effect (ADR 0005 §1).
   */
  readonly containsPoint: (local: Vec2, box: LayoutBox, node: ShapeNode) => boolean;
  /** Inspector properties this kind contributes, beyond the shared visual ones. */
  readonly properties: readonly PropertySpec[];
  /**
   * Whether a `0 × 0` object of this kind is worth creating.
   *
   * A rectangle with no extent has nothing to click and cannot be selected; a line with
   * no width cannot exist. So creation applies a default size for the former and not the
   * latter (ADR 0005 §6).
   */
  readonly needsExtent: boolean;
  /**
   * Whether the kind paints an interior, as opposed to being nothing but its stroke.
   *
   * A model fact, not a rendering one, and it was nearly filed under `render/` — where
   * the layer rule caught it. Creation needs it (a line with no stroke is invisible) and
   * so does the renderer (no background, no border on a line), and both may read `model/`.
   */
  readonly hasInterior: boolean;
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/** A point in the box. Exactly what the browser does for a `border-box` div. */
function containsBoxPoint(local: Vec2, box: LayoutBox): boolean {
  return local.x >= 0 && local.y >= 0 && local.x <= box.width && local.y <= box.height;
}

/**
 * The ellipse inscribed in the box, as a unit-circle test in normalised coordinates.
 *
 * Dividing by the half-extents rather than testing `(x-w/2)² + (y-h/2)² ≤ r²` keeps the
 * degenerate case honest: a zero width or height makes the ellipse flat, and only the
 * normalised form reports that correctly instead of dividing by zero.
 *
 * Measured to agree with Chromium's own hit test for `border-radius: 50%` on a 21×21
 * grid, to within edge antialiasing — 430 of 441 samples exact, the 11 exceptions all on
 * the boundary. So this is a real cross-check, not an assumption.
 */
function containsEllipsePoint(local: Vec2, box: LayoutBox): boolean {
  if (box.width <= 0 || box.height <= 0) return containsBoxPoint(local, box);
  const nx = (local.x / box.width - 0.5) * 2;
  const ny = (local.y / box.height - 0.5) * 2;
  return nx * nx + ny * ny <= 1;
}

/** Distance from `p` to the segment `a`–`b`. Zero-length segments fall back to `a`. */
function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y);

  // Projection of `p - a` onto the segment, clamped to [0, 1].
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * A line, tested by distance to its segment within half the stroke width.
 *
 * This is the one shape whose editor hit region **deliberately disagrees with the
 * browser's**, and the disagreement is the point: Chromium cannot hit-test a zero-height
 * box at all (measured — every layout and hit API returns nothing), so a horizontal line
 * would be ungrabbable. Distance-to-segment is both the only answer and the one users
 * expect: you click *on* a line to select it.
 *
 * With no stroke the tolerance falls back to a nominal sliver, so a bare line is still
 * reachable rather than being exactly zero-width and therefore unclickable.
 */
function containsLinePoint(local: Vec2, box: LayoutBox, node: ShapeNode): boolean {
  const tolerance = Math.max(lineTolerance(node.stroke), MIN_LINE_TOLERANCE / 2);
  const distance = distanceToSegment(local, { x: 0, y: 0 }, { x: box.width, y: box.height });
  return distance <= tolerance;
}

/** Minimum grabbable half-width for a line, in document px. */
const MIN_LINE_TOLERANCE = 4;

function lineTolerance(stroke: Stroke | undefined): number {
  return stroke === undefined ? 0 : stroke.width / 2;
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

const SPECS: Record<ShapeKind, ShapeKindSpec> = {
  rect: {
    kind: 'rect',
    label: 'Rectangle',
    containsPoint: containsBoxPoint,
    // Corner radius is rect-only in the *model* too, so declaring it here is a
    // restatement rather than a special case. If a kind gains a property it appears
    // here and the inspector grows a field with no other edit.
    properties: [{ path: 'shape.cornerRadius', label: 'Corner', kind: 'length' }],
    needsExtent: true,
    hasInterior: true,
  },

  ellipse: {
    kind: 'ellipse',
    label: 'Ellipse',
    containsPoint: containsEllipsePoint,
    properties: [],
    needsExtent: true,
    hasInterior: true,
  },

  line: {
    kind: 'line',
    label: 'Line',
    containsPoint: containsLinePoint,
    properties: [],
    // A line with no width is not a line, and there is nothing to click. A line with
    // no *height* is a perfectly good horizontal line, which is why this is about
    // width rather than about being degenerate in general.
    needsExtent: false,
    hasInterior: false,
  },
};

export function shapeSpec(kind: ShapeKind): ShapeKindSpec {
  return SPECS[kind];
}

/** Every registered kind, for the creation toolbar and for tests. */
export function shapeKinds(): readonly ShapeKind[] {
  return Object.keys(SPECS) as ShapeKind[];
}

/** Human name for a kind, for history labels and the inspector. */
export function shapeLabel(kind: ShapeKind): string {
  return SPECS[kind].label;
}

/**
 * Whether a local point is inside a shape.
 *
 * The one entry point hit testing uses, so no caller has to know that `line` needs a
 * stroke width and the others do not.
 */
export function shapeContainsPoint(
  node: ShapeNode,
  local: Vec2,
  box: LayoutBox,
): boolean {
  return SPECS[node.shape.kind].containsPoint(local, box, node);
}

/** Every shape's local box, so callers never assemble `{ width, height }` by hand. */
export function layoutBoxOf(node: ShapeNode): LayoutBox {
  return { width: node.transform.width, height: node.transform.height };
}

/**
 * Whether a kind paints an interior, rather than being nothing but its stroke.
 *
 * Read by creation (a line with no stroke is invisible) and by the renderer (no
 * background and no border on a line). It was briefly filed in `render/`, which the
 * layer rule rejected — correctly, since it is a fact about the kind, not about pixels.
 */
export function shapeHasInterior(kind: ShapeKind): boolean {
  return SPECS[kind].hasInterior;
}

/** Whether creation should give a click that did not move a default extent. */
export function shapeNeedsExtent(kind: ShapeKind): boolean {
  return SPECS[kind].needsExtent;
}

/** Type guard, for narrowing `node.shape` before reading a kind-specific field. */
export function isGeometry<K extends ShapeKind>(
  geometry: ShapeGeometry,
  kind: K,
): geometry is Extract<ShapeGeometry, { kind: K }> {
  return geometry.kind === kind;
}
