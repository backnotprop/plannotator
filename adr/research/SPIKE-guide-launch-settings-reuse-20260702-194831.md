# SPIKE: Reusing agent-job launch UI + settings machinery for the Guide empty state

Date: 2026-07-02

## Question

ADR 006 (Guided Review) says the empty state's launch controls reuse "the exact same agent-job settings machinery" as the Agents tab, launching through the existing agent-jobs infra with a new `guide` provider. What exactly is reusable, what's coupled to the Agents-tab dock context, and what does a from-scratch guide launch surface actually need to wire up? This spike documents the launch UI + settings stack end to end so the guide empty-state implementation can cite exact call sites instead of re-deriving them.

## 1. `AgentsTab.tsx` — mode, settings, capabilities, launch, job list

File: `packages/ui/components/AgentsTab.tsx` (1122 lines).

**Mode selection.** `AgentMode = 'review' | 'tour'` (from `useAgentSettings`, defined in `packages/ui/hooks/useAgentSettings.ts:44`). `availableModes` (line 685) is derived from live capabilities: `review` is offered iff `availableReviewEngines.length > 0`; `tour` iff `tourAvailable && availableEngines.length > 0`. Rendered as a `SelectMenu` when >1 mode is available, else a static label (line 947-960). A guide "mode" would slot in the same way — a third entry gated on a `guide` capability.

**Engine/model/effort selectors are NOT a separate component — they're inline JSX in the big return block (lines 937-1121), built from small shared primitives defined earlier in the same file:**
- `ConfigRow` (216) — label+control row, `stacked` variant for full-width controls.
- `SegmentedPicker` (234) — pill picker for small option sets (effort/reasoning).
- `Toggle` (257) — on/off switch (Codex fast mode).
- `SelectMenu` (278) — dropdown+popover, used for engine-model and the review-profile picker.
- `renderEngineSelect<E>` (871) — generic icon-button row, parameterized by engine list + icon/label maps; used for both Tour's narrow (claude/codex) and Review's wide (claude/codex/cursor/opencode) engine sets.
- `renderMarkerEngineConfig` (917) — shared Cursor/OpenCode model-only config block.

None of this is factored into a standalone `<LaunchControls>` component — it's conditionally rendered inline based on `selectedMode` / `reviewEngine` / `tourEngine`. **Model/option catalogs are also module-level consts in this file** (`CLAUDE_MODELS`, `CLAUDE_EFFORT`, `CODEX_MODELS`, `CODEX_REASONING`, `TOUR_CLAUDE_MODELS`, `CURSOR_MODELS`, `OPENCODE_MODELS`, lines 30-92) — not imported from `useAgentSettings` or shared elsewhere. Any second launch surface either re-imports these consts from `AgentsTab.tsx` (they're not currently exported) or duplicates them.

**`useAgentSettings`** — `packages/ui/hooks/useAgentSettings.ts`. Persists via cookie (`getItem`/`setItem` from `packages/ui/utils/storage.ts`, key `plannotator.agents`, line 4), *not* server config — same cookie-based pattern called out in CLAUDE.md's Settings Persistence section (random port per session rules out localStorage). State shape (`AgentSettingsState`, line 50): `selectedMode`, `reviewEngine`, `reviewProfileByEngine` (per-engine, not global — line 55 comment explains why), `tourEngine`, and per-engine sections (`claude`/`codex`/`cursor`/`opencode`/`tourClaude`/`tourCodex`), each with a `model` plus a `perModel` map for model-scoped sub-settings (effort/reasoning/fast) — so switching models remembers that model's last effort choice (`patchClaude`/`patchCodex`, lines 205-220, 239-258). The hook returns flattened getters/setters (`claudeModel`, `claudeEffort`, `setClaudeModel`, …) — this is the "settings machinery" the ADR refers to, and it is trivially reusable standalone: `const settings = useAgentSettings()` works from any component, no context/provider needed (it's plain `useState` + a `useEffect` cookie sync, lines 174-179).

**Capabilities fetching/gating.** `AgentsTab` doesn't fetch capabilities itself — it receives `capabilities: AgentCapabilities | null` as a prop (from `useAgentJobs`, see §2). It derives `claudeAvailable`/`codexAvailable`/`tourAvailable`/`cursorAvailable`/`opencodeAvailable` (lines 646-650) by scanning `capabilities.providers`. Two reconciliation effects (702-724, 730-744) snap stored selections back to something valid when capabilities load or change (e.g. saved engine no longer available → fall back to first available; saved Cursor/OpenCode model id gone from the live catalog → reset to `auto`/`''`).

**`buildReviewLaunch` (780-814) / `buildTourLaunch` (815-823)** — pure functions closing over `settings` + `reviewProfiles` state, each returning an `AgentLaunchParams` (see §2 for the type). Review's shape varies by engine (claude: `model`+`effort`; cursor: optional `model` only if not `auto`; opencode: optional `model` only if non-empty; codex: `model`+`reasoningEffort`+optional `fastMode`), and all four splice in `...review` — `{ reviewProfileId }` only when a non-default profile is selected (line 783), so the server-side default resolution path is exercised by omission, not an explicit `"builtin:default"` string. Tour's builder has no `reviewProfileId` at all — confirmed in §4.

**`profilesLoaded` gate (629, 825-833).** Until `/api/agents/review-profiles` resolves, a *custom* profile pick can't be launch-verified (the id might refer to a since-removed skill), so `canLaunch` (829) holds the button disabled for a non-default `reviewProfileId` until `profilesLoaded` is true. A Default pick has nothing to resolve and never waits. This same gate logic would need duplicating (or extracting) if a guide launch surface also lets the user pick a custom "guide style" profile in the future — but per §4, guide launches today wouldn't touch profiles at all, so this gate is moot for v1.

**Job list rendering** — `JobCard` (458-539): status via `StatusSquare` (colored tile + lucide icon per `AgentJobInfo['status']`, `JOB_STATUS_BG`/`JOB_STATUS_ICON` maps at 159-173), elapsed time via `ElapsedTime` (148-155, a `setInterval` re-render ticker) or a static `formatDuration(endedAt - startedAt)` once terminal, and annotation count badge computed from `externalAnnotations` grouped by `ann.source` (`annotationCounts`, 747-755) matched against `job.source` (the `"agent-{idPrefix}"` string on `AgentJobInfo`). `PendingLaunchCard` (541-568) renders an optimistic "starting" card between click and the server's 201 response.

## 2. `useAgentJobs.ts` — the transport hook

File: `packages/ui/hooks/useAgentJobs.ts`. Fully server-transport-agnostic and reusable from any component (`useAgentJobs(options?: { enabled?: boolean })`).

**`AgentLaunchParams`** (23-33) — the wire contract, POSTed verbatim as JSON to `/api/agents/jobs`:
```ts
type AgentLaunchParams = {
  provider?: string; command?: string[]; label?: string;
  engine?: string; model?: string; reasoningEffort?: string;
  effort?: string; fastMode?: boolean; reviewProfileId?: string;
};
```
`launchJob` (225-242) does the POST, parses `{ job: AgentJobInfo }` from the response (`parseLaunchJob`, 78-82), optimistically upserts it into local `jobs` state, and rejects with a user-facing message (`readResponseError`, 65-76) on non-2xx — `AgentsTab.handleLaunch` (835-857) catches this into `launchError`.

**SSE consumption** (123-223): opens `EventSource('/api/agents/jobs/stream')` on mount, handles `snapshot` / `job:started` / `job:updated` / `job:completed` / `job:log` / `jobs:cleared` event types (`AgentJobEvent` union, `packages/shared/agent-jobs.ts`). `job:log` events append to a `Map<jobId, string>` (`jobLogs`) rather than replacing — streaming stdout deltas. On `onerror`, if no snapshot was ever received it falls back to version-gated polling (`GET /api/agents/jobs?since=N`, 304 when unchanged) — SSE reconnection is otherwise left to the browser's native retry.

**`killJob(id)`** → `DELETE /api/agents/jobs/:id`; **`killAll()`** → `DELETE /api/agents/jobs`. Both are fire-and-forget (errors swallowed — "SSE will reconcile", 249/258).

Return shape: `{ jobs, jobLogs, capabilities, launchJob, killJob, killAll }` — this whole object is what a guide launch surface would consume, and it's the *same* object AgentsTab consumes (see §6 — there's only one instance).

## 3. `/api/agents/capabilities` + lazy marker-model catalogs

Server: `packages/server/agent-jobs.ts`. Handler factory `createAgentJobHandler` (144). Binaries are probed **once at construction** (158-171, `Bun.which(...)`) — `claude`, `codex`, `tour` (available if either claude or codex binary exists), plus one entry per `MARKER_ENGINES` value (cursor, opencode — cursor's binary is actually `agent`, comment at 169), gated additionally by `mode === "review"` (marker engines are review-only, not available in plan/annotate modes).

Marker (Cursor/OpenCode) **model catalogs are NOT probed at construction** — `discoverMarkerModels(engine)` (128-142) spawns `<binary> <modelsArgv>` with a 5s timeout, only from inside `buildCapabilitiesResponse()` (174-186), which is only called on the first `GET /api/agents/capabilities` request, and is memoized in `markerModelsCache` (173) so it only runs once per engine per server lifetime. This is explicitly to avoid blocking review-server startup on a slow/unauthenticated CLI spawn (comment at 119-127). Response shape: `{ mode, providers: AgentCapability[], available: boolean }` where each provider is `{ id, name, available, models? }`.

## 4. Review profiles in the launch flow

`GET /api/agents/review-profiles` (`packages/server/review.ts:1798-1817`) returns `{ profiles: [{ id, label, source, default? }, ...] }` — always includes `BUILTIN_DEFAULT_PROFILE` (`id: 'builtin:default'`) first, then one entry per curated skill (`discoverCuratedSkills()`, `id: 'skill:{name}'`, `source: 'user'`). Client refetches this on mount and after `AddReviewDialog` enables a new skill (`refreshReviewProfiles`, `AgentsTab.tsx:632-644`).

Client → server flow: `AgentsTab` sends `reviewProfileId` only for review-mode launches, and only when it's not the default (`buildReviewLaunch`, line 783). Server (`agent-jobs.ts:597`) threads `body.reviewProfileId` into `config.reviewProfileId` passed to `buildCommand`. In `review.ts:buildCommand` (621), `resolveRequestedReviewProfile(requestedProfileId)` (637, from `./review-skill-loader`) is called **unconditionally at the top of `buildCommand`, before branching on provider** — including for `provider === "tour"` (690-699). This means a tour launch's `reviewProfile` always resolves to the built-in default (Tour never sends `reviewProfileId`, confirmed by `buildTourLaunch`, `AgentsTab.tsx:815-823`, which has no `review` spread), and the resolved `{ id: 'builtin:default', label: 'Default' }` rides along on the tour job's `reviewProfileId`/`reviewProfileLabel` fields (699) purely as job metadata — **it is never consumed by `tour.buildCommand`** (691-698, which takes `cwd`/`patch`/`diffType`/`options`/`prMetadata`/`config` — no `reviewProfile` argument). So: tour launches structurally skip profiles (the resolution happens but is a no-op default that isn't used to shape the prompt); a guide provider following the Tour precedent would do the same — call through this same `buildCommand` path, get a profile resolved and stamped on the job for consistency, but ignore it when building its own prompt.

## 5. Extractability of AgentsTab's engine/model/effort selectors

Not a component today — inline JSX + local primitives (`ConfigRow`, `SegmentedPicker`, `Toggle`, `SelectMenu`, `renderEngineSelect`, `renderMarkerEngineConfig`) all defined in `AgentsTab.tsx` itself, none exported. **Minimal reuse for the guide empty state does not require extracting a shared component.** Two realistic options:

**A. Call `useAgentSettings()` directly + hand-roll guide-specific selects (recommended for v1).** The guide launch surface almost certainly only needs an engine picker (claude/codex) + model + effort — a strict subset of what Tour already renders (Tour's config block, `AgentsTab.tsx:1010-1039`, is nearly this exact shape: `renderEngineSelect` + model `SelectMenu` + effort `SegmentedPicker`/reasoning+fast). `useAgentSettings` would need a small addition — a `guideEngine`/`guideClaude`/`guideCodex` slice mirroring `tourEngine`/`tourClaude`/`tourCodex` (lines 57, 62-63 in the hook) — new cookie fields, additive, no migration risk. The guide surface then imports `useAgentSettings` and re-implements ~30 lines of JSX using the *same visual primitives* by literally copying `ConfigRow`/`SegmentedPicker`/`SelectMenu` (they're small, ~20-60 lines each, no external deps beyond `cn` and lucide icons) or, better, promoting just those four primitives to a shared file (e.g. `packages/ui/components/agentLaunchControls.tsx`) that both `AgentsTab.tsx` and the new guide surface import — a small refactor-then-reuse, not a copy.

**B. Extract a full `<LaunchControls mode="guide">` component out of AgentsTab.** Higher-fidelity reuse but more invasive: would require generalizing `selectedMode`/engine-availability logic to a third mode, threading `guideEngine`/model/effort state through the same conditional-render tree, and risks coupling the takeover screen's styling (which per ADR 006 is "clean, elegant, Notion-like," not the dense sidebar-tab density AgentsTab uses) to AgentsTab's Tailwind classes (`text-[9px]`, `text-[11px]`, etc. — tuned for a narrow sidebar, wrong scale for a full-page takeover). Given the ADR explicitly wants a different visual treatment for the empty state, this path fights the design goal for marginal code reuse.

**Recommendation: A**, promoting only the four small stateless primitives, not the mode/engine orchestration logic — the guide surface has a simpler decision tree (probably no engine choice at all if guide only ships on `claude` initially, per Tour's own initial-engine precedent) and shouldn't inherit AgentsTab's review/tour dual-mode branching.

## 6. Job completion/status observation from another surface

**There is exactly one `useAgentJobs()` call site in the codebase** — `packages/review-editor/App.tsx:350` (confirmed by repo-wide grep). AgentsTab does **not** mount its own hook; it receives `jobs`/`capabilities` as props (`ReviewSidebar.tsx:537` passes them through from `App.tsx:2915-2919`, which itself gets them from the single `agentJobs` object). **Double-mounting `useAgentJobs` in a second component would open a second `EventSource` to `/api/agents/jobs/stream`** — the hook has no dedup/context of its own; nothing prevents two independent SSE connections and two independent snapshots if two components each called it. This is a real risk if the guide surface naively calls `useAgentJobs()` itself.

State fan-out today uses two channels, not one:
1. **Regular React Context** — `ReviewStateContext` (or similar; `agentJobs: agentJobs.jobs` is spread into a context value object at `App.tsx:1854`) carries the low-frequency `jobs` array to dockview panels (e.g. the agent-job detail panel) without prop-drilling through the dockview panel API.
2. **A frequency-split context**, `JobLogsContext` (`packages/review-editor/dock/JobLogsContext.tsx`) — carries only `jobLogs` (the high-frequency, ~200ms SSE log-delta map) separately, explicitly to stop log streaming from re-rendering every dockview panel (comment in the file: "Dan Abramov's split contexts by update frequency"). Only the agent detail panel subscribes to it.

**Tour's own precedent for exactly this "observe completion from elsewhere" problem** already exists and is the direct model for guide: `App.tsx:780-792` —
```ts
const tourAutoOpenRef = useRef(new Set<string>());
useEffect(() => {
  for (const job of agentJobs.jobs) {
    if (job.provider === 'tour' && job.status === 'done' && !tourAutoOpenRef.current.has(job.id)) {
      tourAutoOpenRef.current.add(job.id);
      setTourDialogJobId(job.id);
    }
  }
}, [agentJobs.jobs]);
```
This watches the single shared `agentJobs.jobs` array (already in scope in `App.tsx`, no new subscription) and flips local overlay state (`tourDialogJobId`) when a tour job transitions to `done`, deduped via a ref-backed `Set` so it only fires once per job id. The guide takeover screen would add the identical effect keyed on `provider === 'guide'`, flipping to whatever local state drives the takeover screen's visible/loading/ready phases — no new hook, no new SSE connection, no context change required, since `agentJobs.jobs` is already sitting in `App.tsx`'s scope.

## Implications for the guide launch surface

1. **Do not call `useAgentJobs()` again.** Consume the existing single instance from `App.tsx:350` — pass `agentJobs.jobs`, `agentJobs.capabilities`, `agentJobs.launchJob`, `agentJobs.killJob` down as props to the new guide takeover component, exactly as `ReviewSidebar`/`AgentsTab` already do (`App.tsx:2915-2919`). A second `EventSource` per mounted surface is a real regression to avoid.
2. **Extend `useAgentSettings.ts`** (`packages/ui/hooks/useAgentSettings.ts`) with a `guideEngine`/`guideClaude`/`guideCodex` slice, additive alongside `tourEngine`/`tourClaude`/`tourCodex` (lines 57, 62-63, 78, 84) — same cookie key, same shape, no migration needed since it's new fields with defaults.
3. **Reuse `buildTourLaunch`'s shape, not `buildReviewLaunch`'s** — a guide launch is structurally closer to Tour (single-engine picker, no review-profile involvement) than to Review (four engines, profile picker, per-engine model catalogs). Write `buildGuideLaunch(): AgentLaunchParams` returning `{ provider: 'guide', label: 'Guide', engine, model, effort/reasoningEffort, ...fastMode }` mirroring `AgentsTab.tsx:815-823` almost verbatim.
4. **Server side:** add `"guide"` to `SERVER_BUILT_PROVIDERS` (`packages/server/agent-jobs.ts:57-63`) and a `provider === "guide"` branch in `review.ts`'s `buildCommand` (alongside the existing `provider === "tour"` branch at line 690) — following the Tour pattern the ADR itself calls out (`packages/server/tour/tour-review.ts` as the structural precedent for `packages/server/guide/guide-review.ts`).
5. **Promote only the small stateless primitives** (`ConfigRow`, `SegmentedPicker`, `SelectMenu`, and possibly `Toggle`) out of `AgentsTab.tsx` into a shared file if visual consistency with the Agents tab's controls is wanted — do not extract the mode/engine orchestration logic or attempt a shared `<LaunchControls>` component, since the takeover screen's design intent (full-page, Notion-like) differs enough from the dense sidebar tab that forcing one component to serve both would fight the ADR's own visual goals.
6. **Completion observation:** add a `tourAutoOpenRef`-style effect in `App.tsx` watching `agentJobs.jobs` for `provider === 'guide' && status === 'done'`, deduped via a ref `Set`, driving whatever local state shows the finished guide (probably just flips the takeover screen from "generating" to "ready" in place, since guide is a screen replacement, not an overlay dialog like Tour).
7. **Result retrieval:** follow `GET /api/tour/:jobId` (`review.ts:1017`+) as the precedent for a `GET /api/guide/:jobId` endpoint backed by an in-memory result store populated in `onJobComplete` (`review.ts:754`, mirroring the tour ingestion at line 903) — per ADR 006 this is explicitly deferred territory (persistence beyond server memory), so in-memory-only, Tour-style, is the correct v1 scope.
