/**
 * The compiled binary's Inbox in a scratch HOME and data dir, for the SQLite proof (`run.ts`): start it in the
 * foreground (`plannotator inbox --no-open`, so this script holds the process and can kill it), wait until it
 * answers, talk to it as an agent does (MCP `send_message` / `read_thread`) and as the window does (HTTP), stop it.
 *
 * Never the person's Inbox: every data dir and HOME is a new temp folder, the env names it, and the only process
 * ever signalled is one this script spawned (the `proc` it holds).
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { NO_BROWSER } from "../../tests/helpers/no-browser";

export const isWindows = process.platform === "win32";

export interface Sandbox {
  root: string;
  home: string;
  dataDir: string;
  inbox: string;
  project: string;
}

export function sandbox(name: string): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `plannotator-sqlite-proof-${name}-`)));
  const home = join(root, "home");
  const dataDir = join(root, "data");
  const project = join(root, "refund-service");
  for (const dir of [home, dataDir, project]) mkdirSync(dir, { recursive: true });
  return { root, home, dataDir, inbox: join(dataDir, "inbox"), project };
}

/** The env every process of a sandbox runs with: its own HOME and data dir, no browser, nothing reaching out. */
export function envOf(s: Sandbox, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("PLANNOTATOR_")) env[key] = value;
  return {
    ...env,
    HOME: s.home,
    USERPROFILE: s.home,
    TMPDIR: tmpdir(),
    PLANNOTATOR_DATA_DIR: s.dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    BROWSER: NO_BROWSER,
    PLANNOTATOR_TEST_SANDBOX: "1",
    PLANNOTATOR_INBOX_DEBUG: "1",
    PLANNOTATOR_INBOX_CONNECT: "0",
    PLANNOTATOR_INBOX_PHONES: "0",
    PLANNOTATOR_UPDATE_CHECK: "0",
    PLANNOTATOR_UPDATE_API_URL: "http://127.0.0.1:9/releases/latest",
    PLANNOTATOR_RELAY_URL: "http://127.0.0.1:9",
    PLANNOTATOR_FEEDBACK_URL: "http://127.0.0.1:9/feedback",
    PLANNOTATOR_INSTALL_SCRIPT_URL: "http://127.0.0.1:9/install.sh",
    PLANNOTATOR_RELEASE_DOWNLOAD_URL: "http://127.0.0.1:9/download",
    ...extra,
  };
}

export interface Running {
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  base: string;
  /** Everything the Inbox wrote to stderr so far. */
  stderr: () => string;
  ms: number;
}

export type Started = ({ ok: true } & Running) | { ok: false; code: number | null; stderr: string; ms: number };

/** `plannotator inbox --no-open` in the foreground; resolves once it answers health as itself, or once it exits. */
export async function serve(binary: string, s: Sandbox, extra: Record<string, string> = {}, timeoutMs = 180_000): Promise<Started> {
  const at = performance.now();
  const proc = Bun.spawn([binary, "inbox", "--no-open"], { cwd: s.root, env: envOf(s, extra), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let err = "";
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of proc.stderr) err += decoder.decode(chunk);
  })();
  void (async () => {
    for await (const _ of proc.stdout) {
      // Drained so the Inbox never blocks on a full pipe.
    }
  })();
  let exited = false;
  void proc.exited.then(() => (exited = true));
  while (performance.now() - at < timeoutMs) {
    if (exited) return { ok: false, code: proc.exitCode, stderr: err, ms: performance.now() - at };
    const entry = registryOf(s);
    if (entry && entry.pid === proc.pid) {
      try {
        const health = (await (await fetch(`http://127.0.0.1:${entry.port}/api/inbox/health`)).json()) as { pid?: number };
        if (health.pid === proc.pid) return { ok: true, proc, base: `http://127.0.0.1:${entry.port}`, stderr: () => err, ms: performance.now() - at };
      } catch {
        // Not listening yet.
      }
    }
    await Bun.sleep(50);
  }
  hardKill(proc);
  throw new Error(`the Inbox did not answer within ${timeoutMs} ms; stderr:\n${err}`);
}

export function registryOf(s: Sandbox): { pid: number; port: number } | null {
  try {
    const value = JSON.parse(readFileSync(join(s.inbox, "inbox.json"), "utf8")) as { pid?: number; port?: number };
    return typeof value.pid === "number" && typeof value.port === "number" ? { pid: value.pid, port: value.port } : null;
  } catch {
    return null;
  }
}

/**
 * A crash: the process ends with no chance to clean up. POSIX: SIGKILL. Windows: `taskkill /F` on that one pid
 * (TerminateProcess, the same as Task Manager's End task); without `/T`, so a child it started (the move's second
 * process) is left to notice on its own, as after a real crash.
 */
export function hardKill(proc: Bun.Subprocess): void {
  if (isWindows) Bun.spawnSync(["taskkill", "/F", "/PID", String(proc.pid)], { stdout: "ignore", stderr: "ignore" }); // inbox-guard: own child
  else proc.kill("SIGKILL"); // inbox-guard: own child
}

/** `plannotator inbox stop` (asked, as the person would), then the process must be gone. */
export async function stop(binary: string, s: Sandbox, running: Running): Promise<void> {
  const run = Bun.spawnSync([binary, "inbox", "stop"], { cwd: s.root, env: envOf(s), stdout: "pipe", stderr: "pipe" });
  const ended = await Promise.race([running.proc.exited.then(() => true), Bun.sleep(30_000).then(() => false)]);
  if (!ended) {
    hardKill(running.proc);
    throw new Error(`inbox stop left the Inbox running (exit ${run.exitCode}): ${run.stderr.toString()}`);
  }
}

export interface Agent {
  send(body: string): Promise<{ thread_id: string; message_id: string }>;
  thread(threadId: string): Promise<{ id: string; body: string }[]>;
  close(): Promise<void>;
}

/** An agent session on the running Inbox, through its MCP door, as every agent host talks to it. */
export async function agentOn(running: Running, s: Sandbox, session = "ses_sqlite_proof"): Promise<Agent> {
  const client = new Client({ name: "inbox-sqlite-proof", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${running.base}/mcp`)));
  return {
    send: async (body) =>
      (
        (await client.callTool({
          name: "send_message",
          arguments: { project_path: s.project, agent_session: session, agent_name: "Claude Code", agent_host: "claude-code", body },
        })) as { structuredContent: { thread_id: string; message_id: string } }
      ).structuredContent,
    thread: async (threadId) =>
      (
        (await client.callTool({ name: "read_thread", arguments: { thread_id: threadId, agent_session: session } })) as {
          structuredContent: { thread: { messages: { id: string; body: string }[] } };
        }
      ).structuredContent.thread.messages.map((m) => ({ id: m.id, body: m.body })),
    close: () => client.close(),
  };
}

export async function getJson<T = Record<string, unknown>>(running: Running, path: string): Promise<T> {
  const response = await fetch(`${running.base}${path}`);
  if (!response.ok) throw new Error(`GET ${path}: ${response.status}`);
  return (await response.json()) as T;
}

/** The debug log's server notes of one kind, oldest first. */
export function notes(s: Sandbox, ev: string): Record<string, unknown>[] {
  let text = "";
  try {
    text = readFileSync(join(s.inbox, "debug.log"), "utf8");
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const raw of text.split("\n")) {
    try {
      const line = JSON.parse(raw) as Record<string, unknown>;
      if (line.ev === ev) out.push(line);
    } catch {
      // A line cut by a kill.
    }
  }
  return out;
}

/** The CLI, run to the end. */
export function cli(binary: string, s: Sandbox, args: string[], extra: Record<string, string> = {}): { code: number; out: string; err: string; ms: number } {
  const at = performance.now();
  const run = Bun.spawnSync([binary, ...args], { cwd: s.root, env: envOf(s, extra), stdout: "pipe", stderr: "pipe" });
  return { code: run.exitCode ?? -1, out: run.stdout.toString(), err: run.stderr.toString(), ms: performance.now() - at };
}

export function check(ok: unknown, what: string): asserts ok {
  if (!ok) throw new Error(`FAILED: ${what}`);
}
