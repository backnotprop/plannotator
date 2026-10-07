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
 * `agent_session` (one `ses_` id per shim process, so `asked_by: "me"` and a
 * thread-less `wait_for_reply` mean this agent session).
 *
 * stdout carries JSON-RPC only; anything else goes to stderr.
 */

import { inboxId } from "@plannotator/core/inbox-types";
import { inboxStatus, type InboxRegistryEntry } from "@plannotator/shared/inbox/registry";

const FILLED_TOOLS = new Set(["send_message", "read_thread", "wait_for_reply"]);
/** The 2026-07-28 per-request envelope's protocol-version key. */
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";

export interface InboxMcpShimOptions {
  dataDir: string;
  cwd: string;
  ensureRunning: () => Promise<InboxRegistryEntry>;
  /** Default: process stdin / stdout. */
  input?: ReadableStream<Uint8Array>;
  write?: (line: string) => void;
}

type JsonRpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> };

function rpcError(id: string | number | null | undefined, message: string, code = -32603): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

/** Fill `project_path` and `agent_session` on the Inbox's tools when absent. */
export function fillInboxToolArguments(message: JsonRpc, cwd: string, session: string): JsonRpc {
  if (message.method !== "tools/call" || !message.params) return message;
  const name = message.params.name;
  if (typeof name !== "string" || !FILLED_TOOLS.has(name)) return message;
  const args = { ...((message.params.arguments as Record<string, unknown> | undefined) ?? {}) };
  if (args.project_path === undefined && args.reply_to === undefined) args.project_path = cwd;
  if (args.agent_session === undefined) args.agent_session = session;
  return { ...message, params: { ...message.params, arguments: args } };
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
  const session = inboxId("ses");
  const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  let negotiatedVersion: string | null = null;

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
    const outgoing = fillInboxToolArguments(message, options.cwd, session);
    let target: InboxRegistryEntry;
    try {
      target = await entry();
    } catch (error) {
      if (isRequest) write(rpcError(message.id, `Plannotator Inbox is not running: ${error instanceof Error ? error.message : String(error)}`));
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
        body: JSON.stringify(outgoing),
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
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        const reply = item as JsonRpc;
        if (outgoing.method === "initialize" && typeof reply?.result?.protocolVersion === "string") {
          negotiatedVersion = reply.result.protocolVersion as string;
        }
        write(JSON.stringify(item));
        wrote = true;
      }
    }
    if (!wrote && isRequest) write(rpcError(message.id, `Plannotator Inbox answered HTTP ${response.status}.`));
  };

  const input = options.input ?? (Bun.stdin.stream() as ReadableStream<Uint8Array>);
  const decoder = new TextDecoder();
  const inFlight = new Set<Promise<void>>();
  let buffer = "";
  const dispatch = (line: string) => {
    if (!line.trim()) return;
    const task = forward(line).catch((error) => {
      process.stderr.write(`[plannotator inbox mcp] ${error instanceof Error ? error.message : String(error)}\n`);
    });
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
  };
  for await (const chunk of input) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      dispatch(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  }
  dispatch(buffer + decoder.decode());
  await Promise.all([...inFlight]);
}
