/**
 * Text-editing spike harness (docs/ARCHITECTURE.md §10.3).
 *
 * THROWAWAY. This file exists to answer one question:
 *
 *   Can `contenteditable` be fenced so the model stays authoritative outside an
 *   explicit editing session?
 *
 * It drives the *real* renderer — the same `DocumentView`, the same
 * `textFrameRenderer`, the same reconciler the editor uses — so a passing result
 * means something about the real architecture rather than a mock of it.
 *
 * Every state transition is exposed on `window.__spike` so the browser tests can
 * drive and assert the lifecycle deterministically instead of by screenshot.
 */

import './text-spike.css';

import type { Document, RichText, TextFrameNode } from '../model/types';
import {
  createDocument,
  createPage,
  createRectNode,
  createTextFrameNode,
  createTransform,
  richTextToPlain,
} from '../model/factory';
import { DocumentView } from '../render/document-view';
import { TextEditSession } from '../editor/text-edit/text-edit-session';
import { domTextContent } from '../render/rich-text-html';

const PAGE_GAP = 32;

function queryRequired<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`Missing spike element: ${selector}`);
  return element;
}

/** The frame under test: a single text frame with known, distinctive content. */
const INITIAL_TEXT = 'Hello world';

function createSpikeDocument(): Document {
  const page = createPage({ name: '1' });
  page.objects = [
    createTextFrameNode({
      name: 'Spike Text',
      transform: createTransform({ x: 60, y: 80, width: 320, height: 160 }),
      text: {
        blocks: [{ kind: 'paragraph', runs: [{ text: INITIAL_TEXT }] }],
      },
    }),
    // A second frame, so "one frame is fenced, the rest of the document is not"
    // is demonstrable rather than asserted.
    createTextFrameNode({
      name: 'Other Text',
      transform: createTransform({ x: 60, y: 300, width: 320, height: 80 }),
      text: { blocks: [{ kind: 'paragraph', runs: [{ text: 'Untouched' }] }] },
    }),
    createRectNode({
      name: 'Rect',
      transform: createTransform({ x: 60, y: 420, width: 120, height: 60 }),
      shape: { cornerRadius: 4 },
      fill: { type: 'solid', color: '#4f7cff' },
    }),
  ];
  return createDocument({ name: 'Spike', pages: [page] });
}

const state = {
  doc: createSpikeDocument(),
  session: null as TextEditSession | null,
  view: null as DocumentView | null,
  /** Text the model held when the session began, for divergence checks. */
  textAtEntry: '' as string,
};

function frameNode(id: string): TextFrameNode {
  const found = state.doc.pages
    .flatMap((page) => page.objects)
    .find((node) => node.id === id);
  if (found === undefined || found.type !== 'textFrame') {
    throw new Error(`No text frame "${id}"`);
  }
  return found;
}

/** Re-render from the model. Exactly what the real app does on every change. */
function project(): void {
  const view = state.view;
  if (view === null) return;
  view.render(state.doc, PAGE_GAP);
}

/** Replace the text of a frame in the model, immutably. */
function writeModelText(nodeId: string, text: RichText): void {
  state.doc = {
    ...state.doc,
    pages: state.doc.pages.map((page) => ({
      ...page,
      objects: page.objects.map((node) =>
        node.id === nodeId && node.type === 'textFrame' ? { ...node, text } : node,
      ),
    })),
  };
  project();
}

const primaryId = (): string => state.doc.pages[0]!.objects[0]!.id;
const secondaryId = (): string => state.doc.pages[0]!.objects[1]!.id;

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

function enterEdit(): void {
  if (state.session?.isActive === true) return;

  const nodeId = primaryId();
  const element = state.view?.elementFor(nodeId);
  if (element === undefined) throw new Error('Primary frame is not mounted');

  state.textAtEntry = richTextToPlain(frameNode(nodeId).text);

  state.session = TextEditSession.begin(nodeId, element, {
    /*
     * Pinned, not inherited.
     *
     * ADR 0003 flipped `TextEditSession`'s default to `contenteditable="true"`,
     * because `plaintext-only` cannot produce character formatting at all. That is
     * right for the product and wrong for this harness: the spike exists to *measure*
     * `plaintext-only`, and both probes cite it as their evidence
     * (`tests/spike/format-probe.spec.ts`). Letting the mode drift with the default
     * would quietly invalidate ADR 0001 and ADR 0003's own tables.
     *
     * So the spike states the condition it measures. If a future spike wants `true`,
     * that is a new measurement, not a deletion of this one.
     */
    preferPlaintextOnly: true,
    onCommit: (id, text) => {
      /*
       * Order matters, and getting it wrong was a real bug found by the browser
       * tests: clear the fence *first*, then write the model. Writing the model
       * first re-renders while the renderer still believes the frame is being
       * edited, so it withholds the very content we just committed and the frame
       * keeps its stale `data-editing` marker.
       *
       * The real implementation needs this ordering too; it is a rule about the
       * session boundary, not about this harness.
       */
      state.view?.setTextEditing(id, false);
      state.session = null;
      writeModelText(id, text);
      renderPanels('committed');
    },
  });

  // Tell the renderer to stop projecting this frame. This is the fence.
  state.view?.setTextEditing(nodeId, true);
  renderPanels('editing');
}

function exitEdit(): void {
  state.session?.end();
  // `onCommit` already cleared the session; nothing further to do.
  renderPanels('exited');
}

/** Force the document to re-render while a session is active. */
function rerenderWhileEditing(): void {
  project();
  renderPanels('rerendered during edit');
}

// ---------------------------------------------------------------------------
// External mutation (the leak test)
// ---------------------------------------------------------------------------

/** Move the edited frame. Geometry only, so the DOM content should be untouched. */
function externalMove(): void {
  const nodeId = primaryId();
  state.doc = {
    ...state.doc,
    pages: state.doc.pages.map((page) => ({
      ...page,
      objects: page.objects.map((n) =>
        n.id === nodeId
          ? { ...n, transform: { ...n.transform, x: n.transform.x + 40 } }
          : n,
      ),
    })),
  };
  project();
  renderPanels('external: frame moved +40px');
}

/**
 * Rewrite the edited frame's *text* from outside the session.
 *
 * This is the hostile case: the browser owns the DOM, and the model says
 * something different. What should happen is recorded as an observation, not
 * prescribed — that is the question being answered.
 */
function externalText(): void {
  const nodeId = primaryId();
  writeModelText(nodeId, {
    blocks: [{ kind: 'paragraph', runs: [{ text: 'MODEL OVERWROTE' }] }],
  });
  renderPanels('external: model text replaced');
}

/** Hide the edited frame from outside the session. */
function externalHide(): void {
  const nodeId = primaryId();
  state.doc = {
    ...state.doc,
    pages: state.doc.pages.map((page) => ({
      ...page,
      objects: page.objects.map((n) => (n.id === nodeId ? { ...n, visible: false } : n)),
    })),
  };
  project();
  renderPanels('external: frame hidden');
}

// ---------------------------------------------------------------------------
// Instrumentation
// ---------------------------------------------------------------------------

function modelTextOf(nodeId: string): string {
  return richTextToPlain(frameNode(nodeId).text);
}

function domTextOf(nodeId: string): string {
  const element = state.view?.elementFor(nodeId);
  if (element === undefined) return '';
  const content = element.querySelector('.p1-text-content');
  return content === null ? '' : domTextContent(content);
}

function renderPanels(result: string): void {
  const active = state.session?.isActive === true;
  const session = state.session;

  queryRequired('[data-spike-state="active"]').textContent = active ? 'yes' : 'no';
  queryRequired('[data-spike-state="plaintext"]').textContent =
    session === null ? '—' : session.isPlaintextOnly ? 'yes' : 'no (fallback)';
  queryRequired('[data-spike-state="inputs"]').textContent = String(session?.stats.domMutations ?? 0);
  queryRequired('[data-spike-state="beforeinputs"]').textContent = String(
    session?.stats.beforeInputs ?? 0,
  );
  queryRequired('[data-spike-state="compositions"]').textContent = String(
    session?.stats.compositions ?? 0,
  );

  const modelText = modelTextOf(primaryId());
  const domText = domTextOf(primaryId());
  queryRequired('[data-spike-state="inSync"]').textContent =
    modelText === domText ? 'yes' : `no (model="${modelText}" dom="${domText}")`;

  queryRequired('[data-spike-model]').textContent = JSON.stringify(
    { text: modelText, blocks: frameNode(primaryId()).text.blocks.length },
    null,
    2,
  );
  queryRequired('[data-spike-dom]').textContent = domText;
  queryRequired('[data-spike-result]').textContent = result;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function boot(): void {
  const view = new DocumentView({ pages: queryRequired('[data-pages]') });
  state.view = view;
  project();

  const bar = queryRequired('.spike');
  bar.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    switch (target.dataset['spike']) {
      case 'enter':
        enterEdit();
        break;
      case 'exit':
        exitEdit();
        break;
      case 'externalMove':
        externalMove();
        break;
      case 'externalText':
        externalText();
        break;
      case 'externalHide':
        externalHide();
        break;
      default:
        break;
    }
  });

  renderPanels('idle');
}

/**
 * Test surface. Kept small and explicit: the browser tests drive the lifecycle
 * through these rather than through pixel comparisons wherever possible.
 */
declare global {
  interface Window {
    __spike: {
      enterEdit(): void;
      exitEdit(): void;
      rerenderWhileEditing(): void;
      externalMove(): void;
      externalText(): void;
      externalHide(): void;
      primaryId(): string;
      secondaryId(): string;
      modelText(nodeId?: string): string;
      domText(nodeId?: string): string;
      isEditing(): boolean;
      isPlaintextOnly(): boolean;
      compositionActive(): boolean;
      stats(): { domMutations: number; beforeInputs: number; compositions: number };
      domHtml(nodeId?: string): string;
      caretOffset(): number;
      selectionText(): string;
      reset(): void;
    };
  }
}

window.__spike = {
  enterEdit,
  exitEdit,
  rerenderWhileEditing,
  externalMove,
  externalText,
  externalHide,
  primaryId,
  secondaryId,
  modelText: (nodeId) => modelTextOf(nodeId ?? primaryId()),
  domText: (nodeId) => domTextOf(nodeId ?? primaryId()),
  isEditing: () => state.session?.isActive === true,
  isPlaintextOnly: () => state.session?.isPlaintextOnly === true,
  compositionActive: () => state.session?.isComposing === true,
  stats: () =>
    state.session?.stats ?? { domMutations: 0, beforeInputs: 0, compositions: 0 },
  domHtml: (nodeId) => {
    const element = state.view?.elementFor(nodeId ?? primaryId());
    return element?.querySelector('.p1-text-content')?.innerHTML ?? '';
  },
  caretOffset: () => {
    const session = state.session;
    if (session === null) return -1;
    const selection = window.getSelection();
    if (selection === null || selection.rangeCount === 0) return -1;
    const range = selection.getRangeAt(0);
    const probe = range.cloneRange();
    probe.selectNodeContents(session.editableElement);
    probe.setEnd(range.endContainer, range.endOffset);
    return probe.toString().length;
  },
  selectionText: () => window.getSelection()?.toString() ?? '',
  reset: () => {
    state.doc = createSpikeDocument();
    state.session?.end();
    state.session = null;
    state.view?.setTextEditing(primaryId(), false);
    project();
    renderPanels('reset');
  },
};

boot();