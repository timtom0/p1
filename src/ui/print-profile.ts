/**
 * The print profile: what makes the browser's print dialog produce *this* document.
 *
 * ## Why this is a module and not just a stylesheet
 *
 * A print stylesheet can express "hide the chrome" but it cannot express **how big this document's
 * pages are**, because CSS cannot read the model. The page size lives in `doc.pageSize` — a physical
 * unit, an authored width and height, and an orientation — and it can change while you work.
 *
 * So the size is written into a single injected `<style>` element, derived from the document on
 * every change. It is *derived, transient UI state*, exactly like a snap guide: not a command, not a
 * document field, not in history, and not persisted. Pressing print must not dirty the document
 * (M19 §8), and nothing here can, because nothing here writes to the model.
 *
 * ## No second representation
 *
 * The sheet size is computed with the existing geometry, not restated:
 * {@link pageExtentPx} is the same function the renderer uses to size a page element, so "the sheet"
 * and "the page" cannot disagree about orientation. The only genuinely new step is turning those
 * pixels back into a physical length for `@page`, which {@link formatLength} already does.
 *
 * A document authored in millimetres gets `@page { size: 210mm 297mm }`; one authored in inches gets
 * `8.5in 11in`. Nothing assumes A4, because A4 is a choice this editor does not make for you.
 */

import { pageExtentPx } from '../model/page';
import { formatLength } from '../core/units/units';
import type { Document, PageSize } from '../model/types';

/**
 * Marks the injected element, so it can be found by tests and updated in place rather than
 * accumulating one `<style>` per change.
 */
export const PRINT_PROFILE_ATTR = 'data-print-profile';

/**
 * How long to wait for an image before printing anyway.
 *
 * Printing is a user action that must not hang. An image that has not decoded after this is either
 * broken -- in which case the renderer already paints a marked placeholder (ADR 0006) -- or still
 * arriving, and either way the rest of the document should print.
 */
const IMAGE_WAIT_MS = 2000;

/**
 * The sheet size for `@page { size: … }`, derived from the document's own page size.
 *
 * Orientation is resolved by {@link pageExtentPx} rather than by a swap here, so there is exactly one
 * place in the codebase that knows what "landscape" means.
 *
 * @example A4 portrait in mm -> `'210mm 297mm'`; A4 landscape -> `'297mm 210mm'`.
 */
export function printSheetSize(size: PageSize): string {
  const extent = pageExtentPx(size);
  // Four decimals, not the display default of two: the value round-trips through px and back, and a
  // millimetre page is 793.7007874px. Two is enough for any real page size, but the extra precision
  // costs nothing and removes the question.
  return `${formatLength(extent.width, size.unit, 4)} ${formatLength(extent.height, size.unit, 4)}`;
}

/** The injected stylesheet's text for a given page size. */
export function printProfileCss(size: PageSize): string {
  // `margin: 0` is load-bearing twice over: it removes the browser's default page margin, and it is
  // what makes "one document page per sheet" true rather than approximately true.
  return `@page { size: ${printSheetSize(size)}; margin: 0; }`;
}

/**
 * Writes the profile for `size` into the document, creating the element on first use.
 *
 * Idempotent and cheap: the text is compared before writing, so this is safe to call on every render
 * and does no DOM work when the page size has not changed.
 *
 * @returns the profile's CSS text, which is what tests assert against.
 */
export function applyPrintProfile(size: PageSize): string {
  const css = printProfileCss(size);
  const existing = document.querySelector<HTMLStyleElement>(`style[${PRINT_PROFILE_ATTR}]`);
  if (existing !== null) {
    if (existing.textContent !== css) existing.textContent = css;
    return css;
  }
  const element = document.createElement('style');
  element.setAttribute(PRINT_PROFILE_ATTR, 'true');
  element.textContent = css;
  document.head.append(element);
  return css;
}

/** The injected profile's CSS, or `null` if it has never been applied. */
export function currentPrintProfile(): string | null {
  return document.querySelector<HTMLStyleElement>(`style[${PRINT_PROFILE_ATTR}]`)?.textContent ?? null;
}

/**
 * Waits for every image on every page to finish decoding.
 *
 * A print dialog is a snapshot: an `<img>` that has not loaded prints as an empty box, and the user
 * has no way to tell that from a deliberately blank one. `decode()` rejects on an image that cannot be
 * decoded, which is exactly the case where the placeholder should print instead — so rejection is a
 * completion, not a failure.
 */
async function waitForImages(): Promise<void> {
  const images = [...document.querySelectorAll<HTMLImageElement>('.page img')];
  await Promise.all(
    images.map(async (image) => {
      if (image.complete) return;
      await Promise.race([
        image.decode().catch(() => undefined),
        new Promise<void>((resolve) => {
          window.setTimeout(resolve, IMAGE_WAIT_MS);
        }),
      ]);
    }),
  );
}

/**
 * Export the document to PDF through the browser's own print workflow.
 *
 * `window.print()` rather than a generated blob: the document is already laid out by CSS at exactly
 * the authored size, so the browser's paginator is the only component here that knows how to turn
 * boxes into sheets. Building a PDF by hand would mean re-implementing pagination, fonts and text
 * layout — which is the "second representation" this milestone is required not to build.
 *
 * Takes the document rather than reading global state so the page size it publishes is provably the
 * one it was handed.
 */
export async function exportPdf(doc: Document): Promise<void> {
  applyPrintProfile(doc.pageSize);
  await waitForImages();
  window.print();
}