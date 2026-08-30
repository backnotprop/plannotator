<p align="center">
  <img src=".github/assets/banner.webp" alt="Plannotator" width="640" />
</p>



<p align="center">
  <strong>Everything you need to annotate and stay in the loop with your agents</strong><br/>
  <strong>Markdown Review • Code Review • HTML Artifacts</strong><br/>
  <sub>Annotate plans, specs, markdown, and HTML before implementation. Review diffs and PRs. Send feedback to your agent.</sub>
</p>

<p align="center">
  <img src=".github/assets/icons/amp.svg" alt="Amp" title="Amp" height="28" />&nbsp;&nbsp;
  <img src=".github/assets/icons/claude.svg" alt="Claude Code" title="Claude Code" height="28" />&nbsp;&nbsp;
  <img src=".github/assets/icons/codex.png" alt="Codex" title="Codex" height="28" />&nbsp;&nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/icons/copilot-dark.svg" />
    <img src=".github/assets/icons/copilot-light.svg" alt="Copilot CLI" title="Copilot CLI" height="28" />
  </picture>&nbsp;&nbsp;
  <img src=".github/assets/icons/droid.png" alt="Droid" title="Droid" height="28" />&nbsp;&nbsp;
  <img src=".github/assets/icons/gemini.png" alt="Gemini CLI" title="Gemini CLI" height="28" />&nbsp;&nbsp;
  <img src=".github/assets/icons/kiro.svg" alt="Kiro" title="Kiro" height="28" />&nbsp;&nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/icons/opencode-dark.svg" />
    <img src=".github/assets/icons/opencode-light.svg" alt="OpenCode" title="OpenCode" height="28" />
  </picture>&nbsp;&nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/icons/pi-dark.svg" />
    <img src=".github/assets/icons/pi-light.svg" alt="Pi" title="Pi" height="28" />
  </picture>
</p>

<p align="center">
  <a href="https://www.youtube.com/watch?v=a_AT7cEN_9I">Watch the og demo</a> · <a href="https://docs.plannotator.ai/open-source/start/installation">Installation guide</a> · <a href="https://plannotator.ai/">Official site</a> · <a href="https://github.com/plannotator/effective-html">Visual HTML Skills</a> · <a href="#herdr-annotate-plannotator-in-the-terminal">Herdr Annotate</a>
</p>

# Plannotator

Plannotator is a local, browser-based review surface for AI coding agents: Claude Code, Codex, Copilot CLI, Gemini CLI, OpenCode, Kiro, Droid, Amp, and Pi. 

**It plugs directly into your agent** through its hooks and commands. When the agent proposes a plan, html, or finishes writing code, the work opens in your browser and you mark it up, comment, and send feedback directly to the agent for it to act on it.

<table>
<tr>
<td width="40%" valign="middle">

### Review documents, plans, and agent messages

Annotate plans, specs, messages, html, then send the feedback to your agent. 

<p><strong>Demo:</strong> <a href="https://youtu.be/XqFun9XCXPw">Plan review with Pi</a></p>

</td>
<td width="60%">

<img src=".github/assets/annotate.webp" alt="Annotate UI with inline annotations" width="100%" />

</td>
</tr>
<tr>
<td width="40%" valign="middle">

### Code Review

Review local changes or remote PRs. Comment on diffs, suggest code. Your comments go back to the agent. Works with Git, GitButler, Jujutsu (`jj`), Perforce (`p4`), GitHub, and GitLab.

</td>
<td width="60%">

<img src=".github/assets/review.webp" alt="Code review with file tree and side-by-side diff" width="100%" />

</td>
</tr>
</table>

<p align="center">
  <sub><strong>AI built in:</strong> ask AI about anything you're reviewing,<br/>or launch AI reviews that post comments to the diff.</sub>
</p>

## Annotate HTML Artifacts

<p align="center">
  <img src=".github/assets/html.webp" alt="Annotating a rendered HTML artifact" width="720" />
</p>

## Herdr Annotate: Plannotator in the Terminal

<p align="center">
  <a href="https://github.com/plannotator/herdr-annotate">
    <img src=".github/assets/herdr-annotate-banner.svg" alt="Herdr Annotate" width="300" align="middle" />
  </a>
  &nbsp;&nbsp;
  <img src=".github/assets/herdr-annotate.png" alt="Plannotator TUI annotating a markdown folder in the terminal" width="480" align="middle" />
</p>

[Herdr Annotate](https://github.com/plannotator/herdr-annotate) brings Plannotator-style review to the terminal: annotate terminal text, review whole Markdown documents and your coding agent's replies inside [Herdr](https://herdr.dev), and send the feedback straight back to the agent as its next message. Works with Claude Code, Codex, Pi, Copilot CLI, and Droid replies. Annotations are saved in the Plannotator data directory, so terminal reviews and app reviews compound.

```
herdr plugin install plannotator/herdr-annotate
```

Prefer it standalone? [Plannotator TUI](https://github.com/plannotator/plannotator-tui) powers the document review and runs without Herdr: `brew install plannotator/tap/plannotator-tui`.

---

## Commands

<sub>On Codex, swap the slash commands for `!plannotator …` (e.g. `!plannotator review`) or the `$plannotator-*` skills.</sub>

### Annotate

```
/plannotator-annotate README.md                  # Local markdown file
/plannotator-annotate src/                       # Browse and annotate files in a folder
/plannotator-annotate https://docs.rs/…          # Fetch and annotate any URL
/plannotator-annotate report.html --render-html  # Render HTML as-is instead of converting
/plannotator-last                                # Annotate the agent's last message
```

Need a realistic document to try? Copy the [product requirements document template and filled example](https://docs.plannotator.ai/templates/product-requirements-document) as Markdown.

### Code review

```
/plannotator-review                    # Review uncommitted changes
/plannotator-review <github-pr-url>    # Review a GitHub pull request
/plannotator-review <gitlab-mr-url>    # Review a GitLab merge request
plannotator review --gitbutler         # Review an active GitButler workspace
```

GitButler users can review the whole workspace, one stack, or one branch layer. See the [GitButler workflow guide](https://docs.plannotator.ai/open-source/workflows/gitbutler).

### Plan mode

No command needed. Plan mode is wired in through each harness's hooks. Any time your agent creates a plan, the markdown review surface opens for you.

### CLI

```
plannotator sessions                   # List active Plannotator sessions
plannotator sessions --open 1          # Reopen a session in the browser
plannotator archive                    # Browse saved plan decisions read-only
```

---

## Privacy and network behavior

Plannotator does not collect usage telemetry or analytics. Plans, diffs, annotations, drafts, history, and configuration stay local by default.

Each plan review, annotate, archive, share-portal, and code-review app surface checks GitHub for the latest Plannotator release when it loads. This sends no plan or review content and gives the Plannotator project owner no usage analytics, although GitHub receives an ordinary request. There is currently no opt-out setting. Local Git code review can also query the configured `origin` with `git ls-remote` to detect the default branch and a stale baseline; it does not send the local diff.

Content leaves the local workflow only when a network feature needs it:

- URL annotation fetches the requested site, through Jina Reader by default for public pages or directly when Jina is disabled or unavailable.
- GitHub and GitLab review uses your authenticated CLI and Git remote to retrieve PR or MR data.
- Ask AI and review agents send the selected question and relevant plan, document, repository, or diff context to your configured provider.
- Sharing sends the complete link to whoever or whatever service you use to deliver it. Encrypted short links upload ciphertext to the paste service.
- Workspaces is a separate hosted product, so the open source app's local-storage model does not apply to content placed there.

The [privacy policy](https://plannotator.ai/privacy) documents these boundaries and the hosted website and waitlist data.

---

## Link sharing

Open source asynchronous link sharing remains available for compatibility but is moving to deprecated support. Workspaces is the primary direction for team sharing. No removal date has been announced.

<p align="center">
  <a href="https://room.plannotator.ai/">
    <img src=".github/assets/sharing.png" alt="Sharing portal with upload options" width="720" />
  </a>
</p>

<p align="center">
  <sub>Legacy link-sharing demo: <a href="https://room.plannotator.ai/">room.plannotator.ai</a></sub>
</p>

<p align="center">
  <a href="https://plannotator.ai/workspaces">
    <img src=".github/assets/workspaces-cta.svg" alt="Workspaces is the team-sharing direction. Join the waitlist." height="44" />
  </a>
</p>

Share a plan with a teammate and they can annotate it themselves. Import their feedback and send it straight back to your agent.

**Small markdown shares** are compressed into the URL fragment. The fragment is not included in the browser's request to the share portal, but it is not encrypted. Anyone or any messaging service with the complete link can read the shared content. The portal host still receives ordinary request metadata.

**Large markdown and raw HTML shares** use a short-link service. The share payload is encrypted with AES-256-GCM before upload, the server stores only ciphertext, and the key is kept in the URL fragment rather than sent in the paste request. Anyone with the complete link can decrypt it. Hosted pastes expire after 7 days.

Same model as [PrivateBin](https://privatebin.info/). The paste service is [self-hostable](https://docs.plannotator.ai/open-source/workflows/sharing).

Sharing can be disabled entirely with `PLANNOTATOR_SHARE=disabled`.

[Workspaces](https://plannotator.ai/workspaces) is the primary path for hosted team collaboration.

---

## Install

One installer covers almost every agent. It installs the `plannotator` binary, auto-detects your installed agents, and configures hooks, skills, and slash commands for each:

```bash
# macOS / Linux / WSL
curl -fsSL https://plannotator.ai/install.sh | bash
```

```powershell
# Windows PowerShell
irm https://plannotator.ai/install.ps1 | iex
```

The installer downloads the binary from GitHub Releases. A full install can also contact GitHub for release resolution and agent files, Ataraxy-Labs/sem for the optional `sem` sidecar, and npm for Pi, selected extra skills, or the managed agent-terminal runtime. Pinning `--version` skips only GitHub API release resolution, not the release download. See the [privacy policy](https://plannotator.ai/privacy) for the complete network boundaries.

Want just the binary and nothing else? Pass `--minimal` (or export `PLANNOTATOR_MINIMAL=1`) to install only the `plannotator` binary to `~/.local/bin`, skipping every skill, hook, slash command, and per-agent config:

```bash
curl -fsSL https://plannotator.ai/install.sh | bash -s -- --minimal
```

Then finish the step for your agent:

| Agent | After the installer | Details |
|---|---|---|
| **Amp** | Copy [`plannotator.ts`](apps/amp-plugin/plannotator.ts) into `~/.config/amp/plugins/`, then `plugins: reload`. Workflows live in the command palette. | [README](apps/amp-plugin/README.md) |
| **Claude Code** | `/plugin marketplace add backnotprop/plannotator`, then `/plugin install plannotator@plannotator`. Restart Claude Code. | [README](apps/hook/README.md) |
| **Codex** | Nothing. Plan review is enabled automatically via Codex's experimental `Stop` hook (macOS/Linux/WSL; on native Windows, Codex hooks are experimental and the installer prints manual setup steps). `$plannotator-review`, `$plannotator-annotate`, and `$plannotator-last` skills included. | [README](apps/codex/README.md) |
| **Copilot CLI** | `/plugin marketplace add backnotprop/plannotator`, then `/plugin install plannotator-copilot@plannotator`. Restart. Plan review activates in plan mode (`Shift+Tab`). | [README](apps/copilot/README.md) |
| **Droid** | `droid plugin marketplace add https://github.com/backnotprop/plannotator`, then `droid plugin install plannotator@plannotator`. Commands only, no plan interception yet. | [README](apps/droid-plugin/README.md) |
| **Gemini CLI** | Nothing. The hook, policy, and slash commands are configured automatically. Requires Gemini CLI 0.36.0+. | [README](apps/gemini/README.md) |
| **Kiro CLI** | Nothing. Skills and an example agent are installed automatically. Try `kiro-cli chat --agent plannotator`. | [README](apps/kiro-cli/README.md) |
| **OpenCode** | Add `"plugin": ["@plannotator/opencode@latest"]` to `opencode.json`. Restart OpenCode. | [README](apps/opencode-plugin/README.md) |
| **Pi** | Skip the installer. Just `pi install npm:@plannotator/pi-extension`. Start Pi with `--plan`, or toggle with `/plannotator-plan-mode`. | [README](apps/pi-extension/README.md) |

Full walkthroughs live in the [installation docs](https://docs.plannotator.ai/open-source/start/installation).

### Uninstall

The safe default removes recognized Plannotator-installed components and keeps
your local plans, history, drafts, guides, and settings:

```bash
plannotator uninstall
```

Use `--purge` for a full removal of known local Plannotator data as well:

```bash
plannotator uninstall --purge
```

Purge requires typing `purge` at the prompt and explains that the data is
local-only: it is not stored on a Plannotator server and cannot be recovered.
For automation, pass `--yes` (or `-y`); non-interactive removal refuses to run
without it. Use `--dry-run` to preview recognized work without making changes.
Host integrations are always part of uninstall. If a broken or unavailable
host prevents safe cleanup, the command names the blocking plugin manager or
configuration, gives exact manual cleanup instructions, and stops before
deleting the binary. Complete that cleanup and rerun uninstall.
These mechanics keep the ordinary confirmation default-negative, make the
irreversible outcome require a stronger explicit word, and still give package
managers and scripts a conventional non-interactive flag.

The command covers the conventional macOS, Linux, WSL, and Windows binary
locations; the managed `sem` sidecar and agent-terminal runtime; installer
skills, commands, hooks, policies, caches, and recognizable Amp/Kiro files; and
detected Claude Code, Copilot CLI, Droid, Pi, and VS Code installations through
their host CLIs. Shared JSONC settings are edited surgically, while strict JSON
updates preserve the file's indentation, line endings, and trailing-newline
style. Custom
or unrecognized files, separately installed optional skills, project-local
integrations, external plan-save locations, and invalid configs are preserved
(malformed host config is a fail-safe error). If cleanup reports an error,
the CLI remains available for a safe retry, and its Windows PATH entry is
retained or restored when possible. If PATH restoration itself fails, the
output gives the full CLI path for retry and asks for manual PATH repair.
For safety, purge refuses filesystem roots, the home directory, the shared
temporary directory, symlinked data directories, and non-directory data paths.
Existing paths are compared by filesystem identity, so case aliases, symlinks,
hardlinks, and bind mounts cannot bypass the root/home/ancestor checks.
That identity and every containment guard are revalidated after awaited host
commands, immediately before the synchronous data-removal block; a replaced
data directory is refused without touching either the old or replacement data.
If your dedicated data directory is symlinked, point `PLANNOTATOR_DATA_DIR` at
its resolved target and retry.

If you installed only the standalone Pi extension and do not have the
`plannotator` CLI, use `pi remove npm:@plannotator/pi-extension`.

<details>
<summary>Claude Code: manual hook setup (without the plugin system)</summary>

Add to `~/.claude/settings.json`:

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

</details>

<details>
<summary>Pin a specific version</summary>

```bash
curl -fsSL https://plannotator.ai/install.sh | bash -s -- --version vX.Y.Z
```

```powershell
& ([scriptblock]::Create((irm https://plannotator.ai/install.ps1))) -Version vX.Y.Z
```

</details>

### Try it

The fastest way to see what Plannotator does is to invoke it yourself, right now, from your agent:

```
/plannotator-last                   # annotate the agent's last reply
/plannotator-review                 # review your current diff, PR-style
/plannotator-annotate report.html   # annotate any file, folder, or URL
```

(Slash commands in most agents; `$plannotator-*` skills in Codex, command palette in Amp.)

Plan review needs no command at all. The next time your agent proposes a plan, it opens in your browser automatically.

---

## How it works

### Plan review

```
Agent calls ExitPlanMode
  -> PermissionRequest hook fires
  -> Local server reads plan from hook input
  -> Browser opens with review UI
  -> You annotate and approve/deny
  -> Approve: agent proceeds
  -> Deny: structured feedback sent to agent
  -> Agent revises, plan diff shows what changed
```

### Code review

```
You run /plannotator-review
  -> git diff captures changes (or PR fetched by URL)
  -> Browser opens with diff viewer
  -> Annotate lines, stage/unstage files
  -> Send feedback: returned to agent session
  -> Approve: "LGTM" sent
```

---

## Integrations

**VS Code**: Open plans in editor tabs, view diffs inline, add annotations from the editor gutter. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=backnotprop.plannotator-webview).

**Obsidian**: Auto-save approved plans to a vault with YAML frontmatter, tags from the plan title, and backlinks for graph connectivity. Configure in Plannotator's Settings panel.

**Bear**: Save plans as Bear notes with nested tags and project metadata.

**GitHub / GitLab**: Pass any PR or MR URL to `/plannotator-review` and review it with the full diff viewer, annotations, and file tree.

---

## Remote / SSH / devcontainer

Plannotator auto-detects SSH sessions and switches to a fixed port. For explicit control:

```bash
export PLANNOTATOR_REMOTE=1
export PLANNOTATOR_PORT=9999  # forward this port
```

VS Code devcontainers forward the port automatically (check the Ports tab). For raw SSH, add to `~/.ssh/config`:

```
Host your-server
    LocalForward 9999 localhost:9999
```

---

## Security

Every released binary ships with a SHA256 sidecar. [SLSA provenance](https://slsa.dev/) attestations are available from v0.17.2. The current release workflow also attaches a CycloneDX JSON SBOM, evaluates it with a fresh Grype database before anything is attested or published, and creates a GitHub/Sigstore SBOM attestation for the shipped binaries and npm tarballs.

The SBOM is intentionally labeled as a release-wide Syft inventory of the monorepo's locked build inputs and dependencies. It is not an exact per-binary runtime inventory: Bun standalone executables do not expose their bundled JavaScript package metadata to Syft. The canonical [installation and verification docs](https://docs.plannotator.ai/open-source/start/installation#pin-or-verify-a-release) cover the existing installer path; the exact new SBOM commands are included below and must be copied to that Mintlify page before the first SBOM-enabled release.

The release gate rejects scanner-side ignored matches and treats unknown applicability conservatively as runtime when evaluating CISA KEV and fixable Critical findings. Its explicit Grype configuration, complete JSON results, database status, and repository policy decision remain available as workflow evidence.

To verify a released Linux x64 binary, its existing provenance, and the new SBOM evidence directly:

```bash
tag=vX.Y.Z
version="${tag#v}"
mkdir -p /tmp/plannotator-release-verify
gh release download "$tag" --repo backnotprop/plannotator \
  --pattern 'plannotator-linux-x64*' \
  --pattern "plannotator-${version}-release-sbom.cdx.json*" \
  --dir /tmp/plannotator-release-verify

(cd /tmp/plannotator-release-verify && sha256sum --check plannotator-linux-x64.sha256)
(cd /tmp/plannotator-release-verify && sha256sum --check "plannotator-${version}-release-sbom.cdx.json.sha256")

gh attestation verify /tmp/plannotator-release-verify/plannotator-linux-x64 \
  --repo backnotprop/plannotator --source-ref "refs/tags/$tag" \
  --signer-workflow backnotprop/plannotator/.github/workflows/release.yml \
  --predicate-type https://slsa.dev/provenance/v1

gh attestation verify /tmp/plannotator-release-verify/plannotator-linux-x64 \
  --repo backnotprop/plannotator --source-ref "refs/tags/$tag" \
  --signer-workflow backnotprop/plannotator/.github/workflows/release.yml \
  --predicate-type https://cyclonedx.org/bom
```

These are separate claims over the same artifact digest: provenance identifies its builder/source/workflow, while the CycloneDX predicate describes the release-wide inventory. The release runbook also canonicalizes the downloaded SBOM and attested predicate with `jq -S` and compares them.

To verify on install:

```bash
curl -fsSL https://plannotator.ai/install.sh | bash -s -- --verify-attestation
```

Requires the `gh` CLI, but no login: the installer fetches the attestation bundle from GitHub's public attestations API and verifies it with `gh attestation verify --bundle` (the extraction needs node, python3, or jq on PATH; gh's authenticated fetch is the fallback). Can also be set persistently in `~/.plannotator/config.json`:

```json
{ "verifyAttestation": true }
```

Installer verification remains opt-in and verifies SLSA build provenance; normal installation does not require `gh`. See the [canonical installation docs](https://docs.plannotator.ai/open-source/start/installation#pin-or-verify-a-release) for details.

---

## Configuration

Settings are saved in cookies (not localStorage) because each hook invocation runs on a random port. You can also set options through environment variables or `~/.plannotator/config.json`.

### Optional Vim controls

Plan and annotate views offer a default-off **Vim controls** profile under
**Settings → Vim**. Once enabled, focus the document and use `j` / `k`
to move one rendered block at a time. After `l` refines into a semantic level,
`j` / `k` move among sibling rows, cells, or inline targets; `h` moves back to
the containing target. Refining past the deepest target enters text. `v`
starts characterwise Visual selection and
`V` selects whole blocks. `Space` opens the normal annotation toolbar; `c`,
`d`, `m`, and `t` select comment, redline, markup, and label actions. The same
semantic target graph drives pointer Pinpoint and keyboard navigation. Press
`?` in the document for the contextual key reference. Inputs, dialogs,
editors, `Tab`, and all pointer interactions retain their native behavior.
The document takes focus automatically when the page is otherwise neutral;
press `Escape` from app chrome to return to it without clicking.
An additional default-off **Vim HUD** toggle appears beneath Vim controls. It
uses the product-demo styling for the live target reticle and navigation
context. Its bottom-right **Key panel** is independently hideable while the
reticle remains active; `?` still opens the complete key map on demand. The
panel shows recent handled keys, the current block/line/word/Visual phase, and
the command meaning without capturing text typed into comments or other
controls.
See [Vim controls](docs/vim-controls.md) for the interaction contract and
implementation architecture.

| Variable | Description |
|---|---|
| `PLANNOTATOR_REMOTE` | `1`/`true` for remote mode, `0`/`false` for local, unset for SSH auto-detection |
| `PLANNOTATOR_PORT` | Fixed port (default: random locally, `19432` remote) |
| `PLANNOTATOR_BROWSER` | Custom browser to open plans in |
| `PLANNOTATOR_AI` | `disabled` to disable Ask AI, Review Agents, and Guided Review; the annotate agent terminal is separate |
| `PLANNOTATOR_SHARE` | `disabled` to turn off URL sharing |
| `PLANNOTATOR_SHARE_URL` | Custom base URL for share links (self-hosted portal) |
| `PLANNOTATOR_PASTE_URL` | Base URL of the paste service API |
| `PLANNOTATOR_ORIGIN` | Override agent detection: `claude-code`, `amp`, `droid`, `opencode`, `codex`, `copilot-cli`, `gemini-cli`, `kiro-cli`, `pi` |
| `PLANNOTATOR_JINA` | `0`/`false` to disable Jina Reader for URL annotation |
| `JINA_API_KEY` | Jina Reader API key for higher rate limits |
| `PLANNOTATOR_DATA_DIR` | Base directory for Plannotator-managed files (plans, history, drafts, `config.json`). Default: `~/.plannotator`; if that directory doesn't exist and `$XDG_DATA_HOME` is set to an absolute path, `$XDG_DATA_HOME/plannotator` is used instead |

Plannotator-managed files live under `~/.plannotator` by default. Some UI preferences are stored in functional browser cookies. To relocate the files (for example, for an XDG-clean home):

```bash
export PLANNOTATOR_DATA_DIR=~/.local/share/plannotator
```

---

## Development

```bash
bun install

bun run dev:hook       # Plan review server
bun run dev:review     # Code review editor
bun run dev:marketing  # Marketing site (plannotator.ai)
bun run dev:vscode     # VS Code extension (watch mode)
```

### Build

```bash
bun run build          # Main targets (hook + opencode)
bun run build:hook     # Single-file HTML for the hook server
bun run build:review   # Code review editor
bun run build:opencode # OpenCode plugin
bun run build:vscode   # VS Code extension
```

Build order matters. The hook build copies pre-built HTML from `apps/review/dist/`. If you change UI code in `packages/ui/`, `packages/editor/`, or `packages/review-editor/`, rebuild the review app first:

```bash
bun run --cwd apps/review build && bun run build:hook
```

Test the plugin locally:

```bash
claude --plugin-dir ./apps/hook
```

Full binary build:

```bash
bun run --cwd apps/review build && bun run build:hook && \
  bun build apps/hook/server/index.ts --compile --outfile ~/.local/bin/plannotator
```


---

## License

Copyright 2025-2026 backnotprop

Dual-licensed under [Apache 2.0](LICENSE-APACHE) or [MIT](LICENSE-MIT) at your option.

Contributions are dual-licensed under the same terms unless you explicitly state otherwise.
