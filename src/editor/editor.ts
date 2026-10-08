/**
 * `Editor` — the M2 interaction coordinator.
 *
 * Owns exactly three things that do not belong to the document: **selection
 * state**, **mode**, and the **in-flight gesture**. Every document change it makes
 * goes through `DocStore`, which is what makes every change undoable by
 * construction rather than by discipline.
 *
 * ## Coordinate discipline
 *
 * One rule, because breaking it is the classic editor bug: pointers arrive in
 * *client* space, gestures are computed in *page-local document* space, and the
 * model stores *page-local document* space. The viewport owns both conversions.
 * Nothing here divides by zoom or reads a scroll offset — that is exactly what
 * `Viewport` exists to prevent.
 *
 * ## Grab priority
 *
 * Pointer-down tests in a fixed order: rotation handle, resize handles, object
 * body, then background. Order matters — a resize grab near a corner would
 * otherwise be stolen by the move gesture behind it. Handles are tested against the
 * *screen-space* overlay rather than the model, which keeps the grab target a
 * constant size at any zoom.
 *
 * ## Gesture → history
 *
 * A drag dispatches one command per pointer move. Opening a transaction on
 * pointer-down and closing it on pointer-up folds those into a single undo entry,
 * so one drag is one undo. Every close is in a `finally`, because a lost pointerup
 * would otherwise leave history permanently open and silently merge every later
 * action into one entry.
 */

import { identity } from '../core/geom/mat2d';
import { unionRects } from '../core/geom/rect';
import type { Vec2 } from '../core/geom/mat2d';
import type { Document, GroupNode, ImageNode, Node as ModelNode, ShapeKind, Transform2D } from '../model/types';
import { createAssetFrom, hasAsset, orphanAssetIds } from '../model/assets';
import type { AssetState } from '../model/assets';
import { deriveAssetState } from '../render/types/image';
import {
  arrangementDeltas,
  arrangeTargets,
  describeArrange,
  translatedTransform,
  type ArrangeOperation,
} from '../model/arrange';
import { createId } from '../core/ids';
import { createTransform } from '../model/factory';
import { localMatrix, paintedBounds } from '../model/transform';
import { pageExtentPx } from '../model/page';
import { shapeLabel } from '../model/shapes';
import { creationIndex, creationRect, createShapeFor, imagePlacementRect } from '../model/creation';
import { describeCommand } from '../model/commands';
import type { Command, RestackDirection } from '../model/commands';
import type { DocStore } from './store/doc-store';
import type { Viewport } from './viewport/viewport';
import type { HandleDirection, Overlay, OverlayInput, SelectionOutline } from './viewport/overlay';
import {
  angleTo,
  HANDLE_UNITS,
  moveTransform,
  pageDeltaToParentDelta,
  resizeTransform,
  rotateTransform,
  selectionCentre,
  snapAngle,
} from './transform';
import {
  commonFrame,
  emptySelection,
  findNode,
  hitTestPage,
  pageIdOfNode,
  pageNodeIds,
  selectedNodes,
  selectedPlacements,
} from './selection';
import {
  isGroup,
  locateNode,
  nodeById,
  pageIdOf,
  placementOf,
  placementsOnPage,
} from '../model/tree';
import { isDescendantOf, normaliseSelection } from './selection';
import type { SelectionState } from './selection';
import { TextSessionController } from './text-edit/text-session-controller';
import type { TextSessionHost } from './text-edit/text-session-controller';
import {
  measureNode as measureNodeLayout,
  measureTextContent as measureTextContentLayout,
  type Measurement,
  type MeasurementHost,
} from './measure';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the pointer is currently doing. */
type Gesture =
  | { kind: 'idle' }
  | { kind: 'marquee'; pageId: string; origin: Vec2; additive: boolean }
  | {
      kind: 'move';
      origin: Vec2;
      /**
       * Each selected node's transform *and its ancestor chain*.
       *
       * The chain is carried because `x`/`y` are parent-local: converting the gesture's page-space
       * delta into the delta this node's transform understands requires the parent matrix. Carrying
       * only the transform is what made a nested drag drift along its group's local axis.
       */
      start: ReadonlyMap<
        string,
        { transform: Transform2D; ancestors: readonly GroupNode[] }
      >;
    }
  | {
      kind: 'resize';
      handle: HandleDirection;
      start: ReadonlyMap<string, Transform2D>;
    }
  | {
      kind: 'rotate';
      centre: Vec2;
      startAngle: Vec2;
      start: ReadonlyMap<string, Transform2D>;
    }
  | { kind: 'draw'; pageId: string; origin: Vec2 };

/**
 * The current tool.
 *
 * `draw` is a *tool*, not a state the document can be in: no node is being edited and
 * no text session is open while it is active. It is modelled as a mode only because the
 * pointer pipeline already switches on one, and adding a second parallel state would be
 * two sources of truth for "what does the next click do".
 */
export type EditorMode = 'select' | 'textEdit' | 'draw';

export interface EditorOptions {
  store: DocStore;
  viewport: Viewport;
  overlay: Overlay;
  /** Called after any change, so the host can re-project and refresh chrome. */
  onChange: () => void;
}

export class Editor {
  private readonly store: DocStore;
  private readonly viewport: Viewport;
  private readonly overlay: Overlay;
  private readonly onChange: () => void;
  /** The application's node-id-to-element lookup. See {@link attachTextSessions}. */
  private viewHost: TextSessionHost | null = null;

  private selection: SelectionState = emptySelection();

  /**
   * The group whose direct children a click selects, or `null` at page level.
   *
   * **Editor-only, deliberately, and not in `SelectionState`.** It is a place the user *is*, not a fact
   * about the document: nothing is persisted, no command carries it, and reloading a file that contained
   * the same groups lands you at page level. The document is the model; this is the cursor.
   *
   * ## Why there is a scope at all
   *
   * The brief's two rules are in tension and both are right:
   *
   * - a plain click selects what is under the pointer, and
   * - a plain click on a child must not silently select an ancestor.
   *
   * Together they mean a plain click selects the **leaf**, always -- M12's behaviour, which must not
   * regress. So the group is reached by an explicit step rather than by a rule that guesses, and this
   * field is where "which step" lives.
   *
   * ## The interaction, chosen from what already existed
   *
   * - **Plain click** selects the leaf under the pointer. Never the group, never an ancestor.
   * - **<kbd>Alt</kbd>+click** selects the leaf's **parent group** -- reusing the existing alt
   *   convention, which already means "go to the thing behind this one" (`includeLocked`).
   * - **Double-click** *enters* a group: the scope becomes that group, and from then on a plain click
   *   selects its children directly. Double-click is already the browser's and this editor's word for
   *   "go in".
   * - **<kbd>Esc</kbd>** leaves one level; at page level it clears the selection.
   *
   * `<kbd>Enter</kbd>` is deliberately *not* used for entry: it already opens a text session on the
   * primary selection (M9), and overloading it would make one key mean two things depending on whether
   * the selection happens to be a text frame.
   */
  private enteredGroup: string | null = null;

  private mode: EditorMode = 'select';
  private gesture: Gesture = { kind: 'idle' };

  /**
   * The kind the armed draw tool will create, meaningful only while `mode === 'draw'`.
   *
   * A default of `'rect'` rather than `null` so arming the tool needs no second flag:
   * `drawKind` is read only when the mode says a tool is armed.
   */
  private drawKind: ShapeKind = 'rect';

  /**
   * Live rectangle while dragging on empty space — *or* while dragging out a new
   * object, which is the same feedback drawn by the same overlay code.
   *
   * Sharing it is deliberate. A create preview and a selection marquee are the same
   * "here is the rect I am about to apply" affordance, and a second preview rect would
   * be a second place for the overlay's geometry to disagree with the gesture's.
   */
  private marquee: { pageId: string; rect: Rect } | null = null;

  /**
   * An object to drop from the selection if the current press ends without moving.
   *
   * See `beginBodyGrab` — this is how shift-click-removes and shift-drag-moves
   * coexist.
   */
  private pendingDeselect: string | null = null;

  /**
   * Whether the current gesture has actually changed the document.
   *
   * Reset on pointer-down and pointer-up rather than derived, so a gesture that never
   * starts — a click that missed everything — cannot inherit the previous gesture's
   * answer.
   */
  private moved = false;

  private text: TextSessionController | null = null;

  constructor(options: EditorOptions) {
    this.store = options.store;
    this.viewport = options.viewport;
    this.overlay = options.overlay;
    this.onChange = options.onChange;
  }

  // ---------------------------------------------------------------------------
  // Read-only views for the UI layer
  // ---------------------------------------------------------------------------

  get doc(): Document {
    return this.store.state;
  }

  get selectionState(): SelectionState {
    return this.selection;
  }

  get currentMode(): EditorMode {
    return this.mode;
  }

  /** The kind an armed draw tool will create, for the toolbar's pressed state. */
  get armedShapeKind(): ShapeKind | null {
    return this.mode === 'draw' ? this.drawKind : null;
  }

  /**
   * Arms a creation tool.
   *
   * Leaves the tool armed after a creation, which is what every editor with a shape
   * toolbar does: drawing three rectangles should not mean clicking the toolbar three
   * times, and one-shot arming is a papercut nobody asked for. Escape or the select
   * tool disarms it.
   *
   * Ending a text session first is not politeness — the two both claim the pointer, and
   * a tool armed *behind* an open text session would be silently ignored by
   * `pointerDown`'s session branch.
   */
  armDrawTool(kind: ShapeKind): void {
    if (this.text !== null) this.endTextEdit();
    this.drawKind = kind;
    this.mode = 'draw';
    this.redrawOverlay();
    this.onChange();
  }

  /** Returns to the select tool. Bound to Escape and to the select toolbar button. */
  disarmDrawTool(): void {
    if (this.mode !== 'draw') return;
    this.mode = 'select';
    this.redrawOverlay();
    this.onChange();
  }

  get textSession(): TextSessionController | null {
    return this.text;
  }

  // ---------------------------------------------------------------------------
  // Measurement (ADR 0004)
  // ---------------------------------------------------------------------------

  /**
   * Measurement lives on `Editor` so `ui/` never imports `render/`.
   *
   * `eslint.config.js` forbids `ui → render` apart from `app.ts`, and that rule is
   * worth keeping: the inspector is the panel most likely to want "how big is this
   * text", and a convenience import would quietly become the second path from the
   * model to the DOM.
   *
   * Requires {@link attachTextSessions}, because that is where the application's one
   * node-id-to-element lookup arrives. Without it every node reads as `unmounted`,
   * which is the honest answer rather than a crash.
   */
  private get measurementHost(): MeasurementHost {
    return {
      store: this.store,
      elementFor: (nodeId: string) => this.viewHost?.elementFor(nodeId),
    };
  }

  /**
   * A node's laid-out box, in document px, or why there is no answer.
   *
   * Returns a status rather than a number because the failure modes are real: a hidden
   * frame measures zero from every layout API, and a projection that has not caught up
   * with the model reports the previous document's layout. Both look like a size.
   */
  // ---------------------------------------------------------------------------
  // Asset state (ADR 0006)
  // ---------------------------------------------------------------------------

  /**
   * What the browser currently makes of a node's asset, or `null` when it is not
   * mounted.
   *
   * Deliberately **not** in the model. Whether an asset resolves is a fact about this
   * browser session, not about the document: the same document renders correctly in one
   * tab and shows a placeholder in another whose object store was cleared. So the
   * document records a reference and the browser answers the rest.
   *
   * It lives here for the same reason measurement does: `eslint.config.js` forbids
   * `ui -> render`, and the inspector must be able to report this without importing
   * `render/`. There is exactly one node-id-to-element lookup in the application
   * (`viewHost`), and both reads go through it.
   */
  assetStateOf(nodeId: string): AssetState | null {
    const element = this.viewHost?.elementFor(nodeId);
    return element === undefined ? null : deriveAssetState(element);
  }

  /**
   * Why an asset does not resolve, or `null` when it does.
   *
   * Distinguishes the cases a user can act on differently -- "this document has no such
   * asset" is a broken file, "external is not implemented yet" is a missing feature, and
   * `null` means the asset is fine. Reporting one generic "missing" for all three would
   * make the first two indistinguishable from each other.
   */
  assetProblemOf(nodeId: string): string | null {
    const node = findNode(this.doc, nodeId);
    if (node === null || node.type !== 'image') return null;
    if (!hasAsset(this.doc.assets, node.asset)) {
      return `this document has no asset "${node.asset}"`;
    }
    return null;
  }

  measureNode(nodeId: string): Measurement {
    return measureNodeLayout(this.measurementHost, nodeId);
  }

  /**
   * A text frame's laid-out **text** size, in document px.
   *
   * During a text session this observes the browser's uncommitted DOM. Reading it is
   * safe; writing it back into the model is not, and must go through a command if a
   * future feature wants it to. ADR 0004 §5.
   */
  measureTextContent(nodeId: string): Measurement {
    return measureTextContentLayout(this.measurementHost, nodeId);
  }

  get isGesturing(): boolean {
    return this.gesture.kind !== 'idle';
  }

  /** Shared transform values for the inspector; `null` fields mean "mixed". */
  get commonTransform(): Record<string, number | null> | null {
    return commonFrame(this.doc, this.selection);
  }

  // ---------------------------------------------------------------------------
  // Text sessions (ADR 0002)
  // ---------------------------------------------------------------------------

  /**
   * Wires the text-session controller.
   *
   * Separate from the constructor because it needs the host's element lookup and
   * fence hook. Keeping `contenteditable` out of this class entirely is the point:
   * only the controller may begin a session, so the fence has one owner.
   */
  attachTextSessions(host: TextSessionHost): void {
    // Kept for measurement as well as for sessions. There is exactly one
    // node-id-to-element lookup in the application and this is it; a second one for
    // the sake of a new caller is how two answers start disagreeing.
    this.viewHost = host;
    // `onDomChange` is deliberately NOT wired to a chrome refresh, and the reason is
    // specific enough to act on. Measured in Chromium:
    //
    //   per keystroke        Ctrl+Z undoes
    //   -------------------  ---------------------------------------------
    //   a layout read         the whole word   (clientHeight)
    //   a selection query     the whole word   (queryCommandState)
    //   both reads            the whole word
    //   an overlay rebuild    ONE CHARACTER    (replaceChildren)
    //   a toolbar text write  ONE CHARACTER    (textContent)
    //
    // So reads are safe during an editing session and DOM *mutations* outside the
    // editable are not. Wiring the session's `onDomChange` to `onChange` -- which
    // redraws the overlay and rewrites the toolbar -- silently destroyed the browser's
    // keystroke grouping, which is the entire basis of ADR 0002's delegation.
    //
    // The cost of not doing it: the format toggles' pressed state and the measured
    // text height show the state from when the caret was placed until the session
    // exits and the model moves. That is a real cost and it is the cheaper of the
    // two. `tests/spike/undo-granularity-probe.spec.ts` is the measurement.
    this.text = new TextSessionController({ host });
  }

  /** Enters a text session on `nodeId`. */
  beginTextEdit(nodeId: string): boolean {
    if (this.text === null || !this.text.begin(nodeId)) return false;
    this.mode = 'textEdit';
    this.setSelection({ ...emptySelection(), ids: new Set([nodeId]), primary: nodeId });
    this.onChange();
    return true;
  }

  /**
   * Ends the active text session, committing one history entry.
   *
   * The controller owns the ordering (clear fence → write model → render); all this
   * does is leave text mode afterwards.
   */
  endTextEdit(): boolean {
    if (this.text === null || !this.text.isActive) return false;
    const changed = this.text.end();
    this.mode = 'select';
    this.onChange();
    return changed;
  }

  // ---------------------------------------------------------------------------
  // Undo/redo — the composition rule from ADR 0002
  // ---------------------------------------------------------------------------

  /**
   * Undo. Delegates to the text session while one is active, else to the store.
   *
   * Both branches are load-bearing: see ADR 0002. Delegation is what keeps IME,
   * autocorrect and the browser's own keystroke grouping intact.
   */
  undo(): void {
    if (this.text?.isActive === true) {
      this.text.undo();
      return;
    }
    this.store.undo();
    this.pruneSelection();
    this.onChange();
  }

  redo(): void {
    if (this.text?.isActive === true) {
      this.text.redo();
      return;
    }
    this.store.redo();
    this.pruneSelection();
    this.onChange();
  }

  /**
   * Label for the undo affordance, correct in both modes.
   *
   * A **verb phrase**, not a full label: `app.ts` renders `Undo ${label}`, and every
   * `History` label already follows that convention ("Move 1 object" → "Undo Move 1
   * object"). Returning `'Undo text'` here produced "Undo Undo text" — and a browser
   * test had pinned that string, so the doubled prefix was recorded as expected
   * behaviour rather than caught. The convention is the contract; the session labels
   * now follow it.
   */
  undoLabel(): string | null {
    return this.text?.isActive === true ? 'text' : this.store.undoLabel;
  }

  redoLabel(): string | null {
    return this.text?.isActive === true ? 'redo text' : this.store.redoLabel;
  }

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------

  select(ids: Iterable<string>, primary?: string | null): void {
    const list = [...ids];
    this.setSelection({
      ...emptySelection(),
      ids: new Set(list),
      primary: primary ?? list[0] ?? null,
    });
    this.onChange();
  }

  /** Deletes the selected objects. One undo step for the whole selection. */
  deleteSelection(ids: readonly string[]): void {
    if (ids.length === 0) return;
    this.store.mutate(`Delete ${countLabel(ids.length)}`, () => ({ type: 'remove', ids: [...ids] }));
    // `pruneSelection` would handle this, but deleting is an explicit act: clearing
    // the selection makes the outcome obvious instead of silently emptying.
    //
    // The image's **asset record stays** in the document. That is deliberate rather than
    // an oversight: assets live in the model, so undo restoring a deleted image can
    // restore its bytes too. Collecting orphans needs a reference count across the
    // document and needs to interact with undo; it is recorded as ADR 0006's named gap.
    this.setSelection(emptySelection());
    this.onChange();
  }

  // ---------------------------------------------------------------------------
  // Image insertion (ADR 0006)
  // ---------------------------------------------------------------------------

  /**
   * Inserts an image from bytes the browser has already validated.
   *
   * Two commands in one `batch`, so the whole insertion is **one undo step**: the asset
   * record and the node referencing it are one user action, and splitting them would
   * leave an undo that half-restores — a node pointing at bytes that are not there.
   *
   * The placement size is the asset's **intrinsic** size, which is why the default needs
   * no measurement and no render pass: the size is known from the bytes, and ADR 0004's
   * measurement contract has nothing to contribute.
   *
   * `at` is in page-local document px and is the image's **top-left**, matching every
   * other object's origin.
   */
  insertImage(input: {
    pageId: string;
    /** Where the user chose to put it, in page-local document px. */
    at: Vec2;
    mime: string;
    intrinsicWidth: number;
    intrinsicHeight: number;
    inline: string;
  }): void {
    const { id, asset } = createAssetFrom({
      mime: input.mime,
      intrinsicWidth: input.intrinsicWidth,
      intrinsicHeight: input.intrinsicHeight,
      data: { inline: input.inline },
    });

    const page = this.doc.pages.find((candidate) => candidate.id === input.pageId);
    if (page === undefined) return;

    // The placement geometry lives in `model/creation.ts`, beside every other creation
    // decision, so the "at intrinsic size, scaled uniformly to fit" rule is one function
    // with tests rather than arithmetic inside a gesture.
    const box = imagePlacementRect(
      { width: input.intrinsicWidth, height: input.intrinsicHeight },
      input.at,
      pageExtentPx(this.doc.pageSize),
    );

    const node: ImageNode = {
      id: createId('node'),
      type: 'image',
      name: 'Image',
      transform: { ...createTransform(), ...box },
      visible: true,
      locked: false,
      opacity: 1,
      blendMode: 'normal',
      asset: id,
    };

    this.store.mutate('Insert image', () => ({
      type: 'batch',
      label: 'Insert image',
      cmds: [
        { type: 'setAssets', assets: { [id]: asset } },
        { type: 'insert', pageId: input.pageId, index: page.objects.length, nodes: [node] },
      ],
    }));

    this.setSelection({ ...emptySelection(), ids: new Set([node.id]), primary: node.id });
    this.onChange();
  }

  /**
   * Aligns or distributes the selection, as one undo step.
   *
   * ## Why a batch of `setTransform` rather than a new command
   *
   * Because the mutation path is the existing one. Each object gets one `setTransform`, and the batch is
   * one history entry with one label -- the same shape `restack` uses, and for the same reason (a
   * multi-object operation must not produce one undo step per object). A new `align` command in
   * `model/commands.ts` would have to reimplement `mapNodesById`, the merge-and-compare that makes
   * "set X to the value it already has" a no-op, and the no-op detection in `isNoop` -- a second
   * implementation of all three, free to disagree with the originals.
   *
   * ## Why the geometry is not here
   *
   * `model/arrange.ts` owns it. This method only resolves the selection to targets, converts page-space
   * deltas into each node's parent-local delta, and hands the result to the existing command funnel.
   *
   * ## No-op
   *
   * Two layers, and both are needed. If the operation cannot apply -- fewer than two objects to align,
   * fewer than three to distribute -- it returns before any command is built. If it *can* apply but moves
   * nothing -- everything already aligned, which is the common case for a user who clicks align twice --
   * then every patch is a no-op, `setTransform` returns the same node references, `apply` returns the same
   * document, and `store.mutate` records nothing. So there is no empty undo step and the label never
   * reads "Align 3" for a change that did not happen.
   *
   * ## Selection
   *
   * Unchanged, and deliberately so: alignment moves objects, it does not re-select them, and the ids it
   * was given are still the ids afterwards. That is what lets a user align twice in a row -- the second
   * click is a no-op, correctly, rather than a selection that has moved out from under them.
   */
  arrange(operation: ArrangeOperation): void {
    const targets = arrangeTargets(this.doc, this.selection.ids);
    const deltas = arrangementDeltas(targets, operation);
    // `null` means the operation cannot apply at all -- too few objects. Distinct from an empty map,
    // which would mean "applies and moves nothing".
    if (deltas === null) return;

    const label = describeArrange(operation, targets.length);
    const cmds: Command[] = [];
    for (const target of targets) {
      const deltaPage = deltas.get(target.id);
      // A group that is already where it belongs gets no entry at all, rather than a zero-delta patch.
      if (deltaPage === undefined || (deltaPage.x === 0 && deltaPage.y === 0)) continue;
      cmds.push({
        type: 'setTransform',
        ids: [target.id],
        patch: translatedTransform(
          target.transform,
          // Page space to parent-local, the same conversion the move gesture uses. Identity at depth 0.
          pageDeltaToParentDelta(target.ancestors, deltaPage),
        ),
      });
    }
    if (cmds.length === 0) return;

    this.store.mutate(label, () => ({ type: 'batch', cmds }));
    this.redrawOverlay();
    this.onChange();
  }

  /**
   * Moves the given objects by `delta`, as one undo step.
   *
   * `axisLock` collapses the delta to its dominant axis. Arrow keys use shift for a
   * ten-fold step and alt for the lock, so neither steals the other's meaning.
   */
  nudge(ids: readonly string[], delta: Vec2, axisLock: boolean): void {
    if (ids.length === 0) return;
    const step = axisLock
      ? Math.abs(delta.x) > Math.abs(delta.y)
        ? { x: delta.x, y: 0 }
        : { x: 0, y: delta.y }
      : delta;

    const cmds: Command[] = [];
    for (const id of ids) {
      const node = findNode(this.doc, id);
      if (node === null) continue;
      cmds.push({
        type: 'setTransform',
        ids: [id],
        patch: moveTransform(node.transform, step),
      });
    }
    if (cmds.length === 0) return;

    this.store.mutate(`Move ${countLabel(ids.length)}`, () => ({ type: 'batch', cmds }));
    this.redrawOverlay();
    this.onChange();
  }

  selectAll(): void {
    // `pageNodeIds`, not `page.objects.map(...)`: paint order flattened through groups, so a group
    // child is included and a group itself is not. Including a group would select something with
    // no gesture to produce it, and M12 builds no grouping interaction.
    this.select(this.doc.pages.flatMap((page) => pageNodeIds(this.doc, page.id)));
  }

  /**
   * Moves the selection through the paint order.
   *
   * ## One command, and why it is batched rather than looped
   *
   * The selection can span pages -- shift-click does not stop at a page edge -- and paint
   * order is a property of *one page's* array, so a cross-page selection restacks each page's
   * subset independently. That is one `restack` per page, dispatched as a single `batch`, which
   * is one history entry with one label. Dispatching a loop of `restack`s would produce one
   * undo step per page, and the label would read "2 changes".
   *
   * `store.mutate` runs the no-op check first, so pressing "bring forward" with nothing
   * selected, or with the topmost object selected, records nothing at all.
   */
  restack(direction: RestackDirection): void {
    const byPage = new Map<string, string[]>();
    for (const id of this.selection.ids) {
      const pageId = pageIdOfNode(this.doc, id);
      if (pageId === null) continue;
      const bucket = byPage.get(pageId);
      if (bucket === undefined) byPage.set(pageId, [id]);
      else bucket.push(id);
    }
    if (byPage.size === 0) return;

    const cmds: Command[] = [...byPage].map(([pageId, ids]) => ({
      type: 'restack' as const,
      pageId,
      ids,
      direction,
    }));

    // The label comes from the model, not from here. `describeCommand` is where every other
    // label in the app is spelled, and duplicating four strings here is how the history menu
    // and the button tooltip start disagreeing.
    const first = cmds[0];
    if (first === undefined) return;
    this.store.mutate(describeCommand(first), () => ({ type: 'batch', cmds }));
    this.redrawOverlay();
    this.onChange();
  }

  clearSelection(): void {
    this.setSelection(emptySelection());
    this.onChange();
  }

  setHover(nodeId: string | null): void {
    if (this.selection.hover === nodeId) return;
    this.selection = { ...this.selection, hover: nodeId };
    this.redrawOverlay();
  }

  // ---------------------------------------------------------------------------
  // Overlay
  // ---------------------------------------------------------------------------

  /** Recomputes and redraws all editor chrome. Cheap by design (§3.8). */
  redrawOverlay(): void {
    this.overlay.render(this.overlayInput());
  }

  /**
   * Asks the host to re-read everything the chrome reflects.
   *
   * Needed for changes that touch no model state: a format toggle *inside* a session
   * changes only the browser's DOM, so nothing in the store fires and the toolbar's
   * pressed state would go stale. Going through the existing callback rather than a
   * second one keeps a single refresh path.
   */
  refresh(): void {
    this.onChange();
  }

  overlayInput(): OverlayInput {
    const outlines: SelectionOutline[] = [];
    // `selectedPlacements`, not `selectedNodes` + `pageIdOfNode`: the chrome needs the node's
    // **page-space** transform, because an outline drawn from a grouped child's own local transform
    // would sit at the group's origin rather than where the object paints. That is the F6 bug M11
    // fixed, reintroduced one level down, and it is invisible for a flat document — which is why the
    // traversal is passed the whole `{ node, placement }` pair instead of letting a caller look the
    // placement up and forget.
    for (const { node, placement } of selectedPlacements(this.doc, this.selection)) {
      const pageId = pageIdOf(this.doc, node.id);
      if (pageId === null) continue;
      outlines.push({
        nodeId: node.id,
        pageId,
        // The composed transform: the node's own frame, positioned in page space. `width`/`height`
        // are unchanged by depth — the frame is still the node's local box (ADR 0011 §8).
        rect: toRect(placement.transform),
        // The composed linear part, so the outline is rotated and scaled with everything above it.
        // This is the F6 fix (ADR 0011 §8): before it, the chrome was laid out at the model frame
        // and never transformed, so a rotated object was framed by an unrotated box.
        matrix: localMatrix(placement.transform),
      });
    }

    // Selected **groups**, which have no placement of their own.
    //
    // `selectedPlacements` walks `placementsOnPage`, which yields leaves -- so a selected group would
    // otherwise draw nothing at all, and the object the user just grouped would look unselected while
    // still responding to a drag. That is the M11 F6 argument again: rendered-but-unframed is broken,
    // not deferred.
    //
    // The frame is the **union of the group's descendants' painted bounds**, computed here for chrome
    // only. It is deliberately *not* the group's authored `width`/`height` and it is deliberately not
    // written back to the document: a group has no authored geometry to fit (ADR 0012 §3), and deriving
    // one from children would make the parent a function of its members. This is the same
    // `modelFrameUnion` a multi-selection already uses, so a group is framed by the machinery that
    // already exists rather than by a second implementation.
    //
    // The matrix is the identity because the union is already axis-aligned in page space. Using the
    // group's own matrix would rotate the union a second time.
    for (const id of this.selection.ids) {
      const node = nodeById(this.doc, id);
      if (node === null || !isGroup(node)) continue;
      // `locateNode(...).pageId`, **not** `pageIdOf`.
      //
      // `pageIdOf` is built on `placementOnPage`, which walks leaves and returns a placement only for a
      // non-group -- so for a group it answers `null`, which reads as "this node is not on any page".
      // The first version of this loop used `pageIdOf` and a selected group drew **no outline at all**,
      // while every other signal said it was selected. That is ADR 0012 §2's failure mode exactly: a
      // consumer that asks the wrong traversal concludes a grouped object is not there, and goes inert
      // with nothing failing.
      //
      // `locateNode` is the traversal that answers "where does this node live", including for a group.
      const pageId = locateNode(this.doc, id)?.pageId ?? null;
      if (pageId === null) continue;
      const page = this.doc.pages.find((candidate) => candidate.id === pageId);
      if (page === undefined) continue;
      const rects = placementsOnPage(page)
        .filter((placement) => placement.ancestors.some((group) => group.id === id))
        .map((placement) => paintedBounds(placement.transform));
      if (rects.length === 0) continue;
      outlines.push({ nodeId: id, pageId, rect: unionRects(rects), matrix: identity() });
    }

    let hover: SelectionOutline | null = null;
    const hovered = this.selection.hover;
    if (hovered !== null && !this.selection.ids.has(hovered)) {
      const pageId = pageIdOf(this.doc, hovered);
      const placement = placementOf(this.doc, hovered);
      if (pageId !== null && placement !== null) {
        hover = {
          nodeId: hovered,
          pageId,
          rect: toRect(placement.transform),
          matrix: localMatrix(placement.transform),
        };
      }
    }

    // The rotation grip, and the one interaction whose availability is a real capability question.
    //
    // It is offered for **a single selection, rotated or not**. It used to require
    // `rotation === 0`, and that condition was not a capability limit at all: it was a workaround
    // for the frame not following the rotation. With the grip placed on the *transformed* frame's
    // top edge it is meaningful at any angle, so the condition is gone.
    //
    // What remains is the genuine limit, and it is a genuine one: the grip's pivot is the single
    // selected object's frame centre, so there is nothing coherent to offer for several objects. M8
    // deliberately has no aggregate selection frame (ADR 0008 §7) and M11 keeps that, so
    // `startRotate`'s fan-out over several nodes remains an editor capability with no gesture --
    // now because of the missing aggregate frame, which is a decision, rather than because of a
    // geometry bug.
    let rotationHandle: { pageId: string; point: Vec2 } | null = null;
    const outline = outlines.length === 1 ? outlines[0] : undefined;
    if (outline !== undefined) {
      rotationHandle = {
        pageId: outline.pageId,
        // A point on the frame's own top edge, pushed out along the frame's local -y so the grip
        // sits outside the shape at any rotation. Placed by the overlay, which owns the arithmetic
        // and is the same code that draws the outline it has to line up with.
        point: this.overlay.rotationGripPoint(outline, ROTATION_HANDLE_GAP),
      };
    }

    return {
      outlines,
      hover,
      marquee: this.marquee,
      snapLines: [],
      rotationHandle,
    };
  }

  // ---------------------------------------------------------------------------
  // Pointer gestures
  // ---------------------------------------------------------------------------

  pointerDown(event: PointerEvent): void {
    const client = { x: event.clientX, y: event.clientY };
    this.moved = false;

    // A text session owns the keyboard but not the pointer: clicking elsewhere is how
    // the user says they are done. Intercepting that here — rather than in the
    // renderer or the session — keeps the fence in one place.
    if (this.mode === 'textEdit') {
      if (!this.isInsideTextSession(client)) this.endTextEdit();
      return;
    }

    const pagePoint = this.viewport.pagePointFromClient(client);
    if (pagePoint === null) {
      // Not over a page — in a gap, or past the end of the stack.
      if (!event.shiftKey) this.clearSelection();
      return;
    }

    // 0. An armed creation tool. Ahead of every other target, deliberately: a draw tool
    // that could grab handles or select what is underneath it would not be a tool, it
    // would be a modifier. The click is *only* about the page it lands on.
    if (this.mode === 'draw') {
      const pageId = this.pageIdAtClient(client);
      if (pageId === null) return;
      this.gesture = { kind: 'draw', pageId, origin: pagePoint };
      // The preview rect, drawn by the same overlay path as a marquee.
      this.marquee = { pageId, rect: normaliseRect(pagePoint, pagePoint) };
      this.redrawOverlay();
      return;
    }

    // 1. Rotation handle.
    const rotation = this.rotationHandleAt(client);
    if (rotation !== null) {
      this.startRotate(pagePoint, rotation.centre);
      return;
    }

    // 2. Resize handles.
    const handle = this.handleAt(client);
    if (handle !== null) {
      this.startResize(handle.direction, handle.nodeId);
      return;
    }

    // 3. Object body.
    const pageId = this.pageIdAtClient(client);
    const hit = pageId === null ? null : hitTestPage(this.doc, pageId, pagePoint, { includeLocked: event.altKey });
    if (hit !== null) {
      // `selectableIdFor` is where the group semantics live: a plain click takes the leaf, and
      // Alt+click climbs one level to the containing group. Keeping it out of `hitTestPage` is
      // deliberate -- the hit test answers "what is painted here", and this answers "what does a
      // click mean", which is a different question and has been since M12.
      const selectable = this.selectableIdFor(hit.nodeId, event.altKey);
      this.beginBodyGrab(selectable, event.shiftKey);
      this.startMove(pagePoint);
      this.redrawOverlay();
      return;
    }

    // 4. Background: marquee. Leaving the page's scope on a background click is right in both
    //    directions -- the user has left whatever they were inside -- and it is the same single
    //    statement, rather than a second "also forget the scope" call someone can forget.
    if (!event.shiftKey) {
      this.leaveGroup();
      this.setSelection(emptySelection());
    }
    this.gesture = { kind: 'marquee', pageId: pageId ?? '', origin: pagePoint, additive: event.shiftKey };
    this.marquee = { pageId: pageId ?? '', rect: normaliseRect(pagePoint, pagePoint) };
    this.redrawOverlay();
  }

  /**
   * Which node id a click on `leafId` should select.
   *
   * The whole of the group click rule, in one function, so there is exactly one place that answers it.
   *
   * - **Plain click → the leaf.** Never a group, never an ancestor. This is M12's behaviour and the
   *   brief's explicit requirement: a click on a child must not silently select a hidden ancestor.
   * - **Alt+click → the containing group**, when the leaf is inside one. Reuses the existing alt
   *   convention ("reach the thing behind this"), and it is the only way a plain interaction selects a
   *   group, which is what keeps "a click selects a group" from quietly becoming "a click selects
   *   whatever happens to be above this leaf in the tree".
   * - **Inside an entered group → its direct children only.** `hitTestPage` returns the leaf it
   *   painted, and a leaf that is a *grandchild* of the entered group is skipped in favour of its
   *   parent, because otherwise entry would leak straight through to arbitrary depth.
   *
   * Returns the leaf itself when nothing applies, so callers need no fallback branch.
   */
  private selectableIdFor(leafId: string, altKey: boolean): string {
    const location = locateNode(this.doc, leafId);
    if (location === null) return leafId;

    const entered = this.enteredGroup;
    if (entered !== null) {
      // Inside a group: only its direct children are reachable, so clicking one enters the next level.
      const depthFromEntered = location.ancestors.findIndex((ancestor) => ancestor.id === entered);
      if (depthFromEntered >= 0) {
        if (depthFromEntered === location.ancestors.length - 1) return leafId;
        const next = location.ancestors[depthFromEntered + 1];
        return next === undefined ? leafId : next.id;
      }
      // Outside the entered group entirely: fall through to the rules below rather than refusing.
    }

    if (!altKey) return leafId;
    // Alt climbs exactly one level. Climbing all the way to the page root on the fourth alt-click is
    // the kind of "helpful" depth that loses a selection.
    const parent = location.ancestors[location.ancestors.length - 1];
    return parent === undefined ? leafId : parent.id;
  }

  /**
   * Enters `groupId`, so plain clicks select its children.
   *
   * Refuses to enter a group that is not an ancestor-or-self of the current scope, which is what stops
   * entry from silently leaving the user somewhere they did not click. Returns whether it entered, so a
   * double-click that found nothing does not pretend it did.
   */
  private enterGroup(groupId: string): boolean {
    const node = nodeById(this.doc, groupId);
    if (node === null || !isGroup(node)) return false;
    const current = this.enteredGroup;
    if (current === null) {
      // From the page, the group must be a top-level one -- otherwise "entering" it would skip the
      // groups in between and the scope would not match what the user is looking at.
      const location = locateNode(this.doc, groupId);
      if (location === null || location.ancestors.length !== 0) return false;
    } else if (!isDescendantOf(this.doc, groupId, current)) {
      return false;
    }
    this.enteredGroup = groupId;
    return true;
  }

  /** Leaves one level of scope. At page level this is a no-op, so `Esc` can be layered on it. */
  private leaveGroup(): boolean {
    if (this.enteredGroup === null) return false;
    const location = locateNode(this.doc, this.enteredGroup);
    if (location === null || location.ancestors.length === 0) {
      this.enteredGroup = null;
      return true;
    }
    const parent = location.ancestors[location.ancestors.length - 1];
    this.enteredGroup = parent === undefined ? null : parent.id;
    return true;
  }

  /**
   * Selection change for a press on an object body.
   *
   * Shift is genuinely ambiguous here, and resolving it wrongly is why so many
   * editors feel broken:
   *
   *  - shift on an **unselected** object adds it, and the drag moves the new set;
   *  - shift on an **already selected** object is *either* "remove it" or "move
   *    everything", and the two are indistinguishable until the pointer moves.
   *
   * So the removal is deferred to pointer-up and applied only if nothing moved. That
   * is the behaviour users describe as correct even when they cannot articulate why.
   */
  private beginBodyGrab(nodeId: string, shiftKey: boolean): void {
    // Every branch goes through `setSelection`, including the one that only re-points
    // `primary`. Assigning the field directly skips the overlay redraw, and the reason that had
    // not bitten is a `redrawOverlay()` a few lines later in `pointerDown` -- a coincidence of
    // call order, not a property of this method.
    if (!shiftKey) {
      if (this.selection.ids.has(nodeId)) {
        this.setSelection({ ...this.selection, primary: nodeId });
      } else {
        this.setSelection({ ...emptySelection(), ids: new Set([nodeId]), primary: nodeId });
      }
      return;
    }

    if (!this.selection.ids.has(nodeId)) {
      const ids = new Set(this.selection.ids);
      ids.add(nodeId);
      this.setSelection({ ...this.selection, ids, primary: nodeId });
      return;
    }

    // Selected and shift held: leave the selection alone for now, and remember to
    // drop this object if the press turns out to be a click rather than a drag.
    this.pendingDeselect = nodeId;
  }

  /** Is a client point inside the frame currently being edited? */
  private isInsideTextSession(client: Vec2): boolean {
    const nodeId = this.text?.nodeId;
    if (nodeId === null || nodeId === undefined) return false;

    const pagePoint = this.viewport.pagePointFromClient(client);
    if (pagePoint === null) return false;
    const pageId = this.pageIdAtClient(client);
    if (pageId === null) return false;

    return hitTestPage(this.doc, pageId, pagePoint)?.nodeId === nodeId;
  }

  pointerMove(event: PointerEvent): void {
    const client = { x: event.clientX, y: event.clientY };

    if (this.gesture.kind === 'idle') {
      this.updateHover(client);
      return;
    }

    const pagePoint = this.viewport.pagePointFromClient(client);
    if (pagePoint === null) return;

    switch (this.gesture.kind) {
      case 'marquee': {
        const rect = normaliseRect(this.gesture.origin, pagePoint);
        this.marquee = { pageId: this.gesture.pageId, rect };
        // A press that never becomes a drag must not marquee-select. See pplyMarquee.
        if (rect.width > 0 || rect.height > 0) this.moved = true;
        this.redrawOverlay();
        break;
      }
      case 'draw': {
        // The same preview as a marquee. `normaliseRect` is also what the *committed*
        // rect is built from (`creationRect`), so what the user saw while dragging is
        // literally the rect that gets inserted — not an approximation of it.
        const rect = normaliseRect(this.gesture.origin, pagePoint);
        this.marquee = { pageId: this.gesture.pageId, rect };
        // "Moved" means "moved far enough to mean it", using the same threshold that
        // decides whether a drag is committable. Deriving it here rather than counting
        // pointermove events keeps a click with a pixel of jitter classified as a click.
        if (rect.width > 0 || rect.height > 0) this.moved = true;
        this.redrawOverlay();
        break;
      }
      case 'move':
        this.applyMove(pagePoint, event.shiftKey);
        break;
      case 'resize':
        this.applyResize(pagePoint, event.shiftKey, event.altKey);
        break;
      case 'rotate':
        this.applyRotate(pagePoint, event.shiftKey);
        break;
      default:
        break;
    }
  }

  pointerUp(event: PointerEvent): void {
    const gesture = this.gesture;
    this.gesture = { kind: 'idle' };
    const deselect = this.pendingDeselect;
    this.pendingDeselect = null;
    const preview = this.marquee;
    this.marquee = null;

    try {
      if (gesture.kind === 'marquee' && preview !== null && this.moved) {
        const end = this.viewport.pagePointFromClient({ x: event.clientX, y: event.clientY });
        if (end !== null) this.applyMarquee(preview.rect, gesture.pageId, gesture.additive);
      } else if (gesture.kind === 'draw') {
        // Creation commits *once*, on release, as a single `insert`. The drag produced
        // no document change at all — the preview rect was overlay geometry, not model
        // state — so there is no transaction to open and nothing to roll back.
        //
        // Releasing outside the page aborts rather than clamping, because clamping would
        // silently create an object somewhere the user is not pointing.
        const end = this.viewport.pagePointFromClient({ x: event.clientX, y: event.clientY });
        if (end !== null) this.commitCreation(gesture.pageId, gesture.origin, end);
      } else if (deselect !== null && !this.moved) {
        // The press never became a drag, so this was a plain shift-click: remove it.
        this.removeFromSelection(deselect);
      }
    } finally {
      this.store.endTransaction();
    }

    this.moved = false;
    // The draw tool stays armed so several objects can be drawn in a row; only the
    // in-flight preview is gone. `commitCreation` may have disarmed it — it does so for
    // a creation it refused — and that path already redrew.
    this.redrawOverlay();
    this.onChange();
  }

  /**
   * Turns a completed draw drag into one `insert` command, and selects the result.
   *
   * Goes through `store.mutate`, so `isNoop` sees a real command, the history label is
   * derived by the same `describeCommand` every other command uses, and creation has no
   * privileged route into the document. That is the whole of §5's "the interaction
   * should produce normal model commands" — there is no special path here to get wrong.
   */
  private commitCreation(pageId: string, from: Vec2, to: Vec2): void {
    const kind = this.drawKind;
    const rect = creationRect(from, to, kind, this.moved);
    if (rect === null) {
      // A drag too small to be a shape, or a click with a tool that needs two points.
      // Refusing is better than committing a zero-extent object the user could not then
      // select (ADR 0005 §6), and better than leaving a stale preview on screen.
      this.marquee = null;
      this.disarmDrawTool();
      return;
    }

    const page = this.doc.pages.find((candidate) => candidate.id === pageId);
    if (page === undefined) return;

    const node = createShapeFor(kind, rect);
    this.store.mutate(`Insert ${shapeLabel(kind)}`, () => ({
      type: 'insert',
      pageId,
      index: creationIndex(page.objects.length),
      nodes: [node],
    }));

    // Selecting what was just created is the useful outcome; without it the object
    // exists and the user has to go and find it.
    this.setSelection({ ...emptySelection(), ids: new Set([node.id]), primary: node.id });
  }

  /**
   * Aborts the in-flight gesture, rolling the document back to how it started.
   *
   * Two callers, and the second is the one that is easy to miss:
   *
   * - **Escape**, where rolling back rather than committing means a cancelled gesture leaves
   *   no history entry at all — which is what "never mind" should mean.
   * - **`pointercancel`**, where the *browser* has taken the pointer back. This is not a rare
   *   formality: a press that also starts a native text selection gets its pointer cancelled,
   *   and a cancelled pointer then delivers no further `pointermove` and no `pointerup` at
   *   all. A gesture left open here would hang the editor mid-drag, still holding the
   *   pointer capture, with no event coming that could ever end it.
   *
   * The idle guard is what makes the second caller safe. A stray cancel with nothing in
   * flight must do nothing at all: `abortTransaction` would otherwise reach for whatever
   * transaction happened to be open, which during a text session is not this method's
   * business.
   */
  cancelGesture(): void {
    if (this.gesture.kind === 'idle') return;

    this.gesture = { kind: 'idle' };
    this.marquee = null;
    this.pendingDeselect = null;
    this.moved = false;

    // Rolls the transaction back rather than dispatching the starting transforms as a
    // compensating edit, which history could not tell apart from a real change.
    this.store.abortTransaction();

    this.redrawOverlay();
    this.onChange();
  }

  private startMove(origin: Vec2): void {
    const start = this.captureMovableTransforms();
    if (start.size === 0) return;
    this.store.beginTransaction({ label: `Move ${countLabel(start.size)}`, mergeKey: GESTURE_KEY });
    this.gesture = { kind: 'move', origin, start };
  }

  private startResize(handle: HandleDirection, nodeId: string): void {
    const node = findNode(this.doc, nodeId);
    if (node === null) return;

    // Only the grabbed object resizes, even in a multi-selection: a handle belongs
    // to one box, and resizing all of them from one box's corner is not what the
    // user grabbed.
    const start = new Map([[nodeId, node.transform]]);
    this.store.beginTransaction({ label: 'Resize', mergeKey: GESTURE_KEY });
    this.gesture = { kind: 'resize', handle, start };
  }

  private startRotate(pointer: Vec2, centre: Vec2): void {
    const start = this.captureTransforms();
    if (start.size === 0) return;
    this.store.beginTransaction({ label: 'Rotate', mergeKey: GESTURE_KEY });
    this.gesture = { kind: 'rotate', centre, startAngle: pointer, start };
  }

  private captureTransforms(): Map<string, Transform2D> {
    const map = new Map<string, Transform2D>();
    for (const node of selectedNodes(this.doc, this.selection)) map.set(node.id, node.transform);
    return map;
  }

  /**
   * Captures each selected node's transform **together with its ancestor chain**.
   *
   * `captureTransforms` alone is not enough to move anything: `Transform2D.x/y` are parent-local, so
   * a page-space delta needs the parent matrix to become a local one, and that matrix is reachable
   * only from the placement. See `pageDeltaToParentDelta`.
   */
  private captureMovableTransforms(): Map<string, { transform: Transform2D; ancestors: readonly GroupNode[] }> {
    const map = new Map<string, { transform: Transform2D; ancestors: readonly GroupNode[] }>();
    for (const { node, placement } of selectedPlacements(this.doc, this.selection)) {
      map.set(node.id, { transform: node.transform, ancestors: placement.ancestors });
    }
    return map;
  }

  private applyMove(pagePoint: Vec2, shiftKey: boolean): void {
    const gesture = this.gesture;
    if (gesture.kind !== 'move') return;

    let dx = pagePoint.x - gesture.origin.x;
    let dy = pagePoint.y - gesture.origin.y;

    // Shift constrains to the dominant axis — the one the user is obviously after.
    // Matching every other editor beats being clever here.
    if (shiftKey) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
    }

    const cmds: Command[] = [];
    for (const [id, entry] of gesture.start) {
      cmds.push({
        type: 'setTransform',
        ids: [id],
        // `dx`/`dy` are page-space; the transform is parent-local. The conversion is identity at
        // depth 0, so a top-level object moves exactly as before, and correct one level down, where
        // adding the page delta directly moved the child along its group's local axis instead.
        patch: moveTransform(
          entry.transform,
          pageDeltaToParentDelta(entry.ancestors, { x: dx, y: dy }),
        ),
      });
    }
    this.store.dispatch({ type: 'batch', cmds }, { mergeKey: GESTURE_KEY });
    this.moved = true;
    this.redrawOverlay();
  }

  private applyResize(pagePoint: Vec2, shiftKey: boolean, altKey: boolean): void {
    const gesture = this.gesture;
    if (gesture.kind !== 'resize') return;

    const options = { keepAspect: shiftKey, fromCenter: altKey, minSize: MIN_SIZE };
    const next = new Map<string, Transform2D>();
    for (const [id, transform] of gesture.start) {
      next.set(id, resizeTransform(transform, gesture.handle, pagePoint, options));
    }

    this.store.dispatch(patchAll(next), { mergeKey: GESTURE_KEY });
    this.moved = true;
    this.redrawOverlay();
  }

  private applyRotate(pagePoint: Vec2, shiftKey: boolean): void {
    const gesture = this.gesture;
    if (gesture.kind !== 'rotate') return;

    const delta = angleTo(gesture.centre, pagePoint) - angleTo(gesture.centre, gesture.startAngle);
    const applied = shiftKey ? snapAngle(delta) : delta;

    const cmds: Command[] = [];
    for (const [id, transform] of gesture.start) {
      cmds.push({
        type: 'setTransform',
        ids: [id],
        patch: rotateTransform(transform, transform.rotation + applied, gesture.centre),
      });
    }
    this.store.dispatch({ type: 'batch', cmds }, { mergeKey: GESTURE_KEY });
    this.moved = true;
    this.redrawOverlay();
  }

  /**
   * Which resize handle, if any, is under a client point — and whose it is.
   *
   * Every selected object gets its own eight handles, so the answer has to name the
   * object too. Returning just a direction would make the hit test and the drawn
   * chrome disagree about which box is being resized.
   */
  private handleAt(client: Vec2): { direction: HandleDirection; nodeId: string } | null {
    const point = this.overlay.clientToLayer(client);
    for (const outline of this.overlayInput().outlines) {
      if (outline.nodeId === undefined) continue;
      for (const direction of Object.keys(HANDLE_UNITS) as HandleDirection[]) {
        // The overlay's own placement, not a second copy of it. Before M11 this recomputed
        // `rect.x + rect.width * unit.x` from the *model frame*, which agreed with the chrome and
        // was wrong about the object: the handle you saw and the handle you grabbed were both at
        // the unrotated corner, so a rotated object could not be resized by the handle that looked
        // like it was on it.
        const at = this.overlay.handlePoint(outline, direction);
        if (Math.hypot(point.x - at.x, point.y - at.y) <= HANDLE_GRAB_RADIUS) {
          return { direction, nodeId: outline.nodeId };
        }
      }
    }
    return null;
  }

  /** The rotation handle's client point, when one exists and is under the cursor. */
  private rotationHandleAt(client: Vec2): { centre: Vec2 } | null {
    const input = this.overlayInput();
    const handle = input.rotationHandle;
    const outline = input.outlines.length === 1 ? input.outlines[0] : undefined;
    if (handle === null || outline === undefined) return null;

    const pageIndex = this.doc.pages.findIndex((page) => page.id === handle.pageId);
    if (pageIndex < 0) return null;

    const anchor = this.overlay.clientToLayer(
      this.viewport.clientFromPagePoint(handle.point, pageIndex),
    );
    const point = this.overlay.clientToLayer(client);
    if (Math.hypot(point.x - anchor.x, point.y - anchor.y) > HANDLE_GRAB_RADIUS) return null;

    return { centre: selectionCentre(outline.rect) };
  }

  private updateHover(client: Vec2): void {
    const pagePoint = this.viewport.pagePointFromClient(client);
    if (pagePoint === null) {
      this.setHover(null);
      return;
    }
    const pageId = this.pageIdAtClient(client);
    if (pageId === null) {
      this.setHover(null);
      return;
    }
    this.setHover(hitTestPage(this.doc, pageId, pagePoint)?.nodeId ?? null);
  }

  /**
   * Selects every object whose **box** the marquee touches.
   *
   * Box intersection, deliberately, not the shape registry's predicate: a marquee is a
   * rectangular gesture, and every editor selects by bounding box rather than by exact
   * pixels -- otherwise dragging a thin marquee across the corner of an ellipse would
   * skip it, which is surprising rather than precise.
   *
   * ## Why a click never reaches here
   *
   * A press on empty space starts a marquee with a zero-size rect at the click point.
   * A zero-size rect still *overlaps* every box containing that point, so a plain click
   * inside an ellipse's bounding box -- its transparent corner -- selected the ellipse.
   * That made the editor disagree with its own hit testing, and disagree in exactly the
   * place the shape registry exists to get right: `hitNode` correctly refused the point
   * and `applyMarquee` then selected the object anyway.
   *
   * `pointerUp` therefore only applies a marquee the pointer actually dragged, so a click
   * on empty space means what it means everywhere else: clear the selection.
   */
  private applyMarquee(rect: Rect, pageId: string, additive: boolean): void {
    const ids = new Set(additive ? [...this.selection.ids] : []);
    const page = this.doc.pages.find((candidate) => candidate.id === pageId);
    if (page === undefined) {
      this.setSelection({ ...emptySelection(), ids, primary: [...ids][0] ?? null });
      return;
    }
    // Placements, not `page.objects`, for the same reason `hitTestPage` uses them: the region is in
    // page coordinates and a grouped child's own transform is local to its group, so testing it
    // would compare a page rect against a group-local box. A marquee that cannot reach inside a
    // group would be a document you cannot select in.
    for (const placement of placementsOnPage(page)) {
      const node = placement.node;
      // `visible` is deliberately *not* filtered here, unlike in `hitTestPage`. A click is a
      // point gesture and there is nothing to click when an object is not painted; a marquee is
      // a region gesture, and "I drew a box around it" is unambiguous. It is also the only way
      // back: the inspector's `visible` field can hide an object in one click, and an object
      // that cannot be selected cannot be un-hidden, so filtering here would make the field a
      // one-way door.
      //
      // That reasoning now extends to a hidden *group*: a group can hide a subtree, and if a
      // hidden subtree were unreachable by marquee then hiding a group would be a one-way door in
      // exactly the way hiding a leaf is. So the chain is checked, not the leaf alone -- the same
      // `isEffectivelyVisible` rule `hitTestPage` uses, which lives in `selection.ts` rather than
      // being re-derived here.
      //
      // Locked is still excluded. Alt-click reaches a locked object, so locking is a barrier
      // rather than a hiding place, and honouring it here is what makes the two mean different
      // things.
      if (node.locked) continue;
      if (placement.ancestors.some((group) => group.locked)) continue;
      // Painted bounds, not the model frame. This is the same correction as F6: the marquee is a
      // region the user drew *over what they can see*, so it has to test against the object's
      // painted extent. Testing the model frame meant a rotated object could be selected by a region
      // containing none of it -- the identical failure the doc comment above describes for an
      // ellipse's transparent corner, one cause further out.
      //
      // Still box intersection, still not exact pixels: that part of the comment stands, and a thin
      // marquee across a corner still selects. What changed is *which* box, not the strictness.
      //
      // `placement.transform` is the composed one, so the bounds are in page space.
      if (rectsOverlap(rect, paintedBounds(placement.transform))) ids.add(node.id);
    }
    this.setSelection({ ...emptySelection(), ids, primary: [...ids][0] ?? null });
  }

  private removeFromSelection(nodeId: string): void {
    const ids = new Set(this.selection.ids);
    ids.delete(nodeId);
    // Keep a primary as long as anything is selected; a null primary with a non-empty
    // set would make the inspector read "empty" while the overlay shows outlines.
    const primary =
      this.selection.primary !== null && ids.has(this.selection.primary)
        ? this.selection.primary
        : ([...ids][0] ?? null);
    this.setSelection({ ...this.selection, ids, primary });
  }

  /**
   * Wraps the current selection in a group, and selects it.
   *
   * One command, so one undo step. Refuses -- by doing nothing, which `isNoop` turns into no history
   * entry -- when the selection cannot be grouped: fewer than two nodes, or nodes in different parents.
   * The model-level reasons are enumerated at `groupSiblings`, where they are testable.
   *
   * The group's own frame is the transparent one, which is what makes grouping a pure structural move
   * (M12's theorem). It is **not** fitted to the children, and there is no code here that could fit it.
   */
  groupSelection(): void {
    const ids = [...this.selection.ids];
    if (ids.length < 2) return;
    const before = new Set(this.allNodeIds());
    this.store.mutate('Group', () => ({ type: 'group', ids }));
    const created = [...this.allNodeIds()]
      .filter((id) => !before.has(id))
      .find((id) => {
        const node = nodeById(this.doc, id);
        return node !== null && isGroup(node);
      });
    if (created !== undefined) {
      this.setSelection({ ...emptySelection(), ids: new Set([created]), primary: created });
    }
  }

  /** Ungroups each selected group, leaving its children selected. */
  ungroupSelection(): void {
    const ids = [...this.selection.ids].filter((id) => {
      const node = nodeById(this.doc, id);
      return node !== null && isGroup(node);
    });
    if (ids.length === 0) return;
    // What each group held, recorded *before* the command runs, because afterwards the groups are gone.
    const children = ids.flatMap((id) => {
      const node = nodeById(this.doc, id);
      if (node === null || !isGroup(node)) return [];
      return node.children.map((child) => child.id);
    });
    this.store.mutate('Ungroup', () => ({ type: 'ungroup', ids }));
    const survivors = children.filter((id) => nodeById(this.doc, id) !== null);
    this.setSelection(
      survivors.length === 0
        ? emptySelection()
        : { ...emptySelection(), ids: new Set(survivors), primary: survivors[0] ?? null },
    );
    // Ungrouping has consumed the scope the user was in, so leaving it is not optional tidiness.
    this.leaveGroup();
  }

  /**
   * Leaves one level of group scope. `false` when already at page level, so a caller can layer this
   * above an ordinary Escape handler without checking the scope itself.
   */
  leaveGroupScope(): boolean {
    return this.leaveGroup();
  }

  /**
   * Enters the group under the pointer, for a double-click.
   *
   * Returns whether it entered, so a double-click on plain page space can fall through to its ordinary
   * meaning (word selection inside a text session) instead of being swallowed.
   */
  doubleClickGroupEntry(clientX: number, clientY: number): boolean {
    return this.enterGroupFromHit({ x: clientX, y: clientY });
  }

  private enterGroupFromHit(client: Vec2): boolean {
    const pagePoint = this.viewport.pagePointFromClient(client);
    if (pagePoint === null) return false;
    const pageId = this.pageIdAtClient(client);
    if (pageId === null) return false;
    const hit = hitTestPage(this.doc, pageId, pagePoint, { includeLocked: true });
    if (hit === null) return false;
    const location = locateNode(this.doc, hit.nodeId);
    if (location === null) return false;
    const entered = this.enteredGroup;
    if (entered === null) {
      // Enter the outermost group containing the hit, which is the one the user sees as "the group".
      const outermost = location.ancestors[0];
      return outermost === undefined ? false : this.enterGroup(outermost.id);
    }
    if (location.ancestors.some((group) => group.id === entered)) {
      // Enter the group one level deeper than the scope.
      const depth = location.ancestors.findIndex((group) => group.id === entered);
      const next = location.ancestors[depth + 1];
      return next === undefined ? false : this.enterGroup(next.id);
    }
    return this.enterGroup(location.node.id);
  }

  /**
   * Every node id in the document, groups included.
   *
   * `nodeIdsOnPage` deliberately omits groups -- a group is not a painted object. Grouping needs the
   * other list, so this is the one place that answers "every id", and it walks the model rather than
   * asking either traversal to change what it is for.
   */
  private allNodeIds(): string[] {
    const out: string[] = [];
    const visit = (nodes: readonly ModelNode[]): void => {
      for (const node of nodes) {
        out.push(node.id);
        if (isGroup(node)) visit(node.children);
      }
    };
    for (const page of this.doc.pages) visit(page.objects);
    return out;
  }

  /**
 * Drops every asset record no image references, as one undoable command.
 *
 * **Explicit, never automatic** (ADR 0014 §2). Nothing on load, save or delete calls this, because the
 * bytes are history: an implicit sweep would delete them with no undo step to bring them back, which is
 * the exact hazard ADR 0006 named when it deferred collection.
 *
 * Returns how many records were dropped, so the caller can report "nothing to clean up" instead of
 * pretending it did something. A document with nothing to collect makes `apply` return the same
 * reference, `isNoop` true, and no history entry.
 */
pruneUnusedAssets(): number {
  const count = orphanAssetIds(this.doc).length;
  if (count === 0) return 0;
  this.store.mutate('Clean up unused images', () => ({ type: 'pruneAssets' }));
  return count;
}

/**
   * The single place a selection becomes the editor's.
   *
   * Every selection change goes through here -- click, shift-click, marquee, select-all, an undo, and
   * the commands that change what exists -- which is what makes it the right place for the one invariant
   * that has no natural owner anywhere else.
   *
   * ## The invariant
   *
   * **A selection never contains both a node and one of its descendants.**
   *
   * Without it, `group` and `ungroup` become ambiguous in a way that is not a small ambiguity:
   *
   * - grouping `{A, Group[B]}` would take the group *and* a thing inside it, and "the selected nodes
   *   become the group's children" cannot hold for a node that is already inside another group;
   * - ungrouping a selection of `{Group, B}` has no determinate answer, because B's fate depends on
   *   which of the two the user meant;
   * - deleting `{Group, B}` names a node that its own deletion already removed.
   *
   * Normalising to **the outermost** of any ancestor/descendant pair is the only choice that is always
   * defined: the ancestor is what the user can see and act on, and dropping the descendant loses
   * nothing, because every command that could have applied to it also applies to the ancestor.
   *
   * It is enforced here rather than at each producer because "prevent or normalise it explicitly" is
   * only true if there is exactly one door. `selectAll`, the marquee and alt-click all produce
   * selections, and a future producer would otherwise have to remember.
   */
  private setSelection(next: SelectionState): void {
    this.selection = normaliseSelection(this.doc, next);
    this.redrawOverlay();
  }

  /**
   * Drops selected ids that no longer exist, after an undo or redo.
   *
   * Without this, undoing a delete leaves a selection referring to nothing and the
   * overlay draws an outline at the origin.
   */
  private pruneSelection(): void {
    const ids = new Set<string>();
    for (const id of this.selection.ids) {
      if (findNode(this.doc, id) !== null) ids.add(id);
    }
    if (ids.size === this.selection.ids.size) return;

    const keptPrimary = this.selection.primary !== null && ids.has(this.selection.primary);
    this.setSelection({
      ...this.selection,
      ids,
      primary: keptPrimary ? this.selection.primary : ([...ids][0] ?? null),
    });
  }

  /**
   * Which page a client-space point is over, by id.
   *
   * Goes through the viewport's stack coordinates rather than inverting the page
   * transforms, because "which page" is a viewport concern — the viewport owns the
   * gaps, the offsets and the zoom, and re-deriving any of that here is how
   * off-by-a-gap bugs are born.
   */
  private pageIdAtClient(client: Vec2): string | null {
    const stack = this.viewport.stackPointFromClient(client);
    const index = this.viewport.pageIndexAt(stack.y);
    if (index === null) return null;
    return this.doc.pages[index]?.id ?? null;
  }
}

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

/**
 * One merge key for all gestures.
 *
 * Coalescing is already scoped by the transaction (opened on down, closed on up),
 * so a single key cannot accidentally merge two gestures — the boundary guarantees
 * that. A constant is therefore both correct and clearer than encoding the kind.
 */
const GESTURE_KEY = 'gesture';

/** Grab radius in screen px, so handles keep their size at any zoom. */
const HANDLE_GRAB_RADIUS = 6;

/** Distance above the top edge for the rotation handle, in document px. */
const ROTATION_HANDLE_GAP = 24;

/** Minimum object size in document px. */
const MIN_SIZE = 1;

function countLabel(count: number): string {
  return count === 1 ? '1 object' : `${count} objects`;
}

function toRect(transform: Transform2D): Rect {
  return { x: transform.x, y: transform.y, width: transform.width, height: transform.height };
}

function patchAll(transforms: ReadonlyMap<string, Transform2D>): Command {
  return {
    type: 'batch',
    cmds: [...transforms].map(([id, transform]) => ({
      type: 'setTransform',
      ids: [id],
      patch: transform,
    })),
  };
}

function normaliseRect(a: Vec2, b: Vec2): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
}
