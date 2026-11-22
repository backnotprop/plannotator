/**
 * The reply box's start row (approval "reply to a brand-new session", option A "A row in the list"): when the session
 * a reply would go to has ended, the recipient list offers one more row, "+ [mark] New Claude Code session in ledger".
 * The same agent as the ended session, on the same machine, in the same folder, when that machine can start it (its
 * launch block lists it); else the first agent that machine can start; none, no row. Model and effort are that
 * machine's last choice. Picked, the reply goes with `to: { launch }` and starts that session (inbox-reply-launch.ts);
 * never by default. Pure, for the tests.
 */
import type { InboxComposeLaunch, InboxThread } from '@plannotator/core/inbox-types';
import type { AskingSession } from '../components/ReplyRoute';
import type { RecipientRow } from '../replyRecipients';

/** The start row's id in the recipient choice (a draft keeps it with its `recipients`): never a session's. */
const START_PREFIX = 'new:';

/** Whether a recipient id is a start row's. */
export const isStartRow = (id: string | null | undefined): boolean => !!id && id.startsWith(START_PREFIX);

export interface ReplyStart {
  /** The list's row: chosen like any agent's, drawn as New message's start row. */
  row: RecipientRow;
  /** The reply route's `to` when it is chosen. */
  to: { launch: { agent: string; project_id: string; model?: string; effort?: string; primary_agent?: string } };
}

/**
 * The start row a thread offers, or null: the asking session has not ended, starting agents is off there (no block),
 * no agent can start, or the folder is not one of that machine's projects. `asleep`: the thread's machine is away; the
 * row says it starts when it's back.
 */
export function replyStartOf(block: InboxComposeLaunch | null | undefined, thread: InboxThread, asking: AskingSession | null, asleep = false): ReplyStart | null {
  if (!block || !asking) return null;
  const agent = block.agents.find((a) => a.agent === asking.host) ?? block.agents[0];
  if (!agent) return null;
  // The ended session's own folder when it wrote from another one, else the thread's project.
  const own = asking.message.from_project?.root ?? null;
  const there = block.projects.filter((p) => p.exists);
  const project = (own ? there.find((p) => p.root === own) : undefined) ?? there.find((p) => p.id === thread.project.id || p.root === thread.project.root);
  if (!project) return null;
  const last = agent.choices?.last;
  const label = `New ${agent.name} session`;
  return {
    row: { session: `${START_PREFIX}${agent.agent}`, host: agent.agent, label, short: label, state: 'live', start: { project: project.name, asleep } },
    to: { launch: { agent: agent.agent, project_id: project.id, ...(last?.model ? { model: last.model } : {}), ...(last?.effort ? { effort: last.effort } : {}), ...(last?.primary_agent ? { primary_agent: last.primary_agent } : {}) } },
  };
}
