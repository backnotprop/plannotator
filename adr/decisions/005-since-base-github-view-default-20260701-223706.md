# 005. "Since main" composite diff as the default code-review view

Date: 2026-07-01

## Status

Accepted

## Context

The two most common pieces of user feedback about the code review app are "I
just want to see what I would see in GitHub" and "I just want to see what
happens when I run git status." The current default screen answers neither:
the DiffTypePicker forces users to translate intent into git mechanics
(staged / unstaged / merge-base / all) before anything renders, and no single
option matches the GitHub expectation — `merge-base` excludes the working
tree, and the `unstaged` default shows nothing to someone who just committed.
Every possible default betrays one of the two mindsets.

A prototype (`adr/research/code_review_panel_three_stack_mockup.svg`) showed
the desired shape: one panel, three stacked sections — Committed (muted),
Changes, Untracked — with the viewed checkbox as each row's primary action,
a staged dot, and a quiet stage button.

A verification spike
(`adr/research/SPIKE-github-view-composite-diff-20260701-222935.md`) confirmed
the prototype does not need three simultaneous diffs. It is one composite
comparison — merge-base(base, HEAD) → working tree, plus untracked — which is
exactly "what the GitHub PR would show if I pushed right now," and it fits the
server's existing single-snapshot state machine. The section partition is a
sidecar computed from `git status --porcelain` plus
`git diff --name-only <mb>..HEAD`. Every integration point is one new case
along an existing seam (diff runner, fingerprint, file content, staging gates,
agent context, config default). The Pierre diff viewer needs no changes.

Full rationale: `adr/research/synthesis-github-view-20260701-222935.md`.
Full design: `adr/specs/github-view-three-stack-20260701-222935.md`.

## Decision

1. **New git diff type `since-base`**, user-facing label "Since main"
   (dynamic per base): `git diff <merge-base(base, HEAD)>` against the working
   tree plus untracked files. Every diff on this screen means "changes since
   main" — no per-file modes. "Just since last commit" remains the existing
   `last-commit` type in the advanced menu, not a toggle on this view.
2. **`since-base` becomes the default diff type for everyone** (previously
   `unstaged`). Users with an explicit `defaultDiffType` in config keep their
   choice.
3. **New Sections panel** as the default left-panel view, per the mockup:
   Committed / Changes / Untracked, grouped by a server-computed status
   sidecar. Viewed checkbox stays the primary row action; stage button and
   staged dot use the existing `/api/git-add` path. Sizing is
   viewport-adaptive: Changes and Untracked always render fully; Committed
   fills remaining room with a minimum-rows floor and an "N more files"
   expand.
4. **Sections | Tree toggle** in the panel header (persisted per user); a
   third Commits mode is reserved for the backlogged git-graph work.
5. **Progressive disclosure**: the default screen has zero pickers. The
   "vs origin/main" label opens the existing base picker. A quiet footer
   "Advanced" row exposes today's full diff-type list. Nothing is removed.
6. **Baseline staleness banner**: reuse the remote tip SHA already returned by
   the startup `ls-remote` call (currently discarded) to detect when
   `origin/<default>` is behind GitHub; show "Baseline is behind GitHub ·
   Fetch" backed by a dedicated `POST /api/fetch-base` endpoint.
7. **Git only.** jj, Perforce, workspace mode, and PR mode are unchanged.

## Consequences

- Both user mindsets are served by one screen with no configuration: the diff
  content answers "what would GitHub show," the section grouping answers
  "what does git status say."
- The default experience changes for all existing users; the old behavior
  remains one footer click away, and explicit config defaults are honored.
- `packages/shared/review-core.ts`, `vcs-core.ts`, `config.ts`,
  `packages/server/review.ts`, and `agent-review-message.ts` each gain a
  `since-base` case; `/api/diff` and `/api/diff/switch` payloads gain a
  `sections` sidecar; the Pi server mirrors it.
- The client gains the Sections panel component, the Sections/Tree toggle,
  the footer Advanced entry, the staleness banner, and `since-base` entries in
  `STAGEABLE_DIFF_TYPES` and `OPTION_HINTS`.
- Annotations, feedback export, viewed sync, freshness polling, and the diff
  viewer itself are unchanged — they already operate on a single patch and a
  flat file list.
- Advanced modes render in Tree view only; sections exist only for
  `since-base`.
