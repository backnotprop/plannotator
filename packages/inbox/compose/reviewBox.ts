import { inboxPullStacks, type InboxPull, type InboxPullStack, type InboxReviewChanges, type InboxReviewChangesAnswer, type InboxReviewLinkAnswer, type InboxReviewRow, type InboxReviewsAnswer } from '@plannotator/core/inbox-types';
import { handoffStack, inboxPullLabel, openLayers, stackProjects, stackTitle } from '../pulls/model';

/**
 * New review (approval "inbox-reviews-page", DESIGN r2 section 2): the New message dialog with rows above To. This is
 * what those rows choose and the words a choice sends. Local words are general on purpose: how to curate is the
 * /review-curate skill's.
 */

/** What the box's Review row says it reviews. */
export type ReviewKind = 'local' | 'pr' | 'walkthrough';

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
const NOTHING_TYPED = { body: '', threadName: null as string | null, kind: 'local' as ReviewKind, pick: null as ReviewBoxPull | null, link: '' };
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

/** A link's PR when the picker lists it too: it then goes the picker's way. */
export function reviewLinkListed(link: Extract<InboxReviewLinkAnswer, { ok: true }>, pulls: readonly ReviewBoxPull[]): ReviewBoxPull | null {
  const key = link.pull.key.toLowerCase();
  return pulls.find((pull) => pull.stack.layers.some((layer) => layer.key.toLowerCase() === key)) ?? null;
}

/** A link's PR as the hand-off takes it. A merged or closed one can still be read, so it asks the same. */
export function reviewLinkStack(pull: InboxPull): InboxPullStack {
  return inboxPullStacks([{ ...pull, state: 'open' }])[0]!;
}

/** The line under the Link field: how it was read, or why it wasn't. */
export function reviewLinkWords(link: InboxReviewLinkAnswer): string {
  if (link.ok) return `Read with ${link.cli}, signed in to ${link.pull.host}`;
  if (link.reason === 'unreadable') return `${link.cli} couldn't read it. Check the link, and that ${link.cli} is signed in to ${link.host}.`;
  if (link.reason === 'bitbucket') return "Bitbucket links aren't supported yet.";
  return link.reason === 'host' ? "Plannotator can't read that host yet." : "That isn't a pull request link.";
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

/** The hand-off for a walkthrough: the person's words say what, and come first, so a row's preview shows them. */
export function walkthroughMessage(words: string): string {
  return [words.trim(), 'Please walk me through this, using /review-walkthrough. Don\'t change any code.'].join('\n\n');
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
  /** A PR in none of the person's projects: a new session in this scratch pick, where launching can. */
  scratch?: string,
): { session: string } | { agent: string; projectId: string } | null {
  if (scratch && launch?.agents[0]) return { agent: launch.agents[0].agent, projectId: scratch };
  const live = targets.find((t) => current && t.project.id === current) ?? targets.find((t) => t.session === lastSent) ?? targets[0];
  if (live) return { session: live.session };
  const agent = launch?.agents[0];
  const project = launch?.projects.find((p) => p.id === current) ?? launch?.projects[0];
  return agent && project ? { agent: agent.agent, projectId: project.id } : null;
}

/** The change summary, once read. */
export type ReviewSummary = InboxReviewChangesAnswer | null;
