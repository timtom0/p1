/**
 * The spike harness, built and served separately from the product.
 *
 * ## Why this exists
 *
 * `spike.html` is the throwaway §10.3 research harness (ADR 0001). It must not ship, so the main
 * build excludes it — `vite.config.ts` pins `rollupOptions.input` to `index.html` alone, and
 * building the spike would make it an unowned second entry point in the shipped output.
 *
 * That left it as the last thing in the repository served by a **dev** server, and that is the
 * defect this removes. A dev boot pulls the module graph over one request per module — measured
 * at ~49 — and every one of those short-lived sockets lingers in `TIME_WAIT` for 240s against a
 * 16,384-port dynamic range. The browser suite holds one long-lived server across every test, so
 * the pool runs dry and Chromium fails a request with
 *
 * ```
 * /src/render/assets.ts -> status -1, _failureText "net::ERR_NO_BUFFER_SPACE"
 * ```
 *
 * which Windows logs as `Tcpip` event 4231. The browser then gives up on a request that never
 * reached the server, `app.ts` is never evaluated, no `[data-page]` exists, and the boot looks
 * like an application fault. It was never an application fault — it happened to a spike test
 * during M20 and cost a full diagnostic cycle before that was established.
 *
 * The product was moved off the dev server for exactly this reason and now boots as one bundled
 * request. This does the same for the spike: **bundle it, serve it statically, and the failure
 * surface disappears rather than being tolerated.**
 *
 * ## Why a separate output directory rather than `dist/`
 *
 * ADR 0001 is about what *ships*, and `dist/` is what ships. Writing the spike anywhere inside
 * it would put an unowned second entry point into the release artefact even if nothing published
 * it. `dist-spike/` is a sibling, git-ignored, and never referenced by the product build, so the
 * exclusion the ADR asks for is structural rather than a promise.
 *
 * The asset directory is `spike-assets/` for the same reason from the other side: both bundles are
 * served through the same `baseURL`, and two sets of hashed files both claiming `/assets/` would
 * collide. The proxy in `vite.config.ts` maps this path explicitly and refuses to proxy `/`.
 */

import { defineConfig } from 'vite';
import { port } from './vite.config';

const DEV_PORT = port('P1_DEV_PORT', 5175);

export default defineConfig({
  build: {
    outDir: 'dist-spike',
    emptyOutDir: true,
    assetsDir: 'spike-assets',
    rollupOptions: {
      input: { spike: 'spike.html' },
    },
  },

  /*
   * The same shape as the product's preview server -- build output, served statically -- so the
   * spike boot is one bundled request instead of ~49, and the browser suite needs no dev server
   * at all.
   */
  preview: {
    port: DEV_PORT,
    strictPort: true,
  },
});
