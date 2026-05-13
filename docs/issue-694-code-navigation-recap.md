# Issue 694 Code Navigation Recap

Issue: https://github.com/backnotprop/plannotator/issues/694

## What The User Is Asking For

The feature request asks for IDE-like semantic code navigation inside the Plannotator code review UI. The examples in the issue are:

- Ctrl/Cmd-click an identifier to find references.
- Show references in a sidebar.
- Peek definition.
- Navigate to definitions, references, and implementations without leaving the review context.

The user-facing value is not "AST parsing" by itself. The value is that while reviewing a diff, a reviewer can quickly answer: where is this symbol defined, where else is it used, and what related code should I inspect before annotating?

## Current Plannotator Context

Plannotator already has the right UI surface to capture the interaction:

- The code review UI renders diffs through `@pierre/diffs`.
- Pierre exposes token-level events with line number, character range, token text, token DOM element, and diff side.
- Plannotator already wires Pierre token clicks into the annotation toolbar.
- The review server already serves old/new file contents for changed files through `/api/file-content`.
- Dockview already gives us a natural place to add a "References" or "Peek Definition" panel.

Important constraint: Pierre does not provide semantic code intelligence. It can tell us "the user clicked this token at this location." It cannot tell us where the symbol is defined or referenced. That needs a separate backend resolver.

## PR Diff Constraints

PR mode matters because code navigation depends on which version of the repository we are asking about.

Layer PR diffs are platform diffs. In that mode, Plannotator has the patch and can fetch file contents from GitHub/GitLab by SHA, but it may not have a complete local repository to search.

Full-stack PR mode and local review mode can use a local checkout/worktree. Those modes are much better for repo-wide code navigation because the backend can run local search tools against actual files.

The practical rule should be:

- Platform-only PR mode: support changed-file/current-diff navigation and clear degradation.
- Local checkout/worktree mode: support repo-wide references and likely definitions.

## What We Explored

### Full LSP

Bundling and running language servers inside Plannotator is not a good MVP path. It is heavyweight, language-specific, expensive to bundle, harder to sandbox, and can be slow or brittle across arbitrary user repos.

LSP can remain an optional future accuracy tier if a project already has the needed tooling installed.

### SCIP / LSIF

SCIP is the right shape for precise code intelligence if an index already exists. It can represent definitions, references, and richer symbol relationships. But generating SCIP indexes means invoking language-specific indexers, which brings back the same cost problem as LSP.

Good future path: consume SCIP when present. Do not generate it by default in the MVP.

### Tree-sitter / Stack Graphs

Tree-sitter can parse source and identify syntax cheaply. Stack Graphs can model scope and name resolution for supported languages. This is more principled than regex search, but it still requires language grammars, queries, and integration work.

Good future path: use this to improve definitions and ranking. Not needed for the first useful version.

### Universal Ctags

Universal Ctags can produce a symbol index for definitions across many languages. It is lightweight compared with LSP, but it is not guaranteed to be installed. On this machine, only the older Xcode `ctags` is present, not Universal Ctags.

Good future path: detect Universal Ctags if available and use it as a definition indexer.

### Ripgrep

Ripgrep is the best MVP foundation:

- It is commonly installed in developer environments.
- It is very fast.
- It needs no index.
- It respects ignore files by default.
- It can return JSON output.
- It is easy to cap, timeout, and cancel.

On this repo, exact whole-word JSON searches over roughly 800 tracked files completed around 20-25ms. That is fast enough to use lazily on click.

## Recommended MVP

Build a search-based code navigation backend first.

Flow:

1. Pierre emits a token interaction: file path, side, line, char range, token text.
2. Frontend sends that to the server.
3. Server runs a bounded exact-symbol `rg` search for references.
4. Server runs a second bounded search for likely definitions using simple language-aware regex patterns.
5. Server ranks results.
6. Server returns snippets, result kind, confidence, elapsed time, and whether results were capped.
7. Frontend can later render this in a polished IDE-like sidebar or peek panel.

Example endpoint:

```ts
POST /api/code-nav/resolve
{
  symbol: "startReviewServer",
  filePath: "packages/server/review.ts",
  line: 134,
  charStart: 22,
  side: "new",
  language: "typescript"
}
```

Example response:

```ts
{
  backend: "search",
  complete: true,
  definitions: [
    {
      kind: "definition",
      confidence: "likely",
      filePath: "packages/server/review.ts",
      line: 134,
      column: 22,
      snippet: "export async function startReviewServer("
    }
  ],
  references: [
    {
      kind: "reference",
      filePath: "apps/hook/server/index.ts",
      line: 516,
      column: 23,
      snippet: "const server = await startReviewServer({"
    }
  ],
  stats: {
    elapsedMs: 24,
    capped: false
  }
}
```

## Definition Heuristics

For the MVP, definitions should be "likely definitions," not falsely marketed as perfect semantic answers.

For TypeScript/JavaScript, patterns can cover:

- `function symbol`
- `async function symbol`
- `export function symbol`
- `export async function symbol`
- `const symbol =`
- `let symbol =`
- `var symbol =`
- `class symbol`
- `interface symbol`
- `type symbol`
- `enum symbol`
- `symbol(` inside object/class method contexts

Other language patterns can be added incrementally:

- Python: `def symbol`, `class symbol`
- Go: `func symbol`, `func (...) symbol`, `type symbol`
- Rust: `fn symbol`, `struct symbol`, `enum symbol`, `trait symbol`, `impl`

The backend should label these as `likely_definition` unless a stronger backend produced the result.

## Ranking

Ranking matters more than perfect completeness in the MVP.

Recommended ranking:

1. Exact match in the current file.
2. Exact match in changed files.
3. Likely definition in the same directory.
4. Likely definition in imported/exported files.
5. Same language/extension.
6. Test files lower unless clicked symbol came from a test.
7. Docs and generated files lower.
8. Everything else.

The server should return capped results rather than trying to be exhaustive.

## Performance Rules

The backend should be lazy, bounded, and cancelable.

- No startup indexing.
- Do no work until the user asks for code navigation.
- Use current diff/current file matches immediately in memory.
- Run `rg` with exact whole-word matching.
- Cap result count.
- Cap files searched.
- Apply a short timeout.
- Cancel stale searches when the user clicks another symbol.
- Cache recent symbol queries per repo state.
- Respect `.gitignore` and skip `node_modules`, `dist`, build outputs, binary files, and vendored directories.
- Return partial results if a search is capped or times out.

This keeps the feature cheap for normal use and prevents pathological repos from freezing the review server.

## Backend Capability Tiers

The capability model should be explicit:

1. `search`: always available if `rg` is present. Provides exact references and likely definitions.
2. `ctags`: optional if Universal Ctags is installed. Improves definitions.
3. `tree-sitter`: optional later. Improves symbol classification and local scoping.
4. `scip`: optional if an index is already present. Provides precise code intelligence.
5. `lsp`: optional future integration only, never required for baseline behavior.

The UI can show this honestly:

- "References" for exact search matches.
- "Likely definition" for regex/ctags results.
- "Precise definition" only when a precise backend produced it.

## What This Enables On The Frontend

Once this backend exists, the frontend can become more IDE-like without depending on heavyweight infrastructure:

- Ctrl/Cmd-click a token in the Pierre diff.
- Hover with modifier key to show that the token is navigable.
- Show references in a sidebar panel.
- Show a peek definition panel.
- Jump to a changed-file result in the existing diff view.
- Open unchanged-file results in a read-only source preview panel.
- Highlight all visible references in the current diff.
- Add annotations directly from search/navigation results.

The frontend can be polished later. The backend only needs to return stable, fast, ranked results.

## Non-Goals For The MVP

- Do not bundle language servers.
- Do not build a full repo index on server startup.
- Do not promise perfect semantic correctness.
- Do not require Universal Ctags, Tree-sitter, SCIP, or language-specific tools.
- Do not make platform-only PR mode pretend it has full repo navigation when no local checkout exists.

## Final Recommendation

Implement the first version as:

```text
Pierre token click
  -> /api/code-nav/resolve
  -> bounded rg references
  -> regex-ranked likely definitions
  -> snippets + confidence labels
  -> sidebar/peek-ready response
```

This gives users most of the value they are asking for while keeping Plannotator lightweight. It also creates a clean upgrade path: richer backends can be added later without changing the frontend contract.
