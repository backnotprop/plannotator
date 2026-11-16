/**
 * What the plan page sends the agent: the person's comments as plan feedback (Send), or what their edit changed
 * (Done, Restore: plan review's "# Direct Edits", packages/shared/direct-edits.ts, built by the Inbox). One way for
 * both (approval "plans-editing"), to the agent the page finds (`planAgentOf`):
 * - the plan has its Inbox thread (`thread_id`): the words go into it as the person's reply, at once;
 * - else an agent is live in the plan's project (the Inbox's live sessions, the ones New message lists; the session
 *   that wrote the plan first when it is one of them): New message opens to it filled in (compose/openComposer.ts),
 *   or on its own To list when several are live; the person reads it and presses Send there, and the thread it
 *   starts becomes the plan's;
 * - else nothing goes, and the page says so in the Inbox's words for a project with no live agent.
 * A Send that went marks the comments it carried sent, records the thread and the version a Direct Edits section
 * carried (`POST /api/plans/:id/sent`). That record is retried quietly: the reply went, so the person is never told
 * it did not. A reply keeps one key per plan and words, so pressing Send again cannot post it twice. A Send held for
 * another machine is recorded when its outbox entry is delivered.
 */
import { sha1Hex, type PlanRecord, type PlanVersion } from '@plannotator/core/plans';
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
  /** Several agents are live in the project: New message opens on its To list. */
  | { kind: 'pick'; label: string }
  | { kind: 'none' };

const lastPart = (root: string) => root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? root;

/** The live sessions working in the plan's project: its Inbox project, its folder, or the name plan history files it under. */
export function planLiveSessions(plan: Pick<PlanRecord, 'project_id' | 'project_root' | 'project_name'>, model: ComposeSessionsModel | null): InboxComposeSession[] {
  if (!model) return [];
  const ours = (project: { id: string | null; name: string; root: string }, root?: string) =>
    (!!plan.project_id && project.id === plan.project_id) ||
    (!!plan.project_root && (project.root === plan.project_root || root === plan.project_root)) ||
    (!!plan.project_name && (project.name === plan.project_name || lastPart(project.root) === plan.project_name || (!!root && lastPart(root) === plan.project_name)));
  return model.projects.flatMap((group) => group.sessions.filter((s) => ours(group.project, s.root)));
}

/** Whom the plan's words go to now: its thread, else the live agent in its project (the plan's own session first). */
export function planAgentOf(plan: PlanRecord, versions: readonly PlanVersion[], model: ComposeSessionsModel | null): PlanAgent {
  const own = planSession(versions);
  if (plan.thread_id) return { kind: 'thread', thread: plan.thread_id, label: planAgentLabel(own) };
  const live = planLiveSessions(plan, model);
  const chosen = live.find((s) => s.session === own?.session) ?? (live.length === 1 ? live[0]! : null);
  if (chosen) return { kind: 'session', session: chosen.session, host: chosen.host, label: chosen.label || hostLabel(chosen.host) };
  return live.length > 1 ? { kind: 'pick', label: 'the agent' } : { kind: 'none' };
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

/** Record a Send that went, quietly: tried again a few times, and never said to have failed (the words went). */
async function recordSent(id: string, body: SentBody, onSent: () => void): Promise<void> {
  for (const wait of [0, 1_000, 4_000, 15_000]) {
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      await plansApi.sent(id, body);
      onSent();
      return;
    } catch {
      // Tried again below; the comments stay waiting only if every try failed.
    }
  }
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
    // One key per plan and words: the same Send pressed again is the same reply, never a second one.
    const key = `plan_${sha1Hex(new TextEncoder().encode(`${plan.id}\n${agent.thread}\n${words}`)).slice(0, 32)}`;
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
