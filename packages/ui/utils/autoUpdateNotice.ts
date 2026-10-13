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
  return {
    title: 'Auto-update failed',
    description: notice.logPath ? `See ${notice.logPath}` : `Could not install v${notice.version}.`,
  };
}
