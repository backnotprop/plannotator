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
session where it is true: no bridge (remote, `--tailscale`, Windows, the mod off, `-p`, Pi's
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
(`agentToolCostNote`: Pi and OpenCode about 780 tokens per request, Oh My Pi one short line).
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

### File kinds: Code, Tests, Generated

Approved design record "review-file-kinds" (not in this repo). One pure classifier, `fileKind(path, generated?)` in `@plannotator/core/file-kind` (vendored to Pi), sorts every changed file into `code`, `test` or `generated`: **generated** is the host's generated set when it has one (the review server's `generatedFiles`, `.gitattributes` included), else the built-in name list; **test** is a test file name (`*.test.`, `*.spec.`, `*.cy.`, `*.e2e.`, `*.test-d.` or `*_test.` followed by a code extension (`CODE_EXT`: ts, tsx, js, py, go, rs, java, kt, rb, cs, ...), with a name before the marker; `*.stories.*`; `test_*.py`, `conftest.py`, `tests.py`; `*.snap`) or a folder above the file named `__tests__`, `__snapshots__`, `__fixtures__`, `__mocks__`, `test`, `tests`, `spec`, `e2e`, `fixtures`, `testdata` or `testFixtures` (case-insensitive), a Gradle source set `src/<name>Test`, or a .NET `*.Tests` / `*.UnitTests` project; **code** is everything else, docs and config included. `contest.ts`, `latest.ts`, `test.ts`, `testing-library.config.js`, `openapi.spec.yaml` and `load_test.md` stay code. `groupByFileKind` splits a list in that kind order, keeping each item's order. The three glyphs (angle brackets, a flask, a package) are `FileKindIcon` in `@plannotator/guide-viewer/FileKindIcon`, shared by the review app, the Inbox and guides.show.

- **Tree** (`FileTree`, `utils/fileKindTree.ts`): with "Group by kind" on (Tree controls popover, default on, cookie `plannotator-review-group-by-kind` = `off` when turned off; deliberately not a settings-registry entry, which the guides.show viewer bundles) and two or more kinds, the tree is one block per kind, each today's folder tree, under the status view's section header (`PanelSectionHeader` in `FileRowBits.tsx`, which `SectionsPanel` uses too) plus the icon, file count, viewed/total and +/-. A header folds its block in the tree only; Generated starts folded. Folder paths are scoped per block (`kind:path`), so the expansion hook and collapse-all keep working. j/k/Home/End follow the block order. A file that becomes active by any route (j/k, a click in all-files, the scroll highlight, an annotation or search jump) opens its folded block, as folded folders open for the active file; a new file list never does, so Generated stays folded when a diff loads. With hide-viewed on, a block whose rows are all hidden hides its header too. The all-files surface follows it too (`fileOrder: 'kind'`, `getFileKindOrder`); the Git status view keeps its sections and the Commits view its tree order. One kind, or the switch off: today's tree.
- **Flask**: test files get it in diff headers (`FileHeader` `isTest`, from `AllFilesCodeView` and the single-file panel) and on Git status rows. Tree rows inside a block get no icon.
- **Guided Reviews** (`GuideSectionCard`): within a chapter, files come together by kind (code, then a "Tests N" subhead, then "Generated N"), the author's order kept inside each kind; subheads show only with two or more kinds; diff cards follow the chip order; test cards stay open and generated cards start folded (`GuideFileCard` `kind`). Hosts may pass `generatedFiles` on the guide host (the review app does); the Inbox and guides.show use the name list. No change to the guide format, prompt or export. It costs the guides.show viewer about 1.3 KB gzip, inside its 400 KB budget.

### Markdown preview in code review

Approved design: owner-approved variant C (design record, not in this repo). A Markdown file (`.md`, `.mdx`, `.markdown`, config.json `markdownExtensions`) can be shown rendered instead of as a line diff.

**Controls.** One control per Markdown file (owner, 2026-10-12 controls amendment, variant "Menu"): a button in the file's header naming its view with a chevron ("Source ▾"), opening a menu **Source** (the line diff), **Changes** (the rendered diff) and **Read** (the whole document rendered, no diff marks), in that order, the same words everywhere. Added and deleted files, and a rename that changed nothing, offer Source and Read only (`markdownViewsFor` in `utils/markdownPreview.ts`; a wish for Changes there resolves to Read, `resolveMarkdownView`). The menu is Base UI's (`components/MarkdownViewMenu.tsx`: `role="menu"` with `menuitemradio` items and `aria-checked`, arrows, Home/End, type-ahead, Escape back to the button); its title says "Select text to comment" in a rendered view. In the compact touch shell the same button (drawn 36 px, a 44 px hit area from an `::after` box) opens the same items as a bottom sheet titled "Show <file> as". There is no global button and no switch inside the file. Defaults: every file starts in Source (approved); a view picked on any Markdown file becomes the starting view for every Markdown file not set by hand in this review, so those follow on screen, and it is remembered for the next review in the cookie `plannotator-markdown-view` (`source | changes | read`; cookie only, deliberately not a settings-registry entry, which is bundled into the guides.show viewer; the earlier `plannotator-markdown-preview-all=true` is read once as `changes`, rewritten under the new name and removed). A file set by hand keeps its view for the session. Navigation that needs a view (a search hit or a line comment needs Source, a rendered comment its own view, the "not in this view" action) sets that one file only and remembers nothing across reviews (`show`, vs a person's `choose`); like a pick, it pins that file for the session, so a later pick on another file does not move it (chosen over "navigation leaves no override" because yanking the file away from the search hit or comment the person just jumped to would be worse). While a file holds the edit session (All files; it is always in Source then, since Edit is refused on a rendered file), its view is locked: starting the session pins the view it shows (an override, as if set by hand), so a pick or `P` on another file, which moves every file not set by hand, cannot move it; a pick, `P` or navigation aimed at it is refused; its menu is disabled with "Finish editing first" in All files and in the single-file view (`markdownViewDisabledReason`), and `P` on it shows that as a toast (`onLocked`). A search hit in it scrolls in place (the session's file always shows its diff). The pin stays after the session ends (the file keeps Source until picked), and the swap effect re-runs when the session ends, so nothing held back stays half-applied (`lockReason` / `setEditingFile`; `AllFilesCodeView` reports the session's file through `markdownPreview.onEditingFileChange`). `P` reads its key target from `composedPath()[0]`, so typing `p` in the Pierre editor (a shadow root) never switches views. Key (`review-markdown-preview` scope in `packages/ui/shortcuts/code-review/`, so help and the docs page list it): `P` steps the open file (in All files, among the files intersecting the viewport, never the overscan: the Markdown file holding focus or under the pointer, else the top-most Markdown file, resolved when the key is pressed through `markdownPreview.registerViewTarget`) Source -> Changes -> Read -> Source, skipping Changes where the file has none, and counts as a pick; never while typing, off a diff, or on a code file. There is no `Shift+P`: a pick already moves every file not set by hand, so an "every file" key would only override files the person set on purpose. Files shown in Changes or Read show an eye in the file tree. The control is not drawn by `FileHeader` itself (`renderMarkdownView` slot): `DiffViewer` draws it, and in All files the panel passes `renderViewControl`, whose component reads review state from context, so a Changes <-> Read switch relabels it without republishing the CodeView item; read-only hosts (the guide chain, guides.show) carry none of it. State: `useMarkdownPreview` / `useMarkdownPreviewKeys` (`packages/review-editor/hooks/useMarkdownPreview.ts`), on review state as `markdownPreview`, absent (no UI anywhere) without the advert or with no full contents (static patch).

**What the rendered views show** (`components/MarkdownFilePreview.tsx`, lazily loaded). Changes is plan review's `PlanCleanDiffView` over `computePlanDiff(old, new)` with its review-only seams (`renderBlock`, `lineGutter`, `foldUnchanged`, `unchangedClassName`; see `packages/ui/HANDOFF.md`): added, removed and changed sections (classic stacked old over new), unchanged runs folded behind "N unchanged sections", source lines in a gutter. Read renders the new version whole (a deletion: the old one). Both render blocks through `BlockRenderer`; Mermaid and Graphviz fences render as code, never as diagrams (owner decision, performance wins: the single-file review build inlines every dynamic import, so even a lazy diagram import put ~6.7 MB of Mermaid/Graphviz runtimes into every review and ~600 ms before the file tree; `tests/entry-assets.test.ts` fails if the review app imports a diagram module or its bundle carries a diagram runtime; diagrams return only through true lazy loading, never by bundling), images through the per-revision route below (old side for removed sections, new side otherwise), links through the PR's resolver (a file of this review opens in the review; anything else is inert). In a PR review (`prMetadata`; `holdRemoteImages` overrides) a remote image is held behind a placeholder: any source a browser would fetch from another server, read the way a URL parser reads it (`isRemoteImageSource`: tabs and line breaks dropped, a backslash counts as a slash, so `https:host/a.png`, `https:/host/…`, `https:\\host\…`, `//host` and `\\host` all count; every `http(s):` source does, holding one too many being harmless), and a line above the document says how many with **Load remote images**; a click on that button or on any held placeholder loads them for that preview, so opening a stranger's file never tells a tracking pixel's server the reviewer's IP address. Repository images always load through the route. Local reviews load remote images as written. Added and deleted files show their one side whole (the header's status letter and the green or red rail say which); a rename with no change says so. Both sides must still agree with the patch on screen (`markdownPreviewSides`), else "changed after the diff was captured"; over 300 KB a side asks first (Preview anyway). A search hit, a line comment opened from the sidebar, or a line selection sends the file back to Source. In All files the card lives in the item's header slot (measured like an image preview) and the item's diff is swapped for a hunkless one while previewed (`markdownPreviewFileDiff`; the real one, including a full-content augmentation, waits in `fullDiffsRef`); hosts that pass no `markdownPreview` prop (the guide chain, guides.show) get none of it.

**Comments.** The PR description's experience: `useAnnotationHighlighter` in comment mode on the rendered text, select anything and the composer opens. The result is an ordinary file-scoped `CodeAnnotation` carrying `markdownPreview: { originalText, view, diffContext?, startMeta?, endMeta? }` (`packages/ui/types.ts`), so it is listed in the sidebar under its file (with a "rendered" tag and the quote), shown in the file's comment banner in Source, drafted, undoable, and counted. In the other view it is found by its text (stored positions only apply in the view it was made in); when the text is not there (a comment on removed text, seen in Read) the preview says how many comments are not in this view, with "Show in Changes" / "Show in Read". The export prints it under its file as "Comment on the rendered Markdown" with the quote and, in the rendered diff, "(in added / removed / changed text)" (`markdownPreviewQuote`). In a PR review it always goes into the review body with the quote, never inline and never as a file-level thread (`buildFileScopedBody`). Line comments are not drawn in the preview (the header says so). The feedback archive records the quote as `originalText`.

**Capability.** Every diff payload carries `markdownPreviewSupported` beside `imagePreviewSupported` (`/api/diff`, `/api/diff/switch`, `/api/pr-diff-scope`, `/api/pr-switch`, both runtimes): true wherever `/api/file-content` can read a full file, i.e. every session except a static patch. Absent (an older server) reads as false, and the client then shows no preview UI.

**Images.** A previewed Markdown file's images load through `GET /api/review-markdown-image?doc=&side=old|new&src=&snapshot=` (`packages/shared/review-markdown-image.ts`, vendored to Pi; `handleReviewMarkdownImageRequest`), read at THAT side's revision, never from the working tree by default, so a deleted file, a PR or a committed diff shows the images it had. The rules, in order: the session must be one `/api/review-image` serves (`available` = `imagePreviewSupported`); `doc` must be a file in the current patch whose path at that side is Markdown (`.md`, `.mdx`, `.markdown`, or config.json `markdownExtensions`) and that side must exist (`404 not-in-diff` / `absent`); `src` (the source exactly as written; the client never trims it, and the route drops leading and trailing ASCII whitespace from it and from every reference alike, as a browser's URL parser does) must be a plain path — no scheme, `//`, backslash or control character, at most 2048 chars, `?query`/`#fragment` dropped, `%xx` decoded — naming an image by extension (`400 bad-request`, `415 not-image`), checked before anything is read; it resolves against the doc's folder at that side (a renamed doc's old side uses its old folder; a leading `/` is the repository root, GitHub's README rule; in a multi-repo workspace that is the workspace root), and one that climbs above the root is `403 outside-repo`; the doc's text at that side (read up to 2 MB, `413` past it) must reference `src` as an image — a markdown image (`![a](src)`, `<src>`, with a title), a reference-style image's definition, or an `<img src>` value (decoded), never one inside a fenced code block or an inline code span (`stripMarkdownCode`) — else `403 not-referenced`, so the route reads only what the file shows. In jj sessions every read names its path as a literal (`jjRootFileFileset`: `root-file:"…"`, `\` and `"` escaped, control characters as `\xHH`), never a bare path after `--`, which jj parses as a fileset expression (`a|b.png` would read `a` and `b.png`); this covers `/api/review-image`, this route and full-file contents, in both runtimes (`packages/server/jj-fileset-literal.test.ts`, real jj). The image itself goes through the same per-side reader as `/api/review-image` (one `readReviewSide` per runtime now serves both routes, behind the same 4-wide limiter) and is answered by the same tail, `reviewImageBytesResponse` in `review-image.ts`: the 10 MB / 50 MP caps, the LFS-pointer refusal, the sniffed `Content-Type`, the sandbox CSP, `nosniff`, CORP and `ETag`/304. Tests: `packages/shared/review-markdown-image.test.ts` (the decision table over a fake reader) and `packages/server/review-markdown-image.test.ts` (both runtimes against a real repo).

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

### GitButler review invariants

GitButler is a distinct VCS provider, ordered after JJ and before Git in both Bun and Pi. It is selected only while symbolic `HEAD` is `refs/heads/gitbutler/workspace` (or legacy `gitbutler/integration`) and the repository has GitButler's local target-ref configuration; a leftover database or an ordinary branch with the reserved name is not detection. An active workspace requires `but >= 0.21.0` on `PATH`, and a missing/incompatible CLI is an explicit error rather than a fallback to ordinary Git staging against the synthetic workspace commit. `--gitbutler` forces this provider; `--git` remains the escape hatch.

The default `gitbutler:workspace` view is GitButler's reported merge base versus the working tree plus untracked files, so it includes every applied committed change and assigned/unassigned worktree change. Multi-branch stack views are committed-only merge-base→stack-tip Git diffs; branch views are committed-only first-parent segment diffs. Client IDs encode branch-name anchors, never GitButler's transient CLI IDs. Do not concatenate independent GitButler hunks: their bases can differ. Assigned worktree hunks stay in Workspace until GitButler exposes an authoritative combined stack diff.

GitButler assignment is not the Git index, so the provider never opts into stage/unstage. Git-status sections, commit history, remote-base discovery/fetch, and the first-run Git setup remain `vcsType: "git"` only. File expansion uses the exact object range for committed views and merge-base/working-tree pair for Workspace; fingerprints cover the visible Git content plus canonical stack/branch topology. Nested multi-repo mode maps only `workspace-current` to GitButler; staged/unstaged/last modes are unavailable when a GitButler child is present.

### Code-review Ask AI context

Ask AI's "changes under review" context for **code review** is generated by the shared agent-review prompt machine (`buildAgentReviewUserMessage` / `buildAgentReviewUserMessageForTarget` in `packages/server/agent-review-message.ts`) — the same machine the launchable review jobs use — and is **delivered on the user's messages, not the system prompt**. The review server computes it for the current view (`buildCurrentAiReviewContext` in `packages/server/review.ts`, mirrored in `apps/pi-extension/server/serverReview.ts`) and ships it as `aiReviewContext` in the diff payloads (`/api/diff` and the switch/PR endpoints). The client (`packages/review-editor`) latches it onto each question via `buildReviewContextPreamble` (`packages/ui/utils/aiPrompt.ts`): the full block on the first message and whenever the view changes, a short reminder otherwise (never re-pasting a large diff). This keeps the agent looking at exactly the on-screen changeset across every mode (uncommitted/untracked, branch, merge-base, stacked-PR full-stack, hide-whitespace, PR worktrees, workspace, GitButler, jj). The code-review system prompt (`buildCodeReviewPrompt` in `packages/ai/context.ts`) is intentionally role-only.
