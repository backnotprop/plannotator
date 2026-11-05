/**
 * A reply a session's own connection claimed and will never deliver: the wake that took it was killed while it
 * delivered, so the claim stays and no later wake of that session takes it again (a claim is the "never twice").
 * The owner's ruling: never deliver twice, and let the person move it to another session by hand. So nothing here
 * delivers anything; the reply stops reading as on its way, and "Send to another session" may move it even while
 * that session runs.
 *
 * Read from the claim folders the connections write (the store's `readdressMessage` removes the same ones):
 *  - The Claude Code mod, `claude-code-mod/<session>/inbox/claims/<reply id>/`: its claimant writes `alive` every 5 s
 *    while it holds the claim, and another process of the session writes `reported` once it stops
 *    (`watchElsewhere`, `INBOX_UNDELIVERED_AFTER_MS`).
 *  - Pi, OpenCode 2 and dsh (`InboxWake` in packages/shared/inbox/agent-link.ts), `inbox/claims/<reply id>.<session>/`
 *    (an older version's by the reply id alone): no claimant renews it, and a later wake of the session that finds it
 *    settles it without delivering it. So its claimant is gone once the session is, or once a wake that started after
 *    the claim polls for the session.
 * `delivered` in a claim: it went in (the acknowledgement is on its way). `reported`: the connection gave it up.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { inboxClaimName } from "@plannotator/shared/inbox/connection";

/** The Claude Code mod's `INBOX_UNDELIVERED_AFTER_MS` (apps/hook/hooks/mod/inbox.ts): a claimant silent this long quit. */
export const INBOX_CLAIM_ABANDONED_AFTER_MS = 60_000;

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

/** Whether `session`'s connection claimed reply `replyId` and will never deliver it. `inboxDir`: the store's folder. */
export function inboxClaimAbandoned(inboxDir: string, replyId: string, session: string, wake: InboxClaimWake, now: number): boolean {
  // The mod's claim (the store's rule for which session names make a folder there).
  if (/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(session)) {
    const dir = join(inboxDir, "..", "claude-code-mod", session, "inbox", "claims", replyId);
    const made = madeAt(dir);
    if (made !== null) {
      if (existsSync(join(dir, "delivered"))) return false;
      if (existsSync(join(dir, "reported"))) return true;
      let alive = Number.NaN;
      try {
        alive = Number(readFileSync(join(dir, "alive"), "utf8").trim());
      } catch {
        // Not written yet: the claim's own time stands.
      }
      const last = Number.isFinite(alive) && alive > 0 ? alive : made;
      return now - last >= INBOX_CLAIM_ABANDONED_AFTER_MS;
    }
  }
  for (const name of [inboxClaimName(replyId, session), replyId]) {
    const dir = join(inboxDir, "claims", name);
    const made = madeAt(dir);
    if (made === null) continue;
    if (existsSync(join(dir, "delivered"))) return false;
    if (existsSync(join(dir, "reported"))) return true;
    return !wake.there || (wake.startedAt !== null && made < wake.startedAt);
  }
  return false;
}
