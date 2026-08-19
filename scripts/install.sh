#!/bin/bash
set -e

REPO="backnotprop/plannotator"
SEM_REPO="Ataraxy-Labs/sem"
SEM_VERSION="v0.8.0"
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
# Three-layer opt-in for the CallDiff call-flow runtime (large on-disk
# footprint, default off). The normal path installs it in-app from the review
# UI; this flag exists for scripted installs.
# Precedence: --with-call-flow > PLANNOTATOR_INSTALL_CALLDIFF > config.json
# installCallFlow > default (off).
WITH_CALL_FLOW_FLAG=-1
# Guided-install answers. Precedence: CLI flags > wizard (terminal, first run
# or --reconfigure) > saved prefs from a previous run > defaults (no extras,
# nothing model-invocable). Empty string = not set by a flag.
EXTRAS_FLAG=""
MODEL_INVOCABLE_FLAG=""
NON_INTERACTIVE=0
RECONFIGURE=0
# Binary-only mode. Installs just the plannotator binary (to $INSTALL_DIR) and
# no persistent state elsewhere — no sem sidecar, no CallDiff or agent-terminal runtime, no
# skills, hooks, slash commands, or per-agent config (Claude, Codex, OpenCode,
# Gemini, Kiro). Set by --minimal (1) / --no-minimal (0); -1 = neither flag
# given (fall through to the PLANNOTATOR_MINIMAL env var). Resolved after arg
# parsing so a flag overrides the env var in either direction.
MINIMAL_FLAG=-1
# Per-agent integration opt-outs (#1178). Skip means do-not-write: when a
# skipped agent is detected, the installer reports "detected, skipped" and
# writes nothing to that agent's home; it never removes an integration a
# previous install already wired. 1 = flag passed. Resolution (flag > env >
# config skipInstall.<agent> > default off) happens after _config_dir is known.
SKIP_CODEX_FLAG=0
SKIP_GEMINI_FLAG=0
SKIP_KIRO_FLAG=0
SKIP_OPENCODE_FLAG=0
# Same shape, but scoped to the skills/slash-command sparse checkout rather
# than one agent's home: --skip-skills turns the whole fetch into a no-op for
# every scope it writes (Claude, ~/.agents, OpenCode, Gemini, Kiro), including
# the extras and the skill-scope cleanup sweeps. Needed by any environment that
# cannot reach github.com for the tag being installed — the release smoke test
# installs a synthetic v9.9.9 whose tag has no GitHub counterpart.
SKIP_SKILLS_FLAG=0

usage() {
    cat <<'USAGE'
Usage: install.sh [--version <tag>] [--verify-attestation | --skip-attestation]
                  [--extras | --no-extras] [--model-invocable <list>|none]
                  [--minimal | --no-minimal] [--skip-codex] [--skip-gemini]
                  [--skip-kiro] [--skip-opencode] [--skip-skills]
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
  --with-call-flow       Also install the optional pruned CallDiff core
                         (about 5 MB on macOS arm64, needs Node.js 22+).
                         By default it is NOT installed; the review UI offers
                         a one-click install when Call flow is enabled. Also
                         enabled by PLANNOTATOR_INSTALL_CALLDIFF=1 or
                         { "installCallFlow": true } in config.json.
  --extras               Install the extra skills (compound, setup-goal,
                         visual-explainer) via `npx skills add` without asking.
  --no-extras            Skip the extras without asking.
  --model-invocable <l>  Comma-separated skill names to make model-invocable
                         (e.g. plannotator-review,plannotator-compound), or
                         "none". Skills are user-invoked-only by default.
  --minimal              Install only the plannotator binary (aliased
                         --binary-only). Skips the sem semantic-diff sidecar,
                         the CallDiff runtime, the agent-terminal runtime, and every per-agent
                         integration (skills, hooks, slash commands, and config
                         for Claude, Codex, OpenCode, Gemini, and Kiro). No
                         persistent state is written outside $HOME/.local/bin
                         (a temp download file is still used and removed). Also
                         enabled by exporting PLANNOTATOR_MINIMAL=1.
  --no-minimal           Force a full install even when PLANNOTATOR_MINIMAL is
                         set in the environment.
  --skip-codex           Do not write the Codex integration (hooks.json /
                         config.toml under CODEX_HOME) even when Codex is
                         detected. Never removes an existing integration.
                         Also enabled by PLANNOTATOR_SKIP_CODEX_INSTALL=1 or
                         { "skipInstall": { "codex": true } } in
                         ~/.plannotator/config.json (flag > env var > config).
  --skip-gemini          Same opt-out for the Gemini CLI integration
                         (~/.gemini policy, settings hook, commands). Env var:
                         PLANNOTATOR_SKIP_GEMINI_INSTALL; config key:
                         skipInstall.gemini.
  --skip-kiro            Same opt-out for the Kiro CLI integration
                         (~/.kiro skills and agent). Env var:
                         PLANNOTATOR_SKIP_KIRO_INSTALL; config key:
                         skipInstall.kiro.
  --skip-opencode        Do not write the OpenCode integration (command stubs
                         under ~/.config/opencode/commands and the OpenCode
                         plugin cache clear). OpenCode has no detection leg,
                         so this is a plain do-not-write switch. Env var:
                         PLANNOTATOR_SKIP_OPENCODE_INSTALL; config key:
                         skipInstall.opencode.
  --skip-skills          Do not fetch or write the /plannotator-* skills and
                         slash commands (the sparse checkout that feeds Claude
                         Code, ~/.agents, OpenCode, Gemini, and Kiro), the
                         extras, or the skill-scope cleanup sweeps. Nothing
                         already installed is removed. The binary, hooks, and
                         per-agent config still install. Use it where
                         github.com cannot serve the tag being installed. Env
                         var: PLANNOTATOR_SKIP_SKILLS_INSTALL; config key:
                         skipInstall.skills.
  --non-interactive      Never prompt, even in a terminal. Uses flags, then
                         saved answers from a previous run, then the defaults
                         (no extras, nothing model-invocable).
  --reconfigure          Re-open the guided questions even if answers were
                         saved by a previous run.
  -h, --help             Show this help and exit.

Guided install: when run in a terminal for the first time (or with
--reconfigure), the installer asks whether to install the extra skills and
whether any skills should be callable by the model. Answers are saved to
<data dir>/install-prefs and
reused silently on re-runs. Piped/CI runs (no terminal) never prompt and
keep the defaults.

Provenance verification is off by default. Enable it by any of:
  - passing --verify-attestation
  - exporting PLANNOTATOR_VERIFY_ATTESTATION=1
  - setting { "verifyAttestation": true } in ~/.plannotator/config.json
When enabled, the attestation bundle is fetched from GitHub's public
attestations API and verified with `gh attestation verify --bundle`, so no
gh login is required. The credential-free path needs one JSON tool on PATH
(node, python3, or jq) to extract the bundle; without one, and whenever the
public bundle fetch or bundle verification does not complete, gh's
authenticated fetch runs as the fallback.

The optional semantic-diff sidecar (the 'sem' binary, used by code review) is
installed after Plannotator itself. Skip it by exporting
PLANNOTATOR_SKIP_SEM_INSTALL=1. Its download is time-bounded, so a slow network
never blocks an otherwise-complete install.

The optional annotate agent terminal runtime is installed after Plannotator
itself. Skip it by exporting PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL=1. If
Node/npm is unavailable, Plannotator still installs and annotate mode works
without the integrated terminal.

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
        --with-call-flow)
            WITH_CALL_FLOW_FLAG=1
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
        --non-interactive|--yes)
            NON_INTERACTIVE=1
            shift
            ;;
        --reconfigure)
            RECONFIGURE=1
            shift
            ;;
        --minimal|--binary-only)
            if [ "$MINIMAL_FLAG" = "0" ]; then
                echo "--minimal and --no-minimal are mutually exclusive" >&2
                usage >&2
                exit 1
            fi
            MINIMAL_FLAG=1
            shift
            ;;
        --no-minimal)
            if [ "$MINIMAL_FLAG" = "1" ]; then
                echo "--no-minimal and --minimal are mutually exclusive" >&2
                usage >&2
                exit 1
            fi
            MINIMAL_FLAG=0
            shift
            ;;
        --skip-codex)
            SKIP_CODEX_FLAG=1
            shift
            ;;
        --skip-gemini)
            SKIP_GEMINI_FLAG=1
            shift
            ;;
        --skip-kiro)
            SKIP_KIRO_FLAG=1
            shift
            ;;
        --skip-opencode)
            SKIP_OPENCODE_FLAG=1
            shift
            ;;
        --skip-skills)
            SKIP_SKILLS_FLAG=1
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

# Resolve binary-only mode. Precedence: --minimal / --no-minimal flag >
# PLANNOTATOR_MINIMAL env var > default (off). The env var lets `curl ... | bash`
# runs opt in without a flag, matching how PLANNOTATOR_SKIP_SEM_INSTALL et al.
# work; --no-minimal lets a flag override an env var that enables it.
minimal=0
case "${PLANNOTATOR_MINIMAL:-}" in
    1|true|yes|TRUE|YES|True|Yes) minimal=1 ;;
esac
if [ "$MINIMAL_FLAG" -ne -1 ]; then
    minimal="$MINIMAL_FLAG"
fi

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

    # api.github.com caps unauthenticated requests at 60/hour per source IP,
    # which fails installs behind shared egress IPs (NAT/CGNAT/corporate
    # proxies) and during repeated/debug runs within an hour. Attach an
    # Authorization header when a token is available (raises the limit to
    # 5000/hour); when none is found, fall back to anonymous (unchanged
    # behavior). Precedence matches `gh`: GITHUB_TOKEN > GH_TOKEN > gh auth token.
    GH_AUTH_HEADER=()
    if [ -n "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ]; then
        GH_AUTH_HEADER=(-H "Authorization: Bearer ${GITHUB_TOKEN:-${GH_TOKEN}}")
    elif command -v gh >/dev/null 2>&1; then
        # --hostname github.com scopes the fallback to github.com credentials,
        # so a gh setup whose default host is a GitHub Enterprise server never
        # leaks a GHES token to api.github.com. On an ancient gh without the
        # flag, stderr is swallowed and we fall back to anonymous.
        if _gh_token="$(gh auth token --hostname github.com 2>/dev/null)" && [ -n "$_gh_token" ]; then
            GH_AUTH_HEADER=(-H "Authorization: Bearer ${_gh_token}")
        fi
    fi
    # A stale/revoked token (expired GITHUB_TOKEN lingering in CI images,
    # dotfiles, direnv) gets a 401 here and would break an install that
    # works fine anonymously today. Retry anonymously ONLY on HTTP 401:
    # requests carrying invalid credentials count against the anonymous
    # 60/hour per-IP pool, so a blind retry on any failure would double the
    # burn, and network failures gain nothing from a second attempt.
    # Note: no -f here, so a 401 body doesn't abort curl before -w prints
    # the status code. See backnotprop/plannotator#1157.
    _api_url="https://api.github.com/repos/${REPO}/releases/latest"
    _api_body=$(curl -sSL -w '\n%{http_code}' "${GH_AUTH_HEADER[@]}" "$_api_url" 2>/dev/null) || true
    _api_code="${_api_body##*$'\n'}"
    if [ "$_api_code" = "401" ] && [ ${#GH_AUTH_HEADER[@]} -gt 0 ]; then
        _api_body=$(curl -sSL -w '\n%{http_code}' "$_api_url" 2>/dev/null) || true
        _api_code="${_api_body##*$'\n'}"
    fi
    if [ "$_api_code" = "200" ]; then
        latest_tag=$(printf '%s' "$_api_body" | grep '"tag_name"' | cut -d'"' -f4)
    else
        latest_tag=""
    fi
    # Drop the local token copies; GITHUB_TOKEN / GH_TOKEN themselves remain
    # in the environment exactly as the user set them.
    unset _gh_token GH_AUTH_HEADER _api_url _api_body _api_code

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
# Unset: an existing ~/.plannotator (legacy default) always wins; otherwise
# an explicitly-set absolute XDG_DATA_HOME places it at
# $XDG_DATA_HOME/plannotator; otherwise ~/.plannotator.
_raw_dir="${PLANNOTATOR_DATA_DIR:-}"
case "$_raw_dir" in
    "")
        _config_dir="$HOME/.plannotator"
        if [ ! -d "$_config_dir" ]; then
            case "${XDG_DATA_HOME:-}" in
                /*) _config_dir="$XDG_DATA_HOME/plannotator" ;;
            esac
        fi
        ;;
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

# Resolve the CallDiff call-flow runtime opt-in. Same three-layer shape as
# verifyAttestation: CLI flag > env var > config.json > default (off). The
# config grep targets a flat top-level boolean, matching verifyAttestation.
install_call_flow=0
if [ -f "$_config_dir/config.json" ]; then
    if grep -q '"installCallFlow"[[:space:]]*:[[:space:]]*true' "$_config_dir/config.json" 2>/dev/null; then
        install_call_flow=1
    fi
fi
case "${PLANNOTATOR_INSTALL_CALLDIFF:-}" in
    1|true|yes|TRUE|YES|True|Yes) install_call_flow=1 ;;
    0|false|no|FALSE|NO|False|No) install_call_flow=0 ;;
esac
if [ "$WITH_CALL_FLOW_FLAG" -ne -1 ]; then
    install_call_flow="$WITH_CALL_FLOW_FLAG"
fi

# Resolve the per-agent integration opt-outs (#1178). Same three-layer shape
# as verifyAttestation: CLI flag > env var > config.json > default (off).
# The config layer first extracts JUST the skipInstall object (from the
# first "{" after the "skipInstall" key to its first "}" — the object is a
# flat map of booleans, so the first closing brace ends it) and matches
# per-agent keys only inside that region. This keeps a "codex": true under
# some OTHER key from opting anyone out (M2), works whether the JSON is
# pretty-printed or single-line, and an explicit `"codex": false` inside
# skipInstall is honored as a veto rather than being ignored. Each resolved
# skip remembers its source so the detected-but-skipped report can name
# what the user set.
skip_codex=0
skip_codex_source=""
skip_gemini=0
skip_gemini_source=""
skip_kiro=0
skip_kiro_source=""
skip_opencode=0
skip_opencode_source=""
# skipInstall.skills is not an agent — it opts out of the skills/slash-command
# checkout for every scope at once — but it shares the same three layers and
# the same key region, so it rides along in the loop below.
skip_skills=0
skip_skills_source=""
_skip_install_block=""
if [ -f "$_config_dir/config.json" ]; then
    _skip_install_block=$(awk '
        { buf = buf $0 "\n" }
        END {
            # Token check: the key must be followed by optional whitespace,
            # a colon, and the object brace - so a STRING VALUE that merely
            # contains "skipInstall" cannot anchor the extraction. Non-token
            # occurrences are skipped and the scan continues.
            pos = 1
            while (1) {
                i = index(substr(buf, pos), "\"skipInstall\"")
                if (i == 0) exit
                i = pos + i - 1
                rest = substr(buf, i + 13)
                if (match(rest, /^[ \t\r\n]*:[ \t\r\n]*\{/) != 0) {
                    rest = substr(rest, RLENGTH)
                    k = index(rest, "}")
                    if (k == 0) exit
                    print substr(rest, 1, k)
                    exit
                }
                pos = i + 13
            }
        }' "$_config_dir/config.json" 2>/dev/null) || _skip_install_block=""
fi
if [ -n "$_skip_install_block" ]; then
    for _agent in codex gemini kiro opencode skills; do
        if printf '%s' "$_skip_install_block" | grep -q "\"$_agent\"[[:space:]]*:[[:space:]]*false"; then
            continue # explicit false is a veto, never a skip
        fi
        if printf '%s' "$_skip_install_block" | grep -q "\"$_agent\"[[:space:]]*:[[:space:]]*true"; then
            case "$_agent" in
                codex)
                    skip_codex=1
                    skip_codex_source="config skipInstall.codex"
                    ;;
                gemini)
                    skip_gemini=1
                    skip_gemini_source="config skipInstall.gemini"
                    ;;
                kiro)
                    skip_kiro=1
                    skip_kiro_source="config skipInstall.kiro"
                    ;;
                opencode)
                    skip_opencode=1
                    skip_opencode_source="config skipInstall.opencode"
                    ;;
                skills)
                    skip_skills=1
                    skip_skills_source="config skipInstall.skills"
                    ;;
            esac
        fi
    done
    unset _agent
fi
unset _skip_install_block
case "${PLANNOTATOR_SKIP_CODEX_INSTALL:-}" in
    1|true|yes|TRUE|YES|True|Yes)
        skip_codex=1
        skip_codex_source="PLANNOTATOR_SKIP_CODEX_INSTALL"
        ;;
    0|false|no|FALSE|NO|False|No)
        skip_codex=0
        skip_codex_source=""
        ;;
esac
case "${PLANNOTATOR_SKIP_GEMINI_INSTALL:-}" in
    1|true|yes|TRUE|YES|True|Yes)
        skip_gemini=1
        skip_gemini_source="PLANNOTATOR_SKIP_GEMINI_INSTALL"
        ;;
    0|false|no|FALSE|NO|False|No)
        skip_gemini=0
        skip_gemini_source=""
        ;;
esac
case "${PLANNOTATOR_SKIP_KIRO_INSTALL:-}" in
    1|true|yes|TRUE|YES|True|Yes)
        skip_kiro=1
        skip_kiro_source="PLANNOTATOR_SKIP_KIRO_INSTALL"
        ;;
    0|false|no|FALSE|NO|False|No)
        skip_kiro=0
        skip_kiro_source=""
        ;;
esac
case "${PLANNOTATOR_SKIP_OPENCODE_INSTALL:-}" in
    1|true|yes|TRUE|YES|True|Yes)
        skip_opencode=1
        skip_opencode_source="PLANNOTATOR_SKIP_OPENCODE_INSTALL"
        ;;
    0|false|no|FALSE|NO|False|No)
        skip_opencode=0
        skip_opencode_source=""
        ;;
esac
case "${PLANNOTATOR_SKIP_SKILLS_INSTALL:-}" in
    1|true|yes|TRUE|YES|True|Yes)
        skip_skills=1
        skip_skills_source="PLANNOTATOR_SKIP_SKILLS_INSTALL"
        ;;
    0|false|no|FALSE|NO|False|No)
        skip_skills=0
        skip_skills_source=""
        ;;
esac
if [ "$SKIP_CODEX_FLAG" -eq 1 ]; then
    skip_codex=1
    skip_codex_source="--skip-codex"
fi
if [ "$SKIP_GEMINI_FLAG" -eq 1 ]; then
    skip_gemini=1
    skip_gemini_source="--skip-gemini"
fi
if [ "$SKIP_KIRO_FLAG" -eq 1 ]; then
    skip_kiro=1
    skip_kiro_source="--skip-kiro"
fi
if [ "$SKIP_OPENCODE_FLAG" -eq 1 ]; then
    skip_opencode=1
    skip_opencode_source="--skip-opencode"
fi
if [ "$SKIP_SKILLS_FLAG" -eq 1 ]; then
    skip_skills=1
    skip_skills_source="--skip-skills"
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
        # Credential-free path first (#1178): the attestations endpoint on
        # api.github.com is world-readable for public repos, so fetch the
        # Sigstore bundle anonymously and hand it to gh via --bundle. The
        # authenticated path fetches the SAME endpoint with an Authorization
        # header it does not need; dropping the login requirement avoids
        # forcing a broadly-scoped plaintext token onto headless machines
        # just to read public data. Single fetch attempt, deliberately never
        # retried: the unauthenticated API allows 60 requests/hour per IP.
        # Any failure on this path (no JSON extractor, network, rate limit,
        # extraction failure, or a gh that cannot handle --bundle) falls
        # back to gh's own authenticated fetch below — verification itself
        # is never skipped.
        #
        # The response is { "attestations": [ { "bundle": {...}, ... } ] }.
        # gh --bundle expects the bundle values themselves, one JSON document
        # per line (the same JSONL format `gh attestation download` writes).
        # The extraction needs a JSON tool: node, then python3, then jq —
        # whichever is present. With none of the three, the credential-free
        # path is unavailable and the fallback runs (M3: the message names
        # that cause instead of blaming a fetch that never happened).
        attestation_bundle=""
        attestation_bundle_dir=""
        bundle_fallback_reason=""
        if ! command -v node >/dev/null 2>&1 && ! command -v python3 >/dev/null 2>&1 && ! command -v jq >/dev/null 2>&1; then
            bundle_fallback_reason="No JSON extractor found (the credential-free bundle path needs node, python3, or jq)"
        else
            _att_json=$(curl -fsSL --connect-timeout 10 --max-time 30 \
                "https://api.github.com/repos/${REPO}/attestations/sha256:${actual_checksum}" 2>/dev/null) || _att_json=""
            if [ -z "$_att_json" ]; then
                bundle_fallback_reason="Could not fetch the attestation bundle from the public API"
            else
                # Private temp dir with the bundle inside (M5): no
                # rename-into-place of a predictable sibling path, and one
                # rm -rf covers every exit. gh requires a .json/.jsonl
                # extension on --bundle files. A mktemp failure degrades to
                # the authenticated fallback, never aborts under set -e.
                attestation_bundle_dir=$(mktemp -d 2>/dev/null) || attestation_bundle_dir=""
                if [ -z "$attestation_bundle_dir" ]; then
                    bundle_fallback_reason="Could not create a temporary directory for the attestation bundle"
                else
                    _att_bundle_file="$attestation_bundle_dir/bundle.jsonl"
                    _att_extract_ok=0
                    if command -v node >/dev/null 2>&1; then
                        if printf '%s' "$_att_json" | node -e '
let d = "";
process.stdin.on("data", (c) => (d += c));
process.stdin.on("end", () => {
  let p;
  try { p = JSON.parse(d); } catch { process.exit(1); }
  const atts = Array.isArray(p.attestations) ? p.attestations : [];
  const lines = atts.map((a) => a && a.bundle).filter(Boolean).map((b) => JSON.stringify(b));
  if (!lines.length) process.exit(1);
  process.stdout.write(lines.join("\n") + "\n");
});
' > "$_att_bundle_file" 2>/dev/null && [ -s "$_att_bundle_file" ]; then
                            _att_extract_ok=1
                        fi
                    elif command -v python3 >/dev/null 2>&1; then
                        if printf '%s' "$_att_json" | python3 -c '
import json, sys
try:
    p = json.load(sys.stdin)
except Exception:
    sys.exit(1)
atts = p.get("attestations") or []
lines = [json.dumps(a["bundle"], separators=(",", ":")) for a in atts if isinstance(a, dict) and a.get("bundle")]
if not lines:
    sys.exit(1)
sys.stdout.write("\n".join(lines) + "\n")
' > "$_att_bundle_file" 2>/dev/null && [ -s "$_att_bundle_file" ]; then
                            _att_extract_ok=1
                        fi
                    else
                        if printf '%s' "$_att_json" | jq -c '.attestations[]?.bundle | select(. != null)' > "$_att_bundle_file" 2>/dev/null && [ -s "$_att_bundle_file" ]; then
                            _att_extract_ok=1
                        fi
                    fi
                    if [ "$_att_extract_ok" -eq 1 ]; then
                        attestation_bundle="$_att_bundle_file"
                    else
                        bundle_fallback_reason="Could not extract a bundle from the attestations API response"
                        rm -rf "$attestation_bundle_dir"
                        attestation_bundle_dir=""
                    fi
                    unset _att_bundle_file _att_extract_ok
                fi
            fi
            unset _att_json
        fi
        # Capture combined output so we can surface gh's actual error message
        # (auth, network, missing attestation, etc.) on failure instead of a
        # generic "verification failed" with no diagnostic detail.
        # Constrain verification to the exact tag + signing workflow — not
        # just "built by somewhere in this repo". --source-ref pins the
        # git ref the attestation was produced from; --signer-workflow pins
        # the workflow file that signed it. Together they prevent accepting
        # a misattached asset or an attestation from an unrelated workflow.
        gh_status=0
        used_bundle=0
        if [ -n "$attestation_bundle" ]; then
            used_bundle=1
            gh_output=$(gh attestation verify "$tmp_file" \
                --bundle "$attestation_bundle" \
                --repo "$REPO" \
                --source-ref "refs/tags/${latest_tag}" \
                --signer-workflow "backnotprop/plannotator/.github/workflows/release.yml" 2>&1) || gh_status=$?
            if [ "$gh_status" -ne 0 ]; then
                # H1: a --bundle failure is not necessarily a provenance
                # failure (an older gh rejects the flag outright, a corrupted
                # bundle write fails parsing, etc.). Retry once through the
                # exact authenticated path before classifying anything; only
                # the retry's verdict is reported. A real provenance failure
                # fails again here, so nothing bad ever slips through.
                echo "Bundle-based verification did not complete; retrying via gh's authenticated fetch."
                used_bundle=0
                gh_status=0
                gh_output=$(gh attestation verify "$tmp_file" \
                    --repo "$REPO" \
                    --source-ref "refs/tags/${latest_tag}" \
                    --signer-workflow "backnotprop/plannotator/.github/workflows/release.yml" 2>&1) || gh_status=$?
            fi
        else
            echo "${bundle_fallback_reason}; falling back to gh's authenticated fetch."
            gh_output=$(gh attestation verify "$tmp_file" \
                --repo "$REPO" \
                --source-ref "refs/tags/${latest_tag}" \
                --signer-workflow "backnotprop/plannotator/.github/workflows/release.yml" 2>&1) || gh_status=$?
        fi
        if [ -n "$attestation_bundle_dir" ]; then rm -rf "$attestation_bundle_dir"; fi
        if [ "$gh_status" -eq 0 ]; then
            if [ "$used_bundle" -eq 1 ]; then
                echo "✓ verified build provenance (SLSA, credential-free via the public attestations API)"
            else
                echo "✓ verified build provenance (SLSA)"
            fi
        else
            echo "$gh_output" >&2
            # Classification precedence: TUF connectivity first, then auth,
            # then real provenance failure (matches install.cmd).
            case "$gh_output" in
                *"Sigstore verifiers"*)
                    # gh could not initialize the Sigstore trusted root. The
                    # TUF root is fetched on EVERY run (not embedded, not
                    # cached), so this is a connectivity failure, not a
                    # provenance failure — the two mean very different things.
                    echo "Could not initialize the Sigstore trust root (TUF)." >&2
                    echo "Provenance verification needs network access on every run; the trusted" >&2
                    echo "root is fetched per-run, never cached. This is a connectivity failure," >&2
                    echo "NOT evidence of a bad binary. Refusing to install unverified; retry" >&2
                    echo "with network access or pass --skip-attestation." >&2
                    ;;
                *"gh auth login"*)
                    # Only reachable on the authenticated path: the bundle
                    # path was unavailable or did not complete AND gh has no
                    # login to fetch the attestation itself. Environment
                    # problem, not a provenance failure.
                    echo "The credential-free bundle path did not complete and gh is not logged" >&2
                    echo "in, so the authenticated fallback could not run. Retry with network" >&2
                    echo "access to api.github.com, run 'gh auth login', or pass --skip-attestation." >&2
                    ;;
                *)
                    echo "Attestation verification failed!" >&2
                    echo "The binary's SHA256 matched, but no valid signed provenance was found" >&2
                    echo "for ${REPO}. Refusing to install." >&2
                    ;;
            esac
            rm -f "$tmp_file"
            exit 1
        fi
    else
        echo "verifyAttestation is enabled but gh CLI was not found." >&2
        echo "Install https://cli.github.com (no login is needed when the public" >&2
        echo "attestation bundle fetch succeeds), or unset" >&2
        echo "PLANNOTATOR_VERIFY_ATTESTATION / remove verifyAttestation from" >&2
        echo "~/.plannotator/config.json / pass --skip-attestation." >&2
        rm -f "$tmp_file"
        exit 1
    fi
else
    echo "SHA256 verified. For build provenance verification, see"
    echo "https://docs.plannotator.ai/open-source/start/installation#pin-or-verify-a-release"
fi

# Remove old binary first (handles Windows .exe and locked file issues)
rm -f "$INSTALL_DIR/plannotator" "$INSTALL_DIR/plannotator.exe" 2>/dev/null || true

mv "$tmp_file" "$INSTALL_DIR/plannotator"
chmod +x "$INSTALL_DIR/plannotator"

echo ""
echo "plannotator ${latest_tag} installed to ${INSTALL_DIR}/plannotator"

# Print the PATH-setup hint if $INSTALL_DIR isn't already on PATH. Extracted so
# both the normal flow and the --minimal early exit below can reuse it.
print_path_advice() {
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
    echo ""
    echo "To uninstall later: plannotator uninstall"
}

# Binary-only mode stops here: the binary is installed, so print PATH advice and
# exit before any sidecar download, agent integration, skill checkout, config
# write, cache clear, or cleanup migration runs. No persistent state is written
# outside $INSTALL_DIR (the temp download file was already cleaned up above; the
# config dir may have been read, never written). See the MINIMAL_FLAG /
# PLANNOTATOR_MINIMAL resolution near the top.
if [ "$minimal" -eq 1 ]; then
    print_path_advice
    echo ""
    echo "Minimal install complete — only the plannotator binary was installed."
    echo "No skills, hooks, agent integrations, or config files were written."
    exit 0
fi

sem_asset_for_platform() {
    case "$platform" in
        darwin-arm64) echo "sem-darwin-arm64.tar.gz" ;;
        linux-arm64)  echo "sem-linux-arm64.tar.gz" ;;
        linux-x64)    echo "sem-linux-x86_64.tar.gz" ;;
        *)            return 1 ;;
    esac
}

install_sem_sidecar() {
    case "${PLANNOTATOR_SKIP_SEM_INSTALL:-}" in
        1|true|yes|TRUE|YES|True|Yes)
            echo "Skipping semantic diff sidecar install (PLANNOTATOR_SKIP_SEM_INSTALL is set)"
            return 0
            ;;
    esac

    sem_asset="$(sem_asset_for_platform 2>/dev/null || true)"
    if [ -z "$sem_asset" ]; then
        echo "Skipping semantic diff sidecar install (sem does not publish ${platform})"
        return 0
    fi

    sem_dir="${_config_dir}/vendor/sem/${SEM_VERSION}"
    sem_bin="${sem_dir}/sem"
    if [ -x "$sem_bin" ] && "$sem_bin" --version 2>/dev/null | grep -q '^sem '; then
        echo "Semantic diff sidecar already installed at ${sem_bin}"
        return 0
    fi

    tmp_sem_dir="$(mktemp -d)"
    sem_archive="${tmp_sem_dir}/${sem_asset}"
    sem_checksums="${tmp_sem_dir}/checksums.txt"
    sem_base_url="https://github.com/${SEM_REPO}/releases/download/${SEM_VERSION}"

    # Bounded so a slow/hung download of this optional sidecar can't wedge an
    # install where plannotator itself already landed. On timeout curl fails and
    # we skip gracefully. Opt out entirely with PLANNOTATOR_SKIP_SEM_INSTALL=1.
    if ! curl -fsSL --connect-timeout 10 --max-time 120 -o "$sem_archive" "${sem_base_url}/${sem_asset}"; then
        echo "Skipping semantic diff sidecar install (download failed)"
        rm -rf "$tmp_sem_dir"
        return 0
    fi
    if ! curl -fsSL --connect-timeout 10 --max-time 60 -o "$sem_checksums" "${sem_base_url}/checksums.txt"; then
        echo "Skipping semantic diff sidecar install (checksum download failed)"
        rm -rf "$tmp_sem_dir"
        return 0
    fi

    expected_sem_checksum="$(awk -v name="$sem_asset" '$2 == name { print $1 }' "$sem_checksums")"
    if [ -z "$expected_sem_checksum" ]; then
        echo "Skipping semantic diff sidecar install (checksum missing for ${sem_asset})"
        rm -rf "$tmp_sem_dir"
        return 0
    fi

    if [ "$(uname -s)" = "Darwin" ]; then
        actual_sem_checksum="$(shasum -a 256 "$sem_archive" | cut -d' ' -f1)"
    else
        actual_sem_checksum="$(sha256sum "$sem_archive" | cut -d' ' -f1)"
    fi

    if [ "$actual_sem_checksum" != "$expected_sem_checksum" ]; then
        echo "Skipping semantic diff sidecar install (checksum mismatch)"
        rm -rf "$tmp_sem_dir"
        return 0
    fi

    if ! tar -xzf "$sem_archive" -C "$tmp_sem_dir"; then
        echo "Skipping semantic diff sidecar install (extract failed)"
        rm -rf "$tmp_sem_dir"
        return 0
    fi

    extracted_sem="$(find "$tmp_sem_dir" -type f -name sem -print -quit)"
    if [ -z "$extracted_sem" ]; then
        echo "Skipping semantic diff sidecar install (binary missing from archive)"
        rm -rf "$tmp_sem_dir"
        return 0
    fi

    if ! mkdir -p "$sem_dir"; then
        echo "Skipping semantic diff sidecar install (directory creation failed)"
        rm -rf "$tmp_sem_dir"
        return 0
    fi
    if ! cp "$extracted_sem" "$sem_bin"; then
        echo "Skipping semantic diff sidecar install (copy failed)"
        rm -rf "$tmp_sem_dir"
        return 0
    fi
    if ! chmod +x "$sem_bin"; then
        echo "Skipping semantic diff sidecar install (chmod failed)"
        rm -f "$sem_bin"
        rm -rf "$tmp_sem_dir"
        return 0
    fi
    rm -rf "$tmp_sem_dir"
    echo "Semantic diff sidecar installed to ${sem_bin}"
}

install_agent_terminal_runtime() {
    case "${PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL:-}" in
        1|true|yes|TRUE|YES|True|Yes)
            echo "Skipping agent terminal runtime install (PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL is set)"
            return 0
            ;;
    esac

    if ! "$INSTALL_DIR/plannotator" install-runtime agent-terminal; then
        echo "Skipping agent terminal runtime install (plannotator install-runtime failed)"
    fi
}

# Strictly opt-in: Call flow is off by default, so a default install never
# downloads even its pruned core. Review-specific packs install in-app.
install_call_flow_runtime() {
    if [ "$install_call_flow" -ne 1 ]; then
        echo "Call-flow analysis: available as an in-app opt-in install (enable Call flow in review Settings), or run: plannotator install-runtime call-flow"
        return 0
    fi

    if ! "$INSTALL_DIR/plannotator" install-runtime call-flow; then
        echo "Call-flow runtime install failed; it remains available as an in-app opt-in install"
    fi
}

install_sem_sidecar
install_agent_terminal_runtime
install_call_flow_runtime

print_path_advice

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

if [ "$codex_available" -eq 1 ] && [ "$skip_codex" -eq 1 ]; then
    # HONEST three-state reporting (#1178): detected-but-skipped is its own
    # state, never conflated with "not detected". Skip is do-not-write only:
    # nothing under $CODEX_DIR is created, updated, or removed on this run.
    echo ""
    echo "Codex: detected, skipped (${skip_codex_source})."
    if [ -f "$CODEX_DIR/hooks.json" ] && grep -q "plannotator" "$CODEX_DIR/hooks.json" 2>/dev/null; then
        echo "An existing Codex integration at ${CODEX_DIR}/hooks.json was left untouched."
    fi
    echo "Note: the shared agent skills in ~/.agents/skills serve multiple agents"
    echo "(Codex among them) and are still installed."
elif [ "$codex_available" -eq 1 ]; then
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

# Clear any cached OpenCode plugin to force fresh download on next run.
# An OpenCode opt-out (#1178) leaves OpenCode's own cache directory alone;
# the Bun package cache is a shared cache, not OpenCode's home, and is
# always cleared.
if [ "$skip_opencode" -eq 0 ]; then
    rm -rf "$HOME/.cache/opencode/node_modules/@plannotator" "$HOME/.cache/opencode/packages/@plannotator" 2>/dev/null || true
fi
rm -rf "$HOME/.bun/install/cache/@plannotator" 2>/dev/null || true

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
if [ -f "$PREFS_FILE" ]; then
    saved_extras=$(sed -n 's/^extras=//p' "$PREFS_FILE" | head -1)
    saved_invocable=$(sed -n 's/^model_invocable=//p' "$PREFS_FILE" | head -1)
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

# A wizard needs a real human at the keyboard. Piped installs (curl | bash)
# still have a terminal at /dev/tty even though stdin is the pipe; CI and
# scripts do not. Some automated contexts (docker run -t, devcontainer and
# provisioner shells) DO expose an openable /dev/tty with nobody behind it —
# opening /dev/tty succeeds, yet a read would block forever. The per-prompt
# timeout below (see PROMPT_TIMEOUT / ask_yes_no) handles that: a mis-detected
# terminal falls through to the safe non-interactive defaults (extras=no,
# model-invocable=none) instead of wedging. We deliberately do NOT
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
    # default). Otherwise a prompt whose default is "yes" could
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
fi

# Flags override the wizard and saved answers; otherwise saved, then defaults.
[ -n "$EXTRAS_FLAG" ] && extras_choice="$EXTRAS_FLAG"
[ -n "$MODEL_INVOCABLE_FLAG" ] && invocable_choice="$MODEL_INVOCABLE_FLAG"
[ -z "$extras_choice" ] && extras_choice="${saved_extras:-no}"
[ -z "$invocable_choice" ] && invocable_choice="${saved_invocable:-none}"

# Persist only when the wizard ran with real answers, or a flag set something.
# Silent re-runs must not clobber saved answers with defaults, and a wizard that
# timed out to synthetic fallbacks (unattended /dev/tty) must not become sticky
# prefs that suppress the wizard on a later genuine interactive install.
if [ "$wizard_timed_out" -eq 0 ] && { [ "$run_wizard" -eq 1 ] || [ -n "$EXTRAS_FLAG" ] || [ -n "$MODEL_INVOCABLE_FLAG" ]; }; then
    mkdir -p "$_config_dir"
    {
        echo "extras=$extras_choice"
        echo "model_invocable=$invocable_choice"
    } > "$PREFS_FILE"
fi

# Extras install is delegated to the skills CLI (its UI picks the agents).
# Interactive only — the CLI needs the keyboard, so silent runs and CI get
# the printed command instead. Never runs when the extras already exist.
# The extras ARE skills, so --skip-skills suppresses them too — a saved
# extras=yes preference must not smuggle a skill install past the opt-out.
if [ "$skip_skills" -eq 0 ] && [ "$extras_choice" = "yes" ] && [ "$extras_present" -eq 0 ]; then
    if [ "$can_prompt" -eq 1 ] && command -v npx >/dev/null 2>&1; then
        echo "Launching the skills CLI for the extras (pick your agents in its UI)..."
        npx skills add backnotprop/plannotator/apps/skills/extra --global < /dev/tty || \
            echo "skills CLI did not complete — install later with: npx skills add backnotprop/plannotator/apps/skills/extra --global"
    else
        echo "Install the extras with: npx skills add backnotprop/plannotator/apps/skills/extra --global"
    fi
fi

# Skills/commands opt-out. HONEST reporting like the per-agent family: the
# skipped state is announced, and skip means do-not-write — nothing already on
# disk in any skill or command scope is fetched, replaced, or removed on this
# run. Announced here, before the checkout, so the reason precedes the silence.
if [ "$skip_skills" -eq 1 ]; then
    echo ""
    echo "Skills: skipped (${skip_skills_source})."
    echo "No skills or slash commands were fetched, and none already installed"
    echo "were changed or removed. The /plannotator-* commands are NOT installed"
    echo "by this run — re-run without the opt-out to install them."
fi

# Install skills and slash commands from a sparse checkout (requires git).
# Hard requirement: without git we cannot install the /plannotator-* skills,
# so fail loudly instead of leaving a partial install. Hook/config writing
# above has already run by this point; the Pi update and Gemini config below
# are skipped on failure and complete when the user re-runs the installer.
# Nothing is fetched under --skip-skills, so git stops being a requirement
# there — a git-less machine must still get the binary, hooks, and config.
if [ "$skip_skills" -eq 0 ] && ! command -v git &>/dev/null; then
    echo "Error: git is required to install Plannotator's skills and slash commands." >&2
    echo "Install git, then run this installer again." >&2
    echo "To install without them, re-run with --skip-skills." >&2
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
#
# Do NOT rely on `set -e` in here. POSIX says -e is ignored for every
# command of an AND-OR list except the last, and every shell we tested
# (bash 3.2.57, which is what `curl | bash` gets on macOS, plus bash 5.3,
# dash, zsh, and ksh) carries that suppression into the subshell. Writing
# it as `if ! ( ... ); then` suppresses -e the same way. So the fetch
# steps below carry an explicit `|| exit 1`: without them a failed clone
# ran the whole block anyway, the subshell exited 0 on its trailing `if`,
# and the installer printed "YOU'RE ALL SET!" with no skills installed.
# Everything after the checkout stays best-effort on purpose, matching
# install.cmd, which only checks git clone and lets every xcopy run
# unchecked. A local cp/mkdir/rm hiccup must not be reported through the
# "network or git error" message below.
checkout_failed=0
(
    # --skip-skills / PLANNOTATOR_SKIP_SKILLS_INSTALL / skipInstall.skills.
    # Exit 0 BEFORE the clone so no network call is made and checkout_failed
    # stays 0 — an opt-out is not a fetch failure and must not trip the guard
    # below. The report was already printed above the git check.
    if [ "$skip_skills" -eq 1 ]; then
        exit 0
    fi

    cd "$skills_tmp" || exit 1
    # Capture git's stderr instead of discarding it (#1238): on failure the
    # real error is surfaced below so incompatibilities self-diagnose instead
    # of hiding behind the generic "network or git error" message.
    git_err="$skills_tmp/git-stderr"
    surface_git_error() {
        echo "git reported:" >&2
        tail -n 5 "$git_err" >&2
    }
    sparse_clone=1
    # LC_ALL=C pins git's error strings to English: the capability probe below
    # matches the literal "unknown option ... sparse" text, and a localized
    # git (standard Linux NLS builds) would otherwise emit a translated
    # message the match misses, sending old-git non-English users to a hard
    # failure instead of the fallback.
    if ! LC_ALL=C LANGUAGE=C git clone --depth 1 --filter=blob:none --sparse \
        "https://github.com/${REPO}.git" --branch "$latest_tag" repo 2>"$git_err"; then
        # Capability probe, not a version parse (same philosophy as the
        # GitButler flag probing in packages/shared/gitbutler-core.ts):
        # `git clone --sparse` needs git >= 2.25, and an older git (macOS
        # with stale Xcode CLT ships 2.23) rejects the flag instantly with
        # "error: unknown option `sparse'" before any network call (#1238).
        # Fall back to a plain shallow clone — it costs download size, not
        # correctness: every path the copy steps below read is present in
        # the full checkout, and `git sparse-checkout set` (equally missing
        # on that git) is skipped because there is nothing to narrow.
        if grep -qi "unknown option" "$git_err" && grep -qi "sparse" "$git_err"; then
            echo "This git does not support 'git clone --sparse' (needs git >= 2.25) — falling back to a plain shallow clone."
            sparse_clone=0
            rm -rf repo
            if ! git clone --depth 1 \
                "https://github.com/${REPO}.git" --branch "$latest_tag" repo 2>"$git_err"; then
                surface_git_error
                exit 1
            fi
        else
            surface_git_error
            exit 1
        fi
    fi
    cd repo || exit 1
    if [ "$sparse_clone" -eq 1 ]; then
        if ! git sparse-checkout set apps/skills apps/kiro-cli apps/opencode-plugin/commands apps/gemini/commands 2>"$git_err"; then
            surface_git_error
            exit 1
        fi
    fi

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
    if [ "$skip_opencode" -eq 0 ] && [ -d "apps/opencode-plugin/commands" ] && [ -n "$(ls -A apps/opencode-plugin/commands 2>/dev/null)" ]; then
        copy_commands_if_present apps/opencode-plugin/commands "$OPENCODE_COMMANDS_DIR"
        echo "Installed OpenCode commands to ${OPENCODE_COMMANDS_DIR}/"
    fi

    # Gemini native TOML commands — only when Gemini is present and not
    # opted out (#1178; skip_gemini is inherited by this subshell).
    if [ -d "$HOME/.gemini" ] && [ "$skip_gemini" -eq 0 ] && [ -d "apps/gemini/commands" ] && [ -n "$(ls -A apps/gemini/commands 2>/dev/null)" ]; then
        copy_commands_if_present apps/gemini/commands "$GEMINI_COMMANDS_DIR"
        echo "Installed Gemini commands to ${GEMINI_COMMANDS_DIR}/"
    fi

    if [ "$kiro_available" -eq 1 ] && [ "$skip_kiro" -eq 0 ] && [ -d "apps/kiro-cli/skills" ] && [ -n "$(ls -A apps/kiro-cli/skills 2>/dev/null)" ]; then
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
    # A skills opt-out installed no replacement this run, so it removes
    # nothing either — skip means do-not-write, never remove.
    if [ "$skip_skills" -eq 1 ]; then
        continue
    fi
    if [ -d "$CLAUDE_SKILLS_DIR/$cmd" ] && [ -f "$CLAUDE_COMMANDS_DIR/$cmd.md" ]; then
        rm -f "$CLAUDE_COMMANDS_DIR/$cmd.md"
        echo "Removed legacy Claude command ${CLAUDE_COMMANDS_DIR}/$cmd.md (replaced by the $cmd skill)"
    fi
done

# plannotator-archive no longer ships as a skill. Remove any stale installed
# copy from every skill scope so upgraders don't keep a dead skill around.
for scope in "$CLAUDE_SKILLS_DIR" "$AGENTS_SKILLS_DIR" "$KIRO_SKILLS_DIR"; do
    # A skills opt-out leaves every skill scope untouched, sweep included.
    if [ "$skip_skills" -eq 1 ]; then
        continue
    fi
    # A Kiro opt-out leaves ~/.kiro entirely untouched — including this sweep.
    if [ "$scope" = "$KIRO_SKILLS_DIR" ] && [ "$skip_kiro" -eq 1 ]; then
        continue
    fi
    if [ -d "$scope/plannotator-archive" ]; then
        rm -rf "$scope/plannotator-archive"
        echo "Removed stale plannotator-archive skill from ${scope}/plannotator-archive"
    fi
done
# The /plannotator-archive OpenCode command was removed too — sweep the stub
# (only npm-plugin-postinstall users ever had it written here). An OpenCode
# opt-out suspends the sweep: skip means do-not-write, never remove.
# A skills opt-out suspends it for the same reason.
if [ "$skip_opencode" -eq 0 ] && [ "$skip_skills" -eq 0 ] && [ -f "$OPENCODE_COMMANDS_DIR/plannotator-archive.md" ]; then
    rm -f "$OPENCODE_COMMANDS_DIR/plannotator-archive.md"
    echo "Removed stale plannotator-archive command from ${OPENCODE_COMMANDS_DIR}/"
fi

# Codex no longer hosts core skills (they now live in ~/.agents/skills).
# Core skills are removed only once their replacement exists; the stale
# shared-agent extras were never Codex's and are removed unconditionally.
for skill in plannotator-review plannotator-annotate plannotator-last plannotator-compound plannotator-setup-goal; do
    # A Codex opt-out leaves $CODEX_DIR entirely untouched — including this
    # stale-skill cleanup. Skip means do-not-write, never remove. A skills
    # opt-out installed no replacement, so it suspends the sweep as well.
    if [ "$skip_codex" -eq 1 ] || [ "$skip_skills" -eq 1 ]; then
        continue
    fi
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
# A skills opt-out installed no skill copies this run, so there is nothing to
# unlock — and rewriting a PREVIOUS run's SKILL.md would be a write the opt-out
# promised not to make.
if [ "$skip_skills" -eq 0 ] && [ -n "$invocable_choice" ] && [ "$invocable_choice" != "none" ]; then
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
if [ -d "$HOME/.gemini" ] && [ "$skip_gemini" -eq 1 ]; then
    # HONEST three-state reporting (#1178): detected-but-skipped is its own
    # state. Nothing under ~/.gemini is created, updated, or removed.
    echo ""
    echo "Gemini: detected, skipped (${skip_gemini_source})."
    if [ -f "$HOME/.gemini/settings.json" ] && grep -q '"plannotator"' "$HOME/.gemini/settings.json" 2>/dev/null; then
        echo "An existing Gemini integration at ~/.gemini/settings.json was left untouched."
    fi
elif [ -d "$HOME/.gemini" ]; then
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
if [ "$skip_opencode" -eq 1 ]; then
    echo "OpenCode: integration skipped (${skip_opencode_source})."
    echo "No command stubs were written and OpenCode's plugin cache was left alone."
    echo "Re-run without the opt-out to install the command stubs."
elif [ "$skip_skills" -eq 1 ]; then
    # The stubs ship in the skills checkout, so this run installed none.
    echo "Add the plugin to your opencode.json:"
    echo ""
    echo '  "plugin": ["@plannotator/opencode@latest"]'
    echo ""
    echo "Skills were skipped (${skip_skills_source}), so no /plannotator-* command"
    echo "stubs were installed. Re-run without the opt-out to add them."
else
    echo "Add the plugin to your opencode.json:"
    echo ""
    echo '  "plugin": ["@plannotator/opencode@latest"]'
    echo ""
    echo "Then restart OpenCode. The /plannotator-review, /plannotator-annotate, and /plannotator-last commands are ready!"
fi
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
if [ -d "$HOME/.gemini" ] && [ "$skip_gemini" -eq 1 ]; then
    echo "Gemini was detected, but the integration was skipped (${skip_gemini_source})."
    echo "No files under ~/.gemini were written or removed. Re-run without the"
    echo "opt-out to configure plan mode."
elif [ -d "$HOME/.gemini" ]; then
    echo "Enable plan mode in Gemini settings, then run:"
    echo ""
    echo "  gemini"
    echo "  /plan"
    echo ""
    echo "Plans will open in your browser for review."
    echo "If settings.json was not auto-configured, see:"
    echo "  ~/.gemini/settings.json (add BeforeTool hook)"
else
    echo "Gemini was not detected. After installing the Gemini CLI, rerun this"
    echo "installer to configure plan mode."
fi
echo ""
echo "=========================================="
echo "  CODEX USERS"
echo "=========================================="
echo ""
if [ "$codex_available" -eq 1 ] && [ "$skip_codex" -eq 1 ]; then
    echo "Codex was detected, but the integration was skipped (${skip_codex_source})."
    echo "No files under ${CODEX_DIR} were written or removed. The shared agent"
    echo "skills in ~/.agents/skills serve multiple agents and are still installed."
    echo "Re-run without the opt-out to add the Stop hook."
elif [ "$codex_available" -eq 1 ]; then
    echo "Restart Codex Desktop or CLI after installing."
    echo "Plan review is configured through the Codex Stop hook."
    echo ""
    if [ "$skip_skills" -eq 1 ]; then
        echo "Skills were skipped (${skip_skills_source}), so no core skills were"
        echo "installed to ~/.agents/skills/. The Stop hook works without them;"
        echo "re-run without the opt-out to add \$plannotator-review and friends."
    else
        echo "Core skills are installed to ~/.agents/skills/:"
        echo "  \$plannotator-review"
        echo "  \$plannotator-annotate <file|url|folder>"
        echo "  \$plannotator-last"
    fi
else
    echo "Codex was not detected. After installing Codex, rerun this installer to add"
    echo "the Stop hook."
fi
echo ""
echo "=========================================="
echo "  KIRO CLI USERS"
echo "=========================================="
echo ""
if [ "$kiro_available" -eq 1 ] && [ "$skip_kiro" -eq 1 ]; then
    echo "Kiro was detected, but the integration was skipped (${skip_kiro_source})."
    echo "No files under ~/.kiro were written or removed. Re-run without the"
    echo "opt-out to add Kiro skills."
elif [ "$kiro_available" -eq 1 ] && [ "$skip_skills" -eq 1 ]; then
    echo "Kiro was detected, but skills were skipped (${skip_skills_source}), so no"
    echo "Kiro skills or agent were installed. Re-run without the opt-out to add them."
elif [ "$kiro_available" -eq 1 ]; then
    echo "Kiro skills are installed to ~/.kiro/skills/"
    echo "The Plannotator agent is installed to ~/.kiro/agents/plannotator.json"
    echo "Launch it: kiro-cli chat --agent plannotator"
else
    echo "Kiro was not detected. After installing Kiro, rerun this installer to add Kiro skills."
fi
echo ""
echo "=========================================="
if [ "$skip_skills" -eq 1 ]; then
    # Never claim the /plannotator-* commands are ready when nothing was
    # installed — that false banner is exactly what the skills-checkout guard
    # exists to prevent.
    echo "  CLAUDE CODE USERS: BINARY INSTALLED"
else
    echo "  CLAUDE CODE USERS: YOU'RE ALL SET!"
fi
echo "=========================================="
echo ""
echo "Install the Claude Code plugin:"
echo "  /plugin marketplace add backnotprop/plannotator"
echo "  /plugin install plannotator@plannotator"
echo ""
echo "Upgrading from an older version? Also run /plugin marketplace update"
echo "so the plugin drops its old plannotator:* command entries."
echo ""
if [ "$skip_skills" -eq 1 ]; then
    echo "Skills were skipped (${skip_skills_source}), so the /plannotator-review,"
    echo "/plannotator-annotate, and /plannotator-last commands are NOT installed."
    echo "Re-run the installer without the opt-out to add them."
else
    echo "The /plannotator-review, /plannotator-annotate, and /plannotator-last commands are ready to use after you restart Claude Code!"
fi

if [ "$skip_skills" -eq 0 ] && [ "$extras_choice" != "yes" ]; then
    echo ""
    echo "Optional skills (compound planning, setup-goal, visual explainer):"
    echo "  npx skills add backnotprop/plannotator/apps/skills/extra --global"
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
