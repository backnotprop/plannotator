/**
 * Whom a plan's words go to (`planAgentOf`), pure: the plan page's Send and its Direct Edits ask it (deliver.ts).
 *
 * The session that wrote the plan is found by its own id among every live session of this Inbox, before any project
 * is compared. Plan review files a plan under its folder's name (the git toplevel's, lowercased and cut to 30
 * characters), while the Inbox files a session under its project (a linked worktree's repository, by its folder): in a
 * worktree, or a folder named with capitals, the two never meet, and the page said no agent was running beside the
 * very agent that wrote the plan. The project is compared only when that session is not live: then the rules below
 * are as they were, never looser.
 */
import type { PlanRecord, PlanVersion } from '@plannotator/core/plans';
import type { InboxComposeSession } from '@plannotator/core/inbox-types';
import type { ComposeSessionsModel } from '../api';
import { hostLabel } from '../compose/model';

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
 * The plan's own session when it is live in this Inbox, in any project: the same session id, from the same host
 * when the version recorded one (a session id is the host's own, so another host's equal id is never taken for it).
 */
export function planAuthorLive(own: PlanSession | null, model: ComposeSessionsModel | null): InboxComposeSession | null {
  if (!own || !model) return null;
  for (const group of model.projects) {
    for (const s of group.sessions) if (s.session === own.session && (!own.host || s.host === own.host)) return s;
  }
  return null;
}

/**
 * Whom the plan's words go to now: its thread, else the plan's own session while it is live (wherever the Inbox files
 * it), else the one agent matched by the project's id or folder (one of the same name elsewhere does not count).
 * Several, or matched by the folder's name only: New message's To list, where the person sees which folder each
 * agent is in.
 */
export function planAgentOf(plan: PlanRecord, versions: readonly PlanVersion[], model: ComposeSessionsModel | null): PlanAgent {
  const own = planSession(versions);
  if (plan.thread_id) return { kind: 'thread', thread: plan.thread_id, label: planAgentLabel(own) };
  const live = planLiveSessions(plan, model);
  const sure = live.filter((s) => s.sure);
  const chosen = planAuthorLive(own, model) ?? (sure.length === 1 ? sure[0]! : null);
  if (chosen) return { kind: 'session', session: chosen.session, host: chosen.host, label: chosen.label || hostLabel(chosen.host) };
  return live.length > 0 ? { kind: 'pick', label: 'the agent' } : { kind: 'none' };
}
