/**
 * Pull requests (approval "inbox-code-review-direction", items 4 and 5;
 * concept B, take 1; the agent flow: approval "pr-page-review-with-agent",
 * the Inline take): a sidebar row, shown only while Settings → Capabilities →
 * Code review is on. It needs no Board.
 *
 * - The list, in the Inbox list's own rows and bands, grouped by whose move
 *   it is: On you (a teammate asked for the person's review, or the
 *   person's agent opened a PR that waits on them), Ready to land, and a
 *   folded "N waiting on others". A stack is one row: its third line is a
 *   small chain of PR marks in landing order. Top left, always the author's
 *   picture (the owner on #2608); the agent of its review thread is on the
 *   third line, with its mark ("#48201 · Review thread with Claude Code").
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
 * Read only while the page is open (usePulls). No new keyboard shortcuts.
 */
import { forwardRef, useEffect, useId, useMemo, useRef, useState } from 'react';
import { inboxPullRepoKey, type InboxPull, type InboxPullItem, type InboxPullLink, type InboxPullsAnswer, type InboxPullStack } from '@plannotator/core/inbox-types';
import { formatCount, plural } from '@plannotator/core/inbox-format';
import { InboxApiError, inboxApi, type ProjectFolder } from '../api';
import { HostMark, Icon } from '../icons';
import { RefMarkIcon } from '../board/RefMark';
import { ProjectFilter } from '../board/ProjectFilter';
import { RowAgentTiles } from '../components/RowAgents';
import { Tip } from '../components/Tip';
import { relativeTime, relativeWords, useRelativeClock } from '../relativeTime';
import { SidebarTrigger } from '../shell/sidebar';
import { ListColumnEdge } from '../shell/ListColumnEdge';
import { newUuid } from '../uuid';
import { matchesShortcutBinding, resolveShortcutBindings } from '@plannotator/ui/shortcuts';
import { ShortcutHint, useShortcutAria } from '../shortcuts/hint';
import { inboxThreadShortcuts } from '../shortcuts/thread.shortcuts';
import {
  checksWords,
  findStack,
  handoffKeys,
  inboxPullLabel,
  ladderHeading,
  layerPill,
  linkAgentName,
  pullGroups,
  pullHandoffAskLine,
  pullHandoffThreadName,
  handoffStack,
  openLayers,
  pullNounWord,
  pullRows,
  rowMeta,
  stackProjects,
  stackTitle,
} from './model';
import { forgeName, initials, repoLabels, repoName } from './labels';
import { answeredClis, pullsEmptyWords, pullsNotices } from './notices';
import { ReviewPicker } from './ReviewPicker';
import { chainMarks, landsNextLayer, layerBaseWords, stackLink, startLayer } from './topology';
import type { PullsState } from './usePulls';

export interface PullsPageProps {
  state: PullsState;
  /** The stack open beside the list (its id, or any layer's key), or null. */
  stackId: string | null;
  project: string | null;
  projects: readonly ProjectFolder[];
  projectNames: ReadonlyMap<string, string>;
  phone: boolean;
  onOpenStack: (id: string | null) => void;
  onProject: (id: string | null) => void;
  /** Phase 1's review mode on one layer (`scope` layer), or on the stack up to it (`stack`). */
  onReview: (stackId: string, layerKey: string, scope: 'layer' | 'stack') => void;
  onOpenThread: (threadId: string) => void;
  /** Absent while the Board is off (no card chip shows then: the answer has no cards). */
  onOpenCard?: (cardId: string) => void;
  /**
   * Start a new agent: compose's New thread, with the review thread's first message and the PRs it is for.
   * `threadName`: the new thread's name (`pullHandoffThreadName`), compose's chip as it opens.
   */
  onLaunch: (keys: readonly string[], projects: readonly string[], body: string, askLine: string, opener: HTMLElement, threadName: string) => void;
  /** A review thread started with `session`, the picked agent: the list reads it. */
  onStarted: (session: string) => void;
}

/** A layer's state as the Board's mark draws it. */
function markState(pull: InboxPull): 'open' | 'draft' | 'merged' | 'closed' {
  return pull.state;
}

export function PullsPage(props: PullsPageProps) {
  const { state, phone } = props;
  const model = state.model;
  const groups = useMemo(() => (model ? pullGroups(model, props.project) : null), [model, props.project]);
  const open = groups && props.stackId ? findStack(groups, props.stackId) : null;
  // The filter offers the projects that have a GitHub or GitLab remote here.
  const offered = useMemo(() => {
    const ids = new Set(Object.values(model?.projects ?? {}).flat());
    return props.projects.filter((p) => ids.has(p.id));
  }, [model, props.projects]);

  const list = (
    <section className={`ib-listcol${phone ? '' : ' ib-narrow ib-resizable'} ib-prlist`} aria-label="Pull requests" data-pulls-list="">
      <div className="ib-lhead">
        <SidebarTrigger />
        <h1 dir="auto" tabIndex={-1} data-pulls-heading="">
          Pull requests
        </h1>
        {groups && groups.on_you.length > 0 && (
          <span className="ib-pr-onyou" data-pulls-on-you={groups.on_you.length}>
            {formatCount(groups.on_you.length)} on you
          </span>
        )}
        <span className="ib-sp" />
        {offered.length > 1 && <ProjectFilter projects={offered} names={props.projectNames} value={props.project} phone={phone} onChange={props.onProject} />}
      </div>
      <div className="ib-lbody" aria-busy={state.loading && !model ? true : undefined}>
        {!model && state.error && (
          <div className="ib-error" role="alert" style={{ margin: '8px 2px' }}>
            {state.error}
          </div>
        )}
        {!model && !state.error && <p className="ib-pr-empty">Reading your pull requests…</p>}
        {model && groups && <PullList model={model} groups={groups} selected={open?.stack.id ?? null} phone={phone} onOpen={(id) => props.onOpenStack(id)} />}
      </div>
      <PullsFoot model={model} loading={state.loading} error={model ? state.error : null} onRefresh={state.refresh} />
      {!phone && <ListColumnEdge />}
    </section>
  );

  if (phone && open && model) {
    return <StackView key={open.stack.id} {...props} item={open} model={model} phone onClose={() => props.onOpenStack(null)} />;
  }
  return (
    <>
      {list}
      {!phone &&
        (open && model ? (
          <StackView key={open.stack.id} {...props} item={open} model={model} phone={false} onClose={() => props.onOpenStack(null)} />
        ) : (
          <div className="ib-pane ib-pempty" data-pulls-pane-empty="">
            {model && groups && groups.on_you.length + groups.ready.length + groups.waiting.length > 0 ? 'Pick a pull request to see its layers.' : null}
          </div>
        ))}
    </>
  );
}

function PullList({ model, groups, selected, phone, onOpen }: { model: InboxPullsAnswer; groups: ReturnType<typeof pullGroups>; selected: string | null; phone: boolean; onOpen: (id: string) => void }) {
  const [waitingOpen, setWaitingOpen] = useState(false);
  const now = useRelativeClock(true);
  const total = groups.on_you.length + groups.ready.length + groups.waiting.length;
  // A stack opened from the folded group keeps it open.
  useEffect(() => {
    if (selected && groups.waiting.some((i) => i.stack.id === selected)) setWaitingOpen(true);
  }, [selected, groups.waiting]);
  const notices = pullsNotices(model);
  if (total === 0) {
    const empty = pullsEmptyWords(model, notices);
    return (
      <div className="ib-pr-empty" data-pulls-empty={empty.kind}>
        <p className="ib-pr-empty-h">{empty.head}</p>
        {empty.lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
    );
  }
  const labels = repoLabels(pullRows(groups).map((item) => item.stack));
  const row = (item: InboxPullItem) => (
    <PullRow
      key={item.stack.id}
      item={item}
      link={stackLink(item.stack, model.links)}
      links={model.links}
      repoLabel={labels.get(inboxPullRepoKey(item.stack.host, item.stack.repo)) ?? repoName(item.stack.repo)}
      selected={item.stack.id === selected}
      phone={phone}
      now={now}
      onOpen={() => onOpen(item.stack.id)}
    />
  );
  return (
    <>
      {notices.length > 0 && (
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
      )}
      {groups.on_you.length > 0 && (
        <div className="ib-group" role="group" aria-label="On you" data-pulls-group="on_you">
          <div className="ib-band">
            On you <span className="ib-n">{formatCount(groups.on_you.length)}</span>
          </div>
          {groups.on_you.map(row)}
        </div>
      )}
      {groups.ready.length > 0 && (
        <div className="ib-group" role="group" aria-label="Ready to land" data-pulls-group="ready">
          <div className="ib-band">
            Ready to land <span className="ib-n">{formatCount(groups.ready.length)}</span>
          </div>
          {groups.ready.map(row)}
        </div>
      )}
      {groups.waiting.length > 0 && (
        <div className="ib-group ib-pr-fold" role="group" aria-label="Waiting on others" data-pulls-group="waiting">
          <button type="button" className="ib-pr-foldbtn" onClick={() => setWaitingOpen((v) => !v)} aria-expanded={waitingOpen} data-pulls-waiting-toggle="">
            <Icon name={waitingOpen ? 'chevD' : 'chevR'} size={14} />
            {waitingOpen ? (
              <>
                Waiting on others <span className="ib-n">{formatCount(groups.waiting.length)}</span>
              </>
            ) : (
              `${formatCount(groups.waiting.length)} waiting on others`
            )}
          </button>
          {waitingOpen && groups.waiting.map(row)}
        </div>
      )}
    </>
  );
}

/**
 * Who the row is from: the agent's tile when one is tied to it, else the author's initials (a teammate), an empty tile
 * for a teammate's PR whose account is gone (the column stays even), else nothing (the person's own).
 */
/** Pictures that failed or drew nothing in this window, so a row drawn again never asks twice. */
const failedAvatars = new Set<string>();

/**
 * The row's top-left spot: always the PR author's profile picture (the person's own PRs too; a stack's bottom layer's
 * author), read through the Inbox's own route (`GET /api/inbox/pulls/avatar`): the window's CSP never loads a remote
 * image. The initials show while it loads and stay when it cannot; a deleted account is a grey person.
 */
function RowLead({ item }: { item: InboxPullItem }) {
  const bottom = item.stack.layers[0]!;
  const author = bottom.author;
  const src = author ? inboxApi.pullAvatarUrl(bottom.host, author) : null;
  const [shown, setShown] = useState(false);
  const [failed, setFailed] = useState(() => (src ? failedAvatars.has(src) : false));
  useEffect(() => {
    setShown(false);
    setFailed(src ? failedAvatars.has(src) : false);
  }, [src]);
  if (!author || !src) {
    return (
      <Tip content="A deleted account">
        <span className="ib-pr-av ib-pr-av-ghost" role="img" aria-label="A deleted account" data-pulls-ghost="">
          <Icon name="user" size={13} />
        </span>
      </Tip>
    );
  }
  const fail = () => {
    failedAvatars.add(src);
    setFailed(true);
  };
  return (
    <Tip content={author}>
      <span className="ib-pr-av" role="img" aria-label={author} data-pulls-author={author} data-pulls-avatar={failed ? 'none' : shown ? 'shown' : 'loading'}>
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
            onLoad={(event) => {
              const img = event.currentTarget;
              if (img.naturalWidth > 1 && img.naturalHeight > 1) setShown(true);
              else fail();
            }}
            onError={fail}
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
            <span className="ib-bc-mark" data-card-mark={markState(mark)} data-card-mark-kind="pr">
              <RefMarkIcon kind="pr" state={markState(mark)} size={13} />
            </span>
          )}
        </span>
      ))}
    </span>
  );
}

function PullRow({
  item,
  link,
  links,
  repoLabel,
  selected,
  phone,
  now,
  onOpen,
}: {
  item: InboxPullItem;
  link: InboxPullLink | null;
  links: InboxPullsAnswer['links'];
  repoLabel: string;
  selected: boolean;
  phone: boolean;
  now: number;
  onOpen: () => void;
}) {
  const title = stackTitle(item.stack, links);
  const meta = rowMeta(item, link);
  const layers = item.stack.layers.length;
  return (
    <button
      type="button"
      className={`${phone ? 'ib-mrow' : 'ib-nrow'} ib-prrow${item.move === 'on_you' ? ' ib-u' : ''}${selected ? ' ib-sel' : ''}`}
      onClick={onOpen}
      aria-current={selected ? 'true' : undefined}
      data-pulls-row={item.stack.id}
      data-pulls-move={item.move}
      data-pulls-layers={layers}
    >
      <div className="ib-l1">
        <span className="ib-from ib-lead">
          <RowLead item={item} />
          <span className="ib-p" dir="auto" data-pulls-repo="">
            {repoLabel}
          </span>
        </span>
        <span className="ib-t">
          <span aria-hidden="true">{relativeTime(item.updated_at, now)}</span>
          <span className="ib-sr">{relativeWords(item.updated_at, now)}</span>
        </span>
      </div>
      <div className="ib-l2">
        <span className="ib-title" dir="auto">
          {title}
        </span>
      </div>
      <div className="ib-l3 ib-pr-l3">
        {layers > 1 ? (
          <Chain stack={item.stack} />
        ) : (
          <span className="ib-bc-mark" data-card-mark={markState(item.focus)} data-card-mark-kind="pr" aria-hidden="true">
            <RefMarkIcon kind="pr" state={markState(item.focus)} size={13} />
          </span>
        )}
        <span className="ib-pv" dir="auto">
          {layers > 1 && (
            <span className="ib-sr">
              A stack of {layers} {pullNounWord(item.stack.platform)}s:{' '}
            </span>
          )}
          {meta.lead}
          {meta.agent && (
            <>
              {' · '}
              <span className="ib-pr-magent" data-pulls-row-agent={meta.agent.host ?? ''}>
                <HostMark host={meta.agent.host} />
                {meta.agent.words}
              </span>
            </>
          )}
          {meta.rest && ` · ${meta.rest}`}
        </span>
      </div>
    </button>
  );
}

function PullsFoot({ model, loading, error, onRefresh }: { model: InboxPullsAnswer | null; loading: boolean; error: string | null; onRefresh: () => void }) {
  const now = useRelativeClock(true);
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
      <Tip content="Read again">
        <button type="button" className="ib-iconbtn ib-pr-refresh" onClick={onRefresh} aria-label="Read the pull requests again" data-refreshing={loading ? '' : undefined} data-pulls-refresh="">
          <Icon name="refresh" size={14} />
        </button>
      </Tip>
      <span className="ib-pr-foot-t" aria-live="polite" title={words || undefined} data-pulls-foot-words="">
        {words}
      </span>
    </div>
  );
}

/** How long the primary waits for a just-started thread's link before it comes back anyway. */
const AWAIT_LINK_MS = 15_000;

function StackView(props: PullsPageProps & { item: InboxPullItem; model: InboxPullsAnswer; phone: boolean; onClose: () => void }) {
  const { item, model, phone } = props;
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
  const handed = (link ? handoffStack(stack, model.links, link.thread_id) : null) ?? handoffStack(stack, model.links) ?? stack;
  const top = open[open.length - 1] ?? stack.layers[stack.layers.length - 1]!;
  const titleId = useId();
  const pickerId = useId();
  const primaryId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // A stack opened from the list: its title takes focus only on a phone (the list stays where the person is otherwise).
    if (phone) heading.current?.focus({ preventScroll: true });
  }, [stack.id, phone]);
  const forge = forgeName(stack);
  const many = open.length > 1;
  // One review thread at a time: the picker opens only while there is none, or its agent has ended.
  const canStart = open.length > 0 && (!link || ended);
  const [picking, setPicking] = useState(false);
  // After a thread starts, focus moves to the line that names its agent (the picker that held it is gone).
  const said = useRef<HTMLDivElement>(null);
  const focusSaid = useRef(false);
  const linkThread = link?.thread_id ?? null;
  useEffect(() => {
    if (!focusSaid.current || !linkThread || !said.current) return;
    focusSaid.current = false;
    said.current.focus();
  }, [linkThread]);
  // A send to a running agent, then the wait for its link: the primary waits too, so a second thread can't start.
  // `awaiting` holds the thread the stack had when the send began; the link to a new thread ends the wait.
  const [pickerSending, setPickerSending] = useState(false);
  const [awaiting, setAwaiting] = useState<{ from: string | null } | null>(null);
  useEffect(() => {
    if (awaiting && linkThread !== awaiting.from) setAwaiting(null);
  }, [awaiting, linkThread]);
  useEffect(() => {
    // The list never brought the link in (a failed read): the button comes back rather than staying off.
    if (!awaiting) return;
    const timer = window.setTimeout(() => setAwaiting(null), AWAIT_LINK_MS);
    return () => window.clearTimeout(timer);
  }, [awaiting]);
  const primaryWaits = pickerSending || awaiting !== null;
  const primaryButton = useRef<HTMLButtonElement>(null);
  const closePicker = () => {
    setPicking(false);
    primaryButton.current?.focus({ preventScroll: true });
  };
  const primary = canStart ? (
    <button
      ref={primaryButton}
      id={primaryId}
      type="button"
      className="ib-btn ib-pri"
      disabled={primaryWaits}
      onClick={() => setPicking((v) => !v)}
      aria-expanded={picking}
      aria-controls={picking ? pickerId : undefined}
      data-pulls-primary={link ? 'again' : 'review'}
    >
      <Icon name="plus" size={15} />
      {link ? 'Start a new review thread' : 'Review with an agent'}
    </button>
  ) : link && !ended ? (
    <button type="button" className="ib-btn ib-pri" onClick={() => props.onOpenThread(link.thread_id)} data-pulls-primary="open">
      <Icon name="questionBubble" size={15} />
      Open review thread
    </button>
  ) : null;
  // The person's own review, in every state: straight into phase 1's review mode (layer by layer for a stack), no stop on the way.
  // A stack's whole diff is the review's own "This layer | Whole stack" switch, not a second button here.
  const openDiff = start ? (
    <button type="button" className="ib-btn" onClick={() => props.onReview(stack.id, start.key, 'layer')} data-pulls-open-diff="">
      <Icon name="code" size={15} />
      Open the diff
    </button>
  ) : null;
  const projects = stackProjects(model, stack);
  const threadName = pullHandoffThreadName(handed, model.links, stack);
  return (
    <section className="ib-pane ib-prpane" aria-labelledby={titleId} data-pulls-stack={stack.id}>
      <div className="ib-pr-bar">
        {phone && (
          <button type="button" className="ib-iconbtn" onClick={props.onClose} aria-label="Back to pull requests">
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
        {link && <ThreadLine ref={said} link={link} ended={ended} now={now} />}
        {(primary || openDiff) && (
          <div className="ib-pr-actions">
            {primary}
            {openDiff}
          </div>
        )}
        {picking && canStart && (
          <ReviewPicker
            id={pickerId}
            labelId={primaryId}
            stack={handed}
            projects={projects}
            threadName={threadName}
            exclude={link ? [link.agent?.session, link.handed_to].filter((s): s is string => !!s) : []}
            onLaunch={(body, opener) => {
              // Compose takes it from here: the picker closes, so it never comes back by itself (an agent ending later).
              setPicking(false);
              props.onLaunch(handoffKeys(handed), projects, body, pullHandoffAskLine(handed, { kind: 'guide' }), opener, threadName);
            }}
            onSending={setPickerSending}
            onStarted={(session) => {
              focusSaid.current = true;
              setAwaiting({ from: linkThread });
              setPicking(false);
              props.onStarted(session);
            }}
            onCancel={closePicker}
            onReload={props.state.reload}
          />
        )}
        <div className="ib-pr-order">
          <div className="ib-pr-order-h">
            <b>{ladderHeading(stack)}</b>
          </div>
          <ol className="ib-pr-ladder" reversed>
            {[...stack.layers].reverse().map((layer) => (
              <Layer key={layer.key} layer={layer} stack={stack} next={next?.key === layer.key} now={now} onReview={() => props.onReview(stack.id, layer.key, 'layer')} />
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
const ThreadLine = forwardRef<HTMLDivElement, { link: InboxPullLink; ended: boolean; now: number }>(function ThreadLine({ link, ended, now }, ref) {
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
              Review thread with <b>{name}</b>
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

function Layer({ layer, stack, next, now, onReview }: { layer: InboxPull; stack: InboxPullStack; next: boolean; now: number; onReview: () => void }) {
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
