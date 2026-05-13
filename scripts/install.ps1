# Plannotator Windows Installer
param(
    [string]$Version = "latest",
    [switch]$VerifyAttestation,
    [switch]$SkipAttestation
)

$ErrorActionPreference = "Stop"

# Reject mutually-exclusive flag combinations upfront. Passing both is
# almost always a typo or wrapper-script misconfiguration; guessing which
# one the user meant is worse than failing fast.
if ($VerifyAttestation -and $SkipAttestation) {
    [Console]::Error.WriteLine("-VerifyAttestation and -SkipAttestation are mutually exclusive. Pass one or the other.")
    exit 1
}

$repo = "backnotprop/plannotator"
$installDir = "$env:LOCALAPPDATA\plannotator"

# First plannotator release that carries SLSA build-provenance attestations.
# See scripts/install.sh for the full explanation — this constant is bumped
# once at the first attested release via the release skill.
$minAttestedVersion = "v0.17.2"

# Detect architecture. Native ARM64 Windows binaries are built from
# bun-windows-arm64 (stable since Bun v1.3.10), so ARM64 hosts get a
# native binary — no Windows x86-64 emulation tax.
#
# PROCESSOR_ARCHITECTURE reports the architecture the current PowerShell
# process is running under. PROCESSOR_ARCHITEW6432 is set only in 32-bit
# processes running via WoW64 and reflects the HOST architecture. Prefer
# the latter when present so a 32-bit PowerShell on ARM64 Windows still
# selects the native arm64 binary. Matches install.cmd's detection.
if (-not [Environment]::Is64BitOperatingSystem) {
    # Write-Error under $ErrorActionPreference = "Stop" (set at the top
    # of this file) raises a terminating error that exits the process
    # with code 1. No explicit `exit 1` needed here — it would be
    # unreachable. Same applies to every other Write-Error in this file.
    Write-Error "32-bit Windows is not supported"
}
$hostArch = if ($env:PROCESSOR_ARCHITEW6432) {
    $env:PROCESSOR_ARCHITEW6432
} else {
    $env:PROCESSOR_ARCHITECTURE
}
if ($hostArch -eq "ARM64") {
    $arch = "arm64"
} elseif ($hostArch -eq "AMD64") {
    $arch = "x64"
} else {
    Write-Error "Unsupported Windows architecture: $hostArch"
}

$platform = "win32-$arch"
$binaryName = "plannotator-$platform.exe"

# Clean up old install locations that may take precedence in PATH
$oldLocations = @(
    "$env:USERPROFILE\.local\bin\plannotator.exe",
    "$env:USERPROFILE\.local\bin\plannotator"
)

foreach ($oldPath in $oldLocations) {
    if (Test-Path $oldPath) {
        Write-Host "Removing old installation at $oldPath..."
        Remove-Item -Force $oldPath -ErrorAction SilentlyContinue
    }
}

if ($Version -eq "latest") {
    Write-Host "Fetching latest version..."
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest"
    $latestTag = $release.tag_name

    if (-not $latestTag) {
        Write-Error "Failed to fetch latest version"
    }
} else {
    # Normalize: auto-prefix v if missing (matches install.cmd behaviour)
    if ($Version -like "v*") {
        $latestTag = $Version
    } else {
        $latestTag = "v$Version"
    }
}

Write-Host "Installing plannotator $latestTag..."

# Resolve SLSA build-provenance verification opt-in BEFORE the download so we
# can fail fast without wasting bandwidth if the requested tag predates
# provenance support. Precedence: CLI flag > env var > config file > default.
$verifyAttestationResolved = $false

# Layer 3: config file (lowest precedence of the opt-in sources).
$configPath = "$env:USERPROFILE\.plannotator\config.json"
if (Test-Path $configPath) {
    try {
        $cfg = Get-Content $configPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        # Strict check: only a real JSON `true` (parsed as [bool]$true) opts in.
        # A stringified "true", a number, etc. do not — matches install.sh, which
        # greps for a literal boolean.
        if ($cfg.verifyAttestation -is [bool] -and $cfg.verifyAttestation) {
            $verifyAttestationResolved = $true
        }
    } catch {
        # Malformed config — ignore, fall through to other layers.
    }
}

# Layer 2: env var (overrides config file).
$envVerify = $env:PLANNOTATOR_VERIFY_ATTESTATION
if ($envVerify) {
    if ($envVerify -match '^(1|true|yes)$') {
        $verifyAttestationResolved = $true
    } elseif ($envVerify -match '^(0|false|no)$') {
        $verifyAttestationResolved = $false
    }
}

# Layer 1: CLI flags win. -VerifyAttestation and -SkipAttestation are
# mutually exclusive and already rejected together at the top of this
# script (lines ~13-16), so at most one of these branches can fire.
if ($VerifyAttestation) { $verifyAttestationResolved = $true }
if ($SkipAttestation)   { $verifyAttestationResolved = $false }

# Pre-flight: if verification is requested, reject tags older than the first
# attested release before we download anything. Uses PowerShell's [version]
# class for proper numeric comparison (lexicographic string cmp gets
# v0.9.0 vs v0.10.0 backwards).
if ($verifyAttestationResolved) {
    # Pre-release and build-metadata tags (e.g. v0.18.0-rc1) are not
    # supported by [System.Version] — the cast throws on any `-` suffix.
    # install.sh handles these correctly via `sort -V`; Windows has no
    # built-in semver comparator, so we detect and reject explicitly
    # with an accurate error rather than surfacing a confusing "could
    # not parse" message from the catch block below.
    if ($latestTag -match '-') {
        [Console]::Error.WriteLine("Pre-release tags like $latestTag aren't currently supported for provenance verification on Windows. [System.Version] doesn't parse semver prerelease suffixes. Options:")
        [Console]::Error.WriteLine("  - Install without provenance verification: -SkipAttestation")
        [Console]::Error.WriteLine("  - Pin to a stable release tag (no -rc, -beta, etc.)")
        exit 1
    }
    try {
        $resolvedVersion = [version]($latestTag -replace '^v', '')
        $minVersion = [version]($minAttestedVersion -replace '^v', '')
    } catch {
        # Write-Error under Stop raises a new terminating error that
        # propagates past this catch and exits the script with code 1.
        Write-Error "Could not parse version tags for provenance check: latest=$latestTag min=$minAttestedVersion"
    }
    if ($resolvedVersion -lt $minVersion) {
        [Console]::Error.WriteLine("Provenance verification was requested, but $latestTag predates plannotator's attestation support.")
        [Console]::Error.WriteLine("The first release carrying signed build provenance is $minAttestedVersion. Options:")
        [Console]::Error.WriteLine("  - Pin to $minAttestedVersion or later: -Version $minAttestedVersion")
        [Console]::Error.WriteLine("  - Install without provenance verification: -SkipAttestation")
        [Console]::Error.WriteLine("  - Or unset PLANNOTATOR_VERIFY_ATTESTATION / remove verifyAttestation from $configPath")
        exit 1
    }
}

$binaryUrl = "https://github.com/$repo/releases/download/$latestTag/$binaryName"
$checksumUrl = "$binaryUrl.sha256"

# Create install directory
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

$tmpFile = [System.IO.Path]::GetTempFileName()

# Use -UseBasicParsing to avoid security prompts and ensure consistent behavior
Invoke-WebRequest -Uri $binaryUrl -OutFile $tmpFile -UseBasicParsing

# Verify checksum
# Note: In Windows PowerShell 5.1, Invoke-WebRequest returns .Content as byte[] for non-HTML responses.
# We must handle both byte[] (PS 5.1) and string (PS 7+) for cross-version compatibility.
$checksumResponse = Invoke-WebRequest -Uri $checksumUrl -UseBasicParsing
if ($checksumResponse.Content -is [byte[]]) {
    $checksumContent = [System.Text.Encoding]::UTF8.GetString($checksumResponse.Content)
} else {
    $checksumContent = $checksumResponse.Content
}
$expectedChecksum = $checksumContent.Split(" ")[0].Trim().ToLower()
$actualChecksum = (Get-FileHash -Path $tmpFile -Algorithm SHA256).Hash.ToLower()

if ($actualChecksum -ne $expectedChecksum) {
    Remove-Item $tmpFile -Force
    Write-Error "Checksum verification failed!"
}

if ($verifyAttestationResolved) {
    # $verifyAttestationResolved was decided before the download and the
    # MIN_ATTESTED_VERSION pre-flight already rejected older tags. At this
    # point we know the tag is attested and gh should find a bundle.
    if (Get-Command gh -ErrorAction SilentlyContinue) {
        # Constrain verification to the exact tag + signing workflow — see
        # install.sh comment for rationale.
        $verifyOutput = & gh attestation verify $tmpFile `
            --repo $repo `
            --source-ref "refs/tags/$latestTag" `
            --signer-workflow "backnotprop/plannotator/.github/workflows/release.yml" 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "✓ verified build provenance (SLSA)"
        } else {
            # Write to stderr directly — Write-Host goes to PowerShell's
            # Information stream, which is silently dropped when callers
            # redirect stderr for error reporting in CI/CD pipelines.
            #
            # `& gh ... 2>&1` captures multi-line output as an object[]
            # array. Passing the array directly to [Console]::Error.WriteLine
            # binds to the WriteLine(object) overload, which calls ToString()
            # on the array and yields the useless literal "System.Object[]".
            # Out-String normalizes the array back into a single formatted
            # string so the actual gh diagnostic is visible.
            [Console]::Error.WriteLine(($verifyOutput | Out-String).TrimEnd())
            Remove-Item $tmpFile -Force
            Write-Error "Attestation verification failed! The binary's SHA256 matched, but no valid signed provenance was found for $repo. Refusing to install."
        }
    } else {
        Remove-Item $tmpFile -Force
        Write-Error "verifyAttestation is enabled but gh CLI was not found. Install https://cli.github.com (and run 'gh auth login'), or unset PLANNOTATOR_VERIFY_ATTESTATION / remove verifyAttestation from $configPath / pass -SkipAttestation."
    }
} else {
    Write-Host "SHA256 verified. For build provenance verification, see"
    Write-Host "https://plannotator.ai/docs/getting-started/installation/#verifying-your-install"
}

Move-Item -Force $tmpFile "$installDir\plannotator.exe"

Write-Host ""
Write-Host "plannotator $latestTag installed to $installDir\plannotator.exe"

# Add to PATH if not already there
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$installDir*") {
    Write-Host ""
    Write-Host "$installDir is not in your PATH. Adding it..."
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$installDir", "User")
    Write-Host "Added to PATH. Restart your terminal for changes to take effect."
}

# Validate plugin hooks.json if plugin is already installed
$pluginHooks = if ($env:CLAUDE_CONFIG_DIR) { "$env:CLAUDE_CONFIG_DIR\plugins\marketplaces\plannotator\apps\hook\hooks\hooks.json" } else { "$env:USERPROFILE\.claude\plugins\marketplaces\plannotator\apps\hook\hooks\hooks.json" }
if (Test-Path $pluginHooks) {
    # Use full path on Windows so the hook works without PATH being set in the shell
    $exePath = "$installDir\plannotator.exe"
    # Convert backslashes to forward slashes and escape for JSON
    $exePathJson = $exePath.Replace('\', '/')
    @"
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "EnterPlanMode",
        "hooks": [
          {
            "type": "command",
            "command": "$exePathJson improve-context",
            "timeout": 5
          }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "matcher": "ExitPlanMode",
        "hooks": [
          {
            "type": "command",
            "command": "$exePathJson",
            "timeout": 345600
          }
        ]
      }
    ]
  }
}
"@ | Set-Content -Path $pluginHooks
    Write-Host "Updated plugin hooks at $pluginHooks"
}

# Codex hooks on Windows are still experimental upstream. Do not mutate
# $env:USERPROFILE\.codex automatically from the Windows installer until that
# path is verified end-to-end.
$codexDir = "$env:USERPROFILE\.codex"
$codexHomeHasUserConfig = $false
if (Test-Path $codexDir) {
    $codexHomeHasUserConfig = [bool](Get-ChildItem -Force $codexDir -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne "skills" -and $_.Name -ne ".DS_Store" } |
        Select-Object -First 1)
}
$codexAvailable = [bool](Get-Command codex -ErrorAction SilentlyContinue) -or $codexHomeHasUserConfig

if ($codexAvailable) {
    $codexExePath = "$installDir\plannotator.exe"
    Write-Host ""
    Write-Host "Codex detected."
    Write-Host "Codex plan review hooks are experimental on Windows. To try them manually:"
    Write-Host ""
    Write-Host "  1. Add this to $env:USERPROFILE\.codex\config.toml:"
    Write-Host ""
    Write-Host "     [features]"
    Write-Host "     hooks = true"
    Write-Host ""
    Write-Host "  2. Add a Stop hook in $env:USERPROFILE\.codex\hooks.json that runs:"
    Write-Host ""
    Write-Host "     $codexExePath"
}

# Clear OpenCode plugin cache
Remove-Item -Recurse -Force "$env:USERPROFILE\.cache\opencode\node_modules\@plannotator" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:USERPROFILE\.cache\opencode\packages\@plannotator" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:USERPROFILE\.bun\install\cache\@plannotator" -ErrorAction SilentlyContinue

# Clear Pi jiti cache to force fresh download on next run
Remove-Item -Recurse -Force "$env:TEMP\jiti" -ErrorAction SilentlyContinue

function Test-PlannotatorSharedAgentSkillsAvailable {
    $agentsSkillsDir = "$env:USERPROFILE\.agents\skills"
    return (Test-Path (Join-Path $agentsSkillsDir "plannotator-compound\SKILL.md")) -and
        (Test-Path (Join-Path $agentsSkillsDir "plannotator-setup-goal\SKILL.md")) -and
        (Test-Path (Join-Path $agentsSkillsDir "plannotator-visual-explainer\SKILL.md"))
}

function Configure-PiPlannotatorPackageFilter {
    $piAgentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { "$env:USERPROFILE\.pi\agent" }
    $piSettings = Join-Path $piAgentDir "settings.json"

    if (-not (Test-Path $piSettings)) {
        return
    }

    try {
        $settings = Get-Content -Path $piSettings -Raw -ErrorAction Stop | ConvertFrom-Json
    } catch {
        Write-Host "Skipping Pi settings update (could not parse settings.json)"
        return
    }

    if ($null -eq $settings -or $null -eq $settings.packages) {
        return
    }

    $packagePattern = "^(?:npm:)?@plannotator/pi-extension(?:@.+)?$"
    $changed = $false
    $packages = @()

    foreach ($entry in @($settings.packages)) {
        if ($entry -is [string] -and $entry -match $packagePattern) {
            $packages += [pscustomobject]@{
                source = $entry
                skills = @()
            }
            $changed = $true
            continue
        }

        $sourceProperty = $null
        if ($entry -and $entry.PSObject) {
            $sourceProperty = $entry.PSObject.Properties["source"]
        }

        if ($sourceProperty -and $sourceProperty.Value -is [string] -and $sourceProperty.Value -match $packagePattern) {
            $skillsProperty = $entry.PSObject.Properties["skills"]
            if (-not $skillsProperty -or @($skillsProperty.Value).Count -ne 0) {
                if ($skillsProperty) {
                    $entry.skills = @()
                } else {
                    $entry | Add-Member -NotePropertyName "skills" -NotePropertyValue @()
                }
                $changed = $true
            }
        }

        $packages += $entry
    }

    if (-not $changed) {
        return
    }

    $settings.packages = @($packages)
    $tmpPath = [System.IO.Path]::GetTempFileName()

    try {
        $json = ($settings | ConvertTo-Json -Depth 20) + "`n"
        $utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false
        [System.IO.File]::WriteAllText($tmpPath, $json, $utf8NoBom)
        Move-Item -Force $tmpPath $piSettings
        Write-Host "Configured Pi to use global Plannotator skills and skip bundled package skills."
    } catch {
        Write-Host "Skipping Pi settings update (could not rewrite settings.json)"
        Remove-Item -Force $tmpPath -ErrorAction SilentlyContinue
    }
}

function Update-PiExtensionIfPresent {
    if (-not (Get-Command pi -ErrorAction SilentlyContinue)) {
        return
    }

    Write-Host "Updating Pi extension..."
    pi install npm:@plannotator/pi-extension
    if ($LASTEXITCODE -eq 0) {
        if (Test-PlannotatorSharedAgentSkillsAvailable) {
            Configure-PiPlannotatorPackageFilter
        } else {
            Write-Host "Leaving Pi bundled skills enabled (global Plannotator agent skills not found)."
        }
        Write-Host "Pi extension updated."
    } else {
        Write-Host "Skipping Pi settings update (pi install failed)"
    }
}

# Install Claude Code slash command
$claudeCommandsDir = if ($env:CLAUDE_CONFIG_DIR) { "$env:CLAUDE_CONFIG_DIR\commands" } else { "$env:USERPROFILE\.claude\commands" }
New-Item -ItemType Directory -Force -Path $claudeCommandsDir | Out-Null

@'
---
description: Open interactive code review for current changes or a PR URL
allowed-tools: Bash(plannotator:*)
---

## Code Review Feedback

!`plannotator review $ARGUMENTS`

## Your task

If the review above contains feedback or annotations, address them. If no changes were requested, acknowledge and continue.
'@ | Set-Content -Path "$claudeCommandsDir\plannotator-review.md"

Write-Host "Installed /plannotator-review command to $claudeCommandsDir\plannotator-review.md"

# Install Claude Code /annotate slash command
@'
---
description: Open interactive annotation UI for a markdown file
allowed-tools: Bash(plannotator:*)
---

## Markdown Annotations

!`plannotator annotate $ARGUMENTS`

## Your task

Address the annotation feedback above. The user has reviewed the markdown file and provided specific annotations and comments.
'@ | Set-Content -Path "$claudeCommandsDir\plannotator-annotate.md"

Write-Host "Installed /plannotator-annotate command to $claudeCommandsDir\plannotator-annotate.md"

# Install Claude Code /plannotator-last slash command
@'
---
description: Annotate the last rendered assistant message
allowed-tools: Bash(plannotator:*)
---

## Message Annotations

!`plannotator annotate-last`

## Your task

Address the annotation feedback above. The user has reviewed your last message and provided specific annotations and comments.
'@ | Set-Content -Path "$claudeCommandsDir\plannotator-last.md"

Write-Host "Installed /plannotator-last command to $claudeCommandsDir\plannotator-last.md"

# Install OpenCode slash command
$opencodeCommandsDir = "$env:USERPROFILE\.config\opencode\command"
New-Item -ItemType Directory -Force -Path $opencodeCommandsDir | Out-Null

@"
---
description: Open interactive code review for current changes
---

The Plannotator Code Review has been triggered. Opening the review UI...
Acknowledge "Opening code review..." and wait for the user's feedback.
"@ | Set-Content -Path "$opencodeCommandsDir\plannotator-review.md"

Write-Host "Installed /plannotator-review command to $opencodeCommandsDir\plannotator-review.md"

# Install OpenCode /annotate slash command
@"
---
description: Open interactive annotation UI for a markdown file
---

The Plannotator Annotate has been triggered. Opening the annotation UI...
Acknowledge "Opening annotation UI..." and wait for the user's feedback.
"@ | Set-Content -Path "$opencodeCommandsDir\plannotator-annotate.md"

Write-Host "Installed /plannotator-annotate command to $opencodeCommandsDir\plannotator-annotate.md"

# Install OpenCode /plannotator-last slash command
@"
---
description: Annotate the last assistant message
---
"@ | Set-Content -Path "$opencodeCommandsDir\plannotator-last.md"

Write-Host "Installed /plannotator-last command to $opencodeCommandsDir\plannotator-last.md"

# Remove legacy Codex-oriented skills from the older shared agent scope.
$legacyAgentsSkillsDir = "$env:USERPROFILE\.agents\skills"
$legacySkillsRemoved = $false
foreach ($skill in @("plannotator-review", "plannotator-annotate", "plannotator-last")) {
    $legacySkillPath = Join-Path $legacyAgentsSkillsDir $skill
    if (Test-Path $legacySkillPath) {
        Remove-Item -Recurse -Force $legacySkillPath -ErrorAction SilentlyContinue
        $legacySkillsRemoved = $true
    }
}
if ($legacySkillsRemoved) {
    Write-Host "Removed legacy Plannotator skills from $legacyAgentsSkillsDir"
}

# Remove Plannotator skills that belong in the shared agent scope from Codex.
$staleCodexSkillsDir = "$env:USERPROFILE\.codex\skills"
$staleCodexSkillsRemoved = $false
foreach ($skill in @("plannotator-compound", "plannotator-setup-goal")) {
    $staleSkillPath = Join-Path $staleCodexSkillsDir $skill
    if (Test-Path $staleSkillPath) {
        Remove-Item -Recurse -Force $staleSkillPath -ErrorAction SilentlyContinue
        $staleCodexSkillsRemoved = $true
    }
}
if ($staleCodexSkillsRemoved) {
    Write-Host "Removed shared-agent Plannotator skills from $staleCodexSkillsDir"
}

# Install skills (requires git)
if (Get-Command git -ErrorAction SilentlyContinue) {
    $claudeSkillsDir = if ($env:CLAUDE_CONFIG_DIR) { "$env:CLAUDE_CONFIG_DIR\skills" } else { "$env:USERPROFILE\.claude\skills" }
    $codexSkillsDir = "$env:USERPROFILE\.codex\skills"
    $agentsSkillsDir = "$env:USERPROFILE\.agents\skills"
    $skillsTmp = Join-Path ([System.IO.Path]::GetTempPath()) "plannotator-skills-$(Get-Random)"
    New-Item -ItemType Directory -Force -Path $skillsTmp | Out-Null

    function Copy-SkillIfPresent {
        param(
            [string]$SourceDir,
            [string]$TargetDir
        )

        if (Test-Path $SourceDir) {
            Copy-Item -Recurse -Force $SourceDir $TargetDir
        }
    }

    try {
        git clone --depth 1 --filter=blob:none --sparse "https://github.com/$repo.git" --branch $latestTag "$skillsTmp\repo" 2>$null
        # git is a native executable — it does not throw under
        # $ErrorActionPreference=Stop on non-zero exit. Guard with
        # Test-Path so we only Push-Location if the clone actually
        # produced a repo directory.
        if (Test-Path "$skillsTmp\repo") {
            Push-Location "$skillsTmp\repo"
            # Inner try/finally guarantees Pop-Location runs exactly once
            # after a successful Push-Location, regardless of whether the
            # copy operations below throw. The naive pattern (Pop-Location
            # only on the success path) leaks the location stack if a
            # PS-native cmdlet (Copy-Item etc.) throws under Stop.
            try {
                git sparse-checkout set apps/skills 2>$null

                if (Test-Path "apps\skills") {
                    $items = Get-ChildItem "apps\skills" -ErrorAction SilentlyContinue
                    if ($items) {
                        New-Item -ItemType Directory -Force -Path $claudeSkillsDir | Out-Null
                        New-Item -ItemType Directory -Force -Path $agentsSkillsDir | Out-Null
                        Copy-Item -Recurse -Force "apps\skills\*" $claudeSkillsDir
                        Copy-SkillIfPresent "apps\skills\plannotator-compound" $agentsSkillsDir
                        Copy-SkillIfPresent "apps\skills\plannotator-setup-goal" $agentsSkillsDir
                        Copy-SkillIfPresent "apps\skills\plannotator-visual-explainer" $agentsSkillsDir
                        if ($codexAvailable) {
                            New-Item -ItemType Directory -Force -Path $codexSkillsDir | Out-Null
                            Copy-SkillIfPresent "apps\skills\plannotator-review" $codexSkillsDir
                            Copy-SkillIfPresent "apps\skills\plannotator-annotate" $codexSkillsDir
                            Copy-SkillIfPresent "apps\skills\plannotator-last" $codexSkillsDir
                            Write-Host "Installed skills to $claudeSkillsDir\, Codex command skills to $codexSkillsDir\, and shared agent skills to $agentsSkillsDir\"
                        } else {
                            Write-Host "Installed skills to $claudeSkillsDir\ and shared agent skills to $agentsSkillsDir\"
                        }
                    }
                }
            } finally {
                Pop-Location
            }
        }
    } catch {
        Write-Host "Skipping skills install (git sparse-checkout failed)"
    }

    Remove-Item -Recurse -Force $skillsTmp -ErrorAction SilentlyContinue
} else {
    Write-Host "Skipping skills install (git not found)"
}

# Update Pi extension if pi is installed. When global shared skills are
# available, keep the extension commands but disable its bundled skill copy to
# avoid duplicate Pi skill warnings.
Update-PiExtensionIfPresent

# --- Gemini CLI support (only if Gemini is installed) ---
$geminiDir = "$env:USERPROFILE\.gemini"
if (Test-Path $geminiDir) {
    # Install policy file
    $geminiPoliciesDir = "$geminiDir\policies"
    New-Item -ItemType Directory -Force -Path $geminiPoliciesDir | Out-Null
    @'
# Plannotator policy for Gemini CLI
# Allows exit_plan_mode without TUI confirmation so the browser UI is the sole gate.
[[rule]]
toolName = "exit_plan_mode"
decision = "allow"
priority = 100
'@ | Set-Content -Path "$geminiPoliciesDir\plannotator.toml"
    Write-Host "Installed Gemini policy to $geminiPoliciesDir\plannotator.toml"

    # Configure hook in settings.json
    $geminiSettings = "$geminiDir\settings.json"
    if (Test-Path $geminiSettings) {
        $content = Get-Content -Path $geminiSettings -Raw -ErrorAction SilentlyContinue
        if ($content -notmatch '"plannotator"') {
            # Merge hook into existing settings.json using node (ships with Gemini CLI)
            if (Get-Command node -ErrorAction SilentlyContinue) {
                $mergeScript = @"
const fs = require('fs');
const settings = JSON.parse(fs.readFileSync('$($geminiSettings.Replace('\','/'))', 'utf8'));
if (!settings.hooks) settings.hooks = {};
if (!settings.hooks.BeforeTool) settings.hooks.BeforeTool = [];
settings.hooks.BeforeTool.push({"matcher":"exit_plan_mode","hooks":[{"type":"command","command":"plannotator","timeout":345600}]});
fs.writeFileSync('$($geminiSettings.Replace('\','/'))', JSON.stringify(settings, null, 2) + '\n');
"@
                node -e $mergeScript
                Write-Host "Added plannotator hook to $geminiSettings"
            } else {
                Write-Host ""
                Write-Host "Add the following to your ~/.gemini/settings.json hooks:"
                Write-Host ""
                Write-Host '  "hooks": {'
                Write-Host '    "BeforeTool": [{'
                Write-Host '      "matcher": "exit_plan_mode",'
                Write-Host '      "hooks": [{"type": "command", "command": "plannotator", "timeout": 345600}]'
                Write-Host '    }]'
                Write-Host '  }'
            }
        }
    } else {
        @'
{
  "hooks": {
    "BeforeTool": [
      {
        "matcher": "exit_plan_mode",
        "hooks": [
          {
            "type": "command",
            "command": "plannotator",
            "timeout": 345600
          }
        ]
      }
    ]
  },
  "experimental": {
    "plan": true
  }
}
'@ | Set-Content -Path $geminiSettings
        Write-Host "Created Gemini settings at $geminiSettings"
    }

    # Install slash commands
    $geminiCommandsDir = "$geminiDir\commands"
    New-Item -ItemType Directory -Force -Path $geminiCommandsDir | Out-Null

    @'
description = "Open interactive code review for current changes or a PR URL"
prompt = """
## Code Review Feedback

!{plannotator review {{args}}}

## Your task

If the review above contains feedback or annotations, address them. If no changes were requested, acknowledge and continue.
"""
'@ | Set-Content -Path "$geminiCommandsDir\plannotator-review.toml"

    @'
description = "Open interactive annotation UI for a markdown file or folder"
prompt = """
## Markdown Annotations

!{plannotator annotate {{args}}}

## Your task

Address the annotation feedback above. The user has reviewed the markdown file and provided specific annotations and comments.
"""
'@ | Set-Content -Path "$geminiCommandsDir\plannotator-annotate.toml"

    Write-Host "Installed Gemini slash commands to $geminiCommandsDir\"
}

Write-Host ""
Write-Host "=========================================="
Write-Host "  OPENCODE USERS"
Write-Host "=========================================="
Write-Host ""
Write-Host "Add the plugin to your opencode.json:"
Write-Host ""
Write-Host '  "plugin": ["@plannotator/opencode@latest"]'
Write-Host ""
Write-Host "Then restart OpenCode. The /plannotator-review, /plannotator-annotate, and /plannotator-last commands are ready!"
Write-Host ""
Write-Host "=========================================="
Write-Host "  PI USERS"
Write-Host "=========================================="
Write-Host ""
Write-Host "Install or update the extension:"
Write-Host ""
Write-Host "  pi install npm:@plannotator/pi-extension"
Write-Host ""
Write-Host "=========================================="
Write-Host "  CLAUDE CODE USERS: YOU ARE ALL SET!"
Write-Host "=========================================="
Write-Host ""
Write-Host "Install the Claude Code plugin:"
Write-Host "  /plugin marketplace add backnotprop/plannotator"
Write-Host "  /plugin install plannotator@plannotator"
Write-Host ""
Write-Host "The /plannotator-review, /plannotator-annotate, and /plannotator-last commands are ready to use after you restart Claude Code!"

# Warn if plannotator is configured in both settings.json hooks AND the plugin (causes double execution)
# Only warn when the plugin is installed — manual-only users won't have overlap
$claudeSettings = if ($env:CLAUDE_CONFIG_DIR) { "$env:CLAUDE_CONFIG_DIR\settings.json" } else { "$env:USERPROFILE\.claude\settings.json" }
if ((Test-Path $pluginHooks) -and (Test-Path $claudeSettings)) {
    $settingsContent = Get-Content -Path $claudeSettings -Raw -ErrorAction SilentlyContinue
    if ($settingsContent -match '"command".*plannotator') {
        Write-Host ""
        Write-Host "⚠️ ⚠️ ⚠️  WARNING: DUPLICATE HOOK DETECTED  ⚠️ ⚠️ ⚠️"
        Write-Host ""
        Write-Host "  plannotator was found in your settings.json hooks:"
        Write-Host "  $claudeSettings"
        Write-Host ""
        Write-Host "  This will cause plannotator to run TWICE on each plan review."
        Write-Host "  Remove the plannotator hook from settings.json and rely on the"
        Write-Host "  plugin instead (installed automatically via marketplace)."
        Write-Host ""
        Write-Host "⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️"
    }
}
