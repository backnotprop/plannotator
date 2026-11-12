import { getItem, setItem } from './storage';

export interface AutoUpdateNotice {
  id: string;
  kind: 'updated' | 'failed';
  version: string;
  releaseUrl: string;
  logPath?: string;
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

export function claimAutoUpdateNotice(notice: AutoUpdateNotice): boolean {
  if (getItem(SEEN_KEY) === notice.id) return false;
  setItem(SEEN_KEY, notice.id);
  return true;
}

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
