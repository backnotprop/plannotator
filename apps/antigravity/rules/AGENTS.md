# Plannotator Agent Protocol & Architecture (Google Antigravity CLI)

Plannotator is an interactive, browser-based plan review and annotation interface for AI coding agents. It provides a visual feedback loop before modifying repository code.

---

## 1. Core Capabilities & Architecture

- **Interactive Plan Review**: When a plan file is written, Plannotator launches a browser review UI featuring visual GitHub-flavored markdown, Mermaid diagrams, clean vs. raw diff viewers against previous plan iterations, and line-by-line comment annotations.
- **Deterministic Planning Lock**: When a plan is under review or rejected with user annotations, Plannotator enforces a workspace safety lock (`~/.plannotator/planning-locks/`). The agent is strictly prevented from editing source/code files until the user explicitly approves the plan in the browser.
- **Inline Ask AI**: Reviewers can ask questions directly inside the plan browser. Plannotator queries the local `agy` CLI headlessly using the active Gemini model with zero external API keys.
- **Single-Click Approval & Automation Tiers**: Reviewers approve plans with one click, restoring the desired automation level directly into Antigravity CLI via hook `permissionOverrides`.
- **Surface Scope**: Plannotator is designed strictly for **Antigravity CLI (`agy`)** terminal sessions. When operating inside Antigravity 2.0 Desktop or Antigravity IDE, agents should rely on the host's native built-in Planning Mode.

---

## 2. Planning Protocol Workflow

When the user asks to plan, architect, or design any multi-step task or refactor:

1. **Artifact Destination**: Write the full technical implementation plan to `.agents/plans/<plan-name>.md` (or `plans/<plan-name>.md`, `<artifactDirectoryPath>/implementation_plan.md`) using `write_to_file`.
2. **Full File Submissions**: Always write the complete plan using `write_to_file` with `Overwrite: true`. Do not use incremental string replacement (`replace_file_content`) on plan files.
3. **Interactive Review**: Writing to the plan file triggers the `PreToolUse` hook, launching Plannotator in the user's browser and pausing tool execution.
4. **Handling User Decisions**:
   - **If Approved**: The planning lock is released, and granted permission overrides take effect. Proceed immediately with implementation.
   - **If Changes Requested**: The hook denies the write with the user's line annotations and notes. You remain in planning mode. Read the feedback, address all concerns in the plan document, and resubmit the complete revised plan with `write_to_file`.
5. **Preserve Plan Title**: Keep the top-level `# Plan Title` heading identical across revision rounds unless explicitly requested by the user, ensuring Plannotator tracks version diffs and history accurately against previous iterations.

---

## 3. Automation & Permission Modes

Configured by the user in Plannotator Settings (⚙️) under **Permission Mode**:

- **Auto-accept Edits (`acceptEdits` — Default)**: Plannotator returns `"permissionOverrides": ["write_to_file", "replace_file_content", "multi_replace_file_content"]`. File writes during implementation proceed autonomously without prompts, while terminal commands (`run_command`) remain gated for safety.
- **Bypass Permissions (`bypassPermissions`)**: Plannotator returns `"permissionOverrides": ["*"]`. All tools (file edits, bash commands, MCP tools, subagents) run uninterrupted (equivalent to `--dangerously-skip-permissions`).
- **Manual Approval (`default`)**: No overrides returned; Antigravity prompts in the terminal for every tool execution.

---

## 4. Troubleshooting & Agent FAQs

- **"Why was my file edit denied with a Deterministic Planning Lock error?"**:
  You attempted to edit a project source file while a plan is pending review or was rejected with feedback. You must address the reviewer's feedback in the plan file and obtain approval before editing project source files.
- **"How does the user unlock manually?"**:
  If a session gets orphaned, running `plannotator unlock` in the terminal clears all active workspace locks.
- **"Where are settings and snapshots stored?"**:
  - Configuration: `~/.plannotator/config.json` (or UI Settings ⚙️).
  - Approved plans & feedback archive: `~/.plannotator/plans/` and `~/.plannotator/feedback/`.
