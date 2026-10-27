## Code Review Flow

```
User runs /plannotator-review command
        ↓
Claude Code: plannotator review subcommand runs
OpenCode: event handler intercepts command
        ↓
VCS provider captures local changes (Git, GitButler, JJ, or P4 where supported). When review runs from a
non-VCS parent that contains nested Git/JJ/GitButler repos, child diffs are combined with
folder-prefixed paths.
        ↓
Review server starts, opens browser with diff viewer
        ↓
User annotates code, provides feedback
        ↓
Send Feedback → feedback sent to agent session
Approve → approved prompt sent to agent session (with the note/annotations when approving with notes)
```

### Color-free VCS output (#1661)

Every git command the review servers parse goes through `prepareGitCommand`
(`packages/shared/review-core.ts`, both runtimes), which prepends
`GIT_COLOR_FREE_ARGS`: `--no-pager` plus `-c color.<key>=never` for `ui`,
`diff`, `status`, `branch`, `grep`, `showBranch` and `interactive`.
`color.ui=never` alone is not enough, because an explicit `color.diff = always`
in the user's config wins over it and colors a piped diff, which used to parse
to 0 files and 0 viewed-file identities. jj gets `JJ_COLOR_FREE_ARGS`
(`--color=never --no-pager`, `packages/shared/jj-core.ts`) in both runtimes'
`runJj`, `gh pr diff` gets `--color=never`, and agent jobs inherit the same git
settings as `GIT_CONFIG_*` variables (`gitColorFreeEnvironment`). As a backstop,
`parseDiffToFiles` strips ANSI codes from a patch whose `diff --git` headers are
colored (`stripPatchColor`, `packages/core/diff-files.ts`); a normal patch is
returned byte for byte. A new git/jj spawn that bypasses these runners must add
the same options. `packages/server/review-git-color-config.test.ts` runs both
servers against a sandboxed config that forces color on.

### Review directory targets

`plannotator review [DIRECTORY | PR_URL]` (and `/plannotator-review` on OpenCode
and Pi) accepts one local repository/worktree or multi-repo workspace directory.
The shared `parseReviewArgs` + `resolveReviewTarget` resolve it against the
invoking terminal/session cwd, validate it before discovery, and reject multiple
targets or a directory combined with `--patch-file`. Prose stays tolerated
(#1483, the annotate-target precedent): a sole word or any path-shaped word is a
directory candidate (path-shaped typos and files error), every other word is
ignored with a notice and the invoking cwd is reviewed. Hosts pass the resolved cwd
through existing VCS/workspace discovery and project detection; never use
`process.chdir()` in a plugin host. Explicit targets inside a repository normalize
to its detected VCS root. OpenCode uses the internal `opencode-review-directory`
command for these targets so an older CLI rejects them rather than silently
reviewing the caller's repo; ordinary reviews keep `opencode-review`.
Feedback still goes to the invoking agent
session, with `withReviewDirectory` naming the active directory at submission when feedback has content
(a bare approval stays bare). File operations, AI jobs and persistence continue
using the resulting `gitContext.cwd` / workspace root.

### Review header decision control (agent mode)

The agent-destination review header uses the same adaptive split control the annotate surfaces
adopted: a ghost-X Close plus `DecisionControl` (`packages/ui/components/DecisionControl.tsx`)
rendered from the pure `buildDecisionSpec` mapping — `Approve` with no annotations,
`Send Feedback` otherwise, with `Request changes…` / `Send with a note…` and the explicit
`Approve, discard n annotations…` confirm behind the caret. One `submitPrimaryDecision()`
callback serves the header primary, the global `Mod+Enter` handler, and the compact primary row.
Transport routing is pure in `packages/review-editor/reviewDecision.ts` and single-endpoint:
every decision POSTs `/api/feedback` with `approved` as the only fork; a change-request note
becomes a `scope:'general'` `CodeAnnotation` (sentinel `filePath ''`/0/0, riding the export's
`## General` section) with a one-render deferred submit — zero server change. Approve-carrying
menu items (`Approve with notes`, `Approve with a note…`) are capability-gated on the
server-sent `approvalNotesSupported` advert, which rides every diff payload (`/api/diff`,
`/api/diff/switch`, `/api/pr-diff-scope`, `/api/pr-switch`, both runtimes) and reads as false
when absent, so an old server renders no approve-carrying items. For the OpenCode CLI bridge
the advert additionally requires the plugin's own `supportsApprovalNotes: true` declaration on
the `opencode-review` stdin JSON (the binary and plugin version independently; an old plugin
omits it and the advert fails closed, so a new binary can never hand an old bridge a note it
would discard). A capable session's approvals post `buildReviewApprovalBody`: bare approve
sends `feedback: ''` (the old `'LGTM - no changes requested.'` placeholder is gone — a bare
approval now archives as `lgtm` with no sidecar), "Approve with a note…" sends the note as the
feedback, and "Approve with notes" sends the live annotations plus their export (a note, if
both are ever present, is folded in ahead of the export — never dropped). The four agent-facing
decision consumers (Claude Code CLI, OpenCode native + CLI bridge, Pi) emit approvals through
the shared `composeReviewApprovedMessage` (`packages/shared/prompts.ts`, vendored to Pi):
a bare approval is the plain approved prompt; an approval carrying feedback uses the
approved-with-notes framing (`prompts.review.approvedWithNotes`, default
`DEFAULT_REVIEW_APPROVED_WITH_NOTES_PROMPT` — "non-blocking guidance, do not revise or
reopen"), because the bare prompt plus a change-request-shaped export would read as a
contradiction. The legacy placeholder is filtered there so a stale built client cannot get
filler framed as guidance. The standalone dev server (`apps/review/server`) is the exception:
it emits the raw decision JSON with the feedback unfiltered and does not route through the
composer. Compact/touch rows are generated from the same spec, so a visible positive decision
exists in every state; composer rows open `DecisionNoteDialog`. Platform (PR) mode renders the
same ghost-X + `DecisionControl` shape from `buildDecisionSpec`'s platform arm, with **no
composer items ever**: every menu action opens the existing `ReviewSubmissionDialog` (per-target
state, retry, "leave PR open" toggle — whose general-comment textarea is the only note field on
that side), and the self-approval mute is preserved — muted primary/items with the "You can't
approve your own {PR/MR}" reason.

**Request changes is a real review event (#1611).** `PRReviewAction` (`packages/shared/pr-types.ts`)
is `'approve' | 'comment' | 'request_changes'`, carried end to end: `resolvePlatformDecisionAction`
returns `{ action, chooseEvent }`; `Post comments, then…` opens the dialog with a Comment /
Request changes choice (Comment selected) and the empty-state `Request changes…` preselects
Request changes, while the primary `Post Comments` keeps the plain comment flow with no choice.
`POST /api/pr-action` validates `action` with `parsePRReviewAction` in BOTH runtimes (anything
else is `400`, never a silent COMMENT), and `submitGhPRReview` maps it to `REQUEST_CHANGES` on the
single create-review call AND on the pending-review → `/events` submit path (#1600), with the
same `See inline comments.` placeholder COMMENT gets when the body is empty (GitHub requires a
body on both). GitLab has no request-changes review: `request_changes` posts exactly what
`comment` posts, the menu subtitles say so (`requestChangesSupported: false` on the spec's
platform input), and the dialog's Request changes option is disabled with that reason. GitHub
refuses REQUEST_CHANGES on your own PR like APPROVE, so with `requestChangesSupported: true` and
`selfAuthored` the empty-state `Request changes…` mutes with its own reason and a live
`Comment…` row (`note-with-feedback`, compact id `comment`) keeps the state from being a dead
end; `Post comments, then…` stays live with the dialog option disabled. The spec field is
optional and absent keeps the pre-#1611 copy for hosts. In a stacked multi-PR submission every
target posts the same event; the choice locks once any target may have been posted
(success/partial/blocked) so retries and the tab-scoped recovery (which stores `action`) keep
that event, while after a plain failure (nothing posted) it can still change. A refusal GitHub
answers anyway surfaces its own reason through the #1600 `githubErrorDetail` path.

**PR platforms are providers (#1583).** GitHub, GitLab and Bitbucket Cloud each implement one
`PRProvider` (`packages/shared/pr-provider.ts`: `checkAuth`, `getUser`, `fetchPR`, `fetchContext`,
`fetchFileContent`, `fetchFileBytes`, `submitReview`, plus optional `fetchViewedFiles` /
`markFilesViewed` / `fetchStack` / `fetchList`); the dispatch functions look the provider up by
`PRRef.platform`, and an absent optional method is the neutral answer (no viewed state, no stack,
empty PR list). What the UI shows comes from `getPRPlatformCapabilities` (`packages/shared/pr-types.ts`,
browser-safe): `requestChanges`, `selfReviewBlocked`, `fileLevelComments`, `viewedSync`, `artifacts`,
`reviewBodyRequired`, `agentCliAccess`, labels and the CLI. Pure helpers replace the old
`platform === "github" ? number : iid` ternaries: `getPRNumber`, `getDisplayRepo`, `getPRHeadFetchSpec`
(where a local checkout fetches the head: `refs/pull/N/head`, `refs/merge-requests/N/head`, or
Bitbucket's source branch, from the fork URL when `sourceRepo` is set) and `getPRCloneCommand`.
GitHub/GitLab outputs of all of these are pinned byte-for-byte (`pr-platforms.test.ts`, including the
draft target keys). Bitbucket specifics: REST API 2.0 over `fetch` (`packages/shared/pr-bitbucket.ts`,
vendored to Pi), credentials per the `PLANNOTATOR_BITBUCKET_*` rows above; the PR object's 12-char
hashes are resolved to full SHAs and the merge base comes from `/merge-base` (the PR diff is
three-dot); existing inline threads get a GitHub-shaped `diffHunk` cut from the PR diff (`bitbucketDiffHunk`), since Bitbucket comments carry none; a review posts each line comment as an inline comment
(`inline: { path, to | from, start_to | start_from }`), THEN the body as one general comment (the
Activity feed lists newest first, so this puts the summary above the inline comments, #1583), then
`POST /approve` or `POST /request-changes` (so `requestChangesSupported` is true, and an author may approve their own PR,
so nothing is muted); it follows GitLab's partial contract, with `retry.action` naming the failed
decision (`request_changes` included) and `retry.body` carrying the general comment when that is the
part that failed after inline comments landed (`buildPRActionRequest` resends exactly it). File-level comments fold into the body, there is no viewed sync
and no stack discovery, the PR Artifacts panel is hidden (`artifacts: false`), and agent review, Code Tour and
Guided Review prompts carry the diff inline when no local checkout is ready (`agentCliAccess: false`: no CLI a job may run can read the PR). The portable
guide format names only github/gitlab, so a Bitbucket guide omits `source.pr.platform`. Recorded
(anonymized) API responses and a fake API server live in `tests/test-fixtures/bitbucket/`;
`scripts/bitbucket-live-smoke.sh` runs the real flow against a throwaway repo.

**Which gh account a GitHub PR review runs as (#2157).** `gh` can hold several accounts per host and
uses the active one. GitHub's `checkAuth` first asks only that gh is signed in (`checkGhAuth`:
`gh auth status --active --hostname H`; when that fails, an older gh or a broken active login, it
goes on as long as some account on the host is usable, because plain `gh auth status` exits 1 when
ANY account on the host is broken). Then `ensureGhPRAccess` (`packages/shared/pr-github-account.ts`,
vendored to Pi) checks, before the review opens, that the active account can read the PR
(`gh api repos/O/R/pulls/N`; when that is refused but the repository is readable, the number is
wrong and the fetch reports it as before; network and rate-limit failures give no verdict). Refused:
every other account `gh auth status` lists for the host (`--json hosts` from gh v2.81.0, else the
text with NO_COLOR=1 and ANSI stripped) is tried with its token (`gh auth token --hostname H --user L`,
gh v2.40.0+) as GH_TOKEN (GH_ENTERPRISE_TOKEN off github.com and `*.ghe.com`); the first that can read
it is used for THIS review only. `gh auth switch` is never run and gh's settings never change. None
can: the review does not open (the CLI exits 1, like other startup failures) and the error names the
active account, the accounts that can't see it, an account that reads the repo but not the PR ("the
PR number may be wrong"), the accounts with no verdict (broken login, no token, offline, rate limit:
"Couldn't check", with `gh auth switch -u <that one>`), else `gh auth login` / `gh auth switch -u
<user>`, plus a note when GH_TOKEN is the active source. The choice is an in-memory override keyed
by host/owner/repo, and the token goes ONLY where that PR needs it: the dispatch functions in
`pr-provider.ts` run that repo's `gh` calls through `ghScopedRuntime`, which passes it as
`CommandOptions.env` (an optional argument both runtimes add to the process env for that one child),
so a `/api/pr-switch` to another repo runs as the active account; PR artifact downloads send it;
agent jobs get it from their launch PR (`ghAccountEnvForPRUrl` in both runtimes' `agent-jobs.ts`).
`checkAuth` answers `PRAuthResult { notice, childEnv }`: the Bun CLI prints the notice on stderr
("Using gh account X for this review: …") and adds `childEnv` to this PR's checkout steps only (the
clone, git fetches and worktree add of `--local`); it never goes in `process.env`, so the browser
opener, the update wrapper, Ask AI providers and other children never see it. Pi notifies it and runs
its checkout (clone, fork fetch, and every git step through `reviewRuntimeWithEnv`) with it; OpenCode
logs it. A token is never printed, logged or put in an error. Tests: `pr-github-account.test.ts`,
`packages/server/pr-gh-account.test.ts`, `apps/pi-extension/server/pr-gh-account.test.ts` and
`apps/hook/server/review-gh-account-cli.test.ts` (including `--local`, through a git wrapper that logs
which account's token each git call got), against a fake `gh` (`tests/helpers/fake-gh.ts`, which
asserts `Bun.which("gh", { PATH })` finds it) first on the PATH the code under test STARTED with:
`Bun.spawn` without an explicit env looks a command up through the PATH the process started with, not
a later `process.env.PATH`, so a runtime test runs in a child process
(`tests/helpers/gh-account-runtime-probe.ts`).

Interaction-model changes worth knowing (F8 and siblings): the agent-mode `Approve` primary
follows the `FeedbackButton` responsive pattern and is **icon-only below the `lg` breakpoint**,
where the old `ApproveButton` showed a compact `OK` label — the `title` carries the accessible
name, and compact/touch rows keep full labels. Approving despite annotations is now two clicks
(caret → `Approve, discard n annotations…` → `Discard & approve`) instead of the old dimmed
one-click Approve with its warning dialog, and `Mod+Enter` never stacks with the removed
approve-warning dialog — an open confirm dialog owns `Mod+Enter` outright (the
`data-plannotator-confirm-dialog` sentinel guard in the app's keydown effect; without it one
keystroke over the discard confirm would post two contradictory decisions). Accepted edge: the
compact `DecisionNoteDialog` keeps its draft locally and discards it if the item behind it leaves
the live spec (the dialog closes), while the desktop popover composer keeps drafts keyed by item
id — an intentional asymmetry, not a bug.

The review sidebar carries the durable human producer for review-level comments:
**"+ General comment"** renders in the Annotations tab's General section header (even with zero
general comments) AND in the all-empty state, opening the shared `DecisionNoteField` in a small
anchored popover whose width clamps to the resizable panel (200-600px persisted) so it never
clips inside the sidebar's `overflow-x: hidden` scroll area. Composer state (open + draft) lives
in `ReviewSidebar`, shared by both placements: the draft survives a dismissal, a placement flip
(an external annotation arriving mid-sentence moves the button from the empty state to the
section header), and a tab switch; collapsing the sidebar discards it. The producer is
deliberately present in platform (PR) mode too — a session-level comment there rides the posted
review body through the pre-existing `scope:'general'` handling in `buildFileScopedBody` /
`ReviewSubmissionDialog`. Unlike the header composer's submit note (one-submit lifetime), a sidebar
general comment goes through `addCodeAnnotationsWithHistory` — undoable, draft-persisted,
deletable — and both producers share one shape factory, `createGeneralReviewComment` in
`reviewDecision.ts`: `scope:'general'`, sentinel `filePath ''`/0/0, `review-note-` UUID id, and
deliberately **no PR context**, so the comment passes every PR scope predicate and survives an
in-place PR switch. Creating one raises `totalAnnotationCount`, which is what flips the header
control to `Send Feedback` — the control is state-driven, not wired to the button. The
feedback archive records each annotation's `scope` (additive `scope?: string` in
`packages/shared/feedback-archive.ts`'s normalizer, vendored to Pi), so a review-level general
comment stays distinguishable from a line comment in `index.jsonl`.

### Since-main default review view

The default code-review diff is **`since-base`** — a composite of `merge-base(base, HEAD)` vs the working tree plus untracked files ("everything a PR would show if you committed and pushed now"). It can render as a three-section **git status** panel (Committed / Changes / Untracked) via `SectionsPanel`, with a `Tree | Git status | Commits` toggle (`PanelViewToggle`). The Commits segment (local git and jj sessions; not GitButler, P4, workspace or PR mode) is a linear `--first-parent` history rail (`CommitsPanel`): clicking a commit opens its own diff (`commit:<sha>`, vs its first parent) as the all-files view headed by the commit message rendered as markdown. In a jj session the same rail and contract run over the jj family (`listJjCommitHistory` / `getJjCommitDiffInfo` in `packages/shared/commit-history.ts`, vendored to Pi): the rail is `first_ancestors(@) ~ root()` (jj >= 0.33), dropping `@` when it is the usual blank working copy (empty, no description, exactly ONE parent: a blank merge `jj new A B` stays, since its first-parent diff is real), `isHead` marks `@` (badge `@`, not `HEAD`), `shortSha` carries the short CHANGE id while `sha` stays the full commit id, and the divider is the jj compare target (`resolveJjCommitRailBase`: the session base, except an Evolution-diff base, which is not a line base, falls back to the context's line base; labeled by its bookmark). A click opens `jj-commit:<commit id>` — a separate family because providers claim diff types by prefix and git owns `commit:` (a pure jj repo has no git work tree), always addressed as `commit_id(<id>)` so a hex-named bookmark cannot shadow it — diffed `--from <first parent> --to <id>` (never `jj diff -r`, which compares a merge against all its parents), with hunk expansion, image previews, the fingerprint and the analysis snapshot going through the same per-VCS tables as every other jj type (`resolveJjSideRevs`, `getJjSnapshotRevsets`). jj REWRITES a mutable revision on every edit (the working copy on every snapshot) while the old id keeps resolving as a hidden commit, so the jj-commit fingerprint is visibility-aware (`commit_id(X) & ::visible_heads()`: `visible` / `hidden` / `gone`) — an opened `@` goes "Diff out of date" on the next save — and both servers' `/api/diff/switch` pass jj types through `canonicalizeJjCommitDiffType` (`packages/shared/jj-core.ts`), which maps a hidden id to its change's single current version (`change_id(<change>)`; divergent or abandoned changes stay put). Refresh therefore lands on the new `@`, and the client adopts the returned commit-family `diffType` even on an in-place (`preserveFile`) refresh. The feedback export labels a jj revision by its short change id (`commitShortId` from the `commitInfo` sidecar); git keeps the 7-char sha. Client code asks one question for both families: `commitShaFromMode` / `isCommitDiffType` (`packages/review-editor/utils/`), server code `commitFamilyId` (`packages/shared/review-core.ts`). The Commits view is a self-contained detour: entering it memoizes the previously active diff, exiting to Tree restores that diff verbatim (exiting to Git status resets to `since-base` as always), the memo clears whenever any non-commit diff is applied, and a reload that serves a commit-family diff with a non-Commits panel view snaps once to the session default so the commit diff cannot outlive the visit. The toggle never writes the persisted `reviewPanelView`/`defaultDiffType` pair (no server writes from a toggle click), but it does record a cookie-only last-used memo (`reviewPanelViewLastUsed`, `sections` | `tree` — never `commits`; the Commits view is session-only). A review OPENS on caller-pinned flags (`plannotator review --base <ref>` / `--diff-type <id>`, session-only: `openStatePinned` on `/api/diff` disables the panel-pair self-heal and never persists anything) ?? session choice ?? last-used memo ?? persisted `reviewPanelView` ?? the registry default, which is **`tree`** (cookie-only, written only by Settings through `setReviewPanelView()`, which also syncs the memo so an explicit choice is never shadowed by a stale one — except the App self-heal, which passes `recordLastUsed: false` to repair the diff half of a conflicted pair without touching the memo). There is no first-run chooser: a profile with no `reviewPanelView` cookie opens on Tree, which renders every diff type, and the `Tree | Git status | Commits` toggle plus Settings → Git are the two ways to change it. The persisted pair is coupled: the Sections view only renders `since-base`, so choosing a classic diff default snaps the persisted view to Tree and vice-versa (enforced in the Settings Git tab and by the coupled setters in `packages/ui/config/reviewView.ts`); with `tree` as the default the pair is trivially consistent for a reviewer who has chosen neither, so the App self-heal only ever fires for a profile whose `reviewPanelView` cookie already reads `sections` — chosen in Settings, or seeded by a build whose registry default was still `sections`.

**Staging display invariant:** `useGitAdd`'s `stagedFiles` is the EFFECTIVE staged set (sections-sidecar snapshot + session stage/unstage overrides) and is the only source any surface may render staging state from. The sidecar entry's `staged` flag is a snapshot — ORing it back in makes files unstaged mid-session render as staged (and inverts the next toggle).

`since-base` is only offered when the base ref actually resolves — on a repo whose trunk isn't discoverable (`trunk`, no `origin/HEAD`) `getGitContext` omits it and the default falls through to `uncommitted`, so committed branch work is never silently hidden. The since-base patch/sections/fingerprint/file-content paths all degrade to `HEAD` together when merge-base fails for a resolvable-but-unrelated base. There is no first-run review-setup dialog (`ReviewSetupDialog` was removed, as `DiffTypeSetupDialog` was before it): the panel view simply defaults to Tree and the panel toggle / Settings → Git change it. The one-time dialog chain is guide intro → look-and-feel → Edit Mode → token hover cards → the terminal-tools announcement; none of the dialogs stack. The token hover announcement is last and additionally skips a session where hover cards cannot run at all (no live workspace), WITHOUT consuming its cookie, and never shows to a reviewer whose trigger is already non-default (which after the boolean-to-trigger migration is exactly the early adopter who turned cards off). Analysis layers no longer add a startup dialog: Semantic Changes retains its enabled default, while Call Flow remains disabled until the user explicitly enables it in Settings, which is also consent for its managed runtime installation.

### First-run terminal-tools announcement

A one-time panel announcing Plannotator's two terminal clients, **Plannotator
TUI** (`plannotator/plannotator-tui`) and **Herdr Annotate**
(`plannotator/herdr-annotate`). One cookie covers every surface —
`plannotator-announce-tui-herdr-seen`, value `'1'`, read and written by
`needsTerminalToolsAnnouncement()` / `markTerminalToolsAnnouncementSeen()` in
`packages/ui/utils/terminalToolsAnnouncement.ts` — so dismissing it in plan
review retires it in annotate and code review too, and vice versa. It is a
plain storage key rather than a settings-registry entry for the same reason
`lookAndFeelAnnouncement.ts` is: `configStore.ensureLoaded` seeds every
registry default into a cookie on first access, so a registry-backed flag could
never tell "never seen" from "seeded default".

The component is `packages/ui/components/TerminalToolsAnnouncementDialog.tsx`
(shared shell: portal, `z-[100]`, hand-rolled Escape + Tab wrap + focus
restore, `data-terminal-tools-announcement-dialog`). It is video first: the
real demo footage fills the top of the panel edge to edge, and the text under
it is one headline and one sentence, then one action row (star the two repos,
"Watch on X", "Got it"). There is no mock terminal, no install commands, no
feature list; the repo pages carry all of that. Two deliberate departures from
its siblings: the backdrop dismisses (the panel collects no decision, so there
is nothing to lose by closing it impatiently), and its keydown listener is
registered on the CAPTURE phase and swallows `Mod+Enter`, so a keystroke aimed
at the announcement cannot approve a plan or post a review behind it.

**Media is hosted, not bundled.** The two demos (`tui-herdr-full-demo` and
`tui-herdr-lite-demo`, mp4 + webm + poster jpg each, ~23MB together) live in
`apps/marketing/public/assets/` and are served from
`https://plannotator.ai/assets/` once the marketing deploy syncs them, the same
precedent as `GuideIntroDialog`'s hero image (the Edit Mode recording is small
enough to inline; these are not). The `<video>` is `muted playsInline loop`
with `preload="auto"`, mp4 first in source order, and `autoPlay` unless
`prefers-reduced-motion` matches, in which case the poster waits behind a
play button. A `Full | Lite` segmented switch (`role="tablist"`) swaps the
footage and the "Watch on X" link together; the panel is keyed per demo so
playback and load-failure state reset with it. If neither source can load
(offline), the frame keeps its place and shows a "Watch on X" link over it.
The panel's width follows the viewport HEIGHT as well as its width
(`min(1120px, 100%, (100dvh - 14rem) * 1280/806)`) so the video never
scrolls out of view on a short window. No CSP is involved: the app HTML ships
no `Content-Security-Policy`, and the servers only set one on sandboxed
artifact responses.

**Ordering: LAST in each app's chain, never first.** Code review gates it
through `terminalToolsAnnouncementCanShow` on guide intro, look-and-feel, Edit
Mode and token hover cards; the plan editor gates it on the
look-and-feel chooser, goal setup and permission-mode setup. The destination
spotlight and the auto-viewed toast were extended to defer behind it too, so
nothing stacks. Last rather than first because none of those dialogs consumes
this cookie: a session busy asking setup questions defers the announcement to
the next load instead of burning it, and that also puts it in front of the right
reader — someone opening Plannotator for the first time is still learning this
app, while the people who should hear that it now runs in a terminal are the
ones who already answered every setup question and see it on their next load.

Suppressed, never consumed, on: archive browsing and read-only shared plans
(which is also what the share portal serves, via `isSharedSession`), the
compact touch shell, and while the initial payload is still loading. The
guides.show portable viewer never mounts either App, so it is unaffected by
construction. `@plannotator/ui` exposes no first-run-suppression seam on
`configurePlannotatorUI`; a host that wants the announcement off installs its
own `storageBackend` (the documented escape hatch) and pre-seeds the key.

### First-run "Ask this session" announcement

A one-time panel for 0.28.0's integrated sessions: Ask AI answered by the agent session that opened
Plannotator, and reviews that no longer hold that session. Same shape as the terminal-tools
announcement above: `packages/ui/components/AskSessionAnnouncementDialog.tsx` (portal, `z-[100]`,
Escape / Tab wrap / focus restore, backdrop dismiss, capture-phase keydown that swallows
`Mod+Enter`, `data-ask-session-announcement-dialog`) and `packages/ui/utils/askSessionAnnouncement.ts`
(one plain cookie, `plannotator-announce-ask-session-seen` = `'1'`, shared by every surface; not a
settings-registry entry, for the same seeding reason).

**Who sees it:** only a plan review, annotate or code review session that is actually connected
right now: `/api/ai/capabilities` lists the session-bridge provider for `claude-code`, `pi` or
`opencode` and its status is not `gone` (`connectedAskSessionAgent`), and Ask AI is reachable on
the surface (the plan editor's `canUseAI` and not taken over by the annotate agent terminal; code
review's AI button). Everything else defers WITHOUT writing the cookie, so the reader sees it in a
session where it is true: no bridge (remote, a `--tailscale` tab of anyone but the machine's owner, Windows, the mod off, `-p`, Pi's
event-API path, OpenCode 1, an older CLI), a gone session, other origins, `PLANNOTATOR_AI=disabled`,
archive / shared / no-server sessions, the compact touch shell and the initial load. The headline
names the connected host and the footer always says "This session is connected"; there is no
setup variant. OpenCode's copy says "code review and annotate no longer hold the session" because
its plan review still does.

**Timing:** `useFirstRunAnnouncementWindow` (`packages/ui/hooks/`) lets it open only before the
reader's first pointer press, key press or focus into a text field, within 4 s of the initial load,
and never while a text field (a comment composer) or an iframe has focus. Work inside the raw-HTML
and live-app iframes never reaches the parent's listeners, so a window `blur` after the first
second (the viewer's own startup may focus its iframe) also closes the window. Capabilities can answer late (model
discovery), and a dialog that opened then would take focus mid-comment and be dismissed unread by
the next Space or Enter; instead it misses the load, cookie unwritten. Once open it stays until
dismissed.

**Ordering:** after the terminal-tools announcement and never on the same load
(`askSessionAnnouncementPendingThisLoad` is false while that cookie is unset), so a fresh browser
sees terminal tools first and this one on the next load; behind every chain dialog in both apps
(the permission-mode setup included). Code review's destination spotlight, auto-viewed toast and
history-shortcut guard defer behind it like they do behind terminal tools.

**Media:** real footage, hosted like the terminal-tools demos:
`apps/marketing/public/assets/ask-this-session-demo.{mp4,webm}` + `ask-this-session-poster.jpg`
(1280x800, ~35 s). Recorded from a real Claude Code 2.1.289 session (real plugin and mod, real
compiled CLI, real review app) whose model calls went to a scripted local stand-in for the
Messages API, so the question, the Read tool call and the streamed answer are real traffic with
scripted model text. Offline it says the video could not load; reduced motion waits on the poster.

### Agent tool switch: Settings row and first-run offer

The `plannotator` agent tool (off by default on Pi and OpenCode 2, on for the Claude Code mod and in Oh My Pi)
has a switch in Settings → General on plan review, annotate and code review, and a one-time
offer on Pi and OpenCode 2. Both read `parseAgentToolSetting(serverConfig)`
(`packages/ui/utils/agentToolSetting.ts`): present only when the server reports
`agentToolHost` and `agentToolEnabled` (the integration that launched the server has the tool),
so OpenCode 1, Codex, the classic hook and `@plannotator/ui` hosts (which pass neither
`agentToolSetting` nor `onAgentToolChange` to `Settings`) get nothing. An OpenCode bridge
alone is not enough: the plugin also reports that its host can register the tool (a
`tool.transform` domain) as `PLANNOTATOR_OPENCODE_TOOL_CAPABLE=1` on the CLI it launches and
`opencodeToolCapable` on its in-process plan server (`agentToolHostForServer` in
`packages/server/ai-runtime.ts`), so an OpenCode host without the domain, or an older plugin,
gets no switch and no offer. The row says when a change applies: the next Pi session, the next
time Claude Code / OpenCode / Oh My Pi starts (the mod and the OpenCode plugin decide once per
process; OMP may keep the extension loaded across its sessions), and what it costs per host
(`agentToolCostNote`: Pi and OpenCode about 800 tokens per request, Oh My Pi one short line).
Writes go through
`saveAgentToolSetting` (POST `/api/config` `{ agentTool }`, awaited, not the settings registry's
debounced best-effort write-back); the handlers answer 500 when the value did not reach
config.json (`agentToolSaveFailed`), and both surfaces show that. The row is locked with a note
when `agentToolEnv` is set. One `useAgentToolSetting` per App feeds both, so a change in one
shows in the other.

The offer (`AgentToolAnnouncementDialog`, `packages/ui/utils/agentToolAnnouncement.ts`, cookie
`plannotator-announce-agent-tool-seen`, a plain storage key for the registry-seeding reason)
follows the announcement shell (portal, `z-[100]`, Escape / Tab wrap / focus restore, backdrop
dismiss, capture-phase `Mod+Enter` swallow) but collects a decision. Approved design ("Loop";
design record, not in this repo): a theme-token SVG of the round trip over the question
"Do you use Plannotator as a skill?", two example requests, one line of why, the token cost,
and the buttons "No, I’ll just use slash commands" (initial focus) and "Yes, turn it on". The
copy is the approved design's; agree a change with the maintainer before editing it. The
dialog cannot close while a save is in flight, a failure shows the reason with "Try again",
success says when it starts and offers Done. Declining, Escape, the backdrop and a successful
save write the cookie; a failed
save does not. It shows only for a Pi / OpenCode 2 host (never Oh My Pi, where the tool is on by default) whose next-session value is off, never
chosen in config.json (`agentToolConfigured`), and not set by the env. Ordering: LAST in each
app's chain, after terminal tools (latched, `agentToolAnnouncementPendingThisLoad`) and after
"Ask this session" per load (`earlierAnnouncementMayShow`: that one was shown this load, or is
pending and its capabilities answer is outstanding or eligible), so never two announcements on
one load, while a reader who is never connected still gets the offer. Same deferrals as the
others (archive, shared, no server, compact, loading) and the same
`useFirstRunAnnouncementWindow`. Code review's destination spotlight, auto-viewed toast and
history-shortcut guard defer behind it.

### Review drafts and PR pushes (#1590)

Code-review drafts (`/api/draft`) are keyed by `contentHash(rawPatch)`, so a local review whose diff changes still starts without its old draft (unchanged, out of scope). **PR mode only** additionally stores the draft under a stable target key, `prDraftTargetKey(meta, scope)` = `pr-` + hash of platform + host + repo (`owner/repo` or GitLab `projectPath`, lower-cased) + PR number + diff scope (`layer` / `full-stack` are different patches). All of it lives in `packages/shared/review-draft.ts` (vendored to Pi); both review servers hold one `createReviewDraftSession()` and route `/api/draft`, `/api/feedback` and `/api/exit` through it (without a target key every call is the plain `draft.ts` call, including the historical always-`ok` save response).

- **Load** tries the patch key first and returns it unless the target copy is strictly newer by `draftGeneration`. The target copy is stamped server-side with the `patchKey` it was saved on plus `patchKeys` (every patch it was ever saved on); when served for a different patch the response carries `patchChanged: true`. Clients can forge none of these fields and never see the lists.
- **Delete** clears the patch key, the target key, and every remembered patch key, with or without a generation. A decision (`/api/feedback`, `/api/exit`) additionally clears every PR target the session saved to or restored from (an in-place `/api/pr-switch` or `/api/pr-diff-scope` moves the target, and a submit must not leave the earlier one behind); a client `DELETE` (clear-all, dismiss) touches only the target on screen.
- **Tombstones**: the target key's tombstone guards the whole logical draft — a save at or below it is rejected under BOTH keys (PR mode answers `409 { ok: false, found, draftGeneration }` instead of swallowing it), and a patch-key copy at or below it is not served.
- **In-place switches**: `/api/pr-switch` and `/api/pr-diff-scope` responses carry `draftState: { found, draftGeneration }` for the new keys. The client's `adoptDraftTarget` raises its generation to that floor (otherwise every save after switching onto a previously submitted target would be refused). When the target holds a draft, the hook loads it and AUTO-MERGES its items into the session through `onDraftTargetMerge` (skipping ids the session already holds or deleted this session; the app re-checks their anchors and shows a small non-blocking toast), then autosave saves the merge normally — no banner after a switch. The only wait: while that read is in flight, autosave skips writing under the new target (it would overwrite a draft it has not read). Each read is two attempts, each bounded by `TARGET_LOAD_TIMEOUT_MS` (5s), so a hung `GET /api/draft` fails instead of pausing autosave. If both attempts fail, the target counts as unreadable: autosave still never writes over it, and instead retries the read on each later save attempt, saving normally once a read succeeds. The next switch (or unmount) supersedes all of this, so nothing can stick. A per-switch counter makes a stale load from an earlier target a no-op. The page-load restore banner is unchanged.

Client side (`packages/review-editor`, `utils/codeAnnotationAnchor.ts`): in PR mode `withPRContext` records on each line comment `anchorText` (the anchored lines), `anchorContext` (two lines before and after on the same side plus the hunk header's function context, so a common line like `}` is not "still valid" by coincidence) and `anchorSnapshot` (the review snapshot id whose coordinates it uses). `reanchorCodeAnnotations` runs on restore (every in-scope line comment when `patchChanged`) and whenever the snapshot on screen changes: a comment whose text and context still match at the same side/lines is re-stamped; any other in-scope line comment, including one with no anchor fields, gets `outdated: true` and keeps its old line numbers (never dropped, never moved). File and general comments, and comments bound to another PR or scope, pass through. The app remembers the latest layer snapshot per PR, and `buildReviewSubmission` posts a line comment inline unless `canPostInline` refuses it: an outdated comment, or one stamped on a snapshot other than the one the page KNOWS for its PR. No evidence is not evidence of change: an unstamped comment, or one for a PR whose snapshot this page has not seen (after a reload only the PR on screen is known), posts inline. Refused comments go in the review body with the code they were written on; only a comment an anchor check marked outdated carries `OUTDATED_ANNOTATION_LABEL`. Restoring a draft whose patch changed does not restore Viewed marks on files still in the diff (`restorableViewedFiles`: the draft cannot tell which files the push touched), and every `/api/feedback` post, the platform path's status post included, carries `draftGeneration`. Outdated comments are not drawn on the diff (the review-state context filters them), show an "Outdated" chip and an Edit action in the sidebar, export under `OUTDATED_ANNOTATION_LABEL`, and a sidebar click opens their file without a scroll request.

### Image previews in code review (#1598)

A changed image whose patch chunk has no hunks (git's binary stub, our oversized stub, or a header-only GitHub/GitLab fallback chunk) renders as a Before/After preview (`packages/review-editor/components/ImageDiffPreview.tsx`) instead of the "Binary or oversized file" notice, in the single-file view and the all-files view, when the server advertises `imagePreviewSupported`. Added files show After only, deleted files Before only, identical bytes (pure rename, mode change) one pane plus "Contents unchanged"; panes stack under ~480px of width, in the compact shell, and for tall images. Cards fetch only once near the viewport (IntersectionObserver), abort on unmount, and keep a 64-entry object-URL LRU per snapshot; SVG is only ever shown through `<img src=blob:…>`. The notices stay the fallback: not an image → binary notice, an oversized stub over 10 MB → oversized notice. The all-files view takes the preview through a `renderImagePreview` render prop that only the review app's all-files panel sets, so the guide chain and the guides.show viewer keep the plain notice and never request images.

Freshness: the endpoint checks the snapshot id only, not a per-image VCS fingerprint (that probe per image would be expensive on a large PR). So for a working-tree side (uncommitted, unstaged, since-base, local-vs-remote, GitButler workspace) the After pane can show a file NEWER than the diff on screen if it changed after the snapshot; the "Diff out of date · Refresh" banner (the 5s `/api/diff/fresh` poll) covers that case, and a refresh re-binds every card to the new snapshot. Server reads run behind a 4-wide limiter that takes the request's abort signal (Bun `req.signal`, Pi the response `close`), so reads queued for cards the reviewer scrolled past are dropped before they run, and no platform API call starts for a request that is gone. The client cache holds at most 64 sides and 128 MB, never revokes an object URL a mounted `<img>` still uses, and ignores a response that arrives after the page moved to another snapshot.

Server side, every decision is in `packages/shared/review-image.ts` (vendored to Pi): eligibility via `findPatchFileEntry`, caps (`MAX_REVIEW_IMAGE_PREVIEW_BYTES` 10 MB, `MAX_REVIEW_IMAGE_PREVIEW_PIXELS` 50 MP, both in `packages/core/diff-paths.ts`), sniffing, header dimensions, error mapping and headers; both servers only say where the current mode reads a side, behind a 4-wide read limiter. Which object each side is comes from ONE table per VCS shared with hunk expansion: `resolveDiffSideSources` (git), `resolveJjSideRevs` (jj), `resolveGitButlerSideSources`; bytes come from `readDiffSideBytes` (`git cat-file --batch-check` then `cat-file blob <oid>`, never `show`; worktree reads refuse symlinks and require the realpath inside the repository toplevel) over the optional runtime methods `runGitBytes` / `readFileBytes` / `realPath` / `runJjBytes` (absent means unavailable). PR mode reads the local checkout at the fixed merge-base/head commits first and falls back to `fetchPRFileBytes` (GitHub contents API, then the blobs API for files over 1 MB after a size check; GitLab JSON files API), base64 in both cases so bytes survive the CLI's text stdout. Workspace mode delegates per child repo (`WorkspaceReviewSession.getFileBytes`). Off: static patch, P4, the guide chain and guides.show.

### Package changes in code review

A changed `package.json`, `package-lock.json` (or `npm-shrinkwrap.json`), `bun.lock`, `pnpm-lock.yaml` (v6 and later) or `yarn.lock` (classic and Berry) gets a quiet card under its header listing the dependencies the diff adds, removes, upgrades, downgrades, changes or moves between sections, in the single-file and the all-files views (`PackageChangesCard.tsx`). Read-only hosts (the guide chain, guides.show) set neither seam (`packageChangesAvailable`, `renderPackageChanges`), so they never fetch or draw it; a static patch has no files behind it and gets nothing.

- **Server-side derivation.** `GET /api/package-changes` reads both sides of every manifest and lockfile in the diff (plus the `package.json` beside a changed lockfile, for yarn.lock's direct dependencies, new side only) through the per-side byte reader the image routes use (`readReviewSide` in both servers, up to 32 MB a side, 4 reads at a time) and runs `analyzePackageChanges` (`@plannotator/core/package-changes`). A side the diff says exists but that comes back missing, too large or from a failed platform call is **unreadable** (`PackageUnreadable`), never absent: the card shows the quiet error row ("Unreadable bun.lock", the side and reason in a tooltip), never a table of removals. A lockfile that does not parse, or a yarn.lock whose `package.json` cannot be read, gets the same row. A manifest's rows show the versions its governing lockfile (the nearest changed lockfile in the same or a parent directory) resolved, else the spec's floor; a resolved bump inside an unchanged range is still a row. The card nearest the lockfile also carries the other workspaces' direct changes (tagged with the workspace directory) and a fold of the indirect packages whose versions changed. A changed lockfile gets its own card only when no changed manifest it governs is in the diff (a Dependabot lockfile bump); in the all-files view that card stays visible while the lockfile is folded as a generated file. A lockfile that does not read or parse leaves the manifests on their ranges.
- **Ecosystem seam.** Each ecosystem is one `PackageEcosystem` entry (file names, manifest and lockfile readers, spec classification, version order); npm is `package-changes-npm.ts`. Cargo, Go and Python are planned as further entries.
- **npm lookup (consent).** Off by default. "Look up N on npm" on any card saves config.json `packageChanges.lookup: true` (POST `/api/config`) and every card then looks itself up, so N is every name the review would send (`lookup.total`, the union across cards), not the card's own. Settings → Analysis turns it off; `PLANNOTATOR_PACKAGE_LOOKUP=0` is a hard off (and then no registry setting is read at all). The server enforces it: `POST /api/package-changes/lookup` answers 403 until it is on, takes only a card path, and sends that card's `lookup.names`, which the server listed.
- **What may be sent (fail closed).** A name leaves the machine only when every registry setting that could route it elsewhere was read and none does (`package-changes-service.ts`, `packageRouting` in `package-metadata.ts`). Settings are read where the package manager reads them: in a local or workspace review, from the working tree on disk in every directory from the card (and its lockfile) up to the filesystem root, so a gitignored or untracked `.npmrc` counts whatever the diff mode; in a PR review, at the PR head commit: from the local PR checkout when it holds that commit (one `git ls-tree`, then only the settings files that exist; no GitHub call), else through the platform API, at most `REMOTE_SETTINGS_READS` (16) calls per head commit, and a PR that would need more (a monorepo PR touching packages in several folders) withholds every name and offers no button. On first load the PR checkout is usually still being prepared: the card waits for it (`prepare` on the host: Bun `ensurePRLocalCwd`, Pi `worktreePool.ensure`), and reads through the API only when no checkout can exist, or after `PACKAGE_CHECKOUT_WAIT_MS` (18 s), in which case the result is not kept and the next look reads again. Without a checkout the package files themselves cost at most `REMOTE_PACKAGE_READS` (20) calls per base and head commit: the cards that fit are drawn and nothing is offered for lookup, since the total a click would send is not knowable. Settings and package-file reads are kept per head commit, so a new snapshot of the same PR costs nothing (`prSettingsSource` in `package-changes-service.ts`; `packages/server/package-changes-pr.test.ts` counts the `contents` calls for 1, 5 and 30 cards, with and without a checkout); always the user's own files (`NPM_CONFIG_USERCONFIG` or `~/.npmrc`, the global `npmrc` from `NPM_CONFIG_GLOBALCONFIG`, else `$PREFIX/etc/npmrc` for `NPM_CONFIG_PREFIX`, the node on `PATH` and the usual prefixes, `~/.yarnrc.yml`, `~/.yarnrc`, `~/.bunfig.toml`, `$XDG_CONFIG_HOME/.bunfig.toml`) and the environment (any `npm_config_*registry` key, case-insensitive, scoped ones included; `YARN_NPM_REGISTRY_SERVER`, `YARN_REGISTRY`, `YARN_NPM_SCOPES`, `BUN_CONFIG_REGISTRY`). Files per directory: `.npmrc`, `.yarnrc.yml` (or `YARN_RC_FILENAME`), `.yarnrc`, `bunfig.toml`. A scope is withheld when set to another registry in `.npmrc` or `.yarnrc`, or configured at all in `.yarnrc.yml` `npmScopes` (block or flow style, any indent) or `bunfig.toml` `install.scopes`; every name is withheld when the default registry is not npm's, when a settings file exists but cannot be read (a directory, over 1 MB, permission denied), when a PR read fails (a gh error or rate limit), or when the working tree cannot be located. A package the lockfile fetches from anywhere but `registry.npmjs.org` / `registry.yarnpkg.com` (`resolved` in package-lock and yarn.lock, `tarball` or a git resolution in pnpm, bun.lock's registry slot, git and tarball versions) is marked `privateSource` and withheld on every card. Withheld names show a lock icon.
- **Lookups.** The full packument (license, per-version publish time, deprecation) and the downloads API (bulk for unscoped names, one request per scoped name), 4 at a time, one in-flight request per package however many versions ask, 8 s timeout, cached 1 h in memory up to 2,000 entries per cache (`packages/shared/package-metadata.ts`).
- **Card.** Header: fold (one remembered choice for every card, cookie `plannotator-package-changes-folded`), icon, "Packages", count, and on the right either the consent button ("Look up N on npm"; its tooltip says N counts every card in the review) or a failure word with Retry. Columns, old then new: Package (change icon with a tooltip, name, section and workspace tags, lock, deprecated pill), Previous ("—" for an addition or a section move), Version (the warning tone for a semver-breaking step, said in its tooltip with the spec; ↑ and ↓ are both neutral), then after the lookup License, Released (under 7 days in the warning tone) and Downloads (weekly, smaller and fainter, last; `SHOW_DOWNLOADS` drops the column). A row npm was not asked about leaves those three as one blank span. A failed lookup shows only its status and Retry, no lookup columns. Eight rows, then "N more"; the indirect fold shows 100 at a time ("N more"). Under 600 px the rows stack in the same order (old → new) and a native select sorts. No keyboard shortcuts.
- **Settings → Analysis**: "Package changes" (config.json `packageChanges.card`, default on; off hides every card) and "Look up packages on npm" (`packageChanges.lookup`). Both ride serverConfig `packageChanges: { card, lookup, lookupEnv? }` through `usePackageChangesSetting` (`@plannotator/ui/hooks`), not the settings registry. A server that does not advertise it gets no card.

### File kinds: Code, Tests, Generated

Approved design record "review-file-kinds" (not in this repo). One pure classifier, `fileKind(path, generated?)` in `@plannotator/core/file-kind` (vendored to Pi), sorts every changed file into `code`, `test` or `generated`: **generated** is the host's generated set when it has one (the review server's `generatedFiles`, `.gitattributes` included), else the built-in name list; **test** is a test file name (`*.test.`, `*.spec.`, `*.cy.`, `*.e2e.`, `*.test-d.` or `*_test.` followed by a code extension (`CODE_EXT`: ts, tsx, js, py, go, rs, java, kt, rb, cs, ...), with a name before the marker; `*.stories.*`; `test_*.py`, `conftest.py`, `tests.py`; `*.snap`) or a folder above the file named `__tests__`, `__snapshots__`, `__fixtures__`, `__mocks__`, `test`, `tests`, `spec`, `e2e`, `fixtures`, `testdata` or `testFixtures` (case-insensitive), a Gradle source set `src/<name>Test`, or a .NET `*.Tests` / `*.UnitTests` project; **code** is everything else, docs and config included. `contest.ts`, `latest.ts`, `test.ts`, `testing-library.config.js`, `openapi.spec.yaml` and `load_test.md` stay code. `groupByFileKind` splits a list in that kind order, keeping each item's order. The three glyphs (angle brackets, a flask, a package) are `FileKindIcon` in `@plannotator/guide-viewer/FileKindIcon`, shared by the review app, the Inbox and guides.show.

- **Tree** (`FileTree`, `utils/fileKindTree.ts`): with "Group by kind" on (Tree controls popover, default on, cookie `plannotator-review-group-by-kind` = `off` when turned off; deliberately not a settings-registry entry, which the guides.show viewer bundles) and two or more kinds, the tree is one block per kind, each today's folder tree, under the status view's section header (`PanelSectionHeader` in `FileRowBits.tsx`, which `SectionsPanel` uses too) plus the icon, file count, viewed/total and +/-. A header folds its block in the tree only; Generated starts folded. Folder paths are scoped per block (`kind:path`), so the expansion hook and collapse-all keep working. j/k/Home/End follow the block order. A file that becomes active by any route (j/k, a click in all-files, the scroll highlight, an annotation or search jump) opens its folded block, as folded folders open for the active file; a new file list never does, so Generated stays folded when a diff loads. With hide-viewed on, a block whose rows are all hidden hides its header too. The all-files surface follows it too (`fileOrder: 'kind'`, `getFileKindOrder`); the Git status view keeps its sections and the Commits view its tree order. One kind, or the switch off: today's tree.
- **Flask**: test files get it in diff headers (`FileHeader` `isTest`, from `AllFilesCodeView` and the single-file panel) and on Git status rows. Tree rows inside a block get no icon.
- **Guided Reviews** (`GuideSectionCard`): within a chapter, files come together by kind (code, then a "Tests N" subhead, then "Generated N"), the author's order kept inside each kind; subheads show only with two or more kinds; diff cards follow the chip order; test cards stay open and generated cards start folded (`GuideFileCard` `kind`). Hosts may pass `generatedFiles` on the guide host (the review app does); the Inbox and guides.show use the name list. No change to the guide format, prompt or export. It costs the guides.show viewer about 1.3 KB gzip, inside its 400 KB budget.

### Markdown preview in code review

Approved design: owner-approved variant C (design record, not in this repo). A Markdown file (`.md`, `.mdx`, `.markdown`, config.json `markdownExtensions`) can be shown rendered instead of as a line diff.

**Controls.** One control per Markdown file (owner, 2026-10-12 controls amendment, variant "Menu"): a button in the file's header naming its view with a chevron ("Source ▾"), opening a menu **Source** (the line diff), **Changes** (the rendered diff) and **Read** (the whole document rendered, no diff marks), in that order, the same words everywhere. Added and deleted files, and a rename that changed nothing, offer Source and Read only (`markdownViewsFor` in `utils/markdownPreview.ts`; a wish for Changes there resolves to Read, `resolveMarkdownView`). The menu is Base UI's (`components/MarkdownViewMenu.tsx`: `role="menu"` with `menuitemradio` items and `aria-checked`, arrows, Home/End, type-ahead, Escape back to the button); its title says "Select text to comment" in a rendered view. In the compact touch shell the same button (drawn 36 px, a 44 px hit area from an `::after` box) opens the same items as a bottom sheet titled "Show <file> as". There is no global button and no switch inside the file. Defaults: every file starts in Source (approved); a view picked on any Markdown file becomes the starting view for every Markdown file not set by hand in this review, so those follow on screen, and it is remembered for the next review in the cookie `plannotator-markdown-view` (`source | changes | read`; cookie only, deliberately not a settings-registry entry, which is bundled into the guides.show viewer; the earlier `plannotator-markdown-preview-all=true` is read once as `changes`, rewritten under the new name and removed). A file set by hand keeps its view for the session. Navigation that needs a view (a search hit or a line comment needs Source, a rendered comment its own view, the "not in this view" action) sets that one file only and remembers nothing across reviews (`show`, vs a person's `choose`); like a pick, it pins that file for the session, so a later pick on another file does not move it (chosen over "navigation leaves no override" because yanking the file away from the search hit or comment the person just jumped to would be worse). While a file holds the edit session (All files; it is always in Source then, since Edit is refused on a rendered file), its view is locked: starting the session pins the view it shows (an override, as if set by hand), so a pick or `P` on another file, which moves every file not set by hand, cannot move it; a pick, `P` or navigation aimed at it is refused; its menu is disabled with "Finish editing first" in All files and in the single-file view (`markdownViewDisabledReason`), and `P` on it shows that as a toast (`onLocked`). A search hit in it scrolls in place (the session's file always shows its diff). The pin stays after the session ends (the file keeps Source until picked), and the swap effect re-runs when the session ends, so nothing held back stays half-applied (`lockReason` / `setEditingFile`; `AllFilesCodeView` reports the session's file through `markdownPreview.onEditingFileChange`). `P` reads its key target from `composedPath()[0]`, so typing `p` in the Pierre editor (a shadow root) never switches views. Key (`review-markdown-preview` scope in `packages/ui/shortcuts/code-review/`, so help and the docs page list it): `P` steps the open file (in All files, among the files intersecting the viewport, never the overscan: the Markdown file holding focus or under the pointer, else the top-most Markdown file, resolved when the key is pressed through `markdownPreview.registerViewTarget`) Source -> Changes -> Read -> Source, skipping Changes where the file has none, and counts as a pick; never while typing, off a diff, or on a code file. There is no `Shift+P`: a pick already moves every file not set by hand, so an "every file" key would only override files the person set on purpose. Files shown in Changes or Read show an eye in the file tree. The control is not drawn by `FileHeader` itself (`renderMarkdownView` slot): `DiffViewer` draws it, and in All files the panel passes `renderViewControl`, whose component reads review state from context, so a Changes <-> Read switch relabels it without republishing the CodeView item; read-only hosts (the guide chain, guides.show) carry none of it. State: `useMarkdownPreview` / `useMarkdownPreviewKeys` (`packages/review-editor/hooks/useMarkdownPreview.ts`), on review state as `markdownPreview`, absent (no UI anywhere) without the advert or with no full contents (static patch).

**What the rendered views show** (`components/MarkdownFilePreview.tsx`, lazily loaded). Changes is plan review's `PlanCleanDiffView` over `computePlanDiff(old, new)` with its review-only seams (`renderBlock`, `lineGutter`, `foldUnchanged`, `unchangedClassName`; see `packages/ui/HANDOFF.md`): added, removed and changed sections (classic stacked old over new), unchanged runs folded behind "N unchanged sections", source lines in a gutter. Read renders the new version whole (a deletion: the old one). Both render blocks through `BlockRenderer`, except Mermaid and Graphviz fences, which draw as diagrams with the engine the review server serves on demand (see "Diagrams in code review, loaded on demand" below; read-only: no diagram comments, the preview's rendered-text comments are unchanged; without the engine they render as code), images through the per-revision route below (old side for removed sections, new side otherwise), links through the PR's resolver (a file of this review opens in the review; anything else is inert). In a PR review (`prMetadata`; `holdRemoteImages` overrides) a remote image is held behind a placeholder: any source a browser would fetch from another server, read the way a URL parser reads it (`isRemoteImageSource`: tabs and line breaks dropped, a backslash counts as a slash, so `https:host/a.png`, `https:/host/…`, `https:\\host\…`, `//host` and `\\host` all count; every `http(s):` source does, holding one too many being harmless), and a line above the document says how many with **Load remote images**; a click on that button or on any held placeholder loads them for that preview, so opening a stranger's file never tells a tracking pixel's server the reviewer's IP address. Repository images always load through the route. Local reviews load remote images as written. Added and deleted files show their one side whole (the header's status letter and the green or red rail say which); a rename with no change says so. Both sides must still agree with the patch on screen (`markdownPreviewSides`), else "changed after the diff was captured"; over 300 KB a side asks first (Preview anyway). A search hit, a line comment opened from the sidebar, or a line selection sends the file back to Source. In All files the card lives in the item's header slot (measured like an image preview) and the item's diff is swapped for a hunkless one while previewed (`markdownPreviewFileDiff`; the real one, including a full-content augmentation, waits in `fullDiffsRef`); hosts that pass no `markdownPreview` prop (the guide chain, guides.show) get none of it.

**Comments.** The PR description's experience: `useAnnotationHighlighter` in comment mode on the rendered text, select anything and the composer opens. The result is an ordinary file-scoped `CodeAnnotation` carrying `markdownPreview: { originalText, view, diffContext?, startMeta?, endMeta? }` (`packages/ui/types.ts`), so it is listed in the sidebar under its file (with a "rendered" tag and the quote), shown in the file's comment banner in Source, drafted, undoable, and counted. In the other view it is found by its text (stored positions only apply in the view it was made in); when the text is not there (a comment on removed text, seen in Read) the preview says how many comments are not in this view, with "Show in Changes" / "Show in Read". The export prints it under its file as "Comment on the rendered Markdown" with the quote and, in the rendered diff, "(in added / removed / changed text)" (`markdownPreviewQuote`). In a PR review it always goes into the review body with the quote, never inline and never as a file-level thread (`buildFileScopedBody`). Line comments are not drawn in the preview (the header says so). The feedback archive records the quote as `originalText`.

**Capability.** Every diff payload carries `markdownPreviewSupported` beside `imagePreviewSupported` (`/api/diff`, `/api/diff/switch`, `/api/pr-diff-scope`, `/api/pr-switch`, both runtimes): true wherever `/api/file-content` can read a full file, i.e. every session except a static patch. Absent (an older server) reads as false, and the client then shows no preview UI.

**Images.** A previewed Markdown file's images load through `GET /api/review-markdown-image?doc=&side=old|new&src=&snapshot=` (`packages/shared/review-markdown-image.ts`, vendored to Pi; `handleReviewMarkdownImageRequest`), read at THAT side's revision, never from the working tree by default, so a deleted file, a PR or a committed diff shows the images it had. The rules, in order: the session must be one `/api/review-image` serves (`available` = `imagePreviewSupported`); `doc` must be a file in the current patch whose path at that side is Markdown (`.md`, `.mdx`, `.markdown`, or config.json `markdownExtensions`) and that side must exist (`404 not-in-diff` / `absent`); `src` (the source exactly as written; the client never trims it, and the route drops leading and trailing ASCII whitespace from it and from every reference alike, as a browser's URL parser does) must be a plain path — no scheme, `//`, backslash or control character, at most 2048 chars, `?query`/`#fragment` dropped, `%xx` decoded — naming an image by extension (`400 bad-request`, `415 not-image`), checked before anything is read; it resolves against the doc's folder at that side (a renamed doc's old side uses its old folder; a leading `/` is the repository root, GitHub's README rule; in a multi-repo workspace that is the workspace root), and one that climbs above the root is `403 outside-repo`; the doc's text at that side (read up to 2 MB, `413` past it) must reference `src` as an image — a markdown image (`![a](src)`, `<src>`, with a title), a reference-style image's definition, or an `<img src>` value (decoded), never one inside a fenced code block or an inline code span (`stripMarkdownCode`) — else `403 not-referenced`, so the route reads only what the file shows. In jj sessions every read names its path as a literal (`jjRootFileFileset`: `root-file:"…"`, `\` and `"` escaped, control characters as `\xHH`), never a bare path after `--`, which jj parses as a fileset expression (`a|b.png` would read `a` and `b.png`); this covers `/api/review-image`, this route and full-file contents, in both runtimes (`packages/server/jj-fileset-literal.test.ts`, real jj). The image itself goes through the same per-side reader as `/api/review-image` (one `readReviewSide` per runtime now serves both routes, behind the same 4-wide limiter) and is answered by the same tail, `reviewImageBytesResponse` in `review-image.ts`: the 10 MB / 50 MP caps, the LFS-pointer refusal, the sniffed `Content-Type`, the sandbox CSP, `nosniff`, CORP and `ETag`/304. Tests: `packages/shared/review-markdown-image.test.ts` (the decision table over a fake reader) and `packages/server/review-markdown-image.test.ts` (both runtimes against a real repo).

### Diagrams in code review, loaded on demand (#2096)

Owner approval "review-diagrams-on-demand" (2026-10-23; issue #2096). Mermaid and Graphviz fences in a Markdown file's Read and Changes views, and a guide overview's Mermaid diagram, draw with ui's diagram engine (`DiagramBlock`: themed, zoom, the popout), read-only. The single-file review page still carries no diagram runtime (the earlier owner rule: diagrams return to code review only through true lazy loading, never by bundling; `tests/entry-assets.test.ts`): the engine is three separate files the review server serves and the page imports by URL only when a preview or guide overview actually holds a diagram fence.

- **The files** (`apps/review/diagram-engine/build.ts`, run by `apps/review`'s `build` after the page build into `apps/review/dist/diagram-engine/`): `engine.js` (ui's `MermaidBlock`/`GraphvizBlock` → `DiagramBlock` path: canvas, overlay, popout, the renderer slot and sanitizer; about 190 KB, entry `engine.tsx`), `mermaid.js` (the Mermaid runtime with ELK, about 4.8 MB) and `graphviz.js` (`@viz-js/viz`, wasm inlined, about 1.3 MB), each a minified ES module. The engine brings no React and no copy of ui's stateful modules: imports of React, `react/jsx-runtime`, `react-dom`, `ThemeProvider`, `config` (the store), `utils/identity` and `utils/math` become modules that read the PAGE's instances from a host object (`DIAGRAM_ENGINE_SHARED_MODULES`, `packages/review-editor/utils/diagramEngineContract.ts`; Rollup `syntheticNamedExports`), so hooks, the theme context and the config store are the page's own. The build fails when the engine would bundle a stateful ui module (`packages/ui/config/`, storage, the theme registry, the identity and math slots, ThemeProvider), any repository module that defines a React context (its own `anchorClaims` excepted), React or a runtime. The renderer slots' `import('mermaid')` / `import('@viz-js/viz')` (exactly one site each in `utils/mermaid.ts` / `utils/graphviz.ts`, or the build fails) are rewritten to imports of the URLs the host carries, so the ui source and the guides.show viewer bundle are unchanged. Mermaid's own `import("katex")` goes to `utils/mermaid-math-slot`, which typesets `$$` labels with the page's math renderer, so the runtime carries no second KaTeX. The Source pane (CodeMirror) is stubbed out: code review never edits a diagram's source. `build:hook` copies the folder to `apps/hook/dist/diagram-engine/`; build:opencode and Pi's build copy it into their packages (`diagram-engine/`, gitignored, in each package's `files`).
- **Serving** (`packages/shared/diagram-engine-assets.ts`, vendored to Pi): the review server takes `diagramEngine` (the three files' text, or a function that reads them; the CLI's `apps/hook/server/diagram-engine.ts` reaches them through literal dynamic `import(..., { with: { type: "file" } })` and reads the embedded path with `Bun.file`, which `bun build --compile` embeds and a source checkout without the files survives (a `type: "text"` dynamic import of the 4.8 MB Mermaid file cost ~2.4 s of startup in a compiled binary on bun 1.3.14; on 1.4.4 both take ~2 ms, but Bun 1.4 stores a `type: "text"` import that is not pure ASCII as UTF-16, twice its size, so `type: "file"` keeps the binary ~5 MB smaller; the app pages are embedded the same way, see project-and-development.md); Pi and OpenCode read their package folder), hashes them off the request path at start (`warm()`), advertises `diagramEngine: { engine, mermaid, graphviz }` on `/api/diff` (paths `/assets/diagram-engine/<name>-<sha256 16 hex>.js`; absent when the host has no complete set) and answers `GET`/`HEAD /assets/diagram-engine/<name>-<hash>.js` with `text/javascript; charset=utf-8`, `Cache-Control: public, max-age=31536000, immutable`, `nosniff` and `Cross-Origin-Resource-Policy: same-origin`; any other name under the prefix is `404` (never the app page), other methods `405`. Remote and `--tailscale` sessions get them compressed exactly as the app page (`prepareAppHtml`'s new `contentType` argument; its cache now holds 8 bodies). Both runtimes: Bun `packages/server/review.ts`, Pi `apps/pi-extension/server/serverReview.ts`; the OpenCode 1 embedded `/plannotator-review` passes its package folder; OpenCode 2 runs the CLI. The host allowlist and the cross-origin write guard apply as to every route.
- **The page** (`packages/review-editor/utils/diagramEngine.ts`, `components/ReviewDiagramFence.tsx`): App reads the advert once from `/api/diff` (`parseDiagramEngineUrls`: three same-origin paths, else none) into review state (`diagramEngine`). `MarkdownFilePreview`'s `renderBlock` hands a Mermaid or Graphviz fence (`diagramLanguages`, now exported by `@plannotator/ui/components/diagramLanguages`) to `ReviewDiagramFence`, and `ReviewGuideHost` passes `renderOverviewDiagram` (`components/guide/overviewDiagram.tsx`, Mermaid only; an HTML picture keeps the chain's note). The first such fence installs the host (`globalThis.__plannotatorDiagramEngineHost`: the shared modules and the runtime URLs) and imports the engine by URL (`import(/* @vite-ignore */ url)`, which the single-file build leaves alone), once per page; the engine then imports each runtime on its first diagram of that kind. Until it lands the fence shows as code; a failed import shows the code with a quiet note and Retry, and is forgotten so a later fence tries again. No advert (an older server, a host without the files, the demo): code, as before. The Source view, a review without diagram fences and a guide without an overview diagram request nothing.
- **Measured** (2026-10-23, Apple M-series, compiled binaries of main and this change, 5 headless Chromium loads each): the review page grew 4.8 KB (17,199,799 to 17,204,622 bytes; 3 KB gzipped); the engine files are 192 KB, 4,835 KB and 1,318 KB; the median time from navigation to the file tree (about 485 ms), `/api/diff` (about 97 ms) and process start to ready (about 670 ms) were unchanged. Tests: `packages/review-editor/utils/diagramEngine.test.ts` (the loader), `components/MarkdownFilePreview.test.tsx` and `components/guide/overviewDiagram.test.tsx` (DOM: drawn by the engine, code without it, the note when it fails), `packages/server/diagram-engine-assets.test.ts` (both runtimes: the advert, the route's headers, 404/405, no engine, remote compression), `tests/entry-assets.test.ts` (the page imports no engine, only the loader imports by URL, the built files hold their runtimes apart with no bare imports), and `tests/e2e/review-diagrams.spec.ts` (compiled binary: Read and Changes draw both diagrams with each file requested once; a review without diagrams and the Source view request nothing).

### Durable viewed-file progress (#1136)

Viewed marks are independent of annotation drafts and survive feedback submission,
server restarts, and reopening a review. `packages/shared/review-progress.ts` owns
fingerprinting, storage and request validation, mirrored into Pi by `vendor.sh`.
`GET/POST /api/review-progress?snapshot=<snapshotId>` loads or updates progress;
writes carry the server-issued scope key and displayed per-file fingerprints and
reject stale snapshots. The review UI restores automatically through
`useReviewProgress`; explicit viewed/unviewed mutations (including auto-view and
stage-to-view) save immediately, and pending saves flush before switches/decisions.

Storage is `${dataDir}/review-progress/{scopeHash}/{pathHash}.json`: atomic per-file
records prevent independent tabs/processes from overwriting unrelated marks.
Local Git scopes include canonical worktree root, branch and comparison selection
(base ref only for base-relative modes), never HEAD except when detached. PRs use
their URL and layer/full-stack scope. Workspace/non-Git reviews and piped patches
keep the existing draft behavior. Local Git carries a generation-time
`fileIdentities` sidecar: `--raw --patch --no-abbrev` supplies object IDs, paths and
modes without changing rendered patch bytes or existing annotation draft keys.
Bounded worktree hashes are checked against the displayed index line; no live
files are read at click time. This also covers mode-only changes and pure renames.
Files without reliable identities (including oversized untracked files) cannot
restore as viewed. Platform text patches use per-file patch hashes when full IDs
are absent; opaque binary/metadata-only patches without IDs cannot restore.
A mismatch is unviewed regardless of the auto-mark setting. Explicit unchecks
override platform seeds; in-session auto-view suppression survives content refresh.
Progress loading has explicit loading/ready/unsupported/error states: unsuccessful
loads preserve current marks and retain the legacy draft fallback, and a later
mutation or flush retries errors. Requests and the entire pre-decision/switch flush
each have a five-second limit, so stalled persistence cannot block review actions
indefinitely; a timeout warns and unsaved edits remain pending for a later retry.
Legacy draft viewed fields are ignored only on
progress-enabled surfaces (and deferred while capability detection is pending).
Purge uninstall removes `review-progress`; ordinary uninstall preserves it.
Opt-out: `PLANNOTATOR_REVIEW_PROGRESS=0` or `{ "reviewProgress": false }` (see the
environment table); the server then captures no progress snapshot and the client
falls back to draft-based viewed tracking.

**Guided Review ticks mark files viewed (#1786).** Ticking a guide section
"Reviewed" (live job or `saved:{id}` guide) marks its files viewed through the
same path as the per-file Viewed checkbox (`handleGuideMarkFilesViewed` in
`packages/review-editor/App.tsx`: durable progress, auto-view suppression lifted,
`/api/pr-viewed` in PR mode). A file the guide splits across chapters is marked
only once EVERY chapter showing it is ticked; refs not in the diff on screen are
skipped; un-ticking unmarks nothing (`filesViewedByTickingSection`,
`packages/review-editor/utils/guideReviewedViewed.ts`). Not gated on the
auto-mark setting (it is an explicit gesture). Auto-mark on scroll still does
not run inside the guide. The guide chain and the guides.show viewer are
unchanged: the host wraps `onToggleReviewed` in `GuideScreen`.

### GitButler review invariants

GitButler is a distinct VCS provider, ordered after JJ and before Git in both Bun and Pi. It is selected only while symbolic `HEAD` is `refs/heads/gitbutler/workspace` (or legacy `gitbutler/integration`) and the repository has GitButler's local target-ref configuration; a leftover database or an ordinary branch with the reserved name is not detection. An active workspace requires `but >= 0.21.0` on `PATH`, and a missing/incompatible CLI is an explicit error rather than a fallback to ordinary Git staging against the synthetic workspace commit. `--gitbutler` forces this provider; `--git` remains the escape hatch.

The default `gitbutler:workspace` view is GitButler's reported merge base versus the working tree plus untracked files, so it includes every applied committed change and assigned/unassigned worktree change. Multi-branch stack views are committed-only merge-base→stack-tip Git diffs; branch views are committed-only first-parent segment diffs. Client IDs encode branch-name anchors, never GitButler's transient CLI IDs. Do not concatenate independent GitButler hunks: their bases can differ. Assigned worktree hunks stay in Workspace until GitButler exposes an authoritative combined stack diff.

GitButler assignment is not the Git index, so the provider never opts into stage/unstage. Git-status sections, commit history, remote-base discovery/fetch, and the first-run Git setup remain `vcsType: "git"` only. File expansion uses the exact object range for committed views and merge-base/working-tree pair for Workspace; fingerprints cover the visible Git content plus canonical stack/branch topology. Nested multi-repo mode maps only `workspace-current` to GitButler; staged/unstaged/last modes are unavailable when a GitButler child is present.

### Code-review Ask AI context

Ask AI's "changes under review" context for **code review** is generated by the shared agent-review prompt machine (`buildAgentReviewUserMessage` / `buildAgentReviewUserMessageForTarget` in `packages/server/agent-review-message.ts`) — the same machine the launchable review jobs use — and is **delivered on the user's messages, not the system prompt**. The review server computes it for the current view (`buildCurrentAiReviewContext` in `packages/server/review.ts`, mirrored in `apps/pi-extension/server/serverReview.ts`) and ships it as `aiReviewContext` in the diff payloads (`/api/diff` and the switch/PR endpoints). The client (`packages/review-editor`) latches it onto each question via `buildReviewContextPreamble` (`packages/ui/utils/aiPrompt.ts`): the full block on the first message and whenever the view changes, a short reminder otherwise (never re-pasting a large diff). This keeps the agent looking at exactly the on-screen changeset across every mode (uncommitted/untracked, branch, merge-base, stacked-PR full-stack, hide-whitespace, PR worktrees, workspace, GitButler, jj). The code-review system prompt (`buildCodeReviewPrompt` in `packages/ai/context.ts`) is intentionally role-only.

## Ask AI Provider Defaults

Ask AI providers are detected independently from installed/authenticated local CLIs, then the UI picks a default from the detected Plannotator origin. The mapping lives in `packages/core/agents.ts` (re-exported via the `packages/shared/agents.ts` shim) and is applied by `packages/ui/utils/aiProvider.ts`:

| Origin | Preferred Ask AI provider |
|--------|---------------------------|
| `claude-code` | `claude-agent-sdk` |
| `amp` | no dedicated provider; fallback to saved/server default |
| `droid` | no dedicated provider; fallback to saved/server default |
| `codex` | `codex-sdk` |
| `opencode` | `opencode-sdk` |
| `pi` | `pi-sdk` |
| `copilot-cli` | no dedicated provider; fallback to saved/server default |
| `gemini-cli` | no dedicated provider; fallback to saved/server default |
| `mistral-vibe` | no dedicated provider; fallback to saved/server default |

Automatic resolution is session-only and never writes a preference. Explicit per-origin choices are persisted in cookies, so a user can override the automatic match for one agent without changing the default for another.

**New chat (#1981).** Plan review, annotate and code review show a small **New chat** row above the Ask AI messages once there are any (`NewChatButton`, `packages/ui/components/ai/`; the optional `onNewChat` prop on `DocumentAIChatPanel` and the review `AITab`, absent for hosts, so their panel is unchanged; no keyboard shortcut). It calls `useAIChat().newChat()`: the thread and its Plannotator AI session id are cleared, so the next question starts a fresh session (a separate AI gets the full document or "changes under review" context again). Unlike `resetThread` (archive or goal setup; the editor no longer resets on a document switch, see #1001 below), `newChat` never stops anything: while a question is in flight (streaming, creating its session, or waiting on a busy "Ask this session"), or while a busy answer still offers "Ask when it finishes" / "Interrupt and ask now" (`hasPendingBusyChoice`), it returns false and the button is unavailable (`aria-disabled`, still focusable, the reason as its `aria-describedby` description), so no turn is aborted and no pending ask is dropped. It keeps the provider/model choice and the per-page record of the draft list the agent session already received (`deliveredDraftsRef`), because with "Ask this session" a new chat reaches the SAME host session, which still remembers earlier questions; there the button reads **Clear chat** and says so. Earlier chats are not kept to reopen.

**One chat per session, documents named by path (#1001).** In the plan/annotate editor, Ask AI is ONE chat for the whole Plannotator session, as code review's already was: switching files in a folder or bundle, opening a linked document, Back, the multi-message picker and a plan revision all keep the thread and its Plannotator AI session (`aiDocumentKey` in `packages/editor/App.tsx` is `session`; only archive and goal setup, other contexts, get their own, and **New chat** still starts fresh). The session is created from the document on screen at the first question (a separate AI gets it in its session context, unchanged; "Ask this session" gets its surface line), so that question carries nothing extra. A later question on a different document carries one short note leading the prompt (`askDocumentContext.ts`: `describeAskDocument`, `planAskDocumentContext`, `askDocumentParams`): the absolute path the reviewer is looking at now (how it is shown: rendered HTML, converted to markdown, "file 2 of 3"), "back on" when they returned to it, and up to 10 documents viewed earlier in this chat, most recent first, so the agent reads the files itself; never the document's text. A plan revision reads "The plan was revised to version N: <history file>" for a separate AI, from the additive `planPath` on `/api/plan` (both plan servers: the history version file holding the exact plan on screen; the revision poll re-reads it). "Ask this session" is never pointed at that copy (it is outside the project, so it could raise a permission prompt, and that agent wrote the revision): it gets the plan's own file, the additive `planFilePath` (Bun plan server, only while the hook's plan file holds the plan on screen; `PlanFile.path`), or just "The plan was revised to version N", and earlier versions are listed as "the plan (version N)". Only a document with no readable file (a converted URL page, an agent message, a plan from a server without `planPath`) carries its text, once, when it changes, and never to "Ask this session" (the agent wrote the plan or message, or can open the URL; a paste would stay in its context window). The same document twice adds nothing. The latch moves only once a question reached the session (`AskAIParams.onDelivered`, called once when the stream shows delivery; a busy or failed ask leaves it, and the retry that lands moves it), and a question that creates a session (first one, a provider switch, New chat) starts it over. Drafts still travel apart (`draftAnnotations` / `contextUpdate`, unchanged), and no system prompt changes. Tests: `packages/editor/askDocumentContext.test.ts`, the DOM test `packages/editor/askDocumentLatch.test.tsx`, and `tests/e2e/annotate-ai-history.spec.ts` (compiled binary: annotate file switches, and a `claude-mod-plan` revision).

**"Ask this session" (session bridge).** A host can let Ask AI be answered by the agent session that opened Plannotator instead of a separate SDK agent. The host implements the small `SessionBridge` interface (`packages/ai/session-bridge.ts`, vendored to Pi: `host`, `status()` = `ready | busy | blocked | gone`, `modes { turn, transient }`, `ask(req, sink, signal)`, optional `interrupt()`) and passes it as `sessionBridge` to the server (`startReviewServer` / `startAnnotateServer` / plan `ServerOptions` on Bun; review, annotate and plan review on Pi), which then registers `SessionBridgeProvider` under id `session-bridge` as the ONLY Ask AI provider, behind the unchanged `/api/ai/*` endpoints: with a bridge (in-process or pull) the SDK providers go into a separate catalog-only registry (`catalogRegistry` on `createAIEndpoints`, set by `createAIRuntime` / `createPiAIRuntime`), so `/api/ai/capabilities` lists only the bridge under `providers` and makes it `defaultProvider`, and `/api/ai/session` answers `503` for any other provider id whatever the client saved. The catalog-only providers exist so the agent-job launchers (Review Agents, Code Tour, Guided Review) keep their discovered Claude / Codex model lists: `?activate=<id>` naming one runs its discovery and reports it under `catalogProviders`, which only `useModelCatalogs` reads; Ask AI never reads that field. Without a bridge (no mod, OpenCode 1, remote mode) the SDK providers register exactly as before; in a `--tailscale` session with a bridge, a tailnet request from anyone but the machine's owner is answered by a second set of endpoints over the SDK providers (`tailnet` on `createAIRuntime`). `/api/ai/capabilities` adds `label` ("Ask this session · Pi") and live `sessionBridge { host, status, modes }` for it, `models: []` (no model picker). The provider, not the host, enforces one question at a time across threads (`ask_in_flight`), sends no system prompt (the question carries the `SESSION_ASK_HEADER` line plus the surface), and never interrupts implicitly: a busy session answers `agent_busy`, and the client re-asks with `/api/ai/query` `busyPolicy: "wait"` ("Ask when it finishes", streams `status: waiting` until idle) or `"interrupt"` ("Interrupt and ask now", host `interrupt()` then ask). `session_gone` / `session_blocked` offer no other AI (there is none): the answer shows a plain note that the session that opened Plannotator is gone, or waiting on this decision, and Ask AI cannot reach it. Abort cancels only our question; the runtime `detach()`es the bridge before teardown so a decision/exit never stops a turn already running. **Take-over (every host):** once another message enters the turn answering our question (the person typing into the session, another extension's steer; never a background task's notification, an engine notice, a compaction, or on Claude Code a peer session's message), the rest of that turn answers THAT message, so the host stops streaming at once, keeps what it already sent, and settles with the bridge error code `taken_over` (`SessionBridgeErrorCode`; the provider maps it to `session_taken_over` with `SESSION_ASK_TAKEN_OVER_TEXT`, the neutral "Another message entered this session while it was answering, so the rest of the reply went to that message."; the Claude Code mod sends `SESSION_ASK_TAKEN_OVER_BY_PERSON_TEXT`, "You typed into this session…", when it knows the person typed it). When the answer had already finished before the other message entered (the turn's last model response stopped with no tool call: Claude `end_turn`, Pi `stop`, OpenCode `finish: "stop"` with no `session.tool.input.started` in that step, since some OpenAI-compatible providers report "stop" on a tool-calling step; and some answer text was shown), it settles `done` instead: a follow-up such as Plannotator's own decision never turns a complete answer into a cut one. From then on neither a Stop nor "Interrupt and ask now" stops that turn: Stop only closes the question, and `interrupt()` refuses (`SESSION_ASK_TAKEN_OVER_INTERRUPT_TEXT`) while the taken-over run lasts. The client (`useAIChat`) treats `session_taken_over` as a note, not an error: the partial answer stays and `SessionAskNote` renders the text under it (`response.notice`). Per host: Claude Code mod, `prompt.submit` with the question turn's `turnId` from an allowlisted origin (see "Claude Code mod"); Pi, a `user` message, or a custom message other than ours delivered right after a `turn_start` (a steer or follow-up), in the run answering our question; a non-triggering display-only custom message (e.g. `plannotator-handoff`) is appended at `turn_end`, outside that window, and takes nothing over; the run stays protected until `agent_settled` (idle on Pi without it), so an error retry of the person's run is covered; OpenCode 2, a `session.inbox.delivered` for another row whose kind, read from `session.inbox.enqueued` (`item.type`), is `user` (synthetic, compaction, move and unseen rows never take over), after ours was delivered AND the model began answering (`session.step.started` or any answer output), so a command's session-URL notice promoted in the same batch as the question is not a take-over. **Older servers:** the pull server advertises the codes it knows as `features` on every poll answer (`SESSION_BRIDGE_POLL_FEATURES`, today `["taken_over"]`). A pull host (the mod's `bridge.ts`, `runPullSessionBridgeClient`) talking to a server without `taken_over` settles a take-over as `done` with the partial answer plus the note as its last paragraph (`takenOverFallback`), because an older server reads the unknown code as `failed` and its UI would replace the partial answer with the error. Client (`resolveAIProviderSelection`): a bridge in the list is the selection in every status, ahead of any saved pick; without one the order is unchanged. The saved provider cookies are never rewritten for this, so a pick still applies to sessions without a bridge; with a bridge the Ask AI bars and Settings → AI show only its label (no provider or model picker). Code review sends the diff's identity (`buildSessionReviewIdentity`), never the patch. **Draft annotations (#1748):** the session is the agent the feedback is FOR, so the reviewer's unsubmitted annotations never reach it as feedback. `/api/ai/query` ignores `contextUpdate` (the feedback export a separate AI still gets on every question after the first) for a bridge session; the plan/annotate editor instead sends `draftAnnotations`, a plain one-line-per-draft list (`formatDraftAnnotationsForAsk` in `packages/ui/utils/parser.ts`: `Draft 2 (line 14): comment on "…" — …`, no export title, no "pieces of feedback", no "Feedback on" headings, no skill injection), which `useAIChat` sends only when it differs from what the agent session last RECEIVED (`draftAnnotationsToSend`; recorded once the stream shows delivery, so a busy or gone ask resends it; kept per page, not per Ask AI session, because a new thread or a document switch is a new Ask AI session on the same agent session), and `''` once when every draft was removed. A string in the list that reads like the end marker (any case or spacing) is neutralized, so a draft or page text cannot close the frame early. `formatSessionAskText` frames it between the surface and the question with `SESSION_ASK_DRAFTS_LABEL` ("…Do not act on them; the reviewer will send them when ready…") and `SESSION_ASK_DRAFTS_END` (or `SESSION_ASK_DRAFTS_CLEARED`), in turn and transient mode alike; the system prompt is untouched. The annotate agent terminal's Ask prompt uses the same list and frame (`buildTerminalAskPrompt`, deduplicated per terminal session). Code review sends no annotations to Ask AI at all. **Pi** (`apps/pi-extension/pi-session-bridge.ts`): review, annotate, last and plan review (plan review no longer blocks the session, see "Pi plan review does not block" below), off in remote mode; the question is a `pi.sendMessage({ customType: "plannotator-ask", display: true, details: { askId } }, { triggerTurn: true })` turn read back from `message_start` / `message_update` text deltas / `tool_execution_start` / `agent_end`; listeners register once at load because `pi.on` returns no unsubscribe before Pi 1.0. **OpenCode 2** (`apps/opencode-plugin/opencode-session-bridge.ts`): review, annotate and last ask a real turn — `ctx.session.prompt({ id, text, delivery: "steer", metadata: { source: "plannotator-ask" } })` under a message id generated in OpenCode's own ascending `msg_` format, streamed back from `ctx.event.subscribe()` (`session.inbox.delivered` with our id starts the answer, then `session.text.delta` / `text.ended` / `tool.input.started`, ended by `session.execution.succeeded|failed|interrupted`), with `session.wait` + `session.context` as the fallback when the event stream is missing (upstream #44788). Delivery is "steer", not "queue", on purpose: every V2 command leaves its session-URL notice as a pending steer row, and a queued question would wake the session with that notice promoted alone as its own model turn (seen live on 2.0.22). Busy comes from the execution events cross-checked by a single outstanding `session.wait` probe; abort and "Interrupt and ask now" use `session.interrupt` (whole execution), only on a turn that is ours or on the reviewer's explicit choice. Plan review answers from context only ("Quick answer from this session · OpenCode", `modes { turn: false, transient: true }`): `submit_plan` is a pending tool call, so a real turn cannot run until the decision (a prompt sent then waits for the tool result, verified live), and `markPlanReviewPending` makes EVERY bridge on that session report `blocked` so nothing can interrupt the review. The quick answer is `session.generate` (no transcript write; verified live on 2.0.22 with OpenAI during a pending `submit_plan`, and `@opencode/ai`'s `normalizeToolHistory` fills the unfinished call with an error result for every provider); it still offers the model its tools, so the question carries `SESSION_ASK_TRANSIENT_NOTE` and an empty answer (a tool call) is reported as a failure. The embedded plan server takes the bridge in-process; review/annotate/last and the CLI plan fallback run the `plannotator` CLI as a child and use the pull bridge below. **OpenCode 1** has no bridge (a second adapter over V1's different message/event model, not a small lift). **Claude Code** answers through its mod over the pull bridge below (review, annotate, last and plan review, all real turns; see "Claude Code mod"); without the mod Claude Code has no bridge.

**Pull bridge (host-neutral, `packages/ai/session-bridge-pull.ts` server half, vendored to Pi; `session-bridge-pull-client.ts` host half).** For a host that runs the Plannotator server as a SEPARATE process and must not open a listener of its own (the OpenCode plugin's CLI child and the Claude Code mod). The host generates a per-launch secret and starts the server with `PLANNOTATOR_SESSION_BRIDGE_TOKEN` (>= 32 chars), `PLANNOTATOR_SESSION_BRIDGE_HOST` (`opencode` / `claude-code` / `pi`) and optional `PLANNOTATOR_SESSION_BRIDGE_MODES` (`turn,transient`; default `turn`). The Bun CLI takes that config at its very first line (`takeEnvPullSessionBridgeConfig`, cached once per process; `createAIRuntime` reads the cache) and deletes the three variables, so nothing it spawns (git/gh before the server starts, agent jobs, terminals, the auto-update wrapper) inherits the token. Deleting is only half of it: on Bun, `Bun.spawn`, `Bun.spawnSync` and node's synchronous `spawnSync` / `execFileSync` / `execSync` hand a child the environment the process STARTED with whenever `env` is missing or `undefined` (Bun's documented `SpawnOptions.env`), deleted variables included, and `Bun.which` without `{ PATH }` searches the startup PATH. So every such spawn passes the live env explicitly, `env: childEnv()` (`packages/shared/child-env.ts`, vendored to Pi; `childEnv(extra)` lays variables over it, an `undefined` value removes one) or an env built from `process.env`, and `Bun.which` gets `{ PATH: childPath() }`. The same holds for every other variable the CLI takes and scrubs (`PLANNOTATOR_HOST_RESULT_FILE`, `PLANNOTATOR_HOST_MESSAGES_FILE`, `PLANNOTATOR_HOST_REVIEW_ID`). Node's async `spawn` / `execFile` and Bun Shell read the live env. `tests/child-env-guard.test.ts` fails on a Bun or synchronous spawn without `env` (or with an optional `x.env` field that may be undefined) and on a one-argument `Bun.which` in the production trees (exemption: a `child-env-guard: <why>` comment), and `apps/hook/server/scrubbed-env-cli.test.ts` runs `plannotator review` as a real process with logging stubs for git, gh and the agent CLIs and checks none of them sees a scrubbed variable; `--tailscale` keeps it since #2166 (this machine and the owner's Tailscale login only; see "Ask this session" over the tailnet under "Tailnet sessions"). The runtime registers the same `SessionBridgeProvider` over it; it is off in remote mode (and an in-process bridge wins). Pi's `createPiAIRuntime` accepts the same config as its `pullSessionBridge` option (no env takeover: Pi itself always bridges in-process). The host learns the port (OpenCode: `PLANNOTATOR_READY_FILE`) and then talks to two endpoints on `http://127.0.0.1:<port>`, both `POST` + JSON with `Authorization: Bearer <token>`: `/api/ai/bridge/poll` `{ status?, modes?, waitMs? }` long-polls (clamped to 25s; answers early when there is work) and returns `{ commands, closing?, superseded? }`, commands being `{ type: "ask", askId, text, mode }`, `{ type: "cancel", askId }` and `{ type: "interrupt", interruptId }`; `/api/ai/bridge/event` takes one event or `{ events: [...] }` — `started`, `delta`, `tool`, `done`, `error` (per question, `code` one of `busy|blocked|gone|aborted|failed|taken_over`; anything else reads as `failed`); every poll answer also carries `features` (optional protocol features the server knows, `SESSION_BRIDGE_POLL_FEATURES`), `status`, and `interrupted { interruptId, ok, message? }` — and answers `409 { code: "ask_not_active" }` for a question that is no longer running, which tells the host to stop it. Commands are re-sent every ~5s until acknowledged (any event for that question; `interrupted` for an interrupt), so hosts dedupe by id. Guards, in order: a loopback Host with the server's own port (the runtime's `authorizeSessionBridgeRequest`, `403 session_bridge_forbidden_host`), no `Origin` header (`403`, a browser is never the host), the bearer token (`401`); without a pull bridge both paths answer `404`, which an older-binary-aware host treats as "no bridge". Liveness: until the host's first request the bridge reports `ready` (a question waits for the first poll); no first request within 30s, or 30s with no open poll after that, is `gone`, and a running question then fails `session_gone`. The newest poll supersedes an open one. A reviewer's Stop drops a question the host never confirmed, else queues `cancel` and frees the slot when the host confirms (or after 15s); `detach()` (decision / shutdown) drops only unconfirmed questions, and `dispose()` answers the open poll `closing`. Both runtimes route the two paths through `createAIEndpoints` (`pullBridge` dep), and Bun lifts the idle timeout for the poll (`isLongLivedAIEndpointPath`). Tests: `packages/ai/session-bridge-pull.test.ts` (fake host over the real client: streaming, early question, busy wait / interrupt, abort before and after pickup, host disappears, never connects, transient, bad token / Origin / rebinding Host, supersede, dispose, detach), `packages/server/ai-runtime.sessionBridge.test.ts` (env takeover, scrub, remote-off), `apps/opencode-plugin/session-bridge-cli.test.ts` (plugin ↔ CLI child end to end).

**Model lists come from the installed tools, not hand lists.** Claude's list is the SDK's `supportedModels()` against the installed `claude` (a throwaway process with no prompt, `settingSources: []` so no user hooks run, no MCP servers, 10s cap, ~0.5s measured); Codex's is the app-server `model/list`. Both run lazily behind the provider initializer (`?activate=` or the first session), never at startup; a success is kept for the process, a failure may be retried after 60s (`createBestEffortOnce`), and the capabilities answer marks each such provider's list `modelsSource: 'fallback' | 'discovered'` so the client forgets a fallback answer and retries on its next load. The same discovery captures the tool version once (`claude --version` run alongside it; codex from the app-server initialize `userAgent`, via `cliVersionFrom`), kept even when discovery fails, and the answer carries it as an optional `toolVersion`; every Claude/Codex model picker (Agents tab launchers, Guided Review, Ask AI bars, Settings) shows a muted `ModelSourceHint` line ("From your installed Codex 0.155.1", or the built-in-list variant on `fallback`) only when `toolVersion` is present, so a host that omits it gets no hint. Both runtimes share `createDeferredModelDiscovery`: an `?activate=` probe waits for discovery, and so does a session for every provider except Claude, whose sessions resolve the model against the current list while discovery finishes in the background, so the first Ask AI answer does not wait on it — except when that list is still the fallback and lacks the requested pick (e.g. `opus[1m]`), where the session waits for discovery rather than silently running a different model once. One shape, `CatalogModel` in `packages/core/model-catalog.ts` (id, label, efforts + default effort, fast mode, `resolvedId`), serves Ask AI AND the review / Code Tour / Guided Review launchers: `useModelCatalogs` (`packages/ui/hooks/`) fetches the same `/api/ai/capabilities?activate=` answer for the ONE engine a launcher is set to, and `useAgentSettings` resolves saved picks against it at read time (the cookie is never rewritten). ONE resolver, `resolveModelChoice`, is used by the launchers, Ask AI's client (`aiProvider.ts`) and the AI session endpoint: exact id → the alias whose `resolvedId` covers it → the same family's alias (`claude-opus-5` → `opus`) → the surface default (Claude `opus` for review, `sonnet` for tour/guide; Codex `''` = the model the Codex list marks default, except Guided Review, which prefers `gpt-6-luna` when offered: `PREFERRED_GUIDE_CODEX_MODEL`) → the catalog default; it never moves a pick onto a `[1m]` id unless the pick was one. Efforts clamp to the model's own levels, launches wait until the catalog settles, and a loading row shows meanwhile. The Claude catalog drops the SDK's `default` pointer row and adds a bare latest alias per family offered, and always offers `opus` / `sonnet` / `haiku` (some CLIs, e.g. Claude Code 2.1.141, name Opus only through the `default` row, whose description then supplies the version); alias labels carry the version parsed from the row's `resolvedModel` (`claudeModelVersion`: "Opus 5.5 (latest)"), since the SDK's `displayName` has none. Codex fast mode is dropped when resolution replaces a saved model with a different one; changing Fast or reasoning then re-keys the section to the model shown. Codex fast support is read from `serviceTiers` (a `priority`/`fast` tier) as well as the deprecated `additionalSpeedTiers`. The only static lists are the small `CLAUDE_FALLBACK_MODELS` / `CODEX_FALLBACK_MODELS`, used when discovery fails.

> **Codex transport note:** the `codex-sdk` provider id is a stable identifier only — it no longer uses `@openai/codex-sdk` / `codex exec`. It drives a long-lived `codex app-server` process over JSON-RPC (`packages/ai/providers/codex-app-server.ts`), which respects the user's/enterprise-managed approval policy and supports interactive Allow/Deny approvals. The id stays `codex-sdk` to preserve saved cookie preferences, the `agents.ts` mapping, and the UI reasoning-effort gate.

> **OpenCode transport note:** the `opencode-sdk` provider spawns its own `opencode serve` per process on an OS-assigned port (`port: 0`) and never attaches to a server it did not spawn (an attached server can't be cleaned up by us, and opencode's per-directory instances accumulate in it without eviction). The spawned server is closed on dispose and on process exit. Model discovery is deferred behind the provider initializer (`?activate=` from the model picker, or the first opencode session) exactly like Codex — nothing spawns at server boot, so the picker lists opencode with an empty model list until first activation. Regression-pinned by `packages/ai/providers/opencode-sdk.test.ts`.
