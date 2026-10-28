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

import { INBOX_CARD_ACTION_ON, INBOX_CODEX_QUEUE_MIN_VERSION, INBOX_QWEN_WAKE_MIN_VERSION, INBOX_SECTIONS, INBOX_THREAD_NAME_MAX, inboxToolCostText, type InboxSectionId } from "@plannotator/core/inbox-types";
import { QUESTION_AUTHORING_GUIDE } from "@plannotator/core/question-block";
import { INBOX_SET_ASIDE_HEADING } from "@plannotator/core/inbox-questions";
import { INBOX_ACTION_EXAMPLE, INBOX_ACTION_GUIDE, INBOX_ACTIONS_HEADING } from "@plannotator/core/inbox-actions";
import { HARNESSES, harnessPanel, shellLine, type ConnectContext, type Harness } from "@plannotator/inbox/harnesses";
import { join } from "node:path";
import { INBOX_CONTRACT_EXAMPLE, INBOX_DEFAULT_SERVED_TOOLS, INBOX_MCP_TOOLS, INBOX_SERVED_TOOLS, INBOX_WAIT_DEFAULT_MS, INBOX_WAIT_MAX_SECONDS } from "@plannotator/server/inbox-mcp";
import { INBOX_BODY_CUT_BYTES, INBOX_EARLIER_PERSON_BYTES, INBOX_THREAD_WINDOW, sizeText } from "@plannotator/server/inbox-mcp-read";
import { INBOX_AGENT_SEARCH_LIMIT } from "@plannotator/server/inbox-mcp-search";
import { INBOX_TOOL_DEFAULTS, INBOX_TOOL_HOSTS } from "@plannotator/shared/config";
import { INBOX_FILLED_ARGUMENTS, INBOX_FOLLOW_THROUGH_RULE, INBOX_REF_LINK_RULE, INBOX_REPLY_TO_CHECK, INBOX_SUBAGENT_RULE, INBOX_TAGGED_INSTRUCTION, INBOX_TOOL_NAME, inboxReaskInstruction } from "@plannotator/shared/inbox/connection";
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
    args: ["body", "subject", "thread", "reply_to", "supersedes", "done", "attachments", "idempotency_key"],
    lines: [
      "Post a markdown message to the person. `body` is required; question blocks in it render as answerable cards (see \"Asking the reviewer questions\").",
      "- `subject`: used when the message starts a thread; one line of plain text (a line break or leaked tool-call text such as `</subject>` is refused with `validation_error`). Default: the first question's prompt, else the first line.",
      "- `thread`, `reply_to`: where it lands (see \"Threads\"). `thread` is a name: a message id there (`msg_…`) is refused with `validation_error`. To write in an existing thread, pass its id as `reply_to`; beside `reply_to`, leave `thread` out unless you are naming a thread the person started.",
      "- Name a thread the person started: on your reply into it (`reply_to`), pass `thread` with a few words saying what it is about. The first name you give sets it, once; later ones are ignored. Only the session the thread is addressed to may name it (or, once the person sent it to another session, also the first agent that replied). Until then read_thread and wait_for_reply say `name_this_thread: true`, and a reply without a name says so in its result. The result's `named_thread` is the name set, or null while the thread stays unnamed. A name another open thread of the project already has is refused (`naming_refused: \"thread_name_taken\"`, an invalid one `\"invalid_thread_name\"`): pick another name and reply again with it.",
      "- `supersedes`: earlier questions of the thread this message lands in that no longer apply, so the person can no longer answer them: `\"<message id>/<key>\"` for one question (read_thread gives each question's `key`) or `\"<message id>\"` for every open question of that message. With exactly one question in this message, it replaces them; otherwise they read \"No longer applies\". To name the replacement exactly, write a `Replaces:` line in the new block instead (see \"Only in the Inbox\"). A pick the person saved on a superseded question is never sent. An id that names no open question of the thread refuses the whole send with `invalid_supersedes: …`, which lists the thread's open questions. The result's `superseded` lists what it superseded. Withdraw your own questions that are still open (read_thread state `open` or `picked`; a sent, skipped or closed one is refused) this way as the thread moves on, so they stop keeping the thread at the top of the person's list.",
      "- `done`: your own action items (`:::action` blocks, see \"Action items only the person can do\") in the thread this message lands in that you saw done yourself, e.g. the deployment you were watching is Ready: `\"<message id>/<key>\"` (the key starts with `a-`; read_thread gives it) or `\"<message id>\"` for every open action item of that message. The card then says you saw it done; nothing is sent to the person. An id that names no open action item of the thread refuses the whole send with `invalid_done: …`, which lists the thread's open action items. The result's `done` lists what it marked. Never mark done what you did not see happen.",
      `- \`attachments\`: files to show the person beside your message, e.g. \`["docs/plan.md", "proto/admin.html", "/tmp/shot.png"]\`: absolute (anywhere you can read) or relative to \`project_path\`. For something visual, a screenshot or image usually reads fastest; attach the HTML or source too when they should open or click through it. Any regular file, of any size. Markdown, plain text, config and data files, Mermaid and Graphviz sources and HTML open in Plannotator's viewers; images (PNG, JPEG, GIF, WebP, SVG, AVIF, BMP, ICO) show in the message; videos (MP4, MOV, WebM) play beside it, and the person comments at moments (each comment comes back with its time, \`At 1:42 (102.4 s of 7:41)\`, and the path of the paused frame, which you can read); source code, scripts (${INBOX_HELP_CODE_EXAMPLES.map(code).join(", ")} and the like) and any other text open as code with line comments (text over 16 MB is offered as a download); PDFs and every other file are offered as a download. The kind is read from the bytes, so an image, video or PDF needs no particular name. Folders and \`.env\` files are refused, and one refused file refuses the whole send. The Inbox keeps the version you sent and shows the file as it is now; the person's annotations, including comments on images and code lines, come back in their reply. Each attachment in the result has a \`kind\` (\`markdown\`, \`text\`, \`html\`, \`mermaid\`, \`graphviz\`, \`code\`, \`image\`, \`video\`, \`pdf\`, \`file\`); treat a kind you do not know as \`file\`.`,
      "- `idempotency_key`: any unique string. Sending again with the same key returns the first message instead of posting twice; the same key with another body, thread, `reply_to`, `supersedes` or `done` is refused.",
      "- Images in `body` (`![alt](path)`, `<img src=\"path\">`) show in the message from anywhere you can read: a path relative to `project_path`, or absolute (`/tmp/shot.png` works). PNG, JPEG, GIF, WebP, SVG, AVIF, BMP and ICO, up to 10 MB and 50 megapixels. Not shown: a dotenv-named file; anything in a hidden folder (a segment starting with `.`) outside your project and the folder you send from (hidden folders inside them show, `.walkthrough/` say, unless the project is your home folder itself or a folder above it); and web images (`https://…`, `//host/…`). The message is still sent, and the result's `images_not_shown` (`[{ ref, reason, not_yet? }]`, at most 10, with `images_not_shown_more` counting the rest, and a line in the text) names each image that will not show; copy it to a plain folder and link that path, or attach it with `attachments`. An image not written yet (`not_yet: true`) shows once the file exists. The person's own replies show images from the project only.",
      "- Fenced blocks in `body` that draw: a block fenced as `mermaid` or `dot` draws as a diagram, and one fenced as `html` draws as a live page in the message (a chart, an SVG drawing, a small mock). The page runs in a sandbox: its scripts run and it may load libraries, data, images and fonts over https, but it cannot reach the Inbox, the person's files or a path beside you (give images as https or data: URLs). Leave its background transparent so it sits in the message, and use the theme's variables: `var(--foreground)`, `var(--muted-foreground)`, `var(--border)`, `var(--chart-1)` to `var(--chart-5)`, `var(--font-sans)`. Let content set its height: do not use vh units or `height:100%` on html or body (the frame takes the page's height, so the page would grow without end). It shows up to 480 px tall, then Show more; the person can open it full screen or read its code. A block fenced as `svg` shows as an image.",
      `- Issue and PR refs in \`body\`: ${INBOX_REF_LINK_RULE}`,
      "- Returns `message_id`, `thread_id`, `new_thread`, `cursor` and the thread's `url`, and `actions` (each action item's `key` and what to do) when the body has `:::action` blocks.",
    ],
  },
  read_thread: {
    args: ["thread_id", "message_id", "limit", "expand", "before", "after", "format", "asked_by", "include_resolved"],
    lines: [
      `Read one thread (\`thread_id\`, or \`message_id\`: its thread, with that message shown in full even outside the window). A long thread is read as a window, not the whole history, and the result is a transcript that holds everything:`,
      "- First the thread's subject, name, project, who wrote how many messages, and every question still waiting on the person (open, or picked and not sent): its `<message id>/<key>`, `Q<n>` (the number the reply's \"Answers to your questions\" uses), state, prompt and choices.",
      `- Then the messages, oldest first: the newest \`limit\` (default ${INBOX_THREAD_WINDOW}) in full; the person's earlier messages in full, newest first, while they total ${sizeText(INBOX_EARLIER_PERSON_BYTES)} or less (each without its answers section, whose answers are on the questions); every other earlier message as one line: id, author, time, first words, size, and each of its questions with its prompt as \`Q1 q-… ("prompt") sent: "…"\`, \`open\`, \`picked, not sent\`, \`closed\` or \`replaced by <message id>/<key>\`. Answers are quoted whole as JSON strings, so a long free-text answer or note keeps every line. A body over ${sizeText(INBOX_BODY_CUT_BYTES)} is cut, with a marker naming the \`expand\` call for the rest; the person's newest message is always whole. A person's message addressed to one session says \`to you\` or \`to another session (…)\`. No question's state is ever left out: with \`after\`, a question of an older message is listed only when its state changed since that cursor (open and picked ones are always in the header).`,
      "- `expand`: message ids of the thread to show in full, exactly as sent. `before`: only messages before this message id or cursor (read further back). `after`: only messages after this message id or cursor; pass the `cursor` a read returned to get only what is new since then. `format: \"full\"` returns every message as its full record instead (large; for scripts). With both \`thread_id\` and \`message_id\`, the message must be in that thread.",
      "- A message the person marked 👍 Looks good carries `ack: { label, at }` (see \"Where replies go\").",
      "- A reply of the person's that tags agents with `@` carries `to` (the session it goes to anyway) and `tagged: [{ agent, session, you }]`; its line reads `to you` or `to another session (…)`, then `tagged you, Pi (pi-0193)`. `you: true` (and `tagged_you: true` with `format: \"full\"`) means the person tagged you (see \"Where replies go\").",
      "- The structured result keeps the records' field names: `thread.messages` (the messages in full: `id`, `author.kind`, `created_at`, `reply_to`, `body`, `questions[]` with `key`, `q`, `state`, `answer`, `attachments[]` with `name`, `kind`, `size`, `path`, `ack`, `guide.title`), `thread.earlier` (the one-line messages), `thread.open_questions`, `window` and `cursor`.",
      "Without an id, list this project's threads, newest activity first, and every thread in any project the person tagged you in that you have not taken yet (`tagged_you: true` on its row; its line says \"the person tagged you here\"): only the ones you sent in unless `asked_by` is `\"anyone\"`, only open ones unless `include_resolved`, up to `limit` (default 20). Each row is short: `thread_id`, `subject`, `thread_name`, `section` (where it sits in the person's list), `message_count`, `questions: { open, picked, prompt }`, `last_author` (`agent` or `person`), `last_at`, `last_person_at` and `last_person_message_id` (the person's last message, null when they wrote none; the Inbox's own notes, such as the set-aside note, do not count), `unread` (the person wrote something in it for you that no agent has read yet: a reply no agent has read with read_thread or wait_for_reply, or a message addressed to you that your wake or your own wait_for_reply has not delivered yet; read_thread does not deliver it; after a reply you may have missed, read those threads) and, on a resolved thread (with `include_resolved`, or one an agent wrote in after the archive), `resolved_at`. Read a thread by its id for its messages.",
    ],
  },
  search: {
    args: ["query", "all_projects", "limit"],
    lines: [
      `Find messages by words, read-only: your messages, other agents' and the person's, in this project unless \`all_projects\`. It is the search the person runs in the window (⌘K): every word must match (the last may be the start of a word), and a question's prompt, choices and answer count as its message's text. Up to \`limit\` results (default ${INBOX_AGENT_SEARCH_LIMIT}, at most 50), best first, each one line: \`thread_id\`, \`message_id\`, \`author\` (\"person\" or the agent's name), \`at\`, the thread's \`subject\`, a \`snippet\` around the match, and \`question\` (its key) when the match is in a question. The result says how many matched in all. Searching writes nothing and marks nothing read: a folder the Inbox has never seen gets no results (with a note), never a new project. Then read_thread with that \`thread_id\` and \`message_id\` shows the message in full.`,
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
      `Wait for the person's reply in a thread (\`thread_id\` or \`message_id\`), or in any open thread you asked when neither is given. It returns the reply as soon as it lands. Otherwise, after about ${Math.round(INBOX_WAIT_DEFAULT_MS / 1000)} seconds (\`timeout_seconds\`, at most ${INBOX_WAIT_MAX_SECONDS}), it returns \`{ status: "waiting", cursor }\`: call it again with that \`cursor\` to keep waiting. A resolved thread answers \`status: "resolved"\` at once. When the person marks your latest message in the thread 👍 Looks good instead of replying, it returns \`{ status: "acknowledged", acks: [{ message_id, label, at }], cursor }\`: no reply is coming for it.`,
      "Without a cursor, any reply after your last message in the thread counts. Without a thread it also waits on every thread the person tagged you in, in any project; in a thread you never wrote in, only what tags you answers it.",
      "A reply returns `{ status: \"replied\", thread_id, reply: { message_id, reply_to, body, created_at }, questions, cursor, url }`, with `tagged_you: true` when the person tagged you in another session's thread. The `body` is the reply in full, answers included. `questions` lists the questions of the message it answers, each as `{ key, state, answer, sent_reply_id? }` (`sent_reply_id` names the reply that sent its answer); read_thread with `format: \"full\"` has the full question records. The text ends with the same facts in one line: `[reply <id> · to <id> · <time> · questions of <id>: Q1 q-… sent: \"…\"; Q2 q-… open · cursor N · <url>]`.",
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
      "Send the person a guided review of a code change: `guide` (the shape get_guide_brief gives) plus `patch` (the exact unified diff it describes), or a complete `snapshot` instead of both. `body` is your note above the card (default: the guide's intent). It takes send_message's routing fields (`subject`, `thread`, `reply_to`, `supersedes`, `done`, `idempotency_key`). A guide that does not match its patch is refused with `invalid_guide: …` naming the file. Code diffs only.",
    ],
  },
  card: {
    args: ["op", "card_id", "title", "column", "say", "you", "thread_id", "pr", "ref", "reason", "idempotency_key", "asked_by", "include_resolved"],
    lines: [
      "Keep a card on the person's Board for work that outlasts the reply it was asked in: a lane or background task started, a PR opened, \"I'll send you X\". Not for a quick answer. Make it when you take such an ask, then keep it current with one short call at the moments you already note: work started, a PR opened, something sent to the person, waiting on them, shipped. The person reads the Board instead of asking each terminal where things are; each card shows how long ago anyone last wrote to it. A card is its own record: it never changes a thread or the person's list. The Board is something the person turns on (Settings → Capabilities in the Inbox); while it is off the Inbox does not list `card`, and a call answers `board_off` and writes nothing. Turned on, agents get `card` in their next session.",
      "- `op`: `create`, `move`, `say`, `link`, `ship`, `drop` or `list`. Every op but create and list takes `card_id` (`crd_…`, from create or list); an op refuses a field it does not take.",
      "- `column`: `backlog` (not started: work you were asked to do and have not begun goes here, beside the person's own ideas; a backlog card is never a signal to start, the person tells you when), `designing` (research, a plan, mocks, a sheet, options: anything that is not code), `your_look` (a non-code thing waits on the person: a sheet, options, questions, a triage call), `building` (code, or a PR not ready for them), `your_review` (code waits on the person: screenshots before a merge, a green PR to merge, a release go), `shipped` (merged or live, staging included), `dropped`. The stage is the kind of thing the next move makes: code, a PR or a release is building, anything else designing. Waiting on the person wins over work you keep doing beside it. Work you hold back yourself stays in its column, with the reason in `say`.",
      "- `you`: what the person owes, one line, shown as \"You: …\" in your_look and your_review. Moving a card into either needs it; it is dropped when the card leaves them, and refused elsewhere. Link the Inbox thread where the person makes the call (`thread_id`), so \"You: …\" opens it. `say`: your last word, one line (\"lane running, sheet in ~1 h\"), shown in the other columns.",
      "- create: `title`: 2–5 words naming the work (\"Pi update fix\"), never a sentence; status goes in `say`. Or `thread_id` (a thread or message id of this project) to link it and take its subject as the title (subjects run long: pass a short `title` with it); `column` (default backlog; a live column or shipped), `say`, `you`, `pr`, `idempotency_key` (the same key answers the first card). The card is your session's: list shows it as yours.",
      "- move: `column`, with any of `say`, `you`, `pr` and `thread_id`; to dropped it needs `reason`. say: `say` and/or `you` (refs in them link as in `body`), or `title` to rename. link: `thread_id`, `pr` (`owner/repo#123`, or a GitHub, GitLab or Bitbucket PR URL) and/or `ref` (an issue or PR: `owner/repo#123`, or its GitHub or GitLab URL; move, create and ship take it too). The person sees each link's live state when they open the card; it never moves the card. Every write counts as hearing from the card.",
      "- ship: when it is merged or live. A merged PR never moves a card by itself: ship it. Reported broken again: move it back to backlog. drop: `reason` (required from you, one line); the Board shows the person your drop and its reason until they look, and they can restore it.",
      "- list: your cards in this project (`asked_by: \"anyone\"` for every card here) in the live columns and the icebox; `include_resolved` adds shipped and dropped. One line each: id, title, column, `You:` or said, when it was last heard, dropped reason (and whether the person has seen your drop yet), threads, PRs, the agent it belongs to. Read it after a compaction or in a new session to pick your work back up.",
      "- The icebox is the person's pause: you cannot put a card there or move one out of it (`card_icebox_person_only`, `card_iceboxed`), and only the person restores a card they dropped (`card_dropped_by_person`); you can still `say` and `link` on such a card. Leave an iceboxed card's work alone: nothing is sent to you about it and nothing moves it. A card or thread of another project is refused (`card_other_project`): pass that project's `project_path`.",
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
  /**
   * The person turned the Board on (config.json `inboxBoard`, read by the
   * caller). Off (the default), the guide says nothing about cards: no `card`
   * section and no Board bullet, as the Inbox serves no `card` action then.
   */
  board?: boolean;
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
  const board = INBOX_CARD_ACTION_ON && options.board === true;
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
    if (id === "cursor") return `- ${INBOX_AGENT_LABELS[id]} (\`${id}\`): copied by hand into Customize → Rules in Cursor (Cursor keeps its rules in the app, so nothing is written). \`plannotator inbox --notes cursor\` prints the note to copy; Plannotator can't see, update or remove that copy.`;
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
    `The Plannotator Inbox is one local window per machine where you leave the person messages, questions, files to annotate and guided reviews. It binds 127.0.0.1 whatever \`PLANNOTATOR_REMOTE\` and \`PLANNOTATOR_PORT\` say; the person may publish the window over their tailnet, but the MCP server and agent tools answer only on this computer. Its data lives in ${code(inboxPath)} (the data dir is set by \`PLANNOTATOR_DATA_DIR\`). The person reads your message there and answers when they can. Nothing holds your session open: you send, then keep working or end your turn.`,
    "",
    "## When to use it",
    "",
    "Use it for:",
    "",
    "- A question you cannot settle from the code or the conversation, which can wait for an answer.",
    "- A blocker: say what stops you (a `Stopped:` line, below). When you can go on with other work, leave `Stopped:` out and name what waits in `Holds up:`; a question that stops you can carry both.",
    "- A true blocker only the person can clear, outside this conversation (approve a deploy, sign in, touch a security key, merge a pull request you cannot merge): one `:::action` action item (see \"Action items only the person can do\").",
    "- Long work you finished: one short summary, with the files to look at in `attachments`.",
    "- A decision that needs pictures or files, even while the person writes in the chat.",
    "- A plan, document, HTML prototype or diagram the person should read and annotate (`attachments`).",
    "- A guided review of a finished code change (get_guide_brief, then submit_guide).",
    ...(board ? ["- Work that outlasts your reply (a lane, a PR, something you promised to send): a card on the person's Board (card), kept current as it moves. Only while the person has the Board on."] : []),
    "",
    "Do not use it for:",
    "",
    "- Something new the person raised in this chat that needs no pictures or files, or a question they asked you to ask there: ask in the chat (see \"Chat or Inbox\" below).",
    "- A checklist, a status update or a decision written as `:::action` blocks: an action item is only for something the person must go and do before you can go on.",
    "- A sign-off on this plan, document or diff before you go on: use a Plannotator review (plan review, `plannotator annotate`, `plannotator review`).",
    "",
    INBOX_FOLLOW_THROUGH_RULE,
    "",
    INBOX_SUBAGENT_RULE,
    "",
    "## Chat or Inbox",
    "",
    "Whether the person is watching the chat is not a test you can make. A decision you sent to the Inbox stays there. When they come back to the chat, say there what is waiting (a short summary and the thread's link); saying it in both places is fine. Never also ask it in the chat with a blocking question tool (AskUserQuestion or similar): it blocks the chat and splits the answer across two places. Ask in the chat only about something new the person raised there that needs no pictures or files, or when they ask you to.",
    "",
    "## How to reach it",
    "",
    `1. If you have a tool named \`${INBOX_TOOL_NAME}\` (Claude Code, Pi, OpenCode), use it: set \`action\` to one of the tool names below and pass that tool's fields. It can be listed with a prefix (in Claude Code: \`mcp__plannotator__${INBOX_TOOL_NAME}\`) and may need loading through tool search first.`,
    `2. Otherwise use the stdio MCP server: ${code(mcp)}. "Connecting other agents" below shows how to register it.`,
    `3. Only as a fallback: Streamable HTTP at ${code(INBOX_HELP_MCP_URL)}. The port can change when the Inbox restarts; ${code(`${self} inbox --background`)} prints the current URL. A request that carries an \`Origin\` header is refused.`,
    "",
    `The \`${INBOX_TOOL_NAME}\` tool fills ${INBOX_FILLED_ARGUMENTS.map(code).join(", ")} for you. Pass \`project_path\` to it yourself only when the message is about another repository or folder than your working folder (absolute, or relative to your working folder; it must be an existing folder): it then lands in that project, and relative \`attachments\` resolve against it. The stdio server fills \`project_path\` (its working folder, or \`PLANNOTATOR_CWD\`) and \`agent_session\`: the session's own id when a Claude Code or Pi session started it (a command your session runs); in Codex, your thread (Codex names it on every tool call, and in \`CODEX_THREAD_ID\` for the commands its shell runs), so the person's reply comes back into that thread; else one id per process, so pass \`agent_session\` yourself to keep your threads across restarts. Over HTTP, pass \`project_path\` (the absolute path of the repository or folder you work in) and \`agent_session\` yourself.`,
    "",
    "Every call starts a stopped Inbox in the background, without a browser tab, so never run `plannotator inbox` just to send. Bare `plannotator inbox` is for the person: it opens the window.",
    "",
    "## When the person asks where their Inbox is",
    "",
    `When the person asks where the Inbox is, or wants it back after closing its tab, run ${code(`${self} inbox --open`)}. It opens the window in their browser (starting the Inbox in the background when it is not running), prints the address on stdout and returns at once, so it never blocks your session. Tell them the address. They can also use their agent's \`/plannotator-inbox\` command (\`$plannotator-inbox\` in Codex), which runs the same thing. In a remote session (SSH) with no browser set, it opens no browser on the remote host: it prints the address and says how to reach it (\`ssh -L\` or \`--tailscale\`). To read the address without opening a tab, run ${code(`${self} inbox --background`)}: it prints the same URL. The address can change when the Inbox restarts, so read it again instead of reusing an old one.`,
    "",
    "## Connecting yourself",
    "",
    "Set up the connection for the host you run in:",
    "",
    `- **Claude Code** with the Plannotator plugin: nothing else to do. Check \`claude plugin list\` for \`plannotator@plannotator\`; if it is missing, run \`claude plugin marketplace add backnotprop/plannotator\` and \`claude plugin install plannotator@plannotator\`. The \`${INBOX_TOOL_NAME}\` tool appears after Claude Code restarts (\`claude --continue\` returns to this conversation). It needs Claude Code 2.1.287 or later, on macOS or Linux, in an interactive session (not \`claude -p\`).`,
    `- **Pi** with the Plannotator extension (\`pi install npm:@plannotator/pi-extension\` if it is missing), or **OpenCode** with the Plannotator plugin (\`@plannotator/opencode@latest\` in opencode.json: \`"plugin": [...]\` on OpenCode 1, \`"plugins": [{ "package": ... }]\` on OpenCode 2): the inbox tool is off by default there. Turn it on for your host by merging ${code(`{ "inboxTool": { "pi": true } }`)} (or \`"opencode"\`) into ${code(configPath)}, keeping its other keys, or with the switch in the Inbox's Settings. Then start a new Pi session (or \`/reload\`), or restart OpenCode. Pi and OpenCode send the tool with every request: ${inboxToolCostText("pi")} each (the size measured on both; the token count depends on the model), so tell the person before you turn it on.`,
    "- **Anything else**: register the stdio server; \"Connecting other agents\" below has the line for your host.",
    "",
    "When the person runs `plannotator inbox` themselves, it already connects the terminal agents it finds (Codex, Gemini CLI, Qwen Code, Cursor, Windsurf/Devin, Amp, Kiro, Pi 0.99+, OpenCode with its plugin) and the Claude app, so check before adding a second entry: a `plannotator-inbox` server that runs this binary is already the connection.",
    "",
    `A connection takes effect in the next session, never in the one already running. Until then, send through the stdio server directly: ${code(mcp)}.`,
    "",
    "## Tools",
    "",
    "Agents ask, the person decides: no tool answers a question, approves or sends anything for the person. A refusal comes back as an error whose text starts with a code, `<code>: <message>`.",
    "",
    // Every tool this Inbox serves (`card` only while the Board is on and INBOX_CARD_ACTION_ON lets it ship).
    ...(board ? INBOX_SERVED_TOOLS : INBOX_DEFAULT_SERVED_TOOLS).flatMap(toolBlock),
    "## Threads",
    "",
    "Where send_message (and submit_guide) puts a message; the first rule that applies wins:",
    "",
    "1. `reply_to` (a message id): that message's thread, as a reply. Take the id from the Inbox (the wake's `(<reply id>)`, a read_thread or wait_for_reply result), never from memory or an earlier summary. " + INBOX_REPLY_TO_CHECK,
    `2. \`thread\` (a name, 1 to ${INBOX_THREAD_NAME_MAX} characters, one line): the newest open thread of that name in this project, from any session. With none open, a new thread under that name. Names compare without case, spacing or invisible characters.`,
    "3. Neither: your session's own thread, the newest unnamed thread your session started in this project while it is open, else a new one. Without a session id, every message starts a thread.",
    "",
    "Resolved means done: the next message starts a new thread, while `reply_to` still reaches a resolved thread. A thread keeps its first message's subject. Use `thread` to keep separate work apart, or to join another session's thread. A thread the person started takes the name an agent gives it (send_message, \"Name a thread the person started\"); from then on a send with that name joins it. A name another open thread of the project already has is refused, so naming never moves another thread's sends into this one.",
    "",
    "## Where replies go",
    "",
    `- With the \`${INBOX_TOOL_NAME}\` tool in Claude Code, Pi or OpenCode 2, the person's reply arrives in your session by itself as a new message once the session is idle, starting with the line \`Plannotator Inbox: <subject> (<reply id>)\`. End your turn instead of waiting. When the person presses Send now while you work, it arrives in the turn you are in, at your next step: answer it before you go on. To answer, send_message with \`reply_to\` set to that id. The person can also write to a live session first; it arrives the same way. Every such message ends with one closing line, \`[thread <thread id> · more: <tool> read_thread · how it works: plannotator inbox --help]\` (a 👍 Looks good ends with \`[thread <thread id>]\` alone): read_thread with that \`thread_id\` shows the whole thread.`,
    "- The person can start a new thread with your session from the Inbox: an idea or a request of their own, not an answer to anything you asked, and it may have nothing to do with your current work. It arrives the same way, and its second line says so. Say how you will handle it before you start, and answer with `reply_to` set to the id on its first line, so your answer lands in that thread; name this thread on that reply with `thread` (a few words). Files they attached are listed under their words as `Attached: <name> (<path>)`; open them by path.",
    `- Replies come back to the session that sent the message: send with your \`${INBOX_TOOL_NAME}\` tool; inside Claude Code or Pi, a command your session runs also carries the session's identity.`,
    `- In Codex ${INBOX_CODEX_QUEUE_MIN_VERSION.replace(/\.0$/, "")} or later (the TUI, the Codex app, the IDE extension), through the stdio server, the person's reply arrives in your thread by itself too: the Inbox puts it into your thread with \`codex queue\`, and it starts a new turn once the turn you are in ends (at once when the thread is idle; a closed thread gets it when it is resumed). It starts with the same \`Plannotator Inbox: <subject> (<reply id>)\` line and names your tools as you see them (send_message, read_thread). When send_message says the reply arrives by itself, end your turn instead of waiting, and do not call wait_for_reply. It never arrives in the middle of a turn (no Send now). A \`codex exec\` run is not woken (it ends after its turn): there, call wait_for_reply.`,
    `- In Qwen Code ${INBOX_QWEN_WAKE_MIN_VERSION.replace(/\.0$/, "")} or later in a terminal (macOS and Linux), through the stdio server, the person's reply arrives in your session by itself too: Plannotator is a trusted sender there, and Qwen gives it to you as a message from another program (\`<cross_session_message …>\`), as your next turn. It starts with the same \`Plannotator Inbox: <subject> (<reply id>)\` line. When send_message says the reply arrives by itself, end your turn instead of waiting, and do not call wait_for_reply. A \`qwen -p\` run, a session an editor or \`qwen serve\` drives, or one whose settings hold or refuse such messages is not woken: there, call wait_for_reply.`,
    "- OpenCode 1 has the tool but no wake, and nothing wakes another MCP client (or `codex exec`): call wait_for_reply, or read_thread later.",
    "- Grok Build can be run by the Inbox itself: the person starts a session from New message (\"New Grok Build session\" in To), and every message they send in its thread is a real turn of that session, with the same first line. The Inbox hands that session its own `plannotator-inbox` MCP server: answer with send_message `reply_to` the id, then end your turn (never wait_for_reply). If a turn ends with no message from you, the Inbox posts your last words as your answer. The person watches the turn in the thread, answers your permission requests there (calls to the Inbox's own tools need none), can Stop it, and can open the session in Grok's CLI with `grok -r <session id>`.",
    `- The person can tag you with \`@\` in a reply to another session's thread, in this project or another. With a connection that wakes you it arrives as a new message: \`Plannotator Inbox: <subject> (<reply id>)\`, then \`${INBOX_TAGGED_INSTRUCTION}\`, then the line saying whose thread it is. Read the thread first with read_thread (\`message_id\` the reply's id), answer only what is addressed to you, with \`reply_to\` that id, so your answer lands in that thread; your own thread is unchanged. The session that owns the thread gets the same reply, with a line naming who else was tagged: leave what is addressed to them to them. Without a wake (MCP), wait_for_reply and read_thread show it (\`tagged_you: true\`). Agents do not tag each other.`,
    "- The reply is the person's answer to you: their words, then an \"Answers to your questions\" section, then their comments on the text of your messages (\"Feedback on your message from <time> (<message id>)\": the exact words they selected, quoted, then their comment), then their annotations on any attached files. Files they pasted into the reply (screenshots, for example) are listed last as `Attached: <name> (<path>)`; open them by path.",
    "- The person answers in one reply per session, even when the answers are on several of your messages: then \"Answers to your questions\" has a `### Your message <id>` heading per message. Questions they did not answer stay open, and the reply says how many after their words: `You have N other questions open in this thread. They stay open; the person will answer them in the Inbox. Don't re-ask them.` Do not ask them again.",
    "- A question is skipped only when the person chose to: a skip on its card comes back as `Skipped`, \"Skip them\" in the reply box as `Skipped by the person`. Do not wait on either; ask again if you still need it.",
    "- A reply that answers none of them (the person only wrote back, or sent annotations) leaves them all open and says so after their words: `No questions answered yet; all N are still open. Don't re-ask them; the person will answer in the Inbox.` Do not ask them again: the answers come in a later reply.",
    "- The person may mark your latest message 👍 Looks good: they read it and need nothing more. About ten seconds later (after the person's Undo window) it reaches you: with a connection that wakes you, as one short message, `Plannotator Inbox: <subject> (<id>)` and then `The person marked your message 👍 Looks good (<message id>). No reply needed unless you have a question.`; otherwise wait_for_reply returns `status: \"acknowledged\"`, and read_thread shows `ack: { label, at }` on that message. Do not answer it; go on, and use `reply_to` only if you have something new for them. Only a message with no open question takes it, so it never answers a question. A wait on every thread you asked (no `thread_id`, no `cursor`) is not answered again by a 👍 you were already given.",
    `- The person may press Re-ask: you get one message (with a wake: \`Plannotator Inbox: <subject> (<id>)\`, then \`${inboxReaskInstruction("both")}\`, which names only what the note lists) listing your questions and action items still open in the thread by id. Check each against where the work is now and send ONE message with \`reply_to\` that id: the ones still needed, asked again with the context the person needs today and a \`Replaces: <id>\` line in each block; the ids of those that no longer apply in \`supersedes\`, with a line on why. An action item still needed goes back as a \`:::action\` block with its \`Replaces: <id>\` line; one you saw done goes in \`done\`. Answers the person had picked come with it under "Answers to your questions": don't ask those again. Until you do, the old questions stay open and the thread waits on you.`,
    `- The person may mark a thread read without answering: its waiting questions and action items close unanswered, and you get one message from them that starts \`${INBOX_SET_ASIDE_HEADING}\` and lists them (questions as \`- Q1.\`, action items as \`- A1.\`). Do not wait on those; ask again if you must.`,
    `- When the person marks one of your action items Done or Can't do it, it comes with their next reply, together with their words and answers: its first line says it (\`Did 1 action item.\`, or joined to the answers' line: \`Answered 1 question, did 1 action item.\`), and a section \`## ${INBOX_ACTIONS_HEADING}\` after everything else has \`### A1. <what to do>\` and \`Done, 3:12 PM.\` (and \`Note: …\` when they added one) or \`Can't do it: <their reason>\`; one you marked done yourself meanwhile reads \`You saw it done, 3:14 PM.\` with their note. Until they send, read_thread says it is in their reply draft, not sent yet. A last \`Still open: …\` line names what of that message still waits on them (don't ask those again). Go on with the work it unblocks; on Can't do it, find another way or ask.`,
    "",
    QUESTION_AUTHORING_GUIDE.trimEnd(),
    "",
    // Here, not in the guide: the guide is send_message's description, which Claude Code cuts at 2,048 characters.
    "Keep choice labels plain; mark the pick only with the `Recommended:` line, never \"(Recommended)\" in a label.",
    "",
    "(In the Inbox the person's words come before the answers.)",
    "",
    "### Only in the Inbox",
    "",
    "Three more lines a question block can carry, each on its own line (the first other line is always the question):",
    "",
    `- \`Stopped: <why>\`: you cannot go on until this is answered. The person's list shows the thread first, under "${SECTION_LABEL("stopped")}". Add it only when you truly cannot go on; otherwise leave the line out. A negative value (\`no\`, \`none\`, \`n/a\`, a dash) means no stop, so never write \`Stopped: no\`.`,
    `- \`Holds up: <name>; <name>\`: you go on, and these pieces of work wait. The list shows it under "${SECTION_LABEL("holding")}", the most held-up first. An entry that is only \`none\` (or another negative word) holds nothing up.`,
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
    "### Decision lines and picture choices",
    "",
    "Optional lines after the question, for a decision that needs them. Most questions need none of these. Write each at the block's own indent (an indented one under a choice is that choice's text); each is read once, is never context, and does not change the question's key:",
    "",
    "- `Stakes: <one sentence>`: what the choice affects, in product terms. The card shows it under the question. Give one whenever you write `Stopped:` or `Holds up:`; the send result reminds you when you did not.",
    "- `Shows: ![alt](path)` or `Shows: [name](file)`: the one picture or file the decision is about. Put long detail in that file, not in the block (context stays one to three sentences).",
    "- `Why: <one line>`: why you recommend your answer, on its own line. Shown under the choices.",
    "- `Reversible: no — <why>`: only when the answer cannot be taken back. `yes`, or no line, means it can.",
    "- A picture choice: `- [ ] Label — ![alt](path) consequence` (or a plain `- Label — ![alt](path)` bullet), on `:::question` and `:::question-multi`. The card draws the choices as pictures the person picks; the label stays required and is the answer you get back, the rest is the choice's description. Pictures are captured like the message's other images, and the send result names any that will not show.",
    "",
    "```markdown",
    INBOX_CONTRACT_EXAMPLE,
    "```",
    "",
    "### Action items only the person can do",
    "",
    INBOX_ACTION_GUIDE,
    "",
    "```markdown",
    INBOX_ACTION_EXAMPLE,
    "```",
    "",
    "The first line is the action item; every other line that is not `Where:`, `Run:`, `Stopped:`, `Holds up:`, `Watching:` or `Replaces:` is the why. An action item counts like an open question in the person's list (`Stopped:` puts the thread under \"" + SECTION_LABEL("stopped") + "\"), and its key starts with `a-`.",
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
    "Plannotator can add a short note about the Inbox to an agent's instructions, so it sends decisions and finished work here while the person is away. Only with the person's yes: show them this list, then run `plannotator inbox --notes <ids>` with only the agents they agreed to (comma-separated). A written note never overwrites a note the person edited, and the Inbox's Settings and `plannotator uninstall` remove it; Cursor's note is copied by hand instead, and Plannotator cannot see or remove that copy. On this computer:",
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
    "`plannotator inbox status` only reads; run it to check whether the Inbox is up (exit 0) or to find its address. Never run `plannotator inbox stop` or `restart` unless the person asks: other agents' sessions use the same Inbox. After a restart, connected sessions reconnect by themselves within seconds, and replies wait in the Inbox meanwhile.",
    "",
    "## Data and removal",
    "",
    `- Everything lives in ${code(inboxPath)}: threads by project, the versions of the files you sent, and \`inbox.json\` (where the running Inbox is).`,
    "- The person deletes a thread or a project in the window's Settings.",
    "- `plannotator uninstall` keeps the data. `plannotator uninstall --purge` stops a running Inbox, then deletes it (if it cannot stop it, it says so and keeps the data).",
    "- Both remove the `plannotator-inbox` MCP entries `plannotator inbox` added to the agents on this computer (`plannotator uninstall --dry-run` lists them); an entry changed by hand to run something else is left.",
    "- Never run uninstall, delete threads or projects, or edit these files for the person.",
    "",
  ].join("\n");
}
