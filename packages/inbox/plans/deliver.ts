/**
 * What the plan page sends the agent: the person's comments as plan feedback (Send), or what their edit changed
 * (Done, Restore: plan review's "# Direct Edits", packages/shared/direct-edits.ts, built by the Inbox). One way for
 * both (approval "plans-editing"), to the agent the page finds (`planAgentOf`):
 * - the plan has its Inbox thread (`thread_id`): the words go into it as the person's reply, at once;
 * - else an agent is live in the plan's project (the Inbox's live sessions, the ones New message lists; the session
 *   that wrote the plan first when it is one of them): New message opens to it filled in (compose/openComposer.ts),
 *   or on its own To list when several are live or the project is known by its folder's name only (an imported
 *   plan: two folders may share the name, and the list shows which is which); the person reads it and presses Send
 *   there, and the thread it starts becomes the plan's;
 * - else nothing goes, and the page says so in the Inbox's words for a project with no live agent.
 * A Send that went marks the comments it carried sent, records the thread and the version a Direct Edits section
 * carried (`POST /api/plans/:id/sent`). That record is retried quietly: the reply went, so the person is never told
 * it did not; one that never lands waits in this browser's storage and is tried again when a plan page opens. A
 * reply's key is the plan, the thread, the comments it carries, the version it tells of and its words: the same Send
 * tried again is the same reply, and a new Send is never taken for an old one. A Send held for another machine is
 * recorded when its outbox entry is delivered.
 */
import { sha1Hex, type PlanRecord, type PlanVersion } from '@plannotator/core/plans';
import { storage } from '@plannotator/ui/utils/storage';
import type { InboxComposeSession } from '@plannotator/core/inbox-types';
import { inboxApi, type ComposeSessionsModel } from '../api';
import { openComposer } from '../compose/openComposer';
import { hostLabel } from '../compose/model';
import { plansApi } from './client';

/** The agent session that wrote the plan: the newest version that names one. */
export interface PlanSession {
  session: string;
  host: string | null;
  name: string | null;
}

export function planSession(versions: readonly PlanVersion[]): PlanSession | null {
  for (let i = versions.length - 1; i >= 0; i--) {
    const v = versions[i]!;
    if (v.agent_session) return { session: v.agent_session, host: v.agent_host, name: v.agent_name };
  }
  return null;
}

/** The agent as the page names it: its session's name, else its host's ("Claude Code"), else "the agent". */
export const planAgentLabel = (session: PlanSession | null) => session?.name || (session?.host ? hostLabel(session.host) : null) || 'the agent';

/** The Inbox's words for a project with no live agent (the thread's and New message's). */
export const noAgentWords = (project: string | null) => (project ? `No agent is running in ${project}` : 'No live session');

/** Who a plan's words go to. */
export type PlanAgent =
  | { kind: 'thread'; thread: string; label: string }
  | { kind: 'session'; session: string; host: string; label: string }
  /** Several agents are live in the project, or one known by its folder's name only: New message opens on its To list. */
  | { kind: 'pick'; label: string }
  | { kind: 'none' };

const lastPart = (root: string) => root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? root;

/**
 * The live sessions working in the plan's project: its Inbox project, its folder, or the name plan history files it
 * under. `sure`: matched by the project's id or folder; a match by the folder's name only (an imported plan knows no
 * more) may be another folder of the same name.
 */
export function planLiveSessions(plan: Pick<PlanRecord, 'project_id' | 'project_root' | 'project_name'>, model: ComposeSessionsModel | null): (InboxComposeSession & { sure: boolean })[] {
  if (!model) return [];
  const sure = (project: { id: string | null; root: string }, root?: string) =>
    (!!plan.project_id && project.id === plan.project_id) || (!!plan.project_root && (project.root === plan.project_root || root === plan.project_root));
  const named = (project: { name: string; root: string }, root?: string) =>
    !!plan.project_name && (project.name === plan.project_name || lastPart(project.root) === plan.project_name || (!!root && lastPart(root) === plan.project_name));
  return model.projects.flatMap((group) =>
    group.sessions.flatMap((s): (InboxComposeSession & { sure: boolean })[] => (sure(group.project, s.root) ? [{ ...s, sure: true }] : named(group.project, s.root) ? [{ ...s, sure: false }] : [])),
  );
}

/**
 * Whom the plan's words go to now: its thread, else the live agent in its project: the plan's own session first,
 * else the one agent matched by the project's id or folder (one of the same name elsewhere does not count). Several,
 * or matched by the folder's name only: New message's To list, where the person sees which folder each agent is in.
 */
export function planAgentOf(plan: PlanRecord, versions: readonly PlanVersion[], model: ComposeSessionsModel | null): PlanAgent {
  const own = planSession(versions);
  if (plan.thread_id) return { kind: 'thread', thread: plan.thread_id, label: planAgentLabel(own) };
  const live = planLiveSessions(plan, model);
  const sure = live.filter((s) => s.sure);
  const chosen = live.find((s) => s.session === own?.session) ?? (sure.length === 1 ? sure[0]! : null);
  if (chosen) return { kind: 'session', session: chosen.session, host: chosen.host, label: chosen.label || hostLabel(chosen.host) };
  return live.length > 0 ? { kind: 'pick', label: 'the agent' } : { kind: 'none' };
}

/** Whom the plan's words go to at the moment they are sent: the live sessions read again (a failed read: none known). */
export async function planAgentNow(plan: PlanRecord, versions: readonly PlanVersion[]): Promise<PlanAgent> {
  if (plan.thread_id) return planAgentOf(plan, versions, null);
  const model = await inboxApi.composeSessions().catch(() => null);
  return planAgentOf(plan, versions, model);
}

/** How it went: into the plan's thread, New message opened, held for another machine, or nowhere to send it. */
export type PlanDelivery = 'replied' | 'composing' | 'held' | 'no-agent';

type SentBody = Parameters<typeof plansApi.sent>[1];

/**
 * The records of Sends that went but could not be recorded yet, in this browser's localStorage (the Inbox's origin is
 * fixed), at most 50, tried again when a plan page opens. Not Plannotator's `storage`: that is cookies, which hold
 * about ten entries and ride on every request. A queue an older build kept there is moved once.
 */
export const PLAN_SENT_QUEUE_KEY = 'plannotator-inbox-plan-sent-queue';
const QUEUE_MAX = 50;
type QueuedSent = { id: string; body: SentBody };
const local = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};
const parseQueue = (raw: string | null): QueuedSent[] => {
  try {
    const value = JSON.parse(raw ?? '[]') as unknown;
    return Array.isArray(value) ? (value as QueuedSent[]) : [];
  } catch {
    return [];
  }
};
const writeQueue = (queue: readonly QueuedSent[]) => {
  try {
    if (queue.length) local()?.setItem(PLAN_SENT_QUEUE_KEY, JSON.stringify(queue.slice(-QUEUE_MAX)));
    else local()?.removeItem(PLAN_SENT_QUEUE_KEY);
  } catch {
    // No room or no storage: the record is lost, as it would be with no queue (the words went).
  }
};
const readQueue = (): QueuedSent[] => {
  let queue: QueuedSent[] = [];
  try {
    queue = parseQueue(local()?.getItem(PLAN_SENT_QUEUE_KEY) ?? null);
  } catch {
    // Unreadable: nothing queued here.
  }
  // An older build's queue, in the cookie: moved here once, the cookie cleared.
  const old = storage.getItem(PLAN_SENT_QUEUE_KEY);
  if (old !== null && local()) {
    queue = [...parseQueue(old), ...queue].slice(-QUEUE_MAX);
    writeQueue(queue);
    storage.removeItem(PLAN_SENT_QUEUE_KEY);
  }
  return queue;
};

/** How long the quiet record waits between tries (the last try's failure queues it). */
let sentRetryWaits: readonly number[] = [0, 1_000, 4_000, 15_000];
export function setPlanSentRetryWaitsForTests(waits: readonly number[] | null): void {
  sentRetryWaits = waits ?? [0, 1_000, 4_000, 15_000];
}

/**
 * Record a Send that went, quietly: tried again a few times, and never said to have failed (the words went). Every
 * try failed: it waits in the queue (`PLAN_SENT_QUEUE_KEY`) for the next plan page, so the next diff does not hold
 * again what the agent already has. A record is safe twice (a sent comment stays sent, the first thread stays, the
 * told version only rises).
 */
async function recordSent(id: string, body: SentBody, onSent: () => void): Promise<void> {
  for (const wait of sentRetryWaits) {
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      await plansApi.sent(id, body);
      onSent();
      return;
    } catch {
      // Tried again below, then queued.
    }
  }
  writeQueue([...readQueue(), { id, body }]);
}

/** Try the queued records again (a plan page opened): how many landed; the ones that fail again stay queued. */
export async function flushQueuedPlanSent(): Promise<number> {
  const queue = readQueue();
  if (!queue.length) return 0;
  writeQueue([]);
  const left: QueuedSent[] = [];
  let landed = 0;
  for (const entry of queue) {
    try {
      await plansApi.sent(entry.id, entry.body);
      landed++;
    } catch (error) {
      // A record refused for good (400: no longer a valid record; 404: the plan or version is gone) is dropped;
      // anything else waits for the next page, a 409 too (the Inbox restarted under this tab: the next page has it).
      const status = (error as { status?: unknown }).status;
      if (status !== 400 && status !== 404) left.push(entry);
    }
  }
  if (left.length) writeQueue([...left, ...readQueue()]);
  return landed;
}

/** How often a held Send's outbox entry is looked at, and for how long. */
const HELD_LOOK_MS = 5_000;
const HELD_LOOK_FOR_MS = 24 * 60 * 60 * 1000;

/**
 * A Send held for another machine: `then` runs once its outbox entry was delivered (it left the waiting list with no
 * notice); never when it was refused, dropped or cancelled.
 */
export function whenHeldDelivered(key: string, then: () => void, look = () => inboxApi.outbox(), every = HELD_LOOK_MS): void {
  const until = Date.now() + HELD_LOOK_FOR_MS;
  const tick = async () => {
    try {
      const { waiting, notices } = await look();
      const notice = notices.find((n) => n.key === key);
      if (!waiting.some((w) => w.key === key)) {
        if (!notice) then();
        return;
      }
    } catch {
      // Looked at again below.
    }
    if (Date.now() < until) setTimeout(() => void tick(), every);
  };
  setTimeout(() => void tick(), every);
}

/** The outbox key as a message id `/sent` takes. */
const heldMessageId = (key: string) => `held_${key.replace(/[^A-Za-z0-9_:-]/g, '').slice(0, 120)}`;

export async function deliverToPlanAgent(input: {
  plan: PlanRecord;
  agent: PlanAgent;
  words: string;
  /** The comments these words carry (their annotation ids), marked sent once it went. */
  comments: readonly string[];
  /** A Direct Edits section's version (Done, Restore): the agent knows it once it went. */
  told?: { doc: string; version: number } | null;
  /** It went (the thread is recorded): read the plan again. */
  onSent: () => void;
}): Promise<PlanDelivery> {
  const { plan, agent, words, comments, onSent } = input;
  const told = input.told ?? null;
  if (agent.kind === 'thread') {
    // The same Send tried again is the same reply; a new Send (other comments, another version) is never an old one.
    const key = `plan_${sha1Hex(new TextEncoder().encode(`${plan.id}\n${agent.thread}\n${comments.join(',')}\n${told?.version ?? ''}\n${words}`)).slice(0, 32)}`;
    const result = await inboxApi.reply(agent.thread, { idempotency_key: key, words, questions: [] });
    const replyId = (result.reply as { id?: unknown } | null)?.id;
    const body: SentBody = { thread_id: agent.thread, message_id: typeof replyId === 'string' ? replyId : agent.thread, to: null, comments: [...comments], told };
    if (result.held) {
      const held = result.held.key;
      whenHeldDelivered(held, () => void recordSent(plan.id, body, onSent));
      return 'held';
    }
    void recordSent(plan.id, body, onSent);
    return 'replied';
  }
  if (agent.kind === 'none') return 'no-agent';
  openComposer({
    subject: plan.name,
    body: words,
    to: agent.kind === 'session' ? { session: agent.session } : 'pick',
    // The thread it starts is the plan's: its root message is the thread's id.
    onSent: (sent) => {
      if ('held' in sent) {
        const key = sent.held.key;
        whenHeldDelivered(key, () => void recordSent(plan.id, { thread_id: null, message_id: heldMessageId(key), to: null, comments: [...comments], told }, onSent));
      } else {
        void recordSent(plan.id, { thread_id: sent.threadId, message_id: sent.threadId, to: { host: sent.host, session: sent.session }, comments: [...comments], told }, onSent);
      }
    },
  });
  return 'composing';
}
