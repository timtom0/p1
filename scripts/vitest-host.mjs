// A long-lived Vitest process, answering `vitest run <target>` over a request/response file pair.
//
// **Why this exists.** The unit half of the mutation corpus costs ~3.9s per mutant, of which only ~50ms is
// the tests themselves. The rest is process bootstrap: node startup, the `vitest.cmd` shim, config load,
// worker fork. 75 mutants pay that 75 times, for ~294s of the run.
//
// Reusing one Node process removes the bootstrap. `startVitest` is called once per request and builds a
// fresh Vitest (and therefore a fresh Vite server and module graph) each time, so **each run still reads
// the mutated file from disk**. That is the whole safety argument, and it is why this uses `startVitest`
// rather than `createVitest` + `rerunFiles`: the latter reuses one Vite server across runs, keeps a
// transformed module of the file under mutation in memory, and reports a *stale* result. Measured, it was
// 4x faster again than this and silently wrong -- it reported DETECTED for clean runs after a revert, so
// it would have manufactured survivors, which is the one outcome this tool must never produce by accident.
// The faster option is the dangerous one. See the fidelity check in `mutation-check.ps1`.
//
// **Protocol.** The runner writes `req.json` (atomically, via a temp file and a rename, so a partial write
// is never observed) containing `{ id, target }`. This loop notices the new id, runs it, and writes
// `res.json` the same way. Ids are monotonic, so a stale response can never be mistaken for a current one.
// `id: 0` is the shutdown request.
//
// **`process.exitCode` is saved and restored around every run.** Vitest sets it to 1 when tests fail, and
// a mutant *failing its suite is the expected case here* -- without this the host would exit 1 after the
// first detected mutant and take the rest of the run down with it.
//
// **`process.setMaxListeners(0)`** is not cosmetic. Every `startVitest` call constructs a `Logger` that
// registers a `process.on('unhandledRejection')` listener which is never removed, so listeners accumulate
// one per mutant and Node starts warning at 11. The leak is small -- measured at ~2.5% drift over 72
// consecutive runs -- but it is monotonic, and the warning is noise that hides real ones.

import fs from 'node:fs';
import path from 'node:path';
import { startVitest } from 'vitest/node';

process.setMaxListeners(0);

const dir = process.argv[2];
const root = process.argv[3];

if (!dir || !root) {
  console.error('usage: vitest-host.mjs <request-dir> <repo-root>');
  process.exit(2);
}

const reqPath = path.join(dir, 'req.json');
const resPath = path.join(dir, 'res.json');
const tmpPath = path.join(dir, 'res.tmp');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Write via temp + rename so the reader never sees a half-written file. */
function writeAtomic(file, text) {
  fs.writeFileSync(tmpPath, text, 'utf8');
  fs.renameSync(tmpPath, file);
}

/**
 * Run one target and return exactly the text the CLI would have printed.
 *
 * Vitest's reporters write straight to `process.stdout`. Rather than reimplement the `basic` reporter and
 * risk drifting from it, stdout and stderr are tee'd for the duration of the run, so the text -- and
 * therefore the runner's `\d+ failed` verdict regex -- behaves identically to the CLI it replaces.
 */
async function runOnce(target) {
  const chunks = [];
  const capture = (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return true;
  };

  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const savedExitCode = process.exitCode;

  process.stdout.write = capture;
  process.stderr.write = capture;

  try {
    await startVitest('test', [target], { watch: false, run: true, reporters: ['basic'] }, { root });
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    process.exitCode = savedExitCode;
  }

  return Buffer.concat(chunks).toString('utf8');
}

let lastId = 0;
let lastSeen = Date.now();

// Self-terminate when idle. The runner sends `id: 0` to shut down cleanly, but a runner that is killed
// outright -- a closed terminal, a machine restart -- never gets to send it. Without this, every such
// event leaves a Node process alive holding a temp directory, and the next run inherits the mess. The
// window is generous because a real unit suite is ~2s and the loop is otherwise idle.
const IDLE_MS = 10 * 60 * 1000;

for (;;) {
  if (Date.now() - lastSeen > IDLE_MS) process.exit(0);

  let payload = null;
  try {
    payload = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
  } catch {
    payload = null; // absent or mid-rename; try again
  }

  if (!payload || payload.id === lastId) {
    await sleep(4);
    continue;
  }
  lastId = payload.id;
  lastSeen = Date.now();

  if (payload.id === 0) {
    writeAtomic(resPath, JSON.stringify({ id: 0, ok: true, output: '' }));
    process.exit(0);
  }

  let response;
  try {
    response = { id: payload.id, ok: true, output: await runOnce(payload.target) };
  } catch (err) {
    // A host that cannot start Vitest must say so rather than return empty text: empty output matches no
    // `\d+ failed`, which the runner would read as "the suite passed" and record as a survivor.
    response = { id: payload.id, ok: false, output: '', error: String((err && err.stack) || err) };
  }

  try {
    writeAtomic(resPath, JSON.stringify(response));
  } catch (err) {
    try {
      writeAtomic(resPath, JSON.stringify({ id: payload.id, ok: false, output: '', error: String(err) }));
    } catch { /* the runner will time out and report it */ }
  }
}