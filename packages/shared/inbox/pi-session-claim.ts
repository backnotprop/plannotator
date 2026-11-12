import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PiSessionClaim {
  session: string;
  pid: number;
  rpc: boolean;
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
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

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

export function releasePiSessionClaim(dataDir: string, session: string, pid: number, owner: string): void {
  const file = piSessionClaimFileOf(dataDir, session, pid);
  try {
    if (parseClaim(readFileSync(file, "utf8"))?.owner === owner) rmSync(file, { force: true });
  } catch {}
}

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
