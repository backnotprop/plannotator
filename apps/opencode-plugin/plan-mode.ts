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
