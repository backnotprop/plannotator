/**
 * Routines' routes (Bun Inbox only, this machine's own: a routine is managed on the computer that
 * made it). The contract is research CONTRACT.md section 2; every POST carries the page's `serverSession`.
 */
import type { InboxScheduledFolder, InboxScheduledIfMissed, InboxScheduledPreview, InboxScheduledRow, InboxScheduledRunSummary, InboxScheduledSchedule } from '@plannotator/core/inbox-scheduled-types';
import { pageServerSession } from '../api';
import { readJson } from '../apiError';
import { inboxUrl } from '../inboxUrl';
import { newUuid } from '../uuid';

declare module '../api' {
  interface SettingsModel {
    /** Settings → Capabilities → Routines. Absent where launch is not supported (Windows): no row. */
    scheduled_threads?: { on: boolean; login?: 'added' | 'unavailable' };
  }
}

export interface ScheduledFields {
  name: string;
  prompt: string;
  schedule: InboxScheduledSchedule;
  if_missed: InboxScheduledIfMissed;
  folder: InboxScheduledFolder;
  agent: string;
  model?: string;
  effort?: string;
  attachments: string[];
}

/** This machine's own: a routine is managed on the computer that made it. */
const BASE = inboxUrl('/scheduled');

async function get<T>(path: string): Promise<T> {
  return readJson<T>(await fetch(path, { headers: { Accept: 'application/json' }, cache: 'no-store' }));
}

async function post<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const session = pageServerSession();
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(session ? { ...body, serverSession: session } : body),
  });
  return readJson<T>(response);
}

const one = (id: string, rest = '') => `${BASE}/${encodeURIComponent(id)}${rest}`;
type Saved = { scheduled: InboxScheduledRow };

export const scheduledApi = {
  list: () => get<{ scheduled: InboxScheduledRow[]; launch_on: boolean }>(BASE),
  read: (id: string) => get<{ scheduled: InboxScheduledRow; runs: InboxScheduledRunSummary[] }>(one(id)),
  create: (fields: ScheduledFields) => post<Saved>(BASE, { ...fields, idempotency_key: newUuid() }),
  update: (id: string, fields: Partial<ScheduledFields>) => post<Saved>(one(id), fields),
  turn: (id: string, on: boolean) => post<Saved>(one(id, on ? '/on' : '/off')),
  /** `202`: the run's divider; `failed`: why it didn't start (its thread says it too). */
  run: (id: string) => post<Saved & { message_id: string; failed?: string }>(one(id, '/run')),
  stop: (id: string) => post<Saved>(one(id, '/stop')),
  remove: (id: string) => post<{ deleted: true }>(one(id, '/delete')),
  /** A delete's Undo: back as it was. */
  restore: (id: string) => post<Saved>(one(id, '/restore')),
  preview: (schedule: InboxScheduledSchedule) => post<InboxScheduledPreview>(`${BASE}/preview`, { schedule }),
  /** The capability switch (`POST /api/inbox/settings`). */
  saveSwitch: (on: boolean) => post<{ scheduled_threads: { on: boolean; login?: 'added' | 'unavailable' } }>(inboxUrl('/settings'), { scheduled_threads: { on } }),
};
