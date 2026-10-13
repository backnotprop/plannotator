/**
 * `plannotator inbox --help`: the Plannotator Inbox guide for agents.
 *
 * One markdown document an agent with no skill installed can read once and
 * then use the Inbox well. Every fact that can drift comes from the code it
 * describes, never a copy:
 *
 *   - the MCP tool names: INBOX_MCP_TOOLS (packages/server/inbox-mcp.ts), and
 *     TOOL_GUIDE is typed by it, so a tool added there fails to compile here;
 *     inbox-help.test.ts also checks every argument named here against the
 *     schemas a real Inbox serves;
 *   - the question syntax: QUESTION_AUTHORING_GUIDE, verbatim;
 *   - the list's section names: INBOX_SECTIONS;
 *   - the agent tool's name, filled arguments and per-host defaults:
 *     INBOX_TOOL_NAME, INBOX_FILLED_ARGUMENTS, INBOX_TOOL_DEFAULTS;
 *   - the per-harness MCP setup: HARNESSES / harnessPanel
 *     (packages/inbox/harnesses.ts, the window's own "Connect an agent");
 *   - the commands and flags: INBOX_COMMAND_USAGE (cli.ts).
 *
 * Pure: the caller passes the command that runs this CLI, the data dir and
 * the platform.
 */

import { INBOX_SECTIONS, INBOX_THREAD_NAME_MAX, type InboxSectionId } from "@plannotator/core/inbox-types";
import { QUESTION_AUTHORING_GUIDE } from "@plannotator/core/question-block";
import { INBOX_SET_ASIDE_HEADING } from "@plannotator/core/inbox-questions";
import { HARNESSES, harnessPanel, shellLine, type ConnectContext, type Harness } from "@plannotator/inbox/harnesses";
import { join } from "node:path";
import { INBOX_MCP_TOOLS, INBOX_WAIT_DEFAULT_MS, INBOX_WAIT_MAX_SECONDS } from "@plannotator/server/inbox-mcp";
import { INBOX_TOOL_DEFAULTS, INBOX_TOOL_HOSTS } from "@plannotator/shared/config";
import { INBOX_FILLED_ARGUMENTS, INBOX_TOOL_NAME } from "@plannotator/shared/inbox/connection";
import { INBOX_COMMAND_USAGE } from "./cli";
import { createAgentEnvironment, displayPath, type AgentEnvironment } from "@plannotator/server/inbox-agents";
import { noteTarget } from "@plannotator/server/inbox-agent-notes";
import { INBOX_AGENT_LABELS, INBOX_NOTE_AGENT_IDS } from "@plannotator/core/inbox-types";

export type InboxMcpToolName = (typeof INBOX_MCP_TOOLS)[number];

export interface InboxToolGuide {
  /** Arguments worth naming (the filled ones are covered once, above the tools). */
  args: readonly string[];
  lines: readonly string[];
}

/** The `http://127.0.0.1:<port>/mcp` address with the port left open: it changes. */
export const INBOX_HELP_MCP_URL = "http://127.0.0.1:<port>/mcp";

/**
 * The guide's example of the Inbox-only lines, as a whole block.
 * inbox-help.test.ts parses it with the store's own parser.
 */
export const INBOX_QUESTION_EXAMPLE = [
  ":::question",
  "Which queue should failed webhook deliveries retry on?",
  "",
  "Retries now share the jobs queue, so one slow customer endpoint delays every other job. [The load test](load-test.html) shows the delay. A separate queue keeps that delay to retries.",
  "",
  "Stopped: the retry worker cannot start until this is settled",
  "",
  "Holds up: webhook-retries; delivery-dashboard",
  "",
  "Decision: when answered",
  "",
  "- [ ] The existing jobs queue - no new infrastructure",
  "- [ ] A dedicated retries queue - isolates slow retries",
  "",
  "Recommended: A dedicated retries queue",
  ":::",
].join("\n");

/**
 * The guide's example of a question that replaces an earlier one (a
 * `Replaces:` line). inbox-help.test.ts parses it with the store's own
 * parser; the id is a well-formed placeholder.
 */
export const INBOX_REPLACES_EXAMPLE = [
  ":::question",
  "Replaces: msg_01M4H6G73M9H3Z32T859E72DPY/q-4f7db09f",
  "How many times should the jobs queue retry a webhook before it gives up?",
  "",
  "You moved retries into the jobs queue, so the earlier question about the retry worker no longer fits.",
  "",
  "- [ ] 3 times over 10 minutes",
  "- [ ] Once, then the dead-letter queue",
  ":::",
].join("\n");

/**
 * Code files the guide names as attachable. inbox-help.test.ts checks each
 * one against the Inbox's own name rule and kind.
 */
export const INBOX_HELP_CODE_EXAMPLES = ["run.sh", "build.mjs", "app.ts", "main.py", "View.swift", "Makefile"] as const;

/** One block per MCP tool, in INBOX_MCP_TOOLS order. */
export const TOOL_GUIDE: Record<InboxMcpToolName, InboxToolGuide> = {
  send_message: {
    args: ["body", "subject", "thread", "reply_to", "supersedes", "attachments", "idempotency_key"],
    lines: [
      "Post a markdown message to the person. `body` is required; question blocks in it render as answerable cards (see \"Asking the reviewer questions\").",
      "- `subject`: used when the message starts a thread. Default: the first question's prompt, else the first line.",
      "- `thread`, `reply_to`: where it lands (see \"Threads\").",
      "- `supersedes`: earlier questions of the thread this message lands in that no longer apply, so the person can no longer answer them: `\"<message id>/<key>\"` for one question (read_thread gives each question's `key`) or `\"<message id>\"` for every open question of that message. With exactly one question in this message, it replaces them; otherwise they read \"No longer applies\". To name the replacement exactly, write a `Replaces:` line in the new block instead (see \"Only in the Inbox\"). A pick the person saved on a superseded question is never sent. An id that names no open question of the thread refuses the whole send with `invalid_supersedes: …`, which lists the thread's open questions. The result's `superseded` lists what it superseded. Withdraw your own questions that are still open (read_thread state `open` or `picked`; a sent, skipped or closed one is refused) this way as the thread moves on, so they stop keeping the thread at the top of the person's list.",
      `- \`attachments\`: files to show the person beside your message, e.g. \`["docs/plan.md", "proto/admin.html", "/tmp/shot.png"]\`: absolute (anywhere you can read) or relative to \`project_path\`. Any regular file, of any size. Markdown, plain text, config and data files, Mermaid and Graphviz sources and HTML open in Plannotator's viewers; images (PNG, JPEG, GIF, WebP, SVG, AVIF, BMP, ICO) show in the message; source code, scripts (${INBOX_HELP_CODE_EXAMPLES.map(code).join(", ")} and the like) and any other text open as code with line comments (text over 16 MB is offered as a download); PDFs and every other file are offered as a download. The kind is read from the bytes, so an image or PDF needs no particular name. Folders and \`.env\` files are refused, and one refused file refuses the whole send. The Inbox keeps the version you sent and shows the file as it is now; the person's annotations, including comments on images and code lines, come back in their reply. Each attachment in the result has a \`kind\` (\`markdown\`, \`text\`, \`html\`, \`mermaid\`, \`graphviz\`, \`code\`, \`image\`, \`pdf\`, \`file\`); treat a kind you do not know as \`file\`.`,
      "- `idempotency_key`: any unique string. Sending again with the same key returns the first message instead of posting twice; the same key with another body, thread, `reply_to` or `supersedes` is refused.",
      "- Returns `message_id`, `thread_id`, `new_thread`, `cursor` and the thread's `url`.",
    ],
  },
  read_thread: {
    args: ["thread_id", "message_id", "asked_by", "include_resolved", "limit"],
    lines: [
      "Read one thread (`thread_id` or `message_id`): every message, its questions and the person's answers. Without an id, list this project's threads, newest activity first: only the ones you sent in unless `asked_by` is `\"anyone\"`, only open ones unless `include_resolved`, up to `limit` (default 20).",
    ],
  },
  resolve_message: {
    args: ["message_id", "resolved"],
    lines: [
      "Archive the thread a message belongs to for the person; use it only when nothing in it is left for them to read or answer. `message_id` is any message in the thread, or the thread id; `resolved: false` reopens it. Its questions then read as closed.",
    ],
  },
  wait_for_reply: {
    args: ["thread_id", "message_id", "cursor", "timeout_seconds"],
    lines: [
      `Wait for the person's reply in a thread (\`thread_id\` or \`message_id\`), or in any open thread you asked when neither is given. It returns the reply as soon as it lands. Otherwise, after about ${Math.round(INBOX_WAIT_DEFAULT_MS / 1000)} seconds (\`timeout_seconds\`, at most ${INBOX_WAIT_MAX_SECONDS}), it returns \`{ status: "waiting", cursor }\`: call it again with that \`cursor\` to keep waiting. A resolved thread answers \`status: "resolved"\` at once.`,
      "Without a cursor, any reply after your last message in the thread counts.",
    ],
  },
  list_decisions: {
    args: ["state"],
    lines: [
      "List the decisions that hold in this project, oldest first. `state`: `current` (default), `replaced`, `retired` or `all`. Each has `text`, `reason`, `source` (an answer the person sent, an agent's record_decision, or the person's own words) and `state`. Read them before you re-ask something already settled.",
    ],
  },
  record_decision: {
    args: ["text", "reason", "idempotency_key"],
    lines: [
      "Record a decision you settled with the person. `text` is one statement (\"Webhooks are verified before any database write.\"), `reason` says why. It shows on the person's Decisions page as recorded by you.",
    ],
  },
  get_guide_brief: {
    args: [],
    lines: [
      "No arguments. Returns how to write a guided review of a code change: `methodology`, `output_schema`, `diff_steps` (how to produce the exact patch), `rules` and a working `example` call to submit_guide. Call it before submit_guide.",
    ],
  },
  submit_guide: {
    args: ["guide", "patch", "snapshot", "body"],
    lines: [
      "Send the person a guided review of a code change: `guide` (the shape get_guide_brief gives) plus `patch` (the exact unified diff it describes), or a complete `snapshot` instead of both. `body` is your note above the card (default: the guide's intent). It takes send_message's routing fields (`subject`, `thread`, `reply_to`, `supersedes`, `idempotency_key`). A guide that does not match its patch is refused with `invalid_guide: …` naming the file. Code diffs only.",
    ],
  },
};

const SECTION_LABEL = (id: InboxSectionId): string => INBOX_SECTIONS.find((section) => section.id === id)?.label ?? id;

/** "Claude Code", "Pi", "OpenCode": the hosts that carry the agent tool, by their harness labels. */
function hostLabel(host: string): string {
  return HARNESSES.find((harness) => harness.id === host)?.label ?? host;
}

function code(text: string): string {
  return `\`${text}\``;
}

/** One line of JSON (the window shows it pretty-printed); anything else unchanged. */
function oneLine(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text.replace(/\s*\n\s*/g, " ");
  }
}

function where(label: string): string {
  return /[/\\.]/.test(label) ? code(label) : label;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * One harness as one bullet: what to run or paste, in a form an agent can use
 * from a terminal. An install link (Cursor, VS Code, Goose) gives way to the
 * panel's "Another way", which is a command or a file.
 */
export function harnessHelpLine(harness: Harness, ctx: ConnectContext): string {
  const panel = harnessPanel(harness.id, ctx);
  const codes = panel.artefacts.filter((artefact) => artefact.kind === "code");
  if (codes.length > 0) {
    const parts = codes.map((artefact) => `${artefact.label ? `${where(artefact.label)}: ` : ""}${code(oneLine(artefact.text))}`);
    return `- **${harness.label}**: ${parts.join("; ")}.${panel.note ? ` ${sentence(panel.note)}` : ""}`;
  }
  const another = panel.another;
  if (another?.body?.kind === "code") {
    return `- **${harness.label}**: ${another.summary}: ${code(oneLine(another.body.text))}`;
  }
  if (another) return `- **${harness.label}**: ${sentence(another.summary)}`;
  const link = panel.artefacts.find((artefact) => artefact.kind === "link");
  return `- **${harness.label}**: ${link?.kind === "link" ? `${link.label}: ${link.href}` : "see the Inbox window"}`;
}

export interface InboxHelpOptions {
  /** The argv that runs this CLI (`selfCommand()`): the absolute binary, or bun plus the entry script. */
  command: readonly string[];
  /** The resolved data dir (`getPlannotatorDataDir()`). */
  dataDir: string;
  platform?: ConnectContext["platform"];
  /** Where the agents' instructions files are (for the note section). Default: this process's home and environment. */
  agentEnvironment?: AgentEnvironment;
}

export function inboxHelpPlatform(platform: NodeJS.Platform = process.platform): ConnectContext["platform"] {
  return platform === "win32" ? "windows" : platform === "darwin" ? "mac" : "linux";
}

function toolBlock(name: InboxMcpToolName): string[] {
  const guide = TOOL_GUIDE[name];
  const args = guide.args.length > 0 ? [`Arguments: ${guide.args.map(code).join(", ")}.`, ""] : [];
  return [`### ${name}`, "", ...args, ...guide.lines, ""];
}

export function formatInboxHelp(options: InboxHelpOptions): string {
  const mcpCommand = [...options.command, "inbox", "mcp"];
  const mcp = shellLine(mcpCommand);
  const self = shellLine(options.command);
  const ctx: ConnectContext = { command: mcpCommand, mcpUrl: INBOX_HELP_MCP_URL, platform: options.platform ?? inboxHelpPlatform() };
  const inboxPath = join(options.dataDir, "inbox");
  const configPath = join(options.dataDir, "config.json");
  const agents = options.agentEnvironment ?? createAgentEnvironment();
  const noteLines = INBOX_NOTE_AGENT_IDS.map((id) => {
    const target = noteTarget(id, agents);
    const shown = displayPath(target.path, agents);
    if (target.reason) return `- ${INBOX_AGENT_LABELS[id]} (\`${id}\`): none. ${target.reason}`;
    return `- ${INBOX_AGENT_LABELS[id]} (\`${id}\`): ${code(shown ?? "")}, ${target.create ? "creates the file" : "adds a marked section"}.`;
  });
  const on = INBOX_TOOL_HOSTS.filter((host) => INBOX_TOOL_DEFAULTS[host]).map(hostLabel);
  const off = INBOX_TOOL_HOSTS.filter((host) => !INBOX_TOOL_DEFAULTS[host]).map(hostLabel);
  const defaults = [on.length ? `on by default in ${on.join(" and ")}` : "", off.length ? `off by default in ${off.join(" and ")}` : ""]
    .filter(Boolean)
    .join(", ");

  return [
    "# Plannotator Inbox: a guide for agents",
    "",
    "Printed by `plannotator inbox --help`. Written for you, the agent.",
    "",
    "## What it is",
    "",
    `The Plannotator Inbox is one local window per machine where you leave the person messages, questions, files to annotate, guided reviews and decisions. It binds 127.0.0.1 whatever \`PLANNOTATOR_REMOTE\` and \`PLANNOTATOR_PORT\` say; the person may publish the window over their tailnet, but the MCP server and agent tools answer only on this computer. Its data lives in ${code(inboxPath)} (the data dir is set by \`PLANNOTATOR_DATA_DIR\`). The person reads your message there and answers when they can. Nothing holds your session open: you send, then keep working or end your turn.`,
    "",
    "## When to use it",
    "",
    "Use it for:",
    "",
    "- A question you cannot settle from the code or the conversation, which can wait for an answer.",
    "- A blocker: say what stops you (a `Stopped:` line, below). When other work remains, use `Holds up:` instead and go on with it.",
    "- Long work you finished while the person was away: one short summary, with the files to look at in `attachments`.",
    "- A plan, document, HTML prototype or diagram the person should read and annotate (`attachments`).",
    "- A guided review of a finished code change (get_guide_brief, then submit_guide).",
    "- A decision to record for the project (record_decision, or `Decision: when answered` on a question).",
    "",
    "Do not use it for:",
    "",
    "- Something you need answered in the current chat right now: ask in the chat.",
    "- Routine progress or each small step: send one message per real need.",
    "- A sign-off on this plan, document or diff before you go on: use a Plannotator review (plan review, `plannotator annotate`, `plannotator review`).",
    "",
    "## How to reach it",
    "",
    `1. If you have a tool named \`${INBOX_TOOL_NAME}\` (Claude Code, Pi, OpenCode), use it: set \`action\` to one of the tool names below and pass that tool's fields. It can be listed with a prefix (in Claude Code: \`mcp__plannotator__${INBOX_TOOL_NAME}\`) and may need loading through tool search first.`,
    `2. Otherwise use the stdio MCP server: ${code(mcp)}. "Connecting other agents" below shows how to register it.`,
    `3. Only as a fallback: Streamable HTTP at ${code(INBOX_HELP_MCP_URL)}. The port can change when the Inbox restarts; ${code(`${self} inbox --background`)} prints the current URL. A request that carries an \`Origin\` header is refused.`,
    "",
    `The \`${INBOX_TOOL_NAME}\` tool fills ${INBOX_FILLED_ARGUMENTS.map(code).join(", ")} for you. Pass \`project_path\` to it yourself only when the message is about another repository or folder than your working folder (absolute, or relative to your working folder; it must be an existing folder): it then lands in that project, and relative \`attachments\` resolve against it. The stdio server fills \`project_path\` (its working folder, or \`PLANNOTATOR_CWD\`) and \`agent_session\`: the session's own id when a Claude Code or Pi session started it (a command your session runs), else one id per process, so pass \`agent_session\` yourself to keep your threads across restarts. Over HTTP, pass \`project_path\` (the absolute path of the repository or folder you work in) and \`agent_session\` yourself.`,
    "",
    "Every call starts a stopped Inbox in the background, without a browser tab, so never run `plannotator inbox` just to send. Bare `plannotator inbox` is for the person: it opens the window.",
    "",
    "## Connecting yourself",
    "",
    "Set up the connection for the host you run in:",
    "",
    `- **Claude Code** with the Plannotator plugin: nothing else to do. Check \`claude plugin list\` for \`plannotator@plannotator\`; if it is missing, run \`claude plugin marketplace add backnotprop/plannotator\` and \`claude plugin install plannotator@plannotator\`. The \`${INBOX_TOOL_NAME}\` tool appears after Claude Code restarts (\`claude --continue\` returns to this conversation). It needs Claude Code 2.1.287 or later, on macOS or Linux, in an interactive session (not \`claude -p\`).`,
    `- **Pi** with the Plannotator extension (\`pi install npm:@plannotator/pi-extension\` if it is missing), or **OpenCode** with the Plannotator plugin (\`@plannotator/opencode@latest\` in opencode.json: \`"plugin": [...]\` on OpenCode 1, \`"plugins": [{ "package": ... }]\` on OpenCode 2): the inbox tool is off by default there. Turn it on for your host by merging ${code(`{ "inboxTool": { "pi": true } }`)} (or \`"opencode"\`) into ${code(configPath)}, keeping its other keys, or with the switch in the Inbox's Settings. Then start a new Pi session (or \`/reload\`), or restart OpenCode.`,
    "- **Anything else**: register the stdio server; \"Connecting other agents\" below has the line for your host.",
    "",
    "When the person runs `plannotator inbox` themselves, it already connects the terminal agents it finds (Codex, Gemini CLI, Cursor, Windsurf/Devin, Amp, Kiro, Pi 0.99+, OpenCode with its plugin) and the Claude app, so check before adding a second entry: a `plannotator-inbox` server that runs this binary is already the connection.",
    "",
    `A connection takes effect in the next session, never in the one already running. Until then, send through the stdio server directly: ${code(mcp)}.`,
    "",
    "## Tools",
    "",
    "Agents ask, the person decides: no tool answers a question, approves or sends anything for the person. A refusal comes back as an error whose text starts with a code, `<code>: <message>`.",
    "",
    ...INBOX_MCP_TOOLS.flatMap(toolBlock),
    "## Threads",
    "",
    "Where send_message (and submit_guide) puts a message; the first rule that applies wins:",
    "",
    "1. `reply_to` (a message id): that message's thread, as a reply.",
    `2. \`thread\` (a name, 1 to ${INBOX_THREAD_NAME_MAX} characters, one line): the newest open thread of that name in this project, from any session. With none open, a new thread under that name. Names compare without case, spacing or invisible characters.`,
    "3. Neither: your session's own thread, the newest unnamed thread your session started in this project while it is open, else a new one. Without a session id, every message starts a thread.",
    "",
    "Resolved means done: the next message starts a new thread, while `reply_to` still reaches a resolved thread. A thread keeps its first message's subject. Use `thread` to keep separate work apart, or to join another session's thread.",
    "",
    "## Where replies go",
    "",
    `- With the \`${INBOX_TOOL_NAME}\` tool in Claude Code, Pi or OpenCode 2, the person's reply arrives in your session by itself as a new message once the session is idle, starting with the line \`Plannotator Inbox: <subject> (<reply id>)\`. End your turn instead of waiting. To answer, send_message with \`reply_to\` set to that id. The person can also write to a live session first; it arrives the same way.`,
    `- Replies come back to the session that sent the message: send with your \`${INBOX_TOOL_NAME}\` tool; inside Claude Code or Pi, a command your session runs also carries the session's identity.`,
    "- OpenCode 1 has the tool but no wake, and nothing wakes an MCP client: call wait_for_reply, or read_thread later.",
    "- The reply is the person's answer to you: their words, then an \"Answers to your questions\" section, then their annotations on any attached files.",
    "- A reply that answers some of your questions usually skips the ones the person left unanswered: they come back as `Skipped (not answered in this reply)`. Treat them as skipped, and ask again if you still need them.",
    "- A reply that answers none of them (the person only wrote back, or sent annotations) leaves them all open and says so after their words: `No questions answered yet; all N are still open. Don't re-ask them; the person will answer in the Inbox.` Do not ask them again: the answers come in a later reply.",
    `- The person may mark a thread read without answering: its waiting questions close unanswered, and you get one message from them that starts \`${INBOX_SET_ASIDE_HEADING}\` and lists them. Do not wait on those; ask again if you must.`,
    "",
    QUESTION_AUTHORING_GUIDE.trimEnd(),
    "",
    "(In the Inbox the person's words come before the answers.)",
    "",
    "### Only in the Inbox",
    "",
    "Four more lines a question block can carry, each on its own line (the first other line is always the question):",
    "",
    `- \`Stopped: <why>\`: you cannot go on until this is answered. The person's list shows the thread first, under "${SECTION_LABEL("stopped")}". Add it only when you cannot go on; otherwise leave the line out, never \`Stopped: no\`.`,
    `- \`Holds up: <name>; <name>\`: you go on, and these pieces of work wait. The list shows it under "${SECTION_LABEL("holding")}", the most held-up first.`,
    "- `Decision: when answered` (at the start of a line): when the person sends their answer, it is recorded as a project decision (list_decisions). The person can turn that off on the card.",
    "- `Replaces: <message id>/<key>`: this question replaces an earlier one of the same thread (send with `reply_to` into that thread). The old card then reads \"Replaced\", links to this one, and can no longer be answered; a pick the person saved on it is never sent. It is never read as the question, wherever it sits in the block. Get the key from read_thread; several ids may follow, separated by commas. An id that names no open question of the thread refuses the whole send with `invalid_supersedes: …`. send_message's `supersedes` does the same for a whole message or when you ask nothing new.",
    "",
    "```markdown",
    INBOX_QUESTION_EXAMPLE,
    "```",
    "",
    "A question that replaces an earlier one:",
    "",
    "```markdown",
    INBOX_REPLACES_EXAMPLE,
    "```",
    "",
    "Attach the files a question points to (send_message's `attachments`, here `[\"load-test.html\"]`) and link them from its context, as above: the link opens the file beside the thread. A link to a file you did not attach shows as \"Not attached\". Add a screenshot (`![alt](path)`) when the question is about something visual.",
    "",
    "## Connecting other agents",
    "",
    `Register the stdio server once per agent; each line names this binary. Only when the person asks you to set one up:`,
    "",
    ...HARNESSES.map((harness) => harnessHelpLine(harness, ctx)),
    "",
    `The \`${INBOX_TOOL_NAME}\` tool is ${defaults}. \`PLANNOTATOR_INBOX_TOOL=1\` or \`0\` turns it on or off everywhere, and config.json \`inboxTool\` takes \`true\`, \`false\` or one per host (\`{ "pi": true }\`); the environment variable wins. A host decides once, at start (Claude Code and OpenCode when the process starts, Pi per session or \`/reload\`), and registers the tool only if the Inbox has run once on this machine by then (\`inbox/inbox.json\` exists); Claude Code registers it anyway, and its first call starts the Inbox. So the tool appears in sessions started after that, never in one already running. Once the Inbox has run here, a session with the tool also gets one line at its start saying when to use the Inbox; config.json \`inboxReminder\` (\`false\`, or one per host) turns that line off.`,
    "",
    "## A note in each agent's instructions",
    "",
    "Plannotator can add a short, marked note about the Inbox to an agent's own instructions file, so it sends decisions and finished work here while the person is away. Only with the person's yes: show them this list, then run `plannotator inbox --notes <ids>` with only the agents they agreed to (comma-separated). It never overwrites a note the person edited; the Inbox's Settings and `plannotator uninstall` remove it. On this computer:",
    "",
    ...noteLines,
    "",
    "## Commands and flags",
    "",
    "```text",
    INBOX_COMMAND_USAGE,
    "```",
    "",
    "`--tailscale` is the person's choice: never add it to a start you run. The MCP server and the agent tools answer only on this computer.",
    "",
    "## Data and removal",
    "",
    `- Everything lives in ${code(inboxPath)}: threads by project, the versions of the files you sent, decisions, and \`inbox.json\` (where the running Inbox is).`,
    "- The person deletes a thread or a project in the window's Settings.",
    "- `plannotator uninstall` keeps the data. `plannotator uninstall --purge` stops a running Inbox, then deletes it (if it cannot stop it, it says so and keeps the data).",
    "- Both remove the `plannotator-inbox` MCP entries `plannotator inbox` added to the agents on this computer (`plannotator uninstall --dry-run` lists them); an entry changed by hand to run something else is left.",
    "- Never run uninstall, delete threads or projects, or edit these files for the person.",
    "",
  ].join("\n");
}
