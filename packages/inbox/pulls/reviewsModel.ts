/**
 * The Reviews page's rows in the window (approval "inbox-reviews-page", round 2): which rows a filter keeps, and what
 * a row says. The rows themselves are the server's (`GET /api/inbox/reviews`, core's `inboxReviewRows`).
 */
import {
  inboxActionInDraft,
  inboxPullIsOpen,
  inboxPullRepoKey,
  type InboxMessageWire,
  type InboxPull,
  type InboxPullStack,
  type InboxReviewRow,
  type InboxReviewsAnswer,
} from '@plannotator/core/inbox-types';
import { plural } from '@plannotator/core/inbox-format';
import { holdingsOf } from '@plannotator/core/inbox-folding';
import { inboxReviewTitleLine } from '@plannotator/core/inbox-review';
import { checksWords, inboxPullLabel, linkAgentName, openLayers, pullViewOf, type PullFilter } from './model';
import { startLayer } from './topology';
import { hostLabel } from '../compose/model';

/** The rows a project and a view keep: a local review is the person's own, and belongs to its thread's project. */
export function reviewRowsIn(answer: InboxReviewsAnswer, project: string | null, filter: PullFilter): InboxReviewRow[] {
  const inProject = (row: InboxReviewRow) => {
    if (!project) return true;
    if (reviewRowProject(row) === project) return true;
    return row.stacks.some((stack) => (answer.projects[inboxPullRepoKey(stack.host, stack.repo)] ?? []).includes(project));
  };
  const inView = (row: InboxReviewRow) => {
    if (filter === 'all') return true;
    if (row.stacks.length === 0) return filter === 'mine';
    return row.stacks.some((stack) => stack.layers.some((pull) => inboxPullIsOpen(pull) && pullViewOf(pull) === filter));
  };
  return answer.rows.filter((row) => inProject(row) && inView(row));
}

/** The projects a row's filter can offer: the reviews' own, beside the ones with a remote. */
export function reviewRowProjects(answer: InboxReviewsAnswer): Set<string> {
  const ids = new Set(Object.values(answer.projects).flat());
  for (const row of answer.rows) {
    const id = reviewRowProject(row);
    if (id) ids.add(id);
  }
  return ids;
}

/** The project a thread's row is in; null for a PR row. */
export function reviewRowProject(row: InboxReviewRow): string | null {
  return row.review?.project_id ?? row.started?.project_id ?? null;
}

export function reviewRowTitle(row: InboxReviewRow, pullTitle: (stack: InboxPullStack) => string): string {
  const stack = row.stacks[0];
  if (stack) return pullTitle(stack);
  if (row.review) return inboxReviewTitleLine(row.review.title);
  return row.started?.name ?? row.link?.thread_id ?? '';
}

/** A row's third line: what it is, whose agent, and why it is where it is. */
export interface ReviewRowLine {
  kind: 'local' | 'pr' | 'stack';
  lead: string;
  agent: { host: string | null; name: string } | null;
  status: string;
  tone: 'ok' | 'warn' | null;
}

const lower = (words: string) => words.replace(/^./, (c) => c.toLowerCase());

/** The layer a row's words are about: the first that asked the person, else the next to land, else the top. */
function focusOf(stack: InboxPullStack): InboxPull {
  const open = openLayers(stack);
  return open.find((pull) => (pull.requested || pull.assigned) && !pull.mine) ?? startLayer(stack) ?? open[0] ?? stack.layers[stack.layers.length - 1]!;
}

const whose = (pull: InboxPull) => (pull.mine ? 'yours' : (pull.author ?? 'a deleted account'));

/** "yours · checks passed", "tomas · draft": a listed PR's words. */
function listedWords(pull: InboxPull): string {
  const checks = checksWords(pull);
  return [whose(pull), pull.state === 'draft' ? 'draft' : checks ? lower(checks) : null].filter(Boolean).join(' · ');
}

function statusOf(row: InboxReviewRow): { status: string; tone: ReviewRowLine['tone'] } {
  const stack = row.stacks[0];
  const pull = stack ? focusOf(stack) : null;
  const checks = pull ? checksWords(pull) : null;
  switch (row.reason) {
    case 'review_ready':
      return { status: 'Review ready', tone: null };
    case 'curating':
      return { status: 'Curating…', tone: null };
    case 'feedback_sent': {
      const verdict = row.review?.verdict;
      if (verdict?.verdict !== 'changes_requested') return { status: 'You answered', tone: null };
      return { status: verdict.comments > 0 ? `Changes requested · ${plural(verdict.comments, 'comment')}` : 'Changes requested', tone: 'warn' };
    }
    case 'approved':
      return { status: `You approved${checks ? ` · ${lower(checks)}` : ''}`, tone: 'ok' };
    case 'requested':
      return { status: pull?.author ? `${pull.author} asked for your review` : 'Your review was asked for', tone: null };
    case 'assigned':
      return { status: 'assigned to you', tone: null };
    case 'changes':
      return { status: 'Changes requested', tone: 'warn' };
    case 'failing':
      return { status: 'Checks failed', tone: 'warn' };
    case 'checks_running':
      return { status: 'You approved · checks running', tone: null };
    case 'draft':
      return { status: 'You approved · draft', tone: null };
    case 'forge_review': {
      const reviewer = pull?.reviewers[0];
      return { status: reviewer ? `Waiting on ${reviewer}’s review` : 'Waiting on a review', tone: null };
    }
    case 'others':
    case 'not_reviewed':
      return { status: pull ? listedWords(pull) : '', tone: null };
  }
}

export function reviewRowLine(row: InboxReviewRow): ReviewRowLine {
  const stack = row.stacks[0];
  const name = row.review?.agent?.name ?? linkAgentName(row.link) ?? (row.started ? hostLabel(row.started.host) : null);
  const host = row.review?.agent?.host ?? row.link?.agent?.host ?? row.started?.host ?? null;
  const agent = row.reviewed && name ? { host, name } : null;
  const { status, tone } = statusOf(row);
  if (stack) {
    const many = stack.layers.length > 1;
    if (many) {
      const open = openLayers(stack);
      const merged = stack.layers.filter((pull) => pull.state === 'merged').length;
      return { kind: 'stack', lead: `${open.length} open${merged > 0 ? `, ${merged} merged` : ''}`, agent, status, tone };
    }
    return { kind: 'pr', lead: inboxPullLabel(focusOf(stack)), agent, status, tone };
  }
  const landing = row.landed[0];
  if (landing) return { kind: 'pr', lead: `${landing.platform === 'gitlab' ? '!' : '#'}${landing.number} ${landing.state}`, agent, status, tone };
  const source = row.review?.source;
  if (source?.pr?.number) return { kind: 'pr', lead: `${source.pr.platform === 'gitlab' ? '!' : '#'}${source.pr.number}`, agent, status, tone };
  return { kind: 'local', lead: source?.branch ?? row.started?.branch ?? '', agent, status, tone };
}

/** The line over a review thread's title: "charges · Local changes on retry-jitter, against main". */
export function reviewContextLine(row: InboxReviewRow, projectName: string | null): string {
  const source = row.review?.source;
  const line = reviewRowLine(row);
  const started = row.started;
  const what =
    line.kind !== 'local'
      ? line.lead
      : source?.branch
        ? `Local changes on ${source.branch}${source.base ? `, against ${source.base.replace(/^origin\//, '')}` : ''}`
        : started?.branch
          ? started.changes === 'uncommitted'
            ? `Uncommitted changes on ${started.branch}`
            : started.changes === 'last'
              ? `Last commit on ${started.branch}`
              : `Local changes on ${started.branch}${started.base ? `, against ${started.base}` : ''}`
          : 'Local changes';
  return [projectName, what].filter(Boolean).join(' · ');
}

/** What a thread opened from Reviews draws above its messages (ThreadPane's `reviewView`). */
export interface ReviewView {
  context: string;
  /** Local changes, or a PR. */
  kind: 'local' | 'pr';
  /** The review's title, once one arrived. */
  title: string | null;
  /** The first review: the messages before it stay out of this view (`reviewEarlierHidden`). Null when the thread was started for the review. */
  firstReviewId: string | null;
  /** The latest review: open in this view however long ago it was read. */
  latestReviewId: string | null;
  /** An agent is still curating the first review: the thread says so under the request. */
  curating: boolean;
  /** New review's own label on the request: "New review · Guided review". */
  asked: string | null;
  /** The thread the review came from, when it was an ordinary one. */
  fromThread: string | null;
  onWholeThread: () => void;
  /** The PR's own page. */
  onOpenPull: (() => void) | null;
  /** A landed PR, on its forge. */
  pullUrl: string | null;
}

/**
 * The messages before the first review that a thread opened from Reviews leaves out: what has been read and needs
 * nothing. A message new since the last look, or holding an open question, a pick not sent or an open action item,
 * always shows.
 */
/** The message holds something the person still has to act on or send: a question, a pick, an action item, a staged Done. */
function waitsOnPerson(message: InboxMessageWire): boolean {
  if (holdingsOf(message, { delivered: false }).some((holding) => holding.kind === 'open' || holding.kind === 'picks' || holding.kind === 'todo')) return true;
  return (message.actions ?? []).some(inboxActionInDraft);
}

export function reviewEarlierHidden(messages: readonly InboxMessageWire[], firstReviewId: string, fresh: ReadonlySet<string>): string[] {
  const at = messages.findIndex((message) => message.id === firstReviewId);
  if (at <= 0) return [];
  return messages.slice(0, at).filter((message) => !fresh.has(message.id) && !waitsOnPerson(message)).map((message) => message.id);
}

/**
 * How a thread opens from Reviews, worked out once on top of the Inbox's own fold (`planFolds`), so nothing appears or
 * disappears while the person is in it. `left`: what stays out of this view. The latest review, and everything waiting
 * on the person, are open; the first review and everything left over from the runs are drawn. No run names a message
 * that is left out or that has to show, so "N earlier messages" always says what a click shows.
 */
export function reviewOpenPlan(input: {
  messages: readonly InboxMessageWire[];
  firstReviewId: string | null;
  latestReviewId: string | null;
  fresh: ReadonlySet<string>;
  folds: { folded: ReadonlySet<string>; hidden: readonly (readonly string[])[] };
}): { left: string[]; folded: Set<string>; hidden: string[][] } {
  const { messages, firstReviewId, latestReviewId, fresh, folds } = input;
  const left = firstReviewId ? reviewEarlierHidden(messages, firstReviewId, fresh) : [];
  const leftOut = new Set(left);
  const open = new Set(messages.filter((message) => !leftOut.has(message.id) && (waitsOnPerson(message) || fresh.has(message.id))).map((message) => message.id));
  if (latestReviewId) open.add(latestReviewId);
  const shows = new Set(open);
  if (firstReviewId) shows.add(firstReviewId);
  const hidden: string[][] = [];
  for (const run of folds.hidden) {
    let piece: string[] = [];
    for (const id of run) {
      if (leftOut.has(id)) continue;
      if (shows.has(id)) {
        if (piece.length > 0) hidden.push(piece);
        piece = [];
      } else piece.push(id);
    }
    if (piece.length > 0) hidden.push(piece);
  }
  return { left, folded: new Set([...folds.folded].filter((id) => !open.has(id))), hidden };
}

/**
 * A review from an ordinary thread opens at its card with what came before left out (the owner: the same thread, a
 * different view of it). A thread started for the review (a hand-off) opens whole: its one message is the request.
 */
export function reviewViewOf(
  row: InboxReviewRow,
  thread: { messages: readonly { id: string }[]; subject: string | null; thread_name?: string | null },
  options: { projectName: string | null; onWholeThread: () => void; onOpenStack: (stackId: string) => void },
): ReviewView {
  const line = reviewRowLine(row);
  const started = row.link?.via === 'owner' || !!row.started;
  const ask = row.started?.ask ?? (row.link?.via === 'owner' ? row.link.ask : null);
  const first = row.review?.first_review_id ?? null;
  const earlier = first ? thread.messages.findIndex((message) => message.id === first) : -1;
  const folds = !started && first !== null && earlier > 0;
  const stack = row.stacks[0];
  return {
    context: reviewContextLine(row, options.projectName),
    kind: line.kind === 'local' ? 'local' : 'pr',
    title: row.review ? inboxReviewTitleLine(row.review.title) : null,
    firstReviewId: folds ? first : null,
    latestReviewId: row.review?.latest_review_id ?? null,
    curating: row.reason === 'curating',
    asked: ask ? `New review · ${ask === 'custom' ? 'Custom curation' : 'Guided review'}` : null,
    fromThread: folds ? (thread.thread_name ?? thread.subject ?? null) : null,
    onWholeThread: options.onWholeThread,
    onOpenPull: stack ? () => options.onOpenStack(stack.id) : null,
    pullUrl: row.landed[0]?.url ?? null,
  };
}

/** The groups that start folded, and the person's own choice for each, kept in this browser. */
export const REVIEW_FOLDS_KEY = 'plannotator-inbox-reviews-folds';
export type ReviewFolds = { waiting: boolean; not_reviewed: boolean };

export function readReviewFolds(): ReviewFolds {
  try {
    const kept = JSON.parse(localStorage.getItem(REVIEW_FOLDS_KEY) ?? '{}') as Partial<ReviewFolds>;
    return { waiting: kept.waiting === true, not_reviewed: kept.not_reviewed === true };
  } catch {
    return { waiting: false, not_reviewed: false };
  }
}

export function saveReviewFolds(folds: ReviewFolds): void {
  try {
    localStorage.setItem(REVIEW_FOLDS_KEY, JSON.stringify(folds));
  } catch {
    // Storage refused (private mode, quota): the choice lasts this window only.
  }
}
