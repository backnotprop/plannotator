import { stripWrappingQuotes } from "./resolve-file";

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
