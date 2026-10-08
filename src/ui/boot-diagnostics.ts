/**
 * A boot timeline, owned by the product and readable by a test.
 *
 * ## Why this exists
 *
 * The browser suite loses roughly one test per full run to a boot that never completes. The harness
 * reported it as `no [data-page] within 15s` alongside `readout: "100%"`, and those two facts were
 * read as a contradiction: an app that painted chrome but no document. They are not contradictory.
 * `index.html` ships `<output data-zoom-readout>100%</output>` as static markup, so `100%` was the
 * *default*, present before a line of application JavaScript ran. The harness's comment claimed the
 * readout was "only populated after `project()` and `viewport.fit()` run", and that claim was false.
 *
 * The captured occurrence shows what actually happened: the retained trace holds 23 module requests
 * where a healthy boot makes 49, then nothing for the remaining ~13s. The module graph stalled
 * partway, so `app.ts` was never evaluated at all -- no boot, no `[data-page]`, and a readout that was
 * never the app's to begin with.
 *
 * So the difficulty was not that a boot stalled. It was that a check which cannot distinguish "never
 * started" from "started and did not finish" reports both the same way, and the harness can only see
 * the DOM -- the *result* -- which cannot say whether `view.render` was never entered, returned having
 * produced nothing, or produced a page that was subsequently removed. This module records the
 * transitions at the points that actually distinguish those, and its *presence* distinguishes the
 * first case from all the others: no surface at all means no module ran. A failure therefore names its
 * own cause instead of requiring a reproduction nobody can schedule.
 *
 * ## Where it lives, and where it deliberately does not
 *
 * Not in the persistent document. It is boot-time observation of the *application*, not a fact about
 * the document, so putting it in `Document` would make it a field to serialise, compare, migrate and
 * round-trip. It is also not in the UI: nothing renders it, and no control depends on it, so the
 * normal UI cannot be perturbed by its presence.
 *
 * ## Cost
 *
 * A bounded ring of small strings plus a monotonic counter. Recording is unconditional and allocation
 * is trivial at boot scale, so there is nothing to gate behind a debug flag -- and a flag is the thing
 * that would make the timeline absent exactly when it is needed.
 */

export interface BootStep {
  /** Milliseconds since the module was first touched, i.e. since boot began. */
  readonly at: number;
  readonly step: string;
  /** Small, JSON-safe. Only ever counts and names, never a document. */
  readonly detail?: Readonly<Record<string, number | string | boolean | null>>;
}

/** Bounded, so a long session cannot grow it without limit. Boot is a handful of steps. */
const MAX_STEPS = 200;

const steps: BootStep[] = [];
let startedAt = 0;

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Records a boot transition. Named after what happened, not after where it was written from. */
export function recordBootStep(step: string, detail?: BootStep['detail']): void {
  if (startedAt === 0) startedAt = now();
  if (steps.length < MAX_STEPS) {
    steps.push(detail === undefined ? { at: now() - startedAt, step } : { at: now() - startedAt, step, detail });
  }
}

/** The timeline, oldest first. A copy, so a reader cannot corrupt the record. */
export function bootTimeline(): readonly BootStep[] {
  return steps.map((entry) => ({ ...entry }));
}

/** The shape tests read. Named to match the debug surface rather than this module's internals. */
export interface BootDiagnostics {
  readonly timeline: readonly BootStep[];
  /** How many page elements existed at the last observation, and when. */
  readonly lastPageObservation: { count: number; at: number } | null;
}

/**
 * Mutable internally, read-only outward.
 *
 * The read-only `BootDiagnostics` is what callers get, so a reader cannot rewrite the record it is
 * reporting on -- the same rule the model's immutable documents follow, for the same reason: a
 * diagnostic that a test can alter is not evidence.
 */
const state = {
  lastPageObservation: null as { count: number; at: number } | null,
};

/**
 * Reads the page stack from the DOM and records it against the timeline.
 *
 * Called by the harness as well as by boot, which is what makes `lastPageObservation` meaningful: it
 * is the product observing the same DOM the test is looking at, at a known time. If a test later sees
 * a different number, the timeline says which came first.
 */
export function observeRenderedPages(): number {
  const count = document.querySelectorAll('[data-page]').length;
  state.lastPageObservation = { count, at: now() - startedAt };
  return count;
}

/** The current diagnostic surface, rebuilt on read so it always reflects the live timeline. */
export function bootDiagnostics(): BootDiagnostics {
  return { timeline: bootTimeline(), lastPageObservation: state.lastPageObservation };
}

/** The surface tests read. A function-bag, deliberately not a snapshot: a snapshot would be stale. */
export interface BootDiagnosticsSurface {
  read: () => BootDiagnostics;
  record: (step: string, detail?: BootStep['detail']) => void;
  observeRenderedPages: () => number;
}

/**
 * Publishes the surface on `window`.
 *
 * Attached under a `__P1_`-prefixed name so it is unmistakably a test surface rather than an app API,
 * and so it cannot collide with anything the document or the UI owns.
 */
export function publishBootDiagnostics(): BootDiagnosticsSurface {
  const surface: BootDiagnosticsSurface = {
    read: bootDiagnostics,
    record: recordBootStep,
    observeRenderedPages,
  };
  (window as unknown as Record<string, unknown>)['__P1_BOOT__'] = surface;
  return surface;
}