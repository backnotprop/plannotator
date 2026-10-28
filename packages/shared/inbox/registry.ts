/**
 * Plannotator Inbox registry: `${dataDir}/inbox/inbox.json`.
 *
 * `{ v, pid, port, url, version, token, serverSession, startedAt, tailnet?, lan?, tailscale? }`, mode
 * 0600, written by the Inbox server when it starts and LEFT IN PLACE when it
 * exits, so a person who ran the Inbox once has it found by every agent
 * session, and a caller can start it again on the port it last had.
 *
 *  - Found: the file exists.
 *  - Read on every call: callers never cache the port or token.
 *  - The token rotates on every start; it guards the connection routes only.
 *  - Running: the health answer on that port carries this entry's
 *    `serverSession`. Stopped: a dead pid with no health answer, an answer
 *    from a different `serverSession` (the port was reused), or a live pid
 *    with nothing listening (a reused pid). A stopped Inbox is started with
 *    `plannotator inbox --background`. Busy: a live pid whose port takes the
 *    request but does not answer in time; callers wait, never start a second
 *    writer on the store.
 *
 * The Inbox never registers in `sessions/`, so it never holds auto-update back
 * (auto-update skips while another live pid is registered there).
 */

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isInboxHealth, type InboxHealth } from "@plannotator/core/inbox-types";
import { inboxDir } from "./schema";
import { proveInboxProcess } from "./process-proof";

export const INBOX_REGISTRY_FILE = "inbox.json";
export const INBOX_START_LOCK = "start.lock";
/** A start lock older than this belongs to a starter that died. */
export const INBOX_START_LOCK_STALE_MS = 30_000;

export interface InboxRegistryEntry {
  v: 1;
  pid: number;
  port: number;
  url: string;
  version: string;
  token: string;
  serverSession: string;
  startedAt: string;
  /**
   * "Reach from my tailnet" is on (adr/implementation/inbox-mobile.md,
   * section 1): the tailnet HTTPS port and the door-only listener's loopback
   * port it publishes (reused at the next start when free). Absent: off.
   */
  tailnet?: { https_port: number; door_port?: number };
  /**
   * "Reach from this Wi-Fi" (adr/implementation/inbox-mobile.md, section 3):
   * the LAN listener's port, kept when the switch goes off so on again and
   * the next start reuse it when free, and the switch (`on: false` once
   * switched off; absent means on, as P2 wrote it). Absent: never switched on.
   */
  lan?: { port: number; on?: boolean };
  /**
   * "Over your tailnet" (`plannotator inbox --tailscale`, PLANNOTATOR_INBOX_TAILSCALE,
   * config.json `inboxTailscale`): present while publishing is on.
   * `url` is the tailnet address while the publication works, `error` why
   * not when it does not. `https_port` + `proxy_port` name the serve mapping
   * this Inbox made (the HTTPS port is the Inbox's own port, the proxy port
   * its tailnet-only loopback listener), kept after a stop whose take-down
   * failed so the next start or `uninstall --purge` can take it down.
   */
  tailscale?: { url: string | null; error: string | null; https_port?: number; proxy_port?: number };
}

export function inboxRegistryPath(dataDir: string): string {
  return join(inboxDir(dataDir), INBOX_REGISTRY_FILE);
}

/** A fresh connection token: 32 random bytes as hex. */
export function createInboxToken(): string {
  return randomBytes(32).toString("hex");
}

function isEntry(value: unknown): value is InboxRegistryEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === 1 &&
    typeof v.pid === "number" &&
    Number.isInteger(v.pid) &&
    v.pid > 0 &&
    typeof v.port === "number" &&
    Number.isInteger(v.port) &&
    v.port > 0 &&
    v.port < 65536 &&
    typeof v.url === "string" &&
    typeof v.version === "string" &&
    typeof v.token === "string" &&
    v.token.length >= 32 &&
    typeof v.serverSession === "string" &&
    typeof v.startedAt === "string"
  );
}

/** The registry entry, or null when there is none or it does not parse. */
export function readInboxRegistry(dataDir: string): InboxRegistryEntry | null {
  try {
    const value = JSON.parse(readFileSync(inboxRegistryPath(dataDir), "utf8"));
    return isEntry(value) ? value : null;
  } catch {
    return null;
  }
}

/** Write the entry atomically (temp file, then rename), owner-only. */
export function writeInboxRegistry(dataDir: string, entry: InboxRegistryEntry): void {
  const dir = inboxDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = inboxRegistryPath(dataDir);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(temp, 0o600);
  } catch {
    // Best effort where the filesystem has no modes.
  }
  renameSync(temp, path);
}

/**
 * The running Inbox `serverSession` rewriting its own entry (a tailnet or
 * Wi-Fi change), from the entry in the file: `change` gets a copy and the
 * result is written, only while the file still names `serverSession`. False,
 * and nothing written, when the file is gone (the data folder was removed:
 * never make it again) or names another Inbox (one that started since owns
 * the file: a stopping Inbox must not rewrite its successor's entry).
 *
 * Read, then write: not atomic across processes. An Inbox that writes its
 * own entry between the read and the rename (a start overlapping this one's
 * stop, within one file read) is overwritten with this Inbox's entry. The
 * newer Inbox's data-gone check then finds another session in the file and
 * exits, and the next agent call starts a fresh Inbox: a lost start, never
 * two writers on the store and never a dead pid left for callers to wait on
 * (this Inbox is stopping). Closing it would take a lock around every write.
 */
export function updateOwnInboxRegistry(
  dataDir: string,
  serverSession: string,
  change: (entry: InboxRegistryEntry) => void,
): boolean {
  const current = readInboxRegistry(dataDir);
  if (current?.serverSession !== serverSession) return false;
  const entry = { ...current };
  change(entry);
  writeInboxRegistry(dataDir, entry);
  return true;
}

/** What the running Inbox's data-gone check saw (`probeInboxData`). */
export type InboxDataProbe =
  | { state: "ok" }
  /** Its data is gone: the reason, for stderr. */
  | { state: "gone"; reason: string }
  /** Could not tell (a permission, an I/O error, a file being replaced): neither a miss nor a pass. */
  | { state: "unknown"; detail: string };

function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

const isMissing = (code: string | undefined) => code === "ENOENT" || code === "ENOTDIR";

/**
 * Whether the running Inbox `serverSession` still has its data: `inbox.json`
 * exists and names it. Gone ONLY on evidence: the file (or a folder above
 * it) does not exist (ENOENT, ENOTDIR), or it parses and names another
 * Inbox. Any other failure (EACCES, EIO, ESTALE, EMFILE, EBUSY, a file that
 * does not parse) is unknown: a network mount waking up or a permission
 * change must never end an Inbox. Not the folder's device and inode: a
 * remount after sleep or a data dir reached through a moved copy's symlink
 * changes them while the Inbox and its file are fine.
 *
 * Unlike `readInboxRegistry` (null on anything, for callers that only ask
 * "is there an entry"), this keeps the errno.
 */
export function probeInboxData(dataDir: string, serverSession: string): InboxDataProbe {
  const dir = inboxDir(dataDir);
  const path = inboxRegistryPath(dataDir);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = errnoOf(error);
    if (!isMissing(code)) return { state: "unknown", detail: `${path}: ${code ?? String(error)}` };
    let folderGone = false;
    try {
      statSync(dir);
    } catch (folderError) {
      folderGone = isMissing(errnoOf(folderError));
    }
    return { state: "gone", reason: folderGone ? `its data folder ${dir} is gone` : `${path} is gone` };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { state: "unknown", detail: `${path} does not parse` };
  }
  if (!isEntry(value)) return { state: "unknown", detail: `${path} is not an Inbox entry` };
  if (value.serverSession !== serverSession) return { state: "gone", reason: `another Inbox (pid ${value.pid}) owns ${dir} now` };
  return { state: "ok" };
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

type HealthProbe =
  | { kind: "health"; health: InboxHealth }
  /** Something accepted the request but did not answer in time. */
  | { kind: "timeout" }
  /** Refused, or an answer that is not an Inbox's. */
  | { kind: "none" };

async function probeInboxHealth(port: number, timeoutMs: number): Promise<HealthProbe> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/inbox/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { kind: "none" };
    const body: unknown = await response.json();
    return isInboxHealth(body) ? { kind: "health", health: body } : { kind: "none" };
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    return name === "TimeoutError" || name === "AbortError" ? { kind: "timeout" } : { kind: "none" };
  }
}

/** `GET /api/inbox/health` on the entry's loopback port, or null when nothing answers as an Inbox. */
export async function fetchInboxHealth(port: number, timeoutMs = 2000): Promise<InboxHealth | null> {
  const probe = await probeInboxHealth(port, timeoutMs);
  return probe.kind === "health" ? probe.health : null;
}

export type InboxStatus =
  | { state: "missing" }
  | { state: "stopped"; entry: InboxRegistryEntry; reason: "dead_pid" | "no_answer" | "other_session" }
  /**
   * The registry's pid is alive and its port accepted the health request but
   * did not answer in time: an Inbox that is busy or paused, not a stopped
   * one. Starting another would put a second writer on the store, so callers
   * wait for it instead.
   */
  | { state: "busy"; entry: InboxRegistryEntry }
  | { state: "running"; entry: InboxRegistryEntry; health: InboxHealth };

/** Read the registry and check it against the process and the port. */
export async function inboxStatus(dataDir: string, timeoutMs = 2000): Promise<InboxStatus> {
  const entry = readInboxRegistry(dataDir);
  if (!entry) return { state: "missing" };
  const probe = await probeInboxHealth(entry.port, timeoutMs);
  if (probe.kind === "health") {
    if (probe.health.serverSession === entry.serverSession) return { state: "running", entry, health: probe.health };
    return { state: "stopped", entry, reason: "other_session" };
  }
  if (!isPidAlive(entry.pid)) return { state: "stopped", entry, reason: "dead_pid" };
  // A live pid whose port takes the connection but never answers is a busy or
  // paused Inbox; a live pid with nothing listening is a reused pid.
  return probe.kind === "timeout" ? { state: "busy", entry } : { state: "stopped", entry, reason: "no_answer" };
}

/**
 * The start lock: one starter at a time, so two agents that find the Inbox
 * stopped at once do not start two writers on one store. Returns a release
 * function, or null when another starter holds a fresh lock.
 */
export function acquireInboxStartLock(dataDir: string): (() => void) | null {
  const dir = inboxDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, INBOX_START_LOCK);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lock);
      return () => rmSync(lock, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs <= INBOX_START_LOCK_STALE_MS) return null;
        rmSync(lock, { recursive: true, force: true });
      } catch {
        // Gone in between: try again.
      }
    }
  }
  return null;
}

/** Wait until `check` answers non-null, polling; null on timeout. */
export async function waitForInbox<T>(check: () => Promise<T | null>, timeoutMs: number, intervalMs = 100): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Why a record names no running Inbox of its data dir (`plannotator inbox stop` reports it; nothing is signalled). */
export type InboxStaleReason =
  /** The process it names has exited. */
  | "dead_pid"
  /** Another Inbox answers on its port. */
  | "other_session"
  /** Nothing answers on its port and the pid is not proven to be this Inbox: another program has it now (as `inboxStatus` says). */
  | "no_answer"
  /**
   * The Inbox it names runs on another data dir and refused the stop: a
   * copied data dir (a backup, a seeded sandbox) whose record names the
   * original's Inbox.
   */
  | "not_ours";

/**
 * The folder that makes an Inbox one data dir's (its `inbox/` folder: the
 * record and the store): its realpath, so two spellings of one folder
 * compare equal, and its device and inode, so two paths to one folder that
 * realpath cannot join (a bind mount, another mount namespace) do too; null
 * when it does not exist.
 */
function inboxFolderIdentity(dataDir: string): { path: string; dev: bigint; ino: bigint } | null {
  try {
    const path = realpathSync.native(inboxDir(resolve(dataDir)));
    const stat = statSync(path, { bigint: true });
    return { path, dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

/**
 * Whether a stop that names `requested` as its data dir is for the Inbox
 * running on `own` (the stop route asks). Only a clear mismatch says no:
 * both folders exist, their realpaths differ AND they are different folders
 * on disk (device and inode). So a stop is never refused on a folder that
 * cannot be read (a moved or renamed data dir), nor on one folder reached
 * two ways; a copy is another folder.
 */
export function isOwnDataDir(own: string, requested: string): boolean {
  const ownDir = inboxFolderIdentity(own);
  const requestedDir = inboxFolderIdentity(requested);
  if (!ownDir || !requestedDir || ownDir.path === requestedDir.path) return true;
  return ownDir.dev === requestedDir.dev && ownDir.ino === requestedDir.ino;
}

export type InboxStopResult =
  | { state: "not_running"; stale?: { pid: number; reason: InboxStaleReason } }
  | {
      state: "stopped";
      pid: number;
      /** What ended it: its own stop route (the clean stop), or the signal it took after ignoring that. */
      by: "stop_route" | "SIGTERM" | "SIGKILL";
      /** It was published over the tailnet by `--tailscale` for that run only (its stop route says; an older Inbox does not). */
      tailscaleRunOnly: boolean;
    }
  | {
      state: "still_running";
      pid: number;
      /**
       * `busy`: it never answered and could not be proven. `unproven`: the
       * pid could not be proven to be it, so nothing was sent. `survived`: it
       * outlived every signal.
       */
      reason: "busy" | "unproven" | "survived";
    };

export interface StopInboxOptions {
  /** How long each step waits for the process to exit. Default 5 s. */
  timeoutMs?: number;
  /**
   * `plannotator inbox stop`: also prove the pid by its process (`ps`; see
   * process-proof.ts), so an Inbox that stopped answering can still be
   * stopped, and end with SIGKILL when it outlives SIGTERM. Off
   * (uninstall --purge): only a pid the port's health answer names is
   * signalled, and only with SIGTERM.
   */
  escalate?: boolean;
}

async function waitPidGone(pid: number, timeoutMs: number): Promise<boolean> {
  return (await waitForInbox(async () => (isPidAlive(pid) ? null : true), timeoutMs)) === true;
}

/**
 * Stop the Inbox the record names. Asks first, over its token-guarded stop
 * route (the clean stop: its tailnet mappings come down), and waits for the
 * pid to exit; then SIGTERM, and with `escalate` SIGKILL. Before EVERY signal
 * the pid is proven again (`proveInboxProcess`): the port's health answers
 * with this record's pid and serverSession, or (with `escalate`, POSIX) `ps`
 * shows an Inbox command line that started no later than the record. A pid
 * that cannot be proven is never signalled: the record outlives its Inbox and
 * pids are reused. The stop route's request names this data dir, and an
 * Inbox on another one (a copied record) refuses it; then nothing is
 * signalled either. An Inbox older than that check stops, as before, and
 * the signals cannot tell a copied record (both proofs pass for it).
 * Answers what happened.
 */
export async function stopInbox(dataDir: string, options: StopInboxOptions = {}): Promise<InboxStopResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const escalate = options.escalate === true;
  const prove = (entry: InboxRegistryEntry) =>
    proveInboxProcess(entry, { processProof: escalate, health: (port) => fetchInboxHealth(port, 1000) });

  /** SIGTERM, then (escalate) SIGKILL, each only after the pid is proven again. */
  const signalUntilGone = async (entry: InboxRegistryEntry, tailscaleRunOnly: boolean): Promise<InboxStopResult> => {
    let last: "stop_route" | "SIGTERM" = "stop_route";
    for (const signal of escalate ? (["SIGTERM", "SIGKILL"] as const) : (["SIGTERM"] as const)) {
      if (!isPidAlive(entry.pid)) return { state: "stopped", pid: entry.pid, by: last, tailscaleRunOnly };
      if (!(await prove(entry))) return { state: "still_running", pid: entry.pid, reason: "unproven" };
      try {
        process.kill(entry.pid, signal);
      } catch {
        // Gone in between.
      }
      if (await waitPidGone(entry.pid, signal === "SIGKILL" ? Math.min(timeoutMs, 2000) : timeoutMs)) {
        return { state: "stopped", pid: entry.pid, by: signal, tailscaleRunOnly };
      }
      if (signal === "SIGTERM") last = "SIGTERM";
    }
    return { state: "still_running", pid: entry.pid, reason: "survived" };
  };

  let status = await inboxStatus(dataDir);
  if (status.state === "busy") {
    // Give a busy Inbox the stop window to answer; never purge under a live writer.
    const busy = status;
    const answered = await waitForInbox(async () => {
      const next = await inboxStatus(dataDir, 1000);
      return next.state === "busy" ? null : next;
    }, timeoutMs);
    if (!answered) {
      if (!escalate) return { state: "still_running", pid: busy.entry.pid, reason: "busy" };
      const result = await signalUntilGone(busy.entry, false);
      return result.state === "still_running" && result.reason === "unproven" ? { ...result, reason: "busy" } : result;
    }
    status = answered;
  }
  if (status.state === "missing") return { state: "not_running" };
  if (status.state === "stopped") {
    const { entry } = status;
    // A live pid that IS this Inbox but no longer answers on its port: on its way out, or hung after
    // closing its listener. Only `escalate` can prove it (by its process): wait for it, then signal.
    if (escalate && isPidAlive(entry.pid) && (await prove(entry))) {
      if (await waitPidGone(entry.pid, timeoutMs)) return { state: "stopped", pid: entry.pid, by: "stop_route", tailscaleRunOnly: false };
      return signalUntilGone(entry, false);
    }
    return { state: "not_running", stale: { pid: entry.pid, reason: status.reason } };
  }
  const { entry } = status;
  let tailscaleRunOnly = false;
  try {
    // `data_dir`: an Inbox refuses (409 not_ours) a stop for another data dir, so a copied record
    // never stops the original. An older Inbox ignores the body and stops, as before.
    const response = await fetch(`http://127.0.0.1:${entry.port}/api/inbox/control/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${entry.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ data_dir: resolve(dataDir) }),
      signal: AbortSignal.timeout(2000),
    });
    if (response.status === 409) {
      const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
      // Its refusal is the proof it is not this data dir's: nothing is signalled.
      if (body?.code === "not_ours") return { state: "not_running", stale: { pid: entry.pid, reason: "not_ours" } };
    }
    if (response.ok) {
      const body = (await response.json().catch(() => null)) as { tailscale_run_only?: unknown } | null;
      tailscaleRunOnly = body?.tailscale_run_only === true;
    }
  } catch {
    // Fall through to the signals below.
  }
  if (await waitPidGone(entry.pid, timeoutMs)) return { state: "stopped", pid: entry.pid, by: "stop_route", tailscaleRunOnly };
  return signalUntilGone(entry, tailscaleRunOnly);
}

