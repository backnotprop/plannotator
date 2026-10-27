## Guides in VS Code

Approved spec: `.product/approved/vscode-guided-review/SPEC.md` (not in this repo; phase 1). The extension's **Guided Reviews** activity-bar view (container title and command category "Guided Reviews"; command ids and settings keep their `plannotator.guides.*` names) writes and reads Guided Reviews with VS Code's own parts. Its code is a second bundle, `dist/guides.cjs`, that `src/guides-loader.ts` loads the first time the view or a `plannotator.guides.*` command is used; the main bundle only registers a proxy tree view, a proxy webview view and command stubs.

- **Dashboard.** Showing the view from the activity bar opens the "Guided Reviews" dashboard tab once per session (`guides-loader.ts`'s `onDidChangeVisibility`; not when VS Code restores the view at startup, and not when a dashboard, guide or run tab is already open: `openHome({ auto: true })`); the view title bar's home button is "Open Dashboard". With a folder open it leads with this repo (pull request and local-changes cards), recent guides, then PRs waiting on you; with no folder open it shows "Open a repository" and "Guide a pull request by link", then Waiting on you (every repository) and recent guides of every repository on this machine (`listRecentEverywhere`, every shelf under `guides/`). The tree's no-folder rows are the same two actions. Clicking a PR row anywhere (tree or dashboard; `plannotator.guides.openPullRequest`) never opens the browser: it shows the run when one is building that PR, opens the newest saved guide of that PR made at its current head (`guideForPullRequest`; the head from the dashboard's PR list or `gh pr view --json headRefOid`), else starts the Guide flow for it; "Open on GitHub" stays a secondary button. A PR of a repository that is not open (a waiting row of another repo, a pasted link) is guided from a blobless, no-checkout clone of that repository in the extension's storage (`ensureRepoClone`: `gh repo clone <repo> <storage>/repos/<repo-key> -- --filter=blob:none --no-checkout`, made once and reused; its shelf key is the same a local checkout gets), then the usual per-PR worktree; `gh pr view` names `--repo` so a fork's `upstream` remote cannot redirect it. A clone is made in `<path>.cloning-<pid>-<ts>` and renamed into place only when complete (one clone per path at a time in a window; a window that loses the race to another uses the winner's; `*.cloning-*` folders older than an hour are swept), and gets gh as its credential helper in its own config only (`credential.https://<host>.helper` = `!'<gh>' auth git-credential`, the path in POSIX single quotes (`'` as `'\''`, `shellQuoteForGit`) because git runs a `!` helper with `sh -c`, Git for Windows included; the same shape `gh auth setup-git` writes), because `gh repo clone` lends git its credentials for the clone command alone (gh's `AuthenticatedCommand`) and the later fetches of a private repository over HTTPS need them. Whether a PR belongs to the open repository is `isOpenRepository`: owner and repo compare case-insensitively and the host loosely (`ssh.github.com` and SSH host aliases such as `git@github-work:org/repo` are github.com), so the open repository's own PRs never go to a clone; rows of its own PR list pass only the number. When that cannot work (no gh, not signed in, no access) one line says why, with "Open a folder…" and "Open on GitHub". The reader of such a guide reads the open repository only when it is the guide's own, else the clone (made then if missing).

- **Agents.** Any ACP agent can write a guide. `src/guides/acp/agents.ts` holds a small bundled registry (no runtime fetch of the ACP registry, never `npx`): Claude Code (`claude-agent-acp`), Codex (`codex-acp`), OpenCode (`opencode acp`), GitHub Copilot CLI (`copilot --acp --stdio`), Cursor (`cursor-agent acp`, else `agent acp` only when that `agent` is Cursor's own CLI: `altCommandsSignature`, checked by `acp/same-program.ts`, which accepts a real path through a `cursor-agent` file or folder without running anything, else a `--version` line shaped like Cursor's dated build `2026.07.08-0c04a8a`, read once per file; another `agent` on PATH, such as Grok Build's `~/.grok/bin/agent`, leaves Cursor not installed, with its install command), Kiro CLI (`kiro-cli acp`), Kilo Code (`kilo acp`, else `kilocode acp`) and Pi (`pi-acp`). Each entry links its source and carries its install command, cheap model/effort defaults, an optional `note` (a capability gap shown in the picker, never a block: Pi's is that pi-acp does not pass MCP servers on to Pi, so it cannot reach the builder tools) and optional `permissiveModes` (used only with automatic approval; the first is the target, and a session already in any listed mode is never downgraded: Claude Code `acceptEdits`, `auto`, `bypassPermissions`; Codex `agent`, `agent-full-access`). No agent is ever refused or disabled, for local changes or pull requests alike. The picker lists installed agents first; a missing one shows its install command. Overrides: `plannotator.guides.agentCommands` (`{ "<id>": { command, args } }`; `plannotator.guides.claudeCode.command` / `.args` still apply to Claude Code), and `plannotator.guides.customAgent.command` / `.args` / `.label` for any other ACP agent. All command settings, `plannotator.guides.autoApprove` and `plannotator.guides.ghPath` are `"scope": "machine"`, so a workspace cannot set them. Model and effort are read per agent and cached per agent (`plannotator.guides.agentOptions.<id>`); effort is the `thought_level` category, else an option id `thinking`, `thinking_effort`, `reasoning_effort`, `effort` or `effortLevel`; the mode is category `mode`, else id `mode`. Saved guides record the agent as `generator.engine` (`claude`, `codex`, `opencode`, …).
- **Your agent, your config (owner decision 2026-10-23: never block an agent; the user's harness config is their responsibility).** Guides runs the agent with the user's own configuration and permissions: no `_meta` on `session/new`, no forced or reset mode, no tool allow/deny lists, no narrowed setting sources, no injected config or env. It adds only its builder MCP server, the chosen model and effort, and the prompt (which says a review needs no edits). The client advertises no `fs` and no `terminal` (every listed agent brings its own tools); an agent that calls `fs/read_text_file` anyway is served (regular files up to 10 MB, `MAX_CLIENT_READ_BYTES`), and the unadvertised write and terminal methods answer "method not found" (left out, the SDK would answer `fs/write_text_file` with an empty success). **Permissions:** every `session/request_permission` is shown with all the agent's options (allow once or always, reject once or always) in the generating view (`pendingPermissions`, "Waiting for your approval: …", `webview/approvals.ts`) and in a non-modal notification; the first answer goes back as it is (`GuideGeneration.answerPermission`). The builder's own `guide_*` tools, matched by exact programmatic name or whole title and kind `other` or none, are allowed once without a prompt (`acp/permission-policy.ts`). **Automatic approval (opt-in):** `plannotator.guides.autoApprove` (`off` | `allow-all`), a toggle in the start flow's effort step, or at the first request ("Approve all for this run", "Always approve during guides", which sets the setting); then every request is answered with the agent's allow option (once, else always; a request with no allow option stays with the user, since `cancelled` would abort the agent's tool; "Approve all" from a notification whose request was already answered still turns it on while the run is live; the start flow's toggle, seeded from the setting, decides for that run: `autoApproveChoice`) and the session switches to the agent's first offered `permissiveModes` entry, shown in the run's Approvals stat; a mode that cannot be set is a note. **Bottlenecks** (`state.bottlenecks`, never a stop): a request the user turned down (action "Approve automatically for this run"), a failed tool whose output is Claude Code's deny-rule wording "Permission to use … has been denied" (`blockedCause`; one notice per cause, updated with each tool; generic errors such as `Permission denied`, EACCES or `Operation not permitted` are never read as config, and codex-acp reports declined or sandbox-failed commands only as status `failed`, so they are not guessed at), the agent never reaching the builder's MCP server, and a run that ended after the user turned requests down (action "Resume with automatic approval"; deny-rule blocks are not counted, since automatic approval does not lift a deny rule). There is no tripwire and no mode watcher.
- **Generating.** A Quick Pick picks what (this branch's PR, local changes since the merge base, uncommitted only, another PR by number or link), the agent, and the agent's model and effort, read from the agent's ACP `configOptions` (cached per agent; Claude Code defaults to Sonnet at low effort). The extension is an ACP v1 client (`@agentclientprotocol/sdk`, `src/guides/acp/client.ts`) that starts the chosen agent with the user's own environment. Resolution order (`resolveAgentLaunch`): the command in `plannotator.guides.agentCommands` (or `customAgent`), the agent on PATH, the npm ACP adapter the extension installed, then install it now. Claude Code, Codex and Pi have an `adapter` in the agent table (`src/guides/acp/agents.ts`), pinned to an exact npm version published at least 7 days before it was pinned (claude-agent-acp 0.91.0, codex-acp 2.2.2, pi-acp 0.0.34); when it is missing and `plannotator.guides.installAdapters` is on (default), `src/guides/acp/adapters.ts` runs `npm install --prefix <globalStorage>/adapters/<agent>/<copy> --ignore-scripts --before=2026-10-16 --save-exact <pkg>@<version>` under a progress notification (`--before`, `ADAPTER_PIN_BEFORE`, holds every transitive dependency to the 7-day release-age rule too: codex-acp's `@openai/codex ^0.160.1` resolves to 0.160.1, not the newest), then points `<agent>/current.json` at the new copy. Every install and "Update Agent Adapters" writes a new copy and switches the pointer, so a run using the old copy (any window) keeps it; a copy that stopped being current is removed 6 hours after it stopped (the switch stamps `.plannotator-replaced.json` into it, so a long run in another window keeps its copy), and unfinished installs and the first layout's `<agent>.installing-*` folders 6 hours after they were made; when `current.json` exists but cannot be read, nothing is removed. Each launch picks the runtime again: `node` on PATH when its version satisfies the package's `engines.node` (`satisfiesNodeRange`: `>=`, `<`, `^`, `~`, `x`, hyphen and `||` forms; an unreadable range counts as unsatisfied), else VS Code's own runtime (`ELECTRON_RUN_AS_NODE=1`). No global install, no `npx`, no sudo. A failure is one line (npm's reason and the manual `npm install -g <pkg>@<version>`) with Retry (`src/guides/acp/ensure-launch.ts`); "Guided Reviews: Update Agent Adapters" (`plannotator.guides.updateAdapters`) reinstalls the copies it made. Pi also needs `pi` itself (`requires`). Agents that are their own program (OpenCode, Copilot CLI, Cursor, Kiro, Kilo) are never installed: "Install <agent>" opens a terminal with the official install command typed in, not run (on Windows the documented PowerShell command, `installCommandWindows`, or the same npm command; Kiro documents none, so there the button is not offered and the message points at its docs). The client offers no client tools but terminal sign-in (`auth.terminal`, so the agent lists its own login commands for the "Sign in" button, which opens a VS Code terminal running them), and refuses an agent whose `initialize` answers another ACP protocol version (it could not speak to it). Permission requests and automatic approval are described above. Windows: an npm `.cmd` adapter is started through its JavaScript entry (`acp/spawn-plan.ts`, never through `cmd.exe`); untested on Windows. The builder tools reach the agent through a stdio MCP server, `dist/guide-mcp.cjs` (`src/guides/mcp/relay-script.ts`, run by VS Code's runtime with `ELECTRON_RUN_AS_NODE=1`), which relays each line over a private local socket with a per-run token to `src/guides/mcp/relay-host.ts`; the draft (core's `GuideDraft`) stays in the extension and is written after every call. `src/guides/generation.ts` runs one guide: activity stream, cost from `usage_update`, cancel (`session/cancel`), resume and Save as is. The agent runs as the leader of its own process group: when a run ends the group gets SIGTERM, then SIGKILL 3 s later whether or not the agent itself exited (Windows: `taskkill /T /F`); closing VS Code kills it at once. A PR is checked out in a detached worktree of its own head, `worktrees/<repo-key>/pr-<n>-<sha7>` under the extension's global storage, so a worktree is never moved under a live run or another guide. Fetches use `--refmap=` (no ref of the user's moves: the PR head from `refs/pull/<n>/head`, the base by its sha, else into a private ref deleted once read); `git worktree prune` never runs (a re-add uses `worktree add --force`); nothing outside the storage folder is created or removed. Deleting a guide, or discarding a PR draft, removes its worktree only when no other guide, draft, run or open reader uses it (`src/guides/worktrees.ts`); deleting a guide also removes a share link from its host first (`src/guides/share.ts` over the shared `unshareGuide`; when that fails the person is warned and decides). The overview diagram is render-checked in a Guided Reviews webview; with none open (a background run whose tab was closed) the guide is saved with `diagramCheck: "unchecked"`, the run and the agent are told, and the reader checks it when the Guide tab opens.
- **Storage.** Finished guides go in Plannotator's guide store (`guides/{repo-key}/{id}.json` + `.patch`, the overview inside `guide`), so the web app lists them and `plannotator guide export` exports them. VS Code-only state (file ticks, `focus` hints, the source and base commit) is a sidecar at `guides/{repo-key}/vscode/{id}.json`; unfinished drafts at `guides/{repo-key}/vscode/drafts/`. The shared store never reads `vscode/`. Plannotator's guide-history switch is honored: with `PLANNOTATOR_GUIDE_HISTORY=0` or `{ "guideHistory": false }` (read at each run) nothing is written, neither drafts nor the guide, its patch or sidecar; the guide stays in memory for the VS Code session (listed as "not saved (this session only)") and the generating view, the dashboard and the finish message say so.
- **Reading.** Chapters and files in the tree with checkboxes (chapter ticks are the format's `reviewed[]`; a chapter ticks itself when all its files are), the chapter overview in a side webview view, each file in `vscode.diff` (base: a read-only `plannotator-guide:` document from `git show`; head: the real file), a CodeLens "Chapter N of M · title | Mark reviewed | Next file ›" (VS Code hides CodeLens in diffs unless `diffEditor.codeLens` is on: the extension asks once and changes it only on the reader's yes), a chapter-colored gutter mark, focus-range highlight, a status-bar item, and one hover line for symbols changed in a chapter. The Guide tab draws the overview (sanitized markdown; Mermaid through `@plannotator/ui`'s `renderDiagram`, with `click` lines taken out of the source and attached to the drawn nodes) and a popover built from `vscode.executeHoverProvider` / definition / references. The webviews run only the extension's own script (nonce CSP); agent text is data.
- **Ask the agent** (approved 2026-10-23, `.product/approved/vscode-guides-ask/`, not in this repo; the owner's answers override its brief). Entry points: the editor context menu **Ask the Agent About This…** (`plannotator.guides.askAboutSelection`, shown when `plannotator.guides.editorInGuide`, set from the active editor by `guideSideOf` in `vscode/uris.ts`, either side of a guide diff, and text is selected), the CodeLens **Ask…** between Mark reviewed and Next file (`askAboutFile`: the selection when the active editor shows that file, else the whole file; a file not in the active editor is opened first), and the chapter view's ask box (webview command `ask`: typed text is asked about the chapter at once; empty opens the Quick Pick question box, `vscode/ask-box.ts`, kept for the chapter only). No keyboard shortcut. **The box under the lines** (approved 2026-10-23, `.product/approved/vscode-ask-entry/`, variant 1; `vscode/ask-thread.ts`, words in `ask/thread-view.ts`, no `vscode`): the context menu and the CodeLens open a VS Code comment thread under the selected lines (a whole file: under its first line). Its header reads "Ask Claude Code · deliver.ts 25–31" ("Claude Code · …" once asked), with a gear (`comments/commentThread/title`, `askThreadSettings`: the start flow's picker with `purpose: "answer"`, whose words say who answers and show an agent that cannot reach Plannotator's tools as "answers in text only", remembered per guide in `plannotator.guides.askChoice:<guide id>`). Plannotator's first comment (a trusted `MarkdownString` whose `enabledCommands` are only the thread's own: `askThreadPick`, `openAnswer`, `askThreadStop`, `askThreadAgain`) names the lines and what goes with the question, then the suggestions and up to three earlier questions about the same file ("Asked before", lines that overlap first) as command links; the reply field's buttons are package.json `comments/commentThread/context` items keyed on the thread's `contextValue` (`plannotator-ask-compose`: Ask and Cancel; `-asking`: none, `canReply` false; `-done`: Ask and Close). VS Code draws the first (primary) item on the right: "Cancel · Ask", not the mock's "Ask · Cancel". After Ask the box holds the reader's question (author: `git config user.name`, else "You", with an initial avatar) and the agent's comment (the agent's own mark from `images/agents/`, built from `packages/ui/components/icons/AgentIcons.tsx` by `scripts/agent-avatars.ts` and checked by its test; an agent without a mark gets its letter; the person's avatar is their initials, two for two words, an SVG `data:` URI, `avatarDataUri`): `$(loading~spin)` "Asking Claude Code… 0:06 · $0.01 · read worker.ts, retryPolicy.ts · Stop" (a 1 s clock while it runs, files from the tool calls' locations; "needs your OK · Review" while a permission waits; the notification still asks), then "Answer opened beside the diff · Open" (or Stopped / No answer), its label "Sonnet · low · 9s · $0.03". Every bit of agent or file text in the box goes through `escapeMarkdown`: no link, emphasis, HTML, code, theme icon (`$(…)`) or GFM autolink (`https://`, `www.`, `@`) of its own; link titles lose `$`. The answer tab is not opened while it works: it opens beside the diff when the run ends, with `preserveFocus`, and no "Answer ready" toast (`LiveAsk.sink` in `asks.ts`); a box removed while its question runs (the guide closed or switched) stops the run and no tab opens (`sink.alive()`, and the guide must still be the one in the reader). A guide file opened from the tree while an answer tab is active opens in the group already showing that file's diff (the same base and head documents), else the first group whose open tab is not an answer, else a new group beside; never on top of the answers (`vscode/tab-columns.ts`, tested on the mock's tab groups). Follow-ups are asked in the same box (`followUpOf` the box's last answer, the same ACP session). A question refused because another one runs stays in the box as "Not asked: … · Ask it now". **Two controllers** because VS Code has one set of field words per controller: a new box is on `plannotator-guides-ask` ("Ask a question…"); when its first question runs it moves, same lines, to `plannotator-guides-ask-conversation` ("Ask a follow-up…"); menus match both with `commentController =~ /^plannotator-guides-ask/`. The box opens expanded with its text field open and showing its placeholder ("Type a question, or pick one above"; checked in VS Code 1.143), and the reader clicks in it: VS Code 1.85's stable API cannot focus a thread's field (`CommentThread.reveal` is a proposed API), and getting there by moving the caret or the selection risked the reader's own work, so the box never moves the caret, the selection or the focus. Asking again on lines that have a box (same first and last line) gets that box back, asked or not; a new box replaces another box nobody asked in, but never one holding a question that was not asked. Boxes are not saved: closing or switching the guide, deleting it, or reloading the window removes them. They are marked resolved (`CommentThreadState.Resolved`: nothing waits on them). VS Code lists the boxes in its Comments panel (under "Ask the agent") and, with `comments.openView` at its default `firstFile`, opens that panel by itself the first time a box shows in a window; `"never"` or `"firstFileUnresolved"` stop it. A box on the old (left) side of a diff is not tested. Who answers: the reader's pick, else the sidecar's `agent`, else the agent whose `engine` wrote the guide. `vscode/asks.ts` (`GuideAsks`) runs it; `ask/session.ts` (`GuideAskSession`, no `vscode`) is one ACP session per guide kept while the window is open: the first question loads a saved session when the agent's `initialize` advertises `agentCapabilities.loadSession` (`sessionsToLoad`: the sidecar's `askSession` for the same agent first, then the guide's own `acpSessionId`), replayed updates ignored; a failed or unsupported load starts `session/new`; follow-ups reuse the session; the agent stops after `ASK_IDLE_MS` (10 min) and the next question loads the conversation again where it can (the session id is saved as `askSession { id, agent }` in the sidecar). One question at a time per guide. Same user config and permissions as a guide run (agent policy): permission requests with every option in the answer tab (`renderPermissions`) and a notification, opt-in automatic approval, the agent's own `permissiveModes` only then. The prompt (`ask/prompt.ts`, modes `fresh` with the guide's title, intent and chapters / `loaded` / `next` / `followUp`) carries where the change is, the selected lines numbered, and the file's (or the chapter's files') diff from the guide's patch, capped. The answer comes back through `show_answer({ title, html })` (`ask/answer-tool.ts`) on the builder's MCP relay, the only tool an ask session lists (`McpToolHandler.instructions` gives it its own MCP instructions); it is allowed without a prompt like the builder tools (`isBuilderToolCall`); checks: a one-line title (≤160 chars), html ≤ 128 KB, every `code:` (file at the head), `symbol:` (`resolveSymbolForBuilder`) and `chapter:` (in range) link in `href`, `data-link` and Mermaid `click` lines resolves, refusals naming every problem. A turn that ends without it shows the agent's last message as a markdown answer ("answered in text"); Stop (`session/cancel`) keeps what streamed. Cost per answer is the session's running total less what it was before the question (an adapter reporting less than before counts per turn). **Rendering (owner: "If its html scripts can be embedded … we need to support"):** the answer tab (`mode: "answer"`, `webview/answer-frame.ts`) puts the agent's page, scripts included, in `<iframe sandbox="allow-scripts">` via `srcdoc`: opaque origin, so its scripts cannot reach the tab's DOM or `acquireVsCodeApi`; it inherits the tab's CSP, which for this mode only is `script-src <cspSource> 'unsafe-inline'` (a nonce would disable `'unsafe-inline'` and the frame's scripts would not run; `webview-csp.ts`), with `default-src 'none'` so nothing connects anywhere. A bootstrap script put first in the page's head posts link clicks (`code:`/`symbol:`/`chapter:` on `href` or `data-link`, and http(s)) and the page height; the tab accepts only `readAnswerMessage`-checked messages from that frame. The Guides webviews act on a message only when its origin is the page's own origin (`webview/host-messages.ts` `fromWebviewHost`): VS Code posts host messages with `contentWindow.postMessage(message, window.origin)` (`pre/index.html`, the same in 1.85.0 and 1.143), while the `source` is no test (1.143 sets `window.parent = window` in the content frame, 1.85 deletes it, and in VS Code for the Web the source is not the parent). That shuts out the agent's answer frame (origin `"null"`) and any page with a real origin of its own elsewhere in the window (a site in the Simple Browser, another extension's webview) that walks `top.frames` to post; a message from a frame nested in the page is dropped too, whatever it claims; a harness page whose own origin is opaque takes only its own and its parent's messages; so the agent's page cannot post a forged `state` (a fake approval prompt); and `approveAlways` (which writes `plannotator.guides.autoApprove`) is honored only for a run id and permission id that name a request really waiting on the user. A web link in a text answer goes through the same confirm (`openAnswerExternal`). Agent-written markdown keeps no `data-*` attribute (DOMPurify `ALLOW_DATA_ATTR: false`; `data-link` / `data-external` are set only by the sanitizer hook from a real link) and a drawn diagram loses any `data-link`, `data-external` or `data-popover-*` from its labels before the click links are attached, so agent text cannot make an element the webview acts on. `openPullRequestOnGitHub` opens without asking only a tree row's own PR or a URL the extension knows (the dashboard's, the open guide's, the run's: `isKnownPullRequestUrl` in `src/guides/trust.ts`, with `approveAlwaysTarget`); anything else asks first. Deleting an answer always asks (modal). `<pre class="mermaid">` is drawn beforehand with the Guide tab's `renderMermaid`. The page gets the editor's colors as `--foreground`, `--background`, `--muted`, `--card`, `--border`, `--accent`, `--add`, `--del`, `--chart-1…6`, `--font`, `--mono`. Links open in the diff's editor group (guide links: `openLink`/`openChapter` with a column), a web link only after a confirmation. **History:** `ask/shelf.ts` (`AnswerShelf`) holds the answers on disk or in memory, remembers deleted guides and answers so a question still being answered when they are deleted is never written back (nor the sidecar), and the one-question-per-guide slot, taken before anything is awaited (a second ask while the first is getting ready is refused with no record); `ask/answers.ts`, one JSON per answer at `guides/{repo-key}/vscode/answers/{guide-id}/{answer-id}.json` (question, what it is about with the selected code and the head file's SHA-1, the page or text, agent, cost, head commit, session kind, `followUpOf`, `seen`); an answer left answering reads as stopped; `staleNote` says when the file or head moved; deleting the guide deletes them (`deleteSavedGuide`); with guide history off or a session-only guide they live in memory. The chapter view lists the chapter's answers ("Answers · N", `new` until opened) with a footer of the guide's answer cost. The status bar says "Answering · <question>" while one runs. Review comment threads (the editor annotations) have no "ask the agent" (owner's answer 3); the question box is a thread of its own. Not in exported or shared guides.
- **Tests:** module level (no `vscode`): `src/guides/**/*.test.ts`, with `tests/fake-acp-agent.ts`, a scripted ACP agent that starts the relay from `session/new` and calls the builder tools, logs the `_meta` it receives, offers terminal sign-ins, fails with `authRequired`, can start a grandchild that ignores SIGTERM, asks permission for any tool kind with any options (and writes a file only if allowed), calls the client's `fs/read_text_file`, `fs/write_text_file` and `terminal/create`, reports a failed tool with output, switches its own mode, and can accept MCP servers without starting them (`ignoreMcp`, as pi-acp). `generation.test.ts`, block "your agent, your config: Guides never blocks it": every listed agent (and the custom agent) writes a guide for local changes and a pull request with no `_meta` and no mode change; requests are forwarded with all options and the choice passed back; automatic approval, the inline offer, a pending request in the state, answers from the run view, and the bottleneck notices. `acp/agents.test.ts` covers the registry and launch resolution with an injected PATH lookup; `acp/permission-policy.test.ts` that nothing is answered on its own but the builder's tools; `webview/approvals.test.ts` (happy-dom, registered in the file) the run view's approval and bottleneck panels. `tests/screenshots/approvals.ts` renders the built webview with canned run states in headless Chromium (manual). Never a real agent. `src/guides/sources/worktree.test.ts` runs the PR worktree rules on real temp git repositories. The webview's sanitizer and Mermaid path are proved in real Chromium (happy-dom keeps a `<script>` through DOMPurify) by `tests/e2e/vscode-guides-sanitize.spec.ts` in the Playwright job, and the answer frame under the answer tab's own CSP (the page's scripts run, cannot reach the tab, `acquireVsCodeApi`, the network or the top window; links arrive as messages; under the other tabs' nonce policy they would not run; with the real `main.ts`, a state the page forges changes nothing and sends no command, and a text answer's web link goes through the confirm) by `tests/e2e/vscode-guides-answer.spec.ts`. Ask: `ask/answer-tool.test.ts`, `ask/answers.test.ts`, `ask/shelf.test.ts`, `ask/view.test.ts`, `trust.test.ts`, `webview/answer-frame.test.ts`, `webview/host-messages.test.ts`, `vscode/asks.test.ts` (GuideAsks on the vscode mock with the fake agent: the second-ask race, deleting a guide or an answer mid-answer, the Delete confirm, Always approve only for the request really waiting; the box under the lines: asked, the work in the box, the tab opened at the end without the focus, the move to the conversation controller, a follow-up in the same box and session, a suggestion link, "Asked before", a refused question kept to ask again, Cancel, one unasked box, closing the guide, an empty Ask, a box removed while its question runs: stopped and no tab, asking again on the same lines, a not-asked box kept), `ask/thread-view.test.ts` (the box's words and links: every link runs only its own command; hostile agent text rendered through marked with GFM yields no link, autolink, HTML, code or theme icon of its own), `vscode/new-review.test.ts` (the picker's words for answering), `vscode/tab-columns.test.ts`, `scripts/agent-avatars.test.ts`, and `ask/session.test.ts` against the fake agent (which now advertises `loadSession` on request, replays history on `session/load`, can fail it, and plays `askTurns` per prompt in a session whose MCP server lists `show_answer`): fresh vs loaded vs failed load, the text fallback, follow-ups in one process, permissions, Stop, the idle stop and reload. `tests/screenshots/ask.ts` drives the ask flow in a scratch `code serve-web` (manual; the fixture's agent script has an ask turn with a drawn answer) and logs what the box shows (header, links, buttons and which is primary, the spinner, where the focus is), the Comments panel opening, the gear, the Open, suggestion and Stop links and the CodeLens box. `tests/screenshots/` drives a scratch `code serve-web` in headless Chromium (manual; see its header).

## Plan Review Flow

```
Claude calls ExitPlanMode
        ↓
PermissionRequest hook fires
        ↓
Bun server reads plan from stdin JSON (tool_input.plan)
        ↓
Server starts on random port, opens browser
        ↓
User reviews plan, optionally adds annotations
        ↓
Approve → stdout: {"hookSpecificOutput":{"decision":{"behavior":"allow"}}}
Deny    → stdout: {"hookSpecificOutput":{"decision":{"behavior":"deny","message":"..."}}}
```

### Plan review header decision control (#1057)

Approved design: "plan-review-decision-control" (owner approval 2026-10-21, design record not in this repo; built as the proposal shows). Plan review's header uses the same `DecisionControl` annotate and code review use, from the pure `buildDecisionSpec({ app: 'plan', plan: { answers, directEdits, answersOnly, agentName, approveTarget } })` (`packages/ui/utils/decisionSpec.ts`), with no ghost Close (a plan review ends with a decision). It replaced the old pair (an outlined Send Feedback beside a green Approve, OpenCode's `ApproveDropdown`), the "Add Feedback First" dialog (the empty Send Feedback path is now **Request changes…** in the caret) and the Claude Code "Feedback Won't Be Sent" dialog with its faded Approve and hover note (#1457).

- **States.** Nothing to send: **Approve** (OpenCode: `Approve → <agent>`, the agent switch target, cut at 24 characters), caret: "Approve with a note…" (only where notes on approval are delivered) and "Request changes…". Something to send: **Send Feedback**, or **Send answers** when the only feedback is question answers (`isAnswersOnlyFeedback`); caret: "Send with a note…" ("Send answers with a note…"), "Approve with notes" (only where delivered; `→ <agent>` on OpenCode), and always "Approve, discard N annotations…" (the noun follows the feedback: answers, annotations, direct edits) with one confirm, "Discard & approve". Where notes would be lost, that row's subtitle and confirm name the agent ("Claude Code can't take notes on approval").
- **Which hosts take notes on approval is a server advert, not the agent's name.** Both plan servers advertise `approvalNotesSupported` on `/api/plan` (Bun `ServerOptions.approvalNotesSupported`, Pi `startPlanReviewServer`'s option; absent or false reads as false in the tab, so an older server offers no approve-with-notes row). Set true by: the Claude Code mod's `claude-mod-plan` (`planHostResult` composes approved-with-notes), the OpenCode CLI bridge (`opencode-plan`) and the embedded OpenCode plan server (the `submit_plan` executor), and Pi's `startPlanReviewBrowserSession` (`deliverPlanDecision`; the event API's result carries `feedback`). Left false: the classic Claude Code PermissionRequest hook (its allow carries no message), Gemini CLI (a `systemMessage` is shown to the person, not the model), Codex, Copilot CLI, Mistral Vibe, and archive.
- **Transports are unchanged.** Primary and Mod+Enter are one `submitPrimaryDecision` (`submitPrimaryDecisionRef`): Approve posts `/api/approve` (with `permissionMode` for Claude Code, `agentSwitch`, `planSave`, the notes integrations, `serverSession`, `planRevision`), Send Feedback / Send answers post `/api/deny` (`answersOnly: true` only for answers alone). Routing is pure in `packages/editor/planDecision.ts` (`resolvePlanDecisionAction`): a note becomes a `GLOBAL_COMMENT` and is posted one render later (annotate's #1436 mechanism, `queueNoteDecision`), on `/api/deny` for Request changes / Send with a note and on `/api/approve` for Approve with a note; "Approve with notes" posts the approval with the session's feedback (what plan Approve always sent); the confirmed discard posts a bare approval (`handleApprove({ discardFeedback: true })`, no `feedback`). Every approval goes through `requestPlanApprove`, so the unsaved-file-edit warning and OpenCode's "Agent Not Found" check run on every approve path, and that dialog's "Approve Anyway" runs the captured continuation (a confirmed discard stays bare). A note on Send answers makes the deny mixed (the note is a comment), so it carries the denied prompt, as any mix does. Unlike annotate's L3 retry, a queued plan note decision is never left armed: after any refusal (409 `plan_revised`), cancelled warning (Agent Not Found, unsaved file edits) or failed POST it is dropped, the note stays as an ordinary general comment, and the primary means what its label says (Send Feedback posts the deny); the reviewer decides again from scratch. A plan revision waits while the decision note is open (`[data-decision-note-input]` and the compact `[data-decision-note-composer]` are in `PLAN_REVISION_COMPOSER_SELECTOR`, `packages/editor/hooks/usePlanRevisions.ts`). When the only feedback is saved file changes (a host that grants source save), the approve-away row reads "Approve without telling the agent…" and its confirm says the changes are already on disk (`plan.savedFilesOnly`); plan review's own servers grant no source save, so this does not arise there today.
- **Menu rows that are not decisions** go through `DecisionControl`'s `menuFooter` (`packages/ui/components/PlanDecisionMenuExtras.tsx`): OpenCode's agent picker as an "After approval, switch to" radio section (`role="menuitemradio"`, the arrow keys reach it; a pick writes the `agentSwitch` setting and keeps the menu open; shown in both states), and for Claude Code one read-only line, "After approval, Claude Code runs in <mode>", with **Change** (closes the menu, opens Settings). Settings' Permission Mode row now reports a change (`onPermissionModeChange`), so the mode Approve posts and the line show follow it within the session (before, a mid-session Settings change applied only to the next session).
- **Compact/touch rows** come from the same spec (primary row, then one row per caret item; composers open `DecisionNoteDialog`, the discard row its confirm), as annotate's do. The agent picker and permission line are desktop only (Settings has both).
- **No new keyboard shortcuts.** Tests: `packages/ui/utils/decisionSpec.test.ts` (the plan arm and the invariant sweeps), `packages/editor/planDecision.test.ts`, the DOM test `packages/editor/App.planDecisionControl.test.tsx` (each host and state, and the bodies), `packages/server/plan-approval-notes.test.ts` and its Pi mirror, the advert in `apps/hook/server/claude-mod-plan.test.ts` and `apps/opencode-plugin/plan-review-lifecycle.test.ts`.

### Pi plan review does not block

On Pi, `plannotator_submit_plan` returns as soon as the review server is up
("submitted for review … end your turn and wait", `terminate: true`) instead of
holding the tool call until the reviewer decides, so the session stays usable
during review and "Ask this session" works there. The decision is delivered
later by `deliverPlanDecision` (`apps/pi-extension/index.ts`) as a
`pi.sendUserMessage(..., { deliverAs: "followUp" })`, the same delivery review
and annotate feedback use: approval switches to the executing phase first
(tools, model, `plannotator-execute` entry) and sends the approved /
approved-with-notes prompt, which starts the execution turn and its framing;
deny and answers-only send `composePlanDeniedMessage`; external execution mode
hands off and records a non-triggering `plannotator-handoff` message. Nothing
is implemented before approval because the phase stays `planning` while the
review is open, so the planning write gate still holds. The open review is
closed (and its decision dropped) when plan mode is left, when a `/tree` path is
not planning, and on `session_shutdown`; a plan decision is never re-targeted to
a replacement session. The Esc-aborts-the-review behavior of the old blocking
tool is gone: leaving plan mode is how to abandon a review. Closing it first
calls the plan server's in-process `closeKeepingDraft()` (never reachable over
HTTP, where a plan review stays unclosable): open tabs get the `session-closed`
event with `by: "session"` (the tab shows "Review Closed", not "Closed by the
Agent", which stays for `by: "agent"` host closes), and a late approve/deny
answers `409`. The saved draft survives the close, but the server stops right
after, so the last unsaved keystrokes (the draft autosave's debounce window)
may be lost. The same close runs when planning ended while a review was still
starting. Reviews opened through the `plannotator:request` event API
(`plannotator-events.ts`) deliberately do NOT close on `session_shutdown`: the
README promises `review-status` lets a caller recover across session restarts,
so a decision made in that tab after `/reload` is recorded for `review-status`
and never emitted (the replaced runtime's bus is gone). That status file is
written atomically (temp file + rename), and one that cannot be parsed is left
untouched (logged, the write skipped) rather than restarted from `{}`.
Decision listeners run on a microtask (`publishDecision` in `serverPlan.ts`),
because a replaced runtime's `pi.events.emit` throws Pi's stale-ctx error
synchronously and an escape inside the HTTP handler ends the Pi process
(#1864). In `plannotator-events.ts` the review-result emit, `request.respond`
and the status writes are each wrapped in try/catch; `index.ts`'s
`handoffApprovedPlan` emit is not wrapped itself: it runs either inside the
submit tool call (auto-approve, a live session) or behind
`deliverPlanDecision`'s liveness check inside a caught promise chain.

**Revisions while a review is open update the same tab**: a resubmission while a review is pending calls the Pi plan
server's `updatePlan`, which saves a new history version (slug from the revised
heading, `previousPlan` from that slug's prior version) and bumps a revision
counter. `/api/plan` carries `planRevision`; the plan editor polls
`/api/plan/revision` every 2s only when that field is present
(`packages/editor/hooks/usePlanRevisions.ts`) and loads the revision in place
through `applyEditedDocument` (annotations re-anchor by text, the diff base
re-seeds through `usePlanDiff`'s docKey). It waits while Edit Mode is open or
holds direct edits, or a linked document is open. Approve/deny bodies echo
`planRevision`, and the server answers `409 { code: "plan_revised" }` to a stale
one, so a reviewer cannot approve text the agent replaced; the tab then loads
the revision and the reviewer decides again. Both plan servers implement it (`updatePlan` on the
server result, `/api/plan/revision`, the 409) but advertise `planRevision` only
when the caller passes `planRevisions: true`; today only Pi's
`plannotator_submit_plan` and the Claude Code mod's `claude-mod-plan` do, so
classic Claude Code, OpenCode and the Pi event-API `plan-review` action keep a
tab that never polls and sends unchanged bodies.
A decision claims the review right after the revision check (before the note
integrations are awaited), so `updatePlan` refuses from then on; a Pi
resubmission that hits that refusal tells the agent to wait for the decision
instead of opening a second review. The tab also holds a revision while a
comment composer or annotation popover is open.

**Execution works from the approved text, not the file.** The Pi plan
server's approve decision carries `plan`, the exact text on screen when the
reviewer approved. `deliverPlanDecision` appends it to the approval message
under "## Approved plan", records it on the `plannotator-execute` entry
(`approvedPlan`), and executes from it: the checklist, the per-turn framing
and resume (`resyncPhaseFromSession`) read the snapshot instead of re-reading
the plan file, and checkmarks are written back to the file only while its
checklist still matches the approved one. If the file differs from the
approved text at approval, the message says so and tells the agent not to
execute the unreviewed edits (to keep them, the user returns to plan mode and
the agent resubmits). Auto-approved plans (no UI) keep the file as their
source.

### Pi: the `plannotator` tool

The extension registers the shared tool contract
(`packages/shared/plannotator-tool.ts`, vendored as
`generated/plannotator-tool.ts`) with `pi.registerTool`: name, description,
validation (`parsePlannotatorToolInput`), argument mapping and result text all
come from it, and `parameters` is `PLANNOTATOR_TOOL_INPUT_SCHEMA` itself
(plain JSON Schema, which Pi validates without a TypeBox Kind since 0.79.1,
the peer floor; `plannotator-tool.test.ts` runs the installed Pi's
`validateToolArguments` against it). `executionMode: "sequential"` (#1622: an
"edit, then open" batch opens the edited file).

**Registration and activation are decided once per session.** The tool is
OFF by default on Pi and registered only when the agent tool switch turns it on
(`PLANNOTATOR_AGENT_TOOL=1` / `{ "agentTool": true }`, `resolveAgentTool(...,
host)` read once when the extension instance loads; Pi builds a new instance
per session and per `/reload`). Inside Oh My Pi (`detectPiHost(pi)` in
`pi-host.ts` answers `oh-my-pi`) the host is `oh-my-pi` and the tool is ON by
default, because OMP lists an extension tool as one short `xd://plannotator`
line instead of sending its definition; `PLANNOTATOR_AGENT_TOOL=0` /
`{ "agentTool": false }` keep it out there. `setPiHost` records the host for
the extension's review servers, whose `serverConfig` then advertises
`agentToolHost: "oh-my-pi"`. `omp.test.ts` (opt-in, the real `omp`) proves the
default on, the one line and no tool-list entry. Off, nothing is registered and the slash
commands are unchanged. It is registered with
`defaultActive: false` (Pi 0.99+ then leaves it inactive; older Pi ignores the
key and activates every registered tool), and the first `session_start`
(`settleAgentToolActivation`) makes it active when `ctx.hasUI`, inactive in
print/JSON mode, before the session's first request, and never touches it
again. Plan mode's `setActiveTools` calls add and release only the tools they
own, so `plannotator` stays in the tool list (and the prompt prefix) through
planning, execution, completion, leaving plan mode, `/tree` and `/reload`:
`agent-tool-stability.test.ts` drives that whole lifecycle over a fake Pi that
models both activation rules and fails on any request without the tool or any
`setActiveTools` that flips it after the start; it also pins the registered
description/parameters to the shared constants, no `promptSnippet` /
`promptGuidelines` on any Plannotator tool, and no `systemPrompt` from
`before_agent_start`.

**The bundled knowledge skill is user-invoked only.** `vendor.sh` adds
`disable-model-invocation: true` to the vendored copy's frontmatter (the
source `apps/skills/core/plannotator` stays model-invocable for the installers
that ask, #1377), so an npm-only Pi install keeps the #842 promise of no
Plannotator skill in Pi's system prompt; `/skill:plannotator` still loads it,
and the model learns the tool from the tool's own description. A CLI install's
`~/.agents/skills` copy still wins when present (#1642) and carries the
installer's model-invocation choice.

**One launch path.** `/plannotator-review`, `/plannotator-annotate`,
`/plannotator-last` and the tool share `launchCodeReview` / `launchAnnotate` /
`launchLastMessage` in `apps/pi-extension/index.ts` (in-process server,
"Ask this session" bridge, decision as a `followUp` message). The commands
notify a launch error; the tool throws it, which Pi reports as an error
result. Tool differences: the annotate target is ONE argument, so the #1182
tolerant word split never runs on it (`tolerant: false`); an opened review
returns `plannotatorToolOpenedText` with `terminate: true`, so the turn ends
and the session is idle for Ask; a gated session the tool opened delivers a
bare Approve as a message (`deliverApproval`, the mod's rule). The tool's
`last` skips the assistant entry holding the calling tool call
(`isAssistantEntryForToolCall` in `assistant-message.ts`): Pi saves an
assistant message at message_end, before its tools run, so otherwise the
agent's own "opening it now" message would open, and would head the picker.
On one fixed port (remote mode or a single `PLANNOTATOR_PORT`, read from
`getServerPorts`) a second open is refused while any review is open
(`fixedPortBusyText` names it), because the new server would otherwise
self-preempt the open one silently. A list target opens ONE `annotate-bundle`
review through the same `launchAnnotate` the slash command uses: the list goes
to the shared `selectAnnotateTokenTarget` as pre-split tokens (paths with
spaces survive), only the `bundle` selection opens (a missing entry answers
`buildMissingAnnotateFilesMessage`; a folder, URL or bare name refuses, so the
tool never opens fewer files than named), `resolveAnnotateBundleFiles` checks
types and size, and the subject is `plannotatorBundleSubject` (`2 files:
spec.md, notes.md`) in the result, list, close and decision heading; feedback
names every file (`Files:` + `annotateBundleTargetText`). A session without
UI (print/JSON mode) never has the tool active (see above), and a call that
reaches it anyway is refused, since nothing could deliver the decision later.

**Sessions, list and close.** Every review the extension opens (tool,
commands, `plannotator_submit_plan`) is recorded in ONE process-wide registry
(`getProcessPiReviewRegistry` in `apps/pi-extension/plannotator-tool-host.ts`,
on `globalThis`) with a `pn-` id until its decision settles. Process-wide
because Pi builds a new extension instance on `/reload` and `/resume`, and a
per-instance map would forget the open reviews of a session that merely
reloaded. `list` and `close` see only entries whose owner is the calling ctx's
`sessionManager.getSessionId()`, so another session's reviews (including the
previous one after `/new`) are never in reach; the global `sessions/` registry
is never read. `unsent` and `decided` come from the server's
in-process `hostControl.status()`; `close` calls `hostControl.close()` (the
reviewer's Close marked `closedBy: "agent"`, draft kept, tab told), so it
works in remote mode too, where the HTTP endpoints are off. A review the agent
closed delivers nothing: its decision handler notifies "the agent closed …"
instead (user-facing notices name a last-message review "the agent's last
message"; agent-facing texts say "your last message"). Plan reviews are listed
as `Plan vN` (the history version, read from `updatePlan`'s no-op answer for
the same text, and from each revision) and never closed.
Review, annotate and last decisions (commands included) now start with
`plannotatorDecisionHeading` (`Plannotator: notes.md (pn-3f2a9c) — Feedback ·
2 comments.`); outcomes follow the mod: a code review that is not an approval
is `Changes requested` (` · N comments` when it carries annotations), and the
PR-platform status post, which the review server marks `platform: true`
(#1719, `classifyReviewOutcome` in `apps/pi-extension/review-outcome.ts`), is
`Review posted` (`PLANNOTATOR_OUTCOME_REVIEW_POSTED`, shared with OpenCode 2) and delivered verbatim, without the verification
suffix. Every review decision whose feedback has content is delivered,
zero annotations included (PR description, PR comment and editor notes ride
only in the feedback text); nothing is inferred from the annotation count.
Plan decisions are unchanged. Pi cannot take over an agent's
shell `plannotator` command: its `tool_call` event can only block a call, which
the model reads as an error, so the skill's "use the tool" line is what steers
it.

### Pi: session events and the checklist window

**`plannotator:session-opened` / `plannotator:session-closed` (#1589).** One
pair per Pi review, whatever opened it (`apps/pi-extension/session-events.ts`):
the `/plannotator-*` commands and the `plannotator` tool (`trackReview` in
`index.ts`, at the registry's add and its decision or failure), plan review
(the submit tool, closed by its decision, by `stopPendingPlanReview` or by its
server stopping), and `plannotator:request` code-review / annotate /
annotate-last / plan-review (`plannotator-events.ts`, which now starts the
session and waits on it itself so the URL is known before the decision).
Opened: `{ id, action, url, openedAt, piSessionId?, reviewId?, requestId? }`,
`id` the registry's `pn-` id (a fresh `pn-` id for `plannotator:request`
reviews, which are not in the registry; unique among the open reviews both
ways: `newSessionEventId` skips ids the registry or an announced review holds,
and the process registry skips ids an announced review holds,
`isSessionEventIdOpen`), `action` one of `plan-review`,
`code-review`, `annotate`, `annotate-last`. Closed: the same plus `outcome`
(`approved`, `submitted`, or `closed` with `closedBy` `reviewer` | `agent` |
`stopped` | `error`) and `closedAt` (`sessionEndOf` / `sessionEndOfError`).
The handle emits closed at most once; an event with no live bus is dropped. Archive emits neither. **Cache safety:** they go
on `pi.events` only, never a message, entry, system prompt or tool list.
**Stale runtimes (#1864):** every emit runs on a microtask inside try/catch;
it goes through the opener's `pi` when the opener's session was live at the
moment of the open or close, else (or when that throws) through the instance
that last claimed a process-wide slot (`claimSessionEventBus` at
`session_start`, released at `session_shutdown`, on `globalThis` under a
versioned key; a holder that throws, torn down without releasing it, is
forgotten quietly), else nowhere, silently. So a review that ends after `/reload`
reaches the replacement's bus and never throws out of a handler.
`session_shutdown` now calls `stopPendingPlanReview()` first, so a plan review
the session ends closes on its own bus. `plannotator:request` reviews use the
listener's own `sessionLive`, so after a replacement their close goes to the
live instance's bus or nowhere (never the dead one; `plannotator-events.test.ts`
pins that nothing is logged). Proofs: `apps/pi-extension/session-events.test.ts`
(over a fake Pi whose instances share one bus and whose replaced instance
throws Pi's stale-ctx error: every model request, the active tools with their
definitions, `before_agent_start`'s results and every message, is
byte-identical while reviews open, close and outlive `/reload`, and identical
again with a bus that throws; the pair per entry point and outcome) and the
session-event cases in `plannotator-events.test.ts`.

**An update while a review is open keeps the decision.** The extension's lazy
imports go through `importFresh`, which refuses an import once the package on
disk is a different version than the one Pi loaded. The prompts a decision is
written with (`generated/prompts.ts`) therefore load when a review opens
(`preloadDecisionPrompts()` in `trackReview` and the plan review path), not
when the decision arrives: loaded late, an update under an open review lost
the reviewer's feedback ("could not be sent: Plannotator was updated…", 5 of 5
times on a real Pi 0.84.4 with `pi update --extensions`). A new lazy import on
a decision path needs the same preload. Proof:
`apps/pi-extension/review-survives-update.test.ts` (annotate and code review
over a copy of the extension whose `package.json` changes mid-review).

**The checklist widget scrolls (#1412).** Pi draws at most 10 lines of a
widget (`InteractiveMode.MAX_WIDGET_LINES`), so `updateWidget` sends
`checklistWindow(checklistItems)` (`apps/pi-extension/checklist-window.ts`):
all items when there are 10 or fewer, else 10 items ending on the first open
one (the first 10 until it is past them), and the last 10 once everything is
done. `setWidget` only; the status line keeps the full count.
