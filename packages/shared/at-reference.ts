/**
 * `@`-reference handling for user-provided paths.
 *
 * Several agent harnesses (Claude Code, OpenCode, Pi) let users reference
 * files with an `@` prefix, e.g. `@README.md`. The `@` is the team's
 * reference marker, not part of the filename. Stripping it is the primary
 * resolution path — that's the common case and it's supported first-class.
 *
 * The secondary path handles scoped-package-style names like
 * `@scope/pkg/README.md`: if the stripped form doesn't resolve, fall back
 * to the literal form so those paths still open.
 *
 * Both functions are pure and take any filesystem-ish predicate via a
 * callback, so they're trivial to unit-test without stubbing anything.
 */

import { stripWrappingQuotes } from "./resolve-file";

/**
 * Normalize a user-typed path reference by unwrapping matching `"..."` or
 * `'...'` quotes and removing a single leading `@`. Quotes come from
 * harnesses that tokenize on whitespace (OpenCode, Pi), where paths
 * containing spaces have to be quoted. The quote-stripping has to run
 * first so the `@` check sees the real first character.
 *
 * Non-`@` inputs are returned unchanged except for quote unwrapping.
 * Does not recurse: `@@foo` becomes `@foo`, not `foo`.
 */
export function stripAtPrefix(input: string): string {
  const unquoted = stripWrappingQuotes(input);
  return unquoted.startsWith("@") ? unquoted.slice(1) : unquoted;
}

/**
 * Resolve an `@`-prefixed user input by trying the stripped form first
 * (reference mode, primary) and falling back to the literal form if the
 * stripped form doesn't resolve. Returns the candidate that resolves, or
 * null if neither does.
 *
 * `exists` defines what "resolves" means — use `existsSync` for a bare
 * filesystem check, or wrap `resolveMarkdownFile` / `statSync` for richer
 * predicates. The helper itself is filesystem-agnostic.
 */
export function resolveAtReference(
  input: string,
  exists: (candidate: string) => boolean,
): string | null {
  const stripped = stripAtPrefix(input);
  if (exists(stripped)) return stripped;
  if (stripped !== input && exists(input)) return input;
  return null;
}
