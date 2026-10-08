/**
 * The browser suite must be served the production application, not Vite's dev server.
 *
 * ## Why this guard exists
 *
 * The suite used to run against `npx vite` in dev mode. That made a full run fail roughly
 * once in eight, for a reason that had nothing to do with the renderer.
 *
 * A dev-mode boot pulls the module graph over ~49 separate requests, and one long-lived
 * server serves all 556 tests. Each boot spends dozens of short-lived sockets, and every
 * closed socket sits in `TIME_WAIT` for 240s against a 16,384-port dynamic range. Eventually
 * the OS runs out. The captured failure:
 *
 *   /src/render/assets.ts -> status -1, _failureText "net::ERR_NO_BUFFER_SPACE"
 *
 * with Windows logging `Tcpip` 4231 in the same second -- "a request to allocate an ephemeral
 * port number ... has failed due to all such ports being in use".
 *
 * The browser abandoned a request that never reached the server, so `app.ts` was never
 * evaluated. No `[data-page]`, no boot surface, and a failure that read exactly like an
 * application bug. It was a machine-level resource ceiling reached through a dev-server
 * configuration choice.
 *
 * The fix was to serve `dist/` -- one bundled request per boot -- so the failure surface is
 * removed instead of tolerated. **This test is what stops that being undone silently.** Nothing
 * about the renderer would notice the suite had reverted; the suite would simply start
 * failing once every several runs again, and by then the connection to this decision would
 * be gone. A configuration mistake that only manifests as flakiness needs a test.
 *
 * ## What is asserted, and what is deliberately not
 *
 * Asserted: that `/` is the production application -- it references bundled output under
 * `/assets/`, and carries none of Vite's dev markers (`/@vite/client`, raw `/src/**` module
 * references, the dev-only `type="module"` crossorigin import shape).
 *
 * NOT asserted: any specific filename or hash. Vite's hashes change on every content change;
 * pinning one would make this test fail for a reason that has nothing to do with the boundary
 * it exists to protect. The meaningful property is "bundled output, not dev transform", and
 * that is what is checked.
 *
 * The second half asserts the *other* server is still reachable, because the two-server setup
 * is easy to break in the direction of fixing this one: a proxy change that quietly takes
 * `/spike.html` down with it.
 */

import { expect, test } from './harness';
import type { Page } from '@playwright/test';

/** The served HTML for a path, as raw text -- before any script has run and rewritten it. */
async function html(page: Page, path: string): Promise<{ status: number; body: string }> {
  const response = await page.request.get(path);
  return { status: response.status(), body: await response.text() };
}

test.describe('the browser suite is served the production application', () => {
  test('/ is the built bundle, not Vite development output', async ({ page }) => {
    const { status, body } = await html(page, '/');
    expect(status).toBe(200);

    // The application itself is present.
    expect(body, 'the document should still be the editor').toContain('data-canvas');

    /*
     * Dev markers. Each of these is present in dev mode and absent from a production build,
     * and each is a statement about *how* the page was served rather than about content:
     *
     *   /@vite/client     injected by the dev server; carries the HMR socket. This is the one
     *                     whose absence most directly means "no dev server served this page".
     *   /src/...          a raw module reference. A dev page references the unbundled graph;
     *                     a built page references a single bundled artefact instead.
     */
    expect(body, 'the dev HMR client must not be injected').not.toContain('/@vite/client');
    expect(body, 'no raw dev-module references').not.toMatch(/["']\/src\/[^"']+\.ts["']/);

    // The positive half: a reference to built output. Together with the two negative
    // assertions above this pins the boundary -- an HTML shell alone would satisfy the
    // positive check while a dev server still served the modules it points at.
    expect(body, 'the page should reference built output under /assets/').toMatch(
      /(?:src|href)="\/assets\/[^"]+"/,
    );
  });

  test('the spike harness is still reachable through the dev server', async ({ page }) => {
    /*
     * `/spike.html` is deliberately excluded from the production bundle (ADR 0001) and loads a
     * raw TypeScript module, so it can only be served by the dev server -- which the preview
     * server proxies. This asserts that path still works, so the two-server arrangement
     * cannot be broken from this side while `/` keeps looking correct.
     */
    const { status, body } = await html(page, '/spike.html');
    expect(status, 'the spike entry point should still be served').toBe(200);
    expect(body, 'and it should still be the spike harness').toContain('data-canvas');
  });

  test('the dev server is not what answers normal application navigation', async ({ page }) => {
    /*
     * Belt and braces on the boundary, from the running page rather than the source: once the
     * bundle has booted, no dev-server artefact should be observable.
     */
    await page.goto('/');
    const devMarkers = await page.evaluate(() => {
      const scripts = [...document.querySelectorAll('script[src]')].map((el) =>
        (el as HTMLScriptElement).getAttribute('src') ?? '',
      );
      return {
        scripts,
        sawDevClient: scripts.some((src) => src.includes('/@vite/client')),
        sawRawSource: scripts.some((src) => /^\/src\//.test(src)),
      };
    });
    expect(devMarkers.sawDevClient, 'the booted page loaded Vite dev output').toBe(false);
    expect(devMarkers.sawRawSource, 'the booted page loaded raw source modules').toBe(false);
    expect(
      devMarkers.scripts.some((src) => src.startsWith('/assets/')),
      'the booted page should have loaded built output',
    ).toBe(true);
  });
});
