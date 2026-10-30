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

/** The card's small label over the prompt, and the free-text row's placeholder (the reason for a Deny). */
export const INBOX_PERMISSION_EYEBROW = "Permission";
export const INBOX_PERMISSION_REASON_PLACEHOLDER = "Deny, and tell it why…";

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

/** A Bash rule's command, as the person reads it: `bun run:*` → `bun run`. */
const ruleCommand = (content: string) => content.replace(/(?::\*|\s\*)$/, "").trim();

/** Inline code that survives backticks in the text. */
function code(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return longest > 0 ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

/** One line, at most `max` characters. */
function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The "for this session" choice Claude Code itself suggests (`permission_suggestions`,
 * the dialog's "Yes, and don't ask again"), in words, and the update to send back
 * with destination `session` (never the person's settings files). A rule first,
 * then accepting edits, then a folder. Null when nothing fits: the card offers
 * Allow once and Deny only. Never a mode that skips every prompt.
 */
export function inboxPermissionSessionChoice(
  event: InboxPermissionEvent,
  shownPath: (path: string) => string = (path) => path,
): { label: string; update: Record<string, unknown> } | null {
  const session = (s: Record<string, unknown>) => ({ ...s, destination: "session" });
  const rules = event.permission_suggestions.find(
    (s) => s.type === "addRules" && (s.behavior === undefined || s.behavior === "allow") && Array.isArray(s.rules) && s.rules.some(isRecord),
  );
  if (rules) {
    const list = (rules.rules as unknown[]).filter(isRecord);
    const first = list[0]!;
    const tool = typeof first.toolName === "string" ? first.toolName : event.tool_name;
    const content = typeof first.ruleContent === "string" ? first.ruleContent.trim() : "";
    let what: string;
    if (!content) what = tool === "Bash" ? "every command" : `every ${toolNoun(tool)}`;
    else if (tool === "Bash") what = code(oneLine(ruleCommand(content), 60));
    else if (tool === "WebFetch" && content.startsWith("domain:")) what = `pages on ${content.slice("domain:".length)}`;
    else what = `${toolNoun(tool)} ${code(oneLine(content, 60))}`;
    const more = list.length > 1 ? ` and ${list.length - 1} more` : "";
    return { label: `Allow ${what}${more} for this session`, update: session(rules) };
  }
  const edits = event.permission_suggestions.find((s) => s.type === "setMode" && s.mode === "acceptEdits");
  if (edits) return { label: "Allow file edits for this session", update: session(edits) };
  const folders = event.permission_suggestions.find((s) => s.type === "addDirectories" && Array.isArray(s.directories) && s.directories.some((d) => typeof d === "string"));
  if (folders) {
    const dirs = (folders.directories as unknown[]).filter((d): d is string => typeof d === "string");
    const more = dirs.length > 1 ? ` and ${dirs.length - 1} more` : "";
    return { label: `Allow work in ${code(oneLine(shownPath(dirs[0]!), 120))}${more} for this session`, update: session(folders) };
  }
  return null;
}

/** A tool's name as a noun in a sentence ("a file edit"); MCP tools by their own name. */
function toolNoun(tool: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp) return oneLine(`${mcp[2]} (${mcp[1]})`);
  return { Edit: "file edit", MultiEdit: "file edit", Write: "file write", Read: "file read", WebFetch: "web page", WebSearch: "web search", NotebookEdit: "notebook edit" }[tool] ?? tool;
}

/** What the agent wants, as the card's prompt, and the detail over it (a command, a path, a link, the input). */
function asked(event: InboxPermissionEvent, agent: string, shownPath: (path: string) => string): { prompt: string; detail: string | null; tooLong: boolean } {
  const input = event.tool_input;
  const text = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : null);
  const path = text("file_path") ?? text("notebook_path") ?? text("path");
  let tooLong = false;
  const block = (body: string) => {
    if (body.length > INBOX_PERMISSION_DETAIL_MAX) tooLong = true;
    // A line that starts with `:::` could read as a directive's edge: a zero-width space keeps it on screen as written.
    // Display only: the hook echoes the real input.
    const shown = body.replace(/^(\s*):::/gm, "$1:​::");
    const longest = Math.max(2, ...(shown.match(/`{3,}/g) ?? []).map((run) => run.length));
    const fence = "`".repeat(longest + 1);
    return `${fence}\n${shown}\n${fence}`;
  };
  const json = () => (Object.keys(input).length > 0 ? block(JSON.stringify(input, null, 2)) : null);
  const what = whatOf();
  return { ...what, tooLong };
  function whatOf(): { prompt: string; detail: string | null } {
  switch (event.tool_name) {
    case "Bash":
      return { prompt: `${agent} wants to run a command`, detail: text("command") ? block(text("command")!) : json() };
    case "Edit":
    case "MultiEdit":
      return { prompt: `${agent} wants to edit a file`, detail: path ? code(shownPath(path)) : json() };
    case "Write":
      return { prompt: `${agent} wants to write a file`, detail: path ? code(shownPath(path)) : json() };
    case "NotebookEdit":
      return { prompt: `${agent} wants to edit a notebook`, detail: path ? code(shownPath(path)) : json() };
    case "Read":
      return { prompt: `${agent} wants to read a file`, detail: path ? code(shownPath(path)) : json() };
    case "WebFetch":
      return { prompt: `${agent} wants to open a web page`, detail: text("url") ? `<${text("url")}>` : json() };
    case "WebSearch":
      return { prompt: `${agent} wants to search the web`, detail: text("query") ? code(oneLine(text("query")!, 200)) : json() };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(event.tool_name);
  if (mcp) return { prompt: `${agent} wants to use ${code(oneLine(mcp[2]!))} from ${oneLine(mcp[1]!)}`, detail: json() };
  return { prompt: `${agent} wants to use ${code(oneLine(event.tool_name))}`, detail: json() };
  }
}

export interface InboxPermissionQuestion {
  /** The message body: the detail and folder, then one `:::question` block holding only the prompt and the choices. */
  body: string;
  /** The choices in order: Allow once, the session choice when there is one, Deny. */
  choices: string[];
  /** The detail is longer than the card shows in full: never ask this one here. */
  tooLong: boolean;
}

/**
 * The question for one permission prompt: what the agent wants, where, and
 * Allow once / Allow <suggestion> for this session / Deny. The free-text row
 * under the choices is the reason for a Deny.
 */
export function inboxPermissionQuestion(
  event: InboxPermissionEvent,
  options: { agent: string; folder: string; shownPath?: (path: string) => string },
): InboxPermissionQuestion {
  const shownPath = options.shownPath ?? ((path: string) => path);
  const { prompt, detail, tooLong } = asked(event, options.agent, shownPath);
  const choices = inboxPermissionChoices(event, shownPath);
  // The command (or path, or input) and the folder go OVER the block, never in it: inside, a line of the
  // command that reads as a list item (`- Deny`, a commit message's bullets, `- [ ] x`) would become a choice.
  // The block holds only the prompt and the choices, written as checkboxes.
  const lines: string[] = [];
  if (detail) lines.push(detail, "");
  lines.push(`in ${code(oneLine(options.folder, 200))}`, "", ":::question", prompt, "");
  for (const choice of choices) lines.push(`- [ ] ${choice}`);
  lines.push(":::");
  return { body: lines.join("\n"), choices, tooLong };
}

/** The choices a prompt's question must have, in order: Allow once, the session choice when there is one, Deny. */
export function inboxPermissionChoices(event: InboxPermissionEvent, shownPath: (path: string) => string = (path) => path): string[] {
  const session = inboxPermissionSessionChoice(event, shownPath);
  return [INBOX_PERMISSION_ALLOW_ONCE, ...(session ? [session.label] : []), INBOX_PERMISSION_DENY];
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

/** What the person chose, as the Inbox hands it to the hook: never a decision's JSON. */
export type InboxPermissionChoice = "once" | "session" | "deny";
export interface InboxPermissionAnswer {
  choice: InboxPermissionChoice;
  /** The reason the person gave with a Deny, or null. */
  reason: string | null;
}

/** The longest reason passed on to the agent. */
export const INBOX_PERMISSION_REASON_MAX = 2_000;

/**
 * The person's answer as one of three choices. The pick is matched by its
 * exact label against the labels this prompt's event makes, never by
 * position: "Allow once", the session label rebuilt from the event, and
 * anything else (a Skip, free text with no pick, an unknown label) is a Deny.
 * The free text (or a note) is the reason.
 */
export function inboxPermissionAnswer(answer: QuestionAnswer | null, event: InboxPermissionEvent, shownPath: (path: string) => string = (path) => path): InboxPermissionAnswer {
  const reason = [answer?.other, answer?.note].map((t) => t?.trim()).filter(Boolean).join(" ").slice(0, INBOX_PERMISSION_REASON_MAX) || null;
  const picked = answer && !answer.skipped && answer.selected.length === 1 ? answer.selected[0] : undefined;
  if (picked === INBOX_PERMISSION_ALLOW_ONCE) return { choice: "once", reason: null };
  const session = inboxPermissionSessionChoice(event, shownPath);
  if (session && picked === session.label) return { choice: "session", reason: null };
  return { choice: "deny", reason };
}

/**
 * The decision Claude Code reads, built by the hook from ITS OWN event: the
 * tool input unchanged, and for "session" the update Claude Code itself
 * suggested (destination `session`, never bypass mode). Null when the answer
 * cannot be honoured (an unknown choice, or "session" with no suggestion):
 * say nothing, and Claude Code's own dialog decides.
 */
export function inboxPermissionDecisionFor(event: InboxPermissionEvent, answer: { choice?: unknown; reason?: unknown }): InboxPermissionDecision | null {
  if (answer.choice === "once") return { behavior: "allow", updatedInput: event.tool_input };
  if (answer.choice === "session") {
    const session = inboxPermissionSessionChoice(event);
    return session ? { behavior: "allow", updatedInput: event.tool_input, updatedPermissions: [session.update] } : null;
  }
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
