export function normalizeEditPermission(
  edit: string | Record<string, string> | undefined,
): Record<string, string> {
  if (typeof edit === "string") {
    return { "*": edit };
  }
  return edit ?? {};
}

export interface StripPlanModeOptions {
  openCode2?: boolean;
}

const OPENCODE_PLAN_DIRECTORY = /\.opencode[\\/]plans?(?![a-z0-9_-])/;

function shouldStripPlanModeLine(line: string, options: StripPlanModeOptions): boolean {
  const normalized = line.trim().toLowerCase();
  if (normalized.includes("strictly forbidden: any file edits")
    || normalized.includes("your plan at ")
    || normalized.includes("plan file already exists at ")
    || normalized.includes(".opencode/plans/")
    || normalized.includes("plan_exit")
    || (normalized.includes("agent's conversation") && normalized.includes("not on disk"))) return true;
  if (!options.openCode2) return false;
  return normalized.includes("discuss the plan with the user directly")
    || normalized.includes("do not create or update plan files")
    || OPENCODE_PLAN_DIRECTORY.test(normalized);
}

function cleanupSystemEntry(entry: string): string {
  return entry
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function stripConflictingPlanModeRules(
  systemEntries: string[],
  options: StripPlanModeOptions = {},
): string[] {
  return systemEntries
    .map((entry) =>
      cleanupSystemEntry(
        entry
          .split("\n")
          .filter((line) => !shouldStripPlanModeLine(line, options))
          .join("\n"),
      ),
    )
    .filter(Boolean);
}

export function composeSystemPrompt(system: string[], additions: string[]): string[] {
  return [system.concat(additions).map((s) => s.trim()).filter(Boolean).join("\n\n")];
}
