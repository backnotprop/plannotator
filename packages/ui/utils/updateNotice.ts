import { getItem, setItem } from './storage';
import { noteServerSessionMismatch, withServerSession } from './serverSession';

export type UpdateAction = 'script' | 'copy' | 'pi' | 'opencode';

export interface UpdateAdvert {
  version: string;
  current: string;
  releaseUrl: string;
  action: UpdateAction;
  command: string;
  publishedAt?: string;
}

export interface UpdateCheckFailingAdvert {
  since: string;
  error: string;
  command: string;
}

export function parseUpdateCheckFailing(value: unknown): UpdateCheckFailingAdvert | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.since !== 'string' || Number.isNaN(Date.parse(v.since))) return null;
  if (typeof v.error !== 'string' || v.error.length > 200) return null;
  if (typeof v.command !== 'string' || !v.command || v.command.length > 500) return null;
  return { since: v.since, error: v.error, command: v.command };
}

export const UPDATE_TOAST_INTERVAL_MS = 24 * 60 * 60 * 1000;

const TOAST_KEY = 'plannotator-update-toast';
const VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;
const ACTIONS: readonly UpdateAction[] = ['script', 'copy', 'pi', 'opencode'];

export function parseUpdateAdvert(value: unknown): UpdateAdvert | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.version !== 'string' || !VERSION.test(v.version)) return null;
  if (typeof v.current !== 'string' || !VERSION.test(v.current)) return null;
  if (typeof v.releaseUrl !== 'string' || !/^https:\/\/github\.com\//.test(v.releaseUrl)) return null;
  if (typeof v.action !== 'string' || !ACTIONS.includes(v.action as UpdateAction)) return null;
  if (typeof v.command !== 'string' || !v.command || v.command.length > 500) return null;
  return {
    version: v.version,
    current: v.current,
    releaseUrl: v.releaseUrl,
    action: v.action as UpdateAction,
    command: v.command,
    ...(typeof v.publishedAt === 'string' && { publishedAt: v.publishedAt }),
  };
}

function readToastRecord(): { version: string; at: number } | null {
  const raw = getItem(TOAST_KEY);
  if (!raw) return null;
  const at = raw.lastIndexOf('@');
  if (at <= 0) return null;
  const time = Number(raw.slice(at + 1));
  return Number.isFinite(time) ? { version: raw.slice(0, at), at: time } : null;
}

export function updateToastDue(version: string, now: number, record = readToastRecord()): boolean {
  if (!record) return true;
  if (record.version === version) return false;
  if (record.at > now) return true;
  return now - record.at >= UPDATE_TOAST_INTERVAL_MS;
}

export function claimUpdateToast(version: string, now: number): boolean {
  if (!updateToastDue(version, now)) return false;
  setItem(TOAST_KEY, `${version}@${now}`);
  return true;
}

export function describeUpdateToast(advert: UpdateAdvert): { title: string; description: string; primary: 'update' | 'copy' } {
  switch (advert.action) {
    case 'script':
      return {
        title: `Plannotator ${advert.version} is available`,
        description: `You have ${advert.current}. Update installs it in the background; this review keeps working.`,
        primary: 'update',
      };
    case 'copy':
      return {
        title: `Plannotator ${advert.version} is available`,
        description: `You have ${advert.current}. This copy was not installed by the install script: run the install command to update.`,
        primary: 'copy',
      };
    case 'pi':
      return {
        title: `Plannotator for Pi ${advert.version} is available`,
        description: `Run ${advert.command}, then type /reload in Pi.`,
        primary: 'copy',
      };
    case 'opencode':
      return {
        title: `Plannotator ${advert.version} is available`,
        description: "Run the install script again, then run opencode2 reload (OpenCode 1: restart it). It also clears OpenCode's cached plugin.",
        primary: 'copy',
      };
  }
}

export async function requestUpdateNow(): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  try {
    const res = await fetch('/api/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(withServerSession({})) });
    if (await noteServerSessionMismatch(res)) return { ok: false, error: 'This review was replaced by a newer Plannotator session. Reload the page.' };
    const body = (await res.json().catch(() => ({}))) as { version?: string; error?: string };
    if (res.ok && typeof body.version === 'string') return { ok: true, version: body.version };
    return { ok: false, error: body.error ?? `The update could not start (HTTP ${res.status}).` };
  } catch {
    return { ok: false, error: 'The update could not start: the session is not reachable.' };
  }
}
