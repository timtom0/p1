# M24 audit: measurement units

Findings from reading the implementation before changing anything, and the eight questions the
milestone asks to be resolved. The external-convention research is summarised in
`docs/adr/0022-document-measurement-units.md`; this file is the *state of the code*.

## What exists today

**There is no document-level unit.** The nearest thing is `documentUnit()` in `src/ui/app.ts`:

```ts
function documentUnit(): PhysicalUnit {
  return (firstPage(doc().pages) ?? { size: doc().pageSetup.defaultSize }).size.unit;
}
```

That is the **focused page's own** unit. It is a display-only value, it is not persisted as a
preference, and nothing distinguishes "the unit this document is authored in" from "the unit this
particular page happens to be sized in". Those are two different questions and M24 is the milestone
that separates them.

### Audit of `src/core/units/units.ts`

| Function | Behaviour | Problem |
|---|---|---|
| `toPx` / `fromPx` | exact, via `UNITS_PER_INCH` | none |
| `parseLength(input)` | `LENGTH_PATTERN` optional unit, **`?? 'px'`** | a bare number means pixels |
| `formatLength(px, unit, precision = 2)` | rounds, strips trailing zeros | one precision for all units |

`parseLength` defaulting to `px` is the **CSS** convention and it is correct *for CSS*. It is wrong
for a publishing document, where a bare number in a field displaying `mm` means millimetres. Three
separate places already work around it:

- `src/ui/inspector.ts:1773` — `parseLength(raw, defaultUnit)` appends the default unit.
- `src/ui/styles-panel.ts` — its own `hasUnit` regex, `parseLength` alias.
- `src/ui/style-editor.ts` — a third copy of the same regex.

Three copies of "is there a unit suffix, and if not add the default" is the inconsistency the
milestone names. It belongs in the units module, once, with the default supplied as an argument.

### Other findings

1. **The ruler never updates.** `Rulers` stores `this.unit = options.unit` in its constructor and
   `app.ts` passes `documentUnit() as Unit` **once** at mount. The function is a live getter; the
   consumer is not. Moving to a page in another unit leaves the ruler labelled in the old one.

2. **`PageSize.unit` is load-bearing and per-page.** `printSheetSize` in `print-profile.ts` emits
   `@page { size: 210mm 297mm }` from **the page's own unit**, with four decimals. That is exactly
   right for a print shop and it is why pages carry a unit at all. A document-wide unit must
   therefore **not** be inferred from, nor written back to, any page's unit.

3. **`formatLength`'s single precision is wrong per unit.** Two decimals is right for millimetres and
   noise for points and pixels. `printSheetSize` already passes `4` explicitly for this reason, which
   is the existing evidence that the default is a presentation convenience rather than a decision.

4. **Default precision on entry.** `inspector.ts` commits on blur, parsing what is in the box. Since
   the box holds a *rounded* rendering of the stored px, committing an unchanged box therefore
   quantises the value. There is no "did the user actually change it" check.

5. **Format version 5** (`CURRENT_FORMAT_VERSION` in `model/factory.ts`). `documentKeysFor(version)`
   and `pageKeysFor(version)` already carry the version-dependent key lists, and
   `PAGE_SETUP_KEYS` is one constant — the mechanism for a v6 field is already there.

6. **Existing unit literals, and what each means.** See the defaults table in the ADR. The important
   one: `DEFAULT_CREATED_EXTENT = 120` px is a *physical* 3.175 mm, and `MIN_CREATED_EXTENT = 2` px is
   a *physical* 0.53 mm. Neither is "120 of whatever unit" and neither should become one.

## The eight questions, and the answer each one gets

**1. Which unit is the document's authoritative unit?**
`Document.pageSetup.unit` — a required, persisted, document-scoped `PhysicalUnit`. It is *not*
`px` (the internal representation) and it is *not* any page's `PageSize.unit`. New in format v6;
absent in v5 and earlier, which migrate to `mm` because every pre-v6 document's default page size
was A4 in millimetres.

**2. Which properties use it?**
Page dimensions, object geometry (x/y/width/height), corner radius, stroke width, paragraph metrics
(text indent, the four margins), and every inspector measurement field. Page *sizes* additionally
carry their own unit for print, which the document unit does not touch.

**3. Do typography properties follow the document unit?**
**No — font size and leading stay in points.** This is the InDesign convention and it is the reason:
the Type panel is points in every locale and every measurement setting, because a font size of
"12 mm" is not a thing. `lineHeight` (a multiplier) and `letterSpacing` (em) are dimensionless and
are not measurements at all. So font size follows **points**, and is the one documented exception.

**4. What does a unitless value mean in a measurement field?**
The **field's own unit** — which for measurement fields is the document unit. `parseLength` gains a
required `defaultUnit` argument so "unitless means px" stops being the module's silent opinion.

**5. How are explicitly suffixed values handled?**
Accepted and converted from the suffix, whatever the field displays. `12mm` in a field showing `pt`
is 12 mm. Rejected input (`12mmmm`, `abc`, `12 ` + `em`) is refused by name and never reinterpreted.

**6. How are defaults represented and converted?**
Every default is a **fixed physical quantity in px** — the internal unit. Display converts for
display; conversion never touches the stored value. A default of 1 mm shows as `2.83pt` in a points
document, not as `1pt`.

**7. What precision is retained versus displayed?**
All precision is retained internally (px is a float). Displayed precision is **per unit**:
millimetres 2, centimetres 2, inches 3, points 1, picas 2. Committing a box the user did not change
is a no-op, so rounding for display is not cumulative.

**8. What happens when an older document is opened?**
It migrates. v1-v5 have no `pageSetup.unit`, so v5 and earlier default to `mm`, chosen because
`DEFAULT_PAGE_PRESET` has been A4-in-millimetres since before the format existed. **No number in the
document is reinterpreted**: page sizes keep their own recorded units, geometry stays px.

## What is explicitly not in this milestone

Expressions, variables, and any typed-value system. The contract above is stated so that such a
system can be built on top of it: a measurement field's text is parsed by one function, which takes
a default unit and returns px.