/**
 * The opt-in T3 Code connection's per-thread workers, as uninstall and
 * `plannotator t3 logout` see them: each running worker leaves
 * `<data dir>/t3-code/<endpoint>/threads/<thread>/daemon.json`
 * (`{ endpoint, thread, pid, port, token }`, mode 0600) while it listens.
 * A worker is stopped only through its own token-guarded `/stop` route, after
 * its `/health` names the same pid, endpoint and thread; nothing is ever
 * signalled by a pid read from a file.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface T3WorkerEntry { endpoint: string; thread: string; pid: number; port: number; token: string; directory: string }

function isEntry(value: unknown): value is Omit<T3WorkerEntry, "directory"> {
  const v = value as Record<string, unknown> | null;
  return !!v && typeof v.endpoint === "string" && typeof v.thread === "string" && Number.isInteger(v.pid) && (v.pid as number) > 0
    && Number.isInteger(v.port) && (v.port as number) > 0 && (v.port as number) < 65536 && typeof v.token === "string" && v.token.length >= 32;
}

/** Every worker registry under the data dir (running or left behind by a crash). */
export function listT3Workers(dataDir: string): T3WorkerEntry[] {
  const root = join(dataDir, "t3-code");
  if (!existsSync(root)) return [];
  const entries: T3WorkerEntry[] = [];
  for (const endpoint of safeReaddir(root)) {
    const threads = join(root, endpoint, "threads");
    for (const thread of safeReaddir(threads)) {
      const directory = join(threads, thread);
      try {
        const value: unknown = JSON.parse(readFileSync(join(directory, "daemon.json"), "utf8"));
        if (isEntry(value)) entries.push({ ...value, directory });
      } catch { /* No registry: no worker listening there. */ }
    }
  }
  return entries;
}

function safeReaddir(path: string): string[] {
  try { return readdirSync(path); } catch { return []; }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as { code?: string }).code === "EPERM"; }
}

async function workerAnswers(entry: T3WorkerEntry): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${entry.port}/health`, {
      headers: { authorization: `Bearer ${entry.token}` }, signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return false;
    const body = await response.json() as Record<string, unknown>;
    return body.pid === entry.pid && body.endpoint === entry.endpoint && body.thread === entry.thread;
  } catch { return false; }
}

export type T3WorkerStop = { entry: T3WorkerEntry; state: "stopped" | "not_running" | "still_running" };

/** Stop the running workers (optionally only one endpoint's). Reviews stay open. */
export async function stopT3Workers(dataDir: string, endpoint?: string): Promise<T3WorkerStop[]> {
  const results: T3WorkerStop[] = [];
  for (const entry of listT3Workers(dataDir)) {
    if (endpoint !== undefined && entry.endpoint !== endpoint) continue;
    if (!await workerAnswers(entry)) { results.push({ entry, state: "not_running" }); continue; }
    try {
      await fetch(`http://127.0.0.1:${entry.port}/stop`, {
        method: "POST", headers: { authorization: `Bearer ${entry.token}`, "content-type": "application/json" },
        body: "{}", signal: AbortSignal.timeout(2000),
      });
    } catch { /* It may close the connection while it exits. */ }
    const deadline = Date.now() + 5000;
    while (alive(entry.pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    results.push({ entry, state: alive(entry.pid) && await workerAnswers(entry) ? "still_running" : "stopped" });
  }
  return results;
}

/** What `stopT3Workers` would stop, for a dry run. */
export async function runningT3Workers(dataDir: string): Promise<T3WorkerEntry[]> {
  const running: T3WorkerEntry[] = [];
  for (const entry of listT3Workers(dataDir)) if (await workerAnswers(entry)) running.push(entry);
  return running;
}
