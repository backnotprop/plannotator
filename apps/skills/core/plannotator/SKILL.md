---
name: plannotator
description: "Reference for using the Plannotator CLI: plan review, code review, annotating files, URLs, folders, and running local apps, annotating the last assistant message, browsing archived plan decisions, and exporting or sharing Guided Reviews. Invoke when asked to use Plannotator for anything not covered by a more specific plannotator-* skill."
---

# Plannotator CLI Reference

Plannotator is a local, browser-based review layer for agent workflows: it opens plans, diffs, and documents in an annotation UI, the human marks them up, and the structured feedback comes back to you on stdout. It installs as a single `plannotator` binary plus per-host hooks, so plan review fires automatically when you exit plan mode; every other surface is launched explicitly from the CLI. A session runs on a random localhost port (fixed port 19432 in remote mode) and blocks until the reviewer submits feedback, approves, or closes the tab.

This skill is the knowledge layer. The `plannotator-review`, `plannotator-annotate`, and `plannotator-last` skills are thin launchers for the three most common actions; use this reference when you need to pick the right command or flags yourself.

## Choose the command

| The user wants | Run |
| --- | --- |
| Review a plan you produced | Nothing. Plan review opens automatically on plan exit via hooks. Never run bare `plannotator` yourself. |
| Review and explicitly approve a plan/spec saved as a file | `plannotator annotate <file> --gate --json` |
| Review current code changes | `plannotator review` |
| Review a GitHub PR or GitLab MR | `plannotator review <PR_URL>` |
| Annotate a markdown, text, config, or HTML file | `plannotator annotate <file>` |
| Annotate a web page | `plannotator annotate <https-url>` |
| Annotate a running local app (dev server) | `plannotator annotate <http://localhost:PORT/>` |
| Pick a file to annotate from a folder | `plannotator annotate <folder/>` |
| Annotate your latest assistant message | `plannotator last` |
| Browse past plan decisions | `plannotator archive` |
| Export or share a Guided Review | `plannotator guide export` / `plannotator guide share` |
| Reopen or list live sessions | `plannotator sessions` |

## Session model

Every review or annotate command starts a local web server, opens the browser, and blocks until the human decides. That can take minutes. Launch it with a long (or no) command timeout, or in the background, then read stdout when the process exits. Do not kill the process to "finish" a review; a session that ends without a decision reads as no feedback.

The stdout contract is the whole interface:

- Plaintext (default): empty output on close, `The user approved.` on approve, otherwise the feedback text. Address returned feedback in the same conversation.
- `--json`: one JSON record, `{"decision":"approved"|"dismissed"|"annotated","feedback":"..."}`. An approval may still carry notes in `feedback`; treat those as guidance, not a change request.
- `--hook`: hook-native output for real PostToolUse/Stop hook contexts only. Approve/close emits nothing (hook passes); annotations emit `{"decision":"block","reason":"..."}`. `--hook` implies the gate UI. Never use it for a normal interactive invocation.

`plannotator <command> --help` prints usage without launching anything. Bare `plannotator` is the hook entry point and expects hook JSON on stdin.

## plannotator review

```bash
plannotator review [--git | --gitbutler] [--local | --no-local] [--tailscale] [PR_URL]
```

Reviews local VCS changes, or a pull request when a URL is given. Feedback and annotations come back on stdout when the reviewer submits; an approval comes back as an LGTM-style message.

- VCS is auto-detected (JJ, GitButler, Git, and P4 where supported). `--git` forces plain Git; `--gitbutler` forces GitButler (requires the `but` CLI 0.21.0+). Running from a non-VCS parent folder that contains nested repos produces a combined workspace diff.
- The default diff is "everything a PR would show now": merge-base of the trunk vs the working tree plus untracked files. The reviewer can switch diff types in the UI; you do not control that from the CLI.
- PR review (`plannotator review https://github.com/owner/repo/pull/123`, GitLab MR URLs too) needs an authenticated `gh` or `glab` CLI. `--local` (the default) builds a local checkout of the PR head in the background for full file access; `--no-local` skips it and reviews the platform diff only.
- `--tailscale` publishes the loopback session over the user's tailnet via `tailscale serve` (HTTPS, never public) and prints the URL with a QR code. A publish failure exits nonzero instead of leaving the server hanging.

## plannotator annotate

```bash
plannotator annotate <target> [--markdown] [--no-jina] [--app | --static] [--render-html] [--tailscale] [--gate] [--json] [--hook]
```

Opens one document, page, or app in the annotation UI and returns the human's annotations on stdout.

Plain `annotate` is feedback-only: it shows **Close** but no **Approve** button. When the user asks to review, approve, accept, or gate a generated plan/spec/document saved as a file, always add `--gate --json`. Do not tell the user they can approve a plain `annotate` session. If the plan is being handed off through the host agent's native plan flow, do not launch `annotate`; let the plan-exit hook open the approval UI automatically.

Targets:

- Markdown and text files: `.md`, `.mdx`, `.txt`.
- Plain-text config and data files, rendered as text: `.yaml`, `.yml`, `.json`, `.jsonc`, `.json5`, `.toml`, `.ini`, `.cfg`, `.conf`, `.properties`, `.csv`, `.tsv`, `.log`, `.xml`, `.env.example`. `.env` itself is deliberately refused (it commonly holds secrets, and annotate history copies file contents). Source-code files belong to `plannotator review`, not annotate.
- HTML files (`.html`, `.htm`): rendered as the raw page by default; `--markdown` converts to markdown instead. `--render-html` is accepted for compatibility; raw rendering is already the default.
- URLs (`https://...`): fetched and converted via Jina Reader by default; `--no-jina` uses plain fetch plus Turndown instead.
- Running local apps: a loopback `http://localhost:PORT/` URL whose probe returns HTML opens in live-app mode (annotate the real running page). `--app` forces live mode and fails loudly when it cannot apply; `--static` forces the classic conversion pipeline. Non-loopback URLs always use the conversion pipeline.
- Folders: `plannotator annotate docs/` opens a file browser over the folder's supported files.

Single files are capped at 2MB. Files are read from disk at stable project paths; keep the reviewed source where it lives.

Argument tolerance: extra words are fine (`plannotator annotate look at notes.md please` opens `notes.md`), but two resolvable targets is an error naming both, and an unrecognized dashed token disables the tolerance so flag typos fail loudly. When nothing resolves in a plain multi-word invocation, the CLI prints an agent-addressed handoff on stdout and exits 0: read it, work out the concrete target, and re-run with that exact path or URL.

### Strict gates and exit codes

For a machine-checkable approval gate, add `--gate --json` plus one or both strict flags:

```bash
plannotator annotate report.md --gate --json --require-approval --result-file /tmp/decision.json
```

- `--require-approval`: exit code reports the human outcome.
- `--result-file <path>`: the stdout decision JSON is also published atomically to `<path>`. The parent directory must exist and the file must not; results resolve from the invocation cwd.

Exit codes under a strict flag (grep convention):

| Exit | Meaning |
| --- | --- |
| 0 | Approved. The only success. |
| 1 | The reviewer did not approve (annotated or dismissed); the decision record was still published. |
| 2 | The gate itself failed: bad flag combination, startup failure (missing file, unreachable URL, oversized file), or the result file could not be published. Never treat as a reviewer outcome. |
| 128+n | Killed by signal n. |

Without strict flags, startup failures exit 1 and the exit code carries no decision; parse the output instead. Both strict flags require `--gate --json` and reject `--hook`.

## plannotator annotate-last

```bash
plannotator annotate-last [--stdin] [--tailscale] [--gate] [--json] [--hook]
plannotator last
```

Opens the latest rendered assistant message from the current agent session in the annotation UI (`last` is an alias). The session log is discovered per host automatically; `--stdin` reads the content from stdin instead.

Do not print a commentary or status message immediately before running it: the command targets the latest rendered assistant message, so a preamble becomes the thing being annotated.

## plannotator copilot-last

```bash
plannotator copilot-last [--gate] [--json] [--hook]
```

The annotate-last variant for live GitHub Copilot CLI sessions (reads Copilot's session-state events). Normally invoked by the Copilot plugin's /plannotator-last command; use it only inside a Copilot CLI session.

## plannotator archive

```bash
plannotator archive
```

Opens a read-only browser over saved plan decisions (approved/denied badges) from the Plannotator data directory. No feedback comes back; the session ends when the user clicks Done.

## plannotator guide

```bash
plannotator guide list
plannotator guide export --id <savedGuideId> [--out <file.html>]
plannotator guide export --guide <guide.json> --patch <diff.patch> [--out <file.html>]
plannotator guide export --snapshot <snapshot.json> [--out <file.html>]
plannotator guide share --id <savedGuideId> [--public] [--ttl <7d|24h|30m|3600>] [--json]
plannotator guide unshare <id> --token <deleteToken>
```

Guided Reviews are AI-generated walkthroughs of a diff, produced inside the code review UI. The CLI works with saved ones:

- `list` shows guides Plannotator has persisted for the current repo.
- `export` writes one portable, self-contained HTML file (the viewer loads from guides.show). `--guide` + `--patch` exports a guide you authored yourself against a unified diff (`--patch -` reads stdin; validation is strict and names any file the guide references that the patch lacks). `--out -` writes to stdout. `--viewer-url` overrides the pinned viewer base.
- `share` uploads the guide and prints a link. Encrypted by default: the key lives only in the URL fragment and the host stores ciphertext. `--public` stores it unencrypted so chat apps can unfurl a preview. `--ttl` sets an expiry; otherwise the link stays until `unshare`. A saved guide records its link, and a second `share --id` refuses rather than orphaning the first link's delete token.
- `unshare <id> --token <t>` removes a link using the delete token printed at share time.

## plannotator sessions

```bash
plannotator sessions [--open [N]] [--clean]
```

Lists active Plannotator server sessions. `--open` reopens session N (default 1) in the browser, useful when a tab was closed mid-review. `--clean` drops stale entries.

## Other subcommands

```bash
plannotator setup-goal <interview|facts> <bundle.json | -> [--json]
plannotator uninstall [--purge] [--yes] [--dry-run]
plannotator improve-context
```

- `setup-goal` opens the interview or facts-acceptance UI for /goal workflows; it is driven by the `plannotator-setup-goal` skill and takes a bundle JSON (`-` reads stdin). Do not hand-build bundles.
- `uninstall` removes Plannotator-installed components (`--purge` also deletes local data; `--yes` is required without a TTY; `--dry-run` previews).
- `improve-context` and `install-runtime` are internal integration commands (hook plumbing and managed runtime install). Never run `improve-context` directly; `plannotator install-runtime agent-terminal` exists for reinstalling the optional annotate-terminal runtime and is normally run by the installer.
- Additional host-internal subcommands (the `opencode-*` and `copilot-plan` family) are invoked by their plugins, not by you.

## Environment variables that change behavior

| Variable | Use |
| --- | --- |
| `PLANNOTATOR_REMOTE=1` | Force remote mode (fixed port 19432, wide bind) for SSH/devcontainer sessions; `0` forces local. Unset means SSH auto-detection. |
| `PLANNOTATOR_PORT` | Fix the port instead of a random one. |
| `PLANNOTATOR_ORIGIN` | Override agent-origin detection (`claude-code`, `codex`, `opencode`, `pi`, `oh-my-pi`, `amp`, `droid`, `copilot-cli`, `gemini-cli`, `kiro-cli`). Set it when launching Plannotator from a wrapper the detection cannot see through. |
| `PLANNOTATOR_AI=disabled` | Disable Ask AI and agent-launched review surfaces in the UI. |
| `PLANNOTATOR_SHARE=disabled` | Disable URL sharing, including guide share links. |
| `PLANNOTATOR_DATA_DIR` | Move the data directory (default `~/.plannotator`): plans, history, drafts, config. |
| `PLANNOTATOR_BROWSER` | Open sessions in a specific browser. |

## Posting annotations into a live session

A running plan-review session exposes a small HTTP API on its base URL for external annotations: `POST /api/external-annotations` adds inline annotations the reviewer sees immediately, with PATCH/DELETE for updates and an SSE stream at `/api/external-annotations/stream`. The UI's "copy agent instructions" action puts the full API contract for the current session, with the correct base URL, on the clipboard for handing to an agent or script. If the user pastes such instructions, follow them; do not invent endpoints beyond that contract.

## Do not

- Do not parse or scrape the browser UI's HTML; the CLI's stdout (and the documented HTTP API above) is the whole contract.
- Do not use `--hook` outside a real hook context; use `--json` when you need structured output.
- Do not run bare `plannotator` interactively; it is the hook entry point.
- Do not guess flags. Run `plannotator <command> --help` when unsure; unknown dashed tokens make annotate fail on purpose.
- Do not point `plannotator annotate` at source-code files or `.env` files; code goes through `plannotator review`, and `.env` is refused.
- Do not start a strict gate (`--require-approval`) unless a human is actually there to review; the session blocks until they act.
