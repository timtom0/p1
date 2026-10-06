/**
 * Model paint → CSS.
 *
 * This is the whole of the "CSS decides how pixels look, JS decides what they
 * mean" boundary for fills and strokes: the model says `solid #4f7cff`, CSS
 * says `background-color`.
 */

import type { Paint, Stroke } from '../model/types';
import { setStyle } from './dom-style';
import { cssLength } from './num';

/** Returns a CSS colour, or `transparent` for an absent paint. */
export function paintToCss(paint: Paint | undefined): string {
  if (paint === undefined) return 'transparent';
  switch (paint.type) {
    case 'solid':
      return paint.color;
    default: {
      const exhaustive: never = paint.type;
      throw new Error(`Unsupported paint type: ${String(exhaustive)}`);
    }
  }
}

/**
 * Apply a stroke to an element's border.
 *
 * M0 supports `align: 'inside'` only. CSS borders are drawn inside the border
 * box, so combined with `box-sizing: border-box` in the stylesheet the stroke
 * grows inward from the model's declared width/height — exactly the geometry
 * `inside` calls for. `center` and `outside` are deferred to the appearance
 * milestone (M4), which the architecture notes need `outline` or an SVG island.
 */
export function applyStroke(element: HTMLElement, stroke: Stroke | undefined): void {
  if (stroke === undefined) {
    setStyle(element, 'border-width', '0px');
    setStyle(element, 'border-style', 'none');
    return;
  }
  if (stroke.align !== 'inside') {
    throw new Error(
      `Stroke alignment "${stroke.align}" is not implemented in M0 (only "inside")`,
    );
  }
  setStyle(element, 'border-width', cssLength(stroke.width));
  setStyle(element, 'border-style', 'solid');
  setStyle(element, 'border-color', paintToCss(stroke.paint));
}