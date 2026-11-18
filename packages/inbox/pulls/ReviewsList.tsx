/**
 * The Reviews list (approval "inbox-reviews-page", round 2): the Inbox's own rows and bands, grouped by whose move it
 * is: On you, With your agents, Ready to land, then the folded Waiting on others and Open, not reviewed. A row is a
 * review thread (the same thread the Inbox lists, never a copy) or a listed PR nobody has reviewed. The fold state
 * is remembered. No new keyboard shortcuts.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import { inboxPullIsOpen, inboxPullRepoKey, inboxReviewGroups, type InboxPull, type InboxPullHidden, type InboxRepoHidden, type InboxPullLink, type InboxPullsAnswer, type InboxPullStack, type InboxReviewMove, type InboxReviewRow, type InboxReviewsAnswer } from '@plannotator/core/inbox-types';
import { formatCount, plural } from '@plannotator/core/inbox-format';
import { HostMark, Icon } from '../icons';
import { RefMarkIcon } from '../board/RefMark';
import { Tip } from '../components/Tip';
import { relativeTime, relativeWords, useRelativeClock } from '../relativeTime';
import { pullFilterEmptyWords, pullNounWord, stackTitle, type PullFilter } from './model';
import { initials, repoLabels, repoName } from './labels';
import { pullsEmptyWords, pullsNotices } from './notices';
import { chainMarks } from './topology';
import { readReviewFolds, reviewRowLanding, reviewRowLine, reviewRowProject, reviewRowTitle, saveReviewFolds, type ReviewFolds } from './reviewsModel';
import { riskOrder, rowRisk, rowRiskFailure, type RiskFailures, type RiskFilterValue, type RiskJudgments } from './risk';
import { RiskMark } from './RiskMark';
import { Named, usePicture } from './Face';
import { facesOnce } from './words';
import { pullAvatarUrl } from './pullUrls';
import { UnreportedBranches } from './UnreportedBranches';
import type { InboxUnreportedBranch } from '@plannotator/core/inbox-types';
import { useContextMenuTrigger } from '../components/useContextMenuTrigger';
import { focusWhenGone, hiddenInProject, hiddenLabel, hiddenRepo, itemsBy, repoChangeKey } from './hiddenPulls';

const NO_ROWS: readonly InboxReviewRow[] = [];
const NO_JUDGMENTS: RiskJudgments = {};
const NO_FAILURES: RiskFailures = {};

/**
 * A PR row's top-left spot: always the PR author's profile picture (the person's own PRs too; a stack's bottom layer's
 * author), read through the Inbox's own route (`GET /api/inbox/pulls/avatar`): the window's CSP never loads a remote
 * image. The initials show while it loads and stay when it cannot; a deleted account is a grey person.
 */
function AuthorLead({ stack }: { stack: InboxPullStack }) {
  const bottom = stack.layers[0]!;
  const author = bottom.author;
  const src = author ? pullAvatarUrl(bottom.host, author) : null;
  // The same picture state as every face (`Face.tsx`), so a picture that failed in one is never asked again here.
  const { shown, failed, state, onLoad, onError } = usePicture(src);
  if (!author || !src) {
    return (
      <Tip content="A deleted account">
        <span className="ib-pr-av ib-pr-av-ghost" role="img" aria-label="A deleted account" data-pulls-ghost="">
          <Icon name="user" size={13} />
        </span>
      </Tip>
    );
  }
  return (
    <Tip content={author}>
      <span className="ib-pr-av" role="img" aria-label={author} data-pulls-author={author} data-pulls-bot={author.endsWith('[bot]') ? '' : undefined} data-pulls-avatar={state}>
        {!shown && <span aria-hidden="true">{initials(author)}</span>}
        {!failed && (
          <img
            src={src}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            draggable={false}
            data-shown={shown ? '' : undefined}
            onLoad={onLoad}
            onError={onError}
          />
        )}
      </span>
    </Tip>
  );
}

/** The chain of PR marks, bottom (lands first) to top: past five layers, the first two, "+N" and the last two. */
function Chain({ stack }: { stack: InboxPullStack }) {
  return (
    <span className="ib-pr-chain" aria-hidden="true" data-pulls-chain={stack.layers.length}>
      {chainMarks(stack.layers).map((mark, i) => (
        <span key={'more' in mark ? 'more' : mark.key} className="ib-pr-link">
          {i > 0 && <span className="ib-pr-dash" />}
          {'more' in mark ? (
            <span className="ib-pr-more" data-pulls-chain-more={mark.more}>
              +{mark.more}
            </span>
          ) : (
            <span className="ib-bc-mark" data-card-mark={mark.state} data-card-mark-kind="pr">
              <RefMarkIcon kind="pr" state={mark.state} size={13} />
            </span>
          )}
        </span>
      ))}
    </span>
  );
}

function ReviewRowItem({
  row,
  links,
  place,
  selected,
  phone,
  now,
  judgments,
  riskFailed,
  menu = false,
  onOpen,
}: {
  row: InboxReviewRow;
  links: Readonly<Record<string, InboxPullLink>>;
  place: string;
  selected: boolean;
  phone: boolean;
  now: number;
  judgments: RiskJudgments;
  riskFailed: RiskFailures;
  /** Its right-click menu is open (the muted background the Inbox's rows take then). */
  menu?: boolean;
  onOpen: () => void;
}) {
  const stack = row.stacks[0] ?? null;
  // A thread's row is judged by the PRs it owns, a reported branch by its report; a local review has neither, so no mark.
  const judged = rowRisk(row, judgments);
  const riskFailure = rowRiskFailure(row, judgments, riskFailed);
  const line = reviewRowLine(row);
  const layers = stack?.layers.length ?? 0;
  const focusPull = stack?.layers.find((pull) => pull.state === 'open' || pull.state === 'draft') ?? stack?.layers[0] ?? null;
  return (
    <button
      type="button"
      className={`${phone ? 'ib-mrow' : 'ib-nrow'} ib-prrow${row.move === 'on_you' && row.reviewed ? ' ib-u' : ''}${selected ? ' ib-sel' : ''}`}
      onClick={onOpen}
      aria-current={selected ? 'true' : undefined}
      data-reviews-row={row.id}
      data-reviews-kind={row.reviewed ? 'reviewed' : 'listed'}
      // The thread's row, for the window's J and K and its way back; a listed PR is no thread.
      data-row={row.reviewed ? (row.thread_id ?? undefined) : undefined}
      data-thread-id={row.reviewed ? (row.thread_id ?? undefined) : undefined}
      data-pulls-row={stack?.id}
      data-pulls-move={row.move}
      data-pulls-layers={stack ? layers : undefined}
      data-menu={menu ? '' : undefined}
    >
      <div className="ib-l1">
        <span className="ib-from ib-lead">
          {stack ? (
            <AuthorLead stack={stack} />
          ) : (
            <span className="ib-pr-av" aria-hidden="true" data-reviews-project-tile="">
              <span>{initials(place)}</span>
            </span>
          )}
          <span className="ib-p" dir="auto" data-pulls-repo="">
            {place}
          </span>
        </span>
        {judged && <RiskMark judgment={judged} />}
        {riskFailure && <RiskMark failed={riskFailure} />}
        <span className="ib-t">
          <span aria-hidden="true">{relativeTime(row.updated_at, now)}</span>
          <span className="ib-sr">{relativeWords(row.updated_at, now)}</span>
        </span>
      </div>
      <div className="ib-l2">
        <span className="ib-title" dir="auto">
          {reviewRowTitle(row, (s) => stackTitle(s, links))}
        </span>
      </div>
      <div className="ib-l3 ib-pr-l3">
        {line.kind === 'stack' && stack ? (
          <Chain stack={stack} />
        ) : line.kind === 'pr' ? (
          <span className="ib-bc-mark" data-card-mark={focusPull?.state ?? reviewRowLanding(row)?.state ?? 'open'} data-card-mark-kind="pr" aria-hidden="true">
            <RefMarkIcon kind="pr" state={focusPull?.state ?? reviewRowLanding(row)?.state ?? 'open'} size={13} />
          </span>
        ) : (
          <Icon name={line.mark ?? 'laptop'} size={14} />
        )}
        <span className="ib-pv" dir="auto">
          {layers > 1 && stack && (
            <span className="ib-sr">
              A stack of {layers} {pullNounWord(stack.platform)}s:{' '}
            </span>
          )}
          {line.lead}
          {line.lead && (line.agent || line.status) && ' · '}
          {line.agent && (
            <span className="ib-pr-magent" data-pulls-row-agent={line.agent.host ?? ''} title={line.agent.name} aria-label={line.agent.name}>
              <HostMark host={line.agent.host} />
            </span>
          )}
          {line.status && (
            <span className="ib-pr-mstatus" data-tone={line.tone ?? undefined} data-reviews-status="">
              {/* A face by each name, but not twice: the person the row's left circle shows keeps only their name. */}
              <Named words={facesOnce(line.parts, stack ? [stack.layers[0]!.author] : [])} host={stack?.layers[0]!.host ?? null} />
            </span>
          )}
        </span>
      </div>
    </button>
  );
}

function FoldedGroup({ label, name, rows, open, onToggle, draw }: { label: string; name: InboxReviewMove; rows: readonly InboxReviewRow[]; open: boolean; onToggle: () => void; draw: (row: InboxReviewRow) => React.ReactNode }) {
  if (rows.length === 0) return null;
  return (
    <div className="ib-group ib-pr-fold" role="group" aria-label={label} data-pulls-group={name}>
      <button type="button" className="ib-pr-foldbtn" onClick={onToggle} aria-expanded={open} data-reviews-fold={name}>
        <Icon name={open ? 'chevD' : 'chevR'} size={14} />
        {label} <span className="ib-n">{formatCount(rows.length)}</span>
      </button>
      {open && rows.map(draw)}
    </div>
  );
}

function Band({ label, name, rows, draw }: { label: string; name: InboxReviewMove; rows: readonly InboxReviewRow[]; draw: (row: InboxReviewRow) => React.ReactNode }) {
  if (rows.length === 0) return null;
  return (
    <div className="ib-group" role="group" aria-label={label} data-pulls-group={name}>
      <div className="ib-band">
        {label} <span className="ib-n">{formatCount(rows.length)}</span>
      </div>
      {rows.map(draw)}
    </div>
  );
}

/** The open PRs a row is about (never a merged or closed layer of its stack): what its menu's Hide hides. */
export function rowPulls(row: InboxReviewRow): InboxPull[] {
  const keys = new Set(row.pull_keys);
  return row.stacks.flatMap((stack) => stack.layers.filter((layer) => keys.has(layer.key) && inboxPullIsOpen(layer)));
}

/** The links Reviews' rows name their stacks by: the board's, with each reviewed row's own. */
export function reviewLinksOf(model: InboxPullsAnswer, answer: InboxReviewsAnswer): InboxPullsAnswer['links'] {
  return { ...model.links, ...Object.fromEntries(answer.rows.flatMap((row) => (row.link ? row.pull_keys.map((key) => [key, row.link!] as const) : []))) };
}

/** "Hide pull request", "Hide merge request", "Hide 3 pull requests". */
export function hideWords(pulls: readonly Pick<InboxPull, 'platform'>[]): string {
  const noun = pulls.every((pull) => pull.platform === 'gitlab') ? 'merge request' : 'pull request';
  return pulls.length === 1 ? `Hide ${noun}` : `Hide ${formatCount(pulls.length)} ${noun}s`;
}

/**
 * The way back for a hidden PR (hiddenPulls.ts): a quiet fold at the end of the list, as Waiting on others is, closed
 * at first. Each hidden PR: its number, title and repository (its thread when it has one, else a link to the forge),
 * and Show again. Show again moves focus to the next hidden PR's, else the fold's own button.
 */
function HiddenFold({
  hidden,
  repos,
  onShow,
  onShowRepo,
  onOpenThread,
}: {
  hidden: readonly InboxPullHidden[];
  /** Hidden repositories (the board's Hide repository): listed first, each with its own Show again. */
  repos: readonly InboxRepoHidden[];
  onShow: (hidden: InboxPullHidden) => void;
  onShowRepo?: (repo: InboxRepoHidden) => void;
  onOpenThread?: (threadId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const fold = useRef<HTMLDivElement>(null);
  const shownRepos = onShowRepo ? repos : [];
  const count = hidden.length + shownRepos.length;
  if (count === 0) return null;
  const leave = (id: string) => {
    const col = fold.current?.closest('.ib-listcol') ?? null;
    focusWhenGone(itemsBy(() => fold.current, 'data-pulls-show-again'), id, () => fold.current?.querySelector<HTMLElement>('[data-pulls-hidden-toggle]') ?? col?.querySelector<HTMLElement>('[data-pulls-heading]') ?? null);
  };
  const show = (h: InboxPullHidden) => {
    leave(h.key);
    onShow(h);
  };
  return (
    <div ref={fold} className="ib-group ib-pr-fold" role="group" aria-label="Hidden" data-pulls-hidden={count}>
      <button type="button" className="ib-pr-foldbtn" onClick={() => setOpen((was) => !was)} aria-expanded={open} data-pulls-hidden-toggle="">
        <Icon name={open ? 'chevD' : 'chevR'} size={14} />
        Hidden <span className="ib-n">{formatCount(count)}</span>
      </button>
      {open &&
        shownRepos.map((repo) => (
          <div key={repo.key} className="ib-pr-hid" data-pulls-hidden-repo={repo.key}>
            <span className="ib-pr-hid-t" title={repo.key}>
              <span className="ib-pr-hid-title" dir="auto">
                {repo.label}
              </span>
              <span className="ib-pr-hid-repo">Every pull request</span>
            </span>
            <button
              type="button"
              className="ib-pr-hid-show"
              onClick={() => {
                leave(repoChangeKey(repo.key));
                onShowRepo!(repo);
              }}
              aria-label={`Show again, ${repo.label}`}
              data-pulls-show-again={repoChangeKey(repo.key)}
            >
              Show again
            </button>
          </div>
        ))}
      {open &&
        hidden.map((h) => {
          const words = (
            <>
              <span className="ib-pr-hid-n">{hiddenLabel(h)}</span>
              <span className="ib-pr-hid-title" dir="auto">
                {h.title}
              </span>
              <span className="ib-pr-hid-repo" dir="auto">
                {hiddenRepo(h)}
              </span>
            </>
          );
          return (
            <div key={h.key} className="ib-pr-hid" data-pulls-hidden-row={h.key}>
              {h.thread_id && onOpenThread ? (
                <button type="button" className="ib-pr-hid-t" onClick={() => onOpenThread(h.thread_id!)} title={h.title} data-pulls-hidden-thread={h.thread_id}>
                  {words}
                </button>
              ) : (
                <a className="ib-pr-hid-t" href={h.url} target="_blank" rel="noreferrer noopener" title={h.title}>
                  {words}
                </a>
              )}
              <button type="button" className="ib-pr-hid-show" onClick={() => show(h)} aria-label={`Show again, ${hiddenLabel(h)}`} data-pulls-show-again={h.key}>
                Show again
              </button>
            </div>
          );
        })}
    </div>
  );
}

/**
 * Reviews' rows' right-click menu (and the menu key, Shift+F10; a long press on a phone): Hide, on a row about open
 * PRs. The list's body is its trigger (`className`, `.ib-lbody`), so the bands stay its direct children.
 */
export function ReviewsMenu({
  rows,
  links,
  phone,
  onHide,
  onTarget,
  className,
  busy,
  children,
}: {
  rows: readonly InboxReviewRow[];
  links: InboxPullsAnswer['links'];
  phone: boolean;
  /** Absent: no menu, the browser's own. */
  onHide?: (pulls: InboxPull[]) => void;
  onTarget: (id: string | null) => void;
  className: string;
  busy?: boolean;
  children: React.ReactNode;
}) {
  const body = useRef<HTMLDivElement>(null);
  const hideable = new Map(rows.filter((row) => rowPulls(row).length > 0).map((row) => [row.id, row] as const));
  const buttonFor = (id: string) => body.current?.querySelector<HTMLElement>(`[data-reviews-row="${CSS.escape(id)}"]`) ?? null;
  const menu = useContextMenuTrigger({
    itemOf: (target) => {
      const button = target instanceof Element ? target.closest<HTMLElement>('[data-reviews-row]') : null;
      return button && hideable.has(button.getAttribute('data-reviews-row') ?? '') ? button : null;
    },
    idOf: (button) => button.getAttribute('data-reviews-row'),
    has: (id) => hideable.has(id),
    buttonFor,
    // A hidden row: the row now in its place, else the list's heading.
    slotOf: () => ({
      order: [...(body.current?.querySelectorAll<HTMLElement>('[data-reviews-row]') ?? [])].map((b) => b.getAttribute('data-reviews-row')!),
      fallback: () => body.current?.closest('.ib-listcol')?.querySelector<HTMLElement>('[data-pulls-heading]') ?? null,
    }),
    stateOf: (id) => (hideable.has(id) ? 'shown' : ''),
    onTarget,
    longPress: phone,
    disabled: !onHide,
  });
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(body.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  const target = menu.targetId ? (hideable.get(menu.targetId) ?? null) : null;
  const targetPulls = target ? rowPulls(target) : [];
  const title = target ? reviewRowTitle(target, (s) => stackTitle(s, links)) : 'Review';
  return (
    <ContextMenu.Root {...menu.root}>
      <ContextMenu.Trigger ref={body} className={className} aria-busy={busy ? true : undefined} {...menu.trigger}>
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal container={portal ?? undefined}>
        {phone && <ContextMenu.Backdrop className="ib-pm-scrim" />}
        <ContextMenu.Positioner className="ib-pm-pos" data-phone={phone ? '' : undefined}>
          <ContextMenu.Popup className="ib-pm" aria-label={title} data-reviews-menu={target?.id} {...menu.popup}>
            {target && onHide && (
              <>
                <div className="ib-pm-title" dir="auto" aria-hidden="true">
                  {title}
                </div>
                <Menu.Item
                  className="ib-pmi"
                  label={hideWords(targetPulls)}
                  onClick={() => {
                    menu.follow(target.id);
                    onHide(targetPulls);
                  }}
                  data-reviews-hide=""
                >
                  <Icon name="eyeOff" size={15} />
                  {hideWords(targetPulls)}
                </Menu.Item>
              </>
            )}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export function ReviewsList({
  answer,
  model,
  rows,
  filter,
  risk = 'all',
  notJudged = 0,
  notRanked = NO_ROWS,
  judgments = NO_JUDGMENTS,
  riskFailed = NO_FAILURES,
  projectNames,
  selected,
  phone,
  project = null,
  onOpen,
  onNew,
  onReviewBranch,
  menuRow = null,
  onShowAgain,
  onShowRepo,
  onOpenThread,
}: {
  answer: InboxReviewsAnswer;
  model: InboxPullsAnswer;
  rows: readonly InboxReviewRow[];
  filter: PullFilter;
  /** The risk filter (risk.ts `filterReviewRows`): `rows` are the ones it kept. */
  risk?: RiskFilterValue;
  notJudged?: number;
  notRanked?: readonly InboxReviewRow[];
  judgments?: RiskJudgments;
  riskFailed?: RiskFailures;
  projectNames: ReadonlyMap<string, string>;
  /** The open thread's id, or the open stack's. */
  selected: string | null;
  phone: boolean;
  /** The project the list is filtered to: Branch reviews' "Branches nobody reported" is one project's. */
  project?: string | null;
  onOpen: (row: InboxReviewRow) => void;
  onNew: () => void;
  /** Branch reviews' safety net: New review with that branch. Absent: no safety net. */
  onReviewBranch?: (branch: InboxUnreportedBranch, opener: HTMLElement) => void;
  /** The row whose menu (ReviewsMenu) is open: its muted background. */
  menuRow?: string | null;
  /** The Hidden fold's Show again. Absent: no fold. */
  onShowAgain?: (hidden: InboxPullHidden) => void;
  /** Show a hidden repository again (Hidden lists them only with it). */
  onShowRepo?: (repo: InboxRepoHidden) => void;
  /** A hidden PR's thread, from the Hidden fold. */
  onOpenThread?: (threadId: string) => void;
}) {
  const now = useRelativeClock(true);
  const groups = useMemo(() => (risk === 'all' ? inboxReviewGroups(rows) : riskOrder(inboxReviewGroups(rows), judgments)), [rows, risk, judgments]);
  const [folds, setFolds] = useState<ReviewFolds>(readReviewFolds);
  // Under a risk filter nothing it kept starts folded away, and a click folds a group for that filter only, kept for
  // it while the page is open: the saved folds stay the person's choice for All.
  const [riskFolds, setRiskFolds] = useState<Partial<Record<RiskFilterValue, Partial<ReviewFolds>>>>({});
  const riskFolded = riskFolds[risk] ?? {};
  const unfolded = (name: keyof ReviewFolds) => (risk === 'all' ? folds[name] : !riskFolded[name]);
  const toggle = (name: keyof ReviewFolds) => {
    if (risk !== 'all') {
      setRiskFolds((kept) => ({ ...kept, [risk]: { ...kept[risk], [name]: !kept[risk]?.[name] } }));
      return;
    }
    const next = { ...folds, [name]: !folds[name] };
    setFolds(next);
    saveReviewFolds(next);
  };
  const isOpenRow = (row: InboxReviewRow) => selected !== null && (row.thread_id === selected || row.id === selected || row.stacks.some((stack) => stack.id === selected || stack.layers.some((l) => l.key === selected)));
  // A row opened from a folded group keeps its group open.
  const waitingOpen = unfolded('waiting') || groups.waiting.some(isOpenRow);
  const listedOpen = unfolded('not_reviewed') || groups.not_reviewed.some(isOpenRow);
  // Those High could not place, behind one quiet line; one opened from there keeps them shown.
  const [notRankedFolded, setNotRankedOpen] = useState(false);
  const notRankedOpen = notRankedFolded || notRanked.some(isOpenRow);
  // Branch reviews' safety net: one project's, while Branch reviews is on, never read until opened.
  const unreported = answer.branch_reviews && project && onReviewBranch ? <UnreportedBranches key={project} projectId={project} now={now} onStart={onReviewBranch} /> : null;
  const notices = pullsNotices(model, filter);
  const notice =
    notices.length > 0 ? (
      <div className="ib-pr-notices" role="status" data-pulls-notices="">
        {notices.map((n) => (
          <p key={n.key} className="ib-pr-notice" data-pulls-notice={n.key}>
            <Icon name="info" size={14} />
            <span>
              {n.line}
              {n.link && (
                <>
                  {' · '}
                  <a href={n.link.href} target="_blank" rel="noreferrer noopener" data-pulls-notice-link="">
                    {n.link.label}
                  </a>
                </>
              )}
            </span>
          </p>
        ))}
      </div>
    ) : null;
  const notJudgedLine =
    notJudged > 0 ? (
      <p className="ib-pr-risknote" data-pulls-risk-not-judged={notJudged}>
        {plural(notJudged, 'pull request')} not ranked yet.
      </p>
    ) : null;
  const labels = repoLabels([...rows, ...notRanked].flatMap((row) => row.stacks));
  const placeOf = (row: InboxReviewRow) => {
    const stack = row.stacks[0];
    if (stack) return labels.get(inboxPullRepoKey(stack.host, stack.repo)) ?? repoName(stack.repo);
    const id = reviewRowProject(row);
    const project = id ? projectNames.get(id) : null;
    return project ?? row.review?.source?.repo ?? 'A project';
  };
  const links = reviewLinksOf(model, answer);
  const draw = (row: InboxReviewRow) => (
    <ReviewRowItem key={row.id} row={row} links={links} place={placeOf(row)} selected={isOpenRow(row)} phone={phone} now={now} judgments={judgments} riskFailed={riskFailed} menu={menuRow === row.id} onOpen={() => onOpen(row)} />
  );
  // Under a project filter, that project's hidden PRs and repositories only, as the rest of the page (its count follows).
  const hiddenFold = onShowAgain ? <HiddenFold hidden={hiddenInProject(answer.hidden ?? [], project, answer.projects)} repos={hiddenInProject(answer.hidden_repos ?? [], project, answer.projects)} onShow={onShowAgain} onShowRepo={onShowRepo} onOpenThread={onOpenThread} /> : null;
  // High: what it can't place, behind one quiet line in the fold's own shape.
  const notRankedLine =
    notRanked.length > 0 ? (
      <div className="ib-group ib-pr-fold" role="group" aria-label="Not ranked" data-pulls-risk-not-ranked={notRanked.length}>
        <button type="button" className="ib-pr-foldbtn" onClick={() => setNotRankedOpen((v) => !v)} aria-expanded={notRankedOpen} data-pulls-risk-not-ranked-toggle="">
          <Icon name={notRankedOpen ? 'chevD' : 'chevR'} size={14} />
          {notRankedOpen ? (
            <>
              Not ranked <span className="ib-n">{formatCount(notRanked.length)}</span>
            </>
          ) : (
            `${formatCount(notRanked.length)} not ranked`
          )}
        </button>
        {notRankedOpen && notRanked.map(draw)}
      </div>
    ) : null;
  if (rows.length === 0 && risk !== 'all') {
    // What could not be read (signed out, rate limited) is said here too: an empty filter is no "nothing".
    return (
      <>
        {notice}
        <div className="ib-pr-empty" data-pulls-empty="risk">
          <p className="ib-pr-empty-h">{risk === 'high' ? 'Nothing high risk.' : 'Nothing at medium risk or above.'}</p>
          {notJudgedLine}
        </div>
        {notRankedLine}
        {hiddenFold}
      </>
    );
  }
  if (rows.length === 0) {
    // Never "nothing" before Others answers, and the wait never hides a host's own failure.
    const othersOnItsWay = (filter === 'all' || filter === 'others') && model.hosts.some((h) => h.others_pending) && !model.hosts.some((h) => h.error);
    if (othersOnItsWay) return <p className="ib-pr-empty" data-pulls-empty="reading">Reading your pull requests…</p>;
    // A view with nothing in it, while the read was whole: what the view holds. Never while a host failed or was cut.
    if (filter !== 'all' && notices.every((n) => n.key.startsWith('unsigned:'))) {
      const empty = pullFilterEmptyWords(filter);
      return (
        <div className="ib-pr-empty" data-pulls-empty={`view-${filter}`}>
          <p className="ib-pr-empty-h">{empty.head}</p>
          {[empty.line, ...notices.map((n) => n.line)].map((line) => (
            <p key={line}>{line}</p>
          ))}
          {hiddenFold}
        </div>
      );
    }
    const empty = pullsEmptyWords(model, notices);
    const nothing = empty.kind === 'nothing' || empty.kind === 'no-repos';
    return (
      <div className="ib-pr-off" data-pulls-empty={empty.kind}>
        <div className="ib-pr-empty">
          <p className="ib-pr-empty-h">{nothing ? 'No reviews yet' : empty.head}</p>
          {nothing ? <p>Reviews your agents send, and your open pull requests, show here.</p> : empty.lines.map((line) => <p key={line}>{line}</p>)}
          <button type="button" className="ib-btn ib-pri" onClick={onNew} data-reviews-new="empty">
            <Icon name="plus" size={15} />
            New review
          </button>
        </div>
        {unreported}
        {hiddenFold}
      </div>
    );
  }
  return (
    <>
      {notice}
      <Band label="On you" name="on_you" rows={groups.on_you} draw={draw} />
      <Band label="With your agents" name="agents" rows={groups.agents} draw={draw} />
      <Band label="Ready to land" name="ready" rows={groups.ready} draw={draw} />
      <FoldedGroup label="Waiting on others" name="waiting" rows={groups.waiting} open={waitingOpen} onToggle={() => toggle('waiting')} draw={draw} />
      <FoldedGroup label="Open, not reviewed" name="not_reviewed" rows={groups.not_reviewed} open={listedOpen} onToggle={() => toggle('not_reviewed')} draw={draw} />
      {notJudgedLine}
      {notRankedLine}
      {unreported}
      {hiddenFold}
    </>
  );
}
