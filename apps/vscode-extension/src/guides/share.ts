/**
 * Removing a guide's share link before the guide is deleted. The saved
 * envelope is the only copy of the link's delete token, so the web app's
 * delete removes the link first; this does the same with the shared
 * `unshareGuide`. Unlike the web app (which logs and deletes anyway), a
 * failure here is returned so VS Code can warn and let the person decide.
 */

import { GuideShareError, unshareGuide } from "../../../../packages/server/guide/guide-share";

export interface GuideShareRecord {
  id: string;
  url: string;
  deleteToken: string;
  serviceUrl: string;
}

export type ShareRemoval = { ok: true } | { ok: false; url: string; reason: string; command: string };

export async function removeShareBeforeDelete(share: GuideShareRecord | undefined, doFetch?: typeof fetch): Promise<ShareRemoval> {
  if (!share) return { ok: true };
  try {
    await unshareGuide(share.id, share.deleteToken, { serviceUrl: share.serviceUrl, ...(doFetch && { fetch: doFetch }) });
    return { ok: true };
  } catch (err) {
    // Already removed or expired on the host: nothing left to remove.
    if (err instanceof GuideShareError && err.status === 404) return { ok: true };
    return {
      ok: false,
      url: share.url,
      reason: err instanceof Error ? err.message : String(err),
      command: `plannotator guide unshare ${share.id} --token ${share.deleteToken}`,
    };
  }
}
