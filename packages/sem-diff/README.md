# @plannotator/sem-diff

A diff shows lines that were added and deleted. Much of that isn't a real change: a function moved further down the file, a variable renamed, code reformatted, a block pulled out into a helper. This package parses both versions of a file with tree-sitter and says what each change really is, so code review can fold what kept its meaning and point at what didn't.

It returns the `semanticOperations` and `semanticFolds` that the semantic build of `@pierre/diffs` draws (`vendor/pierre-diffs/`, see its `FORK.md`).

```ts
import { semanticDiffFile, languageForPath, reviewSummary } from '@plannotator/sem-diff';

const language = languageForPath(path);            // undefined: plain diff
const { semanticOperations, semanticFolds, patch } = await semanticDiffFile(language, oldText, newText, path);
// Render Pierre's processFile(patch, { oldFile, newFile }) with these two fields set.
// reviewSummary(semanticOperations) splits it into what to read and what to skim.
```

| Change | Example |
|---|---|
| Moved | `loadUser` moved below `saveUser`, unchanged |
| Moved and edited | moved, with a line changed on the way |
| Renamed | `MAX_RETRIES` became `MAX_ATTEMPTS` everywhere, nothing else changed |
| Reformatted | the same code laid out differently |
| Reordered | imports or members re-sorted |
| Extracted function | a loop left `checkout` and now lives in a new helper it calls |
| Inlined function | a helper was removed and its body pasted where it was called |

It prefers saying nothing to saying something wrong: a missed change stays a plain diff. The same two texts always give the same result.

**Languages:** TypeScript, JavaScript (including JSX/TSX), Go, Rust, Python, Java and C#. Parsing uses `web-tree-sitter` (Wasm), so it runs in Bun, Node 24+ and a browser Web Worker. In a browser, pass `locateGrammar` and `locateRuntime` to `configure()` so it can fetch the `.wasm` files.

**How well it works:** on 193 real extract/inline refactors from 7 projects it was never tuned on, it found 127 (66%) with 1 wrong claim. Moves, renames, formatting and imports showed no false claims on about 7,000 generated cases. Speed: a median of 13–35 ms per file.

**Optional second opinion** (`@plannotator/sem-diff/opinions`): a decision model with the user's own key raises extract/inline finds to 87–89% with a few more wrong claims. It is off unless configured.

**Pierre's types:** `src/pierre-types.ts` is a copy of the semantic types on Pierre's `amadeus/semantic-diffs` branch (Apache-2.0). `PIERRE_DIR=<pierre checkout> bun run pierre-drift` fetches the branch and fails if the copy no longer matches.

Licence: MIT or Apache-2.0, at your choice.
