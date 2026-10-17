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
 * Browser viewport.
 *
 * ## Why this is configurable, and why the default did not move
 *
 * The obvious saving is that a viewport is not free: every repaint rasters its full area, and
 * 2400x2600 is 6.2 megapixels. So `P1_VIEWPORT=WIDTHxHEIGHT` exists, and is validated.
 *
 * **Measured on this machine, 3 repeats of a single boot, alternating** -- the run-to-run spread
 * here is large enough that a single sample is worthless, which is exactly what a first, un-repeated
 * measurement said (it claimed 2.3x; the truth is below):
 *
 * | viewport | boot |
 * |---|---|
 * | 2400x2600 (the default) | 1.7 / 1.5 / 1.6s -- **1.60s** |
 * | 1600x1000 | 1.3 / 1.3 / 1.4s -- **1.33s** |
 * | 2400x1400 | 1.2s |
 * | 1280x900 | 1.4s |
 *
 * The ceiling on this lever is about **17% of boot time**, and it scales with *height* rather than
 * area: 2400x1400 has three times the pixels of 1280x900 and boots no slower.
 *
 * ## Why it is not the default
 *
 * Because it is not free, and the bill arrives as **input tests silently selecting nothing**. At
 * 1600x1000 and again at 2400x1400, `group-geometry.spec.ts` fails eight hit-testing and
 * text-editing tests. A document point that is on the page at one size is *below the fold* at
 * another; `page.mouse.click` takes viewport coordinates, so the click lands outside the window and
 * selects nothing. Nothing fails loudly -- the assertion just sees an empty selection.
 *
 * The cause is in the harness rather than here: `clientPointAt` maps a document point to client
 * coordinates and **does not scroll**, so its answer silently depends on the viewport.
 * `clickablePointAt` (added for M24) does scroll and does verify, which is why the specs that use it
 * keep working at any size.
 *
 * Making the small viewport the default would mean either a suite that quietly loses input coverage
 * or a large refactor of helpers twenty-odd specs share. Neither belongs in a config change. So the
 * default stays large, `npm run sweep` does not set this, and the knob is here for the case that
 * actually wants it: a fast smoke run over specs that are not gesture-driven.
 */
function viewport(): { width: number; height: number } {
  const raw = process.env['P1_VIEWPORT'];
  if (raw === undefined || raw === '') return { width: 2400, height: 2600 };
  const parts = raw.split('x').map((part) => Number.parseInt(part, 10));
  const w = parts[0] as number | undefined;
  const h = parts[1] as number | undefined;
  if (w === undefined || h === undefined || !Number.isInteger(w) || !Number.isInteger(h)) {
    throw new Error(`P1_VIEWPORT must be WIDTHxHEIGHT, got "${raw}"`);
  }
  if (w < 200 || h < 200) {
    throw new Error(`P1_VIEWPORT must have both dimensions at least 200, got "${raw}"`);
  }
  return { width: w, height: h };
}

const VIEWPORT = viewport();

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
     * **A server left over from an earlier run silently wins.**
     *
     * `reuseExistingServer` adopts whatever is already listening, so a preview server started
     * before this file changed keeps serving the *old* configuration. When the spike stopped
     * being proxied to a dev transform and became a bundle under `/spike-assets/`, a stale server
     * had no proxy rule for that path: the page loaded, its script 404'd, and 44 spike tests failed
     * on `window.__spike` never appearing -- a failure that reads like the spike being broken and is
     * actually the harness being stale.
     *
     * So if a server change and a spike-shaped failure arrive together, restart the server before
     * investigating anything else. `P1_PREVIEW_PORT`/`P1_DEV_PORT` are the clean way to get a
     * guaranteed-fresh pair without touching a running process.
     */
    /*
     * The spike harness's own server.
     *
     * `spike.html` is excluded from the production bundle on purpose (ADR 0001:
     * throwaway §10.3 research that must not become a second shipped entry point),
     * so it needs a build of its own. `vite.spike.config.ts` produces it into
     * `dist-spike/`, a git-ignored sibling of `dist/` that the product build never
     * reads, and serves that output statically.
     *
     * **This used to be a dev server**, and that was the defect. A dev boot pulls
     * the module graph over one request per module -- ~49 -- and each of those
     * short-lived sockets lingers in `TIME_WAIT` for 240s against a 16,384-port
     * dynamic range. Across a suite that holds one long-lived server, the pool runs
     * dry and Chromium fails a request with `net::ERR_NO_BUFFER_SPACE` (Windows
     * `Tcpip` event 4231). The browser then gives up on a request that never
     * reached the server, the page never boots, and the failure reads as an
     * application fault. It was not one -- and it landed on a spike test during M20,
     * where it cost a diagnostic cycle before anyone established that.
     *
     * The product was moved off the dev server for the same reason; this is the
     * last server doing it. Bundling removes the failure surface rather than
     * tolerating it, and it retires the only dev-only request shapes the proxy
     * needed to forward.
     *
     * Same shape as the server above -- build, then preview the output -- so a
     * preview server can never come up against a missing or stale `dist-spike/`.
     */
    {
      command:
        `npm run build:spike && npx vite preview --config vite.spike.config.ts ` +
        `--host 127.0.0.1 --port ${DEV_PORT} --strictPort`,
      url: `http://127.0.0.1:${DEV_PORT}/spike.html`,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
    },
  ],
});
