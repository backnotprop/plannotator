# Recap: Guided Review (ADR 006)

Date: 2026-07-02 · Branch: `feat/guided-review` (uncommitted)

## What was built

Guided Review is now a first-class feature of the code-review app: a `guide`
agent-job provider generates a chaptered review of the current changeset (core
implementation first, consequences next, glue separated), rendered as a screen
takeover — file tree and center dock CSS-hidden, header and right sidebar intact.
Each section pairs a markdown overview with live, annotatable per-file diffs and a
Reviewed checkbox that collapses the section (with peek-to-re-expand that never
un-marks it). Works for PRs and every local diff type; guide title derives from the
PR when present. Annotation parity holds end to end: guide diffs mount the real
`DiffViewer` with file-scoped handlers, land in the same `CodeAnnotation` state, and
export through the same Send Feedback payload.

## How it went together

**Process:** ADR → 4 research spikes (subagent map-reduce) → synthesis → spec →
preflight (first-hand verification of every seam; two spike claims corrected) →
4 implementation phases (subagents on disjoint file sets) → adversarial self-review
(10 findings) → 13-item fix pass → builds green.

**Server** (`packages/server/guide/guide-review.ts`, mirroring the tour module):
`GUIDE_REVIEW_PROMPT` + `GUIDE_SCHEMA_JSON` (real file refs — never fabricated
hunks), `buildGuideUserMessage` with a changed-file list (from a new
`listPatchFiles` in `packages/shared/review-core.ts`), Claude/Codex command
builders, defensive output sanitization, and `createGuideSession()` whose ingest
validation drops fabricated paths, dedupes first-placement-wins, computes
`unplacedFiles` so every changed file appears exactly once, and fails closed
(`GUIDE_EMPTY_OUTPUT_ERROR`) when nothing survives. Wired via the existing seams:
`SERVER_BUILT_PROVIDERS`, a `guide` capability, `provider === "guide"` branches in
`buildCommand`/`onJobComplete` (validated against the *current* patch at completion,
matching how the client resolves refs), routes `GET /api/guide/:jobId` +
`PUT /api/guide/:jobId/reviewed`. Pi mirror: `vendor.sh` vendors
`shared/guide.ts` + `guide-review.ts`; `serverReview.ts` and Pi's `agent-jobs.ts`
hand-mirror the branches, routes, and provider registration.

**Client** (`packages/review-editor`): `guideOpen` takeover branch (dock stays
mounted — CSS `hidden`; both tree branches gated), Guide pill badge beside the tree
toggle, `Mod+Shift+G` (registered in `reviewEditorShortcuts` for the docs
generator), auto-open on completion (tour pattern), failed-job error banner in the
empty state, `focusedFilePath` nulled while the guide is open plus a guide-local
focus arbiter. `components/guide/`: `GuideScreen` (empty / generating / view),
`GuideEmptyState` (Notion-like launch page on the `guide*` settings slice),
`GuideGenerating` (live logs + cancel), `GuideView` (+ "Everything else" from
`unplacedFiles`), `GuideSectionCard` (peek semantics), `GuideDiffSection`
(ReviewDiffPanel-shaped adapter using the file-scoped handler variants;
missing file → "outdated" chip; `pendingSelection` gated to the focused viewer).
`useGuideData` copies `useTourData` (debounced reviewed persistence, keepalive
flush, demo fixture gated to DEV). Shared reuse extracted rather than copied:
`AgentControls.tsx` (selector primitives), `renderMarkdownProse.tsx` (tour + guide
prose), exported model catalogs. `useAgentSettings` gained the guide slice and
module-level cross-instance sync (two live consumers now). AgentsTab gained the
Guided Review mode + "Open guide" job-card action threaded through ReviewSidebar.

## Verification

- `bun run typecheck` (all packages, re-vendors Pi): clean.
- `bun test` packages/ui: 308 pass, 0 fail (includes shortcut-registry coverage of
  the new binding); Pi `server.test.ts`: 12 pass.
- `apps/review` + `build:hook` builds green; Tailwind output verified to contain the
  callout selectors after the `@source ./utils` fix.
- Self-review confirmed: launch-snapshot discipline, fail-closed ingest, per-job
  reviewed state, annotation data parity, dock never unmounts, `listPatchFiles`
  path fidelity (renames/deletes/quoted/workspace prefixes).

## Known gaps (accepted for v1)

- Guide + reviewed state are in-memory per server process (tour precedent; durable
  storage deferred by ADR 006).
- Guide diffs render in fixed-height (420px) boxes with internal scroll —
  `DiffViewer` fills bounded parents; revisit sizing after real use.
- Sidebar annotation clicks can't reveal a collapsed section's diff; no
  search/`lineStart` scroll targeting inside guide viewers in this pass.
- Auto-open fires on SSE snapshot replay after reload (tour-parity behavior).
- Marker engines (cursor/opencode) are not guide generators.

## Reference files

- ADR: `adr/decisions/006-guided-review-first-class-feature-20260702-192821.md`
- Spikes: `adr/research/SPIKE-guide-{provider-tour-pattern,launch-settings-reuse,diff-annotation-reuse,takeover-layout}-20260702-194831.md`
- Synthesis: `adr/research/synthesis-guided-review-20260702-195351.md`
- Spec (updated through preflight + fixes): `adr/specs/guided-review-20260702-195351.md`
- New code: `packages/shared/guide.ts`, `packages/server/guide/`,
  `packages/review-editor/components/guide/`, `packages/review-editor/hooks/guide/`,
  `packages/review-editor/demoGuide.ts`,
  `packages/review-editor/utils/renderMarkdownProse.tsx`,
  `packages/ui/components/AgentControls.tsx`
