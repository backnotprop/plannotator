import type { InboxPull, InboxPullStack, InboxReviewChanges, InboxReviewChangesAnswer, InboxReviewRow, InboxReviewsAnswer } from '@plannotator/core/inbox-types';
import { handoffStack, inboxPullLabel, openLayers, stackProjects, stackTitle } from '../pulls/model';

/**
 * New review (approval "inbox-reviews-page", DESIGN r2 section 2): the New message dialog with rows above To. This is
 * what those rows choose and the words a choice sends. Local words are general on purpose: how to curate is the
 * /review-curate skill's.
 */

/** What the box's Review row says it reviews. */
export type ReviewKind = 'local' | 'pr';

/** How the read behind the box's pull requests went. */
export type ReviewPullsRead = 'reading' | 'read' | 'failed';

/** What the box reviews: `pick` fills it in, from a pull request's own page. */
export interface ReviewBoxRequest {
  pick?: ReviewBoxPull | null;
}

/**
 * The words in the box and a thread name typed there, kept in memory when it closes without starting, as the Feedback
 * dialog keeps its own. Opened again, they are there. Cleared once a review starts.
 */
const NOTHING_TYPED = { body: '', threadName: null as string | null, kind: 'local' as ReviewKind, pick: null as ReviewBoxPull | null };
let unsent = NOTHING_TYPED;
/**
 * What comes back when the box opens, through `door`: the PR whose page opened it, if any. Words go only to what they
 * were written for: another PR's door opens empty. The plain door reopens the same box, on what it was on.
 */
export const unsentReview = (door?: ReviewBoxPull | null): typeof NOTHING_TYPED => {
  if (door ? unsent.pick?.id !== door.id : !unsent.body.trim() && !unsent.threadName) return NOTHING_TYPED;
  return unsent;
};
export const keepUnsentReview = (typed: typeof NOTHING_TYPED) => {
  unsent = typed;
};
export const forgetUnsentReview = () => {
  unsent = NOTHING_TYPED;
};

/** A pull request the box offers. */
export interface ReviewBoxPull {
  /** The stack's id. */
  id: string;
  /** What a new review is of: the PR, or a stack's chain (`handoffStack`). */
  stack: InboxPullStack;
  label: string;
  title: string;
  /** The Inbox projects its repository is: To offers only these. */
  projects: readonly string[];
  /** It has a review thread: picking it opens that, so a PR never gets a second one. */
  thread: { id: string; agent: string | null } | null;
  /** The first project's name, as the picker shows it. */
  project: string | null;
}

const labelOf = (stack: InboxPullStack, open: readonly InboxPull[]): string => {
  if (open.length <= 1) return open[0] ? inboxPullLabel(open[0]) : inboxPullLabel(stack.layers[stack.layers.length - 1]!);
  return `${inboxPullLabel(open[0]!)} to ${inboxPullLabel(open[open.length - 1]!)}`;
};

/** One row's stacks as the picker lists them: not reviewed first, then the ones already in a review. */
export function reviewBoxPulls(answer: InboxReviewsAnswer | null, projectNames: ReadonlyMap<string, string>): ReviewBoxPull[] {
  if (!answer) return [];
  const links = Object.fromEntries(answer.rows.flatMap((row) => (row.link ? row.pull_keys.map((key) => [key, row.link!] as const) : [])));
  const out: ReviewBoxPull[] = [];
  const seen = new Set<string>();
  for (const row of answer.rows) {
    for (const stack of row.stacks) {
      if (seen.has(stack.id) || openLayers(stack).length === 0) continue;
      seen.add(stack.id);
      const projects = stackProjects({ projects: answer.projects }, stack);
      // A PR of a repository that is no project: nowhere to review it from this list (Pull request link takes it).
      if (projects.length === 0) continue;
      const pull = reviewBoxPull(stack, row, links, projects);
      out.push({ ...pull, project: projectNames.get(projects[0]!) ?? null });
    }
  }
  return [...out.filter((pull) => !pull.thread), ...out.filter((pull) => pull.thread)];
}

/** A stack as the box takes it. An agent that ended left no thread to go back to: a new one can start. */
export function reviewBoxPull(stack: InboxPullStack, row: Pick<InboxReviewRow, 'reviewed' | 'thread_id' | 'link' | 'review'>, links: Parameters<typeof handoffStack>[1], projects: readonly string[]): ReviewBoxPull {
  const ended = row.link?.agent?.ended === true;
  // In review as the page says it: a thread that only named the PR, or was archived before its review, isn't.
  const inReview = row.reviewed && !!row.thread_id && !ended;
  const handed = (row.link ? handoffStack(stack, links, row.link.thread_id) : null) ?? handoffStack(stack, links) ?? stack;
  return {
    id: stack.id,
    stack: handed,
    label: labelOf(handed, openLayers(handed)),
    title: stackTitle(handed, links),
    projects,
    thread: inReview ? { id: row.thread_id!, agent: row.review?.agent?.name ?? row.link?.agent?.name ?? null } : null,
    project: null,
  };
}

const CHANGES_WORDS: Record<InboxReviewChanges, string> = {
  uncommitted: 'the uncommitted changes',
  last: 'the last commit',
  branch: 'the whole branch',
};

/** The hand-off for local changes. The person's words sit with the ask; the second line is what feedback means here. */
export function localReviewMessage(input: { changes: InboxReviewChanges; project: string | null; branch: string | null; base: string | null; words: string }): string {
  const where = input.project ? ` in ${input.project}` : '';
  const on = input.branch ? (input.changes === 'branch' && input.base ? ` (${input.branch}, against ${input.base})` : ` (on ${input.branch})`) : '';
  const words = input.words.trim();
  return [`Please send me a guided review of ${CHANGES_WORDS[input.changes]}${where}${on}, using /review-curate.`, words, 'If I ask for changes, make them and send me the updated review in this thread.']
    .filter(Boolean)
    .join('\n\n');
}

/** The thread's suggested name: "Review web-app: uncommitted on main". */
export function localReviewName(changes: InboxReviewChanges, project: string | null, branch: string | null, base: string | null): string {
  const what = changes === 'uncommitted' ? 'uncommitted' : changes === 'last' ? 'last commit' : 'whole branch';
  const on = branch ? (changes === 'branch' && base ? ` ${branch} against ${base}` : ` on ${branch}`) : '';
  const named = changes === 'branch' && on ? on.trim() : `${what}${on}`;
  return project ? `Review ${project}: ${named}` : `Review: ${named}`;
}

/** Who To names when the box opens: the current project's agent, the one last sent to, any live one; else a new session. */
export function reviewDefaultTo(
  targets: readonly { session: string; project: { id: string | null } }[],
  launch: { agents: readonly { agent: string }[]; projects: readonly { id: string; exists?: boolean }[] } | null | undefined,
  current: string | null,
  lastSent: string | null,
): { session: string } | { agent: string; projectId: string } | null {
  const live = targets.find((t) => current && t.project.id === current) ?? targets.find((t) => t.session === lastSent) ?? targets[0];
  if (live) return { session: live.session };
  const agent = launch?.agents[0];
  const project = launch?.projects.find((p) => p.id === current) ?? launch?.projects[0];
  return agent && project ? { agent: agent.agent, projectId: project.id } : null;
}

/**
 * Local changes, when the agent To was filled in with has none to review: another live agent whose project has some,
 * the one last sent to first, else in list order. `files`: each project's changed files for the chosen kind (a project
 * missing from it was not read). Null when no other project has changes.
 */
export function reviewToWithChanges(targets: readonly { session: string; project: { id: string | null } }[], files: ReadonlyMap<string, number>, lastSent: string | null): string | null {
  const has = (t: { project: { id: string | null } }) => !!t.project.id && (files.get(t.project.id) ?? 0) > 0;
  return (targets.find((t) => t.session === lastSent && has(t)) ?? targets.find(has))?.session ?? null;
}

/** The change summary, once read. */
export type ReviewSummary = InboxReviewChangesAnswer | null;
