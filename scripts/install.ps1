# Plannotator Windows Installer
param(
    [string]$Version = "latest",
    [switch]$VerifyAttestation,
    [switch]$SkipAttestation,
    [switch]$Extras,
    [switch]$NoExtras,
    [string]$ModelInvocable = "",
    [switch]$NonInteractive,
    [switch]$Reconfigure,
    [Alias("BinaryOnly")]
    [switch]$Minimal,
    [switch]$NoMinimal,
    # Opt-in install of the pruned CallDiff call-flow core (default off;
    # the review UI offers a one-click install). Mirrors install.sh's
    # --with-call-flow.
    [switch]$WithCallFlow,
    [switch]$SkipCodex,
    [switch]$SkipGemini,
    [switch]$SkipKiro,
    [switch]$SkipOpencode,
    # Same shape as the per-agent switches, but scoped to the skills/slash
    # command sparse checkout rather than one agent's home: -SkipSkills turns
    # the whole fetch into a no-op for every scope it writes (Claude,
    # ~/.agents, OpenCode, Gemini, Kiro), including the extras and the
    # skill-scope cleanup sweeps. Mirrors install.sh's --skip-skills.
    [switch]$SkipSkills
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
if ($Minimal -and $NoMinimal) {
    [Console]::Error.WriteLine("-Minimal and -NoMinimal are mutually exclusive. Pass one or the other.")
    exit 1
}

# Binary-only mode. Installs just the plannotator binary and no persistent state
# elsewhere - no sem sidecar, CallDiff or agent-terminal runtime, skills, hooks, or per-agent
# config. Precedence: -Minimal / -NoMinimal switch > PLANNOTATOR_MINIMAL env var
# > default (off). Mirrors install.sh's --minimal / --no-minimal.
$minimal = $false
if ($env:PLANNOTATOR_MINIMAL -match '^(1|true|yes)$') {
    $minimal = $true
}
if ($Minimal) { $minimal = $true }
if ($NoMinimal) { $minimal = $false }

$repo = "backnotprop/plannotator"
$semRepo = "Ataraxy-Labs/sem"
$semVersion = "v0.8.0"
$installDir = "$env:LOCALAPPDATA\plannotator"

# First plannotator release that carries SLSA build-provenance attestations.
# See scripts/install.sh for the full explanation - this constant is bumped
# once at the first attested release via the release skill.
$minAttestedVersion = "v0.17.2"

# Detect architecture. Native ARM64 Windows binaries are built from
# bun-windows-arm64 (stable since Bun v1.3.10), so ARM64 hosts get a
# native binary - no Windows x86-64 emulation tax.
#
# PROCESSOR_ARCHITECTURE reports the architecture the current PowerShell
# process is running under. PROCESSOR_ARCHITEW6432 is set only in 32-bit
# processes running via WoW64 and reflects the HOST architecture. Prefer
# the latter when present so a 32-bit PowerShell on ARM64 Windows still
# selects the native arm64 binary. Matches install.cmd's detection.
if (-not [Environment]::Is64BitOperatingSystem) {
    # Write-Error under $ErrorActionPreference = "Stop" (set at the top
    # of this file) raises a terminating error that exits the process
    # with code 1. No explicit `exit 1` needed here - it would be
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

    # api.github.com caps unauthenticated requests at 60/hour per source IP,
    # which fails installs behind shared egress IPs (NAT/CGNAT/corporate
    # proxies) and during repeated/debug runs within an hour. Attach an
    # Authorization header when a token is available (raises the limit to
    # 5000/hour); when none is found, fall back to anonymous (unchanged
    # behavior). Precedence matches `gh`: GITHUB_TOKEN > GH_TOKEN > gh auth token.
    $ghToken = $env:GITHUB_TOKEN
    if (-not $ghToken) { $ghToken = $env:GH_TOKEN }
    if (-not $ghToken -and (Get-Command gh -ErrorAction SilentlyContinue)) {
        # --hostname github.com scopes the fallback to github.com credentials,
        # so a gh setup whose default host is a GitHub Enterprise server never
        # leaks a GHES token to api.github.com. On an ancient gh without the
        # flag, stderr is swallowed and we fall back to anonymous.
        try { $ghToken = (gh auth token --hostname github.com 2>$null) } catch { }
    }
    $ghHeaders = if ($ghToken) { @{ Authorization = "Bearer $ghToken" } } else { @{} }
    # A stale/revoked token (expired GITHUB_TOKEN lingering in CI images,
    # dotfiles, direnv) gets a 401 here and would break an install that
    # works fine anonymously today. Retry anonymously ONLY on HTTP 401:
    # requests carrying invalid credentials count against the anonymous
    # 60/hour per-IP pool, so a blind retry on any failure would double the
    # burn, and network failures gain nothing from a second attempt. The
    # [int] cast handles both Windows PowerShell 5.1 (HttpWebResponse enum)
    # and PowerShell 7 (HttpResponseMessage); the inner try guards a null
    # Response (e.g. DNS failure). See backnotprop/plannotator#1157.
    $apiUrl = "https://api.github.com/repos/$repo/releases/latest"
    try {
        $release = Invoke-RestMethod -Uri $apiUrl -Headers $ghHeaders
    } catch {
        $status = $null
        try { $status = [int]$_.Exception.Response.StatusCode } catch { }
        if ($ghHeaders.Count -gt 0 -and $status -eq 401) {
            try {
                $release = Invoke-RestMethod -Uri $apiUrl
            } catch {
                Write-Error "Failed to fetch latest version: $($_.Exception.Message)"
                exit 1
            }
        } else {
            Write-Error "Failed to fetch latest version: $($_.Exception.Message) (if this is HTTP 403, the GitHub API may be rate-limiting your IP; see https://github.com/backnotprop/plannotator/issues/1156)"
            exit 1
        }
    }
    # Drop the local token copies; GITHUB_TOKEN / GH_TOKEN themselves remain
    # in the environment exactly as the user set them.
    $ghToken = $null; $ghHeaders = $null; $apiUrl = $null
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
# CallDiff call-flow runtime opt-in. Same three-layer shape:
# -WithCallFlow > PLANNOTATOR_INSTALL_CALLDIFF > config installCallFlow >
# default (off).
$installCallFlowResolved = $false

# Layer 3: config file (lowest precedence of the opt-in sources).
# Unset PLANNOTATOR_DATA_DIR: an existing ~/.plannotator (legacy default)
# always wins; otherwise an explicitly-set absolute XDG_DATA_HOME (rare on
# Windows but honored the same way as the runtime) places the directory at
# $XDG_DATA_HOME\plannotator; otherwise ~/.plannotator.
$configDir = if ($env:PLANNOTATOR_DATA_DIR) { $env:PLANNOTATOR_DATA_DIR.Trim() } else {
    $legacyDir = Join-Path $env:USERPROFILE ".plannotator"
    $xdgDataHome = if ($env:XDG_DATA_HOME) { $env:XDG_DATA_HOME.Trim() } else { "" }
    if (Test-Path $legacyDir) {
        $legacyDir
    } elseif ($xdgDataHome -and [System.IO.Path]::IsPathRooted($xdgDataHome)) {
        Join-Path $xdgDataHome "plannotator"
    } else {
        $legacyDir
    }
}
if ($configDir -eq "~") {
    $configDir = $env:USERPROFILE
} elseif ($configDir.StartsWith("~/") -or $configDir.StartsWith('~\')) {
    $configDir = Join-Path $env:USERPROFILE ($configDir.Substring(2))
}

function Install-SemSidecar {
    if ($env:PLANNOTATOR_SKIP_SEM_INSTALL -match '^(1|true|yes)$') {
        Write-Host "Skipping semantic diff sidecar install (PLANNOTATOR_SKIP_SEM_INSTALL is set)"
        return
    }

    $semAsset = if ($platform -eq "win32-x64") { "sem-windows-x86_64.zip" } else { $null }
    if (-not $semAsset) {
        Write-Host "Skipping semantic diff sidecar install (sem does not publish $platform)"
        return
    }

    $semDir = Join-Path $configDir "vendor\sem\$semVersion"
    $semPath = Join-Path $semDir "sem.exe"
    if (Test-Path $semPath) {
        try {
            $versionText = & $semPath --version 2>$null
            if ($LASTEXITCODE -eq 0 -and $versionText -match '^sem ') {
                Write-Host "Semantic diff sidecar already installed at $semPath"
                return
            }
        } catch {
            # Replace invalid stale sidecar below.
        }
    }

    $tmpSemDir = Join-Path ([System.IO.Path]::GetTempPath()) "plannotator-sem-$([System.Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Force -Path $tmpSemDir | Out-Null

    try {
        $semBaseUrl = "https://github.com/$semRepo/releases/download/$semVersion"
        $semArchive = Join-Path $tmpSemDir $semAsset
        $semChecksums = Join-Path $tmpSemDir "checksums.txt"
        # Bounded so a slow/hung download of this optional sidecar can't wedge an
        # install where plannotator already landed; the catch below skips it.
        Invoke-WebRequest -Uri "$semBaseUrl/$semAsset" -OutFile $semArchive -UseBasicParsing -TimeoutSec 120
        Invoke-WebRequest -Uri "$semBaseUrl/checksums.txt" -OutFile $semChecksums -UseBasicParsing -TimeoutSec 60

        $expected = (Get-Content $semChecksums | Where-Object { $_ -match "\s$([regex]::Escape($semAsset))$" } | ForEach-Object { ($_ -split '\s+')[0] } | Select-Object -First 1)
        if (-not $expected) {
            Write-Host "Skipping semantic diff sidecar install (checksum missing for $semAsset)"
            return
        }

        $actual = (Get-FileHash -Path $semArchive -Algorithm SHA256).Hash.ToLower()
        if ($actual -ne $expected.ToLower()) {
            Write-Host "Skipping semantic diff sidecar install (checksum mismatch)"
            return
        }

        Expand-Archive -Force -Path $semArchive -DestinationPath $tmpSemDir
        $extracted = Get-ChildItem -Path $tmpSemDir -Filter "sem.exe" -Recurse | Select-Object -First 1
        if (-not $extracted) {
            Write-Host "Skipping semantic diff sidecar install (binary missing from archive)"
            return
        }

        New-Item -ItemType Directory -Force -Path $semDir | Out-Null
        Copy-Item -Force $extracted.FullName $semPath
        Write-Host "Semantic diff sidecar installed to $semPath"
    } catch {
        Write-Host "Skipping semantic diff sidecar install ($($_.Exception.Message))"
    } finally {
        Remove-Item -Recurse -Force $tmpSemDir -ErrorAction SilentlyContinue
    }
}

function Install-AgentTerminalRuntime {
    if ($env:PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL -match '^(1|true|yes)$') {
        Write-Host "Skipping agent terminal runtime install (PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL is set)"
        return
    }

    $plannotatorPath = Join-Path $installDir "plannotator.exe"
    try {
        & $plannotatorPath install-runtime agent-terminal
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Skipping agent terminal runtime install (plannotator install-runtime failed)"
        }
    } catch {
        Write-Host "Skipping agent terminal runtime install ($($_.Exception.Message))"
    }
}

# Strictly opt-in: Call flow is off by default, so a default install never
# downloads even its pruned core. Review-specific packs install in-app.
function Install-CallFlowRuntime {
    if (-not $installCallFlowResolved) {
        Write-Host "Call-flow analysis: available as an in-app opt-in install (enable Call flow in review Settings), or run: plannotator install-runtime call-flow"
        return
    }

    $plannotatorPath = Join-Path $installDir "plannotator.exe"
    try {
        & $plannotatorPath install-runtime call-flow
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Call-flow runtime install failed; it remains available as an in-app opt-in install"
        }
    } catch {
        Write-Host "Call-flow runtime install failed ($($_.Exception.Message)); it remains available as an in-app opt-in install"
    }
}

$configPath = Join-Path $configDir "config.json"
$cfg = $null
if (Test-Path $configPath) {
    try {
        $cfg = Get-Content $configPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        # Strict check: only a real JSON `true` (parsed as [bool]$true) opts in.
        # A stringified "true", a number, etc. do not - matches install.sh, which
        # greps for a literal boolean.
        if ($cfg.verifyAttestation -is [bool] -and $cfg.verifyAttestation) {
            $verifyAttestationResolved = $true
        }
        if ($cfg.installCallFlow -is [bool] -and $cfg.installCallFlow) {
            $installCallFlowResolved = $true
        }
    } catch {
        # Malformed config - ignore, fall through to other layers.
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

# CallDiff runtime opt-in, layers 2 and 1 (config was read above).
$envInstallCallFlow = $env:PLANNOTATOR_INSTALL_CALLDIFF
if ($envInstallCallFlow) {
    if ($envInstallCallFlow -match '^(1|true|yes)$') {
        $installCallFlowResolved = $true
    } elseif ($envInstallCallFlow -match '^(0|false|no)$') {
        $installCallFlowResolved = $false
    }
}
if ($WithCallFlow) { $installCallFlowResolved = $true }

# Resolve the per-agent integration opt-outs (#1178). Same three-layer shape
# as verifyAttestation: CLI flag > env var > config skipInstall.<agent> >
# default (off). Skip means do-not-write: a skipped agent's home is neither
# written to nor cleaned up, and detected-but-skipped is reported honestly
# as its own state. Each resolved skip remembers its source so the report
# can name what the user set.
$skipCodexResolved = $false;  $skipCodexSource = ""
$skipGeminiResolved = $false; $skipGeminiSource = ""
$skipKiroResolved = $false;   $skipKiroSource = ""
$skipOpencodeResolved = $false; $skipOpencodeSource = ""
# skipInstall.skills is not an agent - it opts out of the skills/slash-command
# checkout for every scope at once - but it shares the same three layers.
$skipSkillsResolved = $false; $skipSkillsSource = ""
if ($cfg -and $cfg.skipInstall) {
    if ($cfg.skipInstall.codex -is [bool] -and $cfg.skipInstall.codex) {
        $skipCodexResolved = $true; $skipCodexSource = "config skipInstall.codex"
    }
    if ($cfg.skipInstall.gemini -is [bool] -and $cfg.skipInstall.gemini) {
        $skipGeminiResolved = $true; $skipGeminiSource = "config skipInstall.gemini"
    }
    if ($cfg.skipInstall.kiro -is [bool] -and $cfg.skipInstall.kiro) {
        $skipKiroResolved = $true; $skipKiroSource = "config skipInstall.kiro"
    }
    if ($cfg.skipInstall.opencode -is [bool] -and $cfg.skipInstall.opencode) {
        $skipOpencodeResolved = $true; $skipOpencodeSource = "config skipInstall.opencode"
    }
    if ($cfg.skipInstall.skills -is [bool] -and $cfg.skipInstall.skills) {
        $skipSkillsResolved = $true; $skipSkillsSource = "config skipInstall.skills"
    }
}
if ($env:PLANNOTATOR_SKIP_CODEX_INSTALL -match '^(1|true|yes)$') {
    $skipCodexResolved = $true; $skipCodexSource = "PLANNOTATOR_SKIP_CODEX_INSTALL"
} elseif ($env:PLANNOTATOR_SKIP_CODEX_INSTALL -match '^(0|false|no)$') {
    $skipCodexResolved = $false; $skipCodexSource = ""
}
if ($env:PLANNOTATOR_SKIP_GEMINI_INSTALL -match '^(1|true|yes)$') {
    $skipGeminiResolved = $true; $skipGeminiSource = "PLANNOTATOR_SKIP_GEMINI_INSTALL"
} elseif ($env:PLANNOTATOR_SKIP_GEMINI_INSTALL -match '^(0|false|no)$') {
    $skipGeminiResolved = $false; $skipGeminiSource = ""
}
if ($env:PLANNOTATOR_SKIP_KIRO_INSTALL -match '^(1|true|yes)$') {
    $skipKiroResolved = $true; $skipKiroSource = "PLANNOTATOR_SKIP_KIRO_INSTALL"
} elseif ($env:PLANNOTATOR_SKIP_KIRO_INSTALL -match '^(0|false|no)$') {
    $skipKiroResolved = $false; $skipKiroSource = ""
}
if ($env:PLANNOTATOR_SKIP_OPENCODE_INSTALL -match '^(1|true|yes)$') {
    $skipOpencodeResolved = $true; $skipOpencodeSource = "PLANNOTATOR_SKIP_OPENCODE_INSTALL"
} elseif ($env:PLANNOTATOR_SKIP_OPENCODE_INSTALL -match '^(0|false|no)$') {
    $skipOpencodeResolved = $false; $skipOpencodeSource = ""
}
if ($env:PLANNOTATOR_SKIP_SKILLS_INSTALL -match '^(1|true|yes)$') {
    $skipSkillsResolved = $true; $skipSkillsSource = "PLANNOTATOR_SKIP_SKILLS_INSTALL"
} elseif ($env:PLANNOTATOR_SKIP_SKILLS_INSTALL -match '^(0|false|no)$') {
    $skipSkillsResolved = $false; $skipSkillsSource = ""
}
if ($SkipCodex)  { $skipCodexResolved = $true;  $skipCodexSource = "-SkipCodex" }
if ($SkipGemini) { $skipGeminiResolved = $true; $skipGeminiSource = "-SkipGemini" }
if ($SkipKiro)   { $skipKiroResolved = $true;   $skipKiroSource = "-SkipKiro" }
if ($SkipOpencode) { $skipOpencodeResolved = $true; $skipOpencodeSource = "-SkipOpencode" }
if ($SkipSkills) { $skipSkillsResolved = $true; $skipSkillsSource = "-SkipSkills" }

# Pre-flight: if verification is requested, reject tags older than the first
# attested release before we download anything. Uses PowerShell's [version]
# class for proper numeric comparison (lexicographic string cmp gets
# v0.9.0 vs v0.10.0 backwards).
if ($verifyAttestationResolved) {
    # Pre-release and build-metadata tags (e.g. v0.18.0-rc1) are not
    # supported by [System.Version] - the cast throws on any `-` suffix.
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
        # Credential-free path first (#1178): the attestations endpoint on
        # api.github.com is world-readable for public repos, so fetch the
        # Sigstore bundle anonymously and hand it to gh via --bundle. This
        # drops the gh-login requirement; gh's own authenticated fetch is
        # only used as a fallback when the public fetch fails. Single fetch
        # attempt, deliberately never retried: the unauthenticated API
        # allows 60 requests/hour per IP.
        $bundleFile = $null
        $bundleFallbackReason = ""
        try {
            $attUrl = "https://api.github.com/repos/$repo/attestations/sha256:$actualChecksum"
            # Raw text via Invoke-WebRequest, NOT Invoke-RestMethod: the
            # bundle is extracted below as a byte-exact substring of the
            # response, never round-tripped through PowerShell's JSON
            # parser. ConvertFrom-Json coerces date-shaped strings into
            # DateTime objects and ConvertTo-Json re-serializes them
            # differently across PowerShell 5.1 and 7, which could corrupt
            # a bundle field and turn into a false verification failure.
            $attResp = Invoke-WebRequest -Uri $attUrl -UseBasicParsing -TimeoutSec 30
            $attRaw = if ($attResp.Content -is [byte[]]) { [System.Text.Encoding]::UTF8.GetString($attResp.Content) } else { [string]$attResp.Content }
            # The response is { "attestations": [ { "bundle": {...} } ] }.
            # gh --bundle expects the bundle values themselves, one JSON
            # document per line (the JSONL format `gh attestation download`
            # writes). Scan for each `"bundle":` key and copy its balanced
            # object verbatim; the scanner is string-literal aware so
            # braces inside JSON strings cannot derail the depth count.
            $bundles = @()
            $searchFrom = 0
            while ($true) {
                # Ordinal comparison: culture-sensitive IndexOf can mismatch
                # under exotic locales; byte-literal key search must not.
                $keyIdx = $attRaw.IndexOf('"bundle"', $searchFrom, [System.StringComparison]::Ordinal)
                if ($keyIdx -lt 0) { break }
                $searchFrom = $keyIdx + 8
                $i = $keyIdx + 8
                while ($i -lt $attRaw.Length -and [char]::IsWhiteSpace($attRaw[$i])) { $i++ }
                if ($i -ge $attRaw.Length -or $attRaw[$i] -ne ':') { continue }
                $i++
                while ($i -lt $attRaw.Length -and [char]::IsWhiteSpace($attRaw[$i])) { $i++ }
                if ($i -ge $attRaw.Length -or $attRaw[$i] -ne '{') { continue }
                $depth = 0
                $inString = $false
                $escaped = $false
                $start = $i
                for (; $i -lt $attRaw.Length; $i++) {
                    $ch = $attRaw[$i]
                    if ($escaped) { $escaped = $false; continue }
                    if ($inString) {
                        if ($ch -eq '\') { $escaped = $true }
                        elseif ($ch -eq '"') { $inString = $false }
                        continue
                    }
                    if ($ch -eq '"') { $inString = $true; continue }
                    if ($ch -eq '{') { $depth++; continue }
                    if ($ch -eq '}') {
                        $depth--
                        if ($depth -eq 0) {
                            $bundles += $attRaw.Substring($start, $i - $start + 1)
                            $searchFrom = $i + 1
                            break
                        }
                    }
                }
            }
            if ($bundles.Count -gt 0) {
                # WriteAllText writes UTF-8 without a BOM so gh's JSON
                # parser accepts the first line.
                $bundleFile = Join-Path ([System.IO.Path]::GetTempPath()) "plannotator-bundle-$([System.Guid]::NewGuid().ToString('N')).jsonl"
                [System.IO.File]::WriteAllText($bundleFile, (($bundles -join "`n") + "`n"))
            } else {
                $bundleFallbackReason = "Could not extract a bundle from the attestations API response"
            }
        } catch {
            $bundleFile = $null
            $bundleFallbackReason = "Could not fetch the attestation bundle from the public API"
        }
        # Constrain verification to the exact tag + signing workflow - see
        # install.sh comment for rationale.
        $usedBundle = $false
        if ($bundleFile) {
            $usedBundle = $true
            $verifyOutput = & gh attestation verify $tmpFile `
                --bundle $bundleFile `
                --repo $repo `
                --source-ref "refs/tags/$latestTag" `
                --signer-workflow "backnotprop/plannotator/.github/workflows/release.yml" 2>&1
            if ($LASTEXITCODE -ne 0) {
                # H1: a --bundle failure is not necessarily a provenance
                # failure (an older gh rejects the flag outright, a corrupt
                # bundle fails parsing, etc.). Retry once through the exact
                # authenticated path before classifying anything; only the
                # retry's verdict is reported. A real provenance failure
                # fails again here, so nothing bad ever slips through.
                Write-Host "Bundle-based verification did not complete; retrying via gh's authenticated fetch."
                $usedBundle = $false
                $verifyOutput = & gh attestation verify $tmpFile `
                    --repo $repo `
                    --source-ref "refs/tags/$latestTag" `
                    --signer-workflow "backnotprop/plannotator/.github/workflows/release.yml" 2>&1
            }
        } else {
            Write-Host "$bundleFallbackReason; falling back to gh's authenticated fetch."
            $verifyOutput = & gh attestation verify $tmpFile `
                --repo $repo `
                --source-ref "refs/tags/$latestTag" `
                --signer-workflow "backnotprop/plannotator/.github/workflows/release.yml" 2>&1
        }
        $verifyExitCode = $LASTEXITCODE
        if ($bundleFile) { Remove-Item $bundleFile -Force -ErrorAction SilentlyContinue }
        if ($verifyExitCode -eq 0) {
            if ($usedBundle) {
                Write-Host "Verified build provenance (SLSA, credential-free via the public attestations API)"
            } else {
                Write-Host "Verified build provenance (SLSA)"
            }
        } else {
            # Write to stderr directly - Write-Host goes to PowerShell's
            # Information stream, which is silently dropped when callers
            # redirect stderr for error reporting in CI/CD pipelines.
            #
            # `& gh ... 2>&1` captures multi-line output as an object[]
            # array. Passing the array directly to [Console]::Error.WriteLine
            # binds to the WriteLine(object) overload, which calls ToString()
            # on the array and yields the useless literal "System.Object[]".
            # Out-String normalizes the array back into a single formatted
            # string so the actual gh diagnostic is visible.
            $verifyText = ($verifyOutput | Out-String).TrimEnd()
            [Console]::Error.WriteLine($verifyText)
            Remove-Item $tmpFile -Force
            if ($verifyText -match "Sigstore verifiers") {
                # gh could not initialize the Sigstore trusted root. The TUF
                # root is fetched on EVERY run (not embedded, not cached), so
                # this is a connectivity failure, not a provenance failure.
                Write-Error "Could not initialize the Sigstore trust root (TUF). Provenance verification needs network access on every run; the trusted root is fetched per-run, never cached. This is a connectivity failure, NOT evidence of a bad binary. Refusing to install unverified; retry with network access or pass -SkipAttestation."
            } elseif ($verifyText -match "gh auth login") {
                # Only reachable on the authenticated path: the bundle path
                # was unavailable or did not complete AND gh has no login to
                # fetch the attestation itself. Environment problem, not a
                # provenance failure.
                Write-Error "The credential-free bundle path did not complete and gh is not logged in, so the authenticated fallback could not run. Retry with network access to api.github.com, run 'gh auth login', or pass -SkipAttestation."
            } else {
                Write-Error "Attestation verification failed! The binary's SHA256 matched, but no valid signed provenance was found for $repo. Refusing to install."
            }
        }
    } else {
        Remove-Item $tmpFile -Force
        Write-Error "verifyAttestation is enabled but gh CLI was not found. Install https://cli.github.com (no login is needed when the public attestation bundle fetch succeeds), or unset PLANNOTATOR_VERIFY_ATTESTATION / remove verifyAttestation from $configPath / pass -SkipAttestation."
    }
} else {
    Write-Host "SHA256 verified. For build provenance verification, see"
    Write-Host "https://docs.plannotator.ai/open-source/start/installation#pin-or-verify-a-release"
}

Move-Item -Force $tmpFile "$installDir\plannotator.exe"

Write-Host ""
Write-Host "plannotator $latestTag installed to $installDir\plannotator.exe"

# Add $installDir to the user PATH if not already there. Extracted so both the
# -Minimal early exit and the normal flow reuse it (mirrors install.sh's
# print_path_advice).
function Show-PathAdvice {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$installDir*") {
        Write-Host ""
        Write-Host "$installDir is not in your PATH. Adding it..."
        [Environment]::SetEnvironmentVariable("Path", "$userPath;$installDir", "User")
        Write-Host "Added to PATH. Restart your terminal for changes to take effect."
    }
    Write-Host ""
    Write-Host "To uninstall later: plannotator uninstall"
}

# Binary-only mode stops here (see the $minimal resolution near the top): the
# binary is installed, so add it to PATH and exit before any sidecar download,
# agent integration, skill checkout, config write, or cleanup runs. Only the
# binary and its PATH entry are added - none of the sem sidecar, CallDiff, agent-terminal
# runtime, or per-agent skills, hooks, or config.
if ($minimal) {
    Show-PathAdvice
    Write-Host ""
    Write-Host "Minimal install complete - only the plannotator binary was installed."
    Write-Host "No skills, hooks, agent integrations, or config files were written."
    exit 0
}

Install-SemSidecar
Install-AgentTerminalRuntime
Install-CallFlowRuntime

Show-PathAdvice

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
            "command": "\"$exePathJson\" improve-context",
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
            "command": "\"$exePathJson\"",
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

if ($codexAvailable -and $skipCodexResolved) {
    # HONEST three-state reporting (#1178): detected-but-skipped is its own
    # state, never conflated with "not detected". The Windows installer
    # never writes the Codex home (hooks are experimental upstream); the
    # skip suppresses the manual setup instructions and this run neither
    # creates, updates, nor removes anything under the Codex home. The
    # existing-integration note only fires when hooks.json actually
    # references plannotator (M4) - mere existence of the file proves
    # nothing, since it may hold only the user's own hooks.
    Write-Host ""
    Write-Host "Codex: detected, skipped ($skipCodexSource)."
    Write-Host "The Windows installer only prints manual Codex setup instructions; they"
    Write-Host "were suppressed."
    $codexHooksProbe = Join-Path $codexDir "hooks.json"
    if (Test-Path $codexHooksProbe) {
        $codexHooksContent = Get-Content -Path $codexHooksProbe -Raw -ErrorAction SilentlyContinue
        if ($codexHooksContent -match "plannotator") {
            Write-Host "Your existing Codex Stop hook at $codexDir\hooks.json is unaffected."
        }
    }
    Write-Host "Note: the shared agent skills in ~/.agents/skills serve multiple agents"
    Write-Host "(Codex among them) and are still installed."
} elseif ($codexAvailable) {
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

# Clear OpenCode plugin cache. An OpenCode opt-out (#1178) leaves OpenCode's
# own cache directory alone; the Bun package cache is a shared cache, not
# OpenCode's home, and is always cleared.
if (-not $skipOpencodeResolved) {
    Remove-Item -Recurse -Force "$env:USERPROFILE\.cache\opencode\node_modules\@plannotator" -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force "$env:USERPROFILE\.cache\opencode\packages\@plannotator" -ErrorAction SilentlyContinue
}
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

# NOTE: legacy Claude command cleanup happens AFTER the skill install below -
# a command file is only removed once its replacement skill is on disk, so a
# failed or skipped skill install never leaves users with neither.
$claudeCommandsDir = if ($env:CLAUDE_CONFIG_DIR) { "$env:CLAUDE_CONFIG_DIR\commands" } else { "$env:USERPROFILE\.claude\commands" }

# NOTE: Codex stale-skill cleanup happens AFTER the skill install below - the
# core skills are only removed from the Codex home once their replacement
# exists in ~/.agents/skills, so an old pinned tag never strips Codex users
# of working skills without a successor.
$staleCodexSkillsDir = Join-Path $codexDir "skills"

# Old installers (pre core/extra split) ran a wholesale skills copy against a
# new-layout tag and could leave junk `core`/`extra` directory copies in the
# Claude skills scope. Never valid skill names - always safe to remove.
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
# copies ONCE per machine - recorded in the migrations ledger under the
# Plannotator data dir - because copies the user reinstalls via `npx skills
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
if (Test-Path $prefsFile) {
    foreach ($line in Get-Content $prefsFile) {
        if ($line -match '^extras=(.*)$') { $savedExtras = $Matches[1] }
        if ($line -match '^model_invocable=(.*)$') { $savedInvocable = $Matches[1] }
    }
}

# Extras already on disk (pre-existing or previously npx-installed)? Then the
# extras question is moot - they still count toward the checkbox list, and we
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

# Bound interactive prompts so an unattended-but-attached console (e.g. a
# PsExec / provisioner first-run) can't hang the install. Override with
# PLANNOTATOR_PROMPT_TIMEOUT (0 = wait forever); non-numeric/negative -> 30.
$script:promptTimeout = 30
if ($env:PLANNOTATOR_PROMPT_TIMEOUT) {
    $parsed = 0
    if ([int]::TryParse($env:PLANNOTATOR_PROMPT_TIMEOUT, [ref]$parsed) -and $parsed -ge 0) {
        $script:promptTimeout = $parsed
    }
}

# Read a line with a timeout (seconds); $null if no input arrives in time.
# 0 waits indefinitely. Echoes typed chars since ReadKey($true) intercepts them.
function Read-LineWithTimeout {
    param([int]$TimeoutSeconds)
    if ($TimeoutSeconds -le 0) { return [Console]::ReadLine() }
    $line = ""
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        if ([Console]::KeyAvailable) {
            $key = [Console]::ReadKey($true)
            if ($key.Key -eq "Enter") { Write-Host ""; return $line }
            elseif ($key.Key -eq "Backspace") {
                if ($line.Length -gt 0) { $line = $line.Substring(0, $line.Length - 1); Write-Host "`b `b" -NoNewline }
            }
            else { $line += $key.KeyChar; Write-Host $key.KeyChar -NoNewline }
        }
        else { Start-Sleep -Milliseconds 50 }
    }
    return $null
}

function Read-YesNo {
    param([string]$Prompt, [string]$Default)
    $suffix = if ($Default -eq "yes") { "[Y/n]" } else { "[y/N]" }
    Write-Host "$Prompt $suffix " -NoNewline
    # On timeout nobody is there -> return the SAFE "no", never $Default, so a
    # yes-default prompt can't auto-run unattended.
    $answer = Read-LineWithTimeout $script:promptTimeout
    if ($null -eq $answer) {
        Write-Host ""
        return "no"
    }
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

if ($runWizard) {
    Write-Host ""
    Write-Host "=========================================="
    Write-Host "  PLANNOTATOR GUIDED INSTALL"
    Write-Host "=========================================="
    Write-Host ""
    if ($extrasPresent) {
        Write-Host "Extra skills already installed - keeping them."
        $extrasChoice = "yes"
    } elseif ($Extras -or $NoExtras) {
        # Flag already answered this question - don't ask and then ignore.
        $extrasChoice = if ($Extras) { "yes" } else { "no" }
    } else {
        $defaultExtras = if ($savedExtras) { $savedExtras } else { "no" }
        $extrasChoice = Read-YesNo "Install the extra skills (compound planning, setup-goal, visual explainer)?" $defaultExtras
    }
    $invocableList = $coreSkillNames
    if ($extrasChoice -eq "yes") { $invocableList = $coreSkillNames + $extraSkillNames }
    if ($ModelInvocable) {
        # Flag already answered this question - don't ask and then ignore.
        $invocableChoice = $ModelInvocable
    } else {
        $wantInvocable = Read-YesNo "Make any skills callable by the model (instead of user-invoked only)?" "no"
        if ($wantInvocable -eq "yes") {
            $invocableChoice = Select-SkillsCheckbox -Names $invocableList -Preselected $savedInvocable
        } else {
            $invocableChoice = "none"
        }
    }
}

# Flags override the wizard and saved answers; otherwise saved, then defaults.
if ($Extras) { $extrasChoice = "yes" }
if ($NoExtras) { $extrasChoice = "no" }
if ($ModelInvocable) { $invocableChoice = $ModelInvocable }
if (-not $extrasChoice) { $extrasChoice = if ($savedExtras) { $savedExtras } else { "no" } }
if (-not $invocableChoice) { $invocableChoice = if ($savedInvocable) { $savedInvocable } else { "none" } }

# Persist only when the wizard ran or a flag set something - silent re-runs
# must not clobber saved answers with defaults.
if ($runWizard -or $Extras -or $NoExtras -or $ModelInvocable) {
    New-Item -ItemType Directory -Force -Path $configDir | Out-Null
    @("extras=$extrasChoice", "model_invocable=$invocableChoice") | Set-Content $prefsFile
}

# Extras install is delegated to the skills CLI (its UI picks the agents).
# Interactive only - silent runs and CI get the printed command instead.
# Never runs when the extras already exist. The extras ARE skills, so
# -SkipSkills suppresses them too - a saved extras=yes preference must not
# smuggle a skill install past the opt-out.
if ((-not $skipSkillsResolved) -and ($extrasChoice -eq "yes") -and (-not $extrasPresent)) {
    if ($canPrompt -and (Get-Command npx -ErrorAction SilentlyContinue)) {
        Write-Host "Launching the skills CLI for the extras (pick your agents in its UI)..."
        npx skills add backnotprop/plannotator/apps/skills/extra --global
        if ($LASTEXITCODE -ne 0) {
            Write-Host "skills CLI did not complete - install later with: npx skills add backnotprop/plannotator/apps/skills/extra --global"
        }
    } else {
        Write-Host "Install the extras with: npx skills add backnotprop/plannotator/apps/skills/extra --global"
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
#
# Skills/commands opt-out (-SkipSkills / PLANNOTATOR_SKIP_SKILLS_INSTALL /
# skipInstall.skills). HONEST reporting like the per-agent family: the skipped
# state is announced, and skip means do-not-write - nothing already on disk in
# any skill or command scope is fetched, replaced, or removed on this run.
# Nothing is fetched, so git also stops being a requirement here.
if ($skipSkillsResolved) {
    Write-Host ""
    Write-Host "Skills: skipped ($skipSkillsSource)."
    Write-Host "No skills or slash commands were fetched, and none already installed"
    Write-Host "were changed or removed. The /plannotator-* commands are NOT installed"
    Write-Host "by this run - re-run without the opt-out to install them."
} elseif (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "Error: git is required to install Plannotator's skills and slash commands."
    Write-Host "Install git, then run this installer again."
    Write-Host "To install without them, re-run with -SkipSkills."
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

# Captured tail of git's stderr from the most recent failed clone attempt,
# surfaced with the "network or git error" message below so the real failure
# self-diagnoses instead of being swallowed (#1238). Read before $skillsTmp
# is removed.
$gitStderrTail = @()
$sparseClone = $true

try {
    # Scoped Continue preference: on PowerShell < 7.2 (and profiles that
    # restore the old behavior), redirecting a native command's stderr under
    # $ErrorActionPreference=Stop turns its FIRST stderr line into a
    # terminating error, and git prints its normal "Cloning into ..."
    # progress on stderr, so the clone "failed" on the message announcing it
    # started (#1162). Real failures stay detectable: the clone is verified
    # by Test-Path below, never by a throw. Stderr goes to a file instead of
    # $null (#1238) so failures can be diagnosed.
    $gitErrFile = Join-Path $skillsTmp "git-stderr.txt"
    if (-not $skipSkillsResolved) {
        # LC_ALL=C pins git's error strings to English for the capability
        # probe below: a localized git would emit a translated "unknown
        # option" message the match misses, sending old-git non-English
        # users to a hard failure instead of the fallback. Saved/restored
        # around the call because $env: changes are process-wide. Kept on
        # one line for the install.test.ts scoped-git-call scanner.
        & { $local:ErrorActionPreference = 'Continue'; $prevLcAll = $env:LC_ALL; $env:LC_ALL = 'C'; git clone --depth 1 --filter=blob:none --sparse "https://github.com/$repo.git" --branch $latestTag "$skillsTmp\repo" 2>$gitErrFile; if ($null -eq $prevLcAll) { Remove-Item Env:LC_ALL -ErrorAction SilentlyContinue } else { $env:LC_ALL = $prevLcAll } }
        if (-not (Test-Path "$skillsTmp\repo")) {
            $cloneErr = ""
            if (Test-Path $gitErrFile) { $cloneErr = [System.IO.File]::ReadAllText($gitErrFile) }
            # Capability probe, not a version parse (same philosophy as the
            # GitButler flag probing in packages/shared/gitbutler-core.ts):
            # `git clone --sparse` needs git >= 2.25, and an older git rejects
            # the flag instantly with "error: unknown option `sparse'" before
            # any network call (#1238). Fall back to a plain shallow clone -
            # it costs download size, not correctness: every path the copy
            # steps below read is present in the full checkout, and
            # `git sparse-checkout set` (equally missing on that git) is
            # skipped because there is nothing to narrow.
            if ($cloneErr -match '(?i)unknown option' -and $cloneErr -match '(?i)sparse') {
                Write-Host "This git does not support 'git clone --sparse' (needs git >= 2.25) - falling back to a plain shallow clone."
                $sparseClone = $false
                & { $local:ErrorActionPreference = 'Continue'; git clone --depth 1 "https://github.com/$repo.git" --branch $latestTag "$skillsTmp\repo" 2>$gitErrFile }
            }
        }
        if ((-not (Test-Path "$skillsTmp\repo")) -and (Test-Path $gitErrFile)) {
            $gitStderrTail = @(Get-Content $gitErrFile -ErrorAction SilentlyContinue | Select-Object -Last 5)
        }
    }
    # git is a native executable - it does not throw under
    # $ErrorActionPreference=Stop on non-zero exit. Guard with
    # Test-Path so we only Push-Location if the clone actually
    # produced a repo directory.
    if ($skipSkillsResolved) {
        # Opt-out: no clone was attempted, so there is nothing to copy and
        # $checkoutFailed stays $false - an opt-out is not a fetch failure
        # and must not trip the guard below. Reported above the git check.
    } elseif (Test-Path "$skillsTmp\repo") {
        Push-Location "$skillsTmp\repo"
        # Inner try/finally guarantees Pop-Location runs exactly once
        # after a successful Push-Location, regardless of whether the
        # copy operations below throw. The naive pattern (Pop-Location
        # only on the success path) leaks the location stack if a
        # PS-native cmdlet (Copy-Item etc.) throws under Stop.
        try {
            # Same scoped Continue as the clone above: sparse-checkout may
            # write advice to stderr, which must not become a terminating
            # error on PowerShell < 7.2 (#1162). Skipped entirely on the
            # plain-clone fallback (#1238): that git has no sparse-checkout
            # subcommand, and the full checkout needs no narrowing.
            if ($sparseClone) {
                & { $local:ErrorActionPreference = 'Continue'; git sparse-checkout set apps/skills apps/kiro-cli apps/opencode-plugin/commands apps/gemini/commands 2>$null }
            }

            # Claude Code and Codex consume different skill bodies. Claude Code
            # reads apps/skills/claude/* (dynamic-context injection
            # `!`plannotator ... $ARGUMENTS`` + allowed-tools, so /plannotator-*
            # run with no permission prompt - like the old slash commands).
            # Codex reads apps/skills/core/* (prose the model follows via its
            # own shell). The `!`...`` injection is a Claude-Code-only extension,
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
                Write-Host "Tag $latestTag predates the per-agent skill layout - skipping Claude Code skill install"
            }
            if ((Test-Path "apps\skills\core") -and (Get-ChildItem "apps\skills\core" -ErrorAction SilentlyContinue)) {
                New-Item -ItemType Directory -Force -Path $agentsSkillsDir | Out-Null
                foreach ($skill in @("plannotator-review", "plannotator-annotate", "plannotator-last")) {
                    Copy-SkillIfPresent "apps\skills\core\$skill" $agentsSkillsDir
                }
                Write-Host "Installed shared agent skills to $agentsSkillsDir\"
            } else {
                Write-Host "Tag $latestTag predates the core/extra skill layout - skipping shared agent skill install"
            }

            # Kiro: hand-maintained skills (origin baked in) + two extras.
            # A Kiro opt-out (#1178) leaves ~/.kiro entirely untouched.
            if ($kiroAvailable -and -not $skipKiroResolved -and (Test-Path "apps\kiro-cli\skills")) {
                $kiroSkillsDir = "$env:USERPROFILE\.kiro\skills"
                New-Item -ItemType Directory -Force -Path $kiroSkillsDir | Out-Null
                # Kiro-specific skills (origin baked in) come from apps/kiro-cli/skills.
                Copy-SkillIfPresent "apps\kiro-cli\skills\plannotator-review" $kiroSkillsDir
                Copy-SkillIfPresent "apps\kiro-cli\skills\plannotator-annotate" $kiroSkillsDir
                # Two extras come from apps/skills/extra (not duplicated into apps/kiro-cli/skills).
                Copy-SkillIfPresent "apps\skills\extra\plannotator-setup-goal" $kiroSkillsDir
                Copy-SkillIfPresent "apps\skills\extra\plannotator-visual-explainer" $kiroSkillsDir
                # Plannotator custom agent - don't clobber a user's existing one.
                $kiroAgentsDir = "$env:USERPROFILE\.kiro\agents"
                if (-not (Test-Path "$kiroAgentsDir\plannotator.json") -and (Test-Path "apps\kiro-cli\agents\plannotator.json")) {
                    New-Item -ItemType Directory -Force -Path $kiroAgentsDir | Out-Null
                    Copy-Item -Force "apps\kiro-cli\agents\plannotator.json" "$kiroAgentsDir\plannotator.json"
                }
                Write-Host "Installed Kiro skills to $kiroSkillsDir\ and agent to $kiroAgentsDir\plannotator.json"
            }

            # OpenCode command stubs -> ~/.config/opencode/commands (always,
            # unless opted out via -SkipOpencode: #1178). The plugin
            # intercepts execution; these stubs just register the slash
            # commands in OpenCode.
            if ((-not $skipOpencodeResolved) -and (Test-Path "apps\opencode-plugin\commands")) {
                $opencodeCommandsDir = "$env:USERPROFILE\.config\opencode\commands"
                $opencodeCmds = Get-ChildItem "apps\opencode-plugin\commands\*.md" -ErrorAction SilentlyContinue
                if ($opencodeCmds) {
                    New-Item -ItemType Directory -Force -Path $opencodeCommandsDir | Out-Null
                    Copy-Item -Force "apps\opencode-plugin\commands\*.md" $opencodeCommandsDir
                    Write-Host "Installed OpenCode commands to $opencodeCommandsDir\"
                }
            }

            # Gemini TOML commands -> ~/.gemini/commands (only when ~/.gemini exists).
            # These are Gemini's native command format. A Gemini opt-out
            # (#1178) leaves ~/.gemini entirely untouched.
            if ((Test-Path "$env:USERPROFILE\.gemini") -and -not $skipGeminiResolved -and (Test-Path "apps\gemini\commands")) {
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
    if ($gitStderrTail.Count -gt 0) {
        Write-Host "git reported:"
        foreach ($line in $gitStderrTail) { Write-Host "  $line" }
    }
    Write-Host "Something went wrong - run the installer again."
    exit 1
}

# Claude Code commands are deprecated in favor of skills. Remove a legacy
# command file only once its replacement skill is actually on disk - running
# AFTER the install above guarantees a failed or skipped skill install never
# leaves users with neither the command nor the skill.
foreach ($cmd in @("plannotator-review", "plannotator-annotate", "plannotator-last")) {
    # A skills opt-out installed no replacement this run, so it removes
    # nothing either - skip means do-not-write, never remove.
    if ($skipSkillsResolved) { continue }
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
    # A skills opt-out leaves every skill scope untouched, sweep included.
    if ($skipSkillsResolved) { continue }
    # A Kiro opt-out leaves ~/.kiro entirely untouched - including this sweep.
    if ($skipKiroResolved -and ($scope -eq "$env:USERPROFILE\.kiro\skills")) { continue }
    $staleArchivePath = Join-Path $scope "plannotator-archive"
    if (Test-Path $staleArchivePath) {
        Write-Host "Removing stale plannotator-archive skill $staleArchivePath"
        Remove-Item -Recurse -Force $staleArchivePath -ErrorAction SilentlyContinue
    }
}
# The /plannotator-archive OpenCode command was removed too - sweep the stub.
# An OpenCode opt-out suspends the sweep: skip means do-not-write, never remove.
# A skills opt-out suspends it for the same reason.
$staleOpencodeArchive = "$env:USERPROFILE\.config\opencode\commands\plannotator-archive.md"
if ((-not $skipOpencodeResolved) -and (-not $skipSkillsResolved) -and (Test-Path $staleOpencodeArchive)) {
    Write-Host "Removing stale plannotator-archive command $staleOpencodeArchive"
    Remove-Item -Force $staleOpencodeArchive -ErrorAction SilentlyContinue
}

# Codex no longer hosts core skills (they now live in ~/.agents/skills).
# Core skills are removed only once their replacement exists; the stale
# shared-agent extras were never Codex's and are removed unconditionally.
foreach ($skill in @("plannotator-review", "plannotator-annotate", "plannotator-last", "plannotator-compound", "plannotator-setup-goal")) {
    # A Codex opt-out leaves the Codex home entirely untouched - including
    # this stale-skill cleanup. Skip means do-not-write, never remove. A
    # skills opt-out installed no replacement, so it suspends the sweep too.
    if ($skipCodexResolved -or $skipSkillsResolved) { continue }
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
# A skills opt-out installed no skill copies this run, so there is nothing to
# unlock - and rewriting a PREVIOUS run's SKILL.md would be a write the opt-out
# promised not to make.
if ((-not $skipSkillsResolved) -and $invocableChoice -and ($invocableChoice -ne "none")) {
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
if ((Test-Path $geminiDir) -and $skipGeminiResolved) {
    # HONEST three-state reporting (#1178): detected-but-skipped is its own
    # state. Nothing under ~/.gemini is created, updated, or removed.
    Write-Host ""
    Write-Host "Gemini: detected, skipped ($skipGeminiSource)."
    $geminiSettingsProbe = "$geminiDir\settings.json"
    if (Test-Path $geminiSettingsProbe) {
        $geminiProbeContent = Get-Content -Path $geminiSettingsProbe -Raw -ErrorAction SilentlyContinue
        if ($geminiProbeContent -match '"plannotator"') {
            Write-Host "An existing Gemini integration at $geminiSettingsProbe was left untouched."
        }
    }
} elseif (Test-Path $geminiDir) {
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
if ($skipOpencodeResolved) {
    Write-Host "OpenCode: integration skipped ($skipOpencodeSource)."
    Write-Host "No command stubs were written and OpenCode's plugin cache was left alone."
    Write-Host "Re-run without the opt-out to install the command stubs."
} elseif ($skipSkillsResolved) {
    # The stubs ship in the skills checkout, so this run installed none.
    Write-Host "Add the plugin to your opencode.json:"
    Write-Host ""
    Write-Host '  "plugin": ["@plannotator/opencode@latest"]'
    Write-Host ""
    Write-Host "Skills were skipped ($skipSkillsSource), so no /plannotator-* command"
    Write-Host "stubs were installed. Re-run without the opt-out to add them."
} else {
    Write-Host "Add the plugin to your opencode.json:"
    Write-Host ""
    Write-Host '  "plugin": ["@plannotator/opencode@latest"]'
    Write-Host ""
    Write-Host "Then restart OpenCode. The /plannotator-review, /plannotator-annotate, and /plannotator-last commands are ready!"
}
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
if ($kiroAvailable -and $skipKiroResolved) {
    Write-Host "Kiro was detected, but the integration was skipped ($skipKiroSource)."
    Write-Host "No files under $env:USERPROFILE\.kiro were written or removed. Re-run"
    Write-Host "without the opt-out to add Kiro skills."
} elseif ($kiroAvailable -and $skipSkillsResolved) {
    Write-Host "Kiro was detected, but skills were skipped ($skipSkillsSource), so no"
    Write-Host "Kiro skills or agent were installed. Re-run without the opt-out to add them."
} elseif ($kiroAvailable) {
    Write-Host "Kiro skills are installed to $env:USERPROFILE\.kiro\skills\"
    Write-Host "The Plannotator agent is installed to $env:USERPROFILE\.kiro\agents\plannotator.json"
    Write-Host "Launch it: kiro-cli chat --agent plannotator"
} else {
    Write-Host "Kiro was not detected. After installing Kiro, rerun this installer to add Kiro skills."
}
Write-Host ""
Write-Host "=========================================="
if ($skipSkillsResolved) {
    # Never claim the /plannotator-* commands are ready when nothing was
    # installed - that false banner is exactly what the skills-checkout
    # guard exists to prevent.
    Write-Host "  CLAUDE CODE USERS: BINARY INSTALLED"
} else {
    Write-Host "  CLAUDE CODE USERS: YOU ARE ALL SET!"
}
Write-Host "=========================================="
Write-Host ""
Write-Host "Install the Claude Code plugin:"
Write-Host "  /plugin marketplace add backnotprop/plannotator"
Write-Host "  /plugin install plannotator@plannotator"
Write-Host ""
Write-Host "Upgrading from an older version? Also run /plugin marketplace update"
Write-Host "so the plugin drops its old plannotator:* command entries."
Write-Host ""
if ($skipSkillsResolved) {
    Write-Host "Skills were skipped ($skipSkillsSource), so the /plannotator-review,"
    Write-Host "/plannotator-annotate, and /plannotator-last commands are NOT installed."
    Write-Host "Re-run the installer without the opt-out to add them."
} else {
    Write-Host "The /plannotator-review, /plannotator-annotate, and /plannotator-last commands are ready to use after you restart Claude Code!"
}

if ((-not $skipSkillsResolved) -and ($extrasChoice -ne "yes")) {
    Write-Host ""
    Write-Host "Optional skills (compound planning, setup-goal, visual explainer):"
    Write-Host "  npx skills add backnotprop/plannotator/apps/skills/extra --global"
}

# Warn if plannotator is configured in both settings.json hooks AND the plugin (causes double execution)
# Only warn when the plugin is installed - manual-only users won't have overlap
$claudeSettings = if ($env:CLAUDE_CONFIG_DIR) { "$env:CLAUDE_CONFIG_DIR\settings.json" } else { "$env:USERPROFILE\.claude\settings.json" }
if ((Test-Path $pluginHooks) -and (Test-Path $claudeSettings)) {
    $settingsContent = Get-Content -Path $claudeSettings -Raw -ErrorAction SilentlyContinue
    if ($settingsContent -match '"command".*plannotator') {
        Write-Host ""
        Write-Host "!!! WARNING: DUPLICATE HOOK DETECTED !!!"
        Write-Host ""
        Write-Host "  plannotator was found in your settings.json hooks:"
        Write-Host "  $claudeSettings"
        Write-Host ""
        Write-Host "  This will cause plannotator to run TWICE on each plan review."
        Write-Host "  Remove the plannotator hook from settings.json and rely on the"
        Write-Host "  plugin instead (installed automatically via marketplace)."
        Write-Host ""
        Write-Host "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    }
}
