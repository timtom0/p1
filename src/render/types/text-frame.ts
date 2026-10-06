/**
 * Renderer for `type: 'textFrame'`.
 *
 * Like the shape renderer, this is a projection: model → HTML/CSS. Text differs
 * from shapes in one respect that matters for ADR 0001's fence: **an element under
 * an active `contenteditable` session has children the renderer did not write.**
 *
 * The renderer therefore has a session-aware escape hatch. When a frame is being
 * edited, `update()` refuses to touch its content, because doing so would destroy
 * the caret mid-edit. That refusal is the fence, expressed in the one place that
 * owns the DOM.
 *
 * ```ts
 * interface RenderCtx {
 *   isTextEditing?(nodeId: string): boolean;   // queried, not pushed
 * }
 * ```
 *
 * ## What the browser does for us
 *
 * Typography is five CSS declarations. Line breaking, line boxes, baselines, kerning,
 * ligatures and justification internals are the browser's job and are deliberately
 * absent from the model (ADR 0003). This renderer projects the frame's `style` onto
 * the content element and lets the layout engine do the rest.
 */

import type { TextFrameNode, TextStyle } from '../../model/types';
import { localMatrix } from '../../model/transform';
import { richTextEqual } from '../../model/rich-text';
import { setStyle } from '../dom-style';
import { cssLength, cssMatrix, cssNumber } from '../num';
import { richTextToHtml } from '../rich-text-html';
import type { ObjectRenderer } from '../reconciler';

/** Class name of the writable content element inside a text frame. */
export const TEXT_CONTENT_CLASS = 'p1-text-content';

/**
 * CSS selector for that element.
 *
 * Kept separate from the class name because the two are used differently: the
 * renderer assigns the name, while callers (the edit session, tests) query by
 * selector. Conflating them produced a `class=".p1-text-content"` element that
 * matched nothing — the class attribute was set to the *selector*, dot included.
 */
export const TEXT_CONTENT_SELECTOR = `.${TEXT_CONTENT_CLASS}`;

export const textFrameRenderer: ObjectRenderer<TextFrameNode> = {
  type: 'textFrame',

  create(_ctx, _node): HTMLElement {
    const element = document.createElement('div');
    element.className = 'p1-object p1-text-frame';
    // `data-oid` and `data-type` are stamped by the reconciler, which owns object identity
    // (ADR 0009 §4). It used to be stamped here, and omitting it once left text frames
    // unaddressable from the DOM — `[data-oid="…"]` silently matched nothing, which broke the
    // test selectors and any future element lookup. One owner cannot be forgotten per type.
    return element;
  },

  update(element, node, prev, ctx): void {
    const { transform } = node;

    // Geometry: identical to shapes, and untouched by text editing.
    setStyle(element, 'left', cssLength(transform.x));
    setStyle(element, 'top', cssLength(transform.y));
    setStyle(element, 'width', cssLength(transform.width));
    setStyle(element, 'height', cssLength(transform.height));
    setStyle(element, 'transform', cssMatrix(localMatrix(transform)));
    setStyle(element, 'opacity', String(node.opacity));
    setStyle(element, 'mix-blend-mode', node.blendMode);
    setStyle(element, 'display', node.visible ? '' : 'none');

    const content = ensureContent(element);

    // Typography is *not* fenced. Changing the font size while a frame is being
    // edited is something the user can legitimately do, and CSS applying it does not
    // disturb the caret — only replacing the content would. So this is written on
    // every update, edited or not.
    applyTypography(content, node.style);

    // The fence. While this frame is being edited the browser owns its content, so
    // the renderer must not write into it — doing so would move the caret, collapse
    // the selection, or drop an IME's uncommitted text. It also skips when the
    // model is unchanged, which keeps ordinary re-renders free.
    //
    // The marker itself is set by `afterUpdate`, so that an early `return` above
    // cannot leave a stale one behind. `TextEditSession` also owns this attribute
    // while a session is live; both paths agree because they set the same value.
    if (ctx.isTextEditing?.(node.id) === true) return;

    const owned = content.dataset['p1Text'] === 'true';
    if (owned && prev !== undefined && richTextEqual(prev.text, node.text)) return;

    content.replaceChildren(richTextToHtml(node.text));
  },

  /**
   * Runs after `update`, so a renderer can fix up state an early `return` skipped.
   * Optional; omitted by renderers that have no such state.
   */
  afterUpdate(element, node, ctx): void {
    // The single owner of the "being edited" marker. Setting it here rather than in
    // `update` means every exit path — including the no-change fast path — leaves
    // the attribute consistent with `ctx.isTextEditing`.
    if (ctx.isTextEditing?.(node.id) === true) {
      element.dataset['editing'] = 'true';
    } else {
      delete element.dataset['editing'];
    }
  },
};

/** The writable content element, created on first render. */
export function contentOf(element: HTMLElement): HTMLElement | null {
  return element.querySelector<HTMLElement>(TEXT_CONTENT_SELECTOR);
}

function ensureContent(element: HTMLElement): HTMLElement {
  const existing = contentOf(element);
  if (existing !== null) return existing;

  const created = document.createElement('div');
  created.className = TEXT_CONTENT_CLASS;
  created.dataset['p1Text'] = 'true';
  element.append(created);
  return created;
}

/**
 * Projects `TextStyle` onto the content element.
 *
 * Every property is written unconditionally, including to "unset". A partial write
 * would leave a previous value in place, which is a bug that only shows up after the
 * user changes a property twice — so the alternative is worse than the extra writes.
 */
function applyTypography(content: HTMLElement, style: TextStyle | undefined): void {
  setStyle(content, 'font-family', style?.fontFamily ?? '');
  setStyle(content, 'font-size', style?.fontSize === undefined ? '' : cssLength(style.fontSize));
  // Unitless: a length here would stop meaning what it meant after a size change.
  setStyle(content, 'line-height', style?.lineHeight === undefined ? '' : cssNumber(style.lineHeight));
  // `em` so letter spacing scales with the size it belongs to.
  setStyle(
    content,
    'letter-spacing',
    style?.letterSpacing === undefined ? '' : `${cssNumber(style.letterSpacing)}em`,
  );
  setStyle(content, 'color', style?.color ?? '');
}