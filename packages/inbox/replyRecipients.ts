import { INBOX_REPLY_DRAFT_RECIPIENTS_MAX, type InboxMessageWire, type InboxThread } from '@plannotator/core/inbox-types';
import type { TaggableModel } from './api';
import { agentName } from './tags';

export type RecipientState = 'live' | 'ended' | 'reader' | 'old';

export interface RecipientRow {
  session: string;
  host: string | null;
  label: string;
  short: string;
  state: RecipientState;
  alone?: boolean;
}

export function canTakeAlone(state: RecipientState, wroteHere: boolean): boolean {
  return wroteHere || (state !== 'ended' && state !== 'reader');
}

export interface RecipientPerson {
  host: string | null;
  session: string;
  name?: string | null;
}

export function latestBy(thread: InboxThread, session: string): InboxMessageWire | undefined {
  return thread.messages.filter((m) => m.author.kind === 'agent' && m.author.session === session).at(-1);
}

export function sessionFolder(session: string, thread: InboxThread, model: TaggableModel | null): string | null {
  const found = model?.sessions.find((s) => s.session === session);
  if (found?.project) {
    const here = (found.project.id !== null && found.project.id === thread.project.id) || (found.project.root !== null && found.project.root === thread.project.root);
    return here ? thread.project.name : found.project.name;
  }
  const wrote = latestBy(thread, session);
  if (wrote) return wrote.from_project?.name ?? thread.project.name;
  return null;
}

export function headFolder(message: InboxMessageWire, thread: InboxThread, model: TaggableModel | null): string {
  if (message.author.kind !== 'agent') return thread.project.name;
  if (message.from_project?.name) return message.from_project.name;
  const session = message.author.session;
  const found = session ? model?.sessions.find((s) => s.session === session) : undefined;
  const project = found?.project;
  if (!project) return thread.project.name;
  const here = (project.id !== null && project.id === thread.project.id) || (project.root !== null && project.root === thread.project.root);
  return here ? thread.project.name : project.name;
}

export function recipientState(session: string, model: TaggableModel | null, ended: ReadonlySet<string>): RecipientState {
  if (ended.has(session)) return 'ended';
  if (!model) return 'live';
  const found = model.sessions.find((s) => s.session === session);
  if (!found) return 'ended';
  if (found.kind === 'mcp') return 'reader';
  return found.taggable ? 'live' : 'old';
}

export function recipientRows(
  people: readonly RecipientPerson[],
  folderOf: (session: string) => string | null,
  stateOf: (session: string) => RecipientState,
): RecipientRow[] {
  const named = people.map((p) => ({ ...p, agent: agentName(p.host, p.name ?? null), folder: folderOf(p.session) }));
  const used = new Map<string, number>();
  const rows = named.map((p): RecipientRow => {
    const folders = new Set(named.filter((o) => o.agent === p.agent).map((o) => o.folder));
    const folder = folders.size > 1 ? p.folder : null;
    const base = folder ? `${p.agent} (${folder})` : p.agent;
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    const label = n > 1 ? `${base} ${n}` : base;
    return { session: p.session, host: p.host, label, short: folder ? (n > 1 ? `${folder} ${n}` : folder) : label, state: stateOf(p.session) };
  });
  return [...rows.filter((r) => r.state !== 'ended'), ...rows.filter((r) => r.state === 'ended')];
}

export const RECIPIENTS_MAX = INBOX_REPLY_DRAFT_RECIPIENTS_MAX;

export function toggleRecipient(current: readonly string[], session: string, max: number = RECIPIENTS_MAX, alone: (session: string) => boolean = () => true): string[] {
  if (!current.includes(session)) return current.length < max ? [...current, session] : [...current];
  if (current.length <= 1) return [...current];
  return aimable(current.filter((id) => id !== session), alone) ?? [...current];
}

export function aimable(pick: readonly string[], alone: (session: string) => boolean): string[] | null {
  const lead = pick.find(alone);
  return lead === undefined ? null : [lead, ...pick.filter((id) => id !== lead)];
}

export function canAddRecipient(row: RecipientRow, chosen: readonly string[]): boolean {
  if (chosen.includes(row.session)) return true;
  return row.state !== 'ended' && row.state !== 'old' && chosen.length < RECIPIENTS_MAX;
}

export function knownRecipients(pick: readonly string[] | null, known: (session: string) => boolean): readonly string[] | null {
  if (pick === null) return null;
  const kept = pick.filter(known);
  if (kept.length === pick.length) return pick;
  return kept.length > 0 ? kept : null;
}
