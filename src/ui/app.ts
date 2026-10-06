/**
 * Composition root.
 *
 * The wiring order here *is* the dependency graph:
 *
 *   model (plain data)
 *     → DocumentView (DOM projection)
 *     → Viewport (CSS transform)
 *     → Overlay (screen-space editor chrome)
 *     → Editor (selection, gestures, command funnel)
 *
 * The app owns a `DocStore` and nothing else that can change the document. Every
 * mutation — tool drag, inspector field, undo — arrives as a `Command`, so "every
 * change is undoable" is a property of the wiring rather than a habit.
 *
 * Zoom lives entirely in `Viewport`: one CSS transform on the page stack, never the
 * model and never an element's geometry. The `Overlay` sits *outside* that
 * transform, which is what keeps selection strokes 1px at any zoom.
 */

import './styles.css';

import type { Document, ShapeKind } from '../model/types';
import type { RestackDirection } from '../model/commands';
import type { Vec2 } from '../core/geom/mat2d';
import { importImageFile } from '../render/assets';
import { createSampleDocument } from '../model/factory';
import { pageExtentPx } from '../model/page';
import { validateDocument } from '../model/invariants';
import { placementsInDocument } from '../model/tree';
import { formatLength } from '../core/units/units';
import type { PhysicalUnit, Unit } from '../core/units/units';
import { DocumentView } from '../render/document-view';
import { Viewport } from '../editor/viewport/viewport';
import { Overlay } from '../editor/viewport/overlay';
import { DocStore } from '../editor/store/doc-store';
import { Editor } from '../editor/editor';
import { Rulers } from './chrome/ruler';
import { bindShortcuts } from './chrome/shortcuts';
import { bindEditingShortcuts } from './chrome/editing-shortcuts';
import { mountInspector } from './inspector';
import { DocumentSession, browserGateway } from './persistence';
import { createDocument } from '../model/factory';

/**
 * Whether a press landed inside a text frame that is currently being edited.
 *
 * The one place the browser's default behaviour on `pointerdown` is wanted: the caret goes
 * where the user clicked because the browser puts it there.
 */
function isInsideTextSession(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-editing]') !== null;
}

/**
 * Narrows a `data-layer` attribute to the model's `RestackDirection`.
 *
 * A guard rather than a cast, because the attribute comes from markup: a typo in the HTML
 * would otherwise produce a command with a direction the model has never heard of, and the
 * failure would surface as an object that mysteriously did not move.
 */
function isRestackDirection(value: string): value is RestackDirection {
  return RESTACK_DIRECTIONS.includes(value as RestackDirection);
}

const RESTACK_DIRECTIONS: readonly RestackDirection[] = ['forward', 'backward', 'front', 'back'];

function queryRequired<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`Missing required element in the app shell: ${selector}`);
  }
  return element;
}

/** Space between pages, in document px. View state, not document state. */
const PAGE_GAP = 32;

/**
 * The hook the visual test suite injects a fixture through.
 *
 * Exposing the composition root is what lets a test render an arbitrary document
 * through the *real* reconciler instead of a reimplementation, so a fixture cannot
 * pass while the app fails. Read before boot and used in place of the sample.
 */
declare global {
  interface Window {
    __P1_FIXTURE__?: () => Document;
  }
}

function main(): void {
  // Every element lookup first, before anything that might call back into the app.
  //
  // Order matters: `project()` is invoked from `Editor`'s and `Viewport`'s callbacks,
  // and it reads the status-bar and toolbar elements. Declaring them after the first
  // `project()` produced a temporal-dead-zone error that aborted `main()` *after* the
  // renderer was already on screen — so the app looked alive but no event listener
  // was ever attached.
  const viewportRoot = queryRequired<HTMLElement>('[data-viewport]');
  const canvas = queryRequired<HTMLElement>('[data-canvas]');
  const pagesElement = queryRequired<HTMLElement>('[data-pages]');
  const overlayLayer = queryRequired<HTMLElement>('[data-overlay]');
  const zoomReadout = queryRequired<HTMLOutputElement>('[data-zoom-readout]');
  const stackStat = queryRequired<HTMLElement>('[data-stat="stack"]');
  const nodeStat = queryRequired<HTMLElement>('[data-stat="nodes"]');
  const statusZoom = queryRequired<HTMLElement>('[data-zoom-status]');
  const statusPoint = queryRequired<HTMLElement>('[data-status="point"]');
  const statusPage = queryRequired<HTMLElement>('[data-status="page"]');
  const undoButton = queryRequired<HTMLButtonElement>('[data-edit="undo"]');
  const redoButton = queryRequired<HTMLButtonElement>('[data-edit="redo"]');
  const docName = queryRequired<HTMLElement>('[data-stat="name"]');
  const docState = queryRequired<HTMLElement>('[data-doc-state]');
  const docMessage = queryRequired<HTMLElement>('[data-doc-message]');
  const documentInput = queryRequired<HTMLInputElement>('[data-file-input="document"]');

  /**
   * The tool buttons, collected once.
   *
   * Queried from the DOM rather than enumerated in code so that a kind added to the
   * registry gets its button from the same place as every other button — the HTML shell
   * is the list, and `model/shapes.ts` remains the only definition of what a kind is.
   */
  const toolButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-tool], [data-shape]')];

  /**
   * The layer-order buttons, collected once.
   *
   * Queried from the DOM for the same reason the tool buttons are: the markup is the list, so
   * adding a direction is a button rather than an edit in three places. The direction itself
   * comes from `data-layer` and is checked against the model's own union, so a typo in the
   * markup cannot reach a command.
   */
  const layerButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-layer]')];

  const imageInput = queryRequired<HTMLInputElement>('[data-file-input="image"]');

  const store = new DocStore(window.__P1_FIXTURE__?.() ?? createSampleDocument());

  /**
   * The document, read from the store on every use rather than mirrored locally.
   *
   * A cached copy would be one more thing to forget to invalidate, and getting it
   * wrong is silent — chrome quietly showing the previous document. One line of
   * indirection removes the whole class of bug.
   */
  const doc = (): Document => store.state;

  const view = new DocumentView({ pages: pagesElement });

  const viewport = new Viewport(
    { root: viewportRoot, canvas, pages: pagesElement },
    {
      onChange: (state) => {
        zoomReadout.value = `${Math.round(state.zoom * 100)}%`;
        rulers?.scheduleDraw();
        // Zoom moves the pages but not the overlay, so chrome must be redrawn.
        editor?.redrawOverlay();
      },
    },
  );

  const overlay = new Overlay(
    { layer: overlayLayer, viewport: viewportRoot },
    {
      toClient: (pageId, point) => {
        const index = doc().pages.findIndex((page) => page.id === pageId);
        return viewport.clientFromPagePoint(point, index);
      },
    },
  );

  const editor = new Editor({
    store,
    viewport,
    overlay,
    // Selection and hover change no document state, so they refresh chrome only.
    // Document changes arrive through the store subscription below, which is the one
    // path that re-projects. Splitting them is what stops a click on the background
    // from re-running the reconciler.
    onChange: () => refreshChrome(),
  });

  const rulers = new Rulers(
    {
      horizontal: queryRequired<HTMLCanvasElement>('[data-ruler-horizontal]'),
      vertical: queryRequired<HTMLCanvasElement>('[data-ruler-vertical]'),
      corner: queryRequired<HTMLElement>('[data-ruler-corner]'),
    },
    viewport,
    { unit: doc().pageSize.unit as Unit },
  );

  const inspector = mountInspector(
    queryRequired<HTMLElement>('[data-inspector]'),
    editor,
    store,
    () => doc().pageSize.unit as PhysicalUnit,
  );

  /**
   * The text-session host.
   *
   * `elementFor` and `setFence` both delegate to `DocumentView`, so the renderer
   * stays the only thing that touches the document DOM. `Editor` never learns how
   * the fence is implemented — it only asks for it.
   */
  editor.attachTextSessions({
    store,
    elementFor: (nodeId) => view.elementFor(nodeId),
    setFence: (nodeId, active) => view.setTextEditing(nodeId, active),
  });

  /**
   * The document lifecycle: dirty state, save, open, new.
   *
   * Created here rather than inside `Editor` because it is not editing: it is a file
   * boundary plus a derived read over the store. The one editing thing it needs is "commit
   * any open text session", which is why `editor` is passed rather than the editor itself --
   * `DocumentSession` must not depend on the editor for a rule that is really about the
   * fence (ADR 0001).
   */
  const documentSession = new DocumentSession(
    store,
    browserGateway({ openInput: documentInput }),
    // Saving serialises what is in the model, and the browser owns the editing subtree
    // until the session ends, so the session is closed first. See `DocumentSession`.
    () => {
      editor.endTextEdit();
    },
  );

  /** Project the current model into the DOM, then tell the viewport the extent. */
  function project(): void {
    const current = doc();

    const violations = validateDocument(current);
    if (violations.length > 0) {
      console.error('Document invariant violations:', violations);
    }

    // `DocumentView` already knows which node the fence covers — the controller
    // marks it through `setTextEditing`. The render call therefore needs no hint.
    view.render(current, PAGE_GAP);

    const page = pageExtentPx(current.pageSize);
    viewport.setContent(
      {
        pageWidth: page.width,
        pageHeight: page.height,
        pageCount: current.pages.length,
      },
      PAGE_GAP,
    );

    stackStat.textContent =
      `${current.pages.length}× ${current.pageSize.width}×${current.pageSize.height} ${current.pageSize.unit}`;
    // Leaves, not `page.objects.length`. A group has no visual form of its own, so counting it as an
    // object would report "3 objects" for a page holding two shapes inside one group -- and the
    // number is a *document* statement ("how much is in here"), which a container is not. The
    // traversal is the same one the renderer uses, so the count and the painted stack cannot
    // disagree about what exists.
    const objectCount = placementsInDocument(current).length;
    nodeStat.textContent = `${objectCount} ${objectCount === 1 ? 'object' : 'objects'}`;
    rulers.draw();
    refreshChrome();
  }

  /** Everything that reflects state without owning it: overlay, inspector, buttons. */
  function refreshChrome(): void {
    editor.redrawOverlay();
    inspector.sync();
    syncHistoryButtons();
    syncToolButtons();
    syncDocumentChrome();
    syncLayerButtons();
  }

  /**
   * The document name, the dirty indicator, and the last failure.
   *
   * The indicator reads `DocumentSession.isDirty`, which compares canonical authored state
   * against the last saved state. Nothing here consults the DOM, the viewport, the selection
   * or a pending measurement -- so scrolling, zooming, selecting and hovering all leave it
   * alone, which is the property that makes it worth having.
   */
  function syncDocumentChrome(): void {
    const dirty = documentSession.isDirty;
    docName.textContent = documentSession.filename;
    docState.textContent = dirty ? 'Unsaved changes' : 'Saved';
    docState.dataset['dirty'] = String(dirty);
    docState.title = dirty
      ? 'This document has changes that are not in any file'
      : 'Identical to the last saved or opened document';

    const error = documentSession.error;
    docMessage.textContent = error === null ? '' : `Could not open: ${error}`;
    docMessage.dataset['error'] = String(error !== null);
  }

  /**
   * Runs a save or an open and reports the outcome.
   *
   * Asynchronous because the gateway is: a download is one tick, a future native picker is
   * not. The chrome is refreshed on completion rather than before, because that is when the
   * baseline has actually moved.
   */
  async function withDocumentFeedback(action: () => Promise<'saved' | 'cancelled'>): Promise<void> {
    await action();
    // Refreshed in *both* cases. On success the baseline moved; on a refusal the message
    // changed, and a status bar that kept reporting the previous state would leave a user
    // who picked the wrong file with no idea anything happened. Cancelling the dialog is
    // harmless: nothing changed, so there is nothing new to show.
    syncDocumentChrome();
  }

  /**
   * Replaces the document with an empty one.
   *
   * Asks first when there is unsaved work, because there is no autosave in this milestone
   * and `reset` discards the undo stack along with the document. The prompt is a plain
   * `confirm`: it is the one case where interrupting the user is the right behaviour, and
   * it needs no machinery to explain.
   */
  function newDocument(): void {
    if (documentSession.isDirty) {
      const discard = window.confirm(
        'This document has unsaved changes. Discard them and start a new document?',
      );
      if (!discard) return;
    }
    documentSession.resetTo(createDocument({ name: 'Untitled' }));
  }

  /**
   * The single re-projection path.
   *
   * Subscribing to the store rather than having each caller remember to re-render is
   * what makes "every change is undoable *and* visible" true by construction. When
   * the inspector committed a field without this, the model changed and nothing on
   * screen did — a silent divergence that only undo exposed.
   */
  store.subscribe(() => project());

  /**
   * Buttons mirror the editor's *effective* target, not the store's.
   *
   * During a text session the history is the browser's, which reports neither
   * `canUndo` nor a label — so asking the editor is the only way the buttons can be
   * honest. Leaving them enabled is deliberate: a delegated undo against an empty
   * browser stack is a no-op, which is also what the keyboard does.
   */
  function syncHistoryButtons(): void {
    const undo = editor.undoLabel();
    const redo = editor.redoLabel();
    const inTextSession = editor.currentMode === 'textEdit';

    undoButton.textContent = undo === null ? 'Undo' : `Undo ${undo}`;
    redoButton.textContent = redo === null ? 'Redo' : `Redo ${redo}`;
    undoButton.title = `Undo ${undo ?? ''} (Ctrl+Z)`.trim();
    redoButton.title = `Redo ${redo ?? ''} (Ctrl+Shift+Z)`.trim();
    undoButton.disabled = undo === null && !inTextSession;
    redoButton.disabled = redo === null && !inTextSession;
  }

  /**
   * The tool buttons mirror the editor's armed tool.
   *
   * Read from `Editor` rather than tracked here, so the buttons cannot claim a tool is
   * armed when the editor has disarmed it — the failure mode of a second copy of this
   * state is a button that looks pressed and a click that selects instead of drawing.
   */
  function syncToolButtons(): void {
    const armed = editor.armedShapeKind;
    for (const button of toolButtons) {
      const kind = button.dataset['shape'];
      const isArmed = kind === undefined ? armed === null : armed === kind;
      button.setAttribute('aria-pressed', String(isArmed));
      button.classList.toggle('is-active', isArmed);
    }
  }

  /**
   * Marks the layer buttons unavailable when there is nothing to restack.
   *
   * Only the empty case. Whether a *particular* move can change anything is the model's
   * no-op rule, and predicting it here would be a second copy of that rule that could
   * disagree with it -- the exact failure mode of a separate `zIndex`. So the buttons are
   * honest about "nothing is selected" and silent about everything else, and the model's
   * `isNoop` handles the rest.
   */
  function syncLayerButtons(): void {
    const empty = editor.selectionState.ids.size === 0;
    for (const button of layerButtons) {
      button.setAttribute('aria-disabled', String(empty));
    }
  }

  // ---- initial paint -------------------------------------------------------
  project();
  viewport.fit();
  viewport.observeResize();
  statusZoom.textContent = `${Math.round(viewport.zoom * 100)}%`;

  // Delegated on the document, not the buttons: the label text is inside the
  // button, so `event.target` is usually a text node's element, not the button.
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const edit = target.dataset['edit'];
    if (edit === 'undo') {
      editor.undo();
      return;
    }
    if (edit === 'redo') {
      editor.redo();
      return;
    }

    // Tools. `data-shape` carries the registry discriminator, so arming a tool and
    // creating an object both resolve through `model/shapes.ts` — there is no list
    // of kinds in the UI layer that could fall out of step with the one in the model.
    if (target.dataset['tool'] === 'select') {
      editor.disarmDrawTool();
      return;
    }
    const shape = target.dataset['shape'];
    if (shape !== undefined) {
      editor.armDrawTool(shape as ShapeKind);
      return;
    }

    if (target.dataset['import'] === 'image') {
      imageInput.click();
      return;
    }

    const layer = target.dataset['layer'];
    if (layer !== undefined && isRestackDirection(layer)) {
      editor.restack(layer);
      return;
    }

    const documentAction = target.dataset['doc'];
    if (documentAction === 'new') {
      newDocument();
      return;
    }
    if (documentAction === 'open') {
      // A pure trigger: the `change` listener below opens the document. Routing the open
      // through the input's event rather than through the click is what makes the button and
      // any other way of choosing a file -- a drop target, a test, a future paste handler --
      // go through exactly one path.
      documentInput.click();
      return;
    }
    if (documentAction === 'save') {
      void withDocumentFeedback(() => documentSession.save());
      return;
    }

    const action = target.dataset['zoom'];
    if (action === undefined) return;

    switch (action) {
      case 'in':
        viewport.zoomIn();
        break;
      case 'out':
        viewport.zoomOut();
        break;
      case 'fit':
        viewport.fit();
        break;
      case 'actual':
        viewport.zoomToActualSize();
        break;
      default:
        break;
    }
  });

  /**
   * Where an inserted image lands.
   *
   * The centre of the visible viewport area, expressed in page-local document px of the
   * page under it — so it is correct at any zoom and any scroll position, because it is
   * derived from the live viewport rather than from a stored offset.
   *
   * `pagePointFromClient` returns a bare `Vec2` with no page id, so the page is recovered
   * separately from `pageIndexAt` over the same stack point. Both are queried once, and
   * from the *same* client point, so the coordinate and the page can never disagree about
   * which page they describe.
   */
  function imageDropPoint(): { pageId: string; at: Vec2 } | null {
    const pages = doc().pages;
    if (pages.length === 0) return null;

    const box = viewportRoot.getBoundingClientRect();
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    const stack = viewport.stackPointFromClient(centre);
    const index = viewport.pageIndexAt(stack.y);
    const page = index === null ? undefined : pages[index];
    if (page !== undefined) {
      const point = viewport.pagePointFromClient(centre);
      if (point !== null) return { pageId: page.id, at: point };
    }

    // The viewport centre is in a gap or past the ends of the stack. The focused page's
    // own centre is always somewhere sensible to put an object, so fall back to it rather
    // than refusing the insert.
    const focused = pages[viewport.focusedPageIndex];
    if (focused === undefined) return null;
    const size = pageExtentPx(doc().pageSize);
    return { pageId: focused.id, at: { x: size.width / 2, y: size.height / 2 } };
  }

  /**
   * Decodes the picked file and inserts it.
   *
   * The decode happens **before** any command, and a failure produces **no document
   * change at all**. That ordering is the contract, not a detail: `decode()` rejects on
   * data that is not a decodable image, so a file that cannot be shown never becomes an
   * asset, never becomes a node, and never leaves a dangling reference behind.
   */
  imageInput.addEventListener('change', () => {
    const file = imageInput.files?.[0];
    // Reset first: without it, picking the same file twice in a row fires no `change`
    // event, and the second attempt would silently do nothing.
    imageInput.value = '';
    if (file === undefined) return;

    const target = imageDropPoint();
    if (target === null) return;

    void importImageFile(file, file.name)
      .then((imported) => {
        editor.insertImage({
          pageId: target.pageId,
          at: target.at,
          mime: imported.mime,
          intrinsicWidth: imported.intrinsicWidth,
          intrinsicHeight: imported.intrinsicHeight,
          inline: imported.inline,
        });
      })
      .catch((error: unknown) => {
        // Reported rather than swallowed: a silently ignored "Image" button is
        // indistinguishable from a broken one.
        reportImportFailure(error);
      });
  });

  function reportImportFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[p1] image import failed: ${message}`);
    statusPage.textContent = `Image import failed — ${message}`;
    statusPage.dataset['error'] = 'true';
  }

  /**
   * Opens whatever file the document input is holding.
   *
   * The single owner of that input's `change` event, which is what makes the Open button a
   * bare trigger. `session.open()` takes no arguments and reads the gateway, so a refusal is
   * reported by the same chrome as a successful open.
   */
  documentInput.addEventListener('change', () => {
    void withDocumentFeedback(() => documentSession.open());
  });

  // The pointer readout is the visible proof that document and screen coordinates
  // are separate spaces: it shows the page-local document position, while the
  // viewport internally works in client and stack coordinates.
  viewportRoot.addEventListener('pointermove', (event) => {
    const unit = doc().pageSize.unit as Unit;
    const client = { x: event.clientX, y: event.clientY };

    // Classify first, then read coordinates. `pagePointFromClient` returns null for
    // *any* point not on a page — the inter-page gap as well as past the ends of
    // the stack — so the two cases have to be distinguished before deciding what to
    // report. Asking the page index first is what makes that possible.
    const stack = viewport.stackPointFromClient(client);
    const index = viewport.pageIndexAt(stack.y);
    const label = index === null ? 'gap' : `page ${index + 1}`;
    statusPage.textContent = label;

    const point = index === null ? null : viewport.pagePointFromClient(client);
    statusPoint.textContent = point === null ? '—' : `${formatLength(point.x, unit)}, ${formatLength(point.y, unit)}`;
  });

  // Losing the window ends any gesture in flight, for the same reason `pointercancel` does: the
  // pointer is not coming back, and a gesture left open holds the capture forever with no event
  // that could end it. Alt-tabbing or clicking the devtools mid-drag is ordinary, not exotic.
  window.addEventListener('blur', () => {
    if (viewport.isSpacePanning) viewport.setSpacePanning(false);
    editor.cancelGesture();
  });

  // ---- keyboard shortcuts --------------------------------------------------
  bindShortcuts({
    viewport,
    onZoomChanged: () => {
      statusZoom.textContent = `${Math.round(viewport.zoom * 100)}%`;
    },
    // Save has a shortcut because a document you cannot save quickly is a document you will
    // lose. It goes through the same path as the button, including the text-session commit.
    onSave: () => {
      void withDocumentFeedback(() => documentSession.save());
    },
    onRestack: (direction) => {
      editor.restack(direction);
    },
  });
  bindEditingShortcuts({ editor });

  // ---- pointer gestures ----------------------------------------------------
  //
  // Bound on the viewport root rather than the overlay, because the overlay is
  // `pointer-events: none` — every pointer event reaching the document passes
  // through it and arrives here.
  viewportRoot.addEventListener('pointerdown', (event) => {
    // Middle-drag and space-drag belong to the viewport, not to selection.
    if (event.button === 1 || viewport.isSpacePanning) return;
    if (event.button !== 0) return;

    // The browser must not start a selection or a native drag of its own while an editor
    // gesture is in flight.
    //
    // This is not tidiness. When a press also begins a native selection, Chromium answers by
    // firing `pointercancel` and then delivering *no further events for that pointer* -- so
    // the gesture cannot continue and cannot finish. It was reproducible on every attempt:
    // shift-click to add a second object, then drag, and only the first `pointermove` of the
    // drag ever arrived, leaving the objects a third of the way across and the editor stuck
    // mid-gesture.
    //
    // Skipped inside a frame being edited, where the browser's default is precisely what puts
    // the caret where the user clicked.
    if (!isInsideTextSession(event.target)) event.preventDefault();

    viewportRoot.setPointerCapture(event.pointerId);
    editor.pointerDown(event);
  });

  // Double-click enters a group, so its children become directly selectable.
  //
  // Reuses `pointerdown`'s hit test rather than adding a second one: `enterGroupFromHit` is given the
  // hit this pointerdown already found, which is the only reason `pointerDown` returns early here.
  // Nothing about hit testing changes -- `hitTestPage` is still the one recursive path, and still
  // answers only "what is painted here".
  viewportRoot.addEventListener('dblclick', (event) => {
    if (event.button !== 0) return;
    // Inside a live text session the browser's own double-click (word selection) is the whole point,
    // so group entry must not swallow it.
    if (isInsideTextSession(event.target)) return;
    editor.doubleClickGroupEntry(event.clientX, event.clientY);
  });

  // A pointer the browser takes back. `pointercancel` means the interaction ended without the
  // user finishing it, and the pointer is finished: no further `pointermove`, no `pointerup`.
  // Without this the editor sits in a `move` or `resize` gesture forever, holding the capture.
  viewportRoot.addEventListener('pointercancel', (event) => {
    if (viewportRoot.hasPointerCapture(event.pointerId)) {
      viewportRoot.releasePointerCapture(event.pointerId);
    }
    editor.cancelGesture();
  });

  // Called for both hover and drag: `Editor.pointerMove` distinguishes them by
  // whether a gesture is in flight, so one listener serves both.
  viewportRoot.addEventListener('pointermove', (event) => {
    editor.pointerMove(event);
  });

  viewportRoot.addEventListener('pointerup', (event) => {
    if (event.button === 1 || viewport.isSpacePanning) return;
    if (viewportRoot.hasPointerCapture(event.pointerId)) {
      viewportRoot.releasePointerCapture(event.pointerId);
    }
    editor.pointerUp(event);
  });
}

main();
