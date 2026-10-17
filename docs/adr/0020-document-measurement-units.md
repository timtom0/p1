# ADR 0020 — Document-wide measurement units

- **Status:** accepted
- **Date:** 2026-10-17
- **Depends on:** [ADR 0004](0004-measurement-boundary.md) (px as the internal geometry unit),
  [ADR 0007](0007-persistent-document-format.md) (the versioned `.p1doc` format),
  [ADR 0019](0019-per-page-dimensions.md) (`Page.size`, and why it has no document-wide fallback)
- **Answers:** which unit a number a person types is read in, what the document's unit is, and what a
  displayed value may be rounded to without becoming a different number
- **Delivers:** roadmap item 24 ("Document-wide measurement units")
- **Numbering:** the previous ADR is 0019. The roadmap's M20–M23 took no ADR of their own — 0019 *is*
  M20's, and M21–M23 amended existing ones — so this takes the next free number rather than a number
  derived from the milestone. Nothing was skipped.

## Context

Through M23 a document had **no measurement unit at all**. Every physical quantity carried its own:
`Page.size.unit`, `PageSize.unit` on the preset, and the unit of whichever page the user was looking
at. The inspector read `doc().pageSetup.defaultSize.unit` — the size the *next added page* would get,
which is an authoring default, not a preference.

Three consequences, in increasing order of how long they would have taken to notice:

1. There was nothing to persist. "What unit is this document in" was not a fact the model could hold.
2. The display unit changed as the user scrolled, because it came from the focused page. In a
   mixed-size document — representable since M20 — scrolling from a millimetre page to a 5×7in page
   silently changed every ruler and every inspector field.
3. A bare number in a field meant **pixels**, because `parseLength` was written before the internal
   unit was CSS px and had no other answer. A user who typed `25` to mean 25 millimetres moved an
   object by 25px.

M24 adds the missing preference. It does not add expressions, variables, or any typography feature.

## 1. The authoritative unit is `PageSetup.unit`, and it is not any of the other three

`PageSetup.unit: MeasurementUnit` is **required, persisted, document-scoped**. The three candidates it
had to beat:

| Candidate | Verdict |
|---|---|
| The document's own coordinate system | **Not `px`.** CSS px stays the internal geometry unit (ADR 0004) and that is unchanged. `px` is a rendering detail; making it the authoring unit would put a browser's idea of screen density into the print pipeline. |
| `Page.size.unit` | **Not it.** That is the page's *paper size* unit, and it is load-bearing: `printSheetSize` turns it into `@page { size: 210mm 297mm }`. It varies per page by design. |
| `PageSizePreset.unit` | **Not it.** A preset is a paper name. `A4` is 210×297mm and `Letter` is 8.5×11in; choosing Letter must not turn a millimetre document into an inch one, and that is exactly what the pre-M24 New Document dialog did. |

These three being separate is the whole design. `PageSetup.unit` answers *how numbers are read and
shown*; `Page.size.unit` answers *how big this sheet is*; the preset's unit answers *how big the named
paper is*. Pages may keep different physical sizes, and a document may measure in a unit none of its
pages is sized in.

## 2. A bare number is read in the document's unit. Always.

`parseLength(input, defaultUnit)` — the `defaultUnit` argument is **required**, not defaulted. That is
the enforcement: three private copies of a "does this have a suffix?" workaround lived in
`inspector.ts`, `styles-panel.ts` and `style-editor.ts` before M24, and each one defaulted to pixels.
Making the argument required meant the compiler found all three and they were deleted.

Precedence, in order:

1. **A suffix wins.** `1in` is one inch, in a millimetre document.
2. **A bare number is the field's documented default unit**, which is the document's unit for geometry.
3. **An empty field means "unset"** and leaves whatever the model says — it is not zero.

Invalid input is **refused and named**, never reinterpreted. `readLength` returns one of three
refusals, and the distinction between the last two is the interesting one:

| Input | `ParseProblem` | Why it matters |
|---|---|---|
| `''` | `empty` | "no value", not "zero" |
| `abc` | `not-a-number` | |
| `12em` | `unknown-unit` | A perfectly good number with a suffix we do not accept. Telling someone who typed `12em` that their number is not a number sends them looking for a typo that is not there. |

The digit test is what separates the last two. This is a **deliberate deviation** from Scribus's
`unitValueFromString`, which returns `0.0` for anything it cannot read — a silent reinterpretation,
and the exact failure mode M24 exists to remove.

## 3. Font size is always points. The one exception, and it is not optional.

Every typography control is specified in points by every typeface format, and no font cares what the
document measures in. So `TextFieldSpec` gained one optional field, `unit?: 'pt'`, and it is honoured
by a single helper, `textFieldUnit()`. One helper rather than a special case at each of the four
commit paths, because read and write have to agree and two lists would drift.

## 4. Display precision is bounded below by round-trippability, not by the raster

`PRECISION_BY_UNIT` is `mm` 2, `cm` 2, `in` 3, `pt` 2, `pc` 2, `px` 2.

The first derivation for `pt` was **one** decimal, on the rule "show the finest increment worth at
least a tenth of a pixel" — 0.1pt is 0.13px, so 0.01pt is noise. That rule is self-consistent and it is
wrong, and the browser suite found it within an hour: 40px is 30.75pt, one decimal shows `30.8`, and
reading that back stores 41.07. **A field whose reading cannot be written back is a field that cannot
be edited.** The lower bound is round-trippability.

The *shape* of the table is unchanged and is the part worth keeping: the coarse unit gets more decimals
than the fine one. That is what Scribus's `unitGetPrecisionFromIndex` has (`in` 4, `pt` 2) and it is
what a naive "always two decimals" gets backwards. This table is the same shape with fewer digits.

The corollary is the `unchanged()` guard. A field that has not been edited is **never committed**, even
though its displayed reading is rounded. Without it, merely opening a panel would quantise every
selected object to the display quantum, and doing that repeatedly is how a document quietly loses
precision.

## 5. Three kinds of default, kept apart

A default that is a measurement has to be classified before it can be displayed, because the wrong
answer changes its meaning. Every measurement default in the model is one of:

| Kind | Meaning | Example | Displayed as |
|---|---|---|---|
| **Fixed physical measurement** | A specific physical thing, independent of the document | `DEFAULT_LINE_STROKE.width` = 2px; `DEFAULT_MIN_SIZE` = 1px | Its own px, or the document's unit — the *same length*, said differently |
| **Convenient value in the selected unit** | A number chosen to be round in the unit the user works in | `DEFAULT_CREATED_EXTENT` = 120px | Its own value, in the document's unit |
| **Unset** | No value; a CSS default or a model rule decides | an empty paragraph margin | **Nothing.** A placeholder, never `0` |

The reason the first row needs care: a 1mm default displayed in a points document must show the
equivalent points, not `1pt`. Displaying the numeral rather than the length converts the *meaning*.
M24 has no field that falls foul of this today, and the classification is written down so that the
first one that does has an answer ready rather than an argument.

## 6. Older files

Format **v6**. `pageSetupKeysFor(version)` splits `PRE_UNIT_PAGE_SETUP_KEYS` from `PAGE_SETUP_KEYS`, so
a v5 page setup carrying a `unit` is **refused by name** rather than silently accepted. Three tests in
`tests/persist/version6-units.test.ts` exist only to hold that line.

Migration for v1–v5 is `DEFAULT_MEASUREMENT_UNIT` = `mm`, and the reasoning is the reason this ADR
exists: `DEFAULT_PAGE_PRESET` has been A4-in-millimetres since before the format did, so a millimetre
migration is the one choice that makes existing documents look unchanged.

Deliberately **not** inferred from `defaultSize.unit`. That is the obvious-looking alternative and it is
wrong twice over — it makes the authoring unit a function of which paper is selected (the confusion
section 1 exists to separate), and it lets the first page's unit leak into a document whose later pages
disagree.

The migration branches on the **version**, not on `undefined`. Reading a missing key as the default
would make a required field optional in every version at once and quietly accept a v6 file that a
hand-edit had stripped. Three *loaded* browser fixtures declare `formatVersion: 5` and no `unit`
specifically so the migration runs on a real path.

## What was verified, and what was not

Honest sourcing, because the difference matters for how much weight the decisions above carry.

**Verified:**

- De facto pica is exactly 1/6in = 4.2333mm, and 1 pica = 12 points; the DTP point is 1/72in =
  0.3527mm. From Wikipedia `Pica (unit)` and `Point (typography)`.
- CSS `pc` is 1/6in and CSS `pt` is 1/72in. **CSS and modern typography agree**, so there is no
  CSS-vs-typography discrepancy to reconcile — a plausible worry that turned out not to exist.
- Scribus's unit list is points, millimetres, inches, picas, centimetres, ciceros — **no pixels** —
  and points are its internal base. From `scribus/units.h` and `scribus/units.cpp`.
- Scribus's `unitGetPrecisionFromIndex` is `{PT:2, MM:3, IN:4, P:2, CM:4}`, its `unitValueFromString`
  returns `0.0` for unreadable input, and `unitIndexFromString` defaults to points.

**Not verified — convention, not research:**

InDesign's default unit per locale; whether its Type panel shows points in every locale; where its
decimal-place preferences live; and what it does to existing content when the unit changes. These are
recorded as conventions this milestone follows, not as facts it established. `helpx.adobe.com`
returned 403, the Scribus wiki 404s, and LibreOffice's help is behind JavaScript.

## Consequences

**Now possible:** a document knows its own unit; scrolling cannot change it; `25` means 25mm; a
suffixed value is honoured; an unrecognised suffix is refused with a reason; a page preset no longer
decides the document's unit; changing the unit changes no stored number.

**The contract future expression support must obey.** M24 deliberately did not add expressions or
variables, but it fixed the ground they will stand on, and getting this wrong later will be expensive:

- An expression's *unit* is the unit of its result, and its operands may carry different units. There is
  exactly one conversion function (`toPx`/`fromPx`) and an expression must not grow a second.
- A bare number in an expression is the document unit, because that is what `parseLength` now means
  everywhere. An expression that wants pixels must say `px`.
- **Evaluating an expression into a field is an edit, and must go through `unchanged()`.** A field that
  shows a rounded reading must not be committed, whether the reading came from a user or from an
  expression. Otherwise the whole of section 4 is undone the first time anything is computed.
- A unit is a *reading*, never a rescale. `fromPx(toPx(v, from), to)` is the only legal re-presentation,
  and any code that multiplies by a ratio without going through it is a bug — the dialog bug this
  milestone shipped and its suite caught is exactly that mistake, made in the opposite direction.

**Open:** none outstanding. The follow-up pass closed both gaps M24 recorded. `clickAt` now takes a
page index, and the helper that computes the click *verifies* the point is inside the page it was
asked for rather than trusting the mapping — a click that lands on the wrong page produces no error,
only a selection on the wrong object. And the fixture guard classifies injected from loaded
literals instead of keeping a list of exemptions. See the M24 notes in `ARCHITECTURE.md`.