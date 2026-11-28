/**
 * Which processes run a Pi session, as each one says it. Pi sets `process.title = "pi"`, so `ps` shows a running
 * Pi as `pi` alone, without `--mode rpc --session-id <uuid>`: its command line cannot tell which session it runs.
 * So Plannotator's Pi extension, in every Pi process on a computer that has run the Inbox, writes
 * `inbox/pi-sessions/<session>.<pid>.json` (`{ session, pid, rpc, title, owner }`) as a session starts and
 * removes it as the session ends. The Inbox's Pi launch host reads them so that it never starts a second writer
 * on a session (packages/server/inbox-launch-pi.ts).
 *
 * A file whose pid no longer runs is stale (a Pi that was killed): the reader removes it, and a Pi that reuses
 * the pid removes it as it claims its own session. `title` is the
 * process's title when it wrote the file, so a pid reused by another program is not read as that Pi. `owner`
 * names the extension instance, so a `/reload`'s old instance never removes the new one's file.
 *
 * Node-safe (vendored into the Pi extension's `generated/inbox/`): `node:` modules only.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PiSessionClaim {
  session: string;
  pid: number;
  /** Pi runs in RPC mode (`--mode rpc`): an Inbox's process, not a person's terminal. */
  rpc: boolean;
  /** `process.title` when it was written: what `ps` shows for that pid while it is that Pi. */
  title: string;
  owner: string;
}

export function piSessionClaimDirOf(dataDir: string): string {
  return join(dataDir, "inbox", "pi-sessions");
}

const safe = (session: string) => session.replace(/[^A-Za-z0-9_-]/g, "_");

export function piSessionClaimFileOf(dataDir: string, session: string, pid: number): string {
  return join(piSessionClaimDirOf(dataDir), `${safe(session)}.${pid}.json`);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Best effort: a claim that cannot be written leaves only `ps` to tell. A pid runs one Pi session at a time, so
 * any other claim under this pid is stale (a killed Pi whose pid this process reused) and is removed.
 */
export function writePiSessionClaim(dataDir: string, claim: PiSessionClaim): void {
  try {
    const dir = piSessionClaimDirOf(dataDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = piSessionClaimFileOf(dataDir, claim.session, claim.pid);
    for (const name of readdirSync(dir)) {
      if (name.endsWith(`.${claim.pid}.json`) && join(dir, name) !== file) rmSync(join(dir, name), { force: true });
    }
    const tmp = `${file}.${claim.owner}.tmp`;
    writeFileSync(tmp, JSON.stringify(claim), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {}
}

function parseClaim(text: string): PiSessionClaim | null {
  try {
    const value = JSON.parse(text) as Partial<PiSessionClaim>;
    if (typeof value.session !== "string" || !value.session || typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) return null;
    return { session: value.session, pid: value.pid, rpc: value.rpc === true, title: typeof value.title === "string" ? value.title : "", owner: typeof value.owner === "string" ? value.owner : "" };
  } catch {
    return null;
  }
}

/** Removes this instance's claim on `session` (another instance's, after a `/reload`, stays). */
export function releasePiSessionClaim(dataDir: string, session: string, pid: number, owner: string): void {
  const file = piSessionClaimFileOf(dataDir, session, pid);
  try {
    if (parseClaim(readFileSync(file, "utf8"))?.owner === owner) rmSync(file, { force: true });
  } catch {}
}

/** Every claim whose pid still runs; a stale one (its pid gone) is removed. */
export function readPiSessionClaims(dataDir: string): PiSessionClaim[] {
  const dir = piSessionClaimDirOf(dataDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const claims: PiSessionClaim[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    let claim: PiSessionClaim | null;
    try {
      claim = parseClaim(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (claim && isPidAlive(claim.pid)) claims.push(claim);
    else if (claim) {
      try {
        rmSync(file, { force: true });
      } catch {}
    }
  }
  return claims;
}

/** Whether any claim file names `pid`: no file, no session, so the caller need not read the process's start time. */
export function piSessionClaimFileOfPid(dataDir: string, pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    return readdirSync(piSessionClaimDirOf(dataDir)).some((name) => name.endsWith(`.${pid}.json`));
  } catch {
    return false;
  }
}

/**
 * The session `pid` claims now, or null: the Pi (or Oh My Pi) process that started the Inbox's stdio MCP shim as
 * its MCP server says which session it runs here, and says it again on `/new`, `/resume` and an OMP session
 * switch, so the shim reads it at every tool call. Reads only that pid's files and removes nothing.
 *
 * `notBeforeMs`: when the process now running as `pid` started (null: unknown, as on Windows). A claim written
 * before then is a dead process's (killed, so it never released it) whose pid was reused, maybe by another
 * agent: it is not this process's session. A live process's claim is always written after it started.
 */
export function piSessionClaimOfPid(dataDir: string, pid: number, notBeforeMs: number | null = null): string | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const dir = piSessionClaimDirOf(dataDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith(`.${pid}.json`)) continue;
    const file = join(dir, name);
    try {
      if (notBeforeMs !== null && statSync(file).mtimeMs < notBeforeMs) continue;
      const claim = parseClaim(readFileSync(file, "utf8"));
      if (claim?.pid === pid) return claim.session;
    } catch {}
  }
  return null;
}
