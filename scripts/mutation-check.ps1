#
param(
  [string] $Filter = '',
  [switch] $List,
  [switch] $NoBrowser,
  [switch] $CheckSites
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
$DevPort    = 5174

$script:timings   = @()
$script:devServer = $null
$script:corpus    = @()

function Add-Mutation([string] $label, [string] $path, [scriptblock] $apply, [string] $target) {
  $script:corpus += [pscustomobject]@{ label = $label; path = $path; apply = $apply; target = $target }
}

function Stop-DevServer {
  if ($null -ne $script:devServer) {
    Stop-Process -Id $script:devServer.Id -Force -ErrorAction SilentlyContinue
    $script:devServer = $null
  }
}

function Start-DevServer {
  # One server for the whole run. `reuseExistingServer` in playwright.config.ts means Playwright uses
  # this rather than spawning its own; starting it explicitly is what turns 20 spawns into 1.
  if (-not (Test-Path $Vite)) { return }
  $script:devServer = Start-Process -FilePath 'node.exe' `
    -ArgumentList $Vite, '--host', '127.0.0.1', '--port', "$DevPort", '--strictPort' `
    -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $env:TEMP 'p1-mutation-vite.log') `
    -RedirectStandardError  (Join-Path $env:TEMP 'p1-mutation-vite.err')
  # Wait for readiness rather than sleeping a fixed interval: a fixed sleep is either wasted time or
  # a flaky start, and this is the one place a race would show as a mysterious "no tests found".
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    try { $null = Invoke-WebRequest -Uri "http://127.0.0.1:$DevPort" -TimeoutSec 2 -UseBasicParsing; return } catch { }
  }
  Write-Host 'WARNING: the shared dev server did not become ready; browser mutants will start their own' -ForegroundColor Yellow
  Stop-DevServer
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
    return (& $Playwright test $target --reporter=line 2>&1 | Out-String)
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
