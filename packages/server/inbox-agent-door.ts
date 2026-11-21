import { statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
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
import { inboxAgentFetchAction, inboxAgentWithoutDrawingPaths } from "./inbox-agent-files";
import { bytesOfBase64, createInboxAgentPieces, inboxAgentPieceAction } from "./inbox-agent-pieces";
import { hasCloudWake, INBOX_CLOUD_PLACES_DIR, type InboxCloudAgent, type InboxCloudAgents } from "./inbox-cloud-agents";
import { prototypePlace } from "./inbox-live";
import { isWebPrototype } from "./inbox-web-prototypes";
import type { InboxCloudSendFile } from "./inbox-cloud-pictures";
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

/** Fields that hold a place on the person's computer (a file's path, a project's folder): never handed to a cloud agent. */
const LOCAL_PATH_FIELDS = new Set(["path", "named_path", "base_path", "root", "project_path", "working_folder", "cwd"]);

/** A tool's structured result with every LOCAL_PATH_FIELDS field left out, at any depth; names, ids and the rest stay. */
export function withoutLocalPaths(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutLocalPaths);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !LOCAL_PATH_FIELDS.has(key)).map(([key, inner]) => [key, withoutLocalPaths(inner)]));
}

const isFolder = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

export function createInboxAgentDoor(context: InboxAgentDoorContext) {
  const { store, agents } = context;
  const pieces = createInboxAgentPieces(store.dir);
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
   * The context of one call. `files`: what it attached in this send, always set (empty when nothing), so every picture
   * in what it writes comes from those bytes and nothing is ever looked for on this computer (inbox-cloud-pictures.ts).
   */
  const contextFor = (agent: InboxCloudAgent, files: readonly InboxCloudSendFile[]): InboxMcpContext => ({
    ...context.mcp,
    inlineImageFiles: files,
    resolveProject: async (path) => {
      const found = store.projectByRoot(path) ?? (path === agents.homeRoot(agent) ? agents.home(agent) : null);
      if (!found) throw new InboxError("project_not_found", "No such project.");
      return found;
    },
    projectRootOf: undefined,
    findProjects: async (path) => (path === EVERY_PROJECT ? { projects: [], unresolved: false, every: true } : { projects: [store.projectByRoot(path)].filter((p): p is InboxProject => p !== null), unresolved: false }),
    // This send's own uploads only (the ones its body does not show as pictures), each once.
    recordAttachments: async (ids) => {
      const uploads = new Set(files.map((file) => file.id));
      if (new Set(ids).size !== ids.length || ids.some((id) => typeof id !== "string" || !uploads.has(id))) throw new InboxError("attachment_path_refused", "attachments: uploaded bytes only.");
      return inboxUploadAttachments(store.dir, [...ids] as string[], new Date(context.mcp.now?.() ?? Date.now()).toISOString());
    },
    checkPrototypeApps: async (apps, probing) => {
      const app = apps.find((candidate) => !isWebPrototype(candidate.target));
      if (!app && context.mcp.checkPrototypeApps) return context.mcp.checkPrototypeApps(apps, probing);
      throw new InboxError(
        "validation_error",
        `body: ${prototypePlace(app ?? apps[0]!)}: Prototype: ${(app ?? apps[0]!).target}: the Inbox opens a running app only on the person's computer, and yours runs elsewhere. Give its https:// address, or attach the page's HTML file in this send and name it (Prototype: mock.html).`,
        { field: "body" },
      );
    },
    // Branch reviews: a cloud agent's report is a branch that lives wherever it pushed it (inbox-mcp-branch.ts).
    cloudAgent: { homeRoot: agents.homeRoot(agent) },
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
    // A repository by its git address (https://github.com/acme/api, git@github.com:acme/api.git): the one project
    // whose origin it is, as a branch report finds it. One no project here has is not found: nothing is made for it.
    const byRemote = context.mcp.branches?.projectOfRemote?.(value.trim()) ?? null;
    if (byRemote) return byRemote;
    if (sameName(agents.homeName(agent), value)) return agents.home(agent);
    throw new DoorRefusal("project_not_found", `No project is named ${JSON.stringify(value.trim())}. Projects: ${projectNames().join(", ") || "none yet"}.`);
  };

  const projectNames = () => store.listProjects().map((project) => project.name);
  const receive = async (agent: InboxCloudAgent, value: unknown): Promise<AgentAttachedFile[]> => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new DoorRefusal("validation_error", "attachments: a list of { name, data } (data: the file's bytes as base64), or { upload } for a file sent in pieces.");
    const files = value.map((item, i): { piece: ReturnType<typeof pieces.take> } | { name: string; bytes: Buffer } => {
      if (typeof item === "string") {
        throw new DoorRefusal("attachment_path_refused", `attachments[${i}]: ${JSON.stringify(item)} is a path, and the Inbox opens no path for a cloud agent. Send the file's bytes: { "name": "shot.png", "data": "<base64>" } (plannotator inbox call does this for a path on your own disk).`);
      }
      const file = item as { name?: unknown; data?: unknown; upload?: unknown } | null;
      if (file && typeof file === "object" && "upload" in file) return { piece: pieces.take(agent.session, file.upload) };
      const bytes = file && typeof file === "object" && typeof file.name === "string" ? bytesOfBase64(file.data) : null;
      if (!bytes) throw new DoorRefusal("validation_error", `attachments[${i}]: { name, data } with data as base64, or { upload } for a file sent in pieces.`);
      return { name: file!.name as string, bytes };
    });
    const total = files.reduce((sum, file) => sum + ("bytes" in file ? file.bytes.length : 0), 0);
    if (total > INBOX_AGENT_ATTACHMENTS_MAX_BYTES) {
      throw new DoorRefusal("attachments_too_large", `attachments: at most ${INBOX_AGENT_ATTACHMENTS_MAX_BYTES / (1024 * 1024)} MB as data in one message. Send a bigger file in pieces (plannotator inbox call does this for a path on your own disk).`);
    }
    const at = new Date(context.mcp.now?.() ?? Date.now()).toISOString();
    const ids: string[] = [];
    const received: AgentAttachedFile[] = [];
    try {
      for (const file of files) {
        if ("piece" in file) {
          ids.push((await receiveInboxUpload(store.dir, file.piece.name, Bun.file(file.piece.path).stream(), { at })).upload_id);
          received.push({ id: ids[ids.length - 1]!, name: file.piece.name });
          continue;
        }
        const bytes = file.bytes;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(bytes));
            controller.close();
          },
        });
        ids.push((await receiveInboxUpload(store.dir, file.name, stream, { at })).upload_id);
        received.push({ id: ids[ids.length - 1]!, name: file.name });
      }
    } catch (error) {
      removeInboxUploads(store.dir, ids);
      throw error;
    }
    for (const file of files) if ("piece" in file) file.piece.drop();
    return received;
  };

  /** The files a send attached, with the Inbox's own copy of each (the only place a picture of it is read from). */
  const sendFilesOf = (received: readonly AgentAttachedFile[]): InboxCloudSendFile[] =>
    received.flatMap((file) => {
      const upload = readInboxUpload(store.dir, file.id);
      return upload ? [{ id: file.id, name: upload.name, path: inboxBlobPath(store.dir, upload.sha256) }] : [];
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
  /**
   * A walkthrough reads the files it names from the project's folder on the person's computer (inbox-walkthrough.ts),
   * as it does for a local agent, whatever commit that checkout is at. A project with no folder there (the agent's own
   * place, or one whose folder is gone) has nothing to read: said plainly, before anything is sent.
   */
  const refuseWalkthroughWithoutCheckout = (agent: InboxCloudAgent, args: Record<string, unknown>) => {
    const replied = typeof args.reply_to === "string" ? store.message(args.reply_to.trim()) : null;
    const replyThread = replied?.thread_id ?? null;
    const asked = args.walkthrough === true || (!!replyThread && !!context.mcp.walkthroughThread?.(replyThread));
    if (!asked || args.snapshot !== undefined || args.guide === undefined || !context.mcp.codeReviewOn?.()) return;
    const named = args[PROJECT_FIELD] === undefined ? null : projectNamed(agent, args[PROJECT_FIELD]);
    const project = named ?? (replied ? store.project(replied.project_id) : null);
    const root = project?.root ?? agents.homeRoot(agent);
    // A cloud agent's own place (a folder under the Inbox's data, made for its threads) holds no checkout.
    const inPlaces = relative(join(store.dir, INBOX_CLOUD_PLACES_DIR), root);
    const ownPlace = !inPlaces.startsWith("..") && !isAbsolute(inPlaces);
    if (!ownPlace && isFolder(root)) return;
    throw new DoorRefusal(
      "no_checkout",
      `walkthrough: it reads the files it names from the project's checkout on the person's computer, and ${project?.name ?? agents.homeName(agent)} has none there. Pass project with a project that is checked out on their computer (whoami lists them; its git address works too), or send guide with patch instead.`,
    );
  };
  /** A routine with no folder: the project the agent names, as a local agent's runs in its own project; else a new scratch folder (a cloud agent has no folder here). */
  const routineFolder = (call: Record<string, unknown>, named: InboxProject | null) => {
    if (named) call.project_path = named.root;
    else if (call.op === "create" && call.folder === undefined) call.folder = { scratch: true };
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
    const pieceResult = inboxAgentPieceAction(pieces, agent.session, tool, args);
    if (pieceResult) return pieceResult;
    const fetched = await inboxAgentFetchAction(store, agent.session, tool, args);
    if (fetched) return fetched;

    const tools = await servedTools(contextFor(agent, []));
    const fields = tools.get(tool);
    if (!fields) throw new DoorRefusal("tool_not_allowed", `${tool} is not an Inbox action. Actions: ${[WHOAMI, ...tools.keys()].join(", ")}.`);
    const open = [...fields.filter((field) => !IDENTITY_FIELDS.includes(field) && !(field in PATH_FIELDS)), ...(fields.includes("project_path") ? [PROJECT_FIELD] : [])];
    const unknown = Object.keys(args).find((field) => !open.includes(field));
    if (unknown) throw new DoorRefusal("validation_error", `${unknown}: not taken through the agent door. ${tool} takes: ${open.join(", ") || "no fields"}.`);

    // A routine's files are paths on the person's computer that each run gets (the tool takes no bytes): not named by
    // a cloud agent, whose paths are on its own machine. The rest of a routine is as a local agent's (the owner, 2026-11-21).
    if (tool === "routine" && args.attachments !== undefined) {
      throw new DoorRefusal("attachment_path_refused", "attachments: a routine's files are paths on the person's computer, which a cloud agent does not name. Make the routine without them; the person can add files to it in Routines in the Inbox.");
    }
    if (tool === "submit_guide") refuseWalkthroughWithoutCheckout(agent, args);
    const received = tool !== "routine" && fields.includes("attachments") ? await receive(agent, args.attachments) : [];
    try {
      // Every file goes to the tool; the send keeps below the message the ones its body does not show (inbox-cloud-pictures.ts).
      const sent = argumentsFor(agent, tool, fields, args, received.map((file) => file.id), commandId);
      const answer = await mcpRequest(contextFor(agent, sendFilesOf(received)), "tools/call", { name: tool, arguments: sent });
      if (!answer || answer.error) return fail("internal_error", answer?.error?.message ?? "The Inbox gave no answer.");
      // No place on the person's computer: a drawing's path in the person's words becomes its name (inbox-agent-files.ts).
      const result = inboxAgentWithoutDrawingPaths(store.dir, answer.result as ToolResult);
      return result.structuredContent === undefined ? result : { ...result, structuredContent: withoutLocalPaths(result.structuredContent) as ToolResult["structuredContent"] };
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
