/**
 * Who a PR's new thread goes to (Start a thread, `startThread.ts`): the reply box's own list (`ReplyRecipient`, a
 * phone's `PhoneReplyRecipient`), filled from this computer's live sessions and launch block. The agents already
 * running in the PR's projects, then a "New <agent> session" row (the reply box's start row, `replyStart.ts`) for each
 * agent this computer can start there. One recipient, never several: a new thread has one agent. To starts on what New
 * review would name (`reviewDefaultTo`: a live agent of the PR's project, else a new session there); nothing is sent
 * until the person presses Send. Pure, for the tests.
 *
 * This computer's only: Reviews lists this computer's PRs, and their projects are this computer's (a linked machine's
 * PR opens its own PR view, not this page), so no other machine's agents are offered.
 */
import type { InboxComposeLaunch, InboxComposeProject } from '@plannotator/core/inbox-types';
import { composeTargets } from '../compose/model';
import { reviewDefaultTo } from '../compose/reviewBox';
import { recipientRows, type RecipientRow } from '../replyRecipients';
import type { PullThreadTo } from './startThread';

export interface PullThreadOption {
  row: RecipientRow;
  to: PullThreadTo;
  /** The project the thread starts in (`pulls/owner` checks the PR with it). */
  project: string;
  /** That project's name, for the row's folder. */
  projectName: string;
}

/** A start row's id: never a session's. */
const startId = (agent: string, project: string) => `new:${agent}:${project}`;

export function pullThreadOptions(model: { projects: readonly InboxComposeProject[]; launch?: InboxComposeLaunch | null } | null, projects: readonly string[]): PullThreadOption[] {
  if (!model) return [];
  const groups = model.projects.filter((g) => g.project.id !== null && projects.includes(g.project.id));
  const targets = composeTargets(groups);
  const folderOf = (session: string) => targets.find((t) => t.session === session)?.project.name ?? null;
  const live = recipientRows(
    targets.map((t) => ({ host: t.host, session: t.session })),
    folderOf,
    () => 'live',
  ).map((row): PullThreadOption => {
    const target = targets.find((t) => t.session === row.session)!;
    return { row, to: { host: target.host, session: target.session }, project: target.project.id!, projectName: target.project.name };
  });
  const block = model.launch;
  const there = (block?.projects ?? []).filter((p) => p.exists && projects.includes(p.id));
  const starts = (block?.agents ?? []).flatMap((agent) =>
    there.map((project): PullThreadOption => {
      const label = `New ${agent.name} session`;
      const last = agent.choices?.last;
      return {
        row: { session: startId(agent.agent, project.id), host: agent.agent, label, short: label, state: 'live', start: { project: project.name, asleep: false } },
        to: { launch: { agent: agent.agent, project_id: project.id, ...(last?.model ? { model: last.model } : {}), ...(last?.effort ? { effort: last.effort } : {}) } },
        project: project.id,
        projectName: project.name,
      };
    }),
  );
  return [...live, ...starts];
}

/** The option To starts on: New review's choice (`reviewDefaultTo`), or null when nothing can take the thread. */
export function pullThreadDefault(model: { projects: readonly InboxComposeProject[]; launch?: InboxComposeLaunch | null } | null, projects: readonly string[], options: readonly PullThreadOption[]): string | null {
  if (!model || options.length === 0) return null;
  const groups = model.projects.filter((g) => g.project.id !== null && projects.includes(g.project.id));
  const launch = model.launch ? { agents: model.launch.agents, projects: model.launch.projects.filter((p) => p.exists && projects.includes(p.id)) } : null;
  const pick = reviewDefaultTo(composeTargets(groups), launch, null, null);
  if (!pick) return null;
  return 'session' in pick ? pick.session : startId(pick.agent, pick.projectId);
}
