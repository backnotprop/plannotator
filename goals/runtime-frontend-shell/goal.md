# Runtime Frontend Shell Goal

Build a new `apps/frontend` Vite React TypeScript application as the production-grade skeleton for Plannotator's future single daemon-served local UI. The shell uses TanStack Router, Zustand, Immer, OxLint/Oxfmt, Vitest, and Vitest Browser Mode with Playwright, while the existing plan/review HTML bundles remain in production service during this phase.

The shared understanding is captured in `facts.md`. The implementation plan is `plan.md`. The full source-backed app/API inventory is `functionality-inventory.md`.

Done means the new third-stacked branch is created from the latest `feat/plannotator-daemon-runtime` tip, the daemon exposes the session bootstrap contract, `apps/frontend` is independently buildable and testable, the source tree follows the approved product-module structure, all required daemon/session/API fixtures and high-signal tests are in place, and final inventory evidence is recorded before completion.
