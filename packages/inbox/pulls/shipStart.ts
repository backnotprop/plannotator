/**
 * Ship from a Reviews row (approval "inbox-ship-mode"): the pull request goes to an agent whose job is not done until
 * it is merged. A row with a review thread ships in that thread (the instruction is the person's reply to the agent
 * picked, on the computer that holds the thread); a pull request with no thread gets one, started with the instruction
 * (core `shipMessage`) and tied to the PR as Start a thread ties it, then the record. Who it can go to: the agents of
 * the thread's project (or the PR's projects), as Start a thread lists them (`threadTo.ts`), on the thread's computer.
 */
import { useMemo } from 'react';
import { shipMessage } from '@plannotator/core/inbox-ship';
import { pullHandoffThreadName } from '@plannotator/core/inbox-pull-handoff';
import { inboxPullIsOpen, inboxPullRepoKey, type InboxPull, type InboxPullStack, type InboxReviewRow } from '@plannotator/core/inbox-types';
import { inboxApi, type ComposeSessionsModel } from '../api';
import { machineOf } from '../inboxUrl';
import { newUuid } from '../uuid';
import { startShip, type ShipTo } from '../data/ships';
import { useComposeSessions } from '../compose/useComposeSessions';
import { useMachineSessions } from '../board/farCards';
import { pullThreadDefault, pullThreadOptions, type PullThreadOption } from './threadTo';

/** What a row's Ship is about: one open pull request, and the review thread it ships in, if it has one. */
export interface ShipTarget {
  pull: InboxPull;
  stack: InboxPullStack;
  threadId: string | null;
  /** The linked machine that holds the thread; null for this computer. */
  machine: string | null;
  /** The projects its agent can work in: the thread's, else the PR's here. */
  projects: string[];
  /** The agent already on the review: Ship's default. */
  agent: { host: string; session: string; name: string | null } | null;
}

/** A row (or a stack's layer) about exactly one open pull request: what its Ship ships. Several: none (one PR per ship). */
export function shipTarget(row: InboxReviewRow, pulls: readonly InboxPull[], repoProjects: Readonly<Record<string, string[]>>): ShipTarget | null {
  if (pulls.length !== 1) return null;
  const pull = pulls[0]!;
  if (!inboxPullIsOpen(pull)) return null;
  const stack = row.stacks.find((s) => s.layers.some((l) => l.key === pull.key)) ?? null;
  if (!stack) return null;
  const link = row.link && (row.thread_id === null || row.link.thread_id === row.thread_id) ? row.link : null;
  const threadId = row.thread_id ?? link?.thread_id ?? null;
  const live = link?.agent && link.agent.session && link.agent.host && !link.agent.ended ? link.agent : null;
  const projects = link?.project_id ? [link.project_id] : (repoProjects[inboxPullRepoKey(pull.host, pull.repo)] ?? []);
  return { pull, stack, threadId, machine: threadId ? machineOf(threadId) : null, projects, agent: live ? { host: live.host!, session: live.session!, name: live.name } : null };
}

/** The agent rows of Ship's picker, and the one it starts on: the agent on the review, else New review's choice. */
export function shipOptions(model: ComposeSessionsModel | null, target: ShipTarget | null): { options: PullThreadOption[]; chosen: string | null } {
  if (!target) return { options: [], chosen: null };
  const listed = pullThreadOptions(model, target.projects);
  const agent = target.agent;
  if (agent && !listed.some((o) => o.row.session === agent.session)) {
    const label = agent.name ?? 'Agent';
    listed.unshift({ row: { session: agent.session, host: agent.host, label, short: label, state: 'live' }, to: { host: agent.host, session: agent.session }, project: target.projects[0] ?? '', projectName: '' });
  }
  return { options: listed, chosen: agent?.session ?? pullThreadDefault(model, target.projects, listed) };
}

/**
 * Ship's picker while `active` (its menu or sheet is open): the live sessions of the computer that holds the thread,
 * read as compose reads them (every few seconds while open, nothing while closed).
 */
export function useShipAgents(target: ShipTarget | null, active: boolean) {
  const far = active && target?.machine ? target.machine : null;
  const { model: here } = useComposeSessions(active && !!target && !target.machine);
  const there = useMachineSessions(far);
  const model = target?.machine ? (there?.model ?? null) : here;
  return useMemo(() => shipOptions(model, target), [model, target]);
}

/** Ship it with `option`: in its thread, or a new one. Answers the thread it ships in. */
export async function shipPull(target: ShipTarget, option: PullThreadOption): Promise<string> {
  const to = option.to as ShipTo;
  if (target.threadId) {
    await startShip({ key: target.pull.key, thread_id: target.threadId, to }, target.machine);
    return target.threadId;
  }
  const keys = [target.pull.key];
  // Taken meanwhile (another window's Start a thread, a hand-off): it ships in that thread.
  const check = await inboxApi.pullOwnerCheck(keys, option.project);
  if (check.owner) {
    await startShip({ key: target.pull.key, thread_id: check.owner, to }, null);
    return check.owner;
  }
  const one = { ...target.stack, layers: [target.pull] };
  const thread = await inboxApi.startThread({
    to: option.to,
    body: shipMessage(target.pull),
    idempotency_key: newUuid(),
    thread_name: pullHandoffThreadName(one, null),
    thread_name_auto: true,
    thread_name_numbered: true,
  });
  await inboxApi.pullOwner(keys, thread.thread_id, 'thread');
  await startShip({ key: target.pull.key, thread_id: thread.thread_id, started: true }, null);
  return thread.thread_id;
}
