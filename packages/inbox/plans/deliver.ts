/**
 * What the plan page sends the agent: the person's comments as plan feedback (Send), or what their edit changed
 * (Done, Restore: plan review's "# Direct Edits", packages/shared/direct-edits.ts, built by the Inbox). One way for
 * both, the way a Send goes (approval "plans-editing"):
 * - the plan has its Inbox thread (`thread_id`): the words go into it as the person's reply, at once;
 * - else an agent session wrote the plan: New message opens to it filled in (compose/openComposer.ts), the person
 *   reads it and presses Send there, and the thread it starts becomes the plan's;
 * - else nothing goes, and the page says so in the Inbox's words for a project with no live agent.
 * A Send that went marks the comments it carried sent and records the thread (`POST /api/plans/:id/sent`).
 */
import type { PlanRecord, PlanVersion } from '@plannotator/core/plans';
import { inboxApi } from '../api';
import { openComposer } from '../compose/openComposer';
import { hostLabel } from '../compose/model';
import { newUuid } from '../uuid';
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

/** How it went: into the plan's thread, New message opened, or nowhere to send it. */
export type PlanDelivery = 'replied' | 'composing' | 'no-agent';

export async function deliverToPlanAgent(input: {
  plan: PlanRecord;
  session: PlanSession | null;
  words: string;
  /** The comments these words carry (their annotation ids), marked sent once it went. */
  comments: readonly string[];
  /** It went (the thread is recorded): read the plan again. */
  onSent: () => void;
}): Promise<PlanDelivery> {
  const { plan, session, words, comments, onSent } = input;
  const to = session ? { host: session.host ?? '', session: session.session } : null;
  if (plan.thread_id) {
    const result = await inboxApi.reply(plan.thread_id, { idempotency_key: newUuid(), words, questions: [] });
    const replyId = (result.reply as { id?: unknown } | null)?.id;
    await plansApi.sent(plan.id, { thread_id: plan.thread_id, message_id: typeof replyId === 'string' ? replyId : plan.thread_id, to, comments: [...comments] });
    onSent();
    return 'replied';
  }
  if (!session) return 'no-agent';
  openComposer({
    subject: plan.name,
    body: words,
    to: { session: session.session },
    // The thread it starts is the plan's: its root message is the thread's id.
    onSent: (sent) => void plansApi.sent(plan.id, { thread_id: sent.threadId, message_id: sent.threadId, to: { host: sent.host, session: sent.session }, comments: [...comments] }).then(onSent, onSent),
  });
  return 'composing';
}
