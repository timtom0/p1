# The mutation corpus.
#
# Split out of `mutation-check.ps1` so the runner and the list of mutations cannot diverge: the
# runner dot-sources this file, so there is exactly one place a mutation is declared. Previously
# the `Mutate ...` calls were inline, and adding one meant editing the runner -- which is how a
# mutation ends up written but never run.
#
# `Add-Mutation` appends to the corpus; the runner applies `-Filter` and `-List` over the result.
# The accounting is unchanged from before the split: one `true` per detected mutant, one `false` per
# survivor, and a thrown error for a substitution that did not change the file.
#
# ## Provenance -- read this before trusting a label
#
# Rewriting `mutation-check.ps1` at the start of M13 destroyed the inline corpus, which was
# untracked, so git could not restore it. This file is a reconstruction: the M11 and M12 entries are
# the original text (they were written during this session's predecessor milestones and are
# reproduced verbatim), and the 30 older entries were rebuilt from each label's target suite and the
# current source.
#
# **Every entry is verified, and the verification is the same property mutation testing exists to
# check**: each one breaks a real behaviour and a real test notices. A reconstructed entry that is
# detected is functionally the mutation it claims to be -- the substitution applies (a site that does
# not match throws rather than passing) and the suite fails (a survivor is reported and the runner
# exits non-zero). **A label being slightly different prose is cosmetic; a survivor would not be.**
#
# So the corpus is trustworthy in the sense that matters and untrustworthy in the sense that its
# labels are second-hand. If a copy of the original exists anywhere, diff against it; the entries most
# worth checking are the ones whose wording implies a mechanism this reconstruction had to infer:
# "the parser shares nested objects with its input", "optional properties are materialised instead
# of left absent", and "the dirty indicator is laid out with padding again".
# --- Accepted survivors ----------------------------------------------------------------
#
# A mutation that no test can kill is either a coverage gap or an equivalent mutant, and the two deserve
# opposite responses: a gap should be closed, an equivalent mutant should be recorded and never counted
# again. One entry is currently accepted. It is listed here, with the reason, so that the single undetected
# result in a full run is a decision rather than an oversight -- and so that the next milestone inherits a
# known quantity instead of rediscovering it. (Deliberately not written as a fraction: a count here goes
# stale the moment a mutant is added, and a stale count reads as a claim about the current run.)
#
# **1. `the dirty indicator is laid out with padding again (resizes every baseline)`** — `src/ui/styles.css`,
#    target `tests/editor/persistence.spec.ts`.
#
#    The substitution replaces `box-shadow: inset 0 0 0 1px` with a `1px` border plus `1px` padding, which
#    grows the dirty badge by two pixels in each direction. It survives because **no test in the suite
#    asserts that element's geometry**: `persistence.spec.ts` checks dirty state behaviourally, and nothing
#    anywhere measures the badge's box.
#
#    The only way to detect it is a pixel baseline, and ADR 0011b section 8 established that the baselines
#    here cannot see a sub-pixel chrome change -- so a baseline would report this mutant as detected while
#    being unable to fail for the right reason, which is the specific outcome this tool exists to avoid.
#
#    It is therefore a genuine, accepted coverage gap rather than a defect in the product: the CSS is
#    correct, and the change the mutant makes is cosmetic and unobservable to the assertions that exist.
#    Accepted through M16 and M17. If a test ever asserts the badge's rendered size, remove this entry and
#    expect the mutant to die.

# --- M0-M7: persistence and the format ------------------------------------------------
# The rule this whole file exists to enforce: an untrusted `.p1doc` must be refused at load with a
# named path, and the canonical form must be byte-stable.

Add-Mutation 'canonical equality always true (dirty state would miss an edit)' `
  'src\model\document-equality.ts' `
  { param($t) [regex]::Replace($t, '(?m)^export function documentsEqual\(a: Document, b: Document\): boolean \{', "export function documentsEqual(a: Document, b: Document): boolean {`n  return true;") } `
  'tests/persist/session.test.ts'

Add-Mutation 'save does not adopt the saved document as the baseline' `
  'src\ui\persistence.ts' `
  { param($t) [regex]::Replace($t, '(?m)^    this\.baseline = current;\r?\n', '') } `
  'tests/persist/session.test.ts'

Add-Mutation 'text session committed after the document is read (stale model)' `
  'src\ui\persistence.ts' `
  { param($t) [regex]::Replace($t, '(?m)^    this\.commitTextSession\(\);\r?\n\r?\n    const current = this.store.state;', '    const current = this.store.state;') } `
  'tests/persist/session.test.ts'

Add-Mutation 'a refused document overwrites the saved filename anyway' `
  'src\ui\persistence.ts' `
  { param($t) $t.Replace("      return 'cancelled';`n    }`n`n    let doc: Document;", "      this.name = opened.name;`n      return 'cancelled';`n    }`n`n    let doc: Document;") } `
  'tests/persist/session.test.ts'

Add-Mutation 'open does not clear history' `
  'src\ui\persistence.ts' `
  { param($t) $t.Replace('    this.baseline = doc;', '    // mutation: the baseline is left alone, so the opened document is dirty on arrival') } `
  'tests/editor/persistence.spec.ts'

Add-Mutation 'id reservation does nothing' `
  'src\core\ids.ts' `
  { param($t) [regex]::Replace($t, '(?m)^export function reserveIds\(ids: Iterable<string>\): void \{', "export function reserveIds(ids: Iterable<string>): void {`n  return;") } `
  'tests/persist/golden-roundtrip.test.ts'

Add-Mutation 'parse no longer re-applies normalizeRichText' `
  'src\persist\deserialize.ts' `
  { param($t) $t.Replace('  return normalizeRichText({ blocks: parsed });', '  return { blocks: parsed };') } `
  'tests/persist'

Add-Mutation 'asset keys are not sorted on the way out' `
  'src\persist\serialize.ts' `
  { param($t) $t.Replace('  for (const id of Object.keys(assets).sort()) {', '  for (const id of Object.keys(assets)) {') } `
  'tests/persist/golden-roundtrip.test.ts'

Add-Mutation 'the transform is copied by spread, losing its declared key order' `
  'src\persist\serialize.ts' `
  { param($t) $t.Replace("    scaleX: transform.scaleX,`n    scaleY: transform.scaleY,", "    ...transform,") } `
  'tests/persist/golden-roundtrip.test.ts'

Add-Mutation 'undeclared top-level fields are dropped rather than refused' `
  'src\persist\format.ts' `
  { param($t) [regex]::Replace($t, '(?m)^    if \(allowed\.includes\(key\)\) continue;', '    if (true) continue;') } `
  'tests/persist/validation.test.ts'

Add-Mutation 'an unknown object type is refused without naming it' `
  'src\persist\deserialize.ts' `
  { param($t) $t.Replace('throw new DocumentParseError(`${path}.type`, `unknown object type "${type}"`);', "throw new DocumentParseError(`${path}.type`, 'unknown object type');") } `
  'tests/persist/validation.test.ts'

Add-Mutation 'an unknown shape kind is refused without naming it' `
  'src\persist\deserialize.ts' `
  { param($t) $t.Replace('throw new DocumentParseError(`${path}.kind`, `unknown shape kind "${kind}"`);', "throw new DocumentParseError(`${path}.kind`, 'unknown shape kind');") } `
  'tests/persist/validation.test.ts'

# The asset reference has **two** owners, and that is the finding, not an accident of this file.
# `assertAssetReferences` is the parse-time walk that throws with a path; `validateDocument` is the
# model check that `assertDocumentIsConsistent` re-reads and re-throws. A first attempt at this
# mutation disabled only the parse-time one and *survived* -- because the invariant still reported
# the violation and `parse` still refused. The surviving mutant was not a weak test; it was
# evidence that deleting one owner leaves the behaviour intact.
#
# So the mutation removes both enforcement points in the one file that holds both, which is what it
# takes to prove the refusal is load-bearing rather than doubly redundant. The parse-time walk is
# the one whose removal also matters for the *path* in the message: the invariant reports the same
# path, so that part stays honest either way.
Add-Mutation 'a dangling asset reference is not checked' `
  'src\persist\deserialize.ts' `
  { param($t)
    $a = [regex]::Escape('      if (Object.hasOwn(assets, node.asset)) return;')
    $t = [regex]::Replace($t, $a, '      if (true) return;')
    $b = [regex]::Escape('  for (const violation of validateDocument(doc)) {')
    [regex]::Replace($t, $b, '  for (const violation of []) {')
  } `
  'tests/persist/validation.test.ts'

Add-Mutation 'duplicate ids are not checked' `
  'src\persist\deserialize.ts' `
  { param($t) [regex]::Replace($t, '(?m)^    if \(seen\.has\(id\)\) \{', '    if (false) {') } `
  'tests/persist/validation.test.ts'

Add-Mutation 'stroke alignment other than `inside` is accepted' `
  'src\persist\deserialize.ts' `
  { param($t) $t.Replace("  if (align !== 'inside') {", "  if (false) {") } `
  'tests/persist/validation.test.ts'

Add-Mutation 'a newer format version is accepted silently' `
  'src\persist\deserialize.ts' `
  { param($t) [regex]::Replace($t, '(?m)^  if \(version > CURRENT_FORMAT_VERSION\) \{', '  if (false) {') } `
  'tests/persist/validation.test.ts'

# `expectRecord` handing on the input by reference is *fine* on its own -- `parseNode` rebuilds
# every field, so the only record it needs to be shared with is one it immediately copies out of.
# The first attempt at this mutation replaced `return input as ...` with a no-op comment, which
# changed nothing and survived: the substitution was not equivalent to the behaviour the label
# claims. The real claim is that `parseSharedNode` reuses the input's `transform` object, so that
# is what gets removed.
Add-Mutation 'the parser shares nested objects with its input' `
  'src\persist\deserialize.ts' `
  { param($t) $t.Replace('    ...parseSharedNode(record, path),', '    ...parseSharedNode(record, path), transform: record[''transform''] as Transform2D,') } `
  'tests/persist/validation.test.ts'

# The search text contains a real template literal -- `` `${path}.fit` `` with backticks -- and
# PowerShell's escaping of backticks inside a double-quoted string is exactly the sort of thing that
# yields a pattern matching nothing while reporting no error. So the backticks are assembled from
# their character code instead. The mutation keeps the guard's *effect* and drops its *absence*: an
# omitted `fit` comes back as `'contain'`, so the key is materialised where the author wrote nothing.
# That is the invariant `fit: 'fill'` and no `fit` are authored differently, which the format must
# not collapse. Deleting the `if` outright would not test that -- it would make `expectEnum` refuse
# an omitted key, which is a different defect entirely.
Add-Mutation 'optional properties are materialised instead of left absent' `
  'src\persist\deserialize.ts' `
  { param($t)
    $bt    = [string][char]96
    $guard = '      if (record[''fit''] !== undefined) {'
    $assign = '        node.fit = expectEnum(record[''fit''], ' + $bt + '${path}.fit' + $bt + ', IMAGE_FITS) as ImageFit;'
    $find  = $guard + "`n" + $assign + "`n" + '      }'
    $repl  = '      node.fit = (record[''fit''] === undefined ? ''contain'' : (expectEnum(record[''fit''], ' + $bt + '${path}.fit' + $bt + ', IMAGE_FITS) as ImageFit));'
    $t.Replace($find, $repl)
  } `
  'tests/persist'

# --- M8: layer order ---------------------------------------------------------------------

Add-Mutation 'a restack moves an object over a selected neighbour that cannot move' `
  'src\model\commands.ts' `
  { param($t) $t.Replace('    if (occupant !== undefined && moving.has(occupant.id)) continue;', '    if (false) continue;') } `
  'src/model/restack.test.ts'

Add-Mutation 'a restack returns a fresh array even when nothing moved' `
  'src\model\commands.ts' `
  { param($t) $t.Replace('function sameOrder(candidate: readonly Node[], original: readonly Node[]): boolean {', "function sameOrder(candidate: readonly Node[], original: readonly Node[]): boolean {`n  return false;") } `
  'src/model/restack.test.ts'

Add-Mutation 'forward restacks are not processed front to back' `
  'src\model\commands.ts' `
  { param($t) $t.Replace('  const step = direction === ''forward'' ? 1 : -1;', '  const step = 1;') } `
  'src/model/restack.test.ts'

# --- M9: interaction integrity ----------------------------------------------------------

# Owned by `src/ui/app.ts`, not the editor: the `preventDefault` that stops the browser beginning its
# own text selection is wired at the pointerdown listener, and the editor has no `preventDefault` of
# its own to break. The condition matters -- it is `!isInsideTextSession(event.target)`, because
# preventing the default there would swallow the caret placement. So the mutation removes the call
# from the guarded branch only, which is the defect the label describes.
#
# **Retargeted at M13.** This entry survived for most of a milestone, and the reason was a gap in the
# *suite*, not in the code: every selection test drags across shapes, and a shape has no text in the
# DOM for the browser to select, so nothing could observe the contract. A drag over an empty box
# starts no selection whether or not the default is prevented. `tests/editor/native-selection.spec.ts`
# puts real text under the pointer and observes `window.getSelection()` directly, which is what makes
# this mutant killable -- so the target is that file, not `interaction-matrix.spec.ts`, which never
# had a chance of noticing.
Add-Mutation 'the browser may start its own selection during an editor gesture' `
  'src\ui\app.ts' `
  { param($t) $t.Replace("    if (!isInsideTextSession(event.target)) event.preventDefault();", "    // mutation: the browser is left to start its own selection during the gesture") } `
  'tests/editor/native-selection.spec.ts'

Add-Mutation 'a marquee skips hidden objects, as hit testing does' `
  'src\editor\editor.ts' `
  { param($t) $t.Replace('    for (const placement of placementsOnPage(page)) {', "    for (const placement of placementsOnPage(page)) {`n      if (!placement.node.visible) continue; // mutation: hidden objects become unreachable") } `
  'tests/editor/interaction-matrix.spec.ts'

Add-Mutation 'every setProps commit is labelled "Change"' `
  'src\model\commands.ts' `
  { param($t) $t.Replace("    case 'setProps':`n      return describeProps(command);", "    case 'setProps':`n      return 'Change';") } `
  'tests/editor/layers.spec.ts'

# Also `src/ui/app.ts`: the `blur` listener is where `editor.cancelGesture()` is wired, which is the
# defect the M9 notes describe ("`blur` cleared the space-pan cursor and did nothing else"). Editing
# the `idle` guard inside `cancelGesture` instead is a *different* mutation -- it would make the
# method corrupt an idle editor -- so the site is the listener, not the callee.
Add-Mutation 'losing window focus leaves a gesture open' `
  'src\ui\app.ts' `
  { param($t) $t.Replace("    editor.cancelGesture();`n  });", "    // mutation: the gesture is left open`n  });") } `
  'tests/editor/cancellation.spec.ts'

# The owner is `History.close`'s canonical-equality guard in `src/editor/history.ts` -- M9's finding --
# and **not** the `moved` flag in the editor. `moved` only decides whether a *click* counts as a
# marquee; whether an out-and-back drag lands on the history is decided when the transaction closes
# and the result is compared canonically with where it started. A first attempt at this mutation
# cleared `this.moved` in `applyMove` and survived, which is worth recording: the flag and the
# history entry are two different facts, and only one of them is what the test claims.
Add-Mutation 'a gesture that moved and came back is recorded anyway' `
  'src\editor\history.ts' `
  { param($t) $t.Replace('    if (documentsEqual(open.before, after)) return;', '    // mutation: an out-and-back gesture lands on the history') } `
  'tests/editor/cancellation.spec.ts'

# `stampIdentity` is the single owner M9 created, and the assertion is on `data-oid` reaching the
# DOM -- which is what every browser test locates an object by. Removing the write is the defect.
Add-Mutation 'object identity is not stamped on the element' `
  'src\render\reconciler.ts' `
  { param($t) $t.Replace("  element.dataset['oid'] = node.id;", "  element.dataset['type'] = node.type; // mutation: identity is not stamped") } `
  'tests/editor/layers.spec.ts'

# The defect is `applyOrder` re-creating rather than moving: forcing a fresh element for every node
# on every reorder destroys DOM identity, which is what a layer test asserts by holding a reference
# to an element across a reorder. Written as "always take the create branch", which is the honest
# shape of the bug -- the alternative first attempt moved `this.elements.set` around, which merely
# re-registered the same element and changed nothing observable.
Add-Mutation 'reordering recreates the elements instead of moving them' `
  'src\render\reconciler.ts' `
  { param($t) $t.Replace('      const prev = this.projected.get(node.id);', "      // mutation: the element is rebuilt rather than reused`n      element.remove();`n      element = renderer.create(ctx, node);`n      stampIdentity(element, node);`n      const prev = this.projected.get(node.id);") } `
  'tests/editor/layers.spec.ts'

Add-Mutation 'the saved baseline is assigned after the store notifies subscribers' `
  'src\ui\persistence.ts' `
  { param($t) $t.Replace('    this.baseline = current;', '    // mutation: the baseline moves after the notification, so the dirty read sees the old one') } `
  'tests/editor/persistence.spec.ts'

Add-Mutation 'the dirty indicator is laid out with padding again (resizes every baseline)' `
  'src\ui\styles.css' `
  { param($t) $t.Replace('  box-shadow: inset 0 0 0 1px #7a5c1e;', '  border: 1px solid #7a5c1e;' + "`n" + '  padding: 1px;') } `
  'tests/editor/persistence.spec.ts'

# --- M11: selection geometry -------------------------------------------------------------
# F6 and F7/F8. The target is always a *geometric* assertion, never a pixel baseline: ADR 0011b Â§8
# records that the overlay's baselines cannot see a 1px chrome change at all.

Add-Mutation 'the selection outline is laid out without the object transform' `
  'src\editor\viewport\overlay.ts' `
  { param($t) $t.Replace("    box.style.transform = cssMatrix(this.layerMatrix(outline));", "    box.style.transform = 'none';") } `
  'tests/editor/selection-frame.spec.ts'

Add-Mutation 'a resize handle is placed on the model frame, not the transformed corner' `
  'src\editor\viewport\overlay.ts' `
  { param($t) $t.Replace("      this.framePoint(outline, {`n        x: outline.rect.width * unit.x,`n        y: outline.rect.height * unit.y,`n      }),", "      this.toLayer(outline.pageId, {`n        x: outline.rect.x + outline.rect.width * unit.x,`n        y: outline.rect.y + outline.rect.height * unit.y,`n      }),") } `
  'tests/editor/selection-frame.spec.ts'

Add-Mutation 'the rotation grip is pinned to the unrotated top edge' `
  'src\editor\viewport\overlay.ts' `
  { param($t) $t.Replace('    return this.framePoint(outline, { x: outline.rect.width / 2, y: -gap });', '    return { x: outline.rect.x + outline.rect.width / 2, y: outline.rect.y - gap };') } `
  'tests/editor/selection-frame.spec.ts'

Add-Mutation 'the marquee tests the model frame instead of the painted bounds' `
  'src\editor\editor.ts' `
  { param($t) $t.Replace('      if (rectsOverlap(rect, paintedBounds(placement.transform))) ids.add(node.id);', '      if (rectsOverlap(rect, toRect(placement.transform))) ids.add(node.id);') } `
  'tests/editor/selection-frame.spec.ts'

Add-Mutation 'the frame point forgets the rotation, so the frame and the object drift' `
  'src\editor\viewport\overlay.ts' `
  { param($t) $t.Replace("    const rotated = applyPoint(outline.matrix, {`n      x: local.x - width / 2,`n      y: local.y - height / 2,`n    });", "    const rotated = { x: local.x - width / 2, y: local.y - height / 2 };") } `
  'src/editor/viewport/overlay-frame.test.ts'

# M11 replaced a `rotation === 0` workaround with `outlines.length === 1` -- a rotation grip needs an
# aggregate frame, and there deliberately is not one for a multi-selection.
#
# **The guard has two owners**, and this entry previously only removed one of them, so it *survived*.
# `overlayInput` decides whether to offer the grip at all; `rotationCentre` decides its pivot. Removing
# only the second leaves the first withholding the handle, so the editor still shows no grip and the
# test still passes -- a mutation that broke nothing while looking exactly like a real one.
#
# That is the same shape as the asset check in Â§7.4: deleting one owner of a fact leaves the behaviour
# intact, and the surviving mutant is evidence of that rather than of a weak test. Both are removed here.
Add-Mutation 'the rotation grip is offered for a multi-selection, with no aggregate frame' `
  'src\editor\editor.ts' `
  { param($t)
    $t = $t.Replace('    const outline = outlines.length === 1 ? outlines[0] : undefined;', '    const outline = outlines.length > 0 ? outlines[0] : undefined;')
    $t.Replace('    const outline = input.outlines.length === 1 ? input.outlines[0] : undefined;', '    const outline = input.outlines.length > 0 ? input.outlines[0] : undefined;')
  } `
  'tests/editor/selection.spec.ts'

Add-Mutation 'a stroke width is no longer the authored local value' `
  'src\render\paint.ts' `
  { param($t) $t.Replace("  setStyle(element, 'border-width', cssLength(stroke.width));", "  setStyle(element, 'border-width', cssLength(stroke.width * 2));") } `
  'tests/editor/stroke-semantics.spec.ts'

# --- M12: the group model ---------------------------------------------------------------
# M12 is the first milestone whose mutations land in *production* geometry rather than in a probe, so
# the list is organised by the claim each mutation is aimed at:
#
#   composition   worldTransformIn -- the three bugs this milestone actually had
#   traversal     tree.ts -- ownership, recursion, paint order
#   validation    the group scale rule and the id recursion
#   persistence   children are required, and their order is paint order
#   rendering     the renderer must see a flat, projected list
#
# `src/core/geom/linear-part.ts` (M10) is still not mutated: `isRotationTimesScale` is spec-only.

Add-Mutation 'a composed transform forces the scale uniform, discarding a leaf own non-uniform scale' `
  'src\model\transform.ts' `
  { param($t) $t.Replace("    scaleX: parent.scaleX * child.scaleX,`n    scaleY: parent.scaleY * child.scaleY,", "    scaleX: parent.scaleX * child.scaleX,`n    scaleY: parent.scaleX * child.scaleX,") } `
  'src/model/group-scale.test.ts'

Add-Mutation 'a composed transform drops the parent rotation, so nesting does not accumulate' `
  'src\model\transform.ts' `
  { param($t) $t.Replace('    rotation: parent.rotation + child.rotation,', '    rotation: child.rotation,') } `
  'src/model/group-scale.test.ts'

Add-Mutation 'a composed transform measures the displacement from the parent PAGE centre' `
  'src\model\transform.ts' `
  { param($t) $t.Replace("  const dx = childCentreX - parentLocalCentreX;`n  const dy = childCentreY - parentLocalCentreY;", "  const dx = childCentreX - parentCentreX;`n  const dy = childCentreY - parentCentreY;") } `
  'src/model/group-scale.test.ts'

Add-Mutation 'a node edit does not reach into group children' `
  'src\model\tree.ts' `
  { param($t) $t.Replace("    if (isGroup(next)) {`n      const children = mapList(next.children, ids, fn);", "    if (false) {`n      const children = mapList(next.children, ids, fn);") } `
  'src/model/tree.test.ts'

Add-Mutation 'a removal does not reach into group children' `
  'src\model\tree.ts' `
  { param($t) $t.Replace("    if (isGroup(node)) {`n      const children = removeFrom(node.children, ids);", "    if (false) {`n      const children = removeFrom(node.children, ids);") } `
  'src/model/tree.test.ts'

Add-Mutation 'paint order stops at a group, so children are omitted' `
  'src\model\tree.ts' `
  { param($t) $t.Replace("  for (const child of node.children) {`n    collectPlacements(child, world, transform, depth + 1, nextAncestors, out);`n  }", "  for (const child of []) {`n    collectPlacements(child, world, transform, depth + 1, nextAncestors, out);`n  }") } `
  'src/model/tree.test.ts'

Add-Mutation 'a group scale need not be uniform' `
  'src\model\invariants.ts' `
  { param($t) $t.Replace('  if (Math.abs(transform.scaleX - transform.scaleY) > UNIFORM_SCALE_EPSILON) {', '  if (false) {') } `
  'src/model/group-scale.test.ts'

Add-Mutation 'a dangling asset reference inside a group is not reported' `
  'src\model\invariants.ts' `
  { param($t) $t.Replace("  if (node.type === 'image') {`n    if (assets !== null && Object.hasOwn(assets, node.asset)) return;", "  if (node.type === 'image') {`n    if (true) return;") } `
  'src/model/tree.test.ts'

Add-Mutation 'a group children array is optional and defaults to empty' `
  'src\persist\deserialize.ts' `
  { param($t) $t.Replace("        children: expectArray(record['children'], ```${path}.children```).map((child, index) =>", "        children: (record['children'] === undefined ? [] : expectArray(record['children'], ```${path}.children```)).map((child, index) =>") } `
  'tests/persist/group-persistence.test.ts'

Add-Mutation 'group children are sorted on write, losing paint order' `
  'src\persist\serialize.ts' `
  { param($t) $t.Replace('        children: node.children.map(canonicalNode),', '        children: [...node.children].sort((a, b) => (a.id < b.id ? -1 : 1)).map(canonicalNode),') } `
  'tests/persist/group-persistence.test.ts'

Add-Mutation 'id collection skips group children, so a generated id can collide' `
  'src\persist\deserialize.ts' `
  { param($t) $t.Replace('    if (node.type === ''group'') collectNodeIds(node.children, out);', "    if (node.type === 'group') { /* mutation: the children are not collected */ }") } `
  'tests/persist/group-persistence.test.ts'

Add-Mutation 'the renderer is handed the raw page array, so groups reach it unflattened' `
  'src\render\document-view.ts' `
  { param($t) $t.Replace('      const projected = placementsOnPage(page).map(projectPlacement);', "      const projected = page.objects.filter((node) => node.type !== 'group') as Node[];") } `
  'tests/editor/group-geometry.spec.ts'

Add-Mutation 'a hidden group no longer hides its children' `
  'src\render\document-view.ts' `
  { param($t) $t.Replace('  const hidden = placement.ancestors.some((ancestor) => !ancestor.visible);', '  const hidden = false;') } `
  'tests/editor/group-geometry.spec.ts'

Add-Mutation 'hit testing ignores the ancestor visibility chain' `
  'src\editor\selection.ts' `
  { param($t) $t.Replace("  for (const ancestor of placement.ancestors) {`n    if (!ancestor.visible) return false;", "  for (const ancestor of []) {`n    if (!ancestor.visible) return false;") } `
  'tests/editor/group-geometry.spec.ts'

Add-Mutation 'the chrome is drawn from the node own local transform, not the composed one' `
  'src\editor\editor.ts' `
  { param($t) $t.Replace("        rect: toRect(placement.transform),`n        // The composed linear part", "        rect: toRect(node.transform),`n        // The composed linear part") } `
  'tests/editor/group-geometry.spec.ts'
# --- M14: asset garbage collection -----------------------------------------------------
# ADR 0014. The list is organised by the claim each mutation is aimed at, and the reach mutations come
# first because they are the ones a shallow walk would pass by accident:
#
#   reach     a walk that only sees top-level images, or that treats hidden as unreferenced
#   count     reference counting rather than ownership -- one asset, two images
#   no-op     rebuilding the table when there is nothing to collect

Add-Mutation 'garbage collection only sees top-level images' `
  'src\model\assets.ts' `
  { param($t) $t.Replace("  for (const placement of placementsInDocument(doc)) {`n    if (placement.node.type === 'image') out.add(placement.node.asset);`n  }","  for (const page of doc.pages) {`n    for (const node of page.objects) {`n      if (node.type === 'image') out.add(node.asset);`n    }`n  }") } `
  'src/model/asset-gc.test.ts'

# The plausible wrong implementation, aimed at the **ancestor chain** rather than the leaf.
#
# A first attempt filtered on `placement.node.visible` and *survived*, which is informative rather than
# merely inconvenient: a leaf inside a hidden group is itself `visible: true` -- the hidden-ness is on
# the ancestor -- so that substitution was a no-op. Recorded because "did the leaf go dark, or did its
# container?" is exactly the question a reach walk has to answer, and it is why the test asserts that
# `placement.node.visible` is *not* the answer.
Add-Mutation 'garbage collection treats an image under a hidden group as unreferenced' `
  'src\model\assets.ts' `
  { param($t) $t.Replace("    if (placement.node.type === 'image') out.add(placement.node.asset);", "    if (placement.ancestors.some((group) => !group.visible)) continue;`n    if (placement.node.type === 'image') out.add(placement.node.asset);") } `
  'src/model/asset-gc.test.ts'

Add-Mutation 'a shared asset is collected while an image still uses it' `
  'src\model\assets.ts' `
  { param($t) $t.Replace("    .filter((id) => !referenced.has(id))","    .filter(() => true)") } `
  'src/model/asset-gc.test.ts'

Add-Mutation 'a collection with nothing to collect rebuilds the table anyway' `
  'src\model\commands.ts' `
  { param($t) $t.Replace("        const table = prunedAssetTable(doc);`n        if (table === null) return doc;`n        return { ...doc, assets: table };","        const table = prunedAssetTable(doc) ?? { ...doc.assets };`n        return { ...doc, assets: table };") } `
  'src/model/asset-gc.test.ts'

# ---------------------------------------------------------------------------
# M16 -- alignment and distribution
#
# The corpus above is complete through M15. These cover the new geometry in `model/arrange.ts` and the
# page-to-local conversion in `editor/transform.ts` that ADR 0016 records.
#
# Two rules this block follows, both learned the hard way:
#
#  - **Every substitution is a single line.** An earlier draft anchored on two or three lines joined with
#    `` `r`n ``, and six of them silently failed to apply because the working tree is LF. The runner reports
#    that as "mutation site not found", which is not a pass -- so single-line anchors only.
#  - **Each label names the mistake and the test that must catch it.** A mutant that survives "because the
#    UI test happened to pass" is exactly what must not be accepted.
# ---------------------------------------------------------------------------

Add-Mutation 'aligning uses the model frame instead of the painted bounds' `
  'src\model\arrange.ts' `
  { param($t) $t.Replace('  if (!isGroup) return paintedBounds(worldTransform);', '  if (!isGroup) return { x: worldTransform.x, y: worldTransform.y, width: worldTransform.width, height: worldTransform.height };') } `
  'src/model/arrange.test.ts'

Add-Mutation 'a group is framed by its own transparent box rather than its members' `
  'src\model\arrange.ts' `
  { param($t) $t.Replace('  if (!isGroup) return paintedBounds(worldTransform);', '  return paintedBounds(worldTransform);') } `
  'src/model/arrange.test.ts'

Add-Mutation 'the descendant union skips a group one level down' `
  'src\model\arrange.ts' `
  { param($t) $t.Replace('    .filter((candidate) => candidate.ancestors.some((group) => group.id === id))', '    .filter((candidate) => candidate.ancestors.length === 1 && candidate.ancestors[0]?.id === id)') } `
  'src/model/arrange.test.ts'

Add-Mutation 'align right behaves as align left' `
  'src\model\arrange.ts' `
  { param($t) $t.Replace('      return { x: bounds.x + bounds.width - (box.x + box.width), y: 0 };', '      return { x: bounds.x - box.x, y: 0 };') } `
  'src/model/arrange.test.ts'

Add-Mutation 'align horizontal centre aligns the left edge instead' `
  'src\model\arrange.ts' `
  { param($t) $t.Replace('      return { x: bounds.x + bounds.width / 2 - (box.x + box.width / 2), y: 0 };', '      return { x: bounds.x - box.x, y: 0 };') } `
  'src/model/arrange.test.ts'

Add-Mutation 'align vertical centre aligns the top edge instead' `
  'src\model\arrange.ts' `
  { param($t) $t.Replace('      return { x: 0, y: bounds.y + bounds.height / 2 - (box.y + box.height / 2) };', '      return { x: 0, y: bounds.y - box.y };') } `
  'src/model/arrange.test.ts'

Add-Mutation 'align bottom behaves as align top' `
  'src\model\arrange.ts' `
  { param($t) $t.Replace('      return { x: 0, y: bounds.y + bounds.height - (box.y + box.height) };', '      return { x: 0, y: bounds.y - box.y };') } `
  'src/model/arrange.test.ts'

Add-Mutation 'alignment is offered with a single object selected' `
  'src\model\arrange.ts' `
  { param($t) $t.Replace('    ? targets.length >= MIN_ALIGN', '    ? targets.length >= 1') } `
  'src/model/arrange.test.ts'

Add-Mutation 'distribution is offered with two objects, where both are anchors' `
  'src\model\arrange.ts' `
  { param($t) $t.Replace('    : targets.length >= MIN_DISTRIBUTE', '    : targets.length >= MIN_ALIGN') } `
  'src/model/arrange.test.ts'

Add-Mutation 'distribution spaces the centres rather than the gaps' `
  'src\model\arrange.ts' `
  { param($t) $t.Replace('  const gap = (span - total) / (sorted.length - 1);', '  const gap = span / (sorted.length - 1) - 1;') } `
  'src/model/arrange.test.ts'

Add-Mutation 'a negative distribution gap is refused rather than applied' `
  'src\model\arrange.ts' `
  { param($t) $t.Replace('  const gap = (span - total) / (sorted.length - 1);', '  const gap = Math.max(0, (span - total) / (sorted.length - 1));') } `
  'src/model/arrange.test.ts'

Add-Mutation 'the outermost object is distributed too, instead of anchoring it' `
  'src\model\arrange.ts' `
  { param($t) $t.Replace('  for (const target of sorted.slice(1, -1)) {', '  for (const target of sorted) {') } `
  'src/model/arrange.test.ts'

Add-Mutation 'distribution tie-breaks on input order instead of id' `
  'src\model\arrange.ts' `
  { param($t) $t.Replace('    return delta !== 0 ? delta : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;', '    return delta;') } `
  'src/model/arrange.test.ts'

Add-Mutation 'distribution sorts vertically when asked for horizontal' `
  'src\model\arrange.ts' `
  { param($t) $t.Replace("  const horizontal = axis === 'horizontal';", "  const horizontal = false;") } `
  'src/model/arrange.test.ts'

Add-Mutation 'a spread is distributed horizontally even when asked for vertical' `
  'src\model\arrange.ts' `
  { param($t) $t.Replace("  const extent = (target: ArrangeTarget): number =>", "  const extent = (): number =>") } `
  'src/model/arrange.test.ts'

Add-Mutation 'an already-aligned selection records a no-op undo step' `
  'src\model\arrange.ts' `
  { param($t) $t.Replace('    if (delta.x === 0 && delta.y === 0) return;', '') } `
  'src/model/arrange.test.ts'

Add-Mutation 'arrangement scales the object instead of translating it' `
  'src\model\arrange.ts' `
  { param($t) $t.Replace('  return { ...transform, x: transform.x + deltaParent.x, y: transform.y + deltaParent.y };', '  return { ...transform, x: transform.x + deltaParent.x, y: transform.y + deltaParent.y, width: transform.width * 1.01 };') } `
  'src/model/arrange.test.ts'

Add-Mutation 'arrangement clears the rotation instead of preserving it' `
  'src\model\arrange.ts' `
  { param($t) $t.Replace('  return { ...transform, x: transform.x + deltaParent.x, y: transform.y + deltaParent.y };', '  return { ...transform, x: transform.x + deltaParent.x, y: transform.y + deltaParent.y, rotation: 0 };') } `
  'src/model/arrange.test.ts'

Add-Mutation 'a target the selection named is dropped when it has no painted box' `
  'src\model\arrange.ts' `
  { param($t) $t.Replace('    if (painted === null) return;', '    if (painted === null) targets.push({ id, transform, ancestors, painted: { x: 0, y: 0, width: 0, height: 0 } });') } `
  'src/model/arrange.test.ts'

Add-Mutation 'the page-space delta is applied as a parent-local one (the pre-M16 drag defect)' `
  'src\editor\transform.ts' `
  { param($t) $t.Replace('  if (ancestors.length === 0) return deltaPage;', '  return deltaPage;') } `
  'src/editor/transform.test.ts'

Add-Mutation 'the page-to-local conversion uses the parent rather than its inverse' `
  'src\editor\transform.ts' `
  { param($t) $t.Replace('  const inverse = invert(parentWorldMatrix(ancestors));', '  const inverse = parentWorldMatrix(ancestors);') } `
  'src/editor/transform.test.ts'

Add-Mutation 'the page-to-local conversion maps the origin instead of differencing two points' `
  'src\editor\transform.ts' `
  { param($t) $t.Replace('  return { x: to.x - from.x, y: to.y - from.y };', '  return { x: to.x, y: to.y };') } `
  'src/editor/transform.test.ts'
# NOT a mutant: reversing the ancestor chain is an **equivalent** change, and the corpus should not carry
# something that cannot fail. With every scale in a chain uniform -- the invariant worldTransformIn",

#
#     R(a)*S(s) * R(b)*S(t)  =  s*t*R(a+b)
#
# so the two groupings differ by nothing. Verified by measurement rather than by argument: reversing the
# chain moves the nested leaf by 30.000000 / -20.000000 either way, the requested page delta to every
# decimal place. A non-uniform scale would break the identity, and UNIFORM_SCALE_EPSILON refuses such a
# document before it can reach here.
  'src/editor/transform.test.ts'

Add-Mutation 'the ancestor chain ignores the outermost group' `
  'src\editor\transform.ts' `
  { param($t) $t.Replace('  for (const ancestor of ancestors) {', '  for (const ancestor of ancestors.slice(1)) {') } `
  'src/editor/transform.test.ts'

# --- M17 -- snapping and guides ---------------------------------------------------------
#
# Covers `model/snap.ts` (the pure calculation, the zoom conversion, target selection) and the gesture
# integration in `editor/editor.ts` (the captured box, Alt suppression, guide lifetime).
#
# Three of these exist specifically to pin the F21 defect, which was invisible to the unit suite because
# the pure engine was always correct and only the *integration* re-read the document. A mutation corpus
# that cannot express "the moving box is re-derived from the live document" cannot guard the fix.
# ---------------------------------------------------------------------------

Add-Mutation 'the threshold is a document-space constant instead of screen px divided by zoom' `
  'src\model\snap.ts' `
  { param($t) $t.Replace('  return SNAP_THRESHOLD_SCREEN_PX / Math.max(zoom, Number.EPSILON);', '  return SNAP_THRESHOLD_SCREEN_PX;') } `
  'src/model/snap.test.ts'

Add-Mutation 'the threshold multiplies by zoom instead of dividing (the screen px become document px)' `
  'src\model\snap.ts' `
  { param($t) $t.Replace('  return SNAP_THRESHOLD_SCREEN_PX / Math.max(zoom, Number.EPSILON);', '  return SNAP_THRESHOLD_SCREEN_PX * Math.max(zoom, Number.EPSILON);') } `
  'src/model/snap.test.ts'

Add-Mutation 'a candidate exactly at the threshold does not qualify (the boundary becomes exclusive)' `
  'src\model\snap.ts' `
  { param($t) $t.Replace('      if (distance > threshold) continue;', '      if (distance >= threshold) continue;') } `
  'src/model/snap.test.ts'

Add-Mutation 'the largest distance within the threshold wins instead of the smallest' `
  'src\model\snap.ts' `
  { param($t) $t.Replace('      if (best === null || distance < Math.abs(best.delta)) {', '      if (best === null || distance > Math.abs(best.delta)) {') } `
  'src/model/snap.test.ts'

Add-Mutation 'the tie-break keeps the later candidate rather than the first scanned' `
  'src\model\snap.ts' `
  { param($t) $t.Replace('      if (best === null || distance < Math.abs(best.delta)) {', '      if (distance <= Math.abs(best?.delta ?? Number.POSITIVE_INFINITY)) {') } `
  'src/model/snap.test.ts'

Add-Mutation 'page features are scanned after objects, so an exact tie goes to the movable one' `
  'src\model\snap.ts' `
  { param($t) $t.Replace('  for (const entry of pageFeatures(pageRect, axis)) {', '  for (const entry of [] as readonly { feature: SnapFeature; position: number; targetId: null }[]) {') } `
  'src/model/snap.test.ts'

Add-Mutation 'only one axis can snap at a time (a corner drag gets one guide instead of two)' `
  'src\model\snap.ts' `
  { param($t) $t.Replace('    adjustment: { x: x === null ? 0 : x.delta, y: y === null ? 0 : y.delta },', '    adjustment: { x: x === null ? 0 : x.delta, y: 0 },') } `
  'src/model/snap.test.ts'

Add-Mutation 'the vertical centre is not a snap feature' `
  'src\model\snap.ts' `
  { param($t) $t.Replace("        { feature: 'center-v', position: rect.y + rect.height / 2 },", '') } `
  'src/model/snap.test.ts'

Add-Mutation 'a group is not offered as a snap target (allNodes yields leaves only)' `
  'src\model\snap.ts' `
  { param($t) $t.Replace('    if (placement.ancestors.some((ancestor) => skip.has(ancestor.id))) continue;', '') } `
  'src/model/snap.test.ts'

Add-Mutation "a selected group's members remain snap targets (self-snap through the group)" `
  'src\model\snap.ts' `
  { param($t) $t.Replace('    if (placement.ancestors.some((ancestor) => skip.has(ancestor.id))) continue;', '    if (false) continue;') } `
  'src/model/snap.test.ts'

Add-Mutation 'translateBounds mutates the box it is given' `
  'src\model\snap.ts' `
  { param($t) $t.Replace('  return { ...rect, x: rect.x + delta.x, y: rect.y + delta.y };', '  rect.x += delta.x; rect.y += delta.y; return rect;') } `
  'src/model/snap.test.ts'

Add-Mutation 'the moving arrangement is the last member instead of the union' `
  'src\model\snap.ts' `
  { param($t) $t.Replace('  return arrangeBounds(arrangeTargets(doc, ids));', '  const t = arrangeTargets(doc, ids); return t.length === 0 ? null : t[t.length - 1]!.painted;') } `
  'src/model/snap.test.ts'

# --- M17 gesture integration (browser) --------------------------------------------------

Add-Mutation 'the move gesture re-derives its box from the live document each frame (the F21 defect)' `
  'src\editor\editor.ts' `
  { param($t) $t.Replace('      const unsnapped = translateBounds(gesture.bounds, { x: dx, y: dy });', '      const unsnapped = translateBounds(movingBounds(this.doc, gesture.start.keys()) ?? gesture.bounds, { x: dx, y: dy });') } `
  'tests/editor/snap.spec.ts'

Add-Mutation 'Alt does not suppress snapping' `
  'src\editor\editor.ts' `
  { param($t) $t.Replace('    if (!altKey && gesture.bounds !== null) {', '    if (gesture.bounds !== null) {') } `
  'tests/editor/snap.spec.ts'

Add-Mutation 'the threshold uses a fixed document-space constant, so zoom stops mattering' `
  'src\editor\editor.ts' `
  { param($t) $t.Replace('      threshold: snapThresholdDocument(this.viewport.zoom),', '      threshold: 10,') } `
  'tests/editor/snap.spec.ts'

Add-Mutation 'guides survive the end of a move gesture (the clearing in pointerUp is dropped)' `
  'src\editor\editor.ts' `
  { param($t) [regex]::Replace($t, '    this\.snapLines = \[\];', '', 1) } `
  'tests/editor/snap.spec.ts'

Add-Mutation 'a cancelled drag leaves its guide on the canvas' `
  'src\editor\editor.ts' `
  { param($t) [regex]::Replace($t, '    this\.snapLines = \[\];', '', 2) } `
  'tests/editor/snap.spec.ts'
# --- M18 -- visibility in arrangement bounds ------------------------------------------------
#
# `arrangeTargets` answers "line these up as I see them", so a box for something that is not on the page is
# a wrong answer rather than a conservative one. These four cover the effective-visibility rule and the two
# places it is applied, so a regression cannot pass by accident through either the leaf check or the group
# union.
# ---------------------------------------------------------------------------

Add-Mutation 'a hidden object still contributes its box to an arrangement target' `
  'src\model\arrange.ts' `
  { param($t) $t.Replace('  if (!placement.node.visible) return false;', '  if (false) return false;') } `
  'src/model/arrange.test.ts'

Add-Mutation 'the ancestor chain is ignored, so a hidden group no longer hides its subtree' `
  'src\model\arrange.ts' `
  { param($t) $t.Replace('  return placement.ancestors.every((ancestor) => ancestor.visible);', '  return true;') } `
  'src/model/arrange.test.ts'

Add-Mutation 'arrangement targets are resolved without filtering on visibility at all' `
  'src\model\arrange.ts' `
  { param($t) $t.Replace('  const leaves = placementsInDocument(doc).filter(isEffectivelyVisible);', '  const leaves = placementsInDocument(doc);') } `
  'src/model/arrange.test.ts'

# NOT a mutant: dropping the `location.node.type !== 'group'` guard is an **equivalent** change, so the
# corpus should not carry something that cannot fail. The guard and the `emit` call are redundant with each
# other by construction:
#
#   if (location === null || location.node.type !== 'group') continue;
#   emit(location.node.id, true, ...);            <-- isGroup is a literal `true`
#
# `isGroup` is hardcoded, so a leaf that slips past the guard is resolved as a **group**, and a group has no
# box unless a visible leaf lists it as an ancestor. There is none, so `boxFor` returns null and `emit`
# declines -- the same outcome the guard produced. Verified by measurement: with the guard removed,
# `arrangeTargets(doc, ['a', 'hid'])` still returns `['a']` for a hidden `hid`.
#
# The guard is kept anyway, because it states the invariant at the point where a future edit would break it.
# The failure it prevents is not the dropped box -- `isGroup: true` already gives that -- but the *wrong*
# box: restoring `location.node.type === 'group'` would hand `emit` the authored parent-local transform where
# `leafWorld` expects a page-space one.
# --- Tool keyboard shortcuts -----------------------------------------------------------------
#
# The four tool buttons carried `title` attributes promising V/R/E/L for their whole life and nothing
# bound them. No suite could see it, because the defect is the *absence* of behaviour -- no test pressed
# a key and expected a tool to change, because the interface was documented in a tooltip and implemented
# nowhere. This block exists so that cannot recur silently.
#
# The text-session test is the one that earns its keep: putting these bindings in `shortcuts.ts` instead
# of `editing-shortcuts.ts` would make them fire during an open text session, because only the latter
# returns early for one.
# ---------------------------------------------------------------------------

Add-Mutation 'the tool shortcuts are not bound (the original defect: titles promising keys nothing handles)' `
  'src\ui\chrome\editing-shortcuts.ts' `
  { param($t) $t.Replace('      const tool = TOOL_KEYS[event.key.toLowerCase()];', '      const tool = TOOL_KEYS[''__never__'' + event.key.toLowerCase()];') } `
  'tests/editor/tool-shortcuts.spec.ts'

Add-Mutation 'a tool shortcut fires while a text session is open, swapping the tool mid-edit' `
  'src\ui\chrome\editing-shortcuts.ts' `
  { param($t) $t.Replace("    if (editor.currentMode === 'textEdit') {", "    if (editor.currentMode === 'textEdit' && false) {") } `
  'tests/editor/tool-shortcuts.spec.ts'
Add-Mutation 'V arms a draw tool instead of returning to select' `
  'src\ui\chrome\editing-shortcuts.ts' `
  { param($t) $t.Replace("  v: 'select',", "  v: 'rect',") } `
  'tests/editor/tool-shortcuts.spec.ts'
# --- M19 -- print profile and PDF export -------------------------------------------------
#
# Two groups, and the split matters. The size derivation is pure and is unit-tested; the stylesheet
# only exists at print time, so it can only be checked by generating output.
#
# The stylesheet mutants are the interesting ones. They are all *absences* of an override -- drop this
# `!important`, drop that `break-after` -- which is the shape a print profile fails in: the screen
# layout is still correct and only the sheets are wrong. Each of these was checked by rebuilding
# `dist/` and running the browser suite, because since M15 the suite serves the built bundle and a
# stylesheet mutation that is not rebuilt cannot reach it at all (ADR 0016 F17).
# ---------------------------------------------------------------------------

Add-Mutation 'the print sheet ignores orientation, so landscape prints portrait' `
  'src\ui\print-profile.ts' `
  { param($t) $t.Replace('  const extent = pageExtentPx(size);', '  const extent = { width: size.width, height: size.height };') } `
  'src/ui/print-profile.test.ts'

# M20 replaced the single `@page` rule with one *named* rule per sheet, so this site had to move with
# it. While it was stale the runner reported "mutation site not found" and refused to count it -- which
# is the correct outcome, and is the reason this corpus is worth having: a mutant that no longer applies
# is not a pass. Do not "fix" this by loosening the pattern into one that matches anything.
Add-Mutation 'the injected @page rule drops margin: 0, so every sheet gains a default margin' `
  'src\ui\print-profile.ts' `
  { param($t) $t.Replace('`@page ${printPageName(index)} { size: ${printSheetSize(size)}; margin: 0; }`', '`@page ${printPageName(index)} { size: ${printSheetSize(size)} }`') } `
  'src/ui/print-profile.test.ts'

Add-Mutation 'the print stylesheet leaves the editor toolbar in the output' `
  'src\ui\styles.css' `
  { param($t) $t.Replace("  .toolbar,`n  .ruler-corner,", '  .ruler-corner,') } `
  'tests/editor/print.spec.ts'

Add-Mutation 'the print stylesheet leaves the selection overlay in the output' `
  'src\ui\styles.css' `
  { param($t) $t.Replace("  .status,`n  .overlay {", '  .status {') } `
  'tests/editor/print.spec.ts'

Add-Mutation 'zoom is not neutralised for print, so the stack prints scaled' `
  'src\ui\styles.css' `
  { param($t) $t.Replace('    transform: none !important;', '    transform: none;') } `
  'tests/editor/print.spec.ts'

Add-Mutation 'the canvas spacer keeps its zoomed inline height, so a page stack prints an extra blank sheet' `
  'src\ui\styles.css' `
  { param($t) $t.Replace("    width: auto !important;`n    height: auto !important;", '') } `
  'tests/editor/print.spec.ts'

Add-Mutation 'pages do not break, so a multi-page document prints onto one sheet' `
  'src\ui\styles.css' `
  { param($t) $t.Replace("    break-after: page;`n    page-break-after: always;", '') } `
  'tests/editor/print.spec.ts'

Add-Mutation 'the last page also breaks, so a trailing blank sheet is printed' `
  'src\ui\styles.css' `
  { param($t) $t.Replace("  .page:last-child {`n    break-after: auto;`n    page-break-after: auto;`n  }", '') } `
  'tests/editor/print.spec.ts'

# The site is the *standard* declaration. Mutating the `-webkit-` prefixed one instead is a
# conditionally equivalent change: Chromium honours either, so with the standard property still
# present the computed value does not move, and the mutant survives for a reason that has nothing to do
# with whether backgrounds print. The prefixed declaration stays as the Safari fallback it is.
Add-Mutation 'authored page backgrounds are dropped, so a coloured page prints white' `
  'src\ui\styles.css' `
  { param($t) $t.Replace('    print-color-adjust: exact;', '    print-color-adjust: economy;') } `
  'tests/editor/print.spec.ts'

Add-Mutation 'the print profile is written once and never updated, so a newly opened document keeps the old sheet size' `
  'src\ui\print-profile.ts' `
  { param($t) $t.Replace('    if (existing.textContent !== css) existing.textContent = css;', '    return css;') } `
  'tests/editor/print.spec.ts'

# ---------------------------------------------------------------------------
# Per-page dimensions (M20)
# ---------------------------------------------------------------------------
#
# M20 added ~600 lines of page geometry across three new modules and reached none of them:
# `page-resize.ts` and `page-setup.ts` had no mutants at all, so a 28-minute run was reporting a green
# gate over code it had never touched. Each of these is aimed at a *decision* rather than a keystroke:
#
#  * `scale` fitting by the larger axis ratio instead of the smaller, which is the whole reason it is
#    `min` -- content that fitted stops fitting, the exact opposite of the promise.
#  * `push` judging a top-level node by its authored frame rather than where it *paints*, and pushing
#    the two sets the wrong way round. `page-resize.ts` carries a comment recording that the first draft
#    judged leaves instead of top-level nodes and silently skipped a straddling group; these two pin the
#    distinction from both sides.
#  * `pageSizesEqual` ignoring orientation, which would make a portrait/landscape flip a silent no-op.
#  * `sizeForNewPage` dropping the `fixedSize` branch, collapsing a mixed-size document to uniform.
#  * `remapNodeIds` not recursing, putting two nodes in one document under one id -- the collision
#    `assertDocumentIsConsistent` refuses on load, so the mutant fails at *open*, not at the copy.
#
# All target `page-commands.test.ts`, which is where the semantics are pinned. The one exception is the
# named-page selector, which needs a generated PDF to be falsifiable at all: a unit test can only prove
# the CSS *says* `p0`, so it is aimed at `print-mixed-size.spec.ts`, which reads `/MediaBox` out of real
# output.
#
# Two of these survived their first run, and both survivors were real holes rather than bad mutants --
# `MAX_PAGE_EDGE` and `paintedBounds` were pinned by nothing. The tests that close them are in
# `page-commands.test.ts` and say so where they are.
# ---------------------------------------------------------------------------

Add-Mutation 'scale fits by the larger axis ratio, so content overflows the page it was scaled for' `
  'src\model\page-resize.ts' `
  { param($t) $t.Replace('Math.min(byWidth, byHeight)', 'Math.max(byWidth, byHeight)') } `
  'src/model/page-commands.test.ts'

Add-Mutation 'push judges the authored frame rather than the painted one, so a rotated object is judged on its unrotated box' `
  'src\model\page-resize.ts' `
  { param($t) $t.Replace('const bounds = paintedBounds(node.transform);', 'const bounds = node.transform;') } `
  'src/model/page-commands.test.ts'

Add-Mutation 'push moves what still fits and keeps what overflows, so the wrong objects change page' `
  'src\model\page-resize.ts' `
  { param($t) $t.Replace('? fits : overflows', '? overflows : fits') } `
  'src/model/page-commands.test.ts'

Add-Mutation 'scale moves x but not width, so content is scaled out of alignment with its own box' `
  'src\model\page-resize.ts' `
  { param($t) $t.Replace('width: transform.width * ratio,', 'width: transform.width,') } `
  'src/model/page-commands.test.ts'

Add-Mutation 'a duplicated page keeps its descendants ids, so two nodes claim one identity' `
  'src\model\page-resize.ts' `
  { param($t) $t.Replace('children: input.children.map(walk)', 'children: input.children') } `
  'src/model/page-commands.test.ts'

Add-Mutation 'orientation does not participate in page size equality, so flipping a page is a silent no-op' `
  'src\model\page-setup.ts' `
  { param($t) $t.Replace('a.orientation === b.orientation', 'true') } `
  'src/model/page-commands.test.ts'

Add-Mutation 'a new page always inherits the preceding page, so fixedSize: true stops producing a uniform document' `
  'src\model\page-setup.ts' `
  { param($t) $t.Replace('if (setup.fixedSize) return clonePageSize(setup.defaultSize);', '') } `
  'src/model/page-commands.test.ts'

Add-Mutation 'the printable page-edge limit is raised out of reach, so an unprintable page is accepted' `
  'src\model\page-setup.ts' `
  { param($t) $t.Replace('export const MAX_PAGE_EDGE = 5000;', 'export const MAX_PAGE_EDGE = 500000;') } `
  'src/model/page-commands.test.ts'

Add-Mutation 'the last page can be deleted, so the document is left with no pages at all' `
  'src\model\commands.ts' `
  { param($t) $t.Replace('if (doc.pages.length <= 1) return doc;', 'if (doc.pages.length < 0) return doc;') } `
  'src/model/page-commands.test.ts'

Add-Mutation 'every page selects the first page named sheet, so a mixed-size document prints at one size' `
  'src\ui\print-profile.ts' `
  { param($t) $t.Replace('printPageName(index)', 'printPageName(0)') } `
  'tests/editor/print-mixed-size.spec.ts'
# ---------------------------------------------------------------------------
# Typography (M21)
# ---------------------------------------------------------------------------
#
# M21 reached three files the corpus had never looked at: `rich-text.ts` (the run/paragraph
# normalisation that carries ADR 0003's property placement), the inspector's commit path, and the
# formatting shortcut map. A 28-minute run was reporting a green gate over them.
#
# Each of these is a rule rather than a keystroke, and the ones worth killing are the ones whose
# failure is invisible on screen. A normaliser that fails to merge runs of equal format renders
# identically and only shows up as a document that re-saves differently each time. A toolbar that
# reports "not bold" for a fully bold frame looks fine until someone relies on it. `dir="auto"`
# missing costs nothing in a Latin document and misplaces a full stop at the end of an Arabic
# sentence.
#
# `rich-text.ts` is aimed at by six and `rich-text.test.ts` is the target: these are pure functions
# and their behaviour is only observable structurally, which is where it should be pinned.

Add-Mutation 'adjacent runs with equal formatting are never merged, so the same text has many spellings' `
  'src\model\rich-text.ts' `
  { param($t) $t.Replace('if (previous !== undefined && formatsEqual(previous.format, run.format)) {', 'if (false) {') } `
  'src/model/rich-text.test.ts'

Add-Mutation 'runs with *different* formatting are merged, so formatting is lost at every boundary' `
  'src\model\rich-text.ts' `
  { param($t) $t.Replace('formatsEqual(previous.format, run.format)', 'true') } `
  'src/model/rich-text.test.ts'

Add-Mutation 'empty runs are kept, so a browser-emitted empty run defeats merging' `
  'src\model\rich-text.ts' `
  { param($t) $t.Replace('if (run.text.length === 0) continue;', '') } `
  'src/model/rich-text.test.ts'

Add-Mutation 'an emptied paragraph keeps no run, so the caret has nowhere to sit' `
  'src\model\rich-text.ts' `
  { param($t) $t.Replace('if (runs.length === 0) runs.push({ text: '''' });', '') } `
  'src/model/rich-text.test.ts'

Add-Mutation 'toggling a flag only ever adds it, so a second press does not remove it' `
  'src\model\rich-text.ts' `
  { param($t) $t.Replace('if (next[flag] === true) delete next[flag];', '') } `
  'src/model/rich-text.test.ts'

Add-Mutation 'the toolbar reports a format as applied throughout when only some runs carry it' `
  'src\model\rich-text.ts' `
  { param($t) $t.Replace('if (r.format?.[flag] !== true) return false;', '') } `
  'src/model/rich-text.test.ts'

Add-Mutation 'an emptied inspector field is a typo rather than an unset, so a value can never be taken back' `
  'src\ui\inspector.ts' `
  { param($t) $t.Replace("      raw === ''`n        ? undefined`n        : field.kind === 'length'", "      false`n        ? undefined`n        : field.kind === 'length'") } `
  'tests/editor/typography-inspector.spec.ts'

Add-Mutation 'an unbalanced quote in a font stack is accepted, so CSS silently discards the declaration' `
  'src\ui\inspector.ts' `
  { param($t) $t.Replace('  if (quote !== null || depth !== 0) return null;', '  if (depth !== 0) return null;') } `
  'tests/editor/typography-inspector.spec.ts'

Add-Mutation 'Ctrl+Shift+X is not bound, so strikethrough has no shortcut' `
  'src\ui\chrome\editing-shortcuts.ts' `
  { param($t) $t.Replace("return event.shiftKey ? 'strike' : null;", 'return null;') } `
  'tests/editor/typography-shortcuts.spec.ts'

Add-Mutation 'plain Ctrl+X toggles strikethrough, taking away cut' `
  'src\ui\chrome\editing-shortcuts.ts' `
  { param($t) $t.Replace("return event.shiftKey ? 'strike' : null;", "return 'strike';") } `
  'tests/editor/typography-shortcuts.spec.ts'

Add-Mutation 'the formatting shortcut is not suppressed inside a form field, so Ctrl+U opens view-source' `
  'src\ui\chrome\editing-shortcuts.ts' `
  { param($t) $t.Replace('      if (isTypingTarget(event.target)) return;', '      if (false) return;') } `
  'tests/editor/typography-shortcuts.spec.ts'

Add-Mutation 'every paragraph resolves against a fixed LTR base instead of the authored direction' `
  'src\render\rich-text-html.ts' `
  { param($t) $t.Replace("paragraph.setAttribute('dir', block.dir ?? 'auto');", "paragraph.setAttribute('dir', 'ltr');") } `
  'src/render/rich-text-html.test.ts'

# ---------------------------------------------------------------------------
# Paragraph direction, indents and spacing, super and subscript (M22)
# ---------------------------------------------------------------------------
#
# M22 added a persisted paragraph shape, a walker that reads it back, and six flags, and the
# interesting decisions are all of the form "what does *absent* mean". That is what this section is
# aimed at, because every one of them produces a document that loads, saves and renders without an
# error while meaning something else -- the exact class of defect a green suite otherwise reports as
# success.
#
#  * `dir` defaulting to `'ltr'` on read instead of to nothing. The renderer would still set an
#    attribute, the file would still round-trip, and every neutral in every Arabic paragraph would
#    resolve the wrong way.
#  * `normalizeRichText` dropping `dir`/`metrics`. Found and fixed during M22 itself; pinned here so
#    the *next* paragraph property cannot be lost the same way. The same rebuild shape had already
#    been found in `setTextAlign` and `applyInlineFormat`.
#  * `setTextAlign` and `applyInlineFormat` rebuilding the block field by field again -- the two
#    defects the M22 browser suite caught, kept as mutants because they are the most likely shape of
#    the next one.
#  * A patch treating an *absent* key as "clear", which destroys the metrics it did not mention.
#  * Logical properties written as physical ones. `margin-inline-start` -> `margin-left` renders
#    identically in LTR, so only the RTL layout measurement can see it, which is why those two aim
#    at `typography-paragraph.spec.ts` and not at the unit suite.
#  * The two no-op guards removed, which do not crash -- they record an undo step that does nothing.
#
# The `metricState` pair is aimed at the field *label*, not the value: collapsing "mixed" back into
# `undefined` makes an inspector show "No first-line indent" over three paragraphs where two have
# one, which is false rather than merely unhelpful.
# One entry that *looks* like it belongs here is deliberately not: "every paragraph resolves against a
# fixed LTR base instead of the authored direction" is M21's `dir="auto"` mutant, kept in the M21 block
# because that is where it was written. Its substitution changed when M22 made `dir` authorable -- it
# used to delete the attribute, and now it pins the base direction -- but the claim it makes is M21's,
# so its identity is M21's.
# ---------------------------------------------------------------------------

Add-Mutation 'an absent paragraph direction reads as ltr instead of as nothing' `
  'src\render\rich-text-html.ts' `
  { param($t) $t.Replace("if (attribute === 'auto') return undefined;", "if (attribute === 'auto') return 'ltr';") } `
  'src/render/rich-text-html.paragraph.test.ts'


Add-Mutation 'normalizeRichText drops the paragraph direction' `
  'src\model\rich-text.ts' `
  { param($t) $t.Replace("...(block.dir === undefined ? {} : { dir: block.dir }),", '') } `
  'src/model/rich-text.test.ts'

Add-Mutation 'normalizeRichText drops the paragraph metrics' `
  'src\model\rich-text.ts' `
  { param($t) $t.Replace("...(block.metrics === undefined ? {} : { metrics: { ...block.metrics } }),", '') } `
  'src/model/rich-text.test.ts'

Add-Mutation 'paragraph equality ignores the metrics, so an indent edit is a no-op with no history' `
  'src\model\rich-text.ts' `
  { param($t) $t.Replace('if (!paragraphMetricsEqual(left.metrics, right.metrics)) return false;', '') } `
  'tests/model/paragraph-commands.test.ts'

Add-Mutation 'setTextAlign rebuilds the paragraph field by field, dropping direction and metrics' `
  'src\model\commands.ts' `
  { param($t) $t.Replace("...block," + "`n" + "              ...(align === null ? {} : { align }),", "kind: block.kind," + "`n" + "              ...(align === null ? {} : { align })," + "`n" + "              runs: block.runs,") } `
  'tests/model/paragraph-commands.test.ts'

Add-Mutation 'a metrics patch treats an absent key as clear, destroying the metrics it did not mention' `
  'src\model\commands.ts' `
  { param($t) $t.Replace('if (!(key in patch)) continue;', '') } `
  'tests/model/paragraph-commands.test.ts'

Add-Mutation 'setting the direction a paragraph already has is no longer a no-op' `
  'src\model\commands.ts' `
  { param($t) $t.Replace("if (node.text.blocks.every((block) => (block.dir ?? 'auto') === (dir ?? 'auto'))) return node;", '') } `
  'tests/model/paragraph-commands.test.ts'

Add-Mutation 'setParagraphMetrics has no no-op guard, so every keystroke records a dead undo step' `
  'src\model\commands.ts' `
  { param($t) $t.Replace('if (node.text.blocks.every((block) => paragraphMetricsEqual(block.metrics, merged(block)))) {', 'if (false) {') } `
  'tests/model/paragraph-commands.test.ts'

Add-Mutation 'the walker reads the start margin as a left margin, which happens to be right in LTR' `
  'src\render\rich-text-html.ts' `
  { param($t) $t.Replace("marginStart: 'margin-inline-start',", "marginStart: 'margin-left',") } `
  'src/render/rich-text-html.paragraph.test.ts'

Add-Mutation 'the first-line indent is written as a left indent, which happens to be right in LTR' `
  'src\render\rich-text-html.ts' `
  { param($t) $t.Replace("setStyle(paragraph, 'text-indent', optionalLength(metrics?.textIndent));", "paragraph.style.marginLeft = optionalLength(metrics?.textIndent);") } `
  'tests/editor/typography-paragraph.spec.ts'

Add-Mutation 'the walker never reads the indents back, so the first keystroke discards them' `
  'src\render\rich-text-html.ts' `
  { param($t) $t.Replace('metrics = readMetrics(element) ?? metrics;', '') } `
  'src/render/rich-text-html.paragraph.test.ts'

Add-Mutation 'the walker never reads the direction back, so the first keystroke discards it' `
  'src\render\rich-text-html.ts' `
  { param($t) $t.Replace('dir = readDirection(element) ?? dir;', '') } `
  'src/render/rich-text-html.paragraph.test.ts'

Add-Mutation 'superscript renders as an ordinary wrapper, so it reads back as plain text' `
  'src\render\rich-text-html.ts' `
  { param($t) $t.Replace("{ flag: 'super', tag: 'sup' },", "{ flag: 'super', tag: 'b' },") } `
  'src/render/rich-text-html.paragraph.test.ts'

Add-Mutation 'superscript and subscript collapse into one flag, which is the second spelling problem' `
  'src\render\rich-text-html.ts' `
  { param($t) $t.Replace("next = { ...extend(), ...(tag === 'SUP' ? { super: true } : { sub: true }) };", "next = { ...extend(), super: true };") } `
  'src/render/rich-text-html.paragraph.test.ts'

Add-Mutation 'the format flag list omits super and subscript, so they are dropped on every save' `
  'src\persist\serialize.ts' `
  { param($t) $t.Replace("for (const flag of CHAR_FLAGS) {", "for (const flag of ['bold', 'italic', 'underline', 'strike'] as const) {") } `
  'tests/persist/version4-migration.test.ts'

Add-Mutation 'the signed/unsigned split between textIndent and the margins is inverted' `
  'src\persist\deserialize.ts' `
  { param($t) $t.Replace('key === ''textIndent''', 'key !== ''textIndent''') } `
  'tests/persist/version4-migration.test.ts'

Add-Mutation 'a version-3 paragraph carrying `dir` is accepted, so a v3 build would re-save without it' `
  'src\persist\format.ts' `
  { param($t) $t.Replace('return version >= 4 ? PARAGRAPH_KEYS : LEGACY_PARAGRAPH_KEYS;', 'return PARAGRAPH_KEYS;') } `
  'tests/persist/version4-migration.test.ts'

Add-Mutation 'the inspector reports a mixed indent as "no first-line indent"' `
  'src\ui\inspector.ts' `
  { param($t) $t.Replace("if (seen.size > 1) return { value: undefined, mixed: true };", "if (seen.size > 1) return { value: undefined, mixed: false };") } `
  'tests/editor/typography-paragraph.spec.ts'

Add-Mutation 'the clear-indents button is disabled whenever the fields read as mixed' `
  'src\ui\inspector.ts' `
  { param($t) $t.Replace('if (anyMetricIn(editor.doc, ids, field.key)) anyMetric = true;', '') } `
  'tests/editor/typography-paragraph.spec.ts'

Add-Mutation 'the super and subscript chords are swallowed inside a text session' `
  'src\ui\chrome\editing-shortcuts.ts' `
  { param($t) $t.Replace("const inside = characterFormatFlag(event);", 'const inside = null as ReturnType<typeof characterFormatFlag>;') } `
  'tests/editor/typography-paragraph.spec.ts'

Add-Mutation 'a paragraph property change is routed through the model even inside a session, double-applying it' `
  'src\ui\chrome\editing-shortcuts.ts' `
  { param($t) $t.Replace('if ((event.ctrlKey || event.metaKey) && inside !== null && !BROWSER_OWNS[inside]) {', 'if (false) {') } `
  'tests/editor/typography-paragraph.spec.ts'
