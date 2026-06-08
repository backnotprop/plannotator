# Plannotator Windows Installer
param(
    [string]$Version = "latest",
    [switch]$VerifyAttestation,
    [switch]$SkipAttestation,
    [switch]$Extras,
    [switch]$NoExtras,
    [string]$ModelInvocable = "",
    [switch]$Glimpse,
    [switch]$NoGlimpse,
    [switch]$NonInteractive,
    [switch]$Reconfigure
)

$ErrorActionPreference = "Stop"

# Reject mutually-exclusive flag combinations upfront. Passing both is
# almost always a typo or wrapper-script misconfiguration; guessing which
# one the user meant is worse than failing fast.
if ($VerifyAttestation -and $SkipAttestation) {
    [Console]::Error.WriteLine("-VerifyAttestation and -SkipAttestation are mutually exclusive. Pass one or the other.")
    exit 1
}
if ($Extras -and $NoExtras) {
    [Console]::Error.WriteLine("-Extras and -NoExtras are mutually exclusive. Pass one or the other.")
    exit 1
}
if ($Glimpse -and $NoGlimpse) {
    [Console]::Error.WriteLine("-Glimpse and -NoGlimpse are mutually exclusive. Pass one or the other.")
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
$configDir = if ($env:PLANNOTATOR_DATA_DIR) { $env:PLANNOTATOR_DATA_DIR.Trim() } else { Join-Path $env:USERPROFILE ".plannotator" }
if ($configDir -eq "~") {
    $configDir = $env:USERPROFILE
} elseif ($configDir.StartsWith("~/") -or $configDir.StartsWith('~\')) {
    $configDir = Join-Path $env:USERPROFILE ($configDir.Substring(2))
}
$configPath = Join-Path $configDir "config.json"
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
# the Codex home automatically from the Windows installer until that
# path is verified end-to-end.
# Codex stores config and state under $env:CODEX_HOME when set, falling back
# to ~\.codex (https://developers.openai.com/codex/config-advanced). (#852)
$codexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { "$env:USERPROFILE\.codex" }
$codexHomeHasUserConfig = $false
if (Test-Path $codexDir) {
    $codexHomeHasUserConfig = [bool](Get-ChildItem -Force $codexDir -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne "skills" -and $_.Name -ne ".DS_Store" } |
        Select-Object -First 1)
}
$codexAvailable = [bool](Get-Command codex -ErrorAction SilentlyContinue) -or $codexHomeHasUserConfig
# Kiro is auto-detected like Codex/Gemini: PATH executable or an existing ~/.kiro.
$kiroAvailable = [bool](Get-Command kiro-cli -ErrorAction SilentlyContinue) -or (Test-Path "$env:USERPROFILE\.kiro")

if ($codexAvailable) {
    $codexExePath = "$installDir\plannotator.exe"
    Write-Host ""
    Write-Host "Codex detected."
    Write-Host "Codex plan review hooks are experimental on Windows. To try them manually:"
    Write-Host ""
    Write-Host "  1. Add this to $codexDir\config.toml:"
    Write-Host ""
    Write-Host "     [features]"
    Write-Host "     hooks = true"
    Write-Host ""
    Write-Host "  2. Add a Stop hook in $codexDir\hooks.json that runs:"
    Write-Host ""
    Write-Host "     $codexExePath"
}

# Clear OpenCode plugin cache
Remove-Item -Recurse -Force "$env:USERPROFILE\.cache\opencode\node_modules\@plannotator" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:USERPROFILE\.cache\opencode\packages\@plannotator" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:USERPROFILE\.bun\install\cache\@plannotator" -ErrorAction SilentlyContinue

# Clear Pi jiti cache to force fresh download on next run
Remove-Item -Recurse -Force "$env:TEMP\jiti" -ErrorAction SilentlyContinue

function Update-PiExtensionIfPresent {
    if (-not (Get-Command pi -ErrorAction SilentlyContinue)) {
        return
    }

    Write-Host "Updating Pi extension..."
    pi install npm:@plannotator/pi-extension
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Pi extension updated."
    } else {
        Write-Host "Skipping Pi extension update (pi install failed)"
    }
}

# Aggressive cleanup of stale install locations from prior versions.
# Echo each removal and ignore anything that is already gone.

# NOTE: legacy Claude command cleanup happens AFTER the skill install below —
# a command file is only removed once its replacement skill is on disk, so a
# failed or skipped skill install never leaves users with neither.
$claudeCommandsDir = if ($env:CLAUDE_CONFIG_DIR) { "$env:CLAUDE_CONFIG_DIR\commands" } else { "$env:USERPROFILE\.claude\commands" }

# NOTE: Codex stale-skill cleanup happens AFTER the skill install below — the
# core skills are only removed from the Codex home once their replacement
# exists in ~/.agents/skills, so an old pinned tag never strips Codex users
# of working skills without a successor.
$staleCodexSkillsDir = Join-Path $codexDir "skills"

# Old installers (pre core/extra split) ran a wholesale skills copy against a
# new-layout tag and could leave junk `core`/`extra` directory copies in the
# Claude skills scope. Never valid skill names — always safe to remove.
$claudeSkillsScope = if ($env:CLAUDE_CONFIG_DIR) { "$env:CLAUDE_CONFIG_DIR\skills" } else { "$env:USERPROFILE\.claude\skills" }
foreach ($junk in @("core", "extra")) {
    $junkPath = Join-Path $claudeSkillsScope $junk
    if (Test-Path $junkPath) {
        Write-Host "Removing stale layout directory $junkPath (left by an older installer)"
        Remove-Item -Recurse -Force $junkPath -ErrorAction SilentlyContinue
    }
}

# Extras (compound / setup-goal / visual-explainer) are no longer managed in
# the Claude or shared-agent skill scopes. Remove previously default-installed
# copies ONCE per machine — recorded in the migrations ledger under the
# Plannotator data dir — because copies the user reinstalls via `npx skills
# add` are byte-identical to ours and can only be told apart by remembering
# that this cleanup already ran.
$claudeSkillsDir = if ($env:CLAUDE_CONFIG_DIR) { "$env:CLAUDE_CONFIG_DIR\skills" } else { "$env:USERPROFILE\.claude\skills" }
$agentsSkillsDir = "$env:USERPROFILE\.agents\skills"
$migrationsDir = Join-Path $configDir "migrations"
$extrasMigration = Join-Path $migrationsDir "2026-06-extras-default-install-removed"
if (-not (Test-Path $extrasMigration)) {
    foreach ($skill in @("plannotator-compound", "plannotator-setup-goal", "plannotator-visual-explainer")) {
        foreach ($scopeDir in @($claudeSkillsDir, $agentsSkillsDir)) {
            $extraSkillPath = Join-Path $scopeDir $skill
            if (Test-Path $extraSkillPath) {
                Write-Host "Removing unmanaged extra skill $extraSkillPath (reinstall via npx skills add)"
                Remove-Item -Recurse -Force $extraSkillPath -ErrorAction SilentlyContinue
            }
        }
    }
    New-Item -ItemType Directory -Force -Path $migrationsDir | Out-Null
    New-Item -ItemType File -Force -Path $extrasMigration | Out-Null
}

# --- Guided install (interactive consoles only) ---
# Mirrors install.sh: two questions (extras? model-invocable skills?), answers
# persisted to install-prefs in the Plannotator data dir and reused silently on
# re-runs. -Reconfigure re-opens the wizard; -NonInteractive forces silence;
# redirected/CI runs never prompt. Flags win over everything.
$prefsFile = Join-Path $configDir "install-prefs"
$coreSkillNames = @("plannotator-review", "plannotator-annotate", "plannotator-last")
$extraSkillNames = @("plannotator-compound", "plannotator-setup-goal", "plannotator-visual-explainer")

$savedExtras = ""
$savedInvocable = ""
$savedGlimpse = ""
if (Test-Path $prefsFile) {
    foreach ($line in Get-Content $prefsFile) {
        if ($line -match '^extras=(.*)$') { $savedExtras = $Matches[1] }
        if ($line -match '^model_invocable=(.*)$') { $savedInvocable = $Matches[1] }
        if ($line -match '^glimpse=(.*)$') { $savedGlimpse = $Matches[1] }
    }
}

# Glimpse (glimpseui) gives Plannotator a native window instead of a browser
# tab; the runtime auto-detects it on PATH. Skip the question when installed.
$glimpsePresent = [bool](Get-Command glimpseui -ErrorAction SilentlyContinue)

# Extras already on disk (pre-existing or previously npx-installed)? Then the
# extras question is moot — they still count toward the checkbox list, and we
# never launch the npx flow over them.
$extrasPresent = $false
foreach ($skill in $extraSkillNames) {
    if ((Test-Path (Join-Path $claudeSkillsDir $skill)) -or (Test-Path (Join-Path $agentsSkillsDir $skill))) {
        $extrasPresent = $true
        break
    }
}

# A wizard needs a real console. `irm | iex` keeps the console attached;
# CI and redirected runs do not.
$canPrompt = $false
if (-not $NonInteractive) {
    try {
        $canPrompt = (-not [Console]::IsInputRedirected) -and (-not [Console]::IsOutputRedirected)
    } catch {
        $canPrompt = $false
    }
}

$runWizard = $canPrompt -and ($Reconfigure -or -not (Test-Path $prefsFile))

function Read-YesNo {
    param([string]$Prompt, [string]$Default)
    $suffix = if ($Default -eq "yes") { "[Y/n]" } else { "[y/N]" }
    Write-Host "$Prompt $suffix " -NoNewline
    $answer = [Console]::ReadLine()
    switch -regex ($answer) {
        '^(y|yes)$' { return "yes" }
        '^(n|no)$'  { return "no" }
        default     { return $Default }
    }
}

# Space-toggle checkbox. Up/down (or j/k) moves, space toggles, enter
# confirms. Returns the chosen names as a comma list, or "none".
function Select-SkillsCheckbox {
    param([string[]]$Names, [string]$Preselected)
    $pre = ",$Preselected,"
    $sel = @()
    foreach ($n in $Names) { $sel += ($pre -like "*,$n,*") }
    $idx = 0
    Write-Host "Space toggles, enter confirms, up/down or j/k moves:"
    $top = [Console]::CursorTop
    while ($true) {
        [Console]::SetCursorPosition(0, $top)
        for ($i = 0; $i -lt $Names.Count; $i++) {
            $mark = if ($sel[$i]) { "x" } else { " " }
            $cursor = if ($i -eq $idx) { "> " } else { "  " }
            Write-Host ("{0}[{1}] {2}    " -f $cursor, $mark, $Names[$i])
        }
        $key = [Console]::ReadKey($true)
        switch ($key.Key) {
            "Spacebar"  { $sel[$idx] = -not $sel[$idx] }
            "UpArrow"   { if ($idx -gt 0) { $idx-- } }
            "DownArrow" { if ($idx -lt $Names.Count - 1) { $idx++ } }
            "K"         { if ($idx -gt 0) { $idx-- } }
            "J"         { if ($idx -lt $Names.Count - 1) { $idx++ } }
            "Enter"     {
                $chosen = @()
                for ($i = 0; $i -lt $Names.Count; $i++) {
                    if ($sel[$i]) { $chosen += $Names[$i] }
                }
                if ($chosen.Count -eq 0) { return "none" }
                return ($chosen -join ",")
            }
        }
    }
}

$extrasChoice = ""
$invocableChoice = ""
$glimpseChoice = ""

if ($runWizard) {
    Write-Host ""
    Write-Host "=========================================="
    Write-Host "  PLANNOTATOR GUIDED INSTALL"
    Write-Host "=========================================="
    Write-Host ""
    if ($extrasPresent) {
        Write-Host "Extra skills already installed — keeping them."
        $extrasChoice = "yes"
    } elseif ($Extras -or $NoExtras) {
        # Flag already answered this question — don't ask and then ignore.
        $extrasChoice = if ($Extras) { "yes" } else { "no" }
    } else {
        $defaultExtras = if ($savedExtras) { $savedExtras } else { "no" }
        $extrasChoice = Read-YesNo "Install the extra skills (compound planning, setup-goal, visual explainer)?" $defaultExtras
    }
    $invocableList = $coreSkillNames
    if ($extrasChoice -eq "yes") { $invocableList = $coreSkillNames + $extraSkillNames }
    if ($ModelInvocable) {
        # Flag already answered this question — don't ask and then ignore.
        $invocableChoice = $ModelInvocable
    } else {
        $wantInvocable = Read-YesNo "Make any skills callable by the model (instead of user-invoked only)?" "no"
        if ($wantInvocable -eq "yes") {
            $invocableChoice = Select-SkillsCheckbox -Names $invocableList -Preselected $savedInvocable
        } else {
            $invocableChoice = "none"
        }
    }
    if ($glimpsePresent) {
        Write-Host "Glimpse already installed — Plannotator will open in its native window."
        $glimpseChoice = "yes"
    } elseif ($Glimpse -or $NoGlimpse) {
        # Flag already answered this question — don't ask and then ignore.
        $glimpseChoice = if ($Glimpse) { "yes" } else { "no" }
    } else {
        $defaultGlimpse = if ($savedGlimpse) { $savedGlimpse } else { "yes" }
        $glimpseChoice = Read-YesNo "Install Glimpse so Plannotator opens in a native window instead of a browser tab? (npm i -g glimpseui)" $defaultGlimpse
    }
}

# Flags override the wizard and saved answers; otherwise saved, then defaults.
if ($Extras) { $extrasChoice = "yes" }
if ($NoExtras) { $extrasChoice = "no" }
if ($ModelInvocable) { $invocableChoice = $ModelInvocable }
if ($Glimpse) { $glimpseChoice = "yes" }
if ($NoGlimpse) { $glimpseChoice = "no" }
if (-not $extrasChoice) { $extrasChoice = if ($savedExtras) { $savedExtras } else { "no" } }
if (-not $invocableChoice) { $invocableChoice = if ($savedInvocable) { $savedInvocable } else { "none" } }
if (-not $glimpseChoice) { $glimpseChoice = if ($savedGlimpse) { $savedGlimpse } else { "no" } }

# Persist only when the wizard ran or a flag set something — silent re-runs
# must not clobber saved answers with defaults.
if ($runWizard -or $Extras -or $NoExtras -or $ModelInvocable -or $Glimpse -or $NoGlimpse) {
    New-Item -ItemType Directory -Force -Path $configDir | Out-Null
    @("extras=$extrasChoice", "model_invocable=$invocableChoice", "glimpse=$glimpseChoice") | Set-Content $prefsFile
}

# Glimpse install (global npm package; the runtime auto-detects it on PATH).
# Wizard or explicit flag only — silent re-runs never install software.
if (($glimpseChoice -eq "yes") -and (-not $glimpsePresent) -and ($runWizard -or $Glimpse)) {
    if (Get-Command npm -ErrorAction SilentlyContinue) {
        Write-Host "Installing Glimpse (npm install -g glimpseui)..."
        npm install -g glimpseui
        if ($LASTEXITCODE -ne 0) { Write-Host "Glimpse install failed — install later with: npm install -g glimpseui" }
    } elseif (Get-Command bun -ErrorAction SilentlyContinue) {
        Write-Host "Installing Glimpse (bun install -g glimpseui)..."
        bun install -g glimpseui
        if ($LASTEXITCODE -ne 0) { Write-Host "Glimpse install failed — install later with: bun install -g glimpseui" }
    } else {
        Write-Host "npm/bun not found — install Node.js, then: npm install -g glimpseui"
    }
}

# Extras install is delegated to the skills CLI (its UI picks the agents).
# Interactive only — silent runs and CI get the printed command instead.
# Never runs when the extras already exist.
if (($extrasChoice -eq "yes") -and (-not $extrasPresent)) {
    if ($canPrompt -and (Get-Command npx -ErrorAction SilentlyContinue)) {
        Write-Host "Launching the skills CLI for the extras (pick your agents in its UI)..."
        npx skills add backnotprop/plannotator/apps/skills/extra
        if ($LASTEXITCODE -ne 0) {
            Write-Host "skills CLI did not complete — install later with: npx skills add backnotprop/plannotator/apps/skills/extra"
        }
    } else {
        Write-Host "Install the extras with: npx skills add backnotprop/plannotator/apps/skills/extra"
    }
}

# Install skills and command stubs (requires git).
#
# Core skills, Kiro skills/extras, OpenCode command stubs, and Gemini TOML
# commands are all copied verbatim from a sparse checkout of the release tag.
# copy-if-present means older pinned tags that lack a given path simply skip it
# rather than failing. Hard requirement: without git we cannot install the
# /plannotator-* skills, so fail loudly instead of leaving a partial install.
# Hook/config writing above has already run; the Pi update and Gemini config
# below are skipped on failure and complete when the user re-runs.
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "Error: git is required to install Plannotator's skills and slash commands."
    Write-Host "Install git, then run this installer again."
    exit 1
}

$checkoutFailed = $false
$skillsTmp = Join-Path ([System.IO.Path]::GetTempPath()) "plannotator-skills-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $skillsTmp | Out-Null

function Copy-SkillIfPresent {
    param(
        [string]$SourceDir,
        [string]$TargetDir
    )

    if (Test-Path $SourceDir) {
        # Remove any existing copy first so re-runs replace rather than
        # nest. PowerShell's `Copy-Item -Recurse` into an existing target
        # dir copies the source INSIDE it (dest\skill\skill); mirror
        # install.sh's `rm -rf` guard so upgrades stay clean.
        $dest = Join-Path $TargetDir (Split-Path $SourceDir -Leaf)
        if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
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
            git sparse-checkout set apps/skills apps/kiro-cli apps/opencode-plugin/commands apps/gemini/commands 2>$null

            # Claude Code and Codex consume different skill bodies. Claude Code
            # reads apps/skills/claude/* (dynamic-context injection
            # `!`plannotator … $ARGUMENTS`` + allowed-tools, so /plannotator-*
            # run with no permission prompt — like the old slash commands).
            # Codex reads apps/skills/core/* (prose the model follows via its
            # own shell). The `!`…`` injection is a Claude-Code-only extension,
            # so the two are sourced separately rather than sharing one body.
            # Route each through Copy-SkillIfPresent (which pre-removes the
            # existing target dir) so re-runs replace rather than nest.
            if ((Test-Path "apps\skills\claude") -and (Get-ChildItem "apps\skills\claude" -ErrorAction SilentlyContinue)) {
                New-Item -ItemType Directory -Force -Path $claudeSkillsDir | Out-Null
                foreach ($skill in @("plannotator-review", "plannotator-annotate", "plannotator-last")) {
                    Copy-SkillIfPresent "apps\skills\claude\$skill" $claudeSkillsDir
                }
                Write-Host "Installed Claude Code skills to $claudeSkillsDir\"
            } else {
                Write-Host "Tag $latestTag predates the per-agent skill layout — skipping Claude Code skill install"
            }
            if ((Test-Path "apps\skills\core") -and (Get-ChildItem "apps\skills\core" -ErrorAction SilentlyContinue)) {
                New-Item -ItemType Directory -Force -Path $agentsSkillsDir | Out-Null
                foreach ($skill in @("plannotator-review", "plannotator-annotate", "plannotator-last")) {
                    Copy-SkillIfPresent "apps\skills\core\$skill" $agentsSkillsDir
                }
                Write-Host "Installed shared agent skills to $agentsSkillsDir\"
            } else {
                Write-Host "Tag $latestTag predates the core/extra skill layout — skipping shared agent skill install"
            }

            # Kiro: hand-maintained skills (origin baked in) + two extras.
            if ($kiroAvailable -and (Test-Path "apps\kiro-cli\skills")) {
                $kiroSkillsDir = "$env:USERPROFILE\.kiro\skills"
                New-Item -ItemType Directory -Force -Path $kiroSkillsDir | Out-Null
                # Kiro-specific skills (origin baked in) come from apps/kiro-cli/skills.
                Copy-SkillIfPresent "apps\kiro-cli\skills\plannotator-review" $kiroSkillsDir
                Copy-SkillIfPresent "apps\kiro-cli\skills\plannotator-annotate" $kiroSkillsDir
                # Two extras come from apps/skills/extra (not duplicated into apps/kiro-cli/skills).
                Copy-SkillIfPresent "apps\skills\extra\plannotator-setup-goal" $kiroSkillsDir
                Copy-SkillIfPresent "apps\skills\extra\plannotator-visual-explainer" $kiroSkillsDir
                # Plannotator custom agent — don't clobber a user's existing one.
                $kiroAgentsDir = "$env:USERPROFILE\.kiro\agents"
                if (-not (Test-Path "$kiroAgentsDir\plannotator.json") -and (Test-Path "apps\kiro-cli\agents\plannotator.json")) {
                    New-Item -ItemType Directory -Force -Path $kiroAgentsDir | Out-Null
                    Copy-Item -Force "apps\kiro-cli\agents\plannotator.json" "$kiroAgentsDir\plannotator.json"
                }
                Write-Host "Installed Kiro skills to $kiroSkillsDir\ and agent to $kiroAgentsDir\plannotator.json"
            }

            # OpenCode command stubs -> ~/.config/opencode/commands (always).
            # The plugin intercepts execution; these stubs just register the
            # slash commands in OpenCode.
            if (Test-Path "apps\opencode-plugin\commands") {
                $opencodeCommandsDir = "$env:USERPROFILE\.config\opencode\commands"
                $opencodeCmds = Get-ChildItem "apps\opencode-plugin\commands\*.md" -ErrorAction SilentlyContinue
                if ($opencodeCmds) {
                    New-Item -ItemType Directory -Force -Path $opencodeCommandsDir | Out-Null
                    Copy-Item -Force "apps\opencode-plugin\commands\*.md" $opencodeCommandsDir
                    Write-Host "Installed OpenCode commands to $opencodeCommandsDir\"
                }
            }

            # Gemini TOML commands -> ~/.gemini/commands (only when ~/.gemini exists).
            # These are Gemini's native command format.
            if ((Test-Path "$env:USERPROFILE\.gemini") -and (Test-Path "apps\gemini\commands")) {
                $geminiCommandsDir = "$env:USERPROFILE\.gemini\commands"
                $geminiCmds = Get-ChildItem "apps\gemini\commands\*.toml" -ErrorAction SilentlyContinue
                if ($geminiCmds) {
                    New-Item -ItemType Directory -Force -Path $geminiCommandsDir | Out-Null
                    Copy-Item -Force "apps\gemini\commands\*.toml" $geminiCommandsDir
                    Write-Host "Installed Gemini slash commands to $geminiCommandsDir\"
                }
            }
        } finally {
            Pop-Location
        }
    } else {
        $checkoutFailed = $true
    }
} catch {
    Write-Host "Command/skill install failed: $($_.Exception.Message)"
    $checkoutFailed = $true
}

Remove-Item -Recurse -Force $skillsTmp -ErrorAction SilentlyContinue

if ($checkoutFailed) {
    Write-Host "Error: unable to fetch $repo at $latestTag (network or git error)."
    Write-Host "Something went wrong — run the installer again."
    exit 1
}

# Claude Code commands are deprecated in favor of skills. Remove a legacy
# command file only once its replacement skill is actually on disk — running
# AFTER the install above guarantees a failed or skipped skill install never
# leaves users with neither the command nor the skill.
foreach ($cmd in @("plannotator-review", "plannotator-annotate", "plannotator-last")) {
    $cmdPath = Join-Path $claudeCommandsDir "$cmd.md"
    $skillPath = Join-Path $claudeSkillsDir $cmd
    if ((Test-Path $skillPath) -and (Test-Path $cmdPath)) {
        Write-Host "Removing stale Claude command $cmdPath (replaced by the $cmd skill)"
        Remove-Item -Force $cmdPath -ErrorAction SilentlyContinue
    }
}

# plannotator-archive no longer ships as a skill. Remove any stale installed
# copy from every skill scope so upgraders don't keep a dead skill around.
foreach ($scope in @($claudeSkillsDir, $agentsSkillsDir, "$env:USERPROFILE\.kiro\skills")) {
    $staleArchivePath = Join-Path $scope "plannotator-archive"
    if (Test-Path $staleArchivePath) {
        Write-Host "Removing stale plannotator-archive skill $staleArchivePath"
        Remove-Item -Recurse -Force $staleArchivePath -ErrorAction SilentlyContinue
    }
}

# Codex no longer hosts core skills (they now live in ~/.agents/skills).
# Core skills are removed only once their replacement exists; the stale
# shared-agent extras were never Codex's and are removed unconditionally.
foreach ($skill in @("plannotator-review", "plannotator-annotate", "plannotator-last", "plannotator-compound", "plannotator-setup-goal")) {
    $staleSkillPath = Join-Path $staleCodexSkillsDir $skill
    if (Test-Path $staleSkillPath) {
        $isCore = $skill -in @("plannotator-review", "plannotator-annotate", "plannotator-last")
        if ($isCore -and -not (Test-Path (Join-Path $agentsSkillsDir $skill))) { continue }
        Write-Host "Removing stale Codex skill $staleSkillPath"
        Remove-Item -Recurse -Force $staleSkillPath -ErrorAction SilentlyContinue
    }
}

# Apply the saved model-invocation choices. Installed skill copies always
# arrive locked (disable-model-invocation: true in SKILL.md); for each chosen
# skill we unlock the INSTALLED copy by removing that line, and flip the Codex
# sidecar's allow_implicit_invocation to match. Re-applied on every run
# because installs replace the skill folders wholesale. Repo sources never
# change.
if ($invocableChoice -and ($invocableChoice -ne "none")) {
    foreach ($skill in ($invocableChoice -split ",")) {
        foreach ($scope in @($claudeSkillsDir, $agentsSkillsDir)) {
            $skillMd = Join-Path $scope (Join-Path $skill "SKILL.md")
            if (Test-Path $skillMd) {
                $content = Get-Content $skillMd
                if ($content -contains "disable-model-invocation: true") {
                    $content | Where-Object { $_ -ne "disable-model-invocation: true" } | Set-Content $skillMd
                    Write-Host "Enabled model invocation: $scope\$skill"
                }
            }
            $sidecar = Join-Path $scope (Join-Path $skill "agents\openai.yaml")
            if (Test-Path $sidecar) {
                $yaml = Get-Content $sidecar -Raw
                if ($yaml -match "allow_implicit_invocation: false") {
                    ($yaml -replace "allow_implicit_invocation: false", "allow_implicit_invocation: true") | Set-Content $sidecar -NoNewline
                }
            }
        }
    }
}

# Update Pi extension if pi is installed. Pi keeps its extension commands and
# the plannotator_submit_plan tool; it no longer bundles skills.
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

    # Gemini slash command TOMLs are copied from the sparse checkout
    # (apps/gemini/commands) in the git-gated skills/commands install above.
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
Write-Host "  KIRO CLI USERS"
Write-Host "=========================================="
Write-Host ""
if ($kiroAvailable) {
    Write-Host "Kiro skills are installed to $env:USERPROFILE\.kiro\skills\"
    Write-Host "The Plannotator agent is installed to $env:USERPROFILE\.kiro\agents\plannotator.json"
    Write-Host "Launch it: kiro-cli chat --agent plannotator"
} else {
    Write-Host "Kiro was not detected. After installing Kiro, rerun this installer to add Kiro skills."
}
Write-Host ""
Write-Host "=========================================="
Write-Host "  CLAUDE CODE USERS: YOU ARE ALL SET!"
Write-Host "=========================================="
Write-Host ""
Write-Host "Install the Claude Code plugin:"
Write-Host "  /plugin marketplace add backnotprop/plannotator"
Write-Host "  /plugin install plannotator@plannotator"
Write-Host ""
Write-Host "Upgrading from an older version? Also run /plugin marketplace update"
Write-Host "so the plugin drops its old plannotator:* command entries."
Write-Host ""
Write-Host "The /plannotator-review, /plannotator-annotate, and /plannotator-last commands are ready to use after you restart Claude Code!"

if ($extrasChoice -ne "yes") {
    Write-Host ""
    Write-Host "Optional skills (compound planning, setup-goal, visual explainer):"
    Write-Host "  npx skills add backnotprop/plannotator/apps/skills/extra"
}

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
