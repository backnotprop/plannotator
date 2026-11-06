/**
 * Launch: OpenCode's permission prompts answered in the launch thread. The
 * questions are the shared ones (inbox-launch-permission.ts); this file is
 * OpenCode's terms and its transport, which is push: the launch's own
 * `opencode serve` (inbox-launch-opencode.ts) streams `permission.asked`
 * on its `/event` stream, and the answer goes back as
 *
 *   POST /permission/<request id>/reply  { reply: "once" | "always" | "reject", message? }
 *
 * (OpenCode 1.18). There is no hook, no key and no lease: the server holds
 * the request until it is answered, and says so (`permission.replied`) when
 * someone else answered it (the person in `opencode attach`), which
 * withdraws the question as "Answered in Terminal.". A server that stops or
 * goes away withdraws its open questions as "No longer waiting.".
 *
 * OpenCode's choices (`once`, `always`, `reject`): Allow once; "Allow <its
 * `always` patterns> for this session" (OpenCode keeps an `always` in the
 * server's memory, so it lasts while this launch's server runs: the session);
 * Deny, with the person's reason as OpenCode's `message`, which the model
 * reads as feedback and goes on. No mode switch: OpenCode has no Auto mode,
 * and Full permissions is how a launch starts (an allow-all ruleset).
 */

import {
  inboxPermissionDenyMessage,
  type InboxPermissionChoice,
  type InboxPermissionEvent,
  type InboxPermissionOptions,
} from "@plannotator/core/inbox-permission";

/** One `permission.asked` (OpenCode 1.18's `PermissionRequest`), the fields the Inbox reads. */
export interface OpenCodePermissionRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  always: string[];
  metadata: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** A `permission.asked` payload (or a `GET /permission` entry), or null when it is not one. */
export function readOpenCodePermission(value: unknown): OpenCodePermissionRequest | null {
  if (!isRecord(value)) return null;
  const { id, sessionID, permission } = value;
  if (typeof id !== "string" || !/^per[A-Za-z0-9_-]{1,80}$/.test(id) || typeof sessionID !== "string" || sessionID === "" || typeof permission !== "string" || permission === "") return null;
  return { id, sessionID, permission, patterns: strings(value.patterns), always: strings(value.always), metadata: isRecord(value.metadata) ? value.metadata : {} };
}

/** OpenCode's permission names, as the card's tools (the card's words and previews are keyed on these). */
const TOOLS: Record<string, string> = { bash: "Bash", edit: "Edit", read: "Read", webfetch: "WebFetch", websearch: "WebSearch" };

/**
 * The prompt as the card's event: OpenCode's `bash` is a Bash command, `edit` (edit, write and patch) an
 * Edit with OpenCode's own unified diff, `read` a Read, `webfetch` and `websearch` as theirs; any other
 * permission (`external_directory`, `task`, a newer one) keeps its own name, its patterns and metadata as the
 * input (shown whole). The "for this session" choice is OpenCode's `always` patterns, one rule each (`*`:
 * every call of that tool).
 */
export function openCodePermissionEvent(request: OpenCodePermissionRequest, folder: string): InboxPermissionEvent {
  const m = request.metadata;
  const text = (key: string) => (typeof m[key] === "string" ? (m[key] as string) : null);
  const tool = TOOLS[request.permission] ?? request.permission;
  let input: Record<string, unknown>;
  switch (request.permission) {
    case "bash":
      input = { command: text("command") ?? request.patterns.join("\n"), ...(text("description") ? { description: text("description") } : {}) };
      break;
    case "edit":
      input = { file_path: text("filepath") ?? request.patterns.join(", "), ...(text("diff") ? { diff: text("diff") } : {}) };
      break;
    case "read":
      input = { file_path: text("filepath") ?? request.patterns[0] ?? "" };
      break;
    case "webfetch":
      input = { url: text("url") ?? request.patterns[0] ?? "" };
      break;
    case "websearch":
      input = { query: text("query") ?? request.patterns[0] ?? "" };
      break;
    default:
      input = { patterns: request.patterns, ...m };
  }
  const rules = request.always.map((pattern) => (pattern === "*" ? { toolName: tool } : { toolName: tool, ruleContent: pattern }));
  return {
    session_id: request.sessionID,
    tool_name: tool,
    tool_input: input,
    cwd: folder,
    permission_suggestions: rules.length > 0 ? [{ type: "addRules", behavior: "allow", rules }] : [],
    permission_mode: null,
  };
}

/** What OpenCode's card offers: no mode switch (`full`: none), allows from here, no hand-off to a dialog of its own. */
export function openCodePermissionTerms(shownPath: (path: string) => string): InboxPermissionOptions {
  return { shownPath, full: true, fullPermissions: false, allowHere: true, terminal: false, note: null, handoff: null };
}

/** The person's choice as OpenCode's reply: once, always (the session choice), else reject with the deny words. */
export function openCodeReply(choice: InboxPermissionChoice, reason: string | null): { reply: "once" | "always" | "reject"; message?: string } {
  if (choice === "once" || choice === "auto" || choice === "full") return { reply: "once" };
  if (choice === "session") return { reply: "always" };
  return { reply: "reject", message: inboxPermissionDenyMessage(reason) };
}
