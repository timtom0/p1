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

const PORT = 5174;

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
    trace: 'off',
    video: 'off',
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

  webServer: {
    // Bind explicitly to 127.0.0.1. Vite's default host resolution can land on
    // IPv6 ::1, which the readiness probe below does not reach on Windows.
    command: `npx vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env['CI'],
    timeout: 60_000,
  },
});
