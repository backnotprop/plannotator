#!/bin/bash
set -e

REPO="backnotprop/plannotator"
INSTALL_DIR="$HOME/.local/bin"

# First plannotator release that carries SLSA build-provenance attestations.
# Releases before this tag were cut before release.yml added the
# `actions/attest-build-provenance` step, so `gh attestation verify` will
# fail with "no attestations found" for them regardless of authenticity.
# When provenance verification is enabled (via flag, env var, or
# ~/.plannotator/config.json), the installer compares the resolved tag
# against this constant and fails fast with a clear message instead of
# downloading a binary, running SHA256, and then hitting a cryptic gh
# failure. Bumped once at the first attested release via the release skill.
MIN_ATTESTED_VERSION="v0.17.2"

# Compare two vMAJOR.MINOR.PATCH tags. Returns 0 (success) if $1 >= $2.
# Uses `sort -V` (version sort) which handles minor/patch width correctly
# unlike plain lexicographic comparison (e.g. v0.9.0 vs v0.10.0).
version_ge() {
    [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" = "$1" ]
}

VERSION="latest"
# Tracks whether a version was explicitly set via --version or positional.
# Used to reject mixing --version <tag> with a stray positional token,
# which would otherwise silently overwrite the earlier value and 404.
VERSION_EXPLICIT=0
# Three-layer opt-in for SLSA build-provenance verification.
# Precedence: CLI flag > env var > ~/.plannotator/config.json > default (off).
# -1 = flag not set yet (fall through to lower layers); 0 = disable; 1 = enable.
VERIFY_ATTESTATION_FLAG=-1

usage() {
    cat <<'USAGE'
Usage: install.sh [--version <tag>] [--verify-attestation | --skip-attestation] [--help]
       install.sh <tag>

Options:
  --version <tag>        Install a specific version (e.g. vX.Y.Z or X.Y.Z;
                         see https://github.com/backnotprop/plannotator/releases).
                         Defaults to the latest GitHub release.
  --verify-attestation   Require SLSA build-provenance verification via
                         `gh attestation verify`. Fails the install if gh is
                         not available or the check does not pass.
  --skip-attestation     Force-skip provenance verification even if enabled
                         via env var or ~/.plannotator/config.json.
  -h, --help             Show this help and exit.

Provenance verification is off by default. Enable it by any of:
  - passing --verify-attestation
  - exporting PLANNOTATOR_VERIFY_ATTESTATION=1
  - setting { "verifyAttestation": true } in ~/.plannotator/config.json

Examples:
  curl -fsSL https://plannotator.ai/install.sh | bash
  curl -fsSL https://plannotator.ai/install.sh | bash -s -- --version vX.Y.Z
  curl -fsSL https://plannotator.ai/install.sh | bash -s -- --verify-attestation
  bash install.sh vX.Y.Z
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        --version)
            if [ -z "${2:-}" ]; then
                echo "--version requires an argument" >&2
                usage >&2
                exit 1
            fi
            case "$2" in
                -*)
                    echo "--version requires a tag value, got flag: $2" >&2
                    usage >&2
                    exit 1
                    ;;
            esac
            VERSION="$2"
            VERSION_EXPLICIT=1
            shift 2
            ;;
        --version=*)
            value="${1#--version=}"
            if [ -z "$value" ]; then
                echo "--version requires an argument" >&2
                usage >&2
                exit 1
            fi
            case "$value" in
                -*)
                    echo "--version requires a tag value, got flag: $value" >&2
                    usage >&2
                    exit 1
                    ;;
            esac
            VERSION="$value"
            VERSION_EXPLICIT=1
            shift
            ;;
        --verify-attestation)
            if [ "$VERIFY_ATTESTATION_FLAG" = "0" ]; then
                echo "--verify-attestation and --skip-attestation are mutually exclusive" >&2
                usage >&2
                exit 1
            fi
            VERIFY_ATTESTATION_FLAG=1
            shift
            ;;
        --skip-attestation)
            if [ "$VERIFY_ATTESTATION_FLAG" = "1" ]; then
                echo "--skip-attestation and --verify-attestation are mutually exclusive" >&2
                usage >&2
                exit 1
            fi
            VERIFY_ATTESTATION_FLAG=0
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        -*)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 1
            ;;
        *)
            # Positional form: install.sh vX.Y.Z (matches install.cmd interface).
            # Reject if --version was already passed — silent overwrite is worse
            # than a clean usage error.
            if [ "$VERSION_EXPLICIT" -eq 1 ]; then
                echo "Unexpected positional argument: $1 (version already set)" >&2
                usage >&2
                exit 1
            fi
            VERSION="$1"
            VERSION_EXPLICIT=1
            shift
            ;;
    esac
done

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

if [ "$VERSION" = "latest" ]; then
    echo "Fetching latest version..."
    latest_tag=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)

    if [ -z "$latest_tag" ]; then
        echo "Failed to fetch latest version" >&2
        exit 1
    fi
else
    # Normalize: auto-prefix v if missing (matches install.cmd behaviour)
    case "$VERSION" in
        v*) latest_tag="$VERSION" ;;
        *)  latest_tag="v$VERSION" ;;
    esac
fi

echo "Installing plannotator ${latest_tag}..."

# Resolve SLSA build-provenance verification opt-in BEFORE the download so we
# can fail fast without wasting bandwidth if the requested tag predates
# provenance support. The three layers (config file, env var, CLI flag) are
# all cheap to check — no reason to defer this past the arg parse.
#
# Precedence: CLI flag > env var > ~/.plannotator/config.json > default (off).
verify_attestation=0

# Layer 3: config file (lowest precedence of the opt-in sources).
# Crude grep against a flat boolean — PlannotatorConfig has no nested
# verifyAttestation, so false positives are not a concern.
if [ -f "$HOME/.plannotator/config.json" ]; then
    if grep -q '"verifyAttestation"[[:space:]]*:[[:space:]]*true' "$HOME/.plannotator/config.json" 2>/dev/null; then
        verify_attestation=1
    fi
fi

# Layer 2: env var (overrides config file).
case "${PLANNOTATOR_VERIFY_ATTESTATION:-}" in
    1|true|yes|TRUE|YES|True|Yes) verify_attestation=1 ;;
    0|false|no|FALSE|NO|False|No) verify_attestation=0 ;;
esac

# Layer 1: CLI flag (overrides everything).
if [ "$VERIFY_ATTESTATION_FLAG" -ne -1 ]; then
    verify_attestation="$VERIFY_ATTESTATION_FLAG"
fi

# Pre-flight: if verification is requested, reject tags older than the first
# attested release before we download anything. This catches both explicit
# `--version <old-tag>` and implicit `latest`-resolves-to-old-tag cases with
# a clean, actionable error — no cryptic `gh: no attestations found` after
# a wasted download.
if [ "$verify_attestation" -eq 1 ]; then
    if ! version_ge "$latest_tag" "$MIN_ATTESTED_VERSION"; then
        echo "Provenance verification was requested, but ${latest_tag} predates" >&2
        echo "plannotator's attestation support. The first release carrying signed" >&2
        echo "build provenance is ${MIN_ATTESTED_VERSION}. Options:" >&2
        echo "  - Pin to ${MIN_ATTESTED_VERSION} or later: --version ${MIN_ATTESTED_VERSION}" >&2
        echo "  - Install without provenance verification: --skip-attestation" >&2
        echo "  - Or unset PLANNOTATOR_VERIFY_ATTESTATION / remove verifyAttestation" >&2
        echo "    from ~/.plannotator/config.json" >&2
        exit 1
    fi
fi

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

if [ "$verify_attestation" -eq 1 ]; then
    # $verify_attestation was resolved before the download; MIN_ATTESTED_VERSION
    # pre-flight already ran and rejected old tags. At this point we know
    # the tag is attested and gh should find a bundle.
    if command -v gh >/dev/null 2>&1; then
        # Capture combined output so we can surface gh's actual error message
        # (auth, network, missing attestation, etc.) on failure instead of a
        # generic "verification failed" with no diagnostic detail.
        # Constrain verification to the exact tag + signing workflow — not
        # just "built by somewhere in this repo". --source-ref pins the
        # git ref the attestation was produced from; --signer-workflow pins
        # the workflow file that signed it. Together they prevent accepting
        # a misattached asset or an attestation from an unrelated workflow.
        if gh_output=$(gh attestation verify "$tmp_file" \
            --repo "$REPO" \
            --source-ref "refs/tags/${latest_tag}" \
            --signer-workflow "backnotprop/plannotator/.github/workflows/release.yml" 2>&1); then
            echo "✓ verified build provenance (SLSA)"
        else
            echo "$gh_output" >&2
            echo "Attestation verification failed!" >&2
            echo "The binary's SHA256 matched, but no valid signed provenance was found" >&2
            echo "for ${REPO}. Refusing to install." >&2
            rm -f "$tmp_file"
            exit 1
        fi
    else
        echo "verifyAttestation is enabled but gh CLI was not found." >&2
        echo "Install https://cli.github.com (and run 'gh auth login')," >&2
        echo "or unset PLANNOTATOR_VERIFY_ATTESTATION / remove verifyAttestation from" >&2
        echo "~/.plannotator/config.json / pass --skip-attestation." >&2
        rm -f "$tmp_file"
        exit 1
    fi
else
    echo "SHA256 verified. For build provenance verification, see"
    echo "https://plannotator.ai/docs/getting-started/installation/#verifying-your-install"
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

# --- Codex CLI / Desktop app support (only if Codex is installed or configured) ---
codex_home_has_user_config() {
    [ -d "$HOME/.codex" ] || return 1
    [ -n "$(find "$HOME/.codex" -mindepth 1 -maxdepth 1 ! -name skills ! -name .DS_Store -print -quit 2>/dev/null)" ]
}

codex_available=0
if command -v codex >/dev/null 2>&1 || codex_home_has_user_config; then
    codex_available=1
fi

if [ "$codex_available" -eq 1 ]; then
    CODEX_DIR="$HOME/.codex"
    CODEX_CONFIG="$CODEX_DIR/config.toml"
    CODEX_HOOKS="$CODEX_DIR/hooks.json"
    PLANNOTATOR_BIN="${INSTALL_DIR}/plannotator"
    codex_hook_configured=0

    mkdir -p "$CODEX_DIR"

    enable_codex_hooks_config() {
        if [ ! -f "$CODEX_CONFIG" ]; then
            cat > "$CODEX_CONFIG" << 'CODEX_CONFIG_EOF'
[features]
codex_hooks = true
CODEX_CONFIG_EOF
            echo "Created Codex config at ${CODEX_CONFIG}"
            return 0
        fi

        if grep -Eq '^[[:space:]]*features[[:space:]]*=' "$CODEX_CONFIG"; then
            echo ""
            echo "Codex config uses inline features in ${CODEX_CONFIG}; leaving it unchanged."
            echo "Add this manually to enable Plannotator plan review:"
            echo ""
            echo "  [features]"
            echo "  codex_hooks = true"
            return 1
        fi

        tmp_config="$(mktemp)"
        if awk '
            function is_table(line) {
                return line ~ /^[[:space:]]*\[[^]]+\][[:space:]]*$/
            }
            BEGIN {
                in_features = 0
                saw_features = 0
                saw_hook = 0
            }
            {
                if (is_table($0)) {
                    if (in_features && !saw_hook) {
                        print "codex_hooks = true"
                        saw_hook = 1
                    }
                    in_features = ($0 ~ /^[[:space:]]*\[features\][[:space:]]*$/)
                    if (in_features) saw_features = 1
                }

                if (in_features && $0 ~ /^[[:space:]]*codex_hooks[[:space:]]*=/) {
                    print "codex_hooks = true"
                    saw_hook = 1
                    next
                }

                print
            }
            END {
                if (saw_features && in_features && !saw_hook) {
                    print "codex_hooks = true"
                } else if (!saw_features) {
                    print ""
                    print "[features]"
                    print "codex_hooks = true"
                }
            }
        ' "$CODEX_CONFIG" > "$tmp_config"; then
            mv "$tmp_config" "$CODEX_CONFIG"
            echo "Enabled codex_hooks in ${CODEX_CONFIG}"
            return 0
        fi

        rm -f "$tmp_config"
        echo "Could not update ${CODEX_CONFIG}; add codex_hooks manually." >&2
        return 1
    }

    if [ ! -f "$CODEX_HOOKS" ]; then
        cat > "$CODEX_HOOKS" << CODEX_HOOKS_EOF
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${PLANNOTATOR_BIN}",
            "timeout": 345600
          }
        ]
      }
    ]
  }
}
CODEX_HOOKS_EOF
        echo "Created Codex hooks at ${CODEX_HOOKS}"
        codex_hook_configured=1
    elif command -v node >/dev/null 2>&1; then
        if codex_merge_result=$(node - "$CODEX_HOOKS" "$PLANNOTATOR_BIN" <<'NODE'
const fs = require("fs");
const path = require("path");
const [hooksPath, command] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
config.hooks ||= {};
const stopHooks = Array.isArray(config.hooks.Stop) ? config.hooks.Stop : [];
let updated = false;
let foundCustomPlannotatorHook = false;

function isManagedPlannotatorCommand(value) {
  const current = value.trim();
  if (current === "plannotator" || current === command) return true;
  return current.startsWith("/") && path.posix.basename(current) === "plannotator";
}

for (const entry of stopHooks) {
  const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
  for (const hook of hooks) {
    if (hook?.type !== "command" || typeof hook.command !== "string") continue;

    if (isManagedPlannotatorCommand(hook.command)) {
      hook.command = command;
      hook.timeout = 345600;
      updated = true;
    } else if (hook.command.includes("plannotator")) {
      foundCustomPlannotatorHook = true;
    }
  }
}
if (!updated && !foundCustomPlannotatorHook) {
  stopHooks.push({
    hooks: [
      {
        type: "command",
        command,
        timeout: 345600,
      },
    ],
  });
}
config.hooks.Stop = stopHooks;
if (updated || !foundCustomPlannotatorHook) {
  fs.writeFileSync(hooksPath, JSON.stringify(config, null, 2) + "\n");
}
process.stdout.write(updated ? "updated" : foundCustomPlannotatorHook ? "custom" : "added");
NODE
        ); then
            case "$codex_merge_result" in
                custom)
                    echo "Existing custom Codex Plannotator hook found at ${CODEX_HOOKS}; left it unchanged."
                    ;;
                added)
                    echo "Added Codex hooks at ${CODEX_HOOKS}"
                    ;;
                *)
                    echo "Updated Codex hooks at ${CODEX_HOOKS}"
                    ;;
            esac
            codex_hook_configured=1
        else
            echo ""
            echo "Codex hooks file already exists at ${CODEX_HOOKS}, but it could not be merged automatically."
            echo "Leaving Codex hook support unchanged. Add or update this Stop hook manually:"
            echo ""
            echo "  command: ${PLANNOTATOR_BIN}"
            echo "  timeout: 345600"
        fi
    else
        echo ""
        echo "Codex hooks file already exists at ${CODEX_HOOKS}, but node was not found to merge it safely."
        echo "Leaving Codex hook support unchanged. Add or update this Stop hook manually:"
        echo ""
        echo "  command: ${PLANNOTATOR_BIN}"
        echo "  timeout: 345600"
    fi

    if [ "$codex_hook_configured" -eq 1 ]; then
        enable_codex_hooks_config || true
    fi
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
rm -rf "$HOME/.cache/opencode/node_modules/@plannotator" "$HOME/.cache/opencode/packages/@plannotator" "$HOME/.bun/install/cache/@plannotator" 2>/dev/null || true

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
description: Open interactive code review for current changes or a PR URL
allowed-tools: Bash(plannotator:*)
---

## Code Review Feedback

!`plannotator review $ARGUMENTS`

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

# Remove legacy Codex-oriented skills from the older shared agent scope.
LEGACY_AGENTS_SKILLS_DIR="$HOME/.agents/skills"
legacy_skills_removed=0
if [ -d "$LEGACY_AGENTS_SKILLS_DIR" ]; then
    for skill in plannotator-review plannotator-annotate plannotator-last; do
        if [ -d "$LEGACY_AGENTS_SKILLS_DIR/$skill" ]; then
            rm -rf "$LEGACY_AGENTS_SKILLS_DIR/$skill"
            legacy_skills_removed=1
        fi
    done
fi
if [ "$legacy_skills_removed" -eq 1 ]; then
    echo "Removed legacy Plannotator skills from ${LEGACY_AGENTS_SKILLS_DIR}"
fi

# Remove Plannotator skills that belong in the shared agent scope from Codex.
STALE_CODEX_SKILLS_DIR="$HOME/.codex/skills"
stale_codex_skills_removed=0
if [ -d "$STALE_CODEX_SKILLS_DIR" ]; then
    for skill in plannotator-compound plannotator-setup-goal; do
        if [ -d "$STALE_CODEX_SKILLS_DIR/$skill" ]; then
            rm -rf "$STALE_CODEX_SKILLS_DIR/$skill"
            stale_codex_skills_removed=1
        fi
    done
fi
if [ "$stale_codex_skills_removed" -eq 1 ]; then
    echo "Removed shared-agent Plannotator skills from ${STALE_CODEX_SKILLS_DIR}"
fi

# Install skills (requires git)
if command -v git &>/dev/null; then
    CLAUDE_SKILLS_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"
    CODEX_SKILLS_DIR="$HOME/.codex/skills"
    AGENTS_SKILLS_DIR="$HOME/.agents/skills"
    skills_tmp=$(mktemp -d)

    copy_skill_if_present() {
        local source_dir="$1"
        local target_dir="$2"

        if [ -d "$source_dir" ]; then
            cp -r "$source_dir" "$target_dir/"
        fi
    }

    # Wrap the cd-bearing block in a subshell so any `cd` is scoped to
    # the subshell and can't leave the parent script with a dangling CWD.
    # Previous version chained `cd` inside an `&&` condition, and if
    # sparse-checkout failed the else branch ran without restoring the
    # directory — then `rm -rf "$skills_tmp"` below executed while the
    # shell's CWD was still inside the directory being deleted. No
    # production failure (subsequent code uses absolute paths) but
    # structurally incorrect. install.ps1 and install.cmd use
    # Push-Location/pushd for the same logic; a subshell is bash's
    # equivalent — the parent shell's CWD is inherited in, and any
    # cd inside the subshell disappears when the subshell exits.
    if (
        set -e
        cd "$skills_tmp"
        git clone --depth 1 --filter=blob:none --sparse \
            "https://github.com/${REPO}.git" --branch "$latest_tag" repo 2>/dev/null
        cd repo
        git sparse-checkout set apps/skills 2>/dev/null
        [ -d "apps/skills" ]
        [ "$(ls -A apps/skills 2>/dev/null)" ]
        mkdir -p "$CLAUDE_SKILLS_DIR" "$AGENTS_SKILLS_DIR"
        cp -r apps/skills/* "$CLAUDE_SKILLS_DIR/"
        copy_skill_if_present apps/skills/plannotator-compound "$AGENTS_SKILLS_DIR"
        copy_skill_if_present apps/skills/plannotator-setup-goal "$AGENTS_SKILLS_DIR"
        if [ "$codex_available" -eq 1 ]; then
            mkdir -p "$CODEX_SKILLS_DIR"
            copy_skill_if_present apps/skills/plannotator-review "$CODEX_SKILLS_DIR"
            copy_skill_if_present apps/skills/plannotator-annotate "$CODEX_SKILLS_DIR"
            copy_skill_if_present apps/skills/plannotator-last "$CODEX_SKILLS_DIR"
        fi
    ); then
        if [ "$codex_available" -eq 1 ]; then
            echo "Installed skills to ${CLAUDE_SKILLS_DIR}/, Codex command skills to ${CODEX_SKILLS_DIR}/, and shared agent skills to ${AGENTS_SKILLS_DIR}/"
        else
            echo "Installed skills to ${CLAUDE_SKILLS_DIR}/ and shared agent skills to ${AGENTS_SKILLS_DIR}/"
        fi
    else
        echo "Skipping skills install (git sparse-checkout failed or apps/skills empty)"
    fi

    rm -rf "$skills_tmp"
else
    echo "Skipping skills install (git not found)"
fi

# --- Gemini CLI support (only if Gemini is installed) ---
if [ -d "$HOME/.gemini" ]; then
    # Install policy file
    GEMINI_POLICIES_DIR="$HOME/.gemini/policies"
    mkdir -p "$GEMINI_POLICIES_DIR"
    cat > "$GEMINI_POLICIES_DIR/plannotator.toml" << 'GEMINI_POLICY_EOF'
# Plannotator policy for Gemini CLI
# Allows exit_plan_mode without TUI confirmation so the browser UI is the sole gate.
[[rule]]
toolName = "exit_plan_mode"
decision = "allow"
priority = 100
GEMINI_POLICY_EOF
    echo "Installed Gemini policy to ${GEMINI_POLICIES_DIR}/plannotator.toml"

    # Configure hook in settings.json
    GEMINI_SETTINGS="$HOME/.gemini/settings.json"
    PLANNOTATOR_HOOK='{"matcher":"exit_plan_mode","hooks":[{"type":"command","command":"plannotator","timeout":345600}]}'

    if [ -f "$GEMINI_SETTINGS" ]; then
        if ! grep -q '"plannotator"' "$GEMINI_SETTINGS" 2>/dev/null; then
            # Merge hook into existing settings.json using node (ships with Gemini CLI)
            if command -v node &>/dev/null; then
                node -e "
                  const fs = require('fs');
                  const settings = JSON.parse(fs.readFileSync('$GEMINI_SETTINGS', 'utf8'));
                  if (!settings.hooks) settings.hooks = {};
                  if (!settings.hooks.BeforeTool) settings.hooks.BeforeTool = [];
                  settings.hooks.BeforeTool.push($PLANNOTATOR_HOOK);
                  fs.writeFileSync('$GEMINI_SETTINGS', JSON.stringify(settings, null, 2) + '\n');
                "
                echo "Added plannotator hook to ${GEMINI_SETTINGS}"
            else
                echo ""
                echo "Add the following to your ~/.gemini/settings.json hooks:"
                echo ""
                echo '  "hooks": {'
                echo '    "BeforeTool": [{'
                echo '      "matcher": "exit_plan_mode",'
                echo '      "hooks": [{"type": "command", "command": "plannotator", "timeout": 345600}]'
                echo '    }]'
                echo '  }'
            fi
        fi
    else
        cat > "$GEMINI_SETTINGS" << 'GEMINI_SETTINGS_EOF'
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
GEMINI_SETTINGS_EOF
        echo "Created Gemini settings at ${GEMINI_SETTINGS}"
    fi

    # Install slash commands
    GEMINI_COMMANDS_DIR="$HOME/.gemini/commands"
    mkdir -p "$GEMINI_COMMANDS_DIR"

    cat > "$GEMINI_COMMANDS_DIR/plannotator-review.toml" << 'GEMINI_CMD_EOF'
description = "Open interactive code review for current changes or a PR URL"
prompt = """
## Code Review Feedback

!{plannotator review {{args}}}

## Your task

If the review above contains feedback or annotations, address them. If no changes were requested, acknowledge and continue.
"""
GEMINI_CMD_EOF

    cat > "$GEMINI_COMMANDS_DIR/plannotator-annotate.toml" << 'GEMINI_CMD_EOF'
description = "Open interactive annotation UI for a markdown file or folder"
prompt = """
## Markdown Annotations

!{plannotator annotate {{args}}}

## Your task

Address the annotation feedback above. The user has reviewed the markdown file and provided specific annotations and comments.
"""
GEMINI_CMD_EOF

    echo "Installed Gemini slash commands to ${GEMINI_COMMANDS_DIR}/"
fi

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
echo "  GEMINI CLI USERS"
echo "=========================================="
echo ""
echo "Enable plan mode in Gemini settings, then run:"
echo ""
echo "  gemini"
echo "  /plan"
echo ""
echo "Plans will open in your browser for review."
echo "If settings.json was not auto-configured, see:"
echo "  ~/.gemini/settings.json (add BeforeTool hook)"
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
