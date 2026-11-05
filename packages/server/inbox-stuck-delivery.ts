/**
 * A reply a session's own connection claimed and will never deliver: the wake that took it was killed while it
 * delivered, so the claim stays and no later wake of that session takes it again (a claim is the "never twice").
 * The owner's ruling: never deliver twice, and let the person move it to another session by hand. So nothing here
 * delivers anything; the reply stops reading as on its way, and "Send to another session" may move it even while
 * that session runs. Each rule calls a claim stuck only when its claimant cannot still deliver it.
 *
 * Read from the claim folders the connections write (the store's `readdressMessage` removes the same ones):
 *  - The Claude Code mod, `claude-code-mod/<session>/inbox/claims/<reply id>/`: while the session runs, one of its
 *    processes watches a claim it lost and writes `reported` once the claimant's `alive` (renewed every 5 s) is
 *    `INBOX_UNDELIVERED_AFTER_MS` old, so only `reported` counts then; with the session gone, that same age does.
 *  - Pi, OpenCode 2 and dsh (`InboxWake` in packages/shared/inbox/agent-link.ts), `inbox/claims/<reply id>.<session>/`
 *    (an older version's by the reply id alone): the wake writes its `pid`, and the claim is stuck once that process
 *    is gone. A claim from an older wake names no process: it is stuck once the session is gone, or once a wake that
 *    started after the claim polls for the session (that wake settles the claim and never delivers it).
 * `delivered` in a claim: it went in (the acknowledgement is on its way). `reported`: the connection gave it up.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { inboxClaimName, INBOX_UNDELIVERED_AFTER_MS } from "@plannotator/shared/inbox/connection";

/** The session's wake as the Inbox knows it now. */
export interface InboxClaimWake {
  /** The session is there (`askerLive`, with its grace). */
  there: boolean;
  /** When the wake that polls for it now started (its poll's `started_at`); null when its poll did not say. */
  startedAt: number | null;
}

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

/** Whether a process runs with this pid (the Inbox and the wakes share one data dir, so one machine). */
function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Whether `session`'s connection claimed reply `replyId` and will never deliver it. `inboxDir`: the store's folder. */
export function inboxClaimAbandoned(inboxDir: string, replyId: string, session: string, wake: InboxClaimWake, now: number): boolean {
  // The mod's claim (the store's rule for which session names make a folder there).
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
    return !wake.there || (wake.startedAt !== null && made < wake.startedAt);
  }
  return false;
}
