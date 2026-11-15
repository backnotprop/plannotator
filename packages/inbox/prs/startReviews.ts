/**
 * Start one review thread for a group of the board's picks (bulkReview.ts), on the machine whose list has them: its
 * agents, its projects, its checkout. The same steps as New review's Start for one PR, without the box: To is what
 * that box fills in (`reviewDefaultTo`: a live agent of the repository's project, else a new one where that machine
 * can start one) passed over an agent that is working; the PRs are checked with that project first, then the thread
 * starts, then the PRs are kept as its own (`pulls/owner`). One PR gets today's message and name; several get
 * `pullsHandoffMessage`. A linked machine's thread goes through the forward and is never held: an asleep machine, or
 * one that does not take it now, starts nothing. The Send's key and an untied thread are kept (reviewStarts.ts), so a
 * press again replays a Send that went late and never starts a second thread for PRs whose tie failed.
 */
import { inboxMachineLaunchWords } from '@plannotator/core/inbox-launch-ready';
import { inboxPullStacks } from '@plannotator/core/inbox-types';
import { InboxApiError, InboxHeldError, inboxApi } from '../api';
import { composeTargets } from '../compose/model';
import { reviewDefaultTo } from '../compose/reviewBox';
import { pullHandoffMessage, pullHandoffThreadName } from '../pulls/model';
import { pullsHandoffMessage, pullsHandoffThreadName } from '../pulls/manyHandoff';
import { INBOX_MESSAGE_SKILL_AUDIENCE, inboxSkillsBlock, withSkillsBlock } from '../skills';
import { newUuid } from '../uuid';
import { noAgentWhy, type ReviewGroup, type ReviewReport } from './bulkReview';
import { forgetSend, noteStarted, noteTied, sendKeyFor, untiedStarts } from './reviewStarts';

export type ReviewOutcome = ReviewReport['started'][number] | { group: ReviewGroup; why: string };

const whyOf = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);

/** `machineName`: the linked machine's name, for a machine whose Plannotator has no `pulls/owner` door route yet. */
export async function startReview(group: ReviewGroup, machineName: string | null = null): Promise<ReviewOutcome> {
  const { machine } = group;
  const keys = group.pulls.map((pull) => pull.key);
  let to: { host: string; session: string } | { launch: { agent: string; project_id: string } };
  let project: string;
  try {
    const model = await inboxApi.composeSessions(null, null, machine);
    const projects = model.projects.filter((g) => g.project.id !== null && group.projects.includes(g.project.id));
    const free = composeTargets(projects).filter((target) => target.busy !== true);
    const launch = model.launch ? { agents: model.launch.agents, projects: model.launch.projects.filter((p) => p.exists && group.projects.includes(p.id)) } : null;
    const pick = reviewDefaultTo(free, launch, null, null);
    if (!pick) return { group, why: noAgentWhy(group.label) };
    if ('session' in pick) {
      const target = free.find((t) => t.session === pick.session)!;
      to = { host: target.host, session: target.session };
      project = target.project.id!;
    } else {
      to = { launch: { agent: pick.agent, project_id: pick.projectId } };
      project = pick.projectId;
    }
    await inboxApi.pullOwnerCheck(keys, project, machine);
  } catch (cause) {
    // An older Plannotator there has no such door route.
    if (cause instanceof InboxApiError && cause.code === 'device_route_not_found') return { group, why: `${inboxMachineLaunchWords(machineName ?? 'the other machine', 'update')}.` };
    return { group, why: whyOf(cause, 'It didn’t go.') };
  }
  const send = sendKeyFor(machine, keys, newUuid);
  const one = group.pulls.length === 1 ? inboxPullStacks(group.pulls)[0]! : null;
  const words = one ? pullHandoffMessage(one) : pullsHandoffMessage(group.pulls);
  const skills = await inboxSkillsBlock([words], INBOX_MESSAGE_SKILL_AUDIENCE);
  let started: Awaited<ReturnType<typeof inboxApi.startThread>>;
  try {
    started = await inboxApi.startThread(
      {
        to: to as Parameters<typeof inboxApi.startThread>[0]['to'],
        body: skills ? withSkillsBlock(words, skills) : words,
        idempotency_key: send,
        thread_name: one ? pullHandoffThreadName(one, null) : pullsHandoffThreadName(group.pulls),
        thread_name_auto: true,
        thread_name_numbered: true,
      },
      machine,
    );
  } catch (cause) {
    if (cause instanceof InboxHeldError) {
      // Never held: a review that starts days later, when nobody is looking, is not what was pressed.
      const name = cause.machine?.name ?? 'The other machine';
      try {
        await inboxApi.cancelOutbox(cause.outbox.key);
      } catch (late) {
        return { group, why: whyOf(late, `${name} took it late.`) };
      }
      forgetSend(send);
      return { group, why: `${name} cannot be reached now.` };
    }
    return { group, why: whyOf(cause, 'It didn’t go.') };
  }
  const launch = 'launch' in to && started.launch?.state !== 'failed' ? (started.launch?.id ?? null) : null;
  try {
    await inboxApi.pullOwner(keys, started.thread_id, 'guide', machine);
    noteStarted(send, started.thread_id, false);
    return { group, threadId: started.thread_id, launch, untied: null };
  } catch (cause) {
    noteStarted(send, started.thread_id, true);
    return { group, threadId: started.thread_id, launch, untied: whyOf(cause, 'It didn’t go.') };
  }
}

/** Tie each untied thread's PRs to it again; the threads whose tie held. */
export async function retryTies(): Promise<string[]> {
  const tied: string[] = [];
  for (const start of untiedStarts()) {
    try {
      await inboxApi.pullOwner(start.keys, start.thread!, 'guide', start.machine);
      noteTied(start.thread!);
      tied.push(start.thread!);
    } catch {
      // Tried again on the next press or the board's next open.
    }
  }
  return tied;
}
