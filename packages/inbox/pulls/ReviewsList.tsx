/**
 * The Reviews list (approval "inbox-reviews-page", round 2): the Inbox's own rows and bands, grouped by whose move it
 * is: On you, With your agents, Ready to land, then the folded Waiting on others and Open, not reviewed. A row is a
 * review thread (the same thread the Inbox lists, never a copy) or a listed PR nobody has reviewed. The fold state
 * is remembered. No new keyboard shortcuts.
 */
import { useEffect, useMemo, useState } from 'react';
import { inboxPullRepoKey, inboxReviewGroups, type InboxPullLink, type InboxPullsAnswer, type InboxPullStack, type InboxReviewMove, type InboxReviewRow, type InboxReviewsAnswer } from '@plannotator/core/inbox-types';
import { formatCount } from '@plannotator/core/inbox-format';
import { inboxApi } from '../api';
import { HostMark, Icon } from '../icons';
import { RefMarkIcon } from '../board/RefMark';
import { Tip } from '../components/Tip';
import { relativeTime, relativeWords, useRelativeClock } from '../relativeTime';
import { pullFilterEmptyWords, pullNounWord, stackTitle, type PullFilter } from './model';
import { initials, repoLabels, repoName } from './labels';
import { pullsEmptyWords, pullsNotices } from './notices';
import { chainMarks } from './topology';
import { readReviewFolds, reviewRowLine, reviewRowProject, reviewRowTitle, saveReviewFolds, type ReviewFolds } from './reviewsModel';

/** Pictures that failed or drew nothing in this window, so a row drawn again never asks twice. */
const failedAvatars = new Set<string>();

/**
 * A PR row's top-left spot: always the PR author's profile picture (the person's own PRs too; a stack's bottom layer's
 * author), read through the Inbox's own route (`GET /api/inbox/pulls/avatar`): the window's CSP never loads a remote
 * image. The initials show while it loads and stay when it cannot; a deleted account is a grey person.
 */
function AuthorLead({ stack }: { stack: InboxPullStack }) {
  const bottom = stack.layers[0]!;
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
  onOpen,
}: {
  row: InboxReviewRow;
  links: Readonly<Record<string, InboxPullLink>>;
  place: string;
  selected: boolean;
  phone: boolean;
  now: number;
  onOpen: () => void;
}) {
  const stack = row.stacks[0] ?? null;
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
          <span className="ib-bc-mark" data-card-mark={focusPull?.state ?? row.landed[0]?.state ?? 'open'} data-card-mark-kind="pr" aria-hidden="true">
            <RefMarkIcon kind="pr" state={focusPull?.state ?? row.landed[0]?.state ?? 'open'} size={13} />
          </span>
        ) : (
          <Icon name="laptop" size={14} />
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
              {line.status}
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

export function ReviewsList({
  answer,
  model,
  rows,
  filter,
  projectNames,
  selected,
  phone,
  onOpen,
  onNew,
}: {
  answer: InboxReviewsAnswer;
  model: InboxPullsAnswer;
  rows: readonly InboxReviewRow[];
  filter: PullFilter;
  projectNames: ReadonlyMap<string, string>;
  /** The open thread's id, or the open stack's. */
  selected: string | null;
  phone: boolean;
  onOpen: (row: InboxReviewRow) => void;
  onNew: () => void;
}) {
  const now = useRelativeClock(true);
  const groups = useMemo(() => inboxReviewGroups(rows), [rows]);
  const [folds, setFolds] = useState<ReviewFolds>(readReviewFolds);
  const toggle = (name: keyof ReviewFolds) => {
    const next = { ...folds, [name]: !folds[name] };
    setFolds(next);
    saveReviewFolds(next);
  };
  const isOpenRow = (row: InboxReviewRow) => selected !== null && (row.thread_id === selected || row.id === selected || row.stacks.some((stack) => stack.id === selected || stack.layers.some((l) => l.key === selected)));
  // A row opened from a folded group keeps its group open.
  const waitingOpen = folds.waiting || groups.waiting.some(isOpenRow);
  const listedOpen = folds.not_reviewed || groups.not_reviewed.some(isOpenRow);
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
      </div>
    );
  }
  const labels = repoLabels(rows.flatMap((row) => row.stacks));
  const placeOf = (row: InboxReviewRow) => {
    const stack = row.stacks[0];
    if (stack) return labels.get(inboxPullRepoKey(stack.host, stack.repo)) ?? repoName(stack.repo);
    const id = reviewRowProject(row);
    const project = id ? projectNames.get(id) : null;
    return project ?? row.review?.source?.repo ?? 'A project';
  };
  const links = { ...model.links, ...Object.fromEntries(answer.rows.flatMap((row) => (row.link ? row.pull_keys.map((key) => [key, row.link!] as const) : []))) };
  const draw = (row: InboxReviewRow) => <ReviewRowItem key={row.id} row={row} links={links} place={placeOf(row)} selected={isOpenRow(row)} phone={phone} now={now} onOpen={() => onOpen(row)} />;
  return (
    <>
      {notice}
      <Band label="On you" name="on_you" rows={groups.on_you} draw={draw} />
      <Band label="With your agents" name="agents" rows={groups.agents} draw={draw} />
      <Band label="Ready to land" name="ready" rows={groups.ready} draw={draw} />
      <FoldedGroup label="Waiting on others" name="waiting" rows={groups.waiting} open={waitingOpen} onToggle={() => toggle('waiting')} draw={draw} />
      <FoldedGroup label="Open, not reviewed" name="not_reviewed" rows={groups.not_reviewed} open={listedOpen} onToggle={() => toggle('not_reviewed')} draw={draw} />
    </>
  );
}
