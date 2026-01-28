#!/bin/bash
# Julien Doc Plannotator - Bash Wrapper
# Runs plannotator from local fork instead of marketplace version
# Location: ~/.claude/scripts/julien-doc-plannotator.sh

PLANNOTATOR_PATH="$HOME/OneDrive/Coding/_Projets de code/2026.01 Planotator (Claude Code annotation)/plannotator"

# Capture original working directory BEFORE cd'ing
# Convert to Windows-style path for Node/Bun compatibility
if command -v cygpath &> /dev/null; then
    # Git Bash / MSYS2 / Cygwin - convert Unix path to Windows
    export PLANNOTATOR_CWD="$(cygpath -w "$(pwd)")"
elif [[ "$(pwd)" == /[a-zA-Z]/* ]]; then
    # Manual conversion for /c/Users/... style paths
    DRIVE_LETTER="${PWD:1:1}"
    REST_OF_PATH="${PWD:2}"
    export PLANNOTATOR_CWD="${DRIVE_LETTER}:${REST_OF_PATH//\//\\}"
else
    # Already Windows-style or native path
    export PLANNOTATOR_CWD="$(pwd)"
fi

# Debug output (set PLANNOTATOR_DEBUG=1 to enable)
if [[ -n "$PLANNOTATOR_DEBUG" ]]; then
    echo "[DEBUG] Original PWD: $(pwd)" >&2
    echo "[DEBUG] PLANNOTATOR_CWD: $PLANNOTATOR_CWD" >&2
    echo "[DEBUG] Arguments: $@" >&2
fi

# Run with bun from the workspace root (required for package resolution)
cd "$PLANNOTATOR_PATH" && bun run "apps/hook/server/index.ts" "$@"
