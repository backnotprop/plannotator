import { inboxPullStacks, type InboxPull, type InboxPullStack, type InboxReviewChanges, type InboxReviewChangesAnswer, type InboxReviewLinkAnswer, type InboxReviewRow, type InboxReviewsAnswer } from '@plannotator/core/inbox-types';
import { handoffStack, inboxPullLabel, openLayers, stackProjects, stackTitle } from '../pulls/model';

export type ReviewKind = 'local' | 'pr' | 'walkthrough';

export type ReviewPullsRead = 'reading' | 'read' | 'failed';

export interface ReviewBoxRequest {
  pick?: ReviewBoxPull | null;
}

const NOTHING_TYPED = { body: '', threadName: null as string | null, kind: 'local' as ReviewKind, pick: null as ReviewBoxPull | null, link: '' };
let unsent = NOTHING_TYPED;
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

export interface ReviewBoxPull {
  id: string;
  stack: InboxPullStack;
  label: string;
  title: string;
  projects: readonly string[];
  thread: { id: string; agent: string | null } | null;
  project: string | null;
}

const labelOf = (stack: InboxPullStack, open: readonly InboxPull[]): string => {
  if (open.length <= 1) return open[0] ? inboxPullLabel(open[0]) : inboxPullLabel(stack.layers[stack.layers.length - 1]!);
  return `${inboxPullLabel(open[0]!)} to ${inboxPullLabel(open[open.length - 1]!)}`;
};

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
      if (projects.length === 0) continue;
      const pull = reviewBoxPull(stack, row, links, projects);
      out.push({ ...pull, project: projectNames.get(projects[0]!) ?? null });
    }
  }
  return [...out.filter((pull) => !pull.thread), ...out.filter((pull) => pull.thread)];
}

export function reviewBoxPull(stack: InboxPullStack, row: Pick<InboxReviewRow, 'reviewed' | 'thread_id' | 'link' | 'review'>, links: Parameters<typeof handoffStack>[1], projects: readonly string[]): ReviewBoxPull {
  const ended = row.link?.agent?.ended === true;
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

export function reviewLinkListed(link: Extract<InboxReviewLinkAnswer, { ok: true }>, pulls: readonly ReviewBoxPull[]): ReviewBoxPull | null {
  const key = link.pull.key.toLowerCase();
  return pulls.find((pull) => openLayers(pull.stack).some((layer) => layer.key.toLowerCase() === key)) ?? null;
}

export function reviewLinkStack(pull: InboxPull): InboxPullStack {
  const stack = inboxPullStacks([{ ...pull, state: 'open' }])[0]!;
  return { ...stack, layers: stack.layers.map((layer) => ({ ...layer, state: pull.state })) };
}

export function reviewLinkWords(link: InboxReviewLinkAnswer): string {
  if (link.ok) return `Read with ${link.cli}, signed in to ${link.pull.host}`;
  if (link.reason === 'unreadable') return `${link.cli} couldn't read it. Check the link, and that ${link.cli} is signed in to ${link.host}.`;
  if (link.reason === 'bitbucket') return "Bitbucket links aren't supported yet.";
  if (link.reason === 'failed') return "Couldn't check that link. Try again.";
  return link.reason === 'host' ? "Plannotator can't read that host yet." : "That isn't a pull request link.";
}

const CHANGES_WORDS: Record<InboxReviewChanges, string> = {
  uncommitted: 'the uncommitted changes',
  last: 'the last commit',
  branch: 'the whole branch',
};

export function localReviewMessage(input: { changes: InboxReviewChanges; project: string | null; branch: string | null; base: string | null; words: string }): string {
  const where = input.project ? ` in ${input.project}` : '';
  const on = input.branch ? (input.changes === 'branch' && input.base ? ` (${input.branch}, against ${input.base})` : ` (on ${input.branch})`) : '';
  const words = input.words.trim();
  return [`Please send me a guided review of ${CHANGES_WORDS[input.changes]}${where}${on}, using /review-curate.`, words, 'If I ask for changes, make them and send me the updated review in this thread.']
    .filter(Boolean)
    .join('\n\n');
}

export function walkthroughMessage(words: string): string {
  return [words.trim(), 'Please walk me through this, using /review-walkthrough. Don\'t change any code.'].join('\n\n');
}

export function localReviewName(changes: InboxReviewChanges, project: string | null, branch: string | null, base: string | null): string {
  const what = changes === 'uncommitted' ? 'uncommitted' : changes === 'last' ? 'last commit' : 'whole branch';
  const on = branch ? (changes === 'branch' && base ? ` ${branch} against ${base}` : ` on ${branch}`) : '';
  const named = changes === 'branch' && on ? on.trim() : `${what}${on}`;
  return project ? `Review ${project}: ${named}` : `Review: ${named}`;
}

export function reviewDefaultTo(
  targets: readonly { session: string; project: { id: string | null } }[],
  launch: { agents: readonly { agent: string }[]; projects: readonly { id: string; exists?: boolean }[] } | null | undefined,
  current: string | null,
  lastSent: string | null,
  scratch?: string,
): { session: string } | { agent: string; projectId: string } | null {
  if (scratch && launch?.agents[0]) return { agent: launch.agents[0].agent, projectId: scratch };
  const live = targets.find((t) => current && t.project.id === current) ?? targets.find((t) => t.session === lastSent) ?? targets[0];
  if (live) return { session: live.session };
  const agent = launch?.agents[0];
  const project = launch?.projects.find((p) => p.id === current) ?? launch?.projects[0];
  return agent && project ? { agent: agent.agent, projectId: project.id } : null;
}

export function reviewToWithChanges(targets: readonly { session: string; project: { id: string | null } }[], files: ReadonlyMap<string, number>, lastSent: string | null): string | null {
  const has = (t: { project: { id: string | null } }) => !!t.project.id && (files.get(t.project.id) ?? 0) > 0;
  return (targets.find((t) => t.session === lastSent && has(t)) ?? targets.find(has))?.session ?? null;
}

export type ReviewSummary = InboxReviewChangesAnswer | null;
