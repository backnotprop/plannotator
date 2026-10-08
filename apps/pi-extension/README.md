# Plannotator for Pi

Plannotator integration for the [Pi coding agent](https://github.com/earendil-works/pi). Adds file-based plan mode with a visual browser UI for reviewing, annotating, and approving agent plans.

## Install

**From npm** (recommended):

```bash
pi install npm:@plannotator/pi-extension
```

**From source:**

```bash
git clone https://github.com/backnotprop/plannotator.git
pi install ./plannotator/apps/pi-extension
```

**Try without installing:**

```bash
pi -e npm:@plannotator/pi-extension
```

## Update

```bash
pi update --extensions
```

This updates your installed Pi packages, Plannotator included. `pi update npm:@plannotator/pi-extension` updates only Plannotator, and `pi update --all` updates Pi and every package. A plain `pi update` updates only Pi itself, not Plannotator. Restart Pi after updating.

## Pi version and project trust

Plannotator requires **Pi 0.79.1 or newer**. Updating only the Plannotator
extension does not repair the security behavior of an older Pi host; update Pi
itself before loading the extension.

Pi 0.79 introduced project trust for repository-local inputs. In interactive
sessions, Pi asks before loading project settings, instructions, resources, and
packages, and can save the decision for that working directory. Plannotator
honors the same decision for `.pi/plannotator.json`.

Noninteractive sessions ignore project-local inputs unless the project already
has a saved trust decision or Pi is started with `--approve` (`-a`). Use
`--no-approve` (`-na`) to disable project inputs for a run even when the project
was previously trusted.

## Uninstall

Remove a standalone Pi installation with:

```bash
pi remove npm:@plannotator/pi-extension
```

If Pi was configured by the full Plannotator installer, `plannotator uninstall`
also detects and removes the extension through Pi.

## Build from source

If installing from a local clone, build the HTML assets first:

```bash
cd plannotator
bun install
bun run build:pi
```

This builds the plan review and code review UIs and copies them into `apps/pi-extension/`.

## Usage

### Plan mode

Start Pi in plan mode:

```bash
pi --plan
```

Or toggle it during a session with `/plannotator-plan-mode` or `Ctrl+Alt+P`.

In plan mode the agent is restricted — destructive commands are blocked, writes are limited to the plan file. It explores your codebase, then writes a plan using markdown checklists:

```markdown
- [ ] Add validation to the login form
- [ ] Write tests for the new validation logic
- [ ] Update error messages in the UI
```

When the agent calls `plannotator_submit_plan`, the Plannotator UI opens in your browser. You can:

- **Approve** the plan to begin execution
- **Deny with annotations** to send structured feedback back to the agent
- **Approve with notes** to proceed but include implementation guidance

The agent iterates on the plan until you approve, then executes with full tool access. On resubmission, Plan Diff highlights what changed since the previous version.

The submit tool does not wait for you: it returns as soon as the review opens, the agent ends its turn, and your decision reaches it later as a new message. While the review is open you can keep chatting with the agent in Pi, or ask it questions from the review's Ask AI panel ("Ask this session"). It still cannot change code: planning restrictions stay on until you approve. If the agent revises the plan while the review is open, the open tab updates to the new version and keeps your comments. Leaving plan mode closes an open review.

Pressing Esc in Pi no longer cancels an open plan review. To abandon a review, leave plan mode (`/plannotator-plan-mode` or `Ctrl+Alt+P`).

### Programmatic plan-mode control

Other Pi extensions can enter, exit, toggle, or query Plannotator plan mode through the shared Pi event bus without invoking the `/plannotator-plan-mode` slash command:

```ts
import { PLANNOTATOR_REQUEST_CHANNEL } from "@plannotator/pi-extension/plannotator-events";

const response = await new Promise((resolve) => {
  pi.events.emit(PLANNOTATOR_REQUEST_CHANNEL, {
    requestId: crypto.randomUUID(),
    action: "plan-mode",
    payload: { mode: "enter" }, // "enter" | "exit" | "toggle" | "status"
    respond: resolve,
  });
});
```

A handled response returns the resulting phase, for example `{ status: "handled", result: { phase: "planning" } }`.

### Configuring per-phase behavior

Plannotator loads configuration in three layers:

1. Built-in base config shipped with the package: `plannotator.json`
2. Global user config: `~/.pi/agent/plannotator.json`
3. Project-local config: `<cwd>/.pi/plannotator.json`

Later layers overwrite earlier ones. If a field is omitted, it inherits the value from lower-precedence layers. If a value is set to `null`, an empty string, or an empty array, it clears the inherited value instead of merging it. You can also set `defaults` or an entire phase object to `null` to clear all inherited settings from lower-precedence layers.

#### Top-level shape

```json
{
  "executionMode": "automatic",
  "defaults": {
    "model": { "provider": "anthropic", "id": "claude-sonnet-4-5" },
    "thinking": "medium",
    "activeTools": ["read", "bash"],
    "statusLabel": "Ready",
    "instructions": "Optional phase-entry message template"
  },
  "phases": {
    "planning": {
      "model": null,
      "thinking": null,
      "activeTools": ["grep", "find", "ls", "plannotator_submit_plan"],
      "statusLabel": "⏸ plan",
      "instructions": "[PLANNING]\nPlan file: ${planFilePath}"
    },
    "executing": {
      "model": { "provider": "anthropic", "id": "claude-sonnet-4-5" },
      "thinking": "high",
      "activeTools": [],
      "statusLabel": "",
      "instructions": "[EXECUTING]\nExecute ${planFilePath}.\n\nEntry checklist:\n${todoList}"
    },
    "reviewing": {
      "instructions": "..."
    }
  }
}
```

#### Option reference

| Option | Type | Meaning |
|--------|------|---------|
| `executionMode` | `automatic` \| `external` | `automatic` executes approved plans in the current Pi session; `external` emits a handoff event and returns to idle |
| `defaults` | object | Base values applied to every phase before phase-specific overrides |
| `phases` | object | Phase-specific overrides |
| `phases.planning` | object | Settings for planning mode |
| `phases.executing` | object | Settings for execution mode |
| `phases.reviewing` | object | Reserved for future review-mode customization |
| `model` | `{ provider, id }` \| `null` | Sets the model for the phase; `null` leaves the current model unchanged |
| `thinking` | `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` \| `null` | Sets the thinking level; `null` leaves the current level unchanged. Pi clamps a level the running model does not support, and an unrecognized value is reported as a warning instead of being ignored |
| `activeTools` | string[] \| `null` | Tools to turn on for the phase. Setting it **replaces** the inherited list rather than adding to it (phase overrides `defaults`, your config overrides the built-in one); `[]` or `null` means no extra phase tools. `plannotator_submit_plan` is always enabled during planning regardless of this setting |
| `statusLabel` | string \| `null` | Optional UI label for the phase; empty/null clears it |
| `instructions` | string \| `null` | Phase framing template, delivered **once** as a hidden conversation message when the phase is entered; empty/null disables the framing message. Replaces the removed `systemPrompt` key, which is now ignored with a warning |

#### Prompt variables

Use these inside `instructions` strings. They render once, when the phase is entered:

- `${planFilePath}` — current plan file path
- `${todoList}` — remaining checklist items as markdown checkboxes (an entry-time snapshot; live updates arrive as separate per-turn messages)
- `${completedCount}` — completed checklist count
- `${totalCount}` — total checklist count
- `${remainingCount}` — remaining checklist count
- `${phase}` — current runtime phase (`planning`, `executing`, `reviewing`, or `idle`)

#### Behavior notes

- **Plannotator never modifies Pi's system prompt.** Pi's base prompt (AGENTS.md context, the skills catalog, tools guidance, `--append-system-prompt` text, working directory) always reaches the model untouched. Phase framing is injected as conversation messages instead, so prompt-cache invalidation reduces to appends at the tail of the conversation plus one history adjustment per phase transition.
- The `instructions` template is delivered exactly once per phase entry as a hidden message; later prompts in the same phase inject nothing. During execution, a small todo-status message is added per prompt as steps complete. Only the newest framing for the current phase is kept in model context: stale framing from other phases or earlier plan cycles is filtered out, and everything Plannotator injected is filtered while idle.
- The one exception while idle is a hidden "plan mode off" notice, delivered on the first prompt after plan mode is turned off (or a plan completes/hands off), which tells the model the planning/execution instructions no longer apply. It is delivered once but then stays anchored in model context for the rest of the idle session; unlike phase framing it is not re-delivered after a compaction. Sessions that never enter plan mode inject nothing at all.
- Executing `instructions` that do not reference `${todoList}` get the entry-time todo snapshot appended automatically, so the first executing prompt always carries the checklist.
- The old `systemPrompt` config key is obsolete and ignored; a warning at session start points to `instructions`.
- Unknown template variables trigger a warning in the UI and are rendered as empty strings.
- `activeTools` **replaces** the list it inherits — it does not merge with it. Defining `phases.planning.activeTools` in your own config supersedes the built-in `["grep", "find", "ls", "plannotator_submit_plan"]` entirely, so list every tool you want for that phase.
- The resolved list is then turned on *alongside* whatever tools are already active in the session, so Plannotator still preserves tools provided by other extensions, and on phase exit it turns off only the tools it added.
- `plannotator_submit_plan` is always enabled during planning even if your `activeTools` omits it — the planning instructions tell the model to call it, so the phase cannot complete without it.
- Execution progress remains dynamic (`[DONE:n]` + checklist tracking), even if `statusLabel` is set.
- `executionMode` defaults to `automatic`, preserving the existing approval-to-execution flow.
- In `external` mode, approval restores the pre-planning model, thinking level, and active tools before emitting the handoff event.

#### Example files

- Built-in base config shipped with the package: `apps/pi-extension/plannotator.json`
- Global user override: `~/.pi/agent/plannotator.json`
- Project-local override: `<cwd>/.pi/plannotator.json`

### Code review

Run `/plannotator-review` to open your current VCS changes in the code review UI. Annotate specific lines, switch between the modes supported by the detected Git, GitButler, or JJ provider, and submit feedback that gets sent to the agent. Pass `--git` or `--gitbutler` to force that provider; GitButler requires `but` 0.21.0 or newer on `PATH`. Pass `--patch-file <path>` to review a static caller-supplied unified diff without a repository.
### Ask this session

In plan review, code review, annotate and `/plannotator-last`, Ask AI is answered by your Pi session ("Ask this session"). It is the only Ask AI option there, so there is no provider picker. Your question shows in Pi's chat. If the agent is busy, choose **Ask when it finishes** or **Interrupt and ask now**. In remote mode you pick a separate provider instead. Review agents, Code Tour and Guided Review still run their own models.

### Shared Plannotator event API

Plannotator also listens on the shared `plannotator:request` event channel so other extensions can reuse the same browser review flows without importing Plannotator internals.

Supported actions and payloads:

- `plan-review`: `{ planContent, planFilePath? }`
- `review-status`: `{ reviewId }`
- `code-review`: `{ cwd?, defaultBranch?, diffType?, vcsType?, useLocal?, prUrl?, patchFile? }`

  Pass `patchFile` (path read at request time, resolved against `cwd`) to
  review a caller-supplied patch without a local repository — the review opens
  in static-patch mode with no file-system affordances that would need the
  worktree. `patchFile` is mutually exclusive with `prUrl`.
- `annotate`: `{ filePath, markdown?, mode?, folderPath? }`
- `annotate-last`: `{ markdown? }`
- `archive`: `{ customPlanPath? }`

Plan review is asynchronous:

- callers send `plannotator:request` with action `plan-review`
- Plannotator opens the browser review and immediately responds with `{ status: "handled", result: { status: "pending", reviewId } }`
- when the human approves or rejects in the browser, Plannotator emits `plannotator:review-result` with `{ reviewId, approved, feedback, savedPath?, agentSwitch?, permissionMode? }`
- callers can query `review-status` with the same `reviewId` to recover from startup races or session restarts

The other shared actions remain request/response flows. Payloads are intentionally minimal and only include fields the shared implementation actually uses.

#### External plan execution handoff

Set `executionMode` to `external` when another Pi extension should orchestrate an approved plan instead of letting Plannotator execute it in the current session:

```json
{
  "executionMode": "external"
}
```

After approval, Plannotator returns to idle and emits `plannotator:plan-approved` with:

```ts
{
  cwd: string;
  planFilePath: string;
  planContent: string;
  feedback?: string;
}
```

`planFilePath` is the path exactly as it was submitted, so it is normally relative to `cwd`. Resolve it against `cwd` before reading the file rather than against the companion extension's own working directory.

Companion extensions can subscribe through the shared event bus:

```ts
import { PLANNOTATOR_PLAN_APPROVED_CHANNEL } from "@plannotator/pi-extension/plannotator-events";
import { resolve } from "node:path";

pi.events.on(PLANNOTATOR_PLAN_APPROVED_CHANNEL, (event) => {
  const planPath = resolve(event.cwd, event.planFilePath);
  // Compile and dispatch the approved plan with an external orchestrator.
});
```

As with `plannotator:request`, the channel is a plain string, so a companion can listen with `pi.events.on("plannotator:plan-approved", ...)` and never import Plannotator internals. The constant and the `PlannotatorPlanApprovedEvent` type are exported purely as a typing convenience.

Plannotator does not send `Continue with the approved plan`, enter its executing phase, or track checklist progress in this mode. The companion extension owns execution after the handoff.

### Markdown annotation

Run `/plannotator-annotate <file.md>` to open any markdown file in the annotation UI. Useful for reviewing documentation or design specs with the agent.

URL targets work too. A loopback `http` URL that answers with an HTML page (a running dev app, e.g. `http://localhost:5173`) opens **live**: the app is served through a local reverse proxy and annotated in place, with HMR and WebSockets passed through. `--static` forces the classic markdown conversion; `--app` requires a live session and errors instead of falling back. Live sessions are unavailable in remote mode (`PLANNOTATOR_REMOTE`).

### Annotate last message

Run `/plannotator-last` to annotate the agent's most recent response. The message opens in the annotation UI where you can highlight text, add comments, and send structured feedback back to the agent.

### The `plannotator` tool

The agent can have a `plannotator` tool (off by default on Pi; see below for turning it on). When you ask it to "open notes.md in Plannotator", it calls the tool instead of running the CLI:

- **Open:** `annotate` a file, folder or URL (`gate: true` adds an Approve button), `review` changes or a PR (`options.base` sets the compare ref), or `last` (the agent's last answer; the message in which the agent calls the tool is skipped). The review opens exactly as the matching slash command opens it, with Ask this session. The tool returns at once with a session id (`pn-3f2a9c`) and the URL, and the agent's turn ends. Your decision arrives later as a new message that starts with `Plannotator: notes.md (pn-3f2a9c) — Feedback · 2 comments.` If the agent asked for a gated sign-off, a plain Approve is sent to it too.
- **List:** the reviews this Pi session opened that are still open, including the ones you opened with `/plannotator-*` commands and plan reviews. Each line shows the id, what it shows, the URL, its age and how many comments you have not sent yet.
- **Close:** one review by id, or `"all"`. This is the same as your Close, except that your unsent comments stay saved as a draft. Nothing is sent to the agent. Plan reviews are not closed this way: they end with your decision or when you leave plan mode.

Another Pi session cannot list or close these reviews. After `/reload` or `/resume` of the same session, the agent still sees the reviews that are open. After `/new` it does not, because that is another session. In remote mode (or with a single `PLANNOTATOR_PORT`) every review uses the same port, so the tool opens only one review at a time and tells the agent which one to close first. The tool is active only in an interactive Pi session: in print or JSON mode the agent does not get it, because nothing could deliver your decision later. To review several files together, the agent passes a list as `target` (for example `["spec.md", "mock.html"]`); they open as one review in that order, with one decision. Decisions from the slash commands now also start with the same `Plannotator: … (pn-…) — …` line.

The tool is off by default: turn it on with `PLANNOTATOR_AGENT_TOOL=1` or `{ "agentTool": true }` in `~/.plannotator/config.json` (the environment variable wins in both directions). Off, the agent has no `plannotator` tool and the slash commands and plan mode work as before. The setting is read when a session starts, so it applies to the next session (or after `/reload`); the tool list never changes during a session, which keeps the model's prompt cache intact.

The extension also ships the `plannotator` knowledge skill (a CLI reference) for installs without the CLI installer's copy. It is user-invoked only: load it with `/skill:plannotator`; it is not listed in the model's system prompt.

### The `plannotator_inbox` tool

With this tool the agent writes to your Plannotator Inbox and reads it: `send_message` starts or continues a thread (a question, a note, files to annotate as attachments), `read_thread` and `wait_for_reply` read your answers, `list_decisions` and `record_decision` keep the project's decisions, and `get_guide_brief` and `submit_guide` send you a guided review. The actions are the ones your Inbox offers when the session starts. When you press Send on a reply, the session that sent the message wakes: the reply goes in as a follow-up once Pi is idle (a run is never interrupted), and the thread shows "Delivered to Pi". If two Pi processes have the same session open, the one you used last gets it. The tool appears only when an Inbox is installed (you ran `plannotator inbox` once) and the `inboxTool` setting is on for Pi. It is off by default on Pi, because Pi sends every tool's full definition with each request. Turn it on with `export PLANNOTATOR_INBOX_TOOL=1`, or with `{ "inboxTool": { "pi": true } }` in `~/.plannotator/config.json` (the Inbox's Settings writes this key; the environment variable wins). The setting is read when a session starts. A call starts a stopped Inbox in the background. In print or JSON mode the tool is inactive.

### Archive browser

The Plannotator archive browser is available through the shared event API as `archive`, which opens the saved plan/decision browser for future callers. The orchestrator does not expose a dedicated archive command yet.

### Progress tracking

During execution, the agent marks completed steps with `[DONE:n]` markers. Progress is shown in the status line and as a checklist widget in the terminal.

## Commands

| Command | Description |
|---------|-------------|
| `/plannotator-plan-mode` | Toggle plan mode. The agent writes a markdown plan file anywhere in the working directory and submits its path |
| `/plannotator-review [DIRECTORY \| PR_URL]` | Open code review UI for current changes, another repository/worktree, or a PR |
| `/plannotator-annotate <file>` | Open markdown file in annotation UI |
| `/plannotator-last` | Annotate the last assistant message |

When the `plannotator` tool is turned on, the agent opens, lists and closes reviews with it (see above).

## Flags

| Flag | Description |
|------|-------------|
| `--plan` | Start in plan mode |

## Keyboard shortcuts

| Shortcut | Description |
|----------|-------------|
| `Ctrl+Alt+P` | Toggle plan mode |

## How it works

By default, the extension manages a state machine: **idle** → **planning** → **executing** → **idle**. With external execution enabled, approval follows **idle** → **planning** → **idle** and emits the handoff event.

During **planning**:
- All tools from other extensions remain available
- Bash is unrestricted — the agent is guided by the planning instructions not to run destructive commands
- Writes and edits restricted to the plan file only

During **executing**:
- Full tool access: `read`, `bash`, `edit`, `write`
- Progress tracked via `[DONE:n]` markers in agent responses
- Plan re-read from disk each turn to stay current

State persists across session restarts via Pi's `appendEntry` API.

## Requirements

- [Pi](https://github.com/earendil-works/pi) >= 0.74.0
