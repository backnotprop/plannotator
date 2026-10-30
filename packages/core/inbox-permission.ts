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

/** ExitPlanMode stays with plan review: the hook says nothing for it. */
export const isPlanModeExit = (event: { tool_name: string }): boolean => event.tool_name === "ExitPlanMode";

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
    return { label: `Allow work in ${code(shownPath(dirs[0]!))}${more} for this session`, update: session(folders) };
  }
  return null;
}

/** A tool's name as a noun in a sentence ("a file edit"); MCP tools by their own name. */
function toolNoun(tool: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp) return `${mcp[2]} (${mcp[1]})`;
  return { Edit: "file edit", MultiEdit: "file edit", Write: "file write", Read: "file read", WebFetch: "web page", WebSearch: "web search", NotebookEdit: "notebook edit" }[tool] ?? tool;
}

/** What the agent wants, as the card's prompt, and the detail under it (a command, a path, a link, the input). */
function asked(event: InboxPermissionEvent, agent: string, shownPath: (path: string) => string): { prompt: string; detail: string | null } {
  const input = event.tool_input;
  const text = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : null);
  const path = text("file_path") ?? text("notebook_path") ?? text("path");
  const block = (body: string) => {
    // A line that is only `:::` would close the card's block early (markdown-structure's directiveCloseIndex):
    // a zero-width space keeps it on screen as written. Display only: the decision echoes the real input.
    const shown = body.replace(/^(\s*):::(\s*)$/gm, "$1:​::$2");
    const capped = shown.length > 2000 ? `${shown.slice(0, 1999)}…` : shown;
    const longest = Math.max(2, ...(capped.match(/`{3,}/g) ?? []).map((run) => run.length));
    const fence = "`".repeat(longest + 1);
    return `${fence}\n${capped}\n${fence}`;
  };
  const json = () => (Object.keys(input).length > 0 ? block(JSON.stringify(input, null, 2)) : null);
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
  if (mcp) return { prompt: `${agent} wants to use ${code(mcp[2]!)} from ${mcp[1]}`, detail: json() };
  return { prompt: `${agent} wants to use ${code(event.tool_name)}`, detail: json() };
}

export interface InboxPermissionQuestion {
  /** The message body: one `:::question` block. */
  body: string;
  /** The choices in order: Allow once, the session choice when there is one, Deny. */
  choices: string[];
  /** The session choice's update (Allow for this session), or null. */
  sessionUpdate: Record<string, unknown> | null;
}

export const INBOX_PERMISSION_ALLOW_ONCE = "Allow once";
export const INBOX_PERMISSION_DENY = "Deny";

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
  const { prompt, detail } = asked(event, options.agent, shownPath);
  const session = inboxPermissionSessionChoice(event, shownPath);
  const choices = [INBOX_PERMISSION_ALLOW_ONCE, ...(session ? [session.label] : []), INBOX_PERMISSION_DENY];
  const lines = [":::question", prompt, ""];
  if (detail) lines.push(detail, "");
  lines.push(`in ${code(options.folder)}`, "");
  for (const choice of choices) lines.push(`- ${choice}`);
  lines.push(":::");
  return { body: lines.join("\n"), choices, sessionUpdate: session?.update ?? null };
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

/**
 * The person's answer as Claude Code's decision. `choices` are the question's
 * choices as the store keeps them, in order (Allow once, [session], Deny); the
 * pick is matched by position. Free text with no pick, a Skip, or anything
 * unknown is a Deny; the free text (or a note) is the reason.
 */
export function inboxPermissionDecision(
  answer: QuestionAnswer | null,
  input: { event: InboxPermissionEvent; choices: readonly string[]; sessionUpdate: Record<string, unknown> | null },
): InboxPermissionDecision {
  const reason = [answer?.other, answer?.note].map((t) => t?.trim()).filter(Boolean).join(" ") || null;
  const picked = answer && !answer.skipped ? answer.selected[0] : undefined;
  const index = picked === undefined ? -1 : input.choices.indexOf(picked);
  const deny = input.choices.length - 1;
  if (index === 0) return { behavior: "allow", updatedInput: input.event.tool_input };
  if (index > 0 && index < deny && input.sessionUpdate) {
    return { behavior: "allow", updatedInput: input.event.tool_input, updatedPermissions: [input.sessionUpdate] };
  }
  return { behavior: "deny", message: inboxPermissionDenyMessage(reason) };
}

/** The hook's stdout for a decision. */
export function inboxPermissionHookOutput(decision: InboxPermissionDecision): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
}
