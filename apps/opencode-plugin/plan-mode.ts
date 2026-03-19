import { existsSync, readFileSync, realpathSync } from "fs";
import { homedir } from "os";
import path from "path";

// ── Directory ─────────────────────────────────────────────────────────────

/**
 * Returns the OpenCode plans directory path.
 * Matches OpenCode's own resolution: $XDG_DATA_HOME/opencode/plans
 * (defaults to ~/.local/share/opencode/plans on all platforms).
 *
 * We use this path because OpenCode's plan mode permission ruleset
 * only allows edits to .opencode/plans/*.md and this XDG path.
 */
export function getPlanDirectory(): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
  return path.join(dataHome, "opencode", "plans");
}

// ── Path validation ───────────────────────────────────────────────────────

export type ValidatePlanPathResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

export function validatePlanPath(
  filePath: string,
  planDir: string,
): ValidatePlanPathResult {
  // 1. Must be absolute
  if (!path.isAbsolute(filePath)) {
    return { ok: false, error: `Path must be absolute. Got: ${filePath}` };
  }

  // 2. Directory check disabled — allow plans to be written anywhere.
  // TODO: revisit if we want to re-scope plan file locations.
  // try {
  //   const canonicalDir = realpathSync(planDir);
  //   const canonicalFile = realpathSync(path.dirname(filePath)) + path.sep + path.basename(filePath);
  //   if (!canonicalFile.startsWith(canonicalDir + path.sep) && canonicalFile !== canonicalDir) {
  //     return {
  //       ok: false,
  //       error: `Plan file must be inside ${planDir}. Got: ${filePath}`,
  //     };
  //   }
  // } catch {
  //   const normalizedFile = path.normalize(filePath);
  //   const normalizedDir = path.normalize(planDir);
  //   if (!normalizedFile.startsWith(normalizedDir + path.sep)) {
  //     return {
  //       ok: false,
  //       error: `Plan file must be inside ${planDir}. Got: ${filePath}`,
  //     };
  //   }
  // }

  // 3. Must exist
  if (!existsSync(filePath)) {
    return {
      ok: false,
      error: `No plan file found at ${filePath}. Create the file first, then call submit_plan.`,
    };
  }

  // 4. Must be readable
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    return {
      ok: false,
      error: `Could not read plan file at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 5. Must have non-whitespace content
  if (!content.trim()) {
    return {
      ok: false,
      error: `Plan file at ${filePath} is empty. Write your plan content first, then call submit_plan.`,
    };
  }

  return { ok: true, content };
}

// ── Permission helpers ────────────────────────────────────────────────────

/**
 * Normalize an `edit` permission value before merging additional rules.
 *
 * OpenCode's zod transform converts legacy `tools: { edit: false }` to
 * `permission.edit = "deny"` (a plain string) before any plugin sees the
 * config.  Spreading a string in JS produces char-index keys:
 *   `{ ..."deny" }` → `{ "0": "d", "1": "e", "2": "n", "3": "y" }`
 * which corrupt the permission ruleset and cause zod validation failures.
 *
 * This function converts a string action to `{ "*": action }` (equivalent
 * wildcard object) so the caller can safely spread it and add overrides.
 */
export function normalizeEditPermission(
  edit: string | Record<string, string> | undefined,
): Record<string, string> {
  if (typeof edit === "string") {
    return { "*": edit };
  }
  return edit ?? {};
}

// ── Prompt stripping ──────────────────────────────────────────────────────

function shouldStripPlanModeLine(line: string): boolean {
  const normalized = line.trim().toLowerCase();
  return normalized.includes("strictly forbidden: any file edits")
    || normalized.includes("your plan at ")
    || normalized.includes("plan file already exists at ")
    || normalized.includes(".opencode/plans/")
    || normalized.includes("plan_exit")
    || (normalized.includes("agent's conversation") && normalized.includes("not on disk"));
}

function cleanupSystemEntry(entry: string): string {
  return entry
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function stripConflictingPlanModeRules(systemEntries: string[]): string[] {
  return systemEntries
    .map((entry) =>
      cleanupSystemEntry(
        entry
          .split("\n")
          .filter((line) => !shouldStripPlanModeLine(line))
          .join("\n"),
      ),
    )
    .filter(Boolean);
}
