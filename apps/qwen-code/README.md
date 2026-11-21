# Plannotator for Qwen Code

Plan review, code review, annotation and annotate-last for [Qwen Code](https://github.com/QwenLM/qwen-code).

- `extension/` is the `plannotator` Qwen extension. It holds two hooks:
  - `PermissionRequest` on `exit_plan_mode` opens the plan in Plannotator and waits for your decision.
  - `PreToolUse` on `enter_plan_mode` adds Plannotator's planning context when you turned it on (it prints nothing otherwise).
- `skills/` holds `/plannotator-review`, `/plannotator-annotate` and `/plannotator-last` for Qwen Code. They go in `~/.qwen/skills` (or `$QWEN_HOME/skills`), where they take the place of the shared copies in `~/.agents/skills`.

## Plan review in Qwen Code

1. The agent calls `exit_plan_mode`. The plan opens in your browser.
2. **Send feedback:** Qwen Code gives your feedback to the agent at once. The agent revises the plan and calls `exit_plan_mode` again.
3. **Approve:** Qwen Code then shows its own plan confirmation in the terminal. Approve the plan there too.

The second confirmation is a Qwen Code rule: a hook cannot approve a tool that needs you, and `exit_plan_mode` is one. For the same reason, notes you add to an approval cannot reach the agent, so the review does not offer them.

If the `plannotator` command is missing or fails, Qwen Code shows its normal plan confirmation.

## Install

The Plannotator installers (`install.sh`, `install.ps1`, `install.cmd`) install the extension and the skills when they find Qwen Code 0.13.0 or newer (`~/.qwen` or `$QWEN_HOME`, plus the `qwen` command or Qwen's own files there). They keep the extension's source at `~/.plannotator/qwen-code/extension` and update it with `qwen extensions update plannotator`, so an extension you turned off stays off. A linked or hand-installed extension is left alone. `--skip-qwen` turns this off. `plannotator uninstall` removes both.

When you change anything under `extension/`, raise `version` in `qwen-extension.json`: installed copies update only when the version changes.

To install by hand, install the `plannotator` command first. Then, from a Plannotator checkout:

```bash
qwen extensions install ./apps/qwen-code/extension --consent
mkdir -p ~/.qwen/skills && cp -R apps/qwen-code/skills/* ~/.qwen/skills/
```

Restart Qwen Code. Remove the extension with `qwen extensions uninstall plannotator`.

## Ask AI

When `qwen` is on your PATH, Ask AI in plan review, code review and annotate can answer with Qwen Code. In a Qwen Code session it is the default. It runs `qwen` in plan mode with Qwen's file-editing, file-writing, memory and worktree tools turned off, and uses the models from your Qwen Code settings. Other tools your Qwen settings auto-approve (a trusted MCP server, or an allow rule) can still run. Each Ask AI conversation becomes the newest Qwen chat for the project, so `qwen --continue` resumes it; `/plannotator-last` skips it.

## Credit

The first Qwen Code port of Plannotator was made by NonoElRobot in a fork (commit c6a02a0). Its session-log reader, the extension layout and its findings on Qwen's plan confirmation are the base of this integration.
