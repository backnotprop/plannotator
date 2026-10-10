import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, openSync, closeSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import * as z from "zod";
import { connectionKey, privateWrite, T3Credentials } from "./auth";
import { T3Client, T3Thread, pause } from "./t3-client";
import { T3SessionBridge } from "./session-bridge";
import { T3Delivery } from "./delivery";
import { T3Reviews } from "./reviews";

export interface AdapterOptions { endpoint: URL; dataDir: string; command: readonly string[]; workerCommand: readonly string[] }
export interface ToolAnswer { text: string; isError: boolean }
const registrySchema = z.object({ endpoint: z.string(), thread: z.string(), pid: z.number().int().positive(), port: z.number().int().min(1).max(65535), token: z.string().min(32) });
type Registry = z.infer<typeof registrySchema>;

export function daemonDirectory(options: AdapterOptions, thread: string): string {
  return join(options.dataDir, "t3-code", connectionKey(options.endpoint), "threads", connectionKey(options.endpoint, thread));
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readRegistry(options: AdapterOptions, thread: string): Registry | undefined {
  try {
    const registry = registrySchema.parse(JSON.parse(readFileSync(join(daemonDirectory(options, thread), "daemon.json"), "utf8")) as unknown);
    return registry.endpoint === options.endpoint.href && registry.thread === thread ? registry : undefined;
  } catch { return undefined; }
}

async function request(registry: Registry, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${registry.port}${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${registry.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(path === "/review" ? 65_000 : 2000) });
  if (!response.ok) throw new Error(`T3 companion refused ${path} (${response.status}).`);
  return response.json();
}

async function healthy(registry: Registry | undefined): Promise<boolean> {
  if (!registry || !alive(registry.pid)) return false;
  try {
    const result = await request(registry, "/health") as Registry;
    return result.pid === registry.pid && result.endpoint === registry.endpoint && result.thread === registry.thread;
  } catch { return false; }
}

export async function callDaemon(options: AdapterOptions, thread: string, input: unknown): Promise<ToolAnswer> {
  new T3Thread({ call: async () => undefined }, thread);
  const directory = daemonDirectory(options, thread);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let registry = readRegistry(options, thread);
  if (!await healthy(registry)) {
    const lock = join(directory, "starting");
    const deadline = Date.now() + 35_000;
    let ownsLock = false;
    while (!ownsLock && Date.now() < deadline) {
      try { mkdirSync(lock, { mode: 0o700 }); privateWrite(join(lock, "owner.json"), { pid: process.pid, at: Date.now() }); ownsLock = true; }
      catch {
        try {
          const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")) as { pid: number; at: number };
          if (!alive(owner.pid)) { rmSync(lock, { recursive: true }); continue; }
        } catch { /* The other starter may still be writing its owner. */ }
        registry = readRegistry(options, thread);
        if (await healthy(registry)) break;
        await pause(100);
      }
    }
    if (ownsLock) {
      try {
        registry = readRegistry(options, thread);
        if (!await healthy(registry)) {
          const log = openSync(join(directory, "daemon.log"), "a", 0o600);
          try {
            const [executable, ...prefix] = options.workerCommand;
            const cliOverride = options.command.length === 1 ? ["--plannotator", options.command[0]!] : [];
            const child = spawn(executable!, [...prefix, "serve", "--url", options.endpoint.href, "--thread", thread, "--data-dir", options.dataDir, ...cliOverride], { detached: true, stdio: ["ignore", log, log] });
            let failure: Error | undefined;
            child.once("error", (error) => { failure = error; });
            child.unref();
            while (Date.now() < deadline) {
              if (failure || child.exitCode !== null) throw failure ?? new Error(`T3 companion failed to start. See ${join(directory, "daemon.log")}`);
              registry = readRegistry(options, thread);
              if (await healthy(registry)) break;
              await pause(100);
            }
          } finally { closeSync(log); }
        }
      } finally { rmSync(lock, { recursive: true, force: true }); }
    }
    if (!await healthy(registry)) throw new Error(`T3 companion did not start. See ${join(directory, "daemon.log")}`);
  }
  return await request(registry!, "/review", input) as ToolAnswer;
}

export async function daemonStatus(options: AdapterOptions, thread: string, stop = false): Promise<unknown> {
  const registry = readRegistry(options, thread);
  if (!await healthy(registry)) return { running: false };
  return request(registry!, stop ? "/stop" : "/health", stop ? {} : undefined);
}

export async function serveDaemon(options: AdapterOptions, threadId: string): Promise<void> {
  const directory = daemonDirectory(options, threadId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, "running");
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch {
    const existing = readRegistry(options, threadId);
    if (await healthy(existing)) return;
    if (existing && alive(existing.pid)) throw new Error("A T3 companion is still starting or unresponsive. Check its log before restarting.");
    rmSync(lock, { recursive: true });
    mkdirSync(lock, { mode: 0o700 });
  }
  let cleanup: (() => void) | undefined;
  try {
    const credentials = new T3Credentials(options.dataDir, options.endpoint);
    if (!credentials.token()) throw new Error("Run plannotator t3 login before opening a connected review.");
    const client = await T3Client.connect(options.endpoint, credentials.token);
    const thread = new T3Thread(client, threadId);
    const snapshot = await thread.read({ limit: 1 });
    if (snapshot.thread.archived) { await client.close(); throw new Error("The selected T3 thread is archived."); }
    const project = z.object({ workspaceRoot: z.string() }).parse(await client.call("t3_project_read", { projectId: snapshot.thread.projectId }));
    const cwd = snapshot.thread.worktreePath ?? project.workspaceRoot;
    if (!isAbsolute(cwd) || !existsSync(cwd)) { await client.close(); throw new Error("Run the companion on the T3 environment's machine; its project/worktree is not accessible here."); }
    const bridge = new T3SessionBridge(thread);
    await bridge.refresh();
    const delivery = new T3Delivery(thread, credentials);
    const reviews = new T3Reviews(join(directory, "reviews"), options.command, cwd, options.dataDir, bridge, delivery);
    const token = randomBytes(32).toString("base64url");
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 2_000_000,
      async fetch(request) {
        const url = new URL(request.url);
        const supplied = request.headers.get("authorization") ?? "";
        const expected = `Bearer ${token}`;
        const authenticated = supplied.length === expected.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
        if (!authenticated || request.headers.has("origin") || url.host !== `127.0.0.1:${server.port}`) return new Response("Forbidden", { status: 403 });
        if (url.pathname === "/health" && request.method === "GET") return Response.json({ running: true, endpoint: options.endpoint.href, thread: threadId, pid: process.pid, status: bridge.status() });
        if (url.pathname === "/stop" && request.method === "POST") { setTimeout(() => { cleanup?.(); process.exit(0); }, 100); return Response.json({ stopped: true, reviews: "Reviews remain open and can be recovered when a CLI command reconnects." }); }
        if (url.pathname !== "/review" || request.method !== "POST") return new Response("Not found", { status: 404 });
        try {
          const input: unknown = await request.json();
          const current = await thread.read({ limit: 1 });
          if (current.thread.archived || current.thread.projectId !== snapshot.thread.projectId || (current.thread.worktreePath ?? project.workspaceRoot) !== cwd) throw new Error("This T3 thread was archived or changed worktrees. Restart its companion.");
          const answer = { text: await reviews.call(input), isError: false };
          return Response.json(answer);
        } catch (error) { return Response.json({ text: error instanceof Error ? error.message : String(error), isError: true }); }
      },
    });
    privateWrite(join(directory, "daemon.json"), { endpoint: options.endpoint.href, thread: threadId, port: server.port, token, pid: process.pid });
    const timer = setInterval(() => { void bridge.refresh(); }, 5000);
    cleanup = () => { clearInterval(timer); reviews.dispose(); bridge.dispose(); server.stop(true); void client.close(); rmSync(join(directory, "daemon.json"), { force: true }); rmSync(lock, { recursive: true, force: true }); };
    process.once("SIGTERM", () => { cleanup?.(); process.exit(0); });
    process.once("SIGINT", () => { cleanup?.(); process.exit(0); });
    reviews.start();
    console.error(`Plannotator connected to T3 thread ${threadId}.`);
    await new Promise<void>(() => {});
  } catch (error) { cleanup?.(); rmSync(lock, { recursive: true, force: true }); throw error; }
}
