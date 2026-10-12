/**
 * Signalling an Inbox from a test, only once it is proven to be the Inbox that
 * test started. Every test and spec that stops, kills, pauses or resumes an
 * Inbox goes through here; `tests/never-touch-the-real-inbox.test.ts` fails on
 * a raw `process.kill(<registry pid>, <signal>)` anywhere else.
 *
 * A pid read from an `inbox/inbox.json` proves nothing: the file can outlive
 * its Inbox, the pid can be reused, and a test that read the wrong folder (or
 * ran without its data-dir sandbox) would name the person's own Inbox. So an
 * entry `{ pid, port, serverSession }` is proven for a scratch `root` when:
 *
 *  - the process is alive and its command line runs the Inbox
 *    (`.../plannotator inbox ...` or `... index.ts inbox ...`, never
 *    `inbox mcp`), and then either
 *  - `GET http://127.0.0.1:<port>/api/inbox/health` answers that entry's pid
 *    AND serverSession, or
 *  - nothing answers on the port (stopped with SIGSTOP, still starting, or
 *    shutting down) and the process's working directory is inside `root` (a
 *    detached Inbox runs in `<data dir>/inbox`).
 *
 * Anything else (a reused pid, another Inbox, the person's own) is never
 * signalled. Node-safe (no Bun APIs): the Playwright specs use it too.
 */
import "../setup/sandbox-data-dir";
import { spawnSync } from "node:child_process";
import { readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { isRealDataDir } from "./real-data-dir";

/** What an Inbox wrote about itself: enough to recognise it again. */
export interface InboxEntry {
  pid: number;
  port: number;
  serverSession: string;
}

/** The entry an `inbox.json` holds, or null when it is missing or malformed. */
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

/** The entry in `<dataDir>/inbox/inbox.json`. Refuses the real data directory outright. */
export function inboxEntryOf(dataDir: string): InboxEntry | null {
  if (isRealDataDir(dataDir)) throw new Error(`refusing to read the real Plannotator data directory: ${dataDir}`);
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

/** The command line runs the Inbox server, never `inbox mcp`. */
function runsInbox(pid: number): boolean {
  const args = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "";
  return /(?:^|[\s/])(?:plannotator|index\.ts) inbox(?:\s|$)/.test(args) && !/ inbox mcp(?:\s|$)/.test(args);
}

/** What the port says: the Inbox's own health answer, nothing (refused or no answer), or something else. */
async function health(port: number): Promise<{ pid: number; serverSession: string } | "nothing" | "other"> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/inbox/health`, { signal: AbortSignal.timeout(2000) });
    const body = (await response.json()) as { pid?: unknown; serverSession?: unknown };
    return typeof body.pid === "number" && typeof body.serverSession === "string" ? { pid: body.pid, serverSession: body.serverSession } : "other";
  } catch (error) {
    // A refused connection or a timeout is "nothing answers"; a page that is not JSON is someone else.
    return error instanceof SyntaxError ? "other" : "nothing";
  }
}

/** The process's working directory: /proc on Linux, `lsof` elsewhere; null when neither says. */
function cwdOf(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, "");
  } catch {
    // Not Linux, or gone.
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

/** This entry's process is the Inbox the scratch folder `root` started (see the header). */
export async function provenInbox(entry: InboxEntry, root: string): Promise<boolean> {
  if (entry.pid === process.pid || !isAlive(entry.pid) || !runsInbox(entry.pid)) return false;
  const answer = await health(entry.port);
  if (answer === "other") return false;
  if (answer !== "nothing") return answer.pid === entry.pid && answer.serverSession === entry.serverSession;
  const cwd = cwdOf(entry.pid);
  if (cwd === null) return false;
  const realRoot = realOrResolved(root);
  return inside(cwd, realRoot) || inside(realOrResolved(cwd), realRoot);
}

/**
 * Send `signal` to the entry's Inbox when it is proven for `root`. Returns
 * whether it was sent; a process that is already gone, or cannot be proven,
 * is left alone.
 */
export async function signalProvenInbox(entry: InboxEntry | null, root: string, signal: NodeJS.Signals): Promise<boolean> {
  if (!entry || !(await provenInbox(entry, root))) return false;
  try {
    process.kill(entry.pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Like `signalProvenInbox`, but a test that means to signal its own Inbox fails when it cannot. */
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

/**
 * Stop every proven Inbox among `targets`: SIGTERM (the clean stop takes a
 * tailnet mapping down), then SIGKILL what is still the same proven process
 * after `graceMs`. Signal `SIGKILL` straight away with `{ signal: "SIGKILL" }`.
 */
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
      // Already gone.
    }
  }
  if (first === "SIGTERM") {
    for (const pid of await waitGone(pids, options.graceMs ?? 5_000)) {
      // Proven again, so a pid reused meanwhile is never killed.
      const { entry, root } = proven.get(pid)!;
      if (!(await provenInbox(entry, root))) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Gone meanwhile.
      }
    }
  }
  await waitGone(pids, 2_000);
}
