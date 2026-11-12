import { INBOX_ROWS_USAGE_LINE } from "@plannotator/core/inbox-types";
import { GUIDE_CLI_USAGE } from "@plannotator/server/guide-cli";
import { T3_CLI_USAGE } from "@plannotator/t3-code/usage";
import { INBOX_CARD_COLUMNS, INBOX_CARD_INITIATIVE_CLEAR_OUT, INBOX_CARD_INITIATIVE_FIELD, INBOX_CARD_INITIATIVE_RULE } from "@plannotator/core/inbox-types";
import { INBOX_REF_LINK_RULE, INBOX_TOOL_ACTIONS } from "@plannotator/shared/inbox/connection";
import { FEEDBACK_HEREDOC_END } from "@plannotator/core/product-feedback";
import { SHAPE_GUIDE, SHAPE_HELP_INTRO } from "@plannotator/core/shape-skill";
import { INBOX_LINK_USAGE } from "./inbox-link-command";
import { LOCKFILE_NAMES, SYSTEM_COMMANDS, SYSTEM_TICK_INTERVAL_SECONDS, TEST_FOLDERS } from "@plannotator/system/commands";

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

/** The subcommands that take `--title`: the ones that open a page in a tab. */
export const TITLE_COMMANDS: ReadonlySet<string> = new Set(["review", "annotate", "annotate-last", "last"]);

export interface ParsedTitleOption {
  /** The tab title the caller chose, whitespace collapsed; absent when not given or blank. */
  title?: string;
  remainingArgs: string[];
}

/**
 * Take `--title <text>` out of the arguments (#2289). The text becomes the
 * whole tab title, as given: runs of whitespace (a newline included) collapse
 * to one space, the ends are trimmed, and nothing is cut, so the browser
 * truncates a long title the way it truncates any other. A blank title is the
 * same as none. Throws on a missing value, a second `--title`, or a command
 * that opens no page.
 */
export function parseTitleOption(args: string[]): ParsedTitleOption {
  let title: string | undefined;
  let seen = false;
  const remainingArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--title") {
      remainingArgs.push(arg);
      continue;
    }
    if (seen) throw new Error("--title may only be specified once");
    seen = true;
    const value = args[index + 1];
    // Like --result-file: a following flag is a forgotten value, not a title.
    if (value === undefined || value.startsWith("--")) throw new Error("Missing value for --title");
    const collapsed = value.replace(/\s+/g, " ").trim();
    if (collapsed) title = collapsed;
    index += 1;
  }
  if (seen && !TITLE_COMMANDS.has(remainingArgs[0] ?? "")) {
    throw new Error("--title is only supported with: plannotator review, annotate, annotate-last (last)");
  }
  return title === undefined ? { remainingArgs } : { title, remainingArgs };
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
    "  plannotator review [--git | --gitbutler] [--base <ref>] [--diff-type <type>] [--patch-file <path | ->] [--title <text>] [--tailscale] [--gate] [DIRECTORY | PR_URL]",
    "  plannotator annotate <file.md | file.txt | file.html | https://... | folder/>  [--markdown] [--no-jina] [--title <text>] [--tailscale] [--gate] [--json] [--hook] [--require-approval] [--result-file <path>]",
    "  plannotator annotate-last [--stdin] [--title <text>] [--tailscale] [--gate] [--json] [--hook]",
    "  plannotator copilot-last [--gate] [--json] [--hook]",
    "  plannotator setup-goal <interview|facts> <bundle.json | -> [--json]",
    "  plannotator last",
    "  plannotator archive",
    "  plannotator guide list",
    "  plannotator guide export --id <savedGuideId> | --guide <guide.json> --patch <diff.patch> | --snapshot <snapshot.json> [--out <file.html>]",
    "  plannotator guide share --id <savedGuideId> | --guide <guide.json> --patch <diff.patch> | --snapshot <snapshot.json> [--public] [--ttl <7d>] [--json]",
    "  plannotator guide unshare <id> --token <deleteToken>",
    "  plannotator guide import --guide <guide.json> --patch <diff.patch> | --snapshot <snapshot.json> [--pr <url>]",
    "  plannotator sessions",
    "  plannotator data-dir",
    "  plannotator inbox [--background | --no-open | --open [<thread>]] [--tailscale]",
    "  plannotator inbox mcp [--t3]",
    "  plannotator inbox status [--json] | stop | restart",
    "  plannotator inbox projects [combine <project id> --into <project id> | undo <project id>] [--json]",
    "  plannotator inbox call [--session <id>] <action> [<json> | -]",
  "  plannotator inbox connection --host <host> [--plugin-version <v>] [--no-wake]",
    "  plannotator t3 login | logout --url <T3 MCP URL>",
    ...(options.board === true ? ["  plannotator card <create|move|say|link|ship|drop|list|initiative_delete> ..."] : []),
    `  plannotator feedback --stdin [--category <bug|idea|other>] [--contact '<text>'] <<'${FEEDBACK_HEREDOC_END}'`,
    "  plannotator update [--check]",
    "  plannotator uninstall [--purge] [--yes] [--dry-run]",
    "  plannotator improve-context",
    "",
    "Run 'plannotator <command> --help' for command-specific usage.",
    "Agents: run 'plannotator inbox --help' for the full guide to the Plannotator Inbox",
    "(what it is, when to use it, its MCP tools, threads, questions, connecting agents).",
    "Using T3 Code? Run 'plannotator t3 --help'.",
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
 * `t3` (the T3 Code connection) was the last one to launch. Today:
 * `t3-hook`, the T3 Claude hook's settings helper, which only the installer
 * runs; `shape`; and `system`, System's drawing commands, until the Inbox's
 * System surfaces ship.
 */
export const HIDDEN_SUBCOMMANDS: ReadonlySet<string> = new Set<string>(["t3-hook", "shape", "system"]);

/**
 * `plannotator card …` (card-command.ts): the Board's card call from a shell,
 * a thin client over the Inbox's `card` MCP tool.
 */
export const CARD_COMMAND_USAGE = [
  "Usage:",
  "  plannotator card create <title> [--column <column>] [--say <text>] [--you <text>] [--thread <id>] [--pr <ref>] [--ref <issue or PR>] [--key <key>] [--initiative <name>]",
  "  plannotator card create --thread <id> [...]      (the thread's subject is the title; pass a short <title> too, as subjects run long)",
  "  plannotator card move <crd_id> <column> [--say <text>] [--you <text>] [--thread <id>] [--pr <ref>] [--ref <issue or PR>] [--reason <text>]",
  "  plannotator card say <crd_id> [<text>] [--you <text>] [--title <text>] [--initiative <name>]",
  "  plannotator card link <crd_id> [--thread <id>] [--pr <ref>] [--ref <issue or PR>] [--say <text>]",
  "  plannotator card ship <crd_id> [--say <text>] [--pr <ref>] [--thread <id>]      (moves it to done)",
  "  plannotator card drop <crd_id> <reason> [--say <text>]",
  "  plannotator card initiative_delete <name or ini_id>      (its cards stay, in no initiative)",
  "  plannotator card list [--anyone | --mine] [--all]",
  "",
  "Every command takes [--project <folder>] (default: your Claude Code or Pi session's project, else this folder) and [--json].",
  `Columns: ${INBOX_CARD_COLUMNS.join(", ")}. A column is where the work stands: todo (asked, not started; the default),`,
  "in_progress (you are on it), in_review (your part handed over; give --you), done (merged, live or finished), dropped (cancelled), backlog (not asked for yet).",
  "A card the person put in backlog is theirs to move. Ship a card when you see its PR merge (the Board may also move it to done once every --pr PR merged).",
  "",
  "Keeps a card on the person's Board in the Plannotator Inbox for work that outlasts a reply.",
  "A title is 2–5 words naming the work (\"Pi update fix\"), never a sentence; status goes in --say.",
  `--initiative: ${INBOX_CARD_INITIATIVE_FIELD} ${INBOX_CARD_INITIATIVE_RULE} ${INBOX_CARD_INITIATIVE_CLEAR_OUT}`,
  "When you move a card to in_review, link the Inbox thread where the person makes the call (--thread), so \"You: …\" opens it.",
  "--ref: an issue or PR as owner/repo#123, or any http(s) link with its scheme (https://…). GitHub and GitLab issues and PRs show their live state; a Jira or YouTrack issue link shows its key; any other link shows as a plain link.",
  `In --say and --you: ${INBOX_REF_LINK_RULE.replace(/^A/, "a")}`,
  "Works only while the person has the Board on (Inbox Settings → Capabilities); off, it exits 1 with board_off.",
  "Run 'plannotator inbox --help' for the full guide (its card section, shown while the Board is on).",
].join("\n");

/**
 * `plannotator shape …` (shape-command.ts): an agent's side of Shape.
 * Unreleased (HIDDEN_SUBCOMMANDS). Built from the one source of Shape's agent
 * text (packages/core/shape-skill.ts): the welcome and the commands, then the
 * drawing guide the Inbox's `/shape` skill ends with too.
 */
export const SHAPE_COMMAND_USAGE = `${SHAPE_HELP_INTRO}\n\n${SHAPE_GUIDE}`.trimEnd();

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

/** Words in lines of at most `width` characters, each indented by `indent` spaces. */
function wrapWords(text: string, indent: number, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && indent + line.length + 1 + word.length > width) {
      lines.push(" ".repeat(indent) + line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(" ".repeat(indent) + line);
  return lines;
}

/**
 * `plannotator system …` (system-command.ts): System's drawing of a project,
 * for the agents that draw it and the launchd job that keeps it current. The
 * usage lines are the package's SYSTEM_COMMANDS, which its recipes name too.
 * Unreleased (HIDDEN_SUBCOMMANDS) while the Inbox's System surfaces are built.
 * An agent reads only this text, so it says what each command reads, prints
 * and refuses (AGENTS.md: agent-facing text is tested clean room).
 */
export const SYSTEM_COMMAND_USAGE = [
  "Usage:",
  ...Object.values(SYSTEM_COMMANDS).map((line) => `  ${line}`),
  "",
  "System is a drawing of a project's code, kept in <data dir>/system/<key>/drawing/:",
  "system.yaml (every part and line), sheets/<CODE>.yaml (the views) and revisions/.",
  "In system.yaml the parts (under parts:) and the lines between them (under flows:)",
  "name the files they rest on in code:, in two shapes:",
  "  a part:  code: { <path>: <what that file does for it>, ... }, for example",
  "             store: { name: Store, code: { src/store/db.ts: reads invoices } }",
  "  a line:  code: { from: <path>, to: <path> }, the file at each end (either may be",
  "           left out), for example",
  "             call: { from: cli, to: server, code: { from: src/cli.ts, to: src/server/routes.ts } }",
  "A path is relative to the repo's root, and a folder covers every file in it;",
  "<alias>:<path> is a file in another repo, named under sources.repos.",
  "sources.repos.self.at is the commit the drawing was drawn from. None of these",
  "commands edits a file in the repo.",
  "",
  "check, gate, tick and revision read the drawing folder as it is on disk, so a fix to",
  "it counts at once. Nothing is committed, branched or pushed in the repo: the drawing",
  "stays in the drawing folder.",
  "",
  "Every command prints its result on stdout and nothing else: check one line per",
  "finding (or one JSON value with --json), the others one JSON value. Exit 0 ok, 1",
  "failed, 2 bad usage. When a command fails, stdout is empty and stderr has one line",
  "per problem, <code>: <message>. The codes: usage (exit 2); not_a_folder (a folder",
  "flag names no folder); no_drawing, drawing_broken and git_failed (check, gate,",
  "revision); tick_failed; revision_refused; not_installed, unsupported and",
  "launchctl_failed (schedule); failed (anything else). check is the one exception:",
  "its findings are its result, on stdout, and stderr gets one line, not_clean:",
  "<counts>, with exit 1.",
  "",
  "check: is the drawing right?",
  "  Loads the drawing, then looks every cited path up in the repo's git tree at",
  "  sources.repos.self.at. A cited file must be committed at that commit: a file only",
  "  on disk (untracked, or committed later) does not count, nor does a symlink. Case",
  "  matters. The drawing itself is read from disk, so an edit counts at once. One line",
  "  per finding:",
  "    error: <file> <field>: <message>      the drawing does not load as written",
  "    warning: <file> <field>: <message>",
  "    missing: <path> (cited by <field>; not in the repo at <commit>)",
  "    clean: <drawing folder>               no findings",
  "  <field> is where system.yaml cites the path: parts.<id>.code for a part, and",
  "  flows.<id>.code.from or flows.<id>.code.to for a line's end. After the findings,",
  "  stderr gets one line, for example not_clean: 0 errors, 0 warnings, 1 missing path.",
  "  Fix a missing path in system.yaml: cite the file's real path at that commit",
  "  (git -C <repo folder> ls-tree -r --name-only <commit> lists them), or drop the",
  "  citation when the file is gone. Run check again until it prints clean.",
  "  --root <repo folder>     The repo: the project's checkout, or Plannotator's clone of",
  "                           it, <data dir>/system/<key>/source. Default: the repo the",
  "                           current folder is in.",
  "  --dir <drawing folder>   The drawing. Default: <data dir>/system/<key>/drawing,",
  "                           <key> the Inbox's key for the --root folder.",
  "  --repo <alias>=<folder>  A checkout of a repo named in sources.repos, to check its",
  "                           <alias>:<path> citations. Repeat for each. Without it they",
  "                           are not checked, and a warning says so.",
  "  --at <commit>            Check this repo's paths at this commit (a sha, a branch, a",
  "                           tag, HEAD) instead of sources.repos.self.at.",
  "  --json                   One JSON value: { ok, errors, warnings, missing, cited_by }.",
  "                           errors and warnings hold { file, field, message }; cited_by",
  "                           maps each missing path to the fields that cite it.",
  "  Exit 0 clean, 1 findings (not_clean) or a failure, 2 bad usage.",
  "",
  "gate: what does a change touch, and does the drawing need a redraw?",
  "  Compares the files changed from --from to --to (git diff --name-status -M, read",
  "  only) with the files the drawing cites. --from and --to are anything git names as",
  "  a commit (a sha, a branch, a tag), diffed exactly as given: the command does not",
  "  look for a merge base. To gate a branch, compute where it left main yourself and",
  "  pass that sha: --from \"$(git merge-base main <branch>)\" --to <branch>.",
  "  The drawing is read from the drawing folder as it is now; no branch is checked out,",
  "  and whichever one is checked out in the repo does not matter. touched names the",
  "  parts and lines of that drawing.",
  "  --project <repo folder>  The repo. Default: as check's --root.",
  "  --dir <drawing folder>   The drawing. Default: as check's --dir, for --project.",
  "  Prints one JSON value:",
  '    { "touched": { "parts": [<id>...], "flows": [<id>...] }, "wake": true | false,',
  '      "why": [{ "path": <path>, "reason": <reason> }...], "ignored": [<path>...] }',
  "  touched  The ids (keys under parts: and flows:) of every part and line that cites a",
  "           changed file, or a folder holding one: what the change touches, and what",
  "           may now be stale.",
  "  wake     true when the change may alter the drawing's shape, so it wants a redraw:",
  "           a file was added, deleted or renamed, or an edited file matches a watch:",
  "           glob. Other edits to files that already exist do not wake it, cited or not.",
  "  why      Each file that woke it, with exactly one reason:",
  "             added       a new file, or a copy of one (the new path)",
  "             cited-gone  a file deleted, or renamed away, whose exact path a part or",
  "                         line cites; the path given is the old one",
  "             deleted     any other deleted file (one inside a cited folder included)",
  "             renamed     any other renamed file; the path given is the new one",
  "             watched     an edited file that matches a watch: glob",
  "           So a deleted file a part cites by its own path gets cited-gone, never also",
  "           deleted. why is empty when wake is false.",
  "  watch:   An optional top-level key in system.yaml: a list of path globs, relative to",
  "           the repo's root, whose edits count as a shape change (** crosses folders,",
  "           * and ? stay inside one). For example:",
  "             watch: [wrangler.toml, config/**/*.yaml]",
  "  ignored  Changed files the gate skips: they never wake it and touch nothing. A file",
  "           is skipped when it is:",
  "             a test      a folder anywhere in its path named",
  ...wrapWords(TEST_FOLDERS.join(", "), 25, 86),
  "                         or a name ending .test.<ext> or .spec.<ext>, <ext> one of",
  "                         js, jsx, ts, tsx, with an optional c or m first (mjs, cts)",
  "             a doc       a name ending .md or .mdx (any case), or a folder named docs",
  "                         anywhere in its path",
  "             a lockfile  a file, in any folder, named",
  ...wrapWords(LOCKFILE_NAMES.join(", "), 25, 86),
  "             a drawing   anything under .plannotator/system/ (a repo's own drawing)",
  "           A rename is skipped only when both its paths are. A part or line that cites",
  "           such a file by its exact path makes it count like any other file; a cited",
  "           folder does not.",
  "",
  "tick: one scheduled check of one project (the launchd job runs it)",
  "  Fetches the default branch, gates from the last checked commit to its tip, and when",
  "  the gate wakes, runs the person's agent in Plannotator's clone of the project",
  "  (<data dir>/system/<key>/source) to redraw a copy of the drawing, puts the copy in",
  "  the drawing folder once it checks clean, and sends one Inbox note. Nothing is",
  "  committed, branched or pushed in the repo. Reads",
  "  <data dir>/system/<key>/setup.json, which the Inbox writes when the person sets the",
  "  project up; without it nothing runs. <key> is the Inbox's key for the project.",
  '  Prints { "ran": "nothing" | "gated" | "redrew", "gated": <commit>, "why"?,',
  '  "note"? }. A failed tick exits 1.',
  "",
  "revision: store an open pull request's change, for the Inbox to draw",
  "  Reads one revision (format 1 YAML, the open form: new parts as full entries with",
  "  place:) on stdin, loads it against the drawing in <data dir>/system/<key>/drawing,",
  "  and stores it as",
  "  <data dir>/system/<key>/reviews/<host>/<owner>/<repo>/<n>@<head, 7 characters>.yaml.",
  "  A revision that does not load is refused with one line per problem, naming its",
  "  field; fix it and send it again. Its pr: and repo: must match --pr. --head is the",
  "  pull request's head commit, as a sha. <key> is the Inbox's key for the --project",
  "  folder. Nothing is committed anywhere.",
  '  Prints { "stored": <path>, "revision": <id>, "pr": <host/owner/repo#n>, "head": <sha> }.',
  "",
  `schedule: the launchd job that runs tick every ${SYSTEM_TICK_INTERVAL_SECONDS / 60} minutes while the Mac is awake`,
  "  (macOS only)",
  "  install writes ~/Library/LaunchAgents/ai.plannotator.system.<key>.plist and loads",
  "  it; remove unloads it and deletes the plist; list prints the keys that have one, as",
  "  one JSON array. The job runs the installed plannotator binary, so install refuses",
  "  to run from a source checkout.",
  `  The job runs a first check as soon as install loads it, then every ${SYSTEM_TICK_INTERVAL_SECONDS / 60} minutes.`,
  "",
  "<data dir> is what 'plannotator data-dir' prints (PLANNOTATOR_DATA_DIR when set).",
].join("\n");

/** `plannotator inbox projects …` (inbox-projects-command.ts): list, combine and undo, on the person's request. */
export const INBOX_PROJECTS_USAGE = [
  "Usage:",
  "  plannotator inbox projects [--json]",
  "  plannotator inbox projects combine <project id> --into <project id> [--json]",
  "  plannotator inbox projects undo <project id> [--json]",
  "",
  "Lists the Inbox's projects, combines one into another, and undoes a combine.",
  "A combine applies right away, and an undo works at any time, from any session.",
  "Run 'plannotator inbox --help' for when to use it.",
].join("\n");

/** What `plannotator inbox call` runs: the Inbox tool's actions. */
export const INBOX_CALL_ACTIONS: readonly string[] = INBOX_TOOL_ACTIONS;

/** `plannotator inbox call …` (inbox-call-command.ts): the Inbox tool from a script. */
export const INBOX_CALL_USAGE = [
  "Usage:",
  "  plannotator inbox call [--session <id>] <action> [<json> | -]",
  "",
  "Runs one Inbox action from a shell, so a script can make many fixes in one go.",
  // `steps` is left out: it is served only while the person has thread steps on, and the guide names it then.
  `Actions: ${INBOX_CALL_ACTIONS.filter((action) => action !== "steps").join(", ")}. The JSON holds the action's fields, as in`,
  "'plannotator inbox --help'; - reads it from stdin (for PowerShell and for loops, where",
  "quoting JSON is painful). A stopped Inbox starts in the background.",
  "",
  "  plannotator inbox call card '{\"op\":\"list\"}'",
  "  plannotator inbox call card '{\"op\":\"ship\",\"card_id\":\"crd_1\"}'",
  "  plannotator inbox call send_message '{\"reply_to\":\"msg_2\",\"body\":\"Settled.\",\"supersedes\":[\"msg_1\"],\"done\":[\"msg_2\"],\"idempotency_key\":\"tidy-1\"}'",
  "  plannotator inbox call send_message - < reply.json",
  "  Get-Content reply.json -Raw | plannotator inbox call send_message -     (PowerShell)",
  "",
  "--session <id>  Who is calling, when your Tidy gave you the value. Otherwise the session",
  "                this shell names, else nobody in particular (as a raw MCP client).",
  "",
  "stdout is the result as one JSON value, and nothing on failure. Pass an idempotency_key",
  "on each send_message and card create, so a rerun cannot post twice.",
  "Exit 0 ok, 1 refused or no Inbox (<code>: <message> on stderr), 2 bad usage.",
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
  "  plannotator inbox [--background | --no-open | --open [<thread>]] [--tailscale]",
  "  plannotator inbox mcp [--t3]",
  "  plannotator inbox status [--json]",
  "  plannotator inbox stop",
  "  plannotator inbox restart [--tailscale]",
  "  plannotator inbox projects [--json]",
  "  plannotator inbox projects combine <project id> --into <project id> [--json]",
  "  plannotator inbox projects undo <project id> [--json]",
  INBOX_ROWS_USAGE_LINE,
  "  plannotator inbox icon set <file> --request <id> [--json]",
  "  plannotator inbox call [--session <id>] <action> [<json> | -]",
  "  plannotator inbox pulls ls|add|rm [--session <id>] <thread> [<ref>... | --all]",
  "  plannotator inbox export-decisions --thread <id> [--format md|html] [--out <file>] [--pr <ref>]",
  "  plannotator inbox link --offer [--tailscale] | link <code> | link --list",
  "  plannotator inbox unlink <machine>",
  "  plannotator inbox --notes <ids>",
  "  plannotator inbox permission-hook",
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
  "  plannotator inbox --open <thread>  Show that thread in the open Inbox window, or open one.",
  "  plannotator inbox --tailscale   Also publish it over the person's tailnet for this",
  "                                  run (tailscale serve, HTTPS, never funnel), for the",
  "                                  Tailscale login that owns this machine only. With",
  "                                  an Inbox already running, asks it to publish.",
  "  plannotator inbox mcp           The stdio MCP server for agents. Starts a stopped",
  "                                  Inbox in the background (no browser tab).",
  "                                  --t3: for T3 Code (plannotator t3 --help); lists",
  "                                  its tools only inside a T3 Code thread.",
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
  "  plannotator inbox projects      List the projects, combine one into another, undo a",
  "                                  combine: when the person asks to clean them up.",
  "  plannotator inbox icon set      Hand back an animated agent icon, only when an Inbox",
  "                                  message asked you to (its request id starts ia_).",
  "  plannotator inbox call          Run one Inbox action from a script: JSON in, one JSON",
  "                                  result on stdout. See 'Scripting the Inbox'.",
  "  plannotator inbox pulls         A thread's PRs: list them, add or remove some",
  "                                  (owner/repo#123, group/project!45 or the URL).",
  "  plannotator inbox export-decisions",
  "                                  A thread's decisions as a file; --pr puts them on",
  "                                  one of its PRs, updated in place when run again.",
  ...INBOX_LINK_USAGE,
  "  plannotator inbox --notes <ids> Add the Inbox note to these agents' instructions",
  "                                  files (claude-code, codex, gemini, qwen, pi,",
  "                                  opencode, comma-separated). Only with the",
  "                                  person's yes; starts nothing.",
  "  plannotator inbox permission-hook",
  "                                  Claude Code's permission hook in sessions the Inbox",
  "                                  started (their settings file runs it). Never run it.",
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

/**
 * `plannotator data-dir` (index.ts): the data directory this Plannotator
 * reads and writes, so skills and agents never have to work it out (#2305).
 */
export const DATA_DIR_COMMAND_USAGE = [
  "Usage:",
  "  plannotator data-dir",
  "",
  "Print the absolute path of Plannotator's data directory (plans/, history/,",
  "config.json, hooks/, ...) and exit. Creates nothing.",
  "",
  "Resolution: PLANNOTATOR_DATA_DIR when set; else ~/.plannotator when it exists,",
  "unless it holds no Plannotator data while $XDG_DATA_HOME/plannotator does; else",
  "$XDG_DATA_HOME/plannotator when XDG_DATA_HOME is an absolute path; else",
  "~/.plannotator. When both folders exist, stderr names the one not used; it may",
  "hold older Plannotator data, so leave it alone.",
  "",
  "Agents: use this path instead of writing ~/.plannotator. Creating ~/.plannotator",
  "on an install that keeps its data elsewhere can hide that data.",
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
    "  plannotator review [--git | --gitbutler] [--base <ref>] [--diff-type <type>] [--local | --no-local] [--patch-file <path | ->] [--no-git-remote-check] [--title <text>] [--tailscale] [--gate] [--json] [DIRECTORY | PR_URL]",
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
    "                or { \"gitRemoteCheck\": false } in the data dir's config.json.",
    "  --title <text>",
    "                Name the browser tab this, in place of \"<repo> · Code Review\"",
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
    "  plannotator annotate <file.md | file.txt | file.html | https://... | folder/> [--markdown] [--no-jina] [--title <text>] [--tailscale] [--gate] [--json] [--hook] [--require-approval] [--result-file <path>]",
    "",
    "Open a markdown/text/HTML file, a URL, or a folder of documents in the annotation UI.",
    "Several existing file paths (plannotator annotate spec.md mock.html notes.md) open",
    "as one review, in that order, with one decision for all of them.",
    "",
    "Options:",
    "  --markdown    Convert HTML input to markdown instead of rendering it raw",
    "  --no-jina     Fetch URLs with fetch+Turndown instead of Jina Reader",
    "  --title <text>",
    "                Name the browser tab and the header this, in place of the file",
    "                or folder name, whichever document is open",
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
    "  plannotator annotate-last [--stdin] [--title <text>] [--tailscale] [--gate] [--json] [--hook]",
    "  plannotator last [--stdin] [--title <text>] [--tailscale] [--gate] [--json] [--hook]",
    "",
    "Annotate the last assistant message from the current agent session.",
    "",
    "Options:",
    "  --stdin       Read the message content from stdin instead of session logs",
    "  --title <text>",
    "                Name the browser tab and the header this, in place of \"Last message\"",
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
    "Open a read-only browser for saved plan decisions in the plans/ folder of the",
    "data directory ('plannotator data-dir' prints it).",
  ].join("\n"),
  "data-dir": DATA_DIR_COMMAND_USAGE,
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
  shape: SHAPE_COMMAND_USAGE,
  feedback: FEEDBACK_COMMAND_USAGE,
  system: SYSTEM_COMMAND_USAGE,
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
  // `inbox projects --help` is that command's own usage, not the whole guide.
  if (canonical === "inbox" && (args[1] === "projects" || args[1] === "rows" || args[1] === "icon" || args[1] === "connection")) return null;
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
