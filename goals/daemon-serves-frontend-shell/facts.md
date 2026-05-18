# Facts

- Every daemon-backed session URL at /s/<sessionId> serves the new apps/frontend React shell, regardless of whether the session mode is plan, review, annotate, archive, or setup-goal.
- This goal does not migrate the older direct non-daemon startPlannotatorServer, startReviewServer, or startAnnotateServer HTML paths; those paths keep using their current mode-specific HTML until a separate UI migration.
- The frontend shell is built for daemon serving as a single-file HTML artifact, so a refreshed /s/<sessionId> page does not depend on separate /assets JavaScript or CSS routes.
- The repository build scripts prepare the frontend shell before building the hook binary/runtime that imports the daemon-served shell asset.
- The shell bootstraps a session through GET /s/<sessionId>/api/session and receives the session summary, apiBase, daemon capabilities, and supported session views.
- Existing per-mode backend APIs remain routed through /s/<sessionId>/api/* to the original plan, review, annotate, archive, and setup-goal session handlers.
- The frontend shell keeps using TanStack Router for /s/$sessionId routing and Zustand with Immer for session state, including success and missing-session/error states.
- The implementation may keep mode-specific placeholder views in the shell; migrating the full legacy plan review, code review, annotate, and archive user interfaces is out of scope for this goal.
- Completion requires frontend typecheck/lint/format/unit tests, frontend browser-mode tests, daemon integration tests for shell serving and session bootstrap, and relevant build script checks; a full live daemon plus browser end-to-end test is not required in this phase.
- Separate static asset serving is intentionally deferred; it can be reconsidered later if the real UI migration needs code splitting, cacheable chunks, or non-single-file frontend assets.
