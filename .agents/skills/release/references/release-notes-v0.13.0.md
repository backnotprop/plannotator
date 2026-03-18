Follow [@plannotator](https://x.com/plannotator) on X for updates

---

<details>
<summary><strong>Missed recent releases?</strong></summary>

| Release                                                                  | Highlights                                                                                                                                               |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
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

## What's New in v0.13.0

v0.13.0 brings built-in themes, annotatable plan diffs, file-scoped code review comments, and deeper platform parity for the Pi extension. Six of the fourteen PRs in this release came from external contributors, three of them first-time.

### Built-in Theme System

The UI now ships with eighteen built-in themes across dark, light, and system-adaptive modes, from high-contrast terminals to soft pastels. A theme grid in Settings lets you preview and switch instantly; your choice persists via cookies across sessions. Under the hood, all color tokens were consolidated into `packages/ui/theme.css` as CSS custom properties, which means the plan viewer, code review, and annotate UIs all share a single source of truth for color.

- [#294](https://github.com/backnotprop/plannotator/pull/294)

### Annotatable Plan Diffs

Plan diff view (the comparison that appears when a coding agent resubmits after a denial) now supports annotations directly on diff content. Hover over an added, removed, or modified section and the annotation toolbar appears. Each annotation carries a `diffContext` field (`added`, `removed`, `modified`) that is included in the exported feedback, so the agent knows exactly which part of the diff your comment targets. This was a major refactor: the annotation highlighting infrastructure was extracted into a shared `useAnnotationHighlighter` hook, and the diff view uses its own block-level hover system rather than web-highlighter.

### File-Scoped Comments in Code Review

The `/plannotator-review` UI now supports file-level comments in addition to line-level annotations. Each file header has a comment composer that lets you leave feedback about the file as a whole. These comments appear in the Review Panel alongside line annotations and are included in the exported feedback. Useful for high-level observations like "this file should be split" or "the approach here needs rethinking" that don't attach to any specific line.

- Authored by @sercantor in [#303](https://github.com/backnotprop/plannotator/pull/303), closing [#302](https://github.com/backnotprop/plannotator/issues/302)

### Octarine Notes Integration

Octarine joins Obsidian and Bear as a third notes app integration. Plan snapshots can be saved directly to Octarine on approval or denial. All three integrations now support an auto-save toggle. Enable it once in Settings and every plan decision writes to your notes app without prompting. Under the hood, all integration saves run in parallel with `Promise.allSettled`, so a slow or failing integration doesn't block the others.

- [#297](https://github.com/backnotprop/plannotator/pull/297)

### Pi Extension: Remote Session Support

The Pi extension now detects SSH and devcontainer environments the same way the Claude Code hook does, using `PLANNOTATOR_REMOTE`, `SSH_TTY`, and `SSH_CONNECTION`. In remote sessions, it uses a fixed port and returns the URL for manual browser opening instead of trying to launch one. This brings Pi to full parity with Claude Code and OpenCode for remote development workflows.

- Authored by @fink-andreas in [#299](https://github.com/backnotprop/plannotator/pull/299)

### Unified Review Core (Bun + Pi)

The review server had two implementations: one in the Bun-compiled hook, one in the Pi extension. They drifted apart over time, causing bugs like missing untracked file support in Pi. This release extracts a runtime-agnostic review core that both platforms consume. Diff assembly, file content retrieval, worktree handling, and stage/unstage all live in one place now. Regression tests cover the shared surface.

- [#310](https://github.com/backnotprop/plannotator/pull/310), closing [#307](https://github.com/backnotprop/plannotator/issues/307) reported by @0xbentang

### Shared Feedback Templates

The deny feedback message that gets sent back to the agent was inconsistent across plan review, code review, and annotate mode. Each had its own phrasing and structure. This release unifies them into shared templates. It also adds an instruction to preserve the plan's `# Title` heading on resubmission, which fixes a version history issue where title changes would break slug-based plan grouping.

- [#298](https://github.com/backnotprop/plannotator/pull/298), addressing [#296](https://github.com/backnotprop/plannotator/issues/296) reported by @MarceloPrado

### Configurable Bear Tags

Bear integration previously hardcoded the tag. You can now set custom tags and choose whether tags are prepended or appended to the note body. This PR also fixes a double-title bug where both the URL parameter title and the H1 in the note body were rendering.

- Authored by @MarceloPrado in [#283](https://github.com/backnotprop/plannotator/pull/283)

### Additional Changes

- **Favicon.** All three server modes (plan review, code review, annotate) now serve an SVG favicon: purple rounded square with a white "P" and gold highlight stripe ([#312](https://github.com/backnotprop/plannotator/pull/312) by @dgrissen2, idea from [Discussion #269](https://github.com/backnotprop/plannotator/discussions/269))
- **LGTM approval fix.** Approving in code review no longer tells the agent to "address all feedback." If you clicked LGTM, there is no feedback to address ([#293](https://github.com/backnotprop/plannotator/pull/293), reported by @tobeycodes in [#284](https://github.com/backnotprop/plannotator/issues/284))
- **Non-blocking browser launch (Pi/Linux).** `execSync(xdg-open)` blocked the Pi extension's event loop on Linux. Replaced with detached `spawn().unref()` ([#292](https://github.com/backnotprop/plannotator/pull/292), reported by @dvic in [#288](https://github.com/backnotprop/plannotator/issues/288))
- **Mobile context menu fix.** Suppresses the native iOS Safari callout and Android Chrome context menu during text selection so the annotation toolbar isn't obscured ([#281](https://github.com/backnotprop/plannotator/pull/281) by @grubmanItay)
- **Tater sprite z-index fix.** The tater mascot was rendering in front of the plan document due to a stacking context created by the mobile compat PR. Fixed ([#308](https://github.com/backnotprop/plannotator/pull/308))
- **review-renovate skill.** New agent skill at `.agents/skills/review-renovate/` for automated supply chain review of Renovate dependency PRs ([#306](https://github.com/backnotprop/plannotator/pull/306))

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

- fix: suppress native mobile context menu on text selection by @grubmanItay in [#281](https://github.com/backnotprop/plannotator/pull/281)
- feat: configurable Bear tags + fix double-title bug by @MarceloPrado in [#283](https://github.com/backnotprop/plannotator/pull/283)
- fix: non-blocking browser launch in Pi extension (Linux) by @backnotprop in [#292](https://github.com/backnotprop/plannotator/pull/292)
- fix: don't ask agent to address feedback on LGTM approval by @backnotprop in [#293](https://github.com/backnotprop/plannotator/pull/293)
- feat: built-in theme system with 18 themes by @backnotprop in [#294](https://github.com/backnotprop/plannotator/pull/294)
- feat: Octarine notes integration + auto-save for all integrations by @backnotprop in [#297](https://github.com/backnotprop/plannotator/pull/297)
- refactor: shared feedback templates + preserve plan title on deny by @backnotprop in [#298](https://github.com/backnotprop/plannotator/pull/298)
- feat(pi-extension): add remote session support for SSH/devcontainer by @fink-andreas in [#299](https://github.com/backnotprop/plannotator/pull/299)
- feat: add file-scoped comments to /plannotator-review by @sercantor in [#303](https://github.com/backnotprop/plannotator/pull/303)
- chore(deps): update github actions by @renovate in [#305](https://github.com/backnotprop/plannotator/pull/305)
- feat: add review-renovate agent skill for CI dependency audits by @backnotprop in [#306](https://github.com/backnotprop/plannotator/pull/306)
- fix: tater sprite z-index regression from mobile compat PR by @backnotprop in [#308](https://github.com/backnotprop/plannotator/pull/308)
- Unify review core across Bun and Pi by @backnotprop in [#310](https://github.com/backnotprop/plannotator/pull/310)
- feat: add favicon (Purple P + gold highlight) by @dgrissen2 in [#312](https://github.com/backnotprop/plannotator/pull/312)

## New Contributors

- @MarceloPrado made their first contribution in [#283](https://github.com/backnotprop/plannotator/pull/283)
- @fink-andreas made their first contribution in [#299](https://github.com/backnotprop/plannotator/pull/299)
- @sercantor made their first contribution in [#303](https://github.com/backnotprop/plannotator/pull/303)

## Contributors

@sercantor authored file-scoped comments for code review ([#303](https://github.com/backnotprop/plannotator/pull/303)), a feature he also requested in [#302](https://github.com/backnotprop/plannotator/issues/302). First contribution to the project.

@fink-andreas brought remote session support to the Pi extension ([#299](https://github.com/backnotprop/plannotator/pull/299)), also a first contribution.

@MarceloPrado authored configurable Bear tags ([#283](https://github.com/backnotprop/plannotator/pull/283)) and reported the version history title issue ([#296](https://github.com/backnotprop/plannotator/issues/296)) that led to the shared feedback template refactor. First contribution.

@grubmanItay continues contributing with the mobile context menu fix ([#281](https://github.com/backnotprop/plannotator/pull/281)), a follow-up to the mobile compat work shipped in v0.12.0.

@dgrissen2 added the favicon across all server modes ([#312](https://github.com/backnotprop/plannotator/pull/312)), sparked by [Discussion #269](https://github.com/backnotprop/plannotator/discussions/269).

Community members who reported issues that drove changes in this release:

- @0xbentang: [#307](https://github.com/backnotprop/plannotator/issues/307) (missing untracked files in Pi review)
- @tobeycodes: [#284](https://github.com/backnotprop/plannotator/issues/284) (LGTM approval still asking agent to address feedback)
- @dvic: [#288](https://github.com/backnotprop/plannotator/issues/288) (Pi extension blocking on Linux browser launch)
- @MarceloPrado: [#296](https://github.com/backnotprop/plannotator/issues/296) (version history title preservation)
- @sercantor: [#302](https://github.com/backnotprop/plannotator/issues/302) (file-scoped comments request)

**Full Changelog**: https://github.com/backnotprop/plannotator/compare/v0.12.0...v0.13.0
