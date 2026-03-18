Follow [@plannotator](https://x.com/plannotator) on X for updates

---

<details>
<summary><strong>Missed recent releases?</strong></summary>

| Release                                                                  | Highlights                                                                                                                                               |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
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

## What's New in v0.12.0

This is the community release. Ten of the fourteen PRs in v0.12.0 were authored by external contributors, spanning three major features and a sweep of cross-platform fixes. The annotation system gained preset labels for one-click feedback — no typing, just click and move on. The plan viewer now renders Graphviz diagrams alongside Mermaid, inline markdown images with a lightbox zoom, and renders all diagrams by default instead of showing raw source. And the entire UI works on mobile.

### Quick Annotation Labels

Reviewing a plan often means the same feedback applies to multiple sections — "clarify this," "verify this assumption," "match existing patterns." Quick Labels turn those into one-click preset chips that appear above the annotation toolbar. Select text, click a label, done. No typing required.

Ten default labels ship out of the box, each with an emoji and a color-coded pill:

> ❓ Clarify this · 🗺️ Missing overview · 🔍 Verify this · 🔬 Give me an example · 🧬 Match existing patterns · 🔄 Consider alternatives · 📉 Ensure no regression · 🚫 Out of scope · 🧪 Needs tests · 👍 Nice approach

Several labels carry agent-facing tips that get injected into the feedback. For example, selecting a section and clicking "🔍 Verify this" tells the agent: *"This seems like an assumption. Verify by reading the actual code before proceeding."* The "🧬 Match existing patterns" label instructs the agent to search the codebase for existing solutions rather than introducing a new approach. These tips are invisible to the reviewer but shape how the agent responds.

When the feedback is exported, labeled annotations are grouped into a Label Summary section at the bottom — `**🔍 Verify this**: 3` — so both the reviewer and the agent can see at a glance which patterns recur across the plan.

Labels are fully customizable in Settings. Add up to 12, reorder them, pick custom colors and tips, or remove the ones you never use. Settings persist across sessions via cookies.

A follow-up PR introduced a dedicated Quick Label editing mode alongside Markup, Comment, and Redline. In this mode, selecting text immediately shows a floating label picker — no toolbar intermediary. Alt+1 through Alt+0 keyboard shortcuts work in any mode for power users who prefer not to reach for the mouse.

- Authored by @grubmanItay in [#268](https://github.com/backnotprop/plannotator/pull/268) and [#272](https://github.com/backnotprop/plannotator/pull/272)

### Mobile Compatibility

Plannotator was desktop-only. That mattered less when the tool was purely a local dev workflow, but with shared URLs and team reviews becoming common, people were opening plan links on phones and tablets and getting a broken layout.

The UI now adapts fully below 768px. The header collapses into a hamburger menu. The annotation panel renders as a full-screen overlay with a backdrop and close button. Touch support covers resize handles, pinpoint annotations, text selection, and the toolstrip. Card action buttons are always visible on touch devices instead of appearing on hover. The Settings modal switches to a horizontal tab bar. The CommentPopover width is capped to the viewport so it doesn't overflow off-screen.

Desktop layout is completely unchanged — this is additive, not a redesign.

- Authored by @grubmanItay in [#260](https://github.com/backnotprop/plannotator/pull/260)

### Graphviz Diagram Rendering

Plannotator has supported Mermaid diagrams since v0.6.8. Plans that use Graphviz for architecture diagrams, dependency graphs, or state machines were stuck with raw DOT source in a code block. The Viewer now renders `graphviz`, `dot`, and `gv` fenced code blocks using `@viz-js/viz`, with the same UX conventions as Mermaid: source/diagram toggle, zoom and pan controls, and an expanded fullscreen view.

- Authored by @flex-yj-kim in [#266](https://github.com/backnotprop/plannotator/pull/266)

### Mermaid Diagram Improvements

The Mermaid viewer received a substantial UX overhaul. Diagrams now open in a proper expanded fullscreen mode with zoom in/out, fit-to-view, and wheel zoom. The source/diagram toggle was reworked for clarity. Wide diagrams no longer clip against container edges in both plan view and plan diff view. Safari stability issues with SVG rendering were resolved.

A separate PR changed both Mermaid and Graphviz diagrams to render by default instead of showing raw source code first — the source toggle is still one click away, but the visual rendering is now the default state.

- Authored by @flex-yj-kim in [#264](https://github.com/backnotprop/plannotator/pull/264) and [#279](https://github.com/backnotprop/plannotator/pull/279)
- Issue [#275](https://github.com/backnotprop/plannotator/issues/275) filed by @flex-yj-kim

### Markdown Image Rendering

Markdown `![alt](path)` syntax was silently treated as plain text — the `!` character wasn't in the inline scanner, so images never rendered. They do now. Local image paths are proxied through the existing `/api/image` endpoint, and relative paths resolve correctly when annotating files outside the project root.

Clicking any rendered image opens a full-screen lightbox with the alt text as a caption. Press Escape or click the backdrop to dismiss.

- Authored by @dgrissen2 in [#271](https://github.com/backnotprop/plannotator/pull/271)

### Linked Doc Navigation in Annotate Mode

The `/plannotator-annotate` command lets you annotate any markdown file, but clicking `.md` links inside that file would break — the annotate server was missing a `/api/doc` endpoint, so link requests returned raw HTML instead of JSON. This release adds the missing route and supports chained relative link navigation, so you can follow links between sibling markdown files without leaving annotate mode.

- Authored by @dgrissen2 in [#276](https://github.com/backnotprop/plannotator/pull/276)

### VS Code Extension in SSH Remote Sessions

The VS Code extension sets `PLANNOTATOR_BROWSER` to its own `open-in-vscode` handler so plans open in editor tabs instead of external browsers. In SSH remote sessions, the shared `openBrowser()` function skipped browser launch entirely — ignoring the custom handler. The fix is a one-line condition change: if `PLANNOTATOR_BROWSER` is set, always call `openBrowser()` regardless of remote detection. This covers plan review, code review, and annotate mode.

- Authored and reported by @7tg in [#274](https://github.com/backnotprop/plannotator/pull/274), closing [#259](https://github.com/backnotprop/plannotator/issues/259)

### Additional Changes

- **Windows markdown path support** — `plannotator annotate` now handles Windows drive-letter paths (`C:\...`, `C:/...`), Git Bash/MSYS paths (`/c/...`), and Cygwin paths (`/cygdrive/c/...`) in the shared markdown resolver ([#267](https://github.com/backnotprop/plannotator/pull/267) by @flex-yj-kim)
- **OS-aware update banner** — the update banner now detects the user's OS and shows the correct install command: bash/curl on macOS and Linux, PowerShell on Windows ([#270](https://github.com/backnotprop/plannotator/pull/270), reported by @eromoe in [#265](https://github.com/backnotprop/plannotator/issues/265))
- **Pi origin in code review** — the code review UI now recognizes Pi as a first-class origin with a violet badge, correct install command in the update banner, and proper agent name in the completion overlay ([#263](https://github.com/backnotprop/plannotator/pull/263))
- **Codex support** — documentation and install instructions for running Plannotator inside Codex, which uses the CLI directly without a plugin ([#261](https://github.com/backnotprop/plannotator/pull/261))
- **Welcome dialog cleanup** — removed three first-run dialogs (UI Features Setup, Plan Diff Marketing, What's New v0.11.0) that had outlived their usefulness. The only remaining first-open dialog is the Permission Mode Setup, which directly affects agent behavior ([#280](https://github.com/backnotprop/plannotator/pull/280))

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

- docs: add Codex support by @backnotprop in [#261](https://github.com/backnotprop/plannotator/pull/261)
- feat: add Pi origin support to code review UI by @backnotprop in [#263](https://github.com/backnotprop/plannotator/pull/263)
- feat: Improve Mermaid diagram viewing experience by @flex-yj-kim in [#264](https://github.com/backnotprop/plannotator/pull/264)
- feat: Add Graphviz diagram rendering in plan mode by @flex-yj-kim in [#266](https://github.com/backnotprop/plannotator/pull/266)
- fix: Support Windows markdown paths in CLI annotate flow by @flex-yj-kim in [#267](https://github.com/backnotprop/plannotator/pull/267)
- feat: add quick annotation labels for one-click preset feedback by @grubmanItay in [#268](https://github.com/backnotprop/plannotator/pull/268)
- fix: detect OS for update banner install command by @backnotprop in [#270](https://github.com/backnotprop/plannotator/pull/270)
- feat: render markdown images with lightbox zoom by @dgrissen2 in [#271](https://github.com/backnotprop/plannotator/pull/271)
- feat: add quick label selection mode for one-click annotations by @grubmanItay in [#272](https://github.com/backnotprop/plannotator/pull/272)
- fix: open browser in SSH remote when PLANNOTATOR_BROWSER is set by @7tg in [#274](https://github.com/backnotprop/plannotator/pull/274)
- fix: enable linked doc navigation in annotate mode by @dgrissen2 in [#276](https://github.com/backnotprop/plannotator/pull/276)
- feat: render diagrams by default in plan review by @flex-yj-kim in [#279](https://github.com/backnotprop/plannotator/pull/279)
- feat: add mobile compatibility by @grubmanItay in [#260](https://github.com/backnotprop/plannotator/pull/260)
- chore: remove non-critical welcome dialogs by @backnotprop in [#280](https://github.com/backnotprop/plannotator/pull/280)

## Contributors

@grubmanItay was a major contributor to this release with three PRs — Quick Annotation Labels, Quick Label Mode, and full mobile support. The labels system touched the annotation pipeline end-to-end: new UI components, settings persistence, keyboard shortcuts, export formatting, and share URL backward compatibility.

@flex-yj-kim continues as the project's most prolific external contributor. Four PRs in this release: Graphviz rendering, Mermaid viewer overhaul, render-by-default diagrams, and Windows path support. Across v0.9.3 through v0.12.0, Yeongjin has authored twelve merged PRs spanning both the plan and code review UIs.

@dgrissen2 shipped two PRs — markdown image rendering with the lightbox viewer and the annotate-mode linked doc navigation fix. Both address gaps where the viewer silently dropped content instead of rendering it.

@7tg authored the SSH remote fix for the VS Code extension, which he also reported in [#259](https://github.com/backnotprop/plannotator/issues/259) with a thorough diagnostic of the underlying IPC issue.

Community members who reported issues and participated in discussions that shaped this release:

- @eromoe — [#265](https://github.com/backnotprop/plannotator/issues/265) (OS detection for update banner install command)
- @grubmanItay — [#278](https://github.com/backnotprop/plannotator/discussions/278) (quick label defaults discussion)

**Full Changelog**: https://github.com/backnotprop/plannotator/compare/v0.11.4...v0.12.0
