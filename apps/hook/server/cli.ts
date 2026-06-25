export function isTopLevelHelpInvocation(args: string[]): boolean {
  return args[0] === "--help";
}

export function isVersionInvocation(args: string[]): boolean {
  return args[0] === "--version" || args[0] === "-v";
}

declare const __CLI_VERSION__: string;

export function formatVersion(): string {
  return `plannotator ${typeof __CLI_VERSION__ !== "undefined" ? __CLI_VERSION__ : "dev"}`;
}

export function isInteractiveNoArgInvocation(
  args: string[],
  stdinIsTTY: boolean | undefined,
): boolean {
  return args.length === 0 && stdinIsTTY === true;
}

const RESERVED_TOP_LEVEL_COMMANDS = new Set([
  "annotate",
  "annotate-last",
  "archive",
  "copilot-last",
  "copilot-plan",
  "improve-context",
  "install-runtime",
  "last",
  "opencode-annotate-last",
  "opencode-plan",
  "opencode-review",
  "review",
  "sessions",
  "setup-goal",
]);

export function isReservedTopLevelCommand(command: string): boolean {
  return (
    RESERVED_TOP_LEVEL_COMMANDS.has(command) ||
    command.startsWith("opencode-") ||
    command.startsWith("copilot-")
  );
}

export function shouldAliasToAnnotate(
  args: string[],
  isAnnotatableTarget: (arg: string) => boolean,
): boolean {
  const firstNonFlagIndex = args.findIndex((arg) => !arg.startsWith("-"));
  if (firstNonFlagIndex === -1 || firstNonFlagIndex !== 0) return false;

  const target = args[firstNonFlagIndex];
  if (!target || isReservedTopLevelCommand(target)) return false;

  return isAnnotatableTarget(target);
}

export function formatTopLevelHelp(): string {
  return [
    "Usage:",
    "  plannotator --help",
    "  plannotator --version, -v",
    "  plannotator [--browser <name>]",
    "  plannotator review [--git] [PR_URL]",
    "  plannotator annotate <file.md | file.txt | file.html | https://... | folder/>  [--markdown] [--no-jina] [--gate] [--json] [--hook]",
    "  plannotator annotate-last [--stdin] [--gate] [--json] [--hook]",
    "  plannotator setup-goal <interview|facts> <bundle.json | -> [--json]",
    "  plannotator last",
    "  plannotator archive",
    "  plannotator sessions",
    "  plannotator improve-context",
    "",
    "Note:",
    "  running 'plannotator' without arguments is for hook integration and expects JSON on stdin",
  ].join("\n");
}

export function formatInteractiveNoArgClarification(): string {
  return [
    "plannotator (without arguments) is usually launched automatically by Claude Code hooks.",
    "It expects hook JSON on stdin.",
    "",
    "For interactive use, try:",
    "  plannotator review",
    "  plannotator annotate <file.md | file.txt | file.html | https://...>",
    "  plannotator setup-goal interview bundle.json --json",
    "  plannotator last",
    "  plannotator archive",
    "  plannotator sessions",
    "",
    "Run 'plannotator --help' for top-level usage.",
  ].join("\n");
}
