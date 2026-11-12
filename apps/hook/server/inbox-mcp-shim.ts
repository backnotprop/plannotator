/**
 * `plannotator inbox mcp`: the stdio MCP entry for any agent.
 *
 * A thin JSON-RPC proxy, not a second MCP server: each newline-delimited
 * message on stdin is POSTed to the running Inbox's `/mcp` and every message
 * it answers with goes to stdout, so the tool list and its rules live once, in
 * the server. On every message the shim re-reads `inbox/inbox.json` (never
 * caching the port) and, when the Inbox is stopped, starts it detached with
 * `plannotator inbox --background` semantics: no browser tab.
 *
 * Two arguments are filled on the Inbox's own tools when the agent left them
 * out: `project_path` (this shim's working folder, the agent's project) and
 * `agent_session`, so `asked_by: "me"` means this agent session. The session
 * is the agent host's own when the shim runs
 * inside one (`inboxHostSessionFromEnv`: a Claude Code session's
 * `PLANNOTATOR_SESSION_TAG`, a Pi bash call's `PI_SESSION_ID`), so a script or
 * command the session runs sends as that session, exactly as its
 * `plannotator_inbox` tool does: the same author, the same threads, and
 * the person's reply wakes it. A Codex session is its thread: Codex names it
 * on every tool call (`params._meta.threadId`, from the `codex-mcp-client`)
 * and in the commands its shell runs (`CODEX_THREAD_ID`), and the shim sends
 * as `agent_host: "codex"` with that id, so the Inbox can queue the person's
 * reply into that thread (packages/server/inbox-codex-wake.ts). A Qwen Code
 * session is read at every call (`inboxCallHostSession`): Qwen's registry
 * record for the shim's parent process, since `/clear` and `/resume` change
 * the id the shim was started with. A T3 Code thread is its thread id
 * (`T3CODE_THREAD_ID`, which T3 sets for the Claude it runs through the Agent
 * SDK), sent as `agent_host: "t3"`, so the Inbox can put the person's reply
 * into that thread (packages/server/inbox-t3-wake.ts). Otherwise it is one
 * `ses_` id per shim process, and an MCP client that wants its threads across
 * restarts passes `agent_session` itself.
 *
 * Inside an agent Plannotator's Ask AI started (`PLANNOTATOR_ASK_AI_CHILD=1`,
 * `isAskAiChild`), the shim is an MCP server with no tools and never starts
 * or reaches the Inbox (`toolessReply`). So is an entry added with `--t3`
 * (`plannotator inbox mcp --t3`, the T3 Code setup's) anywhere but inside a
 * T3 Code thread (`inboxT3EntryIdle`): the person's interactive Claude Code
 * loads the same user-scope entry, and there the mod's tool is the Inbox.
 *
 * stdout carries JSON-RPC only; anything else goes to stderr.
 */

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
/** The filled tools that take no project: thread steps name their thread (the schema is strict, so no `project_path`). */
const NO_PROJECT_TOOLS = new Set(["steps"]);
/** The tools that take the project but no session: search (its schema is strict, so no `agent_session`). */
const PROJECT_ONLY_TOOLS = new Set(["search"]);
/** The tools that record an author, and so take `agent_host` / `agent_name` (their schemas are strict). A card records who made and moved it; a thread's PRs, who added each. */
const AUTHOR_TOOLS = new Set(["send_message", "submit_guide", "card", "steps", "thread_pulls"]);

/**
 * The hosts whose sessions a reply wakes, with the name each one's
 * `plannotator_inbox` tool sends (`INBOX_AGENT_NAME` in the Claude Code mod,
 * `PI_INBOX_AGENT_NAME`, `OPENCODE_INBOX_AGENT_NAME`), and Codex and Qwen
 * Code, which the Inbox wakes itself (`codex queue`, Qwen's cross-session
 * messaging), and T3 Code, whose thread the Inbox sends into through T3's MCP API.
 */
export const INBOX_SESSION_HOST_NAMES: Readonly<Record<string, string>> = Object.fromEntries(INBOX_WAKING_HOSTS.map((host) => [host, INBOX_HOST_NAMES[host]!]));

/** The agent host session a shim process runs inside. */
export interface InboxHostSession {
  host: string;
  session: string;
  name: string;
}

/**
 * The agent session this process belongs to, from the environment it
 * inherited, or null. `PLANNOTATOR_SESSION_TAG` (`<host>:<session id>`, set by
 * the Claude Code mod in every process its session starts) comes first; then
 * `T3CODE_THREAD_ID`, which T3 Code sets for the Claude it runs (a UUID, or
 * the id T3 derives for a launched, scheduled, delegated or provider thread:
 * `isT3ThreadId`); then
 * `PI_SESSION_ID`, which Pi sets on each bash tool call; then
 * `CODEX_THREAD_ID`, which Codex sets in the commands its shell runs; Qwen's;
 * last `DSH_SESSION_ID`, DeepSeek Harness's, only beside `DSH_SHELL=1` (its
 * MCP client strips every `DSH_*` variable, so this is a DSH model shell's
 * `plannotator inbox call`). Anything
 * malformed or naming another host is ignored, never guessed at (a Codex
 * session is a thread id, a UUID; a T3 one any id T3 gives a thread).
 */
export function inboxHostSessionFromEnv(env: Record<string, string | undefined>): InboxHostSession | null {
  const tag = env.PLANNOTATOR_SESSION_TAG;
  if (typeof tag === "string") {
    const colon = tag.indexOf(":");
    const host = colon > 0 ? tag.slice(0, colon) : "";
    const session = tag.slice(colon + 1);
    if (
      Object.hasOwn(INBOX_SESSION_HOST_NAMES, host) &&
      (host === INBOX_T3_HOST ? isT3ThreadId(session) : isInboxSessionId(session)) &&
      (host !== INBOX_CODEX_HOST || isCodexThreadId(session)) &&
      (host !== INBOX_QWEN_HOST || isQwenSessionId(session))
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
  // DeepSeek Harness sets DSH_SESSION_ID with DSH_SHELL=1 in every model shell. Only there: the person's own
  // terminal in DSH Web gets DSH_SESSION_ID without DSH_SHELL, and whatever runs in it is not that session.
  // Last, and only when no other agent's marker is there: every process started from a DSH shell inherits
  // both, another agent included. Plannotator's DSH plugin adds the top-level session the shell works for
  // (a subagent's parent, as the plugin's tool signs), which wins over the subagent's own.
  if (env.DSH_SHELL === "1" && !INBOX_NON_DSH_MARKERS.some((key) => !!env[key])) {
    // The plugin's root counts only for the shell it was set for: a DSH started inside a DSH model shell gives its
    // own shells a new DSH_SESSION_ID, and an inherited root would name the outer session.
    const rootHere = isInboxSessionId(env[INBOX_DSH_ROOT_SESSION_ENV]) && env[INBOX_DSH_ROOT_FOR_ENV] === env.DSH_SESSION_ID;
    const dsh = rootHere ? env[INBOX_DSH_ROOT_SESSION_ENV] : env.DSH_SESSION_ID;
    if (isInboxSessionId(dsh)) return { host: INBOX_DSH_HOST, session: dsh, name: INBOX_SESSION_HOST_NAMES[INBOX_DSH_HOST]! };
  }
  return null;
}

export const INBOX_DSH_HOST = "dsh";

/** Set by Plannotator's DSH plugin in each model shell (DSH's `shellEnv`): the top-level session the shell works for. */
export const INBOX_DSH_ROOT_SESSION_ENV = "DSH_PLANNOTATOR_SESSION_ID";

/** Set beside it: the shell's own session (DSH_SESSION_ID) the root was worked out for. */
export const INBOX_DSH_ROOT_FOR_ENV = "DSH_PLANNOTATOR_SESSION_FOR";

/**
 * The markers other agents set in the shells and MCP servers they start. Any
 * of them beside DSH_SESSION_ID means that agent, started from a DSH shell,
 * is calling, not the DSH session (detect-origin.ts's rule for DSH_SHELL).
 */
const INBOX_NON_DSH_MARKERS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CURSOR_AGENT", "OPENCODE", "GEMINI_CLI", "COPILOT_CLI", "OMPCODE", "QWEN_CODE"] as const;

/**
 * The variable an agent host sets beside its session (the Claude Code mod
 * beside `PLANNOTATOR_SESSION_TAG`, the Pi extension beside `PI_SESSION_ID`):
 * `<host>:<session id>:<folder>`, the folder that session files under in the
 * Inbox (its `plannotator_inbox` tool's `project_path`). A command the
 * session runs (`plannotator inbox call`, `plannotator card`) files there too
 * when the agent names no project, wherever the shell has `cd`'d to, so one
 * session is one project for every tool.
 */
export const INBOX_SESSION_PROJECT_ENV = "PLANNOTATOR_SESSION_PROJECT";

/** A session's project folder, as its host exported it (`INBOX_SESSION_PROJECT_ENV`). */
export interface InboxSessionProject {
  host: string;
  session: string;
  folder: string;
}

/** `PLANNOTATOR_SESSION_PROJECT`, or null when it is absent or malformed (a known host, a session id, an absolute folder). */
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

/**
 * The folder a call files under when the agent named no project: the
 * session's own project folder when the call is filed as that very session
 * (its id, and its host when the caller names one: `inbox call --session <id>`
 * names none) and the folder still exists, else `cwd`. A variable inherited
 * from another session (a nested agent, a stale shell) never applies.
 */
export function inboxProjectFolderFor(sessionProject: InboxSessionProject | null, caller: { host?: string | null; session: string } | null | undefined, cwd: string): string {
  if (!sessionProject || !caller || caller.session !== sessionProject.session) return cwd;
  if (caller.host != null && caller.host !== sessionProject.host) return cwd;
  try {
    return statSync(sessionProject.folder).isDirectory() ? sessionProject.folder : cwd;
  } catch {
    return cwd;
  }
}

/**
 * Where the shim looks for the Qwen Code session it runs in: Qwen's home
 * (`$QWEN_HOME`, else `~/.qwen`), the shim's parent process (the Qwen process
 * that started it as an MCP server), and the session id Qwen set when it
 * started the shim (`QWEN_CODE_SESSION_ID`; stale after `/clear` or `/resume`).
 */
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

/**
 * The host session a tool call belongs to, with Qwen Code's read at the call:
 *
 *  - a daemon-run Qwen session names itself on the call
 *    (`_meta["qwen-code/invocation"].sessionId`);
 *  - otherwise, when the caller is Qwen (its MCP client name, or Qwen's
 *    session variable in this process's environment), the session is the one
 *    Qwen's registry has now for the parent process
 *    (`$QWEN_HOME/sessions/<parent pid>.json`, read on every call, so `/clear`
 *    and `/resume` move the shim to the new session), else that variable;
 *  - a variable another MCP client's process inherited (the client named
 *    itself, and the registry has no record for the parent) is not Qwen's.
 *
 * Qwen wins over another host's variable only when Qwen's client or registry
 * says so; on the variable alone, the environment's own order holds
 * (`inboxHostSessionFromEnv`).
 */
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
  // The variable alone: another client that named itself is not Qwen; with no name, the environment's order.
  if (clientName !== null) return other;
  return other ?? qwenHostSession(fromEnv!);
}
/** The 2026-07-28 per-request envelope's protocol-version key. */
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";

export interface InboxMcpShimOptions {
  dataDir: string;
  cwd: string;
  ensureRunning: () => Promise<InboxRegistryEntry>;
  /** The agent host session the shim runs inside (`inboxHostSessionFromEnv`); absent: one `ses_` id per process. */
  hostSession?: InboxHostSession | null;
  /** Where a Qwen Code session is read at each call (`inboxQwenShimContext`); absent: Qwen only through `hostSession`. */
  qwen?: InboxQwenShimContext | null;
  /** The host session's own project folder (`inboxSessionProjectFromEnv`): a call filed as that session files there, not in `cwd`. */
  sessionProject?: InboxSessionProject | null;
  /**
   * The shim runs in an agent Plannotator's Ask AI started (`isAskAiChild`):
   * it answers on its own with no tools (`toolessReply`), and never starts
   * or reaches the Inbox.
   */
  askAiChild?: boolean;
  /**
   * The entry was added with `--t3` and runs outside a T3 Code thread
   * (`inboxT3EntryIdle`): it answers on its own with no tools, and never
   * starts or reaches the Inbox.
   */
  t3EntryIdle?: boolean;
  /** Default: process stdin / stdout. */
  input?: ReadableStream<Uint8Array>;
  write?: (line: string) => void;
}

type JsonRpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> };

function rpcError(id: string | number | null | undefined, message: string, code = -32603): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

/**
 * Fill `project_path` and `agent_session` on the Inbox's tools when absent.
 * `own` is the shim's own `ses_` id (null: `plannotator inbox call`, which
 * outlives one call and so has none); `hostSession` the agent host session the
 * shim runs inside, if any. The host session is adopted only when the agent
 * named no host or that same host (an agent that says it is another host is
 * not that session, and a reply to it must not wake the session), and then its
 * host and name, where it has them, are filled too on the tools that record an
 * author.
 *
 * A call from Codex (`clientName` is `codex-mcp-client`, or the call carries
 * Codex's turn metadata) that names its thread (`params._meta.threadId`) is
 * that thread's: the host session is the thread, whatever the environment says.
 *
 * `project_path` is `cwd`, unless the call is filed as the session
 * `sessionProject` names (its host's `PLANNOTATOR_SESSION_PROJECT`): then
 * that session's own project folder (`inboxProjectFolderFor`), as its
 * `plannotator_inbox` tool would send.
 */
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
    // The session the call is filed as: the agent's own, else the host session it adopts below.
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

/**
 * Whether a call that names `agentHost` (or none) is filed as the host
 * session: when it names no host or that same host. In a T3 Code thread the
 * agent is Claude, which may name itself `claude-code`: that is still the
 * thread (T3 sets T3CODE_THREAD_ID only for Claude). Any other host it names
 * is not this session, and a reply to it must not wake the thread.
 */
function adoptsHostSession(hostSession: Partial<InboxHostSession>, agentHost: unknown): boolean {
  if (agentHost === undefined || agentHost === hostSession.host) return true;
  return hostSession.host === INBOX_T3_HOST && agentHost === "claude-code";
}

/** What a request other than initialize, tools/list and ping gets from a shim with no tools. */
export const INBOX_ASK_AI_CHILD_REFUSAL = "The Plannotator Inbox is off in an agent that Plannotator's Ask AI started.";
export const INBOX_T3_ENTRY_REFUSAL = "This plannotator-inbox entry (plannotator inbox mcp --t3) lists its tools only inside a T3 Code thread.";

/**
 * An entry added with `--t3` that runs outside a T3 Code thread: no
 * T3CODE_THREAD_ID holding a T3 thread id. It reads nothing else (no settings, no
 * Claude Code version), so an entry without the flag never changes.
 */
export function inboxT3EntryIdle(t3Flag: boolean, env: Record<string, string | undefined>): boolean {
  return t3Flag && !isT3ThreadId(env[INBOX_T3_THREAD_ENV]);
}

/**
 * The shim's own answer where it serves no tools (inside an agent Ask AI
 * started; a `--t3` entry outside a T3 Code thread): an MCP server with no
 * tools. `initialize`, an empty `tools/list` and `ping` are answered; any
 * other request is refused with `refusal`, and notifications get nothing.
 * Clients built on gemini-cli (Qwen Code) still report a server with no
 * tools, prompts or resources as an error and mark it disconnected. That is
 * harmless: they go on without it.
 */
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

/** The JSON-RPC messages in an SSE body (`data:` lines, joined per event). */
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
  /** The MCP client's name, from its `initialize` (Codex: `codex-mcp-client`). */
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
    // Qwen's session is read again for each call: /clear and /resume change it under the same Qwen process.
    const callHost = message?.method === "tools/call" ? inboxCallHostSession(hostSession, options.qwen, message.params?._meta, clientName) : hostSession;
    const outgoing = fillInboxToolArguments(message, options.cwd, own, callHost, clientName, options.sessionProject);
    let target: InboxRegistryEntry;
    try {
      target = await entry();
    } catch (error) {
      if (isRequest) write(rpcError(message.id, `Plannotator Inbox is not running: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    // Refused before anything is sent: the Inbox would answer 413 to it anyway.
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
        // An HTTP-level refusal (413, 400, 406, ...) is a JSON-RPC error the
        // server could not tie to a request, so it carries `id: null`, which
        // a client never matches: it would wait for its request until its own
        // timeout. The error answers this request, so it gets this id.
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
  // Lines are split on bytes and decoded once each, so a line's cost is linear
  // in its length however many chunks it arrives in (a 4 MiB message is ~64
  // pipe reads; re-scanning the whole pending text on every read was quadratic).
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
    // A copy: a stream may reuse its chunk buffer.
    if (start < chunk.length) pending.push(chunk.slice(start));
  }
  if (pending.length > 0) takeLine(new Uint8Array(0));
  await Promise.all([...inFlight]);
}
