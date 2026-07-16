# Synthesis: Flue as a Plannotator agent-job provider

Date: 2026-07-02
Subject: /Users/ramos/oss-agents/flue (`@flue/runtime` 1.0.0-beta.1, Apache-2.0)
Method: shallow breadth dive + three deep-dive subagent reports (runtime execution
model; CLI headless invocation; SDK/HTTP surface + ops).

## What Flue is (and isn't)

Flue is a TypeScript **agent-harness framework**: you author agents/workflows as
code (`createAgent`, valibot-typed tools/skills, sandboxes), the `flue` CLI builds
them (Vite codegen) into a Hono server, and its own loop (via
`@earendil-works/pi-agent-core` / `pi-ai`) calls model APIs directly. It is NOT a
coding-agent CLI like claude/codex/cursor/opencode — there is no third-party agent
to delegate to. Adopting Flue means Plannotator authors and maintains its own
small agent.

## Verdict

**Shape A (spawned job provider): feasible, with real costs.**
**Shape B (Ask-AI session provider): not feasible today.**

## Decisive facts

### For (shape A)
- **True one-shot exists**: `flue run <workflow> --target node --payload '{...}'`
  builds, runs the workflow to completion, prints ONE clean JSON blob (the
  workflow's return value) to stdout, progress to stderr, exit 0/1/130/143.
  Corroborated by code (bin/flue.ts:1361-1404) and the GitHub Actions deploy doc.
- **Best-in-class structured output**: `session.prompt(text, { result: <valibot
  schema> })` injects `finish`/`give_up` tools derived from the schema, validates
  with the original schema, and **feeds validation failures back to the model for
  retry** (result.ts:159-303). Stronger than claude's `--json-schema` and far
  stronger than our nonce marker contract — no marker fallback needed.
- **Arbitrary repo cwd confirmed**: `local({ cwd })` binds bash/read/write/edit/
  grep/glob to any absolute path with real child_process semantics; process-group
  kill on abort/timeout. Env is allowlisted (secrets must be explicitly forwarded).
- **Live logs**: our jobs engine already streams stderr into `job:log` — Flue's
  ANSI progress text would flow through today (needs ANSI stripping; it is not
  NDJSON, so no structured log events without the two-process
  `flue logs --format ndjson` dance against a spawned server).
- Apache-2.0, no telemetry/phone-home.

### Against / costs
1. **We become the agent author.** An embedded Flue project (one workflow, one
   agent definition, prompt plumbing, read-only tool policy) becomes Plannotator
   code to maintain — vs. today's providers where the agent behavior ships with
   the third-party CLI.
2. **Auth regression**: pi-ai reads raw API keys from env (`ANTHROPIC_API_KEY`,
   ...) or `ANTHROPIC_OAUTH_TOKEN` (takes precedence). **No code path borrows the
   user's logged-in Claude Code / Codex CLI credentials.** Today's providers ride
   existing CLI logins; a Flue provider would demand key management from users
   (or fragile token extraction on our side).
3. **Runtime + distribution burden**: Node ≥22.18 required, **Bun explicitly
   rejected** (fine for spawning, but a new user-machine dependency); the embedded
   project needs installed node_modules and a Vite build (every `flue run`
   rebuilds; avoidable by pre-building at install and spawning
   `node dist/server.mjs` + one `POST /workflows/:name?wait=result`). Precedent
   exists: `plannotator install-runtime agent-terminal` already manages a Node
   runtime install.
4. **Read-only enforcement is custom work**: no flag disables write/edit/bash;
   requires a custom `SandboxFactory.tools` reimplementing read/grep/glob via
   `defineTool()` (Flue's own tool impls are not exported).
5. **Beta churn**: 1.0.0-beta.1 (2026-06-16) after a fast-breaking 0.x cadence;
   the in-process embedding seam (`createFlueContext`) is explicitly internal.
6. **Model catalog**: no `flue models`; we'd curate a list against pi-ai's catalog.

### Why shape B is dead (for now)
- `@flue/sdk` is an HTTP client to a Flue-owned server, not an embeddable runtime;
  the session-construction APIs live at `@flue/runtime/internal` marked "never
  import from here."
- **No tool-permission/human-in-the-loop hook** — tool events are observational
  only; our interactive approval prompts have no analog.
- **No server-side abort over HTTP** — dropping the connection doesn't stop the
  run (durable admission by design).
- `examples/pi-provider-chat` is unrelated to our Pi integration (it demos pi-ai's
  OAuth-backed model providers).

## If we did it: minimal integration sketch

- Embedded project `packages/server/flue-provider/` (flue.config.ts, one
  `workflows/run-job.ts` taking `{ prompt, repoPath, schemaKind }`, agent with
  `local({ cwd: repoPath })` + curated read-only toolset), built at install time.
- New provider `flue` in `SERVER_BUILT_PROVIDERS` + capability (node ≥22.18 +
  built project present + a configured API key/OAuth token).
- `buildCommand`: spawn pre-built `node dist/server.mjs` per job (ephemeral port)
  + `POST /workflows/run-job?wait=result`; or accept `flue run`'s rebuild cost for
  v1 simplicity (stdout JSON parse, stderr → logs).
- Reuse: guide/tour/review schemas pass through as the workflow's valibot `result`
  schema — one output pipeline, no marker parsing.

## Recommendation

Not worth adopting as a peer of claude/codex/cursor/opencode **today**: the auth
model (raw API keys vs. riding user CLI logins) and the author-your-own-agent
burden outweigh the structured-output win, and the API is still churning pre-1.0.
Revisit if/when (a) Flue ships a public one-shot/embedding API or a stable
`flue run` with machine-readable event output, (b) pi-ai grows credential
borrowing from installed CLIs, or (c) we want a fully-owned, schema-native job
agent badly enough to fund maintaining one — Flue would then be the strongest
harness candidate we've evaluated.
