# Changelog

## [Unreleased]

## [0.17.0] - 2026-10-28

### Changed
- Guided Reviews: a guide is read in one tab, **Guide**, which is Plannotator's own guide reader (the one the web app and guides.show render) in VS Code's colors and fonts: the overview, then every chapter's text beside its files' diffs on one scrolling page, with a chapter strip at the top. Hovering a name in a diff shows the language server's hover and the definition (and the chapter that changes it); ⌘-click (Ctrl-click) or F12 goes to the definition, in the guide or in the real file beside; Shift+F12 lists the references. Each file has **Open in editor** and **Diff**.
- Guided Reviews: ask about selected lines in the Guide tab's diff (new lines or removed lines, sent as the diff shows them), or about a chapter in the box under its text. The answer tab opens beside at once and shows the agent's work; answers are marked on the lines they are about.

### Removed
- Guided Reviews: the chapter side view, reading a guide file by file in VS Code's diff editor, the CodeLens line on guide files and the comment-thread question box. The **Guided Reviews** side bar stays as the guide's outline; right-click **Ask the Agent About This…** stays in VS Code's own diff of a guide's file (a quick input now).

### Added
- **Guided Reviews.** An agent reads a pull request or your local changes and splits them into chapters, the core of the change first. You read the guide in one **Guide** tab: an overview with a diagram, then each chapter's explanation beside its files' diffs, on one scrolling page in your VS Code colors and fonts. Hover a name in a diff to see VS Code's own hover, where it is defined, and the chapter that changes it; ⌘-click (Ctrl-click) or F12 goes to the definition, Shift+F12 lists the references. Each file has **Open in editor** and **Diff**. Tick chapters and files as you go. The Guided Reviews dashboard opens from the activity bar and lists your repositories, local changes and pull requests (it works without a folder open); the side bar shows the open guide's outline. Guides are shared with Plannotator's web app and export as one HTML file.
- **Your agent, over ACP.** Claude Code, Codex, OpenCode, GitHub Copilot CLI, Cursor, Kiro and Kilo Code write guides, and any other ACP agent works through `plannotator.guides.customAgent`. Pi is listed but can't write guides yet (its ACP adapter does not pass the guide's tools on to Pi). The agent runs with your own install, sign-in and settings: Claude Code and Codex run the `claude` / `codex` on your PATH (turn off `plannotator.guides.useInstalledCli` to use the copy that comes with the adapter). The ACP adapters for Claude Code, Codex and Pi are installed for you on first use (pinned versions, into the extension's storage, nothing global); turn that off with `plannotator.guides.installAdapters`. When a run ends, anything the agent started (a dev server, a watcher) is stopped with it.
- **Permission requests come to you.** The agent is never blocked by the extension: its requests show in the run with every option it offers, and when your setup holds a run back (a request you turned down, a tool your settings or sandbox blocked), the guide says so and offers a way through. Automatic approval is opt-in (`plannotator.guides.autoApprove`).
- **Ask the agent.** Select lines in a guide's diff (new lines or removed lines) and ask in the box that opens on them, or ask about a chapter in the box under its text. The answer opens beside the guide at once and shows the agent's work; it is the agent's own page, in a sandboxed tab with no network and no access to VS Code, and its links open the code, a symbol or a chapter. Follow-ups continue the same conversation. Answers are saved with the guide and marked on the lines they are about. In VS Code's own diff of a guide's file, right-click **Ask the Agent About This…**.
- **Pull requests** need the GitHub CLI (`gh`). Each one opens in a git worktree in the extension's storage, so your checkout is never touched; pull requests from other repositories are cloned there too.

### Fixed
- Guided Reviews: the Claude Code and Codex adapters run your own `claude` / `codex` (via `CLAUDE_CODE_EXECUTABLE` / `CODEX_PATH`), not the copy each adapter bundles. The bundled copy still runs when the CLI is not on PATH, on Windows when the CLI is not an `.exe`, or with the new `plannotator.guides.useInstalledCli` turned off. The output channel names the copy on each launch, and a failed start with your CLI says so.
- Plan review panel: the theme you choose in Plannotator is no longer overridden by VS Code's theme; the old "auto dark" panel setting moves to System once; links to other sites (such as the pull request after you post a review) open in your browser instead of doing nothing.

## [0.4.0] - 2026-02-11

### Added
- Custom WebviewPanel with embedded iframe (replaces Simple Browser)
- Cookie persistence across sessions via reverse proxy and virtual cookie jar
- Auto-close panel when plan is approved or feedback is sent
- VS Code notification when panel opens
- Tab icon for Plannotator panel
- Plannotator output channel for diagnostics

### Changed
- Renamed display name from "Plannotator WebView" to "Plannotator"

## [0.1.0] - 2026-02-11

### Added
- Initial release
- Intercept Plannotator browser opens in VS Code integrated terminal
- URI handler for `vscode://plannotator-webview/open?url=...`
- Router shell script for PLANNOTATOR_BROWSER env var
- Configurable URL pattern matching
- Manual URL opening command
