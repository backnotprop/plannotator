#!/usr/bin/env bash
#
# Plannotator OpenCode Startup Benchmark
#
# Measures real OpenCode startup time across three scenarios:
#   1. No plugin (baseline)
#   2. Published npm plugin (@plannotator/opencode@latest)
#   3. Local optimized plugin (file:// path)
#
# Uses `opencode run` (non-interactive) and parses log timing.
# Usage: ./bench-startup.sh [runs_per_scenario]

set -euo pipefail

RUNS=${1:-3}
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_FILE="$PROJECT_DIR/opencode.json"
LOG_DIR="$HOME/.local/share/opencode/log"
CACHE_DIR="$HOME/.cache/opencode"
LOCAL_PLUGIN="file://$PROJECT_DIR/apps/opencode-plugin"

# ── Helpers ──────────────────────────────────────────────────────────────

write_config() {
  local plugin_json="$1"
  cat > "$CONFIG_FILE" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugin": $plugin_json
}
EOF
}

clear_plugin_cache() {
  rm -rf "$CACHE_DIR/node_modules/@plannotator"
  if [[ -f "$CACHE_DIR/package.json" ]]; then
    bun -e "
      const p = JSON.parse(await Bun.file('$CACHE_DIR/package.json').text());
      delete (p.dependencies || {})['@plannotator/opencode'];
      await Bun.write('$CACHE_DIR/package.json', JSON.stringify(p, null, 2));
    " 2>/dev/null || true
  fi
}

# Run opencode run, find the log, parse timing
run_once() {
  local before_log
  before_log=$(ls -t "$LOG_DIR"/*.log 2>/dev/null | head -1 || echo "")

  # opencode run with a trivial message — exits after one response
  cd "$PROJECT_DIR"
  timeout 30 opencode run "say OK" --format json &>/dev/null || true

  # Find the new log file
  local log_file
  log_file=$(ls -t "$LOG_DIR"/*.log 2>/dev/null | head -1 || echo "")
  if [[ "$log_file" == "$before_log" ]]; then
    echo "0 n/a"
    return
  fi

  # Parse: sum +Xms until first completed /session request
  local total_ms=0
  local plugin_ms="n/a"
  local in_plugin=0

  while IFS= read -r line; do
    local ms
    ms=$(echo "$line" | grep -oE '\+[0-9]+ms' | head -1 | tr -d '+ms')
    [[ -z "$ms" ]] && continue
    total_ms=$((total_ms + ms))

    if echo "$line" | grep -q "loading plugin" && echo "$line" | grep -qi "plannotator"; then
      in_plugin=1
    elif [[ $in_plugin -eq 1 ]]; then
      plugin_ms=$ms
      in_plugin=0
    fi

    if echo "$line" | grep -q "status=completed.*path=/session"; then
      break
    fi
  done < "$log_file"

  echo "$total_ms $plugin_ms"
}

# ── Main ─────────────────────────────────────────────────────────────────

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║        Plannotator OpenCode Startup Benchmark               ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Runs per scenario: $RUNS                                       ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ── Scenario 1: No plugin (baseline) ─────────────────────────────────

echo "━━━ Scenario 1: No plugin (baseline) ━━━"
write_config '[]'
clear_plugin_cache

baseline_times=()
for i in $(seq 1 "$RUNS"); do
  read -r total plugin <<< "$(run_once)"
  baseline_times+=("$total")
  printf "  Run %d: %dms total\n" "$i" "$total"
done

baseline_avg=0
for t in "${baseline_times[@]}"; do baseline_avg=$((baseline_avg + t)); done
baseline_avg=$((baseline_avg / RUNS))
echo "  → Average: ${baseline_avg}ms"
echo ""

# ── Scenario 2: Published npm plugin ─────────────────────────────────

echo "━━━ Scenario 2: Published npm plugin (@plannotator/opencode) ━━━"
write_config '["@plannotator/opencode@latest"]'
clear_plugin_cache

npm_times=()
for i in $(seq 1 "$RUNS"); do
  read -r total plugin <<< "$(run_once)"
  npm_times+=("$total")
  printf "  Run %d: %dms total (plugin: %sms)\n" "$i" "$total" "$plugin"
done

npm_avg=0
for t in "${npm_times[@]}"; do npm_avg=$((npm_avg + t)); done
npm_avg=$((npm_avg / RUNS))
echo "  → Average: ${npm_avg}ms (overhead: +$((npm_avg - baseline_avg))ms)"
echo ""

# ── Scenario 3: Local optimized plugin ───────────────────────────────

echo "━━━ Scenario 3: Local optimized plugin (file://) ━━━"
if [[ ! -f "$PROJECT_DIR/apps/opencode-plugin/dist/index.js" ]]; then
  echo "  Building local plugin (dist/index.js not found)..."
  (cd "$PROJECT_DIR" && bun run build:opencode)
fi
write_config "[\"$LOCAL_PLUGIN\"]"
clear_plugin_cache

local_times=()
for i in $(seq 1 "$RUNS"); do
  read -r total plugin <<< "$(run_once)"
  local_times+=("$total")
  printf "  Run %d: %dms total (plugin: %sms)\n" "$i" "$total" "$plugin"
done

local_avg=0
for t in "${local_times[@]}"; do local_avg=$((local_avg + t)); done
local_avg=$((local_avg / RUNS))
echo "  → Average: ${local_avg}ms (overhead: +$((local_avg - baseline_avg))ms)"
echo ""

# ── Summary ──────────────────────────────────────────────────────────

overhead_npm=$((npm_avg - baseline_avg))
overhead_local=$((local_avg - baseline_avg))
if [[ $overhead_npm -gt 0 ]]; then
  reduction=$(( (overhead_npm - overhead_local) * 100 / overhead_npm ))
else
  reduction=0
fi

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                        RESULTS                              ║"
echo "╠══════════════════════════════════════════════════════════════╣"
printf "║  %-20s %10s %15s           ║\n" "Scenario" "Avg (ms)" "vs Baseline"
echo "║──────────────────────────────────────────────────────────────║"
printf "║  %-20s %10d %15s           ║\n" "No plugin" "$baseline_avg" "—"
printf "║  %-20s %10d %+14dms           ║\n" "npm (published)" "$npm_avg" "$overhead_npm"
printf "║  %-20s %10d %+14dms           ║\n" "Local (optimized)" "$local_avg" "$overhead_local"
echo "║──────────────────────────────────────────────────────────────║"
printf "║  Overhead reduction: %dms → %dms (%d%%)                   ║\n" \
  "$overhead_npm" "$overhead_local" "$reduction"
echo "╚══════════════════════════════════════════════════════════════╝"

# Restore local plugin config
write_config "[\"$LOCAL_PLUGIN\"]"
