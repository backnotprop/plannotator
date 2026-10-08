import {
  HIDDEN_SUBCOMMANDS,
  SUBCOMMAND_HELP,
  SUBCOMMAND_HELP_ALIASES,
} from "./cli";

const INTERNAL_SUBCOMMANDS = [
  "install-runtime",
  "opencode-plan",
  "opencode-review",
  "opencode-review-directory",
  "opencode-annotate-last",
  "copilot-plan",
  "claude-mod-plan",
  "unlock",
] as const;

const PUBLISHED_SUBCOMMANDS = [
  ...Object.keys(SUBCOMMAND_HELP),
  ...Object.keys(SUBCOMMAND_HELP_ALIASES),
];

// Unreleased subcommands still run, but are never suggested to a user.
function suggestableSubcommands(hidden: ReadonlySet<string>): string[] {
  return PUBLISHED_SUBCOMMANDS.filter((sub) => !hidden.has(sub));
}

export const KNOWN_SUBCOMMANDS: ReadonlySet<string> = new Set([
  ...PUBLISHED_SUBCOMMANDS,
  ...INTERNAL_SUBCOMMANDS,
]);

function levenshteinDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }

  return previous[right.length];
}

/**
 * The closest published subcommand to a typo, never one in `hidden`
 * (HIDDEN_SUBCOMMANDS by default; tests pass their own set because the real
 * one is empty while nothing is unreleased).
 */
export function findClosestSubcommand(
  token: string,
  hidden: ReadonlySet<string> = HIDDEN_SUBCOMMANDS,
): string | null {
  const normalized = token.toLowerCase();
  if (!normalized) return null;
  const candidates = suggestableSubcommands(hidden);

  if (normalized.length >= 3) {
    const prefixMatch = candidates.find((candidate) =>
      candidate.startsWith(normalized),
    );
    if (prefixMatch) return prefixMatch;
  }

  const tolerance =
    normalized.length <= 4 ? 1 : normalized.length <= 8 ? 2 : 3;
  let closest: string | null = null;
  let closestDistance = Infinity;

  for (const candidate of candidates) {
    if (Math.abs(normalized.length - candidate.length) > tolerance) continue;

    const distance = levenshteinDistance(normalized, candidate);
    if (distance <= tolerance && distance < closestDistance) {
      closest = candidate;
      closestDistance = distance;
    }
  }

  return closest;
}

export function findUnknownSubcommand(args: readonly string[]): string | null {
  const first = args[0];
  if (!first || first.startsWith("-")) return null;
  return KNOWN_SUBCOMMANDS.has(first) ? null : first;
}

export function formatUnknownSubcommandError(subcommand: string): string {
  const suggestion = findClosestSubcommand(subcommand);
  return [
    `Unknown command: ${subcommand}`,
    ...(suggestion ? ["", `Did you mean 'plannotator ${suggestion}'?`] : []),
    "",
    "Run 'plannotator --help' for the list of commands.",
  ].join("\n");
}

export function exitOnUnknownSubcommand(args: readonly string[]): void {
  const unknownSubcommand = findUnknownSubcommand(args);
  if (!unknownSubcommand) return;

  console.error(formatUnknownSubcommandError(unknownSubcommand));
  process.exit(1);
}
