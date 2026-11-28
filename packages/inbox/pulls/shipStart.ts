/**
 * Ship from a Reviews row (approval "inbox-ship-mode"): the pull request goes to an agent whose job is not done until
 * it is merged. Who it can go to: the agents of the PR's repository on every computer, as Start a thread lists them
 * (`threadTo.ts`): the review thread's computer first (the agent already on the review, the others there, its "New …
 * session" rows), then each linked computer that takes ships under its name (approved shot 3, "Mac mini").
 *
 * An agent on the review thread's computer ships in that thread (the instruction is the person's reply to it). An agent
 * on another computer, or a PR with no thread, gets a new thread on the agent's computer, started with the instruction
 * (core `shipMessage`) and tied to the PR there as Start a thread ties it, then the record there: a thread lives on one
 * computer, and its agent works where it runs. The row shows the ship whichever computer holds it (data/ships.ts).
 */
import { useMemo } from 'react';
import { shipForge, shipMessage } from '@plannotator/core/inbox-pull-handoff';
import { pullHandoffThreadName } from '@plannotator/core/inbox-pull-handoff';
import { inboxPullIsOpen, inboxPullRepoKey, type InboxComposeLaunch, type InboxComposeProject, type InboxPull, type InboxPullStack, type InboxReviewRow } from '@plannotator/core/inbox-types';
import { InboxApiError, InboxHeldError, inboxApi } from '../api';
import { machineOf } from '../inboxUrl';
import { newUuid } from '../uuid';
import { shipsOf, startShip, useShipTakers, type ShipTo } from '../data/ships';
import { useComposeSessions } from '../compose/useComposeSessions';
import { useMachineLaunches } from '../compose/useMachineLaunches';
import { pullThreadDefault, pullThreadOptions, type PullThreadOption } from './threadTo';
import { REVIEW_KEY_REUSE_MS } from '../prs/reviewStarts';

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

/** One agent row of Ship's list, on the computer it runs on. */
export interface ShipOption extends PullThreadOption {
  /** The computer the agent is on: null for this one. */
  machine: string | null;
  /** Unique across computers; the review thread's computer's rows keep their session id. */
  id: string;
  /** Its computer's name, heading its group; null for the review thread's computer. */
  group: string | null;
}

/** A row (or a stack's layer) about exactly one open pull request: what its Ship ships. Several: none (one PR per ship). */
export function shipTarget(row: InboxReviewRow, pulls: readonly InboxPull[], repoProjects: Readonly<Record<string, string[]>>): ShipTarget | null {
  if (pulls.length !== 1) return null;
  const pull = pulls[0]!;
  // A forge whose pull request state the Inbox can't read never ships (its watch would read nothing).
  if (!inboxPullIsOpen(pull) || !shipForge(pull.platform)) return null;
  const stack = row.stacks.find((s) => s.layers.some((l) => l.key === pull.key)) ?? null;
  if (!stack) return null;
  const link = row.link && (row.thread_id === null || row.link.thread_id === row.thread_id) ? row.link : null;
  const threadId = row.thread_id ?? link?.thread_id ?? null;
  const machine = threadId ? machineOf(threadId) : null;
  const live = link?.agent && link.agent.session && link.agent.host && !link.agent.ended ? link.agent : null;
  // A linked machine's thread: its own projects (its ships read says them, `shipAgentGroups`), not this computer's.
  const projects = link?.project_id ? [link.project_id] : machine ? [] : (repoProjects[inboxPullRepoKey(pull.host, pull.repo)] ?? []);
  return { pull, stack, threadId, machine, projects, agent: live ? { host: live.host!, session: live.session!, name: live.name } : null };
}

type SessionsModel = { projects: readonly InboxComposeProject[]; launch?: InboxComposeLaunch | null };

/** Another computer's agents for the PR: its sessions read, its projects on the PR's repository, its name. */
export interface ShipAgentGroup {
  machine: string | null;
  name: string;
  model: SessionsModel | null;
  projects: readonly string[];
}

const asOption = (option: PullThreadOption, machine: string | null, group: string | null): ShipOption => ({ ...option, machine, group, id: group === null ? option.row.session : `${machine ?? 'here'}|${option.row.session}` });

/**
 * The agent rows of Ship's list, and the one it starts on (the agent on the review, else New review's choice): the
 * review thread's computer's live agents, then each other computer's agents under its name, then the thread's
 * computer's "New … session" rows (approved shot 3).
 */
export function shipOptions(model: SessionsModel | null, target: ShipTarget | null, others: readonly ShipAgentGroup[] = []): { options: ShipOption[]; chosen: string | null } {
  if (!target) return { options: [], chosen: null };
  const listed = pullThreadOptions(model, target.projects);
  const agent = target.agent;
  if (agent && !listed.some((o) => o.row.session === agent.session)) {
    const label = agent.name ?? 'Agent';
    listed.unshift({ row: { session: agent.session, host: agent.host, label, short: label, state: 'live' }, to: { host: agent.host, session: agent.session }, project: target.projects[0] ?? '', projectName: '' });
  }
  const home = listed.map((option) => asOption(option, target.machine, null));
  const far = others.filter((group) => group.machine !== target.machine).flatMap((group) => pullThreadOptions(group.model, group.projects).map((option) => asOption(option, group.machine, group.name)));
  const options = [...home.filter((o) => !o.row.start), ...far, ...home.filter((o) => o.row.start)];
  return { options, chosen: agent?.session ?? pullThreadDefault(model, target.projects, listed) };
}

/**
 * Ship's list while `active` (its menu or sheet is open): this computer's live sessions and each online linked
 * computer's that takes ships (read as New message reads them, every few seconds while open, nothing while closed),
 * each with its projects on the PR's repository (`projectsOf`: the Reviews answer's here, its ships read's there).
 */
export function useShipAgents(target: ShipTarget | null, active: boolean, projectsOf: (machine: string | null) => Readonly<Record<string, string[]>>) {
  const on = active && !!target;
  const { model: here } = useComposeSessions(on);
  const { machines, reads } = useMachineLaunches(on, null);
  const shipTakers = useShipTakers();
  return useMemo(() => {
    if (!target) return shipOptions(null, null);
    const repo = inboxPullRepoKey(target.pull.host, target.pull.repo);
    const takers = new Set(shipTakers);
    const groups: ShipAgentGroup[] = [];
    if (target.machine) groups.push({ machine: null, name: machines.find((m) => m.self)?.name ?? 'This computer', model: here, projects: projectsOf(null)[repo] ?? [] });
    for (const m of machines) {
      if (m.self || m.state !== 'online' || !takers.has(m.id)) continue;
      const read = reads.get(m.id);
      groups.push({ machine: m.id, name: m.name, model: read ? { projects: read.projects ?? [], launch: read.launch ?? null } : null, projects: projectsOf(m.id)[repo] ?? [] });
    }
    const home = target.machine ? (groups.find((g) => g.machine === target.machine)?.model ?? null) : here;
    const homeTarget = target.projects.length > 0 || !target.machine ? target : { ...target, projects: projectsOf(target.machine)[repo] ?? [] };
    return shipOptions(home, homeTarget, groups);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [here, machines, reads, target, projectsOf, shipTakers]);
}

/** The projects by repository a computer's ships read said (data/ships.ts); this computer's from `local`. */
export function shipProjectsOf(local: Readonly<Record<string, string[]>>) {
  return (machine: string | null): Readonly<Record<string, string[]>> => (machine ? (shipsOf(machine)?.projects ?? {}) : local);
}

const whyOf = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);

/**
 * The new thread's start of a Ship that did not come back (no answer in time, the network gone), by computer, PR and
 * agent, in memory while the window is open: a press again sends that exact start (its key, body and name), so the
 * Inbox answers the thread it started and never starts a second thread or agent. Forgotten once it started, or was
 * refused or held and cancelled (nothing started: a press again is a new start), and once `REVIEW_KEY_REUSE_MS` old
 * (as Start review thread's key): a Ship pressed much later is a new one.
 */
const shipStarts = new Map<string, { key: string; body: string; name: string; at: number }>();

/**
 * Ship it with `option`: in the review's thread when the agent is on that thread's computer, else in a new thread on
 * the agent's computer. Answers the thread it ships in. `machineName`: the agent's computer's name, for its errors.
 */
export async function shipPull(target: ShipTarget, option: ShipOption, machineName: string | null = null): Promise<string> {
  const to = option.to as ShipTo;
  const there = option.machine;
  if (target.threadId && there === target.machine) {
    await startShip({ key: target.pull.key, thread_id: target.threadId, to }, there);
    return target.threadId;
  }
  const keys = [target.pull.key];
  // Taken meanwhile on that computer (another window's Start a thread, a hand-off): it ships in that thread. A
  // computer whose list does not have the PR yet says so; the ship goes on (it reads the PR itself).
  let owner: string | null = null;
  let tie = true;
  try {
    owner = (await inboxApi.pullOwnerCheck(keys, option.project, there)).owner ?? null;
  } catch (cause) {
    if (cause instanceof InboxApiError && cause.code === 'device_route_not_found') throw new Error(`${machineName ?? 'The other computer'} needs an update to ship.`);
    tie = false;
  }
  if (owner) {
    await startShip({ key: target.pull.key, thread_id: owner, to }, there);
    return owner;
  }
  const one = { ...target.stack, layers: [target.pull] };
  const series = `${there ?? ''}\u0000${target.pull.key}\u0000${JSON.stringify(option.to)}`;
  const kept = shipStarts.get(series);
  const start = kept && Date.now() - kept.at < REVIEW_KEY_REUSE_MS ? kept : { key: newUuid(), body: shipMessage(target.pull), name: pullHandoffThreadName(one, null), at: Date.now() };
  shipStarts.set(series, start);
  let thread: Awaited<ReturnType<typeof inboxApi.startThread>>;
  try {
    thread = await inboxApi.startThread(
      {
        to: option.to,
        body: start.body,
        idempotency_key: start.key,
        thread_name: start.name,
        thread_name_auto: true,
        thread_name_numbered: true,
      },
      there,
    );
  } catch (cause) {
    if (!(cause instanceof InboxHeldError)) {
      if (cause instanceof InboxApiError && cause.status >= 400 && cause.status < 500) shipStarts.delete(series);
      throw cause;
    }
    // Never held: a ship that starts days later, when nobody is looking, is not what was pressed.
    const name = cause.machine?.name ?? machineName ?? 'The other computer';
    try {
      await inboxApi.cancelOutbox(cause.outbox.key);
    } catch (late) {
      throw new Error(whyOf(late, `${name} took it late.`));
    }
    shipStarts.delete(series);
    throw new Error(`${name} cannot be reached now.`);
  }
  shipStarts.delete(series);
  if (tie) await inboxApi.pullOwner(keys, thread.thread_id, 'thread', there).catch(() => {});
  await startShip({ key: target.pull.key, thread_id: thread.thread_id, started: true, ...('session' in to ? { to } : {}) }, there);
  return thread.thread_id;
}
