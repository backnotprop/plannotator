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
# Guided-install answers. Precedence: CLI flags > wizard (terminal, first run
# or --reconfigure) > saved prefs from a previous run > defaults (no extras,
# nothing model-invocable). Empty string = not set by a flag.
EXTRAS_FLAG=""
MODEL_INVOCABLE_FLAG=""
GLIMPSE_FLAG=""
NON_INTERACTIVE=0
RECONFIGURE=0

usage() {
    cat <<'USAGE'
Usage: install.sh [--version <tag>] [--verify-attestation | --skip-attestation]
                  [--extras | --no-extras] [--model-invocable <list>|none]
                  [--non-interactive] [--reconfigure] [--help]
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
  --extras               Install the extra skills (compound, setup-goal,
                         visual-explainer) via `npx skills add` without asking.
  --no-extras            Skip the extras without asking.
  --model-invocable <l>  Comma-separated skill names to make model-invocable
                         (e.g. plannotator-review,plannotator-compound), or
                         "none". Skills are user-invoked-only by default.
  --glimpse              Install Glimpse (glimpseui, npm -g) so Plannotator
                         opens in a native window instead of a browser tab.
  --no-glimpse           Skip the Glimpse install without asking.
  --non-interactive      Never prompt, even in a terminal. Uses flags, then
                         saved answers from a previous run, then the defaults
                         (no extras, nothing model-invocable).
  --reconfigure          Re-open the guided questions even if answers were
                         saved by a previous run.
  -h, --help             Show this help and exit.

Guided install: when run in a terminal for the first time (or with
--reconfigure), the installer asks whether to install the extra skills,
whether any skills should be callable by the model, and whether to install
Glimpse (native window). Answers are saved to <data dir>/install-prefs and
reused silently on re-runs. Piped/CI runs (no terminal) never prompt and
keep the defaults.

Provenance verification is off by default. Enable it by any of:
  - passing --verify-attestation
  - exporting PLANNOTATOR_VERIFY_ATTESTATION=1
  - setting { "verifyAttestation": true } in ~/.plannotator/config.json

Examples:
  curl -fsSL https://plannotator.ai/install.sh | bash
  curl -fsSL https://plannotator.ai/install.sh | bash -s -- --version vX.Y.Z
  curl -fsSL https://plannotator.ai/install.sh | bash -s -- --no-extras --model-invocable none
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
        --extras)
            EXTRAS_FLAG="yes"
            shift
            ;;
        --no-extras)
            EXTRAS_FLAG="no"
            shift
            ;;
        --model-invocable)
            if [ -z "${2:-}" ]; then
                echo "--model-invocable requires a comma-separated skill list or 'none'" >&2
                usage >&2
                exit 1
            fi
            MODEL_INVOCABLE_FLAG="$2"
            shift 2
            ;;
        --model-invocable=*)
            MODEL_INVOCABLE_FLAG="${1#--model-invocable=}"
            if [ -z "$MODEL_INVOCABLE_FLAG" ]; then
                echo "--model-invocable requires a comma-separated skill list or 'none'" >&2
                usage >&2
                exit 1
            fi
            shift
            ;;
        --glimpse)
            GLIMPSE_FLAG="yes"
            shift
            ;;
        --no-glimpse)
            GLIMPSE_FLAG="no"
            shift
            ;;
        --non-interactive|--yes)
            NON_INTERACTIVE=1
            shift
            ;;
        --reconfigure)
            RECONFIGURE=1
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
# Resolve the data directory, expanding ~ the same way the runtime does.
_raw_dir="${PLANNOTATOR_DATA_DIR:-}"
case "$_raw_dir" in
    "")      _config_dir="$HOME/.plannotator" ;;
    "~")     _config_dir="$HOME" ;;
    "~/"*)   _config_dir="$HOME/${_raw_dir#\~/}" ;;
    *)       _config_dir="$_raw_dir" ;;
esac
if [ -f "$_config_dir/config.json" ]; then
    if grep -q '"verifyAttestation"[[:space:]]*:[[:space:]]*true' "$_config_dir/config.json" 2>/dev/null; then
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
# Codex stores config and state under $CODEX_HOME when set, falling back to
# ~/.codex (https://developers.openai.com/codex/config-advanced).
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"

codex_home_has_user_config() {
    [ -d "$CODEX_DIR" ] || return 1
    [ -n "$(find "$CODEX_DIR" -mindepth 1 -maxdepth 1 ! -name skills ! -name .DS_Store -print -quit 2>/dev/null)" ]
}

codex_available=0
if command -v codex >/dev/null 2>&1 || codex_home_has_user_config; then
    codex_available=1
fi

kiro_available=0
if command -v kiro-cli >/dev/null 2>&1 || [ -d "$HOME/.kiro" ]; then
    kiro_available=1
fi

if [ "$codex_available" -eq 1 ]; then
    CODEX_CONFIG="$CODEX_DIR/config.toml"
    CODEX_HOOKS="$CODEX_DIR/hooks.json"
    PLANNOTATOR_BIN="${INSTALL_DIR}/plannotator"
    codex_hook_configured=0

    mkdir -p "$CODEX_DIR"

    enable_codex_hooks_config() {
        if [ ! -f "$CODEX_CONFIG" ]; then
            cat > "$CODEX_CONFIG" << 'CODEX_CONFIG_EOF'
[features]
hooks = true
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
            echo "  hooks = true"
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
                        print "hooks = true"
                        saw_hook = 1
                    }
                    in_features = ($0 ~ /^[[:space:]]*\[features\][[:space:]]*$/)
                    if (in_features) saw_features = 1
                }

                if (in_features && $0 ~ /^[[:space:]]*(codex_hooks|hooks)[[:space:]]*=/) {
                    print "hooks = true"
                    saw_hook = 1
                    next
                }

                print
            }
            END {
                if (saw_features && in_features && !saw_hook) {
                    print "hooks = true"
                } else if (!saw_features) {
                    print ""
                    print "[features]"
                    print "hooks = true"
                }
            }
        ' "$CODEX_CONFIG" > "$tmp_config"; then
            mv "$tmp_config" "$CODEX_CONFIG"
            echo "Enabled Codex hooks in ${CODEX_CONFIG}"
            return 0
        fi

        rm -f "$tmp_config"
        echo "Could not update ${CODEX_CONFIG}; add hooks manually." >&2
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
    "PreToolUse": [
      {
        "matcher": "EnterPlanMode",
        "hooks": [
          {
            "type": "command",
            "command": "plannotator improve-context",
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

update_pi_extension_if_present() {
    if ! command -v pi &>/dev/null; then
        return 0
    fi

    echo "Updating Pi extension..."
    if pi install npm:@plannotator/pi-extension; then
        echo "Pi extension updated."
    else
        echo "Skipping Pi extension update (pi install failed)"
    fi
}

# --- Aggressive cleanup of skills/commands we no longer manage ---
# Echo each removal; ignore missing entries.

# NOTE: legacy Claude command cleanup happens AFTER the skill install below —
# a command file is only removed once its replacement skill is on disk, so a
# failed or skipped skill install never leaves users with neither.

# NOTE: Codex stale-skill cleanup happens AFTER the skill install below —
# the core skills are only removed from the Codex home once their replacement
# exists in ~/.agents/skills, so an old pinned tag never strips Codex users
# of working skills without a successor.
STALE_CODEX_SKILLS_DIR="$CODEX_DIR/skills"

# Old installers (pre core/extra split) ran `cp -r apps/skills/*` against a
# new-layout tag and could leave junk `core`/`extra` directory copies in the
# Claude skills scope. Never valid skill names — always safe to remove.
for junk in core extra; do
    if [ -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/$junk" ]; then
        rm -rf "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/$junk"
        echo "Removed stale layout directory ~/.claude/skills/$junk (left by an older installer)"
    fi
done

# Extras are no longer installed by this script anywhere except Kiro. Remove
# previously default-installed copies ONCE per machine — recorded in the
# migrations ledger under the Plannotator data dir — because copies the user
# reinstalls via `npx skills add` are byte-identical to ours and can only be
# told apart by remembering that this cleanup already ran.
CLAUDE_SKILLS_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"
AGENTS_SKILLS_DIR="$HOME/.agents/skills"
MIGRATIONS_DIR="$_config_dir/migrations"
EXTRAS_MIGRATION="$MIGRATIONS_DIR/2026-06-extras-default-install-removed"
if [ ! -f "$EXTRAS_MIGRATION" ]; then
    for scope in "$CLAUDE_SKILLS_DIR" "$AGENTS_SKILLS_DIR"; do
        for skill in plannotator-compound plannotator-setup-goal plannotator-visual-explainer; do
            if [ -d "$scope/$skill" ]; then
                rm -rf "$scope/$skill"
                echo "Removed extra Plannotator skill from ${scope}/$skill (reinstall via npx skills add)"
            fi
        done
    done
    mkdir -p "$MIGRATIONS_DIR"
    : > "$EXTRAS_MIGRATION"
fi

# --- Guided install (interactive terminals only) ---
# Two questions: install the extra skills? make any skills callable by the
# model? Answers persist to $PREFS_FILE and are reused silently on re-runs.
# --reconfigure re-opens the wizard; --non-interactive forces silence; piped
# CI runs without a terminal never prompt. CLI flags win over everything.
PREFS_FILE="$_config_dir/install-prefs"
CORE_SKILL_NAMES="plannotator-review plannotator-annotate plannotator-last"
EXTRA_SKILL_NAMES="plannotator-compound plannotator-setup-goal plannotator-visual-explainer"

saved_extras=""
saved_invocable=""
saved_glimpse=""
if [ -f "$PREFS_FILE" ]; then
    saved_extras=$(sed -n 's/^extras=//p' "$PREFS_FILE" | head -1)
    saved_invocable=$(sed -n 's/^model_invocable=//p' "$PREFS_FILE" | head -1)
    saved_glimpse=$(sed -n 's/^glimpse=//p' "$PREFS_FILE" | head -1)
fi

# Extras already on disk (pre-existing or previously npx-installed)? Then the
# extras question is moot — they still count toward the checkbox list, and we
# never launch the npx flow over them.
extras_present=0
for skill in $EXTRA_SKILL_NAMES; do
    if [ -d "$CLAUDE_SKILLS_DIR/$skill" ] || [ -d "$AGENTS_SKILLS_DIR/$skill" ]; then
        extras_present=1
        break
    fi
done

# Glimpse (glimpseui) gives Plannotator a native window instead of a browser
# tab; the runtime auto-detects it on PATH, so installing it globally is all
# that's needed. Skip the question when it's already installed.
glimpse_present=0
if command -v glimpseui >/dev/null 2>&1; then
    glimpse_present=1
fi

# A wizard needs a real human at the keyboard. Piped installs (curl | bash)
# still have a terminal at /dev/tty even though stdin is the pipe; CI and
# scripts do not. Some automated contexts (docker run -t, devcontainer and
# provisioner shells) DO expose an openable /dev/tty with nobody behind it —
# opening /dev/tty succeeds, yet a read would block forever. The per-prompt
# timeout below (see PROMPT_TIMEOUT / ask_yes_no) handles that: a mis-detected
# terminal falls through to the safe non-interactive defaults (extras=no,
# model-invocable=none, glimpse=no) instead of wedging. We deliberately do NOT
# gate on $CI here — an exported CI var must not silently suppress an explicit
# --reconfigure or --extras in an otherwise interactive shell.
can_prompt=0
if [ "$NON_INTERACTIVE" -eq 0 ] && { : < /dev/tty; } 2>/dev/null; then
    can_prompt=1
fi

# Bound every interactive read so an unattended-but-open /dev/tty auto-takes
# the default rather than hanging. Set PLANNOTATOR_PROMPT_TIMEOUT=0 to wait
# indefinitely (restores the old unbounded behavior); non-numeric falls to 30.
PROMPT_TIMEOUT="${PLANNOTATOR_PROMPT_TIMEOUT:-30}"
case "$PROMPT_TIMEOUT" in
    ''|*[!0-9]*) PROMPT_TIMEOUT=30 ;;
esac

run_wizard=0
if [ "$can_prompt" -eq 1 ]; then
    if [ "$RECONFIGURE" -eq 1 ] || [ ! -f "$PREFS_FILE" ]; then
        run_wizard=1
    fi
fi

# Ask a y/n question on the terminal. $1 prompt, $2 default (yes/no).
ask_yes_no() {
    local prompt="$1" default="$2" answer suffix rc
    suffix="[y/N]"
    [ "$default" = "yes" ] && suffix="[Y/n]"
    printf '%s %s ' "$prompt" "$suffix" > /dev/tty
    # Bounded read so an unattended-but-open /dev/tty (e.g. docker run -t with
    # no human) can't hang the install. Distinguish a human pressing Enter
    # (read succeeds with an empty answer -> use the prompt's $default) from a
    # timeout/EOF with nobody there (read fails -> use the SAFE "no", never the
    # default). Otherwise a prompt whose default is "yes" (Glimpse) would
    # silently install software on an unattended terminal.
    # Keep the read in a tested context (`|| rc=$?`) so the read itself never
    # trips `set -e` (active at the top of this script), without relying on the
    # subtle rule that -e is suppressed inside a function called in a tested
    # context. ask_yes_no still returns non-zero on timeout/EOF to signal "no
    # human", so every caller consumes it with `|| wizard_timed_out=1`.
    rc=0
    if [ "$PROMPT_TIMEOUT" -gt 0 ]; then
        IFS= read -r -t "$PROMPT_TIMEOUT" answer < /dev/tty || rc=$?
    else
        IFS= read -r answer < /dev/tty || rc=$?
    fi
    if [ "$rc" -ne 0 ]; then
        printf '\n' > /dev/tty
        echo "no"
        return 1
    fi
    case "$answer" in
        y|Y|yes|YES|Yes) echo "yes" ;;
        n|N|no|NO|No)    echo "no" ;;
        *)               echo "$default" ;;
    esac
}

# Space-toggle checkbox over the skill names in $1 (space-separated), with
# the names in $2 (comma-separated) preselected. Echoes the chosen names as
# a comma list, or "none". Up/down (or j/k) moves, space toggles, enter
# confirms. All I/O goes to /dev/tty so piped stdout is unaffected.
select_skills_checkbox() {
    local names=($1) pre=",$2," idx=0 count key seq i mark cursor
    count=${#names[@]}
    local sel=()
    for ((i = 0; i < count; i++)); do
        case "$pre" in
            *",${names[$i]},"*) sel[i]=1 ;;
            *)                  sel[i]=0 ;;
        esac
    done
    printf 'Space toggles, enter confirms, up/down or j/k moves:\n' > /dev/tty
    while true; do
        for ((i = 0; i < count; i++)); do
            mark=" "; [ "${sel[$i]}" -eq 1 ] && mark="x"
            cursor="  "; [ "$i" -eq "$idx" ] && cursor="> "
            printf '%s[%s] %s\033[K\n' "$cursor" "$mark" "${names[$i]}" > /dev/tty
        done
        IFS= read -rsn1 key < /dev/tty || key=""
        if [ -z "$key" ]; then
            break # enter
        fi
        case "$key" in
            " ") sel[idx]=$((1 - sel[idx])) ;;
            j)   [ "$idx" -lt $((count - 1)) ] && idx=$((idx + 1)) ;;
            k)   [ "$idx" -gt 0 ] && idx=$((idx - 1)) ;;
            $'\x1b')
                seq=""
                IFS= read -rsn2 -t 1 seq < /dev/tty || seq=""
                case "$seq" in
                    '[A') [ "$idx" -gt 0 ] && idx=$((idx - 1)) ;;
                    '[B') [ "$idx" -lt $((count - 1)) ] && idx=$((idx + 1)) ;;
                esac
                ;;
        esac
        printf '\033[%dA' "$count" > /dev/tty
    done
    local out=""
    for ((i = 0; i < count; i++)); do
        if [ "${sel[$i]}" -eq 1 ]; then
            [ -n "$out" ] && out="$out,"
            out="$out${names[$i]}"
        fi
    done
    echo "${out:-none}"
}

extras_choice=""
invocable_choice=""
glimpse_choice=""
# Set if any wizard prompt times out / hits EOF (no human answered). A run whose
# answers are synthetic timeout fallbacks must not be persisted as install-prefs.
wizard_timed_out=0

if [ "$run_wizard" -eq 1 ]; then
    {
        echo ""
        echo "=========================================="
        echo "  PLANNOTATOR GUIDED INSTALL"
        echo "=========================================="
        echo ""
    } > /dev/tty
    if [ "$extras_present" -eq 1 ]; then
        echo "Extra skills already installed — keeping them." > /dev/tty
        extras_choice="yes"
    elif [ -n "$EXTRAS_FLAG" ]; then
        # Flag already answered this question — don't ask and then ignore.
        extras_choice="$EXTRAS_FLAG"
    else
        extras_choice=$(ask_yes_no "Install the extra skills (compound planning, setup-goal, visual explainer)?" "${saved_extras:-no}") || wizard_timed_out=1
    fi
    invocable_list="$CORE_SKILL_NAMES"
    if [ "$extras_choice" = "yes" ]; then
        invocable_list="$CORE_SKILL_NAMES $EXTRA_SKILL_NAMES"
    fi
    if [ -n "$MODEL_INVOCABLE_FLAG" ]; then
        # Flag already answered this question — don't ask and then ignore.
        invocable_choice="$MODEL_INVOCABLE_FLAG"
    else
        want_invocable=$(ask_yes_no "Make any skills callable by the model (instead of user-invoked only)?" "no") || wizard_timed_out=1
        if [ "$want_invocable" = "yes" ]; then
            invocable_choice=$(select_skills_checkbox "$invocable_list" "$saved_invocable")
        else
            invocable_choice="none"
        fi
    fi
    if [ "$glimpse_present" -eq 1 ]; then
        echo "Glimpse already installed — Plannotator will open in its native window." > /dev/tty
        glimpse_choice="yes"
    elif [ -n "$GLIMPSE_FLAG" ]; then
        # Flag already answered this question — don't ask and then ignore.
        glimpse_choice="$GLIMPSE_FLAG"
    else
        glimpse_choice=$(ask_yes_no "Install Glimpse so Plannotator opens in a native window instead of a browser tab? (npm i -g glimpseui)" "${saved_glimpse:-yes}") || wizard_timed_out=1
    fi
fi

# Flags override the wizard and saved answers; otherwise saved, then defaults.
[ -n "$EXTRAS_FLAG" ] && extras_choice="$EXTRAS_FLAG"
[ -n "$MODEL_INVOCABLE_FLAG" ] && invocable_choice="$MODEL_INVOCABLE_FLAG"
[ -n "$GLIMPSE_FLAG" ] && glimpse_choice="$GLIMPSE_FLAG"
[ -z "$extras_choice" ] && extras_choice="${saved_extras:-no}"
[ -z "$invocable_choice" ] && invocable_choice="${saved_invocable:-none}"
[ -z "$glimpse_choice" ] && glimpse_choice="${saved_glimpse:-no}"

# Persist only when the wizard ran with real answers, or a flag set something.
# Silent re-runs must not clobber saved answers with defaults, and a wizard that
# timed out to synthetic fallbacks (unattended /dev/tty) must not become sticky
# prefs that suppress the wizard on a later genuine interactive install.
if [ "$wizard_timed_out" -eq 0 ] && { [ "$run_wizard" -eq 1 ] || [ -n "$EXTRAS_FLAG" ] || [ -n "$MODEL_INVOCABLE_FLAG" ] || [ -n "$GLIMPSE_FLAG" ]; }; then
    mkdir -p "$_config_dir"
    {
        echo "extras=$extras_choice"
        echo "model_invocable=$invocable_choice"
        echo "glimpse=$glimpse_choice"
    } > "$PREFS_FILE"
fi

# Glimpse install (global npm package; the runtime auto-detects it on PATH).
# Wizard or explicit flag only — silent re-runs never install software.
if [ "$glimpse_choice" = "yes" ] && [ "$glimpse_present" -eq 0 ]; then
    if [ "$run_wizard" -eq 1 ] || [ -n "$GLIMPSE_FLAG" ]; then
        if command -v npm >/dev/null 2>&1; then
            echo "Installing Glimpse (npm install -g glimpseui)..."
            npm install -g glimpseui || echo "Glimpse install failed — install later with: npm install -g glimpseui"
        elif command -v bun >/dev/null 2>&1; then
            echo "Installing Glimpse (bun install -g glimpseui)..."
            bun install -g glimpseui || echo "Glimpse install failed — install later with: bun install -g glimpseui"
        else
            echo "npm/bun not found — install Node.js, then: npm install -g glimpseui"
        fi
    fi
fi

# Extras install is delegated to the skills CLI (its UI picks the agents).
# Interactive only — the CLI needs the keyboard, so silent runs and CI get
# the printed command instead. Never runs when the extras already exist.
if [ "$extras_choice" = "yes" ] && [ "$extras_present" -eq 0 ]; then
    if [ "$can_prompt" -eq 1 ] && command -v npx >/dev/null 2>&1; then
        echo "Launching the skills CLI for the extras (pick your agents in its UI)..."
        npx skills add backnotprop/plannotator/apps/skills/extra < /dev/tty || \
            echo "skills CLI did not complete — install later with: npx skills add backnotprop/plannotator/apps/skills/extra"
    else
        echo "Install the extras with: npx skills add backnotprop/plannotator/apps/skills/extra"
    fi
fi

# Install skills and slash commands from a sparse checkout (requires git).
# Hard requirement: without git we cannot install the /plannotator-* skills,
# so fail loudly instead of leaving a partial install. Hook/config writing
# above has already run by this point; the Pi update and Gemini config below
# are skipped on failure and complete when the user re-runs the installer.
if ! command -v git &>/dev/null; then
    echo "Error: git is required to install Plannotator's skills and slash commands." >&2
    echo "Install git, then run this installer again." >&2
    exit 1
fi

KIRO_SKILLS_DIR="$HOME/.kiro/skills"
OPENCODE_COMMANDS_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/commands"
GEMINI_COMMANDS_DIR="$HOME/.gemini/commands"
skills_tmp=$(mktemp -d)

copy_skill_if_present() {
    local source_dir="$1"
    local target_dir="$2"

    if [ -d "$source_dir" ]; then
        # Remove any existing copy first so re-runs replace rather than
        # nest (cp -r dir dest/dir would otherwise create dest/dir/dir).
        rm -rf "$target_dir/$(basename "$source_dir")"
        cp -r "$source_dir" "$target_dir/"
    fi
}

# Copy every command file in a directory if the source dir exists.
# Used for OpenCode (.md stubs) and Gemini (.toml) commands, both of
# which are checked out from the repo rather than generated by heredocs.
copy_commands_if_present() {
    local source_dir="$1"
    local target_dir="$2"

    if [ -d "$source_dir" ] && [ -n "$(ls -A "$source_dir" 2>/dev/null)" ]; then
        mkdir -p "$target_dir"
        cp "$source_dir"/* "$target_dir/"
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
checkout_failed=0
(
    set -e
    cd "$skills_tmp"
    git clone --depth 1 --filter=blob:none --sparse \
        "https://github.com/${REPO}.git" --branch "$latest_tag" repo 2>/dev/null
    cd repo
    git sparse-checkout set apps/skills apps/kiro-cli apps/opencode-plugin/commands apps/gemini/commands 2>/dev/null

    # Core skills -> Claude Code (also serve as /plannotator-* slash commands)
    # and the official OpenAI shared-agent path. SOFT guard: a tag pinned
    # via --version may predate the core/extra layout — skip core skills
    # but keep installing the command files below (matches install.ps1 and
    # install.cmd, which guard each block independently).
    # Claude Code and Codex consume different skill bodies. Claude Code reads
    # the apps/skills/claude/* copies, which use dynamic-context injection
    # (`!`plannotator … $ARGUMENTS``) + allowed-tools so /plannotator-* run the
    # binary directly with no permission prompt — matching the old slash
    # commands. Codex (the OpenAI shared-agent path) reads apps/skills/core/*,
    # whose prose bodies the model follows via its own shell; the `!`…``
    # injection is a Claude-Code-only extension, so the two are sourced
    # separately rather than sharing one body.
    if [ -d "apps/skills/claude" ] && [ -n "$(ls -A apps/skills/claude 2>/dev/null)" ]; then
        mkdir -p "$CLAUDE_SKILLS_DIR"
        copy_skill_if_present apps/skills/claude/plannotator-review "$CLAUDE_SKILLS_DIR"
        copy_skill_if_present apps/skills/claude/plannotator-annotate "$CLAUDE_SKILLS_DIR"
        copy_skill_if_present apps/skills/claude/plannotator-last "$CLAUDE_SKILLS_DIR"
        echo "Installed Claude Code skills to ${CLAUDE_SKILLS_DIR}/"
    else
        echo "Tag ${latest_tag} predates the per-agent skill layout — skipping Claude Code skill install"
    fi
    if [ -d "apps/skills/core" ] && [ -n "$(ls -A apps/skills/core 2>/dev/null)" ]; then
        mkdir -p "$AGENTS_SKILLS_DIR"
        copy_skill_if_present apps/skills/core/plannotator-review "$AGENTS_SKILLS_DIR"
        copy_skill_if_present apps/skills/core/plannotator-annotate "$AGENTS_SKILLS_DIR"
        copy_skill_if_present apps/skills/core/plannotator-last "$AGENTS_SKILLS_DIR"
        echo "Installed shared agent skills to ${AGENTS_SKILLS_DIR}/"
    else
        echo "Tag ${latest_tag} predates the core/extra skill layout — skipping shared agent skill install"
    fi

    # OpenCode slash command stubs (the plugin intercepts execution) —
    # always installed when the checkout provides them. Guard the echo on
    # the same condition as the copy so old pinned tags don't report a
    # success that never happened (ps1/cmd already gate this way).
    if [ -d "apps/opencode-plugin/commands" ] && [ -n "$(ls -A apps/opencode-plugin/commands 2>/dev/null)" ]; then
        copy_commands_if_present apps/opencode-plugin/commands "$OPENCODE_COMMANDS_DIR"
        echo "Installed OpenCode commands to ${OPENCODE_COMMANDS_DIR}/"
    fi

    # Gemini native TOML commands — only when Gemini is present.
    if [ -d "$HOME/.gemini" ] && [ -d "apps/gemini/commands" ] && [ -n "$(ls -A apps/gemini/commands 2>/dev/null)" ]; then
        copy_commands_if_present apps/gemini/commands "$GEMINI_COMMANDS_DIR"
        echo "Installed Gemini commands to ${GEMINI_COMMANDS_DIR}/"
    fi

    if [ "$kiro_available" -eq 1 ] && [ -d "apps/kiro-cli/skills" ] && [ -n "$(ls -A apps/kiro-cli/skills 2>/dev/null)" ]; then
        mkdir -p "$KIRO_SKILLS_DIR"
        # Kiro-specific skills (origin baked in) come from apps/kiro-cli/skills.
        copy_skill_if_present apps/kiro-cli/skills/plannotator-review "$KIRO_SKILLS_DIR"
        copy_skill_if_present apps/kiro-cli/skills/plannotator-annotate "$KIRO_SKILLS_DIR"
        # Extras come from apps/skills/extra (not duplicated into apps/kiro-cli/skills).
        copy_skill_if_present apps/skills/extra/plannotator-setup-goal "$KIRO_SKILLS_DIR"
        copy_skill_if_present apps/skills/extra/plannotator-visual-explainer "$KIRO_SKILLS_DIR"
        # Plannotator custom agent — don't clobber a user's existing one.
        if [ ! -f "$HOME/.kiro/agents/plannotator.json" ] && [ -f "apps/kiro-cli/agents/plannotator.json" ]; then
            mkdir -p "$HOME/.kiro/agents"
            cp apps/kiro-cli/agents/plannotator.json "$HOME/.kiro/agents/plannotator.json"
        fi
        echo "Installed Kiro skills to ${KIRO_SKILLS_DIR}/ and agent to ~/.kiro/agents/plannotator.json"
    fi
) || checkout_failed=1

rm -rf "$skills_tmp"

if [ "${checkout_failed:-0}" -eq 1 ]; then
    echo "Error: unable to fetch ${REPO} at ${latest_tag} (network or git error)." >&2
    echo "Something went wrong — run the installer again." >&2
    exit 1
fi

# Claude Code commands are deprecated in favor of skills. Remove a legacy
# command file only once its replacement skill is actually on disk — running
# AFTER the install above guarantees a failed or skipped skill install never
# leaves users with neither the command nor the skill.
CLAUDE_COMMANDS_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/commands"
for cmd in plannotator-review plannotator-annotate plannotator-last; do
    if [ -d "$CLAUDE_SKILLS_DIR/$cmd" ] && [ -f "$CLAUDE_COMMANDS_DIR/$cmd.md" ]; then
        rm -f "$CLAUDE_COMMANDS_DIR/$cmd.md"
        echo "Removed legacy Claude command ${CLAUDE_COMMANDS_DIR}/$cmd.md (replaced by the $cmd skill)"
    fi
done

# plannotator-archive no longer ships as a skill. Remove any stale installed
# copy from every skill scope so upgraders don't keep a dead skill around.
for scope in "$CLAUDE_SKILLS_DIR" "$AGENTS_SKILLS_DIR" "$KIRO_SKILLS_DIR"; do
    if [ -d "$scope/plannotator-archive" ]; then
        rm -rf "$scope/plannotator-archive"
        echo "Removed stale plannotator-archive skill from ${scope}/plannotator-archive"
    fi
done

# Codex no longer hosts core skills (they now live in ~/.agents/skills).
# Core skills are removed only once their replacement exists; the stale
# shared-agent extras were never Codex's and are removed unconditionally.
for skill in plannotator-review plannotator-annotate plannotator-last plannotator-compound plannotator-setup-goal; do
    if [ -d "$STALE_CODEX_SKILLS_DIR/$skill" ]; then
        case "$skill" in
            plannotator-review|plannotator-annotate|plannotator-last)
                [ -d "$AGENTS_SKILLS_DIR/$skill" ] || continue
                ;;
        esac
        rm -rf "$STALE_CODEX_SKILLS_DIR/$skill"
        echo "Removed Plannotator skill from ${STALE_CODEX_SKILLS_DIR}/$skill"
    fi
done

# Apply the saved model-invocation choices. Installed skill copies always
# arrive locked (disable-model-invocation: true in SKILL.md); for each chosen
# skill we unlock the INSTALLED copy by removing that line, and flip the Codex
# sidecar's allow_implicit_invocation to match. Re-applied on every run
# because installs replace the skill folders wholesale. Source files in the
# repo never change.
if [ -n "$invocable_choice" ] && [ "$invocable_choice" != "none" ]; then
    for skill in $(echo "$invocable_choice" | tr ',' ' '); do
        for scope in "$CLAUDE_SKILLS_DIR" "$AGENTS_SKILLS_DIR"; do
            skill_md="$scope/$skill/SKILL.md"
            if [ -f "$skill_md" ] && grep -q '^disable-model-invocation: true$' "$skill_md"; then
                grep -v '^disable-model-invocation: true$' "$skill_md" > "$skill_md.tmp" && mv "$skill_md.tmp" "$skill_md"
                echo "Enabled model invocation: ${scope}/${skill}"
            fi
            sidecar="$scope/$skill/agents/openai.yaml"
            if [ -f "$sidecar" ] && grep -q 'allow_implicit_invocation: false' "$sidecar"; then
                sed 's/allow_implicit_invocation: false/allow_implicit_invocation: true/' "$sidecar" > "$sidecar.tmp" && mv "$sidecar.tmp" "$sidecar"
            fi
        done
    done
fi

# Update Pi extension if pi is installed. The pi-extension no longer bundles
# skills; Pi keeps its extension commands and the plannotator_submit_plan tool.
update_pi_extension_if_present

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

    # Gemini slash commands (.toml) are installed from the sparse checkout in
    # the skills/commands install block above (apps/gemini/commands).
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
echo "  CODEX USERS"
echo "=========================================="
echo ""
if [ "$codex_available" -eq 1 ]; then
    echo "Restart Codex Desktop or CLI after installing."
    echo "Plan review is configured through the Codex Stop hook."
    echo ""
    echo "Core skills are installed to ~/.agents/skills/:"
    echo "  \$plannotator-review"
    echo "  \$plannotator-annotate <file|url|folder>"
    echo "  \$plannotator-last"
else
    echo "Codex was not detected. After installing Codex, rerun this installer to add"
    echo "the Stop hook."
fi
echo ""
echo "=========================================="
echo "  KIRO CLI USERS"
echo "=========================================="
echo ""
if [ "$kiro_available" -eq 1 ]; then
    echo "Kiro skills are installed to ~/.kiro/skills/"
    echo "The Plannotator agent is installed to ~/.kiro/agents/plannotator.json"
    echo "Launch it: kiro-cli chat --agent plannotator"
else
    echo "Kiro was not detected. After installing Kiro, rerun this installer to add Kiro skills."
fi
echo ""
echo "=========================================="
echo "  CLAUDE CODE USERS: YOU'RE ALL SET!"
echo "=========================================="
echo ""
echo "Install the Claude Code plugin:"
echo "  /plugin marketplace add backnotprop/plannotator"
echo "  /plugin install plannotator@plannotator"
echo ""
echo "Upgrading from an older version? Also run /plugin marketplace update"
echo "so the plugin drops its old plannotator:* command entries."
echo ""
echo "The /plannotator-review, /plannotator-annotate, and /plannotator-last commands are ready to use after you restart Claude Code!"

if [ "$extras_choice" != "yes" ]; then
    echo ""
    echo "Optional skills (compound planning, setup-goal, visual explainer):"
    echo "  npx skills add backnotprop/plannotator/apps/skills/extra"
fi

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
