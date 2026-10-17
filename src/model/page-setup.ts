/**
 * Page setup: the document-level answer to "how big is a page, and what happens when it changes?".
 *
 * ## Why this is a document field and not a mode on the page
 *
 * Page *dimensions* live on `Page.size`, always, and every page carries its own — there is no
 * shared-size variant of `Page` and no document-wide size. That is the whole model change, and it is
 * what makes a mixed-size document representable at all.
 *
 * What lives here instead is a smaller, different thing: **what a newly created page should be**, and
 * **what should happen to content when an existing page is resized**. Both are authoring defaults. A
 * document with `fixedSize: true` still permits an individual page to be resized — doing so simply
 * means the next "add page" no longer continues from what the user just did.
 *
 * That distinction is the reason there is no `Page.size | SharedPageSize` union here. A union would
 * make "all pages are the same" a *structural* property that every consumer must branch on, and the
 * renderer, the viewport, hit-testing and the print profile would each grow a "is this shared?" path
 * for a case that only ever affects one decision: what size to give the next page.
 *
 * ## Why `PageSetup` is in the model at all
 *
 * Because it is authored, persistent state, and therefore history. Changing the default page size of
 * a document is an undoable edit like any other; keeping it in view state would make a document
 * reopen with different pages than the ones it was saved with.
 *
 * See ADR 0019 for the decision, the compatibility strategy, and the PDF implications.
 */

import { DEFAULT_MEASUREMENT_UNIT } from '../core/units/units';
import type { MeasurementUnit } from '../core/units/units';
import type { Orientation, PageSize } from './types';

/**
 * What happens to a page's objects when that page is resized.
 *
 * - `crop` — nothing moves. Content keeps its document coordinates, so anything now outside the page
 *   box is simply outside it. **The default**, because it is the only option that never modifies
 *   authored content without being asked to.
 * - `scale` — every object is scaled proportionally about the page origin so the previous content
 *   fits the new box. Lossy for rotated and non-uniformly scaled objects, and therefore opt-in.
 * - `push` — objects that no longer fit move to the next page, creating one if there is none. This is
 *   the publishing "reflow" behaviour; it is opt-in because it *moves content between pages*, which
 *   changes two pages in one edit.
 *
 * `crop` is the default for the same reason `fixedSize` is: the behaviour that does nothing is the one
 * that cannot surprise anybody.
 */
export type PageResizeBehaviour = 'crop' | 'push' | 'scale';

export const PAGE_RESIZE_BEHAVIOURS: readonly PageResizeBehaviour[] = ['crop', 'push', 'scale'];

export interface PageSetup {
  /**
   * The unit every **measurement field** in this document is shown and typed in. M24.
   *
   * ## What it is not
   *
   * It is not the internal unit (that is CSS `px`, for every document), and it is **not**
   * {@link PageSize.unit}. A page's unit says what its dimensions are *written in*, and it is
   * per-page, and `printSheetSize` reads it to emit `@page { size: 210mm 297mm }` -- so a Letter
   * page in a millimetre document is an ordinary document rather than a contradiction. This field
   * says what a measurement field in the inspector, a ruler tick or a pointer readout means when
   * the user types a bare number into it.
   *
   * Those are two questions and M24 exists to stop them being answered by the same field. Before it,
   * `app.ts` derived the display unit from the *focused page*, which meant a mixed-unit document
   * changed its ruler units as the user scrolled and had no unit of its own to persist.
   *
   * ## Defaults
   *
   * `mm`, because `DEFAULT_PAGE_PRESET` has been A4-in-millimetres since before the format existed.
   * That makes the default unobservable: a document created with no explicit unit, and a pre-v6 file
   * that migrates, both keep the page dimensions they always had.
   *
   * ## Changing it
   *
   * Changes interpretation and display, and **nothing else**. No stored number is reinterpreted and
   * no page's `unit` is touched, because the stored numbers are px and px does not depend on this.
   */
  unit: MeasurementUnit;
  /**
   * When true, a newly added page always takes {@link defaultSize}.
   *
   * When false, it copies the size of the page it was added from — or `defaultSize` if there is no
   * such page. Either way the *page* records its own `size`; this only decides what gets written.
   */
  fixedSize: boolean;
  /**
   * The size a new document's pages start at, and the size used whenever `fixedSize` is true.
   *
   * Kept even when `fixedSize` is false, because it is the fallback when adding to an empty document
   * and it is what the document-setup panel edits.
   */
  defaultSize: PageSize;
  /** Applies when an existing page is resized. Never applied to a newly created page. */
  resizeBehaviour: PageResizeBehaviour;
}

/**
 * A named paper size.
 *
 * Dimensions are the **portrait** ones; `orientation` on the `PageSize` does the swapping. Storing
 * A4 landscape as `297×210mm` instead would make `orientation` a second, contradictory answer to the
 * same question, and `pageSizeToPx` is already the single place that knows what orientation means.
 *
 * Units are the paper's own — Letter is authored in inches, A4 in millimetres — because a document
 * authored in millimetres must print as `210mm 297mm` and one authored in inches as `8.5in 11in`.
 * Converting Letter to millimetres would round-trip to `215.9mm`-shaped output that is not what any
 * press expects.
 */
export interface PageSizePreset {
  readonly id: string;
  readonly label: string;
  readonly size: PageSize;
}

function portrait(width: number, height: number, unit: 'mm' | 'in'): PageSize {
  return { width, height, unit, orientation: 'portrait' };
}

/**
 * The preset a new document uses when nothing else is chosen.
 *
 * Named rather than `PAGE_SIZE_PRESETS[0]` because the array is `readonly` and the project compiles
 * with `noUncheckedIndexedAccess`, so indexing it yields `T | undefined` — and a default that can be
 * `undefined` is not a default.
 */
export const DEFAULT_PAGE_PRESET: PageSizePreset = { id: 'a4', label: 'A4', size: portrait(210, 297, 'mm') };

/**
 * The presets offered at document creation.
 *
 * ISO A series plus the three North American sizes that actually appear in publishing briefs, and B5
 * because the Japanese and Nordic trade formats are sized from it rather than from A5.
 *
 * **A4 is first and is the default**, which is what `createDocument` used before this milestone, so a
 * document created with no arguments keeps the same page dimensions it always had.
 */
export const PAGE_SIZE_PRESETS: readonly PageSizePreset[] = Object.freeze([
  DEFAULT_PAGE_PRESET,
  { id: 'a3', label: 'A3', size: portrait(297, 420, 'mm') },
  { id: 'a5', label: 'A5', size: portrait(148, 210, 'mm') },
  { id: 'b5', label: 'B5', size: portrait(176, 250, 'mm') },
  { id: 'letter', label: 'Letter', size: portrait(8.5, 11, 'in') },
  { id: 'legal', label: 'Legal', size: portrait(8.5, 14, 'in') },
  { id: 'tabloid', label: 'Tabloid', size: portrait(11, 17, 'in') },
]);

/** A defensive copy, so a caller mutating the result cannot corrupt the frozen preset table. */
export function clonePageSize(size: PageSize): PageSize {
  return { width: size.width, height: size.height, unit: size.unit, orientation: size.orientation };
}

export function createPageSetup(init: Partial<PageSetup> = {}): PageSetup {
  return {
    fixedSize: true,
    resizeBehaviour: 'crop',
    unit: DEFAULT_MEASUREMENT_UNIT,
    ...init,
    // Placed last and cloned rather than spread, for two reasons. It must win over `init` so the
    // default is always a copy this document owns; and the preset table is frozen while a caller's
    // literal is not, so keeping the reference would let an inspector edit the default in place and
    // change every page created afterwards.
    defaultSize: clonePageSize(init.defaultSize ?? DEFAULT_PAGE_PRESET.size),
  };
}

/** Value equality for page sizes. Orientation participates: A4 portrait is not A4 landscape. */
export function pageSizesEqual(a: PageSize, b: PageSize): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.unit === b.unit &&
    a.orientation === b.orientation
  );
}

/** The same page flipped between portrait and landscape. */
export function flippedSize(size: PageSize): PageSize {
  return {
    ...size,
    orientation: size.orientation === 'portrait' ? 'landscape' : 'portrait',
  };
}

/** Looks up a preset by id, or `null`. Used by the deserializer to name a loaded document's size. */
export function findPageSizePreset(size: PageSize): PageSizePreset | null {
  return (
    PAGE_SIZE_PRESETS.find(
      (preset) =>
        preset.size.width === size.width &&
        preset.size.height === size.height &&
        preset.size.unit === size.unit,
    ) ?? null
  );
}

/**
 * The smallest and largest page edge this build accepts, in the size's own unit.
 *
 * A bound rather than a bare `> 0` because a page 0.01mm across is arithmetically valid, renders as
 * nothing, and produces a PDF sheet no printer can accept — a document that opens and looks broken
 * is worse than one that is refused with a message naming the offending field.
 */
export const MIN_PAGE_EDGE = 1;
export const MAX_PAGE_EDGE = 5000;

/** Returns an error message, or `null` when the size is usable. Shared by the model and the parser. */
export function pageSizeProblem(size: PageSize): string | null {
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) {
    return 'page size must be finite';
  }
  if (size.width < MIN_PAGE_EDGE || size.width > MAX_PAGE_EDGE) {
    return `page width must be between ${MIN_PAGE_EDGE} and ${MAX_PAGE_EDGE} ${size.unit}, got ${size.width}`;
  }
  if (size.height < MIN_PAGE_EDGE || size.height > MAX_PAGE_EDGE) {
    return `page height must be between ${MIN_PAGE_EDGE} and ${MAX_PAGE_EDGE} ${size.unit}, got ${size.height}`;
  }
  return null;
}

/** The size a new page should get, given the document's setup and the page it is being added after. */
export function sizeForNewPage(setup: PageSetup, after: PageSize | null): PageSize {
  if (setup.fixedSize) return clonePageSize(setup.defaultSize);
  if (after !== null) return clonePageSize(after);
  return clonePageSize(setup.defaultSize);
}

export type { Orientation };