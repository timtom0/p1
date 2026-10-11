# ADR 0019 — Per-page dimensions

- **Status:** accepted
- **Date:** 2026-10-11
- **Depends on:** [ADR 0007](0007-persistence-and-format.md) (no migrations),
  [ADR 0012](0012-group-model.md) (the `Node` union as the schema's extension point),
  [ADR 0018](0018-print-profile-and-pdf-export.md) (the print profile)
- **Answers:** where a page's dimensions live, how old documents keep theirs, and how a mixed-size
  document reaches the printer correctly
- **Delivers:** roadmap item 11 ("Page management: add, duplicate, delete, rename, reorder pages;
  per-page dimensions; mixed-size document support")

## Context

Through M19 every page's size was `Document.pageSize`: one value, in a physical unit, plus an
orientation. That is not a simplification, it is a limit on what the model can *express*. A document
containing an A4 page and an A5 page has no representation at all, because there is exactly one place
to put the answer.

The obvious way to add mixed sizes is a `Page.size` alongside the document's, with the document's
acting as a default. That is also the obvious way to get into trouble: two sources for one fact, and
every consumer that reads a page's size has to know which one wins.

## 1. The size moves to the page, and nothing else does

`Page.size: PageSize` is **required on every page**. `Document.pageSize` is gone.

There is deliberately **no `Page.size | SharedPageSize` union** and no document-wide fallback. A union
would make "these pages are all the same size" a *structural* property that every consumer must branch
on — the renderer, the viewport, hit-testing, the snap rectangle and the print profile would each grow
an "is this shared?" path for a case that only ever affects one decision.

The alternative was rejected on the same grounds ADR 0011 rejected a general affine: an unrepresentable
case that looks representable is worse than an absent one, because the code that reads it is written
under a false belief.

What replaces `Document.pageSize` is `Document.pageSetup`, which is **not** a shared/independent mode.
It records two authoring defaults:

- `fixedSize` + `defaultSize` — what size the **next** added page gets.
- `resizeBehaviour` — what happens to content when an existing page is resized.

A document with `fixedSize: true` can still have an individual page resized; doing so simply means it
stops being uniform, and the next page added still takes the default. Uniformity is a *property of a
document's values*, not a flag — which is why `documentsEqual` compares per-page sizes and the status
bar computes "mixed" by comparing them rather than reading a bit.

## 2. Consequences for geometry, all of them reductions

Page sizes being per-page changes the arithmetic, and every uniform case has to land on exactly the
old numbers:

| | before | after |
|---|---|---|
| page top offset | `index × (height + gap)` | sum of the heights before it, plus one gap each |
| `pageIndexAt` | `floor(y / stride)` | walk, returning `null` in a gap |
| stack height | `count × height + (count−1) × gap` | sum, plus `count−1` gaps |
| stack width | the one page width | the **widest** page |
| fit-to-page | the document's box | that page's box |

The sum and the product agree when every term is equal, so `src/model/page-geometry.test.ts` asserts
that identity directly rather than leaving it implicit. It is the guarantee that a mixed-size change did
not alter the behaviour of any document that already existed.

## 3. Compatibility: the first real migration

Format version 3 removes `Document.pageSize` and adds `Page.size` plus `Document.pageSetup`.

Reading a version-3 file in a version-2 build still fails loudly on the unknown `pageSetup` key — the
refusal direction is unchanged and deliberate.

Reading the other way is where this is genuinely new. A version-1 or -2 file has **one** document size
and no per-page size, so reading one means deriving each page's `size` from the document's. That is a
migration, whatever it is called, and it is the first this project has had.

ADR 0007 said "no migrations". That was never a principle about difficulty — it was a *description* of
the situation, true while every accepted version was a strict subset of the current one. Version 3 moved
a field rather than adding one, and that is what ended the subset property. The claim in
`persist/format.ts` has been corrected in place rather than left to mislead the next reader.

Three decisions inside the migration, each with a plausible alternative:

- **The size is copied, per page.** These pages were *already* that size, so recording it is the only
  version of this that preserves appearance. Copied per page rather than shared: a shared reference
  would let resizing one page of a migrated document resize all of them, quietly reinstating the
  coupling this milestone removes, one indirection away.
- **`fixedSize: true`.** A legacy document was uniform by construction, so "all pages match the
  default" is a *fact about the file*, not an assumption. `false` would describe existing pages
  identically and differ only for the next page added.
- **`resizeBehaviour: 'crop'`.** The policy that moves nothing.

The two golden fixtures stay **version 2** and are byte-for-byte unmodified. They are the only real
documents of the old shape in the repository, and re-stamping them would delete the evidence that
migration works. `tests/golden/sample-v3.p1doc` was **added** alongside them, so byte-stability of the
current format and real migration coverage both survive.

## 4. PDF export: CSS named pages

A bare `@page { size: … }` rule applies to **every sheet**. A mixed-size document printed against one
rule therefore prints entirely on the first page's paper — and the DOM, the CSS and the inspector all
look correct while doing it. Nothing short of reading the generated file catches this, which is why
`tests/editor/print-mixed-size.spec.ts` asserts `/MediaBox` per sheet.

The mechanism is CSS **named pages**: one `@page p0`, `@page p1`, … rule per sheet, and each page
element referencing its own name with the `page` property. Measured, not assumed — an A4/A5/A4-landscape
document produces three sheets at three distinct correct sizes, in order.

`printPageName` lives in `model/page.ts` because the layer rules put `model` below both its users
(`render`, which writes the property, and `ui`, which declares the rules) and nothing else below both.
An earlier draft put it in `render` and had `ui` import it; the linter correctly refused it as a layer
violation. Two independent spellings of `p${n}` would desynchronise silently — an element would
reference a rule that was never declared and print at the fallback size with no error anywhere.

A bare fallback `@page` carries the **first** page's size and is emitted last, so it cannot shadow a
named rule. Identical pages are *not* de-duplicated by value: repeating the rule keeps the rule that
fires for page *n* a function of *n* alone, with no equality test that a later change could get subtly
wrong.

## 5. Resizing a page: three defined behaviours

- **`crop`** — change the paper, move nothing. The default, and the only option that cannot lose
  anything.
- **`scale`** — a **uniform** ratio `min(newW/oldW, newH/oldH)`, applied to top-level objects only.
  Uniform because a per-axis ratio would shear every rotated object and every child of a rotated group,
  and ADR 0011 §2 proves a sheared rotated child is not representable in this model at all. Margins on
  the looser axis are the acceptable cost; distortion is not available. Top-level only, and that is
  exact rather than a shortcut: a child's world transform is `W(group) · W(child)`, so scaling the
  group's box scales the subtree, and walking into the group as well would scale children twice.
- **`push`** — objects whose bounds fall outside the new box move to the following page, creating one if
  this is the last page. **One hop, deliberately**: cascading would make a single resize edit an
  unbounded number of pages.

`setPageProps` deliberately **cannot** change a page's size. Allowing it would let a caller resize a
page and silently skip the policy — no scaling, no pushing — which is the one thing `setPageSize` exists
to prevent.

**Typography is not scaled.** `style.fontSize` is an authored value (ADR 0003), so scaling it would
silently rewrite something the user typed, and a frame whose box grew while its type did not re-wraps
rather than scales. Pinned by a test so a future change has to decide about it deliberately rather than
discover it at export.

## Consequences

- The last page cannot be deleted. The command returns the same document rather than throwing, because
  `isNoop` is `apply(doc, cmd) === doc` and a throw would take the history down with a stale click; the
  UI asks `canDeletePage` and disables the control.
- `duplicatePage` re-mints every node id recursively. A copy sharing its descendants' ids would put two
  nodes in one document claiming one identity, and editing the duplicate would edit the original.
- Page sizes are bounded to 1–5000 in their own unit. A 0.01mm page is arithmetically valid, renders as
  nothing, and produces a sheet no printer accepts.