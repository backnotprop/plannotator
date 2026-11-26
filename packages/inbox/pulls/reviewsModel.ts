/**
 * The Reviews page's rows in the window (approval "inbox-reviews-page", round 2): which rows a filter keeps, and what
 * a row says. The rows themselves are the server's (`GET /api/inbox/reviews`, core's `inboxReviewRows`).
 */
import {
  inboxActionInDraft,
  inboxPullIsOpen,
  type InboxMessageWire,
  type InboxPull,
  type InboxPullLink,
  INBOX_PULL_RISK_AUTO_TRIES,
  type InboxPullRiskAutoMake,
  type InboxPullRiskAutoRun,
  type InboxPullStack,
  type InboxReviewRow,
  type InboxReviewsAnswer,
} from '@plannotator/core/inbox-types';
import { plural } from '@plannotator/core/inbox-format';
import { holdingsOf } from '@plannotator/core/inbox-folding';
import { inboxReviewTitleLine } from '@plannotator/core/inbox-review';
import { checksWords, inboxPullLabel, isPullThread, linkAgentName, openLayers, pullInProject, pullViewOf, requestedParts, type PullFilter } from './model';
import { person, wordsText, type Words } from './words';
import { startLayer } from './topology';
import { hostLabel } from '../compose/model';
import { branchAskedAlready, branchContextWords, branchNoteOf, branchReportOf, branchRowLead, type BranchNote } from './branchReviews';

/** The rows a project and a view keep: a local review is the person's own, and belongs to its thread's project. */
export function reviewRowsIn(answer: InboxReviewsAnswer, project: string | null, filter: PullFilter): InboxReviewRow[] {
  const inProject = (row: InboxReviewRow) => {
    if (!project) return true;
    const own = reviewRowProject(row);
    if (own === project) return true;
    return row.stacks.some((stack) => stack.layers.some((pull) => pullInProject(pull, project, answer.projects, own)));
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
/**
 * The stack whose launchpad a row opens (approval "pr-launchpad"; the owner's routing answer, 2026-11-09): a row about
 * one open PR on its own opens that PR's launchpad, also once an agent reviewed it (its guided review, the diff and the
 * thread are its doors). Null: the row keeps its way in (a local review or a thread of several PRs its thread, a stack
 * of several its stack page).
 */
export function reviewRowLaunchpad(row: InboxReviewRow): string | null {
  // A thread started from the PR's page (Start a thread) is that PR's page from then on: the row opens it.
  if (row.stacks.length !== 1 || (row.reviewed && row.thread_id && isPullThread(row.link))) return null;
  const stack = row.stacks[0]!;
  return stack.layers.length === 1 && startLayer(stack) ? stack.id : null;
}

export function reviewRowProject(row: InboxReviewRow): string | null {
  return row.review?.project_id ?? row.started?.project_id ?? null;
}

/** `shown`: the PR whose ship the row draws (`reviewRowLanding`). */
export function reviewRowTitle(row: InboxReviewRow, pullTitle: (stack: InboxPullStack) => string, shown?: string | null): string {
  const stack = row.stacks[0];
  if (stack) return pullTitle(stack);
  if (row.review) return inboxReviewTitleLine(row.review.title);
  // A shipped PR's thread, its PR merged: the PR's title, as its row had while open.
  return row.started?.name ?? reviewRowLanding(row, shown)?.title ?? row.link?.thread_id ?? '';
}

/** A row's third line: what it is, whose agent, and why it is where it is. */
export interface ReviewRowLine {
  kind: 'local' | 'pr' | 'stack';
  lead: string;
  agent: { host: string | null; name: string } | null;
  /** Why it is where it is, as one string (a reader's and the tests' words). */
  status: string;
  /** The same words in parts: the people it names are drawn with their faces (`words.ts`). */
  parts: Words;
  tone: 'ok' | 'warn' | null;
  /** A reported branch's mark (Branch reviews): this computer's, a linked machine's, a cloud agent's. Absent: the kind's own. */
  mark?: 'gitBranch' | 'laptop' | 'cloud';
}

const lower = (words: string) => words.replace(/^./, (c) => c.toLowerCase());

/** The layer a row's words are about: the first that asked the person, else the next to land, else the top. */
function focusOf(stack: InboxPullStack): InboxPull {
  const open = openLayers(stack);
  return open.find((pull) => (pull.requested || pull.assigned) && !pull.mine) ?? startLayer(stack) ?? open[0] ?? stack.layers[stack.layers.length - 1]!;
}

const whose = (pull: InboxPull) => (pull.mine ? 'yours' : pull.author ? person(pull.author) : 'a deleted account');

/** "yours · checks passed", "tomas · draft": a listed PR's words. */
function listedWords(pull: InboxPull): Words {
  const checks = checksWords(pull);
  const state = pull.state === 'draft' ? 'draft' : checks ? lower(checks) : null;
  return state ? [whose(pull), ` · ${state}`] : [whose(pull)];
}

function statusOf(row: InboxReviewRow): { status: Words; tone: ReviewRowLine['tone'] } {
  const stack = row.stacks[0];
  const pull = stack ? focusOf(stack) : null;
  const checks = pull ? checksWords(pull) : null;
  switch (row.reason) {
    case 'review_ready':
      return { status: ['Review ready'], tone: null };
    case 'branch_ready':
      return { status: ['Ready for review'], tone: null };
    case 'curating':
      return { status: [row.started?.ask === 'picture_it' ? 'Making a Picture page…' : 'Curating…'], tone: null };
    case 'feedback_sent': {
      const verdict = row.review?.verdict;
      if (verdict?.verdict !== 'changes_requested') return { status: ['You answered'], tone: null };
      return { status: [verdict.comments > 0 ? `Changes requested · ${plural(verdict.comments, 'comment')}` : 'Changes requested'], tone: 'warn' };
    }
    case 'approved':
      return { status: [`You approved${checks ? ` · ${lower(checks)}` : ''}`], tone: 'ok' };
    case 'requested':
      return { status: requestedParts(pull?.author), tone: null };
    case 'assigned':
      return { status: ['assigned to you'], tone: null };
    case 'changes':
      return { status: ['Changes requested'], tone: 'warn' };
    case 'failing':
      return { status: ['Checks failed'], tone: 'warn' };
    case 'checks_running':
      return { status: ['You approved · checks running'], tone: null };
    case 'draft':
      return { status: ['You approved · draft'], tone: null };
    case 'forge_review': {
      const reviewer = pull?.reviewers[0];
      return { status: reviewer ? ['Waiting on ', person(reviewer, '’s'), ' review'] : ['Waiting on a review'], tone: null };
    }
    case 'others':
    case 'not_reviewed':
      return { status: pull ? listedWords(pull) : [], tone: null };
  }
}

const reviewIsWalkthrough = (row: InboxReviewRow) => !!row.review?.walkthrough || row.started?.kind === 'walkthrough';

/**
 * The landing a row speaks for: a link's own PR only, since an agent's guide may name another that merged. `shown`: the
 * PR whose ship the row draws (its Merged words): its landing, so the title is of the PR that merged.
 */
export function reviewRowLanding(row: InboxReviewRow, shown?: string | null): InboxReviewRow['landed'][number] | null {
  const ship = shown ? row.landed.find((landing) => landing.key === shown) : undefined;
  if (ship) return ship;
  const handed = row.started?.pull;
  return (handed ? row.landed.find((landing) => landing.key === handed.key) : row.landed[0]) ?? null;
}

const LEVEL_WORD = { high: 'High', medium: 'Medium', low: 'Low' } as const;

export const REVIEW_ROW_AUTO_STOPPED: Record<InboxPullRiskAutoMake, string> = {
  picture_it: 'The agent stopped before sending a Picture page.',
  guide: 'The agent stopped before sending a guided review.',
};

export function reviewRowAutoRun(row: Pick<InboxReviewRow, 'stacks'>, runs: Readonly<Record<string, InboxPullRiskAutoRun>> | undefined): InboxPullRiskAutoRun | null {
  const layer = runs ? row.stacks[0]?.layers.find((pull) => runs[pull.key]) : undefined;
  return layer ? runs![layer.key]! : null;
}

export function reviewRowAutoWords(run: InboxPullRiskAutoRun | null, row: Pick<InboxReviewRow, 'link' | 'review' | 'thread_id' | 'stacks'>): string | null {
  if (!run) return null;
  const link = row.link;
  if (run.state === 'failed') {
    const open = row.stacks[0] ? openLayers(row.stacks[0]).length > 0 : false;
    const again = (run.tries ?? 1) < INBOX_PULL_RISK_AUTO_TRIES ? ' It will try again.' : '';
    return open && !link && !row.thread_id ? `Couldn't start: ${run.reason ?? 'the agent did not start.'}${again}` : null;
  }
  if (run.state !== 'started' || !link || link.thread_id !== run.thread_id) return null;
  const page = run.made !== 'guide' && link.picture_it_page && link.picture_it_page.at >= run.at ? link.picture_it_page : null;
  if (page) return !page.seen && !row.review ? `Picture page ready, made when it ranked ${LEVEL_WORD[run.level]}` : null;
  if (row.review) return null;
  if (link.agent?.ended) return REVIEW_ROW_AUTO_STOPPED[run.made];
  return run.made === 'picture_it' ? 'Making a Picture page…' : 'Making a guided review…';
}

export function reviewRowLine(row: InboxReviewRow, autoRuns?: Readonly<Record<string, InboxPullRiskAutoRun>>, shown?: string | null): ReviewRowLine {
  const stack = row.stacks[0];
  const name = row.review?.agent?.name ?? linkAgentName(row.link) ?? (row.started ? hostLabel(row.started.host) : null);
  const host = row.review?.agent?.host ?? row.link?.agent?.host ?? row.started?.host ?? null;
  const agent = row.reviewed && name ? { host, name } : null;
  const said = statusOf(row);
  const { tone } = said;
  // A walkthrough has nothing to review: Ready once it's in, Writing… while the agent writes it.
  const auto = reviewRowAutoWords(reviewRowAutoRun(row, autoRuns), row);
  const parts: Words = auto ? [auto] : reviewIsWalkthrough(row) && (row.reason === 'review_ready' || row.reason === 'curating') ? [row.reason === 'review_ready' ? 'Ready' : 'Writing…'] : said.status;
  const status = wordsText(parts);
  if (reviewIsWalkthrough(row)) return { kind: 'local', lead: 'Walkthrough', agent, status, parts, tone };
  if (stack) {
    const many = stack.layers.length > 1;
    if (many) {
      const open = openLayers(stack);
      const merged = stack.layers.filter((pull) => pull.state === 'merged').length;
      return { kind: 'stack', lead: `${open.length} open${merged > 0 ? `, ${merged} merged` : ''}`, agent, status, parts, tone };
    }
    return { kind: 'pr', lead: inboxPullLabel(focusOf(stack)), agent, status, parts, tone };
  }
  const landing = reviewRowLanding(row, shown);
  if (landing) return { kind: 'pr', lead: `${landing.platform === 'gitlab' ? '!' : '#'}${landing.number} ${landing.state}`, agent, status, parts, tone };
  // The PR the person handed it: an agent's words about another PR don't change where a Post goes.
  const linked = row.started?.pull;
  if (linked) return { kind: 'pr', lead: `${linked.platform === 'gitlab' ? '!' : '#'}${linked.number}`, agent, status, parts, tone };
  const source = row.review?.source;
  const report = source ? null : branchReportOf(row);
  if (report) return { kind: 'local', lead: branchRowLead(report), agent, status, parts, tone, mark: report.machine ? 'laptop' : report.place === 'cloud' ? 'cloud' : 'gitBranch' };
  if (source?.pr?.number) return { kind: 'pr', lead: `${source.pr.platform === 'gitlab' ? '!' : '#'}${source.pr.number}`, agent, status, parts, tone };
  return { kind: 'local', lead: source?.branch ?? row.started?.branch ?? '', agent, status, parts, tone };
}

/** The line over a review thread's title: "charges · Local changes on retry-jitter, against main". */
export function reviewContextLine(row: InboxReviewRow, projectName: string | null): string {
  const source = row.review?.source;
  const line = reviewRowLine(row);
  const started = row.started;
  const report = branchReportOf(row);
  const what = report && !source
    ? branchContextWords(report)
    : line.kind !== 'local' || reviewIsWalkthrough(row)
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
  /**
   * The name the thread's bar shows instead of the thread's own: the review's title, which the Reviews row and the
   * heading show (`reviewRowTitle`), so the bar does not keep New review's name once the guide lands. Null for a PR
   * row (its row is the PR's title) and before a review arrived (the row shows the thread's name then).
   */
  name: string | null;
  /** The first review: the messages before it stay out of this view (`reviewEarlierHidden`). Null when the thread was started for the review. */
  firstReviewId: string | null;
  /** The latest review: open in this view however long ago it was read. */
  latestReviewId: string | null;
  /**
   * An agent is still writing the first review: what the thread says under the request ("Curating the review…", for a
   * walkthrough "Writing the walkthrough…"). Null once a review arrived.
   */
  curating: string | null;
  /** New review's own label on the request: "New review · Guided review". */
  asked: string | null;
  /** The thread the review came from, when it was an ordinary one. */
  fromThread: string | null;
  onWholeThread: () => void;
  /** The PR's own page. */
  onOpenPull: (() => void) | null;
  /** A landed PR, on its forge. */
  pullUrl: string | null;
  /**
   * A thread started from the PR's page (Start a thread): the PR's line over the messages (`PullContextLine`) in place of
   * the context line, with Guided review (asked for in this thread, `usePullThreadGuide`, or opened once it is in), The
   * diff (`onDiff`) and the PR on its forge. `link`: the PR's, this thread's. Null otherwise.
   */
  pullLine?: { pull: InboxPull; stack: InboxPullStack; link: InboxPullLink; onDiff: () => void; onAsked: () => void } | null;
  /**
   * A reported branch with no review yet (Branch reviews): what the agent reported, and the message a review request
   * replies to, so the review stays in this thread, and whether the person already asked for it (`asked`). Null for
   * every other thread, and once a review is in.
   */
  branch: (BranchNote & { projectName: string | null; replyTo: string | null; asked?: boolean }) | null;
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
  thread: { messages: readonly { id: string; author?: { kind: string }; body?: string; created_at?: string }[]; subject: string | null; thread_name?: string | null },
  options: { projectName: string | null; onWholeThread: () => void; onOpenStack: (stackId: string) => void; onOpenDiff?: (stackId: string, layerKey: string) => void; onAsked?: () => void },
): ReviewView {
  const line = reviewRowLine(row);
  const started = row.link?.via === 'owner' || !!row.started;
  // A reported branch's first message is the agent's report, no New review request.
  const pullThread = isPullThread(row.link);
  const ask = row.started?.kind === 'branch' || pullThread ? null : (row.started?.ask ?? (row.link?.via === 'owner' ? row.link.ask : null));
  const first = row.review?.first_review_id ?? null;
  const earlier = first ? thread.messages.findIndex((message) => message.id === first) : -1;
  const folds = !started && first !== null && earlier > 0;
  const stack = row.stacks[0];
  const report = row.review ? null : branchReportOf(row);
  return {
    branch: report
      ? { ...branchNoteOf(report), projectName: options.projectName, replyTo: thread.messages[thread.messages.length - 1]?.id ?? null, asked: branchAskedAlready(thread.messages, report, options.projectName) }
      : null,
    context: reviewContextLine(row, options.projectName),
    kind: line.kind === 'local' ? 'local' : 'pr',
    title: row.review ? inboxReviewTitleLine(row.review.title) : null,
    name: row.review && !stack ? inboxReviewTitleLine(row.review.title) : null,
    firstReviewId: folds ? first : null,
    latestReviewId: row.review?.latest_review_id ?? null,
    curating: row.reason !== 'curating' ? null : reviewIsWalkthrough(row) ? 'Writing the walkthrough…' : row.started?.ask === 'picture_it' ? 'Making a Picture page…' : 'Curating the review…',
    asked: ask ? `New review · ${reviewIsWalkthrough(row) ? 'Walkthrough' : ask === 'custom' ? 'Custom curation' : ask === 'picture_it' ? 'Picture it' : 'Guided review'}` : null,
    fromThread: folds ? (thread.thread_name ?? thread.subject ?? null) : null,
    onWholeThread: options.onWholeThread,
    onOpenPull: stack ? () => options.onOpenStack(stack.id) : null,
    pullUrl: reviewRowLanding(row)?.url ?? null,
    pullLine:
      pullThread && stack && startLayer(stack) && row.link?.thread_id === row.thread_id && options.onOpenDiff
        ? { pull: startLayer(stack)!, stack, link: row.link, onDiff: () => options.onOpenDiff!(stack.id, startLayer(stack)!.key), onAsked: options.onAsked ?? (() => {}) }
        : null,
  };
}

export { ReviewViewNote } from './ReviewViewNote';

/** The groups that start folded, and the person's own choice for each, kept in this browser. */
export const REVIEW_FOLDS_KEY = 'plannotator-inbox-reviews-folds';
/** Which folded groups are open, kept: "On this computer" (`local`, OnThisComputer.tsx) is one. */
export type ReviewFolds = { waiting: boolean; not_reviewed: boolean; local: boolean };

export function readReviewFolds(): ReviewFolds {
  try {
    const kept = JSON.parse(localStorage.getItem(REVIEW_FOLDS_KEY) ?? '{}') as Partial<ReviewFolds>;
    return { waiting: kept.waiting === true, not_reviewed: kept.not_reviewed === true, local: kept.local === true };
  } catch {
    return { waiting: false, not_reviewed: false, local: false };
  }
}

export function saveReviewFolds(folds: ReviewFolds): void {
  try {
    localStorage.setItem(REVIEW_FOLDS_KEY, JSON.stringify(folds));
  } catch {
    // Storage refused (private mode, quota): the choice lasts this window only.
  }
}

/** The sidebar's Reviews count: the rows on the person in the last read. */
export function reviewsOnYou(answer: InboxReviewsAnswer): number {
  return answer.rows.filter((row) => row.move === 'on_you').length;
}
