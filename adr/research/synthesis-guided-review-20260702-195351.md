# Synthesis: Guided Review

Date: 2026-07-02
Feeds: ADR 006 (`adr/decisions/006-guided-review-first-class-feature-20260702-192821.md`)
Sources:
- `SPIKE-guide-provider-tour-pattern-20260702-194831.md`
- `SPIKE-guide-launch-settings-reuse-20260702-194831.md`
- `SPIKE-guide-diff-annotation-reuse-20260702-194831.md`
- `SPIKE-guide-takeover-layout-20260702-194831.md`

## Verdict

The ADR's scope calibration holds. Every subsystem the feature needs exists and has a
proven seam for exactly this kind of extension. The implementation is one new server
module, one new provider branch in existing seams, one new layout branch in App.tsx,
and a handful of new components that compose existing ones. Two small refactors, zero
rewrites.

## What the spikes agreed on

**1. The tour provider is the right skeleton — with one deliberate departure.**
Tour shows the full provider lifecycle: self-contained module (prompt + JSON schema +
per-engine CLI builders + parsers + in-memory session), a single `if (provider === ...)`
branch in `buildCommand` and `onJobComplete` in `packages/server/review.ts`
(review.ts:690-700, 901-914), two result routes (review.ts:1016-1034), and fail-closed
empty-output handling (invalid guide → job `failed`, so the UI never opens a 404).

The departure: **tour anchors embed model-fabricated `hunk` text rendered read-only**
(`DiffHunkPreview`, zero annotation wiring). That violates our hard constraint. The
guide schema must reference the real changeset — file paths (validated against the
current `DiffFile[]`) — so sections render live slices of the actual patch through the
existing annotation pipeline.

**2. Diff + annotation reuse is nearly free.**
`DiffViewer` is already dock-agnostic; all dock coupling lives in the ~110-line
`ReviewDiffPanel` wrapper. The guide needs its own equally-thin adapter, one
`DiffViewer` per referenced file. `useAnnotationToolbar` already supports multiple
simultaneous instances (module-level draft `Map`s keyed by `filePath`, arbitrated by
`isFocused`). `ReviewStateProvider` wraps the whole app body, so a guide screen inside
it gets annotations/jobs/config for free. `DiffFile.patch` is a self-contained
single-file patch — `state.files.find(f => f.path === path)` is the whole anchor-
resolution story for v1. `AllFilesCodeView`/`CodeView` is the wrong tool at 1–5 files
per section.

**3. The takeover is a layout branch, not an overlay, and the dock must be CSS-hidden.**
`TourDialog`/`PRSwitchOverlay` are `fixed inset-0` overlays — wrong model for a primary
mode. The guide is a conditional branch in the main content row (App.tsx:2671+).
Critical: App.tsx already proves that unmounting `<DockviewReact>` destroys panel/tab
layout (the `files.length === 0` branch rebuilds from scratch on remount). So the
takeover **CSS-hides the dock wrapper** (App.tsx:2793) and file tree rather than
unmounting them. This also keeps diff-switch epoch guards and draft dedup fully
decoupled from `guideOpen`.

**4. Launch machinery reuse is a settings slice plus shared primitives.**
`useAgentSettings` is a plain cookie-backed hook — add `guideEngine`/`guideClaude`/
`guideCodex` mirroring the tour slice. The engine/model/effort selectors are inline JSX
in AgentsTab built from local primitives (`ConfigRow`, `SegmentedPicker`, `SelectMenu`);
promote the primitives to a shared file rather than extracting a monolithic launch
component — the Notion-like takeover shouldn't inherit dense sidebar styling.

**5. One SSE connection; completion observed the tour way.**
`useAgentJobs()` has exactly one call site (App.tsx:350). The guide surface consumes
that instance via props/context. Completion detection copies the tour auto-open effect
(App.tsx:780-792): watch shared jobs for `provider === 'guide' && terminal`, dedupe
via ref `Set`.

**6. Pi mirror is two-part and hand-work is unavoidable.**
`vendor.sh` vendors business-logic modules verbatim into `apps/pi-extension/generated/`
(add `packages/server/guide/guide-review.ts` there), but `serverReview.ts` routes are
hand-maintained `node:http` — guide routes get mirrored by hand, same as tour's.

## Identified gaps / refactors (small, bounded)

1. **`isFocused` arbitration is dock-visibility-unaware** (App.tsx:1778,
   ReviewDiffPanel.tsx:22). A hidden dock panel would still claim toolbar focus and
   race the guide's `DiffViewer` for the same file's draft. Fix: gate the dock-side
   `isFocused` on `!guideOpen` (and give guide-side instances their own arbiter).
2. **Log formatter provider check** (`agent-jobs.ts:312-314`) hardcodes providers for
   Claude-engine stdout formatting — `guide` must be added or logs render raw.
3. **Anchor drift**: the guide is generated against a patch snapshot; the diff can
   change under it (agent commits mid-review — the staleness fingerprint exists for
   exactly this). File-level anchors degrade gracefully (path missing → section shows
   an "outdated" chip instead of a diff); line-range anchors would not. One more
   argument for file-level in v1.

## Resolution of ADR 006's deferred questions (proposed)

- **Persistence**: in-memory `Map`s in the guide session (tour precedent), plus
  reviewed-state PUT endpoint. Durable storage stays deferred; the API shape doesn't
  change if we later back it with disk.
- **Single vs multiple guides**: the guide screen shows the latest completed
  `guide` job; regenerate replaces. Older guide jobs remain reachable as jobs
  (results kept per jobId), but the UI models one active guide. Cheap now, doesn't
  foreclose a picker later.
- **Anchor granularity**: file-level for v1, with optional `lineStart`/`lineEnd` per
  diff ref reserved in the schema (rendered as scroll/highlight hints, not slicing).
  Hunk-level slicing only if v1 proves insufficient — and then by slicing real hunks
  from `DiffFile.patch`, never synthesizing.
