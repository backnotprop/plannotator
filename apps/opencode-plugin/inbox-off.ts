import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { isInboxSessionOff } from "@plannotator/shared/inbox/session-off";

export function openCodeInboxOff(sessionID: string | undefined): boolean {
  return !!sessionID && isInboxSessionOff(getPlannotatorDataDir(), sessionID);
}
