import type { VcsSelection } from "./vcs-core";
import { stripWrappingQuotes } from "./resolve-file";

export interface ParsedReviewArgs {
  prUrl?: string;
  vcsType?: VcsSelection;
  useLocal: boolean;
  /** Non-interactive tripwire scan (`--tripwires` / `-t`). */
  tripwires?: boolean;
  /**
   * Natural-language description for `--add-tripwire <description...>`.
   * Consumes everything after the flag (so unquoted multi-word descriptions
   * work); undefined when the flag has no value.
   */
  addTripwire?: string;
}

export function parseReviewArgs(input: string | string[]): ParsedReviewArgs {
  const tokens = Array.isArray(input)
    ? input.map((token) => stripWrappingQuotes(token.trim())).filter(Boolean)
    : tokenizeReviewArgs(input ?? "");

  let vcsType: VcsSelection | undefined;
  let useLocal = true;
  let tripwires: boolean | undefined;
  let addTripwire: string | undefined;
  const positional: string[] = [];

  // True after `--add-tripwire`: every remaining token is part of the
  // natural-language description, not a positional or flag. A missing next
  // token leaves addTripwire undefined.
  let collectAddTripwire = false;
  const addTripwireParts: string[] = [];

  for (const token of tokens) {
    if (collectAddTripwire) {
      addTripwireParts.push(token);
      continue;
    }
    switch (token) {
      case "--git":
        vcsType = "git";
        break;
      case "--local":
        useLocal = true;
        break;
      case "--no-local":
        useLocal = false;
        break;
      case "--tripwires":
      case "-t":
        tripwires = true;
        break;
      case "--add-tripwire":
        collectAddTripwire = true;
        break;
      default:
        positional.push(token);
        break;
    }
  }

  if (addTripwireParts.length > 0) {
    addTripwire = addTripwireParts.join(" ");
  }

  const target = positional[0];
  return {
    prUrl: target && isReviewUrl(target) ? target : undefined,
    vcsType,
    useLocal,
    ...(tripwires ? { tripwires } : {}),
    ...(addTripwire !== undefined ? { addTripwire } : {}),
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
