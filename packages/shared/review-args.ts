import type { VcsSelection } from "./vcs-core";
import { stripWrappingQuotes } from "./resolve-file";

export interface ParsedReviewArgs {
  prUrl?: string;
  vcsType?: VcsSelection;
  useLocal: boolean;
  /**
   * Argument-shape problems the host must surface before starting a session.
   * Always present; empty means the invocation parsed cleanly. Hosts differ in
   * how they surface these (CLI exits 1, Pi/OpenCode notify), which is why the
   * parser reports rather than throws.
   */
  errors: string[];
}

export function parseReviewArgs(input: string | string[]): ParsedReviewArgs {
  const tokens = Array.isArray(input)
    ? input.map((token) => stripWrappingQuotes(token.trim())).filter(Boolean)
    : tokenizeReviewArgs(input ?? "");

  let vcsType: VcsSelection | undefined;
  let useLocal = true;
  const errors: string[] = [];
  const positional: string[] = [];

  // Index-based so value-taking flags can consume their value token before the
  // positional collector sees it.
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    switch (token) {
      case "--git":
        vcsType = "git";
        break;
      case "--gitbutler":
        vcsType = "gitbutler";
        break;
      case "--local":
        useLocal = true;
        break;
      case "--no-local":
        useLocal = false;
        break;
      default:
        if (token.startsWith("-")) {
          // Unknown dash-prefixed tokens error loudly, matching the annotate
          // contract ("a typo'd flag errors the way it always did"). Silently
          // dropping them meant a mistyped flag vanished on every host — and a
          // dashed token in positional[0] could even shadow a PR URL.
          errors.push(`Unknown review option: ${token}`);
        } else {
          // Plain words stay tolerated: slash-command hosts forward raw user
          // prose verbatim, and only positional[0] is ever inspected (as a URL).
          positional.push(token);
        }
        break;
    }
  }

  const target = positional[0];
  return {
    prUrl: target && isReviewUrl(target) ? target : undefined,
    vcsType,
    useLocal,
    errors,
  };
}

function isReviewUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

function tokenizeReviewArgs(input: string): string[] {
  const raw = input.trim();
  if (!raw) return [];

  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) tokens.push(current);
  return tokens.map((token) => stripWrappingQuotes(token.trim())).filter(Boolean);
}
