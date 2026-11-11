/** The `@` is a reference marker, stripped first; if the stripped form does not resolve, the literal form is tried (scoped-package-style names like `@scope/pkg/README.md`). */

import { stripWrappingQuotes } from "./resolve-file";

/** Unwraps matching quotes, then removes one leading `@` (quotes first, so the `@` check sees the real first character). Does not recurse: `@@foo` becomes `@foo`. */
export function stripAtPrefix(input: string): string {
  const unquoted = stripWrappingQuotes(input);
  return unquoted.startsWith("@") ? unquoted.slice(1) : unquoted;
}

export function resolveAtReference(
  input: string,
  exists: (candidate: string) => boolean,
): string | null {
  const stripped = stripAtPrefix(input);
  if (exists(stripped)) return stripped;
  if (stripped !== input && exists(input)) return input;
  return null;
}
