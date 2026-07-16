# Annotate Agent Terminal Implementation

Status: implemented and verified locally

## Goal

Add an optional WebTUI-powered agent terminal to `plannotator annotate` for single-file and folder annotation. Keep it isolated from annotation export, Ask AI, code review agent jobs, plan review, archive, goal setup, and `annotate-last`.

## Decisions To Preserve

- No agent starts automatically.
- The user starts exactly one selected agent from a top-left `ReviewAgentsIcon` control.
- The terminal panel is separate from the file sidebar and appears to its left.
- The terminal launches in the original Plannotator launch cwd, not the annotated file/folder path unless they are the same.
- The terminal uses the same Plannotator origin and port.
- No second browser-facing PTY port. Bun uses a lazy loopback-only Node sidecar internally because WebTUI's PTY data path works correctly under Node.
- No arbitrary command box.
- No prompt injection, annotation sync, file-sidebar integration, multiple agents, background agent jobs, or terminal persistence in v1.

## Task Tracker

- [x] Add WebTUI as a local development dependency.
- [x] Add shared browser-safe terminal capability types.
- [x] Add Bun annotate same-origin WebSocket proxy, lazy Node sidecar PTY support, and `/api/plan` capability.
- [x] Add Pi/Node annotate WebSocket/PTY support and matching capability.
- [x] Pass original launch cwd into annotate server entrypoints.
- [x] Add annotate agent terminal settings helper.
- [x] Add separate annotate agent terminal panel.
- [x] Add top-left agent icon/toggle using `ReviewAgentsIcon`.
- [x] Wire start/stop/restart lifecycle with WebTUI.
- [x] Self-review server adapter for lifecycle, disabled fallback, and same-port behavior.
- [x] Self-review UI for state isolation and layout containment.
- [x] Verify focused tests, build, and manual annotate flows.

## Notes And Findings

- ADR: `adr/0002-add-webtui-agent-panel-for-annotate-mode.md`.
- WebTUI source: `/Users/ramos/oss/webtui`.
- WebTUI is consumed through `@plannotator/webtui`; local file dependencies should not be reintroduced.
- WebTUI exports from `dist`; rebuild WebTUI after changing it.
- Current runtime finding: WebTUI's `NodePtyBackend` under Bun can spawn a PTY but did not deliver `onData` output in local smoke tests. The same backend under Node delivered shell and Claude output correctly. This matches WebTUI's working examples, which run the PTY backend in Node.
- Bun uses `packages/server/agent-terminal.ts` as a same-origin browser WebSocket proxy. It starts `packages/server/agent-terminal-node-sidecar.mjs` lazily on first terminal WebSocket connection. No sidecar or PTY exists when annotate opens.
- The Node sidecar binds `127.0.0.1` on a random internal port, validates that only WebTUI built-in agents are launched, forces the configured Plannotator cwd, and exits if the Bun parent closes its stdin pipe.
- Pi/Node uses WebTUI's helper with a backend wrapper attached to the existing Node HTTP server.
- The UI panel is isolated in `packages/editor/components/AnnotateAgentTerminalPanel.tsx`.
- Stop behavior sends Ctrl-C, sends a second Ctrl-C after 350ms, then kills the PTY after 1400ms if needed. A real Codex smoke confirmed the fallback kill is what guarantees cleanup when the agent does not exit from interrupts quickly enough.
- Current verification for this commit: focused agent-terminal/theme tests, `bun run --cwd apps/hook build`, and a local browser smoke for annotate-folder.
- Earlier verification during implementation covered Bun same-port WebSocket behavior, Pi/Node same-port WebSocket behavior, real agent launch/kill cleanup, and headless Chrome layout smoke.

## Follow-Up Design Notes

### Theme

The agent terminal appearance is affected by three layers:

- Plannotator chrome: Tailwind/theme tokens such as `bg-card`, `border-border`, and `text-muted-foreground`.
- WebTUI/xterm: `terminalOptions.theme` and `terminalColorScheme`. The panel maps Plannotator themes to xterm palettes in `packages/editor/components/annotateAgentTerminalTheme.ts`.
- Terminal content: the user's shell prompt, CLI ANSI colors, and agent UI colors.

The theme map is intentionally curated. New Plannotator themes should either get an explicit terminal preset or fall back to a palette derived from the active CSS tokens.

### Agent Message Injection

WebTUI supports injecting messages after the terminal is ready:

- `sendAgentMessage({ text })` uses bracketed paste and submits the message. This is the right product API for "send this to the running agent."
- `write(data)` sends raw terminal input. This should stay internal unless there is a specific advanced use case.
- `pasteText(text)` can paste without necessarily submitting.

Plannotator does not expose an injection UI yet. The clean version would be a small "Send to agent" affordance wired to the `WebTuiTerminal` handle and disabled until `onReady` fires. Avoid exposing a raw terminal command box.

### File Tree And Editor Awareness

Current state:

- The annotate file tree does not live-watch disk changes.
- The file tree is fetched from `/api/reference/files` and refreshed only when the UI explicitly asks for it.
- Main now has source-backed direct editing. Plannotator knows about files it opens/saves through the editor and can mark tree rows dirty, saving, saved, conflict, or error.
- Plannotator detects save conflicts by hash/mtime when saving through `/api/source/save`.
- Plannotator does not proactively notice an agent changing a file on disk while the editor is open.

Recommended shape:

- Add a server-side watcher for annotate roots, ignoring the existing excluded directories. Debounce filesystem bursts and send compact "tree changed" events over SSE. The client should then refresh the tree snapshot; it should not try to mutate tree nodes directly from raw filesystem events.
- Add a separate git-based workspace changes surface. Use git as the truth for what changed: `git status --porcelain -z`, `git diff`, and untracked handling. Show changed files in the tree and open diffs lazily on demand.
- Keep attribution pragmatic. "Saved by Plannotator" is known from source-save records. "Changed since agent started" can be known by comparing a launch-time snapshot to current disk/git state. "Agent changed this" is not perfectly knowable unless every writer is instrumented.
- For the editor, if an open file changes on disk and the Plannotator buffer is clean, auto-refresh or show a subtle reload notice. If the buffer is dirty, show a conflict notice with a diff between the user buffer and disk, plus disk baseline versus new disk.

This keeps the feature reliable and fast: filesystem watchers only trigger invalidation, git provides the authoritative changed-file model, and expensive diffs are computed only when the user opens them.
