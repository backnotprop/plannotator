@echo off
setlocal enabledelayedexpansion

REM Plannotator Windows CMD Bootstrap Script

REM Parse command line arguments
set "VERSION=latest"
REM Tracks whether a version was explicitly set via --version or positional.
REM Used to reject mixing --version <tag> with a stray positional token.
set "VERSION_EXPLICIT=0"
REM Three-layer opt-in for SLSA provenance verification.
REM Precedence: CLI flag > env var > %USERPROFILE%\.plannotator\config.json > default.
REM -1 = flag not set (fall through); 0 = disable; 1 = enable.
set "VERIFY_ATTESTATION_FLAG=-1"
REM Opt-in install of the pruned CallDiff call-flow core (default off; the
REM review UI offers a one-click install). Precedence: --with-call-flow >
REM PLANNOTATOR_INSTALL_CALLDIFF > config installCallFlow > default (off).
REM -1 = flag not set (fall through); 1 = enable.
set "WITH_CALL_FLOW_FLAG=-1"
REM Guided-install answers. Precedence: CLI flags > wizard (interactive, first
REM run or --reconfigure) > saved prefs from a previous run > defaults.
set "EXTRAS_FLAG="
set "MODEL_INVOCABLE_FLAG="
set "NON_INTERACTIVE=0"
set "RECONFIGURE=0"
REM Binary-only mode. Installs just plannotator.exe and no persistent state
REM elsewhere. Set by --minimal (1) / --no-minimal (0); -1 = neither flag given
REM (fall through to the PLANNOTATOR_MINIMAL env var, resolved after :args_done).
set "MINIMAL_FLAG=-1"
REM Per-agent integration opt-outs (#1178). Skip means do-not-write: a skipped
REM agent's home is neither written to nor cleaned up, and detected-but-skipped
REM is reported honestly. Resolution (flag > env var > config skipInstall.<agent>
REM > default off) happens after _CONFIG_DIR is known.
set "SKIP_CODEX_FLAG=0"
set "SKIP_GEMINI_FLAG=0"
set "SKIP_KIRO_FLAG=0"
set "SKIP_VIBE_FLAG=0"
set "SKIP_OPENCODE_FLAG=0"
set "SKIP_QWEN_FLAG=0"
REM Same shape, but scoped to the skills/slash-command sparse checkout rather
REM than one agent's home: --skip-skills turns the whole fetch into a no-op for
REM every scope it writes (Claude, .agents, OpenCode, Gemini, Kiro), including
REM the extras and the skill-scope cleanup sweeps.
set "SKIP_SKILLS_FLAG=0"
REM Do not update an installed Claude Code plugin (see :UpdateClaudePlugin).
REM Same three layers; mirrors install.sh's --skip-claude-plugin.
set "SKIP_CLAUDE_PLUGIN_FLAG=0"

:parse_args
if "%~1"=="" goto args_done
if /i "%~1"=="--version" (
    if "%~2"=="" (
        echo --version requires an argument >&2
        exit /b 1
    )
    REM Reject dash-prefixed values - prevents `install.cmd --version
    REM --skip-attestation` from silently setting VERSION=--skip-attestation.
    set "NEXT_ARG=%~2"
    if "!NEXT_ARG:~0,1!"=="-" (
        echo --version requires a tag value, got flag: "%~2" >&2
        exit /b 1
    )
    set "VERSION=%~2"
    set "VERSION_EXPLICIT=1"
    shift
    shift
    goto parse_args
)
if /i "%~1"=="--verify-attestation" (
    if "!VERIFY_ATTESTATION_FLAG!"=="0" (
        echo --verify-attestation and --skip-attestation are mutually exclusive >&2
        exit /b 1
    )
    set "VERIFY_ATTESTATION_FLAG=1"
    shift
    goto parse_args
)
if /i "%~1"=="--skip-attestation" (
    if "!VERIFY_ATTESTATION_FLAG!"=="1" (
        echo --skip-attestation and --verify-attestation are mutually exclusive >&2
        exit /b 1
    )
    set "VERIFY_ATTESTATION_FLAG=0"
    shift
    goto parse_args
)
if /i "%~1"=="--with-call-flow" (
    set "WITH_CALL_FLOW_FLAG=1"
    shift
    goto parse_args
)
if /i "%~1"=="--extras" (
    set "EXTRAS_FLAG=yes"
    shift
    goto parse_args
)
if /i "%~1"=="--no-extras" (
    set "EXTRAS_FLAG=no"
    shift
    goto parse_args
)
if /i "%~1"=="--model-invocable" (
    if "%~2"=="" (
        echo --model-invocable requires a comma-separated skill list or 'none' >&2
        exit /b 1
    )
    set "MODEL_INVOCABLE_FLAG=%~2"
    shift
    shift
    goto parse_args
)
if /i "%~1"=="--non-interactive" (
    set "NON_INTERACTIVE=1"
    shift
    goto parse_args
)
if /i "%~1"=="--yes" (
    set "NON_INTERACTIVE=1"
    shift
    goto parse_args
)
if /i "%~1"=="--reconfigure" (
    set "RECONFIGURE=1"
    shift
    goto parse_args
)
if /i "%~1"=="--minimal" (
    if "!MINIMAL_FLAG!"=="0" (
        echo --minimal and --no-minimal are mutually exclusive >&2
        exit /b 1
    )
    set "MINIMAL_FLAG=1"
    shift
    goto parse_args
)
if /i "%~1"=="--binary-only" (
    if "!MINIMAL_FLAG!"=="0" (
        echo --binary-only and --no-minimal are mutually exclusive >&2
        exit /b 1
    )
    set "MINIMAL_FLAG=1"
    shift
    goto parse_args
)
if /i "%~1"=="--no-minimal" (
    if "!MINIMAL_FLAG!"=="1" (
        echo --no-minimal and --minimal are mutually exclusive >&2
        exit /b 1
    )
    set "MINIMAL_FLAG=0"
    shift
    goto parse_args
)
if /i "%~1"=="--skip-codex" (
    set "SKIP_CODEX_FLAG=1"
    shift
    goto parse_args
)
if /i "%~1"=="--skip-gemini" (
    set "SKIP_GEMINI_FLAG=1"
    shift
    goto parse_args
)
if /i "%~1"=="--skip-kiro" (
    set "SKIP_KIRO_FLAG=1"
    shift
    goto parse_args
)
if /i "%~1"=="--skip-vibe" (
    set "SKIP_VIBE_FLAG=1"
    shift
    goto parse_args
)
if /i "%~1"=="--skip-opencode" (
    set "SKIP_OPENCODE_FLAG=1"
    shift
    goto parse_args
)
if /i "%~1"=="--skip-qwen" (
    set "SKIP_QWEN_FLAG=1"
    shift
    goto parse_args
)
if /i "%~1"=="--skip-skills" (
    set "SKIP_SKILLS_FLAG=1"
    shift
    goto parse_args
)
if /i "%~1"=="--skip-claude-plugin" (
    set "SKIP_CLAUDE_PLUGIN_FLAG=1"
    shift
    goto parse_args
)
REM Reject any other dash-prefixed token as an unknown option, so a typoed
REM flag like --verify-attesttion fails fast instead of being interpreted as
REM a version tag (which would 404 on releases/download/v--verify-attesttion/...).
REM
REM Uses a variable-assigned substring test instead of `echo %~1 | findstr`
REM because unquoted %~1 in an echo pipe lets cmd.exe interpret shell
REM metacharacters (& | > <) in the argument before the pipe runs. Assigning
REM to a `set "VAR=%~1"` literal-quoted form preserves metacharacters safely,
REM and delayed-expansion substring (!VAR:~0,1!) avoids the subprocess entirely.
REM The error-message echo also quotes "%~1" for the same reason - echoing an
REM unquoted arg containing `&` would re-trigger metacharacter interpretation.
set "CURRENT_ARG=%~1"
if "!CURRENT_ARG:~0,1!"=="-" (
    echo Unknown option: "%~1" >&2
    echo Usage: install.cmd [--version ^<tag^>] [--verify-attestation ^| --skip-attestation] [--with-call-flow] [--extras ^| --no-extras] [--model-invocable ^<list^>] [--minimal ^| --no-minimal] [--skip-codex] [--skip-gemini] [--skip-kiro] [--skip-vibe] [--skip-opencode] [--skip-skills] [--skip-qwen] [--skip-claude-plugin] [--non-interactive] [--reconfigure] >&2
    exit /b 1
)
REM Positional form: install.cmd vX.Y.Z (legacy interface).
REM Reject if --version was already passed - silent overwrite is worse
REM than a clean usage error.
if "!VERSION_EXPLICIT!"=="1" (
    echo Unexpected positional argument: "%~1" ^(version already set^) >&2
    exit /b 1
)
set "VERSION=%~1"
set "VERSION_EXPLICIT=1"
shift
goto parse_args
:args_done

REM Resolve binary-only mode. Precedence: --minimal / --no-minimal flag >
REM PLANNOTATOR_MINIMAL env var > default (off). Mirrors install.sh / install.ps1.
set "MINIMAL=0"
if /i "!PLANNOTATOR_MINIMAL!"=="1"    set "MINIMAL=1"
if /i "!PLANNOTATOR_MINIMAL!"=="true" set "MINIMAL=1"
if /i "!PLANNOTATOR_MINIMAL!"=="yes"  set "MINIMAL=1"
if "!MINIMAL_FLAG!"=="1" set "MINIMAL=1"
if "!MINIMAL_FLAG!"=="0" set "MINIMAL=0"

set "REPO=backnotprop/plannotator"
set "SEM_REPO=Ataraxy-Labs/sem"
set "SEM_VERSION=v0.8.0"
set "INSTALL_DIR=%USERPROFILE%\.local\bin"

REM First plannotator release that carries SLSA build-provenance attestations.
REM See scripts/install.sh for the full explanation - this constant is
REM bumped once at the first attested release via the release skill.
set "MIN_ATTESTED_VERSION=v0.17.2"

REM Attestation-bundle fetch helper, passed to PowerShell via -EncodedCommand
REM so NO script file ever touches %%TEMP%% (a %%RANDOM%%-named .ps1 would be a
REM predictable-path code-execution vector). Inputs travel via env vars
REM (REPO, ATT_DIGEST, ATT_BUNDLE_FILE); exit codes: 0 = bundle written,
REM 2 = fetch failed, 3 = nothing extracted. The blob decodes to EXACTLY the
REM script below (UTF-16LE base64). scripts/install.test.ts decodes the blob,
REM asserts it matches these REM PS: lines byte for byte, and executes its
REM scanner against a captured real attestations response - so the blob
REM cannot silently drift from what is documented here. Regenerate after
REM editing the REM PS: lines:
REM   [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
REM PS: $ErrorActionPreference = 'Stop'
REM PS: try {
REM PS:     $resp = Invoke-WebRequest -Uri ('https://api.github.com/repos/' + $env:REPO + '/attestations/sha256:' + $env:ATT_DIGEST) -UseBasicParsing -TimeoutSec 30
REM PS:     $raw = if ($resp.Content -is [byte[]]) { [System.Text.Encoding]::UTF8.GetString($resp.Content) } else { [string]$resp.Content }
REM PS: } catch { exit 2 }
REM PS: $bundles = @()
REM PS: $searchFrom = 0
REM PS: while ($true) {
REM PS:     $keyIdx = $raw.IndexOf('"bundle"', $searchFrom, [System.StringComparison]::Ordinal)
REM PS:     if ($keyIdx -lt 0) { break }
REM PS:     $searchFrom = $keyIdx + 8
REM PS:     $i = $keyIdx + 8
REM PS:     while ($i -lt $raw.Length -and [char]::IsWhiteSpace($raw[$i])) { $i++ }
REM PS:     if ($i -ge $raw.Length -or $raw[$i] -ne ':') { continue }
REM PS:     $i++
REM PS:     while ($i -lt $raw.Length -and [char]::IsWhiteSpace($raw[$i])) { $i++ }
REM PS:     if ($i -ge $raw.Length -or $raw[$i] -ne '{') { continue }
REM PS:     $depth = 0
REM PS:     $inString = $false
REM PS:     $escaped = $false
REM PS:     $start = $i
REM PS:     for (; $i -lt $raw.Length; $i++) {
REM PS:         $ch = $raw[$i]
REM PS:         if ($escaped) { $escaped = $false; continue }
REM PS:         if ($inString) {
REM PS:             if ($ch -eq '\') { $escaped = $true }
REM PS:             elseif ($ch -eq '"') { $inString = $false }
REM PS:             continue
REM PS:         }
REM PS:         if ($ch -eq '"') { $inString = $true; continue }
REM PS:         if ($ch -eq '{') { $depth++; continue }
REM PS:         if ($ch -eq '}') {
REM PS:             $depth--
REM PS:             if ($depth -eq 0) {
REM PS:                 $bundles += $raw.Substring($start, $i - $start + 1)
REM PS:                 $searchFrom = $i + 1
REM PS:                 break
REM PS:             }
REM PS:         }
REM PS:     }
REM PS: }
REM PS: if ($bundles.Count -eq 0) { exit 3 }
REM PS: try { [System.IO.File]::WriteAllText($env:ATT_BUNDLE_FILE, (($bundles -join [char]10) + [char]10)) } catch { exit 3 }
REM PS: exit 0
set "ATT_FETCH_B64=JABFAHIAcgBvAHIAQQBjAHQAaQBvAG4AUAByAGUAZgBlAHIAZQBuAGMAZQAgAD0AIAAnAFMAdABvAHAAJwAKAHQAcgB5ACAAewAKACAAIAAgACAAJAByAGUAcwBwACAAPQAgAEkAbgB2AG8AawBlAC0AVwBlAGIAUgBlAHEAdQBlAHMAdAAgAC0AVQByAGkAIAAoACcAaAB0AHQAcABzADoALwAvAGEAcABpAC4AZwBpAHQAaAB1AGIALgBjAG8AbQAvAHIAZQBwAG8AcwAvACcAIAArACAAJABlAG4AdgA6AFIARQBQAE8AIAArACAAJwAvAGEAdAB0AGUAcwB0AGEAdABpAG8AbgBzAC8AcwBoAGEAMgA1ADYAOgAnACAAKwAgACQAZQBuAHYAOgBBAFQAVABfAEQASQBHAEUAUwBUACkAIAAtAFUAcwBlAEIAYQBzAGkAYwBQAGEAcgBzAGkAbgBnACAALQBUAGkAbQBlAG8AdQB0AFMAZQBjACAAMwAwAAoAIAAgACAAIAAkAHIAYQB3ACAAPQAgAGkAZgAgACgAJAByAGUAcwBwAC4AQwBvAG4AdABlAG4AdAAgAC0AaQBzACAAWwBiAHkAdABlAFsAXQBdACkAIAB7ACAAWwBTAHkAcwB0AGUAbQAuAFQAZQB4AHQALgBFAG4AYwBvAGQAaQBuAGcAXQA6ADoAVQBUAEYAOAAuAEcAZQB0AFMAdAByAGkAbgBnACgAJAByAGUAcwBwAC4AQwBvAG4AdABlAG4AdAApACAAfQAgAGUAbABzAGUAIAB7ACAAWwBzAHQAcgBpAG4AZwBdACQAcgBlAHMAcAAuAEMAbwBuAHQAZQBuAHQAIAB9AAoAfQAgAGMAYQB0AGMAaAAgAHsAIABlAHgAaQB0ACAAMgAgAH0ACgAkAGIAdQBuAGQAbABlAHMAIAA9ACAAQAAoACkACgAkAHMAZQBhAHIAYwBoAEYAcgBvAG0AIAA9ACAAMAAKAHcAaABpAGwAZQAgACgAJAB0AHIAdQBlACkAIAB7AAoAIAAgACAAIAAkAGsAZQB5AEkAZAB4ACAAPQAgACQAcgBhAHcALgBJAG4AZABlAHgATwBmACgAJwAiAGIAdQBuAGQAbABlACIAJwAsACAAJABzAGUAYQByAGMAaABGAHIAbwBtACwAIABbAFMAeQBzAHQAZQBtAC4AUwB0AHIAaQBuAGcAQwBvAG0AcABhAHIAaQBzAG8AbgBdADoAOgBPAHIAZABpAG4AYQBsACkACgAgACAAIAAgAGkAZgAgACgAJABrAGUAeQBJAGQAeAAgAC0AbAB0ACAAMAApACAAewAgAGIAcgBlAGEAawAgAH0ACgAgACAAIAAgACQAcwBlAGEAcgBjAGgARgByAG8AbQAgAD0AIAAkAGsAZQB5AEkAZAB4ACAAKwAgADgACgAgACAAIAAgACQAaQAgAD0AIAAkAGsAZQB5AEkAZAB4ACAAKwAgADgACgAgACAAIAAgAHcAaABpAGwAZQAgACgAJABpACAALQBsAHQAIAAkAHIAYQB3AC4ATABlAG4AZwB0AGgAIAAtAGEAbgBkACAAWwBjAGgAYQByAF0AOgA6AEkAcwBXAGgAaQB0AGUAUwBwAGEAYwBlACgAJAByAGEAdwBbACQAaQBdACkAKQAgAHsAIAAkAGkAKwArACAAfQAKACAAIAAgACAAaQBmACAAKAAkAGkAIAAtAGcAZQAgACQAcgBhAHcALgBMAGUAbgBnAHQAaAAgAC0AbwByACAAJAByAGEAdwBbACQAaQBdACAALQBuAGUAIAAnADoAJwApACAAewAgAGMAbwBuAHQAaQBuAHUAZQAgAH0ACgAgACAAIAAgACQAaQArACsACgAgACAAIAAgAHcAaABpAGwAZQAgACgAJABpACAALQBsAHQAIAAkAHIAYQB3AC4ATABlAG4AZwB0AGgAIAAtAGEAbgBkACAAWwBjAGgAYQByAF0AOgA6AEkAcwBXAGgAaQB0AGUAUwBwAGEAYwBlACgAJAByAGEAdwBbACQAaQBdACkAKQAgAHsAIAAkAGkAKwArACAAfQAKACAAIAAgACAAaQBmACAAKAAkAGkAIAAtAGcAZQAgACQAcgBhAHcALgBMAGUAbgBnAHQAaAAgAC0AbwByACAAJAByAGEAdwBbACQAaQBdACAALQBuAGUAIAAnAHsAJwApACAAewAgAGMAbwBuAHQAaQBuAHUAZQAgAH0ACgAgACAAIAAgACQAZABlAHAAdABoACAAPQAgADAACgAgACAAIAAgACQAaQBuAFMAdAByAGkAbgBnACAAPQAgACQAZgBhAGwAcwBlAAoAIAAgACAAIAAkAGUAcwBjAGEAcABlAGQAIAA9ACAAJABmAGEAbABzAGUACgAgACAAIAAgACQAcwB0AGEAcgB0ACAAPQAgACQAaQAKACAAIAAgACAAZgBvAHIAIAAoADsAIAAkAGkAIAAtAGwAdAAgACQAcgBhAHcALgBMAGUAbgBnAHQAaAA7ACAAJABpACsAKwApACAAewAKACAAIAAgACAAIAAgACAAIAAkAGMAaAAgAD0AIAAkAHIAYQB3AFsAJABpAF0ACgAgACAAIAAgACAAIAAgACAAaQBmACAAKAAkAGUAcwBjAGEAcABlAGQAKQAgAHsAIAAkAGUAcwBjAGEAcABlAGQAIAA9ACAAJABmAGEAbABzAGUAOwAgAGMAbwBuAHQAaQBuAHUAZQAgAH0ACgAgACAAIAAgACAAIAAgACAAaQBmACAAKAAkAGkAbgBTAHQAcgBpAG4AZwApACAAewAKACAAIAAgACAAIAAgACAAIAAgACAAIAAgAGkAZgAgACgAJABjAGgAIAAtAGUAcQAgACcAXAAnACkAIAB7ACAAJABlAHMAYwBhAHAAZQBkACAAPQAgACQAdAByAHUAZQAgAH0ACgAgACAAIAAgACAAIAAgACAAIAAgACAAIABlAGwAcwBlAGkAZgAgACgAJABjAGgAIAAtAGUAcQAgACcAIgAnACkAIAB7ACAAJABpAG4AUwB0AHIAaQBuAGcAIAA9ACAAJABmAGEAbABzAGUAIAB9AAoAIAAgACAAIAAgACAAIAAgACAAIAAgACAAYwBvAG4AdABpAG4AdQBlAAoAIAAgACAAIAAgACAAIAAgAH0ACgAgACAAIAAgACAAIAAgACAAaQBmACAAKAAkAGMAaAAgAC0AZQBxACAAJwAiACcAKQAgAHsAIAAkAGkAbgBTAHQAcgBpAG4AZwAgAD0AIAAkAHQAcgB1AGUAOwAgAGMAbwBuAHQAaQBuAHUAZQAgAH0ACgAgACAAIAAgACAAIAAgACAAaQBmACAAKAAkAGMAaAAgAC0AZQBxACAAJwB7ACcAKQAgAHsAIAAkAGQAZQBwAHQAaAArACsAOwAgAGMAbwBuAHQAaQBuAHUAZQAgAH0ACgAgACAAIAAgACAAIAAgACAAaQBmACAAKAAkAGMAaAAgAC0AZQBxACAAJwB9ACcAKQAgAHsACgAgACAAIAAgACAAIAAgACAAIAAgACAAIAAkAGQAZQBwAHQAaAAtAC0ACgAgACAAIAAgACAAIAAgACAAIAAgACAAIABpAGYAIAAoACQAZABlAHAAdABoACAALQBlAHEAIAAwACkAIAB7AAoAIAAgACAAIAAgACAAIAAgACAAIAAgACAAIAAgACAAIAAkAGIAdQBuAGQAbABlAHMAIAArAD0AIAAkAHIAYQB3AC4AUwB1AGIAcwB0AHIAaQBuAGcAKAAkAHMAdABhAHIAdAAsACAAJABpACAALQAgACQAcwB0AGEAcgB0ACAAKwAgADEAKQAKACAAIAAgACAAIAAgACAAIAAgACAAIAAgACAAIAAgACAAJABzAGUAYQByAGMAaABGAHIAbwBtACAAPQAgACQAaQAgACsAIAAxAAoAIAAgACAAIAAgACAAIAAgACAAIAAgACAAIAAgACAAIABiAHIAZQBhAGsACgAgACAAIAAgACAAIAAgACAAIAAgACAAIAB9AAoAIAAgACAAIAAgACAAIAAgAH0ACgAgACAAIAAgAH0ACgB9AAoAaQBmACAAKAAkAGIAdQBuAGQAbABlAHMALgBDAG8AdQBuAHQAIAAtAGUAcQAgADAAKQAgAHsAIABlAHgAaQB0ACAAMwAgAH0ACgB0AHIAeQAgAHsAIABbAFMAeQBzAHQAZQBtAC4ASQBPAC4ARgBpAGwAZQBdADoAOgBXAHIAaQB0AGUAQQBsAGwAVABlAHgAdAAoACQAZQBuAHYAOgBBAFQAVABfAEIAVQBOAEQATABFAF8ARgBJAEwARQAsACAAKAAoACQAYgB1AG4AZABsAGUAcwAgAC0AagBvAGkAbgAgAFsAYwBoAGEAcgBdADEAMAApACAAKwAgAFsAYwBoAGEAcgBdADEAMAApACkAIAB9ACAAYwBhAHQAYwBoACAAewAgAGUAeABpAHQAIAAzACAAfQAKAGUAeABpAHQAIAAwAAoA"

REM Detect architecture. Native ARM64 Windows binaries are built from
REM bun-windows-arm64 (stable since Bun v1.3.10), so ARM64 hosts get a
REM native binary - no Windows x86-64 emulation tax. PROCESSOR_ARCHITECTURE
REM reports the architecture the current cmd.exe process is running under;
REM PROCESSOR_ARCHITEW6432 is set only in 32-bit processes running via
REM WoW64 and reflects the host architecture (covers the edge case of a
REM 32-bit tool launching install.cmd on an ARM64 machine).
set "PLATFORM="
if /i "%PROCESSOR_ARCHITECTURE%"=="AMD64"    set "PLATFORM=win32-x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64"    set "PLATFORM=win32-arm64"
if /i "%PROCESSOR_ARCHITEW6432%"=="AMD64"    set "PLATFORM=win32-x64"
if /i "%PROCESSOR_ARCHITEW6432%"=="ARM64"    set "PLATFORM=win32-arm64"

if "!PLATFORM!"=="" (
    echo Plannotator does not support 32-bit Windows. >&2
    exit /b 1
)

REM Check for curl availability
curl --version >nul 2>&1
if !ERRORLEVEL! neq 0 (
    echo curl is required but not available. Please use the PowerShell installer. >&2
    exit /b 1
)

REM Create install directory
if not exist "!INSTALL_DIR!" mkdir "!INSTALL_DIR!"

REM Get version to install
if /i "!VERSION!"=="latest" (
    echo Fetching latest version...

    REM api.github.com caps unauthenticated requests at 60/hour per source IP,
    REM which fails installs behind shared egress IPs (NAT/CGNAT/corporate
    REM proxies) and during repeated/debug runs within an hour. Attach an
    REM Authorization header when a token is available (raises the limit to
    REM 5000/hour); when none is found, fall back to anonymous (unchanged
    REM behavior). Precedence matches `gh`: GITHUB_TOKEN > GH_TOKEN > gh auth token.
    REM Read the env vars via delayed expansion, never percent expansion, so
    REM the value is not re-parsed by cmd's phase-1 expansion - a value
    REM containing metacharacters or exclamation marks can neither inject
    REM commands nor be corrupted here.
    set "GH_TOKEN_VAL="
    if defined GITHUB_TOKEN set "GH_TOKEN_VAL=!GITHUB_TOKEN!"
    if not defined GH_TOKEN_VAL if defined GH_TOKEN set "GH_TOKEN_VAL=!GH_TOKEN!"
    if not defined GH_TOKEN_VAL (
        REM Resolve gh via `where` and invoke the absolute path so the for /f
        REM command line never runs a bare `gh` name, which cmd would resolve
        REM from the current directory first. (`where` itself also searches
        REM the CWD first - accepted limitation, documented here.)
        REM --hostname github.com scopes the fallback to github.com
        REM credentials, so a gh setup whose default host is a GitHub
        REM Enterprise server never leaks a GHES token to api.github.com. On
        REM an ancient gh without the flag, stderr is swallowed and we fall
        REM back to anonymous.
        set "GH_EXE="
        for /f "delims=" %%g in ('where gh 2^>nul') do if not defined GH_EXE set "GH_EXE=%%g"
        if defined GH_EXE (
            for /f "delims=" %%i in ('"!GH_EXE!" auth token --hostname github.com 2^>nul') do set "GH_TOKEN_VAL=%%i"
        )
        set "GH_EXE="
    )
    REM Charset allowlist: GitHub tokens are [A-Za-z0-9_] (plus - to be
    REM safe). Strip every allowed character (cmd substitution is
    REM case-insensitive, covering A-Z too); anything left over means an
    REM unexpected character - a quote in particular could break out of the
    REM quoted Authorization header on the curl line below - so drop the
    REM token and go anonymous. Done with pure delayed-expansion
    REM substitutions: a findstr pipe cannot be used because delayed
    REM expansion does not survive into pipe children, and writing the token
    REM to a temp file for findstr would leak the secret to disk.
    if defined GH_TOKEN_VAL (
        set "TOKEN_RESIDUE=!GH_TOKEN_VAL!"
        for %%c in (a b c d e f g h i j k l m n o p q r s t u v w x y z 0 1 2 3 4 5 6 7 8 9 _ -) do if defined TOKEN_RESIDUE set "TOKEN_RESIDUE=!TOKEN_RESIDUE:%%c=!"
        if defined TOKEN_RESIDUE set "GH_TOKEN_VAL="
        set "TOKEN_RESIDUE="
    )
    if defined GH_TOKEN_VAL (
        set "GH_AUTH_HEADER=-H "Authorization: Bearer !GH_TOKEN_VAL!""
    ) else (
        set "GH_AUTH_HEADER="
    )

    REM Download release info to a randomized temp file so concurrent
    REM invocations don't collide and a same-user pre-placed symlink at
    REM a predictable path can't redirect curl's output.
    set "RELEASE_JSON=%TEMP%\plannotator-release-%RANDOM%.json"
    curl -fsSL !GH_AUTH_HEADER! "https://api.github.com/repos/!REPO!/releases/latest" -o "!RELEASE_JSON!"
    REM A stale/revoked token (expired GITHUB_TOKEN lingering in CI images,
    REM dotfiles, direnv) gets a 401 here and would break an install that
    REM works fine anonymously today. If the authenticated call failed and
    REM we had a token, retry once without the header so a bad token costs
    REM one extra request but never blocks an otherwise-working install.
    REM Note: install.sh / install.ps1 inspect the HTTP status and retry
    REM only on 401; capturing the status portably in batch is not worth the
    REM complexity, so cmd retries on any failure when a token was used - an
    REM accepted cmd-only compromise. See backnotprop/plannotator#1157.
    REM Both ERRORLEVEL reads below sit immediately adjacent to the curl
    REM they test (only REM lines and a no-op if in between); the token
    REM clears deliberately come AFTER the failure check because `set` can
    REM disturb ERRORLEVEL.
    if !ERRORLEVEL! neq 0 if defined GH_AUTH_HEADER (
        curl -fsSL "https://api.github.com/repos/!REPO!/releases/latest" -o "!RELEASE_JSON!"
    )
    if !ERRORLEVEL! neq 0 (
        REM API unavailable (anonymous rate limit, proxy): the release-page
        REM redirect fallback below fills TAG instead.
        del "!RELEASE_JSON!" 2>nul
    )
    REM Drop the local token copies; downloads and git clone are anonymous.
    REM GITHUB_TOKEN / GH_TOKEN themselves remain in the environment exactly
    REM as the user set them.
    set "GH_TOKEN_VAL="
    set "GH_AUTH_HEADER="

    REM Extract tag_name by parsing the real JSON with PowerShell. A
    REM line-based findstr breaks when GitHub serves the response compact on
    REM one line, picking up the "url" value instead (#1655). Only a plain
    REM vX.Y.Z-style tag is accepted.
    set "TAG="
    set "PLN_RELEASE_JSON=!RELEASE_JSON!"
    for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "try { $t = (Get-Content $env:PLN_RELEASE_JSON -Raw -Encoding UTF8 | ConvertFrom-Json).tag_name } catch { exit 0 }; if ($t -cmatch '^v[0-9]+\.[0-9]+\.[0-9]+\z') { $t }"`) do (
        set "TAG=%%i"
    )
    set "PLN_RELEASE_JSON="
    del "!RELEASE_JSON!" 2>nul

    REM The API failed (anonymous rate limit of 60/hour per IP, a proxy that
    REM blocks api.github.com): read the tag from the redirect that
    REM github.com/<repo>/releases/latest answers with
    REM (.../releases/tag/vX.Y.Z), which is not rate-limited and needs no
    REM token or gh. The last path segment is the tag.
    if "!TAG!"=="" (
        set "LATEST_URL="
        for /f "usebackq delims=" %%u in (`curl -fsSLI -o nul -w "%%{url_effective}" "https://github.com/!REPO!/releases/latest"`) do set "LATEST_URL=%%u"
        REM Keep what follows the last "/" by stripping one "*/" prefix per
        REM pass (no FOR-IN split: an element with * or ? would be matched
        REM against files in the current directory).
        if defined LATEST_URL for /l %%n in (1,1,32) do if not "!LATEST_URL:/=!"=="!LATEST_URL!" set "LATEST_URL=!LATEST_URL:*/=!"
        if defined LATEST_URL if "!LATEST_URL:/=!"=="!LATEST_URL!" set "TAG=!LATEST_URL!"
        set "LATEST_URL="
    )

    REM Only a plain vX.Y.Z tag is accepted, from the API or the redirect: it
    REM goes into the download URL, the attestation --source-ref and git
    REM clone --branch. After the leading v there may be only the ten digits
    REM and exactly two dots, none of them leading, trailing or doubled.
    REM Pure delayed-expansion substitutions, no findstr pipe (findstr's
    REM [0-9] also matches superscript digits, and a pipe child loses
    REM delayed expansion).
    if defined TAG (
        set "TAG_REST="
        if "!TAG:~0,1!"=="v" set "TAG_REST=!TAG:~1!"
        set "TAG_DOTS=!TAG_REST!"
        for %%c in (0 1 2 3 4 5 6 7 8 9) do if defined TAG_DOTS set "TAG_DOTS=!TAG_DOTS:%%c=!"
        if not "!TAG_DOTS!"==".." set "TAG="
        if defined TAG_REST (
            if "!TAG_REST:~0,1!"=="." set "TAG="
            if "!TAG_REST:~-1!"=="." set "TAG="
            if not "!TAG_REST:..=!"=="!TAG_REST!" set "TAG="
        ) else (
            set "TAG="
        )
        set "TAG_REST="
        set "TAG_DOTS="
    )

    if "!TAG!"=="" (
        echo Failed to get latest version ^(check your connection, or pass --version vX.Y.Z^) >&2
        exit /b 1
    )
) else (
    set "TAG=!VERSION!"
    REM Add v prefix if not present. Use a substring test rather than
    REM piping the expanded variable through findstr - an unquoted echo
    REM pipe re-exposes cmd metacharacters (& | > <) in the value before
    REM the pipe runs. Matches the safe pattern used in the arg parser.
    if not "!TAG:~0,1!"=="v" set "TAG=v!TAG!"
)

echo Installing plannotator !TAG!...

REM Resolve SLSA build-provenance verification opt-in BEFORE the download so
REM we can fail fast without wasting bandwidth if the requested tag predates
REM provenance support. Precedence: CLI flag > env var > config.json > default.
set "VERIFY_ATTESTATION=0"

REM Layer 3: config file (lowest precedence of the opt-in sources).
REM Unset PLANNOTATOR_DATA_DIR: an existing %USERPROFILE%\.plannotator
REM (legacy default) always wins; otherwise an explicitly-set absolute
REM XDG_DATA_HOME (rare on Windows but honored the same way as the runtime;
REM drive-rooted or UNC) places the directory at XDG_DATA_HOME\plannotator;
REM otherwise %USERPROFILE%\.plannotator.
if defined PLANNOTATOR_DATA_DIR (
    set "_CONFIG_DIR=!PLANNOTATOR_DATA_DIR!"
) else (
    set "_CONFIG_DIR=%USERPROFILE%\.plannotator"
    if not exist "%USERPROFILE%\.plannotator\" if defined XDG_DATA_HOME (
        if "!XDG_DATA_HOME:~1,1!"==":" (
            set "_CONFIG_DIR=!XDG_DATA_HOME!\plannotator"
        ) else if "!XDG_DATA_HOME:~0,2!"=="\\" (
            set "_CONFIG_DIR=!XDG_DATA_HOME!\plannotator"
        )
    )
)
if /i "!_CONFIG_DIR!"=="~" set "_CONFIG_DIR=%USERPROFILE%"
if "!_CONFIG_DIR:~0,2!"=="~\" set "_CONFIG_DIR=%USERPROFILE%\!_CONFIG_DIR:~2!"
if "!_CONFIG_DIR:~0,2!"=="~/" set "_CONFIG_DIR=%USERPROFILE%\!_CONFIG_DIR:~2!"
if exist "!_CONFIG_DIR!\config.json" (
    findstr /r /c:"\"verifyAttestation\"[ 	]*:[ 	]*true" "!_CONFIG_DIR!\config.json" >nul 2>&1
    if !ERRORLEVEL! equ 0 set "VERIFY_ATTESTATION=1"
)

REM Layer 2: env var (overrides config file).
if /i "!PLANNOTATOR_VERIFY_ATTESTATION!"=="1"    set "VERIFY_ATTESTATION=1"
if /i "!PLANNOTATOR_VERIFY_ATTESTATION!"=="true" set "VERIFY_ATTESTATION=1"
if /i "!PLANNOTATOR_VERIFY_ATTESTATION!"=="yes"  set "VERIFY_ATTESTATION=1"
if /i "!PLANNOTATOR_VERIFY_ATTESTATION!"=="0"    set "VERIFY_ATTESTATION=0"
if /i "!PLANNOTATOR_VERIFY_ATTESTATION!"=="false" set "VERIFY_ATTESTATION=0"
if /i "!PLANNOTATOR_VERIFY_ATTESTATION!"=="no"   set "VERIFY_ATTESTATION=0"

REM Layer 1: CLI flag (overrides everything).
if "!VERIFY_ATTESTATION_FLAG!"=="1" set "VERIFY_ATTESTATION=1"
if "!VERIFY_ATTESTATION_FLAG!"=="0" set "VERIFY_ATTESTATION=0"

REM Resolve the CallDiff call-flow runtime opt-in. Same three-layer shape as
REM verifyAttestation: CLI flag > env var > config.json > default (off).
set "INSTALL_CALL_FLOW=0"
if exist "!_CONFIG_DIR!\config.json" (
    findstr /r /c:"\"installCallFlow\"[ 	]*:[ 	]*true" "!_CONFIG_DIR!\config.json" >nul 2>&1
    if !ERRORLEVEL! equ 0 set "INSTALL_CALL_FLOW=1"
)
if /i "!PLANNOTATOR_INSTALL_CALLDIFF!"=="1"     set "INSTALL_CALL_FLOW=1"
if /i "!PLANNOTATOR_INSTALL_CALLDIFF!"=="true"  set "INSTALL_CALL_FLOW=1"
if /i "!PLANNOTATOR_INSTALL_CALLDIFF!"=="yes"   set "INSTALL_CALL_FLOW=1"
if /i "!PLANNOTATOR_INSTALL_CALLDIFF!"=="0"     set "INSTALL_CALL_FLOW=0"
if /i "!PLANNOTATOR_INSTALL_CALLDIFF!"=="false" set "INSTALL_CALL_FLOW=0"
if /i "!PLANNOTATOR_INSTALL_CALLDIFF!"=="no"    set "INSTALL_CALL_FLOW=0"
if "!WITH_CALL_FLOW_FLAG!"=="1" set "INSTALL_CALL_FLOW=1"

REM Resolve the per-agent integration opt-outs (#1178). Same three-layer shape
REM as verifyAttestation: CLI flag > env var > config skipInstall.<agent> >
REM default (off). The config layer parses the REAL JSON with PowerShell
REM (M2): findstr is line-oblivious, so a "codex": true under some OTHER key
REM would have opted users out, and an explicit false inside skipInstall
REM would have been ignored. PowerShell reads the actual skipInstall object
REM (strict boolean check, matching install.ps1) and emits one agent name
REM per enabled skip; the config path travels via an env var so nothing is
REM re-parsed as code. Each resolved skip remembers its source so the
REM detected-but-skipped report can name what the user set.
set "SKIP_CODEX=0"
set "SKIP_CODEX_SOURCE="
set "SKIP_GEMINI=0"
set "SKIP_GEMINI_SOURCE="
set "SKIP_KIRO=0"
set "SKIP_KIRO_SOURCE="
set "SKIP_VIBE=0"
set "SKIP_VIBE_SOURCE="
set "SKIP_OPENCODE=0"
set "SKIP_OPENCODE_SOURCE="
set "SKIP_QWEN=0"
set "SKIP_QWEN_SOURCE="
REM skipInstall.skills is not an agent - it opts out of the skills/slash-command
REM checkout for every scope at once - but it shares the same three layers.
set "SKIP_SKILLS=0"
set "SKIP_SKILLS_SOURCE="
REM skipInstall.claudePlugin opts out of updating an installed Claude Code plugin.
set "SKIP_CLAUDE_PLUGIN=0"
set "SKIP_CLAUDE_PLUGIN_SOURCE="
if exist "!_CONFIG_DIR!\config.json" (
    set "PLN_CONFIG_JSON=!_CONFIG_DIR!\config.json"
    for /f "usebackq delims=" %%K in (`powershell -NoProfile -Command "try { $c = Get-Content $env:PLN_CONFIG_JSON -Raw | ConvertFrom-Json } catch { exit 0 }; if (-not $c.skipInstall) { exit 0 }; foreach ($k in @('codex','gemini','kiro','vibe','opencode','qwen','skills','claudePlugin')) { $v = $c.skipInstall.$k; if ($v -is [bool] -and $v) { $k } }"`) do (
        if /i "%%K"=="codex" (
            set "SKIP_CODEX=1"
            set "SKIP_CODEX_SOURCE=config skipInstall.codex"
        )
        if /i "%%K"=="gemini" (
            set "SKIP_GEMINI=1"
            set "SKIP_GEMINI_SOURCE=config skipInstall.gemini"
        )
        if /i "%%K"=="kiro" (
            set "SKIP_KIRO=1"
            set "SKIP_KIRO_SOURCE=config skipInstall.kiro"
        )
        if /i "%%K"=="vibe" (
            set "SKIP_VIBE=1"
            set "SKIP_VIBE_SOURCE=config skipInstall.vibe"
        )
        if /i "%%K"=="opencode" (
            set "SKIP_OPENCODE=1"
            set "SKIP_OPENCODE_SOURCE=config skipInstall.opencode"
        )
        if /i "%%K"=="qwen" (
            set "SKIP_QWEN=1"
            set "SKIP_QWEN_SOURCE=config skipInstall.qwen"
        )
        if /i "%%K"=="skills" (
            set "SKIP_SKILLS=1"
            set "SKIP_SKILLS_SOURCE=config skipInstall.skills"
        )
        if /i "%%K"=="claudePlugin" (
            set "SKIP_CLAUDE_PLUGIN=1"
            set "SKIP_CLAUDE_PLUGIN_SOURCE=config skipInstall.claudePlugin"
        )
    )
    set "PLN_CONFIG_JSON="
)
for %%V in (1 true yes) do if /i "!PLANNOTATOR_SKIP_CODEX_INSTALL!"=="%%V" (
    set "SKIP_CODEX=1"
    set "SKIP_CODEX_SOURCE=PLANNOTATOR_SKIP_CODEX_INSTALL"
)
for %%V in (0 false no) do if /i "!PLANNOTATOR_SKIP_CODEX_INSTALL!"=="%%V" (
    set "SKIP_CODEX=0"
    set "SKIP_CODEX_SOURCE="
)
for %%V in (1 true yes) do if /i "!PLANNOTATOR_SKIP_GEMINI_INSTALL!"=="%%V" (
    set "SKIP_GEMINI=1"
    set "SKIP_GEMINI_SOURCE=PLANNOTATOR_SKIP_GEMINI_INSTALL"
)
for %%V in (0 false no) do if /i "!PLANNOTATOR_SKIP_GEMINI_INSTALL!"=="%%V" (
    set "SKIP_GEMINI=0"
    set "SKIP_GEMINI_SOURCE="
)
for %%V in (1 true yes) do if /i "!PLANNOTATOR_SKIP_KIRO_INSTALL!"=="%%V" (
    set "SKIP_KIRO=1"
    set "SKIP_KIRO_SOURCE=PLANNOTATOR_SKIP_KIRO_INSTALL"
)
for %%V in (0 false no) do if /i "!PLANNOTATOR_SKIP_KIRO_INSTALL!"=="%%V" (
    set "SKIP_KIRO=0"
    set "SKIP_KIRO_SOURCE="
)
for %%V in (1 true yes) do if /i "!PLANNOTATOR_SKIP_VIBE_INSTALL!"=="%%V" (
    set "SKIP_VIBE=1"
    set "SKIP_VIBE_SOURCE=PLANNOTATOR_SKIP_VIBE_INSTALL"
)
for %%V in (0 false no) do if /i "!PLANNOTATOR_SKIP_VIBE_INSTALL!"=="%%V" (
    set "SKIP_VIBE=0"
    set "SKIP_VIBE_SOURCE="
)
for %%V in (1 true yes) do if /i "!PLANNOTATOR_SKIP_OPENCODE_INSTALL!"=="%%V" (
    set "SKIP_OPENCODE=1"
    set "SKIP_OPENCODE_SOURCE=PLANNOTATOR_SKIP_OPENCODE_INSTALL"
)
for %%V in (0 false no) do if /i "!PLANNOTATOR_SKIP_OPENCODE_INSTALL!"=="%%V" (
    set "SKIP_OPENCODE=0"
    set "SKIP_OPENCODE_SOURCE="
)
for %%V in (1 true yes) do if /i "!PLANNOTATOR_SKIP_QWEN_INSTALL!"=="%%V" (
    set "SKIP_QWEN=1"
    set "SKIP_QWEN_SOURCE=PLANNOTATOR_SKIP_QWEN_INSTALL"
)
for %%V in (0 false no) do if /i "!PLANNOTATOR_SKIP_QWEN_INSTALL!"=="%%V" (
    set "SKIP_QWEN=0"
    set "SKIP_QWEN_SOURCE="
)
for %%V in (1 true yes) do if /i "!PLANNOTATOR_SKIP_SKILLS_INSTALL!"=="%%V" (
    set "SKIP_SKILLS=1"
    set "SKIP_SKILLS_SOURCE=PLANNOTATOR_SKIP_SKILLS_INSTALL"
)
for %%V in (0 false no) do if /i "!PLANNOTATOR_SKIP_SKILLS_INSTALL!"=="%%V" (
    set "SKIP_SKILLS=0"
    set "SKIP_SKILLS_SOURCE="
)
for %%V in (1 true yes) do if /i "!PLANNOTATOR_SKIP_CLAUDE_PLUGIN_UPDATE!"=="%%V" (
    set "SKIP_CLAUDE_PLUGIN=1"
    set "SKIP_CLAUDE_PLUGIN_SOURCE=PLANNOTATOR_SKIP_CLAUDE_PLUGIN_UPDATE"
)
for %%V in (0 false no) do if /i "!PLANNOTATOR_SKIP_CLAUDE_PLUGIN_UPDATE!"=="%%V" (
    set "SKIP_CLAUDE_PLUGIN=0"
    set "SKIP_CLAUDE_PLUGIN_SOURCE="
)
if "!SKIP_CODEX_FLAG!"=="1" (
    set "SKIP_CODEX=1"
    set "SKIP_CODEX_SOURCE=--skip-codex"
)
if "!SKIP_GEMINI_FLAG!"=="1" (
    set "SKIP_GEMINI=1"
    set "SKIP_GEMINI_SOURCE=--skip-gemini"
)
if "!SKIP_KIRO_FLAG!"=="1" (
    set "SKIP_KIRO=1"
    set "SKIP_KIRO_SOURCE=--skip-kiro"
)
if "!SKIP_VIBE_FLAG!"=="1" (
    set "SKIP_VIBE=1"
    set "SKIP_VIBE_SOURCE=--skip-vibe"
)
if "!SKIP_OPENCODE_FLAG!"=="1" (
    set "SKIP_OPENCODE=1"
    set "SKIP_OPENCODE_SOURCE=--skip-opencode"
)
if "!SKIP_QWEN_FLAG!"=="1" (
    set "SKIP_QWEN=1"
    set "SKIP_QWEN_SOURCE=--skip-qwen"
)
if "!SKIP_SKILLS_FLAG!"=="1" (
    set "SKIP_SKILLS=1"
    set "SKIP_SKILLS_SOURCE=--skip-skills"
)
if "!SKIP_CLAUDE_PLUGIN_FLAG!"=="1" (
    set "SKIP_CLAUDE_PLUGIN=1"
    set "SKIP_CLAUDE_PLUGIN_SOURCE=--skip-claude-plugin"
)

REM Pre-flight: reject verification requests for tags older than the first
REM attested release BEFORE downloading. Critical security point: the version
REM comparison uses $env:TAG_NUM / $env:MIN_NUM instead of interpolating
REM !TAG_NUM! / !MIN_NUM! into the PowerShell command string. Interpolation
REM would let a crafted --version value break out of the single-quoted literal
REM and execute arbitrary PowerShell (e.g. --version "0.18.0'; calc; '0.18.0"
REM would run Calculator). $env: reads the raw string; PowerShell never parses
REM the value as code. [version] cast throws on invalid input, catch swallows,
REM VERSION_OK stays empty, and the guard rejects - safe fail.
if "!VERIFY_ATTESTATION!"=="1" (
    REM Strip the leading `v` via substring-from-index-1. cmd's `:str=repl`
    REM substitution is GLOBAL, not anchored - `!TAG:v=!` would remove every
    REM `v` in the string, not just the leading one, so a hypothetical tag
    REM like `v1.0.0-rev2` would become `1.0.0-re2` and break the [version]
    REM cast. TAG is guaranteed to start with `v` by the normalization step
    REM above, so `:~1` (drop first char) is equivalent to stripping the
    REM leading prefix.
    set "TAG_NUM=!TAG:~1!"
    set "MIN_NUM=!MIN_ATTESTED_VERSION:~1!"

    REM Detect pre-release / build-metadata tags (e.g. v0.18.0-rc1) BEFORE
    REM handing the value to PowerShell. [System.Version] doesn't support
    REM semver prerelease suffixes and would throw inside the try/catch,
    REM leaving VERSION_OK empty and surfacing a misleading "predates
    REM attestation support" error. install.sh handles these correctly via
    REM `sort -V`; Windows doesn't have a built-in semver comparator, so
    REM we reject explicitly with an accurate diagnosis instead of silently
    REM misclassifying the failure.
    REM
    REM Uses native cmd substitution `!VAR:-=!` to check for `-` presence -
    REM no subshell, no metacharacter risk. If removing `-` changes the
    REM string, the original contained a `-`.
    if not "!TAG_NUM!"=="!TAG_NUM:-=!" (
        echo Pre-release tags like !TAG! aren't currently supported for >&2
        echo provenance verification on Windows. [System.Version] doesn't >&2
        echo parse semver prerelease suffixes. Options: >&2
        echo   - Install without provenance verification: --skip-attestation >&2
        echo   - Pin to a stable release tag ^(no `-rc`, `-beta`, etc.^) >&2
        exit /b 1
    )

    set "VERSION_OK="
    for /f "delims=" %%i in ('powershell -NoProfile -Command "try { if ([version]$env:TAG_NUM -ge [version]$env:MIN_NUM) { 'yes' } } catch {}"') do set "VERSION_OK=%%i"
    if not "!VERSION_OK!"=="yes" (
        echo Provenance verification was requested, but !TAG! predates >&2
        echo plannotator's attestation support. The first release carrying >&2
        echo signed build provenance is !MIN_ATTESTED_VERSION!. Options: >&2
        echo   - Pin to !MIN_ATTESTED_VERSION! or later: --version !MIN_ATTESTED_VERSION! >&2
        echo   - Install without provenance verification: --skip-attestation >&2
        echo   - Or unset PLANNOTATOR_VERIFY_ATTESTATION / remove verifyAttestation >&2
        echo     from %USERPROFILE%\.plannotator\config.json >&2
        exit /b 1
    )
)

set "BINARY_NAME=plannotator-!PLATFORM!.exe"
set "BINARY_URL=https://github.com/!REPO!/releases/download/!TAG!/!BINARY_NAME!"
set "CHECKSUM_URL=!BINARY_URL!.sha256"

REM Download binary to a randomized temp path so concurrent invocations
REM don't collide and a same-user pre-placed symlink at a predictable
REM path can't redirect where curl writes the downloaded executable.
REM The SHA256 check would pass regardless (content is authentic), but
REM the install destination would be corrupted.
set "TEMP_FILE=%TEMP%\plannotator-%RANDOM%.exe"
curl -fsSL "!BINARY_URL!" -o "!TEMP_FILE!"
if !ERRORLEVEL! neq 0 (
    echo Failed to download binary >&2
    if exist "!TEMP_FILE!" del "!TEMP_FILE!"
    exit /b 1
)

REM Download checksum to a randomized temp path for the same reason as
REM the binary download above (concurrent collision + symlink pre-placement).
set "CHECKSUM_FILE=%TEMP%\plannotator-checksum-%RANDOM%.txt"
curl -fsSL "!CHECKSUM_URL!" -o "!CHECKSUM_FILE!"
if !ERRORLEVEL! neq 0 (
    echo Failed to download checksum >&2
    REM curl -o creates the output file before receiving data, so a
    REM network failure or HTTP error leaves a 0-byte/partial file
    REM at CHECKSUM_FILE. Clean it up to match the discipline used
    REM for TEMP_FILE elsewhere in this script.
    if exist "!CHECKSUM_FILE!" del "!CHECKSUM_FILE!"
    del "!TEMP_FILE!"
    exit /b 1
)

REM Extract expected checksum (first field)
set /p EXPECTED_CHECKSUM=<"!CHECKSUM_FILE!"
for /f "tokens=1" %%i in ("!EXPECTED_CHECKSUM!") do set "EXPECTED_CHECKSUM=%%i"
del "!CHECKSUM_FILE!"

REM Verify checksum using certutil
set "ACTUAL_CHECKSUM="
for /f "skip=1 tokens=*" %%i in ('certutil -hashfile "!TEMP_FILE!" SHA256') do (
    if not defined ACTUAL_CHECKSUM (
        set "ACTUAL_CHECKSUM=%%i"
        set "ACTUAL_CHECKSUM=!ACTUAL_CHECKSUM: =!"
    )
)

if /i "!ACTUAL_CHECKSUM!" neq "!EXPECTED_CHECKSUM!" (
    echo Checksum verification failed >&2
    del "!TEMP_FILE!"
    exit /b 1
)

if "!VERIFY_ATTESTATION!"=="1" (
    REM VERIFY_ATTESTATION was resolved before the download; MIN_ATTESTED_VERSION
    REM pre-flight already ran and rejected older tags. At this point we know
    REM the tag is attested and gh should find a bundle.
    where gh >nul 2>&1
    if !ERRORLEVEL! equ 0 (
        REM Capture combined output to a randomized temp file so gh's
        REM actual error message (auth, network, missing attestation, etc.)
        REM can be surfaced on failure. Randomized to match the existing
        REM %RANDOM% pattern used elsewhere in this script and avoid races
        REM between concurrent invocations. Matches install.sh / install.ps1.
        REM
        REM Verification is constrained to the exact tag (--source-ref) AND
        REM the specific signing workflow file (--signer-workflow) - not
        REM just "built somewhere in this repo". See install.sh for full
        REM rationale.
        REM Credential-free path first (#1178): the attestations endpoint on
        REM api.github.com is world-readable for public repos, so fetch the
        REM Sigstore bundle anonymously and hand it to gh via --bundle. This
        REM drops the gh-login requirement; gh's own authenticated fetch is
        REM only used as a fallback when the public fetch fails. Single fetch
        REM attempt, deliberately never retried: the unauthenticated API
        REM allows 60 requests/hour per IP. The response is
        REM { "attestations": [ { "bundle": {...} } ] }; gh --bundle expects
        REM the bundle values one JSON document per line (the JSONL format
        REM `gh attestation download` writes). PowerShell does the fetch and
        REM the extraction via the ATT_FETCH_B64 -EncodedCommand payload
        REM (documented and drift-guarded where it is defined, near the top
        REM of this file): each bundle is copied as a byte-exact substring of
        REM the response, never a ConvertFrom-Json round trip whose DateTime
        REM coercion could corrupt a bundle field. Values pass via $env: so
        REM nothing is re-parsed as code, and no helper file ever exists on
        REM disk. Exit codes: 0 = bundle written, 2 = fetch failed, 3 = no
        REM bundle extracted.
        set "ATT_BUNDLE_FILE=%TEMP%\plannotator-bundle-%RANDOM%.jsonl"
        set "ATT_DIGEST=!ACTUAL_CHECKSUM!"
        set "ATT_BUNDLE_OK=0"
        REM NOTE: the ATT_FALLBACK_REASON literals below are assigned inside
        REM parenthesized blocks - they must stay free of unescaped cmd
        REM metacharacters, parentheses above all, or the block parse breaks.
        set "ATT_FALLBACK_REASON=Could not fetch the attestation bundle from the public API"
        powershell -NoProfile -EncodedCommand !ATT_FETCH_B64!
        if !ERRORLEVEL! equ 0 (
            if exist "!ATT_BUNDLE_FILE!" set "ATT_BUNDLE_OK=1"
        ) else if !ERRORLEVEL! equ 3 (
            set "ATT_FALLBACK_REASON=Could not extract a bundle from the attestations API response"
        )
        set "GH_OUTPUT=%TEMP%\plannotator-gh-%RANDOM%.txt"
        set "ATT_USED_BUNDLE=0"
        if "!ATT_BUNDLE_OK!"=="1" (
            set "ATT_USED_BUNDLE=1"
            gh attestation verify "!TEMP_FILE!" ^
                --bundle "!ATT_BUNDLE_FILE!" ^
                --repo "!REPO!" ^
                --source-ref "refs/tags/!TAG!" ^
                --signer-workflow "backnotprop/plannotator/.github/workflows/release.yml" ^
                > "!GH_OUTPUT!" 2>&1
            if !ERRORLEVEL! neq 0 (
                REM H1: a --bundle failure is not necessarily a provenance
                REM failure - an older gh rejects the flag outright, a corrupt
                REM bundle fails parsing, etc. Retry once through the exact
                REM authenticated path before classifying anything; only the
                REM retry's verdict is reported. A real provenance failure
                REM fails again here, so nothing bad ever slips through.
                echo Bundle-based verification did not complete; retrying via gh's authenticated fetch.
                set "ATT_USED_BUNDLE=0"
                gh attestation verify "!TEMP_FILE!" ^
                    --repo "!REPO!" ^
                    --source-ref "refs/tags/!TAG!" ^
                    --signer-workflow "backnotprop/plannotator/.github/workflows/release.yml" ^
                    > "!GH_OUTPUT!" 2>&1
            )
        ) else (
            echo !ATT_FALLBACK_REASON!; falling back to gh's authenticated fetch.
            gh attestation verify "!TEMP_FILE!" ^
                --repo "!REPO!" ^
                --source-ref "refs/tags/!TAG!" ^
                --signer-workflow "backnotprop/plannotator/.github/workflows/release.yml" ^
                > "!GH_OUTPUT!" 2>&1
        )
        if !ERRORLEVEL! neq 0 (
            type "!GH_OUTPUT!" >&2
            REM Classify the failure so connectivity problems are never
            REM conflated with a provenance failure. "Sigstore verifiers"
            REM means gh could not initialize the TUF trust root, which is
            REM fetched on EVERY run (never cached); "gh auth login" is only
            REM reachable on the authenticated path. Precedence: TUF wins
            REM over auth (the auth findstr runs first so the TUF assignment
            REM lands last, matching install.sh / install.ps1).
            set "VERIFY_FAIL_KIND=provenance"
            findstr /c:"gh auth login" "!GH_OUTPUT!" >nul 2>&1
            if !ERRORLEVEL! equ 0 set "VERIFY_FAIL_KIND=auth"
            findstr /c:"Sigstore verifiers" "!GH_OUTPUT!" >nul 2>&1
            if !ERRORLEVEL! equ 0 set "VERIFY_FAIL_KIND=tuf"
            del "!GH_OUTPUT!"
            if exist "!ATT_BUNDLE_FILE!" del "!ATT_BUNDLE_FILE!"
            if "!VERIFY_FAIL_KIND!"=="tuf" (
                echo Could not initialize the Sigstore trust root ^(TUF^). Provenance >&2
                echo verification needs network access on every run; the trusted root >&2
                echo is fetched per-run, never cached. This is a connectivity failure, >&2
                echo NOT evidence of a bad binary. Refusing to install unverified; >&2
                echo retry with network access or pass --skip-attestation. >&2
            )
            if "!VERIFY_FAIL_KIND!"=="auth" (
                echo The credential-free bundle path did not complete and gh is not >&2
                echo logged in, so the authenticated fallback could not run. Retry with >&2
                echo network access to api.github.com, run 'gh auth login', or pass >&2
                echo --skip-attestation. >&2
            )
            if "!VERIFY_FAIL_KIND!"=="provenance" (
                echo Attestation verification failed! >&2
                echo The binary's SHA256 matched, but no valid signed provenance was found >&2
                echo for !REPO!. Refusing to install. >&2
            )
            del "!TEMP_FILE!"
            exit /b 1
        )
        del "!GH_OUTPUT!"
        if "!ATT_USED_BUNDLE!"=="1" (
            echo [OK] verified build provenance ^(SLSA, credential-free via the public attestations API^)
        ) else (
            echo [OK] verified build provenance ^(SLSA^)
        )
        if exist "!ATT_BUNDLE_FILE!" del "!ATT_BUNDLE_FILE!"
    ) else (
        echo verifyAttestation is enabled but gh CLI was not found. >&2
        echo Install https://cli.github.com ^(no login is needed when the public >&2
        echo attestation bundle fetch succeeds^), or unset >&2
        echo PLANNOTATOR_VERIFY_ATTESTATION / remove verifyAttestation >&2
        echo from %USERPROFILE%\.plannotator\config.json / pass --skip-attestation. >&2
        del "!TEMP_FILE!"
        exit /b 1
    )
) else (
    echo SHA256 verified. For build provenance verification, see
    echo https://docs.plannotator.ai/open-source/start/installation#pin-or-verify-a-release
)

REM Install binary
set "INSTALL_PATH=!INSTALL_DIR!\plannotator.exe"
REM A running plannotator.exe cannot be overwritten, but it can be renamed.
REM Move the current binary aside to plannotator.exe.old first (a running
REM session keeps working from it), then move the new one in. The .old file
REM from an earlier run is deleted when nothing holds it any more; if it is
REM still locked the rename-aside is skipped and the move behaves as before.
if exist "!INSTALL_PATH!.old" del /f /q "!INSTALL_PATH!.old" >nul 2>&1
set "ASIDE_DONE=0"
if exist "!INSTALL_PATH!" if not exist "!INSTALL_PATH!.old" (
    move /y "!INSTALL_PATH!" "!INSTALL_PATH!.old" >nul 2>&1 && set "ASIDE_DONE=1"
)
move /y "!TEMP_FILE!" "!INSTALL_PATH!" >nul
if errorlevel 1 (
    if "!ASIDE_DONE!"=="1" if not exist "!INSTALL_PATH!" move /y "!INSTALL_PATH!.old" "!INSTALL_PATH!" >nul 2>&1
    if exist "!TEMP_FILE!" del "!TEMP_FILE!" >nul 2>&1
    echo Could not install !INSTALL_PATH!. >&2
    exit /b 1
)
if "!ASIDE_DONE!"=="1" del /f /q "!INSTALL_PATH!.old" >nul 2>&1

echo.
echo plannotator !TAG! installed to !INSTALL_PATH!

REM Binary-only mode stops here (see the MINIMAL resolution after :args_done):
REM the binary is installed, so print PATH advice and exit before any sidecar
REM download, agent integration, skill checkout, or config write runs. No
REM persistent state is written outside !INSTALL_DIR! except install-flags.json
REM (:WriteInstallFlags), which lets a later auto-update stay binary-only.
if "!MINIMAL!"=="1" (
    call :WriteInstallFlags
    call :PrintPathAdvice
    echo.
    echo Minimal install complete - only the plannotator binary was installed.
    echo No skills, hooks, agent integrations, or config files were written.
    exit /b 0
)

call :InstallSemSidecar
call :InstallAgentTerminalRuntime
call :InstallCallFlowRuntime

call :PrintPathAdvice

REM Claude Code plugin: repair the marketplace clone, never rewrite it.
REM
REM <claude config>\plugins\marketplaces\plannotator is Claude Code's own git
REM clone of this repository; installing or updating the plugin copies
REM apps/hook from it into the plugin cache. Installers used to overwrite its
REM apps/hook/hooks/hooks.json with a hard-coded copy (#230 stale timeout,
REM #267 Windows exe path). That copy drifted from the repo file (#689 dropped
REM the EnterPlanMode hook; later it dropped "modules", the Claude Code mod),
REM so nothing writes it now: the clone's own file is the source of truth.
REM An earlier installer's rewrite can still be sitting in the clone as a
REM local edit; :RepairLegacyPluginHooks restores it from the clone's HEAD,
REM but only when it differs from HEAD AND matches one of the shapes those
REM installers wrote, so a user's own edit is never discarded.
if defined CLAUDE_CONFIG_DIR (
    set "PLUGIN_MARKETPLACE_DIR=%CLAUDE_CONFIG_DIR%\plugins\marketplaces\plannotator"
) else (
    set "PLUGIN_MARKETPLACE_DIR=%USERPROFILE%\.claude\plugins\marketplaces\plannotator"
)
set "PLUGIN_HOOKS=!PLUGIN_MARKETPLACE_DIR!\apps\hook\hooks\hooks.json"
if exist "!PLUGIN_HOOKS!" call :RepairLegacyPluginHooks

REM Claude Code plugin: update it when it is already installed. The plugin
REM comes from a GitHub marketplace, which Claude Code does not auto-update by
REM default, so a binary update used to leave an old plugin behind. When the
REM claude CLI is on PATH and plannotator@plannotator is in Claude Code's plugin
REM registry (at user scope), :UpdateClaudePlugin runs the two commands this
REM script used to only print, after the repair above so a repaired clone is
REM what gets copied. It never installs the plugin, never prompts, and never
REM fails the install. Opt out with --skip-claude-plugin,
REM PLANNOTATOR_SKIP_CLAUDE_PLUGIN_UPDATE=1 or skipInstall.claudePlugin.
set "CLAUDE_PLUGIN_STATE=none"
call :UpdateClaudePlugin

REM Codex hooks on Windows are still experimental upstream. Do not mutate
REM the Codex home automatically from the cmd installer until that path
REM is verified end-to-end.
REM Codex stores config and state under CODEX_HOME when set, falling back to
REM %%USERPROFILE%%\.codex (developers.openai.com/codex/config-advanced). (#852)
set "CODEX_DIR=%USERPROFILE%\.codex"
if defined CODEX_HOME set "CODEX_DIR=%CODEX_HOME%"
set "CODEX_AVAILABLE=0"
where codex >nul 2>&1
if !ERRORLEVEL! equ 0 set "CODEX_AVAILABLE=1"
if exist "!CODEX_DIR!" (
    for /f "delims=" %%C in ('dir /b /a "!CODEX_DIR!" 2^>nul') do (
        if /i not "%%C"=="skills" if /i not "%%C"==".DS_Store" set "CODEX_AVAILABLE=1"
    )
)
REM Kiro is auto-detected like Codex/Gemini: PATH executable or an existing %USERPROFILE%\.kiro.
set "KIRO_AVAILABLE=0"
where kiro-cli >nul 2>&1
if !ERRORLEVEL! equ 0 set "KIRO_AVAILABLE=1"
if exist "%USERPROFILE%\.kiro" set "KIRO_AVAILABLE=1"

REM Vibe (Mistral's TUI coding agent) stores everything under VIBE_HOME when
REM set, falling back to %USERPROFILE%\.vibe. Detected only when that home
REM exists, matching install.sh: a vibe executable on PATH alone is not enough.
REM The Windows installer writes NOTHING under the Vibe home. The plan-review
REM hook is macOS/Linux-only, so only manual hook instructions are printed; and
REM the Vibe-specific skills are not installed either, because they run
REM "PLANNOTATOR_ORIGIN=mistral-vibe plannotator ...", a POSIX env-prefix that
REM Vibe's Windows shell tool only understands when it resolved Git Bash (it
REM falls back to PowerShell otherwise). Vibe also reads ~/.agents/skills, which
REM this installer fills with the shell-neutral core skills, so
REM /plannotator-review and /plannotator-annotate work there with no Vibe origin
REM label. /plannotator-last is NOT supported for Vibe on Windows yet: without
REM PLANNOTATOR_ORIGIN it takes the Claude Code transcript path, so it fails or
REM reads the wrong session.
if not defined VIBE_HOME set "VIBE_HOME=%USERPROFILE%\.vibe"
set "VIBE_AVAILABLE=0"
if exist "!VIBE_HOME!" set "VIBE_AVAILABLE=1"

REM Qwen Code keeps its user files in QWEN_HOME when set, else
REM %USERPROFILE%\.qwen. QWEN_HOME is the Qwen folder itself, a leading ~ is
REM expanded and a relative path is taken from the current folder, as in
REM Qwen. Detected as in install.sh: that folder must exist, and so must the
REM qwen command or a file only Qwen Code writes there ^(settings.json,
REM installation_id, projects\, extensions\^). The `skills` CLI makes
REM ~/.qwen/skills for people who never installed Qwen Code, so the folder
REM alone is not enough. The extension step needs the qwen command.
set "QWEN_DIR=%USERPROFILE%\.qwen"
if defined QWEN_HOME set "QWEN_DIR=!QWEN_HOME!"
if "!QWEN_DIR!"=="~" set "QWEN_DIR=%USERPROFILE%"
if "!QWEN_DIR:~0,2!"=="~/" set "QWEN_DIR=%USERPROFILE%\!QWEN_DIR:~2!"
if "!QWEN_DIR:~0,2!"=="~\" set "QWEN_DIR=%USERPROFILE%\!QWEN_DIR:~2!"
for %%P in ("!QWEN_DIR!") do set "QWEN_DIR=%%~fP"
set "QWEN_SKILLS_DIR=!QWEN_DIR!\skills"
set "QWEN_AVAILABLE=0"
set "QWEN_SKILLS_INSTALLED=0"
set "QWEN_TOO_OLD=0"
if exist "!QWEN_DIR!\" (
    where $PATH:qwen >nul 2>&1
    if !ERRORLEVEL! equ 0 set "QWEN_AVAILABLE=1"
    if exist "!QWEN_DIR!\settings.json" set "QWEN_AVAILABLE=1"
    if exist "!QWEN_DIR!\installation_id" set "QWEN_AVAILABLE=1"
    if exist "!QWEN_DIR!\projects\" set "QWEN_AVAILABLE=1"
    if exist "!QWEN_DIR!\extensions\" set "QWEN_AVAILABLE=1"
)
REM HONEST three-state reporting (#1178): detected-but-skipped is its own
REM state, never conflated with "not detected". A Codex opt-out leaves the
REM Codex home entirely untouched (no writes, no cleanup, no removal).
if "!CODEX_AVAILABLE!"=="1" if "!SKIP_CODEX!"=="1" (
    echo.
    echo Codex: detected, skipped ^(!SKIP_CODEX_SOURCE!^).
    echo The Windows installer only prints manual Codex setup instructions; they
    echo were suppressed.
    REM M4: the existing-integration note only fires when hooks.json actually
    REM references plannotator - mere existence proves nothing, since the
    REM file may hold only the user's own hooks.
    if exist "!CODEX_DIR!\hooks.json" (
        findstr /c:"plannotator" "!CODEX_DIR!\hooks.json" >nul 2>&1
        if !ERRORLEVEL! equ 0 echo Your existing Codex Stop hook at !CODEX_DIR!\hooks.json is unaffected.
    )
    echo Note: the shared agent skills in %USERPROFILE%\.agents\skills serve multiple
    echo agents ^(Codex among them^) and are still installed.
)
if "!CODEX_AVAILABLE!"=="1" if "!SKIP_CODEX!"=="0" (
    echo.
    echo Codex detected.
    echo Codex plan review hooks are experimental on Windows. To try them manually:
    echo.
    echo   1. Add this to !CODEX_DIR!\config.toml:
    echo.
    echo      [features]
    echo      hooks = true
    echo.
    echo   2. Add a Stop hook in !CODEX_DIR!\hooks.json that runs:
    echo.
    echo      !INSTALL_PATH!
    echo.
)

REM Vibe plan-review hooks run on macOS/Linux only (Vibe spawns hooks via /bin/sh;
REM Windows uses cmd.exe and a .sh launcher is not executable). The Windows
REM installer never writes hooks.toml automatically - it prints manual setup
REM instructions, mirroring Codex-on-Windows. A Vibe opt-out (#1178) suppresses
REM the manual instructions and this run neither creates, updates, nor removes
REM anything under the Vibe home (nothing is written there on Windows anyway).
if "!VIBE_AVAILABLE!"=="1" if "!SKIP_VIBE!"=="1" (
    echo.
    echo Vibe: detected, skipped ^(!SKIP_VIBE_SOURCE!^).
    echo The Windows installer only prints manual Vibe setup instructions; they
    echo were suppressed.
    if exist "!VIBE_HOME!\hooks.toml" (
        findstr /c:"plannotator" "!VIBE_HOME!\hooks.toml" >nul 2>&1
        if !ERRORLEVEL! equ 0 echo Your existing Vibe plan-review hook at !VIBE_HOME!\hooks.toml is unaffected.
    )
)
if "!VIBE_AVAILABLE!"=="1" if "!SKIP_VIBE!"=="0" (
    echo.
    echo Vibe detected.
    echo Vibe plan-review hooks run on macOS/Linux only ^(Vibe spawns hooks via
    echo /bin/sh; on Windows a .sh launcher is not executable^). To set up plan
    echo review manually on a macOS/Linux box with Vibe, add to ~/.vibe/hooks.toml:
    echo.
    echo   [[hooks]]
    echo   name = "plannotator-exit-plan-mode"
    echo   type = "pre_tool"
    echo   match = "exit_plan_mode"
    echo   command = "/full/path/to/plannotator"
    echo   timeout = 345600
    echo.
    echo The command must be argv-only ^(no env-prefix^): plannotator detects
    echo the Vibe origin from the hook payload. Hooks are stable in Vibe
    echo 2.25+, so no config.toml flag is needed.
    echo.
    echo The Vibe-specific skills are not installed on Windows. Vibe picks up the
    echo shared review and annotate skills from %USERPROFILE%\.agents\skills instead;
    echo /plannotator-last is not supported for Vibe on Windows yet.
)

REM Clear any cached OpenCode plugin to force fresh download on next run.
REM Both OpenCode generations root their cache at %XDG_CACHE_HOME%\opencode,
REM else %USERPROFILE%\.cache\opencode (on Windows too: OpenCode uses XDG
REM paths off the home directory, not %LOCALAPPDATA%).
REM   OpenCode 1: node_modules\@plannotator and packages\@plannotator
REM   OpenCode 2: npm\<name>@<spec>\<generation>\ (packages/util/src/npm.ts),
REM               so our plugin is npm\@plannotator\opencode@<spec>.
REM Only our own package's entries are removed. An OpenCode opt-out (#1178)
REM leaves OpenCode's own cache directory alone; the Bun package cache is a
REM shared cache, not OpenCode's home, and is always cleared.
if defined XDG_CACHE_HOME (
    set "OPENCODE_CACHE_DIR=%XDG_CACHE_HOME%\opencode"
) else (
    set "OPENCODE_CACHE_DIR=%USERPROFILE%\.cache\opencode"
)
if "!SKIP_OPENCODE!"=="0" (
    if exist "!OPENCODE_CACHE_DIR!\node_modules\@plannotator" rmdir /s /q "!OPENCODE_CACHE_DIR!\node_modules\@plannotator" >nul 2>&1
    if exist "!OPENCODE_CACHE_DIR!\packages\@plannotator" rmdir /s /q "!OPENCODE_CACHE_DIR!\packages\@plannotator" >nul 2>&1
    if exist "!OPENCODE_CACHE_DIR!\npm\@plannotator" (
        for /d %%D in ("!OPENCODE_CACHE_DIR!\npm\@plannotator\opencode@*") do rmdir /s /q "%%~fD" >nul 2>&1
        REM The scope directory goes only when nothing else is left in it.
        rmdir "!OPENCODE_CACHE_DIR!\npm\@plannotator" >nul 2>&1
    )
)
if exist "%USERPROFILE%\.bun\install\cache\@plannotator" rmdir /s /q "%USERPROFILE%\.bun\install\cache\@plannotator" >nul 2>&1

REM ----------------------------------------------------------------------
REM Skills + command stubs install (requires git)
REM
REM Claude Code commands are deprecated in favor of skills. Core skills
REM installed to %%USERPROFILE%%\.claude\skills are user-invocable by directory
REM name (/plannotator-review etc.), so no command files are written anymore.
REM
REM Install matrix (all copies verbatim, copy-if-present so older-tag pinned
REM installs never fail when a source dir is absent):
REM   %%USERPROFILE%%\.claude\skills            <- apps\skills\core\* (all 4)
REM   %%USERPROFILE%%\.agents\skills            <- apps\skills\core\* (all 4)
REM   %%USERPROFILE%%\.kiro\skills              <- apps\kiro-cli\skills\* (3) + 2 extras (when kiro detected)
REM   %%USERPROFILE%%\.config\opencode\commands <- apps\opencode-plugin\commands\*.md (always)
REM   %%USERPROFILE%%\.gemini\commands          <- apps\gemini\commands\*.toml (when ~/.gemini exists)
REM Nothing goes to the Codex home (CODEX_DIR\skills) anymore.
REM ----------------------------------------------------------------------

REM Aggressive cleanup on upgrade - echo each removal, ignore missing.
REM NOTE: legacy Claude command cleanup happens AFTER the skill install below -
REM a command file is only removed once its replacement skill is on disk, so a
REM failed or skipped skill install never leaves users with neither.
if defined CLAUDE_CONFIG_DIR (
    set "CLAUDE_COMMANDS_DIR=%CLAUDE_CONFIG_DIR%\commands"
) else (
    set "CLAUDE_COMMANDS_DIR=%USERPROFILE%\.claude\commands"
)

REM NOTE: Codex stale-skill cleanup happens AFTER the skill install below -
REM the core skills are only removed from the Codex home once their
REM replacement exists in %%USERPROFILE%%\.agents\skills.
set "STALE_CODEX_SKILLS_DIR=!CODEX_DIR!\skills"

REM Old installers (pre core/extra split) ran a wholesale skills copy against
REM a new-layout tag and could leave junk core/extra directory copies in the
REM Claude skills scope. Never valid skill names - always safe to remove.
if defined CLAUDE_CONFIG_DIR (
    set "CLAUDE_SKILLS_SCOPE=%CLAUDE_CONFIG_DIR%\skills"
) else (
    set "CLAUDE_SKILLS_SCOPE=%USERPROFILE%\.claude\skills"
)
for %%J in (core extra) do (
    if exist "!CLAUDE_SKILLS_SCOPE!\%%J" (
        rmdir /s /q "!CLAUDE_SKILLS_SCOPE!\%%J" >nul 2>&1
        echo Removed stale layout directory !CLAUDE_SKILLS_SCOPE!\%%J ^(left by an older installer^)
    )
)

REM Extras are no longer managed in the Claude / shared-agent scopes. Remove
REM previously default-installed copies ONCE per machine - recorded in the
REM migrations ledger under the Plannotator data dir - because copies the user
REM reinstalls via `npx skills add` are byte-identical to ours and can only be
REM told apart by remembering that this cleanup already ran.
if defined CLAUDE_CONFIG_DIR (
    set "CLAUDE_SKILLS_DIR=%CLAUDE_CONFIG_DIR%\skills"
) else (
    set "CLAUDE_SKILLS_DIR=%USERPROFILE%\.claude\skills"
)
set "AGENTS_SKILLS_DIR=%USERPROFILE%\.agents\skills"
set "MIGRATIONS_DIR=!_CONFIG_DIR!\migrations"
set "EXTRAS_MIGRATION=!MIGRATIONS_DIR!\2026-06-extras-default-install-removed"
if not exist "!EXTRAS_MIGRATION!" (
    for %%S in (plannotator-compound plannotator-setup-goal plannotator-visual-explainer) do (
        if exist "!CLAUDE_SKILLS_DIR!\%%S" (
            rmdir /s /q "!CLAUDE_SKILLS_DIR!\%%S" >nul 2>&1
            echo Removed extra Plannotator skill from !CLAUDE_SKILLS_DIR!\%%S ^(reinstall via npx skills add^)
        )
        if exist "!AGENTS_SKILLS_DIR!\%%S" (
            rmdir /s /q "!AGENTS_SKILLS_DIR!\%%S" >nul 2>&1
            echo Removed extra Plannotator skill from !AGENTS_SKILLS_DIR!\%%S ^(reinstall via npx skills add^)
        )
    )
    if not exist "!MIGRATIONS_DIR!" mkdir "!MIGRATIONS_DIR!" >nul 2>&1
    type nul > "!EXTRAS_MIGRATION!"
)

REM --- Guided install (interactive consoles only) ---
REM Mirrors install.sh: two questions (extras? model-invocable skills?),
REM answers persisted to install-prefs in the Plannotator data dir and reused
REM silently on re-runs. --reconfigure re-opens the wizard; --non-interactive
REM forces silence. `set /p` returns empty at EOF, so redirected/CI runs fall
REM through to the defaults without hanging. Flags win over everything.
REM No checkbox UI in batch - the skill picker uses numbered toggles instead.
set "PREFS_FILE=!_CONFIG_DIR!\install-prefs"
set "SAVED_EXTRAS="
set "SAVED_INVOCABLE="
if exist "!PREFS_FILE!" (
    for /f "usebackq tokens=1,* delims==" %%A in ("!PREFS_FILE!") do (
        if /i "%%A"=="extras" set "SAVED_EXTRAS=%%B"
        if /i "%%A"=="model_invocable" set "SAVED_INVOCABLE=%%B"
    )
)

REM Extras already on disk? Then the extras question is moot - they still
REM count toward the picker list, and we never launch the npx flow over them.
set "EXTRAS_PRESENT=0"
for %%S in (plannotator-compound plannotator-setup-goal plannotator-visual-explainer) do (
    if exist "!CLAUDE_SKILLS_DIR!\%%S" set "EXTRAS_PRESENT=1"
    if exist "!AGENTS_SKILLS_DIR!\%%S" set "EXTRAS_PRESENT=1"
)

REM A wizard needs a real console. `timeout` exits non-zero when stdin is
REM redirected ("Input redirection is not supported"), making it a reliable
REM console probe - CI and redirected runs never see the wizard and never
REM trigger the wizard-only installs (npx extras). The set /p
REM EOF-fallthrough remains as a second line of defense.
set "CAN_PROMPT=0"
timeout /t 0 >nul 2>&1
if !ERRORLEVEL! equ 0 set "CAN_PROMPT=1"
if "!NON_INTERACTIVE!"=="1" set "CAN_PROMPT=0"
set "RUN_WIZARD=0"
if "!CAN_PROMPT!"=="1" (
    if "!RECONFIGURE!"=="1" set "RUN_WIZARD=1"
    if not exist "!PREFS_FILE!" set "RUN_WIZARD=1"
)

set "EXTRAS_CHOICE="
set "INVOCABLE_CHOICE="
if "!RUN_WIZARD!"=="1" call :guided_wizard

REM Flags override the wizard and saved answers; otherwise saved, then defaults.
if defined EXTRAS_FLAG set "EXTRAS_CHOICE=!EXTRAS_FLAG!"
if defined MODEL_INVOCABLE_FLAG set "INVOCABLE_CHOICE=!MODEL_INVOCABLE_FLAG!"
if not defined EXTRAS_CHOICE (
    if defined SAVED_EXTRAS (set "EXTRAS_CHOICE=!SAVED_EXTRAS!") else (set "EXTRAS_CHOICE=no")
)
if not defined INVOCABLE_CHOICE (
    if defined SAVED_INVOCABLE (set "INVOCABLE_CHOICE=!SAVED_INVOCABLE!") else (set "INVOCABLE_CHOICE=none")
)

REM Persist only when the wizard ran or a flag set something - silent re-runs
REM must not clobber saved answers with defaults.
set "DO_PERSIST=0"
if "!RUN_WIZARD!"=="1" set "DO_PERSIST=1"
if defined EXTRAS_FLAG set "DO_PERSIST=1"
if defined MODEL_INVOCABLE_FLAG set "DO_PERSIST=1"
if "!DO_PERSIST!"=="1" (
    if not exist "!_CONFIG_DIR!" mkdir "!_CONFIG_DIR!" >nul 2>&1
    > "!PREFS_FILE!" (
        echo extras=!EXTRAS_CHOICE!
        echo model_invocable=!INVOCABLE_CHOICE!
    )
)

REM Extras install is delegated to the skills CLI (its UI picks the agents).
REM Interactive wizard runs only - silent runs and CI get the printed command.
REM Never runs when the extras already exist. The extras ARE skills, so
REM --skip-skills suppresses them too - a saved extras=yes preference must not
REM smuggle a skill install past the opt-out.
if "!SKIP_SKILLS!"=="0" if "!EXTRAS_CHOICE!"=="yes" if "!EXTRAS_PRESENT!"=="0" (
    set "NPX_OK=0"
    where npx >nul 2>&1
    if !ERRORLEVEL! equ 0 if "!RUN_WIZARD!"=="1" set "NPX_OK=1"
    if "!NPX_OK!"=="1" (
        echo Launching the skills CLI for the extras ^(pick your agents in its UI^)...
        call npx skills add backnotprop/plannotator/apps/skills/extra --global
        if not !ERRORLEVEL! equ 0 echo skills CLI did not complete - install later with: npx skills add backnotprop/plannotator/apps/skills/extra --global
    ) else (
        echo Install the extras with: npx skills add backnotprop/plannotator/apps/skills/extra --global
    )
)

REM File-copy installs require git (sparse checkout). Hard requirement: without
REM git we cannot install the /plannotator-* skills, so fail loudly instead of
REM leaving a partial install. Hook/config writing above has already run; the
REM Pi update and Gemini config below are skipped on failure and complete when
REM the user re-runs the installer.
REM
REM Skills/commands opt-out (--skip-skills / PLANNOTATOR_SKIP_SKILLS_INSTALL /
REM skipInstall.skills). HONEST reporting like the per-agent family: the skipped
REM state is announced, and skip means do-not-write - nothing already on disk in
REM any skill or command scope is fetched, replaced, or removed on this run.
REM Nothing is fetched, so git also stops being a requirement here.
if "!SKIP_SKILLS!"=="1" (
    echo.
    echo Skills: skipped ^(!SKIP_SKILLS_SOURCE!^).
    echo No skills or slash commands were fetched, and none already installed
    echo were changed or removed. The /plannotator-* commands are NOT installed
    echo by this run - re-run without the opt-out to install them.
) else (
    where git >nul 2>&1
    if not !ERRORLEVEL! equ 0 (
        echo Error: git is required to install Plannotator's skills and slash commands. 1>&2
        echo Install git, then run this installer again. 1>&2
        echo To install without them, re-run with --skip-skills. 1>&2
        exit /b 1
    )
)
REM Qwen Code too old for plan review: nothing is installed for it. See :QwenVersionCheck.
call :QwenVersionCheck
set "CHECKOUT_FAILED=0"
set "KIRO_SKILLS_DIR=%USERPROFILE%\.kiro\skills"
set "KIRO_AGENTS_DIR=%USERPROFILE%\.kiro\agents"
set "OPENCODE_COMMANDS_DIR=%USERPROFILE%\.config\opencode\commands"
set "GEMINI_COMMANDS_DIR=%USERPROFILE%\.gemini\commands"
set "SKILLS_TMP=%TEMP%\plannotator-skills-%RANDOM%"
REM git's stderr is captured OUTSIDE SKILLS_TMP (which is removed before the
REM failure message prints) so a failed clone can show the real git error
REM (#1238) instead of only the generic "network or git error" line.
set "GIT_ERR_FILE=%TEMP%\plannotator-git-stderr-%RANDOM%.txt"
mkdir "!SKILLS_TMP!" >nul 2>&1

REM Opt-out: jump past the clone so no network call is made and
REM CHECKOUT_FAILED stays 0 - an opt-out is not a fetch failure and must not
REM trip the guard below. Reported above, next to the git check.
if "!SKIP_SKILLS!"=="1" goto skills_checkout_done

set "CLONE_OK=0"
set "SPARSE_CLONE=1"
REM LC_ALL=C pins git's error strings to English for the capability probe
REM below: a localized git would emit a translated "unknown option" message
REM the findstr match misses, sending old-git non-English users to a hard
REM failure instead of the fallback. Saved and restored around the probe.
set "PLANNOTATOR_SAVED_LC_ALL=!LC_ALL!"
set "LC_ALL=C"
git clone --depth 1 --filter=blob:none --sparse "https://github.com/!REPO!.git" --branch "!TAG!" "!SKILLS_TMP!\repo" >nul 2>"!GIT_ERR_FILE!"
if !ERRORLEVEL! equ 0 set "CLONE_OK=1"
set "LC_ALL=!PLANNOTATOR_SAVED_LC_ALL!"
set "PLANNOTATOR_SAVED_LC_ALL="

REM Capability probe, not a version parse (same philosophy as the GitButler
REM flag probing in packages/shared/gitbutler-core.ts): `git clone --sparse`
REM needs git >= 2.25, and an older git rejects the flag instantly with
REM "error: unknown option `sparse'" before any network call (#1238). Fall
REM back to a plain shallow clone - it costs download size, not correctness:
REM every path the copy steps below read is present in the full checkout, and
REM `git sparse-checkout set` (equally missing on that git) is skipped
REM because there is nothing to narrow.
set "SPARSE_UNSUPPORTED=0"
if "!CLONE_OK!"=="0" (
    findstr /i /c:"unknown option" "!GIT_ERR_FILE!" >nul 2>&1 && findstr /i /c:"sparse" "!GIT_ERR_FILE!" >nul 2>&1 && set "SPARSE_UNSUPPORTED=1"
)
if "!SPARSE_UNSUPPORTED!"=="1" (
    echo This git does not support "git clone --sparse" ^(needs git ^>= 2.25^) - falling back to a plain shallow clone.
    set "SPARSE_CLONE=0"
    if exist "!SKILLS_TMP!\repo" rmdir /s /q "!SKILLS_TMP!\repo" >nul 2>&1
    git clone --depth 1 "https://github.com/!REPO!.git" --branch "!TAG!" "!SKILLS_TMP!\repo" >nul 2>"!GIT_ERR_FILE!"
    if !ERRORLEVEL! equ 0 set "CLONE_OK=1"
)

if "!CLONE_OK!"=="1" (
    pushd "!SKILLS_TMP!\repo"
    if "!SPARSE_CLONE!"=="1" git sparse-checkout set apps/skills apps/kiro-cli apps/vibe apps/opencode-plugin/commands apps/gemini/commands apps/qwen-code >nul 2>&1

    REM Claude Code reads apps\skills\claude\* (injection `!`plannotator ... $ARGUMENTS``
    REM + allowed-tools, so /plannotator-* run with no permission prompt); Codex
    REM reads apps\skills\core\* (prose). The `!`...`` injection is Claude-Code-only,
    REM so the two are sourced separately. Replace rather than merge on each run.
    if exist "apps\skills\claude" (
        if not exist "!CLAUDE_SKILLS_DIR!" mkdir "!CLAUDE_SKILLS_DIR!"
        for %%S in (plannotator-review plannotator-annotate plannotator-last plannotator-inbox) do (
            if exist "apps\skills\claude\%%S" (
                if exist "!CLAUDE_SKILLS_DIR!\%%S" rmdir /s /q "!CLAUDE_SKILLS_DIR!\%%S" >nul 2>&1
                xcopy /s /i /y /q "apps\skills\claude\%%S" "!CLAUDE_SKILLS_DIR!\%%S\" >nul 2>&1
            )
        )
        REM The plannotator knowledge skill (CLI reference) has no Claude-only
        REM injection form, so Claude installs the single-sourced core copy.
        if exist "apps\skills\core\plannotator" (
            if exist "!CLAUDE_SKILLS_DIR!\plannotator" rmdir /s /q "!CLAUDE_SKILLS_DIR!\plannotator" >nul 2>&1
            xcopy /s /i /y /q "apps\skills\core\plannotator" "!CLAUDE_SKILLS_DIR!\plannotator\" >nul 2>&1
        )
        echo Installed Claude Code skills to !CLAUDE_SKILLS_DIR!\
    )
    if exist "apps\skills\core" (
        if not exist "!AGENTS_SKILLS_DIR!" mkdir "!AGENTS_SKILLS_DIR!"
        for %%S in (plannotator-review plannotator-annotate plannotator-last plannotator-inbox plannotator) do (
            if exist "apps\skills\core\%%S" (
                REM Replace rather than merge so files removed upstream don't linger.
                if exist "!AGENTS_SKILLS_DIR!\%%S" rmdir /s /q "!AGENTS_SKILLS_DIR!\%%S" >nul 2>&1
                xcopy /s /i /y /q "apps\skills\core\%%S" "!AGENTS_SKILLS_DIR!\%%S\" >nul 2>&1
            )
        )
        echo Installed shared agent skills to !AGENTS_SKILLS_DIR!\
    ) else (
        echo Tag !TAG! predates the core/extra skill layout - skipping core skill install
    )

    REM OpenCode command stubs -> always (plugin intercepts execution),
    REM unless opted out via --skip-opencode (#1178).
    if "!SKIP_OPENCODE!"=="0" if exist "apps\opencode-plugin\commands" (
        if not exist "!OPENCODE_COMMANDS_DIR!" mkdir "!OPENCODE_COMMANDS_DIR!"
        xcopy /y /q "apps\opencode-plugin\commands\*.md" "!OPENCODE_COMMANDS_DIR!\" >nul 2>&1
        echo Installed OpenCode commands to !OPENCODE_COMMANDS_DIR!\
    )

    REM Gemini TOML commands -> only when ~/.gemini exists (Gemini's native
    REM format) and not opted out (#1178).
    if exist "%USERPROFILE%\.gemini" if "!SKIP_GEMINI!"=="0" if exist "apps\gemini\commands" (
        if not exist "!GEMINI_COMMANDS_DIR!" mkdir "!GEMINI_COMMANDS_DIR!"
        xcopy /y /q "apps\gemini\commands\*.toml" "!GEMINI_COMMANDS_DIR!\" >nul 2>&1
        echo Installed Gemini commands to !GEMINI_COMMANDS_DIR!\
    )

    REM Kiro -> hand-maintained kiro skills (3) + 2 extras, only when detected
    REM and not opted out (#1178: a Kiro opt-out leaves ~/.kiro untouched).
    if "!KIRO_AVAILABLE!"=="1" if "!SKIP_KIRO!"=="0" if exist "apps\kiro-cli\skills" (
        if not exist "!KIRO_SKILLS_DIR!" mkdir "!KIRO_SKILLS_DIR!"
        REM Kiro-specific skills with origin baked in come from apps\kiro-cli\skills.
        for %%S in (plannotator-review plannotator-annotate) do (
            if exist "apps\kiro-cli\skills\%%S" (
                if exist "!KIRO_SKILLS_DIR!\%%S" rmdir /s /q "!KIRO_SKILLS_DIR!\%%S" >nul 2>&1
                xcopy /s /i /y /q "apps\kiro-cli\skills\%%S" "!KIRO_SKILLS_DIR!\%%S\" >nul 2>&1
            )
        )
        REM /plannotator-inbox needs no origin label: the shell-neutral core copy.
        if exist "apps\skills\core\plannotator-inbox" (
            if exist "!KIRO_SKILLS_DIR!\plannotator-inbox" rmdir /s /q "!KIRO_SKILLS_DIR!\plannotator-inbox" >nul 2>&1
            xcopy /s /i /y /q "apps\skills\core\plannotator-inbox" "!KIRO_SKILLS_DIR!\plannotator-inbox\" >nul 2>&1
        )
        REM The plannotator knowledge skill (CLI reference) has no Kiro-specific
        REM form, so Kiro receives the single-sourced core copy like every other scope.
        if exist "apps\skills\core\plannotator" (
            if exist "!KIRO_SKILLS_DIR!\plannotator" rmdir /s /q "!KIRO_SKILLS_DIR!\plannotator" >nul 2>&1
            xcopy /s /i /y /q "apps\skills\core\plannotator" "!KIRO_SKILLS_DIR!\plannotator\" >nul 2>&1
        )
        REM The two extras Kiro keeps receiving come from apps\skills\extra.
        if exist "apps\skills\extra\plannotator-setup-goal" (
            if exist "!KIRO_SKILLS_DIR!\plannotator-setup-goal" rmdir /s /q "!KIRO_SKILLS_DIR!\plannotator-setup-goal" >nul 2>&1
            xcopy /s /i /y /q "apps\skills\extra\plannotator-setup-goal" "!KIRO_SKILLS_DIR!\plannotator-setup-goal\" >nul 2>&1
        )
        if exist "apps\skills\extra\plannotator-visual-explainer" (
            if exist "!KIRO_SKILLS_DIR!\plannotator-visual-explainer" rmdir /s /q "!KIRO_SKILLS_DIR!\plannotator-visual-explainer" >nul 2>&1
            xcopy /s /i /y /q "apps\skills\extra\plannotator-visual-explainer" "!KIRO_SKILLS_DIR!\plannotator-visual-explainer\" >nul 2>&1
        )
        REM Plannotator custom agent - don't clobber a user's existing one.
        if not exist "!KIRO_AGENTS_DIR!\plannotator.json" if exist "apps\kiro-cli\agents\plannotator.json" (
            if not exist "!KIRO_AGENTS_DIR!" mkdir "!KIRO_AGENTS_DIR!"
            copy /y "apps\kiro-cli\agents\plannotator.json" "!KIRO_AGENTS_DIR!\plannotator.json" >nul 2>&1
        )
        echo Installed Kiro skills to !KIRO_SKILLS_DIR!\ and agent to !KIRO_AGENTS_DIR!\plannotator.json
    )

    REM Qwen Code: its own copies of review, annotate and last ^(they run the
    REM command in the background, past the shell tool's time limit^). Qwen
    REM reads QWEN_DIR\skills before ~/.agents/skills, so these take the place
    REM of the shared copies. The extension is copied out of the checkout here
    REM and installed after this block ^(:InstallQwenExtension^). A Qwen opt-out,
    REM or a Qwen Code too old for plan review, leaves QWEN_DIR untouched.
    if "!QWEN_AVAILABLE!"=="1" if "!SKIP_QWEN!"=="0" if "!QWEN_TOO_OLD!"=="0" if exist "apps\qwen-code\skills" (
        if not exist "!QWEN_SKILLS_DIR!" mkdir "!QWEN_SKILLS_DIR!"
        for %%S in (plannotator-review plannotator-annotate plannotator-last) do (
            if exist "apps\qwen-code\skills\%%S" (
                if exist "!QWEN_SKILLS_DIR!\%%S" rmdir /s /q "!QWEN_SKILLS_DIR!\%%S" >nul 2>&1
                xcopy /s /i /y /q "apps\qwen-code\skills\%%S" "!QWEN_SKILLS_DIR!\%%S\" >nul 2>&1
            )
        )
        echo Installed Qwen Code skills to !QWEN_SKILLS_DIR!\
        set "QWEN_SKILLS_INSTALLED=1"
    )
    if "!QWEN_AVAILABLE!"=="1" if "!SKIP_QWEN!"=="0" if "!QWEN_TOO_OLD!"=="0" if exist "apps\qwen-code\extension\qwen-extension.json" (
        xcopy /s /i /y /q "apps\qwen-code\extension" "!SKILLS_TMP!\qwen-extension\" >nul 2>&1
    )

    REM Vibe - no skills are copied to !VIBE_HOME! on Windows. The apps\vibe
    REM skills use a POSIX env-prefix that Vibe's PowerShell fallback cannot
    REM run; Vibe reads the shell-neutral core skills from ~/.agents/skills.

    popd
) else (
    set "CHECKOUT_FAILED=1"
)

:skills_checkout_done
REM The Qwen Code extension, outside any parenthesized block. See :InstallQwenExtension.
if "!CHECKOUT_FAILED!"=="0" if "!QWEN_AVAILABLE!"=="1" call :InstallQwenExtension
rmdir /s /q "!SKILLS_TMP!" >nul 2>&1

if "!CHECKOUT_FAILED!"=="1" (
    echo Error: unable to fetch !REPO! at !TAG! ^(network or git error^). 1>&2
    if exist "!GIT_ERR_FILE!" (
        echo git reported: 1>&2
        type "!GIT_ERR_FILE!" 1>&2
        del /q "!GIT_ERR_FILE!" >nul 2>&1
    )
    echo Something went wrong - run the installer again. 1>&2
    exit /b 1
)
del /q "!GIT_ERR_FILE!" >nul 2>&1

REM Claude Code commands are deprecated in favor of skills. Remove a legacy
REM command file only once its replacement skill is actually on disk - running
REM AFTER the install above guarantees a failed or skipped skill install never
REM leaves users with neither the command nor the skill.
REM A skills opt-out installed no replacement this run, so it removes nothing
REM either - skip means do-not-write, never remove.
for %%C in (plannotator-review plannotator-annotate plannotator-last) do (
    if "!SKIP_SKILLS!"=="0" if exist "!CLAUDE_SKILLS_DIR!\%%C" if exist "!CLAUDE_COMMANDS_DIR!\%%C.md" (
        del /q "!CLAUDE_COMMANDS_DIR!\%%C.md" >nul 2>&1
        echo Removed deprecated Claude command !CLAUDE_COMMANDS_DIR!\%%C.md ^(replaced by the %%C skill^)
    )
)

REM plannotator-archive no longer ships as a skill. Remove any stale installed
REM copy from every skill scope so upgraders don't keep a dead skill around.
for %%D in ("!CLAUDE_SKILLS_DIR!" "!AGENTS_SKILLS_DIR!" "!KIRO_SKILLS_DIR!") do (
    REM A Kiro opt-out leaves ~/.kiro entirely untouched - including this sweep.
    REM A skills opt-out leaves every skill scope untouched, sweep included.
    set "SCOPE_OK=1"
    if "!SKIP_SKILLS!"=="1" set "SCOPE_OK=0"
    if /i "%%~D"=="!KIRO_SKILLS_DIR!" if "!SKIP_KIRO!"=="1" set "SCOPE_OK=0"
    if "!SCOPE_OK!"=="1" if exist "%%~D\plannotator-archive" (
        rmdir /s /q "%%~D\plannotator-archive" >nul 2>&1
        echo Removed stale plannotator-archive skill from %%~D\plannotator-archive
    )
)

REM The /plannotator-archive OpenCode command was removed too - sweep the stub.
REM An OpenCode opt-out suspends the sweep: skip means do-not-write, never remove.
REM A skills opt-out suspends it for the same reason.
if "!SKIP_OPENCODE!"=="0" if "!SKIP_SKILLS!"=="0" if exist "!OPENCODE_COMMANDS_DIR!\plannotator-archive.md" (
    del /q "!OPENCODE_COMMANDS_DIR!\plannotator-archive.md" >nul 2>&1
    echo Removed stale plannotator-archive command from !OPENCODE_COMMANDS_DIR!
)

REM Codex no longer hosts core skills (they live in %%USERPROFILE%%\.agents\skills).
REM Core skills are removed only once their replacement exists; the stale
REM shared-agent extras were never Codex's and are removed unconditionally.
for %%S in (plannotator-review plannotator-annotate plannotator-last plannotator-compound plannotator-setup-goal) do (
    REM A Codex opt-out leaves the Codex home entirely untouched - including
    REM this stale-skill cleanup. Skip means do-not-write, never remove. A
    REM skills opt-out installed no replacement, so it suspends the sweep too.
    if "!SKIP_CODEX!"=="0" if "!SKIP_SKILLS!"=="0" if exist "!STALE_CODEX_SKILLS_DIR!\%%S" (
        set "OK_REMOVE=1"
        if "%%S"=="plannotator-review" if not exist "!AGENTS_SKILLS_DIR!\%%S" set "OK_REMOVE=0"
        if "%%S"=="plannotator-annotate" if not exist "!AGENTS_SKILLS_DIR!\%%S" set "OK_REMOVE=0"
        if "%%S"=="plannotator-last" if not exist "!AGENTS_SKILLS_DIR!\%%S" set "OK_REMOVE=0"
        if "!OK_REMOVE!"=="1" (
            rmdir /s /q "!STALE_CODEX_SKILLS_DIR!\%%S" >nul 2>&1
            echo Removed Plannotator skill from !STALE_CODEX_SKILLS_DIR!\%%S
        )
    )
)

REM Apply the saved model-invocation choices. Installed skill copies always
REM arrive locked (disable-model-invocation: true in SKILL.md); for each
REM chosen skill we unlock the INSTALLED copy by removing that line, and flip
REM the Codex sidecar's allow_implicit_invocation to match. Re-applied on
REM every run because installs replace the skill folders wholesale.
REM A skills opt-out installed no skill copies this run, so there is nothing to
REM unlock - and rewriting a PREVIOUS run's SKILL.md would be a write the
REM opt-out promised not to make.
if "!SKIP_SKILLS!"=="0" if defined INVOCABLE_CHOICE if not "!INVOCABLE_CHOICE!"=="none" (
    for %%K in ("!INVOCABLE_CHOICE:,=" "!") do (
        for %%D in ("!CLAUDE_SKILLS_DIR!" "!AGENTS_SKILLS_DIR!" "!QWEN_SKILLS_DIR!") do (
            REM A Qwen opt-out ^(or a Qwen Code too old for plan review^) leaves
            REM QWEN_DIR untouched, a previous run's copies included.
            set "SCOPE_OK=1"
            if /i "%%~D"=="!QWEN_SKILLS_DIR!" if not "!QWEN_AVAILABLE!!SKIP_QWEN!!QWEN_TOO_OLD!"=="100" set "SCOPE_OK=0"
            if "!SCOPE_OK!"=="1" if exist "%%~D\%%~K\SKILL.md" (
                findstr /c:"disable-model-invocation: true" "%%~D\%%~K\SKILL.md" >nul 2>&1
                if !ERRORLEVEL! equ 0 (
                    findstr /v /c:"disable-model-invocation: true" "%%~D\%%~K\SKILL.md" > "%%~D\%%~K\SKILL.md.tmp"
                    move /y "%%~D\%%~K\SKILL.md.tmp" "%%~D\%%~K\SKILL.md" >nul 2>&1
                    echo Enabled model invocation: %%~D\%%~K
                )
            )
            if exist "%%~D\%%~K\agents\openai.yaml" (
                findstr /c:"allow_implicit_invocation: false" "%%~D\%%~K\agents\openai.yaml" >nul 2>&1
                if !ERRORLEVEL! equ 0 (
                    powershell -NoProfile -Command "(Get-Content '%%~D\%%~K\agents\openai.yaml' -Raw) -replace 'allow_implicit_invocation: false','allow_implicit_invocation: true' | Set-Content '%%~D\%%~K\agents\openai.yaml' -NoNewline"
                )
            )
        )
    )
)

REM Update Pi extension if pi is installed. Pi keeps its 6 extension commands
REM and the plannotator_submit_plan tool; it no longer bundles skills, so there
REM is no settings.json package-skills filter to configure. See :UpdatePiExtension.
where pi >nul 2>&1
if !ERRORLEVEL! equ 0 call :UpdatePiExtension

REM --- Gemini CLI support (only if Gemini is installed) ---
REM HONEST three-state reporting (#1178): detected-but-skipped is its own
REM state. A Gemini opt-out leaves ~/.gemini entirely untouched.
if exist "%USERPROFILE%\.gemini" if "!SKIP_GEMINI!"=="1" (
    echo.
    echo Gemini: detected, skipped ^(!SKIP_GEMINI_SOURCE!^).
    if exist "%USERPROFILE%\.gemini\settings.json" (
        findstr /c:"plannotator" "%USERPROFILE%\.gemini\settings.json" >nul 2>&1
        if !ERRORLEVEL! equ 0 echo An existing Gemini integration at %USERPROFILE%\.gemini\settings.json was left untouched.
    )
)
if exist "%USERPROFILE%\.gemini" if "!SKIP_GEMINI!"=="0" (
    REM Install policy file
    if not exist "%USERPROFILE%\.gemini\policies" mkdir "%USERPROFILE%\.gemini\policies"
    (
echo # Plannotator policy for Gemini CLI
echo # Allows exit_plan_mode without TUI confirmation so the browser UI is the sole gate.
echo [[rule]]
echo toolName = "exit_plan_mode"
echo decision = "allow"
echo priority = 100
    ) > "%USERPROFILE%\.gemini\policies\plannotator.toml"
    echo Installed Gemini policy to %USERPROFILE%\.gemini\policies\plannotator.toml

    REM Configure hook in settings.json
    if not exist "%USERPROFILE%\.gemini\settings.json" (
        (
echo {
echo   "hooks": {
echo     "BeforeTool": [
echo       {
echo         "matcher": "exit_plan_mode",
echo         "hooks": [
echo           {
echo             "type": "command",
echo             "command": "plannotator",
echo             "timeout": 345600
echo           }
echo         ]
echo       }
echo     ]
echo   },
echo   "experimental": {
echo     "plan": true
echo   }
echo }
        ) > "%USERPROFILE%\.gemini\settings.json"
        echo Created Gemini settings at %USERPROFILE%\.gemini\settings.json
    ) else (
        findstr /c:"plannotator" "%USERPROFILE%\.gemini\settings.json" >nul 2>&1
        if !ERRORLEVEL! neq 0 (
            REM Merge hook into existing settings.json using node (ships with Gemini CLI)
            where node >nul 2>&1
            if !ERRORLEVEL! equ 0 (
                set "GEMINI_SETTINGS_PATH=%USERPROFILE%\.gemini\settings.json"
                set "GEMINI_SETTINGS_FWD=!GEMINI_SETTINGS_PATH:\=/!"
                node -e "const fs=require('fs');const s=JSON.parse(fs.readFileSync('!GEMINI_SETTINGS_FWD!','utf8'));s.hooks=s.hooks||{};s.hooks.BeforeTool=s.hooks.BeforeTool||[];s.hooks.BeforeTool.push({matcher:'exit_plan_mode',hooks:[{type:'command',command:'plannotator',timeout:345600}]});fs.writeFileSync('!GEMINI_SETTINGS_FWD!',JSON.stringify(s,null,2)+'\n');"
                echo Added plannotator hook to !GEMINI_SETTINGS_PATH!
            ) else (
                echo.
                echo Add the following to your ~/.gemini/settings.json hooks:
                echo.
                echo   "hooks": {
                echo     "BeforeTool": [{
                echo       "matcher": "exit_plan_mode",
                echo       "hooks": [{"type": "command", "command": "plannotator", "timeout": 345600}]
                echo     }]
                echo   }
            )
        )
    )

    REM Gemini slash commands (plannotator-*.toml) are copied from the sparse
    REM checkout in the git-gated skills/commands block above, not written here.
)

if "!SKIP_OPENCODE!"=="1" (
    echo.
    echo OpenCode: integration skipped ^(!SKIP_OPENCODE_SOURCE!^).
    echo No command stubs were written and OpenCode's plugin cache was left alone.
    echo Re-run without the opt-out to install the command stubs.
)

REM The KIRO CLI USERS section prints only when this run detected Kiro
REM (KIRO_AVAILABLE, computed above); a detected-but-skipped Kiro keeps its
REM honest "detected, skipped" lines. Output only: nothing here decides what
REM installs.
if "!KIRO_AVAILABLE!"=="1" (
    echo.
    echo ==========================================
    echo   KIRO CLI USERS
    echo ==========================================
    echo.
    if "!SKIP_KIRO!"=="1" (
        echo Kiro was detected, but the integration was skipped ^(!SKIP_KIRO_SOURCE!^).
        echo No files under %USERPROFILE%\.kiro were written or removed. Re-run
        echo without the opt-out to add Kiro skills.
    ) else if "!SKIP_SKILLS!"=="1" (
        echo Kiro was detected, but skills were skipped ^(!SKIP_SKILLS_SOURCE!^), so no
        echo Kiro skills or agent were installed. Re-run without the opt-out to add them.
    ) else (
        echo Kiro skills are installed to %USERPROFILE%\.kiro\skills\
        echo The Plannotator agent is installed to %USERPROFILE%\.kiro\agents\plannotator.json
        echo Launch it: kiro-cli chat --agent plannotator
    )
)

REM The Vibe section prints only when Vibe was detected; without a Vibe home
REM the installer says nothing about Vibe at all.
if "!VIBE_AVAILABLE!"=="1" (
    echo.
    echo ==========================================
    echo   VIBE USERS
    echo ==========================================
    echo.
    if "!SKIP_VIBE!"=="1" (
        echo Vibe was detected, but the integration was skipped ^(!SKIP_VIBE_SOURCE!^).
        echo No files under !VIBE_HOME! were written or removed.
    ) else (
        echo Vibe detected. The Windows installer writes nothing under !VIBE_HOME!.
        echo Vibe uses the shared review and annotate skills from ~/.agents/skills
        echo ^(/plannotator-last is not supported for Vibe on Windows yet^). The
        echo plan-review hook is macOS/Linux-only; see the manual setup instructions
        echo printed above to wire plan review on a macOS/Linux box.
        echo Note: improve-context ^(plan-mode enrichment^) is not wired for Vibe.
    )
)

REM The Qwen Code section prints only when Qwen Code was detected.
if "!QWEN_AVAILABLE!"=="1" (
    echo.
    echo ==========================================
    echo   QWEN CODE USERS
    echo ==========================================
    echo.
    if "!SKIP_QWEN!"=="1" (
        echo Qwen Code was detected, but the integration was skipped ^(!SKIP_QWEN_SOURCE!^).
        echo No extension was installed or removed, and no files under !QWEN_DIR! were
        echo written. Re-run without the opt-out to add plan review and the skills.
    ) else if "!SKIP_SKILLS!"=="1" (
        echo Qwen Code was detected, but skills were skipped ^(!SKIP_SKILLS_SOURCE!^). The
        echo Qwen Code extension and skills come from the same download, so neither was
        echo installed or changed. Re-run without the opt-out to add them.
    ) else if "!QWEN_TOO_OLD!"=="1" (
        echo Qwen Code is older than 0.13.0, the first release that runs extension
        echo hooks, so nothing was installed for it. Update Qwen Code to use plan
        echo review, then re-run this installer.
    ) else (
        if "!QWEN_EXTENSION_STATE!"=="ok" (
            echo Plan review: when the agent calls exit_plan_mode, the plan opens in your
            echo browser. After you approve it there, Qwen Code asks you to confirm the plan
            echo once more in the terminal. Restart Qwen Code to load a new extension.
        ) else if "!QWEN_EXTENSION_STATE!"=="ok-off" (
            echo The plannotator extension is turned off in Qwen Code ^(in some or all
            echo projects^), and it stays off. Where it is off, plan review is off. To
            echo turn it on: qwen extensions enable plannotator
        ) else if "!QWEN_EXTENSION_STATE!"=="linked" (
            echo The plannotator extension is linked from a local folder ^(qwen extensions
            echo link^), so this installer left it as it is.
        ) else if "!QWEN_EXTENSION_STATE!"=="foreign" (
            echo The plannotator extension was installed from another source ^(see above^),
            echo not by this installer, so it was left as it is. To let this installer
            echo manage it, run: qwen extensions uninstall plannotator
            echo and re-run this installer.
        ) else if "!QWEN_EXTENSION_STATE!"=="no-cli" (
            echo The qwen command was not found, so the plan-review extension was not
            echo installed. Put qwen on PATH and re-run this installer.
        ) else if "!QWEN_EXTENSION_STATE!"=="not-in-tag" (
            echo This release has no Qwen Code extension. Install a newer release for plan review.
        ) else (
            echo The plan-review extension could not be installed ^(see the message above^).
            echo Re-run this installer to try again.
        )
        if "!QWEN_SKILLS_INSTALLED!"=="1" (
            echo.
            echo Skills are installed to !QWEN_SKILLS_DIR!\:
            echo   /plannotator-review, /plannotator-annotate, /plannotator-last
        )
    )
)

echo.
echo Test the install:
echo   echo {"tool_input":{"plan":"# Test Plan\\n\\nHello world"}} ^| plannotator
echo.
if "!CLAUDE_PLUGIN_STATE!"=="updated" (
    echo The Claude Code plugin was updated. Restart Claude Code to load it.
) else if "!CLAUDE_PLUGIN_STATE!"=="current" (
    echo The Claude Code plugin is up to date.
) else if "!CLAUDE_PLUGIN_STATE!"=="none" (
    echo Then install the Claude Code plugin:
    echo   /plugin marketplace add backnotprop/plannotator
    echo   /plugin install plannotator@plannotator
    echo.
    echo Updating the plugin? Run these in a terminal, then restart Claude Code:
    echo   claude plugin marketplace update plannotator
    echo   claude plugin update plannotator@plannotator --scope user
) else if "!CLAUDE_PLUGIN_STATE!"=="no-marketplace" (
    echo Re-add the Claude Code plugin's marketplace: run these in a terminal, then restart Claude Code:
    echo   claude plugin marketplace add backnotprop/plannotator
    echo   claude plugin update plannotator@plannotator --scope user
) else (
    echo Update the Claude Code plugin: run these in a terminal, then restart Claude Code:
    echo   claude plugin marketplace update plannotator
    echo   claude plugin update plannotator@plannotator --scope user
)
echo.
REM Never claim the /plannotator-* skills are ready when nothing was installed -
REM that false banner is exactly what the skills-checkout guard exists to prevent.
if "!SKIP_SKILLS!"=="1" (
    echo Skills were skipped ^(!SKIP_SKILLS_SOURCE!^), so the /plannotator-review,
    echo /plannotator-annotate, and /plannotator-last skills are NOT installed.
    echo Re-run the installer without the opt-out to add them.
) else (
    echo The /plannotator-review, /plannotator-annotate, and /plannotator-last skills are ready to use!
)
if "!SKIP_SKILLS!"=="0" if not "!EXTRAS_CHOICE!"=="yes" (
    echo.
    echo Optional skills ^(compound planning, setup-goal, visual explainer^):
    echo   npx skills add backnotprop/plannotator/apps/skills/extra --global
)

REM Warn if plannotator is configured in both settings.json hooks AND the plugin (causes double execution)
REM Only warn when the plugin is installed - manual-only users won't have overlap
if defined CLAUDE_CONFIG_DIR (
    set "CLAUDE_SETTINGS=%CLAUDE_CONFIG_DIR%\settings.json"
) else (
    set "CLAUDE_SETTINGS=%USERPROFILE%\.claude\settings.json"
)
if exist "!PLUGIN_HOOKS!" if exist "!CLAUDE_SETTINGS!" (
    findstr /r /c:"\"command\".*plannotator" "!CLAUDE_SETTINGS!" >nul 2>&1
    if !ERRORLEVEL! equ 0 (
        echo.
        echo WARNING: DUPLICATE HOOK DETECTED
        echo.
        echo   plannotator was found in your settings.json hooks:
        echo   !CLAUDE_SETTINGS!
        echo.
        echo   This will cause plannotator to run TWICE on each plan review.
        echo   Remove the plannotator hook from settings.json and rely on the
        echo   plugin instead ^(installed automatically via marketplace^).
        echo.
    )
)

REM The full install completed: remember its command-line flags for auto-update.
call :WriteInstallFlags

echo.
exit /b 0

REM ======================================================================
REM Remember the install-affecting choices this run took from COMMAND-LINE
REM flags (#1634), so a background auto-update re-runs the installer with the
REM same ones. Only the known flag set is written, as neutral ids shared with
REM install.sh / install.ps1 (never raw arguments, paths, or secrets); env vars
REM and config.json survive on their own and are not recorded. A run with none
REM of these flags writes an empty set, which is how a manual re-run with no
REM flags goes back to defaults. Best effort: a failed write never fails the
REM install.
REM ======================================================================
:WriteInstallFlags
set "IFL="
if "!MINIMAL_FLAG!"=="1" call :AddInstallFlag minimal
if "!MINIMAL_FLAG!"=="0" call :AddInstallFlag no-minimal
if "!VERIFY_ATTESTATION_FLAG!"=="1" call :AddInstallFlag verify-attestation
if "!VERIFY_ATTESTATION_FLAG!"=="0" call :AddInstallFlag skip-attestation
if "!WITH_CALL_FLOW_FLAG!"=="1" call :AddInstallFlag with-call-flow
if "!SKIP_CODEX_FLAG!"=="1" call :AddInstallFlag skip-codex
if "!SKIP_GEMINI_FLAG!"=="1" call :AddInstallFlag skip-gemini
if "!SKIP_KIRO_FLAG!"=="1" call :AddInstallFlag skip-kiro
if "!SKIP_VIBE_FLAG!"=="1" call :AddInstallFlag skip-vibe
if "!SKIP_OPENCODE_FLAG!"=="1" call :AddInstallFlag skip-opencode
if "!SKIP_QWEN_FLAG!"=="1" call :AddInstallFlag skip-qwen
if "!SKIP_SKILLS_FLAG!"=="1" call :AddInstallFlag skip-skills
if "!SKIP_CLAUDE_PLUGIN_FLAG!"=="1" call :AddInstallFlag skip-claude-plugin
if not exist "!_CONFIG_DIR!" mkdir "!_CONFIG_DIR!" >nul 2>&1
>"!_CONFIG_DIR!\install-flags.json.tmp" echo {"v":1,"flags":[!IFL!]}
if exist "!_CONFIG_DIR!\install-flags.json.tmp" move /y "!_CONFIG_DIR!\install-flags.json.tmp" "!_CONFIG_DIR!\install-flags.json" >nul 2>&1
goto :eof

REM ======================================================================
REM :RepairLegacyPluginHooks - restore the Claude Code marketplace clone's
REM apps/hook/hooks/hooks.json from its git HEAD when (and only when) it is
REM an earlier installer's rewrite: it must differ from HEAD and, with all
REM whitespace removed, match PLN_HOOKS_RE exactly. PLN_HOOKS_RE is the same
REM pattern as LEGACY_PLUGIN_HOOKS_RE in install.sh and $legacyPluginHooksRe
REM in install.ps1 (keep the three in step), written with \x22 / \x5c and
REM \A / \z so it carries no quote, pipe, percent or exclamation mark for
REM cmd.exe to parse (the one caret, in [^...], is literal inside the quoted
REM set on a line with no exclamation mark). Needs git; best effort, never
REM fails the install.
REM ======================================================================
:RepairLegacyPluginHooks
where git >nul 2>&1
if errorlevel 1 goto :eof
set "PLN_PLUGIN_CLONE=!PLUGIN_MARKETPLACE_DIR!"
set "PLN_HOOKS_RE=\A\{\x22hooks\x22:\{(\x22PreToolUse\x22:\[\{\x22matcher\x22:\x22EnterPlanMode\x22,\x22hooks\x22:\[\{\x22type\x22:\x22command\x22,\x22command\x22:\x22(\x5c\x22)?[^\x22\x5c]*plannotator(\.exe)?(\x5c\x22)?improve-context\x22,\x22timeout\x22:5\}\]\}\],)?\x22PermissionRequest\x22:\[\{\x22matcher\x22:\x22ExitPlanMode\x22,\x22hooks\x22:\[\{\x22type\x22:\x22command\x22,\x22command\x22:\x22(\x5c\x22)?[^\x22\x5c]*plannotator(\.exe)?(\x5c\x22)?\x22,\x22timeout\x22:345600\}\]\}\]\}\}\z"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c = $env:PLN_PLUGIN_CLONE; $r = 'apps/hook/hooks/hooks.json'; $f = Join-Path $c 'apps\hook\hooks\hooks.json'; if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { exit 0 }; git -C $c cat-file -e ('HEAD:' + $r) 2>$null; if ($LASTEXITCODE -ne 0) { exit 0 }; git -C $c diff --quiet HEAD -- $r 2>$null; if ($LASTEXITCODE -ne 1) { exit 0 }; $t = Get-Content -LiteralPath $f -Raw; if ($null -eq $t) { exit 0 }; if (($t -replace '[\s\uFEFF]', '') -notmatch $env:PLN_HOOKS_RE) { exit 0 }; git -C $c checkout -q -- $r 2>$null; if ($LASTEXITCODE -eq 0) { Write-Output ('Restored ' + $f + ' from its git checkout (an earlier installer had rewritten it).') }"
set "PLN_PLUGIN_CLONE="
set "PLN_HOOKS_RE="
goto :eof

REM ======================================================================
REM :UpdateClaudePlugin - update an installed Claude Code plugin (see the call
REM site). Same steps as update_claude_plugin_if_installed in install.sh and
REM Update-ClaudePluginIfInstalled in install.ps1 (keep the three in step):
REM read the user-scope plannotator@plannotator record from
REM <claude config>\plugins\installed_plugins.json; without one do nothing;
REM without a claude CLI on PATH, or when opted out, run nothing; otherwise run
REM `claude plugin marketplace update plannotator` then `claude plugin update
REM plannotator@plannotator --scope user`, each started directly with its stdin pipe
REM closed at once (a claude that exits first is not an error) and a time
REM limit (PLANNOTATOR_CLAUDE_PLUGIN_TIMEOUT seconds, default 120, an internal
REM knob for the tests), and report updated / already up to date from the
REM record, or the manual commands on failure. The PowerShell reports its state
REM as its exit code (0 none, 20 no CLI, 21 skipped, 22 updated, 23 current,
REM 24 failed, 25 marketplace missing). A --version pin (TAG is not the release
REM auto-update resolved, PLANNOTATOR_UPDATE_VERSION) skips it like an opt-out.
REM The plugin update always passes --scope user (current Claude Code would
REM auto-detect a project scope). Inputs travel in PLN_CP_REGISTRY / PLN_CP_SKIP /
REM PLN_CP_PINNED, never interpolated; the command carries no double quote,
REM percent sign or exclamation mark for cmd.exe to parse. Called outside any
REM parenthesized block. Best effort: never fails the install.
REM ======================================================================
:UpdateClaudePlugin
if defined CLAUDE_CONFIG_DIR (
    set "PLN_CP_REGISTRY=%CLAUDE_CONFIG_DIR%\plugins\installed_plugins.json"
) else (
    set "PLN_CP_REGISTRY=%USERPROFILE%\.claude\plugins\installed_plugins.json"
)
if not exist "!PLN_CP_REGISTRY!" (
    set "PLN_CP_REGISTRY="
    goto :eof
)
set "PLN_CP_SKIP="
if "!SKIP_CLAUDE_PLUGIN!"=="1" set "PLN_CP_SKIP=!SKIP_CLAUDE_PLUGIN_SOURCE!"
set "PLN_CP_PINNED="
if /i not "!VERSION!"=="latest" if not "!TAG!"=="!PLANNOTATOR_UPDATE_VERSION!" set "PLN_CP_PINNED=!TAG!"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Continue'; $id = 'plannotator@plannotator'; $reg = $env:PLN_CP_REGISTRY; function Rec { if (-not (Test-Path -LiteralPath $reg -PathType Leaf)) { return $null }; try { $j = Get-Content -LiteralPath $reg -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop } catch { return $null }; if ($null -eq $j -or $null -eq $j.plugins) { return $null }; $e = $j.plugins.$id; if ($null -eq $e) { return $null }; return @($e) | Where-Object { $null -ne $_ -and ((-not $_.scope) -or ($_.scope -eq 'user')) } | Select-Object -First 1 }; function Fp($r) { if ($null -eq $r) { return '||' }; return [string]$r.version + '|' + [string]$r.gitCommitSha + '|' + [string]$r.installPath }; function Run($a) { $si = New-Object System.Diagnostics.ProcessStartInfo; $si.FileName = $cl; $si.Arguments = ($a -join ' '); $si.UseShellExecute = $false; $si.RedirectStandardInput = $true; $si.RedirectStandardOutput = $true; $si.RedirectStandardError = $true; $si.CreateNoWindow = $true; try { $p = [System.Diagnostics.Process]::Start($si) } catch { return 'could not run claude: ' + $_.Exception.Message }; try { $p.StandardInput.Close() } catch { }; $to = $p.StandardOutput.ReadToEndAsync(); $te = $p.StandardError.ReadToEndAsync(); if (-not $p.WaitForExit($secs * 1000)) { try { $p.Kill($true) } catch { try { $null = & taskkill /T /F /PID $p.Id 2>$null } catch { }; try { $p.Kill() } catch { } }; return 'timed out after ' + $secs + 's' }; $p.WaitForExit(); if ($p.ExitCode -eq 0) { return '' }; $tx = @(); foreach ($t in @($te, $to)) { $v = ''; try { if ($t.Wait(5000)) { $v = [string]$t.Result } } catch { }; $tx += $v }; foreach ($m in @($tx | ForEach-Object { $_ -split '\r?\n' })) { if ($m -match 'marketplace' -and $m -match 'not found|not exist|no such|unknown') { $script:mm = $true } }; $l = $null; foreach ($v in $tx) { $l = @($v -split '\r?\n') | ForEach-Object { ($_ -replace '[^\x20-\x7E]', '').Trim() } | Where-Object { $_ } | Select-Object -Last 1; if ($l) { break } }; if ($l -and $l.Length -gt 200) { $l = $l.Substring(0, 200) }; if ($l) { return 'claude exited ' + $p.ExitCode + ': ' + $l }; return 'claude exited ' + $p.ExitCode }; function Manual { Write-Output '  claude plugin marketplace update plannotator'; Write-Output ('  claude plugin update ' + $id + ' --scope user') }; function Readd { Write-Output '  claude plugin marketplace add backnotprop/plannotator'; Write-Output ('  claude plugin update ' + $id + ' --scope user') }; $r = Rec; if ($null -eq $r) { exit 0 }; $c = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; if (-not $c) { exit 20 }; $cl = $c.Source; if ($env:PLN_CP_SKIP) { Write-Output ('Claude Code plugin: not updated (' + $env:PLN_CP_SKIP + ').'); exit 21 }; if ($env:PLN_CP_PINNED) { Write-Output ('Claude Code plugin: not updated: pinned to ' + $env:PLN_CP_PINNED + '; updating would install the newest plugin.'); exit 21 }; $secs = 120; if ($env:PLANNOTATOR_CLAUDE_PLUGIN_TIMEOUT -match '^[1-9][0-9]*$') { $secs = [int]$env:PLANNOTATOR_CLAUDE_PLUGIN_TIMEOUT }; $b = Fp $r; Remove-Item Env:CLAUDECODE -ErrorAction SilentlyContinue; Write-Output 'Updating the Claude Code plugin...'; $script:mm = $false; $x = Run @('plugin', 'marketplace', 'update', 'plannotator'); if (-not $x) { $x = Run @('plugin', 'update', $id, '--scope', 'user') }; if ($x -and $script:mm) { Write-Output 'Claude Code plugin: could not update it (the plannotator marketplace is not registered). Re-add it, then restart Claude Code:'; Readd; exit 25 }; if ($x) { Write-Output ('Claude Code plugin: could not update it (' + $x + '). Run these, then restart Claude Code:'); Manual; exit 24 }; $r = Rec; $a = Fp $r; $v = ''; if ($r -and $r.version) { $v = [string]$r.version }; if ($a -eq '||' -or $b -ne $a) { if ($v) { $v = ' to ' + $v }; Write-Output ('Claude Code plugin: updated' + $v + ' (restart Claude Code to load it).'); exit 22 }; if ($v) { $v = ' (' + $v + ')' }; Write-Output ('Claude Code plugin: already up to date' + $v + '.'); exit 23"
set "PLN_CP_RC=!ERRORLEVEL!"
if "!PLN_CP_RC!"=="20" set "CLAUDE_PLUGIN_STATE=manual"
if "!PLN_CP_RC!"=="21" set "CLAUDE_PLUGIN_STATE=skipped"
if "!PLN_CP_RC!"=="22" set "CLAUDE_PLUGIN_STATE=updated"
if "!PLN_CP_RC!"=="23" set "CLAUDE_PLUGIN_STATE=current"
if "!PLN_CP_RC!"=="24" set "CLAUDE_PLUGIN_STATE=failed"
if "!PLN_CP_RC!"=="25" set "CLAUDE_PLUGIN_STATE=no-marketplace"
set "PLN_CP_RC="
set "PLN_CP_REGISTRY="
set "PLN_CP_SKIP="
set "PLN_CP_PINNED="
goto :eof

REM ======================================================================
REM Pi extension (#902), the same logic as install.sh / install.ps1.
REM `pi install npm:@plannotator/pi-extension` runs a bare `npm install` that
REM may settle on an older version and still exit 0 (npm passes over a release
REM whose engines the running Node does not meet; a registry mirror can lag).
REM So an install Pi's settings already list is updated with Pi's own `pi
REM update <source>`, which installs <name>@latest by name (falling back to
REM `pi install` when it fails); a first install that landed on an older
REM version gets the same `pi update`. The version on disk is read back where
REM Pi loads it from (<agent dir>\npm\node_modules, else the global npm root),
REM and installed/updated is said only when it reached this release; otherwise
REM one line names the cause it can see (the release not on the npm registry
REM yet) and the command to run. The step never pins a version in Pi's
REM settings; a version the person pinned is left alone with the command that
REM moves it. Nothing is removed first, so a failed step leaves the install as
REM it was.
REM The release travels in PLN_PI_TARGET, never interpolated; the command
REM carries no double quote, percent sign, exclamation mark or caret for
REM cmd.exe to parse (quote, caret and apostrophe come from [char]). Called
REM outside any parenthesized block. Best effort: never fails the install.
REM ======================================================================
:UpdatePiExtension
set "PLN_PI_TARGET=!TAG!"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Continue'; $q = [char]34; $src = 'npm:@plannotator/pi-extension'; $t = ([string]$env:PLN_PI_TARGET).TrimStart('v'); $d = $env:PI_CODING_AGENT_DIR; if (-not $d) { $d = Join-Path (Join-Path $env:USERPROFILE '.pi') 'agent' } elseif ($d -eq '~') { $d = $env:USERPROFILE } elseif ($d.StartsWith('~/') -or $d.StartsWith('~\')) { $d = Join-Path $env:USERPROFILE $d.Substring(2) }; function Ver { $p = Join-Path (Join-Path (Join-Path (Join-Path $d 'npm') 'node_modules') '@plannotator') 'pi-extension'; if (-not (Test-Path -LiteralPath $p -PathType Container)) { $p = $null; if (Get-Command npm -ErrorAction SilentlyContinue) { $r = $null; try { $r = & npm root -g 2>$null | Select-Object -First 1 } catch { }; if ($r) { $p = Join-Path (Join-Path ([string]$r).Trim() '@plannotator') 'pi-extension' } } }; if (-not $p) { return '' }; $j = Join-Path $p 'package.json'; if (-not (Test-Path -LiteralPath $j -PathType Leaf)) { return '' }; try { return [string](Get-Content -LiteralPath $j -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop).version } catch { return '' } }; function AtLeast($a, $b) { $x = @(((([string]$a).TrimStart('v') -split '[-+]')[0]).Split('.')); $y = @(((([string]$b).TrimStart('v') -split '[-+]')[0]).Split('.')); for ($i = 0; $i -lt 3; $i++) { $m = 0; $n = 0; if ($i -lt $x.Count) { [void][int]::TryParse($x[$i], [ref]$m) }; if ($i -lt $y.Count) { [void][int]::TryParse($y[$i], [ref]$n) }; if ($m -gt $n) { return $true }; if ($m -lt $n) { return $false } }; return $true }; $s = Join-Path $d 'settings.json'; $txt = ''; if (Test-Path -LiteralPath $s -PathType Leaf) { try { $txt = [string](Get-Content -LiteralPath $s -Raw -ErrorAction Stop) } catch { } }; if ($txt -match ($q + 'npm:@plannotator/pi-extension@v?([0-9]+\.[0-9]+\.[0-9][0-9A-Za-z.+-]*)' + $q)) { Write-Output ('Pi extension: pinned to ' + $Matches[1] + ' in Pi' + [char]39 + 's settings, left as is. To move it: pi install ' + $src + '@' + $t); exit 0 }; $fresh = $false; $b = ''; if (-not ($txt -match ($q + 'npm:@plannotator/pi-extension(@[' + [char]94 + $q + ']*)?' + $q))) { $fresh = $true; Write-Output 'Installing Pi extension...'; & pi install $src; if ($LASTEXITCODE -ne 0) { Write-Output 'Skipping Pi extension install (pi install failed)'; exit 0 }; $b = Ver; if ((-not $b) -or (-not (AtLeast $b $t))) { & pi update $src } } else { Write-Output 'Updating Pi extension...'; $b = Ver; & pi update $src; if ($LASTEXITCODE -ne 0) { & pi install $src } }; $a = Ver; if (-not $a) { Write-Output ('Pi extension: could not read its installed version. To update it: pi update ' + $src) } elseif (-not (AtLeast $a $t)) { $v = ''; if (Get-Command npm -ErrorAction SilentlyContinue) { try { $v = (& npm view ('@plannotator/pi-extension@' + $t) version --fetch-timeout=10000 --fetch-retries=0 2>&1 | Out-String) } catch { $v = '' } }; if ($v -match 'E404') { Write-Output ('Pi extension: still ' + $a + ' (' + $t + ' is not on your npm registry yet). Run this later: pi update ' + $src) } else { Write-Output ('Pi extension: still ' + $a + ' (this release is ' + $t + '). To update it: pi update ' + $src) } } elseif ($fresh) { Write-Output ('Pi extension installed (' + $a + ').') } elseif ($b -eq $a) { Write-Output ('Pi extension already up to date (' + $a + ').') } else { Write-Output ('Pi extension updated to ' + $a + '.') }; exit 0"
set "PLN_PI_TARGET="
goto :eof

REM BEGIN Qwen Code subroutines
REM ======================================================================
REM The Qwen Code steps, as in install.sh and install.ps1. One PowerShell
REM program (:QwenPsDefs) does the work; each of its lines is kept in its
REM own PLN_QX_Pnnn variable and the program is put together from them, so
REM no line comes near cmd.exe's 8191-character limit. Its lines carry no
REM double quote, percent sign, exclamation mark or caret, so cmd.exe passes
REM them as written. Inputs travel in PLN_QX_* variables, never interpolated.
REM Every qwen command has a time limit, reads no input and runs in an empty
REM temporary folder. Its exit code is the result. Best effort: never fails
REM the install.
REM ======================================================================

REM :QwenVersionCheck - plan review needs extension hooks, which Qwen Code
REM runs from 0.13.0 on. Below that, nothing is installed for Qwen Code (no
REM extension, no skills): QWEN_TOO_OLD=1. A version that cannot be read
REM does not block the install.
:QwenVersionCheck
set "QWEN_TOO_OLD=0"
if not "!QWEN_AVAILABLE!"=="1" goto :eof
if "!SKIP_QWEN!"=="1" goto :eof
if "!SKIP_SKILLS!"=="1" goto :eof
call :QwenPsDefs
set "PLN_QX_MODE=version"
set "PLN_QX_HOME=!QWEN_DIR!"
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ((Get-ChildItem env: | Where-Object Name -like 'PLN_QX_P*' | Sort-Object Name | ForEach-Object Value) -join [char]10); exit $rc"
if "!ERRORLEVEL!"=="36" set "QWEN_TOO_OLD=1"
call :QwenPsClear
goto :eof

REM :InstallQwenExtension - install or update the plannotator Qwen Code
REM extension with Qwen's own commands. Its source is kept at
REM _CONFIG_DIR\qwen-code\extension, a path that does not change: Qwen
REM records it as the source, derives the extension's id from it and reads
REM it on update. Not installed: `qwen extensions install that path
REM --consent`. Installed from that path in another version: `qwen extensions
REM update plannotator`, which keeps the id and the user's on/off choices
REM ^(never uninstalled here^). The same version: no extension command runs.
REM Linked ^(`qwen extensions link`^) or installed from another source: left
REM as it is.
:InstallQwenExtension
if "!SKIP_QWEN!"=="1" (
    echo.
    echo Qwen Code: detected, skipped ^(!SKIP_QWEN_SOURCE!^).
    if exist "!QWEN_DIR!\extensions\plannotator\qwen-extension.json" echo The installed Qwen Code extension was left untouched.
    goto :eof
)
if "!SKIP_SKILLS!"=="1" goto :eof
if "!QWEN_TOO_OLD!"=="1" (
    set "QWEN_EXTENSION_STATE=too-old"
    goto :eof
)
call :QwenPsDefs
set "PLN_QX_MODE=extension"
set "PLN_QX_HOME=!QWEN_DIR!"
set "PLN_QX_SRC=!SKILLS_TMP!\qwen-extension"
set "PLN_QX_DATA=!_CONFIG_DIR!"
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ((Get-ChildItem env: | Where-Object Name -like 'PLN_QX_P*' | Sort-Object Name | ForEach-Object Value) -join [char]10); exit $rc"
set "PLN_QX_RC=!ERRORLEVEL!"
set "QWEN_EXTENSION_STATE=failed"
if "!PLN_QX_RC!"=="30" set "QWEN_EXTENSION_STATE=no-cli"
if "!PLN_QX_RC!"=="31" set "QWEN_EXTENSION_STATE=ok"
if "!PLN_QX_RC!"=="32" set "QWEN_EXTENSION_STATE=ok"
if "!PLN_QX_RC!"=="33" set "QWEN_EXTENSION_STATE=ok"
if "!PLN_QX_RC!"=="35" set "QWEN_EXTENSION_STATE=not-in-tag"
if "!PLN_QX_RC!"=="37" set "QWEN_EXTENSION_STATE=linked"
if "!PLN_QX_RC!"=="38" set "QWEN_EXTENSION_STATE=foreign"
if "!PLN_QX_RC!"=="41" set "QWEN_EXTENSION_STATE=ok-off"
if "!PLN_QX_RC!"=="43" set "QWEN_EXTENSION_STATE=ok-off"
call :QwenPsClear
goto :eof

:QwenPsClear
for /f "delims==" %%V in ('set PLN_QX_ 2^>nul') do set "%%V="
goto :eof

REM :QwenPsDefs - the PowerShell program, one line per variable.
:QwenPsDefs
set "PLN_QX_P001=$ErrorActionPreference = 'Continue'"
set "PLN_QX_P002=$q = [char]34"
set "PLN_QX_P003=function QwenPath { $c = Get-Command qwen -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { return $c.Source }; return $null }"
set "PLN_QX_P004=function Secs { if ($env:PLANNOTATOR_QWEN_EXTENSION_TIMEOUT -match '\A[1-9][0-9]*\z') { return [int]$env:PLANNOTATOR_QWEN_EXTENSION_TIMEOUT }; return 120 }"
set "PLN_QX_P005=function NewTmp { $t = Join-Path ([System.IO.Path]::GetTempPath()) ('plannotator-qwen-' + [System.Guid]::NewGuid().ToString('N')); try { New-Item -ItemType Directory -Force -Path (Join-Path $t 'cwd') -ErrorAction Stop | Out-Null; return $t } catch { return $null } }"
set "PLN_QX_P006=function Run($exe, $argv, $work) {"
set "PLN_QX_P007=    $secs = Secs"
set "PLN_QX_P008=    $quoted = ($argv | ForEach-Object { $q + $_ + $q }) -join ' '"
set "PLN_QX_P009=    $si = New-Object System.Diagnostics.ProcessStartInfo"
set "PLN_QX_P010=    if ($exe -match '\.(cmd|bat)\z') {"
set "PLN_QX_P011=        if (($exe + ($argv -join '')) -match ('[' + $q + [char]37 + [char]33 + ']')) { return @{ Why = 'could not run ' + (Split-Path $exe -Leaf) + ': a path has a character cmd.exe would change'; Out = ''; Last = '' } }"
set "PLN_QX_P012=        $si.FileName = $(if ($env:ComSpec) { $env:ComSpec } else { 'cmd.exe' })"
set "PLN_QX_P013=        $si.Arguments = '/d /s /c ' + $q + $q + $exe + $q + ' ' + $quoted + $q"
set "PLN_QX_P014=    } else { $si.FileName = $exe; $si.Arguments = $quoted }"
set "PLN_QX_P015=    $si.WorkingDirectory = $work; $si.UseShellExecute = $false; $si.RedirectStandardInput = $true; $si.RedirectStandardOutput = $true; $si.RedirectStandardError = $true; $si.CreateNoWindow = $true"
set "PLN_QX_P016=    try { $p = [System.Diagnostics.Process]::Start($si) } catch { return @{ Why = 'could not run qwen: ' + $_.Exception.Message; Out = ''; Last = '' } }"
set "PLN_QX_P017=    try { $p.StandardInput.Close() } catch { }"
set "PLN_QX_P018=    $to = $p.StandardOutput.ReadToEndAsync(); $te = $p.StandardError.ReadToEndAsync()"
set "PLN_QX_P019=    if (-not $p.WaitForExit($secs * 1000)) { try { $p.Kill($true) } catch { try { $null = & taskkill /T /F /PID $p.Id 2>$null } catch { }; try { $p.Kill() } catch { } }; return @{ Why = 'timed out after ' + $secs + 's'; Out = ''; Last = '' } }"
set "PLN_QX_P020=    $p.WaitForExit()"
set "PLN_QX_P021=    $texts = @(); foreach ($t in @($to, $te)) { $v = ''; try { if ($t.Wait(5000)) { $v = [string]$t.Result } } catch { }; $texts += $v }"
set "PLN_QX_P022=    $l = $null; foreach ($v in @($texts[1], $texts[0])) { $l = @($v -split '\r?\n') | ForEach-Object { ($_ -replace ('[' + [char]94 + '\x20-\x7E]'), '').Trim() } | Where-Object { $_ } | Select-Object -Last 1; if ($l) { break } }"
set "PLN_QX_P023=    if ($l -and $l.Length -gt 200) { $l = $l.Substring(0, 200) }"
set "PLN_QX_P024=    $why = ''; if ($p.ExitCode -ne 0) { $why = 'qwen exited ' + $p.ExitCode; if ($l) { $why = $why + ': ' + $l } }"
set "PLN_QX_P025=    return @{ Why = $why; Out = $texts[0]; Last = $l }"
set "PLN_QX_P026=}"
set "PLN_QX_P027=function Ver($path) { try { return [string]((Get-Content -LiteralPath $path -Raw -ErrorAction Stop | ConvertFrom-Json).version) } catch { return '' } }"
set "PLN_QX_P028=function SamePath($a, $b) {"
set "PLN_QX_P029=    if (-not $a -or -not $b) { return $false }"
set "PLN_QX_P030=    try { $x = [System.IO.Path]::GetFullPath($a).TrimEnd('\', '/'); $y = [System.IO.Path]::GetFullPath($b).TrimEnd('\', '/') } catch { return $false }"
set "PLN_QX_P031=    if ([System.IO.Path]::DirectorySeparatorChar -eq '\') { return $x -ieq $y }; return $x -ceq $y"
set "PLN_QX_P032=}"
set "PLN_QX_P033=function Off($qd) {"
set "PLN_QX_P034=    $off = $false"
set "PLN_QX_P035=    try { $s = Get-Content -LiteralPath (Join-Path (Join-Path $qd 'extension-store') 'state.json') -Raw -ErrorAction Stop | ConvertFrom-Json; foreach ($p in @($s.extensions.PSObject.Properties)) { $v = $p.Value; if ($v.name -ne 'plannotator') { continue }; if ($v.defaultActivation -eq 'disabled') { $off = $true }; if ($v.workspaceOverrides) { foreach ($o in @($v.workspaceOverrides.PSObject.Properties)) { if ($o.Value -eq 'disabled') { $off = $true } } } } } catch { }"
set "PLN_QX_P036=    try { $l = Get-Content -LiteralPath (Join-Path (Join-Path $qd 'extensions') 'extension-enablement.json') -Raw -ErrorAction Stop | ConvertFrom-Json; if ($l.plannotator -and $l.plannotator.overrides) { foreach ($r in @($l.plannotator.overrides)) { if (([string]$r).StartsWith([string][char]33)) { $off = $true } } } } catch { }"
set "PLN_QX_P037=    return $off"
set "PLN_QX_P038=}"
set "PLN_QX_P039=function Main {"
set "PLN_QX_P040=    $qd = $env:PLN_QX_HOME"
set "PLN_QX_P041=    $qwen = QwenPath"
set "PLN_QX_P042=    if ($env:PLN_QX_MODE -eq 'version') {"
set "PLN_QX_P043=        if (-not $qwen) { return 0 }"
set "PLN_QX_P044=        $tmp = NewTmp; if (-not $tmp) { return 0 }"
set "PLN_QX_P045=        try {"
set "PLN_QX_P046=            $r = Run $qwen @('--version') (Join-Path $tmp 'cwd')"
set "PLN_QX_P047=            $m = [regex]::Match([string]$r.Out, '[0-9]+\.[0-9]+\.[0-9]+')"
set "PLN_QX_P048=            if ($m.Success -and ([version]$m.Value -lt [version]'0.13.0')) { Write-Host ''; Write-Host ('Qwen Code ' + $m.Value + ' is older than 0.13.0, so nothing was installed for it. Update Qwen Code to use plan review.'); return 36 }"
set "PLN_QX_P049=        } catch { } finally { Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue }"
set "PLN_QX_P050=        return 0"
set "PLN_QX_P051=    }"
set "PLN_QX_P052=    $src = $env:PLN_QX_SRC"
set "PLN_QX_P053=    if (-not (Test-Path -LiteralPath (Join-Path $src 'qwen-extension.json') -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path (Join-Path $src 'hooks') 'hooks.json') -PathType Leaf)) { return 35 }"
set "PLN_QX_P054=    $dest = Join-Path (Join-Path $qd 'extensions') 'plannotator'"
set "PLN_QX_P055=    $rec = $null; try { $rec = Get-Content -LiteralPath (Join-Path $dest '.qwen-extension-install.json') -Raw -ErrorAction Stop | ConvertFrom-Json } catch { }"
set "PLN_QX_P056=    if ($rec -and $rec.type -eq 'link') { Write-Host 'Qwen Code extension: linked from a local folder (qwen extensions link), left as it is.'; return 37 }"
set "PLN_QX_P057=    if (-not $qwen) { Write-Host 'Qwen Code extension: not installed (the qwen command is not on PATH).'; return 30 }"
set "PLN_QX_P058=    $data = $env:PLN_QX_DATA; if (-not [System.IO.Path]::IsPathRooted($data)) { $data = Join-Path (Get-Location).Path $data }"
set "PLN_QX_P059=    $stable = Join-Path (Join-Path $data 'qwen-code') 'extension'"
set "PLN_QX_P060=    $nv = Ver (Join-Path $src 'qwen-extension.json')"
set "PLN_QX_P061=    $had = Test-Path -LiteralPath (Join-Path $dest 'qwen-extension.json') -PathType Leaf"
set "PLN_QX_P062=    if ($had) { $from = ''; if ($rec) { $from = [string]$rec.source }; if (-not (SamePath $from $stable)) { if (-not $from) { $from = 'an unknown source' }; Write-Host ('Qwen Code extension: installed from ' + $from + ', not by this installer, so it was left as it is.'); return 38 } }"
set "PLN_QX_P063=    $staged = $stable + '.new'"
set "PLN_QX_P064=    try {"
set "PLN_QX_P065=        if (Test-Path -LiteralPath $staged) { Remove-Item -Recurse -Force -LiteralPath $staged -ErrorAction Stop }"
set "PLN_QX_P066=        New-Item -ItemType Directory -Force -Path (Split-Path $stable) -ErrorAction Stop | Out-Null"
set "PLN_QX_P067=        Copy-Item -Recurse -Force -LiteralPath $src -Destination $staged -ErrorAction Stop"
set "PLN_QX_P068=        if (Test-Path -LiteralPath $stable) { Remove-Item -Recurse -Force -LiteralPath $stable -ErrorAction Stop }"
set "PLN_QX_P069=        Move-Item -LiteralPath $staged -Destination $stable -ErrorAction Stop"
set "PLN_QX_P070=    } catch { Remove-Item -Recurse -Force -LiteralPath $staged -ErrorAction SilentlyContinue; Write-Host ('Qwen Code extension: could not write its source to ' + $stable + '. The installed one was left as it was.'); return 34 }"
set "PLN_QX_P071=    $off = $false; if ($had) { $off = [bool](Off $qd) }"
set "PLN_QX_P072=    if ($had -and ((Ver (Join-Path $dest 'qwen-extension.json')) -eq $nv)) { Write-Host 'Qwen Code extension: already up to date.'; if ($off) { return 41 }; return 31 }"
set "PLN_QX_P073=    $tmp = NewTmp; if (-not $tmp) { Write-Host 'Qwen Code extension: could not install it (no temporary directory).'; return 34 }"
set "PLN_QX_P074=    try {"
set "PLN_QX_P075=        $work = Join-Path $tmp 'cwd'"
set "PLN_QX_P076=        if ($had) {"
set "PLN_QX_P077=            Write-Host 'Updating the Qwen Code extension...'"
set "PLN_QX_P078=            $r = Run $qwen @('extensions', 'update', 'plannotator') $work"
set "PLN_QX_P079=            if ((Ver (Join-Path $dest 'qwen-extension.json')) -eq $nv) { Write-Host 'Qwen Code extension: updated (restart Qwen Code to load it).'; if ($off) { Write-Host 'It stays turned off where you turned it off in Qwen Code.'; return 43 }; return 33 }"
set "PLN_QX_P080=            $w = $r.Why; if (-not $w) { $w = $r.Last }; if (-not $w) { $w = 'qwen did not update it' }"
set "PLN_QX_P081=            Write-Host ('Qwen Code extension: could not update it (' + $w + '). The installed one was left as it was.'); Write-Host 'To try again by hand: qwen extensions update plannotator'; return 34"
set "PLN_QX_P082=        }"
set "PLN_QX_P083=        Write-Host 'Installing the Qwen Code extension...'"
set "PLN_QX_P084=        $r = Run $qwen @('extensions', 'install', $stable, '--consent') $work"
set "PLN_QX_P085=        if (-not $r.Why) { Write-Host 'Qwen Code extension: installed (restart Qwen Code to load it).'; return 32 }"
set "PLN_QX_P086=        Write-Host ('Qwen Code extension: could not install it (' + $r.Why + ').'); Write-Host ('To try again by hand: qwen extensions install ' + $q + $stable + $q); return 34"
set "PLN_QX_P087=    } finally { Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue }"
set "PLN_QX_P088=}"
set "PLN_QX_P089=$rc = $(if ($env:PLN_QX_MODE -eq 'version') { 0 } else { 34 })"
set "PLN_QX_P090=try { $rc = Main | Select-Object -Last 1 } catch { }"
goto :eof
REM END Qwen Code subroutines
:AddInstallFlag
if defined IFL (set "IFL=!IFL!,"%~1"") else (set "IFL="%~1"")
goto :eof

REM ======================================================================
REM If INSTALL_DIR isn't on this session's PATH, add it to the USER PATH (as
REM install.ps1's Show-PathAdvice does) and print how to pick it up. The
REM Claude Code plugin hooks run bare `plannotator`, so the binary has to be
REM on PATH. Called by both the --minimal early exit and the normal flow.
REM
REM The PowerShell one-liner edits HKCU\Environment\Path through the registry
REM API, read unexpanded and written back with its own kind (REG_EXPAND_SZ on
REM most systems) so %VARS% in other entries survive, the same way
REM `plannotator uninstall` removes the entry again. It appends only when no
REM entry already names INSTALL_DIR (raw or expanded, case-insensitive,
REM trailing backslash ignored), so re-running the installer never duplicates
REM it. The directory travels in PLN_PATH_DIR, never interpolated into the
REM command, and the command carries no double quote, percent sign,
REM exclamation mark, caret, ampersand or redirect for cmd.exe to parse (its
REM one pipe is inside the quotes); the DllImport quotes for the settings
REM broadcast are built from [char]34. The call sits outside any parenthesized
REM block. Best effort: a failure prints the manual command instead and never
REM fails the install.
REM ======================================================================
:PrintPathAdvice
echo !PATH! | findstr /i /c:"!INSTALL_DIR!" >nul
if !ERRORLEVEL! equ 0 goto :PathAdviceTail
echo.
echo !INSTALL_DIR! is not in your PATH. Adding it to your user PATH...
set "PLN_PATH_DIR=!INSTALL_DIR!"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $d=$env:PLN_PATH_DIR.Trim().TrimEnd('\'); $k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); $p=$k.GetValue('Path',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $kind=[Microsoft.Win32.RegistryValueKind]::ExpandString; if($null -ne $p){$kind=$k.GetValueKind('Path')}; $p=[string]$p; $has=@($p -split ';' | Where-Object { $e=$_.Trim().TrimEnd('\'); ($e -ine '') -and (($e -ieq $d) -or ([Environment]::ExpandEnvironmentVariables($e).TrimEnd('\') -ieq $d)) }); if($has.Count -gt 0){$k.Close(); Write-Output 'It is already in your user PATH; open a new terminal to pick it up.'; exit 0}; if($p.Trim() -eq ''){$n=$d}else{$n=$p.TrimEnd(';') + ';' + $d}; $k.SetValue('Path',$n,$kind); $k.Close(); Write-Output 'Added. Restart your terminal for the change to take effect.'; $q=[char]34; $sig='[DllImport('+$q+'user32.dll'+$q+',CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd,uint msg,UIntPtr wParam,string lParam,uint flags,uint timeout,out UIntPtr result);'; try{Add-Type -Namespace Plannotator -Name PathBroadcast -MemberDefinition $sig; $r=[UIntPtr]::Zero; [void][Plannotator.PathBroadcast]::SendMessageTimeout([IntPtr]0xffff,0x1A,[UIntPtr]::Zero,'Environment',0x2,1000,[ref]$r)}catch{}; exit 0"
if errorlevel 1 (
    echo Could not update your user PATH automatically. Add it permanently with:
    echo.
    echo   setx PATH "%%PATH%%;!INSTALL_DIR!"
)
set "PLN_PATH_DIR="
echo.
echo Or add it for this session only:
echo.
echo   set PATH=%%PATH%%;!INSTALL_DIR!
:PathAdviceTail
echo.
echo To uninstall later: plannotator uninstall
goto :eof

REM ======================================================================
REM Optional annotate agent terminal runtime install. Non-fatal: Plannotator
REM remains installed if Node/npm or npm install is unavailable.
REM ======================================================================
:InstallAgentTerminalRuntime
if /i "!PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL!"=="1" (
    echo Skipping agent terminal runtime install ^(PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL is set^)
    goto :eof
)
if /i "!PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL!"=="true" (
    echo Skipping agent terminal runtime install ^(PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL is set^)
    goto :eof
)
if /i "!PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL!"=="yes" (
    echo Skipping agent terminal runtime install ^(PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL is set^)
    goto :eof
)

"!INSTALL_PATH!" install-runtime agent-terminal
if !ERRORLEVEL! neq 0 (
    echo Skipping agent terminal runtime install ^(plannotator install-runtime failed^)
)
goto :eof

REM ======================================================================
REM Opt-in CallDiff core install. Call flow is off by default, so a default
REM install never downloads even the pruned core. Review-specific packs
REM install in-app. Non-fatal when the opt-in install fails.
REM ======================================================================
:InstallCallFlowRuntime
if not "!INSTALL_CALL_FLOW!"=="1" (
    echo Call-flow analysis: available as an in-app opt-in install ^(enable Call flow in review Settings^), or run: plannotator install-runtime call-flow
    goto :eof
)

"!INSTALL_PATH!" install-runtime call-flow
if !ERRORLEVEL! neq 0 (
    echo Call-flow runtime install failed; it remains available as an in-app opt-in install
)
goto :eof

REM ======================================================================
REM Optional semantic diff sidecar install. Non-fatal: Plannotator remains
REM installed if sem download, checksum, or extraction fails.
REM ======================================================================
:InstallSemSidecar
if /i "!PLANNOTATOR_SKIP_SEM_INSTALL!"=="1" (
    echo Skipping semantic diff sidecar install ^(PLANNOTATOR_SKIP_SEM_INSTALL is set^)
    goto :eof
)
if /i "!PLANNOTATOR_SKIP_SEM_INSTALL!"=="true" (
    echo Skipping semantic diff sidecar install ^(PLANNOTATOR_SKIP_SEM_INSTALL is set^)
    goto :eof
)
if /i "!PLANNOTATOR_SKIP_SEM_INSTALL!"=="yes" (
    echo Skipping semantic diff sidecar install ^(PLANNOTATOR_SKIP_SEM_INSTALL is set^)
    goto :eof
)

set "SEM_ASSET="
if /i "!PLATFORM!"=="win32-x64" set "SEM_ASSET=sem-windows-x86_64.zip"
if not defined SEM_ASSET (
    echo Skipping semantic diff sidecar install ^(sem does not publish !PLATFORM!^)
    goto :eof
)

set "SEM_DIR=!_CONFIG_DIR!\vendor\sem\!SEM_VERSION!"
set "SEM_PATH=!SEM_DIR!\sem.exe"
if exist "!SEM_PATH!" (
    "!SEM_PATH!" --version 2>nul | findstr /r /c:"^sem " >nul 2>&1
    if !ERRORLEVEL! equ 0 (
        echo Semantic diff sidecar already installed at !SEM_PATH!
        goto :eof
    )
)

set "SEM_BASE_URL=https://github.com/!SEM_REPO!/releases/download/!SEM_VERSION!"
set "SEM_ARCHIVE=%TEMP%\plannotator-sem-%RANDOM%.zip"
set "SEM_EXTRACT=%TEMP%\plannotator-sem-%RANDOM%"
mkdir "!SEM_EXTRACT!" >nul 2>&1

REM Bounded so a slow/hung download of this optional sidecar can't wedge an
REM install where plannotator already landed. Opt out with PLANNOTATOR_SKIP_SEM_INSTALL=1.
curl -fsSL --connect-timeout 10 --max-time 120 "!SEM_BASE_URL!/!SEM_ASSET!" -o "!SEM_ARCHIVE!"
if !ERRORLEVEL! neq 0 (
    echo Skipping semantic diff sidecar install ^(download failed^)
    goto :sem_cleanup
)

REM Pinned for SEM_VERSION, not read from the release's checksums.txt (same
REM connection as the archive). Keep in step with install.sh / install.ps1.
set "EXPECTED_SEM_CHECKSUM="
if /i "!SEM_ASSET!"=="sem-windows-x86_64.zip" set "EXPECTED_SEM_CHECKSUM=2a4b57f8368f0c88ded52f9ecbe0a85771008e37aa09215fc9ce750adab03d06"
if not defined EXPECTED_SEM_CHECKSUM (
    echo Skipping semantic diff sidecar install ^(checksum missing for !SEM_ASSET!^)
    goto :sem_cleanup
)

set "ACTUAL_SEM_CHECKSUM="
for /f "skip=1 tokens=*" %%i in ('certutil -hashfile "!SEM_ARCHIVE!" SHA256') do (
    if not defined ACTUAL_SEM_CHECKSUM (
        set "ACTUAL_SEM_CHECKSUM=%%i"
        set "ACTUAL_SEM_CHECKSUM=!ACTUAL_SEM_CHECKSUM: =!"
    )
)
if /i "!ACTUAL_SEM_CHECKSUM!" neq "!EXPECTED_SEM_CHECKSUM!" (
    echo Skipping semantic diff sidecar install ^(checksum mismatch^)
    goto :sem_cleanup
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Force -Path $env:SEM_ARCHIVE -DestinationPath $env:SEM_EXTRACT"
if !ERRORLEVEL! neq 0 (
    echo Skipping semantic diff sidecar install ^(extract failed^)
    goto :sem_cleanup
)
set "EXTRACTED_SEM="
for /f "usebackq delims=" %%i in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -Path $env:SEM_EXTRACT -Filter sem.exe -Recurse -File | Select-Object -First 1 -ExpandProperty FullName"`) do (
    set "EXTRACTED_SEM=%%i"
)
if not defined EXTRACTED_SEM (
    echo Skipping semantic diff sidecar install ^(binary missing from archive^)
    goto :sem_cleanup
)

if not exist "!SEM_DIR!" mkdir "!SEM_DIR!"
copy /y "!EXTRACTED_SEM!" "!SEM_PATH!" >nul
if !ERRORLEVEL! equ 0 (
    echo Semantic diff sidecar installed to !SEM_PATH!
) else (
    echo Skipping semantic diff sidecar install ^(copy failed^)
)

:sem_cleanup
if exist "!SEM_ARCHIVE!" del "!SEM_ARCHIVE!"
if exist "!SEM_EXTRACT!" rmdir /s /q "!SEM_EXTRACT!"
goto :eof

REM ======================================================================
REM Guided-install wizard (called only on interactive first runs or with
REM --reconfigure). Sets EXTRAS_CHOICE and INVOCABLE_CHOICE.
REM ======================================================================
:guided_wizard
echo.
echo ==========================================
echo   PLANNOTATOR GUIDED INSTALL
echo ==========================================
echo.
if "!EXTRAS_PRESENT!"=="1" (
    echo Extra skills already installed - keeping them.
    set "EXTRAS_CHOICE=yes"
) else if defined EXTRAS_FLAG (
    REM Flag already answered this question - don't ask and then ignore.
    set "EXTRAS_CHOICE=!EXTRAS_FLAG!"
) else (
    set "DEF_EXTRAS=no"
    if defined SAVED_EXTRAS set "DEF_EXTRAS=!SAVED_EXTRAS!"
    set "ANSWER="
    set /p "ANSWER=Install the extra skills (compound planning, setup-goal, visual explainer)? [y/N] "
    set "EXTRAS_CHOICE=no"
    if /i "!ANSWER!"=="y" set "EXTRAS_CHOICE=yes"
    if /i "!ANSWER!"=="yes" set "EXTRAS_CHOICE=yes"
    if "!ANSWER!"=="" set "EXTRAS_CHOICE=!DEF_EXTRAS!"
)
if defined MODEL_INVOCABLE_FLAG (
    REM Flag already answered this question - don't ask and then ignore.
    set "INVOCABLE_CHOICE=!MODEL_INVOCABLE_FLAG!"
    goto :eof
)
set "ANSWER="
set /p "ANSWER=Make any skills callable by the model (instead of user-invoked only)? [y/N] "
set "WANT_INVOCABLE=no"
if /i "!ANSWER!"=="y" set "WANT_INVOCABLE=yes"
if /i "!ANSWER!"=="yes" set "WANT_INVOCABLE=yes"
if "!WANT_INVOCABLE!"=="no" (
    set "INVOCABLE_CHOICE=none"
    goto :eof
)
set "SKILL_COUNT=3"
set "SKILL_1=plannotator-review"
set "SKILL_2=plannotator-annotate"
set "SKILL_3=plannotator-last"
if "!EXTRAS_CHOICE!"=="yes" (
    set "SKILL_COUNT=6"
    set "SKILL_4=plannotator-compound"
    set "SKILL_5=plannotator-setup-goal"
    set "SKILL_6=plannotator-visual-explainer"
)
REM Preselect previously chosen skills. NOTE: no pipes here - each side of a
REM cmd pipe runs in a child without delayed expansion, so !vars! would pass
REM through literally. A substring-replace containment test avoids that trap.
set "PRESEL=,!SAVED_INVOCABLE!,"
for /l %%I in (1,1,!SKILL_COUNT!) do (
    set "SEL_%%I=0"
    if defined SAVED_INVOCABLE (
        for %%K in ("!SKILL_%%I!") do if not "!PRESEL:,%%~K,=!"=="!PRESEL!" set "SEL_%%I=1"
    )
)
:toggle_loop
echo.
for /l %%I in (1,1,!SKILL_COUNT!) do (
    set "MARK= "
    if "!SEL_%%I!"=="1" set "MARK=x"
    echo   %%I^) [!MARK!] !SKILL_%%I!
)
set "PICK="
set /p "PICK=Toggle a number (press enter on empty input to confirm): "
if "!PICK!"=="" goto :collect_invocable
set "VALID=0"
for /l %%I in (1,1,!SKILL_COUNT!) do if "!PICK!"=="%%I" set "VALID=1"
if "!VALID!"=="0" (
    echo Invalid choice: !PICK!
    goto :toggle_loop
)
for %%I in (!PICK!) do (
    if "!SEL_%%I!"=="1" (set "SEL_%%I=0") else (set "SEL_%%I=1")
)
goto :toggle_loop
:collect_invocable
set "INVOCABLE_CHOICE="
for /l %%I in (1,1,!SKILL_COUNT!) do (
    if "!SEL_%%I!"=="1" (
        if defined INVOCABLE_CHOICE (set "INVOCABLE_CHOICE=!INVOCABLE_CHOICE!,!SKILL_%%I!") else (set "INVOCABLE_CHOICE=!SKILL_%%I!")
    )
)
if not defined INVOCABLE_CHOICE set "INVOCABLE_CHOICE=none"
goto :eof
