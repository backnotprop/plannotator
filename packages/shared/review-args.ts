import type { VcsSelection } from "./vcs-core";
import { stripWrappingQuotes } from "./resolve-file";

export interface ParsedReviewArgs {
  prUrl?: string;
  patchFile?: string;
  vcsType?: VcsSelection;
  useLocal: boolean;
}

export function parseReviewArgs(input: string | string[]): ParsedReviewArgs {
  const tokens = Array.isArray(input)
    ? input.map((token) => stripWrappingQuotes(token.trim())).filter(Boolean)
    : tokenizeReviewArgs(input ?? "");

  let vcsType: VcsSelection | undefined;
  let useLocal = true;
  const positional: string[] = [];

  const patchFileIndex = tokens.indexOf("--patch-file");
  const patchFile = patchFileIndex === -1 ? undefined : tokens[patchFileIndex + 1];
  if (patchFileIndex !== -1) {
    if (!patchFile || patchFile.startsWith("--")) {
      throw new Error("--patch-file requires a path or -");
    }
    if (tokens.lastIndexOf("--patch-file") !== patchFileIndex) {
      throw new Error("--patch-file may only be specified once");
    }
    tokens.splice(patchFileIndex, 2);
  }

  for (const token of tokens) {
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
        positional.push(token);
        break;
    }
  }

  const target = positional[0];
  return {
    prUrl: target && isReviewUrl(target) ? target : undefined,
    patchFile,
    vcsType,
    useLocal,
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
