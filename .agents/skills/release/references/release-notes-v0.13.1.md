Follow [@plannotator](https://x.com/plannotator) on X for updates

---

<details>
<summary><strong>Missed recent releases?</strong></summary>

| Release                                                                  | Highlights                                                                                                                                               |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [v0.13.0](https://github.com/backnotprop/plannotator/releases/tag/v0.13.0) | Built-in themes, annotatable plan diffs, file-scoped code review comments, Octarine integration, unified review core, Pi remote sessions                 |
| [v0.12.0](https://github.com/backnotprop/plannotator/releases/tag/v0.12.0) | Quick annotation labels, mobile compatibility, Graphviz rendering, markdown images with lightbox, linked doc navigation in annotate mode                 |
| [v0.11.4](https://github.com/backnotprop/plannotator/releases/tag/v0.11.4) | Git add from code review, bidirectional scroll navigation, clipboard paste for annotation images, VS Code IPC port stability                             |
| [v0.11.3](https://github.com/backnotprop/plannotator/releases/tag/v0.11.3) | Expandable diff context, hierarchical folder tree, redesigned worktree controls, supply chain hardening                                                   |
| [v0.11.2](https://github.com/backnotprop/plannotator/releases/tag/v0.11.2) | Git worktree support in code review, VS Code editor annotations in review, Obsidian auto-save & separator settings, session discovery, smart file resolution |
| [v0.11.1](https://github.com/backnotprop/plannotator/releases/tag/v0.11.1) | VS Code extension for in-editor plan review, Pinpoint mode for point-and-click annotations, untracked files in code review                              |
| [v0.11.0](https://github.com/backnotprop/plannotator/releases/tag/v0.11.0) | Auto-save annotation drafts, comment popover, Obsidian vault browser, deny message framing fix, configurable OpenCode timeout                           |
| [v0.10.0](https://github.com/backnotprop/plannotator/releases/tag/v0.10.0) | Short URL sharing with E2E encryption, code suggestions in review UI, CJK input method support, customizable Obsidian filenames, XDG install fix       |
| [v0.9.3](https://github.com/backnotprop/plannotator/releases/tag/v0.9.3) | Linked document navigation & annotation, VS Code diff integration, toolbar dismiss fix, automated npm publishing                                         |
| [v0.9.0](https://github.com/backnotprop/plannotator/releases/tag/v0.9.0) | Plan Diff with two view modes, version history, sidebar redesign, terminology cleanup                                                                    |
| [v0.8.5](https://github.com/backnotprop/plannotator/releases/tag/v0.8.5) | Pi coding agent support, auto-close countdown, image endpoint security fix, OpenCode package fix                                                         |
| [v0.8.0](https://github.com/backnotprop/plannotator/releases/tag/v0.8.0) | Open source (MIT/Apache-2.0), annotate command, self-hosted share portal, resizable panels, mermaid controls, auto-close on approval, documentation site |

</details>

---

## What's New in v0.13.1

v0.13.1 rewrites how Plannotator works with OpenCode's plan mode. The plugin now intercepts plan mode, injects its own planning workflow, and gives OpenCode users the same interactive browser-based review that Claude Code and Pi users already have. This release also fixes an Obsidian save failure on certain Bun versions.

### OpenCode Plan Mode Rewrite

Previous versions of the OpenCode plugin had a fragile plan mode integration. Long plans caused JSON parse errors because the entire plan was passed as a tool call string argument. The agent wrote to a custom directory that OpenCode's permission system blocked. The browser review UI often failed to open. There was no support for the agent asking clarifying questions during planning.

This release replaces all of that with file-based plan storage. The agent writes its plan to a markdown file on disk, then calls `submit_plan` with the file path. Plans live in `~/.local/share/opencode/plans/`, which is the XDG data path that OpenCode's permission system already allows. The agent picks the filename, and on feedback it revises the same file and resubmits. No content is lost between rounds.

The planning prompt now follows an exploration-first workflow: Explore the codebase, ask clarifying questions, write the plan, submit for review. Previously, agents would jump straight into writing a plan before understanding the code. For greenfield tasks where there is no codebase to explore, the agent skips to questions. The prompt is tool-neutral and avoids referencing specific tool names like `write` or `edit`, so it works with GPT models that use `apply_patch`.

Under the hood, the plugin strips OpenCode's native "STRICTLY FORBIDDEN: ANY file edits" directive from the system prompt and replaces it with Plannotator's own scoped rules, which allow the agent to create and edit plan files while still preventing codebase modifications. The `submit_plan` tool is hidden from subagents by default; users running custom subagent workflows like Superpowers or OhMyOpenCode can set `PLANNOTATOR_ALLOW_SUBAGENTS=1` to make it visible.

Shared checklist utilities were extracted to `@plannotator/shared` for cross-plugin reuse of plan execution tracking.

- [#318](https://github.com/backnotprop/plannotator/pull/318), closing [#63](https://github.com/backnotprop/plannotator/issues/63) (file-based plans, requested by @DanielusG), [#129](https://github.com/backnotprop/plannotator/issues/129) (JSON parse error, reported by @5trongHust), [#152](https://github.com/backnotprop/plannotator/issues/152) (question support, requested by @fidelix), [#183](https://github.com/backnotprop/plannotator/issues/183) (browser not opening, reported by @eromoe), and [#289](https://github.com/backnotprop/plannotator/issues/289) (subagent access, reported by @sfpmld)

### Obsidian Save Fix

Bun versions 1.1.43 through 1.1.45 introduced a regression where `mkdirSync({ recursive: true })` throws `EEXIST` when the directory already exists. This broke Obsidian saves on the second attempt. The fix adds an `existsSync` guard before the mkdir call. It's a no-op on unaffected Bun versions and prevents the save failure on affected ones.

- [#319](https://github.com/backnotprop/plannotator/pull/319), fixing [#315](https://github.com/backnotprop/plannotator/issues/315) reported by @Pollux12

---

## Install / Update

**macOS / Linux:**

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

**Windows:**

```powershell
irm https://plannotator.ai/install.ps1 | iex
```

**Claude Code Plugin:** Run `/plugin` in Claude Code, find **plannotator**, and click **"Update now"**.

**OpenCode:** Clear cache and restart:

```bash
rm -rf ~/.bun/install/cache/@plannotator
```

Then in `opencode.json`:

```json
{
  "plugin": ["@plannotator/opencode@latest"]
}
```

**Pi:** Install or update the extension:

```bash
pi install npm:@plannotator/pi-extension
```

---

## What's Changed

- feat: Pi-style iterative planning for OpenCode plugin by @backnotprop in [#318](https://github.com/backnotprop/plannotator/pull/318)
- fix: guard Obsidian mkdir against Bun EEXIST regression by @backnotprop in [#319](https://github.com/backnotprop/plannotator/pull/319)

## Community

Five long-standing feature requests and bug reports drove this release:

- @DanielusG requested file-based plans in [#63](https://github.com/backnotprop/plannotator/issues/63), the oldest open issue on the tracker
- @5trongHust reported the JSON parse error on long plans in [#129](https://github.com/backnotprop/plannotator/issues/129)
- @fidelix requested question/answer support during planning in [#152](https://github.com/backnotprop/plannotator/issues/152)
- @eromoe reported the browser not opening after plan mode in [#183](https://github.com/backnotprop/plannotator/issues/183)
- @sfpmld reported subagent access to `submit_plan` in [#289](https://github.com/backnotprop/plannotator/issues/289)
- @Pollux12 reported the Obsidian save failure in [#315](https://github.com/backnotprop/plannotator/issues/315)

**Full Changelog**: https://github.com/backnotprop/plannotator/compare/v0.13.0...v0.13.1
