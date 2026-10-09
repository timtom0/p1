import { defineConfig, devices } from '@playwright/test';

/**
 * Visual verification for the document renderer (docs/ARCHITECTURE.md §8.2).
 *
 * This suite exists to check the things a DOM emulator cannot: real page
 * dimensions, real transform composition, real clipping, real paint order, and
 * real behaviour at several zoom levels.
 *
 * Determinism is the whole design. Every source of variance is pinned:
 *   - a fixed 1280×900 viewport
 *   - `deviceScaleFactor: 1`
 *   - animations and caret blinking disabled
 *   - the document is driven through `addInitScript`, not through UI clicking,
 *     so there is no gesture timing in the capture path
 *   - only `[data-page]` is screenshotted, so the browser chrome and the
 *     viewport's own zoom never enter the comparison
 */

/**
 * The ports this run's servers listen on.
 *
 * Overridable by environment variable so the mutation runner can give each of its parallel workers its
 * own pair — two `--strictPort` servers cannot share a port, and each worker builds and serves its own
 * bundle because a mutant is a file edit. Defaults are the values every ordinary caller uses, so `npm
 * run test:visual` is unaffected and cannot tell the difference. See `vite.config.ts` for the same pair
 * read from the same variables.
 */
const PORT = envPort('P1_PREVIEW_PORT', 5174);

/**
 * The dev server's port. Only `/spike.html` and the raw-TypeScript graph it
 * imports are served from here; see `vite.config.ts` for the proxy that makes
 * that reachable through `PORT`.
 */
const DEV_PORT = envPort('P1_DEV_PORT', 5175);

/**
 * A port number from the environment, validated here rather than trusted.
 *
 * A malformed value that silently became `NaN` would surface much later as an opaque connection
 * failure, from inside whichever worker happened to be running — so it is rejected at config load.
 */
function envPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be a port number between 1 and 65535, got "${raw}"`);
  }
  return value;
}

/**
 * Browser viewport for the visual suite.
 *
 * Sized so a whole A4 page (794×1123) fits at the *highest* zoom level under
 * test (195%, giving ≈1550×2190) with room to spare, and with the chrome
 * subtracted: the 300px dev panel takes width, and the toolbar plus rulers take
 * height.
 *
 * This lets every screenshot be a single clipped viewport capture, which is both
 * fast and complete — see `screenshotPage` in harness.ts for why the alternatives
 * (locator screenshots, `fullPage`) do not work, and why a page that does not fit
 * must fail loudly rather than capture the surrounding chrome.
 *
 * Note these dimensions are a test concern, not a product requirement: a real
 * user window is far smaller, and the code under test must not depend on them.
 */
const VIEWPORT = { width: 2400, height: 2600 };

export default defineConfig({
  // Only the visual + spike suites; unit tests are Vitest's job (`npm test`).
  testDir: './tests',
  /*
   * `tests/` holds two kinds of file, and the split is explicit because they
   * collided. A `*.test.ts` under `tests/` is a **Vitest** file (added to Vitest's
   * `include` so injected-fixture sources can be parse-checked without a browser), and
   * a `*.spec.ts` is a **Playwright** file.
   *
   * Without this, Playwright's default `testMatch` collected the Vitest guard and every
   * run failed with "Vitest failed to access its internal state" -- an error that
   * names neither the cause nor the file at fault.
   */
  testIgnore: '**/*.test.ts',
  // Baselines are pixel-exact within a tolerance; running files in parallel would
  // contend for the same dev server.
  //
  // Parallelism was **measured for the mutation runner and rejected**, rather than assumed either
  // way: on `tests/editor/layers.spec.ts` (39 tests, the suite one mutation run hits hardest) four
  // workers with `fullyParallel` gave 62.5s and 55.5s against 58.0s serial. The cost is per-test
  // browser setup, not scheduling, so workers contend for the same CPU and the same dev server and
  // hand back nothing. An earlier draft of this file carried a `P1_PARALLEL` env switch on the
  // strength of the assumption that it would help; the measurement said otherwise and the switch was
  // removed rather than left in as unused configuration. M13's notes record the numbers.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  reporter: [['list']],

  expect: {
    // `toMatchSnapshot` accepts only the diff controls; animation and caret
    // suppression are passed to `page.screenshot` in harness.ts instead.
    toMatchSnapshot: {
      // Antialiasing varies slightly across platforms and driver versions. This
      // threshold absorbs that without hiding a real layout change, which moves
      // whole regions by many pixels.
      maxDiffPixelRatio: 0.002,
      threshold: 0.2,
    },
  },

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // The spike harness needs a second entry point.
    deviceScaleFactor: 1,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    // `retain-on-failure` rather than `off` or `on-first-retry`.
    //
    // `off` was how this suite lost its evidence: the one full run that reproduced the boot failure
    // wrote an `error-context.md`, and three later clean runs overwrote it before anyone read it.
    // `on-first-retry` would not help either, because `retries` is 0 -- a retry never happens, so the
    // trace is never taken. `retain-on-failure` records a trace for every test and keeps only the ones
    // that fail, which is the behaviour this suite needs: expensive in the passing case, permanent in
    // the failing one.
    //
    // A trace is what answers "the DOM was correct but the harness looked at the wrong document" --
    // it holds every navigation, every request and every console message, so the state at the moment
    // of failure can be reconstructed rather than inferred.
    trace: 'retain-on-failure',
    video: 'off',
    // Off, and deliberately.
    //
    // `only-on-failure` still writes a PNG for **every** test into a staging directory and discards
    // the passing ones, which is 550 files a run. Measured: enabling it took the suite from 9-19 min
    // to 22-27 min -- a 2-3x slowdown for evidence a `retain-on-failure` trace already carries, since
    // the trace contains the page's snapshots and screencast frames. Adding it was my own change
    // during this milestone, and it would have made the suite slower and therefore *more* exposed to
    // the load-sensitive failure under investigation.
    screenshot: 'off',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // NOTE: `projects[].use` merges *after* the top-level `use`, so the
        // viewport has to be restated here or `devices['Desktop Chrome']` wins.
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
      },
    },
  ],

  webServer: [
    /*
     * The application is served to the browser suite as a **production build**.
     *
     * It used to be served by `npx vite` in dev mode, and that made the suite
     * depend on something the renderer has nothing to do with. A dev-mode boot
     * pulls the module graph over ~49 separate requests (measured), and the
     * suite holds one long-lived server across all 556 tests. Every boot spends
     * dozens of short-lived sockets, each of which lingers in `TIME_WAIT` for
     * 240s against a 16,384-port dynamic range. Over a full run the OS runs out:
     * the captured failure is
     *
     *   /src/render/assets.ts -> status -1, _failureText "net::ERR_NO_BUFFER_SPACE"
     *
     * logged by Windows as `Tcpip` event 4231 at the same second -- "a request to
     * allocate an ephemeral port number ... has failed due to all such ports being
     * in use". The browser gave up on a request that never reached the server, so
     * `app.ts` was never evaluated, no `[data-page]` existed, and the boot looked
     * like an application fault. It was never an application fault.
     *
     * Serving `dist/` makes each boot **one bundled request** instead of 49, so
     * the failure surface is removed rather than tolerated. The boot-failure
     * diagnostics from M15 stay exactly as they are: they are what made this
     * legible in the first place, and they are what names the next occurrence.
     *
     * This is an intentional test-infrastructure boundary. Browser coverage now
     * targets the **production bundle**, not Vite's development transform or
     * unbundled module graph. What the suite verifies is the renderer as it
     * ships. It no longer verifies that Vite's dev pipeline can serve it.
     *
     * The build runs in the same command, so the server cannot come up before its
     * output exists -- a preview server with a missing or stale `dist/` would
     * serve the wrong application rather than fail.
     */
    {
      command: `npm run build && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
      url: `http://127.0.0.1:${PORT}`,
      reuseExistingServer: !process.env['CI'],
      // Longer than a dev server needs, because this one has to finish a
      // production build first. Startup budget only -- no test timeout is touched.
      timeout: 180_000,
    },
    /*
     * The dev server, for the spike harness alone.
     *
     * `spike.html` is excluded from the production bundle on purpose (ADR 0001:
     * throwaway §10.3 research that must not become a second shipped entry point)
     * and it loads `/src/spike/text-spike.ts` as a raw module, which only the dev
     * transform can serve. `vite.config.ts` proxies those requests through the
     * preview server, so the 44 spike tests reach this server under the same
     * `baseURL` as everything else and needed no changes.
     *
     * It is a real second lifecycle and is kept deliberately: it is the only
     * thing that can serve a dev-only entry point, and it carries 44 of 556
     * tests -- about a twelfth of the socket pressure that caused the failure.
     */
    {
      command: `npx vite --host 127.0.0.1 --port ${DEV_PORT} --strictPort`,
      url: `http://127.0.0.1:${DEV_PORT}`,
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
    },
  ],
});
