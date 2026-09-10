/**
 * Pure validation for the `plannotator review --base <ref>` / `--diff-type <id>`
 * open-state flags. Everything here is decision logic with no git and no
 * server, so the whole provider/PR/workspace matrix is testable in isolation
 * and shared verbatim by the CLI, the opencode-review bridge, the OpenCode
 * plugin, and the Pi extension (vendored).
 *
 * The flags are a per-invocation SEED, never a setting: callers thread the
 * resolved `requestedBase` / `requestedDiffType` into `prepareLocalReviewDiff`
 * and nothing here (or downstream) writes a persisted preference.
 */
import type { ParsedReviewArgs } from "./review-args";
import type { AvailableBranches, DiffType } from "./review-core";

export interface ReviewOpenStatePolicy {
  resolve(input: ProviderReviewOpenStateInput): ReviewOpenState;
}

export interface ReviewOpenStateInput {
  parsed: Pick<ParsedReviewArgs, "base" | "diffType">;
  isPRMode: boolean;
  isWorkspace: boolean;
  provider?: ReviewOpenStatePolicy;
  resolvedDefaultDiffType: DiffType;
  /** Result of a provider-specific base probe; undefined = not probed. */
  baseResolves?: boolean;
  /** Optional names for provider-specific near-match suggestions. */
  availableBranches?: AvailableBranches;
}

export interface ProviderReviewOpenStateInput {
  base?: string;
  diffType?: string;
  resolvedDefaultDiffType: DiffType;
  baseResolves?: boolean;
  availableBranches?: AvailableBranches;
}

export interface ReviewOpenState {
  requestedBase?: string;
  requestedDiffType?: DiffType;
  /** Non-fatal messages for stderr / host notification. */
  notices: string[];
  /** Fatal: exit 1 at the CLI, host notification elsewhere. Never start a session. */
  error?: string;
}

export function resolveReviewOpenState(input: ReviewOpenStateInput): ReviewOpenState {
  const base = input.parsed.base;
  const diffType = input.parsed.diffType;
  if (base === undefined && diffType === undefined) {
    return { notices: [] };
  }

  // PR mode: the base comes from the pull request, and PR review has its own
  // layer/full-stack scope control — accepting either flag would be a lie.
  if (input.isPRMode) {
    return fail(
      base !== undefined
        ? "--base is not supported for pull request review; the base comes from the pull request."
        : "--diff-type is not supported for pull request review; pull request review has its own layer/full-stack scope control.",
    );
  }

  // Multi-repo workspace review has no base parameter at all, and its diff
  // types are the four workspace-* ids.
  if (input.isWorkspace) {
    return fail(
      base !== undefined
        ? "--base is not available in multi-repo workspace review (each child repo has its own base)."
        : "--diff-type is not available in multi-repo workspace review; use the workspace view toggle.",
    );
  }

  if (!input.provider) {
    return fail("Review options are not available because no VCS provider was selected.");
  }

  return input.provider.resolve({
    base,
    diffType,
    resolvedDefaultDiffType: input.resolvedDefaultDiffType,
    baseResolves: input.baseResolves,
    availableBranches: input.availableBranches,
  });
}

function fail(error: string): ReviewOpenState {
  return { notices: [], error };
}

/**
 * The fatal message for a `--base` ref the rev-parse probe could not resolve,
 * with up to five near matches from the already-computed branch lists — the
 * single most useful thing an agent caller can act on.
 */
export function buildBaseNotFoundError(
  ref: string,
  availableBranches?: AvailableBranches,
): string {
  const lines = [
    `Base ref not found: ${ref}`,
    "Pass a branch, remote branch, tag, or commit that exists in this repository.",
  ];
  const suggestions = availableBranches ? suggestBaseRefs(ref, availableBranches) : [];
  if (suggestions.length > 0) {
    lines.push(`Did you mean: ${suggestions.join(", ")}?`);
  }
  return lines.join("\n");
}

/** Rank branch names near `ref`: substring matches first, then small edit distances. */
export function suggestBaseRefs(
  ref: string,
  availableBranches: AvailableBranches,
  limit = 5,
): string[] {
  const needle = ref.toLowerCase();
  const scored: Array<{ name: string; score: number }> = [];
  const seen = new Set<string>();
  for (const name of [...availableBranches.local, ...availableBranches.remote]) {
    if (seen.has(name)) continue;
    seen.add(name);
    const candidate = name.toLowerCase();
    let score: number | undefined;
    if (candidate === needle) score = 0;
    else if (candidate.includes(needle) || needle.includes(candidate)) score = 1;
    else {
      const distance = boundedEditDistance(candidate, needle, 2);
      if (distance !== undefined) score = 2 + distance;
    }
    if (score !== undefined) scored.push({ name, score });
  }
  scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map((entry) => entry.name);
}

/** Levenshtein distance, or undefined when it exceeds `max`. */
function boundedEditDistance(a: string, b: string, max: number): number | undefined {
  if (Math.abs(a.length - b.length) > max) return undefined;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return undefined;
    previous = current;
  }
  const distance = previous[b.length]!;
  return distance <= max ? distance : undefined;
}
