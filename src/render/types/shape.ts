/**
 * Renderer for `type: 'shape'`.
 *
 * Everything visual is CSS, with exactly one measured exception: `line`, which needs a
 * scoped SVG `<line>` because CSS cannot stroke a zero-height box (ADR 0005, measured —
 * `border` grows the box downward, `outline` paints nothing at all).
 *
 * ## What this function's job is
 *
 * Translate a model node into declarations. There is no geometry math beyond formatting:
 * the browser lays the element out.
 *
 *   transform.x/y/width/height -> `left`/`top`/`width`/`height`
 *   rotation + scale           -> `transform: matrix(...)`, `transform-origin: 50% 50%`
 *   fill                       -> `background-color`
 *   stroke (inside)            -> `border-*`
 *   opacity / blendMode        -> `opacity` / `mix-blend-mode`
 *
 * ## Why the projections are a `Record` and not a switch
 *
 * `Record<ShapeKind, Projector>` is compile-time exhaustive. Adding a kind to the union
 * is a type error here until its projector exists, which is the guarantee a `switch`
 * gives — without the growing chain of `if (kind === ...)` that the shape registry
 * exists to prevent.
 *
 * The projections deliberately live in `render/`, not in the registry in `model/shapes.ts`:
 * they need `HTMLElement`, and `model/` may not touch the DOM.
 */

import type { ShapeKind, ShapeNode } from '../../model/types';
import { shapeHasInterior } from '../../model/shapes';
import { localMatrix } from '../../model/transform';
import { setStyle } from '../dom-style';
import { cssLength, cssMatrix } from '../num';
import { applyStroke, paintToCss } from '../paint';
import type { RenderCtx } from '../render-context';
import type { ObjectRenderer } from '../reconciler';

/** Class name for the SVG island a `line` renders into. */
const LINE_SVG = 'p1-shape-svg';

/**
 * Applies one kind's CSS, given the element the geometry already occupies.
 *
 * Geometry (position, size, transform) is written once by the renderer and is identical
 * for every kind — the box is the box whether it holds a rectangle, an ellipse or a
 * line. Only the *decoration of that box* differs.
 */
type Projector = (element: HTMLElement, node: ShapeNode) => void;

const PROJECTORS: Record<ShapeKind, Projector> = {
  rect(element, node) {
    const geometry = node.shape;
    if (geometry.kind !== 'rect') return; // unreachable: keyed by kind
    setStyle(element, 'border-radius', cssLength(geometry.cornerRadius));
  },

  ellipse(element) {
    // `50%` of both axes is the inscribed ellipse, and Chromium hit-tests it as one
    // (measured: agrees with the unit-circle test on 430 of 441 grid samples, the rest
    // all on the boundary). So no SVG is needed here.
    setStyle(element, 'border-radius', '50%');
  },

  line(element) {
    // A line has no interior, so it gets no background and no border-radius: the
    // stroke *is* the shape, and `paintLine` draws it into the SVG island.
    setStyle(element, 'border-radius', '0px');
    setStyle(element, 'background-color', 'transparent');
  },
};

export const shapeRenderer: ObjectRenderer<ShapeNode> = {
  type: 'shape',

  create(_ctx: RenderCtx, node: ShapeNode): HTMLElement {
    const element = document.createElement('div');
    element.className = 'p1-object';
    // `data-oid` and `data-type` are stamped by the reconciler, which owns object identity
    // (§2.3, ADR 0009 §4). Setting them here would be a second owner for one attribute, and
    // this file was already the third *spelling* of the same two lines.

    // The island is built once and thereafter only its attributes change. §2.3's
    // reconciler invariant allows this explicitly: an object element's auxiliary
    // children live *inside* it, and `reconcileInto` never touches a leaf's children.
    if (node.shape.kind === 'line') element.append(createLineSvg());
    return element;
  },

  update(element, node, prev, _ctx): void {
    const { transform } = node;

    // Geometry. `left`/`top` place the untransformed box in the parent's space,
    // which for a top-level node is page-local document space.
    setStyle(element, 'left', cssLength(transform.x));
    setStyle(element, 'top', cssLength(transform.y));
    setStyle(element, 'width', cssLength(transform.width));
    setStyle(element, 'height', cssLength(transform.height));

    // Orientation about the box centre. See `model/transform.ts` for why this
    // composes exactly like `transform-origin: 50% 50%`.
    setStyle(element, 'transform', cssMatrix(localMatrix(transform)));

    PROJECTORS[node.shape.kind](element, node);

    // Fill. Shared by the kinds that have an interior; a line is painted by its stroke
    // alone, and its projector has already cleared the background.
    if (shapeHasInterior(node.shape.kind)) {
      setStyle(element, 'background-color', paintToCss(node.fill));
    }

    // Stroke. Also shared — except for a line, whose stroke is drawn into the SVG island
    // because CSS cannot centre one on a zero-height box (ADR 0005, measured). Kept here
    // rather than inside each projector so "stroke is a shared visual property" stays
    // true in the code and not just in the documentation.
    if (shapeHasInterior(node.shape.kind)) applyStroke(element, node.stroke);
    else paintLine(element, node);

    // Compositing and visibility.
    setStyle(element, 'opacity', String(node.opacity));
    setStyle(element, 'mix-blend-mode', node.blendMode);
    setStyle(element, 'display', node.visible ? '' : 'none');

    // `prev` is part of the signature every renderer accepts; this one has no
    // early-return fast path to invalidate, so it is genuinely unused.
    void prev;
  },
};

function createLineSvg(): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add(LINE_SVG);
  svg.setAttribute('overflow', 'visible');
  svg.setAttribute('preserveAspectRatio', 'none');
  // The island's own viewport box is not a target. Chromium hit-tests an `<svg>` element
  // against its rectangular viewport, which for a zero-height line is a 1px-tall strip
  // corresponding to nothing drawn -- measured: without this, a *stroke-less* line
  // reported as a hit where a stroked one did not, purely because of the
  // `Math.max(height, 1)` below.
  svg.setAttribute('pointer-events', 'none');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  // pointer-events is an *inherited* SVG property, so setting none on the root would
  // silence the stroke as well - measured, and the reason this line does not keep its
  // inherited value. "stroke" rather than "visiblePainted": hit the stroke, hit nothing
  // else, which is exactly the shape's extent. Real ink stays pickable, unpainted area
  // is not, and a stroke-less line has no target at all.
  line.setAttribute('pointer-events', 'stroke');
  svg.append(line);
  return svg;
}

/**
 * Projects a line's stroke onto its SVG island.
 *
 * The `<svg>` is stretched to the model box and the `<line>` is drawn corner to
 * corner, so the *model box stays exactly the box*: measured `offsetHeight` is 0 for a
 * zero-height line with this approach, where a CSS border made it 4. The stroke then
 * straddles the segment because SVG strokes are centred on the path, which is the one
 * behaviour CSS could not provide.
 *
 * `vector-effect="non-scaling-stroke"` is deliberately **not** used. A transformed
 * object should scale its stroke along with its shape, matching the CSS `border` that
 * `rect` and `ellipse` use; pinning the stroke would make the two disagree.
 */
function paintLine(element: HTMLElement, node: ShapeNode): void {
  const svg = element.querySelector<SVGElement>(`.${LINE_SVG}`);
  if (svg === null) return;
  const line = svg.firstElementChild;
  if (line === null) return;

  const { width, height } = node.transform;
  // A zero-extent `<svg>` would collapse the drawing viewport, so it is given one
  // device pixel and `overflow: visible` lets the stroke outside it.
  setAttribute(svg, 'width', `${Math.max(width, 1)}`);
  setAttribute(svg, 'height', `${Math.max(height, 1)}`);
  setStyle(svg as unknown as HTMLElement, 'display', 'block');

  setAttribute(line, 'x1', '0');
  setAttribute(line, 'y1', '0');
  setAttribute(line, 'x2', String(width));
  setAttribute(line, 'y2', String(height));

  const stroke = node.stroke;
  if (stroke === undefined) {
    setAttribute(line, 'stroke', 'none');
    setAttribute(line, 'stroke-width', '0');
    return;
  }
  if (stroke.align !== 'inside') {
    // See ADR 0005 §2: `inside` is the only supported alignment, and the reason it is
    // worth refusing rather than approximating is that an inside stroke is what makes
    // selection geometry equal to the model box.
    throw new Error(`Stroke alignment "${stroke.align}" is not supported (only "inside")`);
  }
  setAttribute(line, 'stroke', paintToCss(stroke.paint));
  setAttribute(line, 'stroke-width', String(stroke.width));
  // `butt` is the SVG default and is also the honest one: a line's ends are its
  // endpoints, and a cap would extend the stroke past them.
  setAttribute(line, 'stroke-linecap', 'butt');
}

/**
 * Writes an SVG attribute, skipping redundant assignments.
 *
 * The style cache in `dom-style` cannot be used: SVG geometry is attributes, not CSS.
 * Spelling that out rather than assigning inline keeps the same "write only what
 * changed" property the reconciler relies on.
 */
function setAttribute(element: Element, name: string, value: string): void {
  if (element.getAttribute(name) === value) return;
  element.setAttribute(name, value);
}


