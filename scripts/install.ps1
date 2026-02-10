# Plannotator Windows Installer
$ErrorActionPreference = "Stop"

$repo = "backnotprop/plannotator"
$installDir = "$env:LOCALAPPDATA\plannotator"

# Detect architecture
$arch = if ([Environment]::Is64BitOperatingSystem) {
    if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
} else {
    Write-Error "32-bit Windows is not supported"
    exit 1
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

Write-Host "Fetching latest version..."
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest"
$latestTag = $release.tag_name

if (-not $latestTag) {
    Write-Error "Failed to fetch latest version"
    exit 1
}

Write-Host "Installing plannotator $latestTag..."

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
    exit 1
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

# Clear OpenCode plugin cache
Remove-Item -Recurse -Force "$env:USERPROFILE\.cache\opencode\node_modules\@plannotator" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:USERPROFILE\.bun\install\cache\@plannotator" -ErrorAction SilentlyContinue

# Install Claude Code slash command
$claudeCommandsDir = if ($env:CLAUDE_CONFIG_DIR) { "$env:CLAUDE_CONFIG_DIR\commands" } else { "$env:USERPROFILE\.claude\commands" }
New-Item -ItemType Directory -Force -Path $claudeCommandsDir | Out-Null

@"
---
description: Open interactive code review for current changes
allowed-tools: Bash(plannotator:*)
---

## Code Review Feedback

!`plannotator review`

## Your task

Address the code review feedback above. The user has reviewed your changes in the Plannotator UI and provided specific annotations and comments.
"@ | Set-Content -Path "$claudeCommandsDir\plannotator-review.md"

Write-Host "Installed /plannotator-review command to $claudeCommandsDir\plannotator-review.md"

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

Write-Host ""
Write-Host "=========================================="
Write-Host "  OPENCODE USERS"
Write-Host "=========================================="
Write-Host ""
Write-Host "Add the plugin to your opencode.json:"
Write-Host ""
Write-Host '  "plugin": ["@plannotator/opencode@latest"]'
Write-Host ""
Write-Host "Then restart OpenCode. The /plannotator-review command is ready!"
Write-Host ""
Write-Host "=========================================="
Write-Host "  CLAUDE CODE USERS: YOU ARE ALL SET!"
Write-Host "=========================================="
Write-Host ""
Write-Host "Install the Claude Code plugin:"
Write-Host "  /plugin marketplace add backnotprop/plannotator"
Write-Host "  /plugin install plannotator@plannotator"
Write-Host ""
Write-Host "The /plannotator-review command is ready to use after you restart Claude Code!"
