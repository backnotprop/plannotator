import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { INBOX_HOST_NAMES } from "@plannotator/core/inbox-types";
import { INBOX_TOOL_HOSTS, loadConfig, resolveInboxTool, type InboxToolHost } from "@plannotator/shared/config";
import { discoverInboxTools, InboxAgentConnection, inboxRegistryFileOf, InboxWake } from "@plannotator/shared/inbox/agent-link";
import { inboxAgentTool, type InboxToolInfo } from "@plannotator/shared/inbox/connection";

export const INBOX_CONNECTION_HOSTS: readonly InboxToolHost[] = INBOX_TOOL_HOSTS.filter((host) => host !== "claude-code");

export const INBOX_CONNECTION_USAGE = [
  "Usage:",
  "  plannotator inbox connection --host <host> [--plugin-version <version>] [--no-wake]",
  "",
  "The Inbox connection for an agent plugin written in another language (the Hermes",
  "Agent plugin): one process per agent process, speaking JSON lines. Each line on",
  "stdin is one request; each line on stdout is one event. Nothing else is printed.",
  "It ends when stdin closes.",
  "",
  `  --host <host>             The agent host it signs as: ${INBOX_CONNECTION_HOSTS.join(", ")}.`,
  "  --plugin-version <v>      The plugin's version, shown in Settings → Agents.",
  "  --no-wake                 The plugin cannot put a reply into a session: the tool",
  "                            says so, and replies wait in the Inbox.",
  "",
  "First line out:",
  '  {"type":"ready","tool":{"name","description","parameters"}} the tool to register,',
  '  or {"type":"ready","tool":null,"why":"..."} when the host has no Inbox tool',
  "  (its switch is off, or the Inbox never ran on this computer).",
  "",
  "Requests (stdin):",
  '  {"type":"call","id":1,"session":"<id>","cwd":"<folder>","input":{...},"wakes":true}',
  '      one tool call by that session; answered by {"type":"result","id":1,"text","is_error"}',
  '  {"type":"open","session":"<id>","cwd":"<folder>"}',
  "      replies to that session wake it from now on (it is listed as live)",
  '  {"type":"state","session":"<id>","busy":true|false}   a turn started or ended',
  '  {"type":"delivered","session":"<id>","id":"<reply id>"}',
  '  {"type":"failed","session":"<id>","id":"<reply id>","why":"..."}',
  "      the answer to one deliver event",
  '  {"type":"close","session":"<id>"}   the session ended',
  "",
  "Events (stdout):",
  '  {"type":"deliver","session":"<id>","id":"<reply id>","text":"..."}',
  "      put text into that session as the person's next turn once it is idle, then",
  "      answer delivered or failed. Each reply is handed out once.",
  '  {"type":"notify","session":"<id>","text":"..."}   a line for the person, not the model',
].join("\n");

export const INBOX_CONNECTION_DELIVER_WAIT_MS = 30_000;
export const INBOX_CONNECTION_DISCOVER_TIMEOUT_MS = 1_500;

export interface InboxConnectionDeps {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  lines: AsyncIterable<string>;
  write: (line: string) => void;
  discover?: (dataDir: string) => Promise<InboxToolInfo[] | null>;
  tickMs?: number;
  deliverWaitMs?: number;
}

interface Options {
  host: InboxToolHost;
  version: string | null;
  wakes: boolean;
}

function parseOptions(argv: readonly string[]): Options | string {
  let host: string | null = null;
  let version: string | null = null;
  let wakes = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--host" || arg === "--plugin-version") {
      const value = argv[++i];
      if (!value) return `${arg} takes a value.`;
      if (arg === "--host") host = value;
      else version = value;
    } else if (arg === "--no-wake") wakes = false;
    else return `Unknown inbox connection option: ${arg}`;
  }
  if (!host) return "--host is required.";
  if (!(INBOX_CONNECTION_HOSTS as readonly string[]).includes(host)) return `--host takes one of ${INBOX_CONNECTION_HOSTS.join(", ")}, not ${host}.`;
  return { host: host as InboxToolHost, version, wakes };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

export async function runInboxConnectionCommand(argv: readonly string[], deps: InboxConnectionDeps): Promise<number> {
  const options = parseOptions(argv);
  if (typeof options === "string") {
    process.stderr.write(`${options}\n${INBOX_CONNECTION_USAGE}\n`);
    return 2;
  }
  const send = (event: Record<string, unknown>) => deps.write(`${JSON.stringify(event)}\n`);
  const offWhy = !resolveInboxTool(loadConfig(), deps.env, options.host)
    ? `The Inbox tool is off for ${INBOX_HOST_NAMES[options.host]}: turn it on in the Inbox's Settings → Agents.`
    : !existsSync(inboxRegistryFileOf(deps.dataDir))
      ? "The Inbox has never run on this computer: start it once with plannotator inbox."
      : null;
  const tools = offWhy ? null : await (deps.discover ?? ((dir) => discoverInboxTools(dir, { timeoutMs: INBOX_CONNECTION_DISCOVER_TIMEOUT_MS })))(deps.dataDir).catch(() => null);
  const spec = tools ? inboxAgentTool(tools, { wakes: options.wakes }) : null;
  if (!tools || !spec) {
    send({ type: "ready", tool: null, why: offWhy ?? "The Inbox's tools are not known yet: start it once with plannotator inbox." });
    for await (const _line of deps.lines) continue;
    return 0;
  }
  send({ type: "ready", tool: { name: spec.name, description: spec.description, parameters: spec.inputSchema } });

  const connection = new InboxAgentConnection({ dataDir: deps.dataDir, host: options.host, agentName: INBOX_HOST_NAMES[options.host]!, tools });
  const sessions = new Map<string, { wake: InboxWake; cwd: string; busy: boolean }>();
  const waiting = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  const open = (session: string, cwd: string) => {
    const known = sessions.get(session);
    if (known) {
      known.cwd = cwd || known.cwd;
      known.wake.touch();
      return;
    }
    const entry = { cwd, busy: false, wake: null as unknown as InboxWake };
    entry.wake = new InboxWake(
      connection,
      session,
      {
        isBusy: () => entry.busy,
        deliver: (wakeText, command) =>
          new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              waiting.delete(`${session}\n${command.id}`);
              reject(new Error(`${INBOX_HOST_NAMES[options.host]} did not take it within ${(deps.deliverWaitMs ?? INBOX_CONNECTION_DELIVER_WAIT_MS) / 1000} s`));
            }, deps.deliverWaitMs ?? INBOX_CONNECTION_DELIVER_WAIT_MS);
            waiting.set(`${session}\n${command.id}`, { resolve, reject, timer });
            send({ type: "deliver", session, id: command.id, text: wakeText });
          }),
        notify: (message) => send({ type: "notify", session, text: message }),
        projectPath: () => entry.cwd || null,
        pluginVersion: () => options.version,
      },
      deps.tickMs,
    );
    sessions.set(session, entry);
    entry.wake.start();
  };

  const settle = (key: string, why: string | null) => {
    const pending = waiting.get(key);
    if (!pending) return;
    waiting.delete(key);
    clearTimeout(pending.timer);
    if (why === null) pending.resolve();
    else pending.reject(new Error(why));
  };

  const call = async (request: Record<string, unknown>) => {
    const session = text(request.session);
    const result = session
      ? await connection.callTool(request.input ?? {}, { sessionId: session, cwd: text(request.cwd) ?? process.cwd(), wakes: options.wakes && request.wakes === true })
      : { text: "No session: the call names none.", isError: true };
    if (session) sessions.get(session)?.wake.touch();
    send({ type: "result", id: request.id ?? null, text: result.text, is_error: result.isError });
  };

  const calls = new Set<Promise<void>>();
  for await (const line of deps.lines) {
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!request || typeof request !== "object") continue;
    const session = text(request.session);
    if (request.type === "call") {
      const running = call(request).catch((error) => send({ type: "result", id: request.id ?? null, text: String(error), is_error: true }));
      calls.add(running);
      void running.finally(() => calls.delete(running));
    } else if (request.type === "open" && session && options.wakes) open(session, text(request.cwd) ?? "");
    else if (request.type === "state" && session) {
      const entry = sessions.get(session);
      if (entry) entry.busy = request.busy === true;
    } else if (request.type === "delivered" && session && text(request.id)) settle(`${session}\n${request.id}`, null);
    else if (request.type === "failed" && session && text(request.id)) settle(`${session}\n${request.id}`, text(request.why) ?? "it could not be put into the session");
    else if (request.type === "close" && session) {
      sessions.get(session)?.wake.dispose();
      sessions.delete(session);
    }
  }
  for (const entry of sessions.values()) entry.wake.dispose();
  for (const key of [...waiting.keys()]) settle(key, "the agent closed the connection");
  await Promise.allSettled([...calls]);
  return 0;
}

export function stdinLines(): AsyncIterable<string> {
  return createInterface({ input: process.stdin, crlfDelay: Infinity });
}
