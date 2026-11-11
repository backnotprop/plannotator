/** Generated-file detection for code review: built-in name defaults, refined by `git check-attr` for linguist-generated (explicit set or unset wins). Any lookup failure leaves the name defaults standing. */

import type { ReviewGitRuntime } from "./review-core";
import { DEFAULT_GENERATED_PATTERNS, isDefaultGeneratedPath } from "@plannotator/core/file-kind";

export const GENERATED_ATTRIBUTE = "linguist-generated";

const CHECK_ATTR_TIMEOUT_MS = 5000;

export { DEFAULT_GENERATED_PATTERNS, isDefaultGeneratedPath };

export function detectGeneratedFilesByName(paths: string[]): string[] {
  const unique = [...new Set(paths.filter((p) => p.length > 0))];
  return unique.filter(isDefaultGeneratedPath);
}

/** `git check-attr -z` emits NUL-separated path, attribute, value triples. `set`/`true` mark the file; `unset`/`false` un-mark it; anything else defers to the defaults. */
export function parseCheckAttrStates(
  stdout: string,
): Map<string, "set" | "unset" | "unspecified"> {
  const tokens = stdout.split("\0");
  const states = new Map<string, "set" | "unset" | "unspecified">();
  for (let i = 0; i + 2 < tokens.length; i += 3) {
    const [path, attribute, value] = [tokens[i], tokens[i + 1], tokens[i + 2]];
    if (attribute !== GENERATED_ATTRIBUTE) continue;
    if (value === "set" || value === "true") states.set(path, "set");
    else if (value === "unset" || value === "false") states.set(path, "unset");
    else states.set(path, "unspecified");
  }
  return states;
}

export async function detectGeneratedFiles(
  runtime: ReviewGitRuntime,
  cwd: string | undefined,
  paths: string[],
): Promise<string[]> {
  const unique = [...new Set(paths.filter((p) => p.length > 0))];
  if (unique.length === 0) return [];
  const marked = new Set(unique.filter(isDefaultGeneratedPath));
  try {
    const result = await runtime.runGit(
      ["check-attr", "--stdin", "-z", GENERATED_ATTRIBUTE],
      {
        cwd,
        // NUL-terminated input pairs with -z output, so paths with spaces, quotes or newlines need no quoting.
        stdin: unique.join("\0") + "\0",
        timeoutMs: CHECK_ATTR_TIMEOUT_MS,
        interaction: "forbid",
      },
    );
    if (result.exitCode === 0 && !result.truncated) {
      for (const [path, state] of parseCheckAttrStates(result.stdout)) {
        if (state === "set") marked.add(path);
        else if (state === "unset") marked.delete(path);
        // unspecified: no opinion — the built-in default stands.
      }
    }
  } catch {
    // Attribute refinement unavailable — the name-based defaults stand.
  }
  return unique.filter((p) => marked.has(p));
}
