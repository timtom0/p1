param(
  [string] $Filter = '',
  [switch] $List,
  [switch] $NoBrowser,
  [switch] $CheckSites,

  # Parallel workers. Each gets its own copy of the tree and its own pair of ports, because a
  # mutation is a *file edit*: two workers sharing a workspace would corrupt each other, and two
  # workers sharing a --strictPort server would collide. Default 1, which is the serial path
  # unchanged -- see the parallelism note below for the measurements.
  [int] $Workers = 1,

  # Internal: set on the worker child process, never by a human.
  [int] $WorkerIndex = -1,
  [string] $ResultsFile = '',
  # The slice this worker runs, as indices into the selected corpus. Passed rather than recomputed:
  # the parent balanced it by cost, and two places computing a split is two places that must agree.
  [string[]] $WorkerIndices = @()
)

#  Mutation check: break one behaviour at a time, confirm the test that claims it fails.
#
# A green suite proves nothing unless a test *would* have failed. Each mutation is applied, the
# relevant suite is run, and the file is restored -- so a mutation that silently fails to apply is
# itself reported as an error rather than as a pass. Every mutation is reverted in a `finally`, so a
# crash cannot leave a mutated file behind.
$ErrorActionPreference = 'Continue'

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
#   powershell -ExecutionPolicy Bypass -File scripts\mutation-check.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\mutation-check.ps1 -Filter 'group|tree'
#   powershell -ExecutionPolicy Bypass -File scripts\mutation-check.ps1 -List
#   powershell -ExecutionPolicy Bypass -File scripts\mutation-check.ps1 -NoBrowser
#
# -Filter selects by *label*, matched case-insensitively as a regex. This is the parameter that
#   matters: a targeted run costs seconds, where a full run costs about half an hour.
# -List prints every label and target without running anything.
# -NoBrowser skips browser mutants, for iterating on model code where they cannot be the subject.
#
# ---------------------------------------------------------------------------
# Performance: what was measured, and what actually helped (M13)
# ---------------------------------------------------------------------------
# M12 reported a ~7 hour mutation cost. The measured breakdown at the start of M13:
#
#   * One clean full run of 52 mutants was **30.9 min**, 52/52 detected. The seven hours were the
#     *cumulative* cost of running the suite roughly six times while M12's mutations were being
#     written -- each attempt aborting or being re-run as sites moved -- so the real defect was
#     **having no narrow scope**, not a slow harness.
#   * Per-mutant cost: ~3-4s for a Vitest target, ~30-85s for a Playwright target. The three
#     heaviest browser targets are `layers.spec.ts` (58s), `selection-frame.spec.ts` (35s) and
#     `group-geometry.spec.ts` (33s), and 20 of the 52 mutants target a browser suite.
#
# Four changes, in descending order of what they actually bought:
#
#   1. **`-Filter` (new).** The whole point. A 2-mutant targeted run is seconds rather than ~1900s.
#      Before this, the only way to check one mutant was to run all 52.
#   2. **Per-mutant timing (new).** The cost was a black box, so nobody could tell which mutants were
#      expensive, or that 20 of 52 targeted a browser. Now printed per mutant and summarised as the
#      five slowest at the end.
#   3. **`npx` -> the direct binary (~2.5-3s per mutant, ~2.5 min over a full run).** `npx` spawns a
#      Node wrapper and re-resolves the package for every invocation; the runner does not need it,
#      since the dependency is already installed.
#   4. **One dev server for the whole run.** `playwright.config.ts` already sets `reuseExistingServer: !CI`,
#      but nothing ever left a server running, so every browser mutant spawned `vite` and waited for the
#      readiness probe. This script starts one, keeps it for every mutant, and stops it in a `finally`.
#      In the parallel path the parent starts one *per workspace* and the workers never start one at all --
#      see `Start-DevServer`, where doing that from inside a `Start-Job` does not work.
#
#   5. **`--max-failures=1` on browser targets (M19). 34.3 min to 15.4 min.** The only question asked of a
#      suite is "did it fail?", and for a detected mutant that is settled by the first failing test; the rest
#      cannot change the answer. Measured on the print suite: 70.3s down to 30.0s for one mutant, and over
#      the full corpus the browser mutants went from the ~30-85s quoted above to 3-16s each. Detection is
#      unaffected -- the check is `$out -match '\d+ failed'` and Playwright still prints `1 failed`.
#
# And two more things that were measured and **not** adopted, recorded because both are the obvious next
# idea and both cost real time to establish:
#
#   * **`--bail=1` on Vitest targets**, the direct analogue of lever 5 for the unit half. Detection would
#     survive it (Vitest still prints `Failed Tests 1`, so `$out -match '\d+ failed'` holds), but it is
#     **2.3x slower**: 22.1s against 9.6s on `tests/persist/session.test.ts`. Bail changes Vitest's run
#     mode, and what it saves in test time it more than gives back in collection and teardown.
#   * **Dropping the per-mutant `vite build`.** Not possible, and the reason is the mechanism rather than an
#     accident: since M15 the browser suite is served `dist/`, so a source mutation reaches a browser test
#     *only* through a rebuild. `tsc --noEmit` was already once per run, not per mutant; the build is ~4.5s
#     and is the price of the mutation being real.
#
# **Wall-clock figures from this machine are only comparable when measured back to back.** The slowest
# mutant in the corpus measured 62.2s and then 97.4s on *byte-identical* code hours apart, and a full
# serial run measured 15.9 min and then 24.4 min. That is not this script changing; it is the box. Every
# comparison recorded above was re-measured adjacently for that reason, and any future one should be too.
#
# And one measured-and-rejected:
#
#   * **Parallelism does not help.** `workers: 4` with `fullyParallel` gave 62.5s and 55.5s against
#     58.0s serial on the heaviest suite. The cost is per-test browser setup, not scheduling, so
#     workers contend for the same CPU and the same dev server and hand back nothing. An earlier
#     draft carried a `P1_PARALLEL` env switch in `playwright.config.ts` on the assumption that it
#     would; it was removed rather than left in as unused configuration. `playwright.config.ts` now
#     records the measurement next to `workers: 1`.
#
#   * **Parallelism across *mutants*: implemented, measured, and left off by default.** The rejection above
#     is about splitting the tests of one mutant. This splits the mutants, each with its own workspace copy,
#     its own bundle, its own ports. It is correct and it does not pay on this machine:
#
#     | slice (4 browser + 4 unit, run back to back) | serial | 4 workers |
#     |----------------------------------------------|--------|-----------|
#     | mixed                                          |  111.6s |   187.7s  |
#
#     1.68x slower. Four concurrent Chromium instances plus four builds on four physical cores contend for
#     the thing the browser mutants actually need, and unit work does not make up for it: four concurrent
#     Vitest runs against four serial ones measured 13.66s against 16.93s, so the machine yields about
#     **1.24x** from four-way concurrency on the cheap half of the corpus.
#
#     **The first version of this note was wrong, and the way it was wrong is the useful part.** It
#     reported 22x and 13x, from runs in which every worker sat waiting out a readiness budget against a
#     server that had never started -- see `Start-DevServer`, where a `Start-Process` issued from inside a
#     `Start-Job` produces a process that is alive, silent and never binds its port. So those figures
#     measured a broken harness, not parallelism, and I attributed them to contention and wrote them down
#     as a result. The verdict survived; the evidence did not, and had I checked the logs instead of the
#     timings I would have found it in one run.
#
#     So `-Workers` defaults to **1**, the pool is kept because it is correct and would pay on a machine
#     with cores to spare, and `--max-failures=1` above remains the *only* change that made this faster.
#     to 15.4 min** on the full corpus, with identical results (111 of 112, same accepted survivor).
#
# What is **not** changed: the mutation set, the detected/undetected accounting, the
# "site not found is an error" rule, and the fact that every mutation is reverted whether it passed or
# failed. A narrow run reports how many mutants it actually ran and fails if that count is zero,
# because "no mutants matched" and "every mutant was detected" must never look the same.
#
# ## The corpus was reconstructed, and that is recorded in `mutations.ps1`
#
# Rewriting this file at the start of M13 destroyed the inline corpus, which was untracked. See the
# provenance note at the top of `scripts\mutations.ps1` for what was recovered verbatim, what was
# rebuilt, and why a *detected* mutation is still a verified one.


$log = Join-Path $env:TEMP 'p1-mutation-last.log'

# --- crash recovery ---------------------------------------------------------------------
#
# The header's claim that "a crash cannot leave a mutated file behind" relies on the `finally` in
# `Mutate`, and that claim is **false** when the process dies outside PowerShell's control -- a
# killed `Tee-Object`, a closed pipe, a machine reset mid-run. That is not hypothetical: during
# M13 a run was killed exactly that way and left `src/ui/persistence.ts` without its
# `this.baseline = current;` and `src/persist/deserialize.ts` with an unconditional `node.fit =`.
# Both were only noticed because `-CheckSites` reported three entries that had started passing and
# now failed -- the source was the mutated copy, not the code.
#
# So a copy is taken before the first write and restored on the next start, whatever killed the run.
# The backup directory is beside the script rather than in `%TEMP%` so it survives a cleared temp
# directory, and it is removed when a run finishes normally.
$BackupDir = Join-Path $PSScriptRoot '.mutation-backup'

function Restore-AfterCrash {
  if (-not (Test-Path $BackupDir)) { return }
  $files = @(Get-ChildItem -Path $BackupDir -File)
  if ($files.Count -eq 0) {
    Remove-Item $BackupDir -Recurse -Force -ErrorAction SilentlyContinue
    return
  }
  Write-Host 'A previous mutation run did not finish. Restoring the files it had modified:' -ForegroundColor Yellow
  foreach ($file in $files) {
    # `$file.Name`, not `$file.BaseName`: BaseName strips the extension, so `src__model__tree.ts`
    # restored to a path with no extension and the restore silently did nothing -- found by
    # testing the recovery rather than assuming it worked.
    $relative = $file.Name -replace '__', '/'
    $target = Join-Path (Split-Path $PSScriptRoot -Parent) ($relative -replace '/', '\')
    if (Test-Path $target) {
      Copy-Item -LiteralPath $file.FullName -Destination $target -Force
      Write-Host ("  restored  {0}" -f $relative) -ForegroundColor Yellow
    } else {
      Write-Host ("  MISSING   {0} -- the file it belonged to no longer exists" -f $relative) -ForegroundColor Red
    }
  }
  Remove-Item $BackupDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host 'Restored. If this recurs, the runner is being killed rather than failing.' -ForegroundColor Yellow
}

function Save-BeforeMutation([string] $path) {
  if (-not (Test-Path $BackupDir)) { $null = New-Item -ItemType Directory -Path $BackupDir -Force }
  # The backup name is derived by replacing the directory separators only. An earlier version
  # computed it by substring arithmetic against the repo root and produced a path `Copy-Item`
  # rejected -- which, see the note on `Mutate`, failed *silently* and turned the whole run into a
  # vacuous "every mutation was detected (0 of 0)".
  $flat = $path -replace '[\\/]', '__'
  Copy-Item -LiteralPath $path -Destination (Join-Path $BackupDir $flat) -Force
}

Restore-AfterCrash

# Direct binaries rather than `npx`. See the note above: `npx` costs ~2.5-3s per invocation and the
# package is already installed.
$Vitest     = Join-Path $PSScriptRoot '..\node_modules\.bin\vitest.cmd'
$Playwright = Join-Path $PSScriptRoot '..\node_modules\.bin\playwright.cmd'
$Vite       = Join-Path $PSScriptRoot '..\node_modules\vite\bin\vite.js'
$ViteBuild  = Join-Path $PSScriptRoot '..\node_modules\.bin\vite.cmd'
$Tsc        = Join-Path $PSScriptRoot '..\node_modules\.bin\tsc.cmd'
# The two ports the browser suite uses, and they are **not** interchangeable (M15).
#
#   5174 -- the production build, served by `vite preview`. This is what `/` resolves to.
#   5175 -- the dev server, reachable only through the preview server's proxy, and the only thing that
#           can serve `/spike.html` (excluded from the bundle, loads raw TypeScript).
#
# The runner has to reproduce that arrangement or mutants are measured against a serving model the suite
# never uses. Leaving a *dev* server on 5174 here would be worse than not starting one: `reuseExistingServer`
# would see 5174 answering and skip `npm run build && vite preview` entirely, so every browser mutant would
# silently run against the dev server -- and `tests/visual/production-serving.spec.ts` would fail for a
# reason that has nothing to do with the mutant under test.
# Worker 0 keeps the historical ports, so a single-worker run is exactly the run it always was and any
# stale server on 5174/5175 is reused as before. Worker N is offset by 2N: the pair must differ per
# worker, and the stride leaves room to grow without moving 5174.
$PortBase    = 5174
$PreviewPort = $PortBase + (2 * [Math]::Max(0, $WorkerIndex))
$DevPort     = $PreviewPort + 1

# The servers read their ports from the environment (see `vite.config.ts`), so a worker must export
# them for the *test runner* too, not only for `Start-DevServer`. Only when running as a worker, so a
# serial run leaves the environment untouched.
if ($WorkerIndex -ge 0) {
  $env:P1_PREVIEW_PORT = "$PreviewPort"
  $env:P1_DEV_PORT     = "$DevPort"
}

$script:timings    = @()
$script:corpus     = @()

# Every server this process started, so a single `Stop-DevServer` can tear all of them down. The serial
# path starts at most two; the parallel path starts up to two per browser workspace.
$script:servers    = @()

function Add-Mutation([string] $label, [string] $path, [scriptblock] $apply, [string] $target) {
  $script:corpus += [pscustomobject]@{ label = $label; path = $path; apply = $apply; target = $target }
}

function Stop-DevServer {
  foreach ($server in $script:servers) {
    if ($null -ne $server) {
      Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    }
  }
  $script:servers = @()
}

# Waits for a server to answer, bounded by **wall-clock seconds**, and gives up immediately if the server
# process has died.
#
# This was originally a *try count*, which is the wrong unit and cost a measured 830 seconds.
#
# Each attempt is `Start-Sleep 500ms` plus an `Invoke-WebRequest -TimeoutSec 2`. When nothing is listening
# the connection is refused instantly, so a try costs ~0.5s -- but when the port is filtered or held by a
# process that never answers, the probe burns its **full 2s timeout** every time. A 60-try budget is then
# 30s in the good case and 150s in the bad one; the 360-try budget I added for workers was 180s at best and
# **~900s at worst**. That is where the "parallelism is 22x slower" result came from: not four workers
# contending, but one worker sitting in a wait loop against a server that had never started. The warning it
# printed -- a single yellow line -- was the only symptom, and I read it as contention rather than as a bug.
#
# So: a deadline rather than a count, an early exit when the process is gone, and the captured server log
# printed on failure. A failure that costs seconds and explains itself can be acted on; one that costs
# fifteen minutes and says nothing cannot.
function Wait-Ready([int] $port, [string] $what, $process) {
  $budget = if ($WorkerIndex -ge 0) { 60 } else { 30 }
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  while ($clock.Elapsed.TotalSeconds -lt $budget) {
    Start-Sleep -Milliseconds 500
    # The common case is a server that refused to start at all -- a taken `--strictPort`, or a workspace
    # with no `dist/`. Waiting out the budget for a process that has already exited helps nobody.
    if ($null -ne $process -and $process.HasExited) {
      Write-Host "WARNING: the shared $what server on $port exited immediately (code $($process.ExitCode))" -ForegroundColor Yellow
      Show-ServerLog $port $what
      return $false
    }
    try { $null = Invoke-WebRequest -Uri "http://127.0.0.1:$port" -TimeoutSec 2 -UseBasicParsing; return $true } catch { }
  }
  Write-Host ("WARNING: the shared {0} server on {1} did not become ready within {2:N0}s; browser mutants will start their own" -f $what, $port, $budget) -ForegroundColor Yellow
  Show-ServerLog $port $what
  return $false
}

# Prints whatever the server wrote to its log. The log is per-port, so this is that server's own output and
# cannot be interleaved with another's.
function Show-ServerLog([int] $port, [string] $what) {
  foreach ($stream in @('out', 'err')) {
    $path = Server-Log $port $what $stream
    if (Test-Path $path) {
      $tail = @(Get-Content $path -Tail 6 -ErrorAction SilentlyContinue) -join ' | '
      if ($tail.Trim()) { Write-Host ("  {0} on {1} said: {2}" -f $what, $port, $tail) -ForegroundColor DarkGray }
    }
  }
}

# **Per-worker log paths.** These were one shared pair in `$env:TEMP` for the whole process, which was
# correct only while one runner existed. Concurrent workers each redirect their server's stdout and stderr
# into the *same two files*, and two processes writing one file is not something PowerShell coordinates --
# so a worker's server could fail to launch for a reason that appeared nowhere, and the symptom was again
# only the "did not become ready" line. Keyed on the port, which is unique per workspace.
function Server-Log([int] $port, [string] $what, [string] $stream) {
  $ext = if ($stream -eq 'out') { 'log' } else { 'err' }
  return (Join-Path $env:TEMP ("p1-mutation-{0}-{1}.{2}" -f $what, $port, $ext))
}

# Builds a worker workspace: `tsc --noEmit` then `vite build`, inside that directory.
#
# **`Set-Location` alone is not enough, and the reason is the same one that made the pool report every
# mutant undetected.** `Set-Location` moves PowerShell's provider location; it does not move
# `[Environment]::CurrentDirectory`, which is what a child process inherits. So a build "in" another
# directory silently built the *caller's* repository unless the process directory is set explicitly.
# Saved and restored so the parent is left where it started.
function Build-Workspace([string] $dir) {
  $saved = [System.Environment]::CurrentDirectory
  try {
    [System.Environment]::CurrentDirectory = $dir
    Set-Location -LiteralPath $dir
    if (Test-Path $Tsc) {
      & $Tsc --noEmit
      if ($LASTEXITCODE -ne 0) { return $false }
    }
    $null = & $ViteBuild 'build'
    return ($LASTEXITCODE -eq 0)
  } finally {
    [System.Environment]::CurrentDirectory = $saved
    Set-Location -LiteralPath $saved
  }
}
# Starts the two servers a browser mutant needs, for one root directory and one port pair.
#
# Two servers for the whole run, mirroring `playwright.config.ts`. `reuseExistingServer` means Playwright uses
# these rather than spawning its own per mutant; starting them explicitly is what turns ~20 spawns into 2.
#
# **This is only ever called from the parent, never from a worker.** Measured: a `vite preview` launched with
# `Start-Process` from inside a `Start-Job` comes up *alive, silent, and never binds its port* -- 0 bytes on
# both streams, no URL line, connection refused. The identical command from the main shell answers HTTP 200
# every time, and the workspace's `node_modules` junction is not implicated: the junction path works from
# the shell, and the real (non-junction) path fails from inside the job.
#
# That single quirk is what made the pool look like a 22x pessimisation. Four workers, each waiting out a
# readiness budget against a server that could never start, then falling back to Playwright spawning its own
# per mutant -- the wall clock was one stall multiplied by four, and it had nothing to do with contention.
# So the parent brings every server up front, once per workspace, and a worker only applies, runs and
# restores. Which is also the cheaper arrangement: servers are per workspace, not per mutant.
function Start-DevServer([string] $Root, [int] $Preview, [int] $Dev, [switch] $SkipBuild) {
  if (-not $Root) { $Root = Split-Path $PSScriptRoot -Parent }
  $vite = Join-Path $Root 'node_modules\vite\bin\vite.js'
  if (-not (Test-Path $vite)) { return }

  $savedCwd     = [System.Environment]::CurrentDirectory
  $savedPreview = $env:P1_PREVIEW_PORT
  $savedDev     = $env:P1_DEV_PORT
  try {
    # `Set-Location` moves PowerShell's provider location only; a child process inherits
    # `[Environment]::CurrentDirectory`. See `Build-Workspace` for the same trap, and `port()` in
    # `vite.config.ts` for why the servers need the port in the environment at all.
    [System.Environment]::CurrentDirectory = $Root
    Set-Location -LiteralPath $Root
    $env:P1_PREVIEW_PORT = "$Preview"
    $env:P1_DEV_PORT     = "$Dev"

    # `-SkipBuild` is for a workspace the parent has **already built**. Building here would be correct but
    # wasteful: the parallel path builds each workspace once, sequentially, before starting any worker, so
    # that four `tsc --noEmit` + `vite build` pairs do not run at the same moment on four physical cores.
    if ($SkipBuild -and -not (Test-Path (Join-Path $Root 'dist'))) {
      Write-Host "WARNING: -SkipBuild was given but $Root has no dist/; building after all" -ForegroundColor Yellow
      $SkipBuild = $false
    }

    # The production server serves `dist/`, so the build has to exist and has to match the source under
    # test. `tsc --noEmit` first because that is what `npm run build` does, and a mutant that does not
    # compile must fail loudly here rather than be served a stale bundle.
    if (-not $SkipBuild) {
      if (Test-Path $Tsc) {
        & $Tsc --noEmit
        if ($LASTEXITCODE -ne 0) {
          Write-Host 'WARNING: typecheck failed; skipping the shared production server' -ForegroundColor Yellow
          return
        }
      }
      $null = & (Join-Path $Root 'node_modules\.bin\vite.cmd') build
      if ($LASTEXITCODE -ne 0) {
        Write-Host 'WARNING: the production build failed; skipping the shared production server' -ForegroundColor Yellow
        return
      }
    }

    # Named `$prodServer`/`$devServer` rather than `$prod`/`$dev`: this function has an `[int] $Dev`
    # parameter, PowerShell variable names are case-insensitive, and `$dev = Start-Process ...` therefore
    # assigned a `System.Diagnostics.Process` into a typed `[int]` and threw
    # "Cannot convert ... to type System.Int32" at the second Start-Process. Local names that differ from
    # a parameter only in case are a trap worth avoiding by construction.
    $prodServer = Start-Process -FilePath 'node.exe' `
      -ArgumentList $vite, 'preview', '--host', '127.0.0.1', '--port', "$Preview", '--strictPort' `
      -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput (Server-Log $Preview 'preview' 'out') `
      -RedirectStandardError  (Server-Log $Preview 'preview' 'err')
    $script:servers += , $prodServer
    if (-not (Wait-Ready $Preview 'production' $prodServer)) {
      Stop-Process -Id $prodServer.Id -Force -ErrorAction SilentlyContinue
      return
    }

    # The dev server only answers the proxied `/spike.html`; see `vite.config.ts` for the proxy. If it
    # will not start that costs the spike spec, not the mutants -- so this warns and carries on rather than
    # tearing down a working production server. The previous code called `Stop-DevServer` here, which would
    # have thrown away the good server over the optional one.
    $devServer = Start-Process -FilePath 'node.exe' `
      -ArgumentList $vite, '--host', '127.0.0.1', '--port', "$Dev", '--strictPort' `
      -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput (Server-Log $Preview 'dev' 'out') `
      -RedirectStandardError  (Server-Log $Preview 'dev' 'err')
    $script:servers += , $devServer
    if (-not (Wait-Ready $Dev 'dev' $devServer)) {
      Stop-Process -Id $devServer.Id -Force -ErrorAction SilentlyContinue
    }
  } finally {
    [System.Environment]::CurrentDirectory = $savedCwd
    Set-Location -LiteralPath $savedCwd
    $env:P1_PREVIEW_PORT = $savedPreview
    $env:P1_DEV_PORT     = $savedDev
  }
}

# Dispatch on the file kind. `tests/` holds two kinds of file and Vitest silently collects none of
# the `.spec.ts` ones, so a browser mutation run through Vitest reports "no tests found" -- which the
# failure check below reads as a pass. Two of the twenty mutations were undetected for exactly that
# reason before this was fixed.
function Is-Browser([string] $target) {
  return $target -like '*.spec.ts' -or $target -like '*tests/editor/persistence*'
}

function Invoke-Target([string] $target) {
  if (Is-Browser $target) {
    if ($NoBrowser) { return $null }
    # **Rebuild before every browser mutant.** This is not an optimisation, it is the whole mechanism.
    #
    # Since M15 the browser suite is served the production bundle, so `/` resolves to `dist/` and the dev
    # server only answers the proxied `/spike.html`. A mutation to `src/` therefore does nothing at all
    # unless `dist/` is rebuilt from the mutated source first -- and a bundle built once at the start of the
    # run means **no source mutation can ever reach a browser test**.
    #
    # It presents as every browser mutant being reported "NOT FOUND", which is the worst possible failure
    # mode for this tool: 20 survivors that all look like coverage gaps and are in fact a harness that
    # stopped testing anything. That is exactly what happened the first time this was run.
    #
    # The build is ~1s, against ~30-85s per browser mutant, so paying it every time is cheap.
    # `--mode=basic` would be wrong: the mutants are in source files, not CSS, so the CSS pipeline is
    # irrelevant, but the type check is deliberately *not* run -- a mutant that does not compile is still
    # a mutant, and the bundle should fail loudly in the browser rather than being silently skipped here.
    #
    # **`--max-failures=1` is free accuracy we were throwing away.** The only question this tool asks of a
    # suite is "did it fail?", and for a detected mutant that is settled by the first failing test.
    # Running the remaining tests cannot change the answer, and for a large target it is most of the
    # cost: measured on the M19 print suite, a mutant caught by its first test went from **70.3s to
    # 30.0s**. Detection is unaffected -- the check below is `$out -match '\d+ failed'`, and Playwright
    # still prints `1 failed` -- so this changes the wall clock and nothing else.
    $null = & $ViteBuild 'build'
    return (& $Playwright test $target --reporter=line --max-failures=1 2>&1 | Out-String)
  }
  return (& $Vitest run $target --reporter=basic 2>&1 | Out-String)
}

# One mutation: apply, run the target, restore, and record how long it took.
function Mutate([string] $label, [string] $path, [scriptblock] $apply, [string] $target) {
  # Normalised to LF for the substitution and restored afterwards. The tree has mixed line endings
  # (noted in the M6 notes), and a `(?m)$` anchor silently fails to match on a CRLF file -- which
  # presents as "mutation site not found" and reads like a broken script rather than a broken pattern.
  $raw = [System.IO.File]::ReadAllText($path)
  $original = $raw.Replace("`r`n", "`n")
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $mutated = & $apply $original
    if ($mutated -eq $original) { throw "mutation site not found: $label" }
    Save-BeforeMutation $path
    [System.IO.File]::WriteAllText($path, $mutated)
    $out = Invoke-Target $target
  } finally {
    [System.IO.File]::WriteAllText($path, $raw)
  }
  $watch.Stop()

  if ($null -eq $out) {
    # Skipped by -NoBrowser. Recorded rather than dropped, so the summary's denominator is honest.
    Write-Host "skipped    $label (browser target, -NoBrowser)" -ForegroundColor DarkGray
    return $null
  }

  $out | Set-Content -Path $log -Encoding utf8
  $failed = $out -match '\d+ failed'
  $detail = if ($out -match '(\d+) failing|(\d+) failed') { "$($Matches[1])$($Matches[2]) failing" } else { 'no failure reported' }
  $script:timings += [pscustomobject]@{
    label = $label; target = $target; seconds = $watch.Elapsed.TotalSeconds; detected = $failed
  }
  if ($failed) {
    Write-Host ("detected   {0} [{1:N1}s] ({2})" -f $label, $watch.Elapsed.TotalSeconds, $detail) -ForegroundColor Green
    return $true
  }
  Write-Host ("NOT FOUND  {0} [{1:N1}s] -- {2} did not fail" -f $label, $watch.Elapsed.TotalSeconds, $target) -ForegroundColor Red
  return $false
}

. (Join-Path $PSScriptRoot 'mutations.ps1')

$mutations = @($script:corpus)
# `@(...)` around the whole thing, not just the `else` branch.
#
# PowerShell unrolls a **single**-element array when it leaves an `if` used as an expression, so
# `$selected` was a bare `PSCustomObject` rather than an array -- and `.Count` on one is `$null` under
# Windows PowerShell 5.1. Every guard below then compared against `$null` and quietly did nothing:
# `$skippedBrowser -eq $selected.Count` evaluated as `1 -eq $null`, which is false. The symptom was
# `-NoBrowser -Filter <a browser entry>` printing "ran 0 of  selected" and then **exiting 0** behind a
# green "every mutation was detected (0 of 0)".
#
# So the guards were present, readable, and inert. That is the fourth time this project has met a check
# that could not fail being mistaken for a check that passed -- and the reason every guard here is now
# exercised by a deliberate negative control instead of trusted.
$selected = @(if ($Filter -eq '') { $mutations } else { $mutations | Where-Object { $_.label -match $Filter } })

# `-CheckSites` applies every substitution and runs no tests.
#
# It exists because of how the corpus was rebuilt (see `mutations.ps1`). A substitution whose
# pattern no longer matches throws "site not found" -- which is the correct behaviour, but it
# *aborts the run*, so one stale site hides the state of every mutation after it. Two full runs
# (about 30 min each) were spent that way. This mode finds every stale site in seconds, which is
# also why it is worth having when the corpus is healthy: a site can rot when production code is
# edited, and the discovery cost should not be a half-hour run.
#
# It reports only that a substitution applies. It says nothing about whether the mutant is
# *killed* -- only a real run can know that -- so it is a preflight, never a substitute.
if ($CheckSites) {
  $bad = 0
  foreach ($m in $selected) {
    try {
      $original = [System.IO.File]::ReadAllText($m.path).Replace("`r`n", "`n")
      $mutated = & $m.apply $original
      if ($mutated -eq $original) { throw 'substitution is a no-op' }
      Write-Host ("  ok        {0}" -f $m.label) -ForegroundColor DarkGray
    } catch {
      $bad += 1
      Write-Host ("  STALE     {0}`n            {1}" -f $m.label, $_.Exception.Message) -ForegroundColor Red
    }
  }
  Write-Host ''
  if ($bad -gt 0) {
    Write-Host ("{0} of {1} substitutions do not apply. No tests were run." -f $bad, $selected.Count) -ForegroundColor Red
    exit 1
  }
  Write-Host ("all {0} substitutions apply (sites only; nothing was run against a test)" -f $selected.Count) -ForegroundColor Green
  exit 0
}

if ($List) {
  foreach ($m in $mutations) {
    Write-Host ("  [{0}] {1}`n        -> {2}" -f $(if (Is-Browser $m.target) { 'browser' } else { 'unit   ' }), $m.label, $m.target)
  }
  Write-Host ''
  Write-Host ("{0} mutations ({1} browser, {2} unit). Use -Filter '<regex>' on the label." -f `
    $mutations.Count,
    (@($mutations | Where-Object { Is-Browser $_.target }).Count),
    (@($mutations | Where-Object { -not (Is-Browser $_.target) }).Count))
  exit 0
}

# The guard that keeps a narrow run honest. Without it, `-Filter 'typo'` runs nothing and reports
# "every mutation was detected (0 of 0)", which reads exactly like a clean pass. This is the same
# class of trap as the "site not found" rule one level down.
if ($selected.Count -eq 0) {
  Write-Host "no mutation matches -Filter '$Filter'." -ForegroundColor Red
  Write-Host 'Use -List to see the labels.' -ForegroundColor Red
  exit 1
}

$skippedBrowser = @($selected | Where-Object { $NoBrowser -and (Is-Browser $_.target) }).Count
if ($skippedBrowser -gt 0 -and $skippedBrowser -eq $selected.Count) {
  Write-Host 'every selected mutation has a browser target, and -NoBrowser was given.' -ForegroundColor Red
  exit 1
}

# --- parallel workers (M19) -------------------------------------------------------------
#
# ## Why this exists at all
#
# Measured on this corpus: 36 browser mutants and 76 unit, ~34 minutes total, of which the browser
# mutants are ~85%. Each browser mutant is one Playwright spec run and they were strictly sequential.
#
# Two independent levers, in descending order of what they bought:
#
#  1. `--max-failures=1` above. Same semantics, ~2.3x on a browser mutant.
#  2. This pool. The mutants are independent, so they can simply run at the same time.
#
# ## This is NOT the parallelism that was measured and rejected
#
# `playwright.config.ts` records `workers: 1` with the measurement behind it: `workers: 4` *within* one
# suite gave 62.5s against 58.0s serial, because the workers share one CPU pool, one server and one
# per-test browser setup. That experiment is still true and still recorded there.
#
# The difference is scope. Those workers split the *tests of one mutant*; these split the *mutants*, and
# each gets its own workspace, its own bundle, its own server and its own ports, so nothing is shared
# except the CPU. That is the contention the earlier experiment lost to.
#
# ## Why each worker needs a whole copy of the tree
#
# A mutation is a file edit. Two workers sharing `src/` would have one restoring a file while the other
# mutates it -- which does not fail loudly, it just produces wrong verdicts. `node_modules` is the only
# thing worth sharing, and it is joined rather than copied (see `New-WorkerWorkspace`).
#
# ## Cost-balanced partitioning
#
# Naive round-robin over a corpus that is 1/3 browser is badly unbalanced, because the browser mutants
# cost ~10x a unit one: a worker handed four of them decides the wall clock for everyone. So the slice
# is built longest-processing-time-first, from a measured cost estimate. This is not micro-optimisation;
# it is the difference between 4 workers and 2 in practice.
$script:WorkerRoot = Join-Path $env:TEMP 'p1-mutation-workers'

# Measured means from the M19 run, used only to balance the split.
$script:CostBrowser = 45
$script:CostUnit    = 4

function New-WorkerWorkspace([int] $index, [string] $root) {
  $repo = Split-Path $PSScriptRoot -Parent
  $dir = Join-Path $root ("w{0}" -f $index)
  if (Test-Path $dir) { Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue }
  $null = New-Item -ItemType Directory -Path $dir -Force

  # Everything a worker needs to build and test, and nothing else. In particular *not* `dist/` (each
  # worker builds its own, from its own mutated source) and *not* `.git`.
  foreach ($item in @('src', 'tests', 'scripts')) {
    Copy-Item -LiteralPath (Join-Path $repo $item) -Destination (Join-Path $dir $item) -Recurse -Force
  }
  foreach ($file in @('index.html', 'spike.html', 'vite.config.ts', 'playwright.config.ts', 'tsconfig.json', 'package.json')) {
    Copy-Item -LiteralPath (Join-Path $repo $file) -Destination (Join-Path $dir $file) -Force
  }

  # A junction, not a copy: `node_modules` is ~200MB and every worker resolves the *same* installed
  # packages. On Windows a junction is the only cheap way to share it, and it behaves like a real
  # directory to Node, Vite and Vitest -- which is what matters, because each worker still gets its own
  # `dist/` and its own mutated source.
  $modules = Join-Path $dir 'node_modules'
  if (-not (Test-Path $modules)) {
    $null = New-Item -ItemType Junction -Path $modules -Target (Join-Path $repo 'node_modules')
  }
  return $dir
}

# Longest-processing-time-first: sort by cost descending, then give each mutant to whichever worker is
# currently the least loaded. Deterministic, and it does not depend on iteration order.
function Split-By-Cost($items, [int] $count) {
  $load = @(0) * $count
  $slices = @()
  0..($count - 1) | ForEach-Object { $slices += , @() }
  $index = 0
  foreach ($item in $items) {
    $c = if (Is-Browser $item.target) { $script:CostBrowser } else { $script:CostUnit }
    # Lowest load; ties break to the lowest index so the split is reproducible run to run.
    $pick = 0
    for ($w = 1; $w -lt $count; $w++) { if ($load[$w] -lt $load[$pick]) { $pick = $w } }
    $slices[$pick] += , $item
    $load[$pick] += $c
    $index += 1
  }
  return $slices
}

# --- worker child process -----------------------------------------------------------------
#
# Runs one slice of the corpus inside its own workspace copy and reports back as JSON lines.
#
# This is the *same script*, not a second implementation: everything below reuses the functions above, so
# there is exactly one definition of "apply, run, restore" and a fix to it cannot land in one path and
# miss the other. The only differences are which slice is taken and where results are written.
#
# The slice arrives as an explicit list of *indices* rather than a computed stride. The parent already
# balanced the split by cost, and recomputing it here would mean two places that have to agree about the
# cost model -- and if they disagreed, the mutants would silently be run twice or not at all.
if ($WorkerIndex -ge 0) {
  $indices = @($WorkerIndices | ForEach-Object { [int] $_ })
  $mine = @($indices | ForEach-Object { $selected[$_] })

  # **No server is started from in here.** The parent brought this workspace's servers up before launching
  # any worker, because `Start-Process` inside a `Start-Job` yields a process that is alive, silent and never
  # listening -- see `Start-DevServer` for the measurement.
  #
  # Asserted rather than assumed, and that distinction matters: a worker with no server does not produce a
  # wrong verdict, it produces a *correct* one ~150s per mutant later, because Playwright quietly starts its
  # own. So the only symptom of getting this wrong is a mysteriously slow run -- exactly the kind of thing
  # that gets misread as "parallelism doesn't scale here".
  if ((-not $NoBrowser) -and (@($mine | Where-Object { Is-Browser $_.target }).Count -gt 0)) {
    $served = $false
    try { $null = Invoke-WebRequest -Uri "http://127.0.0.1:$PreviewPort" -TimeoutSec 5 -UseBasicParsing; $served = $true } catch { }
    if (-not $served) {
      throw "worker $WorkerIndex has browser mutants but nothing is serving port $PreviewPort; the parent must start it"
    }
  }

  $records = @()
  try {
    foreach ($m in $mine) {
      $entry = [ordered]@{ label = $m.label; target = $m.target; detected = $null; skipped = $false; message = '' }
      try {
        $detected = Mutate $m.label $m.path $m.apply $m.target
        $entry['detected'] = $detected
      } catch {
        $entry['message'] = $_.Exception.Message
      }
      $records += , ([pscustomobject]$entry)
      # Written incrementally: a worker killed half-way still leaves a usable partial result rather
      # than nothing, which is the difference between resuming and restarting.
      $records | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ResultsFile -Encoding utf8
    }
  } finally {
    # Nothing to stop: the servers belong to the parent, which tears them down after `Wait-Job`.
    Stop-DevServer
  }
  exit 0
}

# --- parent: run the pool ---------------------------------------------------------------
if ($Workers -gt 1) {
  Write-Host ("running {0} mutants across {1} workers (ports {2}..{3})" -f `
    $selected.Count, $Workers, $PortBase, ($PortBase + (2 * ($Workers - 1)) + 1))

  $slices = Split-By-Cost $selected $Workers
  if (Test-Path $script:WorkerRoot) { Remove-Item $script:WorkerRoot -Recurse -Force -ErrorAction SilentlyContinue }
  $null = New-Item -ItemType Directory -Path $script:WorkerRoot -Force

  $jobs = @()
  $poolWatch = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    for ($w = 0; $w -lt $Workers; $w++) {
      $indices = @(for ($k = 0; $k -lt $slices[$w].Count; $k++) { [array]::IndexOf($selected, $slices[$w][$k]) })
      if ($indices.Count -eq 0) { continue }
      $space = New-WorkerWorkspace $w $script:WorkerRoot
      $hasBrowser = (@($slices[$w] | Where-Object { Is-Browser $_.target }).Count -gt 0)

      # **Build and serve this workspace from here, in the parent, before any worker starts.** Both halves of
      # that sentence are load-bearing.
      #
      # Sequentially, because four simultaneous `tsc --noEmit` + `vite build` pairs on four physical cores
      # oversubscribe the machine -- and only for workspaces that actually have a browser mutant, since a
      # worker holding only Vitest mutants never serves `dist/` and its build would buy nothing.
      #
      # From the parent, because a `Start-Process` inside a `Start-Job` produces a server that is alive,
      # silent and never binds its port. That is not a performance note: it is the entire reason this pool
      # once looked like a 22x pessimisation, and it cost a committed "measured and rejected" note that was
      # really a measurement of a broken harness.
      if ($hasBrowser -and -not $NoBrowser) {
        # Same stride the worker computes for itself, so the two cannot disagree about which port this
        # workspace owns. Asserted by the worker's own probe before it runs a browser mutant.
        $spacePreviewPort = $PortBase + (2 * $w)
        if (-not (Build-Workspace $space)) {
          Write-Host "WARNING: workspace $space failed to build; its browser mutants will start their own server" -ForegroundColor Yellow
        } else {
          Start-DevServer -Root $space -Preview $spacePreviewPort -Dev ($spacePreviewPort + 1) -SkipBuild
        }
      }
      $results = Join-Path $script:WorkerRoot ("w{0}.json" -f $w)
      $script = Join-Path $space 'scripts\mutation-check.ps1'
      Write-Host ("  worker {0}: {1} mutants ({2} browser)" -f $w, $indices.Count, `
        (@($slices[$w] | Where-Object { Is-Browser $_.target }).Count))

      $jobs += Start-Job -Name "w$w" -ArgumentList $script, $space, $w, $indices, $results, $Filter, $NoBrowser.IsPresent -ScriptBlock {
        param($entryScript, $space, $index, $list, $out, $filter, $noBrowser)
        # **`Set-Location` is not enough, and the reason is worth writing down.**
        #
        # `Set-Location` / `Push-Location` change PowerShell's *provider* location. They do **not** change
        # `[Environment]::CurrentDirectory`, which is what a child process actually inherits. So `& vitest`
        # launched from a "changed" location still ran with the parent's working directory -- which here is
        # the real repository. A worker therefore mutated its own copy, ran the suite against the
        # *unmutated* real tree, and reported every mutant undetected.
        #
        # That is the worst possible failure mode for this tool and it is completely silent: 100%
        # survivors, no error, a clean-looking report. It was caught because the numbers were
        # *implausible* rather than wrong -- five mutants known to be detected came back NOT FOUND --
        # and then confirmed directly by putting a **syntax error** in a worker copy and watching the
        # suite pass anyway.
        #
        # Both are set, and the assignment is verified rather than assumed: a worker that cannot enter its
        # own workspace must fail loudly, because the alternative is a run that lies.
        Set-Location -LiteralPath $space
        [System.Environment]::CurrentDirectory = $space
        if ([System.Environment]::CurrentDirectory -ne $space) {
          throw "worker could not enter its workspace (wanted '$space', process CWD is '$([System.Environment]::CurrentDirectory)')"
        }
        $jobs = @()
        foreach ($i in $list) { $jobs += "$i" }
        & $entryScript -WorkerIndex $index -ResultsFile $out -WorkerIndices $jobs -Filter $filter -NoBrowser:$noBrowser
      }
    }

    Wait-Job -Job $jobs | Out-Null
    $poolWatch.Stop()

    # Aggregate in *corpus order*, not completion order, so two runs of the same corpus print the same
    # report and a diff between them is readable.
    $byLabel = @{}
    $jobErrors = @()
    for ($w = 0; $w -lt $Workers; $w++) {
      $job = $jobs | Where-Object { $_.Name -eq "w$w" }
      if ($null -ne $job) { Receive-Job -Job $job -ErrorAction SilentlyContinue | Out-Null }
    }
    foreach ($file in (Get-ChildItem $script:WorkerRoot -Filter '*.json' -ErrorAction SilentlyContinue)) {
      foreach ($rec in (Get-Content $file.FullName -Raw | ConvertFrom-Json)) {
        $byLabel[$rec.label] = $rec
      }
    }

    $results = @()
    $errors = @()
    foreach ($m in $selected) {
      $rec = $byLabel[$m.label]
      if ($null -eq $rec) { $errors += [pscustomobject]@{ label = $m.label; message = 'a worker produced no result for this mutation' }; continue }
      if ($rec.message -ne '') { $errors += [pscustomobject]@{ label = $m.label; message = $rec.message }; continue }
      if ($null -eq $rec.detected) { $results += , $null; continue }
      $results += , ([bool]$rec.detected)
      Write-Host ("{0} {1}" -f $(if ($rec.detected) { 'detected  ' } else { 'NOT FOUND ' }), $m.label)
    }
  } finally {
    # The workspace servers are the parent's, so the parent stops them. Before this they leaked: nothing
    # owned them, so every pool run left live `vite preview` processes holding the worker ports, and the
    # *next* run's `--strictPort` servers then failed to bind for a reason that had nothing to do with the
    # code under test.
    Stop-DevServer
    foreach ($job in $jobs) { Remove-Job -Job $job -Force -ErrorAction SilentlyContinue }
    Remove-Item $script:WorkerRoot -Recurse -Force -ErrorAction SilentlyContinue
  }

  $ran = @($results | Where-Object { $null -ne $_ })
  $survived = @($ran | Where-Object { -not $_ })
  Write-Host ''
  Write-Host ("ran {0} of {1} selected across {2} workers in {3:N1}s ({4:N1} min)" -f `
    $ran.Count, $selected.Count, $Workers, $poolWatch.Elapsed.TotalSeconds, $poolWatch.Elapsed.TotalMinutes)
  if ($errors.Count -gt 0) {
    Write-Host ''
    Write-Host ("{0} MUTATION(S) COULD NOT BE RUN" -f $errors.Count) -ForegroundColor Red
    $errors | ForEach-Object { Write-Host ("  {0}`n    {1}" -f $_.label, $_.message) -ForegroundColor Red }
    exit 1
  }
  if ($ran.Count -lt $selected.Count) { Write-Host ''; Write-Host 'not every selected mutation reported a result' -ForegroundColor Red; exit 1 }
  if ($survived.Count -gt 0) { Write-Host ("SOME MUTATIONS WENT UNDETECTED ({0} of {1})" -f $survived.Count, $ran.Count) -ForegroundColor Red; exit 1 }
  Write-Host ("every mutation was detected ({0} of {0})" -f $ran.Count) -ForegroundColor Green
  exit 0
}

if (-not $NoBrowser -and @($selected | Where-Object { Is-Browser $_.target }).Count -gt 0) {
  Start-DevServer -Root (Split-Path $PSScriptRoot -Parent) -Preview $PreviewPort -Dev $DevPort
}

$total = [System.Diagnostics.Stopwatch]::StartNew()
$results = @()
$errors = @()
try {
  foreach ($m in $selected) {
    # Every mutation is wrapped, so a *thrown* mutation is reported as a failure rather than
    # vanishing.
    #
    # This hole was found the hard way: `Save-BeforeMutation` threw on every call, the `throw`
    # propagated out of `Mutate`, `$results` stayed empty, and the summary cheerfully printed
    # "every mutation was detected (0 of 0)" and **exited 0**. A run in which nothing executed is
    # exactly the result the `-Filter` zero-guard exists to prevent, arriving by a different road --
    # and `site not found` aborting the whole run was the older version of the same mistake.
    #
    # So: catch, record, and let the final count do the talking. A mutation that cannot be applied
    # has not been verified, and "not verified" must never read as "verified".
    try {
      $results += , (Mutate $m.label $m.path $m.apply $m.target)
    } catch {
      $errors += [pscustomobject]@{ label = $m.label; message = $_.Exception.Message }
      Write-Host ("ERROR      {0}`n           {1}" -f $m.label, $_.Exception.Message) -ForegroundColor Red
      # The file was restored by `Mutate`'s own `finally`; the backup is left behind deliberately so
      # the next start re-checks the tree rather than trusting it.
    }
  }
} finally {
  Stop-DevServer
  Remove-Item $BackupDir -Recurse -Force -ErrorAction SilentlyContinue
  $total.Stop()
}

# --- summary -----------------------------------------------------------------
# Same semantics as before: a skipped mutant is neither a detection nor a miss, and the denominator
# is the number that actually ran.
$ran      = @($results | Where-Object { $null -ne $_ })
$survived = @($ran | Where-Object { -not $_ })

Write-Host ''
Write-Host '--- slowest mutants -----------------------------------------------'
$script:timings | Sort-Object seconds -Descending | Select-Object -First 5 |
  ForEach-Object { Write-Host ("  {0,7:N1}s  {1}" -f $_.seconds, $_.label) }
Write-Host ''
Write-Host ("ran {0} of {1} selected ({2} skipped by -NoBrowser) in {3:N1}s ({4:N1} min)" -f `
  $ran.Count, $selected.Count, $skippedBrowser, $total.Elapsed.TotalSeconds, $total.Elapsed.TotalMinutes)

if ($errors.Count -gt 0) {
  Write-Host ''
  Write-Host ("{0} MUTATION(S) COULD NOT BE RUN" -f $errors.Count) -ForegroundColor Red
  $errors | ForEach-Object { Write-Host ("  {0}`n    {1}" -f $_.label, $_.message) -ForegroundColor Red }
  Write-Host 'These are not passes. A mutation that could not be applied has not been verified.' -ForegroundColor Red
  exit 1
}
if ($ran.Count -lt $selected.Count) {
  Write-Host ''
  Write-Host ("only {0} of {1} selected mutations reported a result" -f $ran.Count, $selected.Count) -ForegroundColor Red
  exit 1
}
if ($survived.Count -gt 0) {
  Write-Host ("SOME MUTATIONS WENT UNDETECTED ({0} of {1})" -f $survived.Count, $ran.Count) -ForegroundColor Red
  exit 1
}
Write-Host ("every mutation was detected ({0} of {0})" -f $ran.Count) -ForegroundColor Green
