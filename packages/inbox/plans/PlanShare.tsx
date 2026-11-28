/**
 * Share this space (approval "share-this-space", `.product/approved/share-this-space/`): the Share button at the
 * right end of a plan page's top bar and the small panel under it (a sheet from the bottom on a phone). The upload
 * runs in the Inbox (packages/shared/spaces/share-job.ts); this reads where it stands (`GET /api/plans/:id/share`,
 * again every `SHARE_POLL_MS` while something is going) and asks for the next thing. Drawn only while the Inbox says
 * Share this space is on (`usePlanShareOn`); off, nothing here is drawn or read.
 *
 * Every word on it is in `SHARE_WORDS`, as approved: labels are nouns or verbs, no sentence explains another, and no
 * state shows more than about 20 words. No keyboard shortcut is added: the panel is Base UI's Popover (Escape and a
 * press outside close it, focus goes back to the button), the switch is a radio group, the rest are buttons and links.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Popover } from '@base-ui/react/popover';
import { spaceShareButton, type SpaceShareDetails, type SpaceShareMode, type SpaceShareStatus } from '@plannotator/core/space-share';
import { Icon, type IconName } from '../icons';
import { plansApi } from './client';

export const SHARE_POLL_MS = 600;

/** The approved strings, verbatim (FLOW.md). */
export const SHARE_WORDS = {
  share: 'Share',
  sharing: 'Sharing',
  shared: 'Shared',
  update: 'Update',
  all: 'All versions',
  newest: 'Newest',
  anyone: 'Anyone with the link can edit',
  onlyYou: 'Only you',
  anyoneComment: 'Anyone with the link can comment',
  details: 'Details',
  waiting: 'Waiting…',
  copy: 'Copy link',
  copied: 'Copied',
  stop: 'Stop',
  makeYours: 'Make it yours',
  keep: 'Keep this space',
  idle: 'Removed after 30 idle days unless kept.',
  keepWaiting: 'Waiting for your browser…',
  keepFirst: 'First to keep it owns it.',
  cancel: 'Cancel',
  openAgain: 'Open again',
  keepRemote: 'Sign in from your own computer.',
  close: 'Close',
  invite: 'Invite',
  openInSpaces: 'Open in Spaces',
  keptByOther: 'Someone else kept this space',
  stillComment: 'You can still comment there.',
  shareAsNew: 'Share as new',
  overLimit: 'Over 100 MB without sign-in.',
  overLimitOwn: 'Over the limit',
  signIn: 'Sign in',
  failed: 'Couldn’t reach Spaces.',
  tryAgain: 'Try again',
  stopped: 'Sharing stopped',
  gone: 'This space is gone',
  stopSharing: 'Stop sharing',
  deletes: 'Deletes the copy in Spaces for good.',
  del: 'Delete',
  notShared: 'Not shared',
  link: 'Link',
  back: 'Back',
} as const;

const changesWords = (n: number) => `${n} ${n === 1 ? 'change' : 'changes'} here`;
const busyWords = (seconds: number) => `Spaces is busy. Trying again in ${seconds} s.`;
/** Only an http(s) address is ever a link on the page. */
const linkOf = (status: SpaceShareStatus) => (status.link && /^https?:\/\//i.test(status.link) ? status.link : null);

/** Two marks the Inbox's set has no shape for (lucide's share and globe), drawn as its icons are. */
const EXTRA_MARKS = {
  share: 'M12 2v13 M16 6l-4-4-4 4 M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8',
  globe: 'M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0 M12 2a14.5 14.5 0 0 0 0 20a14.5 14.5 0 0 0 0-20 M2 12h20',
} as const;
function Mark({ name }: { name: keyof typeof EXTRA_MARKS | IconName }) {
  if (name in EXTRA_MARKS) {
    return (
      <svg className="ib-ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-icon={name}>
        <path d={EXTRA_MARKS[name as keyof typeof EXTRA_MARKS]} />
      </svg>
    );
  }
  return <Icon name={name as IconName} />;
}

const Spinner = () => <span className="ib-shr-spin" aria-hidden="true" />;

// ─────────────────────────────── The panel's parts ───────────────────────────────

function Head({ title, right, id }: { title: ReactNode; right?: ReactNode; id?: string }) {
  return (
    <div className="ib-shr-head">
      <h2 className="ib-shr-title" id={id}>
        {title}
      </h2>
      {right}
    </div>
  );
}

function Btn({ children, kind, onClick, name, disabled }: { children: ReactNode; kind?: 'pri' | 'danger' | 'dangerq'; onClick: () => void; name: string; disabled?: boolean }) {
  return (
    <button type="button" className={`ib-shr-b${kind ? ` ib-shr-${kind}` : ''}`} onClick={onClick} data-share-act={name} disabled={disabled}>
      {children}
    </button>
  );
}

function LinkBtn({ href, children, name, icon }: { href: string; children?: ReactNode; name: string; icon?: boolean }) {
  return (
    <a className={`ib-shr-b${icon ? ' ib-shr-icb' : ''}`} href={href} target="_blank" rel="noopener noreferrer" data-share-act={name} {...(icon ? { 'aria-label': SHARE_WORDS.openInSpaces, title: SHARE_WORDS.openInSpaces } : {})}>
      {icon ? <Mark name="external" /> : children}
    </a>
  );
}

function LinkRow({ link, primary }: { link: string; primary: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = () => {
    void navigator.clipboard?.writeText(link).then(
      () => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };
  return (
    <div className="ib-shr-linkrow" data-share-link="">
      <input className="ib-shr-field" readOnly value={link} aria-label={SHARE_WORDS.link} onFocus={(e) => e.currentTarget.select()} />
      <button type="button" className={`ib-shr-b${primary ? ' ib-shr-pri' : ''}`} onClick={copy} data-share-act="copy">
        <span aria-live="polite">{copied ? SHARE_WORDS.copied : SHARE_WORDS.copy}</span>
      </button>
      <LinkBtn href={link} name="open" icon />
    </div>
  );
}

function Row({ mark, children, right, warn, oneLine }: { mark: Parameters<typeof Mark>[0]['name']; children: ReactNode; right?: ReactNode; warn?: boolean; oneLine?: boolean }) {
  return (
    <div className={`ib-shr-arow${warn ? ' ib-shr-warnrow' : ''}${oneLine ? ' ib-shr-oneline' : ''}`} data-share-row-mark={mark}>
      <span className="ib-shr-disc">
        <Mark name={mark} />
      </span>
      <span className="ib-shr-atext">{children}</span>
      {right}
    </div>
  );
}

function Msg({ mark, children, tone, first }: { mark: Parameters<typeof Mark>[0]['name'] | 'spin'; children: ReactNode; tone?: 'quiet' | 'warn'; first?: boolean }) {
  return (
    <p className={`ib-shr-msg${tone ? ` ib-shr-${tone}` : ''}${first ? ' ib-shr-first' : ''}`} role="status">
      <span className="ib-shr-msgico">{mark === 'spin' ? <Spinner /> : <Mark name={mark} />}</span>
      <span>{children}</span>
    </p>
  );
}

function Foot({ left, children }: { left?: ReactNode; children?: ReactNode }) {
  return (
    <div className="ib-shr-foot">
      <span>{left}</span>
      <span className="ib-shr-fr">{children}</span>
    </div>
  );
}

/** The one fact behind the info mark: on hover, on focus, and on a press. */
function InfoMark() {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="ib-shr-infowrap">
      <button type="button" className="ib-shr-info" aria-label={SHARE_WORDS.idle} aria-describedby={id} aria-expanded={open} onClick={() => setOpen((o) => !o)} onBlur={() => setOpen(false)} data-share-info="">
        <Mark name="info" />
      </button>
      <span role="tooltip" id={id} className="ib-shr-tip" data-open={open ? '' : undefined}>
        {SHARE_WORDS.idle}
      </span>
    </span>
  );
}

function VersionSwitch({ mode, onMode }: { mode: SpaceShareMode; onMode: (mode: SpaceShareMode) => void }) {
  const refs = useRef<Record<SpaceShareMode, HTMLButtonElement | null>>({ all: null, newest: null });
  const pick = (next: SpaceShareMode) => {
    onMode(next);
    refs.current[next]?.focus();
  };
  const option = (value: SpaceShareMode, label: string) => (
    <button
      key={value}
      ref={(el) => void (refs.current[value] = el)}
      type="button"
      role="radio"
      aria-checked={mode === value}
      tabIndex={mode === value ? 0 : -1}
      className="ib-shr-segb"
      onClick={() => onMode(value)}
      onKeyDown={(e) => {
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
          e.preventDefault();
          pick(value === 'all' ? 'newest' : 'all');
        }
      }}
      data-share-mode={value}
    >
      {label}
    </button>
  );
  return (
    <div className="ib-shr-seg" role="radiogroup" aria-label="Versions">
      {option('all', SHARE_WORDS.all)}
      {option('newest', SHARE_WORDS.newest)}
    </div>
  );
}

/** The most words the Details view shows (the approved rule: about 20 a state). */
export const DETAILS_WORDS_MAX = 20;

/**
 * The Details rows: what goes up, then what stays. Every row that applies is shown while the view holds its 20
 * words; past that, the rows about what stays give way, least surprising first (the dates, older approvals, the
 * comments the agent has). A file or a page too big to go is never the one left out: with both, and every row above
 * them, the view is 21 words. Shown in the approved order.
 */
export function detailsRows(details: SpaceShareDetails): { up: [string, string][]; not: [string, string][] } {
  const up: [string, string][] = [];
  if (details.pages > 0) up.push(['Pages', String(details.pages)]);
  if (details.files > 0) up.push(['Files', String(details.files)]);
  if (details.comments > 0) up.push(['Comments', String(details.comments)]);
  if (details.approval !== null) up.push(['Approval', `v${details.approval}`]);
  // [label, value, the order it is kept in when words run short]
  const all: [string, string, number][] = [];
  if (details.not.sent_comments > 0) all.push(['Sent comments', String(details.not.sent_comments), 4]);
  if (details.not.pictures > 0) all.push(['Pictures', String(details.not.pictures), 5]);
  if (details.not.original_dates) all.push(['Original dates', '', 7]);
  if (details.not.files_over > 0) all.push(['File over 100 MB', String(details.not.files_over), 1]);
  if (details.not.pages_over > 0) all.push(['Page over 1.5 MB', String(details.not.pages_over), 2]);
  if (details.not.long_comments > 0) all.push(['Long comment', String(details.not.long_comments), 3]);
  if (details.not.older_approvals > 0) all.push(['Older approvals', String(details.not.older_approvals), 6]);
  const wordsOf = (label: string, value: string) => label.split(' ').length + (value ? 1 : 0);
  // "Details", the rows that go up, and "Not shared" once any row follows it.
  let left = DETAILS_WORDS_MAX - 1 - up.reduce((n, [label, value]) => n + wordsOf(label, value), 0) - 2;
  const kept = new Set<string>();
  for (const [label, value] of [...all].sort((a, b) => a[2] - b[2])) {
    const words = wordsOf(label, value);
    // A file or a page too big to go is always said, even where the two together run one word over.
    const must = label.includes(' over ');
    if (words > left && !must) continue;
    left -= words;
    kept.add(label);
  }
  return { up, not: all.filter(([label]) => kept.has(label)).map(([label, value]) => [label, value]) };
}

function DetailsView({ details, onBack, onStopSharing }: { details: SpaceShareDetails; onBack: () => void; onStopSharing: (() => void) | null }) {
  const row = ([label, value]: [string, string]) => (
    <div className="ib-shr-row" key={label} data-share-row={label}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
  const rows = detailsRows(details);
  const up = rows.up.map(row);
  const not = rows.not.map(row);
  return (
    <>
      <div className="ib-shr-head">
        <button type="button" className="ib-shr-backb" onClick={onBack} aria-label={SHARE_WORDS.back} data-share-act="back">
          <Mark name="back" />
        </button>
        <h2 className="ib-shr-title">{SHARE_WORDS.details}</h2>
      </div>
      {up.length > 0 && <dl className="ib-shr-rows">{up}</dl>}
      {not.length > 0 && (
        <>
          <h3 className="ib-shr-grp">{SHARE_WORDS.notShared}</h3>
          <dl className="ib-shr-rows">{not}</dl>
        </>
      )}
      {onStopSharing && (
        <Foot>
          <Btn kind="dangerq" onClick={onStopSharing} name="stop-sharing">
            {SHARE_WORDS.stopSharing}
          </Btn>
        </Foot>
      )}
    </>
  );
}

// ─────────────────────────────── The panel ───────────────────────────────

export type ShareView = 'main' | 'details' | 'stop';

export interface ShareActions {
  share: (input: { mode?: SpaceShareMode; fresh?: boolean }) => void;
  stop: () => void;
  keep: () => void;
  keepCancel: () => void;
  /** Stop sharing; false when the space could not be deleted. */
  remove: () => Promise<boolean>;
}

export interface SharePanelProps {
  status: SpaceShareStatus;
  view: ShareView;
  onView: (view: ShareView) => void;
  mode: SpaceShareMode;
  onMode: (mode: SpaceShareMode) => void;
  actions: ShareActions;
}

/** The panel's content for where the share stands: one state at a time, each as approved. */
export function SharePanel({ status, view, onView, mode, onMode, actions }: SharePanelProps) {
  const [deleteFailed, setDeleteFailed] = useState(false);
  const link = linkOf(status);
  const shownMode = status.phase === 'none' ? mode : status.mode;

  if (view === 'stop') {
    return (
      <>
        <Head title={SHARE_WORDS.stopSharing} />
        <Msg mark="excl" tone="warn">
          {deleteFailed ? SHARE_WORDS.failed : SHARE_WORDS.deletes}
        </Msg>
        <Foot>
          <Btn onClick={() => onView('main')} name="cancel">
            {SHARE_WORDS.cancel}
          </Btn>
          <Btn
            kind="danger"
            name="delete"
            onClick={() => {
              setDeleteFailed(false);
              void actions.remove().then((ok) => (ok ? onView('main') : setDeleteFailed(true)));
            }}
          >
            {SHARE_WORDS.del}
          </Btn>
        </Foot>
      </>
    );
  }
  if (view === 'details') {
    return <DetailsView details={status.details[shownMode]} onBack={() => onView('main')} onStopSharing={status.kept && status.phase === 'shared' ? () => onView('stop') : null} />;
  }

  if (status.keep === 'waiting') {
    return (
      <>
        <Head title={SHARE_WORDS.keep} />
        <Msg mark="spin">{SHARE_WORDS.keepWaiting}</Msg>
        <Msg mark="info" tone="quiet">
          {SHARE_WORDS.keepFirst}
        </Msg>
        <Foot>
          <Btn onClick={actions.keepCancel} name="keep-cancel">
            {SHARE_WORDS.cancel}
          </Btn>
          <Btn onClick={actions.keep} name="keep-again">
            {SHARE_WORDS.openAgain}
          </Btn>
        </Foot>
      </>
    );
  }
  if (status.keep === 'remote') {
    return (
      <>
        <Head title={SHARE_WORDS.keep} />
        <Msg mark="info">{SHARE_WORDS.keepRemote}</Msg>
        <Foot>
          <Btn onClick={actions.keepCancel} name="keep-close">
            {SHARE_WORDS.close}
          </Btn>
        </Foot>
      </>
    );
  }

  // The access line says what is true of the space: private only when it was made signed in; a space kept after
  // it was shared still lets holders of its link read and comment.
  const invite = status.kept && status.phase !== 'none' && link ? <LinkBtn href={link} name="invite">{SHARE_WORDS.invite}</LinkBtn> : undefined;
  const access = (right?: ReactNode, own?: ReactNode) =>
    status.access === 'private' ? (
      <Row mark="lock" right={own ?? invite}>
        {SHARE_WORDS.onlyYou}
      </Row>
    ) : status.access === 'comment' ? (
      <Row mark="globe" right={own ?? invite} oneLine={!own}>
        {SHARE_WORDS.anyoneComment}
      </Row>
    ) : (
      <Row mark="globe" right={right}>
        {SHARE_WORDS.anyone}
      </Row>
    );
  const detailsLink = (
    <button type="button" className="ib-shr-det" onClick={() => onView('details')} data-share-act="details">
      {SHARE_WORDS.details}
    </button>
  );

  switch (status.phase) {
    case 'none':
      return (
        <>
          <Head
            title={SHARE_WORDS.share}
            right={
              status.signed_in && status.who ? (
                <span className="ib-shr-who" data-share-who="">
                  <Mark name="user" /> {status.who}
                </span>
              ) : undefined
            }
          />
          {status.versions > 1 && <VersionSwitch mode={mode} onMode={onMode} />}
          {access()}
          <Foot left={detailsLink}>
            <Btn kind="pri" onClick={() => actions.share({ mode })} name="share">
              {SHARE_WORDS.share}
            </Btn>
          </Foot>
        </>
      );
    case 'sharing': {
      const progress = status.progress ?? { done: 0, total: 0 };
      // Too many new spaces in a minute, before anything is up: one line, and the one way past it.
      if (status.waiting !== null && !link && progress.done === 0) {
        return (
          <>
            <Msg mark="excl" tone="warn" first>
              {busyWords(status.waiting)}
            </Msg>
            <Foot>
              <Btn kind="pri" onClick={actions.keep} name="sign-in">
                {SHARE_WORDS.signIn}
              </Btn>
            </Foot>
          </>
        );
      }
      const title = status.waiting !== null ? SHARE_WORDS.waiting : SHARE_WORDS.sharing;
      return (
        <>
          <Head title={title} right={<span className="ib-shr-count" data-share-count="">{`${progress.done} of ${progress.total}`}</span>} />
          <div className="ib-shr-prog" role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} aria-valuetext={`${progress.done} of ${progress.total}`}>
            <i style={{ width: `${progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0}%` }} />
          </div>
          {link && <LinkRow link={link} primary={false} />}
          <Foot>
            <Btn onClick={actions.stop} name="stop">
              {SHARE_WORDS.stop}
            </Btn>
          </Foot>
        </>
      );
    }
    case 'shared': {
      const stopped = status.stopped_pages.length > 0;
      const update = status.changes > 0;
      // Waiting for Keep (a write was not allowed, or the sign-in is gone): Keep is offered, and Update waits for it.
      const waits = status.needs_keep === true;
      const offerKeep = waits || (!stopped && !update && !status.kept);
      // The person's own space, signed out here: only signing in again is asked, on the access line itself.
      const keepButton = (
        <Btn onClick={actions.keep} name="keep" disabled={status.busy === true}>
          {SHARE_WORDS.keep}
        </Btn>
      );
      const ownWaits = waits && status.own === true;
      return (
        <>
          {link && <LinkRow link={link} primary={!stopped && !update && !waits} />}
          {stopped
            ? status.stopped_pages.map((page) => (
                <Row key={page.title} mark="excl" warn right={link ? <LinkBtn href={link} name="open-page">{SHARE_WORDS.openInSpaces}</LinkBtn> : undefined}>
                  {page.title} changed
                </Row>
              ))
            : access(!update && !waits ? <InfoMark /> : undefined, ownWaits ? keepButton : undefined)}
          {offerKeep && !(ownWaits && !stopped) && (
            <Row
              mark="user"
              right={
                <Btn onClick={actions.keep} name="keep" disabled={status.busy === true}>
                  {SHARE_WORDS.keep}
                </Btn>
              }
            >
              {SHARE_WORDS.makeYours}
            </Row>
          )}
          {update && (
            <Row
              mark="doc"
              right={
                <Btn kind="pri" onClick={() => actions.share({})} name="update" disabled={waits}>
                  {SHARE_WORDS.update}
                </Btn>
              }
            >
              {changesWords(status.changes)}
            </Row>
          )}
          {!stopped && !update && <Foot left={detailsLink} />}
        </>
      );
    }
    case 'gone':
      // The space is no longer there for this computer: one line, and the one way on.
      return (
        <>
          <Msg mark="excl" tone="warn" first>
            {SHARE_WORDS.gone}
          </Msg>
          <Foot>
            <Btn kind="pri" onClick={() => actions.share({ mode: status.mode, fresh: true })} name="share-new">
              {SHARE_WORDS.shareAsNew}
            </Btn>
          </Foot>
        </>
      );
    case 'refused':
      return (
        <>
          <Head title={SHARE_WORDS.keptByOther} />
          <Msg mark="info" tone="quiet">
            {SHARE_WORDS.stillComment}
          </Msg>
          <Foot>
            {link && <LinkBtn href={link} name="open-space">{SHARE_WORDS.openInSpaces}</LinkBtn>}
            <Btn kind="pri" onClick={() => actions.share({ mode: status.mode, fresh: true })} name="share-new">
              {SHARE_WORDS.shareAsNew}
            </Btn>
          </Foot>
        </>
      );
    case 'over_limit':
      // The person's own space: no sign-in can help. Try again sends once more (room may have been made in the
      // space) and comes back here when it is still over; nothing tries by itself.
      if (status.limit_own) {
        return (
          <>
            <Msg mark="excl" tone="warn" first>
              {SHARE_WORDS.overLimitOwn}
            </Msg>
            {link && <LinkRow link={link} primary={false} />}
            <Foot>
              <Btn kind="pri" onClick={() => actions.share({})} name="try-again">
                {SHARE_WORDS.tryAgain}
              </Btn>
            </Foot>
          </>
        );
      }
      return (
        <>
          <Msg mark="excl" tone="warn" first>
            {SHARE_WORDS.overLimit}
          </Msg>
          <Foot>
            <Btn kind="pri" onClick={actions.keep} name="sign-in">
              {SHARE_WORDS.signIn}
            </Btn>
          </Foot>
        </>
      );
    case 'failed':
    case 'stopped':
      return (
        <>
          <Msg mark="excl" tone="warn" first>
            {status.phase === 'failed' ? SHARE_WORDS.failed : SHARE_WORDS.stopped}
          </Msg>
          {link && <LinkRow link={link} primary={false} />}
          <Foot>
            {/* Started signed in and the sign-in is gone: signing in again is the way on, never a share without it. */}
            {status.needs_keep ? (
              <Btn kind="pri" onClick={actions.keep} name="keep" disabled={status.busy === true}>
                {SHARE_WORDS.keep}
              </Btn>
            ) : (
              <Btn kind="pri" onClick={() => actions.share({})} name="try-again">
                {SHARE_WORDS.tryAgain}
              </Btn>
            )}
          </Foot>
        </>
      );
  }
}

// ─────────────────────────────── The button ───────────────────────────────

const BUTTON_MARK: Record<ReturnType<typeof spaceShareButton>['state'], Parameters<typeof Mark>[0]['name'] | 'spin'> = { idle: 'share', busy: 'spin', shared: 'link', update: 'share', look: 'excl', failed: 'excl' };
/** What a screen reader hears beside the label when the button carries a mark. */
const BUTTON_NOTE: Partial<Record<ReturnType<typeof spaceShareButton>['state'], string>> = { look: 'needs a look', failed: 'did not finish' };

export interface PlanShareProps {
  id: string;
  phone: boolean;
  /** Counts the page's own writes and reads of the plan: the share's standing is read again after each. */
  fresh?: number;
}

export function PlanShare({ id, phone, fresh = 0 }: PlanShareProps) {
  const [status, setStatus] = useState<SpaceShareStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ShareView>('main');
  const [mode, setMode] = useState<SpaceShareMode>('all');
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  // Drawn inside the window's root, so its styles and theme reach it.
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(trigger.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);

  const take = useCallback((next: Promise<SpaceShareStatus>) => next.then((s) => void (alive.current && setStatus(s))).catch(() => {}), []);
  const read = useCallback(() => take(plansApi.share(id)), [id, take]);
  useEffect(() => {
    void read();
  }, [read, fresh, open]);
  useEffect(() => {
    const back = () => document.visibilityState === 'visible' && void read();
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, [read]);
  // While an upload or a sign-in is going, its standing is read again and again, panel open or not.
  const going = status?.phase === 'sharing' || status?.keep === 'waiting' || status?.busy === true;
  useEffect(() => {
    if (!going) return;
    const timer = setInterval(() => void read(), SHARE_POLL_MS);
    return () => clearInterval(timer);
  }, [going, read]);

  const actions: ShareActions = {
    share: (input) => void take(plansApi.shareStart(id, input)),
    stop: () => void take(plansApi.shareStop(id)),
    keep: () => void take(plansApi.shareKeep(id)),
    keepCancel: () => void take(plansApi.shareKeepCancel(id)),
    remove: () =>
      plansApi.shareDelete(id).then(
        (s) => {
          if (alive.current) setStatus(s);
          return true;
        },
        () => false,
      ),
  };

  const button = spaceShareButton(status);
  const mark = BUTTON_MARK[button.state];
  const note = BUTTON_NOTE[button.state];
  return (
    <Popover.Root
      open={open}
      modal={phone}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setView('main');
      }}
    >
      <Popover.Trigger ref={trigger} className="ib-shr-btn" data-plan-share="" data-state={button.state} data-phone={phone ? '' : undefined} aria-label={note ? `${button.label}: ${note}` : undefined}>
        {mark === 'spin' ? <Spinner /> : <Mark name={mark} />}
        <span>{button.label}</span>
      </Popover.Trigger>
      <Popover.Portal container={portal ?? undefined}>
        {phone && <Popover.Backdrop className="ib-oq-scrim" data-plan-share-scrim="" />}
        <Popover.Positioner className="ib-oq-pos ib-shr-pos" side="bottom" align="end" sideOffset={6} collisionPadding={8} data-phone={phone ? '' : undefined}>
          {/* Focus goes to the panel itself: a link field focused on open would scroll and select its text. */}
          <Popover.Popup ref={popup} tabIndex={-1} initialFocus={popup} className="ib-shr" aria-label={SHARE_WORDS.share} data-plan-share-panel="" data-phone={phone ? '' : undefined}>
            {status && <SharePanel status={status} view={view} onView={setView} mode={mode} onMode={setMode} actions={actions} />}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
