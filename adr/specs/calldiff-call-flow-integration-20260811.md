# Optional call-flow review with CallDiff

- Status: implemented (experimental, off by default)
- Date: 2026-08-11
- External engine: CallDiff 0.4.1 at commit `a3194d20ca91ef6a314273d634e9b9c0db1c2707`
- User-facing name: **Call flow**

## Decision

Plannotator code review offers two independent optional analyses:

- **Semantic changes** (on by default), powered by `sem`.
- **Call flow** (off by default), powered by CallDiff.

Call flow has two views over one snapshot-keyed result:

1. a review-wide **Call flow** Dock panel;
2. a per-file **`flow N`** Lens in the file header.

Disabling Call flow removes both surfaces and stops analysis. Semantic changes keeps its existing Dock and Lens, but can now be disabled independently. The settings are persisted together under `reviewAnalysis` without one toggle overwriting the other.

## What CallDiff does

CallDiff compares complete source trees at two Git commits. It uses Tree-sitter to extract named callables and ordered call/branch steps, infers entry paths affected by changed calls, recursively expands a bounded call tree, and marks nodes as `same`, `added`, or `removed`. Source locations identify definitions and call sites.

CallDiff is syntactic evidence, not a runtime trace. It does not provide type or import resolution, dataflow, side effects, severity, confidence, test coverage, or a proof of dynamic dispatch. Duplicate bare symbol names can be ambiguous, and moves or reorderings can appear as remove/add pairs. Product copy therefore says “inferred entry paths” and “changed call-flow steps.”

CallDiff currently advertises 22 extractor modes. JavaScript/JSX and TypeScript/TSX share a core grammar family; the other modes map to 19 independently installable grammar packs.

## Runtime boundary

The published npm package named `calldiff@0.4.1` predates source-location output and the current language set. Plannotator therefore installs the exact upstream source archive at the commit above, verifies its SHA-512 integrity, and compiles it once at install time.

Installation is strictly user-initiated and selective. Nothing installs Call flow by default. On first use, the server maps the current patch's changed extensions to language families and offers one install containing the pruned core (CallDiff, Tree-sitter, JavaScript, and TypeScript) plus exactly the missing grammar packs needed by that review. The funnel names those languages, totals repository-owned per-pack size estimates, discloses Node.js 22+, shows staged progress, and hands off to analysis in the same session. A later review can analyze installed languages immediately while returning explicit skipped-file metadata for missing languages; its quiet inline notice installs those packs and reruns the same snapshot. The Dock's detail area also lists every supported language for install-ahead-of-need. Packs are not individually removable in v1; uninstall removes the whole managed Call flow tree.

The other entry points are the headless core install (`plannotator install-runtime call-flow`) and an installer core opt-in (`--with-call-flow` / `-WithCallFlow`, `PLANNOTATOR_INSTALL_CALLDIFF=1`, or `{ "installCallFlow": true }` in config.json; flag > env var > config). Language packs remain selectable from the review UI, where the current patch provides the authoritative need. Minimal installs always exclude Call flow.

The managed runtime lives at:

```text
~/.plannotator/vendor/call-flow/calldiff-0.4.1
```

Its contract is:

- Node.js 22 or newer;
- exact CallDiff source commit and archive integrity;
- a small core containing exact direct versions for Tree-sitter and the JavaScript/TypeScript grammars;
- one repository-committed `package-lock.json` per optional grammar pack, with exact package versions and registry integrity hashes;
- optional-pack tarballs are downloaded into memory, checked against those repository-owned SHA-512 values, and only then exposed to a fresh private npm cache; `npm ci` consumes that cache in offline mode;
- a lock marker written only after a pruned pack loads successfully through CallDiff; a folder without that exact marker is not installed;
- `npm ci --ignore-scripts` before any explicit native rebuild, for core and every pack;
- post-install pruning of TypeScript/Node build tools, generated parser sources, foreign-platform prebuilds, and node-gyp intermediates; locally compiled final `.node` addons are retained;
- no package installation or network access during review: server preflight resolves missing packs before spawn, the worker verifies CallDiff, Tree-sitter, every core grammar, and each relevant optional grammar at its exact version before importing CallDiff, `CALLDIFF_GRAMMAR_CACHE` points only at the managed store, npm offline flags are set, and a PATH-front npm blocker makes CallDiff's upstream lazy installer unreachable during both post-prune validation and analysis;
- a short-lived Node worker with a 512 MB heap, 45 second timeout, and 12 MB output limit;
- parsed output bounded to 100 trees, 5,000 nodes, depth 32, and 100 diagnostics;
- untrusted source paths rejected when absolute or parent-traversing.

Measured on macOS arm64 with Node 24.15.0 after the pinned install on 2026-08-11: core shrank from 94,408,476 bytes before pruning to 4,649,257 bytes; the representative Python pack shrank from 7,513,587 bytes to 527,081 bytes. All 19 optional packs plus core occupy 71,925,356 bytes on that platform. UI estimates are the measured pruned sizes rounded up per pack; native artifact sizes can vary modestly by platform.

`PLANNOTATOR_CALLDIFF_PATH` is a development override for a built CallDiff package whose optional grammars are already available under its own `node_modules`. Managed pack installation is never offered for an override: invalid override states explain their direct recovery instead of presenting an install funnel that cannot repair them. Normal uninstall removes the managed `vendor/call-flow` directory while preserving unknown vendor entries. The former `PLANNOTATOR_SKIP_CALLDIFF_INSTALL` opt-out was deleted: opting out of a default-off install is meaningless.

## Exact snapshot materialization

CallDiff requires two immutable commits. Plannotator never points it at a mutable worktree for patch-backed views. Instead it makes a temporary shared clone, seeds a temporary index at the correct base, applies the exact visible patch, and creates unreachable synthetic commits with `git commit-tree`. Cleanup removes the temporary clone. No ref, index, or worktree in the user's repository is changed.

Before spawning the worker, Plannotator groups both sides of every changed path by supported extension. It then lists both immutable snapshots and passes CallDiff an exact path filter containing all files in the installed language families relevant to the patch. This preserves complete same-language repository call graphs rather than reducing analysis to changed files, while preventing an unrelated unsupported language elsewhere in the repository from reaching CallDiff's lazy grammar loader.

| Review view | CallDiff `from` | CallDiff `to` |
| --- | --- | --- |
| Since base | merge-base(base, HEAD) | synthetic commit containing the visible patch |
| Uncommitted | HEAD | synthetic commit containing the visible patch |
| Staged | HEAD | synthetic commit containing the visible patch |
| Unstaged | synthetic staged snapshot | synthetic snapshot plus visible unstaged patch |
| Branch | selected base commit | HEAD |
| Merge base | merge-base(base, HEAD) | HEAD |
| Last commit | first parent of HEAD | HEAD |
| Commit rail | first parent of selected commit | selected commit |
| PR layer/full stack | exact locally available base/head pair | exact locally available head |

The All Files snapshot has no meaningful commit baseline and is explicitly unsupported. GitButler, Jujutsu, Perforce, nested workspace aggregation, and hosted PR analysis without a local checkout are also unsupported in this version.

## Server and API contract

Bun and Pi expose the same endpoints and response shapes.

- Every initial and switched diff payload advertises `semanticDiff` and `callFlow` capability state.
- `POST /api/review-analysis` validates and persists independent boolean settings, returns fresh adverts, and applies the change to the live session.
- `GET /api/review-analysis` refreshes adverts without joining the settings mutation epoch. Install completion uses this read-only route, retries transient failures, and therefore cannot supersede or silently lose a concurrent toggle mutation.
- `GET /api/call-flow?snapshot=<snapshotId>` analyzes only the active snapshot.
- A mismatched snapshot or a repository change during execution returns the structured `stale` state with HTTP 409 and `Cache-Control: no-store`.
- Disabled, unsupported, unavailable, stale, error, and successful results remain distinct domain states.
- `POST /api/call-flow/install` accepts `{ languageIds?: CallFlowLanguageId[] }`. Omitting the list installs the server-authored current-review plan; the manual language list supplies explicit ids. Core is prepended when needed. One coordinator deduplicates targets, queues new targets onto the active single flight, and reports the current pack. A Node.js 22+ preflight runs before any download; a missing or too-old Node is a distinct, immediate `{ state: "error", reason: "node-unavailable" | "node-version" }`. The same-origin guard remains mandatory.
- `GET /api/call-flow/install-status` reports `{ state: "idle" | "running" | "done" | "error", stage?, languageIds?, currentLanguageId?, error?, reason? }` with `stage` advancing through `downloading`, `verifying`, `installing-deps`, `building`. `error` persists until the next install POST retries. Completion cancels old work and invalidates the runtime probe plus successful/failure result caches in both runtimes, so the same snapshot immediately reruns with the new language set.

Each review server permits one CallDiff execution at a time. Requests for the same snapshot share an in-flight promise. Successful results are kept in a bounded session cache, repeated failures have a 30 second cooldown, and every committed diff/base/PR/scope/whitespace change cancels work for the prior snapshot. Server shutdown and disabling the feature also cancel all workers.

## UI contract

When disabled, no Call flow row, Dock, Lens, preflight, or analysis request appears.

When enabled, the navigation row stays visible even if the active review mode or runtime is unavailable. Its count is `—`; opening it explains the state and recovery action. On supported snapshots the client begins one background request and shares the result across the Dock and all virtualized file headers.

When only some changed languages are installed, the response remains successful and includes `skippedLanguages`. The Dock names the number of skipped files, languages, and combined install size; each skipped file Lens shows an actionable `flow —` state. Installing refreshes adverts and retries analysis in-session. The compact Languages disclosure shows installed state and measured per-pack size for every supported family.

The Dock's primary chrome shows the result, not the engine. It reports unique changed-step and impacted-file counts, then offers two dedicated views:

- **Paths** renders collapsible inferred entry trees with source locations and navigation.
- **Raw** renders CallDiff's own canonical, colorless ASCII output (with locations) in a copyable monospace surface.

Provider/version and the syntactic-analysis qualification live behind the quiet info affordance. They are deliberately absent from the primary heading. The raw view does not use `@pierre/diffs`: Pierre models text patches as files, hunks, and line ranges, while a call diff is an aligned parent/child tree. Adapting it would require fake files and hunk coordinates and would obscure tree parentage. A dedicated `<pre>` preserves CallDiff's exact human output and copying fidelity; the tradeoff is that raw rows do not navigate to source, so the structured Paths view remains the interactive view. The raw payload is bounded to 1 MB and rejected rather than silently truncated.

The Lens uses the same shared result and selects complete inferred entry trees containing at least one changed node in the current file (or its rename source). It filters only at the entry-tree boundary and never prunes nodes from a selected tree, so parents, unchanged context, sibling changes, and descendants remain visible. Changed nodes in the current file receive a quiet focus treatment; any located node can navigate to source. Changed nodes with a source line also expose the native code-review Comment action. It opens the existing annotation toolbar in place and creates the same line-scoped `CodeAnnotation` used by the diff, sidebar, feedback export, and hosted review submission. Unchanged context is navigation-only because it is not a valid old/new inline-diff target. The `flow N` count remains the unique changed-step count for that file.

Code review includes a one-time, versioned analysis welcome after Guide, look-and-feel, and review setup, and before Edit Mode. It presents **Semantic changes** and **Call flow** side by side. Both switches write the same `reviewAnalysis` settings as Settings → Analysis, and the dialog participates in the existing no-stack chain.

## Deliberate non-goals

This implementation does not add CallDiff `reach` queries, arbitrary entry selection, inline `@pierre/diffs` decorations, persisted analysis, automatic Ask AI context, confidence/severity scoring, or tree search. Those can be evaluated after the snapshot and runtime contracts have proven reliable.

## Verification requirements

Changes to this integration must preserve:

- Bun/Pi endpoint parity and Pi vendoring;
- exact managed dependency pins and offline analysis;
- selective changed-language preflight, successful partial results, and explicit skipped-file states;
- post-prune runtime loading for both prebuilt and locally compiled native grammars;
- source-repository immutability during snapshot creation;
- stale-result rejection and cancellation on view changes;
- independent Semantic changes and Call flow settings;
- one shared result powering both Dock and Lens;
- canonical raw output bounded at the worker boundary, never reconstructed from the UI tree;
- complete, unpruned entry trees in each relevant file Lens;
- native line annotations from changed, source-located Dock and Lens rows, with unchanged context rejected as an inline-comment target;
- the versioned analysis welcome remaining in the no-stack dialog chain;
- explicit unsupported/unavailable UI rather than a disappearing enabled feature.
