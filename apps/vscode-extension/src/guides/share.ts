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
    if (err instanceof GuideShareError && err.status === 404) return { ok: true };
    return {
      ok: false,
      url: share.url,
      reason: err instanceof Error ? err.message : String(err),
      command: `plannotator guide unshare ${share.id} --token ${share.deleteToken}`,
    };
  }
}
