# Spec: GitHub-view default with three-stack panel

Date: 2026-07-01
Status: **Decisions settled 2026-07-01 — ready for ADR**
Mockup: `adr/research/code_review_panel_three_stack_mockup.svg`
Research: `adr/research/SPIKE-github-view-composite-diff-20260701-222935.md`,
`adr/research/synthesis-github-view-20260701-222935.md`

## Summary

Make the default code-review screen answer "what would I see in GitHub" with
zero configuration. One new git diff type — merge-base(base, HEAD) → working
tree + untracked — rendered as a three-section file panel (Committed / Changes
/ Untracked) with Viewed as the primary per-row action. Everything that exists
today moves behind progressive disclosure; nothing is removed.

## 1. New diff type: `since-base`

**Decided.** Internal id `since-base`; user-facing label is dynamic:
**"Since main"** / "Since origin/main" / "Since <base>" — honest about the
comparison, follows the base picker, no platform branding.

**Semantics:** everything that would appear in a GitHub PR if the user
committed and pushed right now, against the merge-base with the review base
(default `origin/<default-branch>`).

**Computation** (new case in `runGitDiff`, `packages/shared/review-core.ts`):

```
mb = git merge-base --end-of-options <base> HEAD
patch = git diff --no-ext-diff [-w] --src-prefix=a/ --dst-prefix=b/ --end-of-options <mb>
      + getUntrackedFileDiffs()
label = "Since <base>"
```

Guard: no HEAD (fresh repo) or merge-base failure → fall back to
untracked-only patch with a non-fatal error label, same pattern as
`uncommitted`'s `hasHead` guard.

**Companion cases (one each):**

- `getGitDiffFingerprint`: `HEAD sha` + `hashDiffOutput([mb])` +
  `hashUntracked()` + base tip sha.
- `getFileContentsForDiff`: old = `git show <mb>:path`, new = working tree.
- `getGitContext` diffOptions: emitted first when a default branch exists →
  becomes the initial type via existing `resolveInitialDiffType`.
- `vcs-core.ts`: add to `GIT_DIFF_TYPES`; `canStageFiles` returns true.
- `agent-review-message.ts` `getLocalDiffInstruction`: target = "all changes
  since the merge-base with <base> (committed and uncommitted), plus untracked
  files — the full set GitHub would show in a PR"; inspect = the mb lookup +
  `git diff <mb>` commands.
- `config.ts` `resolveDefaultDiffType`: accept the new id; **default flips to
  it for everyone** (from `'unstaged'`) — decided. Users with an explicit
  `defaultDiffType` in config keep their choice.
- Client `STAGEABLE_DIFF_TYPES` (`useGitAdd.ts`) and `OPTION_HINTS`
  (`DiffTypePicker.tsx`): add the new id.
- **`WORKTREE_SUB_TYPES`** (`review-core.ts:521`): add `since-base` so
  `worktree:<path>:since-base` parses and worktree switching preserves the
  mode (App.tsx mirrors this parse at ~1200 — keep in sync). *(preflight)*
- **`compareTarget.diffTypes`** (`getGitContext`, `review-core.ts:427`,
  currently `["branch", "merge-base"]`): add `since-base` so the base picker
  row gates on for it — this is what powers the "vs origin/main" affordance.
  *(preflight)*
- Pi: `vendor.sh` vendors all of `packages/shared/` **and**
  `packages/server/agent-review-message.ts` into `generated/` at build, so
  every shared-layer change propagates automatically. Only hand-mirror the
  `sections` payload field and `POST /api/fetch-base` in `serverReview.ts`.
  *(verified in preflight)*

## 2. Sections sidecar

Server computes alongside the patch (both `/api/diff` and `/api/diff/switch`
responses when `diffType === "since-base"`):

```ts
sections: {
  base: string;            // resolved base ref, e.g. "origin/main"
  mergeBase: string;       // sha, for display/debug
  files: Record<string, {
    group: "committed" | "changes" | "untracked";
    status: "A" | "M" | "D" | "R";   // vs merge-base (from the patch itself)
    staged: boolean;                  // porcelain column 1
  }>;
}
```

Sources: `git status --porcelain` + `git diff --name-only <mb>..HEAD`.
Partition rule: `??` → untracked; dirty in status → changes; else (in
mb..HEAD set, clean tree) → committed. Files present in both the branch set
and the dirty set land in **changes** (their diff still shows the full
since-base story — confirmed decision, no per-file override).

## 3. UI: three-stack Sections panel (per mockup)

New component (sibling of `FileTree`, same left-panel slot):

- **Header:** "Review" + branch chip; beneath it a quiet "vs origin/main"
  affordance → opens existing `BaseBranchPicker`.
- **Three collapsible sections** with counts: Committed (muted ~55% opacity),
  Changes, Untracked.
- **Committed sizing is viewport-adaptive** (decided): Changes and Untracked
  always render fully — every actionable file visible without scrolling those
  sections. Committed fills whatever vertical room remains, with a floor of a
  few visible rows even when space is tight, then an "N more files" expand
  row. Expanded state scrolls within the panel.
- **Row anatomy** (from mockup): viewed checkbox (primary action, existing
  `viewedFiles` behavior incl. `v` key and auto-view-on-stage) · filename ·
  staged dot (purple) · quiet stage/+ button (`/api/git-add`) · status letter
  (M amber / A green / U gray; D red when present; modified undecorated stays
  the tree-view convention — sections view shows M per mockup).
- Clicking a row opens the same single-file DiffViewer; All-files and Semantic
  panels work unchanged (they already consume the flat `DiffFile[]`).

**View toggle:** `Sections | Tree` in the panel header. Tree = current
`FileTree` rendering of the same since-base patch. Choice persisted (cookie,
like other settings). Reserved third slot: `Commits` (backlogged
git-graph spike, Phase 1).

**Progressive disclosure:**

- Default screen: no pickers visible.
- "vs origin/main" → base picker (level 1).
- "Advanced" entry (decided: **quiet footer row**, near the existing copy-diff
  footer) → today's `DiffTypePicker` with the full mode list (staged/unstaged/
  last-commit/merge-base/all/worktrees). Selecting an advanced mode switches
  the panel to Tree view (sections only exist for since-base).
- `DiffTypeSetupDialog` gains "GitHub view (recommended)" as the default
  choice; power users can still pick a classic default.

## 4. Baseline staleness banner

- Extend `detectRemoteDefaultBranch` (or add a sibling) to also return the
  remote tip sha from the same `ls-remote` output it already parses.
- Compare against `git rev-parse origin/<branch>`. If different → payload/
  fresh-probe field `baseBehindRemote: true`.
- UI: quiet banner "Baseline is behind GitHub · Fetch" → dedicated endpoint
  `POST /api/fetch-base` runs `git fetch origin <branch>` then the client
  re-runs `/api/diff/switch` (preserveFile). (Decided: separate endpoint, not
  overloading `/api/diff/switch` — fetch is a network mutation with its own
  failure modes.)
- Cadence: check at startup + every ~60s (network call — not on the 5s
  fingerprint poll).

## 5. Scope

- **Git only.** jj → keeps `jj-current` default and current UI; p4 and
  workspace mode unchanged. `since-base` is git-owned via `GIT_DIFF_TYPES`.
- PR mode unchanged (it already IS the GitHub view).
- No removal of any existing diff type, endpoint, or control.

## 6. Acceptance sketch

1. Fresh run on a feature branch with commits + edits + a new file: panel
   shows three sections, counts correct, every file diff = since main.
2. On the default branch with local edits: Committed empty, Changes/Untracked
   match today's uncommitted view.
3. Stage a file from the row button: dot appears, file auto-marked viewed,
   file stays in Changes.
4. Toggle Sections ↔ Tree: same files, no refetch.
5. Stale `origin/main`: banner appears; Fetch refreshes and re-partitions.
6. Advanced → "Staged changes": classic behavior, Tree view, no sections.
7. jj repo: no behavior change.

## Decisions log (2026-07-01)

- [x] Label: **"Since main"** (dynamic per base); internal id `since-base`.
- [x] Rollout: **flip everyone**; explicit `defaultDiffType` configs respected.
- [x] Committed section: **viewport-adaptive** — Changes + Untracked always
      fully visible; Committed fills remaining room with a minimum-rows floor
      and an "N more files" expand.
- [x] Advanced entry: **footer row**.
- [x] Fetch-on-stale: dedicated `POST /api/fetch-base`.
