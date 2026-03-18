# Plannotator for Pi

Plannotator integration for the [Pi coding agent](https://github.com/mariozechner/pi). Adds file-based plan mode with a visual browser UI for reviewing, annotating, and approving agent plans.

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

When the agent calls `exit_plan_mode`, the Plannotator UI opens in your browser. You can:

- **Approve** the plan to begin execution
- **Deny with annotations** to send structured feedback back to the agent
- **Approve with notes** to proceed but include implementation guidance

The agent iterates on the plan until you approve, then executes with full tool access. On resubmission, Plan Diff highlights what changed since the previous version.

### Code review

Run `/plannotator-review` to open your current git changes in the code review UI. Annotate specific lines, switch between diff views (uncommitted, staged, last commit, branch), and submit feedback that gets sent to the agent.

### Markdown annotation

Run `/plannotator-annotate <file.md>` to open any markdown file in the annotation UI. Useful for reviewing documentation or design specs with the agent.

### Annotate last message

Run `/plannotator-last` to annotate the agent's most recent response. The message opens in the annotation UI where you can highlight text, add comments, and send structured feedback back to the agent.

### Progress tracking

During execution, the agent marks completed steps with `[DONE:n]` markers. Progress is shown in the status line and as a checklist widget in the terminal.

## Commands

| Command | Description |
|---------|-------------|
| `/plannotator [path]` | Toggle plan mode. Accepts optional file path or prompts interactively |
| `/plannotator-set-file <path>` | Change the plan file path mid-session |
| `/plannotator-status` | Show current phase, plan file, and progress |
| `/plannotator-review` | Open code review UI for current changes |
| `/plannotator-annotate <file>` | Open markdown file in annotation UI |
| `/plannotator-last` | Annotate the last assistant message |

## Flags

| Flag | Description |
|------|-------------|
| `--plan` | Start in plan mode |
| `--plan-file <path>` | Custom plan file path (default: `PLAN.md`) |

## Keyboard shortcuts

| Shortcut | Description |
|----------|-------------|
| `Ctrl+Alt+P` | Toggle plan mode |

## How it works

The extension manages a state machine: **idle** → **planning** → **executing** → **idle**.

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

- [Pi](https://github.com/mariozechner/pi) >= 0.53.0
