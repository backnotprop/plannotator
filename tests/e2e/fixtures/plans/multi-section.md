# Refactor the Auth Module

## Background

The current authentication middleware has accumulated dead code paths over the
last two release cycles. We are going to simplify it before adding the new
session-token storage.

## Approach

1. Remove the legacy cookie helpers in `packages/auth/cookie.ts`.
2. Inline the remaining branches into `packages/auth/index.ts`.
3. Replace the homegrown CSRF helper with the framework-provided one.

```ts
// New shape of the exported helper
export function authenticate(req: Request): Promise<User | null> {
  return resolveSessionFromHeaders(req.headers);
}
```

## Risks

> The auth surface is exercised by every authenticated route. We will keep the
> existing test fixtures untouched and add new contract tests against the new
> shape so we can detect regressions immediately.

## Rollout

- Land changes behind a small feature flag.
- Monitor error rates for one full deploy window before removing the flag.
