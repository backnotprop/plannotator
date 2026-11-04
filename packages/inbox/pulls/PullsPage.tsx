/**
 * Pull requests (approval "inbox-code-review-direction", items 4 and 5;
 * concept B, take 1): the sidebar's row under Board, shown only while
 * Settings → Capabilities → Code review is on.
 *
 * - The list, in the Inbox list's own rows and bands, grouped by whose move
 *   it is: On you (a teammate asked for the person's review, or the
 *   person's agent opened a PR that waits on them), Ready to land, and a
 *   folded "N waiting on others". A stack is one row: its third line is a
 *   small chain of the Board's PR marks in landing order.
 * - The stack view beside it (a phone: in its place): the layers from the
 *   base branch up, the lowest open one marked "Lands next"; the agent
 *   behind it, its thread and its Board card when linked; "Review layer by
 *   layer" (phase 1's review mode, on that layer) and "Whole stack"; Reply
 *   at the foot goes into the agent's thread. No merge button.
 *
 * Read only while the page is open (usePulls). No new keyboard shortcuts.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { inboxPullLandsNext, type InboxPull, type InboxPullItem, type InboxPullLink, type InboxPullsAnswer, type InboxPullStack } from '@plannotator/core/inbox-types';
import { formatCount, plural } from '@plannotator/core/inbox-format';
import { InboxApiError, inboxApi, type ProjectFolder } from '../api';
import { Icon } from '../icons';
import { RefMarkIcon } from '../board/RefMark';
import { ProjectFilter } from '../board/ProjectFilter';
import { RowAgentTiles } from '../components/RowAgents';
import { Tip } from '../components/Tip';
import { relativeTime, relativeWords, useRelativeClock } from '../relativeTime';
import { SidebarTrigger } from '../shell/sidebar';
import { ListColumnEdge } from '../shell/ListColumnEdge';
import { newUuid } from '../uuid';
import {
  checksWords,
  findStack,
  forgeName,
  inboxPullLabel,
  layerBaseWords,
  layerPill,
  linkAgentName,
  pullGroups,
  repoName,
  rowLine,
  stackLink,
  stackTitle,
  startLayer,
} from './model';
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
  onOpenGuide: (threadId: string, messageId: string) => void;
  /** Absent while the Board is off: the card chip is not a link then. */
  onOpenCard?: (cardId: string) => void;
}

const isOpen = (pull: InboxPull) => pull.state === 'open' || pull.state === 'draft';

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
    const ids = new Set(Object.values(model?.projects ?? {}));
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
    return <StackView {...props} item={open} model={model} phone onClose={() => props.onOpenStack(null)} />;
  }
  return (
    <>
      {list}
      {!phone &&
        (open && model ? (
          <StackView {...props} item={open} model={model} phone={false} onClose={() => props.onOpenStack(null)} />
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
  if (total === 0) {
    const signedIn = model.hosts.length > 0;
    return (
      <div className="ib-pr-empty" data-pulls-empty="">
        <p className="ib-pr-empty-h">{signedIn ? 'Nothing open in your projects' : 'No signed-in GitHub or GitLab here'}</p>
        <p>
          {signedIn
            ? 'Pull requests you opened, and the ones you are asked to review, show here.'
            : 'Pull requests show here when this computer’s gh or glab is signed in to the host of a project’s origin.'}
        </p>
      </div>
    );
  }
  const row = (item: InboxPullItem) => <PullRow key={item.stack.id} item={item} link={stackLink(item.stack, model.links)} selected={item.stack.id === selected} phone={phone} now={now} onOpen={() => onOpen(item.stack.id)} />;
  return (
    <>
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

/** Who the row is from: the agent's tile when one is tied to it, else the author's initials (a teammate), else nothing. */
function RowLead({ item, link }: { item: InboxPullItem; link: InboxPullLink | null }) {
  if (link?.agent) return <RowAgentTiles participants={undefined} agent={{ kind: 'agent', host: link.agent.host }} />;
  const author = item.focus.author;
  if (!author || item.focus.mine) return null;
  return (
    <Tip content={author}>
      <span className="ib-pr-av" role="img" aria-label={author}>
        {initials(author)}
      </span>
    </Tip>
  );
}

function initials(login: string): string {
  // Two words give two letters ("mara-lee" → "ML"); one gives one ("priya" → "P"), never a pair that reads as "PR".
  const parts = login.split(/[-_. ]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
}

/** The chain of PR marks, bottom (lands first) to top. */
function Chain({ stack }: { stack: InboxPullStack }) {
  return (
    <span className="ib-pr-chain" aria-hidden="true" data-pulls-chain={stack.layers.length}>
      {stack.layers.map((layer, i) => (
        <span key={layer.key} className="ib-pr-link">
          {i > 0 && <span className="ib-pr-dash" />}
          <span className="ib-bc-mark" data-card-mark={markState(layer)} data-card-mark-kind="pr">
            <RefMarkIcon kind="pr" state={markState(layer)} size={13} />
          </span>
        </span>
      ))}
    </span>
  );
}

function PullRow({ item, link, selected, phone, now, onOpen }: { item: InboxPullItem; link: InboxPullLink | null; selected: boolean; phone: boolean; now: number; onOpen: () => void }) {
  const title = stackTitle(item.stack, link);
  const line = rowLine(item, link);
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
          <RowLead item={item} link={link} />
          <span className="ib-p" dir="auto">
            {repoName(item.stack.repo)}
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
          {layers > 1 && <span className="ib-sr">A stack of {layers} pull requests: </span>}
          {line}
        </span>
      </div>
    </button>
  );
}

function PullsFoot({ model, loading, error, onRefresh }: { model: InboxPullsAnswer | null; loading: boolean; error: string | null; onRefresh: () => void }) {
  const now = useRelativeClock(true);
  const clis = [...new Set((model?.hosts ?? []).map((h) => h.cli))];
  const from = clis.length === 0 ? 'gh and glab' : clis.join(' and ');
  const limited = model?.hosts.some((h) => h.error === 'rate_limited');
  const when = model?.fetched_at ? relativeWords(model.fetched_at, now).replace('just now', 'just now') : null;
  return (
    <div className="ib-pr-foot" data-pulls-foot="">
      <Tip content="Read again">
        <button type="button" className="ib-iconbtn ib-pr-refresh" onClick={onRefresh} aria-label="Read the pull requests again" data-refreshing={loading ? '' : undefined} data-pulls-refresh="">
          <Icon name="refresh" size={14} />
        </button>
      </Tip>
      <span className="ib-pr-foot-t" aria-live="polite">
        {error ? error : limited ? `${from} asked to slow down; showing the last read` : `From ${from} on this computer${when ? ` · ${when}` : ''}`}
      </span>
    </div>
  );
}

function StackView(props: PullsPageProps & { item: InboxPullItem; model: InboxPullsAnswer; phone: boolean; onClose: () => void }) {
  const { item, model, phone } = props;
  const stack = item.stack;
  const link = stackLink(stack, model.links);
  const agent = linkAgentName(link);
  const now = useRelativeClock(true);
  const next = inboxPullLandsNext(stack);
  const start = startLayer(stack);
  const openLayers = stack.layers.filter(isOpen);
  const top = openLayers[openLayers.length - 1] ?? stack.layers[stack.layers.length - 1]!;
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // A stack opened from the list: its title takes focus only on a phone (the list stays where the person is otherwise).
    if (phone) heading.current?.focus({ preventScroll: true });
  }, [stack.id, phone]);
  const forge = forgeName(stack);
  const many = openLayers.length > 1;
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
          {stackTitle(stack, link)}
        </h2>
        <div className="ib-pr-meta">
          <span dir="auto">{stack.host === 'github.com' ? stack.repo : `${stack.host}/${stack.repo}`}</span>
          {agent && link?.agent && (
            <span className="ib-pr-agent">
              <RowAgentTiles participants={undefined} agent={{ kind: 'agent', host: link.agent.host }} tip={false} />
              {agent}
            </span>
          )}
          <span>{plural(stack.layers.length, stack.platform === 'gitlab' ? 'merge request' : 'pull request')}</span>
          {/* Each chip says what it opens ("Thread", "Board"), with its own mark: a thread and its card often share a title. */}
          {link && (
            <Tip content="Open the agent's thread">
              <button type="button" className="ib-pr-chip" onClick={() => props.onOpenThread(link.thread_id)} data-pulls-thread={link.thread_id}>
                <Icon name="questionBubble" size={13} />
                <span className="ib-pr-chip-k">Thread</span>
                <span dir="auto">{link.thread_subject ?? 'Untitled'}</span>
              </button>
            </Tip>
          )}
          {link?.card &&
            (props.onOpenCard ? (
              <Tip content="Open its card on the Board">
                <button type="button" className="ib-pr-chip" onClick={() => props.onOpenCard!(link.card!.id)} data-pulls-card={link.card.id}>
                  <Icon name="board" size={13} />
                  <span className="ib-pr-chip-k">Board</span>
                  <span dir="auto">{link.card.title}</span>
                </button>
              </Tip>
            ) : (
              <span className="ib-pr-chip" data-pulls-card={link.card.id}>
                <Icon name="board" size={13} />
                <span className="ib-pr-chip-k">Board</span>
                <span dir="auto">{link.card.title}</span>
              </span>
            ))}
        </div>
        {link?.last && (
          <div className="ib-pr-said" data-pulls-said="">
            <div className="ib-pr-said-h">
              {link.agent && <RowAgentTiles participants={undefined} agent={{ kind: 'agent', host: link.agent.host }} tip={false} />}
              <b>{agent ?? 'Agent'}</b>
              {link.thread_subject && (
                <span className="ib-mut" dir="auto">
                  in {link.thread_subject}
                </span>
              )}
              <span className="ib-mut">· {relativeTime(link.last.at, now)}</span>
            </div>
            <p dir="auto">{link.last.preview}</p>
            {link.guide && (
              <button type="button" className="ib-pr-guide" onClick={() => props.onOpenGuide(link.thread_id, link.guide!.message_id)} data-pulls-guide="">
                <Icon name="map" size={14} />
                Guided Review <span className="ib-mut">{plural(link.guide.steps, 'step')}</span>
              </button>
            )}
          </div>
        )}
        {openLayers.length > 0 && start && (
          <div className="ib-pr-actions">
            <button type="button" className="ib-btn ib-pri" onClick={() => props.onReview(stack.id, start.key, 'layer')} data-pulls-review-layers="">
              {many ? 'Review layer by layer' : 'Review'}
            </button>
            {many && (
              <button type="button" className="ib-btn" onClick={() => props.onReview(stack.id, top.key, 'stack')} data-pulls-review-stack="">
                <Icon name="layers" size={15} />
                Whole stack
              </button>
            )}
            {many && <span className="ib-pr-note">Starts at {inboxPullLabel(start)}{start.key === next?.key ? ', the next to land.' : '.'}</span>}
          </div>
        )}
        <div className="ib-pr-order">
          <div className="ib-pr-order-h">
            <b>{many ? 'Landing order' : 'Pull request'}</b>
            {many && <span className="ib-mut">The bottom lands first</span>}
          </div>
          <ol className="ib-pr-ladder" reversed>
            {[...stack.layers].reverse().map((layer) => (
              <Layer key={layer.key} layer={layer} stack={stack} next={next?.key === layer.key && many} now={now} onReview={() => props.onReview(stack.id, layer.key, 'layer')} />
            ))}
            <li className="ib-pr-base" aria-label={`Base branch ${stack.base}`}>
              <span className="ib-pr-dot" aria-hidden="true" />
              <code>{stack.base}</code>
            </li>
          </ol>
        </div>
      </div>
      {link?.last && <StackReply key={link.thread_id} link={link} agent={agent ?? 'the agent'} onOpenThread={() => props.onOpenThread(link.thread_id)} />}
    </section>
  );
}

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
              {base && <span>{base}</span>}
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
        <button type="button" className="ib-pr-lrow" onClick={onReview} aria-label={`Review ${inboxPullLabel(layer)} ${layer.title}${next ? ', lands next' : ''}`}>
          {body}
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
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
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
            <button type="button" className="ib-btn ib-pri" onClick={() => void send()} disabled={sending || !words.trim()} data-pulls-reply-send="">
              {sending ? 'Sending…' : 'Send'}
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
