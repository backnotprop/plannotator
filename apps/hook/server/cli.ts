import { GUIDE_CLI_USAGE } from "@plannotator/server/guide-cli";
import { T3_CLI_USAGE } from "@plannotator/t3-code/usage";
import { INBOX_CARD_COLUMNS } from "@plannotator/core/inbox-types";
import { INBOX_REF_LINK_RULE } from "@plannotator/shared/inbox/connection";
import { FEEDBACK_HEREDOC_END } from "@plannotator/core/product-feedback";

const HELP_FLAGS = new Set(["--help", "-h"]);

export interface ParsedStrictAnnotateOptions {
  requireApproval: boolean;
  resultFile?: string;
  remainingArgs: string[];
}

export interface ParsedUninstallOptions {
  purge: boolean;
  yes: boolean;
  dryRun: boolean;
}

/**
 * Parse the deliberately small, non-overlapping uninstall flag surface.
 */
export function parseUninstallOptions(
  args: readonly string[],
): ParsedUninstallOptions {
  let purge = false;
  let yes = false;
  let dryRun = false;

  for (const arg of args) {
    if (arg === "--purge") {
      if (purge) throw new Error("--purge may only be specified once");
      purge = true;
    } else if (arg === "--yes" || arg === "-y") {
      if (yes) throw new Error("--yes/-y may only be specified once");
      yes = true;
    } else if (arg === "--dry-run") {
      if (dryRun) throw new Error("--dry-run may only be specified once");
      dryRun = true;
    } else {
      throw new Error(`Unknown uninstall option: ${arg}`);
    }
  }

  return { purge, yes, dryRun };
}

/**
 * Normal uninstall accepts y/yes. Purge intentionally requires an exact,
 * explicit word so an accidental return key cannot destroy local data.
 */
export function isUninstallConfirmationAccepted(
  answer: string,
  purge: boolean,
): boolean {
  const normalized = answer.trim().toLowerCase();
  return purge
    ? normalized === "purge"
    : normalized === "y" || normalized === "yes";
}

export function parseStrictAnnotateOptions(
  args: string[],
): ParsedStrictAnnotateOptions {
  let requireApproval = false;
  let resultFile: string | undefined;
  const remainingArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--require-approval") {
      if (requireApproval) {
        throw new Error("--require-approval may only be specified once");
      }
      requireApproval = true;
      continue;
    }
    if (arg === "--result-file") {
      if (resultFile !== undefined) {
        throw new Error("--result-file may only be specified once");
      }
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --result-file");
      }
      resultFile = value;
      index += 1;
      continue;
    }
    remainingArgs.push(arg);
  }

  if (!requireApproval && resultFile === undefined) {
    return { requireApproval: false, remainingArgs };
  }
  if (remainingArgs[0] !== "annotate") {
    throw new Error(
      "--require-approval and --result-file are only valid with annotate",
    );
  }
  if (!remainingArgs.includes("--gate") || !remainingArgs.includes("--json")) {
    throw new Error(
      "--require-approval and --result-file require --gate --json",
    );
  }
  if (remainingArgs.includes("--hook")) {
    throw new Error(
      "--require-approval and --result-file cannot be used with --hook",
    );
  }

  return { requireApproval, resultFile, remainingArgs };
}

/** True when any token is a help flag (`--help` / `-h`). */
export function hasHelpFlag(args: string[]): boolean {
  return args.some((arg) => HELP_FLAGS.has(arg));
}

export function isTopLevelHelpInvocation(args: string[]): boolean {
  return args.length > 0 && HELP_FLAGS.has(args[0]);
}

export function isVersionInvocation(args: string[]): boolean {
  return args[0] === "--version" || args[0] === "-v";
}

declare const __CLI_VERSION__: string;

/** The release version baked in at compile time; undefined for dev/source runs. */
export function getCliVersion(): string | undefined {
  return typeof __CLI_VERSION__ !== "undefined" ? __CLI_VERSION__ : undefined;
}

export function formatVersion(): string {
  return `plannotator ${typeof __CLI_VERSION__ !== "undefined" ? __CLI_VERSION__ : "dev"}`;
}

export function isInteractiveNoArgInvocation(
  args: string[],
  stdinIsTTY: boolean | undefined,
): boolean {
  return args.length === 0 && stdinIsTTY === true;
}

/**
 * `plannotator --help`. `board`: the person turned the Inbox's Board on
 * (config.json `inboxBoard`, read by the caller); off (the default), the
 * `card` line is left out, so a person without the Board sees nothing of it.
 */
export function formatTopLevelHelp(options: { board?: boolean } = {}): string {
  return [
    "Usage:",
    "  plannotator --help",
    "  plannotator --version, -v",
    "  plannotator [--browser <name>]",
    "  plannotator review [--git | --gitbutler] [--base <ref>] [--diff-type <type>] [--patch-file <path | ->] [--tailscale] [--gate] [DIRECTORY | PR_URL]",
    "  plannotator annotate <file.md | file.txt | file.html | https://... | folder/>  [--markdown] [--no-jina] [--tailscale] [--gate] [--json] [--hook] [--require-approval] [--result-file <path>]",
    "  plannotator annotate-last [--stdin] [--tailscale] [--gate] [--json] [--hook]",
    "  plannotator copilot-last [--gate] [--json] [--hook]",
    "  plannotator setup-goal <interview|facts> <bundle.json | -> [--json]",
    "  plannotator last",
    "  plannotator archive",
    "  plannotator guide list",
    "  plannotator guide export --id <savedGuideId> | --guide <guide.json> --patch <diff.patch> | --snapshot <snapshot.json> [--out <file.html>]",
    "  plannotator guide share --id <savedGuideId> | --guide <guide.json> --patch <diff.patch> | --snapshot <snapshot.json> [--public] [--ttl <7d>] [--json]",
    "  plannotator guide unshare <id> --token <deleteToken>",
    "  plannotator sessions",
    "  plannotator inbox [--background | --no-open | --open] [--tailscale]",
    "  plannotator inbox mcp",
    "  plannotator inbox status [--json] | stop | restart",
    ...(options.board === true ? ["  plannotator card <create|move|say|link|ship|drop|list> ..."] : []),
    `  plannotator feedback --stdin [--category <bug|idea|other>] [--contact '<text>'] <<'${FEEDBACK_HEREDOC_END}'`,
    "  plannotator update [--check]",
    "  plannotator uninstall [--purge] [--yes] [--dry-run]",
    "  plannotator improve-context",
    "",
    "Run 'plannotator <command> --help' for command-specific usage.",
    "Agents: run 'plannotator inbox --help' for the full guide to the Plannotator Inbox",
    "(what it is, when to use it, its MCP tools, threads, questions, connecting agents).",
    "",
    "Note:",
    "  running 'plannotator' without arguments is for hook integration and expects JSON on stdin",
    "  --browser <name> picks the browser for one run; --browser none opens no browser (the URL is always printed)",
  ].join("\n");
}

/**
 * Subcommands that work but are not released yet. They keep their
 * `<sub> --help` text and stay known to the dispatcher (so they never read as
 * "Unknown command"), but they are left out of everything that advertises the
 * CLI: the top-level help, the "Did you mean" suggestions, and the plannotator
 * knowledge skill (plannotator-skill-reference.test.ts requires a hidden
 * subcommand to be ABSENT from the skill and every other one to be present).
 * To launch one, delete it from this set, add its usage lines to
 * formatTopLevelHelp() and document it in apps/skills/core/plannotator/SKILL.md.
 *
 * `inbox` (the Plannotator Inbox) was the last one to launch. Today: the
 * opt-in T3 Code connection (`t3`, and `t3-hook`, its Claude hook), and
 * `card`, the Board's card call from a shell (approval "inbox-board", step 1),
 * hidden until the Board page ships.
 */
export const HIDDEN_SUBCOMMANDS: ReadonlySet<string> = new Set<string>(["t3", "t3-hook"]);

/**
 * `plannotator card …` (card-command.ts): the Board's card call from a shell,
 * a thin client over the Inbox's `card` MCP tool.
 */
export const CARD_COMMAND_USAGE = [
  "Usage:",
  "  plannotator card create <title> [--column <column>] [--say <text>] [--you <text>] [--thread <id>] [--pr <ref>] [--ref <issue or PR>] [--key <key>]",
  "  plannotator card create --thread <id> [...]      (the thread's subject is the title; pass a short <title> too, as subjects run long)",
  "  plannotator card move <crd_id> <column> [--say <text>] [--you <text>] [--thread <id>] [--pr <ref>] [--ref <issue or PR>] [--reason <text>]",
  "  plannotator card say <crd_id> [<text>] [--you <text>] [--title <text>]",
  "  plannotator card link <crd_id> [--thread <id>] [--pr <ref>] [--ref <issue or PR>] [--say <text>]",
  "  plannotator card ship <crd_id> [--say <text>] [--pr <ref>] [--thread <id>]",
  "  plannotator card drop <crd_id> <reason> [--say <text>]",
  "  plannotator card list [--anyone | --mine] [--all]",
  "",
  "Every command takes [--project <folder>] (default: this folder) and [--json].",
  `Columns: ${INBOX_CARD_COLUMNS.join(", ")} (icebox is the person's only).`,
  "",
  "Keeps a card on the person's Board in the Plannotator Inbox for work that outlasts a reply.",
  "A title is 2–5 words naming the work (\"Pi update fix\"), never a sentence; status goes in --say.",
  "When a card waits on the person, link the Inbox thread where they make the call (--thread), so \"You: …\" opens it.",
  `In --say and --you: ${INBOX_REF_LINK_RULE.replace(/^A/, "a")}`,
  "Works only while the person has the Board on (Inbox Settings → Capabilities); off, it exits 1 with board_off.",
  "Run 'plannotator inbox --help' for the full guide (its card section, shown while the Board is on).",
].join("\n");

/**
 * `plannotator feedback` (feedback-command.ts): sends the person's feedback
 * about Plannotator to its maintainers. The Inbox's Feedback dialog copies a
 * prompt that tells an agent to use it.
 */
export const FEEDBACK_COMMAND_USAGE = [
  "Usage:",
  `  plannotator feedback --stdin [--category <bug|idea|other>] [--contact '<how to reach you>'] <<'${FEEDBACK_HEREDOC_END}'`,
  "  <the message, exactly as the person approved it>",
  `  ${FEEDBACK_HEREDOC_END}`,
  "",
  "Sends feedback about Plannotator to its maintainers and prints \"Sent\".",
  "What is sent: the message, the category and contact if given, the Plannotator",
  "version, the OS name (macOS, Linux, Windows) and that it came from the CLI.",
  "Nothing else: no files, no paths, no session content, no machine id.",
  "",
  "Agents: send only the person's own feedback. Show them the exact text (and",
  "category and contact) first, and run this only after they say yes. Pass the",
  `message on stdin with a QUOTED heredoc (<<'${FEEDBACK_HEREDOC_END}', quotes included)`,
  "so the shell changes nothing. Never put it inside double quotes, in any shell:",
  "they expand $VAR, backticks and $(...). If a line of the message is exactly the",
  "end word, pick another. Put a contact in single quotes, a ' in it written as '\\''.",
  "",
  "Example (bash, zsh, sh):",
  `  plannotator feedback --stdin --category idea --contact 'ada@example.com' <<'${FEEDBACK_HEREDOC_END}'`,
  "  The list jumps to the top after a reload.",
  `  ${FEEDBACK_HEREDOC_END}`,
  "",
  "Example (PowerShell; UTF-8 so accents and emoji survive; a ' in the contact is ''):",
  "  $OutputEncoding = [Text.UTF8Encoding]::new($false)",
  "  @'",
  "  The list jumps to the top after a reload.",
  "  '@ | plannotator feedback --stdin --category idea",
  "",
  "Options:",
  "  --stdin, -       Read the message from stdin (up to 4000 characters)",
  "  --category <c>   bug, idea or other",
  "  --contact <text> An email or handle the person chose to give (optional)",
  "",
  "A short message typed by hand can also be given as words: plannotator feedback 'it works'",
  "",
  "Exit 0 sent, 1 not sent (the reason on stderr), 2 bad usage.",
].join("\n");

/**
 * `plannotator inbox`'s commands and flags. `plannotator inbox --help` prints
 * the full agent guide (inbox-help.ts), which carries this block as its
 * "Commands and flags" section; it is also the `inbox` entry of
 * SUBCOMMAND_HELP, so the skill freshness test reads the same flags.
 * The parser is `runInboxCommand` in inbox-command.ts.
 */
export const INBOX_COMMAND_USAGE = [
  "Usage:",
  "  plannotator inbox [--background | --no-open | --open] [--tailscale]",
  "  plannotator inbox mcp",
  "  plannotator inbox status [--json]",
  "  plannotator inbox stop",
  "  plannotator inbox restart [--tailscale]",
  "  plannotator inbox --notes <ids>",
  "",
  "  plannotator inbox               Start the Inbox and open it in the browser,",
  "                                  or open the one already running",
  "  plannotator inbox --background  Start it detached without opening a browser,",
  "                                  print its URL and exit",
  "  plannotator inbox --no-open     Run it here without opening a browser",
  "  plannotator inbox --open        Open it in the browser and print its URL, starting it",
  "                                  detached first when it is not running. Never blocks:",
  "                                  what the /plannotator-inbox commands run, and how to",
  "                                  find the Inbox's address for the person.",
  "  plannotator inbox --tailscale   Also publish it over the person's tailnet for this",
  "                                  run (tailscale serve, HTTPS, never funnel), for the",
  "                                  Tailscale login that owns this machine only. With",
  "                                  an Inbox already running, asks it to publish.",
  "  plannotator inbox mcp           The stdio MCP server for agents. Starts a stopped",
  "                                  Inbox in the background (no browser tab).",
  "  plannotator inbox status        Whether the Inbox runs: URL, pid, version, data dir.",
  "                                  Exit 0 running, 1 not running, 2 not answering.",
  "                                  --json prints the same as one JSON object.",
  "  plannotator inbox stop          Stop the Inbox of this data dir: asks it first, then",
  "                                  SIGTERM, then SIGKILL, each only once the pid is",
  "                                  proven to be that Inbox (never another program).",
  "                                  Exit 0 when none runs afterwards. An agent's next",
  "                                  call starts it again in the background.",
  "  plannotator inbox restart       Stop it, then start it in the background (no",
  "                                  browser tab) and print its URL. A run published by",
  "                                  --tailscale is published again.",
  "  plannotator inbox --notes <ids> Add the Inbox note to these agents' instructions",
  "                                  files (claude-code, codex, gemini, qwen, pi,",
  "                                  opencode, comma-separated). Only with the",
  "                                  person's yes; starts nothing.",
  "",
  "Over the tailnet at every start: the Inbox's Settings, PLANNOTATOR_INBOX_TAILSCALE=1,",
  "or { \"inboxTailscale\": true } in config.json. Agents and MCP stay on this computer;",
  "another Tailscale login is let in only when config.json inboxTailscaleAllow names it.",
  "",
  "A person's plannotator inbox (not --background) also connects the agents found on",
  "this computer that are not connected yet: a plannotator-inbox MCP server in each",
  "terminal agent and the Claude app, the inbox tool for Pi and OpenCode with",
  "Plannotator's extension or plugin. It never adds back one removed or turned off,",
  "never replaces another plannotator-inbox, and says what it added on stderr.",
  "PLANNOTATOR_INBOX_CONNECT=0 skips it. plannotator uninstall removes what it added.",
].join("\n");

/** `plannotator update`'s usage; the command is update-command.ts. */
export const UPDATE_COMMAND_USAGE = [
  "Usage:",
  "  plannotator update [--check]",
  "",
  "Install the newest Plannotator release now, the way the install script does,",
  "with the choices from your last install (install-flags.json). Open reviews keep",
  "running on the old version; new ones start on the new one.",
  "",
  "Options:",
  "  --check       Only ask GitHub whether a newer release exists; install nothing",
  "",
  "Asks GitHub even when automatic update checks are off (PLANNOTATOR_UPDATE_CHECK=0",
  "or { \"updateCheck\": false }), because you asked. Exit codes: 0 up to date or",
  "updated, 1 the update failed or could not run, 2 usage, 130 interrupted.",
].join("\n");

// Per-subcommand usage text. Keyed by the canonical subcommand token; aliases
// (e.g. `last` → `annotate-last`) are resolved in formatSubcommandHelp().
//
// These exist so an agent (or human) probing `plannotator <sub> --help` gets
// usage on stdout instead of accidentally launching the browser UI — running
// `review --help` used to fall through to local review mode and open a tab.
// Exported so the plannotator knowledge skill's freshness test
// (plannotator-skill-reference.test.ts) can diff the documented surface
// against the real one.
export const SUBCOMMAND_HELP: Record<string, string> = {
  review: [
    "Usage:",
    "  plannotator review [--git | --gitbutler] [--base <ref>] [--diff-type <type>] [--local | --no-local] [--patch-file <path | ->] [--no-git-remote-check] [--tailscale] [--gate] [--json] [DIRECTORY | PR_URL]",
    "",
    "Review local VCS changes or a GitHub, GitLab or Bitbucket Cloud pull request in the browser.",
    "",
    "Options:",
    "  --git         Force git as the VCS (skip auto-detection)",
    "  --gitbutler   Force GitButler as the VCS (requires but 0.21.0+)",
    "  --base <ref>  Open the session against this compare target (branch, origin/<branch>,",
    "                tag, or commit). Session-only; never changes your saved defaults. Git only.",
    "  --diff-type <type>",
    "                Open the session in this diff mode: since-base, local-vs-remote,",
    "                uncommitted, staged, unstaged, last-commit, branch, merge-base, all.",
    "                Session-only; never changes your saved defaults. Git only.",
    "  --local       For PR review, prepare a local checkout for full file access (default)",
    "  --no-local    For PR review, skip the local checkout (diff only)",
    "  --patch-file  Display a static unified diff from a file, or use - for stdin",
    "  --no-git-remote-check",
    "                Never contact the git remote this session: no ls-remote for the",
    "                default branch or the \"behind GitHub\" check. The compare target",
    "                stays what local refs resolve to; Fetch still works. Useful when",
    "                SSH auth costs a hardware-key touch. Also PLANNOTATOR_GIT_REMOTE_CHECK=0",
    "                or { \"gitRemoteCheck\": false } in ~/.plannotator/config.json.",
    "  --tailscale   Publish the loopback session over your tailnet via tailscale serve (HTTPS)",
    "  --gate        You wait for the sign-off: a bare Approve reaches you too. The approval",
    "                is printed either way; an agent host that only logs a bare Approve",
    "                (the Claude Code mod) delivers it as a message.",
    "  --json        Emit one decision/message JSON record instead of plaintext",
    "  PR_URL        GitHub PR, GitLab MR or Bitbucket Cloud PR URL to review",
    "  DIRECTORY     Review a repo, worktree, or multi-repo workspace at this path",
    "                Relative to the invoking directory; quote paths containing spaces.",
    "",
    "  Accepts one DIRECTORY or PR_URL. Neither can be combined with --patch-file.",
    "  A sole word or a path-like word (./x, ../x, a/b, ~/x) is a directory target;",
    "  other words are ignored with a notice.",
    "",
    "JSON output:",
    '  { "decision": "approved" | "annotated" | "dismissed", "message": string }',
    "  message is the rendered plaintext output without its final console newline:",
    "  configured prompts, approval-with-notes framing, and annotation-dependent instructions included.",
    "  This differs from the raw feedback in annotate/opencode-review JSON.",
    "  Identify the outcome by decision, not message text.",
    "",
    "Examples:",
    "  plannotator review",
    "  plannotator review --git",
    "  plannotator review ../feature-worktree",
    "  plannotator review ./backend --diff-type last-commit",
    "  plannotator review --gitbutler",
    "  plannotator review --base feature/part-1   # review one layer of a stacked branch",
    "  plannotator review --patch-file reading.diff",
    "  plannotator review https://github.com/owner/repo/pull/123",
  ].join("\n"),
  annotate: [
    "Usage:",
    "  plannotator annotate <file.md | file.txt | file.html | https://... | folder/> [--markdown] [--no-jina] [--tailscale] [--gate] [--json] [--hook] [--require-approval] [--result-file <path>]",
    "",
    "Open a markdown/text/HTML file, a URL, or a folder of documents in the annotation UI.",
    "Several existing file paths (plannotator annotate spec.md mock.html notes.md) open",
    "as one review, in that order, with one decision for all of them.",
    "",
    "Options:",
    "  --markdown    Convert HTML input to markdown instead of rendering it raw",
    "  --no-jina     Fetch URLs with fetch+Turndown instead of Jina Reader",
    "  --tailscale   Publish the loopback session over your tailnet via tailscale serve (HTTPS)",
    "  --gate        Add an Approve button (review-gate UX)",
    "  --json        Emit a structured decision JSON on stdout",
    "  --hook        Emit hook-native JSON (block/pass) for PostToolUse/Stop hooks",
    "  --require-approval",
    "                Exit 1 unless the reviewer approves (requires --gate --json;",
    "                usage/startup errors exit 2)",
    "  --result-file <path>",
    "                Atomically publish the stdout JSON (requires --gate --json)",
  ].join("\n"),
  "annotate-last": [
    "Usage:",
    "  plannotator annotate-last [--stdin] [--tailscale] [--gate] [--json] [--hook]",
    "  plannotator last [--stdin] [--tailscale] [--gate] [--json] [--hook]",
    "",
    "Annotate the last assistant message from the current agent session.",
    "",
    "Options:",
    "  --stdin       Read the message content from stdin instead of session logs",
    "  --tailscale   Publish the loopback session over your tailnet via tailscale serve (HTTPS)",
    "  --gate        Add an Approve button (review-gate UX)",
    "  --json        Emit a structured decision JSON on stdout",
    "  --hook        Emit hook-native JSON (block/pass) for PostToolUse/Stop hooks",
  ].join("\n"),
  "copilot-last": [
    "Usage:",
    "  plannotator copilot-last [--gate] [--json] [--hook]",
    "",
    "Annotate the last assistant message from the live GitHub Copilot CLI session,",
    "read from its session-state events.jsonl. Normally invoked by the Copilot",
    "plugin's /plannotator-last command.",
    "",
    "Options:",
    "  --gate        Add an Approve button (review-gate UX)",
    "  --json        Emit a structured decision JSON on stdout",
    "  --hook        Emit hook-native JSON (block/pass) for PostToolUse/Stop hooks",
  ].join("\n"),
  "setup-goal": [
    "Usage:",
    "  plannotator setup-goal <interview|facts> <bundle.json | -> [--json]",
    "",
    "Open the goal-setup question (interview) or facts-acceptance UI for /goal workflows.",
    "Pass '-' to read the bundle JSON from stdin.",
    "",
    "Options:",
    "  --json        Emit compact JSON instead of pretty-printed output",
  ].join("\n"),
  archive: [
    "Usage:",
    "  plannotator archive",
    "",
    "Open a read-only browser for saved plan decisions in ~/.plannotator/plans/.",
  ].join("\n"),
  guide: GUIDE_CLI_USAGE,
  "improve-context": [
    "Usage:",
    "  plannotator improve-context",
    "",
    "Hook-integration command spawned by the PreToolUse hook on EnterPlanMode.",
    "Reads the hook event on stdin and emits additionalContext JSON (PFM reminder",
    "and/or compound improvement hook), or exits silently when nothing is enabled.",
    "Not intended to be run directly.",
  ].join("\n"),
  sessions: [
    "Usage:",
    "  plannotator sessions [--open [N]] [--clean] [--json]",
    "",
    "List active Plannotator server sessions.",
    "",
    "Options:",
    "  --open [N]    Reopen session #N (default 1) in the browser",
    "  --clean       Remove stale session entries",
    "  --json        Print the sessions as a JSON array on stdout (index, mode, reviewId, target, url, ...)",
  ].join("\n"),
  // `inbox --help` prints the full agent guide instead (index.ts, inbox-help.ts).
  inbox: INBOX_COMMAND_USAGE,
  update: UPDATE_COMMAND_USAGE,
  uninstall: [
    "Usage:",
    "  plannotator uninstall [--purge] [--yes | -y] [--dry-run]",
    "",
    "Remove Plannotator-installed components. Local plans, history, drafts,",
    "settings, and other Plannotator data are preserved by default.",
    "",
    "Options:",
    "  --purge       Also permanently delete known local Plannotator data",
    "  --yes, -y     Skip the interactive confirmation (required without a TTY)",
    "  --dry-run     Preview recognized removal work without changing anything",
    "",
    "Purge data is local-only: it is not stored on a Plannotator server and",
    "cannot be recovered after purge. Unrecognized custom files are preserved.",
  ].join("\n"),
  // The Board's cards; and, unreleased (HIDDEN_SUBCOMMANDS), the opt-in T3 Code connection.
  t3: T3_CLI_USAGE,
  card: CARD_COMMAND_USAGE,
  feedback: FEEDBACK_COMMAND_USAGE,
  "t3-hook": [
    "Usage:",
    "  plannotator t3-hook install --settings <settings.json> --executable <plannotator>",
    "  plannotator t3-hook remove --settings <settings.json>",
    "",
    "Internal: the Claude Bash hook of the opt-in T3 Code connection and its",
    "settings helper (install.sh --with-t3 / --without-t3). Agents never run it.",
  ].join("\n"),
};

// Aliases share another subcommand's help text.
// Exported for the same freshness test as SUBCOMMAND_HELP.
export const SUBCOMMAND_HELP_ALIASES: Record<string, string> = {
  last: "annotate-last",
};

/**
 * Returns the canonical subcommand name when `args` is a `<sub> ... --help`
 * invocation for a user-facing subcommand, or null otherwise. Lets the CLI
 * print usage and exit before a subcommand branch can launch the UI.
 */
export function isSubcommandHelpInvocation(args: string[]): string | null {
  const sub = args[0];
  if (!sub) return null;
  const canonical = SUBCOMMAND_HELP_ALIASES[sub] ?? sub;
  if (!(canonical in SUBCOMMAND_HELP)) return null;
  return hasHelpFlag(args.slice(1)) ? canonical : null;
}

/** Usage text for a canonical subcommand (falls back to top-level help). */
export function formatSubcommandHelp(subcommand: string): string {
  return SUBCOMMAND_HELP[subcommand] ?? formatTopLevelHelp();
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
    "  plannotator inbox",
    "  plannotator update",
    "  plannotator uninstall",
    "",
    "Run 'plannotator --help' for top-level usage.",
  ].join("\n");
}
