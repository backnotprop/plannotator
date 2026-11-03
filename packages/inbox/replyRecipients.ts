/**
 * Who gets the reply (approval "inbox-reply-recipient", option E): the rules
 * behind the pill under the reply box in a thread with more than one agent.
 * Pure, for the tests; the pill and its list are ReplyRecipient.tsx.
 *
 * Names: two sessions of one agent in different folders read "Claude Code
 * (plannotator)", "Claude Code (billing-api)"; a second one in the same
 * folder "Claude Code 2", numbered by who came first. A phone shows the folder
 * alone beside the tile ("plannotator"). Live agents come first, ended last.
 */
import { INBOX_REPLY_DRAFT_RECIPIENTS_MAX, type InboxMessageWire, type InboxThread } from '@plannotator/core/inbox-types';
import type { TaggableModel } from './api';
import { agentName } from './tags';

/** `ended`: its session is gone; `reader`: an agent that reads the Inbox, not woken; `old`: a live session on an older Plannotator. */
export type RecipientState = 'live' | 'ended' | 'reader' | 'old';

export interface RecipientRow {
  session: string;
  host: string | null;
  /** The name in the pill and the list: "Claude Code (plannotator)", "Claude Code 2", "OpenCode". */
  label: string;
  /** What a phone's pill shows: the folder alone when the label carries one ("plannotator"), else the label. */
  short: string;
  state: RecipientState;
  /**
   * It can take the reply alone (be the first recipient): false for an agent with no message of its own in the
   * thread that the reply route's `to` cannot reach (it ended, or it only reads the Inbox). Absent: it can.
   */
  alone?: boolean;
}

/** Whether a session can take the reply alone: it wrote here (the reply answers its message), or `to` reaches it (live). */
export function canTakeAlone(state: RecipientState, wroteHere: boolean): boolean {
  return wroteHere || (state !== 'ended' && state !== 'reader');
}

/** A session the pill may name: one that wrote in the thread or was tagged in it, or a live one of its project. */
export interface RecipientPerson {
  host: string | null;
  session: string;
  name?: string | null;
}

/** The latest message `session` wrote in the thread. */
export function latestBy(thread: InboxThread, session: string): InboxMessageWire | undefined {
  return thread.messages.filter((m) => m.author.kind === 'agent' && m.author.session === session).at(-1);
}

/**
 * The folder (its project's name) a session works in, as the window knows it: from the live list while it is
 * live, else from what it wrote (its own project, kept on the message, or the thread's), else unknown.
 */
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

/**
 * The folder a message head names after "in": the agent's own project when it is not the thread's (kept on the
 * message, or, for a message from before that was kept, read from the live list), else the thread's.
 */
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

/** Whether a session can be woken now, as the `@` list's model says (no model yet: taken as live). */
export function recipientState(session: string, model: TaggableModel | null, ended: ReadonlySet<string>): RecipientState {
  if (ended.has(session)) return 'ended';
  if (!model) return 'live';
  const found = model.sessions.find((s) => s.session === session);
  if (!found) return 'ended';
  if (found.kind === 'mcp') return 'reader';
  return found.taggable ? 'live' : 'old';
}

/** The pill's rows, named as the approval says, live first and ended last (each group in the order given). */
export function recipientRows(
  people: readonly RecipientPerson[],
  folderOf: (session: string) => string | null,
  stateOf: (session: string) => RecipientState,
): RecipientRow[] {
  const named = people.map((p) => ({ ...p, agent: agentName(p.host, p.name ?? null), folder: folderOf(p.session) }));
  const used = new Map<string, number>();
  const rows = named.map((p): RecipientRow => {
    // The folder only when this agent's sessions are in more than one.
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

/**
 * The most agents one reply goes to: the one it answers and as many tags as a reply takes. Counted with the
 * agents typed with `@` in the box, so ticks never take a Send past its tags.
 */
export const RECIPIENTS_MAX = INBOX_REPLY_DRAFT_RECIPIENTS_MAX;

/**
 * A tap on a circle: that agent too (while under the most), or (already in, and not the only one) not any more.
 * The first recipient stays one that can take the reply alone (`alone`): taking it away moves the next such one
 * first, and with none left the tap does nothing.
 */
export function toggleRecipient(current: readonly string[], session: string, max: number = RECIPIENTS_MAX, alone: (session: string) => boolean = () => true): string[] {
  if (!current.includes(session)) return current.length < max ? [...current, session] : [...current];
  if (current.length <= 1) return [...current];
  return aimable(current.filter((id) => id !== session), alone) ?? [...current];
}

/** The choice with a recipient that can take the reply alone first, or null when it has none. */
export function aimable(pick: readonly string[], alone: (session: string) => boolean): string[] | null {
  const lead = pick.find(alone);
  return lead === undefined ? null : [lead, ...pick.filter((id) => id !== lead)];
}

/**
 * Whether a circle can be ticked: an ended agent, or one on an older Plannotator, can't be a second recipient,
 * and none can once the reply goes to the most it takes (`chosen`: everyone it goes to, typed tags too).
 */
export function canAddRecipient(row: RecipientRow, chosen: readonly string[]): boolean {
  if (chosen.includes(row.session)) return true;
  return row.state !== 'ended' && row.state !== 'old' && chosen.length < RECIPIENTS_MAX;
}

/** A restored choice without the sessions this window does not know (a draft naming one it never listed): null when none is left. */
export function knownRecipients(pick: readonly string[] | null, known: (session: string) => boolean): readonly string[] | null {
  if (pick === null) return null;
  const kept = pick.filter(known);
  if (kept.length === pick.length) return pick;
  return kept.length > 0 ? kept : null;
}
