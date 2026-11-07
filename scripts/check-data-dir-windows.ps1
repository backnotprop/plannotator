# Runs the data-dir resolution blocks of install.ps1 and install.cmd (between
# their "BEGIN/END data-dir resolution" markers) against temp folders, on real
# PowerShell and real cmd.exe, and fails when either picks the wrong folder
# (#2305). The runtime rule is packages/shared/data-dir.ts; the bun test
# tests/data-dir-mirrors.test.ts covers install.sh, the mod and the Amp plugin.
#
# PLANNOTATOR_DATA_DIR is removed for every case: set, it skips the branch
# under test. Only temp folders are touched. Run by windows.yml's
# install-ps1-windows job; `pwsh -File scripts/check-data-dir-windows.ps1`.
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

function Get-Block([string]$path, [string]$begin, [string]$end) {
    $text = Get-Content -Raw -LiteralPath $path
    $start = $text.IndexOf($begin)
    $stop = $text.IndexOf($end)
    if ($start -lt 0 -or $stop -le $start) { throw "$path lost its data-dir resolution markers" }
    $start = $text.IndexOf("`n", $start) + 1
    return $text.Substring($start, $stop - $start)
}

$ps1Block = Get-Block (Join-Path $repo "scripts\install.ps1") "# BEGIN data-dir resolution" "# END data-dir resolution"
$cmdBlock = Get-Block (Join-Path $repo "scripts\install.cmd") "REM BEGIN data-dir resolution" "REM END data-dir resolution"

$root = Join-Path ([System.IO.Path]::GetTempPath()) ("pn-data-dir-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $root | Out-Null

# A drive letter nothing is mounted on, for the "XDG_DATA_HOME on a missing drive" case.
$used = @(Get-PSDrive -PSProvider FileSystem | ForEach-Object { $_.Name.ToUpper() })
$freeLetter = @("Q", "R", "S", "T", "U", "V", "W", "X", "Y") | Where-Object { $used -notcontains $_ } | Select-Object -First 1

$ps1File = Join-Path $root "resolve.ps1"
Set-Content -LiteralPath $ps1File -Encoding UTF8 -Value ("`$ErrorActionPreference = 'Stop'`r`n" + $ps1Block + "`r`nWrite-Output `$configDir`r`n")
$cmdFile = Join-Path $root "resolve.cmd"
$cmdText = "@echo off`r`nsetlocal EnableDelayedExpansion`r`n" + ($cmdBlock -replace "(?<!`r)`n", "`r`n") + "`r`necho !_CONFIG_DIR!`r`n"
[System.IO.File]::WriteAllText($cmdFile, $cmdText, [System.Text.Encoding]::ASCII)

function New-Layout([string]$dir, [string[]]$entries) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    foreach ($entry in $entries) {
        $path = Join-Path $dir $entry
        if ($entry -match '\.(json|txt|html)$') {
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
            Set-Content -LiteralPath $path -Value "{}"
        } else {
            New-Item -ItemType Directory -Force -Path $path | Out-Null
        }
    }
}

$stray = @("hooks\compound\enterplanmode-improve-hook.txt", "plans\compound-planning-report.html", "config.json")
$cases = @(
    @{ name = "home-only"; legacy = @("history"); xdg = $null; want = "legacy" },
    @{ name = "XDG-only"; legacy = $null; xdg = @("history", "sessions"); want = "xdg" },
    @{ name = "XDG-only, XDG_DATA_HOME padded with spaces"; legacy = $null; xdg = @("history"); pad = $true; want = "xdg" },
    @{ name = "stray ~/.plannotator, XDG folder with data"; legacy = $stray; xdg = @("sessions"); want = "xdg" },
    @{ name = "empty ~/.plannotator, XDG folder with data"; legacy = @(); xdg = @("history"); want = "xdg" },
    @{ name = "both hold data"; legacy = @("install-flags.json"); xdg = @("history"); want = "legacy" },
    @{ name = "~/.plannotator, XDG folder without data"; legacy = @(); xdg = @("hooks"); want = "legacy" },
    @{ name = "~/.plannotator, XDG folder missing"; legacy = @("history"); xdg = $null; want = "legacy" }
)
if ($freeLetter) {
    $cases += @{ name = "~/.plannotator, XDG_DATA_HOME on an unmounted drive"; legacy = @("history"); xdgHome = "${freeLetter}:\no-such-xdg"; want = "legacy" }
}

$saved = @{ USERPROFILE = $env:USERPROFILE; XDG_DATA_HOME = $env:XDG_DATA_HOME; PLANNOTATOR_DATA_DIR = $env:PLANNOTATOR_DATA_DIR }
$failures = @()
$i = 0
try {
    foreach ($case in $cases) {
        $i++
        $home_ = Join-Path $root "h$i\home"
        $xdgHome = if ($case.xdgHome) { $case.xdgHome } else { Join-Path $root "h$i\xdg" }
        New-Item -ItemType Directory -Force -Path $home_ | Out-Null
        if ($null -ne $case.legacy) { New-Layout (Join-Path $home_ ".plannotator") $case.legacy }
        if ($null -ne $case.xdg) { New-Layout (Join-Path $xdgHome "plannotator") $case.xdg }
        $want = if ($case.want -eq "legacy") { Join-Path $home_ ".plannotator" } else { [System.IO.Path]::Combine($xdgHome, "plannotator") }

        $env:USERPROFILE = $home_
        $env:XDG_DATA_HOME = if ($case.pad) { "  $xdgHome  " } else { $xdgHome }
        Remove-Item Env:PLANNOTATOR_DATA_DIR -ErrorAction SilentlyContinue

        $ps1Out = (& pwsh -NoProfile -NonInteractive -File $ps1File 2>&1 | Out-String).Trim()
        $cmdOut = (& cmd.exe /d /c $cmdFile 2>&1 | Out-String).Trim()
        foreach ($pair in @(@("install.ps1", $ps1Out), @("install.cmd", $cmdOut))) {
            if ($pair[1] -ne $want) {
                $failures += "$($pair[0]) [$($case.name)]: expected $want, got: $($pair[1])"
            } else {
                Write-Host "ok $($pair[0]) [$($case.name)] -> $($pair[1])"
            }
        }
    }
} finally {
    foreach ($key in $saved.Keys) {
        if ($null -eq $saved[$key]) { Remove-Item "Env:$key" -ErrorAction SilentlyContinue }
        else { Set-Item "Env:$key" $saved[$key] }
    }
    Remove-Item -Recurse -Force -LiteralPath $root -ErrorAction SilentlyContinue
}

if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Host "FAIL $_" }
    throw "$($failures.Count) data-dir resolution check(s) failed"
}
Write-Host "All data-dir resolution checks passed ($($cases.Count) cases, install.ps1 and install.cmd)."
