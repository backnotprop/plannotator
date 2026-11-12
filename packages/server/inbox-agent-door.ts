/**
 * The agent door: a paired cloud agent's only way in (adr/implementation/inbox-mobile.md, section 13).
 *
 *   POST /api/inbox/agent/call   Authorization: Bearer <the pairing's tok_>   { tool, arguments }
 *
 * It runs four of the Inbox's agent tools through the same handlers as `/mcp`, with the Inbox setting who is
 * calling, the project and the scope. Answers `200 { result }` (the tool's result, a refusal as `isError` with
 * `<code>: <message>`), or `4xx { error, code }` when the caller is not a live agent device.
 */

import { createMcpHandler } from "@modelcontextprotocol/server";
import { inboxCloudHostOf } from "@plannotator/core/inbox-cloud";
import { inboxSearchTerms, INBOX_SEARCH_LIMIT_MAX, INBOX_SEARCH_QUERY_MAX, type InboxSearchMessageRow } from "@plannotator/core/inbox-search";
import type { InboxProject } from "@plannotator/core/inbox-types";
import { inboxStopNoticeReply, INBOX_MAX_REQUEST_BYTES, mcpAnswerOfResponse } from "@plannotator/shared/inbox/connection";
import type { InboxDevice } from "@plannotator/shared/inbox/devices";
import { bodyShowsLocalImages } from "@plannotator/shared/inbox/inline-images";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxSearchIndex } from "@plannotator/shared/inbox/search";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxUploadAttachments, receiveInboxUpload, removeInboxUploads } from "@plannotator/shared/inbox/uploads";
import type { InboxCloudAgent, InboxCloudAgents } from "./inbox-cloud-agents";
import { createInboxMcpServer, type InboxMcpContext } from "./inbox-mcp";
import { fail, okComplete, type ToolResult } from "./inbox-mcp-result";
import { INBOX_AGENT_SEARCH_LIMIT, INBOX_AGENT_SEARCH_BUILD_WAIT_MS, rowOf, searchRowText } from "./inbox-mcp-search";

export const INBOX_AGENT_DOOR_PATH = "/api/inbox/agent/call";

export const INBOX_AGENT_DOOR_TOOLS = ["send_message", "read_thread", "search", "resolve_message"] as const;
type DoorTool = (typeof INBOX_AGENT_DOOR_TOOLS)[number];

/** What one call may upload, all files together: a sealed relay command must fit one 32 MiB frame as base64. */
export const INBOX_AGENT_ATTACHMENTS_MAX_BYTES = 16 * 1024 * 1024;

const FIELDS: Record<DoorTool, readonly string[]> = {
  send_message: ["body", "subject", "thread", "reply_to", "supersedes", "done", "idempotency_key", "attachments"],
  read_thread: ["thread_id", "message_id", "limit", "expand", "before", "after", "include_resolved"],
  search: ["query", "limit"],
  resolve_message: ["message_id", "resolved"],
};

const IDENTITY_FIELDS = ["agent_session", "agent_name", "agent_host"];
/** Search pages read to find the caller's own matches. */
const SEARCH_PAGES_MAX = 20;

export interface InboxAgentDoorDevices {
  byToken: (token: string) => InboxDevice | null;
  isOtherDevice: (token: string) => boolean;
  touch: (id: string) => void;
}

export interface InboxAgentDoorContext {
  store: InboxStore;
  agents: InboxCloudAgents;
  devices: () => InboxAgentDoorDevices | null;
  baseUrl: () => string;
  searchIndex?: InboxSearchIndex;
  now?: () => number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

const refuse = (status: number, code: string, error: string) => json({ error, code }, status);

class DoorRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function createInboxAgentDoor(context: InboxAgentDoorContext) {
  const { store } = context;

  const messageOf = (id: unknown) => {
    if (typeof id !== "string") return null;
    return store.message(id) ?? store.message(inboxStopNoticeReply(id) ?? "") ?? null;
  };

  /** The threads a cloud agent may see: it wrote there, the person sent it the thread, or the person tagged it there. */
  const inScope = (threadId: string | null | undefined, session: string): boolean => {
    if (!threadId) return false;
    for (const message of store.thread(threadId)?.messages ?? []) {
      if (message.author.kind === "agent" && message.author.session === session) return true;
      if (message.author.kind !== "person") continue;
      if (message.to?.session === session) return true;
      if (message.tags?.some((tag) => tag.session === session && !tag.handed_away)) return true;
    }
    return false;
  };

  /** A message the caller may name: in one of its threads. Anything else reads as not there at all. */
  const ownedMessage = (id: unknown, session: string, field: string) => {
    const message = messageOf(id);
    if (!message || !inScope(message.thread_id, session)) throw new DoorRefusal("message_not_found", `No message ${String(id)}.${field === "message_id" ? "" : ` (${field})`}`);
    return message;
  };

  const projectOf = (agent: InboxCloudAgent): InboxProject | null => (agent.project_id ? store.project(store.canonicalProjectId(agent.project_id)) : null);

  /** The tool handlers of `/mcp`, with only what a cloud agent may reach: no disk paths, no running apps, no PRs. */
  const runTool = async (agent: InboxCloudAgent, name: DoorTool, args: Record<string, unknown>, uploads: string[]): Promise<ToolResult> => {
    const project = projectOf(agent);
    const at = new Date(context.now?.() ?? Date.now()).toISOString();
    const mcpContext: InboxMcpContext = {
      store,
      baseUrl: context.baseUrl,
      resolveProject: async () => {
        if (!project) throw new InboxError("project_not_found", "This cloud agent has no project; pair it again.");
        return project;
      },
      recordAttachments: async (ids) => {
        if (ids.length !== uploads.length || ids.some((id, i) => id !== uploads[i])) throw new InboxError("attachment_path_refused", "attachments: uploaded bytes only.");
        return inboxUploadAttachments(store.dir, uploads, at);
      },
      sessionWakes: async (_host, session) => session === agent.session,
      stepsOn: () => false,
      boardOn: () => false,
      ...(context.searchIndex ? { searchIndex: context.searchIndex } : {}),
    };
    const handler = createMcpHandler(() => createInboxMcpServer(mcpContext), { legacy: "stateless", maxRequestBodySize: INBOX_MAX_REQUEST_BYTES });
    const call =
      name === "send_message"
        ? { ...args, agent_session: agent.session, agent_name: agent.name, agent_host: inboxCloudHostOf(agent.preset) }
        : name === "read_thread"
          ? { ...args, agent_session: agent.session }
          : args;
    const response = await handler.fetch(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: call } }),
      }),
    );
    const answer = mcpAnswerOfResponse(response.status, await response.text());
    if (!answer || answer.error) return fail("internal_error", answer?.error?.message ?? "The Inbox gave no answer.");
    return answer.result as ToolResult;
  };

  /** search over the caller's threads only: the window's index, every project, then its own threads' rows. */
  const search = async (session: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const index = context.searchIndex;
    if (!index) return fail("search_unavailable", "This Inbox has no search index.");
    const q = typeof args.query === "string" ? args.query.trim().slice(0, INBOX_SEARCH_QUERY_MAX) : "";
    if (inboxSearchTerms(q).length === 0) return fail("validation_error", "query: words to search for (letters or digits).");
    const limit = typeof args.limit === "number" && Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, INBOX_SEARCH_LIMIT_MAX) : INBOX_AGENT_SEARCH_LIMIT;
    if (!index.ready()) {
      await Promise.race([index.ensureBuilt(), new Promise((resolve) => setTimeout(resolve, INBOX_AGENT_SEARCH_BUILD_WAIT_MS))]);
      if (!index.ready()) return fail("search_indexing", "The search index is still being built; try again in a moment.");
    }
    const found: InboxSearchMessageRow[] = [];
    for (let page = 0; page < SEARCH_PAGES_MAX; page++) {
      const answer = index.search({ q, project: null, group: "messages", offset: page * INBOX_SEARCH_LIMIT_MAX, limit: INBOX_SEARCH_LIMIT_MAX });
      const rows = (answer.groups?.messages ?? []).filter((row): row is InboxSearchMessageRow => row.type === "message");
      for (const row of rows) if (inScope(row.thread_id, session)) found.push(row);
      if (rows.length < INBOX_SEARCH_LIMIT_MAX) break;
    }
    const results = found.slice(0, limit).map((row) => rowOf(row, true));
    const scope = "your threads";
    const head =
      results.length === 0
        ? `No message matches ${JSON.stringify(q)} in ${scope}.`
        : `${found.length} message${found.length === 1 ? " matches" : "s match"} ${JSON.stringify(q)} in ${scope}${found.length > results.length ? `; the best ${results.length}` : ""}:`;
    const text = results.length === 0 ? head : `${head}\n${results.map(searchRowText).join("\n")}\nread_thread with a thread_id and its message_id shows that message in full.`;
    return okComplete(text, { query: q, scope, total: found.length, results });
  };

  /** Uploaded files, as pending uploads named in the call: their ids. A path is refused. */
  const receive = async (value: unknown): Promise<string[]> => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new DoorRefusal("validation_error", "attachments: a list of { name, data } (data: the file's bytes as base64).");
    const files = value.map((item, i) => {
      if (typeof item === "string") {
        throw new DoorRefusal("attachment_path_refused", `attachments[${i}]: ${JSON.stringify(item)} is a path, and the Inbox opens no path for a cloud agent. Send the file's bytes: { "name": "shot.png", "data": "<base64>" } (plannotator inbox call does this for a path on your own disk).`);
      }
      const file = item as { name?: unknown; data?: unknown } | null;
      if (!file || typeof file !== "object" || typeof file.name !== "string" || typeof file.data !== "string" || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(file.data)) {
        throw new DoorRefusal("validation_error", `attachments[${i}]: { name, data } with data as base64.`);
      }
      return { name: file.name, bytes: Buffer.from(file.data, file.data.includes("-") || file.data.includes("_") ? "base64url" : "base64") };
    });
    const total = files.reduce((sum, file) => sum + file.bytes.length, 0);
    if (total > INBOX_AGENT_ATTACHMENTS_MAX_BYTES) {
      throw new DoorRefusal("attachments_too_large", `attachments: at most ${INBOX_AGENT_ATTACHMENTS_MAX_BYTES / (1024 * 1024)} MB in one message.`);
    }
    const at = new Date(context.now?.() ?? Date.now()).toISOString();
    const ids: string[] = [];
    try {
      for (const file of files) {
        const bytes = file.bytes;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(bytes));
            controller.close();
          },
        });
        ids.push((await receiveInboxUpload(store.dir, file.name, stream, { at })).upload_id);
      }
    } catch (error) {
      removeInboxUploads(store.dir, ids);
      throw error;
    }
    return ids;
  };

  const call = async (agent: InboxCloudAgent, tool: DoorTool, args: Record<string, unknown>): Promise<ToolResult> => {
    const session = agent.session;
    const identity = IDENTITY_FIELDS.find((field) => field in args);
    if (identity) throw new DoorRefusal("identity_forced", `${identity}: not taken here. The Inbox names a cloud agent from its pairing.`);
    if ("project_path" in args) throw new DoorRefusal("project_forced", "project_path: not taken here. A cloud agent's threads go in the project chosen when it was paired.");
    const unknown = Object.keys(args).find((field) => !FIELDS[tool].includes(field));
    if (unknown) throw new DoorRefusal("validation_error", `${unknown}: not taken through the agent door.`);

    if (tool === "search") return search(session, args);

    if (tool === "resolve_message") {
      const message = ownedMessage(args.message_id, session, "message_id");
      if (message.author.kind !== "agent" || message.author.session !== session) {
        throw new DoorRefusal("not_your_message", "A cloud agent resolves a thread only through a message it sent there.");
      }
      return runTool(agent, tool, { ...args, message_id: message.id }, []);
    }

    if (tool === "read_thread") {
      const ids = [args.message_id, ...(Array.isArray(args.expand) ? args.expand : []), args.before, args.after].filter((id) => typeof id === "string");
      if (typeof args.thread_id === "string") {
        if (!inScope(store.message(args.thread_id)?.thread_id === args.thread_id ? args.thread_id : null, session)) throw new DoorRefusal("thread_not_found", `No thread ${args.thread_id}.`);
      }
      for (const id of ids) ownedMessage(id, session, "message_id");
      if (typeof args.thread_id !== "string" && typeof args.message_id !== "string") {
        const project = projectOf(agent);
        return runTool(agent, tool, { ...args, asked_by: "me", project_path: project?.root ?? "/" }, []);
      }
      return runTool(agent, tool, args, []);
    }

    const body = typeof args.body === "string" ? args.body : "";
    if (bodyShowsLocalImages(body)) {
      throw new DoorRefusal("image_path_refused", "body: a picture shown by path (![alt](path)) is not taken from a cloud agent: the Inbox opens no path for it. Put the picture in attachments instead (plannotator inbox call reads a path there from your own disk and sends its bytes); it shows below the message.");
    }
    if (typeof args.reply_to === "string") ownedMessage(args.reply_to, session, "reply_to");
    else if (typeof args.thread === "string") {
      const project = projectOf(agent);
      const joins = project ? store.threadRoutedBy(project.id, args.thread) : null;
      if (joins && !inScope(joins, session)) throw new DoorRefusal("thread_name_taken", `thread: another thread in this project is named ${JSON.stringify(args.thread)}. Pick another name.`);
    }
    const uploads = await receive(args.attachments);
    try {
      const project = projectOf(agent);
      const sent = {
        ...args,
        ...(typeof args.reply_to === "string" ? {} : { project_path: project?.root ?? "/" }),
        ...(typeof args.idempotency_key === "string" ? { idempotency_key: `${session}:${args.idempotency_key}` } : {}),
        ...(uploads.length > 0 ? { attachments: uploads } : { attachments: undefined }),
      };
      return await runTool(agent, tool, sent, uploads);
    } finally {
      removeInboxUploads(store.dir, uploads);
    }
  };

  /** One request at the door. The caller (inbox.ts) has already kept it to this computer, with no browser. */
  const handle = async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return json({ error: "Use POST." }, 405);
    const match = /^Bearer\s+(\S+)$/i.exec((req.headers.get("authorization") ?? "").trim());
    if (!match) return refuse(401, "device_token_missing", "This request needs the cloud agent's pairing.");
    const devices = context.devices();
    const device = devices?.byToken(match[1]!) ?? null;
    if (!device) {
      if (devices?.isOtherDevice(match[1]!)) return refuse(403, "device_not_an_agent", "A phone's or a linked machine's token opens the device door, not the agent door.");
      return refuse(401, "device_token_invalid", "This pairing does not belong to a paired cloud agent.");
    }
    const agent = context.agents.byDevice(device.id);
    if (device.revoked_at !== null || !agent) return refuse(401, "device_revoked", "This cloud agent was removed from the Inbox. Pair it again.");
    devices!.touch(device.id);
    let request: { tool?: unknown; arguments?: unknown };
    try {
      request = (await req.json()) as typeof request;
    } catch {
      return refuse(422, "validation_error", "body: expected { tool, arguments }.");
    }
    if (!request || typeof request !== "object" || Array.isArray(request)) return refuse(422, "validation_error", "body: expected { tool, arguments }.");
    const tool = request.tool;
    if (typeof tool !== "string" || !(INBOX_AGENT_DOOR_TOOLS as readonly string[]).includes(tool)) {
      return json({ result: fail("tool_not_allowed", `${String(tool)} is not open to a cloud agent. Tools: ${INBOX_AGENT_DOOR_TOOLS.join(", ")}.`) });
    }
    const args = request.arguments ?? {};
    if (typeof args !== "object" || Array.isArray(args) || args === null) return json({ result: fail("validation_error", "arguments: a JSON object.") });
    try {
      return json({ result: await call(agent, tool as DoorTool, args as Record<string, unknown>) });
    } catch (error) {
      if (error instanceof DoorRefusal || error instanceof InboxError) return json({ result: fail(error.code, error.message) });
      return json({ result: fail("internal_error", "The Inbox could not run that call.") });
    }
  };

  return { handle };
}
