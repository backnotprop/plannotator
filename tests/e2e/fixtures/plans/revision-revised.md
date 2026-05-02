# Refactor Auth Module

Updated approach: the audit shim is unnecessary because the legacy paths are
confirmed unused by code search. We will delete them outright and replace the
homegrown CSRF helper with the framework-provided implementation.

## Steps

1. Delete the unused branches in `packages/auth/index.ts`.
2. Swap to the framework-provided CSRF helper.
3. Add a contract test asserting the new auth surface.
4. Land behind a feature flag and monitor for one deploy window.
