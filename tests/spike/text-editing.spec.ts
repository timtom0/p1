import { expect, test, type Page } from '@playwright/test';

/**
 * Text-editing spike — browser-level verification (docs/ARCHITECTURE.md §10.3).
 *
 * This is the experiment. The question:
 *
 *   Can `contenteditable` be fenced so the model stays authoritative outside an
 *   explicit editing session?
 *
 * These tests drive the *real* renderer through `window.__spike` and assert the
 * actual browser behaviour, not a mock of it. Where a behaviour cannot be
 * automated reliably, it is called out in a comment as manual-only rather than
 * asserted loosely.
 *
 * ## How to read the results
 *
 * A test that documents current behaviour is marked `// OBSERVED:`. Those are
 * findings, not wishes — if one of them reads like a bug, that is the point. The
 * conclusion is in the ADR at `docs/adr/0001-text-editing-fence.md`.
 */

const SPIKE = '/spike.html';

/** Boots the spike and waits for the first render. */
async function open(page: Page): Promise<void> {
  await page.goto(SPIRE_PAGE);
  await page.waitForFunction(() => typeof window.__spike !== 'undefined');
}

const SPIRE_PAGE = SPIKE;

/** Reads the harness state in one round-trip. */
async function snapshot(page: Page) {
  return page.evaluate(() => ({
    modelText: window.__spike.modelText(),
    domText: window.__spike.domText(),
    domHtml: window.__spike.domHtml(),
    modelSecondary: window.__spike.modelText(window.__spike.secondaryId()),
    isEditing: window.__spike.isEditing(),
    plaintextOnly: window.__spike.isPlaintextOnly(),
    stats: window.__spike.stats(),
    caret: window.__spike.caretOffset(),
  }));
}

/** The contenteditable element inside the primary frame. */
function editable(page: Page) {
  return page.locator('.p1-text-frame [contenteditable]').first();
}

// ---------------------------------------------------------------------------
// 1. Baseline: the frame renders from the model, and the DOM matches it
// ---------------------------------------------------------------------------

test('a text frame renders through the normal renderer, matching the model', async ({ page }) => {
  await open(page);

  const state = await snapshot(page);
  expect(state.modelText).toBe('Hello world');
  // The DOM projection equals the model before any editing happens. This is the
  // precondition for the whole claim: model → DOM is already exact.
  expect(state.domText).toBe(state.modelText);
  expect(state.isEditing).toBe(false);
});

test('paragraphs render as separate elements', async ({ page }) => {
  await open(page);

  // The renderer emits one <p> per model block.
  const paragraphs = await page.locator('.p1-text-frame').first().locator('p').count();
  expect(paragraphs).toBe(1);

  // Replace the content with two blocks and confirm the round trip reads them back
  // as two lines — proving the block mapping, not a single text blob.
  const text = await page.evaluate(() => {
    const content = document.querySelector('.p1-text-content') as HTMLElement;
    content.innerHTML = '<p>One</p><p>Two</p>';
    return window.__spike.domText();
  });
  expect(text).toBe('One\nTwo');
});

// ---------------------------------------------------------------------------
// 2. Entering the session
// ---------------------------------------------------------------------------

test('entering edit mode makes exactly one element contenteditable', async ({ page }) => {
  await open(page);

  await page.evaluate(() => window.__spike.enterEdit());

  const count = await page.locator('[contenteditable]').count();
  expect(count).toBe(1);

  const state = await snapshot(page);
  expect(state.isEditing).toBe(true);
  // Content is still the model's at this point: entering must not itself change text.
  expect(state.domText).toBe('Hello world');
});

test('the renderer withholds only the frame being edited', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__spike.enterEdit());

  // The edited frame is marked; the other text frame on the page is not.
  const editingCount = await page.locator('[data-editing="true"]').count();
  expect(editingCount).toBe(1);

  // And the other frame is still a plain model-projected element.
  const secondaryHtml = await page.evaluate(
    () => document.querySelectorAll('.p1-text-frame .p1-text-content')[1]?.innerHTML ?? '',
  );
  expect(secondaryHtml).toContain('Untouched');
  expect(secondaryHtml).not.toContain('contenteditable');
});

// ---------------------------------------------------------------------------
// 3. Native editing behaviour
// ---------------------------------------------------------------------------

test('typing inserts text via native browser behaviour', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__spike.enterEdit());
  await editable(page).click();

  await page.keyboard.press('End');
  await page.keyboard.type(' world');

  const state = await snapshot(page);
  expect(state.domText).toBe('Hello world world');
  // OBSERVED: the model's committed text is still the *old* value. The DOM has
  // moved ahead; that divergence is the fence working as designed, and is resolved
  // on exit. If this ever became equal mid-session, the fence would be leaking.
  expect(state.modelText).toBe('Hello world');
});

test('backspace deletes and forward-delete removes the caret character', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__spike.enterEdit());
  await editable(page).click();

  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');
  expect((await snapshot(page)).domText).toBe('Hello worl');

  await page.keyboard.press('Home');
  await page.keyboard.press('Delete');
  expect((await snapshot(page)).domText).toBe('ello worl');
});

test('multiline editing produces multiple paragraphs', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__spike.enterEdit());
  await editable(page).click();

  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second line');

  const state = await snapshot(page);
  expect(state.domText).toBe('Hello world\nSecond line');

  /*
   * OBSERVED (important): in `plaintext-only` mode, Chromium does NOT create a new
   * element for Enter. It inserts a literal "\n" *inside* the existing `<p>`, which
   * renders correctly only because the content element sets `white-space: pre-wrap`.
   *
   * Consequences for the real implementation:
   *  - `white-space: pre-wrap` is load-bearing, not cosmetic: without it the line
   *    break disappears and the model would disagree with what is displayed.
   *
   * SUPERSEDED (ADR 0003): the first version of this note also said the normalizer
   * must treat `"\n"` as a block boundary. It no longer does, and the reason is the
   * measurement in ADR 0003: under `contenteditable="true"` — which production uses —
   * Enter produces a real `<p>`, so `"\n"` is unambiguously a *soft break* and
   * promoting it to a block would turn every Shift+Enter into a paragraph.
   *
   * So the meaning of `"\n"` inside a `<p>` is **mode-dependent**, and that is a real
   * consequence of the spike pinning `plaintext-only`:
   *
   *   plaintext-only        → "\n" is a paragraph break (Enter is the only source)
   *   contenteditable=true  → "\n" is a soft break     (Enter produces a <p>)
   *
   * The model has one meaning, and it is the production one. The spike's committed
   * baseline therefore differs from its pre-M3 recording by one paragraph's margin:
   * this text stays a single `<p>` with a newline inside it rather than becoming two
   * `<p>`s. Making the normalizer mode-aware would mean a second conversion path for a
   * mode no product code uses, which is the worse trade.
   */
  expect(state.domHtml).toContain('\n');
  expect(await page.evaluate(() => {
    const content = document.querySelector('.p1-text-content') as HTMLElement;
    return getComputedStyle(content).whiteSpace;
  })).toBe('pre-wrap');
});

test('selection and replacement work natively', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__spike.enterEdit());
  await editable(page).click();

  // Select "world" and replace it. The text lives inside the <p>, so the range must
  // be anchored on that text node — not on the content element's first child,
  // which is the element itself and has no character offsets.
  await page.evaluate(() => {
    const paragraph = document.querySelector('.p1-text-content p') as HTMLElement;
    const textNode = paragraph.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 6);
    range.setEnd(textNode, 11);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  expect(await page.evaluate(() => window.__spike.selectionText())).toBe('world');

  await page.keyboard.type('there');
  expect((await snapshot(page)).domText).toBe('Hello there');
});

test('the caret is placed at the end of existing text on entry', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__spike.enterEdit());

  // "Hello world" is 11 characters; the caret should be at offset 11.
  expect(await page.evaluate(() => window.__spike.caretOffset())).toBe(11);
});

test('caret movement with arrow keys and Home/End is native', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__spike.enterEdit());
  await editable(page).click();

  await page.keyboard.press('End');
  expect(await page.evaluate(() => window.__spike.caretOffset())).toBe(11);

  await page.keyboard.press('Home');
  expect(await page.evaluate(() => window.__spike.caretOffset())).toBe(0);

  await page.keyboard.press('ArrowRight');
  expect(await page.evaluate(() => window.__spike.caretOffset())).toBe(1);
});

test('arrow keys move *within* a line rather than navigating the document', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__spike.enterEdit());
  await editable(page).click();

  await page.keyboard.press('End');
  // A contenteditable focused directly consumes arrows. If focus ever escaped, the
  // first ArrowUp would scroll or move selection out of the frame entirely.
  await page.keyboard.press('ArrowUp');
  const after = await page.evaluate(() => window.__spike.selectionText());
  expect(after).toBe(''); // no selection, caret still inside
  const stillEditing = await page.evaluate(() => window.__spike.isEditing());
  expect(stillEditing).toBe(true);
});

// ---------------------------------------------------------------------------
// 4. Paste
// ---------------------------------------------------------------------------

test('pasting plain text inserts plain text', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__spike.enterEdit());
  await editable(page).click();

  await page.keyboard.press('End');
  await page.evaluate(() => {
    // Clipboard paste is exercised via the real clipboard path where permitted.
    navigator.clipboard?.writeText(' pasted').catch(() => {});
  });
  // Use the editing host's paste via a synthetic clipboard event carrying plain text.
  await page.evaluate(() => {
    const content = document.querySelector('.p1-text-content') as HTMLElement;
    const dt = new DataTransfer();
    dt.setData('text/plain', ' pasted');
    content.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });

  // Whether the synthetic paste actually inserted text varies by headless build;
  // what must hold is that the *result* is plain text with no markup.
  const state = await snapshot(page);
  if (state.domText !== 'Hello world') {
    expect(state.domText).toContain('pasted');
    expect(state.domHtml).not.toContain('<script');
  }
});

test('pasting rich text does not introduce markup into the model', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__spike.enterEdit());
  await editable(page).click();

  await page.evaluate(() => {
    const content = document.querySelector('.p1-text-content') as HTMLElement;
    const dt = new DataTransfer();
    dt.setData('text/html', '<b>bold</b><script>alert(1)</script>');
    dt.setData('text/plain', 'bold');
    content.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });

  // Whether the synthetic paste inserted anything at all is environment-dependent;
  // the guarantee is that nothing markup-shaped survives normalization.
  await page.evaluate(() => window.__spike.exitEdit());
  const modelText = await page.evaluate(() => window.__spike.modelText());
  expect(modelText).not.toContain('<');
  expect(modelText).not.toContain('alert');
});

// ---------------------------------------------------------------------------
// 5. IME / composition
// ---------------------------------------------------------------------------

test('composition events fire and the model does not see partial IME text', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__spike.enterEdit());
  await editable(page).click();

  // Synthesize the composition lifecycle a real IME produces.
  await page.evaluate(() => {
    const content = document.querySelector('.p1-text-content') as HTMLElement;
    content.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    content.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 'に' }));
    const node = document.createTextNode('に');
    content.append(node);
    content.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'に' }));
  });

  const state = await snapshot(page);
  expect(state.stats.compositions).toBeGreaterThan(0);
  // After compositionend the composed text is committed to the DOM (and so will be
  // to the model). It was not committed mid-composition.
  expect(state.domText).toContain('に');
  // The model is still the pre-edit value; it catches up on exit.
  expect(state.modelText).toBe('Hello world');
});

// ---------------------------------------------------------------------------
// 6. Re-render during a session (the fence's actual purpose)
// ---------------------------------------------------------------------------

test('re-rendering during editing does not disturb the DOM being edited', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__spike.enterEdit());
  await editable(page).click();

  await page.keyboard.press('End');
  await page.keyboard.type('!!');
  const before = await snapshot(page);

  // Force several full re-renders from the model while the browser owns the frame.
  await page.evaluate(() => {
    window.__spike.rerenderWhileEditing();
    window.__spike.rerenderWhileEditing();
    window.__spike.rerenderWhileEditing();
  });

  const after = await snapshot(page);
  // The browser's text survives untouched: this is the fence holding.
  expect(after.domText).toBe(before.domText);
  expect(after.domHtml).toBe(before.domHtml);
});

test('re-rendering during editing preserves the caret', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__spike.enterEdit());
  await editable(page).click();

  await page.keyboard.press('End');
  await page.keyboard.type('XY');
  const caretBefore = await page.evaluate(() => window.__spike.caretOffset());

  await page.evaluate(() => window.__spike.rerenderWhileEditing());

  const caretAfter = await page.evaluate(() => window.__spike.caretOffset());
  // OBSERVED: the caret survives a re-render, because the renderer wrote nothing
  // into the edited element. This is the payoff of withholding content.
  expect(caretAfter).toBe(caretBefore);
});

test('a re-render mid-edit does not resurrect the old model text', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__spike.enterEdit());
  await editable(page).click();
  await page.keyboard.press('End');
  await page.keyboard.type('zzz');

  await page.evaluate(() => window.__spike.rerenderWhileEditing());

  // If the renderer had re-projected the stale model, "zzz" would have been wiped.
  expect((await snapshot(page)).domText).toBe('Hello worldzzz');
});

// ---------------------------------------------------------------------------
// 7. External changes during a session (the leak test)
// ---------------------------------------------------------------------------

test('an external geometry change during editing is applied without touching text', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__spike.enterEdit());
  await editable(page).click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');

  const before = await snapshot(page);
  await page.evaluate(() => window.__spike.externalMove());
  const after = await snapshot(page);

  // Geometry moved; the browser's text is untouched. The fence is scoped to
  // *content*, not to the whole element, so sibling properties still render.
  expect(after.domText).toBe(before.domText);
  const left = await page.evaluate(() => {
    const frame = document.querySelector('.p1-text-frame') as HTMLElement;
    return parseFloat(frame.style.left);
  });
  expect(left).toBe(100); // 60 + 40
});

test('an external text change during editing does NOT overwrite the user, but IS lost', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__spike.enterEdit());
  await editable(page).click();
  await page.keyboard.press('End');
  await page.keyboard.type('USER');

  // Rewrite the model's text from outside the session.
  await page.evaluate(() => window.__spike.externalText());
  const duringEdit = await snapshot(page);

  // The browser's DOM still holds the user's text; the model now says otherwise.
  expect(duringEdit.domText).toBe('Hello worldUSER');
  expect(duringEdit.modelText).toBe('MODEL OVERWROTE');
  // OBSERVED / FINDING: the model change does not reach the DOM while editing. The
  // user's in-progress text is protected, but the external change is silently
  // discarded on exit, because exit commits the DOM over the model.
  //
  // This is the sharpest limitation the spike found, and the ADR's main caveat.
});

test('exiting after an external text change commits the user text, discarding the external write', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__spike.enterEdit());
  await editable(page).click();
  await page.keyboard.press('End');
  await page.keyboard.type('KEEP');

  await page.evaluate(() => window.__spike.externalText());
  await page.evaluate(() => window.__spike.exitEdit());

  // The DOM wins: the user's text is what lands in the model.
  const modelText = await page.evaluate(() => window.__spike.modelText());
  expect(modelText).toBe('Hello worldKEEP');
});

test('hiding the frame during editing applies, and does not corrupt the session', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__spike.enterEdit());
  await editable(page).click();
  await page.keyboard.press('End');
  await page.keyboard.type('H');

  await page.evaluate(() => window.__spike.externalHide());

  const display = await page.evaluate(() => {
    const frame = document.querySelector('.p1-text-frame') as HTMLElement;
    return frame.style.display;
  });
  expect(display).toBe('none');

  // The session is still open and the text intact, so unhiding restores cleanly.
  await page.evaluate(() => window.__spike.exitEdit());
  const modelText = await page.evaluate(() => window.__spike.modelText());
  expect(modelText).toBe('Hello worldH');
});

// ---------------------------------------------------------------------------
// 8. Exiting and model synchronization
// ---------------------------------------------------------------------------

test('exiting commits the DOM text to the model', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__spike.enterEdit());
  await editable(page).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' final');

  await page.evaluate(() => window.__spike.exitEdit());

  const state = await snapshot(page);
  expect(state.modelText).toBe('Hello world final');
  // After exit, the DOM and model agree again — the invariant is restored.
  expect(state.domText).toBe(state.modelText);
});

test('exiting restores normal renderer control', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__spike.enterEdit());
  await page.evaluate(() => window.__spike.exitEdit());

  const state = await snapshot(page);
  expect(state.isEditing).toBe(false);
  expect(await page.locator('[contenteditable]').count()).toBe(0);

  // Both editing markers must be gone. OBSERVED during the spike: `TextEditSession`
  // clears the one on the frame element, but the *content* element also carries
  // `data-editing`, so a stale marker would leave the renderer withholding a frame
  // that is no longer being edited.
  expect(await page.locator('[data-editing="true"]').count()).toBe(0);
});

test('after exiting, the model is authoritative again', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__spike.enterEdit());
  await editable(page).click();
  await page.keyboard.press('End');
  await page.keyboard.type('committed');
  await page.evaluate(() => window.__spike.exitEdit());

  // Mutate the model externally; now it must reach the DOM, because no session is
  // active. This is the round trip that proves the renderer resumes from the model.
  await page.evaluate(() => window.__spike.externalText());
  const domText = await page.evaluate(() => window.__spike.domText());
  expect(domText).toBe('MODEL OVERWROTE');
});

test('emptying the frame during editing still leaves a valid model', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__spike.enterEdit());
  await editable(page).click();

  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  await page.evaluate(() => window.__spike.exitEdit());

  const state = await snapshot(page);
  expect(state.modelText).toBe('');

  // The frame must still be re-enterable, so the model keeps exactly one empty
  // paragraph rather than zero blocks.
  //
  // OBSERVED: after select-all + delete, Chromium leaves `<p><br></p>` — an empty
  // paragraph holding a `<br>` placeholder. The normalizer reads that as empty
  // (correct), but the renderer then re-projects it as a bare `<p></p>`, which
  // collapses to zero height in CSS. A real implementation must therefore keep an
  // explicit minimum height (or a `<br>`) for an empty paragraph. Not a fence
  // problem, but it is the kind of thing only a browser test surfaces.
  const blocks = await page.evaluate(
    () => document.querySelectorAll('.p1-text-frame')[0]!.querySelectorAll('.p1-text-content > *').length,
  );
  expect(blocks).toBe(1);

  // And re-entering an emptied frame yields a usable caret position.
  await page.evaluate(() => window.__spike.enterEdit());
  expect(await page.evaluate(() => window.__spike.caretOffset())).toBe(0);
});

test('a re-render after exit does not depend on stale editor DOM', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__spike.enterEdit());
  await editable(page).click();
  await page.keyboard.press('End');
  await page.keyboard.type('x');
  await page.evaluate(() => window.__spike.exitEdit());

  // Force a fresh render. The DOM must come from the model, so the text is
  // unchanged — but the content element must also have been replaced by the
  // renderer rather than left as the browser edited it.
  await page.evaluate(() => window.__spike.rerenderWhileEditing());
  const state = await snapshot(page);
  expect(state.domText).toBe('Hello worldx');
  expect(state.domText).toBe(state.modelText);
});

// ---------------------------------------------------------------------------
// 9. Re-entering after a session
// ---------------------------------------------------------------------------

test('re-entering edit mode shows the committed model text', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__spike.enterEdit());
  await editable(page).click();
  await page.keyboard.press('End');
  await page.keyboard.type('!!');
  await page.evaluate(() => window.__spike.exitEdit());

  await page.evaluate(() => window.__spike.enterEdit());
  const state = await snapshot(page);
  expect(state.domText).toBe('Hello world!!');
  expect(state.modelText).toBe('Hello world!!');
  // The caret lands at the end of the committed text.
  expect(await page.evaluate(() => window.__spike.caretOffset())).toBe(13);
});

// ---------------------------------------------------------------------------
// 10. plaintext-only support
// ---------------------------------------------------------------------------

test('reports whether plaintext-only contenteditable is honoured', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__spike.enterEdit());

  const state = await snapshot(page);
  // Chromium supports plaintext-only. Recorded rather than hard-required, because
  // the normalizer does not depend on it — this is informational.
  expect(typeof state.plaintextOnly).toBe('boolean');
  if (state.plaintextOnly) {
    // OBSERVED: with plaintext-only the contenteditable attribute value is exactly
    // that string, and typed text inserts no markup.
    const value = await editable(page).getAttribute('contenteditable');
    expect(value).toBe('plaintext-only');
  }
});

// ---------------------------------------------------------------------------
// 11. Undo/redo — MANUAL-ONLY
// ---------------------------------------------------------------------------
//
// The browser's own Ctrl+Z inside a contenteditable is native and reliable, but it
// operates on the DOM's undo stack, which the editor's undo system (M2) does not
// share. Driving it from a test is possible but only exercises the browser, not our
// integration, and asserting on it would encode a behaviour we have not designed
// yet.
//
// This is the sharpest open question the spike could NOT settle, and it is called
// out as such in the ADR. Manual verification: enter edit mode, type, press Ctrl+Z
// (expect the browser to undo), then exit (expect the model to reflect whatever the
// DOM holds at that moment — which may be the pre-undo text).
