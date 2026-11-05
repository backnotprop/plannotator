/**
 * The PR's details, on demand, over the code: who wrote it, its description and its comments in a reading column, the
 * reviewers, checks and labels in a tinted one, as on the forge. On a phone, one column: people and checks compress to a
 * line each that opens in place. Everything comes from the forge through `GET /api/inbox/pulls/details` (the diff's
 * description first, as it is already read); pictures through the Inbox's own avatar route.
 */
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { InboxPull, InboxPullCheck, InboxPullCheckState, InboxPullDetailComment, InboxPullDetailsAnswer, InboxPullReviewer, InboxPullReviewState } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { Icon } from '../icons';
import { Tip } from '../components/Tip';
import { relativeTime, relativeWords } from '../relativeTime';
import { forgeBody } from './descriptionLinks';
import { ForgeMarkdown, PullDescription } from './PullDescription';

/** The details of one PR, read again when `stamp` moves or `retry` asks (the server keeps them a minute); a failure says so and can ask again. */
export function usePullDetails(key: string | null, stamp: string = ''): { data: InboxPullDetailsAnswer | null; failed: boolean; retry: () => void } {
  const [data, setData] = useState<InboxPullDetailsAnswer | null>(null);
  const [failed, setFailed] = useState(false);
  const [asked, setAsked] = useState(0);
  const shownKey = useRef(key);
  useEffect(() => {
    // Another PR clears the panel; a new read of this one leaves it until the answer.
    if (shownKey.current !== key) {
      shownKey.current = key;
      setData(null);
    }
    setFailed(false);
    if (!key) return;
    const ask = new AbortController();
    inboxApi.pullDetails(key, ask.signal).then(setData, () => {
      if (!ask.signal.aborted) setFailed(true);
    });
    return () => ask.abort();
  }, [key, stamp, asked]);
  return { data, failed: failed && !data, retry: () => setAsked((n) => n + 1) };
}

const REVIEW_WORDS: Record<InboxPullReviewState, string> = { approved: 'Approved', changes: 'Changes requested', commented: 'Commented', waiting: 'Waiting' };
const REVIEW_ORDER: InboxPullReviewState[] = ['changes', 'approved', 'commented', 'waiting'];
const DELETED = 'A deleted account';
const initial = (login: string) => (login.includes('/') ? login.split('/')[1]! : login).replace(/\[bot\]$/, '').slice(0, 1).toUpperCase();
const shortName = (login: string) => login.replace(/\[bot\]$/, '');
const checkName = (check: InboxPullCheck) => (check.workflow ? `${check.workflow} / ${check.name}` : check.name);
/** A bot that only commented says nothing about where the review stands: it follows the people who were asked. */
const quietBot = (r: InboxPullReviewer) => !!r.bot && r.state === 'commented';
export const byState = (rows: readonly InboxPullReviewer[]) =>
  [...rows].sort((a, b) => (quietBot(a) ? REVIEW_ORDER.length : REVIEW_ORDER.indexOf(a.state)) - (quietBot(b) ? REVIEW_ORDER.length : REVIEW_ORDER.indexOf(b.state)));
const worst = (checks: readonly InboxPullCheck[]): InboxPullCheckState => (checks.some((c) => c.state === 'fail') ? 'fail' : checks.some((c) => c.state === 'pending') ? 'pending' : 'pass');

function checkWords(checks: readonly InboxPullCheck[]) {
  const fail = checks.filter((c) => c.state === 'fail').length;
  const pending = checks.filter((c) => c.state === 'pending').length;
  return fail ? `${fail} failed` : pending ? `${pending} running` : 'All passed';
}
export function reviewWords(all: readonly InboxPullReviewer[]) {
  const people = all.filter((r) => !quietBot(r));
  const reviewers = people.length ? people : all;
  if (reviewers.some((r) => r.state === 'changes')) return 'Changes requested';
  const approved = reviewers.filter((r) => r.state === 'approved').length;
  return approved ? `${approved} approved` : reviewers.some((r) => r.state === 'commented') ? 'Commented' : 'Waiting';
}

/**
 * A person's picture, round: the initial while it loads and when it cannot, a grey person for a deleted account. An app
 * or a team is a soft square, as on the forge; a team has no picture to ask for.
 */
function Face({ login, host, size, bot, team, state }: { login: string; host: string; size: number; bot?: boolean; team?: boolean; state?: InboxPullReviewState }) {
  const [shown, setShown] = useState(false);
  const [failed, setFailed] = useState(false);
  const isTeam = team || login.includes('/');
  const square = bot || isTeam || login.endsWith('[bot]');
  return (
    <span className="ib-prd-face" data-square={square ? '' : undefined} data-gone={login ? undefined : ''} style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden="true">
      <span className="ib-prd-pic">
        {!login ? <Icon name="user" size={Math.round(size * 0.6)} /> : !shown && initial(login)}
        {login && !isTeam && !failed && (
          <img
            src={inboxApi.pullAvatarUrl(host, login)}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            draggable={false}
            data-shown={shown ? '' : undefined}
            onLoad={(event) => (event.currentTarget.naturalWidth > 1 ? setShown(true) : setFailed(true))}
            onError={() => setFailed(true)}
          />
        )}
      </span>
      {state && state !== 'waiting' && (
        <span className="ib-prd-pip" data-state={state}>
          <Icon name={state === 'approved' ? 'check' : state === 'changes' ? 'x' : 'comment'} size={8} />
        </span>
      )}
    </span>
  );
}

const CheckMark = ({ state, quiet }: { state: InboxPullCheckState; quiet?: boolean }) =>
  state === 'pending' ? (
    <span className="ib-prd-ring" aria-hidden="true" />
  ) : (
    <span className="ib-prd-cmark" data-state={quiet ? 'quiet' : state} aria-hidden="true">
      <Icon name={state === 'pass' ? 'checkCircle' : 'xCircle'} size={15} />
    </span>
  );

/** The bar's control's status: how the checks stand and how many people's comments, nothing while it is unknown. */
export function DetailsStatus({ data }: { data: InboxPullDetailsAnswer | null }) {
  const checks = data?.checks ?? [];
  const comments = data?.comments?.filter((c) => !c.bot).length ?? 0;
  return (
    <>
      {checks.length > 0 && <span className="ib-prp-dot" data-state={worst(checks)} data-pull-details-checks={worst(checks)} aria-hidden="true" />}
      {comments > 0 && (
        <span className="ib-prp-count" data-pull-details-comments={comments}>
          <Icon name="comment" size={13} />
          {comments}
        </span>
      )}
    </>
  );
}

function ReviewerRows({ reviewers, host, words }: { reviewers: readonly InboxPullReviewer[]; host: string; words: boolean }) {
  return (
    <ul className="ib-prd-rows" data-pull-details-reviewers="">
      {byState(reviewers).map((r) => (
        <li key={r.login} data-pull-details-reviewer={r.login}>
          <Face login={r.login} host={host} size={22} bot={r.bot} team={r.team} />
          <Tip cut content={r.login}>
            <span className="ib-prd-rname">{shortName(r.login)}</span>
          </Tip>
          {words ? (
            <span className="ib-prd-rstate" data-state={r.state}>{REVIEW_WORDS[r.state]}</span>
          ) : (
            <Tip content={REVIEW_WORDS[r.state]}>
              <span className="ib-prd-rmark" data-state={r.state} role="img" aria-label={REVIEW_WORDS[r.state]}>
                <Icon name={r.state === 'waiting' ? 'clock' : r.state === 'approved' ? 'check' : r.state === 'changes' ? 'x' : 'comment'} size={14} />
              </span>
            </Tip>
          )}
        </li>
      ))}
    </ul>
  );
}

/** A check's whole name: in its tip where it is cut; a row with a page is a link, which a keyboard reaches the tip on too. */
function CheckRow({ check }: { check: InboxPullCheck }) {
  const name = checkName(check);
  const inner = (
    <>
      <CheckMark state={check.state} quiet={!!check.note} />
      <Tip cut content={name}>
        <span className="ib-prd-rname">{name}</span>
      </Tip>
      {check.note && <span className="ib-prd-rstate">{check.note}</span>}
    </>
  );
  return (
    <li data-pull-details-check={check.state}>
      {check.url ? (
        <a className="ib-prd-rlink" href={check.url} target="_blank" rel="noreferrer noopener" aria-label={`${name}, ${check.state === 'pass' ? 'passed' : check.state === 'fail' ? 'failed' : 'running'}`}>
          {inner}
        </a>
      ) : (
        <span className="ib-prd-rlink" data-plain="">{inner}</span>
      )}
    </li>
  );
}

/** What needs eyes first; the passed ones behind a line that opens. */
/** This many passed checks read as a list; a project's hundred read as a line that opens. */
const PASSED_SHOWN = 5;

export function CheckRows({ checks }: { checks: readonly InboxPullCheck[] }) {
  const [all, setAll] = useState(false);
  const needEyes = checks.filter((c) => c.state !== 'pass');
  const passed = checks.filter((c) => c.state === 'pass' && !c.note);
  const quiet = checks.filter((c) => c.state === 'pass' && c.note);
  const done = passed.length + quiet.length;
  const folds = done > 0 && (needEyes.length > 0 || done > PASSED_SHOWN);
  const words = [
    ...(passed.length ? [`${passed.length} passed`] : []),
    ...[...new Set(quiet.map((c) => c.note!))].map((note) => `${quiet.filter((c) => c.note === note).length} ${note.toLowerCase()}`),
  ].join(', ');
  const rows = all || !folds ? [...needEyes, ...passed, ...quiet] : needEyes;
  return (
    <>
      {rows.length > 0 && (
        <ul className="ib-prd-rows" data-pull-details-checks-list="">
          {rows.map((check, index) => (
            <CheckRow key={`${index}:${check.name}`} check={check} />
          ))}
        </ul>
      )}
      {folds && (
        <button type="button" className="ib-prd-more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Show less' : words}
        </button>
      )}
    </>
  );
}

function CommentCard({ comment, layer, onFile }: { comment: InboxPullDetailComment; layer: InboxPull; onFile?: (path: string) => void }) {
  const name = comment.author || DELETED;
  const now = Date.now();
  const when = comment.at && !Number.isNaN(Date.parse(comment.at));
  const short = when ? relativeTime(comment.at, now) : '';
  return (
    <article className="ib-prd-comment" data-pull-details-comment={comment.id}>
      <Face login={comment.author} host={layer.host} size={28} bot={comment.bot} />
      <div className="ib-prd-cbody">
        <div className="ib-prd-chead">
          <Tip cut content={name}><b>{shortName(name)}</b></Tip>
          {when && <span className="ib-prd-at" aria-label={relativeWords(comment.at, now)}>{/^\d+[mhd]$/.test(short) ? `${short} ago` : short}</span>}
          {comment.file && (
            <Tip content={`${comment.file}${comment.line ? `:${comment.line}` : ''}`}>
              {onFile ? (
                <button type="button" className="ib-prd-cfile" onClick={() => onFile(comment.file!)}>
                  {comment.file.split('/').pop()}{comment.line ? `:${comment.line}` : ''}
                </button>
              ) : (
                <span className="ib-prd-cfile">{comment.file.split('/').pop()}{comment.line ? `:${comment.line}` : ''}</span>
              )}
            </Tip>
          )}
        </div>
        <ForgeMarkdown markdown={comment.body} layer={layer} />
      </div>
    </article>
  );
}

export function PullDetails({ layer, description, headSha, data, failed, onRetry, forge, panel, phone, inDiff, onClose, onFile, top, keys }: {
  layer: InboxPull;
  description: string | null | undefined;
  headSha?: string | null;
  data: InboxPullDetailsAnswer | null;
  failed: boolean;
  onRetry: () => void;
  forge: string;
  panel: RefObject<HTMLElement | null>;
  phone: boolean;
  /** Whether a path is in the diff on screen: a comment's file is a way there only then. */
  inDiff: (path: string) => boolean;
  onClose: () => void;
  onFile: (path: string) => void;
  /** The phone's sheet: the stack above the details. */
  top?: ReactNode;
  keys?: Record<string, unknown>;
}) {
  const labelsId = useId();
  const [opened, setOpened] = useState<'people' | 'checks' | null>(null);
  const [bots, setBots] = useState(false);
  const checks = data?.checks ?? [];
  const reviewers = data?.reviewers ?? [];
  const comments = data?.comments ?? [];
  const labels = data?.labels ?? [];
  const people = comments.filter((c) => !c.bot);
  const botComments = comments.filter((c) => c.bot);
  const words = [description, data?.description].map((body) => (body ? forgeBody(body) : '')).find((body) => body.trim());
  const card = (comment: InboxPullDetailComment) => (
    <CommentCard
      key={`${comment.id}:${comment.at}`}
      comment={comment}
      layer={layer}
      onFile={comment.file && inDiff(comment.file) ? (path) => { onFile(path); onClose(); } : undefined}
    />
  );
  const conversation = comments.length > 0 && (
    <>
      {people.length > 0 && <h3 className="ib-prd-h">{people.length === 1 ? '1 comment' : `${people.length} comments`}</h3>}
      <div className="ib-prd-convo">
        {people.map(card)}
        {botComments.length > 0 && (bots ? botComments.map(card) : (
          <button type="button" className="ib-prd-more" onClick={() => setBots(true)} data-pull-details-bots="">
            {botComments.length} from bots
          </button>
        ))}
      </div>
    </>
  );
  const threadsMissing = data?.threads_incomplete && (
    <p className="ib-prd-none" role="status" data-pull-details-threads-missing="">
      {forge} did not answer for all the comments on lines.{' '}
      <button type="button" className="ib-prd-more" onClick={onRetry}>Try again</button>
    </p>
  );
  const reading = words ? <PullDescription markdown={words} layer={layer} headSha={headSha} /> : data || failed ? <p className="ib-prd-none">No description.</p> : null;
  const failedNote = failed && (
    <p className="ib-prd-none" role="status" data-pull-details-failed="">
      {forge} did not answer about the reviewers and checks.{' '}
      <button type="button" className="ib-prd-more" onClick={onRetry}>Try again</button>
    </p>
  );
  const labelRow = labels.length > 0 && (
    <div className="ib-prd-labels" id={labelsId} data-pull-details-labels="">
      {labels.map((label) => <span key={label}>{label}</span>)}
    </div>
  );
  const pile = () => {
    const faces = byState(reviewers);
    return (
      <span className="ib-prd-pile">
        {faces.slice(0, 5).map((r) => <Face key={r.login} login={r.login} host={layer.host} size={24} bot={r.bot} team={r.team} state={r.state} />)}
        {faces.length > 5 && <span className="ib-prd-moreface">+{faces.length - 5}</span>}
      </span>
    );
  };
  return (
    <aside ref={panel as RefObject<HTMLElement>} className="ib-prd" aria-label="Details" tabIndex={-1} data-pull-details="" data-layout={phone ? 'column' : 'columns'} {...keys}>
      <header className="ib-prd-head">
        <Face login={layer.author ?? ''} host={layer.host} size={32} />
        <div className="ib-prd-who">
          <Tip cut content={layer.author ?? DELETED}><b>{layer.author ?? DELETED}</b></Tip>
          <span className="ib-prd-branch">
            <Tip cut content={layer.head}><span className="ib-prd-ref">{layer.head}</span></Tip>
            <Icon name="arrowRight" size={12} />
            <Tip cut content={layer.base}><span className="ib-prd-ref ib-prd-base">{layer.base}</span></Tip>
          </span>
        </div>
        <Tip content={`Open on ${forge}`}>
          <a className="ib-prd-iconbtn" href={layer.url} target="_blank" rel="noreferrer noopener" aria-label={`Open on ${forge}`}><Icon name="external" size={15} /></a>
        </Tip>
        <Tip content="Close">
          <button type="button" className="ib-prd-iconbtn" aria-label="Close the details" onClick={onClose} data-pull-details-close=""><Icon name="x" size={15} /></button>
        </Tip>
      </header>
      <div className="ib-prd-body">
        {top && <div className="ib-prd-top">{top}</div>}
        {phone ? (
          <>
            {labelRow}
            {(reviewers.length > 0 || checks.length > 0) && (
              <>
                <div className="ib-prd-summary">
                  {reviewers.length > 0 && (
                    <button type="button" className="ib-prd-sum" aria-expanded={opened === 'people'} data-on={opened === 'people' ? '' : undefined} onClick={() => setOpened(opened === 'people' ? null : 'people')}>
                      {pile()}
                      <span className="ib-prd-sumw" data-state={reviewers.some((r) => r.state === 'changes') ? 'changes' : undefined}>{reviewWords(reviewers)}</span>
                    </button>
                  )}
                  {checks.length > 0 && (
                    <button type="button" className="ib-prd-sum" aria-expanded={opened === 'checks'} data-on={opened === 'checks' ? '' : undefined} onClick={() => setOpened(opened === 'checks' ? null : 'checks')}>
                      <CheckMark state={worst(checks)} />
                      <span className="ib-prd-sumw" data-state={worst(checks)}>{checkWords(checks)}</span>
                    </button>
                  )}
                </div>
                {opened === 'people' && <div className="ib-prd-drop"><ReviewerRows reviewers={reviewers} host={layer.host} words /></div>}
                {opened === 'checks' && <div className="ib-prd-drop"><CheckRows checks={checks} /></div>}
              </>
            )}
            {failedNote}
            {reading}
            {conversation}
            {threadsMissing}
          </>
        ) : (
          <div className="ib-prd-cols">
            <div className="ib-prd-main">
              {reading}
              {conversation}
              {threadsMissing}
            </div>
            {(!data || reviewers.length > 0 || checks.length > 0 || labels.length > 0) && (
              <div className="ib-prd-side" aria-busy={!data && !failed}>
                {failedNote}
                {!data && !failed && <div className="ib-prd-waiting" aria-hidden="true"><i /><i /><i /></div>}
                {reviewers.length > 0 && <section><h3>Reviewers</h3><ReviewerRows reviewers={reviewers} host={layer.host} words={false} /></section>}
                {checks.length > 0 && <section><h3>Checks</h3><CheckRows checks={checks} /></section>}
                {labels.length > 0 && <section><h3>Labels</h3>{labelRow}</section>}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
