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

export function formatTopLevelHelp(): string {
  return [
    "Usage:",
    "  plannotator --help",
    "  plannotator --version, -v",
    "  plannotator [--browser <name>]",
    "  plannotator review [--git] [--tripwires|-t] [--add-tripwire <description...>] [PR_URL]",
    "  plannotator tripwires <list|add|validate|path>",
    "  plannotator tripwires add <description...> | --glob <g> [--symbol <s>] [--note <text>] [--repo]",
    "  plannotator annotate <file.md | file.html | https://... | folder/>  [--no-jina] [--gate] [--json] [--hook]",
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
    "  plannotator tripwires list",
    "  plannotator annotate <file.md | file.html | https://...>",
    "  plannotator setup-goal interview bundle.json --json",
    "  plannotator last",
    "  plannotator archive",
    "  plannotator sessions",
    "",
    "Run 'plannotator --help' for top-level usage.",
  ].join("\n");
}
