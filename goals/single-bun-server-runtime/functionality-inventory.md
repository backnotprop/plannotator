# Single Bun Server Runtime Functionality Inventory

This inventory was created before runtime migration work. Its purpose is to prevent parity loss while OpenCode and Pi move from plugin-owned server code to the installed `plannotator` Bun binary.

Base checked: `origin/main` / `HEAD` at `807cc5f09be92baa4546be9d85188417fe467fe3`.

Legend:

- Current owner: where the behavior lives now.
- Target owner: where it should live after this goal.
- Final check: evidence that must be filled in before marking the goal complete.

## Goal Facts Closure Checklist

| Fact | Required final evidence | Final check |
| --- | --- | --- |
| One Bun server runtime serves plan, review, annotate, and archive UI flows. | Code search and package/build checks show only `packages/server` + binary server paths serve UI sessions. | [x] |
| Pi no longer ships, builds, vendors, or calls `apps/pi-extension/server/`. | `test ! -d apps/pi-extension/server`; package files and imports no longer reference it. | [x] |
| OpenCode no longer imports `@plannotator/server` or starts HTTP servers in-process. | `rg '@plannotator/server|startPlannotatorServer|startReviewServer|startAnnotateServer' apps/opencode-plugin` has no runtime imports. | [x] |
| OpenCode and Pi do not package browser HTML runtime payloads. | Package `files` arrays and build scripts do not include/copy `plannotator.html` or `review-editor.html` for those plugins. | [x] |
| OpenCode and Pi are clients of the installed binary. | Binary-client modules exist and command/session flows use them. | [x] |
| Binary/client boundary is daemon-first. | Protocol docs/types are transport-neutral and include capability/version negotiation. | [x] |
| Full daemon endpoint is identified as multi-session service. | Docs/architecture notes describe session IDs, routing, decisions, cleanup, concurrency. | [x] |
| Plan does not treat current ephemeral server as final daemon. | Docs explicitly distinguish phase-one binary client from later multi-session daemon. | [x] |
| OpenCode keeps only agent-specific behavior. | OpenCode tests still cover tool/backing-file/prompt/session injection behavior. | [x] |
| Pi keeps only agent-specific behavior. | Pi tests still cover phase state, tool gating, commands, fallback, and event channel. | [x] |
| OpenCode and Pi discover installed binary by override, PATH, and standard install locations. | Binary discovery tests cover each path. | [x] |
| Missing required binary can auto-install official binary. | Binary-client tests cover install trigger and disabled auto-install path without network. | [x] |
| Plugins verify binary integration capability/version. | Capability tests cover compatible, missing, and incompatible cases. | [x] |
| Claude, OpenCode, and Pi workflows continue to work. | Inventory parity checklist below is completed with tests or manual smoke checks. | [x] |
| Migration does not redesign UI, annotation formats, command names, or release pipeline. | Diff audit shows UI/data/command/release changes are absent or intentionally limited. | [x] |
| Automated tests cover discovery/install, plugin-to-binary behavior, and absence of plugin-owned server/HTML dependencies. | Test list and outputs recorded in final completion notes. | [x] |

## Binary And CLI Modes

Current owner: `apps/hook/server/index.ts`, `apps/hook/server/cli.ts`, compiled into release binaries by `.github/workflows/release.yml`.

Target owner: remains the installed `plannotator` Bun binary. New plugin-facing commands should be added here.

| Flow | Current behavior | Source evidence | Final check |
| --- | --- | --- | --- |
| Top-level help/version | `plannotator --help`, `--version`, `-v`, and interactive no-arg clarification. | `apps/hook/server/cli.ts`, `apps/hook/server/cli.test.ts` | [x] |
| Global flags | `--browser`, `--no-jina`, `--gate`, `--json`, `--hook`, `--render-html` are parsed before subcommands. | `apps/hook/server/index.ts` | [x] |
| Default hook plan review | Reads hook JSON from stdin, opens plan UI, emits Claude PermissionRequest allow/deny. | `apps/hook/server/index.ts` default branch | [x] |
| Codex Stop-hook review | Reads rollout/transcript, extracts latest plan, emits `{}` or `{ decision: "block" }`. | `apps/hook/server/index.ts` Stop branch | [x] |
| Gemini plan review | Reads `plan_filename`/`plan_path`, loads plan from Gemini temp path, emits Gemini allow/deny JSON. | `apps/hook/server/index.ts` default branch | [x] |
| Review command | `plannotator review [--git] [PR_URL]` prepares local diff or PR diff/worktree, opens review UI, prints feedback. | `apps/hook/server/index.ts` review branch | [x] |
| Annotate command | `plannotator annotate <file.md|file.html|https://...|folder/>` handles files, folders, URLs, HTML conversion/raw render, gate/json/hook output. | `apps/hook/server/index.ts` annotate branch | [x] |
| Annotate last | `plannotator annotate-last` / `plannotator last` finds last assistant message and opens annotate UI. | `apps/hook/server/index.ts` annotate-last branch | [x] |
| Archive command | `plannotator archive` opens read-only archive viewer and waits for Done. | `apps/hook/server/index.ts` archive branch | [x] |
| Sessions command | `plannotator sessions`, `--open [N]`, `--clean` list/reopen/clean active session registry files. | `apps/hook/server/index.ts`, `packages/server/sessions.ts` | [x] |
| Copilot plan | `plannotator copilot-plan` reads Copilot session state and emits permissionDecision JSON. | `apps/hook/server/index.ts` copilot-plan branch | [x] |
| Copilot last | `plannotator copilot-last` annotates last Copilot message and emits annotate outcome. | `apps/hook/server/index.ts` copilot-last branch | [x] |
| Improve context | `plannotator improve-context` composes improvement hook + PFM reminder into PreToolUse additionalContext. | `apps/hook/server/index.ts` improve-context branch | [x] |
| Setup-goal skill flow | Repo `main` contains the skill at `apps/skills/plannotator-setup-goal/SKILL.md`; the locally installed binary currently supports `plannotator setup-goal ...`, but that CLI source is not present on this `main` checkout. | `apps/skills/plannotator-setup-goal/SKILL.md`; no `setup-goal` source found by `rg` | [x] |

## Bun Server API Inventory

Current owner: `packages/server/` via Bun `Request`/`Response` APIs.

Target owner: remains the only server/runtime implementation. Plugin clients must not mirror these routes.

### Plan And Archive Server

Source: `packages/server/index.ts`.

| Endpoint/behavior | Purpose | Final check |
| --- | --- | --- |
| `GET /api/plan` | Return current plan payload, archive mode payload, origin, previous plan/version info, repo/server config. | [x] |
| `GET /api/plan/version` | Fetch specific plan history version. | [x] |
| `GET /api/plan/versions` | List current plan versions. | [x] |
| `GET /api/archive/plans` | List archived plan decisions, cached during session. | [x] |
| `GET /api/archive/plan` | Read one archived plan file. | [x] |
| `POST /api/done` | Resolve archive Done and close archive browser. | [x] |
| `GET /api/doc` | Serve linked markdown/HTML/code document. | [x] |
| `POST /api/doc/exists` | Batch-validate code-file links. | [x] |
| `GET /api/hooks/status` | Report improvement/PFM hook status. | [x] |
| `POST /api/config` | Save user config. | [x] |
| `GET /api/image` | Serve uploaded/local image by path. | [x] |
| `POST /api/upload` | Upload image to temp storage. | [x] |
| `POST /api/plan/vscode-diff` | Open plan version diff in VS Code. | [x] |
| `GET /api/obsidian/vaults` | Detect Obsidian vaults. | [x] |
| `GET /api/reference/obsidian/files` | List Obsidian markdown files. | [x] |
| `GET /api/reference/obsidian/doc` | Read Obsidian markdown file. | [x] |
| `GET /api/reference/files` | File browser tree for annotate/reference use. | [x] |
| `GET /api/agents` | OpenCode agent list when client is available. | [x] |
| `GET/POST/DELETE /api/draft` | Load/save/delete annotation drafts. | [x] |
| `POST /api/save-notes` | Save notes via integrations. | [x] |
| `POST /api/approve` | Resolve approved plan with optional feedback, saves, integrations, agent switch, permission mode. | [x] |
| `POST /api/deny` | Resolve denied plan and optional save. | [x] |
| `GET /favicon.svg` | Serve app favicon. | [x] |
| History saving | Save every arriving plan to `~/.plannotator/history`. | [x] |
| Decision snapshots | Save approved/denied final snapshots when settings request it. | [x] |

Shared plan/review support routes:

- Editor annotations: `GET /api/editor-annotations`, `POST /api/editor-annotation`, `DELETE /api/editor-annotation` in `packages/server/editor-annotations.ts`.
- External annotations: `GET /api/external-annotations/stream`, `GET/POST/PATCH/DELETE /api/external-annotations` in `packages/server/external-annotations.ts`.
- Agent jobs: `GET /api/agents/capabilities`, `GET /api/agents/jobs/stream`, `GET/POST/DELETE /api/agents/jobs`, `DELETE /api/agents/jobs/:id` in `packages/server/agent-jobs.ts`.

Final shared-route check: [x]

### Review Server

Source: `packages/server/review.ts`.

| Endpoint/behavior | Purpose | Final check |
| --- | --- | --- |
| `GET /api/diff` | Return current diff payload, origin, diff type, base, PR/git context, repo info. | [x] |
| `POST /api/diff/switch` | Switch local diff type/base/whitespace mode and recompute patch. | [x] |
| `POST /api/pr-diff-scope` | Switch PR diff scope between layer/full stack. | [x] |
| `GET /api/pr-list` | List PRs for current repository. | [x] |
| `POST /api/pr-switch` | Switch review session to a different PR URL. | [x] |
| `GET /api/pr-context` | Return PR context/details for UI and agent prompts. | [x] |
| `POST /api/pr-action` | Perform platform PR action/comment/approval flow. | [x] |
| `POST /api/pr-viewed` | Mark PR viewed. | [x] |
| `GET /api/file-content` | Return old/new file content for expandable diff context. | [x] |
| `POST /api/code-nav/resolve` | Resolve symbol definitions/references. | [x] |
| `GET /api/code-nav/file` | Read file preview for code navigation. | [x] |
| `POST /api/git-add` | Stage or unstage a file when supported. | [x] |
| `POST /api/config` | Save user config. | [x] |
| `GET /api/image`, `POST /api/upload` | Image serving/upload. | [x] |
| `GET /api/agents` | OpenCode agent list when client is available. | [x] |
| `GET/POST/DELETE /api/draft` | Review annotation drafts. | [x] |
| `POST /api/exit` | Resolve review session as closed/exit. | [x] |
| `POST /api/feedback` | Resolve approved/denied review feedback and annotations. | [x] |
| `GET /api/tour/:jobId` | Fetch completed Code Tour result. | [x] |
| `PUT /api/tour/:jobId/checklist` | Persist Code Tour checklist state. | [x] |
| `/api/ai/*` | AI session/capability/query/abort/permission endpoints when providers are available. | [x] |
| `GET /favicon.svg` | Serve app favicon. | [x] |

### Annotate Server

Source: `packages/server/annotate.ts`.

| Endpoint/behavior | Purpose | Final check |
| --- | --- | --- |
| `GET /api/plan` | Return annotate payload, source info, gate, raw HTML/render mode, server config. | [x] |
| `POST /api/config` | Save user config. | [x] |
| `GET /api/image`, `POST /api/upload` | Image serving/upload. | [x] |
| `GET /api/doc` | Serve linked file/doc content with annotate base handling. | [x] |
| `POST /api/doc/exists` | Batch-validate code-file links. | [x] |
| `GET /api/obsidian/vaults` | Detect Obsidian vaults. | [x] |
| `GET /api/reference/obsidian/files` | List Obsidian markdown files. | [x] |
| `GET /api/reference/obsidian/doc` | Read Obsidian markdown file. | [x] |
| `GET /api/reference/files` | File browser tree. | [x] |
| `GET/POST/DELETE /api/draft` | Annotation drafts. | [x] |
| `POST /api/exit` | Close session without feedback. | [x] |
| `POST /api/approve` | Approve review-gate annotate session. | [x] |
| `POST /api/feedback` | Resolve annotation feedback and annotations. | [x] |
| `GET /favicon.svg` | Serve app favicon. | [x] |

## Pi Mirrored Node Server Inventory

Current owner: `apps/pi-extension/server.ts` and `apps/pi-extension/server/`.

Target owner: remove from Pi package; all routes above must be served only by the Bun binary.

| Mirrored file/group | Current purpose | Final check |
| --- | --- | --- |
| `server.ts` | Barrel re-export of Pi Node server functions and VCS helpers. | [x] |
| `server/serverPlan.ts` | Node equivalent of plan/archive server routes. | [x] |
| `server/serverReview.ts` | Node equivalent of review server routes, AI providers, PR actions, tours, code nav. | [x] |
| `server/serverAnnotate.ts` | Node equivalent of annotate server routes. | [x] |
| `server/network.ts` | Remote detection, fixed/random port, browser opening. | [x] |
| `server/vcs.ts`, `server/pr.ts`, `server/project.ts` | Node-side VCS/PR/project helpers. | [x] |
| `server/handlers.ts`, `reference.ts`, `integrations.ts`, `annotations.ts`, `external-annotations.ts`, `agent-jobs.ts`, `ide.ts` | Mirrored route/helper implementations. | [x] |
| `vendor.sh` / `generated/` | Copies shared/server/AI code into Pi package for Node runtime. | [x] |
| `server.test.ts`, `server/network.test.ts` | Parity tests for mirrored Node server. | [x] |

## OpenCode Behavior Inventory

Current owner: `apps/opencode-plugin/index.ts`, `apps/opencode-plugin/commands.ts`, `apps/opencode-plugin/workflow.ts`.

Target owner: OpenCode plugin keeps agent integration behavior but delegates browser/server work to binary client.

| Behavior | Current owner/evidence | Target owner | Final check |
| --- | --- | --- | --- |
| Workflow options | `normalizeWorkflowOptions`, `applyWorkflowConfig`; modes `plan-agent`, `manual`, `user-managed`, `all-agents`. | OpenCode plugin | [x] |
| Plan-agent tool permissions | Adds `submit_plan` to configured planning agents, denies build/non-planning agents as configured. | OpenCode plugin | [x] |
| Prompt transforms | Rewrites OpenCode plan-mode prompt and injects planning/system reminders plus PFM/improvement context. | OpenCode plugin | [x] |
| Tool definition rewrites | Rewrites `plan_exit` and `todowrite` descriptions during plan mode. | OpenCode plugin | [x] |
| Command interception | Intercepts `plannotator-last`, `plannotator-annotate`, `plannotator-review`, `plannotator-archive` before the agent sees command body/args. | OpenCode plugin | [x] |
| Bundled HTML lazy loading | Reads `plannotator.html` and `review-editor.html` from package. | Remove; binary owns assets | [x] |
| `submit_plan` backing file | Manages `.opencode/plans/_active-plan.md` with line-range edits. | OpenCode plugin | [x] |
| Edit validation | Validates positive line ranges, non-overlap, append semantics, max 5 MB plan. | OpenCode plugin | [x] |
| Plan approval handling | Supports approved, approved-with-notes, saved path, optional agent switch, target agent prompt. | OpenCode plugin + binary result | [x] |
| Plan denial handling | Returns configured denial prompt and line-numbered current plan for targeted edits. | OpenCode plugin + binary result | [x] |
| Review command | Parses PR/local review args, prepares diff/PR data, starts review server, injects feedback or approval prompt. | Move diff/server ownership to binary; keep injection | [x] |
| Annotate command | Parses annotate args, resolves file/folder/URL, converts HTML/URL to markdown, starts annotate server, injects file feedback. | Move file/URL/server ownership to binary where possible; keep injection | [x] |
| Last-message annotation | Reads last assistant message from OpenCode session, starts annotate-last, injects message feedback. | OpenCode plugin + binary result | [x] |
| Archive command | Starts archive server and waits for Done. | Binary client | [x] |
| Sharing settings | Reads OpenCode config `share`, env `PLANNOTATOR_SHARE`, share/paste base URLs. | Binary/client contract | [x] |
| Agent list bridge | Passes OpenCode client into server for `/api/agents`. | Needs binary/daemon design or plugin-result bridge | [x] |

Current OpenCode tests:

- `submit-plan.test.ts`: backing file path, edit application, validation, line numbers.
- `workflow.test.ts`, `plan-mode.test.ts`: workflow normalization, prompt/tool behavior.
- `commands.test.ts`: command behavior uses injected binary-client mocks.

Final OpenCode test check: [x]

## Pi Behavior Inventory

Current owner: `apps/pi-extension/index.ts`, `apps/pi-extension/plannotator-events.ts`, `apps/pi-extension/plannotator-browser.ts`, helper modules.

Target owner: Pi extension keeps agent integration behavior and delegates browser/server work to binary client.

| Behavior | Current owner/evidence | Target owner | Final check |
| --- | --- | --- | --- |
| Session lifecycle | Registers current Pi session, clears on shutdown, restores persisted phase state on session start. | Pi extension | [x] |
| Plan mode flag/command | `--plan`, `/plannotator`, `Ctrl+Alt+P`, optional plan path, status updates. | Pi extension | [x] |
| Phase config | Loads `plannotator.json`, global/project overrides, applies active tools/model/thinking/status/system prompt. | Pi extension | [x] |
| Tool scope | Adds `plannotator_submit_plan` only during planning and strips it otherwise. | Pi extension | [x] |
| Planning write gate | Blocks `write`/`edit` outside markdown files inside cwd during planning. | Pi extension | [x] |
| Plan submit tool | Validates plan mode, file path, markdown extension, cwd containment, file existence, non-empty content. | Pi extension | [x] |
| Non-UI auto-approve | If `ctx.hasUI` is false or current browser assets are missing, auto-approves and moves to executing. | Pi extension; asset-missing branch should disappear when binary owns assets | [x] |
| Plan review UI | Starts local Node plan server with bundled HTML, waits for approve/deny. | Binary client | [x] |
| Plan approval/denial prompts | Uses shared prompt helpers for approved, approved-with-notes, denied with plan-file rule. | Pi extension + binary result | [x] |
| Execution checklist | Parses markdown checklist, tracks `[DONE:n]`, updates status/widget, completes phase. | Pi extension | [x] |
| Before-agent context | Injects planning/executing context and improvement/PFM context. | Pi extension | [x] |
| Context cleanup | Filters stale Plannotator context while idle. | Pi extension | [x] |
| `/plannotator-status` | Reports phase, last plan path, and checklist progress. | Pi extension | [x] |
| `/plannotator-review` | Parses review args, starts code review session in background, injects approval/denial/PR feedback. | Pi extension + binary client | [x] |
| PR/local checkout behavior | Current `plannotator-browser.ts` can fetch PRs, create worktrees, shallow clone cross-repo PRs, default local checkout unless `--no-local`. | Move to binary | [x] |
| `/plannotator-annotate` | Parses file/folder/URL/html args, resolves `@` references, converts URL/HTML, starts annotation, injects feedback. | Move content prep/server ownership to binary where possible; keep injection | [x] |
| `/plannotator-last` | Captures last assistant message, supports `--gate`, anchors feedback if session moved. | Pi extension + binary result | [x] |
| `/plannotator-archive` | Opens archive browser and waits for close. | Binary client | [x] |
| Event channel | Handles `plannotator:request` actions: `plan-review`, `review-status`, `code-review`, `annotate`, `annotate-last`, `archive`. | Pi extension + binary client | [x] |
| Event result channel | Emits `plannotator:review-result` and persists review status in `~/.pi/plannotator-review-status.json`. | Pi extension | [x] |
| Current-session fallback | Sends feedback to current Pi session when original session moved or send fails. | Pi extension | [x] |

Current Pi tests:

- `tool-scope.test.ts`: planning tool and write path gates.
- `config.test.ts`: layered config, templates, todo formatting.
- `plannotator-browser.test.ts`: local PR checkout option.
- `packaging.test.ts`: asserts `server.ts`, `server/`, browser HTML assets, and generated AI/server payloads are absent.

Final Pi test check: [x]

## Package, Build, CI, And Installer Inventory

| Area | Current state | Target state | Final check |
| --- | --- | --- | --- |
| Release binary build | `.github/workflows/release.yml` builds hook/review UI, compiles `apps/hook/server/index.ts` for macOS/Linux/Windows architectures, publishes SHA256 and attestations. | Keep intact. | [x] |
| Root build scripts | `build:hook`, `build:review`, `build:opencode`, `build:pi`; `typecheck` runs `apps/pi-extension/vendor.sh`. | Remove Pi vendoring from typecheck/build if no longer needed. | [x] |
| OpenCode package payload | Ships `dist`, `commands`, `README.md`, `plannotator.html`, `review-editor.html`; build copies HTML and bundles `index.ts`. | Remove plugin-owned HTML payloads; keep plugin JS and commands. | [x] |
| OpenCode dependencies | Runtime depends only on `@opencode-ai/plugin`; dev depends on `@plannotator/server`/`shared`. | Runtime remains thin; dev deps should not include server unless tests need types only. | [x] |
| Pi package payload | Ships extension files, `server.ts`, `server/`, `generated/`, copied HTML, copied `skills/`. | Remove server/runtime/HTML payloads; keep Pi-specific files and skills as needed. | [x] |
| Pi build script | Copies hook/review HTML, copies skills, runs `vendor.sh`. | Stop copying browser HTML; shrink/remove vendoring. | [x] |
| Test workflow | Runs `bash apps/pi-extension/vendor.sh`, typecheck, `bun test`. | Remove vendoring step when no longer needed. | [x] |
| Installer scripts | Install binary to `~/.local/bin`, configure hooks/commands/plugins, update Pi extension, manage skills and caches. | Continue installing binary and plugin packages; docs/tests mention plugin runtime dependency on installed binary. | [x] |
| Env vars | Existing runtime env includes `PLANNOTATOR_REMOTE`, `PLANNOTATOR_PORT`, `PLANNOTATOR_BROWSER`, share vars, `PLANNOTATOR_ORIGIN`, Jina/config vars. | Add/document `PLANNOTATOR_BIN` and auto-install opt-out/test env. | [x] |

## Final Parity Closure Template

Before completion, fill this section with real evidence:

- [x] Command outputs for required tests/builds.
- [x] Code-search outputs proving OpenCode and Pi no longer own server/runtime code.
- [x] Package JSON excerpts proving OpenCode and Pi do not ship browser HTML or Pi server folders.
- [x] Fact closure notes for every fact in `facts.md`.
- [x] Flow closure notes for every OpenCode and Pi user-facing workflow above.
- [x] Explicit residual risks or uncovered manual smoke checks, if any.

## Final Closure Evidence

### Command outputs

- `git fetch origin main && git rev-list --left-right --count HEAD...origin/main` — passed, `0 0`; branch head matches current `origin/main` (`807cc5f09be92baa4546be9d85188417fe467fe3`).
- `bun run typecheck` — passed.
- `bun test` — passed after the final hook CLI patch, 1156 pass / 0 fail.
- `bun test apps/opencode-plugin apps/pi-extension packages/shared/plugin-protocol.test.ts packages/shared/plugin-binary.test.ts apps/hook/server/cli.test.ts` — passed, 111 pass / 0 fail.
- `bun run build:review` — passed.
- `bun run build:hook` — passed.
- `bun run build:opencode` — passed, bundled 16 modules into `apps/opencode-plugin/dist/index.js`.
- `bun run build:pi` — passed, copies Pi skills and regenerates shared helpers only.
- `bun build apps/hook/server/index.ts --outfile /tmp/plannotator-cli-test.js --target bun` — passed after the final hook CLI patch.

### Absence checks

- `rg '@plannotator/server|startPlannotatorServer|startReviewServer|startAnnotateServer' apps/opencode-plugin --glob '!*.test.ts'` — no output.
- `rg './server|server\.js|apps/pi-extension/server|startPlanReviewServer|startReviewServer|startAnnotateServer|plannotator.html|review-editor.html' apps/pi-extension --glob '!*.test.ts'` — no output.
- `test ! -d apps/pi-extension/server && test ! -f apps/pi-extension/server.ts && test ! -d apps/pi-extension/generated/ai` — passed.
- OpenCode package `files`: `["dist", "commands", "README.md"]`.
- Pi package `files`: `["index.ts", "assistant-message.ts", "binary-client.ts", "current-pi-session.ts", "plannotator-browser.ts", "plannotator-events.ts", "tool-scope.ts", "config.ts", "plannotator.json", "generated/", "README.md", "skills/"]`.

### Fact closure notes

| Fact | Evidence |
| --- | --- |
| One Bun server runtime serves plan/review/annotate/archive. | Pi `server/` and `server.ts` deleted; OpenCode runtime has no server imports; `tests/parity/route-parity.test.ts` now asserts Bun route ownership. |
| Pi no longer ships/calls mirrored `node:http` server. | `apps/pi-extension/packaging.test.ts`; `test ! -d apps/pi-extension/server`; package files exclude `server.ts` and `server/`. |
| OpenCode no longer starts servers in-process. | `apps/opencode-plugin/commands.ts` delegates to `runPlugin*`; absence search has no runtime hits. |
| OpenCode/Pi do not package browser HTML. | Package `files` arrays exclude `plannotator.html` and `review-editor.html`; build scripts no longer copy HTML. |
| OpenCode/Pi are installed-binary clients. | `apps/opencode-plugin/binary-client.ts`, `apps/pi-extension/binary-client.ts`, and command/session flows use plugin protocol calls. |
| Boundary is daemon-first. | `packages/shared/plugin-protocol.ts` has versioned capabilities and request/result types; `docs/single-binary-runtime.md` documents transport-neutral protocol. |
| Full daemon endpoint is identified. | `docs/single-binary-runtime.md` lists session creation, IDs, routing, decisions, cancellation/TTL, and concurrency. |
| Current ephemeral server is not treated as final daemon. | `docs/single-binary-runtime.md` explicitly says phase one is not the final daemon and `packages/server/sessions.ts` is not it. |
| OpenCode keeps OpenCode-specific behavior. | Existing `submit-plan`, `workflow`, `plan-mode`, and command tests pass. |
| Pi keeps Pi-specific behavior. | `config`, `tool-scope`, `plannotator-browser`, and packaging tests pass; plan auto-approve remains tied to `ctx.hasUI`. |
| Binary discovery/install/capability verification works. | `packages/shared/plugin-binary.test.ts`, `apps/opencode-plugin/binary-client.test.ts`, and `apps/pi-extension/binary-client.test.ts`. |
| Workflows continue. | Automated coverage for client formatting/hand-off plus full suite/builds pass; manual browser smoke remains recommended before release. |
| No UI/data/command/release redesign. | UI packages unchanged except rebuild output; command names unchanged; release binary build remains hook/review UI then binary compile. |
| Automated tests cover migration boundaries. | Packaging tests, route ownership test, binary-client tests, protocol tests, full `bun test`. |

### OpenCode flow closure

| Flow | Evidence |
| --- | --- |
| Workflow/prompt transforms and tool registration | `apps/opencode-plugin/workflow.test.ts`, `plan-mode.test.ts`. |
| `submit_plan` backing file/edit validation/approval-denial formatting | `apps/opencode-plugin/submit-plan.test.ts`; `index.ts` calls `runPluginPlan`. |
| `/plannotator-review` | `commands.ts` passes raw args to `runPluginReview`; binary owns diff/PR prep. |
| `/plannotator-annotate` | `commands.test.ts` verifies raw args and share/paste values passed to `runPluginAnnotate`; feedback injection uses returned file metadata. |
| `/plannotator-last` | `commands.test.ts` verifies last assistant message is sent to `mode:"annotate-last"`. |
| `/plannotator-archive` | `commands.ts` calls `runPluginArchive`; packaging tests prove no local server. |
| Agent switching | `index.ts` and `commands.ts` preserve returned `agentSwitch` handling. |

### Pi flow closure

| Flow | Evidence |
| --- | --- |
| Phase state/config/tool gating/write gate | `apps/pi-extension/config.test.ts`, `tool-scope.test.ts`. |
| Non-UI auto-approve | `index.ts` still auto-approves when `!ctx.hasUI`; missing-HTML branch is gone because `hasPlanBrowserHtml()` is always true. |
| Plan review UI | `plannotator_submit_plan` calls `openPlanReviewBrowser`, which calls `runPluginPlan`. |
| Code review and PR local checkout | `/plannotator-review` calls `startCodeReviewBrowserSession`, which sends `prUrl`, `vcsType`, `useLocal`, `diffType`, and `defaultBranch` to `runPluginReview`; `shouldUseLocalPrCheckout` tests preserve default local behavior. |
| Annotation and last-message flows | `index.ts` keeps Pi-specific feedback/session fallback; `plannotator-browser.ts` delegates sessions to `runPluginAnnotate`. |
| Archive flow | `/plannotator-archive` and event `archive` call `runPluginArchive`. |
| Event channel compatibility | `plannotator-events.ts` still handles all request/status/result actions; plan-review pending IDs are generated by Pi while the binary call runs. |

### Revalidation on daemon stack

- `bun run typecheck` — passed after the daemon review fixes.
- `bun run test` — passed after the daemon review fixes, 1255 pass / 0 fail.
- Single-runtime package boundaries still hold: Pi has no `apps/pi-extension/server/` or `server.ts`, OpenCode runtime code has no `@plannotator/server` imports, and OpenCode/Pi package `files` arrays still exclude plugin-owned browser HTML payloads.
- The follow-on daemon goal now implements the long-running multi-session daemon called out as future work in this phase-one plan.

### Residual risks / manual smoke

- Subprocess transport cannot expose OpenCode's live agent list to `/api/agents`; the UI falls back to empty validation until the daemon has an agent bridge.
- Browser-ready URLs are emitted by the binary process; remote OpenCode/Pi environments should be manually smoked before release to confirm users see or can reach the session URL.
- Release-candidate remote OpenCode/Pi environments should still get a real SSH/devcontainer smoke test even though the daemon stack now covers the long-running multi-session architecture.
