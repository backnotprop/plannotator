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
REM Guided-install answers. Precedence: CLI flags > wizard (interactive, first
REM run or --reconfigure) > saved prefs from a previous run > defaults.
set "EXTRAS_FLAG="
set "MODEL_INVOCABLE_FLAG="
set "GLIMPSE_FLAG="
set "NON_INTERACTIVE=0"
set "RECONFIGURE=0"

:parse_args
if "%~1"=="" goto args_done
if /i "%~1"=="--version" (
    if "%~2"=="" (
        echo --version requires an argument >&2
        exit /b 1
    )
    REM Reject dash-prefixed values — prevents `install.cmd --version
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
if /i "%~1"=="--glimpse" (
    set "GLIMPSE_FLAG=yes"
    shift
    goto parse_args
)
if /i "%~1"=="--no-glimpse" (
    set "GLIMPSE_FLAG=no"
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
REM Reject any other dash-prefixed token as an unknown option, so a typoed
REM flag like --verify-attesttion fails fast instead of being interpreted as
REM a version tag (which would 404 on releases/download/v--verify-attesttion/...).
REM
REM Uses a variable-assigned substring test instead of `echo %~1 | findstr`
REM because unquoted %~1 in an echo pipe lets cmd.exe interpret shell
REM metacharacters (& | > <) in the argument before the pipe runs. Assigning
REM to a `set "VAR=%~1"` literal-quoted form preserves metacharacters safely,
REM and delayed-expansion substring (!VAR:~0,1!) avoids the subprocess entirely.
REM The error-message echo also quotes "%~1" for the same reason — echoing an
REM unquoted arg containing `&` would re-trigger metacharacter interpretation.
set "CURRENT_ARG=%~1"
if "!CURRENT_ARG:~0,1!"=="-" (
    echo Unknown option: "%~1" >&2
    echo Usage: install.cmd [--version ^<tag^>] [--verify-attestation ^| --skip-attestation] [--extras ^| --no-extras] [--model-invocable ^<list^>] [--glimpse ^| --no-glimpse] [--non-interactive] [--reconfigure] >&2
    exit /b 1
)
REM Positional form: install.cmd vX.Y.Z (legacy interface).
REM Reject if --version was already passed — silent overwrite is worse
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

set "REPO=backnotprop/plannotator"
set "INSTALL_DIR=%USERPROFILE%\.local\bin"

REM First plannotator release that carries SLSA build-provenance attestations.
REM See scripts/install.sh for the full explanation — this constant is
REM bumped once at the first attested release via the release skill.
set "MIN_ATTESTED_VERSION=v0.17.2"

REM Detect architecture. Native ARM64 Windows binaries are built from
REM bun-windows-arm64 (stable since Bun v1.3.10), so ARM64 hosts get a
REM native binary — no Windows x86-64 emulation tax. PROCESSOR_ARCHITECTURE
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

    REM Download release info to a randomized temp file so concurrent
    REM invocations don't collide and a same-user pre-placed symlink at
    REM a predictable path can't redirect curl's output.
    set "RELEASE_JSON=%TEMP%\plannotator-release-%RANDOM%.json"
    curl -fsSL "https://api.github.com/repos/!REPO!/releases/latest" -o "!RELEASE_JSON!"
    if !ERRORLEVEL! neq 0 (
        echo Failed to get latest version >&2
        exit /b 1
    )

    REM Extract tag_name from JSON
    for /f "tokens=2 delims=:," %%i in ('findstr /c:"\"tag_name\"" "!RELEASE_JSON!"') do (
        set "TAG=%%i"
        set "TAG=!TAG: =!"
        set "TAG=!TAG:"=!"
    )
    del "!RELEASE_JSON!"

    if "!TAG!"=="" (
        echo Failed to parse version >&2
        exit /b 1
    )
) else (
    set "TAG=!VERSION!"
    REM Add v prefix if not present. Use a substring test rather than
    REM piping the expanded variable through findstr — an unquoted echo
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
if defined PLANNOTATOR_DATA_DIR (
    set "_CONFIG_DIR=!PLANNOTATOR_DATA_DIR!"
) else (
    set "_CONFIG_DIR=%USERPROFILE%\.plannotator"
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

REM Pre-flight: reject verification requests for tags older than the first
REM attested release BEFORE downloading. Critical security point: the version
REM comparison uses $env:TAG_NUM / $env:MIN_NUM instead of interpolating
REM !TAG_NUM! / !MIN_NUM! into the PowerShell command string. Interpolation
REM would let a crafted --version value break out of the single-quoted literal
REM and execute arbitrary PowerShell (e.g. --version "0.18.0'; calc; '0.18.0"
REM would run Calculator). $env: reads the raw string; PowerShell never parses
REM the value as code. [version] cast throws on invalid input, catch swallows,
REM VERSION_OK stays empty, and the guard rejects — safe fail.
if "!VERIFY_ATTESTATION!"=="1" (
    REM Strip the leading `v` via substring-from-index-1. cmd's `:str=repl`
    REM substitution is GLOBAL, not anchored — `!TAG:v=!` would remove every
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
    REM Uses native cmd substitution `!VAR:-=!` to check for `-` presence —
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
        REM the specific signing workflow file (--signer-workflow) — not
        REM just "built somewhere in this repo". See install.sh for full
        REM rationale.
        set "GH_OUTPUT=%TEMP%\plannotator-gh-%RANDOM%.txt"
        gh attestation verify "!TEMP_FILE!" ^
            --repo "!REPO!" ^
            --source-ref "refs/tags/!TAG!" ^
            --signer-workflow "backnotprop/plannotator/.github/workflows/release.yml" ^
            > "!GH_OUTPUT!" 2>&1
        if !ERRORLEVEL! neq 0 (
            type "!GH_OUTPUT!" >&2
            del "!GH_OUTPUT!"
            echo Attestation verification failed! >&2
            echo The binary's SHA256 matched, but no valid signed provenance was found >&2
            echo for !REPO!. Refusing to install. >&2
            del "!TEMP_FILE!"
            exit /b 1
        )
        del "!GH_OUTPUT!"
        echo [OK] verified build provenance ^(SLSA^)
    ) else (
        echo verifyAttestation is enabled but gh CLI was not found. >&2
        echo Install https://cli.github.com ^(and run 'gh auth login'^), >&2
        echo or unset PLANNOTATOR_VERIFY_ATTESTATION / remove verifyAttestation >&2
        echo from %USERPROFILE%\.plannotator\config.json / pass --skip-attestation. >&2
        del "!TEMP_FILE!"
        exit /b 1
    )
) else (
    echo SHA256 verified. For build provenance verification, see
    echo https://plannotator.ai/docs/getting-started/installation/#verifying-your-install
)

REM Install binary
set "INSTALL_PATH=!INSTALL_DIR!\plannotator.exe"
move /y "!TEMP_FILE!" "!INSTALL_PATH!" >nul

echo.
echo plannotator !TAG! installed to !INSTALL_PATH!

REM Check if install directory is in PATH
echo !PATH! | findstr /i /c:"!INSTALL_DIR!" >nul
if !ERRORLEVEL! neq 0 (
    echo.
    echo !INSTALL_DIR! is not in your PATH.
    echo.
    echo Add it permanently with:
    echo.
    echo   setx PATH "%%PATH%%;!INSTALL_DIR!"
    echo.
    echo Or add it for this session only:
    echo.
    echo   set PATH=%%PATH%%;!INSTALL_DIR!
)

REM Validate plugin hooks.json if plugin is already installed
if defined CLAUDE_CONFIG_DIR (
    set "PLUGIN_HOOKS=%CLAUDE_CONFIG_DIR%\plugins\marketplaces\plannotator\apps\hook\hooks\hooks.json"
) else (
    set "PLUGIN_HOOKS=%USERPROFILE%\.claude\plugins\marketplaces\plannotator\apps\hook\hooks\hooks.json"
)
if exist "!PLUGIN_HOOKS!" (
    REM Use full path so the hook works without PATH being set in the shell
    set "EXE_PATH=!INSTALL_PATH:\=/!"
    (
echo {
echo   "hooks": {
echo     "PreToolUse": [
echo       {
echo         "matcher": "EnterPlanMode",
echo         "hooks": [
echo           {
echo             "type": "command",
echo             "command": "!EXE_PATH! improve-context",
echo             "timeout": 5
echo           }
echo         ]
echo       }
echo     ],
echo     "PermissionRequest": [
echo       {
echo         "matcher": "ExitPlanMode",
echo         "hooks": [
echo           {
echo             "type": "command",
echo             "command": "!EXE_PATH!",
echo             "timeout": 345600
echo           }
echo         ]
echo       }
echo     ]
echo   }
echo }
    ) > "!PLUGIN_HOOKS!"
    echo Updated plugin hooks at !PLUGIN_HOOKS!
)

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
if "!CODEX_AVAILABLE!"=="1" (
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

REM Clear any cached OpenCode plugin to force fresh download on next run
if exist "%USERPROFILE%\.cache\opencode\node_modules\@plannotator" rmdir /s /q "%USERPROFILE%\.cache\opencode\node_modules\@plannotator" >nul 2>&1
if exist "%USERPROFILE%\.cache\opencode\packages\@plannotator" rmdir /s /q "%USERPROFILE%\.cache\opencode\packages\@plannotator" >nul 2>&1
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

REM Aggressive cleanup on upgrade — echo each removal, ignore missing.
REM NOTE: legacy Claude command cleanup happens AFTER the skill install below —
REM a command file is only removed once its replacement skill is on disk, so a
REM failed or skipped skill install never leaves users with neither.
if defined CLAUDE_CONFIG_DIR (
    set "CLAUDE_COMMANDS_DIR=%CLAUDE_CONFIG_DIR%\commands"
) else (
    set "CLAUDE_COMMANDS_DIR=%USERPROFILE%\.claude\commands"
)

REM NOTE: Codex stale-skill cleanup happens AFTER the skill install below —
REM the core skills are only removed from the Codex home once their
REM replacement exists in %%USERPROFILE%%\.agents\skills.
set "STALE_CODEX_SKILLS_DIR=!CODEX_DIR!\skills"

REM Old installers (pre core/extra split) ran a wholesale skills copy against
REM a new-layout tag and could leave junk core/extra directory copies in the
REM Claude skills scope. Never valid skill names — always safe to remove.
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
REM previously default-installed copies ONCE per machine — recorded in the
REM migrations ledger under the Plannotator data dir — because copies the user
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
REM No checkbox UI in batch — the skill picker uses numbered toggles instead.
set "PREFS_FILE=!_CONFIG_DIR!\install-prefs"
set "SAVED_EXTRAS="
set "SAVED_INVOCABLE="
set "SAVED_GLIMPSE="
if exist "!PREFS_FILE!" (
    for /f "usebackq tokens=1,* delims==" %%A in ("!PREFS_FILE!") do (
        if /i "%%A"=="extras" set "SAVED_EXTRAS=%%B"
        if /i "%%A"=="model_invocable" set "SAVED_INVOCABLE=%%B"
        if /i "%%A"=="glimpse" set "SAVED_GLIMPSE=%%B"
    )
)

REM Glimpse (glimpseui) gives Plannotator a native window instead of a browser
REM tab; the runtime auto-detects it on PATH. Skip the question when installed.
set "GLIMPSE_PRESENT=0"
where glimpseui >nul 2>&1
if !ERRORLEVEL! equ 0 set "GLIMPSE_PRESENT=1"

REM Extras already on disk? Then the extras question is moot — they still
REM count toward the picker list, and we never launch the npx flow over them.
set "EXTRAS_PRESENT=0"
for %%S in (plannotator-compound plannotator-setup-goal plannotator-visual-explainer) do (
    if exist "!CLAUDE_SKILLS_DIR!\%%S" set "EXTRAS_PRESENT=1"
    if exist "!AGENTS_SKILLS_DIR!\%%S" set "EXTRAS_PRESENT=1"
)

REM A wizard needs a real console. `timeout` exits non-zero when stdin is
REM redirected ("Input redirection is not supported"), making it a reliable
REM console probe — CI and redirected runs never see the wizard and never
REM trigger the wizard-only installs (npx extras, Glimpse). The set /p
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
set "GLIMPSE_CHOICE="
if "!RUN_WIZARD!"=="1" call :guided_wizard

REM Flags override the wizard and saved answers; otherwise saved, then defaults.
if defined EXTRAS_FLAG set "EXTRAS_CHOICE=!EXTRAS_FLAG!"
if defined MODEL_INVOCABLE_FLAG set "INVOCABLE_CHOICE=!MODEL_INVOCABLE_FLAG!"
if defined GLIMPSE_FLAG set "GLIMPSE_CHOICE=!GLIMPSE_FLAG!"
if not defined EXTRAS_CHOICE (
    if defined SAVED_EXTRAS (set "EXTRAS_CHOICE=!SAVED_EXTRAS!") else (set "EXTRAS_CHOICE=no")
)
if not defined INVOCABLE_CHOICE (
    if defined SAVED_INVOCABLE (set "INVOCABLE_CHOICE=!SAVED_INVOCABLE!") else (set "INVOCABLE_CHOICE=none")
)
if not defined GLIMPSE_CHOICE (
    if defined SAVED_GLIMPSE (set "GLIMPSE_CHOICE=!SAVED_GLIMPSE!") else (set "GLIMPSE_CHOICE=no")
)

REM Persist only when the wizard ran or a flag set something — silent re-runs
REM must not clobber saved answers with defaults.
set "DO_PERSIST=0"
if "!RUN_WIZARD!"=="1" set "DO_PERSIST=1"
if defined EXTRAS_FLAG set "DO_PERSIST=1"
if defined MODEL_INVOCABLE_FLAG set "DO_PERSIST=1"
if defined GLIMPSE_FLAG set "DO_PERSIST=1"
if "!DO_PERSIST!"=="1" (
    if not exist "!_CONFIG_DIR!" mkdir "!_CONFIG_DIR!" >nul 2>&1
    > "!PREFS_FILE!" (
        echo extras=!EXTRAS_CHOICE!
        echo model_invocable=!INVOCABLE_CHOICE!
        echo glimpse=!GLIMPSE_CHOICE!
    )
)

REM Glimpse install (global npm package; the runtime auto-detects it on PATH).
REM Wizard or explicit flag only — silent re-runs never install software.
set "DO_GLIMPSE_INSTALL=0"
if "!RUN_WIZARD!"=="1" set "DO_GLIMPSE_INSTALL=1"
if defined GLIMPSE_FLAG set "DO_GLIMPSE_INSTALL=1"
if "!GLIMPSE_CHOICE!"=="yes" if "!GLIMPSE_PRESENT!"=="0" if "!DO_GLIMPSE_INSTALL!"=="1" (
    where npm >nul 2>&1
    if !ERRORLEVEL! equ 0 (
        echo Installing Glimpse ^(npm install -g glimpseui^)...
        call npm install -g glimpseui
        if not !ERRORLEVEL! equ 0 echo Glimpse install failed — install later with: npm install -g glimpseui
    ) else (
        where bun >nul 2>&1
        if !ERRORLEVEL! equ 0 (
            echo Installing Glimpse ^(bun install -g glimpseui^)...
            call bun install -g glimpseui
            if not !ERRORLEVEL! equ 0 echo Glimpse install failed — install later with: bun install -g glimpseui
        ) else (
            echo npm/bun not found — install Node.js, then: npm install -g glimpseui
        )
    )
)

REM Extras install is delegated to the skills CLI (its UI picks the agents).
REM Interactive wizard runs only — silent runs and CI get the printed command.
REM Never runs when the extras already exist.
if "!EXTRAS_CHOICE!"=="yes" if "!EXTRAS_PRESENT!"=="0" (
    set "NPX_OK=0"
    where npx >nul 2>&1
    if !ERRORLEVEL! equ 0 if "!RUN_WIZARD!"=="1" set "NPX_OK=1"
    if "!NPX_OK!"=="1" (
        echo Launching the skills CLI for the extras ^(pick your agents in its UI^)...
        call npx skills add backnotprop/plannotator/apps/skills/extra
        if not !ERRORLEVEL! equ 0 echo skills CLI did not complete — install later with: npx skills add backnotprop/plannotator/apps/skills/extra
    ) else (
        echo Install the extras with: npx skills add backnotprop/plannotator/apps/skills/extra
    )
)

REM File-copy installs require git (sparse checkout). Hard requirement: without
REM git we cannot install the /plannotator-* skills, so fail loudly instead of
REM leaving a partial install. Hook/config writing above has already run; the
REM Pi update and Gemini config below are skipped on failure and complete when
REM the user re-runs the installer.
where git >nul 2>&1
if not !ERRORLEVEL! equ 0 (
    echo Error: git is required to install Plannotator's skills and slash commands. 1>&2
    echo Install git, then run this installer again. 1>&2
    exit /b 1
)
set "CHECKOUT_FAILED=0"
set "KIRO_SKILLS_DIR=%USERPROFILE%\.kiro\skills"
set "KIRO_AGENTS_DIR=%USERPROFILE%\.kiro\agents"
set "OPENCODE_COMMANDS_DIR=%USERPROFILE%\.config\opencode\commands"
set "GEMINI_COMMANDS_DIR=%USERPROFILE%\.gemini\commands"
set "SKILLS_TMP=%TEMP%\plannotator-skills-%RANDOM%"
mkdir "!SKILLS_TMP!" >nul 2>&1

git clone --depth 1 --filter=blob:none --sparse "https://github.com/!REPO!.git" --branch "!TAG!" "!SKILLS_TMP!\repo" >nul 2>&1
if !ERRORLEVEL! equ 0 (
    pushd "!SKILLS_TMP!\repo"
    git sparse-checkout set apps/skills apps/kiro-cli apps/opencode-plugin/commands apps/gemini/commands >nul 2>&1

    REM Claude Code reads apps\skills\claude\* (injection `!`plannotator … $ARGUMENTS``
    REM + allowed-tools, so /plannotator-* run with no permission prompt); Codex
    REM reads apps\skills\core\* (prose). The `!`…`` injection is Claude-Code-only,
    REM so the two are sourced separately. Replace rather than merge on each run.
    if exist "apps\skills\claude" (
        if not exist "!CLAUDE_SKILLS_DIR!" mkdir "!CLAUDE_SKILLS_DIR!"
        for %%S in (plannotator-review plannotator-annotate plannotator-last) do (
            if exist "apps\skills\claude\%%S" (
                if exist "!CLAUDE_SKILLS_DIR!\%%S" rmdir /s /q "!CLAUDE_SKILLS_DIR!\%%S" >nul 2>&1
                xcopy /s /i /y /q "apps\skills\claude\%%S" "!CLAUDE_SKILLS_DIR!\%%S\" >nul 2>&1
            )
        )
        echo Installed Claude Code skills to !CLAUDE_SKILLS_DIR!\
    )
    if exist "apps\skills\core" (
        if not exist "!AGENTS_SKILLS_DIR!" mkdir "!AGENTS_SKILLS_DIR!"
        for %%S in (plannotator-review plannotator-annotate plannotator-last) do (
            if exist "apps\skills\core\%%S" (
                REM Replace rather than merge so files removed upstream don't linger.
                if exist "!AGENTS_SKILLS_DIR!\%%S" rmdir /s /q "!AGENTS_SKILLS_DIR!\%%S" >nul 2>&1
                xcopy /s /i /y /q "apps\skills\core\%%S" "!AGENTS_SKILLS_DIR!\%%S\" >nul 2>&1
            )
        )
        echo Installed shared agent skills to !AGENTS_SKILLS_DIR!\
    ) else (
        echo Tag !TAG! predates the core/extra skill layout — skipping core skill install
    )

    REM OpenCode command stubs -> always (plugin intercepts execution).
    if exist "apps\opencode-plugin\commands" (
        if not exist "!OPENCODE_COMMANDS_DIR!" mkdir "!OPENCODE_COMMANDS_DIR!"
        xcopy /y /q "apps\opencode-plugin\commands\*.md" "!OPENCODE_COMMANDS_DIR!\" >nul 2>&1
        echo Installed OpenCode commands to !OPENCODE_COMMANDS_DIR!\
    )

    REM Gemini TOML commands -> only when ~/.gemini exists (Gemini's native format).
    if exist "%USERPROFILE%\.gemini" if exist "apps\gemini\commands" (
        if not exist "!GEMINI_COMMANDS_DIR!" mkdir "!GEMINI_COMMANDS_DIR!"
        xcopy /y /q "apps\gemini\commands\*.toml" "!GEMINI_COMMANDS_DIR!\" >nul 2>&1
        echo Installed Gemini commands to !GEMINI_COMMANDS_DIR!\
    )

    REM Kiro -> hand-maintained kiro skills (3) + 2 extras, only when detected.
    if "!KIRO_AVAILABLE!"=="1" if exist "apps\kiro-cli\skills" (
        if not exist "!KIRO_SKILLS_DIR!" mkdir "!KIRO_SKILLS_DIR!"
        REM Kiro-specific skills with origin baked in come from apps\kiro-cli\skills.
        for %%S in (plannotator-review plannotator-annotate) do (
            if exist "apps\kiro-cli\skills\%%S" (
                if exist "!KIRO_SKILLS_DIR!\%%S" rmdir /s /q "!KIRO_SKILLS_DIR!\%%S" >nul 2>&1
                xcopy /s /i /y /q "apps\kiro-cli\skills\%%S" "!KIRO_SKILLS_DIR!\%%S\" >nul 2>&1
            )
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
        REM Plannotator custom agent — don't clobber a user's existing one.
        if not exist "!KIRO_AGENTS_DIR!\plannotator.json" if exist "apps\kiro-cli\agents\plannotator.json" (
            if not exist "!KIRO_AGENTS_DIR!" mkdir "!KIRO_AGENTS_DIR!"
            copy /y "apps\kiro-cli\agents\plannotator.json" "!KIRO_AGENTS_DIR!\plannotator.json" >nul 2>&1
        )
        echo Installed Kiro skills to !KIRO_SKILLS_DIR!\ and agent to !KIRO_AGENTS_DIR!\plannotator.json
    )

    popd
) else (
    set "CHECKOUT_FAILED=1"
)

rmdir /s /q "!SKILLS_TMP!" >nul 2>&1

if "!CHECKOUT_FAILED!"=="1" (
    echo Error: unable to fetch !REPO! at !TAG! ^(network or git error^). 1>&2
    echo Something went wrong — run the installer again. 1>&2
    exit /b 1
)

REM Claude Code commands are deprecated in favor of skills. Remove a legacy
REM command file only once its replacement skill is actually on disk — running
REM AFTER the install above guarantees a failed or skipped skill install never
REM leaves users with neither the command nor the skill.
for %%C in (plannotator-review plannotator-annotate plannotator-last) do (
    if exist "!CLAUDE_SKILLS_DIR!\%%C" if exist "!CLAUDE_COMMANDS_DIR!\%%C.md" (
        del /q "!CLAUDE_COMMANDS_DIR!\%%C.md" >nul 2>&1
        echo Removed deprecated Claude command !CLAUDE_COMMANDS_DIR!\%%C.md ^(replaced by the %%C skill^)
    )
)

REM plannotator-archive no longer ships as a skill. Remove any stale installed
REM copy from every skill scope so upgraders don't keep a dead skill around.
for %%D in ("!CLAUDE_SKILLS_DIR!" "!AGENTS_SKILLS_DIR!" "!KIRO_SKILLS_DIR!") do (
    if exist "%%~D\plannotator-archive" (
        rmdir /s /q "%%~D\plannotator-archive" >nul 2>&1
        echo Removed stale plannotator-archive skill from %%~D\plannotator-archive
    )
)

REM Codex no longer hosts core skills (they live in %%USERPROFILE%%\.agents\skills).
REM Core skills are removed only once their replacement exists; the stale
REM shared-agent extras were never Codex's and are removed unconditionally.
for %%S in (plannotator-review plannotator-annotate plannotator-last plannotator-compound plannotator-setup-goal) do (
    if exist "!STALE_CODEX_SKILLS_DIR!\%%S" (
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
if defined INVOCABLE_CHOICE if not "!INVOCABLE_CHOICE!"=="none" (
    for %%K in ("!INVOCABLE_CHOICE:,=" "!") do (
        for %%D in ("!CLAUDE_SKILLS_DIR!" "!AGENTS_SKILLS_DIR!") do (
            if exist "%%~D\%%~K\SKILL.md" (
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
REM is no settings.json package-skills filter to configure.
where pi >nul 2>&1
if !ERRORLEVEL! equ 0 (
    echo Updating Pi extension...
    pi install npm:@plannotator/pi-extension
    if !ERRORLEVEL! equ 0 (
        echo Pi extension updated.
    ) else (
        echo Skipping Pi update ^(pi install failed^)
    )
)

REM --- Gemini CLI support (only if Gemini is installed) ---
if exist "%USERPROFILE%\.gemini" (
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

echo.
echo ==========================================
echo   KIRO CLI USERS
echo ==========================================
echo.
if "!KIRO_AVAILABLE!"=="1" (
    echo Kiro skills are installed to %USERPROFILE%\.kiro\skills\
    echo The Plannotator agent is installed to %USERPROFILE%\.kiro\agents\plannotator.json
    echo Launch it: kiro-cli chat --agent plannotator
) else (
    echo Kiro was not detected. After installing Kiro, rerun this installer to add Kiro skills.
)

echo.
echo Test the install:
echo   echo {"tool_input":{"plan":"# Test Plan\\n\\nHello world"}} ^| plannotator
echo.
echo Then install the Claude Code plugin:
echo   /plugin marketplace add backnotprop/plannotator
echo   /plugin install plannotator@plannotator
echo.
echo Upgrading from an older version? Also run /plugin marketplace update
echo so the plugin drops its old plannotator:* command entries.
echo.
echo The /plannotator-review, /plannotator-annotate, and /plannotator-last skills are ready to use!
if not "!EXTRAS_CHOICE!"=="yes" (
    echo.
    echo Optional skills ^(compound planning, setup-goal, visual explainer^):
    echo   npx skills add backnotprop/plannotator/apps/skills/extra
)

REM Warn if plannotator is configured in both settings.json hooks AND the plugin (causes double execution)
REM Only warn when the plugin is installed — manual-only users won't have overlap
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

echo.
exit /b 0

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
    echo Extra skills already installed — keeping them.
    set "EXTRAS_CHOICE=yes"
) else if defined EXTRAS_FLAG (
    REM Flag already answered this question — don't ask and then ignore.
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
    REM Flag already answered this question — don't ask and then ignore.
    set "INVOCABLE_CHOICE=!MODEL_INVOCABLE_FLAG!"
    goto :glimpse_question
)
set "ANSWER="
set /p "ANSWER=Make any skills callable by the model (instead of user-invoked only)? [y/N] "
set "WANT_INVOCABLE=no"
if /i "!ANSWER!"=="y" set "WANT_INVOCABLE=yes"
if /i "!ANSWER!"=="yes" set "WANT_INVOCABLE=yes"
if "!WANT_INVOCABLE!"=="no" (
    set "INVOCABLE_CHOICE=none"
    goto :glimpse_question
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
REM Preselect previously chosen skills. NOTE: no pipes here — each side of a
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
:glimpse_question
if "!GLIMPSE_PRESENT!"=="1" (
    echo Glimpse already installed — Plannotator will open in its native window.
    set "GLIMPSE_CHOICE=yes"
    goto :eof
)
if defined GLIMPSE_FLAG (
    REM Flag already answered this question — don't ask and then ignore.
    set "GLIMPSE_CHOICE=!GLIMPSE_FLAG!"
    goto :eof
)
set "DEF_GLIMPSE=yes"
if defined SAVED_GLIMPSE set "DEF_GLIMPSE=!SAVED_GLIMPSE!"
set "ANSWER="
set /p "ANSWER=Install Glimpse so Plannotator opens in a native window instead of a browser tab? (npm i -g glimpseui) [Y/n] "
set "GLIMPSE_CHOICE=!DEF_GLIMPSE!"
if /i "!ANSWER!"=="y" set "GLIMPSE_CHOICE=yes"
if /i "!ANSWER!"=="yes" set "GLIMPSE_CHOICE=yes"
if /i "!ANSWER!"=="n" set "GLIMPSE_CHOICE=no"
if /i "!ANSWER!"=="no" set "GLIMPSE_CHOICE=no"
goto :eof
