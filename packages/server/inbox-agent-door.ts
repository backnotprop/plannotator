import { createMcpHandler } from "@modelcontextprotocol/server";
import { inboxCloudHostOf } from "@plannotator/core/inbox-cloud";
import type { InboxProject } from "@plannotator/core/inbox-types";
import { INBOX_MAX_REQUEST_BYTES, mcpAnswerOfResponse } from "@plannotator/shared/inbox/connection";
import type { InboxDevice } from "@plannotator/shared/inbox/devices";
import type { AgentAttachedFile } from "@plannotator/shared/inbox/agent-pictures";
import { inboxBlobPath } from "@plannotator/shared/inbox/attachments";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxUploadAttachments, readInboxUpload, receiveInboxUpload, removeInboxUploads } from "@plannotator/shared/inbox/uploads";
import { inboxAgentFetchAction, inboxAgentFetchFields } from "./inbox-agent-files";
import { INBOX_AGENT_FETCH_FILE } from "@plannotator/shared/inbox/agent-pairing";
import { bytesOfBase64, createInboxAgentPieces, inboxAgentPieceAction } from "./inbox-agent-pieces";
import { inboxAgentRouteAction } from "./inbox-agent-routes";
import { hasCloudWake, type InboxCloudAgent, type InboxCloudAgents } from "./inbox-cloud-agents";
import type { InboxSendUpload } from "./inbox-cloud-pictures";
import { createTurns } from "./inbox-machine-agent-piece";
import { createInboxMcpServer, type InboxMcpContext } from "./inbox-mcp";
import { fail, ok, okComplete, type ToolResult } from "./inbox-mcp-result";

export const INBOX_AGENT_DOOR_PATH = "/api/inbox/agent/call";
export const INBOX_AGENT_ATTACHMENTS_MAX_BYTES = 16 * 1024 * 1024;

const WHOAMI = "whoami";
const IDENTITY_FIELDS = ["agent_session", "agent_name", "agent_host"];
const PROJECT_FIELD = "project";
const EVERY_PROJECT = "\u0000every-project";

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
  /** The Inbox's own handler for the window routes the agent's commands use (inbox-agent-routes.ts). */
  route?: (req: Request) => Promise<Response>;
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

/**
 * fetch_file of a message this store does not hold, while a machine is linked: that machine's piece, in the same
 * answer as one of this computer's (inbox-agent-files.ts `inboxAgentFetchAction`). Null: not a far message.
 */
async function farFetchAction(store: InboxStore, mcp: InboxMcpContext, args: Record<string, unknown>, turn: <T>(read: () => Promise<T>) => Promise<T>): Promise<ToolResult | null> {
  const messageId = typeof args.message_id === "string" ? args.message_id.trim() : "";
  if (!messageId || store.message(messageId) || !mcp.filePieceOnMachine) return null;
  const extra = Object.keys(args).find((field) => !inboxAgentFetchFields.includes(field));
  if (extra) throw new DoorRefusal("validation_error", `${extra}: not taken. ${INBOX_AGENT_FETCH_FILE} takes: ${inboxAgentFetchFields.join(", ")}.`);
  const offset = args.offset ?? 0;
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) throw new DoorRefusal("validation_error", "offset: where the piece starts, in bytes from 0 (the next_offset of the piece before).");
  const file = typeof args.file === "string" ? args.file.trim() : "";
  const read = mcp.filePieceOnMachine;
  const piece = await turn(() => read({ message_id: messageId, file }, offset));
  if (!piece) return null;
  const end = piece.next_offset ?? piece.size;
  return ok(`${piece.name}: bytes ${offset} to ${end} of ${piece.size}${piece.next_offset === null ? ", the end" : `; next offset ${piece.next_offset}`}.`, { message_id: messageId, file, ...piece });
}

export function createInboxAgentDoor(context: InboxAgentDoorContext) {
  const { store, agents } = context;
  const pieces = createInboxAgentPieces(store.dir);
  // A linked machine's pieces, a few at a time per agent: each is held in memory for its answer.
  const farTurns = createTurns();
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

  /**
   * The context of one call: a local agent's (`context.mcp`), the same checks and the same reach on the person's
   * computer, plus what only the pairing has. The agent's own place (a folder under the Inbox's data, its threads'
   * project when it names none) and "every project" (a list or search with none named) resolve here; every other
   * folder, a `project_path` it names included, goes through the local agent's own lookups. `uploads`: the files it
   * sent as bytes in this send (inbox-cloud-pictures.ts); `given`: the send's list as the agent gave it (receive()'s
   * items), which a refusal names a path's place in.
   */
  const contextFor = (agent: InboxCloudAgent, uploads: readonly InboxSendUpload[], given: readonly string[] = []): InboxMcpContext => {
    const homeRoot = agents.homeRoot(agent);
    const local = context.mcp;
    const sent = new Set(uploads.map((upload) => upload.id));
    return {
      ...local,
      inlineImageFiles: uploads,
      resolveProject: async (path) => store.projectByRoot(path) ?? (path === homeRoot ? agents.home(agent) : local.resolveProject(path)),
      projectRootOf: local.projectRootOf ? (path) => (path === homeRoot || path === EVERY_PROJECT ? Promise.reject(new Error("no root")) : local.projectRootOf!(path)) : undefined,
      findProjects: async (path) => {
        if (path === EVERY_PROJECT) return { projects: [], unresolved: false, every: true };
        const known = store.projectByRoot(path);
        if (known || path === homeRoot || !local.findProjects) return { projects: known ? [known] : [], unresolved: false };
        return local.findProjects(path);
      },
      // Each item as the agent gave it, in its order: a file it sent as bytes in this send, or a path, which the local
      // agent's own rule reads on the person's computer (the same .env, folder and missing-file refusals).
      recordAttachments: async (items, project, base) => {
        const paths = items.filter((item) => !(typeof item === "string" && sent.has(item)));
        const ids = items.filter((item): item is string => typeof item === "string" && sent.has(item));
        if (new Set(ids).size !== ids.length) throw new InboxError("validation_error", "attachments: each file once.");
        if (paths.length > 0 && !local.recordAttachments) throw new InboxError("validation_error", "attachments: not taken by this Inbox.");
        // A refusal names the path by its place in the agent's own list, not among the paths alone. The list given
        // here may have lost the uploads the body shows as pictures, never a path: the k-th path is the k-th given.
        const at = (given.length > 0 ? given : items).flatMap((item, i) => (typeof item === "string" && sent.has(item) ? [] : [i]));
        const fromDisk =
          paths.length > 0
            ? await local.recordAttachments!(paths, project, base).catch((error: unknown) => {
                if (!(error instanceof InboxError)) throw error;
                const place = (text: string) => text.replace(/^attachments\[(\d+)\]/, (whole, k: string) => (at[Number(k)] === undefined ? whole : `attachments[${at[Number(k)]}]`));
                const field = typeof error.details.field === "string" ? place(error.details.field) : error.details.field;
                throw new InboxError(error.code, place(error.message), { ...error.details, ...(field === undefined ? {} : { field }) });
              })
            : [];
        const fromBytes = ids.length > 0 ? await inboxUploadAttachments(store.dir, ids, new Date(local.now?.() ?? Date.now()).toISOString()) : [];
        let disk = 0;
        let bytes = 0;
        return items.map((item) => (typeof item === "string" && sent.has(item) ? fromBytes[bytes++]! : fromDisk[disk++]!));
      },
      // Branch reviews: a cloud agent's report is a branch that lives wherever it pushed it (inbox-mcp-branch.ts).
      cloudAgent: { homeRoot },
      sessionWakes: async (_host, session) => session === agent.session && hasCloudWake(agent),
    };
  };

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
    // A repository by its git address (https://github.com/acme/api, git@github.com:acme/api.git): the one project
    // whose origin it is, as a branch report finds it. One no project here has is not found: nothing is made for it.
    const byRemote = context.mcp.branches?.projectOfRemote?.(value.trim()) ?? null;
    if (byRemote) return byRemote;
    if (sameName(agents.homeName(agent), value)) return agents.home(agent);
    throw new DoorRefusal("project_not_found", `No project is named ${JSON.stringify(value.trim())}. Projects: ${projectNames().join(", ") || "none yet"}.`);
  };

  const projectNames = () => store.listProjects().map((project) => project.name);
  /**
   * The send's attachments: each path as it is (read on the person's computer by the local agent's own rule, in
   * `recordAttachments`), each file sent as bytes (`{ name, data }`, or `{ upload }` for one sent in pieces) kept as an
   * upload. `items`: the list for the tool, in the agent's order, a path or an upload's id; `received`: the uploads.
   */
  const receive = async (agent: InboxCloudAgent, value: unknown): Promise<{ items: string[]; received: AgentAttachedFile[] }> => {
    if (value === undefined) return { items: [], received: [] };
    if (!Array.isArray(value)) throw new DoorRefusal("validation_error", "attachments: a list of paths, or of { name, data } (data: the file's bytes as base64), or { upload } for a file sent in pieces.");
    const files = value.map((item, i): { path: string } | { piece: ReturnType<typeof pieces.take> } | { name: string; bytes: Buffer } => {
      if (typeof item === "string") return { path: item };
      const file = item as { name?: unknown; data?: unknown; upload?: unknown } | null;
      if (file && typeof file === "object" && "upload" in file) return { piece: pieces.take(agent.session, file.upload) };
      const bytes = file && typeof file === "object" && typeof file.name === "string" ? bytesOfBase64(file.data) : null;
      if (!bytes) throw new DoorRefusal("validation_error", `attachments[${i}]: a path, { name, data } with data as base64, or { upload } for a file sent in pieces.`);
      return { name: file!.name as string, bytes };
    });
    const total = files.reduce((sum, file) => sum + ("bytes" in file ? file.bytes.length : 0), 0);
    if (total > INBOX_AGENT_ATTACHMENTS_MAX_BYTES) {
      throw new DoorRefusal("attachments_too_large", `attachments: at most ${INBOX_AGENT_ATTACHMENTS_MAX_BYTES / (1024 * 1024)} MB as data in one message. Send a bigger file in pieces (plannotator inbox call does this for a path on your own disk).`);
    }
    const at = new Date(context.mcp.now?.() ?? Date.now()).toISOString();
    const items: string[] = [];
    const received: AgentAttachedFile[] = [];
    try {
      for (const file of files) {
        if ("path" in file) {
          items.push(file.path);
          continue;
        }
        const name = "piece" in file ? file.piece.name : file.name;
        const stream =
          "piece" in file
            ? Bun.file(file.piece.path).stream()
            : new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new Uint8Array(file.bytes));
                  controller.close();
                },
              });
        const id = (await receiveInboxUpload(store.dir, name, stream, { at })).upload_id;
        received.push({ id, name });
        items.push(id);
      }
    } catch (error) {
      removeInboxUploads(store.dir, received.map((file) => file.id));
      throw error;
    }
    for (const file of files) if ("piece" in file) file.piece.drop();
    return { items, received };
  };

  /** The files a send attached as bytes, with the Inbox's own copy of each (where a picture of one is read from). */
  const uploadsOf = (received: readonly AgentAttachedFile[]): InboxSendUpload[] =>
    received.flatMap((file) => {
      const upload = readInboxUpload(store.dir, file.id);
      return upload ? [{ id: file.id, name: upload.name, kind: upload.kind, path: inboxBlobPath(store.dir, upload.sha256) }] : [];
    });

  const whoami = (agent: InboxCloudAgent): ToolResult => {
    const home = agents.homeName(agent);
    const projects = projectNames();
    return okComplete(
      `You are ${agent.name}, a cloud agent paired with this Inbox. You can read, search and write in every thread of every project here. A new thread goes in ${home} unless you pass "project" with another project's name.${projects.length > 0 ? ` Projects: ${projects.join(", ")}.` : ""} The Inbox answered, so your setup works.`,
      { name: agent.name, project: home, projects },
    );
  };
  /**
   * A card call's project when the agent names none, as reply_to takes its thread's: the card's own for a card_id,
   * the thread's for a create with thread_id, every project for list (as read_thread's list and search), else its home.
   */
  const cardProjectRoot = (agent: InboxCloudAgent, call: Record<string, unknown>): string => {
    const rootOf = (projectId: string | undefined) => (projectId ? store.project(projectId)?.root : undefined);
    if (typeof call.card_id === "string") return rootOf(store.card(call.card_id.trim())?.project_id) ?? agents.homeRoot(agent);
    if (call.op === "list") return EVERY_PROJECT;
    if (typeof call.thread_id === "string") return rootOf(store.message(call.thread_id.trim())?.project_id) ?? agents.homeRoot(agent);
    return agents.homeRoot(agent);
  };
  /** A routine with no folder and no project named: a new scratch folder (its own place is no folder to run in). */
  const routineFolder = (call: Record<string, unknown>, named: InboxProject | null) => {
    if (named) call.project_path = named.root;
    else if (call.op === "create" && call.folder === undefined) call.folder = { scratch: true };
  };
  const argumentsFor = (agent: InboxCloudAgent, tool: string, fields: readonly string[], args: Record<string, unknown>, attachments: readonly string[] | null, commandId: string | null) => {
    const { [PROJECT_FIELD]: projectName, ...call } = args;
    const has = (field: string) => fields.includes(field);
    if (has("agent_session")) call.agent_session = agent.session;
    if (has("agent_name")) call.agent_name = agent.name;
    if (has("agent_host")) call.agent_host = inboxCloudHostOf(agent.preset);
    if (projectName !== undefined && call.project_path !== undefined) throw new DoorRefusal("validation_error", "project, project_path: pass one of them.");
    // A folder it names is the local agent's project_path, as it is; with none, the project it names or its default.
    if (has("project_path") && call.project_path === undefined) {
      const named = projectName === undefined ? null : projectNamed(agent, projectName);
      if (tool === "search") {
        if (named) call.project_path = named.root;
        else call.all_projects ??= true;
      } else if (tool === "read_thread") {
        if (typeof call.thread_id !== "string" && typeof call.message_id !== "string") call.project_path = named?.root ?? EVERY_PROJECT;
      } else if (tool === "card") {
        call.project_path = named?.root ?? cardProjectRoot(agent, call);
      } else if (tool === "routine") {
        routineFolder(call, named);
      } else if (named || typeof call.reply_to !== "string") {
        call.project_path = named?.root ?? agents.homeRoot(agent);
      }
    }
    if (has("idempotency_key")) {
      if (typeof call.idempotency_key === "string") call.idempotency_key = `${agent.session}:${call.idempotency_key}`;
      else if (commandId !== null) call.idempotency_key = `relay.${commandId}`;
    }
    if (attachments !== null) call.attachments = attachments.length > 0 ? [...attachments] : undefined;
    return call;
  };

  const call = async (agent: InboxCloudAgent, tool: string, args: Record<string, unknown>, commandId: string | null): Promise<ToolResult> => {
    const identity = IDENTITY_FIELDS.find((field) => field in args);
    if (identity) throw new DoorRefusal("identity_forced", `${identity}: not taken here. The Inbox names a cloud agent from its pairing.`);
    if (tool === WHOAMI) {
      const extra = Object.keys(args)[0];
      if (extra) throw new DoorRefusal("validation_error", `${extra}: whoami takes no fields.`);
      return whoami(agent);
    }
    const pieceResult = inboxAgentPieceAction(pieces, agent.session, tool, args);
    if (pieceResult) return pieceResult;
    // A file of a linked machine's thread: its pieces come from there, as this computer's own do (inbox-machine-agent-piece.ts).
    const far = tool === INBOX_AGENT_FETCH_FILE ? await farFetchAction(store, context.mcp, args, (read) => farTurns(agent.session, read)) : null;
    if (far) return far;
    const fetched = await inboxAgentFetchAction(store, agent.session, tool, args);
    if (fetched) return fetched;
    const routed = await inboxAgentRouteAction(context.route, { host: inboxCloudHostOf(agent.preset), session: agent.session }, tool, args);
    if (routed) return routed;

    const tools = await servedTools(contextFor(agent, []));
    const fields = tools.get(tool);
    if (!fields) throw new DoorRefusal("tool_not_allowed", `${tool} is not an Inbox action. Actions: ${[WHOAMI, ...tools.keys()].join(", ")}.`);
    const open = [...fields.filter((field) => !IDENTITY_FIELDS.includes(field)), ...(fields.includes("project_path") ? [PROJECT_FIELD] : [])];
    // A guide takes no attachments, but the pictures its body (or its guide's intent) shows from the agent's own disk
    // come as bytes, as a send's do (plannotator inbox call sends them): kept for the send, not given to the tool.
    const guidePictures = tool === "submit_guide" && !fields.includes("attachments") && args.attachments !== undefined;
    const unknown = Object.keys(args).find((field) => !open.includes(field) && !(guidePictures && field === "attachments"));
    if (unknown) throw new DoorRefusal("validation_error", `${unknown}: not taken through the agent door. ${tool} takes: ${open.join(", ") || "no fields"}.`);
    const pathAt = guidePictures && Array.isArray(args.attachments) ? args.attachments.findIndex((item) => typeof item === "string") : -1;
    if (pathAt >= 0) throw new DoorRefusal("validation_error", `attachments[${pathAt}]: ${tool} takes only the pictures its body or its guide's intent shows, each as bytes ({ name, data } or { upload }), named as the picture names its file.`);

    // A routine's files are paths each run reads on the person's computer: given to the tool as they are.
    const { items, received } = (tool !== "routine" && fields.includes("attachments")) || guidePictures ? await receive(agent, args.attachments) : { items: null, received: [] };
    try {
      const sent = argumentsFor(agent, tool, fields, args, guidePictures ? null : items, commandId);
      if (guidePictures) delete sent.attachments;
      const answer = await mcpRequest(contextFor(agent, uploadsOf(received), items ?? []), "tools/call", { name: tool, arguments: sent });
      if (!answer || answer.error) return fail("internal_error", answer?.error?.message ?? "The Inbox gave no answer.");
      return answer.result as ToolResult;
    } finally {
      removeInboxUploads(store.dir, received.map((file) => file.id));
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
