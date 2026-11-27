/**
 * The Reviews list (approval "inbox-reviews-page", round 2; compact rows from "inbox-reviews-compact-list"): one line
 * per review (ReviewRow.tsx) under plain group labels, grouped by whose move it is: On you, With your agents, Ready to
 * land, then the folded Waiting on others and Open, not reviewed. A row is a review thread (the same thread the Inbox
 * lists, never a copy) or a listed PR nobody has reviewed. The fold state is remembered. No new keyboard shortcuts.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import { inboxPullIsOpen, inboxPullRepoKey, inboxReviewGroups, type InboxPull, type InboxPullHidden, type InboxRepoHidden, type InboxPullsAnswer, type InboxReviewRow, type InboxReviewsAnswer } from '@plannotator/core/inbox-types';
import { formatCount, plural } from '@plannotator/core/inbox-format';
import { Icon } from '../icons';
import { useRelativeClock } from '../relativeTime';
import { pullFilterEmptyWords, stackTitle, type PullFilter } from './model';
import { repoLabels, repoName } from './labels';
import { pullsEmptyWords, pullsNotices } from './notices';
import { readReviewFolds, reviewRowProject, reviewRowTitle, saveReviewFolds, type ReviewFolds } from './reviewsModel';
import { riskOrder, type RiskFailures, type RiskFilterValue, type RiskJudgments } from './risk';
import { layerItem, ReviewRowItem, ReviewStack } from './ReviewRow';
import { ReviewGroup, type ReviewGroupFold } from './ReviewGroup';
import type { InboxPullRiskAutoRun } from '@plannotator/core/inbox-types';
import { useContextMenuTrigger } from '../components/useContextMenuTrigger';
import { focusWhenGone, hiddenInProject, hiddenLabel, hiddenRepo, itemsBy, repoChangeKey } from './hiddenPulls';
import { shipActive, shipLook, type InboxShipView } from '@plannotator/core/inbox-pull-handoff';
import { shipTarget, useShipAgents, type ShipOption, type ShipTarget } from './shipStart';
import { ShipAgentSheet, ShipMenuItems } from './ShipMenu';

const NO_ROWS: readonly InboxReviewRow[] = [];
const NO_JUDGMENTS: RiskJudgments = {};
const NO_FAILURES: RiskFailures = {};

/** The open PRs a row is about (never a merged or closed layer of its stack): what its menu's Hide hides. */
export function rowPulls(row: InboxReviewRow): InboxPull[] {
  const keys = new Set(row.pull_keys);
  return row.stacks.flatMap((stack) => stack.layers.filter((layer) => keys.has(layer.key) && inboxPullIsOpen(layer)));
}

/** The links Reviews' rows name their stacks by: the board's, with each reviewed row's own. */
export function reviewLinksOf(model: InboxPullsAnswer, answer: InboxReviewsAnswer): InboxPullsAnswer['links'] {
  return { ...model.links, ...Object.fromEntries(answer.rows.flatMap((row) => (row.link ? row.pull_keys.map((key) => [key, row.link!] as const) : []))) };
}

/** What a right-click finds: a row about open PRs, or an open layer of an unfolded stack; what its title and Hide name. */
interface MenuTarget {
  title: string;
  pulls: InboxPull[];
  /** The row it is on (a layer's: its stack's): what Ship ships in. */
  row: InboxReviewRow;
}

/** The menu's targets by id (`data-reviews-item`): each row about open PRs, and each open layer of a stack (`layerItem`). */
export function menuTargets(rows: readonly InboxReviewRow[], links: InboxPullsAnswer['links']): Map<string, MenuTarget> {
  const targets = new Map<string, MenuTarget>();
  for (const row of rows) {
    const pulls = rowPulls(row);
    if (pulls.length > 0) targets.set(row.id, { title: reviewRowTitle(row, (s) => stackTitle(s, links)), pulls, row });
    const stack = row.stacks[0];
    if (!stack || stack.layers.length < 2) continue;
    for (const layer of stack.layers) if (inboxPullIsOpen(layer)) targets.set(layerItem(layer.key), { title: layer.title, pulls: [layer], row });
  }
  return targets;
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
 * PRs or an open layer's row (that one PR). The list's body is its trigger (`className`, `.ib-lbody`), so the bands
 * stay its direct children.
 */
export function ReviewsMenu({
  rows,
  links,
  phone,
  onHide,
  onTarget,
  className,
  busy,
  ship,
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
  /** Ship (ShipMenu.tsx), first in the menu of a row about one open PR. Absent: no Ship. */
  ship?: ShipHandlers;
  children: React.ReactNode;
}) {
  const body = useRef<HTMLDivElement>(null);
  const hideable = menuTargets(rows, links);
  const buttonFor = (id: string) => body.current?.querySelector<HTMLElement>(`[data-reviews-item="${CSS.escape(id)}"]`) ?? null;
  const menu = useContextMenuTrigger({
    itemOf: (target) => {
      const button = target instanceof Element ? target.closest<HTMLElement>('[data-reviews-item]') : null;
      return button && hideable.has(button.getAttribute('data-reviews-item') ?? '') ? button : null;
    },
    idOf: (button) => button.getAttribute('data-reviews-item'),
    has: (id) => hideable.has(id),
    buttonFor,
    // A hidden row: the row now in its place, else the list's heading.
    slotOf: () => ({
      order: [...(body.current?.querySelectorAll<HTMLElement>('[data-reviews-item]') ?? [])].map((b) => b.getAttribute('data-reviews-item')!),
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
  const targetId = target ? menu.targetId! : null;
  const targetPulls = target?.pulls ?? [];
  const title = target?.title ?? 'Review';
  const shipTo = target && ship ? shipTarget(target.row, target.pulls, ship.repoProjects) : null;
  const shipNow = shipTo ? (ship?.ships.get(shipTo.pull.key) ?? null) : null;
  const shipping = !!shipNow && shipActive(shipNow);
  const agents = useShipAgents(shipping ? null : shipTo, menu.open && !!shipTo && !shipping, ship?.projectsOf ?? noProjects);
  // A phone's agent sheet, after the menu closes.
  const [sheet, setSheet] = useState<ShipTarget | null>(null);
  const sheetAgents = useShipAgents(sheet, sheet !== null, ship?.projectsOf ?? noProjects);
  const shipWith = (to: ShipTarget, option: ShipOption) => {
    setSheet(null);
    menu.close();
    ship?.onShip(to, option);
  };
  return (
    <ContextMenu.Root {...menu.root}>
      <ContextMenu.Trigger ref={body} className={className} aria-busy={busy ? true : undefined} {...menu.trigger}>
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal container={portal ?? undefined}>
        {phone && <ContextMenu.Backdrop className="ib-pm-scrim" />}
        <ContextMenu.Positioner className="ib-pm-pos" data-phone={phone ? '' : undefined}>
          <ContextMenu.Popup className="ib-pm" aria-label={title} data-reviews-menu={targetId ?? undefined} {...menu.popup}>
            {target && onHide && (
              <>
                <div className="ib-pm-title" dir="auto" aria-hidden="true">
                  {title}
                </div>
                {shipTo && ship && (
                  <ShipMenuItems
                    shipping={shipping}
                    options={agents.options}
                    chosen={agents.chosen}
                    phone={phone}
                    portal={portal}
                    onShip={(option) => shipWith(shipTo, option)}
                    onChoose={() => setSheet(shipTo)}
                    onLog={() => {
                      menu.keepFocus();
                      ship.onLog(shipNow!, buttonFor(targetId!));
                    }}
                    onStop={() => ship.onStop(shipNow!)}
                  />
                )}
                <Menu.Item
                  className="ib-pmi"
                  label={hideWords(targetPulls)}
                  onClick={() => {
                    menu.follow(targetId!);
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
      {ship && phone && (
        <ShipAgentSheet open={sheet !== null} title={sheet?.pull.title ?? 'Ship'} options={sheetAgents.options} chosen={sheetAgents.chosen} host={portal} onShip={(option) => sheet && shipWith(sheet, option)} onClose={() => setSheet(null)} />
      )}
    </ContextMenu.Root>
  );
}

/** What Reviews' Ship needs from its page (PullsPage.tsx). */
export interface ShipHandlers {
  ships: ReadonlyMap<string, InboxShipView>;
  /** `host/repo` → the Inbox projects on it (the Reviews answer's). */
  repoProjects: Readonly<Record<string, string[]>>;
  /** A computer's projects by repository (null: this one): whose agents Ship's list offers there. Absent: this one's. */
  projectsOf?: (machine: string | null) => Readonly<Record<string, string[]>>;
  onShip: (target: ShipTarget, option: ShipOption) => void;
  /** Open the ship log by its row (`anchor`). */
  onLog: (ship: InboxShipView, anchor: HTMLElement | null) => void;
  onStop: (ship: InboxShipView) => void;
}

const NO_PROJECTS: Readonly<Record<string, string[]>> = {};
const noProjects = () => NO_PROJECTS;

/**
 * The ship a row draws: its one PR's; a folded stack's, any layer's (an unfolded one's layers draw their own); a
 * landed PR's (its Merged words). One that still draws first: a thread's older ship, long over, never hides a fresh one.
 */
function rowShip(row: InboxReviewRow, ships: ReadonlyMap<string, InboxShipView> | undefined, unfolded: boolean, now: number): InboxShipView | null {
  if (!ships || ships.size === 0 || unfolded) return null;
  let quiet: InboxShipView | null = null;
  for (const key of [...row.pull_keys, ...row.landed.map((landing) => landing.key)]) {
    const ship = ships.get(key);
    if (!ship) continue;
    if (shipLook(ship, now) !== null) return ship;
    quiet ??= ship;
  }
  return quiet;
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
  autoRuns,
  projectNames,
  selected,
  selectedLayer = null,
  phone,
  project = null,
  onOpen,
  onOpenLayer,
  onNew,
  localGroup = null,
  menuRow = null,
  onShowAgain,
  onShowRepo,
  onOpenThread,
  ships,
}: {
  /** The ships by pull request key (data/ships.ts): their rows in ship mode. */
  ships?: ReadonlyMap<string, InboxShipView>;
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
  autoRuns?: Readonly<Record<string, InboxPullRiskAutoRun>>;
  projectNames: ReadonlyMap<string, string>;
  /** The open thread's id, or the open stack's. */
  selected: string | null;
  /**
   * The layer of the open stack whose row shows selected (PullsPage's, from the address): the one whose diff closed
   * back to the stack, or the stack opened by that layer's own key. Nothing is remembered here.
   */
  selectedLayer?: string | null;
  phone: boolean;
  /** The project the list is filtered to. */
  project?: string | null;
  onOpen: (row: InboxReviewRow) => void;
  /** A layer's row of an unfolded stack: that layer. Absent: the row's own `onOpen`. */
  onOpenLayer?: (row: InboxReviewRow, layer: InboxPull) => void;
  onNew: () => void;
  /**
   * "On this computer" (OnThisComputer.tsx), at the list's foot whatever it holds, given its saved fold (`folds.local`).
   * Not under a risk filter: local work has no risk to match.
   */
  localGroup?: ((fold: ReviewGroupFold) => React.ReactNode) | null;
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
  const local = localGroup && risk === 'all' ? localGroup({ open: folds.local, onToggle: () => toggle('local') }) : null;
  const isOpenRow = (row: InboxReviewRow) => selected !== null && (row.thread_id === selected || row.id === selected || row.stacks.some((stack) => stack.id === selected || stack.layers.some((l) => l.key === selected)));
  // A row opened from a folded group keeps its group open.
  const waitingOpen = unfolded('waiting') || groups.waiting.some(isOpenRow);
  const listedOpen = unfolded('not_reviewed') || groups.not_reviewed.some(isOpenRow);
  /** The layer of this row's stack that shows selected on its own row (`selectedLayer`), when this row is the open one. */
  const openLayerOf = (row: InboxReviewRow): string | null => {
    const stack = row.stacks[0];
    if (!stack || stack.layers.length < 2 || !isOpenRow(row) || !selectedLayer) return null;
    return stack.layers.some((layer) => layer.key === selectedLayer) ? selectedLayer : null;
  };
  // A stack's fold, by hand; one whose layer is open starts unfolded, as a folded group keeps an open row shown.
  const [stackFolds, setStackFolds] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const stackUnfolded = (row: InboxReviewRow) => stackFolds.get(row.id) ?? openLayerOf(row) !== null;
  const toggleStack = (row: InboxReviewRow) => {
    const open = stackUnfolded(row);
    setStackFolds((was) => new Map(was).set(row.id, !open));
  };
  // Those High could not place, behind one quiet line; one opened from there keeps them shown.
  const [notRankedFolded, setNotRankedOpen] = useState(false);
  const notRankedOpen = notRankedFolded || notRanked.some(isOpenRow);
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
  const draw = (row: InboxReviewRow) => {
    const stack = row.stacks[0];
    const many = !!stack && stack.layers.length > 1;
    const unfolded = many && stackUnfolded(row);
    const props = { row, links, place: placeOf(row), selected: isOpenRow(row), phone, now, judgments, riskFailed, autoRuns, menu: menuRow === row.id, ship: rowShip(row, ships, unfolded, now), ships, onOpen: () => onOpen(row) };
    // A stack of several PRs unfolds its layers under its row; the choice lasts while the list is shown.
    if (many) {
      // An open layer shown on its own row takes the selection from the stack's row.
      const openLayer = unfolded ? openLayerOf(row) : null;
      return (
        <ReviewStack
          key={row.id}
          {...props}
          selected={props.selected && openLayer === null}
          open={unfolded}
          onToggle={() => toggleStack(row)}
          openLayer={openLayer}
          menuItem={menuRow}
          onOpenLayer={(layer) => (onOpenLayer ? onOpenLayer(row, layer) : onOpen(row))}
        />
      );
    }
    return <ReviewRowItem key={row.id} {...props} />;
  };
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
        {local}
        {hiddenFold}
      </div>
    );
  }
  return (
    <>
      {notice}
      <ReviewGroup label="On you" name="on_you" count={groups.on_you.length}>{groups.on_you.map(draw)}</ReviewGroup>
      <ReviewGroup label="With your agents" name="agents" count={groups.agents.length}>{groups.agents.map(draw)}</ReviewGroup>
      <ReviewGroup label="Ready to land" name="ready" count={groups.ready.length}>{groups.ready.map(draw)}</ReviewGroup>
      <ReviewGroup label="Waiting on others" name="waiting" count={groups.waiting.length} fold={{ open: waitingOpen, onToggle: () => toggle('waiting') }}>
        {groups.waiting.map(draw)}
      </ReviewGroup>
      <ReviewGroup label="Open, not reviewed" name="not_reviewed" count={groups.not_reviewed.length} fold={{ open: listedOpen, onToggle: () => toggle('not_reviewed') }}>
        {groups.not_reviewed.map(draw)}
      </ReviewGroup>
      {notJudgedLine}
      {notRankedLine}
      {local}
      {hiddenFold}
    </>
  );
}
