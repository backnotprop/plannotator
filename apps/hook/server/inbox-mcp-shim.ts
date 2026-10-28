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
 * `agent_session`, so `asked_by: "me"` and a thread-less `wait_for_reply` mean
 * this agent session. The session is the agent host's own when the shim runs
 * inside one (`inboxHostSessionFromEnv`: a Claude Code session's
 * `PLANNOTATOR_SESSION_TAG`, a Pi bash call's `PI_SESSION_ID`), so a script or
 * command the session runs sends as that session, exactly as its
 * `plannotator_inbox` tool does: the same author, the same default thread, and
 * the person's reply wakes it. A Codex session is its thread: Codex names it
 * on every tool call (`params._meta.threadId`, from the `codex-mcp-client`)
 * and in the commands its shell runs (`CODEX_THREAD_ID`), and the shim sends
 * as `agent_host: "codex"` with that id, so the Inbox can queue the person's
 * reply into that thread (packages/server/inbox-codex-wake.ts). A Qwen Code
 * session is read at every call (`inboxCallHostSession`): Qwen's registry
 * record for the shim's parent process, since `/clear` and `/resume` change
 * the id the shim was started with. Otherwise it is one `ses_` id per shim process,
 * and an MCP client that wants its threads across restarts passes
 * `agent_session` itself.
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
  INBOX_WAKING_HOSTS,
  codexThreadOfCall,
  inboxId,
  isCodexThreadId,
  isQwenMcpClient,
  isQwenSessionId,
  qwenSessionOfCall,
} from "@plannotator/core/inbox-types";
import { inboxStatus, type InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import { qwenHome, qwenSessionOfProcess } from "@plannotator/shared/inbox/qwen-sessions";
import { INBOX_MAX_REQUEST_BYTES, INBOX_WAKES_META_KEY, inboxRequestTooLargeMessage } from "@plannotator/shared/inbox/connection";

const FILLED_TOOLS = new Set(["send_message", "read_thread", "wait_for_reply", "submit_guide", "card"]);
/** The tools that take the project but no session: search (its schema is strict, so no `agent_session`). */
const PROJECT_ONLY_TOOLS = new Set(["search"]);
/** The tools that record an author, and so take `agent_host` / `agent_name` (their schemas are strict). A card records who made and moved it. */
const AUTHOR_TOOLS = new Set(["send_message", "submit_guide", "card"]);

/**
 * The hosts whose sessions a reply wakes, with the name each one's
 * `plannotator_inbox` tool sends (`INBOX_AGENT_NAME` in the Claude Code mod,
 * `PI_INBOX_AGENT_NAME`, `OPENCODE_INBOX_AGENT_NAME`), and Codex and Qwen
 * Code, which the Inbox wakes itself (`codex queue`, Qwen's cross-session
 * messaging); and Grok Build, a session the Inbox runs itself over ACP
 * (packages/server/inbox-acp-runner.ts), which is not in INBOX_WAKING_HOSTS
 * (no bridge or MCP wake: the runner's turns).
 */
export const INBOX_SESSION_HOST_NAMES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(INBOX_WAKING_HOSTS.map((host) => [host, INBOX_HOST_NAMES[host]!])),
  grok: INBOX_HOST_NAMES.grok!,
};

/**
 * The hosts whose sessions the Inbox runs itself over ACP (packages/server/
 * inbox-acp-runner.ts sets the tag in the shim's own environment, never in
 * the agent's): every reply reaches them as a turn, so the shim marks their
 * tool calls as coming through a connection that wakes the session
 * (`INBOX_WAKES_META_KEY`), and send_message tells the agent the reply comes
 * by itself instead of telling it to wait_for_reply.
 */
export const INBOX_RUNNER_HOSTS: ReadonlySet<string> = new Set(["grok"]);

/** A host session id: what Claude Code, Pi and OpenCode use (UUIDs, `ses_` ids), and nothing that could carry anything else. */
const HOST_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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
 * `PI_SESSION_ID`, which Pi sets on each bash tool call; then
 * `CODEX_THREAD_ID`, which Codex sets in the commands its shell runs. Anything
 * malformed or naming another host is ignored, never guessed at (a Codex
 * session is a thread id, a UUID).
 */
export function inboxHostSessionFromEnv(env: Record<string, string | undefined>): InboxHostSession | null {
  const tag = env.PLANNOTATOR_SESSION_TAG;
  if (typeof tag === "string") {
    const colon = tag.indexOf(":");
    const host = colon > 0 ? tag.slice(0, colon) : "";
    const session = tag.slice(colon + 1);
    if (Object.hasOwn(INBOX_SESSION_HOST_NAMES, host) && HOST_SESSION_ID.test(session) && (host !== INBOX_CODEX_HOST || isCodexThreadId(session)) && (host !== INBOX_QWEN_HOST || isQwenSessionId(session))) {
      return { host, session, name: INBOX_SESSION_HOST_NAMES[host]! };
    }
  }
  const pi = env.PI_SESSION_ID;
  if (typeof pi === "string" && HOST_SESSION_ID.test(pi)) return { host: "pi", session: pi, name: INBOX_SESSION_HOST_NAMES.pi! };
  const codex = env.CODEX_THREAD_ID;
  if (isCodexThreadId(codex)) return { host: INBOX_CODEX_HOST, session: codex, name: INBOX_CODEX_NAME };
  const qwen = env[INBOX_QWEN_SESSION_ENV];
  if (isQwenSessionId(qwen)) return { host: INBOX_QWEN_HOST, session: qwen, name: INBOX_QWEN_NAME };
  return null;
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
 * `own` is the shim's own `ses_` id; `hostSession` the agent host session the
 * shim runs inside, if any. The host session is adopted only when the agent
 * named no host or that same host (an agent that says it is another host is
 * not that session, and a reply to it must not wake the session), and then its
 * host and name are filled too on the tools that record an author.
 *
 * A call from Codex (`clientName` is `codex-mcp-client`, or the call carries
 * Codex's turn metadata) that names its thread (`params._meta.threadId`) is
 * that thread's: the host session is the thread, whatever the environment says.
 */
export function fillInboxToolArguments(message: JsonRpc, cwd: string, own: string, hostSession?: InboxHostSession | null, clientName?: string | null): JsonRpc {
  if (message.method !== "tools/call" || !message.params) return message;
  const codexThread = codexThreadOfCall(message.params._meta, clientName);
  if (codexThread) hostSession = { host: INBOX_CODEX_HOST, session: codexThread, name: INBOX_CODEX_NAME };
  const name = message.params.name;
  if (typeof name !== "string") return message;
  if (PROJECT_ONLY_TOOLS.has(name)) {
    const args = { ...((message.params.arguments as Record<string, unknown> | undefined) ?? {}) };
    if (args.project_path === undefined && args.all_projects !== true) args.project_path = cwd;
    return { ...message, params: { ...message.params, arguments: args } };
  }
  if (!FILLED_TOOLS.has(name)) return message;
  const args = { ...((message.params.arguments as Record<string, unknown> | undefined) ?? {}) };
  if (args.project_path === undefined && args.reply_to === undefined) args.project_path = cwd;
  let wakes = false;
  if (args.agent_session === undefined) {
    if (hostSession && (args.agent_host === undefined || args.agent_host === hostSession.host)) {
      args.agent_session = hostSession.session;
      wakes = INBOX_RUNNER_HOSTS.has(hostSession.host);
      if (AUTHOR_TOOLS.has(name)) {
        args.agent_host = hostSession.host;
        if (args.agent_name === undefined) args.agent_name = hostSession.name;
      }
    } else {
      args.agent_session = own;
    }
  }
  // A session the Inbox runs: its replies come as turns (the shim's env names it; the agent cannot set that).
  const meta = wakes ? { _meta: { ...((message.params._meta as Record<string, unknown> | undefined) ?? {}), [INBOX_WAKES_META_KEY]: true } } : {};
  return { ...message, params: { ...message.params, ...meta, arguments: args } };
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
    const isRequest = message && typeof message === "object" && "id" in message && typeof message.method === "string";
    if (message?.method === "initialize") {
      const name = (message.params?.clientInfo as { name?: unknown } | undefined)?.name;
      if (typeof name === "string") clientName = name;
    }
    // Qwen's session is read again for each call: /clear and /resume change it under the same Qwen process.
    const callHost = message?.method === "tools/call" ? inboxCallHostSession(hostSession, options.qwen, message.params?._meta, clientName) : hostSession;
    const outgoing = fillInboxToolArguments(message, options.cwd, own, callHost, clientName);
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
