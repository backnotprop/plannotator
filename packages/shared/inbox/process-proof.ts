/**
 * Is this pid the Inbox that `inbox/inbox.json` names? Asked before
 * `plannotator inbox stop` signals anything, because a pid in a record proves
 * nothing on its own: the record outlives its Inbox and pids are reused.
 *
 * Two proofs, either one enough (`proveInboxProcess`):
 *
 *  - health: `GET /api/inbox/health` on the record's port answers with the
 *    record's pid AND serverSession. Only that Inbox knows its serverSession.
 *  - process (POSIX only, read from `ps`): the pid runs an Inbox server
 *    command line (`plannotator inbox`, `… index.ts inbox`, with only
 *    `--no-open` / `--tailscale` after it; never `inbox mcp`), AND it started
 *    no later than the record's `startedAt`. The Inbox writes `startedAt`
 *    once it listens, so the process that wrote the record was already
 *    running then; a process that reused the pid started after the Inbox
 *    exited, which is after `startedAt`. Used when health cannot answer: an
 *    Inbox that closed its listener and hangs on the way out, or one too busy
 *    to answer.
 *
 * The time check reads the wall clock (`now - etime` against `startedAt`).
 * A clock set forward only makes the proof fail, which is safe. A clock set
 * back further than the time from the Inbox's start to the pid's reuse can
 * let a reused pid pass; it must still run an Inbox server command line.
 *
 * Windows has no `ps`: there only the health proof works, so an Inbox that
 * does not answer is never signalled there.
 *
 * The command-line classifier follows rmohta's `classifyInboxCommand`
 * (rmohta/plannotator, branch feat/plan-library, inbox-processes.ts), matched
 * on the whole line so a binary in a folder whose name holds a space still
 * reads.
 */

import { spawnSync } from "node:child_process";
import type { InboxRegistryEntry } from "./registry";

/** `ps` rounds the elapsed time down to the second; the record's time is to the millisecond. */
const START_SLACK_MS = 2_000;

/** The flags an Inbox server runs with (a detached start runs `inbox --no-open [--tailscale]`). */
const SERVER_TAIL = /\sinbox((?:\s+(?:--no-open|--tailscale))*)\s*$/;
/**
 * What runs the Inbox: the `plannotator` binary itself (bare, or a path to
 * it), or a script after its interpreter (`bun …/index.ts inbox`). Not
 * `grep plannotator inbox`: a word before a bare `plannotator` is not a path.
 */
const RUNNER = /^(?:plannotator|.*[\\/]plannotator)(?:\.exe)?$|\.[cm]?[jt]s$/;

/** Whether one command line is an Inbox server (never `inbox mcp`, `inbox stop` or another subcommand). */
export function isInboxServerCommand(command: string): boolean {
  const line = command.trim();
  const tail = SERVER_TAIL.exec(line);
  if (!tail) return false;
  return RUNNER.test(line.slice(0, tail.index));
}

/** `ps`'s `etime`, `[[dd-]hh:]mm:ss`, in milliseconds; null when it does not read. */
export function parseElapsed(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60_000 + Number(seconds) * 1000;
}

export interface ProcessInfo {
  /** When it started (now minus its elapsed time), to the second. */
  startedAtMs: number;
  command: string;
}

/** `ps -o etime= -o args=` for one pid; null where it cannot be read (Windows, a gone pid, no `ps`). */
export function readProcessInfo(pid: number, now: number = Date.now()): ProcessInfo | null {
  if (process.platform === "win32" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  let stdout = "";
  try {
    const result = spawnSync("ps", ["-ww", "-o", "etime=", "-o", "args=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      timeout: 5_000,
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return null;
    stdout = result.stdout;
  } catch {
    return null;
  }
  const line = stdout.split("\n").find((l) => l.trim().length > 0);
  const match = line ? /^\s*(\S+)\s+(.+)$/.exec(line) : null;
  if (!match) return null;
  const elapsed = parseElapsed(match[1]!);
  if (elapsed === null) return null;
  return { startedAtMs: now - elapsed, command: match[2]!.trim() };
}

/** The process proof alone: an Inbox command line that started no later than the record. */
export function processMatchesEntry(info: ProcessInfo | null, entry: Pick<InboxRegistryEntry, "startedAt">): boolean {
  if (!info || !isInboxServerCommand(info.command)) return false;
  const recorded = Date.parse(entry.startedAt);
  return Number.isFinite(recorded) && info.startedAtMs <= recorded + START_SLACK_MS;
}

export type InboxProof = "health" | "process" | null;

/**
 * How `entry.pid` is proven to be the Inbox `entry` describes, or null when
 * it is not (then it must never be signalled). `processProof: false` allows
 * only the health proof.
 */
export async function proveInboxProcess(
  entry: Pick<InboxRegistryEntry, "pid" | "port" | "serverSession" | "startedAt">,
  options: {
    processProof?: boolean;
    health?: (port: number) => Promise<{ pid: number; serverSession: string } | null>;
    processInfo?: (pid: number) => ProcessInfo | null;
  } = {},
): Promise<InboxProof> {
  const health = options.health ? await options.health(entry.port) : null;
  if (health && health.pid === entry.pid && health.serverSession === entry.serverSession) return "health";
  if (options.processProof === false) return null;
  const info = (options.processInfo ?? readProcessInfo)(entry.pid);
  return processMatchesEntry(info, entry) ? "process" : null;
}
