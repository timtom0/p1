import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { port: 5173 },
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