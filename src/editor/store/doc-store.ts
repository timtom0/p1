/**
 * `DocStore` — the document, its history, and the single write path (§4.1/§4.2).
 *
 * Everything that mutates the document goes through `dispatch` or `mutate`. There
 * is no other way in, which is what makes "every change is undoable" a property of
 * the architecture rather than a convention.
 *
 * Deliberately minimal: no observables, no reactive wrappers, no middleware. The
 * renderer is told when to reconcile, and the UI is told when to redraw. When a
 * real need for derived-state caching appears, that is the moment to add it —
 * speculating here would be the "infrastructure for features that don't exist"
 * mistake.
 */

import type { Document } from '../../model/types';
import type { Command } from '../../model/commands';
import type { DispatchOptions, TransactionOptions } from '../history';
import { isNoop } from '../../model/commands';
import { History } from '../history';

export type DocStoreListener = (doc: Document) => void;

export class DocStore {
  private doc: Document;
  private readonly history: History;
  private readonly listeners = new Set<DocStoreListener>();

  constructor(initial: Document) {
    this.doc = initial;
    this.history = new History();
  }

  get state(): Document {
    return this.doc;
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  get undoLabel(): string | null {
    return this.history.undoLabel;
  }

  get redoLabel(): string | null {
    return this.history.redoLabel;
  }

  /** Subscribes to document changes. Returns an unsubscribe function. */
  subscribe(listener: DocStoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Applies a command, recording it for undo. */
  dispatch(command: Command, options: DispatchOptions = {}): void {
    const { doc } = this.history.dispatch(this.doc, command, options);
    this.commit(doc);
  }

  /**
   * Applies a command as one undo entry under a caller-chosen label.
   *
   * The label goes in with the dispatch rather than being applied afterwards, so
   * subscribers see the final label. Relabelling after the fact means the first
   * notification carries the derived label and the corrected one never arrives.
   */
  mutate(label: string, build: () => Command): void {
    const command = build();
    if (isNoop(this.doc, command)) return;
    this.dispatch(command, { label });
  }

  /**
   * Records a change discovered rather than dispatched — the text session's path.
   *
   * Kept separate from `dispatch` because the discovery is asymmetric: the DOM was
   * authoritative, and we only learn what changed when the session ends.
   */
  commitExternal(next: Document, command: Command, label?: string): void {
    this.commit(this.history.commitExternal(this.doc, next, command, label));
  }

  beginTransaction(options: TransactionOptions): void {
    this.history.begin(this.doc, options);
  }

  endTransaction(): void {
    this.history.end();
  }

  /**
   * Rolls the open transaction back, discarding everything it did.
   *
   * Distinct from `endTransaction`, which *commits*. Escape on a drag wants this one.
   */
  abortTransaction(): void {
    const restored = this.history.abort();
    if (restored !== null) this.commit(restored);
  }

  undo(): void {
    this.commit(this.history.undo(this.doc));
  }

  redo(): void {
    this.commit(this.history.redo(this.doc));
  }

  /** Replaces the document without recording history. Used on open/new. */
  reset(doc: Document): void {
    this.history.clear();
    this.commit(doc);
  }

  private commit(doc: Document): void {
    if (doc === this.doc) return;
    this.doc = doc;
    for (const listener of this.listeners) listener(doc);
  }
}