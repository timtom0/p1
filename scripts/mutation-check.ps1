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
#   5. **`--max-failures=1` on browser targets (M19). 34.3 min to 15.4 min.** The only question asked of a
#      suite is "did it fail?", and for a detected mutant that is settled by the first failing test; the rest
#      cannot change the answer. Measured on the print suite: 70.3s down to 30.0s for one mutant, and over
#      the full corpus the browser mutants went from the ~30-85s quoted above to 3-16s each. Detection is
#      unaffected -- the check is `$out -match '\d+ failed'` and Playwright still prints `1 failed`.
#
#   4. **One dev server for the whole run (~3.4s per browser mutant, ~1 min over a full run).**
#      `playwright.config.ts` already sets `reuseExistingServer: !CI`, but nothing ever left a server
#      running, so every browser mutant spawned `vite` and waited for the readiness probe. This
#      script starts one, keeps it for every mutant, and stops it in a `finally`.
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
#   * **Parallelism across *mutants*, likewise: measured, implemented, and left off by default.** The
#     rejection above is about splitting the tests of one mutant. This was splitting the mutants, each
#     with its own workspace copy, its own bundle, its own server and its own ports, so nothing was
#     shared but the CPU -- which is exactly the contention the earlier experiment lost to. It works, and
#     on this machine it is much worse than useless:
#
#     | slice                                        | serial | 4 workers |
#     |----------------------------------------------|--------|-----------|
#     | 5 print-profile browser mutants              |  48.1s |  1079.1s  |
#     | 17 Vitest mutants                            |  77.2s |  1015.5s  |
#
#     22x and 13x slower. Two reasons, both measured rather than guessed. The per-mutant work is small
#     enough that the pool's fixed cost dominates: each worker copies the tree, starts a PowerShell
#     process, and (until this was fixed) ran `tsc --noEmit` + `vite build` whether or not it had a
#     browser mutant to serve. And four concurrent Chromium instances on four physical cores contend for
#     the thing the browser mutants actually need.
#
#     So `-Workers` defaults to **1**, the pool is kept because it is correct and would pay on a larger
#     machine, and the honest summary is that `--max-failures=1` above is the *entire* win: **34.3 min
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
$script:devServer  = $null
$script:prodServer = $null
$script:corpus     = @()

function Add-Mutation([string] $label, [string] $path, [scriptblock] $apply, [string] $target) {
  $script:corpus += [pscustomobject]@{ label = $label; path = $path; apply = $apply; target = $target }
}

function Stop-DevServer {
  if ($null -ne $script:devServer) {
    Stop-Process -Id $script:devServer.Id -Force -ErrorAction SilentlyContinue
    $script:devServer = $null
  }
  if ($null -ne $script:prodServer) {
    Stop-Process -Id $script:prodServer.Id -Force -ErrorAction SilentlyContinue
    $script:prodServer = $null
  }
}

function Wait-Ready([int] $port, [string] $what) {
  # Wait for readiness rather than sleeping a fixed interval: a fixed sleep is either wasted time or
  # a flaky start, and this is the one place a race would show as a mysterious "no tests found".
  #
  # The budget widens for a worker. `Start-DevServer` runs `tsc --noEmit` and a full `vite build` before
  # it starts a server, and with four workers doing that at once on four physical cores the build is
  # several times slower than it is alone -- long enough that the old 30s budget expired, the worker gave
  # up, and Playwright then spawned its own server *per browser mutant*. That is the expensive path this
  # whole function exists to avoid, and the warning it printed was the only symptom.
  #
  # The failure remains graceful (the mutant is still measured, just slower), which is why this is a
  # budget change rather than a correctness fix.
  $tries = if ($WorkerIndex -ge 0) { 360 } else { 60 }
  for ($i = 0; $i -lt $tries; $i++) {
    Start-Sleep -Milliseconds 500
    try { $null = Invoke-WebRequest -Uri "http://127.0.0.1:$port" -TimeoutSec 2 -UseBasicParsing; return $true } catch { }
  }
  Write-Host "WARNING: the shared $what server on $port did not become ready; browser mutants will start their own" -ForegroundColor Yellow
  return $false
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
function Start-DevServer([switch] $SkipBuild) {
  # Two servers for the whole run, mirroring `playwright.config.ts`. `reuseExistingServer` means Playwright
  # uses these rather than spawning its own per mutant; starting them explicitly is what turns ~20 spawns
  # into 2.
  if (-not (Test-Path $Vite)) { return }

  # `-SkipBuild` is for a worker whose workspace the parent has **already built**, sequentially, before any
  # worker started. That ordering is the whole point: four workers each running `tsc --noEmit` and a full
  # `vite build` at the same moment, on four physical cores, saturated the machine badly enough that the
  # servers were still not up when the readiness budget expired -- and the fallback is Playwright spawning
  # its own server per browser mutant, which is the single most expensive thing this runner avoids.
  # Measured: five print mutants took 17.7 min through the pool that way, against ~30s each serially.
  if ($SkipBuild) {
    if (-not (Test-Path (Join-Path (Split-Path $PSScriptRoot -Parent) 'dist'))) {
      Write-Host 'WARNING: -SkipBuild was given but dist/ does not exist; building after all' -ForegroundColor Yellow
      $SkipBuild = $false
    }
  }

  # The production server serves `dist/`, so the build has to exist and has to match the source under
  # test. `tsc --noEmit` first because that is what `npm run build` does, and a mutant that does not
  # compile must fail loudly here rather than be served a stale bundle.
  if (-not $SkipBuild -and (Test-Path $Tsc)) {
    & $Tsc --noEmit
    if ($LASTEXITCODE -ne 0) {
      Write-Host 'WARNING: typecheck failed; skipping the shared production server' -ForegroundColor Yellow
      return
    }
  }
  if (-not $SkipBuild) {
    $null = & $ViteBuild 'build'
    if ($LASTEXITCODE -ne 0) {
      Write-Host 'WARNING: the production build failed; skipping the shared production server' -ForegroundColor Yellow
      return
    }
  }

  $script:prodServer = Start-Process -FilePath 'node.exe' `
    -ArgumentList $Vite, 'preview', '--host', '127.0.0.1', '--port', "$PreviewPort", '--strictPort' `
    -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $env:TEMP 'p1-mutation-preview.log') `
    -RedirectStandardError  (Join-Path $env:TEMP 'p1-mutation-preview.err')
  if (-not (Wait-Ready $PreviewPort 'production')) {
    Stop-Process -Id $script:prodServer.Id -Force -ErrorAction SilentlyContinue
    $script:prodServer = $null
    return
  }

  $script:devServer = Start-Process -FilePath 'node.exe' `
    -ArgumentList $Vite, '--host', '127.0.0.1', '--port', "$DevPort", '--strictPort' `
    -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $env:TEMP 'p1-mutation-vite.log') `
    -RedirectStandardError  (Join-Path $env:TEMP 'p1-mutation-vite.err')
  if (-not (Wait-Ready $DevPort 'dev')) {
    Stop-DevServer
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

  $needServers = (-not $NoBrowser) -and (@($mine | Where-Object { Is-Browser $_.target }).Count -gt 0)
  if ($needServers) { Start-DevServer -SkipBuild }

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

      # Build this workspace **now, sequentially**, and **only if this worker has a browser mutant to
      # run**. Building unconditionally was measured and it is pure waste: a worker holding only Vitest
      # mutants never serves `dist/`, so its `tsc --noEmit` + `vite build` -- roughly 11s, times
      # every worker -- buys nothing at all.
      if (@($slices[$w] | Where-Object { Is-Browser $_.target }).Count -gt 0) {
        if (-not (Build-Workspace $space)) {
          Write-Host 'WARNING: a workspace failed to build; its browser mutants will start their own server' -ForegroundColor Yellow
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

  Start-DevServer
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
