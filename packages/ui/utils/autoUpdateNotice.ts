/**
 * One-time notice after a background auto-update (#1634).
 *
 * The compiled CLI's servers attach `autoUpdateNotice` to /api/plan and
 * /api/diff when the data dir records an install attempt: `updated` once the
 * running binary is the new version, `failed` when the install script exited
 * non-zero. The notice id is stable per attempt; the "seen" marker is a cookie,
 * which is shared across the random ports sessions run on, so the toast shows
 * once whichever app (plan, annotate, review) loads first.
 */

import { getItem, setItem } from './storage';

export interface AutoUpdateNotice {
  id: string;
  kind: 'updated' | 'failed';
  version: string;
  releaseUrl: string;
  logPath?: string;
  /**
   * `mismatch`: the download did not match its checksum; `download`: it could not be downloaded;
   * `prepare`: it was downloaded but the temp folder could not hold it. The old version is kept in each case.
   */
  reason?: 'mismatch' | 'download' | 'prepare';
}

const SEEN_KEY = 'plannotator-auto-update-notice-seen';

export function parseAutoUpdateNotice(value: unknown): AutoUpdateNotice | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !v.id) return undefined;
  if (v.kind !== 'updated' && v.kind !== 'failed') return undefined;
  if (typeof v.version !== 'string' || typeof v.releaseUrl !== 'string') return undefined;
  if (!/^https:\/\/github\.com\//.test(v.releaseUrl)) return undefined;
  return {
    id: v.id,
    kind: v.kind,
    version: v.version,
    releaseUrl: v.releaseUrl,
    ...(typeof v.logPath === 'string' && { logPath: v.logPath }),
    ...((v.reason === 'mismatch' || v.reason === 'download' || v.reason === 'prepare') && { reason: v.reason }),
  };
}

/**
 * True the first time a given notice is claimed in this browser, false after.
 * Claiming marks it seen, so a caller shows the toast only when this is true.
 */
export function claimAutoUpdateNotice(notice: AutoUpdateNotice): boolean {
  if (getItem(SEEN_KEY) === notice.id) return false;
  setItem(SEEN_KEY, notice.id);
  return true;
}

/** Title and description for the toast. */
export function describeAutoUpdateNotice(notice: AutoUpdateNotice): { title: string; description: string } {
  if (notice.kind === 'updated') {
    return { title: `Updated to v${notice.version}`, description: 'Plannotator updated itself in the background.' };
  }
  if (notice.reason === 'mismatch') {
    return {
      title: `Update to v${notice.version} stopped`,
      description: "The download didn't match the checksum Plannotator fetched for it. Nothing was changed; it tries again later.",
    };
  }
  if (notice.reason === 'prepare') {
    return {
      title: "Couldn't prepare the update",
      description: 'The temp folder couldn’t hold it. Nothing was changed. Run plannotator update to see why and what to do.',
    };
  }
  if (notice.reason === 'download') {
    return {
      title: "Couldn't download the update",
      description: 'Nothing was changed. Try again later: plannotator update',
    };
  }
  return {
    title: 'Auto-update failed',
    description: notice.logPath ? `See ${notice.logPath}` : `Could not install v${notice.version}.`,
  };
}
