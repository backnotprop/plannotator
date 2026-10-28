# Changelog

## [Unreleased]

### Fixed
- Guided Reviews: the Claude Code and Codex adapters run your own `claude` / `codex` (via `CLAUDE_CODE_EXECUTABLE` / `CODEX_PATH`), not the copy each adapter bundles. The bundled copy still runs when the CLI is not on PATH, on Windows when the CLI is not an `.exe`, or with the new `plannotator.guides.useInstalledCli` turned off. The output channel names the copy on each launch, and a failed start with your CLI says so.

### Added
- Guided Reviews: ask the agent about selected code, a file or a chapter, and read its answer as a page beside the diff (the agent's own HTML, scripts included, in a sandboxed frame; Mermaid drawn by the Guide tab's engine). The guide's own ACP session answers when the agent can load it; answers are saved with the guide and listed under the chapter, with follow-ups in the same conversation. Selected lines (and the file's CodeLens) open the question box right under the lines, as a comment thread that shows the agent's progress and links to the answer.
- Guides view: write a Guided Review of a pull request or your local changes with Claude Code over ACP, watch it build, and read it chapter by chapter in the native diff editor (overview with a Mermaid diagram and code links, chapter and file ticks, CodeLens, status bar). Guides are shared with Plannotator's web app. A pull request's own Claude Code settings and MCP servers are never loaded; guide history off (`PLANNOTATOR_GUIDE_HISTORY=0`) is honored.

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
