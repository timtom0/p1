/**
 * Document model types.
 *
 * Per docs/ARCHITECTURE.md §0 the model is plain data: no DOM types may appear
 * in this file or anywhere under `src/model`. `src/render` projects these values
 * into HTML/CSS; the DOM is disposable.
 */

import type { PhysicalUnit } from '../core/units/units';

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * The unrotated, unscaled layout box plus an orientation about its centre.
 * `x`/`y` are relative to the *parent's* space, not the page's.
 *
 * The derived world matrix is T(x+w/2, y+h/2) · R(rotation) · S(scaleX,scaleY)
 * · T(-w/2, -h/2), which matches CSS `transform-origin: 50% 50%`. It is never
 * stored — see `model/transform.ts`.
 */
export interface Transform2D {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Radians. */
  rotation: number;
  scaleX: number;
  scaleY: number;
}

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

/** Solid fill only in M0; gradients arrive with the appearance milestone. */
export interface SolidPaint {
  type: 'solid';
  /** Any CSS colour string, e.g. `#4f7cff`, `rgba(0,0,0,.5)`, `rebeccapurple`. */
  color: string;
}

export type Paint = SolidPaint;

/**
 * Stroke alignment. M0 renders `inside` via `border` (with `box-sizing:
 * border-box`); `center` and `outside` are not yet implemented.
 */
export type StrokeAlign = 'center' | 'inside' | 'outside';

export interface Stroke {
  paint: Paint;
  width: number;
  align: StrokeAlign;
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export interface BaseNode {
  id: string;
  /** Discriminator for the object-type registry. Never compared with `===` outside `render/`. */
  type: string;
  name: string;
  transform: Transform2D;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blendMode: BlendMode;
  /** Escape hatch for data this build does not understand; preserved verbatim. */
  extensions?: Record<string, unknown>;
}

/**
 * Object types are added to this union as they are implemented, each with a
 * matching entry in the object-type registry.
 */
export interface ShapeNode extends BaseNode {
  type: 'shape';
  shape: ShapeGeometry;
  fill?: Paint;
  stroke?: Stroke;
}

/**
 * The graphical kinds M5 implements.
 *
 * Kept short on purpose. Each addition is a geometry predicate, a CSS projection and
 * an inspector contribution — see `model/shapes.ts` for the registry, and ADR 0005 for
 * why `polygon`/`star`/`path` are *absent* rather than present as empty fields.
 */
export type ShapeKind = 'rect' | 'ellipse' | 'line';

/**
 * Shape-specific geometry, as a discriminated union.
 *
 * ## Why a union and not optional fields
 *
 * The previous sketch was `{ kind; points?; closed?; cornerRadius? }` — every field
 * optional, so `{ kind: 'line', cornerRadius: 8 }` type-checked and meant nothing. A
 * union makes "corner radius exists only on a rect" a *type* fact rather than a runtime
 * check, and it means adding a kind cannot silently accept fields the renderer ignores.
 *
 * ## What the box means
 *
 * `transform.x/y/width/height` is the **border box**, in page-local document px. For a
 * rect and an ellipse it bounds the shape; for a line it is the box whose diagonal from
 * local `(0,0)` to `(width, height)` is the segment, so a horizontal line has height 0.
 *
 * A stroke does **not** expand it: `align: 'inside'` draws inward, and
 * `offsetWidth/Height` equals the model box exactly. Measured — see ADR 0005.
 */
export type ShapeGeometry =
  | { kind: 'rect'; cornerRadius: number }
  | { kind: 'ellipse' }
  | { kind: 'line' };

// ---------------------------------------------------------------------------
// Text
//
// Designed in ADR 0003. The governing rule for every property below:
//
//   If the user authored it, it is in the model. If changing it changes pixels
//   without the user authoring it, it belongs to CSS.
//
// So the model holds paragraphs, alignment, four character-formatting flags and
// frame typography — and holds no line breaks from wrapping, no glyph positions, and
// no measured widths. That last exclusion is why auto-size is deferred: a fitted box
// height needs measurement, which no amount of model data can supply.
// ---------------------------------------------------------------------------

/**
 * Character formatting.
 *
 * Every flag is `true` or **absent**. `false` is deliberately not representable, so
 * "not bold" has exactly one encoding. Two encodings of the same visual text would
 * make history comparison and diffing churn on documents that render identically.
 */
export interface CharFormat {
  bold?: true;
  italic?: true;
  underline?: true;
  strike?: true;
}

/**
 * A run of text sharing one format.
 *
 * Adjacent runs with equal formats are merged, so the model is in canonical form and
 * every visual text has exactly one run-sequence. See `normalizeRichText`.
 */
export interface InlineRun {
  /**
   * The characters. May contain `\n`, which is a **soft break** — a line break
   * inside the paragraph, produced by Shift+Enter and rendered by
   * `white-space: pre-wrap`.
   *
   * All whitespace is significant. A paragraph boundary is a separate block, never a
   * character.
   */
  text: string;
  /** Omitted entirely when unformatted, not `{}`. */
  format?: CharFormat;
}

/** Paragraph alignment. Omitted means "the CSS default", which is also `left`. */
export type ParagraphAlign = 'left' | 'center' | 'right' | 'justify';

/**
 * One paragraph: one `<p>` in the DOM, one entry in `RichText.blocks`.
 *
 * `kind` is a discriminator even though only `paragraph` exists. §1.5's publishing
 * scope includes headings and lists, and keeping it means adding one is additive
 * rather than a refactor of every `block.runs` site. Consumers must **throw** on an
 * unrecognised kind rather than skipping it — silently rendering an empty frame is
 * worse than refusing.
 */
export interface ParagraphBlock {
  kind: 'paragraph';
  align?: ParagraphAlign;
  runs: InlineRun[];
}

export type TextBlock = ParagraphBlock;

/**
 * A frame's text content.
 *
 * Invariant: `blocks.length >= 1`. An empty frame is one paragraph with one run of
 * `''`, never an empty list — the caret needs somewhere to live and `Enter` needs
 * somewhere to go, and "is empty" then stays a helper rather than a branch every
 * reader has to write.
 */
export interface RichText {
  blocks: TextBlock[];
}

/**
 * Frame-level typography.
 *
 * Every field is optional, and "absent" means "unset" — the renderer emits nothing
 * and CSS decides. That keeps the model sparse for the common case and makes the
 * document format forward-compatible with properties this build does not understand.
 *
 * Relative units on purpose: `lineHeight: 1.2` and `letterSpacing` in em survive a
 * font-size change, whereas `19.2px` and `0.32px` silently stop meaning what they
 * meant. Every design tool does this, and it is the difference between a usable
 * property and a trap.
 */
export interface TextStyle {
  /** A CSS font stack, e.g. `'Georgia', serif`. */
  fontFamily?: string;
  /** Document px — the internal unit (§1.1). */
  fontSize?: number;
  /** Unitless multiplier: `1.2` = 120%. */
  lineHeight?: number;
  /** In em, so it scales with font size. Absent means CSS `normal`. */
  letterSpacing?: number;
  /** Any CSS colour string. */
  color?: string;
}

/**
 * A text frame.
 *
 * Note what is absent versus §1.5's sketch, and why — each is a decision recorded in
 * ADR 0003, not an oversight:
 *
 *  - no `verticalAlign` — needs a flex container on the frame, which moves the
 *    content element's box and therefore the caret's coordinate space. That puts the
 *    fence back under test for a non-load-bearing feature. Needs its own spike.
 *  - no `padding` — box model, not typography; arrives with frame geometry.
 *  - no `columns` — needs measurement.
 *  - no `autoSize` — needs measurement; the model cannot derive it.
 *  - no linked frames — no story yet for resolving the link graph.
 */
export interface TextFrameNode extends BaseNode {
  type: 'textFrame';
  text: RichText;
  /** Omitted means the document default, which CSS supplies. */
  style?: TextStyle;
}

/**
 * A group: a transform and an ordered list of child nodes, in the group's local space.
 *
 * ## Group-local children (ADR 0012)
 *
 * A child of a group is positioned in **group-local** coordinates. A group's transform maps
 * group-local into its parent space; a child's transform maps its own local box into group-local
 * space. So the world matrix of a child is
 *
 * ```
 * W(child) = W(ancestors) · W(group) · W(child)
 * ```
 *
 * which is ordinary matrix composition and needs no special case anywhere — which is why this is
 * the representation M10b's [ADR 0010](0010-groups-and-the-transform-question.md) §2 chose over
 * page-local children, where a group's transform is not part of the coordinate chain at all and
 * every consumer must be taught about it separately.
 *
 * ## What `transform` means here
 *
 * Exactly what it means for every other node, and unchanged: `Transform2D` maps the node's local
 * box into its parent's space, and rotation is about the **centre of that box**.
 *
 * `width`/`height` are therefore the size of the group's *local coordinate space* — the frame its
 * rotation happens about — and they are **authored, not derived**. They are not fitted to the
 * children, because a group's extent is a consequence of its members and a member's extent is a
 * consequence of its geometry; making the parent a function of the children makes the authored
 * document depend on layout, and `Transform2D` would no longer mean what §1.3 says it means. A
 * group's frame is what it says it is, and fitting it is a *tool*, not a property.
 *
 * That also means a group is permitted to be visually larger or smaller than its members. Nothing
 * is wrong with that, and there is no invariant that says otherwise.
 *
 * ## Why the scale must be uniform
 *
 * `Transform2D` has independent `scaleX`/`scaleY`, and this node does **not** add a separate
 * uniform-scale field — one representation, with the constraint expressed as an invariant
 * (`scaleX === scaleY`) rather than as a second place for the same number.
 *
 * A *non-uniform* group scale on a rotated child is a shear, and shear is not representable without
 * extending the transform to a general affine. That was proved, specified, and refused in
 * [ADR 0011](0011-affine-transform-decision.md) — see its §2, where the composed matrix is
 * `-σxg σyg σxc σyc · sin(θc)`, non-zero for almost every (group, child) pair. The refusal is not
 * revisited here; this node is the shape of the compromise, and `scaleX === scaleY` is what the
 * compromise costs.
 *
 * `src/model/group-scale.test.ts` pins the positive case and the refused case together, so a later
 * change that widens `Transform2D` cannot quietly make groups capable of shear.
 */
export interface GroupNode extends BaseNode {
  type: 'group';
  /**
   * Children in **paint order**.
   *
   * By value, never by id. That is what makes the ownership invariant enforceable: a node has
   * exactly one parent because it lives in exactly one array, and a node cannot be in two groups
   * because it would have to be in two arrays. An id-reference model would need a separate
   * uniqueness check to achieve what a value tree gets for free.
   */
  children: Node[];
}

export type Node = ShapeNode | TextFrameNode | ImageNode | GroupNode;

// ---------------------------------------------------------------------------
// Assets and images
//
// Designed in ADR 0006. Two rules carry the whole contract:
//
//  1. **Identity is an id, never a URL.** `ImageNode.asset` is an `AssetId` that means
//     the same thing in a fresh tab, in an undo, and in a serialized file. A blob URL
//     may be a runtime projection; it may never be an asset's identity.
//  2. **Bytes and identity are separate.** The model holds the bytes (so the document is
//     self-contained) and the intrinsic size (so placing an image needs no browser
//     round-trip). Neither is derived from layout.
// ---------------------------------------------------------------------------

/**
 * A stable asset identity.
 *
 * Opaque by construction: nothing may parse it, infer anything from its shape, or
 * reconstruct it from bytes. It is a name, and that is the whole contract.
 */
export type AssetId = string;

/**
 * How an asset's bytes are carried.
 *
 * `inline` is the only implemented variant, and it is the one that matters first: a
 * document that only renders online is not a document, so every asset must be able to
 * carry its own bytes. `external` exists so that a project-folder format can be added
 * later **additively** -- a union arm, not a redesign.
 *
 * Both are strings, which is what keeps a future serializer free of decisions.
 */
export type AssetData =
  | { readonly inline: string }
  | { readonly external: string };

export interface AssetRecord {
  readonly kind: 'image';
  readonly mime: string;
  /**
   * Intrinsic size in px, read **once at import** via `decode()`.
   *
   * Never `0`. Measured: `decode()` *rejects* with an `EncodingError` on data that is not
   * a decodable image, so a file that cannot be decoded never becomes an asset at all --
   * which is what keeps "a failed image" from being representable as a valid asset with
   * size `0x0`.
   *
   * Asset metadata, **not** measurement. It describes the bytes, not the layout, so ADR
   * 0004's measurement contract has nothing to contribute here.
   */
  readonly intrinsicWidth: number;
  readonly intrinsicHeight: number;
  readonly data: AssetData;
}

/**
 * How an image fills its authored box.
 *
 * Authored, because it is user intent with a visible effect and no other representation:
 * `fill` stretches to the box, `contain` and `cover` letterbox or crop within it. It is
 * *not* geometry -- measured, every value leaves `offsetWidth/Height` and the hit region
 * unchanged (ADR 0006 PROBE X) -- so it does not belong in `transform`.
 *
 * `object-position` is deliberately **absent**: under the default `fill` it has no
 * observable effect, so it would be a property with no authored meaning. It arrives with
 * cropping.
 */
export type ImageFit = 'fill' | 'contain' | 'cover' | 'none' | 'scale-down';

export interface ImageNode extends BaseNode {
  type: 'image';
  /**
   * The asset's identity. Never a URL, never a `File`, never a `Blob` -- see the module
   * comment. An `Image` carries none of those because they are not comparable by value,
   * which is what `isNoop` and `History` both depend on.
   */
  asset: AssetId;
  /** Omitted means `fill`, which is both CSS's default and the publishing convention. */
  fit?: ImageFit;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export type Orientation = 'portrait' | 'landscape';

/** Authored in a physical unit so that "A4" survives a round trip and printing is exact. */
export interface PageSize {
  width: number;
  height: number;
  unit: PhysicalUnit;
  orientation: Orientation;
}

export interface Page {
  id: string;
  name: string;
  background: Paint;
  /** Order is paint order: index 0 paints first (furthest back). */
  objects: Node[];
}

export interface Document {
  /** Bumped only when the on-disk shape changes; see `persist/` (M8). */
  formatVersion: number;
  id: string;
  name: string;
  pageSize: PageSize;
  /**
   * Every asset this document owns, by id.
   *
   * Part of the model -- and therefore part of history -- because that is what lets undo
   * restore a deleted image *together with its bytes*. A separate side store would make
   * undo restore a reference to nothing.
   *
   * Orphans are not collected; see ADR 0006's named gap.
   */
  assets: Record<AssetId, AssetRecord>;
  /**
   * M0 renders the first page. Multi-page stacking, guides and grid arrive with their
   * respective milestones; resources moved onto the document above in M6.
   */
  pages: Page[];
}