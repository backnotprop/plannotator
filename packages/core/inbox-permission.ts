/**
 * Claude Code permission prompts answered in the Inbox (launch, PR 2; PLAN
 * "Permission hook"). A session the Inbox launched runs
 * `plannotator inbox permission-hook` on every PermissionRequest; the hook
 * hands the event to the Inbox, which asks the person with an ordinary
 * question card in the launch thread, and prints the person's answer in the
 * shape Claude Code reads (proved in .ops/work/bg-perm-test/RESULTS.md).
 *
 * Pure and browser-safe: what the question says, which choices it offers,
 * and how an answer becomes Claude Code's decision. The server and the hook
 * share it; the window reads `isInboxPermissionSession` to draw the card.
 *
 * The question is written by its own identity, `perm:<session id>`, so the
 * person's answer is never handed to the session's own poll as a new turn.
 */

import type { QuestionAnswer } from "./question-block";

export const INBOX_PERMISSION_ALLOW_ONCE = "Allow once";
export const INBOX_PERMISSION_DENY = "Deny";

/** The author session of a permission question: `perm:<Claude Code session id>`. */
export const INBOX_PERMISSION_SESSION_PREFIX = "perm:";

export const inboxPermissionSession = (sessionId: string): string => `${INBOX_PERMISSION_SESSION_PREFIX}${sessionId}`;

/** Whether an author session is a permission question's (`perm:…`). */
export function isInboxPermissionSession(session: string | null | undefined): boolean {
  return typeof session === "string" && session.startsWith(INBOX_PERMISSION_SESSION_PREFIX);
}

/** The follow-ups that withdraw a question no hook waits on any more. */
export const INBOX_PERMISSION_ANSWERED_IN_TERMINAL = "Answered in Terminal.";
export const INBOX_PERMISSION_NO_LONGER_WAITING = "No longer waiting.";
/** The follow-up when a card could not offer exactly this prompt's choices: it is never answered here. */
export const INBOX_PERMISSION_ASK_IN_TERMINAL = "This one can't be answered here. Answer it in Terminal.";

/** The part of Claude Code's PermissionRequest stdin the Inbox reads. */
export interface InboxPermissionEvent {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  cwd: string | null;
  permission_suggestions: Record<string, unknown>[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** The event from a hook's stdin JSON (or the route's body), or null when it is not one. */
export function readInboxPermissionEvent(value: unknown): InboxPermissionEvent | null {
  if (!isRecord(value)) return null;
  const { session_id, tool_name, tool_input, cwd, permission_suggestions } = value;
  if (typeof session_id !== "string" || session_id === "" || typeof tool_name !== "string" || tool_name === "") return null;
  return {
    session_id,
    tool_name,
    tool_input: isRecord(tool_input) ? tool_input : {},
    cwd: typeof cwd === "string" && cwd !== "" ? cwd : null,
    permission_suggestions: Array.isArray(permission_suggestions) ? permission_suggestions.filter(isRecord) : [],
  };
}

/**
 * Tools the hook never answers: ExitPlanMode stays with plan review, and
 * AskUserQuestion with Claude Code's own dialog (an Allow there would carry no
 * answers). The hook says nothing for them.
 */
export const isPassThroughTool = (event: { tool_name: string }): boolean => event.tool_name === "ExitPlanMode" || event.tool_name === "AskUserQuestion";

/** The longest command, path or input the card shows. A longer one is never asked here: the person could not read all of it. */
export const INBOX_PERMISSION_DETAIL_MAX = 8_000;

/** The longest "for this session" label. A longer one is not offered: every rule it grants must be readable. */
export const INBOX_PERMISSION_LABEL_MAX = 200;

/** Bidi controls and invisible characters (a reversed or hidden part of a command, as in Trojan Source). */
const INVISIBLE = "\\u061C\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF";
/** Controls a multi-line block may not show as they are: every C0 but a tab and a line feed, C1, and the Unicode line and paragraph separators. */
const BLOCK_CONTROL = "\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u2028\\u2029";
/** Text that reads exactly as it is, on one line: no control (a tab or a line break neither), nothing invisible. */
const PLAIN = new RegExp(`^[^\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029${INVISIBLE}]*$`);
const HIDDEN = new RegExp(`[${BLOCK_CONTROL}${INVISIBLE}]`, "g");
const plain = (text: string) => PLAIN.test(text);

/**
 * Text as the person reads it: every control (a tab and a line feed excepted)
 * and every invisible character shown as `⟨U+202E⟩`, never hidden and never
 * acted on. Display only: the hook echoes the real input.
 */
const visible = (text: string) =>
  text.replace(/\r\n/g, "\n").replace(HIDDEN, (c) => `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟩`);

/** A Bash rule's command, as the person reads it: `bun run:*` → `bun run`. */
const ruleCommand = (content: string) => content.replace(/(?::\*|\s\*)$/, "").trim();

/** Inline code that survives backticks in the text. */
function code(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return longest > 0 ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

/** One line, at most `max` characters, every control and invisible character shown. */
function oneLine(text: string, max = 80): string {
  const flat = visible(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** "a", "a and b", "a, b and c". */
const listed = (items: string[]) => (items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** One rule as the person reads it, in full; null when it cannot be shown exactly (a line break, a control, an invisible character). */
function ruleWords(rule: Record<string, unknown>, fallbackTool: string): string | null {
  const tool = typeof rule.toolName === "string" ? rule.toolName : fallbackTool;
  const content = typeof rule.ruleContent === "string" ? rule.ruleContent.trim() : "";
  if (!plain(tool) || !plain(content)) return null;
  if (!content) return tool === "Bash" ? "every command" : `every ${toolNoun(tool)}`;
  if (tool === "Bash") return code(ruleCommand(content));
  if (tool === "WebFetch" && content.startsWith("domain:")) return `pages on ${content.slice("domain:".length)}`;
  return `${toolNoun(tool)} ${code(content)}`;
}

/**
 * The "for this session" choice Claude Code itself suggests (`permission_suggestions`,
 * the dialog's "Yes, and don't ask again"), in words, and the update to send back
 * with destination `session` (never the person's settings files). A rule first,
 * then accepting edits, then a folder. The label names EVERY rule or folder the
 * update grants, in full: one it cannot show exactly, or a label longer than
 * `INBOX_PERMISSION_LABEL_MAX`, offers no session choice. Null when nothing fits:
 * the card offers Allow once and Deny only. Never a mode that skips every prompt.
 */
export function inboxPermissionSessionChoice(
  event: InboxPermissionEvent,
  shownPath: (path: string) => string = (path) => path,
): { label: string; update: Record<string, unknown> } | null {
  const session = (s: Record<string, unknown>) => ({ ...s, destination: "session" });
  const offer = (granted: (string | null)[], suggestion: Record<string, unknown>) => {
    if (granted.length === 0 || granted.some((g) => g === null)) return null;
    const label = `Allow ${listed(granted as string[])} for this session`;
    return label.length > INBOX_PERMISSION_LABEL_MAX ? null : { label, update: session(suggestion) };
  };
  const rules = event.permission_suggestions.find(
    (s) => s.type === "addRules" && (s.behavior === undefined || s.behavior === "allow") && Array.isArray(s.rules) && s.rules.some(isRecord),
  );
  if (rules) return offer((rules.rules as unknown[]).filter(isRecord).map((rule) => ruleWords(rule, event.tool_name)), rules);
  const edits = event.permission_suggestions.find((s) => s.type === "setMode" && s.mode === "acceptEdits");
  if (edits) return { label: "Allow file edits for this session", update: session(edits) };
  const folders = event.permission_suggestions.find((s) => s.type === "addDirectories" && Array.isArray(s.directories) && s.directories.some((d) => typeof d === "string"));
  if (folders) {
    const dirs = (folders.directories as unknown[]).filter((d): d is string => typeof d === "string");
    return offer(dirs.map((dir) => (plain(dir) ? `work in ${code(shownPath(dir))}` : null)), folders);
  }
  return null;
}

/** A tool's name as a noun in a sentence ("a file edit"); MCP tools by their own name. */
function toolNoun(tool: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp) return oneLine(`${mcp[2]} (${mcp[1]})`);
  return { Edit: "file edit", MultiEdit: "file edit", Write: "file write", Read: "file read", WebFetch: "web page", WebSearch: "web search", NotebookEdit: "notebook edit" }[tool] ?? oneLine(tool);
}

/** What the card shows over the question: a command or the input in a fenced block, or a path, a link or a query on one line. */
type Detail = { text: string; on: "block" | "line" };

/** What the agent wants, as the card's prompt, and the detail to show over it (taken from the tool's input). */
function asked(event: InboxPermissionEvent, agent: string, shownPath: (path: string) => string): { prompt: string; detail: Detail | null } {
  const input = event.tool_input;
  const text = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : null);
  const json: Detail | null = Object.keys(input).length > 0 ? { text: JSON.stringify(input, null, 2), on: "block" } : null;
  const line = (value: string | null): Detail | null => (value === null ? json : { text: value, on: "line" });
  const path = text("file_path") ?? text("notebook_path") ?? text("path");
  const file = line(path === null ? null : shownPath(path));
  switch (event.tool_name) {
    case "Bash": {
      const command = text("command");
      return { prompt: `${agent} wants to run a command`, detail: command === null ? json : { text: command, on: "block" } };
    }
    case "Edit":
    case "MultiEdit":
      return { prompt: `${agent} wants to edit a file`, detail: file };
    case "Write":
      return { prompt: `${agent} wants to write a file`, detail: file };
    case "NotebookEdit":
      return { prompt: `${agent} wants to edit a notebook`, detail: file };
    case "Read":
      return { prompt: `${agent} wants to read a file`, detail: file };
    case "WebFetch":
      return { prompt: `${agent} wants to open a web page`, detail: line(text("url")) };
    case "WebSearch":
      return { prompt: `${agent} wants to search the web`, detail: line(text("query")) };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(event.tool_name);
  if (mcp) return { prompt: `${agent} wants to use ${code(oneLine(mcp[2]!))} from ${oneLine(mcp[1]!)}`, detail: json };
  return { prompt: `${agent} wants to use ${code(oneLine(event.tool_name))}`, detail: json };
}

/** A fenced block for the body: longer than any run of 3+ backticks in the text, a line starting `:::` broken with a zero-width space, every control or invisible character shown. */
function fenced(text: string, info = ""): string {
  const shown = visible(text).replace(/^(\s*):::/gm, "$1:​::");
  const fence = "`".repeat(Math.max(2, ...(shown.match(/`{3,}/g) ?? []).map((run) => run.length)) + 1);
  return `${fence}${info}\n${shown}\n${fence}`;
}

/**
 * The detail as Markdown over the card, or null when it cannot be shown in
 * full and exactly: longer than `INBOX_PERMISSION_DETAIL_MAX`, or a path, link
 * or query holding a line break, a control or an invisible character (a line
 * break could open a `:::question` of its own over the real choices). A block
 * is fenced (`fenced`).
 */
function shownDetail(detail: Detail): string | null {
  if (detail.text.length > INBOX_PERMISSION_DETAIL_MAX) return null;
  if (detail.on === "line") return plain(detail.text) ? code(detail.text) : null;
  return fenced(detail.text);
}

/** The longest file content or change a card shows. A longer one is never asked here: the person could not read all of what they allow. */
export const INBOX_PERMISSION_PREVIEW_MAX = 50_000;

/** What Claude Code's own dialog shows besides the detail: a Write's content, an Edit's change (`-` and `+` lines). */
export interface InboxPermissionPreview {
  kind: "write" | "diff";
  text: string;
}

function previewOf(event: InboxPermissionEvent): InboxPermissionPreview | null {
  const input = event.tool_input;
  const text = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : null);
  if (event.tool_name === "Write" && text("content") !== null) return { kind: "write", text: text("content")!.replace(/\n$/, "") };
  if (event.tool_name === "Edit" && text("old_string") !== null && text("new_string") !== null) {
    const sign = (mark: string, body: string) => body.split("\n").map((line) => `${mark}${line}`);
    return { kind: "diff", text: [...sign("-", text("old_string")!), ...sign("+", text("new_string")!)].join("\n") };
  }
  return null;
}

/** What Claude says the call is for (a Bash call's description, a fetch's prompt): one plain line, or null. */
function purposeOf(event: InboxPermissionEvent): string | null {
  const key = event.tool_name === "Bash" ? "description" : event.tool_name === "WebFetch" ? "prompt" : null;
  const value = key && typeof event.tool_input[key] === "string" ? (event.tool_input[key] as string).trim() : "";
  // Commentary, not the request: one that cannot be shown exactly on one line is left out.
  return value && plain(value) ? oneLine(value, 300) : null;
}

/**
 * Whether a launched session can switch to Full permissions (`bypassPermissions`):
 * Claude Code honours that switch only in a session started with them allowed.
 * Today that is a launch made with Settings → Agents' "Start new sessions with
 * full permissions" (`--permission-mode bypassPermissions`). If every launch
 * also passes `--allow-dangerously-skip-permissions` (the owner's open
 * question), this is where it says so.
 */
export const inboxLaunchFullPermissions = (launch: { full_permissions?: true }): boolean => launch.full_permissions === true;

/** In a launch's settings file `env` when `inboxLaunchFullPermissions`: the hook honours "Full permissions" only then. */
export const INBOX_LAUNCH_FULL_PERMISSIONS_ENV = "PLANNOTATOR_LAUNCH_FULL_PERMISSIONS";

/** The answer that also switches the session's mode (Claude Code's `setMode`, destination `session`). */
export const INBOX_PERMISSION_AUTO = "Allow and switch to Auto mode";
export const INBOX_PERMISSION_FULL = "Allow and switch to Full permissions";

export interface InboxPermissionOptions {
  /** A path as the person reads it (`~/…`). */
  shownPath?: (path: string) => string;
  /** The session can switch to Full permissions (it started with them allowed). */
  fullPermissions?: boolean;
}

export interface InboxPermissionQuestion {
  /** The message body: the detail, the preview, the purpose and the folder, then one `:::question` block holding only the prompt and the choices. */
  body: string;
  /** The question's prompt, as the store must read it back. */
  prompt: string;
  /** The choices in order (`inboxPermissionChoices`). */
  choices: string[];
  /** False when the detail or the preview cannot be shown in full and exactly: never asked here (Claude Code's own dialog decides). */
  askable: boolean;
}

/**
 * The question for one permission prompt: what the agent wants, where, and
 * its choices. The window draws it as the permission card
 * (`readInboxPermissionBody` reads the body back).
 */
export function inboxPermissionQuestion(event: InboxPermissionEvent, options: { agent: string; folder: string } & InboxPermissionOptions): InboxPermissionQuestion {
  const shownPath = options.shownPath ?? ((path: string) => path);
  const { prompt, detail } = asked(event, options.agent, shownPath);
  const shown = detail === null ? null : shownDetail(detail);
  const preview = previewOf(event);
  const purpose = purposeOf(event);
  const choices = inboxPermissionChoices(event, options);
  // Everything taken from the tool's input goes OVER the block, never in it: inside, a line that reads
  // as a list item (`- Deny`, a commit message's bullets, `- [ ] x`) would become a choice.
  // The block holds only the prompt and the choices, written as checkboxes.
  const lines: string[] = [];
  if (shown) lines.push(shown, "");
  if (preview) lines.push(fenced(preview.text, preview.kind), "");
  if (purpose) lines.push(`Purpose: ${purpose}`, "");
  lines.push(`in ${code(oneLine(options.folder, 200))}`, "", ":::question", prompt, "");
  for (const choice of choices) lines.push(`- [ ] ${choice}`);
  lines.push(":::");
  const askable = (detail === null || shown !== null) && (preview === null || preview.text.length <= INBOX_PERMISSION_PREVIEW_MAX);
  return { body: lines.join("\n"), prompt, choices, askable };
}

/**
 * The choices a prompt's question must have, in order: Allow once, the
 * session choice when there is one, Deny, then the mode switches (Auto mode
 * always, Full permissions only when the session can switch to it).
 */
export function inboxPermissionChoices(event: InboxPermissionEvent, options: InboxPermissionOptions = {}): string[] {
  const session = inboxPermissionSessionChoice(event, options.shownPath);
  return [
    INBOX_PERMISSION_ALLOW_ONCE,
    ...(session ? [session.label] : []),
    INBOX_PERMISSION_DENY,
    INBOX_PERMISSION_AUTO,
    ...(options.fullPermissions ? [INBOX_PERMISSION_FULL] : []),
  ];
}

/** A permission question's body read back for the card: exactly what `inboxPermissionQuestion` wrote over the block. */
export interface InboxPermissionBody {
  /** The command or the input (a block), or the path, link or query (a line), as shown. */
  detail: { text: string; on: "block" | "line" } | null;
  preview: InboxPermissionPreview | null;
  purpose: string | null;
  folder: string | null;
}

/** Inline code back to its text (`code`). */
function uncode(text: string): string | null {
  const m = /^(`+)(.*)\1$/.exec(text);
  if (!m) return null;
  return m[1]!.length > 1 && m[2]!.startsWith(" ") && m[2]!.endsWith(" ") ? m[2]!.slice(1, -1) : m[2]!;
}

/**
 * Reads a permission question's body the way `inboxPermissionQuestion` wrote
 * it, line by line, up to its own `:::question` (a line of the input that
 * starts `:::` was broken, so the first one at a line's start is the block's).
 * A fence closes only on its own exact line (it is longer than any run of
 * backticks inside). Display only: the decision never comes from here.
 */
export function readInboxPermissionBody(body: string): InboxPermissionBody {
  const lines = body.split("\n");
  const end = lines.indexOf(":::question");
  const head = end < 0 ? lines : lines.slice(0, end);
  const out: InboxPermissionBody = { detail: null, preview: null, purpose: null, folder: null };
  for (let i = 0; i < head.length; i++) {
    const line = head[i]!;
    const open = /^(`{3,})(write|diff)?$/.exec(line);
    if (open) {
      const close = head.indexOf(open[1]!, i + 1);
      if (close < 0) break;
      const text = head.slice(i + 1, close).join("\n").replace(/^(\s*):​::/gm, "$1:::");
      if (open[2]) out.preview = { kind: open[2] as InboxPermissionPreview["kind"], text };
      else out.detail = { text, on: "block" };
      i = close;
    } else if (line.startsWith("in `")) out.folder = uncode(line.slice(3));
    else if (line.startsWith("Purpose: ")) out.purpose = line.slice("Purpose: ".length);
    else if (line.startsWith("`")) {
      const text = uncode(line);
      if (text !== null) out.detail = { text, on: "line" };
    }
  }
  return out;
}

/** Claude Code's PermissionRequest decision (`hookSpecificOutput.decision`). */
export type InboxPermissionDecision =
  | { behavior: "allow"; updatedInput: Record<string, unknown>; updatedPermissions?: Record<string, unknown>[] }
  | { behavior: "deny"; message: string };

/** What the agent is told on a Deny: never to retry, and to go on; the person's reason when they gave one. */
export function inboxPermissionDenyMessage(reason: string | null): string {
  const why = reason?.trim();
  return `The person denied this in the Plannotator Inbox. Do not retry it; go on with the next step without it.${why ? ` Their reason: ${why}` : ""}`;
}

/** What the person chose, as the Inbox hands it to the hook: never a decision's JSON. `auto` and `full` allow and switch the session's mode. */
export type InboxPermissionChoice = "once" | "session" | "deny" | "auto" | "full";
export interface InboxPermissionAnswer {
  choice: InboxPermissionChoice;
  /** The reason the person gave with a Deny, or null. */
  reason: string | null;
}

/** The longest reason passed on to the agent. */
export const INBOX_PERMISSION_REASON_MAX = 2_000;

/**
 * The person's answer as one of the choices. The pick is matched by its
 * exact label against the labels this prompt's event makes, never by
 * position: "Allow once", the session label rebuilt from the event, the mode
 * switches (Full permissions only when the session can switch to it), and
 * anything else (a Skip, free text with no pick, an unknown label) is a Deny.
 * The free text (or a note) is the reason.
 */
export function inboxPermissionAnswer(answer: QuestionAnswer | null, event: InboxPermissionEvent, options: InboxPermissionOptions = {}): InboxPermissionAnswer {
  const reason = [answer?.other, answer?.note].map((t) => t?.trim()).filter(Boolean).join(" ").slice(0, INBOX_PERMISSION_REASON_MAX) || null;
  const picked = answer && !answer.skipped && answer.selected.length === 1 ? answer.selected[0] : undefined;
  if (picked === INBOX_PERMISSION_ALLOW_ONCE) return { choice: "once", reason: null };
  if (picked === INBOX_PERMISSION_AUTO) return { choice: "auto", reason: null };
  if (picked === INBOX_PERMISSION_FULL && options.fullPermissions) return { choice: "full", reason: null };
  const session = inboxPermissionSessionChoice(event, options.shownPath);
  if (session && picked === session.label) return { choice: "session", reason: null };
  return { choice: "deny", reason };
}

/** Claude Code's `setMode` update, for this session only. */
const setMode = (mode: "auto" | "bypassPermissions") => ({ type: "setMode", mode, destination: "session" });

/**
 * The decision Claude Code reads, built by the hook from ITS OWN event: the
 * tool input unchanged; for "session" the update Claude Code itself suggested
 * (destination `session`); for "auto" Auto mode for this session; for "full"
 * Full permissions (`bypassPermissions`) for this session, only when the
 * hook's own launch allows them (`fullPermissions`). Null when the answer
 * cannot be honoured (an unknown choice, "session" with no suggestion, "full"
 * not allowed): say nothing, and Claude Code's own dialog decides.
 */
export function inboxPermissionDecisionFor(
  event: InboxPermissionEvent,
  answer: { choice?: unknown; reason?: unknown },
  options: { fullPermissions?: boolean } = {},
): InboxPermissionDecision | null {
  if (answer.choice === "once") return { behavior: "allow", updatedInput: event.tool_input };
  if (answer.choice === "session") {
    const session = inboxPermissionSessionChoice(event);
    return session ? { behavior: "allow", updatedInput: event.tool_input, updatedPermissions: [session.update] } : null;
  }
  if (answer.choice === "auto") return { behavior: "allow", updatedInput: event.tool_input, updatedPermissions: [setMode("auto")] };
  if (answer.choice === "full") return options.fullPermissions ? { behavior: "allow", updatedInput: event.tool_input, updatedPermissions: [setMode("bypassPermissions")] } : null;
  if (answer.choice === "deny") {
    const reason = typeof answer.reason === "string" ? answer.reason.slice(0, INBOX_PERMISSION_REASON_MAX) : null;
    return { behavior: "deny", message: inboxPermissionDenyMessage(reason) };
  }
  return null;
}

/** The hook's stdout for a decision. */
export function inboxPermissionHookOutput(decision: InboxPermissionDecision): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
}
