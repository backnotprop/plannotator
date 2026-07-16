# SPIKE: Code Tour provider as the template for the Guide provider

Date: 2026-07-02
Status: Verified against code. Feeds spec work off `adr/decisions/006-guided-review-first-class-feature-20260702-192821.md`.

## Question

ADR 006 says the guide agent-job provider should follow the Tour pattern
(`packages/server/tour/`) "rather than inventing a new lifecycle." This spike
documents that pattern end to end, with exact file:line refs, so the guide
provider's spec can cite a checklist instead of re-deriving it.

## 1. `packages/server/tour/tour-review.ts` — the provider module

One file owns: system prompt, JSON schema, user-message builder, CLI command
builders for both engines, output parsers, and a session object that wraps all
of it behind a small interface the jobs engine calls into.

- **`TOUR_SCHEMA_JSON`** (:20-84) — a hand-built JSON Schema string (not derived
  from the TS types), `additionalProperties: false` everywhere, passed verbatim
  to both CLIs' schema flags. Shape: `title, greeting, intent, before, after,
  key_takeaways[], stops[], qa_checklist[]`. Each `stop` has
  `title/gist/detail/transition/anchors[]`; each `anchor` has
  `file/line/end_line/hunk/label` — **`hunk` is a full unified-diff string the
  model must fabricate from the patch it read**, not a pointer into the real
  patch. This is a deliberate schema choice worth flagging (see §7).

- **`TOUR_REVIEW_PROMPT`** (:86-287) — a long, carefully tuned system prompt:
  identity/tone rules (conversational, no em-dashes, no emoji), an "Output
  structure" section walking through every schema field with worked examples,
  a "Pipeline" section (read diff → read CLAUDE.md/README → read commits/PR →
  group into stops → order by reading flow → emit JSON), and a "Hard
  constraints" section restating the non-negotiables (non-empty hunks, no
  fabricated line numbers, one-sentence gist, etc.). ADR 006 explicitly says
  the guide prompt "gets the same level of care" — this is the bar.

- **`buildTourUserMessage`** (:289-338) — dispatches on context shape: PR
  full-stack, PR with local worktree access, PR without local access,
  workspace (multi-repo), or local diff (via
  `getLocalDiffInstruction` from `../agent-review-message`). Each branch
  produces a short instruction + (sometimes) the inlined `patch` in a fenced
  diff block. `buildWorkspaceTourUserMessage` (:340-353) is the multi-repo
  variant.

- **`buildTourClaudeCommand`** (:360-404) — exact argv for the Claude engine:
  ```
  claude -p --permission-mode dontAsk --output-format stream-json --verbose
    --json-schema <TOUR_SCHEMA_JSON> --no-session-persistence
    --model <model> [--effort <effort>]
    --tools Agent,Bash,Read,Glob,Grep
    --allowedTools <comma list: Agent,Read,Glob,Grep,git/jj/gh/glab read-only subcommands,wc>
    --disallowedTools <Edit,Write,NotebookEdit,WebFetch,WebSearch,interpreters,curl/wget>
  ```
  Prompt goes over stdin (`stdinPrompt`), not argv — avoids argv length/escaping
  limits. `captureStdout: true` is required upstream so the jobs engine buffers
  stdout for `parseTourStreamOutput`.

- **`buildTourCodexCommand`** (:423-449) — Codex path writes the JSON schema to
  a materialized file (`ensureTourSchemaFile`, :410-417, memoized so it's
  written once per process) because Codex takes `--output-schema <path>`, not
  an inline schema. Global flags (`-m`, `-c model_reasoning_effort=`, `-c
  service_tier=fast`) must precede the `exec` subcommand. Output goes to a temp
  file via `-o <outputPath>` (`generateTourOutputPath`, :419-421, uses
  `os.tmpdir()` + uuid), not stdout — `--full-auto --ephemeral -C <cwd> <prompt>`.

- **Parsers**:
  - `parseTourStreamOutput` (:451-475) — walks stdout lines **backwards**,
    parses each as JSON, looks for `{ type: "result" }`, bails on `is_error`,
    and — critically — **rejects a parse if `stops` is missing/empty**
    (comment: "A tour with no stops isn't a tour"). Returns `null` on any
    failure; never throws.
  - `parseTourFileOutput` (:477-491) — same empty-stops guard for the Codex
    file-output path; always attempts `unlink(outputPath)` in both the success
    and catch paths (temp file cleanup happens here, not in the jobs engine).
  - `TOUR_EMPTY_OUTPUT_ERROR` (:18) — the calm string surfaced to the job when
    parsing succeeds structurally (exit 0) but yields `null`.

- **`createTourSession()`** (:542-604) — the object review.ts holds one
  instance of (`const tour = createTourSession()` at review.ts:206). Two
  in-memory `Map`s (`tourResults: Map<jobId, CodeTourOutput>`,
  `tourChecklists: Map<jobId, boolean[]>`) — **no persistence, dies with the
  server process**. Exposes:
  - `buildCommand({ cwd, patch, diffType, options, prMetadata, config })` —
    reads `config.engine` (default `"claude"`), `config.model` (falls back to
    `"sonnet"` for Claude, blank for Codex — comment explains why: `"sonnet"`
    is a Claude-only model id and must not leak to Codex), `config.effort`,
    `config.reasoningEffort`, `config.fastMode`. Builds the user message once,
    prepends `TOUR_REVIEW_PROMPT`, then branches engine → returns the
    `TourSessionBuildCommandResult` shape (command/outputPath/stdinPrompt/cwd/
    label/prompt/engine/model/effort/reasoningEffort/fastMode).
  - `onJobComplete({ job, meta })` — picks the parser by
    `job.engine === "codex" ? outputPath : stdout`, stores the result in
    `tourResults`, and returns a `TourSessionJobSummary` (`correctness:
    "Tour Generated"`, `explanation: "<n> stops, <m> QA items"`, `confidence:
    1.0`). Returns `{ summary: null }` on parse failure — no exception, no
    partial write.
  - `getTour(jobId)` — merges the stored `CodeTourOutput` with its checklist
    (defaulting to `[]`), returns `null` if the job's result was never stored.
  - `saveChecklist(jobId, checked)` — blind overwrite, no validation of length
    against `qa_checklist.length`.

## 2. Jobs-engine integration in `packages/server/review.ts`

- `const tour = createTourSession();` — review.ts:206. One instance per review
  server process/session (matches ADR 006's "guide persistence beyond server
  memory" being explicitly deferred).

- `createAgentJobHandler({ mode: "review", ..., buildCommand, onJobComplete })`
  — review.ts:616 opens the whole handler; the outer `buildCommand` closure
  (:621-752) does **state snapshotting before any `await`** (comment at
  :622-624: "Snapshot ALL launch-relevant state before any await: waiting out
  the checkout warmup below yields to other requests"). It snapshots
  `prMetadata`, `currentPatch`, `currentDiffType`, `currentBase`,
  `currentPRDiffScope` into `launch*` locals up front, resolves the requested
  review profile, then (only relevant to PR mode) awaits
  `ensurePRLocalCwd(launchMetadata)` when `options.worktreePool` is set —
  throwing a user-facing error if the PR checkout isn't ready yet ("Local PR
  checkout unavailable... Retry shortly") rather than silently running in the
  wrong directory. It then builds `diffContext` (mode/base/worktreePath, or
  `null` worktreePath for workspace mode, or `undefined` entirely in PR mode
  since `prMetadata` covers it) — this snapshot rides on every provider's job,
  tour included.

  The **`if (provider === "tour")` branch** (:690-700) is the first check in
  the outer switch (before codex/claude/marker branches), and just forwards
  to `tour.buildCommand({ cwd, patch: launchPatch, diffType: launchDiffType,
  options: userMessageOptions, prMetadata: launchMetadata, config })`, then
  splices `prUrl/diffScope/diffContext/reviewProfileId/reviewProfileLabel`
  onto whatever `tour.buildCommand` returned. Tour is the *only* provider that
  delegates its whole `buildCommand` body to an external module — codex/
  claude/marker branches inline their own logic in review.ts.

- **`onJobComplete`** (:754-915) is one big function with a per-provider
  branch at the end. The **`if (job.provider === "tour")` branch** (:901-914)
  calls `tour.onJobComplete({ job, meta })`. If `summary` comes back it's
  assigned to `job.summary` (same field every provider uses — codex/claude/
  marker set `correctness/explanation/confidence` inline, tour's is just
  `{correctness: "Tour Generated", explanation: "<n> stops...", confidence:
  1.0}`). If `summary` is `null`, the branch **flips `job.status = "failed"`**
  and sets `job.error = TOUR_EMPTY_OUTPUT_ERROR` — explicit comment: "the
  client doesn't auto-open a successful-looking card that 404s on
  `/api/tour/:id`." This is the fail-closed precedent the marker-engine branch
  above it explicitly cites in its own comment (:854).

- **Routes** — review.ts:1015-1034, registered inline in the `fetch()` handler
  *before* the generic `/api/diff` route:
  - `GET /api/tour/:jobId` (:1016-1021) — regex match, `tour.getTour(jobId)`,
    404 `{ error: "Tour not found" }` on miss, else the full
    `CodeTourOutput & { checklist }` as JSON.
  - `PUT /api/tour/:jobId/checklist` (:1024-1034) — regex match, parses
    `{ checked: boolean[] }`, calls `tour.saveChecklist` only if `checked` is
    an array, returns `{ ok: true }` or 400 on bad JSON. No validation that
    `checked.length` matches the tour's `qa_checklist.length`.

## 3. `packages/server/agent-jobs.ts` — generic jobs engine touch points

- **`SERVER_BUILT_PROVIDERS`** (:57-63) — `Set(["claude", "codex", "tour",
  "cursor", "opencode"])`. Membership here means: client-supplied `command`
  argv is discarded (:568-571) and a `null`/missing `buildCommand` result is a
  hard error (:561-567), never a silent fallback to client argv. **A guide
  provider must be added to this set** or the `/api/agents/jobs POST` handler
  will accept and spawn arbitrary client-supplied commands for it.

- **Capability entry** (:158-162) — `{ id: "tour", name: "Code Tour",
  available: !!Bun.which("claude") || !!Bun.which("codex") }`. Availability is
  OR'd across both engines the provider can use (unlike codex/claude
  capabilities which each gate on their own binary). A guide entry follows the
  same OR shape if it also supports both engines.

- **`AgentJobHandlerOptions.buildCommand` return shape** (:81-110) — the full
  set of optional fields a provider's builder can populate:
  `command/outputPath/captureStdout/stdinPrompt/cwd/label/prompt/engine/
  model/effort/reasoningEffort/fastMode/prUrl/diffScope/diffContext/
  reviewProfileId/reviewProfileLabel`. Tour populates all except
  `reviewProfileId/Label` are passed through from the outer review.ts wrapper,
  not from `tour.buildCommand` itself (tour.ts doesn't know about review
  profiles).

- **`spawnJob`** (:202-412) — generic process lifecycle. Notable for a new
  provider:
  - stdout capture is opt-in via `captureStdout` (:237, :244) — Codex-style
    providers that write to a file instead don't need it; Claude-engine tour
    jobs *do* set it (mirrors the Claude review path).
  - The stdout-formatting `emitLogLine` closure (:310-333) has an explicit
    tour carve-out: "Tour jobs with the Claude engine also stream Claude
    JSONL, so key off engine too" (:312-314) — checks
    `provider === "claude" || spawnOptions?.engine === "claude"` to route
    through `formatClaudeLogEvent`. **A guide provider using the Claude engine
    needs the identical `|| spawnOptions?.engine === "claude"` check added**,
    or its live log stream will render raw JSONL instead of formatted text.
  - Exit handling (:354-398) calls `onJobComplete` only on `exitCode === 0`;
    tour's fail-closed (`job.status = "failed"` on empty output) happens
    *inside* `onJobComplete`, not here — the generic engine still marks the
    job `"done"` first (:364) and lets the provider's `onJobComplete`
    downgrade it after ingestion runs synchronously before the
    `job:completed` broadcast (:395).

- **`POST /api/agents/jobs` body validation** (:520-653) —
  `KNOWN_JOB_FIELDS` (:527-531) is `["provider", "command", "label", "engine",
  "model", "reasoningEffort", "effort", "fastMode", "reviewProfileId"]`; any
  other key in the request body 400s. **If the guide launch needs a
  provider-specific field not in this list (unlikely, given tour needed
  none), it must be added here too.**

## 4. Shared types

- **`packages/shared/tour.ts`** (61 lines, full file read) — pure interfaces,
  no logic: `TourDiffAnchor`, `TourKeyTakeaway`, `TourStop`, `TourQAItem`,
  `CodeTourOutput` (the agent's raw output), and `CodeTourData = CodeTourOutput
  & { checklist: boolean[] }` (the UI-side shape after checklist is merged
  in). A guide equivalent (`GuidePage`, `GuideDiffSlice`?, `GuideOutput`,
  `GuideData = GuideOutput & { reviewed: boolean[] }`) is the direct parallel.

- **`packages/shared/agent-jobs.ts`** (156 lines, full file read) — the
  provider-agnostic job model. Relevant fields on `AgentJobInfo` (:31-82):
  `provider: string` (free-form id, "tour" today), `engine?: string` ("set
  when provider is 'tour'" per the doc comment at :39 — **this comment will
  need updating to mention guide too**), `model/effort/reasoningEffort/
  fastMode` (all provider-agnostic, reused verbatim by tour). `source` is
  `jobSource(id) = "agent-" + id.slice(0,8)` (:141-143) — used to tag
  annotations created by a job; a guide provider likely doesn't ingest
  annotations directly (guide pages aren't findings), so `source` may go
  unused for it, which is fine — it's still assigned uniformly by `spawnJob`.
  `markJobReviewFailed` (:153-156) is the Tour-precedent fail-closed helper,
  explicitly commented as reusable ("Code Tour precedent") — the marker-engine
  path in review.ts inlines the same pattern by hand instead of calling this
  helper (worth normalizing when adding guide, not required).

## 5. Client side

- **`packages/review-editor/hooks/tour/useTourData.ts`** (full file, 107
  lines) — `useTourData(jobId)` hook: fetches `/api/tour/:jobId` on mount
  (short-circuits to `DEMO_TOUR` when `jobId === DEMO_TOUR_ID`, :29-35),
  derives initial `checked` from `data.checklist` or an all-false array sized
  to `qa_checklist.length` (:44), and debounce-persists checklist toggles
  (500ms, :57-72) plus a synchronous `keepalive: true` flush on unmount
  (:89-103) so a tab-close doesn't drop the last toggle. A guide "Reviewed"
  checkbox hook is a structural clone of this, sized to page count instead of
  QA-item count, hitting a `PUT /api/guide/:jobId/reviewed`-shaped endpoint.

- **`demoTour.ts`** — dev-mode fixture (`DEMO_TOUR_ID = 'demo-tour'`,
  `DEMO_TOUR: CodeTourData`) rendered without a live agent job, toggled by
  Cmd/Ctrl+Shift+T in dev (App.tsx :766-777). Useful precedent for iterating
  on the guide takeover screen's visual design before the agent/schema exist.

- **`App.tsx`** dialog-lifecycle wiring (all `import.meta.env.DEV`-gated bits
  aside):
  - `tourDialogJobId` state (:352-353) + `handleOpenTour` (:762-764) opens it.
  - **Auto-open effect** (:779-792) — scans `agentJobs.jobs` on every change,
    and for any `job.provider === 'tour' && job.status === 'done'` not
    already seen (tracked via a `Set` ref, :780, so it only fires once per
    job), calls `setTourDialogJobId(job.id)`. **Note this does not check
    `job.status === 'failed'`** — a failed tour job (including the
    `TOUR_EMPTY_OUTPUT_ERROR` case from §2) never auto-opens anything, it just
    surfaces via the generic agent-jobs status UI. A guide provider's
    auto-open (if the ADR's takeover screen should also auto-open on
    completion) should copy this same done-only, once-per-job-id gating.
  - `<TourDialog jobId={tourDialogJobId} onClose={...} />` (:3125) rendered
    unconditionally at the App root, alongside the dev-only demo-tour toggle
    button (:3127-3136). ADR 006 wants a **screen takeover** (hiding file
    tree + center dock, not an overlay dialog) — structurally this means the
    guide surface is a sibling to `TourDialog` in the render tree, but it
    needs to reach into the layout state that currently lives inside the dock
    machinery to actually hide the tree/dock rather than floating over them.
    That plumbing does not exist yet for Tour (`TourDialog` is a pure overlay,
    z-stacked over everything, not a layout replacement) — this is a real gap,
    not just a reuse point.

- **`packages/ui/components/AgentsTab.tsx` — `buildTourLaunch`** (:815-823):
  ```ts
  const buildTourLaunch = (): LaunchParams => ({
    provider: 'tour',
    label: 'Code Tour',
    engine: tourEngine,
    model: tourEngine === 'claude' ? tourClaudeModel : tourCodexModel,
    ...(tourEngine === 'claude'
      ? { effort: tourClaudeEffort }
      : { reasoningEffort: tourCodexReasoning, ...(tourCodexFast && { fastMode: true }) }),
  });
  ```
  Fed into the generic launch button at :837 (`selectedMode === 'review' ?
  buildReviewLaunch(reviewEngine) : buildTourLaunch()`), which POSTs to
  `/api/agents/jobs`. Capability gating: `tourAvailable` (:648) reads
  `capabilities.providers.find(id === 'tour').available`; `availableModes`
  (:685-690) only offers `'tour'` as a mode when `tourAvailable &&
  availableEngines.length > 0` (i.e., Claude or Codex CLI present). The
  mode-reconciliation effect (:702-724) snaps back to an available mode/engine
  if capabilities change under the user (e.g. a CLI gets uninstalled
  mid-session). **All of `AgentMode`/`AgentEngine` union types, the
  engine/model/effort state variables (`tourEngine`, `tourClaudeModel`, etc.,
  via some settings-persistence hook above :590), and this whole gating block
  need a `'guide'` sibling** — likely copy-modify given how tightly
  `tour`-specific state threads through this ~1200-line component today.

## 6. Pi extension — confirmed, tour IS mirrored, via vendoring not by hand

CLAUDE.md's "both server implementations must be updated" rule is satisfied
for Tour **not** by a hand-maintained duplicate of `tour-review.ts`, but by a
**build-time vendoring step**: `apps/pi-extension/vendor.sh` (source-of-truth
comment: "Vendor shared modules into generated/ for Pi extension. Single
source of truth"). Relevant excerpt:

```bash
# packages/shared/*.ts copied verbatim (with a "@generated" header) —
# "tour" and "agent-jobs" are both in this list:
for f in ... external-annotation agent-jobs ... tour ...; do
  cp "../../packages/shared/$f.ts" -> "generated/$f.ts" (with header)
done

# packages/server/tour/tour-review.ts copied with sed-rewritten imports
# (parent-relative "../vcs", "../pr", "../agent-review-message" and the
# "@plannotator/shared/tour" alias all get remapped to the flat generated/
# layout):
for f in tour-review; do
  cat "../../packages/server/tour/$f.ts" | sed \
    's|from "\.\./vcs"|from "./review-core.js"|; ...' \
    > "generated/$f.ts"
done
```

So `apps/pi-extension/generated/tour-review.ts` and
`apps/pi-extension/generated/tour.ts` are **exact copies** of the Bun-side
source (modulo import paths), regenerated by `vendor.sh` on every Pi build
(`package.json` build script runs `bash vendor.sh`). This means:

- `TOUR_REVIEW_PROMPT`, `TOUR_SCHEMA_JSON`, the CLI command builders, and the
  parsers are **never hand-duplicated** for Pi — they're the same file,
  copy-pasted by a script, not re-implemented.
- What **is** hand-written twice is the HTTP-layer glue:
  `apps/pi-extension/server/agent-jobs.ts` (imports from
  `../generated/agent-jobs.js`, has its own `SERVER_BUILT_PROVIDERS` Set
  including `"tour"` at :49, its own capability entry `{ id: "tour", ...
  available: whichCmd("claude") || whichCmd("codex") }` at :144) and
  `apps/pi-extension/server/serverReview.ts` (imports
  `createTourSession`/`TOUR_EMPTY_OUTPUT_ERROR` from
  `../generated/tour-review.js` at :103, instantiates its own
  `const tour = createTourSession()` at :590, has its own `provider === "tour"`
  branches in `buildCommand`/`onJobComplete` at :710-711/:916-917 mirroring
  review.ts almost line-for-line but against `node:http`'s `req`/`res` instead
  of `Request`/`Response`, and its own `GET /api/tour/:jobId` +
  `PUT /api/tour/:jobId/checklist` routes at :959-977).

**Implication for the guide provider**: the schema/prompt/parser module
(analogous to `tour-review.ts`) gets Pi support "for free" by adding its
filename to the two `for f in ...` loops in `vendor.sh` (the shared-types loop
for `packages/shared/guide.ts`, and the server-tour-style loop for
`packages/server/guide/guide-review.ts`, with whatever import-path `sed`
rewrites its actual imports need — check what it imports from
`agent-review-message.ts`/`vcs.ts`/`pr.ts` first). The HTTP-layer wiring
(`SERVER_BUILT_PROVIDERS`, capability entry, `buildCommand`/`onJobComplete`
branches, `/api/guide/:jobId` + `/api/guide/:jobId/reviewed` routes) **must
still be hand-written a second time** in `apps/pi-extension/server/agent-
jobs.ts` and `apps/pi-extension/server/serverReview.ts`, mirroring
`packages/server/agent-jobs.ts` / `packages/server/review.ts` — there is no
shared HTTP layer between Bun and Node here, by design (per CLAUDE.md's
"Server Runtimes" section: Pi "mirrors the Bun server's API but uses
`node:http` primitives instead of Bun's `Request`/`Response` APIs").

## 7. Implications for a guide provider

### Checklist — every file/integration point to touch

**New module** (mirrors `packages/server/tour/tour-review.ts`):
- [ ] `packages/shared/guide.ts` — `GuidePage`/`GuideDiffSlice`/`GuideOutput`/
      `GuideData` types (mirrors `packages/shared/tour.ts`).
- [ ] `packages/server/guide/guide-review.ts` — `GUIDE_SCHEMA_JSON`,
      `GUIDE_REVIEW_PROMPT`, `buildGuideUserMessage` (can likely reuse
      `getLocalDiffInstruction`/`buildWorkspacePromptContextLines` from
      `agent-review-message.ts` verbatim), `buildGuideClaudeCommand` /
      `buildGuideCodexCommand` (near-identical argv to tour's, same
      allow/disallow tool lists), `parseGuideStreamOutput` /
      `parseGuideFileOutput` (same empty-check discipline: no pages = invalid),
      `GUIDE_EMPTY_OUTPUT_ERROR`, `createGuideSession()` with
      `guideResults`/`guideReviewed` maps and the same
      `buildCommand`/`onJobComplete`/`getGuide`/`saveReviewed` interface shape.

**Bun server wiring** (`packages/server/review.ts`):
- [ ] Instantiate `const guide = createGuideSession();` alongside the tour one.
- [ ] `if (provider === "guide")` branch in the `buildCommand` closure,
      forwarding the same snapshotted `launchPatch/launchDiffType/
      userMessageOptions/launchMetadata/config`.
- [ ] `if (job.provider === "guide")` branch in `onJobComplete`, same
      fail-closed pattern (empty output → `job.status = "failed"`).
- [ ] `GET /api/guide/:jobId` and `PUT /api/guide/:jobId/reviewed` routes
      (mirrors :1016-1034), documented in CLAUDE.md's Review Server endpoint
      table.

**Generic jobs engine** (`packages/server/agent-jobs.ts`):
- [ ] Add `"guide"` to `SERVER_BUILT_PROVIDERS` (:57-63).
- [ ] Add a capabilities entry (same OR-across-engines availability rule as
      tour, :158-162).
- [ ] Extend the `emitLogLine` Claude-engine check (:312-314) to also cover
      `spawnOptions?.engine === "claude"` when `provider === "guide"` — i.e.
      change the condition to check engine regardless of provider, or
      explicitly add `provider === "guide"` alongside `"claude"`. (Cleanest
      fix: key entirely off `spawnOptions?.engine === "claude"`, drop the
      provider check — verify no other provider needs the old behavior first.)
- [ ] If a guide-specific config field is needed, add it to
      `KNOWN_JOB_FIELDS` (:527-531).

**Shared types** (`packages/shared/agent-jobs.ts`):
- [ ] Update the doc comment on `AgentJobInfo.engine`/`model` (:38-42) to
      mention "guide" alongside "tour" (comment currently hardcodes "tour").

**Pi extension**:
- [ ] Add `guide-review` (or whatever the file's named) to the sed-rewrite
      loop in `apps/pi-extension/vendor.sh`, and `guide` to the
      `packages/shared/*` copy loop.
- [ ] Hand-port the same `buildCommand`/`onJobComplete` branches and
      `/api/guide/*` routes into `apps/pi-extension/server/agent-jobs.ts` and
      `apps/pi-extension/server/serverReview.ts` — no shortcut here, this is
      manual duplication by design.

**Client**:
- [ ] `packages/review-editor/hooks/guide/useGuideData.ts` — clone of
      `useTourData.ts`, `reviewed: boolean[]` sized to page count instead of
      `checklist` sized to QA-item count.
- [ ] Guide takeover screen component — **not** a `TourDialog`-style overlay;
      per ADR 006 it must hide the file tree + center dock, which means
      hooking into whatever layout/dock-visibility state
      `packages/review-editor/dock/` exposes (no existing precedent — Tour
      never did this).
- [ ] `App.tsx` — state + open/close handlers for the takeover screen,
      analogous to `tourDialogJobId`/`handleOpenTour`/the auto-open effect
      (:352-353, :762-764, :779-792) but gated on `job.provider === 'guide'`.
      Decide deliberately whether failed-job auto-open should differ from
      Tour's silent no-op.
- [ ] `packages/ui/components/AgentsTab.tsx` — `buildGuideLaunch` alongside
      `buildTourLaunch` (:815-823), a `'guide'` value in whatever `AgentMode`
      union backs `selectedMode`, its own engine/model/effort state variables,
      and inclusion in the `availableModes`/capability-gating logic
      (:646-724). This file is already the densest single touch point for
      Tour; expect the same for guide.
- [ ] Marketing/docs: if guide gets a keyboard shortcut (entry point is a
      header badge per ADR 006), define it in
      `packages/ui/shortcuts/code-review/` following the existing
      `tourDialog.shortcuts.ts` precedent, wired via `useShortcutScope` at the
      call site.

### Awkwardness in the Tour pattern — do not copy

1. **Anchors are fabricated diff text, not real patch pointers.** The schema's
   `hunk` field (tour-review.ts :56, :210-223) asks the model to retype a
   unified diff hunk from what it read, rather than referencing
   file+line-range into the actual patch the server already holds. This is
   why `TourStopCard.tsx` renders anchors via `DiffHunkPreview.tsx`, which
   feeds the anchor's **fabricated** `hunk` string into `@pierre/diffs`'
   `FileDiff` (`getSingularPatch(anchor.hunk)`) — a real diff-rendering
   component, but fed synthetic text, with **no annotation wiring** (no
   `useAnnotationToolbar`, no `CodeAnnotation` list hookup). ADR 006's
   "annotation parity is a hard constraint" directly rules this out: guide
   diff slices must reference **real coordinates in the actual review patch**
   (file path + line range, resolved against the live diff already loaded in
   `App.tsx`/`ReviewStateContext`) so the exact same `FileDiff`/`CodeView` +
   `useAnnotationToolbar` + `CodeAnnotation` + `/api/feedback` machinery used
   elsewhere in the app can render them, live and annotatable, instead of a
   second read-only preview component. This is also the ADR's explicitly
   deferred question ("the anchoring granularity of guide diff slices back
   into the real patch — file-level vs. hunk-level") — resolve it in favor of
   anchoring into the real patch, not schema-level hunk fabrication.
2. **In-memory-only storage with no eviction.** `tourResults`/
   `tourChecklists` are plain `Map`s that live for the process lifetime with
   no cap, no TTL, no persistence. ADR 006 flags this as deferred for guide
   too ("guide persistence beyond server memory... may warrant durability")
   — worth deciding up front whether guide should persist to
   `~/.plannotator/` given guides are more expensive to regenerate than a
   tour and more likely to be revisited across sessions.
3. **Checklist/reviewed-state save has no shape validation.** `saveChecklist`
   (tour-review.ts :600-602) and the `PUT .../checklist` route (review.ts
   :1024-1034) accept any `boolean[]` with no length check against the
   actual `qa_checklist`/page count. Harmless for tour (worst case: checklist
   UI shows fewer/more boxes than array entries), but worth a bounds check
   for guide if page count drives layout/collapse state more centrally.
4. **`AgentsTab.tsx` state sprawl.** Tour's engine/model/effort selection
   lives as ~10 discrete `useState`-like variables threaded through one
   already-large component (:590-618, :646-738, :815-823, :1010-1036).
   Copy-modifying this for guide is the path of least resistance but
   compounds the file's size; if guide's settings surface is meant to be
   simpler (ADR 006 says "same engine/model/effort settings," so maybe not
   simplifiable), at least group the per-provider state behind a small
   struct/reducer instead of adding another ten loose variables.
