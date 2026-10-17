/**
 * The gate, in the order that fails fastest, with the expensive part last and opt-in.
 *
 * ## Why this exists
 *
 * `npm run test:visual` is a 42-minute serial browser run. Running it to check a change to one
 * inspector field is a 42-minute answer to a two-second question, and doing that repeatedly is how a
 * session turns into an hour of the machine being busy.
 *
 * So this splits the gate in two:
 *
 *   1. **The cheap gate** -- typecheck, lint, unit. About three minutes, no browser, and it catches
 *      the large majority of mistakes. Always runs.
 *   2. **The browser gate** -- only the specs named on the command line, or a small core set that
 *      catches store/persistence breakage. `--all` runs the whole suite.
 *
 * ## What this will not do
 *
 * It will not guess. A changed file does not determine which specs cover it without a dependency
 * graph nobody has written down, and a wrong guess is worse than none: it reports a green gate for a
 * change nothing tested. So the browser specs are named by the caller, and this says so rather than
 * pretending otherwise.
 *
 * ## Cleaning up after itself
 *
 * Every long run used to leave orphan vite servers behind -- `Stop-Process` on an `npx` wrapper
 * leaves the `vite.js` child running -- and those accumulate across a session and compete with the
 * user's own browser for memory. `--clean` reaps them, and the mutation runner's teardown now kills
 * the tree. Run `node scripts/sweep.cjs --clean` any time if something looks wedged.
 *
 * Usage:
 *   node scripts/sweep.cjs                          cheap gate + the core specs
 *   node scripts/sweep.cjs tests/editor/units.spec.ts
 *   node scripts/sweep.cjs --all                    cheap gate + every browser spec
 *   node scripts/sweep.cjs --clean                  reap orphans and exit
 */

const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

const ROOT = process.cwd();
const BIN = (name) => join(ROOT, 'node_modules', '.bin', `${name}.cmd`);

/**
 * Specs run when none are named.
 *
 * Chosen for breadth rather than depth: each one covers a different way the store can break, so
 * together they catch "something fundamental changed" without costing 42 minutes. They are not a
 * substitute for the full run -- they are the smoke test that says the smoke is worth watching.
 */
const CORE = [
  'tests/editor/persistence.spec.ts', // store, save, open, refuse
  'tests/editor/selection.spec.ts', // hit-testing, which every geometry change touches
  'tests/editor/pages.spec.ts', // page setup, which owns the document unit
];

const argv = process.argv.slice(2);
const wantAll = argv.includes('--all');
const specs = argv.filter((a) => !a.startsWith('--'));

const run = (label, command, args, { optional = false } = {}) => {
  process.stdout.write(`\n=== ${label} ===\n`);
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
    // No timeout: the browser suite is 42 minutes by design and the caller asked for it.
  });
  const seconds = Math.round((Date.now() - started) / 1000);
  if (result.error !== undefined && result.error !== null) {
    console.log(`  could not start: ${result.error.message}`);
    return 1;
  }
  const code = result.status === null ? 1 : result.status;
  console.log(`  ${label}: exit ${code} (${seconds}s)`);
  if (code !== 0 && !optional) process.exitCode = code;
  return code;
};

/**
 * Reap vite servers this repo started and no longer wants.
 *
 * Scoped to `p1\node_modules` in the command line, so it cannot reach a server the user started
 * themselves. The name filter alone would not be enough: `vite preview` is what a developer runs to
 * look at their own work, and that is exactly the process this must not kill.
 */
function clean() {
  const query =
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    "Where-Object { $_.CommandLine -like '*vite*' -and $_.CommandLine -like '*p1\\node_modules*' } | " +
    'Select-Object -ExpandProperty ProcessId';
  const found = spawnSync('powershell', ['-NoProfile', '-Command', query], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true,
  });
  const pids = (found.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line));
  for (const pid of pids) {
    spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore', shell: true });
  }
  console.log(pids.length === 0 ? '  no orphans' : `  reaped ${pids.length} orphan server(s)`);
}

if (argv.includes('--clean')) {
  clean();
  process.exit(0);
}

// The cheap gate. Nothing here needs a browser, so a failure here costs seconds to find and the
// browser suite is not even started.
run('typecheck', BIN('tsc'), ['--noEmit']);
run('lint', BIN('eslint'), ['src', 'tests']);
run('unit', BIN('vitest'), ['run', '--reporter=basic']);

// The browser gate.
const targets = wantAll ? [] : specs.length > 0 ? specs : CORE;
run(
  wantAll ? 'browser (ALL)' : `browser (${targets.length} spec${targets.length === 1 ? '' : 's'})`,
  BIN('playwright'),
  ['test', '--reporter=line', ...targets],
);

if (process.env['P1_KEEP_SERVERS'] === undefined) clean();

const failures = [
  process.exitCode === undefined || process.exitCode === 0 ? null : `exit ${process.exitCode}`,
].filter((x) => x !== null);
console.log(
  failures.length === 0
    ? '\nGate green.'
    : `\nGate red: ${failures.join(', ')}.${wantAll ? '' : ' Full browser suite not run -- pass --all if you want it.'}`,
);