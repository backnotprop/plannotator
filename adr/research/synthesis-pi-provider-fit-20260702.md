# Synthesis: Pi as a Plannotator agent-job provider

Date: 2026-07-02
Subject: /Users/ramos/oss-agents/pi (`@earendil-works/pi-coding-agent` 0.80.3, MIT)
Method: shallow breadth dive + three deep-dive subagent reports (CLI headless modes;
extensibility/SDK/auth; Plannotator-side integration seams).
Companion: `synthesis-flue-provider-fit-20260702.md` (Flue verdict: pass).

## Verdict

**Yes. Pi fits as an agent-job provider, and more cleanly than cursor/opencode do
today.** Users asking for it are already Pi-authenticated, which makes it
zero-config. Recommended shape: third marker engine for v1, with a straight
upgrade path to schema-native output via Pi's blessed finish-tool extension.

## Why it fits (the contract, point by point)

| Plannotator job contract | Pi answer |
|---|---|
| One-shot headless spawn | `pi -p "<prompt>"` / `--mode json` — full tool loop, exits on completion (print-mode.ts) |
| Live logs from stdout NDJSON | `--mode json`: one JSON event per line (session header, `agent_start` → `message_update` deltas → `tool_execution_*` → `agent_end`) — same shape class as Claude's stream-json |
| Structured JSON result | v1: our existing nonce marker-block contract, extracted from the final assistant message text. v2: **schema-native** via a shipped extension (`pi -e finish-tool.ts`) registering a runtime-validated tool with `terminate: true` — Pi ships this exact pattern as `examples/extensions/structured-output.ts`; invalid args produce per-field errors the model must retry. Stronger than markers, comparable to claude `--json-schema` |
| Auth that "just works" | Reuses `~/.pi/agent/auth.json` transparently: Claude Pro/Max OAuth, ChatGPT Plus/Codex, GitHub Copilot, or API keys, auto-refreshed. No new key management |
| cwd = the repo | Operates on spawn cwd (no `--cwd` flag; we already spawn with cwd) |
| Read-only for tour/guide | `--tools read,grep,find,ls` — enforced at tool registration, disables edit/write/bash outright (stronger than anything we have for cursor/opencode) |
| Model selection | `--model provider/id[:thinking]`, `--provider`, `--thinking off..xhigh` |
| Model catalog | `--list-models` is a human table (no JSON). Options: parse the table in `parseModels`, or reuse our existing `pi --mode rpc` + `get_available_models` machinery from `packages/ai/providers/pi-sdk.ts:247-281` (already built, already auth-filtered) |
| Session hygiene | `--no-session` (ephemeral) or `--session-id <job-id>` (future "view agent trace" feature) |
| Kill/abort | SIGTERM → exit 143; process-level, same as other providers |
| Capability detection | `Bun.which("pi")` — we already do this for the Ask-AI provider |

## Gotchas to encode in the integration (all confirmed)

1. **`--mode json` exits 0 even when the run failed.** The text-mode stopReason
   check is gated on `mode === "text"` (print-mode.ts:129). Failure detection must
   come from the event stream: last assistant message `stopReason: "error"/"aborted"`
   (+ `errorMessage`), or a missing `agent_end`. Exit 1 only means Pi itself
   crashed/misconfigured (no auth, bad model, extension load failure).
2. **Project trust**: non-interactive runs apply `defaultProjectTrust` silently.
   Always pass `--no-approve` for jobs over arbitrary checkouts so `.pi/settings.json`,
   project extensions, and project skills are never loaded — don't rely on the
   default, a user's global setting or prior `/trust` could flip it.
   (v2 verify: a host-shipped `-e` extension must still load under `--no-approve`;
   it's a CLI resource, not a project resource, but confirm before shipping.)
3. **No job timeout flag** — we enforce wall-clock and SIGTERM ourselves (existing
   posture).
4. **Stdin merge quirk**: piped stdin is concatenated to the argv prompt with NO
   separator (initial-message.ts:20-43) — append our own newline if we ever pipe
   diff context.
5. **Release cadence is near-daily (0.80.x)** — treat undocumented internals as
   unstable; our surface (CLI flags + JSON events) is documented, but pin
   expectations to documented behavior only.
6. **No permission prompts exist in Pi at all** (by design; README: "No permission
   popups. Run in a container"). Irrelevant for jobs (fire-and-forget), relevant if
   we ever deepen the Ask-AI provider.

## Integration sketch (v1: third marker engine)

Everything below was seam-mapped with file:line refs in the Plannotator-side report:

1. `packages/server/marker-review.ts` — add the `pi` `MarkerEngine` descriptor
   (six fields): `binary: "pi"`,
   `buildArgv: ["--mode","json","--no-session","--no-approve",...model flags,"-p",prompt]`,
   `extractText` reading assistant text from Pi's `message_end`/`message_update`
   events, `formatLogEvent` over the same events, `modelsArgv`/`parseModels`
   (table-parse, or wire capabilities to the existing pi-sdk `fetchModels`).
   For tour/guide read-only runs the argv gains `--tools read,grep,find,ls` —
   note `buildArgv` today doesn't take a read-only param; thread it or handle in
   the guide/tour branch.
2. `packages/server/agent-jobs.ts:57-64` — add `"pi"` to `SERVER_BUILT_PROVIDERS`.
   Capability entry + lazy model discovery come free via the `MARKER_ENGINES` loops.
3. `packages/server/review.ts` — widen the two `as "cursor"|"opencode"` casts; the
   marker fallthrough branch handles `pi` with zero new code.
4. `packages/server/guide/guide-review.ts` — widen the engine union + two casts
   (guide already supports marker engines).
5. `packages/server/tour/tour-review.ts` — tour is claude/codex-only today; adding
   pi to tour means adding marker-engine support to tour first (same gap
   cursor/opencode have — separate decision).
6. UI: `useAgentSettings` `PiSection` (flat `{model}`, cursor-style), widen
   `ReviewEngine`/`REVIEW_ENGINES`; `AgentsTab` label/icon maps (a `PiIcon`
   already exists from the Ask-AI provider), `piAvailable`, cursor-style model
   catalog wiring; `GuideEmptyState` `ENGINE_LABEL` entry (engine list derives
   from it).
7. Pi mirror: `marker-review.ts` vendors automatically; hand-mirror the
   `SERVER_BUILT_PROVIDERS` + cast widenings in `apps/pi-extension/server/
   {agent-jobs,serverReview}.ts`. Note the recursion: the Pi extension would be
   able to spawn a nested `pi` job from inside a Pi session — architecturally
   identical to spawning cursor from inside Claude Code today; the child inherits
   `PLANNOTATOR_AGENT_SOURCE`/`PLANNOTATOR_API_URL` like every job. No
   special-casing needed, worth one test.

**v2 upgrade (schema-native)**: ship a small finish-tool extension per job schema
(review findings / guide / tour), load with `-e`, parse the terminating tool's
validated result from `tool_execution_end` instead of marker text. This moves Pi
out of the marker fallthrough into its own branch (like claude/codex) — do it
once v1 proves demand.

## Pi vs Flue (why this one's a yes)

| | Pi | Flue |
|---|---|---|
| Is a coding agent we can delegate to | Yes (its whole point) | No (harness framework; we'd author the agent) |
| Headless one-shot | `-p` / `--mode json` | `flue run` (requires embedded project + Vite build) |
| Structured output | marker now, blessed finish-tool extension later | valibot-native (best) but behind project authoring |
| Auth | rides user's existing Pi login (OAuth subs or keys) | raw API keys / manual token env vars |
| Runtime | plain Node CLI, spawnable from Bun; no install burden beyond `pi` itself | Node ≥22.18 + node_modules + build step; Bun rejected |
| License / maturity | MIT, 0.80.3, daily releases | Apache-2.0, 1.0.0-beta.1, breaking churn |
| Fits existing seams | drops into MARKER_ENGINES nearly as-is | new bespoke provider machinery |

## Recommendation

Green-light v1 (marker engine). It's a contained change on well-worn seams, serves
an actual user request, is zero-config for Pi users, and read-only enforcement is
better than our existing marker engines. Defer tour support (needs tour marker
plumbing first) and the schema-native extension to a fast-follow.
