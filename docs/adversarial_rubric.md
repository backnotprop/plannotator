# Adversarial Rubric

Last Updated: 2026-04-17

This rubric captures the main adversarial and drift vectors for Plannotator's review and annotation surfaces. It is intended for milestone reviews, especially for UI state changes that can unintentionally cross plan, annotate, archive, and review modes.

## Data Boundaries

| Boundary | Format | Validation | Failure Mode |
| --- | --- | --- | --- |
| `/api/plan`, `/api/feedback`, `/api/draft`, `/api/upload` between browser and Bun server | JSON, multipart form data, markdown text | Per-endpoint parsing in `packages/server/index.ts`, `packages/server/annotate.ts`, `packages/server/shared-handlers.ts` | Invalid payloads can silently fall back to demo/empty state or reject late in the flow |
| Linked-doc file resolution via `/api/doc` and Obsidian doc endpoints | Relative/absolute markdown paths | `packages/server/reference-handlers.ts`, `packages/shared/resolve-file.ts` normalize and constrain paths | Path confusion can open the wrong file or expose unintended content if guards drift |
| Share/import URLs and paste payloads | URL hash, compressed JSON, encrypted blobs | `packages/ui/utils/sharing.ts` parses, decompresses, decrypts, and reconstructs annotations | Malformed share payloads can break annotation restore or produce partial state |
| External annotations stream and snapshot APIs | SSE + JSON annotations | `packages/server/external-annotations.ts`, shared annotation types in `packages/shared/external-annotation.ts` | Unsanitized/invalid annotation payloads can corrupt UI state or highlight bookkeeping |
| Cookie-backed UI preferences | Strings in `document.cookie` | `packages/ui/utils/storage.ts`, `packages/ui/utils/uiPreferences.ts`, `packages/ui/config/settings.ts` coerce to enums/bools | Invalid cookie values can create inconsistent mode/layout defaults across sessions |

## Type Coercion Vectors

| Coercion | Location | Risk | Test Exists? |
| --- | --- | --- | --- |
| Cookie string → boolean / enum | `packages/ui/utils/uiPreferences.ts`, `packages/ui/config/settings.ts` | Invalid values can silently select unsafe defaults or inconsistent layout state | Partial |
| URL hash / paste payload → structured annotations | `packages/ui/utils/sharing.ts` | Malformed arrays or unexpected tuple shapes can restore incomplete/shifted annotations | Partial |
| Query/path input → resolved markdown path | `packages/shared/resolve-file.ts` | Separator normalization and basename fallback can drift from intended trust boundary | Yes |
| External annotation JSON → internal annotation model | `packages/shared/external-annotation.ts` | Missing/extra fields can degrade rendering or selection restoration | Partial |
| Resize/cap values → persisted panel widths | `packages/ui/hooks/useResizablePanel.ts` | Invalid saved widths can distort layout or hide controls | No |

## Trust Assumptions

| Assumption | What Breaks | Severity | Test Exists? |
| --- | --- | --- | --- |
| Annotate-only UI changes will not leak into plan/review/archive modes | Hidden controls or layout regressions in other surfaces | HIGH | No |
| Session-scoped UI modes restore the user’s prior layout exactly | Users lose sidebar/panel context or hidden state drifts | HIGH | No |
| Shared workspace aliases stay aligned across app Vite configs | Local builds fail even though workspace packages compile | MEDIUM | No |
| Linked-doc navigation only needs the sidebar capabilities it declares | Runtime mismatches if hook expectations drift | MEDIUM | No |
| Cookie defaults are benign when malformed or missing | Surprising startup state, especially around sidebar and panel behavior | LOW | Partial |

## Cascade Risks

| Cascade Point | Blast Radius | Isolation | Test Exists? |
| --- | --- | --- | --- |
| Viewer/layout mode toggles in `packages/editor/App.tsx` | Can affect annotate, plan, linked-doc, archive, and sticky-header behavior at once | Manual branching by `annotateMode`, `archiveMode`, `isPlanDiffActive` | No |
| Sticky header lane width calculations | Reader chrome can diverge from document width and overlay controls incorrectly | Separate `StickyHeaderLane` component with measured widths | No |
| Linked-doc state swap and cached annotations | Annotation state can leak between source doc and linked doc | `useLinkedDoc` caches/restores per file | No |
| External annotation highlight replay | DOM highlights can desync when switching linked docs or diff mode | `useExternalAnnotationHighlights` and explicit reset hooks | Partial |

## Registry Drift Risks

| Registry | Code Location | Drift Detection | Last Verified |
| --- | --- | --- | --- |
| Hook/review app workspace aliases | `apps/hook/vite.config.ts`, `apps/review/vite.config.ts` | Manual build of both apps | 2026-04-17 |
| Public API endpoint docs vs runtime endpoints | `AGENTS.md`, marketing docs, `packages/server/*.ts` | Manual review + endpoint additions in PR review | 2026-04-17 |
| Shared package exports vs app imports | `packages/shared/package.json` and app/package imports | Typecheck/build | 2026-04-17 |
| UI preference keys vs Settings UI | `packages/ui/utils/uiPreferences.ts`, `packages/ui/components/Settings.tsx` | Manual review | 2026-04-17 |

## Learned Vectors

| Vector | Source Milestone | Category | Recurrence |
| --- | --- | --- | --- |
| Session-scoped layout modes can mutate hidden panel state unless every reopen path exits the mode first | `feat/annotate-wide-mode` | Cascade / Trust Assumption | Likely |
| Annotate-only controls must be explicitly gated to avoid leaking into plan/review surfaces through shared components | `feat/annotate-wide-mode` | Trust Assumption | Likely |
| Build-time alias drift can look like a feature regression even when the code change is correct | `feat/annotate-wide-mode` | Registry Drift | Likely |
