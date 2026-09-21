import { SUBCOMMAND_HELP, SUBCOMMAND_HELP_ALIASES } from "./cli";

const INTERNAL_SUBCOMMANDS = [
  "install-runtime",
  "opencode-plan",
  "opencode-review",
  "opencode-annotate-last",
  "copilot-plan",
] as const;

const SUGGESTABLE_SUBCOMMANDS = [
  ...Object.keys(SUBCOMMAND_HELP),
  ...Object.keys(SUBCOMMAND_HELP_ALIASES),
];

export const KNOWN_SUBCOMMANDS: ReadonlySet<string> = new Set([
  ...SUGGESTABLE_SUBCOMMANDS,
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

export function findClosestSubcommand(token: string): string | null {
  const normalized = token.toLowerCase();
  if (!normalized) return null;

  if (normalized.length >= 3) {
    const prefixMatch = SUGGESTABLE_SUBCOMMANDS.find((candidate) =>
      candidate.startsWith(normalized),
    );
    if (prefixMatch) return prefixMatch;
  }

  const tolerance =
    normalized.length <= 4 ? 1 : normalized.length <= 8 ? 2 : 3;
  let closest: string | null = null;
  let closestDistance = Infinity;

  for (const candidate of SUGGESTABLE_SUBCOMMANDS) {
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
