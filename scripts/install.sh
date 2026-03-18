#!/bin/bash
set -e

REPO="backnotprop/plannotator"
INSTALL_DIR="$HOME/.local/bin"

case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    *)      echo "Unsupported OS. For Windows, run: irm https://plannotator.ai/install.ps1 | iex" >&2; exit 1 ;;
esac

case "$(uname -m)" in
    x86_64|amd64)   arch="x64" ;;
    arm64|aarch64)  arch="arm64" ;;
    *)              echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

platform="${os}-${arch}"
binary_name="plannotator-${platform}"

# Clean up old Windows install locations (for users running bash on Windows)
if [ -n "$USERPROFILE" ]; then
    # Running on Windows (Git Bash, MSYS, etc.) - clean up old locations
    rm -f "$USERPROFILE/.local/bin/plannotator" "$USERPROFILE/.local/bin/plannotator.exe" 2>/dev/null || true
    rm -f "$LOCALAPPDATA/plannotator/plannotator.exe" 2>/dev/null || true
    echo "Cleaned up old Windows install locations"
fi

echo "Fetching latest version..."
latest_tag=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)

if [ -z "$latest_tag" ]; then
    echo "Failed to fetch latest version" >&2
    exit 1
fi

echo "Installing plannotator ${latest_tag}..."

binary_url="https://github.com/${REPO}/releases/download/${latest_tag}/${binary_name}"
checksum_url="${binary_url}.sha256"

mkdir -p "$INSTALL_DIR"

tmp_file=$(mktemp)
curl -fsSL -o "$tmp_file" "$binary_url"

expected_checksum=$(curl -fsSL "$checksum_url" | cut -d' ' -f1)

if [ "$(uname -s)" = "Darwin" ]; then
    actual_checksum=$(shasum -a 256 "$tmp_file" | cut -d' ' -f1)
else
    actual_checksum=$(sha256sum "$tmp_file" | cut -d' ' -f1)
fi

if [ "$actual_checksum" != "$expected_checksum" ]; then
    echo "Checksum verification failed!" >&2
    rm -f "$tmp_file"
    exit 1
fi

# Remove old binary first (handles Windows .exe and locked file issues)
rm -f "$INSTALL_DIR/plannotator" "$INSTALL_DIR/plannotator.exe" 2>/dev/null || true

mv "$tmp_file" "$INSTALL_DIR/plannotator"
chmod +x "$INSTALL_DIR/plannotator"

echo ""
echo "plannotator ${latest_tag} installed to ${INSTALL_DIR}/plannotator"

if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
    echo ""
    echo "${INSTALL_DIR} is not in your PATH. Add it with:"
    echo ""

    case "$SHELL" in
        */zsh)  shell_config="~/.zshrc" ;;
        */bash) shell_config="~/.bashrc" ;;
        *)      shell_config="your shell config" ;;
    esac

    echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ${shell_config}"
    echo "  source ${shell_config}"
fi

# Validate plugin hooks.json if plugin is already installed
PLUGIN_HOOKS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/marketplaces/plannotator/apps/hook/hooks/hooks.json"
if [ -f "$PLUGIN_HOOKS" ]; then
    cat > "$PLUGIN_HOOKS" << 'HOOKS_EOF'
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "ExitPlanMode",
        "hooks": [
          {
            "type": "command",
            "command": "plannotator",
            "timeout": 345600
          }
        ]
      }
    ]
  }
}
HOOKS_EOF
    echo "Updated plugin hooks at ${PLUGIN_HOOKS}"
fi

# Clear any cached OpenCode plugin to force fresh download on next run
rm -rf "$HOME/.cache/opencode/node_modules/@plannotator" "$HOME/.bun/install/cache/@plannotator" 2>/dev/null || true

# Clear Pi jiti cache to force fresh download on next run
rm -rf /tmp/jiti 2>/dev/null || true

# Update Pi extension if pi is installed
if command -v pi &>/dev/null; then
    echo "Updating Pi extension..."
    pi install npm:@plannotator/pi-extension
    echo "Pi extension updated."
fi

# Install /review slash command
CLAUDE_COMMANDS_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/commands"
mkdir -p "$CLAUDE_COMMANDS_DIR"

cat > "$CLAUDE_COMMANDS_DIR/plannotator-review.md" << 'COMMAND_EOF'
---
description: Open interactive code review for current changes
allowed-tools: Bash(plannotator:*)
---

## Code Review Feedback

!`plannotator review`

## Your task

If the review above contains feedback or annotations, address them. If no changes were requested, acknowledge and continue.
COMMAND_EOF

echo "Installed /plannotator-review command to ${CLAUDE_COMMANDS_DIR}/plannotator-review.md"

# Install /annotate slash command for Claude Code
cat > "$CLAUDE_COMMANDS_DIR/plannotator-annotate.md" << 'COMMAND_EOF'
---
description: Open interactive annotation UI for a markdown file
allowed-tools: Bash(plannotator:*)
---

## Markdown Annotations

!`plannotator annotate $ARGUMENTS`

## Your task

Address the annotation feedback above. The user has reviewed the markdown file and provided specific annotations and comments.
COMMAND_EOF

echo "Installed /plannotator-annotate command to ${CLAUDE_COMMANDS_DIR}/plannotator-annotate.md"

# Install /plannotator-last slash command for Claude Code
cat > "$CLAUDE_COMMANDS_DIR/plannotator-last.md" << 'COMMAND_EOF'
---
description: Annotate the last rendered assistant message
allowed-tools: Bash(plannotator:*)
---

## Message Annotations

!`plannotator annotate-last`

## Your task

Address the annotation feedback above. The user has reviewed your last message and provided specific annotations and comments.
COMMAND_EOF

echo "Installed /plannotator-last command to ${CLAUDE_COMMANDS_DIR}/plannotator-last.md"

# Install OpenCode slash command
OPENCODE_COMMANDS_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/command"
mkdir -p "$OPENCODE_COMMANDS_DIR"

cat > "$OPENCODE_COMMANDS_DIR/plannotator-review.md" << 'COMMAND_EOF'
---
description: Open interactive code review for current changes
---

The Plannotator Code Review has been triggered. Opening the review UI...
Acknowledge "Opening code review..." and wait for the user's feedback.
COMMAND_EOF

echo "Installed /plannotator-review command to ${OPENCODE_COMMANDS_DIR}/plannotator-review.md"

# Install /annotate slash command for OpenCode
cat > "$OPENCODE_COMMANDS_DIR/plannotator-annotate.md" << 'COMMAND_EOF'
---
description: Open interactive annotation UI for a markdown file
---

The Plannotator Annotate has been triggered. Opening the annotation UI...
Acknowledge "Opening annotation UI..." and wait for the user's feedback.
COMMAND_EOF

echo "Installed /plannotator-annotate command to ${OPENCODE_COMMANDS_DIR}/plannotator-annotate.md"

# Install /plannotator-last slash command for OpenCode
cat > "$OPENCODE_COMMANDS_DIR/plannotator-last.md" << 'COMMAND_EOF'
---
description: Annotate the last assistant message
---
COMMAND_EOF

echo "Installed /plannotator-last command to ${OPENCODE_COMMANDS_DIR}/plannotator-last.md"

echo ""
echo "=========================================="
echo "  OPENCODE USERS"
echo "=========================================="
echo ""
echo "Add the plugin to your opencode.json:"
echo ""
echo '  "plugin": ["@plannotator/opencode@latest"]'
echo ""
echo "Then restart OpenCode. The /plannotator-review, /plannotator-annotate, and /plannotator-last commands are ready!"
echo ""
echo "=========================================="
echo "  PI USERS"
echo "=========================================="
echo ""
echo "Install or update the extension:"
echo ""
echo "  pi install npm:@plannotator/pi-extension"
echo ""
echo "=========================================="
echo "  CLAUDE CODE USERS: YOU'RE ALL SET!"
echo "=========================================="
echo ""
echo "Install the Claude Code plugin:"
echo "  /plugin marketplace add backnotprop/plannotator"
echo "  /plugin install plannotator@plannotator"
echo ""
echo "The /plannotator-review, /plannotator-annotate, and /plannotator-last commands are ready to use after you restart Claude Code!"

# Warn if plannotator is configured in both settings.json hooks AND the plugin (causes double execution)
# Only warn when the plugin is installed — manual-only users won't have overlap
CLAUDE_SETTINGS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
if [ -f "$PLUGIN_HOOKS" ] && [ -f "$CLAUDE_SETTINGS" ] && grep -q '"command".*plannotator' "$CLAUDE_SETTINGS" 2>/dev/null; then
    echo ""
    echo "⚠️ ⚠️ ⚠️  WARNING: DUPLICATE HOOK DETECTED  ⚠️ ⚠️ ⚠️"
    echo ""
    echo "  plannotator was found in your settings.json hooks:"
    echo "  $CLAUDE_SETTINGS"
    echo ""
    echo "  This will cause plannotator to run TWICE on each plan review."
    echo "  Remove the plannotator hook from settings.json and rely on the"
    echo "  plugin instead (installed automatically via marketplace)."
    echo ""
    echo "⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️"
fi
