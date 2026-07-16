# Synthesis: the "GitHub view" default for code review

Date: 2026-07-01
Inputs: `SPIKE-github-view-composite-diff-20260701-222935.md`,
`SPIKE-git-graph-view-20260618-220909.md` (backlogged, reused here),
mockup `code_review_panel_three_stack_mockup.svg`, product discussion 2026-07-01.

## The problem, in users' words

- "I just want to see what I would see in GitHub."
- "I just want to see what happens when I run git status."

The current `DiffTypePicker` forces users to translate those intents into git
mechanics (staged / unstaged / merge-base / all) before anything renders. No
option answers the GitHub question: `merge-base` (our own hint even says "Same
as GitHub's PR view") excludes the working tree, and the `unstaged` default
shows nothing to someone who just committed. Every possible default betrays one
of the two mindsets.

## The resolution

Don't pick a better default — dissolve the choice. One comparison serves both
mindsets simultaneously:

> **merge-base(origin/default, HEAD) → working tree + untracked**
> = "what the GitHub PR would show if I pushed right now"

- The **diff content** answers the GitHub question. Every diff on screen means
  the same thing: changes since main. No exceptions, no per-file modes.
- The **grouping** answers the git-status question: three sections — Committed
  (muted), Changes (modified + added conjoined, staged dot), Untracked —
  exactly the mockup's three-stack panel.

Confirmed decisions from discussion:

1. **Every diff shows "since main."** A file edited in an old commit and again
   now appears once (in Changes) and its diff shows everything since main.
   "Just since last commit" is NOT a toggle on this view — that intent already
   exists as the `last-commit` diff type and lives in the advanced menu.
2. **Viewed is untouchable.** It's the app's most-used feature; the mockup
   promotes the checkbox to the row's primary action. Existing `viewedFiles`
   infra carries over as-is.
3. **Sections | Tree toggle**, with a future third mode: Commits (the
   backlogged git-graph spike's Phase 1 — flat commit list + per-commit diff —
   slots in here with no viewer changes).
4. **Progressive disclosure**: default screen has zero pickers. The "vs
   origin/main" label opens the existing BaseBranchPicker. An Advanced entry
   exposes today's full diff-type list. Nothing is deleted; it stops being the
   front door.
5. **Baseline honesty**: we compare against `origin/main` = GitHub as of last
   fetch. The startup `ls-remote` call already receives the remote tip SHA and
   throws it away; keep it, compare, and show a quiet "baseline is behind
   GitHub — fetch" banner when stale. That one banner is what makes "this is
   the GitHub view" a trustworthy claim.
6. **Git only.** jj and Perforce keep the current UI. Workspace mode keeps the
   current UI for now.
7. **Committed section default state** (collapsed vs peek): feel it out during
   implementation; mockup mutes it at 55% opacity with a "124 more files"
   truncation, which suggests collapsed-with-count is the starting point.

## Why this is cheap (spike findings, condensed)

The three-stack panel is **one new git diff type plus a status sidecar**, not a
new diff engine:

- The server's single-snapshot state machine (one `currentPatch`, one
  fingerprint) fits a composite comparison as-is.
- `runGitDiff`, fingerprinting, file-content retrieval, staging, the freshness
  probe, and the agent context builder each need one new `case` along an
  existing seam (~6 small additions, verified line-by-line in the spike).
- The section partition comes from `git status --porcelain` (already run for
  fingerprints) + `git diff --name-only <mb>..HEAD` — shipped as a payload
  sidecar; the client groups files by it.
- The Pierre diff viewer needs zero changes (re-confirmed; also the git-graph
  spike's key finding).
- Viewed, staging (`/api/git-add`), annotations, and feedback export all work
  unchanged; annotations against mb→worktree have the same shape as today's
  merge-base annotations.

The genuinely new work is UI: the Sections panel component, the Sections/Tree
toggle, the disclosure re-layering (pickers → Advanced), and the staleness
banner.

## Open questions carried into the spec

- Naming of the new `DiffType` id and its user-facing label.
- Where the fetch action lives when the baseline is stale (banner button →
  `git fetch` server-side, then re-switch).
- Whether Sections view fully replaces FileTree as default or per-user
  preference persists (cookie, like other settings).
- Exact payload shape of the sections sidecar.
