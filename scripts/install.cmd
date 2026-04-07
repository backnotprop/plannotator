@echo off
setlocal enabledelayedexpansion

REM Plannotator Windows CMD Bootstrap Script

REM Parse command line arguments
set "VERSION=latest"
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
    set "VERSION=%~2"
    shift
    shift
    goto parse_args
)
if /i "%~1"=="--verify-attestation" (
    set "VERIFY_ATTESTATION_FLAG=1"
    shift
    goto parse_args
)
if /i "%~1"=="--skip-attestation" (
    set "VERIFY_ATTESTATION_FLAG=0"
    shift
    goto parse_args
)
REM Reject any other dash-prefixed token as an unknown option, so a typoed
REM flag like --verify-attesttion fails fast instead of being interpreted as
REM a version tag (which would 404 on releases/download/v--verify-attesttion/...).
echo %~1 | findstr /b "[-]" >nul
if !ERRORLEVEL! equ 0 (
    echo Unknown option: %~1 >&2
    echo Usage: install.cmd [--version ^<tag^>] [--verify-attestation ^| --skip-attestation] >&2
    exit /b 1
)
REM Positional form: install.cmd v0.17.1 (legacy interface)
set "VERSION=%~1"
shift
goto parse_args
:args_done

set "REPO=backnotprop/plannotator"
set "INSTALL_DIR=%USERPROFILE%\.local\bin"
set "PLATFORM=win32-x64"

REM Check for 64-bit Windows
if /i "%PROCESSOR_ARCHITECTURE%"=="AMD64" goto :arch_valid
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" goto :arch_valid
if /i "%PROCESSOR_ARCHITEW6432%"=="AMD64" goto :arch_valid
if /i "%PROCESSOR_ARCHITEW6432%"=="ARM64" goto :arch_valid

echo Plannotator does not support 32-bit Windows. >&2
exit /b 1

:arch_valid

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

    REM Download release info and extract tag_name
    curl -fsSL "https://api.github.com/repos/!REPO!/releases/latest" -o "%TEMP%\release.json"
    if !ERRORLEVEL! neq 0 (
        echo Failed to get latest version >&2
        exit /b 1
    )

    REM Extract tag_name from JSON
    for /f "tokens=2 delims=:," %%i in ('findstr /c:"\"tag_name\"" "%TEMP%\release.json"') do (
        set "TAG=%%i"
        set "TAG=!TAG: =!"
        set "TAG=!TAG:"=!"
    )
    del "%TEMP%\release.json"

    if "!TAG!"=="" (
        echo Failed to parse version >&2
        exit /b 1
    )
) else (
    set "TAG=!VERSION!"
    REM Add v prefix if not present
    echo !TAG! | findstr /b "v" >nul
    if !ERRORLEVEL! neq 0 set "TAG=v!TAG!"
)

echo Installing plannotator !TAG!...

set "BINARY_NAME=plannotator-!PLATFORM!.exe"
set "BINARY_URL=https://github.com/!REPO!/releases/download/!TAG!/!BINARY_NAME!"
set "CHECKSUM_URL=!BINARY_URL!.sha256"

REM Download binary
set "TEMP_FILE=%TEMP%\plannotator-!TAG!.exe"
curl -fsSL "!BINARY_URL!" -o "!TEMP_FILE!"
if !ERRORLEVEL! neq 0 (
    echo Failed to download binary >&2
    if exist "!TEMP_FILE!" del "!TEMP_FILE!"
    exit /b 1
)

REM Download checksum
curl -fsSL "!CHECKSUM_URL!" -o "%TEMP%\checksum.txt"
if !ERRORLEVEL! neq 0 (
    echo Failed to download checksum >&2
    del "!TEMP_FILE!"
    exit /b 1
)

REM Extract expected checksum (first field)
set /p EXPECTED_CHECKSUM=<"%TEMP%\checksum.txt"
for /f "tokens=1" %%i in ("!EXPECTED_CHECKSUM!") do set "EXPECTED_CHECKSUM=%%i"
del "%TEMP%\checksum.txt"

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

REM Resolve SLSA build-provenance verification opt-in.
REM Precedence: CLI flag > env var > config.json > default (off).
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

if "!VERIFY_ATTESTATION!"=="1" (
    where gh >nul 2>&1
    if !ERRORLEVEL! equ 0 (
        gh attestation verify "!TEMP_FILE!" --repo !REPO! >nul 2>&1
        if !ERRORLEVEL! neq 0 (
            echo Attestation verification failed! >&2
            echo The binary's SHA256 matched, but no valid signed provenance was found >&2
            echo for !REPO!. Refusing to install. >&2
            del "!TEMP_FILE!"
            exit /b 1
        )
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
echo !`plannotator review $ARGUMENTS`
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
echo !`plannotator annotate $ARGUMENTS`
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
echo !`plannotator annotate-last`
echo.
echo ## Your task
echo.
echo Address the annotation feedback above. The user has reviewed your last message and provided specific annotations and comments.
) > "!CLAUDE_COMMANDS_DIR!\plannotator-last.md"

echo Installed /plannotator-last command to !CLAUDE_COMMANDS_DIR!\plannotator-last.md

REM Install skills (requires git)
where git >nul 2>&1
if !ERRORLEVEL! equ 0 (
    if defined CLAUDE_CONFIG_DIR (
        set "CLAUDE_SKILLS_DIR=%CLAUDE_CONFIG_DIR%\skills"
    ) else (
        set "CLAUDE_SKILLS_DIR=%USERPROFILE%\.claude\skills"
    )
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
            xcopy /s /y /q "apps\skills\*" "!AGENTS_SKILLS_DIR!\" >nul 2>&1
            echo Installed skills to !CLAUDE_SKILLS_DIR!\ and !AGENTS_SKILLS_DIR!\
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
echo ^!{plannotator review {{args}}}
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
echo ^!{plannotator annotate {{args}}}
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
