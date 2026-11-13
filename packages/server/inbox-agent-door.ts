import { createMcpHandler } from "@modelcontextprotocol/server";
import { inboxCloudHostOf } from "@plannotator/core/inbox-cloud";
import type { InboxProject } from "@plannotator/core/inbox-types";
import { INBOX_MAX_REQUEST_BYTES, mcpAnswerOfResponse } from "@plannotator/shared/inbox/connection";
import type { InboxDevice } from "@plannotator/shared/inbox/devices";
import { bodyShowsLocalImages } from "@plannotator/shared/inbox/inline-images";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxUploadAttachments, receiveInboxUpload, removeInboxUploads } from "@plannotator/shared/inbox/uploads";
import { hasCloudWake, type InboxCloudAgent, type InboxCloudAgents } from "./inbox-cloud-agents";
import { createInboxMcpServer, type InboxMcpContext } from "./inbox-mcp";
import { fail, okComplete, type ToolResult } from "./inbox-mcp-result";

export const INBOX_AGENT_DOOR_PATH = "/api/inbox/agent/call";
export const INBOX_AGENT_ATTACHMENTS_MAX_BYTES = 16 * 1024 * 1024;

const WHOAMI = "whoami";
const IDENTITY_FIELDS = ["agent_session", "agent_name", "agent_host"];
const PROJECT_FIELD = "project";
const EVERY_PROJECT = "\u0000every-project";

const PATH_FIELDS: Record<string, string> = {
  project_path: `project_path: a folder on the person's computer, which a cloud agent does not name. Pass "project" with a project's name instead (whoami lists them).`,
  walkthrough: "walkthrough: it reads files from the project's folder on the person's computer, which a cloud agent cannot ask for. Send guide with patch instead.",
};

export interface InboxAgentDoorDevices {
  byToken: (token: string) => InboxDevice | null;
  byId: (id: string) => InboxDevice | null;
  isOtherDevice: (token: string) => boolean;
  touch: (id: string) => void;
}

export interface InboxAgentDoorContext {
  store: InboxStore;
  agents: InboxCloudAgents;
  devices: () => InboxAgentDoorDevices | null;
  mcp: InboxMcpContext;
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

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function createInboxAgentDoor(context: InboxAgentDoorContext) {
  const { store, agents } = context;
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

  const contextFor = (agent: InboxCloudAgent, uploads: readonly string[]): InboxMcpContext => ({
    ...context.mcp,
    resolveProject: async (path) => {
      const found = store.projectByRoot(path) ?? (path === agents.homeRoot(agent) ? agents.home(agent) : null);
      if (!found) throw new InboxError("project_not_found", "No such project.");
      return found;
    },
    projectRootOf: undefined,
    findProjects: async (path) => (path === EVERY_PROJECT ? { projects: [], unresolved: false, every: true } : { projects: [store.projectByRoot(path)].filter((p): p is InboxProject => p !== null), unresolved: false }),
    recordAttachments: async (ids) => {
      if (ids.length !== uploads.length || ids.some((id, i) => id !== uploads[i])) throw new InboxError("attachment_path_refused", "attachments: uploaded bytes only.");
      return inboxUploadAttachments(store.dir, [...uploads], new Date(context.mcp.now?.() ?? Date.now()).toISOString());
    },
    checkPrototypeApps: undefined,
    walkthroughThread: () => false,
    sessionWakes: async (_host, session) => session === agent.session && hasCloudWake(agent),
  });

  const mcpRequest = async (mcpContext: InboxMcpContext, method: string, params: Record<string, unknown>) => {
    const handler = createMcpHandler(() => createInboxMcpServer(mcpContext), { legacy: "stateless", maxRequestBodySize: INBOX_MAX_REQUEST_BYTES });
    const response = await handler.fetch(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
    return mcpAnswerOfResponse(response.status, await response.text());
  };
  const servedTools = async (mcpContext: InboxMcpContext): Promise<Map<string, string[]>> => {
    const answer = await mcpRequest(mcpContext, "tools/list", {});
    const tools = ((answer?.result as { tools?: { name: string; inputSchema?: { properties?: Record<string, unknown> } }[] } | undefined)?.tools ?? []);
    return new Map(tools.map((tool) => [tool.name, Object.keys(tool.inputSchema?.properties ?? {})]));
  };

  const projectNamed = (agent: InboxCloudAgent, value: unknown): InboxProject => {
    if (typeof value !== "string" || value.trim() === "") throw new DoorRefusal("validation_error", "project: a project's name, as the Inbox shows it (whoami lists them).");
    const byId = store.project(value.trim());
    if (byId) return store.project(store.canonicalProjectId(byId.id)) ?? byId;
    const named = store.listProjects().filter((project) => sameName(project.name, value));
    if (named.length === 1) return named[0]!;
    if (named.length > 1) throw new DoorRefusal("project_ambiguous", `${JSON.stringify(value.trim())} names ${named.length} projects: ${named.map((p) => `${p.id}`).join(", ")}. Pass one of these ids as project.`);
    if (sameName(agents.homeName(agent), value)) return agents.home(agent);
    throw new DoorRefusal("project_not_found", `No project is named ${JSON.stringify(value.trim())}. Projects: ${projectNames().join(", ") || "none yet"}.`);
  };

  const projectNames = () => store.listProjects().map((project) => project.name);
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
    const at = new Date(context.mcp.now?.() ?? Date.now()).toISOString();
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

  const whoami = (agent: InboxCloudAgent): ToolResult => {
    const home = agents.homeName(agent);
    const projects = projectNames();
    return okComplete(
      `You are ${agent.name}, a cloud agent paired with this Inbox. You can read, search and write in every thread of every project here. A new thread goes in ${home} unless you pass "project" with another project's name.${projects.length > 0 ? ` Projects: ${projects.join(", ")}.` : ""} The Inbox answered, so your setup works.`,
      { name: agent.name, project: home, projects },
    );
  };
  const argumentsFor = (agent: InboxCloudAgent, tool: string, fields: readonly string[], args: Record<string, unknown>, uploads: readonly string[], commandId: string | null) => {
    const { [PROJECT_FIELD]: projectName, ...call } = args;
    const has = (field: string) => fields.includes(field);
    if (has("agent_session")) call.agent_session = agent.session;
    if (has("agent_name")) call.agent_name = agent.name;
    if (has("agent_host")) call.agent_host = inboxCloudHostOf(agent.preset);
    if (has("project_path")) {
      const named = projectName === undefined ? null : projectNamed(agent, projectName);
      if (tool === "search") {
        if (named) call.project_path = named.root;
        else call.all_projects ??= true;
      } else if (tool === "read_thread") {
        if (typeof call.thread_id !== "string" && typeof call.message_id !== "string") call.project_path = named?.root ?? EVERY_PROJECT;
      } else if (named || typeof call.reply_to !== "string") {
        call.project_path = named?.root ?? agents.homeRoot(agent);
      }
    }
    if (has("idempotency_key")) {
      if (typeof call.idempotency_key === "string") call.idempotency_key = `${agent.session}:${call.idempotency_key}`;
      else if (commandId !== null) call.idempotency_key = `relay.${commandId}`;
    }
    if (has("attachments")) call.attachments = uploads.length > 0 ? [...uploads] : undefined;
    return call;
  };

  const call = async (agent: InboxCloudAgent, tool: string, args: Record<string, unknown>, commandId: string | null): Promise<ToolResult> => {
    const identity = IDENTITY_FIELDS.find((field) => field in args);
    if (identity) throw new DoorRefusal("identity_forced", `${identity}: not taken here. The Inbox names a cloud agent from its pairing.`);
    const path = Object.keys(PATH_FIELDS).find((field) => field in args);
    if (path) throw new DoorRefusal("path_refused", PATH_FIELDS[path]!);
    if (tool === WHOAMI) {
      const extra = Object.keys(args)[0];
      if (extra) throw new DoorRefusal("validation_error", `${extra}: whoami takes no fields.`);
      return whoami(agent);
    }

    const tools = await servedTools(contextFor(agent, []));
    const fields = tools.get(tool);
    if (!fields) throw new DoorRefusal("tool_not_allowed", `${tool} is not an Inbox action. Actions: ${[WHOAMI, ...tools.keys()].join(", ")}.`);
    const open = [...fields.filter((field) => !IDENTITY_FIELDS.includes(field) && !(field in PATH_FIELDS)), ...(fields.includes("project_path") ? [PROJECT_FIELD] : [])];
    const unknown = Object.keys(args).find((field) => !open.includes(field));
    if (unknown) throw new DoorRefusal("validation_error", `${unknown}: not taken through the agent door. ${tool} takes: ${open.join(", ") || "no fields"}.`);

    if (typeof args.body === "string" && bodyShowsLocalImages(args.body)) {
      throw new DoorRefusal("image_path_refused", "body: a picture shown by path (![alt](path)) is not taken from a cloud agent: the Inbox opens no path for it. Put the picture in attachments instead (plannotator inbox call reads a path there from your own disk and sends its bytes); it shows below the message.");
    }
    const uploads = fields.includes("attachments") ? await receive(args.attachments) : [];
    try {
      const sent = argumentsFor(agent, tool, fields, args, uploads, commandId);
      const answer = await mcpRequest(contextFor(agent, uploads), "tools/call", { name: tool, arguments: sent });
      if (!answer || answer.error) return fail("internal_error", answer?.error?.message ?? "The Inbox gave no answer.");
      return answer.result as ToolResult;
    } finally {
      removeInboxUploads(store.dir, uploads);
    }
  };
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
    let request: { tool?: unknown; arguments?: unknown };
    try {
      request = (await req.json()) as typeof request;
    } catch {
      request = null as unknown as typeof request;
    }
    return serve(devices!, device, request, null);
  };

  const serve = async (devices: InboxAgentDoorDevices, device: InboxDevice, request: { tool?: unknown; arguments?: unknown } | null, commandId: string | null): Promise<Response> => {
    const agent = agents.byDevice(device.id);
    if (device.revoked_at !== null || !agent) return refuse(401, "device_revoked", "This cloud agent was removed from the Inbox. Pair it again.");
    devices.touch(device.id);
    if (!request || typeof request !== "object" || Array.isArray(request)) return refuse(422, "validation_error", "body: expected { tool, arguments }.");
    const tool = request.tool;
    if (typeof tool !== "string" || tool === "") return json({ result: fail("validation_error", "tool: the name of an Inbox action, such as read_thread.") });
    const args = request.arguments ?? {};
    if (typeof args !== "object" || Array.isArray(args) || args === null) return json({ result: fail("validation_error", "arguments: a JSON object.") });
    try {
      const result = await call(agent, tool, args as Record<string, unknown>, commandId);
      if (!result.isError) agents.seen(device.id);
      return json({ result });
    } catch (error) {
      if (error instanceof DoorRefusal || error instanceof InboxError) return json({ result: fail(error.code, error.message) });
      return json({ result: fail("internal_error", "The Inbox could not run that call.") });
    }
  };

  const asAgent = async (deviceId: string, request: { tool: unknown; arguments: unknown }, commandId: string): Promise<Response> => {
    const devices = context.devices();
    const device = devices?.byId(deviceId) ?? null;
    if (!devices || !device) return refuse(401, "device_token_invalid", "This pairing does not belong to a paired cloud agent.");
    return serve(devices, device, request, commandId);
  };

  const inScopeOf = (threadId: string, deviceId: string): boolean => {
    const agent = agents.byDevice(deviceId);
    return agent !== null && inScope(threadId, agent.session);
  };

  return { handle, asAgent, inScopeOf };
}
