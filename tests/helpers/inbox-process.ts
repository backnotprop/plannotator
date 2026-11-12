import "../setup/sandbox-data-dir";
import { spawnSync } from "node:child_process";
import { readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { accountHome, isScratchDataDir } from "./real-data-dir";

export function refuseRealHome(home: string | undefined, what: string): string {
  const value = home?.trim();
  if (!value || !isScratchDataDir(value) || resolve(value) === accountHome()) {
    throw new Error(`${what}: HOME must be a scratch folder, got ${value || "none (os.homedir() falls back to the account's home)"}`);
  }
  return value;
}

export interface InboxEntry {
  pid: number;
  port: number;
  serverSession: string;
}

export function readInboxEntry(file: string): InboxEntry | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<InboxEntry>;
    if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 1) return null;
    if (typeof value.port !== "number" || typeof value.serverSession !== "string") return null;
    return { pid: value.pid, port: value.port, serverSession: value.serverSession };
  } catch {
    return null;
  }
}

export function inboxEntryOf(dataDir: string): InboxEntry | null {
  if (!isScratchDataDir(dataDir)) throw new Error(`refusing to read ${dataDir}: not a scratch data dir (it may be a real Inbox)`);
  return readInboxEntry(join(dataDir, "inbox", "inbox.json"));
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function runsInbox(pid: number): boolean {
  const args = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "";
  return /(?:^|[\s/])(?:plannotator|index\.ts) inbox(?:\s|$)/.test(args) && !/ inbox mcp(?:\s|$)/.test(args);
}

async function health(port: number): Promise<{ pid: number; serverSession: string } | "nothing" | "other"> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/inbox/health`, { signal: AbortSignal.timeout(2000) });
    const body = (await response.json()) as { pid?: unknown; serverSession?: unknown };
    return typeof body.pid === "number" && typeof body.serverSession === "string" ? { pid: body.pid, serverSession: body.serverSession } : "other";
  } catch (error) {
    return error instanceof SyntaxError ? "other" : "nothing";
  }
}

function cwdOf(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, "");
  } catch {
  }
  const out = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" }).stdout ?? "";
  const line = out.split("\n").find((l) => l.startsWith("n"));
  return line ? line.slice(1).replace(/ \(deleted\)$/, "") : null;
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}${sep}`);

export async function provenInbox(entry: InboxEntry, root: string): Promise<boolean> {
  if (!isScratchDataDir(root)) return false;
  if (entry.pid === process.pid || !isAlive(entry.pid) || !runsInbox(entry.pid)) return false;
  const answer = await health(entry.port);
  if (answer === "other") return false;
  if (answer !== "nothing" && (answer.pid !== entry.pid || answer.serverSession !== entry.serverSession)) return false;
  const cwd = cwdOf(entry.pid);
  if (cwd === null) return answer !== "nothing";
  const realRoot = realOrResolved(root);
  return inside(cwd, realRoot) || inside(realOrResolved(cwd), realRoot);
}

export async function signalProvenInbox(entry: InboxEntry | null, root: string, signal: NodeJS.Signals): Promise<boolean> {
  if (!entry || !(await provenInbox(entry, root))) return false;
  try {
    process.kill(entry.pid, signal);
    return true;
  } catch {
    return false;
  }
}

export async function mustSignalInbox(entry: InboxEntry | null, root: string, signal: NodeJS.Signals): Promise<InboxEntry> {
  if (!entry) throw new Error(`no Inbox entry to ${signal}`);
  if (!(await signalProvenInbox(entry, root, signal))) {
    throw new Error(`pid ${entry.pid} is not provably the Inbox started under ${root}; not sending ${signal}`);
  }
  return entry;
}

export async function waitGone(pids: number[], ms: number): Promise<number[]> {
  const deadline = Date.now() + ms;
  let left = pids.filter(isAlive);
  while (left.length > 0 && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 100));
    left = left.filter(isAlive);
  }
  return left;
}

export async function stopProvenInboxes(
  targets: readonly { entry: InboxEntry; root: string }[],
  options: { graceMs?: number; signal?: "SIGTERM" | "SIGKILL" } = {},
): Promise<void> {
  const proven = new Map<number, { entry: InboxEntry; root: string }>();
  for (const target of targets) {
    if (!proven.has(target.entry.pid) && (await provenInbox(target.entry, target.root))) proven.set(target.entry.pid, target);
  }
  const pids = [...proven.keys()];
  const first = options.signal ?? "SIGTERM";
  for (const pid of pids) {
    try {
      process.kill(pid, first);
    } catch {
    }
  }
  if (first === "SIGTERM") {
    for (const pid of await waitGone(pids, options.graceMs ?? 5_000)) {
      const { entry, root } = proven.get(pid)!;
      if (!(await provenInbox(entry, root))) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
      }
    }
  }
  await waitGone(pids, 2_000);
}
