import { defineConfig } from 'vitest/config';

/**
 * The port the browser suite's *production* server listens on, and the port the
 * dev server listens on behind it.
 *
 * The preview port is the suite's `baseURL`, because the overwhelming majority
 * of tests address the application at `/` and must get the built bundle. The dev
 * port is separate so the two lifecycles cannot collide on `--strictPort`.
 *
 * **Overridable by environment variable, for one reason only.** The mutation
 * runner (M19) gives each parallel worker its own copy of the tree, and two
 * workers cannot share a `--strictPort` server. `P1_PREVIEW_PORT` and
 * `P1_DEV_PORT` let a worker take a distinct pair; the defaults are the values
 * every other caller — dev, build, the browser suite — already uses, so nothing
 * else in the project can tell the difference.
 *
 * Read as a number at module scope rather than inside a function so a malformed
 * value fails once, loudly, instead of producing `5174NaN` and a confusing port
 * error much later.
 */
function port(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be a port number between 1 and 65535, got "${raw}"`);
  }
  return value;
}

const PREVIEW_PORT = port('P1_PREVIEW_PORT', 5174);
const DEV_PORT = port('P1_DEV_PORT', 5175);

export default defineConfig({
  server: { port: 5173 },
  /*
   * `preview` proxies the spike harness back to the dev server.
   *
   * The browser suite is served the production bundle for `/` (see
   * `playwright.config.ts` for why: the unbundled dev module graph exhausts the
   * OS ephemeral port pool over a long run). But `spike.html` is deliberately
   * excluded from that bundle -- it is throwaway §10.3 research, recorded in
   * ADR 0001, and building it would make it an unowned second entry point in
   * the shipped output.
   *
   * `spike.html` loads `/src/spike/text-spike.ts` as a raw module, which only
   * the dev transform can serve. So it, and the dev-only request shapes it needs,
   * are proxied here. This keeps a single origin for every test: `baseURL` does
   * not change per spec, and the spike specs keep working unmodified.
   *
   * Deliberately NOT proxied: `/` and `/assets/`. Those must come from `dist/`,
   * which is the entire point -- if `/` ever fell through to the dev server the
   * suite would silently be testing the thing it was moved away from.
   */
  preview: {
    port: PREVIEW_PORT,
    strictPort: true,
    proxy: {
      '/spike.html': `http://127.0.0.1:${DEV_PORT}`,
      '/src': `http://127.0.0.1:${DEV_PORT}`,
      '/@vite': `http://127.0.0.1:${DEV_PORT}`,
      '/node_modules': `http://127.0.0.1:${DEV_PORT}`,
    },
  },
  build: {
    /*
     * `spike.html` is the throwaway §10.3 research harness. It must not ship: the
     * findings are recorded in docs/adr/0001, and the harness would otherwise
     * become an unowned second entry point in the production bundle.
     *
     * Removing it here rather than deleting the files keeps the experiment
     * reproducible — `npx playwright test spike` still runs it in dev.
     */
    rollupOptions: {
      input: { main: 'index.html' },
    },
  },
  test: {
    /*
     * `src/**` is the product. `tests/spike/**` holds fixture *sources* that are
     * injected into a page, and those need a unit-level guard: a malformed one throws
     * before the app boots, the app silently falls back to the sample document, and
     * the probe then fails with "no element" three screens from the cause. The guard
     * is a Vitest test because it is a parse check, not a browser claim — the browser
     * claims live in `tests/spike/measure-probe.spec.ts`.
     */
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
  },
});