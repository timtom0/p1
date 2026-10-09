# ADR 0018 — Print profile and PDF export

- **Status:** accepted
- **Date:** 2026-10-09
- **Depends on:** `docs/ARCHITECTURE.md` §6.4 and the "exact print output" row of the
  known-limitations table; [ADR 0005](0005-shape-geometry-contract.md),
  [ADR 0006](0006-image-asset-contract.md), [ADR 0016](0016-alignment-and-distribution.md)
- **Answers:** how a document becomes a PDF, and why that is a stylesheet rather than a renderer
- **Delivers:** roadmap item 10 ("A dedicated print profile: `@page { size: <exact>; margin: 0 }`,
  `-webkit-print-color-adjust: exact`, a print-only stylesheet, and a headless-print export path")

## Context

The document backbone is HTML + CSS, so a printed page is already laid out by the same code that
draws the screen. That makes export unusually cheap — and it makes one decision load-bearing:
**the document must not have to be rendered twice.**

The screen layout is actively hostile to printing. Pages are absolutely positioned and stacked with
a view gap, the whole stack carries `transform: scale(zoom)`, the canvas spacer is sized in
JavaScript so the scrollbars tell the truth, and every page is surrounded by editor chrome.

## 1. `window.print()`, not a generated PDF

Export calls `window.print()`. It does not build a PDF, and it does not render a second DOM.

A PDF writer would have to reimplement pagination, font embedding, text shaping and text layout —
and would then disagree with the screen, which is the one thing this architecture cannot afford.
The browser's print engine is the only component here that knows how to turn boxes into sheets, and
using it means the printed artefact is produced by the same layout the user has been looking at.

This also settles the export-quality question for free. There is no "export fidelity" setting
because there is nothing to degrade.

## 2. Two halves, because CSS cannot read the model

A print stylesheet can say "hide the toolbar". It cannot say **how big this document's pages are**:
the size lives in `doc.pageSize` — a physical unit, an authored width and height, an orientation —
and it can change when a different document is opened.

So the profile is split:

| half | where | what |
|---|---|---|
| static | `@media print` in `ui/styles.css` | chrome, layout neutralisation, page breaks, colour adjustment |
| dynamic | one injected `<style data-print-profile>` | `@page { size: …; margin: 0 }` |

The dynamic half is derived, transient UI state — the same category as a snap guide (ADR 0017 §5):
not a command, not a document field, not in history, never persisted. It is rewritten on every store
change and compares before writing, so it costs nothing when the page size has not moved.

**The size is computed with the existing geometry, not restated.** `printSheetSize` calls
`pageExtentPx` — the same function the renderer uses to size a page element — so "the sheet" and
"the page" cannot disagree about what landscape means. The only new step is turning those pixels
back into a physical length, which `formatLength` already does. A4 is nowhere in the code; a
document authored in inches gets `@page { size: 8.5in 11in }`.

`margin: 0` is what makes one-document-page-per-sheet *true* rather than approximately true. Left
at the browser default, a full-size page element is shrunk to fit inside the margin and every sheet
gains a border.

## 3. Chrome is hidden, not removed

Editor chrome — toolbar, rulers, inspector, status bar — is hidden by the print stylesheet. So is
`.overlay`, which is where selection outlines, resize handles, the rotation grip and every snap
guide are drawn, so one rule retires all of them.

**Hidden rather than torn down, deliberately.** Entering print must not mutate editor state, and
rebuilding the editor to print it would be exactly that. The chrome is still in the DOM after
printing and still correct on screen; the tests assert *invisibility*, not absence, because absence
would be the wrong property.

## 4. Findings

- **F19 — three of the rules must beat an inline style, and only PDF generation notices.** The
  viewport writes `transform: scale(zoom)` onto `.pages` and an inline `width`/`height` of
  `stack × zoom` onto `.canvas`; the renderer writes each page's `top` from the stack offset. None
  of these can be overridden by a stylesheet without `!important`.

  The `.canvas` one is the interesting defect. The spacer keeps whatever height the zoomed stack
  implied, so **a three-page document printed four sheets**, the fourth blank. Under print-media
  emulation the DOM looks correct — the stack measures 907px, the spacer 971px, and nothing visible
  in between. Pagination happens in the print engine, so no DOM assertion can see it. It was found by
  generating a PDF and counting pages, which is the only way to observe it, and it is the whole
  reason the suite asserts a *generated* sheet count rather than trusting the emulated stylesheet.

  The general rule, which extends ADR 0016's F17: **this project's browser tests cannot see a
  stylesheet change that has not been rebuilt into `dist/`.** Verified during this milestone — a
  mutation of the print stylesheet run without a rebuild reported success for every case.

- **F20 — `print-color-adjust` is a contract, not an observable, in a headless test.** The
  declaration does not change the computed `background-color`, so a test asserting the colour passes
  with the instruction deleted. What *is* observable is that the instruction is present, and that the
  colour reaches the PDF at all — asserted on the inflated content stream as an `rg` operand, after
  an earlier version asserted a byte count that a 72-byte difference could not distinguish from noise.

  **The documented limitation:** Playwright's `printBackground` is Chromium's own headless switch and
  does **not** consult `print-color-adjust`. So the declaration's real-world effect can only be
  observed in a real print dialog, and is not verified here. The stylesheet carries both the standard
  and the `-webkit-` prefixed declaration; the prefixed one is the Safari fallback and is
  deliberately *not* a mutation site, because with the standard property present Chromium honours
  either and the prefixed one is conditionally equivalent.

- **F21 — an image prints as an empty box unless it has decoded.** A print dialog is a snapshot, and
  a user cannot distinguish "did not load yet" from "deliberately blank". `exportPdf` awaits every
  image on a page before calling `print()`, with a bounded wait: printing must not hang, and a broken
  image is already a marked placeholder that *should* print (ADR 0006). `decode()` rejects on
  undecodable bytes, which is treated as completion rather than failure.

## 5. What is not claimed

- Page size is **not authorable in the UI**. It arrives from the file or from New. The profile is
  re-derived on store change, which covers opening a different document — the case that would
  otherwise leave a stale sheet size — but there is no page-size control to drive.
- Print output is RGB. No CMYK, no separations, no preflight (roadmap item 9, still out of scope).
- No SVG, raster, or PDF-import path, and no print-preview panel. Export is a button and a browser
  dialog.

## 6. Scope

Print integrates with the **move of no editor state at all**: no command, no transaction, no dirty
flag, no history entry, no selection change. Rendering is the existing document renderer, unmodified
— including page clipping, which the print profile deliberately does not touch. The one way to
"rescue" content that overflows a page would be to remove `overflow: hidden`, and that is a
regression, so it is asserted rather than left to taste.