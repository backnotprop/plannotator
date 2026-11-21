/**
 * The window routes a paired cloud agent's commands reach through the agent door (`route`, inbox-agent-door.ts), so
 * `plannotator inbox rows`, `inbox projects`, `inbox icon` and `inbox export-decisions` work over a pairing exactly as
 * they do on the person's computer: each command is a thin client over these same routes on the local listener, and
 * through the door its request is answered by the Inbox's own handler, in this process. Only the routes those commands
 * use are carried; a rows change is said to be the pairing's agent's, as a local agent's names its own session.
 */

import { INBOX_AGENT_ROUTE } from "@plannotator/shared/inbox/agent-pairing";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { ok, type ToolResult } from "./inbox-mcp-result";

const FIELDS = ["method", "path", "body"];
const ID = "[A-Za-z0-9_-]{1,80}";

/** Each route the commands use: its method and its path, as the command sends it. */
const ROUTES: readonly { method: "GET" | "POST"; path: RegExp }[] = [
  { method: "GET", path: /^\/api\/inbox\/settings$/ },
  { method: "POST", path: /^\/api\/inbox\/settings$/ },
  { method: "GET", path: /^\/api\/inbox\/projects$/ },
  { method: "GET", path: /^\/api\/inbox\/tidy\?surface=list$/ },
  { method: "POST", path: new RegExp(`^/api/inbox/projects/${ID}/combine$`) },
  { method: "POST", path: /^\/api\/inbox\/icon-animate$/ },
  { method: "GET", path: new RegExp(`^/api/inbox/threads/${ID}/decisions\\?[A-Za-z0-9_=&%.+/-]*$`) },
  { method: "POST", path: new RegExp(`^/api/inbox/threads/${ID}/decisions/post$`) },
];

/** The settings a rows command sends: the look, and its undo. Who made it is the door's to say. */
const ROWS_FIELDS = ["rows", "rows_undo"];

const refuse = (message: string) => new InboxError("validation_error", message);

/**
 * `route` at the agent door, or null for any other action: the Inbox's answer to one of the commands' requests, as
 * `{ status, content_type, body }` (the body as text). `by`: the agent, named on a rows change.
 */
export async function inboxAgentRouteAction(
  handle: ((req: Request) => Promise<Response>) | undefined,
  by: { host: string; session: string },
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolResult | null> {
  if (tool !== INBOX_AGENT_ROUTE) return null;
  const extra = Object.keys(args).find((field) => !FIELDS.includes(field));
  if (extra) throw refuse(`${extra}: not taken. ${tool} takes: ${FIELDS.join(", ")}.`);
  const { method, path } = args;
  if (typeof method !== "string" || typeof path !== "string" || !ROUTES.some((route) => route.method === method && route.path.test(path))) {
    throw refuse("method, path: one of the requests plannotator inbox rows, projects, icon and export-decisions make.");
  }
  if (!handle) throw new InboxError("internal_error", "This Inbox cannot answer that here.");
  let body: Record<string, unknown> | undefined;
  if (method === "POST") {
    if (!args.body || typeof args.body !== "object" || Array.isArray(args.body)) throw refuse("body: a JSON object.");
    body = { ...(args.body as Record<string, unknown>) };
    if (path === "/api/inbox/settings") {
      const other = Object.keys(body).find((field) => !ROWS_FIELDS.includes(field));
      if (other) throw refuse(`body: ${other}: only the rows of the list are changed this way.`);
      body.rows_by = by;
    }
  }
  // As the command's own request on this computer: loopback, no browser origin.
  const headers = { Host: "127.0.0.1", ...(method === "POST" ? { "Content-Type": "application/json" } : {}) };
  const response = await handle(new Request(`http://127.0.0.1${path}`, method === "POST" ? { method, headers, body: JSON.stringify(body) } : { method, headers }));
  const text = await response.text();
  return ok(`${method} ${path.split("?")[0]}: ${response.status}.`, { status: response.status, content_type: response.headers.get("content-type") ?? "", body: text });
}
