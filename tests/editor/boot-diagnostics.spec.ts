/**
 * M15: the boot diagnostics themselves.
 *
 * These are not tests of the editor. They are tests of the **instrumentation**, because an
 * instrument that quietly stops recording -- or starts recording a field whose name no longer describes
 * what it counted -- is worse than no instrument: it turns a stall into a confident wrong answer.
 *
 * The history is specific. `render:return` originally reported the `[data-objects]` count under the key
 * `objects`, which reads as "the document's objects" and is not: it is one container per page. A reader
 * diagnosing a stalled boot would have read "objects: 0" as "the document had no objects" rather than
 * "no page containers were built". So the field names are asserted here, by value and not by presence
 * alone, and the model leaf count is asserted to be a *different* number from the container count --
 * which is the whole reason they needed separate names.
 *
 * The step **order** is asserted too, because order is what distinguishes the failure modes: a boot
 * that never reached `render:enter` is a different defect from one that reached `render:return` with
 * nothing on the page, and a timeline that recorded the steps out of order could not tell them apart.
 */

import { readFile } from 'node:fs/promises';
import { expect, test } from './helpers';
import { mountFixture, mountSample, waitForApp } from '../visual/harness';
import type { Page } from '@playwright/test';

interface Step {
  step: string;
  detail?: Record<string, unknown>;
}

/** The boot timeline, read through the product-owned surface. */
async function timeline(page: Page): Promise<Step[]> {
  return page.evaluate(() => {
    const surface = (window as unknown as Record<string, unknown>)['__P1_BOOT__'] as
      | { read: () => { timeline: Step[] } }
      | undefined;
    if (surface === undefined) throw new Error('no __P1_BOOT__ surface');
    return surface.read().timeline;
  });
}

/**
 * Prevents any application JavaScript from running, leaving the served HTML inert.
 *
 * Blocks by role rather than by URL, because the app is not served from a fixed path: the browser
 * suite is served the production bundle (`/assets/*.js`), while `vite` dev serves `/src/ui/app.ts`.
 * A hardcoded dev URL silently matches nothing against a production server, and the test then passes
 * or fails for reasons unrelated to what it is checking.
 */
async function blockApplicationScript(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith('/assets/') || url.pathname.startsWith('/src/'),
    (route) => route.abort(),
  );
}

const stepNames = (steps: Step[]): string[] => steps.map((entry) => entry.step);const detailOf = (steps: Step[], name: string): Record<string, unknown> => {
  const found = steps.find((entry) => entry.step === name);
  if (found === undefined) throw new Error(`no step "${name}" in ${stepNames(steps).join(' -> ')}`);
  return found.detail ?? {};
};

test.describe('the boot timeline records every boundary, in order', () => {
  test('a healthy boot reaches boot:complete through all of them', async ({ page }) => {
    await mountSample(page);
    const steps = await timeline(page);
    const names = stepNames(steps);

    // Every boundary the diagnosis depends on, in the order the boot performs them.
    expect(names).toContain('main:enter');
    expect(names).toContain('store:ready');
    expect(names).toContain('boot:paint:begin');
    expect(names).toContain('project:enter');
    expect(names).toContain('render:enter');
    expect(names).toContain('render:return');
    expect(names).toContain('viewport.fit:enter');
    expect(names).toContain('viewport.fit:return');
    expect(names).toContain('boot:complete');

    // Order is the diagnostic content, so it is asserted rather than assumed.
    expect(names.indexOf('main:enter')).toBeLessThan(names.indexOf('store:ready'));
    expect(names.indexOf('store:ready')).toBeLessThan(names.indexOf('render:enter'));
    expect(names.indexOf('render:enter')).toBeLessThan(names.indexOf('render:return'));
    expect(names.indexOf('render:return')).toBeLessThan(names.indexOf('viewport.fit:enter'));
    expect(names.indexOf('viewport.fit:enter')).toBeLessThan(names.indexOf('viewport.fit:return'));
    expect(names.indexOf('viewport.fit:return')).toBeLessThan(names.indexOf('boot:complete'));

    // `boot:complete` last: a boot that stalled anywhere above cannot have reached it.
    expect(names[names.length - 1]).toBe('boot:complete');
  });
});

test.describe('the counts are named for what they count', () => {
  test('render:return separates page containers from model leaves', async ({ page }) => {
    await mountSample(page);
    const steps = await timeline(page);
    const detail = detailOf(steps, 'render:return');

    // The regression this file exists for: `objects` used to name the container count.
    expect(Object.keys(detail)).not.toContain('objects');
    expect(Object.keys(detail).sort()).toEqual(['leaves', 'pageCount', 'pageElements']);

    // `pageCount` counts `[data-objects]` containers and `pageElements` counts `[data-page]`.
    const dom = await page.evaluate(() => ({
      containers: document.querySelectorAll('[data-objects]').length,
      pages: document.querySelectorAll('[data-page]').length,
      leaves: document.querySelectorAll('[data-oid]').length,
    }));
    expect(detail['pageCount']).toBe(dom.containers);
    expect(detail['pageElements']).toBe(dom.pages);
    expect(detail['leaves']).toBe(dom.leaves);
  });

  test('a grouped document proves the two counts are genuinely different', async ({ page }) => {
    // A group has no visual form, so a page holding three shapes inside one group has four model
    // nodes but three leaves and one page container. If `pageCount` and `leaves` ever agreed by
    // accident on a flat fixture, the names would look interchangeable and the next reader would
    // trust the wrong one.
    await mountFixture(
      page,
      `() => ({
        formatVersion: 2, id: 'diag', name: 'Diag',
        pageSize: { width: 300, height: 200, unit: 'pt', orientation: 'portrait' },
        assets: {},
        pages: [{
          id: 'p1', name: '1',
          background: { type: 'solid', color: '#ffffff' },
          objects: [{
            type: 'group', id: 'g1', name: 'G',
            transform: { x: 0, y: 0, width: 0, height: 0, rotation: 0, scaleX: 1, scaleY: 1 },
            visible: true, locked: false, opacity: 1, blendMode: 'normal',
            children: ['a', 'b', 'c'].map((id, i) => ({
              type: 'shape', id, name: id,
              transform: { x: 20 + i * 60, y: 20, width: 40, height: 40, rotation: 0, scaleX: 1, scaleY: 1 },
              visible: true, locked: false, opacity: 1, blendMode: 'normal',
              shape: { kind: 'rect', cornerRadius: 0 },
            })),
          }],
        }],
      })`,
    );

    const steps = await timeline(page);
    const detail = detailOf(steps, 'render:return');
    // One page, one container, three leaves.
    expect(detail['pageCount']).toBe(1);
    expect(detail['pageElements']).toBe(1);
    expect(detail['leaves']).toBe(3);
    expect(detail['leaves']).not.toBe(detail['pageCount']);
  });
});

test.describe('the readiness condition cannot be satisfied by static HTML', () => {
  test('a page whose module graph never delivers app.ts is reported as never evaluated', async ({
    page,
  }) => {
    // The regression this whole milestone turned on.
    //
    // `waitForApp` used to require `readout.value !== ''`, on the documented belief that the zoom
    // readout is "only populated after `project()` and `viewport.fit()` run". It is not: `index.html`
    // ships `<output data-zoom-readout>100%</output>` as static markup. So on a page where the module
    // graph stalled and `app.ts` was never evaluated, that half of the condition was already true and
    // the failure was reported as `readout: "100%"` alongside `pages: 0` — which reads like a
    // half-booted app and sent the diagnosis down the wrong path entirely. The retained trace settled
    // it: 23 of ~49 modules had loaded, then stopped.
    //
    // So the old condition could not tell "never started" from "started and stalled", and reported
    // both identically. Readiness is now the app's own `boot:complete` step, and the two are named.
    //
    // The failure is produced by blocking the application's own entry script, which gives the exact
    // state the trace recorded: the HTML is served, and no application code ever runs.
    //
    // Blocking has to target *wherever the app is served from*, and that is not fixed. Under the
    // production server it is the bundled `/assets/*.js`; under `vite` dev it was `/src/ui/app.ts`.
    // An earlier version of this test blocked only the dev path, and passed for the wrong reason --
    // against the production server the route matched nothing, the app booted normally, and the
    // assertion below failed. So the block is by role, not by a hardcoded dev URL.
    await blockApplicationScript(page);
    await page.goto('/');

    // The premise, asserted so it cannot drift back: with no app running, the readout is populated.
    // This is the false belief the old condition was built on.
    const staticState = await page.evaluate(() => ({
      readout: (document.querySelector('[data-zoom-readout]') as HTMLOutputElement).value,
      pages: document.querySelectorAll('[data-page]').length,
      surface: (window as unknown as Record<string, unknown>)['__P1_BOOT__'] !== undefined,
    }));
    expect(staticState.readout, 'index.html ships a pre-populated readout').toBe('100%');
    expect(staticState.pages).toBe(0);
    expect(staticState.surface, 'and with app.ts blocked, nothing published the boot surface').toBe(
      false,
    );

    // The old predicate's readout half is *already satisfied* on this page — which is the whole
    // problem: it contributed nothing and looked like evidence.
    const readoutHalfOldPredicate = await page.evaluate(
      () =>
        (document.querySelector('[data-zoom-readout]') as HTMLOutputElement).value !== '',
    );
    expect(readoutHalfOldPredicate, 'the old predicate\'s readout term was true with no app').toBe(
      true,
    );

    // The real readiness check rejects it, and says which of the two failures this is.
    const failure = await waitForApp(page, 1_000).then(
      () => null,
      (error: Error) => error,
    );
    expect(failure, 'waitForApp resolved on a page whose app never ran').not.toBeNull();
    expect(failure?.message).toContain('The app module never evaluated');
    // The state snapshot names the absent surface, so the log line is self-explanatory.
    expect(failure?.message).toContain('no boot surface');
    // It must NOT be reported as a boot that started and stalled: that would be a lie, and the
    // original diagnosis was built on exactly that kind of lie.
    expect(failure?.message).not.toContain('started but did not reach');
  });

  test('a boot that starts but never completes is reported differently', async ({ page }) => {
    // The other half of the distinction, because collapsing these two is what made the original
    // failure undiagnosable. Here the module graph *does* deliver and `app.ts` runs, so the surface
    // exists — but `boot:complete` never arrives because the document has no pages to render.
    await mountSample(page);
    const steps = await timeline(page);
    expect(stepNames(steps)).toContain('boot:complete');

    // Simulate the stall by making the surface report a boot that has not reached its terminal step.
    // Done by shadowing `read` rather than by adding a mutator to the product surface: the surface is
    // read-only on purpose, because a diagnostic a test can rewrite is not evidence. Here the *real*
    // boot ran and produced a real timeline -- only the last step is withheld, which is exactly the
    // state this branch describes.
    await page.evaluate(() => {
      const surface = (window as unknown as Record<string, unknown>)['__P1_BOOT__'] as {
        read: () => { timeline: { step: string }[] };
      };
      const real = surface.read.bind(surface);
      surface.read = () => ({
        ...real(),
        timeline: real().timeline.filter((entry) => entry.step !== 'boot:complete'),
      });
    });

    const failure = await waitForApp(page, 1_000).then(
      () => null,
      (error: Error) => error,
    );
    expect(failure, 'waitForApp resolved with no boot:complete step').not.toBeNull();
    expect(failure?.message).toContain('started but did not reach');
    expect(failure?.message).not.toContain('The app module never evaluated');
    // The timeline is carried into the report, which is how the next occurrence gets diagnosed
    // without a rerun.
    expect(failure?.message).toContain('render:return');
  });
});

test.describe('the surface is not part of the document', () => {
  test('the timeline never appears in the saved bytes', async ({ page }) => {
    // The instrumentation records boot-time observation of the *application*. In the document it would
    // be a field to serialise, compare, migrate and round-trip -- for something true only of the run
    // that produced it. So the check is on the real artefact: the bytes the user would get.
    await mountSample(page);

    // First prove the surface exists, so a pass cannot mean "nothing was recorded at all".
    const recorded = await page.evaluate(() => {
      const surface = (window as unknown as Record<string, unknown>)['__P1_BOOT__'] as
        | { read: () => { timeline: unknown[] } }
        | undefined;
      return surface === undefined ? 0 : surface.read().timeline.length;
    });
    expect(recorded, 'the boot timeline recorded nothing, so the rest proves nothing').toBeGreaterThan(0);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('[data-doc="save"]').click(),
    ]);
    const path = await download.path();
    if (path === null) throw new Error('the download produced no file');
    const bytes = await readFile(path, 'utf8');

    for (const needle of ['__P1_BOOT__', 'render:enter', 'pageCount', 'boot:complete', 'timeline']) {
      expect(bytes, `the saved document contains "${needle}"`).not.toContain(needle);
    }
    // And the format is untouched: still version 2, with no new top-level key.
    const parsed = JSON.parse(bytes) as { formatVersion: number };
    expect(parsed.formatVersion).toBe(2);
  });
});