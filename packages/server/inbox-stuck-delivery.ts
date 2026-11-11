/** Never deliver twice: nothing here delivers. A claim is stuck only when its claimant cannot still deliver it, so the reply stops reading as on its way and may be moved by hand. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { inboxClaimName, INBOX_UNDELIVERED_AFTER_MS } from "@plannotator/shared/inbox/connection";

export interface InboxClaimWake {
  there: boolean;
  startedAt: number | null;
}

/** Linux stamps files from a coarse kernel clock that lags `Date.now()` by up to 10 ms, so a claim made just after the wake started can read as earlier. Leaning this way means a claim its claimant may still deliver is never stuck. */
const CLAIM_CLOCK_SLACK_MS = 50;

const madeAt = (path: string): number | null => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
};

const readNumber = (path: string): number | null => {
  try {
    const value = Number(readFileSync(path, "utf8").trim());
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
};

function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export function inboxClaimAbandoned(inboxDir: string, replyId: string, session: string, wake: InboxClaimWake, now: number): boolean {
  if (/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(session)) {
    const dir = join(inboxDir, "..", "claude-code-mod", session, "inbox", "claims", replyId);
    const made = madeAt(dir);
    if (made !== null) {
      if (existsSync(join(dir, "delivered"))) return false;
      if (existsSync(join(dir, "reported"))) return true;
      if (wake.there) return false;
      return now - (readNumber(join(dir, "alive")) ?? made) >= INBOX_UNDELIVERED_AFTER_MS;
    }
  }
  for (const name of [inboxClaimName(replyId, session), replyId]) {
    const dir = join(inboxDir, "claims", name);
    const made = madeAt(dir);
    if (made === null) continue;
    if (existsSync(join(dir, "delivered"))) return false;
    if (existsSync(join(dir, "reported"))) return true;
    const pid = readNumber(join(dir, "pid"));
    if (pid !== null) return processGone(pid);
    return !wake.there || (wake.startedAt !== null && made < wake.startedAt - CLAIM_CLOCK_SLACK_MS);
  }
  return false;
}
