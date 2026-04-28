#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: clear-opencode-cache.sh [--dry-run] [--help]

Clears OpenCode cache directories and related Bun package caches so OpenCode
and the Plannotator OpenCode plugin are reloaded from a clean state.

Options:
  --dry-run   Show which paths would be removed without deleting them
  -h, --help  Show this help and exit
EOF
}

dry_run=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

xdg_cache_home="${XDG_CACHE_HOME:-$HOME/.cache}"
bun_cache_home="${BUN_INSTALL_CACHE_DIR:-$HOME/.bun/install/cache}"

paths=(
  "$xdg_cache_home/opencode"
  "$bun_cache_home/@opencode-ai"
  "$bun_cache_home/@plannotator"
)

echo "OpenCode cache cleanup"
echo ""

removed_any=0

for path in "${paths[@]}"; do
  if [ -e "$path" ]; then
    if [ "$dry_run" -eq 1 ]; then
      echo "Would remove: $path"
    else
      rm -rf "$path"
      echo "Removed: $path"
    fi
    removed_any=1
  else
    echo "Not found: $path"
  fi
done

echo ""

if [ "$dry_run" -eq 1 ]; then
  if [ "$removed_any" -eq 1 ]; then
    echo "Dry run complete."
  else
    echo "Dry run complete. No matching cache paths were found."
  fi
else
  if [ "$removed_any" -eq 1 ]; then
    echo "OpenCode cache cleared."
  else
    echo "No matching cache paths were found."
  fi
fi
