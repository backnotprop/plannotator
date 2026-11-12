import {
  INBOX_CODEX_HOST,
  INBOX_CODEX_NAME,
  INBOX_HOST_NAMES,
  INBOX_QWEN_HOST,
  INBOX_QWEN_NAME,
  INBOX_QWEN_SESSION_ENV,
  INBOX_T3_HOST,
  INBOX_T3_NAME,
  INBOX_T3_THREAD_ENV,
  INBOX_WAKING_HOSTS,
  codexThreadOfCall,
  inboxId,
  isCodexThreadId,
  isInboxSessionId,
  isQwenMcpClient,
  isQwenSessionId,
  isT3ThreadId,
  qwenSessionOfCall,
} from "@plannotator/core/inbox-types";
import { inboxStatus, type InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import { qwenHome, qwenSessionOfProcess } from "@plannotator/shared/inbox/qwen-sessions";
import { INBOX_MAX_REQUEST_BYTES, inboxRequestTooLargeMessage } from "@plannotator/shared/inbox/connection";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

const FILLED_TOOLS = new Set(["send_message", "read_thread", "submit_guide", "card", "steps", "thread_pulls"]);
const NO_PROJECT_TOOLS = new Set(["steps"]);
const PROJECT_ONLY_TOOLS = new Set(["search"]);
const AUTHOR_TOOLS = new Set(["send_message", "submit_guide", "card", "steps", "thread_pulls"]);

export const INBOX_SESSION_HOST_NAMES: Readonly<Record<string, string>> = Object.fromEntries(INBOX_WAKING_HOSTS.map((host) => [host, INBOX_HOST_NAMES[host]!]));

export interface InboxHostSession {
  host: string;
  session: string;
  name: string;
}

export function inboxHostSessionFromEnv(env: Record<string, string | undefined>): InboxHostSession | null {
  const tag = env.PLANNOTATOR_SESSION_TAG;
  if (typeof tag === "string") {
    const colon = tag.indexOf(":");
    const host = colon > 0 ? tag.slice(0, colon) : "";
    const session = tag.slice(colon + 1);
    if (
      Object.hasOwn(INBOX_SESSION_HOST_NAMES, host) &&
      isInboxSessionId(session) &&
      (host !== INBOX_CODEX_HOST || isCodexThreadId(session)) &&
      (host !== INBOX_QWEN_HOST || isQwenSessionId(session)) &&
      (host !== INBOX_T3_HOST || isT3ThreadId(session))
    ) {
      return { host, session, name: INBOX_SESSION_HOST_NAMES[host]! };
    }
  }
  const t3 = env[INBOX_T3_THREAD_ENV];
  if (isT3ThreadId(t3)) return { host: INBOX_T3_HOST, session: t3, name: INBOX_T3_NAME };
  const pi = env.PI_SESSION_ID;
  if (isInboxSessionId(pi)) return { host: "pi", session: pi, name: INBOX_SESSION_HOST_NAMES.pi! };
  const codex = env.CODEX_THREAD_ID;
  if (isCodexThreadId(codex)) return { host: INBOX_CODEX_HOST, session: codex, name: INBOX_CODEX_NAME };
  const qwen = env[INBOX_QWEN_SESSION_ENV];
  if (isQwenSessionId(qwen)) return { host: INBOX_QWEN_HOST, session: qwen, name: INBOX_QWEN_NAME };
  if (env.DSH_SHELL === "1" && !INBOX_NON_DSH_MARKERS.some((key) => !!env[key])) {
    const rootHere = isInboxSessionId(env[INBOX_DSH_ROOT_SESSION_ENV]) && env[INBOX_DSH_ROOT_FOR_ENV] === env.DSH_SESSION_ID;
    const dsh = rootHere ? env[INBOX_DSH_ROOT_SESSION_ENV] : env.DSH_SESSION_ID;
    if (isInboxSessionId(dsh)) return { host: INBOX_DSH_HOST, session: dsh, name: INBOX_SESSION_HOST_NAMES[INBOX_DSH_HOST]! };
  }
  return null;
}

export const INBOX_DSH_HOST = "dsh";

export const INBOX_DSH_ROOT_SESSION_ENV = "DSH_PLANNOTATOR_SESSION_ID";

export const INBOX_DSH_ROOT_FOR_ENV = "DSH_PLANNOTATOR_SESSION_FOR";

const INBOX_NON_DSH_MARKERS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CURSOR_AGENT", "OPENCODE", "GEMINI_CLI", "COPILOT_CLI", "OMPCODE", "QWEN_CODE"] as const;

export const INBOX_SESSION_PROJECT_ENV = "PLANNOTATOR_SESSION_PROJECT";

export interface InboxSessionProject {
  host: string;
  session: string;
  folder: string;
}

export function inboxSessionProjectFromEnv(env: Record<string, string | undefined>): InboxSessionProject | null {
  const value = env[INBOX_SESSION_PROJECT_ENV];
  if (typeof value !== "string") return null;
  const first = value.indexOf(":");
  const second = first > 0 ? value.indexOf(":", first + 1) : -1;
  if (second < 0) return null;
  const host = value.slice(0, first);
  const session = value.slice(first + 1, second);
  const folder = value.slice(second + 1);
  if (!Object.hasOwn(INBOX_SESSION_HOST_NAMES, host) || !isInboxSessionId(session) || !isAbsolute(folder)) return null;
  return { host, session, folder };
}

export function inboxProjectFolderFor(sessionProject: InboxSessionProject | null, caller: { host?: string | null; session: string } | null | undefined, cwd: string): string {
  if (!sessionProject || !caller || caller.session !== sessionProject.session) return cwd;
  if (caller.host != null && caller.host !== sessionProject.host) return cwd;
  try {
    return statSync(sessionProject.folder).isDirectory() ? sessionProject.folder : cwd;
  } catch {
    return cwd;
  }
}

export interface InboxQwenShimContext {
  home: string;
  parentPid: number;
  envSession: string | null;
}

export function inboxQwenShimContext(env: Record<string, string | undefined>, homeDir: string, cwd: string, parentPid: number): InboxQwenShimContext {
  const session = env[INBOX_QWEN_SESSION_ENV];
  return { home: qwenHome(env, homeDir, cwd), parentPid, envSession: isQwenSessionId(session) ? session : null };
}

const qwenHostSession = (session: string): InboxHostSession => ({ host: INBOX_QWEN_HOST, session, name: INBOX_QWEN_NAME });

export function inboxCallHostSession(
  hostSession: InboxHostSession | null,
  qwen: InboxQwenShimContext | null | undefined,
  meta: unknown,
  clientName: string | null,
): InboxHostSession | null {
  const named = qwenSessionOfCall(meta);
  if (named) return qwenHostSession(named);
  const fromEnv = qwen?.envSession ?? null;
  const qwenClient = isQwenMcpClient(clientName);
  const other = hostSession && hostSession.host !== INBOX_QWEN_HOST ? hostSession : null;
  if (!qwen || (!qwenClient && fromEnv === null)) return hostSession;
  const record = qwenSessionOfProcess(qwen.home, qwen.parentPid);
  if (qwenClient || record) {
    const session = record?.sessionId ?? fromEnv;
    return session ? qwenHostSession(session) : other;
  }
  if (clientName !== null) return other;
  return other ?? qwenHostSession(fromEnv!);
}
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";

export interface InboxMcpShimOptions {
  dataDir: string;
  cwd: string;
  ensureRunning: () => Promise<InboxRegistryEntry>;
  hostSession?: InboxHostSession | null;
  qwen?: InboxQwenShimContext | null;
  sessionProject?: InboxSessionProject | null;
  askAiChild?: boolean;
  t3EntryIdle?: boolean;
  input?: ReadableStream<Uint8Array>;
  write?: (line: string) => void;
}

type JsonRpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> };

function rpcError(id: string | number | null | undefined, message: string, code = -32603): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

export function fillInboxToolArguments(
  message: JsonRpc,
  cwd: string,
  own: string | null,
  hostSession?: (Pick<InboxHostSession, "session"> & Partial<InboxHostSession>) | null,
  clientName?: string | null,
  sessionProject?: InboxSessionProject | null,
): JsonRpc {
  if (message.method !== "tools/call" || !message.params) return message;
  const codexThread = codexThreadOfCall(message.params._meta, clientName);
  if (codexThread) hostSession = { host: INBOX_CODEX_HOST, session: codexThread, name: INBOX_CODEX_NAME };
  const name = message.params.name;
  if (typeof name !== "string") return message;
  if (PROJECT_ONLY_TOOLS.has(name)) {
    const args = { ...((message.params.arguments as Record<string, unknown> | undefined) ?? {}) };
    if (args.project_path === undefined && args.all_projects !== true) args.project_path = inboxProjectFolderFor(sessionProject ?? null, hostSession, cwd);
    return { ...message, params: { ...message.params, arguments: args } };
  }
  if (!FILLED_TOOLS.has(name)) return message;
  const args = { ...((message.params.arguments as Record<string, unknown> | undefined) ?? {}) };
  if (!NO_PROJECT_TOOLS.has(name) && args.project_path === undefined && args.reply_to === undefined) {
    const adopts = hostSession && args.agent_session === undefined && adoptsHostSession(hostSession, args.agent_host);
    const caller = adopts ? hostSession : typeof args.agent_session === "string" ? { host: typeof args.agent_host === "string" ? args.agent_host : null, session: args.agent_session } : null;
    args.project_path = inboxProjectFolderFor(sessionProject ?? null, caller, cwd);
  }
  if (args.agent_session === undefined) {
    if (hostSession && adoptsHostSession(hostSession, args.agent_host)) {
      args.agent_session = hostSession.session;
      if (AUTHOR_TOOLS.has(name)) {
        if (hostSession.host) args.agent_host = hostSession.host;
        if (args.agent_name === undefined && hostSession.name) args.agent_name = hostSession.name;
      }
    } else if (own !== null) {
      args.agent_session = own;
    }
  }
  return { ...message, params: { ...message.params, arguments: args } };
}

function adoptsHostSession(hostSession: Partial<InboxHostSession>, agentHost: unknown): boolean {
  if (agentHost === undefined || agentHost === hostSession.host) return true;
  return hostSession.host === INBOX_T3_HOST && agentHost === "claude-code";
}

export const INBOX_ASK_AI_CHILD_REFUSAL = "The Plannotator Inbox is off in an agent that Plannotator's Ask AI started.";
export const INBOX_T3_ENTRY_REFUSAL = "This plannotator-inbox entry (plannotator inbox mcp --t3) lists its tools only inside a T3 Code thread.";

export function inboxT3EntryIdle(t3Flag: boolean, env: Record<string, string | undefined>): boolean {
  return t3Flag && !isT3ThreadId(env[INBOX_T3_THREAD_ENV]);
}

export function toolessReply(message: JsonRpc, refusal: string = INBOX_ASK_AI_CHILD_REFUSAL): string | null {
  if (!message || typeof message !== "object" || !("id" in message) || typeof message.method !== "string") return null;
  const result = (value: Record<string, unknown>) => JSON.stringify({ jsonrpc: "2.0", id: message.id ?? null, result: value });
  switch (message.method) {
    case "initialize": {
      const requested = message.params?.protocolVersion;
      return result({
        protocolVersion: typeof requested === "string" ? requested : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "plannotator-inbox", version: "1.0.0" },
      });
    }
    case "tools/list":
      return result({ tools: [] });
    case "ping":
      return result({});
    default:
      return rpcError(message.id, refusal, -32601);
  }
}

function sseMessages(text: string): string[] {
  const out: string[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data.trim()) out.push(data);
  }
  return out;
}

export async function runInboxMcpShim(options: InboxMcpShimOptions): Promise<void> {
  const own = inboxId("ses");
  const hostSession = options.hostSession ?? null;
  const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  let negotiatedVersion: string | null = null;
  let clientName: string | null = null;

  const entry = async (): Promise<InboxRegistryEntry> => {
    const status = await inboxStatus(options.dataDir, 1500);
    if (status.state === "running") return status.entry;
    return options.ensureRunning();
  };

  const forward = async (raw: string): Promise<void> => {
    let message: JsonRpc;
    try {
      message = JSON.parse(raw) as JsonRpc;
    } catch {
      write(rpcError(null, "Parse error", -32700));
      return;
    }
    if (options.askAiChild || options.t3EntryIdle) {
      const reply = toolessReply(message, options.askAiChild ? INBOX_ASK_AI_CHILD_REFUSAL : INBOX_T3_ENTRY_REFUSAL);
      if (reply) write(reply);
      return;
    }
    const isRequest = message && typeof message === "object" && "id" in message && typeof message.method === "string";
    if (message?.method === "initialize") {
      const name = (message.params?.clientInfo as { name?: unknown } | undefined)?.name;
      if (typeof name === "string") clientName = name;
    }
    const callHost = message?.method === "tools/call" ? inboxCallHostSession(hostSession, options.qwen, message.params?._meta, clientName) : hostSession;
    const outgoing = fillInboxToolArguments(message, options.cwd, own, callHost, clientName, options.sessionProject);
    let target: InboxRegistryEntry;
    try {
      target = await entry();
    } catch (error) {
      if (isRequest) write(rpcError(message.id, `Plannotator Inbox is not running: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    const body = JSON.stringify(outgoing);
    const bytes = Buffer.byteLength(body);
    if (bytes > INBOX_MAX_REQUEST_BYTES) {
      if (isRequest) write(rpcError(message.id, inboxRequestTooLargeMessage(bytes), -32600));
      return;
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const envelopeVersion = (outgoing.params?._meta as Record<string, unknown> | undefined)?.[PROTOCOL_VERSION_META_KEY];
    if (typeof envelopeVersion === "string") headers["MCP-Protocol-Version"] = envelopeVersion;
    else if (negotiatedVersion && outgoing.method !== "initialize") headers["MCP-Protocol-Version"] = negotiatedVersion;

    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${target.port}/mcp`, {
        method: "POST",
        headers,
        body,
      });
    } catch (error) {
      if (isRequest) write(rpcError(message.id, `Plannotator Inbox did not answer: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    if (response.status === 202) return;
    const text = await response.text();
    const type = response.headers.get("content-type") ?? "";
    const bodies = type.includes("text/event-stream") ? sseMessages(text) : text.trim() ? [text] : [];
    let wrote = false;
    for (const body of bodies) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        continue;
      }
      for (const raw of Array.isArray(parsed) ? parsed : [parsed]) {
        const item =
          isRequest && !response.ok && raw && typeof raw === "object" && (raw as { id?: unknown }).id == null && "error" in raw
            ? { ...(raw as object), id: message.id }
            : raw;
        const reply = item as JsonRpc;
        if (outgoing.method === "initialize" && typeof reply?.result?.protocolVersion === "string") {
          negotiatedVersion = reply.result.protocolVersion as string;
        }
        write(JSON.stringify(item));
        wrote = true;
      }
    }
    if (!wrote && isRequest) {
      write(
        response.status === 413
          ? rpcError(message.id, inboxRequestTooLargeMessage(bytes), -32600)
          : rpcError(message.id, `Plannotator Inbox answered HTTP ${response.status}.`),
      );
    }
  };

  const input = options.input ?? (Bun.stdin.stream() as ReadableStream<Uint8Array>);
  const inFlight = new Set<Promise<void>>();
  const dispatch = (line: string) => {
    if (!line.trim()) return;
    const task = forward(line).catch((error) => {
      process.stderr.write(`[plannotator inbox mcp] ${error instanceof Error ? error.message : String(error)}\n`);
    });
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
  };
  const decoder = new TextDecoder();
  let pending: Uint8Array[] = [];
  const takeLine = (tail: Uint8Array) => {
    pending.push(tail);
    const line = pending.length === 1 ? pending[0]! : Buffer.concat(pending);
    pending = [];
    dispatch(decoder.decode(line));
  };
  for await (const chunk of input) {
    let start = 0;
    let newline: number;
    while ((newline = chunk.indexOf(0x0a, start)) !== -1) {
      takeLine(chunk.subarray(start, newline));
      start = newline + 1;
    }
    if (start < chunk.length) pending.push(chunk.slice(start));
  }
  if (pending.length > 0) takeLine(new Uint8Array(0));
  await Promise.all([...inFlight]);
}
