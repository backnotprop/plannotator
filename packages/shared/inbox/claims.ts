import { join } from "node:path";
import { inboxClaimName } from "./connection";

const MOD_SESSION = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
 * The Claude Code mod's claim folder for a reply to `session`. The mod keeps a session's Inbox files under the
 * session's id with every character a file name cannot hold read `_` (`inboxSessionDirName` in
 * apps/hook/hooks/mod/inbox.ts): a T3 Code thread made by an agent has `:` in its id.
 */
export function inboxModClaimDir(inboxDir: string, replyId: string, session: string): string | null {
  const name = session.replace(/[^A-Za-z0-9._-]/g, "_");
  return MOD_SESSION.test(name) ? join(inboxDir, "..", "claude-code-mod", name, "inbox", "claims", replyId) : null;
}

export function inboxClaimDirs(inboxDir: string, replyId: string, session: string): string[] {
  const mod = inboxModClaimDir(inboxDir, replyId, session);
  return [...(mod ? [mod] : []), join(inboxDir, "claims", inboxClaimName(replyId, session)), join(inboxDir, "claims", replyId)];
}
