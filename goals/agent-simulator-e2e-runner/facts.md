# Facts

- The end-to-end runner is a standalone OpenTUI application in this repository, separate from the new React frontend shell.
- The runner spawns the real Plannotator command, writes realistic stdin payloads, captures stdout and stderr, observes child exit status, and parses PLANNOTATOR_SESSION_READY lines when present.
- The first runner covers fixture-backed scenarios for Claude Code plan hooks, OpenCode plugin plan/review/annotate/archive, Pi plugin plan/review/annotate/archive, Codex plan hooks, Copilot plan hooks, Gemini plan-file hooks, and direct CLI review/annotate/archive.
- Runner scenarios use local temporary fixtures by default and do not require live external agent products, network PR URLs, or external hosted services to pass.
- Where the session type allows it, each automated scenario runs the full local loop: create the session, verify it appears in the daemon, complete it through the real session API, and assert the final stdout/stderr/result behavior.
- Browser interaction is manual or optional in this goal; the runner does not require Playwright-driven browser automation to prove the process-to-daemon flow.
- The daemon exposes a focused SSE event stream for integration visibility, including session created, session updated, session removed, daemon status, and useful debug/error events.
- The frontend debug dashboard subscribes to the daemon event stream when available and falls back to polling existing daemon endpoints when the stream is unavailable.
- The frontend shell includes lightweight debug dashboard components that render daemon status JSON, active session JSON, selected session bootstrap JSON, recent daemon events, per-mode API probe results, and session links.
- The frontend debug panels include small action buttons where useful, such as approving, denying, sending review feedback, submitting annotation feedback, exiting annotate sessions, and closing archive sessions, so stdout/result behavior can be observed without the full migrated UI.
- The browser frontend does not contain the agent simulator controls; it only displays daemon/session/debug state and simple session API actions.
- This goal does not migrate the real plan review, code review, annotate, or archive interfaces into the new frontend shell.
- This goal does not introduce an advanced daemon authentication/security project beyond the repository's current local daemon posture.
- Completion requires automated coverage for scenario request construction, child-process/stdio handling, daemon event streaming, frontend event/polling behavior, frontend action buttons, and at least one fixture-backed full process-to-daemon completion path.
