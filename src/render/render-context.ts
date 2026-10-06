/**
 * What a renderer is allowed to know about the world.
 *
 * Note what is *absent*: no zoom, no viewport rect, no selection, no pointer
 * position. Renderers project a node onto an element and nothing else, which is
 * why zooming costs exactly one `transform` write in the viewport and zero
 * re-renders (§2.2).
 */

import type { Document } from '../model/types';

export interface RenderCtx {
  readonly document: Document;

  /**
   * Is this node currently inside an active text-editing session?
   *
   * Queried rather than pushed, deliberately: the renderer stays a pure projection
   * of the model, and the *only* thing it learns is whether to withhold one
   * element's content. This is the fence described in §10.3 — while a text session
   * is active the browser owns that element's DOM, and the renderer must not fight
   * it. Outside a session this is absent and the renderer behaves normally.
   */
  isTextEditing?: (nodeId: string) => boolean;
}

export function createRenderContext(
  document: Document,
  extra: { isTextEditing?: (nodeId: string) => boolean } = {},
): RenderCtx {
  return { document, ...extra };
}