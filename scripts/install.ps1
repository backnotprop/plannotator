param(
    [Parameter(Position=0)]
    [string]$Version = "latest"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = 'SilentlyContinue'

$REPO = "backnotprop/plannotator"
$INSTALL_DIR = "$env:USERPROFILE\.local\bin"

# Check for 32-bit Windows
if (-not [Environment]::Is64BitProcess) {
    Write-Error "Plannotator does not support 32-bit Windows."
    exit 1
}

# Determine platform
$platform = "win32-x64"

# Create install directory
New-Item -ItemType Directory -Force -Path $INSTALL_DIR | Out-Null

# Get version to install
if ($Version -eq "latest") {
    Write-Output "Fetching latest version..."
    try {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$REPO/releases/latest" -ErrorAction Stop
        $tag = $release.tag_name
    }
    catch {
        Write-Error "Failed to get latest version: $_"
        exit 1
    }
}
else {
    $tag = $Version
    if (-not $tag.StartsWith("v")) {
        $tag = "v$tag"
    }
}

Write-Output "Installing plannotator $tag..."

$binaryName = "plannotator-$platform.exe"
$binaryUrl = "https://github.com/$REPO/releases/download/$tag/$binaryName"
$checksumUrl = "$binaryUrl.sha256"

# Download binary
$tempFile = Join-Path $env:TEMP "plannotator-$tag.exe"
try {
    Invoke-WebRequest -Uri $binaryUrl -OutFile $tempFile -ErrorAction Stop
}
catch {
    Write-Error "Failed to download binary: $_"
    if (Test-Path $tempFile) {
        Remove-Item -Force $tempFile
    }
    exit 1
}

# Download and verify checksum
try {
    $expectedChecksum = (Invoke-RestMethod -Uri $checksumUrl -ErrorAction Stop).Split(" ")[0].Trim()
}
catch {
    Write-Error "Failed to download checksum: $_"
    Remove-Item -Force $tempFile
    exit 1
}

$actualChecksum = (Get-FileHash -Path $tempFile -Algorithm SHA256).Hash.ToLower()

if ($actualChecksum -ne $expectedChecksum) {
    Write-Error "Checksum verification failed"
    Remove-Item -Force $tempFile
    exit 1
}

# Install binary
$installPath = Join-Path $INSTALL_DIR "plannotator.exe"
Move-Item -Force $tempFile $installPath

Write-Output ""
Write-Output "plannotator $tag installed to $installPath"

# Check if install directory is in PATH
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$INSTALL_DIR*") {
    Write-Output ""
    Write-Output "$INSTALL_DIR is not in your PATH."
    Write-Output ""
    Write-Output "Add it permanently with:"
    Write-Output ""
    Write-Output "  [Environment]::SetEnvironmentVariable('Path', `$env:Path + ';$INSTALL_DIR', 'User')"
    Write-Output ""
    Write-Output "Or add it for this session only:"
    Write-Output ""
    Write-Output "  `$env:Path += ';$INSTALL_DIR'"
}

# Install /review slash command
$claudeCommandsDir = "$env:USERPROFILE\.claude\commands"
New-Item -ItemType Directory -Force -Path $claudeCommandsDir | Out-Null

$reviewCommand = @"
---
description: Open interactive code review for current changes
allowed-tools: Bash(plannotator:*)
---

## Code Review Feedback

!``plannotator review``

## Your task

Address the code review feedback above. The user has reviewed your changes in the Plannotator UI and provided specific annotations and comments.
"@

Set-Content -Path "$claudeCommandsDir\plannotator-review.md" -Value $reviewCommand -Encoding UTF8
Write-Output "Installed /plannotator-review command to $claudeCommandsDir\plannotator-review.md"

Write-Output ""
Write-Output "Test the install:"
Write-Output '  echo ''{"tool_input":{"plan":"# Test Plan\\n\\nHello world"}}'' | plannotator'
Write-Output ""
Write-Output "Then install the Claude Code plugin:"
Write-Output "  /plugin marketplace add backnotprop/plannotator"
Write-Output "  /plugin install plannotator@plannotator"
Write-Output ""
Write-Output "The /plannotator-review command is ready to use!"
Write-Output ""
