/**
 * Reviews (approval "inbox-reviews-page", on approvals "inbox-code-review-direction", items 4 and 5, and
 * "pr-page-review-with-agent", the Inline take): a sidebar row, shown only while Settings → Capabilities →
 * Code review is on. It needs no Board. The list is ReviewsList.tsx; beside a thread, the pane is the Inbox's own.
 *
 * - The stack view beside it (a phone: in its place): the title, then one
 *   review thread per PR or stack and one button for it, under the title:
 *   "Review with an agent" (the picker: a running agent of this project, or a
 *   new one where the Inbox can start one), "Open review thread" once it has
 *   one, or "Start a new review thread" once its agent ended. "Open the diff"
 *   (phase 1's review mode, layer by layer; the whole stack is its switch)
 *   sits beside it in every state, as each layer's row does. Then the layers
 *   from the base branch up, the lowest open one marked "Lands next"; a Board
 *   chip only when the Board is on and a card links it; Reply at the foot goes
 *   into the review thread. No merge button.
 *
 * - System (approval "system-inbox", screens 3, 4a and 4b; only while `systemShown`): the System button beside the
 *   filter mark lists the drawn projects; one opens its drawing in the pane (`&system=`), with the open PRs that
 *   change it, and a full window (`&full=1`). The list is never filtered by it. A PR's pane opened from it goes back
 *   to the drawing when closed.
 *
 * Read only while the page is open (usePulls). No new keyboard shortcuts.
 */
import { reviewBoxPull, type ReviewBoxPull } from '../compose/reviewBox';
import { forwardRef, useEffect, useId, useMemo, useRef, useState } from 'react';
import { type InboxPull, type InboxPullItem, type InboxPullLink, type InboxPullRiskJudgment, type InboxPullsAnswer, type InboxPullStack } from '@plannotator/core/inbox-types';
import { formatCount, plural } from '@plannotator/core/inbox-format';
import { InboxApiError, inboxApi, type ProjectFolder } from '../api';
import { Icon } from '../icons';
import { RefMarkIcon } from '../board/RefMark';
import { RowAgentTiles } from '../components/RowAgents';
import { Tip } from '../components/Tip';
import { relativeTime, relativeWords, useRelativeClock } from '../relativeTime';
import { SidebarTrigger } from '../shell/sidebar';
import { ListColumnEdge } from '../shell/ListColumnEdge';
import { newUuid } from '../uuid';
import { matchesShortcutBinding, resolveShortcutBindings } from '@plannotator/ui/shortcuts';
import { ShortcutHint, useShortcutAria, withShortcut } from '../shortcuts/hint';
import { inboxAppShortcuts } from '../shortcuts/app.shortcuts';
import { inboxThreadShortcuts } from '../shortcuts/thread.shortcuts';
import {
  checksWords,
  findStack,
  inboxPullLabel,
  ladderHeading,
  layerPill,
  linkAgentName,
  pullGroups,
  openLayers,
  pullNounWord,
  stackProjects,
  stackTitle,
  type PullFilter,
} from './model';
import { PullFilterControl, PullScopeLine, useFilterTrigger } from './PullFilter';
import { ReviewsList } from './ReviewsList';
import { reviewRowProjects, reviewRowsIn } from './reviewsModel';
import { forgeName } from './labels';
import { answeredClis } from './notices';
import { filterReviewRows, readRiskFilter, riskLevelWord, saveRiskFilter, stackRisk, stackRiskFailure, type RiskFailures, type RiskFilterValue, type RiskJudgments } from './risk';
import { RiskFilter } from './RiskFilter';
import { COULD_NOT_RANK, RiskMark } from './RiskMark';
import { RiskRulesDialog } from './RiskRulesDialog';
import { usePullRisk } from './usePullRisk';
import { landsNextLayer, layerBaseWords, stackLink, startLayer } from './topology';
import type { PullsState } from './usePulls';
import type { SystemProjectRow } from '@plannotator/core/inbox-system';
import { SystemButton } from '../system/SystemButton';
import { SystemPane } from '../system/SystemPane';

/** System in Reviews: present only while System shows (`systemShown`). */
export interface PullsSystem {
  /** The projects with their drawing's state; null until read. */
  projects: SystemProjectRow[] | null;
  /** The project whose drawing is open (`&system=`), its sheet (`&sheet=`) and whether it has the whole window (`&full=1`). */
  open: string | null;
  sheet: string | null;
  full: boolean;
  /** Open a project's drawing (the menu), or close it (null). */
  onOpen: (project: string | null) => void;
  onSheet: (sheet: string) => void;
  onFull: (full: boolean) => void;
  /** The menu opened: read the projects again. */
  onMenu: () => void;
}

export interface PullsPageProps {
  state: PullsState;
  /** The stack open beside the list (its id, or any layer's key), or null. */
  stackId: string | null;
  project: string | null;
  /** The list's view (`&view=`): All, Mine, To review or Others. */
  filter: PullFilter;
  projects: readonly ProjectFolder[];
  projectNames: ReadonlyMap<string, string>;
  phone: boolean;
  /** Reviews' thread open beside the list: the page draws only the list, and the window the thread (the Inbox's own pane). */
  threadId?: string | null;
  /** The header's +, the empty state's New review. */
  onNew: () => void;
  onOpenStack: (id: string | null) => void;
  /** A new view and project from the filter, in one step. */
  onScope: (next: { filter: PullFilter; project: string | null }) => void;
  /** Phase 1's review mode on one layer (`scope` layer), or on the stack up to it (`stack`). */
  onReview: (stackId: string, layerKey: string, scope: 'layer' | 'stack') => void;
  onOpenThread: (threadId: string) => void;
  /** Absent while the Board is off (no card chip shows then: the answer has no cards). */
  onOpenCard?: (cardId: string) => void;
  /** A PR nobody is reviewing: the New review box, filled in with it. */
  onNewReview: (pick: ReviewBoxPull, opener: HTMLElement) => void;
  /** System's button and drawing; absent while System does not show. */
  system?: PullsSystem | null;
}

const NO_JUDGMENTS: RiskJudgments = {};
const NO_FAILURES: RiskFailures = {};

export function PullsPage(given: PullsPageProps) {
  const model = given.state.model;
  const answer = given.state.reviews;
  // The filter offers the projects with a review here, or a GitHub or GitLab remote.
  const offered = useMemo(() => {
    const ids = answer ? reviewRowProjects(answer) : new Set(Object.values(model?.projects ?? {}).flat());
    return given.projects.filter((p) => ids.has(p.id));
  }, [answer, model, given.projects]);
  // A project gone from the list (removed, its remote changed, a stale link) is no filter, as an unknown view is All:
  // never a line naming no project over an empty list. Before the projects and the first answer, it stands.
  const gone = !!given.project && !!model && given.projects.length > 0 && !offered.some((p) => p.id === given.project);
  const props = gone ? { ...given, project: null } : given;
  const { state, phone } = props;
  const groups = useMemo(() => (model ? pullGroups(model, props.project, props.filter) : null), [model, props.project, props.filter]);
  // A stack the address names opens even when the view leaves it out (a link like `view=mine&stack=…`): never a blank pane.
  const open = useMemo(() => {
    if (!groups || !model || !props.stackId) return null;
    return findStack(groups, props.stackId) ?? (props.filter === 'all' ? null : findStack(pullGroups(model, props.project), props.stackId));
  }, [groups, model, props.stackId, props.filter, props.project]);
  const rows = useMemo(() => (answer ? reviewRowsIn(answer, props.project, props.filter) : null), [answer, props.project, props.filter]);
  // Risk ranking (inbox-pull-risk.ts). The filter acts only once rules exist, and never closes the stack open beside the list.
  const risk = usePullRisk(model);
  const rulesSet = !!risk.answer?.rules;
  const judgments: RiskJudgments = risk.answer?.judgments ?? NO_JUDGMENTS;
  const riskFailed: RiskFailures = risk.answer?.failed ?? NO_FAILURES;
  const [riskFilter, setRiskFilter] = useState<RiskFilterValue>(readRiskFilter);
  const [rulesOpen, setRulesOpen] = useState(false);
  const activeRisk = rulesSet ? riskFilter : 'all';
  const ranked = useMemo(() => (rows ? filterReviewRows(rows, activeRisk, judgments, riskFailed) : null), [rows, activeRisk, judgments, riskFailed]);
  const trigger = useFilterTrigger();
  const head = useRef<HTMLDivElement>(null);
  const system = props.system ?? null;
  // The drawing shows while no PR's pane does: a PR opened from it closes back to it.
  const systemOpen = system?.open && !open ? system.open : null;
  // The drawing closed (its ×, Escape, a phone's "Reviews"): the focus it held returns to the System button.
  const drawingWas = useRef(system?.open ?? null);
  useEffect(() => {
    const was = drawingWas.current;
    drawingWas.current = system?.open ?? null;
    if (!was || system?.open) return;
    requestAnimationFrame(() => {
      const lost = !document.activeElement || document.activeElement === document.body;
      if (lost) head.current?.querySelector<HTMLElement>('[data-system-button]')?.focus({ preventScroll: true });
    });
  }, [system?.open]);
  const projectName = props.project ? (props.projectNames.get(props.project) ?? offered.find((p) => p.id === props.project)?.name ?? null) : null;

  const list = (
    <section className={`ib-listcol${phone ? '' : ' ib-narrow ib-resizable'} ib-prlist`} aria-label="Reviews" data-pulls-list="">
      <div className="ib-lhead" ref={head}>
        <SidebarTrigger />
        <h1 dir="auto" tabIndex={-1} data-pulls-heading="">
          Reviews
        </h1>
        {(model || system) && (
          <span className="ib-pf-slot">
            {system && <SystemButton projects={system.projects} open={systemOpen} phone={phone} portalRef={head} onOpen={system.onOpen} onMenu={system.onMenu} />}
            {/* Shown once a first answer came: before it, there is nothing to filter. */}
            {model && (
              <PullFilterControl
                count={(project, filter) => (answer ? reviewRowsIn(answer, project, filter).length : 0)}
                filter={props.filter}
                project={props.project}
                projects={offered}
                names={props.projectNames}
                phone={phone}
                triggerRef={trigger}
                onChange={props.onScope}
              />
            )}
          </span>
        )}
        {risk.answer && (
          <RiskFilter
            value={activeRisk}
            rulesSet={rulesSet}
            phone={phone}
            onChange={(next) => {
              setRiskFilter(next);
              saveRiskFilter(next);
            }}
            onRules={() => setRulesOpen(true)}
          />
        )}
        <Tip content="New review">
          <button type="button" className="ib-iconbtn ib-pr-new" onClick={props.onNew} aria-label="New review" data-reviews-new="head">
            <Icon name="plus" size={18} />
          </button>
        </Tip>
      </div>
      {model && <PullScopeLine filter={props.filter} projectName={projectName} triggerRef={trigger} onClear={() => props.onScope({ filter: 'all', project: null })} />}
      <div className="ib-lbody" aria-busy={state.loading && !model ? true : undefined}>
        {!model && state.error && (
          <div className="ib-error" role="alert" style={{ margin: '8px 2px' }}>
            {state.error}
          </div>
        )}
        {!model && !state.error && <p className="ib-pr-empty">Reading your pull requests…</p>}
        {model && answer && ranked && (
          <ReviewsList
            answer={answer}
            model={model}
            rows={ranked.rows}
            filter={props.filter}
            risk={activeRisk}
            notJudged={ranked.notJudged}
            notRanked={ranked.notRanked}
            judgments={judgments}
            riskFailed={riskFailed}
            projectNames={props.projectNames}
            selected={props.threadId ?? open?.stack.id ?? null}
            phone={phone}
            onOpen={(row) => (row.reviewed && row.thread_id ? props.onOpenThread(row.thread_id) : props.onOpenStack(row.stacks[0]?.id ?? null))}
            onNew={props.onNew}
          />
        )}
      </div>
      <PullsFoot model={model} loading={state.loading} error={model ? state.error : null} onRefresh={state.refresh} />
      {!phone && <ListColumnEdge />}
      {rulesOpen && risk.answer && (
        <RiskRulesDialog
          answer={risk.answer}
          onClose={() => setRulesOpen(false)}
          onSaved={(next) => {
            risk.setAnswer(next);
            setRulesOpen(false);
            // A list read is what starts the judgments of the new rules.
            state.reload();
          }}
        />
      )}
    </section>
  );

  if (props.threadId) return list;
  const drawing =
    system && systemOpen ? (
      <SystemPane
        key={systemOpen}
        project={systemOpen}
        sheet={system.sheet}
        full={system.full}
        phone={phone}
        pulls={model}
        onSheet={system.onSheet}
        onFull={system.onFull}
        onClose={() => system.onOpen(null)}
        onOpenStack={(key) => props.onOpenStack(key)}
      />
    ) : null;
  if (phone && open && model) {
    return <StackView key={open.stack.id} {...props} item={open} model={model} judgments={judgments} riskFailed={riskFailed} phone onClose={() => props.onOpenStack(null)} />;
  }
  if (phone && drawing) return drawing;
  return (
    <>
      {list}
      {!phone &&
        (open && model ? (
          <StackView key={open.stack.id} {...props} item={open} model={model} judgments={judgments} riskFailed={riskFailed} phone={false} onClose={() => props.onOpenStack(null)} />
        ) : drawing ? (
          drawing
        ) : (
          <div className="ib-pane ib-pempty" data-pulls-pane-empty="">
            {rows && rows.length > 0 ? 'Pick a review to open it.' : null}
          </div>
        ))}
    </>
  );
}

/** A `#reviews` or `#pulls` link while Settings → Capabilities → Code review is off: what is here, and the way to turn it on. Nothing is read. */
export function ReviewsOff({ phone, onSettings }: { phone: boolean; onSettings: () => void }) {
  return (
    <>
      <section className={`ib-listcol${phone ? '' : ' ib-narrow ib-resizable'} ib-prlist`} aria-label="Reviews" data-reviews-off="">
        <div className="ib-lhead">
          <SidebarTrigger />
          <h1 dir="auto" tabIndex={-1}>
            Reviews
          </h1>
        </div>
        <div className="ib-lbody ib-pr-off">
          <div className="ib-pr-empty">
            <p className="ib-pr-empty-h">Code review is off</p>
            <p>Reviews of your local changes and pull requests show here when it’s on.</p>
            <button type="button" className="ib-btn" onClick={onSettings} data-reviews-off-settings="">
              Open Settings
            </button>
          </div>
        </div>
        {!phone && <ListColumnEdge />}
      </section>
      {!phone && <div className="ib-pane ib-pempty" />}
    </>
  );
}

function PullsFoot({ model, loading, error, onRefresh }: { model: InboxPullsAnswer | null; loading: boolean; error: string | null; onRefresh: () => void }) {
  const now = useRelativeClock(true);
  // Shift+R runs this ↻ on Reviews (approval "inbox-refresh-key"): its keycap and key name, gone with single keys off.
  const refreshKeys = useShortcutAria({ scope: inboxAppShortcuts, action: 'refresh' });
  // Only the CLIs that answered: a host that failed is said in the list, by name.
  const answered = model ? answeredClis(model) : [];
  const when = model?.fetched_at ? relativeWords(model.fetched_at, now) : null;
  const words = error
    ? error
    : !model
      ? 'From gh and glab on this computer'
      : answered.length > 0
        ? `From ${answered.join(' and ')} on this computer${when ? ` · ${when}` : ''}`
        : model.hosts.length > 0
          ? 'Nothing read this time'
          : 'Nothing read on this computer';
  return (
    <div className="ib-pr-foot" data-pulls-foot="">
      <Tip content={withShortcut('Read again', { scope: inboxAppShortcuts, action: 'refresh' })}>
        <button
          type="button"
          className="ib-iconbtn ib-pr-refresh"
          onClick={onRefresh}
          aria-label="Read the pull requests again"
          aria-keyshortcuts={refreshKeys}
          data-refreshing={loading ? '' : undefined}
          data-pulls-refresh=""
        >
          <Icon name="refresh" size={14} />
        </button>
      </Tip>
      <span className="ib-pr-foot-t" aria-live="polite" title={words || undefined} data-pulls-foot-words="">
        {words}
      </span>
    </div>
  );
}

function StackView(props: PullsPageProps & { item: InboxPullItem; model: InboxPullsAnswer; judgments: RiskJudgments; riskFailed: RiskFailures; phone: boolean; onClose: () => void }) {
  const { item, model, phone, judgments, riskFailed } = props;
  const stack = item.stack;
  // The stack's one review thread: its lowest open linked layer's (`stackLink`), whoever else linked a layer above.
  const link = stackLink(stack, model.links);
  const agent = linkAgentName(link);
  // The Board is optional: a card shows only while the Board is on and one links a layer (the answer has none otherwise).
  const card = stack.layers.map((l) => model.cards?.[l.key]).find((c) => !!c) ?? null;
  const now = useRelativeClock(true);
  // "Lands next" only where the base is one it lands on (a merged layer in the middle, or an unread base, gets none).
  const next = landsNextLayer(stack);
  // An agent whose session ended stays named, marked ended; a new review thread can start (Reply gives way).
  const ended = link?.agent?.ended === true;
  const start = startLayer(stack);
  const open = openLayers(stack);
  // What a review thread is about (`handoffStack`): with none yet, the whole stack (a tree: the chain to its top); a new
  // one after its agent ended, the layers that thread had. A tree's sibling left out of that chain shows nothing of
  // its own here.
  const top = open[open.length - 1] ?? stack.layers[stack.layers.length - 1]!;
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // A stack opened from the list: its title takes focus only on a phone (the list stays where the person is otherwise).
    if (phone) heading.current?.focus({ preventScroll: true });
  }, [stack.id, phone]);
  const forge = forgeName(stack);
  const many = open.length > 1;
  // A thread that only named the PR isn't a review of it: the page's rows say so, the stack stays Open, not reviewed.
  const mentioned = !!link && !ended && props.state.reviews?.rows.find((row) => row.stacks.some((s) => s.id === stack.id))?.reviewed === false;
  // One review thread at a time: the picker opens only while there is none, or its agent has ended.
  const canStart = open.length > 0 && (!link || ended || mentioned);
  const primary = canStart ? (
    <button
      type="button"
      className="ib-btn ib-pri"
      onClick={(event) => props.onNewReview(reviewBoxPull(stack, { reviewed: false, thread_id: null, link, review: null }, model.links, projects), event.currentTarget)}
      data-pulls-primary={link && !mentioned ? 'again' : 'review'}
    >
      <Icon name="plus" size={15} />
      {link && !mentioned ? 'Start a new review thread' : 'Review with an agent'}
    </button>
  ) : link && !ended ? (
    <button type="button" className="ib-btn ib-pri" onClick={() => props.onOpenThread(link.thread_id)} data-pulls-primary="open">
      <Icon name="questionBubble" size={15} />
      Open review thread
    </button>
  ) : null;
  // The person's own review, in every state: straight into phase 1's review mode (layer by layer for a stack), no stop on the way.
  // A stack's whole diff is the review's own "This layer | Whole stack" switch, not a second button here.
  const openThread = mentioned ? (
    <button type="button" className="ib-btn" onClick={() => props.onOpenThread(link!.thread_id)} data-pulls-open-thread="">
      Open thread
    </button>
  ) : null;
  const openDiff = start ? (
    <button type="button" className="ib-btn" onClick={() => props.onReview(stack.id, start.key, 'layer')} data-pulls-open-diff="">
      <Icon name="code" size={15} />
      Open the diff
    </button>
  ) : null;
  const projects = stackProjects(model, stack);
  const judged = stackRisk(stack, judgments);
  const riskFailure = stackRiskFailure(stack, judgments, riskFailed);
  return (
    <section className="ib-pane ib-prpane" aria-labelledby={titleId} data-pulls-stack={stack.id}>
      <div className="ib-pr-bar">
        {phone && (
          <button type="button" className="ib-iconbtn" onClick={props.onClose} aria-label="Back to reviews">
            <Icon name="back" />
          </button>
        )}
        <a className="ib-pr-ext" href={(many ? top : (start ?? top)).url} target="_blank" rel="noreferrer noopener" data-pulls-open-forge="">
          <Icon name="external" size={15} />
          {phone ? <span className="ib-sr">Open on {forge}</span> : `Open on ${forge}`}
        </a>
        <span className="ib-sp" />
        {!phone && (
          <Tip content="Close">
            <button type="button" className="ib-iconbtn" onClick={props.onClose} aria-label="Close the stack">
              <Icon name="x" />
            </button>
          </Tip>
        )}
      </div>
      <div className="ib-pr-body">
        <h2 id={titleId} ref={heading} tabIndex={-1} className="ib-pr-h" dir="auto">
          {stackTitle(stack, model.links)}
        </h2>
        <div className="ib-pr-meta">
          <span dir="auto">{stack.host === 'github.com' ? stack.repo : `${stack.host}/${stack.repo}`}</span>
          {stack.layers.length > 1 && <span>{plural(stack.layers.length, pullNounWord(stack.platform))}</span>}
          {phone && next && (
            <span data-pulls-lands-next-head="">
              Lands next: <span className="ib-pr-num">{inboxPullLabel(next)}</span>
            </span>
          )}
          {card && props.onOpenCard && (
            <Tip content="Open its card on the Board">
              <button type="button" className="ib-pr-chip" onClick={() => props.onOpenCard!(card.id)} data-pulls-card={card.id}>
                <Icon name="board" size={13} />
                <span className="ib-pr-chip-k">Board</span>
                <span dir="auto">{card.title}</span>
              </button>
            </Tip>
          )}
        </div>
        {riskFailure && (
          <p className="ib-pr-riskline" data-pulls-risk-line="failed">
            <span className="ib-risk" data-risk="failed">
              {COULD_NOT_RANK}
            </span>
            <span dir="auto">{riskFailure}</span>
          </p>
        )}
        {judged && (
          <p className="ib-pr-riskline" data-pulls-risk-line={judged.level}>
            <span className="ib-risk" data-risk={judged.level}>
              {riskLevelWord[judged.level]} risk
            </span>{' '}
            <span dir="auto">{judged.why}</span>
          </p>
        )}
        {link && <ThreadLine link={link} ended={ended} mentioned={mentioned} now={now} />}
        {(primary || openDiff) && (
          <div className="ib-pr-actions">
            {primary}
            {openThread}
            {openDiff}
          </div>
        )}
        <div className="ib-pr-order">
          <div className="ib-pr-order-h">
            <b>{ladderHeading(stack)}</b>
          </div>
          <ol className="ib-pr-ladder" reversed>
            {[...stack.layers].reverse().map((layer) => (
              <Layer key={layer.key} layer={layer} stack={stack} next={next?.key === layer.key} now={now} layerRisk={stack.layers.length > 1 ? judgments[layer.key] : undefined} layerFailed={stack.layers.length > 1 ? riskFailed[layer.key] : undefined} onReview={() => props.onReview(stack.id, layer.key, 'layer')} />
            ))}
            <li className="ib-pr-base" aria-label={`Base branch ${stack.base}`}>
              <span className="ib-pr-dot" aria-hidden="true" />
              <code>{stack.base}</code>
            </li>
          </ol>
        </div>
      </div>
      {link?.last && !ended && <StackReply key={link.thread_id} link={link} agent={agent ?? 'the agent'} onOpenThread={() => props.onOpenThread(link.thread_id)} />}
    </section>
  );
}

/**
 * The review thread's agent, under the title: its tile, "Review thread with Claude Code" and where it stands (the ask
 * on its way, the last answer's time, or none yet), its last words under it; "Claude Code ended" once its session
 * ended. No box. Focus lands here when a thread has just started.
 */
const ThreadLine = forwardRef<HTMLDivElement, { link: InboxPullLink; ended: boolean; mentioned?: boolean; now: number }>(function ThreadLine({ link, ended, mentioned, now }, ref) {
  const name = linkAgentName(link) ?? 'Agent';
  // The ask (the person started it), until the agent's guided review arrives in the thread.
  const asked = link.via === 'owner' && link.ask && !link.guide?.review ? (link.ask === 'custom' ? 'Custom curation on the way' : 'Guided review on the way') : null;
  return (
    <div ref={ref} tabIndex={-1} className="ib-pr-thread" data-pulls-thread-line={ended ? 'ended' : asked ? 'asked' : 'live'} data-pulls-thread={link.thread_id}>
      <div className="ib-pr-thread-h">
        <RowAgentTiles participants={undefined} agent={{ kind: 'agent', host: link.agent?.host ?? null }} tip={false} />
        {ended ? (
          <span>
            <b>{name}</b> ended
          </span>
        ) : (
          <>
            <span>
              {mentioned ? 'Thread' : 'Review thread'} with <b>{name}</b>
            </span>
            <span className="ib-mut" data-pulls-ask={asked ? link.ask : undefined}>
              {asked ?? (link.last ? relativeTime(link.last.at, now) : 'No answer yet')}
            </span>
          </>
        )}
      </div>
      {!ended && !asked && link.last && (
        <p className="ib-pr-thread-p" dir="auto">
          {link.last.preview}
        </p>
      )}
    </div>
  );
});

function Layer({ layer, stack, next, now, layerRisk, layerFailed, onReview }: { layer: InboxPull; stack: InboxPullStack; next: boolean; now: number; layerRisk?: InboxPullRiskJudgment; layerFailed?: string; onReview: () => void }) {
  const pill = layerPill(layer);
  const checks = checksWords(layer);
  const base = layerBaseWords(layer, stack);
  const merged = layer.state === 'merged';
  const body = (
    <>
      <span className="ib-pr-lmark ib-bc-mark" data-card-mark={layer.state} data-card-mark-kind="pr" aria-hidden="true">
        <RefMarkIcon kind="pr" state={layer.state} size={15} />
      </span>
      <span className="ib-pr-lmain">
        <span className="ib-pr-l1">
          <span className="ib-pr-num">{inboxPullLabel(layer)}</span>
          <span className="ib-pr-lt" dir="auto">
            {layer.title}
          </span>
          {next && (
            <span className="ib-pr-pill" data-tone="next" data-pulls-lands-next="">
              Lands next
            </span>
          )}
          {layerRisk && <RiskMark judgment={layerRisk} />}
          {!layerRisk && layerFailed && <RiskMark failed={layerFailed} />}
        </span>
        <span className="ib-pr-l2">
          {merged ? (
            <span>
              Merged {layer.merged_at ? relativeWords(layer.merged_at, now) : ''}
              {layer.mine ? ' by you' : ''}
            </span>
          ) : (
            <>
              <span className="ib-add">+{formatCount(layer.additions)}</span>
              <span className="ib-del">−{formatCount(layer.deletions)}</span>
              <span>{plural(layer.files, 'file')}</span>
              {checks && (
                <span className="ib-pr-checks" data-checks={layer.checks}>
                  <Icon name={layer.checks === 'success' ? 'check' : layer.checks === 'failure' ? 'x' : 'clock'} size={12} />
                  {checks}
                </span>
              )}
              {base && <span className="ib-pr-basew">{base}</span>}
            </>
          )}
        </span>
      </span>
      {pill && (
        <span className="ib-pr-pill" data-tone={pill.tone}>
          {pill.text}
        </span>
      )}
    </>
  );
  return (
    <li className="ib-pr-layer" data-pulls-layer={layer.key} data-state={layer.state}>
      {merged || layer.state === 'closed' ? (
        <div className="ib-pr-lrow">{body}</div>
      ) : (
        <button type="button" className="ib-pr-lrow" onClick={onReview} aria-label={`Open diff ${inboxPullLabel(layer)} ${layer.title}${next ? ', lands next' : ''}`}>
          {body}
          <span className="ib-pr-lgo" aria-hidden="true">
            Open diff
            <Icon name="chevR" size={13} />
          </span>
        </button>
      )}
    </li>
  );
}

/** Reply at the foot: one reply into the agent's thread, to its last message, as the thread's reply box sends it. */
function StackReply({ link, agent, onOpenThread }: { link: InboxPullLink; agent: string; onOpenThread: () => void }) {
  const [open, setOpen] = useState(false);
  const [words, setWords] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const key = useRef<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const sendKeys = useShortcutAria({ scope: inboxThreadShortcuts, action: 'send' });
  useEffect(() => {
    if (open) box.current?.focus();
  }, [open]);
  const send = async () => {
    const text = words.trim();
    if (!text || sending || !link.last) return;
    setSending(true);
    setError(null);
    key.current ??= newUuid();
    try {
      await inboxApi.reply(link.last.message_id, { idempotency_key: key.current, words: text, questions: [] });
      key.current = null;
      setWords('');
      setOpen(false);
      setSent(true);
    } catch (cause) {
      setError(cause instanceof InboxApiError || cause instanceof Error ? cause.message : 'Your reply was not sent.');
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="ib-pr-replyfoot" data-pulls-reply="">
      {open ? (
        <div className="ib-pr-replybox">
          <textarea
            ref={box}
            className="ib-pr-replyin"
            rows={3}
            value={words}
            placeholder={`Reply to ${agent}`}
            aria-label={`Reply to ${agent}`}
            onChange={(event) => setWords(event.target.value)}
            onKeyDown={(event) => {
              // The registry's Send (`inboxThreadShortcuts.send`, Mod+Enter), as the thread's reply box and compose match it.
              if (!event.nativeEvent.isComposing && resolveShortcutBindings(inboxThreadShortcuts.shortcuts.send).some((binding) => matchesShortcutBinding(event.nativeEvent, binding))) {
                event.preventDefault();
                void send();
              } else if (event.key === 'Escape' && !words.trim()) {
                event.preventDefault();
                setOpen(false);
              }
            }}
            disabled={sending}
          />
          {error && (
            <div className="ib-error" role="alert">
              {error}
            </div>
          )}
          <div className="ib-pr-replyacts">
            <span className="ib-mut">Goes to {agent}’s thread</span>
            <span className="ib-sp" />
            <button type="button" className="ib-btn" onClick={() => setOpen(false)} disabled={sending}>
              Cancel
            </button>
            <button type="button" className="ib-btn ib-pri" onClick={() => void send()} disabled={sending || !words.trim()} aria-keyshortcuts={sendKeys} data-pulls-reply-send="">
              {sending ? 'Sending…' : 'Send'}
              <ShortcutHint scope={inboxThreadShortcuts} action="send" />
            </button>
          </div>
        </div>
      ) : (
        <div className="ib-pr-replyrow">
          <button
            type="button"
            className="ib-pr-replybtn"
            onClick={() => {
              setSent(false);
              setOpen(true);
            }}
            data-pulls-reply-open=""
          >
            <Icon name="reply" size={15} />
            <b>Reply</b> <span className="ib-mut">to {agent}</span>
          </button>
          {sent && (
            <span className="ib-pr-sent" role="status">
              Sent.{' '}
              <button type="button" className="ib-pr-linkbtn" onClick={onOpenThread}>
                Open the thread
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
