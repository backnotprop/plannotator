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
    echo Usage: install.cmd [--version ^<tag^>] [--verify-attestation ^| --skip-attestation] >&2
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
if exist "%USERPROFILE%\.plannotator\config.json" (
    findstr /r /c:"\"verifyAttestation\"[ 	]*:[ 	]*true" "%USERPROFILE%\.plannotator\config.json" >nul 2>&1
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
REM %%USERPROFILE%%\.codex automatically from the cmd installer until that path
REM is verified end-to-end.
set "CODEX_AVAILABLE=0"
where codex >nul 2>&1
if !ERRORLEVEL! equ 0 set "CODEX_AVAILABLE=1"
if exist "%USERPROFILE%\.codex" (
    for /f "delims=" %%C in ('dir /b /a "%USERPROFILE%\.codex" 2^>nul') do (
        if /i not "%%C"=="skills" if /i not "%%C"==".DS_Store" set "CODEX_AVAILABLE=1"
    )
)
if "!CODEX_AVAILABLE!"=="1" (
    echo.
    echo Codex detected.
    echo Codex plan review hooks are experimental on Windows. To try them manually:
    echo.
    echo   1. Add this to %%USERPROFILE%%\.codex\config.toml:
    echo.
    echo      [features]
    echo      codex_hooks = true
    echo.
    echo   2. Add a Stop hook in %%USERPROFILE%%\.codex\hooks.json that runs:
    echo.
    echo      !INSTALL_PATH!
    echo.
)

REM Clear any cached OpenCode plugin to force fresh download on next run
if exist "%USERPROFILE%\.cache\opencode\node_modules\@plannotator" rmdir /s /q "%USERPROFILE%\.cache\opencode\node_modules\@plannotator" >nul 2>&1
if exist "%USERPROFILE%\.cache\opencode\packages\@plannotator" rmdir /s /q "%USERPROFILE%\.cache\opencode\packages\@plannotator" >nul 2>&1
if exist "%USERPROFILE%\.bun\install\cache\@plannotator" rmdir /s /q "%USERPROFILE%\.bun\install\cache\@plannotator" >nul 2>&1

REM Update Pi extension if pi is installed
where pi >nul 2>&1
if !ERRORLEVEL! equ 0 (
    echo Updating Pi extension...
    pi install npm:@plannotator/pi-extension
    echo Pi extension updated.
)

REM Install /review slash command
if defined CLAUDE_CONFIG_DIR (
    set "CLAUDE_COMMANDS_DIR=%CLAUDE_CONFIG_DIR%\commands"
) else (
    set "CLAUDE_COMMANDS_DIR=%USERPROFILE%\.claude\commands"
)
if not exist "!CLAUDE_COMMANDS_DIR!" mkdir "!CLAUDE_COMMANDS_DIR!"

(
echo ---
echo description: Open interactive code review for current changes or a PR URL
echo allowed-tools: Bash^(plannotator:*^)
echo ---
echo.
echo ## Code Review Feedback
echo.
echo ^^!`plannotator review $ARGUMENTS`
echo.
echo ## Your task
echo.
echo If the review above contains feedback or annotations, address them. If no changes were requested, acknowledge and continue.
) > "!CLAUDE_COMMANDS_DIR!\plannotator-review.md"

echo Installed /plannotator-review command to !CLAUDE_COMMANDS_DIR!\plannotator-review.md

(
echo ---
echo description: Open interactive annotation UI for a markdown file
echo allowed-tools: Bash^(plannotator:*^)
echo ---
echo.
echo ## Markdown Annotations
echo.
echo ^^!`plannotator annotate $ARGUMENTS`
echo.
echo ## Your task
echo.
echo Address the annotation feedback above. The user has reviewed the markdown file and provided specific annotations and comments.
) > "!CLAUDE_COMMANDS_DIR!\plannotator-annotate.md"

echo Installed /plannotator-annotate command to !CLAUDE_COMMANDS_DIR!\plannotator-annotate.md

(
echo ---
echo description: Annotate the last rendered assistant message
echo allowed-tools: Bash^(plannotator:*^)
echo ---
echo.
echo ## Message Annotations
echo.
echo ^^!`plannotator annotate-last`
echo.
echo ## Your task
echo.
echo Address the annotation feedback above. The user has reviewed your last message and provided specific annotations and comments.
) > "!CLAUDE_COMMANDS_DIR!\plannotator-last.md"

echo Installed /plannotator-last command to !CLAUDE_COMMANDS_DIR!\plannotator-last.md

REM Install skills (requires git)
REM Remove legacy Codex-oriented skills from the older shared agent scope.
set "LEGACY_AGENTS_SKILLS_DIR=%USERPROFILE%\.agents\skills"
set "LEGACY_SKILLS_REMOVED=0"
for %%S in (plannotator-review plannotator-annotate plannotator-last) do (
    if exist "!LEGACY_AGENTS_SKILLS_DIR!\%%S" (
        rmdir /s /q "!LEGACY_AGENTS_SKILLS_DIR!\%%S" >nul 2>&1
        set "LEGACY_SKILLS_REMOVED=1"
    )
)
if "!LEGACY_SKILLS_REMOVED!"=="1" echo Removed legacy Plannotator skills from !LEGACY_AGENTS_SKILLS_DIR!

REM Remove Plannotator skills that belong in the shared agent scope from Codex.
set "STALE_CODEX_SKILLS_DIR=%USERPROFILE%\.codex\skills"
set "STALE_CODEX_SKILLS_REMOVED=0"
for %%S in (plannotator-compound plannotator-setup-goal) do (
    if exist "!STALE_CODEX_SKILLS_DIR!\%%S" (
        rmdir /s /q "!STALE_CODEX_SKILLS_DIR!\%%S" >nul 2>&1
        set "STALE_CODEX_SKILLS_REMOVED=1"
    )
)
if "!STALE_CODEX_SKILLS_REMOVED!"=="1" echo Removed shared-agent Plannotator skills from !STALE_CODEX_SKILLS_DIR!

where git >nul 2>&1
if !ERRORLEVEL! equ 0 (
    if defined CLAUDE_CONFIG_DIR (
        set "CLAUDE_SKILLS_DIR=%CLAUDE_CONFIG_DIR%\skills"
    ) else (
        set "CLAUDE_SKILLS_DIR=%USERPROFILE%\.claude\skills"
    )
    set "CODEX_SKILLS_DIR=%USERPROFILE%\.codex\skills"
    set "AGENTS_SKILLS_DIR=%USERPROFILE%\.agents\skills"
    set "SKILLS_TMP=%TEMP%\plannotator-skills-%RANDOM%"
    mkdir "!SKILLS_TMP!" >nul 2>&1

    git clone --depth 1 --filter=blob:none --sparse "https://github.com/!REPO!.git" --branch "!TAG!" "!SKILLS_TMP!\repo" >nul 2>&1
    if !ERRORLEVEL! equ 0 (
        pushd "!SKILLS_TMP!\repo"
        git sparse-checkout set apps/skills >nul 2>&1

        if exist "apps\skills" (
            if not exist "!CLAUDE_SKILLS_DIR!" mkdir "!CLAUDE_SKILLS_DIR!"
            if not exist "!AGENTS_SKILLS_DIR!" mkdir "!AGENTS_SKILLS_DIR!"
            xcopy /s /y /q "apps\skills\*" "!CLAUDE_SKILLS_DIR!\" >nul 2>&1
            if exist "apps\skills\plannotator-compound" xcopy /s /i /y /q "apps\skills\plannotator-compound" "!AGENTS_SKILLS_DIR!\plannotator-compound\" >nul 2>&1
            if exist "apps\skills\plannotator-setup-goal" xcopy /s /i /y /q "apps\skills\plannotator-setup-goal" "!AGENTS_SKILLS_DIR!\plannotator-setup-goal\" >nul 2>&1
            if "!CODEX_AVAILABLE!"=="1" (
                if not exist "!CODEX_SKILLS_DIR!" mkdir "!CODEX_SKILLS_DIR!"
                if exist "apps\skills\plannotator-review" xcopy /s /i /y /q "apps\skills\plannotator-review" "!CODEX_SKILLS_DIR!\plannotator-review\" >nul 2>&1
                if exist "apps\skills\plannotator-annotate" xcopy /s /i /y /q "apps\skills\plannotator-annotate" "!CODEX_SKILLS_DIR!\plannotator-annotate\" >nul 2>&1
                if exist "apps\skills\plannotator-last" xcopy /s /i /y /q "apps\skills\plannotator-last" "!CODEX_SKILLS_DIR!\plannotator-last\" >nul 2>&1
                echo Installed skills to !CLAUDE_SKILLS_DIR!\, Codex command skills to !CODEX_SKILLS_DIR!\, and shared agent skills to !AGENTS_SKILLS_DIR!\
            ) else (
                echo Installed skills to !CLAUDE_SKILLS_DIR!\ and shared agent skills to !AGENTS_SKILLS_DIR!\
            )
        )

        popd
    ) else (
        echo Skipping skills install ^(git sparse-checkout failed^)
    )

    rmdir /s /q "!SKILLS_TMP!" >nul 2>&1
) else (
    echo Skipping skills install ^(git not found^)
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

    REM Install slash commands
    if not exist "%USERPROFILE%\.gemini\commands" mkdir "%USERPROFILE%\.gemini\commands"

    (
echo description = "Open interactive code review for current changes or a PR URL"
echo prompt = """
echo ## Code Review Feedback
echo.
echo ^^!{plannotator review {{args}}}
echo.
echo ## Your task
echo.
echo If the review above contains feedback or annotations, address them. If no changes were requested, acknowledge and continue.
echo """
    ) > "%USERPROFILE%\.gemini\commands\plannotator-review.toml"

    (
echo description = "Open interactive annotation UI for a markdown file or folder"
echo prompt = """
echo ## Markdown Annotations
echo.
echo ^^!{plannotator annotate {{args}}}
echo.
echo ## Your task
echo.
echo Address the annotation feedback above. The user has reviewed the markdown file and provided specific annotations and comments.
echo """
    ) > "%USERPROFILE%\.gemini\commands\plannotator-annotate.toml"

    echo Installed Gemini slash commands to %USERPROFILE%\.gemini\commands\
)

echo.
echo Test the install:
echo   echo {"tool_input":{"plan":"# Test Plan\\n\\nHello world"}} ^| plannotator
echo.
echo Then install the Claude Code plugin:
echo   /plugin marketplace add backnotprop/plannotator
echo   /plugin install plannotator@plannotator
echo.
echo The /plannotator-review, /plannotator-annotate, and /plannotator-last commands are ready to use!

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
