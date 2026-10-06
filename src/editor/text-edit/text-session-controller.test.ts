/**
 * @vitest-environment happy-dom
 *
 * The executable form of [ADR 0002](../../../docs/adr/0002-text-undo-composition.md).
 *
 * If any assertion here fails, the ADR is wrong and the decision has to be revisited
 * rather than the code patched to match.
 *
 * ## Why the native undo is faked
 *
 * `nativeUndo` / `nativeRedo` are injected. The real implementation is
 * `document.execCommand('undo')`, which happy-dom does not implement — and even if it
 * did, a *unit* test should not depend on a browser's undocumented undo stack. What is
 * being tested here is the **composition rule**, not Chromium's behaviour: that undo
 * routes to the session while one is open and to the history otherwise. The probes in
 * `tests/spike/undo-probe.spec.ts` cover the browser half against real Chromium.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Document, RichText } from '../../model/types';
import { createDocument, createTextFrameNode, createTransform } from '../../model/factory';
import { DocStore } from '../store/doc-store';
import { TextSessionController } from './text-session-controller';
import type { TextSessionHost } from './text-session-controller';
import { contentOf } from '../../render/types/text-frame';

const TEXT_NODE = 'frame-1';

function makeDoc(text = 'Hello'): Document {
  return createDocument({
    pages: [
      {
        id: 'p1',
        name: 'p1',
        background: { type: 'solid', color: '#ffffff' },
        objects: [
          createTextFrameNode({
            id: TEXT_NODE,
            transform: createTransform({ x: 10, y: 10, width: 200, height: 80 }),
            text: plain(text),
          }),
        ],
      },
    ],
  });
}

const plain = (value: string): RichText => ({
  blocks: [{ kind: 'paragraph', runs: [{ text: value }] }],
});

function modelText(doc: Document, id: string): string {
  for (const page of doc.pages) {
    for (const node of page.objects) {
      if (node.id === id && node.type === 'textFrame') {
        return node.text.blocks.map((block) => block.runs.map((run) => run.text).join('')).join('\n');
      }
    }
  }
  throw new Error(`no text frame ${id}`);
}

/**
 * A host backed by a real DOM element with a real `.p1-text-content` child.
 *
 * Real DOM rather than a mock, because the session reaches for `contenteditable` and
 * reads text back out; a mock would be asserting against a fiction.
 */
function makeHost(store: DocStore, initial = 'Hello') {
  const element = document.createElement('div');
  element.className = 'p1-text-frame';
  const content = document.createElement('div');
  content.className = 'p1-text-content';
  content.textContent = initial;
  element.append(content);
  document.body.append(element);

  const fences: string[] = [];
  const host: TextSessionHost = {
    store,
    elementFor: (nodeId) => (nodeId === TEXT_NODE ? element : undefined),
    setFence: (nodeId, active) => fences.push(`${nodeId}:${active}`),
  };
  return { host, element, content, fences };
}

describe('TextSessionController — ADR 0002 composition', () => {
  let store: DocStore;
  let dom: ReturnType<typeof makeHost>;
  let nativeUndo: ReturnType<typeof vi.fn>;
  let nativeRedo: ReturnType<typeof vi.fn>;
  let controller: TextSessionController;

  beforeEach(() => {
    document.body.replaceChildren();
    store = new DocStore(makeDoc());
    dom = makeHost(store);
    nativeUndo = vi.fn(() => true);
    nativeRedo = vi.fn(() => true);
    controller = new TextSessionController({ host: dom.host, nativeUndo, nativeRedo });
  });

  // ---- session lifecycle ---------------------------------------------------

  it('refuses to begin for a node that is not a text frame', () => {
    expect(controller.begin('frame-1')).toBe(true);
    expect(controller.begin('frame-1')).toBe(false);
  });

  it('marks the fence on entry and clears it on exit, in that order', () => {
    controller.begin(TEXT_NODE);
    expect(controller.isActive).toBe(true);
    expect(dom.fences).toEqual([`${TEXT_NODE}:true`]);

    controller.end();
    expect(controller.isActive).toBe(false);
    expect(dom.fences).toEqual([`${TEXT_NODE}:true`, `${TEXT_NODE}:false`]);
  });

  it('gives the content element to the browser on entry', () => {
    controller.begin(TEXT_NODE);
    expect(dom.content.getAttribute('contenteditable')).not.toBeNull();
  });

  // ---- the commit is exactly one history entry -----------------------------

  it('commits the whole session as a single history entry', () => {
    // Enter, type three times, leave. Each keystroke was the browser's business, but
    // the model learned about all of it at once.
    controller.begin(TEXT_NODE);
    dom.content.textContent = 'Hello world';
    controller.end();

    expect(modelText(store.state, TEXT_NODE)).toBe('Hello world');
    expect(store.undoLabel).toBe('Edit text');

    store.undo();
    expect(modelText(store.state, TEXT_NODE)).toBe('Hello');
    expect(store.canUndo).toBe(false);
  });

  it('records nothing for a session that changed nothing', () => {
    controller.begin(TEXT_NODE);
    controller.end();

    expect(modelText(store.state, TEXT_NODE)).toBe('Hello');
    expect(store.canUndo).toBe(false);
    expect(store.undoLabel).toBeNull();
  });

  it('reports whether the commit changed anything', () => {
    controller.begin(TEXT_NODE);
    expect(controller.end()).toBe(false);

    controller.begin(TEXT_NODE);
    dom.content.textContent = 'changed';
    expect(controller.end()).toBe(true);
  });

  it('redo restores the text after an undo', () => {
    controller.begin(TEXT_NODE);
    dom.content.textContent = 'Hello world';
    controller.end();

    store.undo();
    expect(modelText(store.state, TEXT_NODE)).toBe('Hello');
    store.redo();
    expect(modelText(store.state, TEXT_NODE)).toBe('Hello world');
  });

  // ---- the composition rule ------------------------------------------------

  it('delegates undo to the browser while a session is active', () => {
    controller.begin(TEXT_NODE);
    controller.undo();

    expect(nativeUndo).toHaveBeenCalledTimes(1);
    expect(store.canUndo).toBe(false);
  });

  it('delegates redo to the browser while a session is active', () => {
    controller.begin(TEXT_NODE);
    controller.redo();

    expect(nativeRedo).toHaveBeenCalledTimes(1);
  });

  it('targets the application history once the session has ended', () => {
    controller.begin(TEXT_NODE);
    dom.content.textContent = 'Hello world';
    controller.end();

    controller.undo();
    expect(nativeUndo).not.toHaveBeenCalled();
    expect(modelText(store.state, TEXT_NODE)).toBe('Hello');
  });

  it('labels the action according to where it will land', () => {
    expect(controller.undoLabel()).toBeNull();

    controller.begin(TEXT_NODE);
    expect(controller.undoLabel()).toBe('Undo text');

    dom.content.textContent = 'Hello world';
    controller.end();
    expect(controller.undoLabel()).toBe('Edit text');
  });

  // ---- the lost-write rule -------------------------------------------------

  it('defers an external write to the frame being edited, then replays it', () => {
    controller.begin(TEXT_NODE);
    dom.content.textContent = 'Hello world';
    controller.notifyExternalWrite(TEXT_NODE, { text: plain('from elsewhere') });

    expect(controller.hasDeferredWrite).toBe(true);
    // While the session is open the model still holds the old text.
    expect(modelText(store.state, TEXT_NODE)).toBe('Hello');

    controller.end();

    // The user's in-progress text won, and the deferred write is layered on top of
    // it — two entries, in the order they happened, so undo walks back through both.
    expect(modelText(store.state, TEXT_NODE)).toBe('from elsewhere');

    store.undo();
    expect(modelText(store.state, TEXT_NODE)).toBe('Hello world');

    store.undo();
    expect(modelText(store.state, TEXT_NODE)).toBe('Hello');
  });

  it('discards a deferred write that matches what the session already committed', () => {
    controller.begin(TEXT_NODE);
    dom.content.textContent = 'Hello world';
    controller.notifyExternalWrite(TEXT_NODE, { text: plain('Hello world') });
    controller.end();

    // One entry, not two: the replay would have been a no-op.
    expect(modelText(store.state, TEXT_NODE)).toBe('Hello world');
    store.undo();
    expect(store.canUndo).toBe(false);
  });

  it('ignores an external write to a *different* frame', () => {
    controller.begin(TEXT_NODE);
    controller.notifyExternalWrite('some-other-frame', { text: plain('nope') });
    expect(controller.hasDeferredWrite).toBe(false);
  });

  it('ignores an external write when no session is open', () => {
    controller.notifyExternalWrite(TEXT_NODE, { text: plain('nope') });
    expect(controller.hasDeferredWrite).toBe(false);
  });

  // ---- diagnostics ---------------------------------------------------------

  it('reports the live text the browser holds', () => {
    expect(controller.liveText()).toBeNull();
    controller.begin(TEXT_NODE);
    dom.content.textContent = 'in progress';
    expect(controller.liveText()).toBe('in progress');
  });

  it('reports the node being edited', () => {
    expect(controller.nodeId).toBeNull();
    controller.begin(TEXT_NODE);
    expect(controller.nodeId).toBe(TEXT_NODE);
  });

  it('refuses to begin for a node with no mounted element', () => {
    const bare = new TextSessionController({ host: { ...dom.host, elementFor: () => undefined } });
    expect(bare.begin(TEXT_NODE)).toBe(false);
  });

  it('refuses to begin for an element with no content node', () => {
    const bare = new TextSessionController({ host: { ...dom.host, elementFor: () => document.createElement('div') } });
    expect(bare.begin(TEXT_NODE)).toBe(false);
  });

  it('end is a no-op with no session', () => {
    expect(controller.end()).toBe(false);
    expect(dom.fences).toEqual([]);
  });

  it('reads through the real content lookup, not a hard-coded selector', () => {
    controller.begin(TEXT_NODE);
    expect(contentOf(dom.element)).toBe(dom.content);
  });
});
