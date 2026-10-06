/**
 * The overlay: selection affordances, drawn in **screen space** (§3.8).
 *
 * Deliberately *not* inside the zoomed page stack. That is what keeps strokes
 * exactly 1px and handles a constant size at any zoom, at the cost of one `× zoom`
 * at write time — which is exactly what the conversions below are for.
 *
 * Owns no state beyond a reference to the viewport and the page element it draws
 * into. It is redrawn from whatever it is given; there is no incremental update and
 * no diffing, because the amount of chrome is small and fixed.
 */

import { applyPoint, identity } from '../../core/geom/mat2d';
import type { Mat2D, Vec2 } from '../../core/geom/mat2d';
import type { Rect } from '../../core/geom/rect';
import { rectBottom, rectLeft, rectRight, rectTop } from '../../core/geom/rect';
import { cssMatrix } from '../../render/num';

export interface OverlayElements {
  /** The overlay layer, sized to the viewport and untransformed. */
  layer: HTMLElement;
  /** The scroll container, for scrollbar-aware sizing. */
  viewport: HTMLElement;
}

export interface OverlayMetrics {
  /**
   * How a page-local document point maps to a **client** point.
   *
   * The zoom is applied *here*, once, and nowhere else: every rectangle and every matrix in this
   * file is derived from it. An earlier draft of the F6 fix also asked for `zoom` and composed it
   * into the outline's matrix, which scaled the outline twice and looked correct at 100%.
   */
  toClient(pageId: string, point: Vec2): Vec2;
}

/** Handle positions, in the object's own local space. */
export const HANDLE_DIRECTIONS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
export type HandleDirection = (typeof HANDLE_DIRECTIONS)[number];

const HANDLE_UNIT: Record<HandleDirection, Vec2> = {
  nw: { x: 0, y: 0 },
  n: { x: 0.5, y: 0 },
  ne: { x: 1, y: 0 },
  e: { x: 1, y: 0.5 },
  se: { x: 1, y: 1 },
  s: { x: 0.5, y: 1 },
  sw: { x: 0, y: 1 },
  w: { x: 0, y: 0.5 },
};

/** Cursor for each handle, by corner/edge. */
const HANDLE_CURSOR: Record<HandleDirection, string> = {
  nw: 'nwse-resize',
  n: 'ns-resize',
  ne: 'nesw-resize',
  e: 'ew-resize',
  se: 'nwse-resize',
  s: 'ns-resize',
  sw: 'nesw-resize',
  w: 'ew-resize',
};

export interface SelectionOutline {
  /** The object this outline belongs to. Absent for the hover and marquee outlines. */
  nodeId?: string;
  /**
   * The object's **model frame** in page-local document coordinates: `{x, y, width, height}` off the
   * transform, untransformed.
   *
   * This is what the box is *laid out* at. It is not what the user sees — see {@link matrix}.
   */
  rect: Rect;
  /**
   * The node's linear part in page space (`localMatrix`), or the identity for a marquee and a
   * create preview.
   *
   * ## Why the chrome carries a matrix at all
   *
   * Before M11 the overlay drew `left/top/width/height` and nothing else, so a rotated object was
   * framed by an **unrotated** rectangle at its model position: a 140×100 box around an object that
   * paints 171.2 × 156.6, with its eight handles pointing at empty space (ADR 0011 §8 F6).
   *
   * The fix is not to compute four corners and emit a polygon. It is to write **the node's own
   * matrix onto the outline** — the same `matrix(...)` the renderer already writes onto the object,
   * with the same `transform-origin: 50% 50%`, so the outline *is* the object's frame by
   * construction. One projection, used twice, and the two cannot drift apart because there is only
   * one function that formats a matrix.
   */
  matrix: Mat2D;
  pageId: string;
}

export interface MarqueeRect {
  /** Live marquee in page-local document coordinates. */
  rect: Rect;
  pageId: string;
}

export interface SnapLine {
  axis: 'x' | 'y';
  /** Position in page-local document coordinates. */
  position: number;
  pageId: string;
  /** Extent along the other axis, so the line is drawn to fit its context. */
  from: number;
  to: number;
}

export interface OverlayInput {
  outlines: readonly SelectionOutline[];
  marquee: MarqueeRect | null;
  snapLines: readonly SnapLine[];
  /** Rotation handle, in page-local coordinates. */
  rotationHandle: { pageId: string; point: Vec2 } | null;
  hover: SelectionOutline | null;
}

export class Overlay {
  /**
   * Layer-local origin, refreshed once per `render`.
   *
   * The metrics hand back *client* coordinates; chrome is positioned in
   * *layer-local* ones. Converting here rather than in each caller means the
   * subtraction happens once per frame instead of once per handle, and there is one
   * place to look when a handle lands in the wrong spot.
   */
  private origin: Vec2 = { x: 0, y: 0 };

  constructor(
    private readonly elements: OverlayElements,
    private readonly metrics: OverlayMetrics,
  ) {}

  /** Sizes the layer to the scroll viewport and redraws. */
  render(input: OverlayInput): void {
    const { layer, viewport } = this.elements;
    layer.style.width = `${viewport.clientWidth}px`;
    layer.style.height = `${viewport.clientHeight}px`;

    const box = layer.getBoundingClientRect();
    this.origin = { x: box.left, y: box.top };

    layer.replaceChildren();

    if (input.hover !== null) {
      layer.append(this.outline(input.hover, 'hover'));
    }
    for (const outline of input.outlines) {
      layer.append(this.outline(outline, 'selection'));
    }
    for (const line of input.snapLines) {
      layer.append(this.snapLine(line));
    }
    if (input.marquee !== null) {
      // A marquee and a create preview are axis-aligned by construction, so they get the identity
      // matrix and are drawn exactly as before. Stated rather than special-cased: `MarqueeRect` is
      // not an `SelectionOutline`, so the conversion is explicit and lives in one place.
      layer.append(
        this.outline(
          { ...input.marquee, matrix: identity() },
          'marquee',
        ),
      );
    }
    if (input.rotationHandle !== null) {
      layer.append(this.rotationHandle(input.rotationHandle));
    }
  }

  clear(): void {
    this.elements.layer.replaceChildren();
  }

  /** Layer-local point for a page-local document point. */
  private toLayer(pageId: string, point: Vec2): Vec2 {
    const client = this.metrics.toClient(pageId, point);
    return { x: client.x - this.origin.x, y: client.y - this.origin.y };
  }

  /**
   * Client → layer.
   *
   * Needed because pointer events arrive in client space while every rectangle in
   * here is layer-local. Without this conversion a handle's hit area is offset by the
   * distance between the window origin and the surface origin — which at a non-zero
   * toolbar height means handles are drawn in one place and grabbed in another.
   */
  clientToLayer(client: Vec2): Vec2 {
    return { x: client.x - this.origin.x, y: client.y - this.origin.y };
  }

  /**
   * Layer-local rectangle for a page-local selection rect.
   *
   * The **model frame** in layer coordinates: still axis-aligned, because `rect` is the untransformed
   * local box. The rotation lives in {@link SelectionOutline.matrix} and is applied by the box's own
   * `transform`, so this rect is where the frame is *laid out*, not where it ends up.
   *
   * Public because the editor hit-tests handles against layer coordinates, and it must be the *same*
   * rectangle the chrome was drawn from — a second, slightly different computation is how handles
   * and hit areas drift apart.
   */
  toClientRect(outline: SelectionOutline): Rect {
    const topLeft = this.toLayer(outline.pageId, {
      x: rectLeft(outline.rect),
      y: rectTop(outline.rect),
    });
    const bottomRight = this.toLayer(outline.pageId, {
      x: rectRight(outline.rect),
      y: rectBottom(outline.rect),
    });
    return {
      x: topLeft.x,
      y: topLeft.y,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
    };
  }

  /**
   * A point on the frame, in **page** coordinates.
   *
   * `local` is measured in the node's own box space — `(0, 0)` is the model's top-left, and
   * coordinates outside it are fine, which is how the rotation grip gets a point above the top
   * edge. The rotation about the box centre means the origin is *not* the identity: the matrix acts
   * about `(width/2, height/2)`, so the local origin has to be shifted before the matrix and the
   * frame's page position added after.
   *
   * Public because the rotation grip is a point on the frame too, and it must be placed by the same
   * arithmetic that places the outline -- otherwise the grip drifts away from the shape it rotates,
   * which is the bug this milestone exists to remove.
   */
  framePoint(outline: SelectionOutline, local: Vec2): Vec2 {
    const { width, height } = outline.rect;
    const rotated = applyPoint(outline.matrix, {
      x: local.x - width / 2,
      y: local.y - height / 2,
    });
    return {
      x: rotated.x + outline.rect.x + width / 2,
      y: rotated.y + outline.rect.y + height / 2,
    };
  }

  /**
   * Where one resize handle sits, in layer coordinates, **on the transformed frame**.
   *
   * ## The single source of truth
   *
   * Both the chrome and the editor's hit test call this. That is the whole point: before M11 each
   * side computed `rect.x + rect.width * unit.x` from the model frame, so they agreed with each other
   * and both were wrong about where the object was. Sharing one function means a future change to
   * handle placement cannot fix the drawing and leave the hit area behind -- the failure mode this
   * file's header already warns about for `toClientRect`.
   */
  handlePoint(outline: SelectionOutline, direction: HandleDirection): Vec2 {
    const unit = HANDLE_UNIT[direction];
    // Local corner -> page space through the node's own matrix -> layer space. `toLayer` applies
    // the zoom and the page offset, so this needs no separate zoom handling.
    return this.toLayer(
      outline.pageId,
      this.framePoint(outline, {
        x: outline.rect.width * unit.x,
        y: outline.rect.height * unit.y,
      }),
    );
  }

  /** The rotation grip's point, in page coordinates, `gap` document px beyond the frame's top edge. */
  rotationGripPoint(outline: SelectionOutline, gap: number): Vec2 {
    return this.framePoint(outline, { x: outline.rect.width / 2, y: -gap });
  }

  /**
   * The matrix to write onto the outline: **the node's own matrix, unchanged.**
   *
   * ## The zoom is already in the layout, and must not be applied twice
   *
   * `toClientRect` lays the box out at `width · zoom`, because `toLayer` maps a page point through
   * the zoomed stack. So the box is already zoom-sized, and `transform` only has to supply the
   * object's own rotation and scale about the box's centre.
   *
   * Composing `scale(zoom)` in here as well — which the first draft of this fix did, on the
   * reasonable-sounding grounds that the overlay is outside the zoom transform — scales the outline
   * by the zoom *twice*. At 100% that is invisible, which is why every other test passed; it only
   * shows at any other zoom level, where the outline stops matching the object. The zoom test in
   * `tests/editor/selection-frame.spec.ts` is what caught it, and it is why that test exists.
   */
  private layerMatrix(outline: SelectionOutline): Mat2D {
    return outline.matrix;
  }

  private outline(outline: SelectionOutline, kind: 'selection' | 'hover' | 'marquee'): HTMLElement {
    const rect = this.toClientRect(outline);
    const group = document.createElement('div');
    group.className = `p1-overlay-group p1-overlay-group--${kind}`;
    group.dataset['kind'] = kind;
    // The owning object's id, so the outline can be traced back to the model without
    // reverse-engineering its screen-space position. `data-for`, never `data-oid` -- see ADR 0008
    // §13.1 for why two elements must never answer to one identifier.
    if (outline.nodeId !== undefined) group.dataset['for'] = outline.nodeId;

    const box = document.createElement('div');
    box.className = `p1-overlay-box p1-overlay-box--${kind}`;
    box.style.left = `${rect.x}px`;
    box.style.top = `${rect.y}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;

    // The F6 fix. The box is laid out at the model frame and then *rotated and scaled by the node's
    // own matrix*, so what the user sees outlined is the object. `transform-origin: 50% 50%` matches
    // the renderer exactly, and the renderer rotates about the box centre for the same reason -- so
    // the outline and the object share a centre, not merely a size.
    //
    // Written unconditionally rather than only when the node is rotated: a transform of `none` and
    // the identity matrix are the same picture, and branching would leave the unrotated path untested
    // for the rotated one. It costs one style write.
    box.style.transformOrigin = '50% 50%';
    box.style.transform = cssMatrix(this.layerMatrix(outline));

    group.append(box);

    if (kind !== 'selection') return group;

    // Handles are positioned from {@link handlePoint} -- the transformed corners -- rather than from
    // the frame rect, and they stay children of the (untransformed) group so their coordinates are
    // layer coordinates like everything else's. They do not need a transform of their own: a handle
    // is a square, and rotation would not change its appearance, only its position -- which is
    // already the transformed one.
    for (const direction of HANDLE_DIRECTIONS) {
      const handle = document.createElement('div');
      handle.className = 'p1-overlay-handle';
      handle.dataset['handle'] = direction;
      const point = this.handlePoint(outline, direction);
      handle.style.left = `${point.x}px`;
      handle.style.top = `${point.y}px`;
      handle.style.cursor = HANDLE_CURSOR[direction];
      group.append(handle);
    }

    return group;
  }

  private snapLine(line: SnapLine): HTMLElement {
    const element = document.createElement('div');
    element.className = 'p1-overlay-snap';
    if (line.axis === 'x') {
      const a = this.toLayer(line.pageId, { x: line.position, y: line.from });
      const b = this.toLayer(line.pageId, { x: line.position, y: line.to });
      element.classList.add('p1-overlay-snap--v');
      element.style.left = `${a.x}px`;
      element.style.top = `${Math.min(a.y, b.y)}px`;
      element.style.height = `${Math.abs(b.y - a.y)}px`;
    } else {
      const a = this.toLayer(line.pageId, { x: line.from, y: line.position });
      const b = this.toLayer(line.pageId, { x: line.to, y: line.position });
      element.classList.add('p1-overlay-snap--h');
      element.style.top = `${a.y}px`;
      element.style.left = `${Math.min(a.x, b.x)}px`;
      element.style.width = `${Math.abs(b.x - a.x)}px`;
    }
    return element;
  }

  private rotationHandle(input: { pageId: string; point: Vec2 }): HTMLElement {
    const client = this.toLayer(input.pageId, input.point);
    const element = document.createElement('div');
    element.className = 'p1-overlay-rotate';
    element.dataset['handle'] = 'rotate';
    element.style.left = `${client.x}px`;
    element.style.top = `${client.y}px`;
    element.style.cursor = 'grab';
    return element;
  }
}

export { HANDLE_CURSOR };