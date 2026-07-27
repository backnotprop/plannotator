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

Or toggle it during a session with `/plannotator` or `Ctrl+Alt+P`. The command accepts an optional file path argument (`/plannotator plans/auth.md`) or prompts you to choose one interactively.

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

### Programmatic plan-mode control

Other Pi extensions can enter, exit, toggle, or query Plannotator plan mode through the shared Pi event bus without invoking the `/plannotator` slash command:

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
    "systemPrompt": "Optional prompt template"
  },
  "phases": {
    "planning": {
      "model": null,
      "thinking": null,
      "activeTools": ["grep", "find", "ls", "plannotator_submit_plan"],
      "statusLabel": "⏸ plan",
      "systemPrompt": "[PLANNING]\nPlan file: ${planFilePath}"
    },
    "executing": {
      "model": { "provider": "anthropic", "id": "claude-sonnet-4-5" },
      "thinking": "high",
      "activeTools": [],
      "statusLabel": "",
      "systemPrompt": "[EXECUTING]\nRemaining steps:\n${todoList}"
    },
    "reviewing": {
      "systemPrompt": "..."
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
| `thinking` | `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `null` | Sets the thinking level; `null` leaves the current level unchanged |
| `activeTools` | string[] \| `null` | Tools to turn on for the phase. Setting it **replaces** the inherited list rather than adding to it (phase overrides `defaults`, your config overrides the built-in one); `[]` or `null` means no extra phase tools. `plannotator_submit_plan` is always enabled during planning regardless of this setting |
| `statusLabel` | string \| `null` | Optional UI label for the phase; empty/null clears it |
| `systemPrompt` | string \| `null` | Phase system prompt template; empty/null disables prompt injection |

#### Prompt variables

Use these inside `systemPrompt` strings:

- `${planFilePath}` — current plan file path
- `${todoList}` — remaining checklist items as markdown checkboxes
- `${completedCount}` — completed checklist count
- `${totalCount}` — total checklist count
- `${remainingCount}` — remaining checklist count
- `${phase}` — current runtime phase (`planning`, `executing`, `reviewing`, or `idle`)

#### Behavior notes

- Unknown template variables trigger a warning in the UI and are rendered as empty strings.
- `activeTools` **replaces** the list it inherits — it does not merge with it. Defining `phases.planning.activeTools` in your own config supersedes the built-in `["grep", "find", "ls", "plannotator_submit_plan"]` entirely, so list every tool you want for that phase.
- The resolved list is then turned on *alongside* whatever tools are already active in the session, so Plannotator still preserves tools provided by other extensions, and on phase exit it turns off only the tools it added.
- `plannotator_submit_plan` is always enabled during planning even if your `activeTools` omits it — the planning system prompt tells the model to call it, so the phase cannot complete without it.
- Execution progress remains dynamic (`[DONE:n]` + checklist tracking), even if `statusLabel` is set.
- `executionMode` defaults to `automatic`, preserving the existing approval-to-execution flow.
- In `external` mode, approval restores the pre-planning model, thinking level, and active tools before emitting the handoff event.

#### Example files

- Built-in base config shipped with the package: `apps/pi-extension/plannotator.json`
- Global user override: `~/.pi/agent/plannotator.json`
- Project-local override: `<cwd>/.pi/plannotator.json`

### Code review

Run `/plannotator-review` to open your current VCS changes in the code review UI. Annotate specific lines, switch between the modes supported by the detected Git, GitButler, or JJ provider, and submit feedback that gets sent to the agent. Pass `--git` or `--gitbutler` to force that provider; GitButler requires `but` 0.21.0 or newer on `PATH`.

### Shared Plannotator event API

Plannotator also listens on the shared `plannotator:request` event channel so other extensions can reuse the same browser review flows without importing Plannotator internals.

Supported actions and payloads:

- `plan-review`: `{ planContent, planFilePath? }`
- `review-status`: `{ reviewId }`
- `code-review`: `{ cwd?, defaultBranch?, diffType? }`
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

Companion extensions can subscribe through the shared event bus:

```ts
import { PLANNOTATOR_PLAN_APPROVED_CHANNEL } from "@plannotator/pi-extension/plannotator-events";

pi.events.on(PLANNOTATOR_PLAN_APPROVED_CHANNEL, (event) => {
  // Compile and dispatch the approved plan with an external orchestrator.
});
```

Plannotator does not send `Continue with the approved plan`, enter its executing phase, or track checklist progress in this mode. The companion extension owns execution after the handoff.

### Markdown annotation

Run `/plannotator-annotate <file.md>` to open any markdown file in the annotation UI. Useful for reviewing documentation or design specs with the agent.

### Annotate last message

Run `/plannotator-last` to annotate the agent's most recent response. The message opens in the annotation UI where you can highlight text, add comments, and send structured feedback back to the agent.

### Archive browser

The Plannotator archive browser is available through the shared event API as `archive`, which opens the saved plan/decision browser for future callers. The orchestrator does not expose a dedicated archive command yet.

### Progress tracking

During execution, the agent marks completed steps with `[DONE:n]` markers. Progress is shown in the status line and as a checklist widget in the terminal.

## Commands

| Command | Description |
|---------|-------------|
| `/plannotator` | Toggle plan mode. The agent writes a markdown plan file anywhere in the working directory and submits its path |
| `/plannotator-review` | Open code review UI for current changes |
| `/plannotator-annotate <file>` | Open markdown file in annotation UI |
| `/plannotator-last` | Annotate the last assistant message |

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
- Bash is unrestricted — the agent is guided by the system prompt not to run destructive commands
- Writes and edits restricted to the plan file only

During **executing**:
- Full tool access: `read`, `bash`, `edit`, `write`
- Progress tracked via `[DONE:n]` markers in agent responses
- Plan re-read from disk each turn to stay current

State persists across session restarts via Pi's `appendEntry` API.

## Requirements

- [Pi](https://github.com/earendil-works/pi) >= 0.74.0
