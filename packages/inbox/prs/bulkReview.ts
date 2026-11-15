/**
 * Start review thread on the Pull requests board (approval "inbox-pr-board-bulk": one thread per repository, and
 * "do what can be done, say plainly what could not"). Which picks go to which new thread, which already have one, and
 * the words of the bar and the report. Pure: SheetPage asks it, the tests table it; startReviews.ts starts them.
 */
import { INBOX_PULL_OWNER_KEYS_MAX, inboxPullLabel, inboxPullRepoKey, type InboxPull, type InboxPullLink } from '@plannotator/core/inbox-types';
import { linkAgentName } from '../pulls/model';

/** One new review thread: a repository's picks on the machine whose list has them, and that repository's projects. */
export interface ReviewGroup {
  key: string;
  label: string;
  machine: string | null;
  pulls: InboxPull[];
  projects: readonly string[];
}

/** A pick that has a review thread already: linked to it, never given a second. */
export interface ReviewAlready {
  pull: InboxPull;
  threadId: string;
  agent: string | null;
}

/** Picks that could not go, with why, said after their numbers. */
export interface ReviewFailed {
  pulls: InboxPull[];
  why: string;
}

export interface ReviewPlan {
  groups: ReviewGroup[];
  already: ReviewAlready[];
  failed: ReviewFailed[];
}

/** How a run ended: the threads it started (each with why its PRs were not tied to it, when they were not), and the rest. */
export interface ReviewReport {
  started: { group: ReviewGroup; threadId: string; launch: string | null; untied: string | null }[];
  already: ReviewAlready[];
  failed: ReviewFailed[];
}

/**
 * The picks, split: a PR with a live review thread (the list's link, or one started here before
 * the list says so) is linked to it; the others go one thread per repository and machine, in a repository that is an
 * Inbox project, lowest number first (the linked ones too), and at most `INBOX_PULL_OWNER_KEYS_MAX` to a thread (the owner route's limit).
 */
export function reviewPlan(
  picks: readonly InboxPull[],
  links: Readonly<Record<string, InboxPullLink>>,
  startedHere: ReadonlyMap<string, string>,
  projects: Readonly<Record<string, readonly string[]>>,
  labelOf: (repoKey: string) => string,
): ReviewPlan {
  const already: ReviewAlready[] = [];
  const byGroup = new Map<string, ReviewGroup>();
  for (const pull of picks) {
    const link = links[pull.key];
    const here = startedHere.get(pull.key);
    if (link && link.agent?.ended !== true) {
      already.push({ pull, threadId: link.thread_id, agent: linkAgentName(link) });
      continue;
    }
    if (here) {
      already.push({ pull, threadId: here, agent: null });
      continue;
    }
    const repo = inboxPullRepoKey(pull.host, pull.repo);
    const key = `${pull.machine ?? ''}\n${repo}`;
    const group = byGroup.get(key) ?? { key, label: labelOf(repo), machine: pull.machine ?? null, pulls: [], projects: projects[repo] ?? [] };
    group.pulls.push(pull);
    byGroup.set(key, group);
  }
  const groups: ReviewGroup[] = [];
  const failed: ReviewFailed[] = [];
  for (const group of byGroup.values()) {
    group.pulls.sort((x, y) => x.number - y.number);
    if (group.projects.length === 0) failed.push({ pulls: group.pulls, why: `${group.label} is not a project.` });
    else if (group.pulls.length > INBOX_PULL_OWNER_KEYS_MAX) {
      groups.push({ ...group, pulls: group.pulls.slice(0, INBOX_PULL_OWNER_KEYS_MAX) });
      failed.push({ pulls: group.pulls.slice(INBOX_PULL_OWNER_KEYS_MAX), why: `one review thread takes at most ${INBOX_PULL_OWNER_KEYS_MAX}.` });
    } else groups.push(group);
  }
  already.sort((x, y) => x.pull.number - y.pull.number);
  return { groups, already, failed };
}

/** The bar's button: "Start review thread", or "Start 2 review threads" when the picks are in two repositories. */
export function startButtonWords(threads: number): string {
  return threads > 1 ? `Start ${threads} review threads` : 'Start review thread';
}

/** "Starting 1 of 2…" while the threads start, one after another. */
export function startingWords(done: number, total: number): string {
  return `Starting ${done} of ${total}…`;
}

/** "Started 2 reviews": a phone's heading row over its threads' rows. */
export function startedHeading(count: number): string {
  return `Started ${count} ${count === 1 ? 'review' : 'reviews'}`;
}

/** "Started 2 reviews: " before each thread's part. */
export function startedLead(count: number): string {
  return `${startedHeading(count)}: `;
}

/** A started thread's part, its link: "ledger (3 PRs)", GitLab's "web (1 MR)". */
export function groupPart(group: Pick<ReviewGroup, 'label' | 'pulls'>): string {
  const n = group.pulls.length;
  const noun = group.pulls[0]?.platform === 'gitlab' ? 'MR' : 'PR';
  return `${group.label} (${n} ${noun}${n === 1 ? '' : 's'})`;
}

export const ALREADY_HEADING = 'Already in review';
export const ALREADY_LEAD = `${ALREADY_HEADING}: `;

/** A pick that has its thread already, its link: "#1198 with Codex", or "#1198" when the thread's agent isn't known. */
export function alreadyPart(already: ReviewAlready): string {
  return `${inboxPullLabel(already.pull)}${already.agent ? ` with ${already.agent}` : ''}`;
}

/** "#5, #7 Not started: Mac mini cannot be reached now." */
export function notStartedLine(failed: ReviewFailed): string {
  return `${failed.pulls.map(inboxPullLabel).join(', ')} Not started: ${failed.why}`;
}

/** A thread that started whose PRs the Inbox could not keep for it: "#5, #7 Not tied to its thread: <why>". */
export function untiedLine(pulls: readonly InboxPull[], why: string): string {
  return `${pulls.map(inboxPullLabel).join(', ')} Not tied to its thread: ${why}`;
}

/** Why no thread could start in a repository: no agent free there to take it, and none this Inbox can start. */
export const noAgentWhy = (label: string) => `no agent can start in ${label}.`;

/** The toast after a run that started only new agents ("Started 2 reviews", with Stop), and after its Stop. */
export const startedToast = startedHeading;
export function stoppedToast(count: number): string {
  return `Stopped ${count}`;
}
