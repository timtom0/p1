/**
 * Creating graphical objects: the geometry, and nothing else.
 *
 * This module is the *only* place a shape's default geometry is decided, so creation
 * cannot disagree with the geometry contract (ADR 0005) or with hit testing.
 *
 * ## No snapping, deliberately
 *
 * Snapping needs the measurement boundary (§2.6) and the guide model (§3.6), neither of
 * which exists. Guessing at it here would put a second coordinate-conversion path in the
 * creation gesture. So a drag is taken exactly as drawn, and §3.6 owns the rest.
 *
 * ## No mutation path
 *
 * Everything here produces a `Command` and nothing else. Creation has no more access to
 * the document than the inspector does, which is what keeps "every change is undoable" a
 * property of the architecture rather than a habit.
 */

import { rectFromPoints } from '../core/geom/rect';
import type { Rect } from '../core/geom/rect';
import type { Vec2 } from '../core/geom/mat2d';
import type { Paint, ShapeKind, Stroke } from './types';
import { createShapeNode, createTransform } from './factory';
import type { ShapeNode } from './types';
import { shapeHasInterior, shapeNeedsExtent } from './shapes';

/**
 * Smallest object creation is allowed to produce, in document px.
 *
 * A rectangle smaller than this has nothing to click: a `0 × 0` object is not
 * hit-testable by the browser (measured) and, with the editor's own box predicate,
 * effectively not reachable by click either. So creation refuses to make one rather
 * than making something the user cannot then select (ADR 0005 §6).
 *
 * Not applied to a line's *height*, because a horizontal line legitimately has none.
 */
export const MIN_CREATED_EXTENT = 2;

/** Size used when a tool is clicked rather than dragged, in document px. */
export const DEFAULT_CREATED_EXTENT = 120;

/** The stroke a new line gets, because a line with no stroke is invisible. */
const DEFAULT_LINE_STROKE: Stroke = { paint: { type: 'solid', color: '#111111' }, width: 2, align: 'inside' };

/**
 * The stroke a new stroke-less object is given.
 *
 * Exported because the inspector needs it too: typing a weight into an object that has
 * no stroke has to produce *some* stroke, and if the inspector invented its own the same
 * "stroke" would mean two different things depending on how you drew the object.
 *
 * A fresh copy every call, so a caller cannot mutate the shared default.
 */
export function defaultStroke(): Stroke {
  return { ...DEFAULT_LINE_STROKE, paint: { ...DEFAULT_LINE_STROKE.paint } };
}

/** The fill a new shape gets, so a freshly drawn object is visible. */
const DEFAULT_FILL: Paint = { type: 'solid', color: '#4f7cff' };

/**
 * The rect a drag should produce, or `null` if the drag is not worth committing.
 *
 * Normalised, because a drag from bottom-right to top-left yields negative extents and
 * the model forbids them — CSS computes `width: -50px` to `0px` (measured), so a negative
 * box would silently become a zero-sized object. `rectFromPoints` is the same helper the
 * marquee uses, so there is one normalisation, not two.
 *
 * Returns `null` only for a click that did not move on a kind that needs an extent; a
 * click is otherwise a request for a default-sized object, which is what every editor
 * does and what makes the tool usable without a drag.
 */
export function creationRect(
  from: Vec2,
  to: Vec2,
  kind: ShapeKind,
  moved: boolean,
): Rect | null {
  if (moved) {
    const rect = rectFromPoints(from, to);
    // Every kind needs width — a line with no width is not a line. Only the kinds with an
    // interior need height, because a horizontal line legitimately has none.
    if (rect.width < MIN_CREATED_EXTENT) return null;
    if (shapeHasInterior(kind) && rect.height < MIN_CREATED_EXTENT) return null;
    return rect;
  }

  // A click. Only kinds that would otherwise be degenerate get a default size, and the
  // registry decides which those are rather than this module naming them.
  if (!shapeNeedsExtent(kind)) return null;
  return { x: from.x, y: from.y, width: DEFAULT_CREATED_EXTENT, height: DEFAULT_CREATED_EXTENT };
}

/**
 * Builds the node for a new shape.
 *
 * Defaults live here rather than in the gesture, so a rectangle created by dragging and
 * one created by any future route (paste, a menu item, a script) are identical.
 */
export function createShapeFor(
  kind: ShapeKind,
  rect: Rect,
  overrides: { fill?: Paint; stroke?: Stroke } = {},
): ShapeNode {
  // `transform` rather than loose x/y/width/height: `Transform2D` is one authored
  // value, and spreading a partial into it here would let creation invent defaults
  // that differ from the factory's.
  const node = createShapeNode(kind, {
    transform: {
      ...createTransform(),
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    },
  });

  const filled = shapeHasInterior(kind);
  const fill = overrides.fill ?? (filled ? DEFAULT_FILL : undefined);
  // A line with no stroke is invisible, so the stroke is not optional for a kind without
  // an interior — it is the only thing that paints.
  const stroke = overrides.stroke ?? (filled ? undefined : DEFAULT_LINE_STROKE);

  // Built by spread rather than by mutation so the result is a plain literal the command
  // funnel can clone, which is what `insert` does to every node it is handed.
  return { ...node, ...(fill === undefined ? {} : { fill }), ...(stroke === undefined ? {} : { stroke }) };
}

/**
 * Where a newly imported image goes.
 *
 * Centred on the point the user chose, at the asset's **intrinsic** size — which is why
 * this needs no measurement and no render pass. The size was read from the bytes at
 * import (`decode()`), so the model already knows it; ADR 0004's measurement contract has
 * nothing to contribute here.
 *
 * ## Why it is scaled down to fit, and why that is not "changing the image"
 *
 * An image is opaque, so one that hangs off the page edge is mostly invisible — and a
 * user who cannot see what they just inserted will assume the insert failed. So a larger
 * image is scaled **by a uniform factor**, which preserves the intrinsic ratio exactly.
 *
 * Uniform, rather than clamping width and height independently: independent clamping would
 * distort the image on the way in, which is a worse outcome than not fitting, and it would
 * make the placed size depend on the page's aspect in a way the user did not ask for.
 * An image that fits is placed at exactly its intrinsic size, so the common case has no
 * arithmetic at all.
 */
export function imagePlacementRect(
  intrinsic: { width: number; height: number },
  centre: Vec2,
  page: { width: number; height: number },
): Rect {
  // A page with no area cannot constrain anything; leave the image at its own size.
  if (!(page.width > 0) || !(page.height > 0)) {
    return { x: centre.x - intrinsic.width / 2, y: centre.y - intrinsic.height / 2, width: intrinsic.width, height: intrinsic.height };
  }

  const factor = Math.min(1, page.width / intrinsic.width, page.height / intrinsic.height);
  const width = intrinsic.width * factor;
  const height = intrinsic.height * factor;

  return {
    x: centre.x - width / 2,
    y: centre.y - height / 2,
    width,
    height,
  };
}

/**
 * Where a new object goes in the paint order.
 *
 * On top of everything already on the page: the thing a user just drew is the thing
 * they are looking at. Not "after the selected object" — that would put a new shape
 * *under* the one it was drawn over, which reads as the draw having failed.
 */
export function creationIndex(objectCount: number): number {
  return objectCount;
}
