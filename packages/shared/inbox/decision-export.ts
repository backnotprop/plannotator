/**
 * Export decisions: the `plannotator.decisions` v1 shape and its builder live in `@plannotator/core/inbox-decisions`
 * (pure, published, so a host can import the shape from npm). This re-export keeps every Plannotator import of
 * `@plannotator/shared/inbox/decision-export` as it was.
 */
export * from "@plannotator/core/inbox-decisions";
