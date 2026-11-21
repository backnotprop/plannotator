/**
 * A FAKE ACP agent for tests and screenshots. Never a real agent: it reads a
 * script (FAKE_ACP_SCRIPT, a JSON file) and plays it. It speaks ACP v1 on
 * stdio through the SDK's agent side, starts the stdio MCP servers the client
 * hands it in `session/new` (the builder relay), and calls their tools like a
 * real agent would. Everything it receives is appended to FAKE_ACP_LOG.
 *
 * Run with bun: `bun tests/helpers/fake-acp-agent.ts` (FAKE_ACP_SCRIPT and FAKE_ACP_LOG set).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
  type Agent,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";

type Step =
  | { say: string }
  | { tool: { title: string; kind?: string; locations?: Array<{ path: string; line?: number }>; fail?: boolean; output?: string } }
  /** Call the client's `fs/read_text_file` and log the answer. */
  | { clientRead: { path: string; line?: number; limit?: number } }
  /**
   * Ask `session/request_permission`. `kind` defaults to "execute"; with
   * `kindOnlyInUpdate` the kind is sent only in the `tool_call` update before
   * the request (the request leaves it out). `options` replaces the usual
   * allow once / always allow / reject set. `name` is the programmatic tool name.
   */
  | { permission: { title: string; kind?: string; kindOnlyInUpdate?: boolean; options?: Array<{ optionId: string; name: string; kind: string }>; name?: string; writeOnAllow?: string } }
  /** Call the client's `fs/write_text_file` (the client must refuse it) and log the answer. */
  | { clientWrite: { path: string; content: string } }
  /** Call the client's `terminal/create` (the client must refuse it) and log the answer. */
  | { clientTerminal: { command: string } }
  /** Edit a file with the agent's own tool without asking (an agent whose settings allow it), then report it as a completed edit. */
  | { editWithoutAsking: { path: string; content: string } }
  /** Switch the session's mode by itself and report it (`current_mode_update`, or `config_option_update` with `via: "config"`). */
  | { modeUpdate: string; via?: "mode" | "config" }
  /**
   * Call a tool of the MCP server the client handed over. `server` names it in
   * the tool call's title (default `mcp__plannotator-guide__<name>`; with a
   * server, Grok Build's form `<server>__<name>`); `ask` asks permission for
   * it first, as Grok Build does even for an MCP tool. In `args`, the string
   * "$REPLY_TO" becomes the id the prompt's first line names (`(msg_…)`).
   */
  | { mcp: { name: string; args?: Record<string, unknown>; server?: string; ask?: boolean } }
  /** Send an extension notification (`_x.ai/...`), as Grok Build does; its params may carry secrets. */
  | { extNotify: { method: string; params: Record<string, unknown> } }
  | { usage: { cost: number } }
  | { plan: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> }
  | { sleep: number }
  | { exit: number }
  /** Fail the turn with ACP's authRequired error, as the real adapter does when Claude Code is signed out. */
  | { authRequired: true }
  /** Start a grandchild that ignores SIGTERM and log its pid (process-tree cleanup). */
  | { spawnStubborn: true };

interface Script {
  models?: Array<{ value: string; name: string }>;
  efforts?: Array<{ value: string; name: string }>;
  /** Fail session/new with this message (e.g. an auth error). */
  newSessionError?: string;
  steps: Step[];
  /** Delay between steps, ms. */
  pace?: number;
  /** Answer `initialize` with this protocol version instead of ours. */
  protocolVersion?: number;
  /**
   * Start the session in this permission mode, as the real adapter does from
   * the cwd's `.claude/settings*.json` `permissions.defaultMode`. Unset: the
   * fake advertises no modes at all.
   */
  startMode?: string;
  /** How the modes are advertised: a `mode` config option, `modes` on session/new, or both (the real adapter). */
  modeSurface?: "config" | "modes" | "both";
  /** Refuse every mode change (session/set_mode and the `mode` config option). */
  refuseModeChange?: boolean;
  /** Accept a mode change but stay in the start mode. */
  ignoreModeChange?: boolean;
  /** Accept the client's MCP servers but never start them (like pi-acp). */
  ignoreMcp?: boolean;
  /** The modes offered (default: Claude Code's four), e.g. another agent's read-only or plan mode. */
  modes?: Array<{ id: string; name: string }>;
  /** Advertise `loadSession` in `initialize` (default false). */
  loadSession?: boolean;
  /** Fail `session/load` with this message. */
  loadSessionError?: string;
  /**
   * What the agent does in an "ask" session (its MCP server offers
   * show_answer): one list of steps per prompt, the last one repeated.
   * Without it, `steps` is played.
   */
  askTurns?: Step[][];
  /** One list of steps per prompt in a session (counted across session/load), the last one repeated. Without it, `steps`. */
  turns?: Step[][];
  /** Advertise `session/close` (`sessionCapabilities.close`), as Grok Build does. */
  closeSession?: boolean;
}

const script: Script = JSON.parse(readFileSync(process.env.FAKE_ACP_SCRIPT ?? "", "utf8"));
const logPath = process.env.FAKE_ACP_LOG;
const log = (entry: Record<string, unknown>) => {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
};

class McpClient {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();
  constructor(private readonly child: ChildProcess) {
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        this.pending.get(msg.id)?.(msg);
        this.pending.delete(msg.id);
      }
    });
  }
  request(method: string, params: unknown): Promise<{ result?: any; error?: any }> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  notify(method: string, params?: unknown) {
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined && { params }) })}\n`);
  }
  close() {
    this.child.stdin!.end();
    this.child.kill();
  }
}

const models = script.models ?? [
  { value: "default", name: "Default (Opus)" },
  { value: "sonnet", name: "Sonnet" },
  { value: "haiku", name: "Haiku" },
];
const efforts = script.efforts ?? [
  { value: "low", name: "Low" },
  { value: "medium", name: "Medium" },
  { value: "high", name: "High" },
];

let currentModel = models[0].value;
let currentEffort = efforts[efforts.length - 1].value;
let currentMode = script.startMode;
const modeSurface = script.modeSurface ?? "both";
const availableModes = script.modes ?? [
  { id: "default", name: "Default" },
  { id: "acceptEdits", name: "Accept Edits" },
  { id: "plan", name: "Plan Mode" },
  { id: "bypassPermissions", name: "Bypass Permissions" },
];

function configOptions(): SessionConfigOption[] {
  return [
    ...(currentMode !== undefined && modeSurface !== "modes"
      ? [{ id: "mode", name: "Mode", category: "mode", type: "select", currentValue: currentMode, options: availableModes.map((m) => ({ value: m.id, name: m.name })) }]
      : []),
    { id: "model", name: "Model", category: "model", type: "select", currentValue: currentModel, options: models },
    { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: currentEffort, options: efforts },
  ] as SessionConfigOption[];
}

function setMode(mode: string): void {
  if (script.refuseModeChange) throw new Error("Mode change refused");
  if (!script.ignoreModeChange) currentMode = mode;
}

const sessions = new Map<string, { cwd: string; mcp: McpClient | null; cancelled: boolean; tools: string[]; turns: number }>();
/** Prompts per session id, kept across session/load (`turns`). */
const promptsBySession = new Map<string, number>();

/** Start the stdio MCP server the client handed over (the relay), as a real agent does. */
async function startMcp(servers: Array<unknown>): Promise<{ mcp: McpClient | null; tools: string[] }> {
  const server = servers[0] as { command?: string; args?: string[]; env?: Array<{ name: string; value: string }> } | undefined;
  if (!server?.command || script.ignoreMcp) return { mcp: null, tools: [] };
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const e of server.env ?? []) env[e.name] = e.value;
  const child = spawn(server.command, server.args ?? [], { env, stdio: ["pipe", "pipe", "inherit"] });
  const mcp = new McpClient(child);
  const init = await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-agent", version: "1" } });
  mcp.notify("notifications/initialized");
  const list = await mcp.request("tools/list", {});
  const tools = (list.result?.tools ?? []).map((t: { name: string }) => t.name);
  log({ event: "mcpReady", protocolVersion: init.result?.protocolVersion, tools, instructions: init.result?.instructions ?? null });
  return { mcp, tools };
}

const stream = ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

new AgentSideConnection((conn): Agent => ({
  async initialize(params) {
    // The variables that make the real adapters run the user's own CLI instead of their bundled one.
    const cliEnv = { CLAUDE_CODE_EXECUTABLE: process.env.CLAUDE_CODE_EXECUTABLE ?? null, CODEX_PATH: process.env.CODEX_PATH ?? null };
    log({ event: "initialize", pid: process.pid, clientCapabilities: params.clientCapabilities, clientInfo: params.clientInfo, cliEnv });
    // Like claude-agent-acp: terminal sign-ins only for a client that can run them.
    const authMethods = params.clientCapabilities?.auth?.terminal
      ? [{ id: "claude-ai-login", name: "Claude Subscription", type: "terminal" as const, args: ["--cli", "auth", "login", "--claudeai"] }]
      : [];
    return {
      protocolVersion: (script.protocolVersion ?? PROTOCOL_VERSION) as typeof PROTOCOL_VERSION,
      agentCapabilities: { loadSession: !!script.loadSession, ...(script.closeSession ? { sessionCapabilities: { close: {} } } : {}) } as never,
      authMethods,
    };
  },
  async authenticate() {
    return {};
  },
  async newSession(params) {
    log({ event: "newSession", cwd: params.cwd, mcpServers: params.mcpServers.map((s) => ({ name: s.name })), meta: params._meta ?? null });
    if (script.newSessionError) throw new Error(script.newSessionError);
    const sessionId = `fake-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const { mcp, tools } = await startMcp(params.mcpServers);
    sessions.set(sessionId, { cwd: params.cwd, mcp, cancelled: false, tools, turns: 0 });
    const modes = currentMode !== undefined && modeSurface !== "config" ? { currentModeId: currentMode, availableModes } : undefined;
    return { sessionId, configOptions: configOptions(), ...(modes && { modes }) };
  },
  async loadSession(params) {
    log({ event: "loadSession", sessionId: params.sessionId, cwd: params.cwd, mcpServers: params.mcpServers.map((s) => ({ name: s.name })) });
    if (script.loadSessionError) throw new Error(script.loadSessionError);
    // Replay the conversation, as session/load does: none of it is a new turn.
    await conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Write a guided review (replayed)" } } as never });
    await conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLAYED: the guide is saved." } } as never });
    await conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "replayed-1", title: "Read src/replayed.ts", kind: "read", status: "completed" } as never });
    await conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "usage_update", used: 1000, size: 200000, cost: { amount: 0.5, currency: "USD" } } as never });
    const { mcp, tools } = await startMcp(params.mcpServers);
    sessions.set(params.sessionId, { cwd: params.cwd, mcp, cancelled: false, tools, turns: 0 });
    return { configOptions: configOptions() };
  },
  async setSessionMode(params) {
    log({ event: "setMode", modeId: params.modeId });
    setMode(params.modeId);
    return {};
  },
  async setSessionConfigOption(params) {
    log({ event: "setConfig", configId: params.configId, value: params.value });
    if (params.configId === "mode") setMode(String(params.value));
    if (params.configId === "model") currentModel = String(params.value);
    if (params.configId === "effort") currentEffort = String(params.value);
    return { configOptions: configOptions() };
  },
  async prompt(params) {
    const session = sessions.get(params.sessionId)!;
    const text = params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
    log({ event: "prompt", pid: process.pid, sessionId: params.sessionId, text, model: currentModel, effort: currentEffort, mode: currentMode ?? null });
    const update = (u: Record<string, unknown>) => conn.sessionUpdate({ sessionId: params.sessionId, update: u as never });
    let toolNo = 0;
    session.cancelled = false;
    const asking = session.tools.includes("show_answer") && !!script.askTurns?.length;
    const prompted = promptsBySession.get(params.sessionId) ?? 0;
    promptsBySession.set(params.sessionId, prompted + 1);
    const steps = asking
      ? script.askTurns![Math.min(session.turns, script.askTurns!.length - 1)]
      : script.turns?.length
        ? script.turns[Math.min(prompted, script.turns.length - 1)]!
        : script.steps;
    session.turns++;
    // The id the prompt's first line names (`Plannotator Inbox: <subject> (msg_…)`), for "$REPLY_TO".
    const replyTo = /\((msg_[0-9A-Za-z]+)\)\s*$/m.exec(text.split("\n")[0] ?? "")?.[1] ?? null;
    const fill = (value: unknown): unknown =>
      value === "$REPLY_TO" ? replyTo : value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)])) : value;
    for (const step of steps) {
      if (session.cancelled) break;
      if (script.pace) await sleep(script.pace);
      if ("say" in step) {
        for (const word of step.say.split(/(?<= )/)) await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: word } });
      } else if ("tool" in step) {
        const toolCallId = `t${++toolNo}`;
        await update({ sessionUpdate: "tool_call", toolCallId, title: step.tool.title, kind: step.tool.kind ?? "read", status: "in_progress", locations: step.tool.locations?.map((l) => ({ path: l.path.startsWith("/") ? l.path : `${session.cwd}/${l.path}`, line: l.line })) });
        await update({ sessionUpdate: "tool_call_update", toolCallId, status: step.tool.fail ? "failed" : "completed", ...(step.tool.output && { content: [{ type: "content", content: { type: "text", text: step.tool.output } }] }) });
      } else if ("permission" in step) {
        const toolCallId = `t${++toolNo}`;
        const p = step.permission;
        const kind = p.kind ?? "execute";
        await update({ sessionUpdate: "tool_call", toolCallId, title: p.title, kind, status: "pending" });
        const answer = await conn.requestPermission({
          sessionId: params.sessionId,
          toolCall: { toolCallId, title: p.title, ...(!p.kindOnlyInUpdate && { kind }), ...(p.name && { name: p.name }), status: "pending" } as never,
          options: (p.options ?? [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ]) as never,
        });
        const allowed = answer.outcome.outcome === "selected" && /^allow/.test(answer.outcome.optionId);
        log({ event: "permission", title: p.title, kind, outcome: answer.outcome });
        if (allowed && p.writeOnAllow) writeFileSync(`${session.cwd}/${p.writeOnAllow}`, "written after an allow\n");
        await update({ sessionUpdate: "tool_call_update", toolCallId, status: allowed ? "completed" : "failed" });
      } else if ("clientRead" in step) {
        try {
          const res = await conn.readTextFile({ sessionId: params.sessionId, path: `${session.cwd}/${step.clientRead.path}`, ...(step.clientRead.line && { line: step.clientRead.line }), ...(step.clientRead.limit && { limit: step.clientRead.limit }) });
          log({ event: "clientRead", ok: true, content: res.content });
        } catch (err) {
          log({ event: "clientRead", ok: false, message: err instanceof Error ? err.message : String(err) });
        }
      } else if ("clientWrite" in step) {
        try {
          const res = await conn.writeTextFile({ sessionId: params.sessionId, path: `${session.cwd}/${step.clientWrite.path}`, content: step.clientWrite.content });
          log({ event: "clientWrite", ok: true, result: res ?? null });
        } catch (err) {
          log({ event: "clientWrite", ok: false, code: (err as { code?: number }).code ?? null, message: err instanceof Error ? err.message : String(err) });
        }
      } else if ("clientTerminal" in step) {
        try {
          const res = await conn.createTerminal({ sessionId: params.sessionId, command: step.clientTerminal.command });
          log({ event: "clientTerminal", ok: true, id: (res as { id?: string }).id ?? null });
        } catch (err) {
          log({ event: "clientTerminal", ok: false, code: (err as { code?: number }).code ?? null, message: err instanceof Error ? err.message : String(err) });
        }
      } else if ("modeUpdate" in step) {
        currentMode = step.modeUpdate;
        if (step.via === "config") await update({ sessionUpdate: "config_option_update", configOptions: configOptions() });
        else await update({ sessionUpdate: "current_mode_update", currentModeId: step.modeUpdate });
        log({ event: "modeUpdate", mode: step.modeUpdate });
        await sleep(300);
      } else if ("editWithoutAsking" in step) {
        const toolCallId = `t${++toolNo}`;
        const path = `${session.cwd}/${step.editWithoutAsking.path}`;
        await update({ sessionUpdate: "tool_call", toolCallId, title: `Edit ${step.editWithoutAsking.path}`, kind: "edit", status: "in_progress", locations: [{ path }] });
        writeFileSync(path, step.editWithoutAsking.content);
        await update({ sessionUpdate: "tool_call_update", toolCallId, status: "completed" });
        log({ event: "editedWithoutAsking", path });
        await sleep(300);
      } else if ("mcp" in step) {
        if (!session.mcp) throw new Error("no MCP server was given");
        const toolCallId = `t${++toolNo}`;
        // Like the real adapter: the builder call also shows as a tool call (the client folds it into the builder line).
        const title = step.mcp.server ? `${step.mcp.server}__${step.mcp.name}` : `mcp__plannotator-guide__${step.mcp.name}`;
        await update({ sessionUpdate: "tool_call", toolCallId, title, kind: "other", status: "in_progress" });
        if (step.mcp.ask) {
          // Grok Build asks permission even for an MCP tool.
          const answer = await conn.requestPermission({
            sessionId: params.sessionId,
            toolCall: { toolCallId, title, kind: "other", status: "pending" } as never,
            options: [
              { optionId: "always-allow", name: "always allow", kind: "allow_always" },
              { optionId: "allow-once", name: "allow once", kind: "allow_once" },
              { optionId: "reject-once", name: "reject once", kind: "reject_once" },
            ] as never,
          });
          log({ event: "mcpPermission", title, outcome: answer.outcome });
          if (answer.outcome.outcome !== "selected" || !/allow/.test(answer.outcome.optionId)) {
            await update({ sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
            continue;
          }
        }
        const res = await session.mcp.request("tools/call", { name: step.mcp.name, arguments: fill(step.mcp.args ?? {}) });
        const answerText = res.result?.content?.[0]?.text ?? JSON.stringify(res.error);
        log({ event: "mcpCall", name: step.mcp.name, isError: res.result?.isError ?? true, text: answerText });
        await update({ sessionUpdate: "tool_call_update", toolCallId, status: "completed" });
      } else if ("extNotify" in step) {
        await conn.extNotification(step.extNotify.method, step.extNotify.params);
        log({ event: "extNotify", method: step.extNotify.method });
      } else if ("usage" in step) {
        await update({ sessionUpdate: "usage_update", used: 1000, size: 200000, cost: { amount: step.usage.cost, currency: "USD" } });
      } else if ("plan" in step) {
        await update({ sessionUpdate: "plan", entries: step.plan.map((p) => ({ ...p, priority: "medium" })) });
      } else if ("sleep" in step) {
        await sleep(step.sleep);
      } else if ("exit" in step) {
        process.exit(step.exit);
      } else if ("authRequired" in step) {
        throw RequestError.authRequired(undefined, "Not logged in · Please run /login");
      } else if ("spawnStubborn" in step) {
        // Same process group as the agent (not detached), ignores SIGTERM like a stuck tool.
        const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
        await sleep(200);
        log({ event: "stubborn", pid: child.pid });
      }
    }
    if (session.cancelled) {
      log({ event: "cancelled" });
      return { stopReason: "cancelled" };
    }
    return { stopReason: "end_turn" };
  },
  async cancel(params) {
    log({ event: "cancel" });
    const s = sessions.get(params.sessionId);
    if (s) s.cancelled = true;
  },
  async closeSession(params) {
    log({ event: "closeSession", sessionId: params.sessionId });
    const s = sessions.get(params.sessionId);
    s?.mcp?.close();
    sessions.delete(params.sessionId);
    return {};
  },
}), stream);

process.on("SIGTERM", () => {
  for (const s of sessions.values()) s.mcp?.close();
  process.exit(0);
});
