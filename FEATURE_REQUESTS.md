# Feature Requests — Prioritized

> Generated from open GitHub issues as of 2026-02-13. Sorted by community demand and strategic impact.

---

## Tier 1: High Priority (Strong demand, accepted, or core workflow improvements)

### Plan Diffing & Versioning
The most-requested category. Users repeatedly struggle to identify what changed between plan iterations.

| # | Title | Upvotes | Labels | Summary |
|---|-------|---------|--------|---------|
| [#82](https://github.com/backnotprop/plannotator/issues/82) | Keyboard shortcut for clear context + auto-accept | 7 | `enhancement` | Mirror Claude Code's shift+tab behavior: clear context + auto-accept edits on approval. |
| [#111](https://github.com/backnotprop/plannotator/issues/111) | See what has changed since last iteration | 5 | `enhancement`, `accepted` | Highlight diffs between plan iterations so users don't re-read the entire plan. |
| [#41](https://github.com/backnotprop/plannotator/issues/41) | Auto-close browser tab after confirmation | 5 | `enhancement` | Auto-close the browser tab ~1.5s after approve/deny in local sessions. Prevent tab accumulation. |
| [#138](https://github.com/backnotprop/plannotator/issues/138) | Plan Versions and Diffs | 3 | — | Store plan versions locally, allow diffing and navigating between them. Related to #111. |
| [#127](https://github.com/backnotprop/plannotator/issues/127) | Clear context + auto-accept approval variant | 3 | — | Hook API support for context clearing on approval. Related to #82. May require upstream Claude Code API changes. |
| [#63](https://github.com/backnotprop/plannotator/issues/63) | File-based plans | 3 | `enhancement`, `accepted` | Plans as editable markdown files instead of full rewrites. Enables incremental edits and reduces context window clutter. |

**Recommendation:** #111 and #138 are closely related — implement a unified plan versioning system that tracks iterations and shows diffs. #82 and #127 are the same request — depends on Claude Code hook API supporting `clearContext`.

---

## Tier 2: Medium Priority (Solid use cases, moderate demand)

### Agent Switching Improvements

| # | Title | Upvotes | Labels | Summary |
|---|-------|---------|--------|---------|
| [#113](https://github.com/backnotprop/plannotator/issues/113) | Agent switching should remember selection per repo | — | `enhancement`, `accepted` | Persist agent choice per repository. Move agent selector to a prominent location near approve button. |
| [#120](https://github.com/backnotprop/plannotator/issues/120) | Agent switching should switch back to previous agent | 1 | — | After plan implementation, automatically return to Plan agent for next iteration. |
| [#114](https://github.com/backnotprop/plannotator/issues/114) | Unintentional agent switching on approval | — | — | Possible UX bug: agent switches unexpectedly on plan approval. May be related to #113. |

### Annotation & Feedback Enhancements

| # | Title | Upvotes | Labels | Summary |
|---|-------|---------|--------|---------|
| [#67](https://github.com/backnotprop/plannotator/issues/67) | Image names for referencing in feedback | 2 | `enhancement`, `accepted` | Attach images to annotations with names so the LLM can locate and review them. |
| [#109](https://github.com/backnotprop/plannotator/issues/109) | `plannotator annotate <file.md>` — annotate any markdown file | 2 | — | Extend annotation UI beyond ExitPlanMode to arbitrary markdown files. Contributor has a working implementation ready. |

### Session & Infrastructure

| # | Title | Upvotes | Labels | Summary |
|---|-------|---------|--------|---------|
| [#102](https://github.com/backnotprop/plannotator/issues/102) | Support concurrent sessions (port conflicts) | 1 | `enhancement` | Multiple Claude Code processes conflict on the same port. Support port ranges or UI multiplexing with tabs. |
| [#140](https://github.com/backnotprop/plannotator/issues/140) | Release via package manager (Homebrew) | 2 | — | Distribute plannotator through Homebrew or similar for easier installation. |
| [#25](https://github.com/backnotprop/plannotator/issues/25) | Unified update command | — | `enhancement` | Binary and plugin can become misaligned during updates. Provide a single `plannotator update` command or auto-detection. |

---

## Tier 3: Lower Priority (Niche, exploratory, or blocked)

### Browser & UX

| # | Title | Upvotes | Labels | Summary |
|---|-------|---------|--------|---------|
| [#135](https://github.com/backnotprop/plannotator/issues/135) | Configurable browser & reopen closed GUI tabs | — | — | Specify browser via CLI/config/env. Reopen accidentally closed tabs without restarting. |
| [#119](https://github.com/backnotprop/plannotator/issues/119) | Use BROWSER env var as fallback | — | — | Fall back to `BROWSER` env var when default browser command fails and `PLANNOTATOR_BROWSER` isn't set. |
| [#118](https://github.com/backnotprop/plannotator/issues/118) | Stop agent after plan approval | — | — | Option to halt agent post-approval for "write plan only" sessions. OpenCode-specific. |

### Platform & Third-Party Integration

| # | Title | Upvotes | Labels | Summary |
|---|-------|---------|--------|---------|
| [#38](https://github.com/backnotprop/plannotator/issues/38) | Support other CLI agents (Codex, Kiro, etc.) | 1 | `enhancement` | Integration guidance/support for non-Claude CLI agents. |
| [#112](https://github.com/backnotprop/plannotator/issues/112) | Superpowers compatibility | 2 | — | Superpowers modifies planning behavior and blocks plannotator from triggering. |
| [#106](https://github.com/backnotprop/plannotator/issues/106) | Support OpenCode Sisyphus mode | — | `enhancement` | No description provided. OpenCode-specific workflow. |
| [#91](https://github.com/backnotprop/plannotator/issues/91) | IDE-based control & interactive code revision | — | `question` | Proposal to move control into IDE extensions instead of browser. Exploratory discussion. |

---

## Summary by Theme

| Theme | Issues | Top Priority |
|-------|--------|-------------|
| **Plan Diffing & Versioning** | #111, #138, #63 | #111 (5 upvotes, accepted) |
| **Approval Flow** | #82, #127, #41, #118 | #82 (7 upvotes) |
| **Agent Switching** | #113, #120, #114 | #113 (accepted) |
| **Annotation & Feedback** | #67, #109 | #67 (accepted) |
| **Concurrent Sessions** | #102 | #102 |
| **Distribution & Updates** | #140, #25 | #140 |
| **Browser Configuration** | #135, #119 | #135 |
| **Third-Party Integration** | #38, #112, #106, #91 | #112 |

## Suggested Implementation Order

1. **#82 / #127** — Clear context + auto-accept (highest upvotes, but may be blocked on upstream hook API)
2. **#111 / #138** — Plan diff/versioning (most impactful UX improvement, both accepted)
3. **#41** — Auto-close tabs (high upvotes, well-scoped, quick win)
4. **#113** — Per-repo agent switching (accepted, clear scope)
5. **#63** — File-based plans (accepted, architecturally significant)
6. **#67** — Image references in feedback (accepted, moderate scope)
7. **#109** — Annotate arbitrary markdown (contributor has PR ready)
8. **#102** — Concurrent session support (important for power users)
9. **#140 / #25** — Distribution improvements (Homebrew, unified updates)
10. **#135 / #119** — Browser configuration (smaller UX wins)
