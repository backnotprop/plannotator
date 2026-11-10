/**
 * The PR's details, on demand, over the code: who wrote it, its description and its comments in a reading column, the
 * reviewers, checks and labels in a tinted one, as on the forge. On a phone, one column: people and checks compress to a
 * line each that opens in place. Everything comes from the forge through `GET /api/inbox/pulls/details` (the diff's
 * description first, as it is already read); pictures through the Inbox's own avatar route.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { InboxPull, InboxPullCheck, InboxPullCheckState, InboxPullDetailComment, InboxPullDetailsAnswer, InboxPullReviewer, InboxPullReviewState } from '@plannotator/core/inbox-types';
import { InboxApiError, inboxApi } from '../api';
import { Icon } from '../icons';
import { Tip } from '../components/Tip';
import { relativeTime, relativeWords } from '../relativeTime';
import { forgeBody } from './descriptionLinks';
import { ForgeMarkdown, PullDescription } from './PullDescription';
import { Face } from './Face';

/**
 * The details of one PR, read again when `stamp` moves or `retry` asks (the server keeps them a minute); a failure says
 * so and can ask again. `heldUntil`: the forge asked to slow down, and is not asked again before then.
 */
export function usePullDetails(key: string | null, stamp: string = ''): { data: InboxPullDetailsAnswer | null; failed: boolean; heldUntil: number | null; retry: () => void } {
  const [data, setData] = useState<InboxPullDetailsAnswer | null>(null);
  const [failed, setFailed] = useState(false);
  const [heldUntil, setHeldUntil] = useState<number | null>(null);
  const [asked, setAsked] = useState(0);
  const shownKey = useRef(key);
  useEffect(() => {
    // Another PR clears the panel; a new read of this one leaves it until the answer.
    if (shownKey.current !== key) {
      shownKey.current = key;
      setData(null);
    }
    setFailed(false);
    setHeldUntil(null);
    if (!key) return;
    const ask = new AbortController();
    inboxApi.pullDetails(key, ask.signal).then(setData, (cause) => {
      if (ask.signal.aborted) return;
      setFailed(true);
      if (cause instanceof InboxApiError && cause.code === 'pull_details_held' && cause.retryAt) setHeldUntil(cause.retryAt);
    });
    return () => ask.abort();
  }, [key, stamp, asked]);
  return { data, failed: failed && !data, heldUntil: failed && !data ? heldUntil : null, retry: () => setAsked((n) => n + 1) };
}

/** Whether the time has come, re-drawn when it does. */
function useReached(at: number | null): boolean {
  const [, tick] = useState(0);
  const reached = at === null || Date.now() >= at;
  useEffect(() => {
    if (reached || at === null) return;
    const timer = setTimeout(() => tick((n) => n + 1), Math.min(at - Date.now() + 50, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [at, reached]);
  return reached;
}

const REVIEW_WORDS: Record<InboxPullReviewState, string> = { approved: 'Approved', changes: 'Changes requested', commented: 'Commented', waiting: 'Waiting' };
const REVIEW_ORDER: InboxPullReviewState[] = ['changes', 'approved', 'commented', 'waiting'];
export const DELETED = 'A deleted account';
export const shortName = (login: string) => login.replace(/\[bot\]$/, '');
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

/**
 * Whether the bar keeps its Details button beside the PR's title. The title opens the details either way (the owner's
 * suggestion); with no button, the title carries the button's status (the checks' dot and the people's comments). The
 * owner chose the title only (approval "inbox-review-details-panel", addendum "title only").
 */
export const DETAILS_BUTTON: boolean = false;

/** The bar's Details button, while `DETAILS_BUTTON` keeps it. */
export function DetailsButton({ open, data, onToggle }: { open: boolean; data: InboxPullDetailsAnswer | null; onToggle: (event: React.MouseEvent<HTMLElement>) => void }) {
  if (!DETAILS_BUTTON) return null;
  return (
    <Tip content="Description, comments, checks and reviewers">
      <button type="button" className={`ib-prp-dbtn${open ? ' ib-on' : ''}`} aria-expanded={open} onClick={onToggle} data-pull-details-button="">
        Details
        <DetailsStatus data={data} />
      </button>
    </Tip>
  );
}

/**
 * The bar's title as the way to the details: `name` is its visible words, the button's name starts with them and says
 * what a click does, and so does the last line of its tip. With no Details button, the status rides at its end.
 */
export function DetailsTitle({ name, tip, open, data, onToggle, className, children, ...rest }: {
  name: string;
  tip: ReactNode;
  open: boolean;
  data: InboxPullDetailsAnswer | null;
  onToggle: (event: React.MouseEvent<HTMLElement>) => void;
  className: string;
  children: ReactNode;
  [data: `data-${string}`]: string;
}) {
  return (
    <Tip
      content={
        <span className="ib-tip-proj">
          {tip}
          <span className="ib-tip-sub" data-pull-details-hint="">{open ? 'Click to close Details' : 'Click for Details: description, comments, checks and reviewers'}</span>
        </span>
      }
    >
      <button type="button" className={`${className} ib-dtitle${open ? ' ib-on' : ''}`} aria-expanded={open} aria-label={`${name}, opens details`} onClick={onToggle} data-pull-details-title="" {...rest}>
        {children}
        {!DETAILS_BUTTON && <DetailsStatus data={data} />}
      </button>
    </Tip>
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

/**
 * A check's own name, as the forge's checks page leads with it: a reusable workflow's run is "<job> / <its job>", so the
 * caller's job ("Run changed specs against the staging build (worker, 1/5)") names it, without the workflow before it or
 * the called job after it. Two checks that would read the same keep their whole names.
 */
export function checkLabels(checks: readonly InboxPullCheck[]): Map<InboxPullCheck, string> {
  const short = (check: InboxPullCheck) => check.name.split(' / ')[0]!.trim() || check.name;
  const seen = new Map<string, number>();
  for (const check of checks) seen.set(short(check), (seen.get(short(check)) ?? 0) + 1);
  return new Map(checks.map((check) => [check, seen.get(short(check))! > 1 ? check.name : short(check)]));
}

/** `text` kept to `keep` characters around a "…": a little more of its end, where checks differ (matrix, shard, OS). */
export function cutMiddle(text: string, keep: number): string {
  const chars = Array.from(text);
  if (keep >= chars.length) return text;
  const head = Math.ceil(keep * 0.4);
  return `${chars.slice(0, head).join('').trimEnd()}…${chars.slice(chars.length - (keep - head)).join('').trimStart()}`;
}

/** Lines a check's name may take before it gives way in its middle. */
const NAME_LINES = 2;

/**
 * A check's name: whole on up to two lines; longer, cut in its middle to two lines, so the start and the end that
 * tells checks apart both show. Measured in the row as drawn, and again when the row's width changes.
 */
function CheckName({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let width = -1;
    const fit = () => {
      const now = el.clientWidth;
      if (now === width) return;
      width = now;
      el.textContent = text;
      const room = parseFloat(getComputedStyle(el).lineHeight) * NAME_LINES + 1;
      if (!(room > 0) || el.scrollHeight <= room) return;
      let lo = 1;
      let hi = Array.from(text).length - 1;
      let best = cutMiddle(text, 1);
      while (lo <= hi) {
        const keep = (lo + hi) >> 1;
        el.textContent = cutMiddle(text, keep);
        if (el.scrollHeight <= room) {
          best = el.textContent;
          lo = keep + 1;
        } else hi = keep - 1;
      }
      el.textContent = best;
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => watch.disconnect();
  }, [text]);
  // The words are written by the measure, so React never owns a text node it would later miss.
  return <span ref={ref} className="ib-prd-cfit" data-name={text} />;
}

/** A check: its mark, its own name on up to two lines (the whole one in its tip), a failure's word; a link to its run. */
function CheckRow({ check, label }: { check: InboxPullCheck; label: string }) {
  const whole = checkName(check);
  const quiet = check.state === 'pass' && !!check.note;
  const inner = (
    <>
      <CheckMark state={check.state} quiet={quiet} />
      <Tip content={whole}>
        <span className="ib-prd-rname ib-prd-cname"><CheckName text={label} /></span>
      </Tip>
      {check.state === 'fail' && check.note && <span className="ib-prd-rstate" data-state="fail">{check.note}</span>}
    </>
  );
  return (
    <li data-pull-details-check={check.state}>
      {check.url ? (
        <a className="ib-prd-rlink" href={check.url} target="_blank" rel="noreferrer noopener" aria-label={`${whole}, ${check.state === 'pass' ? (check.note ?? 'passed') : check.state === 'fail' ? (check.note ?? 'failed') : 'running'}`}>
          {inner}
        </a>
      ) : (
        <span className="ib-prd-rlink" data-plain="">{inner}</span>
      )}
    </li>
  );
}

/** Running checks past this many fold into the line with the passed ones; failures always show. */
const RUNNING_SHOWN = 3;
/** This many passed checks read as a list; a project's hundred read as a line that opens. */
const PASSED_SHOWN = 5;

/**
 * Failures first, each on a line with its status; then what runs; then the passed and the quiet ones. A short list is
 * whole. A long one keeps the failures (and a few running) and folds the rest into one line that says what it holds
 * ("14 running, 113 passed, 7 skipped") and opens.
 */
export function CheckRows({ checks }: { checks: readonly InboxPullCheck[] }) {
  const [all, setAll] = useState(false);
  const labels = useMemo(() => checkLabels(checks), [checks]);
  const failed = checks.filter((c) => c.state === 'fail');
  const running = checks.filter((c) => c.state === 'pending');
  const passed = checks.filter((c) => c.state === 'pass' && !c.note);
  const quiet = checks.filter((c) => c.state === 'pass' && c.note);
  const done = passed.length + quiet.length;
  const runningFolds = running.length > RUNNING_SHOWN;
  const folds = runningFolds || (done > 0 && (failed.length + running.length > 0 || done > PASSED_SHOWN));
  const words = [
    ...(runningFolds ? [`${running.length} running`] : []),
    ...(passed.length ? [`${passed.length} passed`] : []),
    ...[...new Set(quiet.map((c) => c.note!))].map((note) => `${quiet.filter((c) => c.note === note).length} ${note.toLowerCase()}`),
  ].join(', ');
  const order = [...failed, ...running, ...passed, ...quiet];
  const rows = all || !folds ? order : [...failed, ...(runningFolds ? [] : running)];
  return (
    <>
      {rows.length > 0 && (
        <ul className="ib-prd-rows ib-prd-checks" data-pull-details-checks-list="">
          {rows.map((check, index) => (
            <CheckRow key={`${index}:${check.name}`} check={check} label={labels.get(check)!} />
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

export function PullDetails({ layer, description, headSha, data, failed, heldUntil = null, onRetry, forge, panel, phone, inDiff, onClose, onFile, top, keys, descriptionUnread = false }: {
  layer: InboxPull;
  description: string | null | undefined;
  headSha?: string | null;
  data: InboxPullDetailsAnswer | null;
  failed: boolean;
  /** The forge asked to slow down: not asked again before this time. */
  heldUntil?: number | null;
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
  /** The description has no other source than the details' read (the full review), and it failed: whether there is one is not known. */
  descriptionUnread?: boolean;
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
  const reading = words ? <PullDescription markdown={words} layer={layer} headSha={headSha} /> : data || (failed && !descriptionUnread) ? <p className="ib-prd-none">No description.</p> : null;
  // Held, Try again waits for the time it names: before it, a click could only be refused again.
  const canRetry = useReached(heldUntil);
  const failedNote = failed && (
    <p className="ib-prd-none" role="status" data-pull-details-failed={heldUntil ? 'held' : ''}>
      {heldUntil
        ? `${layer.host} asked to slow down.${canRetry ? '' : ` Try again after ${new Date(heldUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`}`
        : `${forge} did not answer about the ${descriptionUnread ? 'description, ' : ''}reviewers and checks.`}{' '}
      {canRetry && <button type="button" className="ib-prd-more" onClick={onRetry}>Try again</button>}
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
