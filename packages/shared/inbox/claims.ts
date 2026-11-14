import { join } from "node:path";
import { inboxClaimName } from "./connection";

const MOD_SESSION = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export function inboxModClaimDir(inboxDir: string, replyId: string, session: string): string | null {
  return MOD_SESSION.test(session) ? join(inboxDir, "..", "claude-code-mod", session, "inbox", "claims", replyId) : null;
}

export function inboxClaimDirs(inboxDir: string, replyId: string, session: string): string[] {
  const mod = inboxModClaimDir(inboxDir, replyId, session);
  return [...(mod ? [mod] : []), join(inboxDir, "claims", inboxClaimName(replyId, session)), join(inboxDir, "claims", replyId)];
}
