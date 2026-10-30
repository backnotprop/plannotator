---
title: "Claude Code"
description: "How Plannotator works with Claude Code — the Plannotator mod, the classic hook, permission modes, and updating the plugin."
sidebar:
  order: 4
section: "Getting Started"
---

Plannotator works with Claude Code in one of two ways. Both open the same review UI.

- **The Plannotator mod** (Claude Code 2.1.287 or newer, in the interactive terminal). It is on by default. Claude does not wait for you.
- **The classic hook** (older Claude Code, `claude -p` and SDK runs, Windows, or the mod turned off). Claude waits until you decide.

## The Plannotator mod

When Claude calls `ExitPlanMode`, or you run `/plannotator-review`, `/plannotator-annotate` or `/plannotator-last`, Plannotator opens in your browser and Claude ends its turn. It does not wait for you:

- You can keep chatting with Claude while the review is open.
- When you decide, your decision arrives in the session as a message from the Plannotator plugin, and Claude continues from there.
- If Claude revises the plan while the review is open, the same tab updates to the new version. Your comments stay.
- After you approve a plan, Claude calls `ExitPlanMode` once more and works from the exact plan text you approved.
- Claude can open Plannotator itself with its `plannotator` tool, for example when you ask it to "open notes.md in Plannotator". A plain `plannotator review`, `annotate` or `last` command that Claude runs in Bash opens the same way. To read it on your phone, ask Claude to open it over Tailscale: the tool's `tailscale` option serves it on your tailnet (HTTPS, never public), and "Ask this session" works there for your Tailscale login.
- Ask AI in the review is answered by this Claude session. See [Ask this session](/docs/guides/ai-features/#ask-this-session).
- The status line shows the reviews that are waiting for you.
- A review stays open if you close the terminal. Resume the session (for example with `claude --continue`) and the decision is delivered.

**Known limit:** while a plan review is open, Claude is not blocked. If you leave plan mode yourself before you approve, Claude can start editing.

Keep the `plannotator` binary up to date as well (run the install script again). With an older binary, plan review falls back to the classic flow.

### Turning the mod off

Set `PLANNOTATOR_CLAUDE_MOD=0` in the shell that starts Claude Code (or in the `env` block of Claude Code's `settings.json`), or add this to `~/.plannotator/config.json`:

```json
{ "claudeCodeMod": false }
```

The environment variable wins over the config file. Claude Code reads the setting when it starts, so restart Claude Code after you change it. With the mod off, the classic hook and the slash command skills work as described below.

To keep only the `plannotator` tool out of Claude's tool list and leave the rest of the mod on, set `PLANNOTATOR_AGENT_TOOL=0` or add `{ "agentTool": false }` to `~/.plannotator/config.json`. The slash commands, plan review, Ask this session, and Bash `plannotator` commands that Claude runs work as before. Turning the tool off keeps that Bash take-over, so a `plannotator` command Claude runs still opens without blocking; to get the blocking CLI back, set `PLANNOTATOR_CLAUDE_MOD=0` instead. Restart Claude Code after you change it.

## The classic hook

Without the mod, Plannotator uses Claude Code's hooks system. When Claude calls `ExitPlanMode`, a `PermissionRequest` hook intercepts the call and opens the Plannotator UI.

Plannotator registers a `PermissionRequest` hook that matches the `ExitPlanMode` tool:

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "ExitPlanMode",
        "hooks": [
          {
            "type": "command",
            "command": "plannotator",
            "timeout": 345600
          }
        ]
      }
    ]
  }
}
```

When matched, the hook:

1. Receives the plan markdown via stdin (as JSON with `tool_input.plan`)
2. Starts a local Bun server on a random port
3. Opens the browser to the plan review UI
4. Waits until you approve or deny (Claude waits too)
5. Returns a JSON response to stdout that Claude Code interprets

**Approve** returns:
```json
{"hookSpecificOutput":{"decision":{"behavior":"allow"}}}
```

**Deny** returns:
```json
{"hookSpecificOutput":{"decision":{"behavior":"deny","message":"<feedback>"}}}
```

## Permission mode

On first use, Plannotator asks you to choose a permission mode. This controls what Claude Code does after you approve a plan:

- **Bypass permissions** — Claude proceeds with implementation without further permission prompts for the approved plan
- **Default** — Normal Claude Code permission behavior applies (you may see additional permission prompts)

This preference is saved and sent with each approval. You can change it in Settings.

## Approve vs. Send Feedback

The header has one decision button. With nothing to send it reads **Approve**; once you add a comment, an answer or an edit it reads **Send Feedback** (or **Send answers** when you only answered the plan's questions). The other choices are behind its arrow:

- **Send Feedback**: the plan is denied with your annotations as structured feedback. Claude revises the plan and presents it again.
- **Request changes…** (nothing added yet): write overall feedback and send it the same way.
- **Approve with notes**: approve and pass your annotations along as non-blocking guidance. Offered only where Claude can receive them: with Plannotator's Claude Code mod (on by default in current Claude Code), not with the classic hook, whose approval response carries no message.
- **Approve, discard N annotations…**: approve and drop what you added, after one confirmation. Where notes on approval would be lost, the row and its confirmation say so.

The same menu shows the permission mode Approve sends ("After approval, Claude Code runs in Auto-accept Edits"), with **Change** to open Settings. `Cmd/Ctrl+Enter` always does what the main button says.

## Slash commands

Plannotator's slash commands are installed as Claude Code skills in `~/.claude/skills` by the install script (the canonical source is `apps/skills/core/`). Claude Code skills are user-invocable by directory name, so these work like slash commands inside your session:

### `/plannotator-review`

Opens a code review UI for your uncommitted `git diff`. Also supports reviewing GitHub pull requests:

```
/plannotator-review https://github.com/owner/repo/pull/123
```

See the [code review docs](/docs/commands/code-review/) for details.

#### Long reviews

This limit applies only without the mod. With the mod on, a review does not hold a Bash command open, so it can stay open as long as you need.

Without the mod, Claude Code runs the command behind a slash command with its Bash tool. After 2 minutes it moves the command to the background, and it stops a background command 30 minutes later. A review that stays open longer than about 32 minutes is therefore closed by Claude Code, not by Plannotator. Your annotations are saved as a draft and come back when you run the command again, and a finished Guided Review is listed under **Previous guides**. A Guided Review that was still generating is lost and must be started again.

To allow longer sessions, raise Claude Code's background time limit in `~/.claude/settings.json`:

```json
{ "env": { "BASH_DEFAULT_TIMEOUT_MS": "14400000" } }
```

This example allows 4 hours. The value is in milliseconds and only takes effect above `1800000` (30 minutes). It is also the default timeout for every other command Claude runs without its own timeout, so a stuck command can wait that long too. See [Claude Code's Bash tool reference](https://code.claude.com/docs/en/tools-reference#time-limit-for-background-commands).

### `/plannotator-annotate <file.md>`

Opens any markdown file in the annotation UI. See the [annotate docs](/docs/commands/annotate/) for details.

### `/plannotator-last`

Annotates the agent's most recent message. See the [annotate last docs](/docs/commands/annotate-last/) for details.

### `/plannotator-inbox`

Opens your [Plannotator Inbox](/docs/reference/inbox/) in the browser, starting it if needed, and shows its address. Use it when you closed the Inbox tab. It also briefs Claude on using the Inbox for the rest of the session, without starting new work; with the plugin you see only the address and Claude gets the briefing unseen.

Optional extra skills (compound planning, setup-goal, visual explainer) are not installed by default. Add them with:

```bash
npx skills add backnotprop/plannotator/apps/skills/extra --global
```

## Plugin installation

The plugin is installed from the marketplace:

```
/plugin marketplace add backnotprop/plannotator
/plugin install plannotator@plannotator
```

Restart Claude Code after installing for hooks to take effect. See the [installation guide](/docs/getting-started/installation/) for manual setup.

## Updating the plugin

Refreshing the marketplace alone does not update an installed plugin. From a terminal:

```bash
claude plugin marketplace update plannotator
claude plugin update plannotator@plannotator
```

Or inside Claude Code: run `/plugin marketplace update plannotator`, then open `/plugin`, go to **Installed**, select **plannotator** and choose **Update now**.

Then restart Claude Code. To update the `plannotator` binary and the slash commands, run the [install script](/docs/getting-started/installation/#updating) again.
