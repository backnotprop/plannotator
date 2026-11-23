/**
 * Share this space (approval "share-this-space", `.product/approved/share-this-space/`): the Share button at the
 * right end of a plan page's top bar and the small panel under it (the Inbox's own bottom sheet on a phone). The upload
 * runs in the Inbox (packages/shared/spaces/share-job.ts); this reads where it stands (`GET /api/plans/:id/share`,
 * again every `SHARE_POLL_MS` while something is going) and asks for the next thing. Drawn only while the Inbox says
 * Share this space is on (`usePlanShareOn`); off, nothing here is drawn or read.
 *
 * Every word on it is in `SHARE_WORDS`, as approved: labels are nouns or verbs, no sentence explains another, and no
 * state shows more than about 20 words. No keyboard shortcut is added: the panel is Base UI's Popover (Escape and a
 * press outside close it, focus goes back to the button), on a phone the Inbox's `BottomSheet` (Escape, the scrim or a
 * drag down close it); the switch is a radio group, the rest are buttons and links.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Popover } from '@base-ui/react/popover';
import { spaceShareButton, type SpaceShareDetails, type SpaceShareMode, type SpaceShareStatus } from '@plannotator/core/space-share';
import { BottomSheet } from '../components/BottomSheet';
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
//
// Every state has the same three parts (approval "inbox-share-panel-b1", B1): the status line (what is true now, with
// a count, a person or the one mark that opens the space at its end), at most two lines about the space (who can open
// it), and one row of actions (Details at its left; at its right one main button and at most one more). The address is
// never shown: Copy link is a button, and the status line's mark opens the space.

function Status({ title, warn, right }: { title: ReactNode; warn?: boolean; right?: ReactNode }) {
  return (
    <div className="ib-shr-head" data-share-status="">
      {warn && (
        <span className="ib-shr-warn">
          <Mark name="excl" />
        </span>
      )}
      <h2 className="ib-shr-title">{title}</h2>
      <span className="ib-shr-sp" />
      {right}
    </div>
  );
}

/** The one mark that opens the space, at the end of the status line. */
function OpenMark({ link }: { link: string }) {
  return (
    <a className="ib-shr-open" href={link} target="_blank" rel="noopener noreferrer" aria-label={SHARE_WORDS.openInSpaces} title={SHARE_WORDS.openInSpaces} data-share-act="open">
      <Mark name="external" />
    </a>
  );
}

function Btn({ children, kind, onClick, name, disabled }: { children: ReactNode; kind?: 'pri' | 'danger' | 'dangerq'; onClick: () => void; name: string; disabled?: boolean }) {
  return (
    <button type="button" className={`ib-shr-b${kind ? ` ib-shr-${kind}` : ''}`} onClick={onClick} data-share-act={name} disabled={disabled}>
      {children}
    </button>
  );
}

function LinkBtn({ href, children, name, primary }: { href: string; children: ReactNode; name: string; primary?: boolean }) {
  return (
    <a className={`ib-shr-b${primary ? ' ib-shr-pri' : ''}`} href={href} target="_blank" rel="noopener noreferrer" data-share-act={name}>
      {children}
    </a>
  );
}

/** Copy link: the link itself is never drawn; "Copied" for a moment once it is on the clipboard. */
function CopyBtn({ link, primary }: { link: string; primary?: boolean }) {
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
    <button type="button" className={`ib-shr-b${primary ? ' ib-shr-pri' : ''}`} onClick={copy} data-share-act="copy">
      <span aria-live="polite">{copied ? SHARE_WORDS.copied : SHARE_WORDS.copy}</span>
    </button>
  );
}

function Row({ mark, children, right, warn, quiet, oneLine }: { mark: Parameters<typeof Mark>[0]['name']; children: ReactNode; right?: ReactNode; warn?: boolean; quiet?: boolean; oneLine?: boolean }) {
  return (
    <div className={`ib-shr-arow${warn ? ' ib-shr-warnrow' : ''}${quiet ? ' ib-shr-quietrow' : ''}${oneLine ? ' ib-shr-oneline' : ''}`} data-share-row-mark={mark}>
      <span className="ib-shr-disc">
        <Mark name={mark} />
      </span>
      <span className="ib-shr-atext">{children}</span>
      {right}
    </div>
  );
}

function Msg({ mark, children, tone }: { mark: Parameters<typeof Mark>[0]['name'] | 'spin'; children: ReactNode; tone?: 'quiet' | 'warn' }) {
  return (
    <p className={`ib-shr-msg${tone ? ` ib-shr-${tone}` : ''}`} role="status">
      <span className="ib-shr-msgico">{mark === 'spin' ? <Spinner /> : <Mark name={mark} />}</span>
      <span>{children}</span>
    </p>
  );
}

/** The one row of actions: what is at its left (Details), then the buttons at its right, the main one last. */
function Actions({ left, children }: { left?: ReactNode; children?: ReactNode }) {
  return (
    <div className="ib-shr-foot" data-share-actions="">
      {left}
      <span className="ib-shr-sp" />
      {children}
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
        <Actions>
          <Btn kind="dangerq" onClick={onStopSharing} name="stop-sharing">
            {SHARE_WORDS.stopSharing}
          </Btn>
        </Actions>
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
        <Status title={SHARE_WORDS.stopSharing} />
        <Msg mark="excl" tone="warn">
          {deleteFailed ? SHARE_WORDS.failed : SHARE_WORDS.deletes}
        </Msg>
        <Actions>
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
        </Actions>
      </>
    );
  }
  if (view === 'details') {
    return <DetailsView details={status.details[shownMode]} onBack={() => onView('main')} onStopSharing={status.kept && status.phase === 'shared' ? () => onView('stop') : null} />;
  }

  if (status.keep === 'waiting') {
    return (
      <>
        <Status title={SHARE_WORDS.keep} />
        <Msg mark="spin">{SHARE_WORDS.keepWaiting}</Msg>
        <Msg mark="info" tone="quiet">
          {SHARE_WORDS.keepFirst}
        </Msg>
        <Actions>
          <Btn onClick={actions.keepCancel} name="keep-cancel">
            {SHARE_WORDS.cancel}
          </Btn>
          <Btn onClick={actions.keep} name="keep-again">
            {SHARE_WORDS.openAgain}
          </Btn>
        </Actions>
      </>
    );
  }
  if (status.keep === 'remote') {
    return (
      <>
        <Status title={SHARE_WORDS.keep} />
        <Msg mark="info">{SHARE_WORDS.keepRemote}</Msg>
        <Actions>
          <Btn onClick={actions.keepCancel} name="keep-close">
            {SHARE_WORDS.close}
          </Btn>
        </Actions>
      </>
    );
  }

  // The access line says what is true of the space: private only when it was made signed in; a space kept after
  // it was shared still lets holders of its link read and comment.
  const access = (right?: ReactNode) =>
    status.access === 'private' ? (
      <Row mark="lock">{SHARE_WORDS.onlyYou}</Row>
    ) : status.access === 'comment' ? (
      <Row mark="globe" oneLine>
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
  const openMark = link ? <OpenMark link={link} /> : undefined;

  switch (status.phase) {
    case 'none':
      return (
        <>
          <Status
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
          <Actions left={detailsLink}>
            <Btn kind="pri" onClick={() => actions.share({ mode })} name="share">
              {SHARE_WORDS.share}
            </Btn>
          </Actions>
        </>
      );
    case 'sharing': {
      const progress = status.progress ?? { done: 0, total: 0 };
      // Too many new spaces in a minute, before anything is up: one line, and the one way past it.
      if (status.waiting !== null && !link && progress.done === 0) {
        return (
          <>
            <Status warn title={busyWords(status.waiting)} />
            <Actions>
              <Btn kind="pri" onClick={actions.keep} name="sign-in">
                {SHARE_WORDS.signIn}
              </Btn>
            </Actions>
          </>
        );
      }
      const title = status.waiting !== null ? SHARE_WORDS.waiting : SHARE_WORDS.sharing;
      return (
        <>
          <Status title={title} right={<span className="ib-shr-count" data-share-count="">{`${progress.done} of ${progress.total}`}</span>} />
          <div className="ib-shr-prog" role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} aria-valuetext={`${progress.done} of ${progress.total}`}>
            <i style={{ width: `${progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0}%` }} />
          </div>
          <Actions>
            <Btn onClick={actions.stop} name="stop">
              {SHARE_WORDS.stop}
            </Btn>
            {link && <CopyBtn link={link} />}
          </Actions>
        </>
      );
    }
    case 'shared': {
      const stopped = status.stopped_pages.length > 0;
      const update = status.changes > 0;
      // Waiting for Keep (a write was not allowed, or the sign-in is gone): Keep is offered, and the changes wait for
      // it (a Keep sends what waits), so with changes Keep is the main button where Update would be.
      const waits = status.needs_keep === true;
      const keepButton = (primary: boolean) => (
        <Btn kind={primary ? 'pri' : undefined} onClick={actions.keep} name="keep" disabled={status.busy === true}>
          {SHARE_WORDS.keep}
        </Btn>
      );
      // Beside the main button: Keep for a space nobody kept, Invite for a kept one; Copy link when the main one is
      // something else.
      let other: ReactNode = null;
      let main: ReactNode = null;
      if (waits && update) {
        other = link && <CopyBtn link={link} />;
        main = keepButton(true);
      } else if (update) {
        other = link && <CopyBtn link={link} />;
        main = (
          <Btn kind="pri" onClick={() => actions.share({})} name="update">
            {SHARE_WORDS.update}
          </Btn>
        );
      } else {
        other = waits || (!stopped && !status.kept) ? keepButton(!link) : status.kept && link ? <LinkBtn href={link} name="invite">{SHARE_WORDS.invite}</LinkBtn> : null;
        main = link && <CopyBtn link={link} primary />;
      }
      return (
        <>
          <Status title={update ? changesWords(status.changes) : SHARE_WORDS.shared} right={openMark} />
          {stopped
            ? status.stopped_pages.map((page) => (
                <Row key={page.title} mark="excl" warn>
                  {page.title} changed
                </Row>
              ))
            : access(!update && !waits ? <InfoMark /> : undefined)}
          <Actions left={detailsLink}>
            {other}
            {main}
          </Actions>
        </>
      );
    }
    case 'gone':
      // The space is no longer there for this computer: one line, and the one way on.
      return (
        <>
          <Status warn title={SHARE_WORDS.gone} />
          <Actions>
            <Btn kind="pri" onClick={() => actions.share({ mode: status.mode, fresh: true })} name="share-new">
              {SHARE_WORDS.shareAsNew}
            </Btn>
          </Actions>
        </>
      );
    case 'refused':
      return (
        <>
          <Status title={SHARE_WORDS.keptByOther} />
          <Row mark="info" quiet>
            {SHARE_WORDS.stillComment}
          </Row>
          <Actions>
            {link && <LinkBtn href={link} name="open-space">{SHARE_WORDS.openInSpaces}</LinkBtn>}
            <Btn kind="pri" onClick={() => actions.share({ mode: status.mode, fresh: true })} name="share-new">
              {SHARE_WORDS.shareAsNew}
            </Btn>
          </Actions>
        </>
      );
    case 'over_limit':
      // The person's own space: no sign-in can help. Room is made in the space, so Open in Spaces is the main button;
      // Try again sends once more and comes back here when it is still over; nothing tries by itself.
      if (status.limit_own) {
        return (
          <>
            <Status warn title={SHARE_WORDS.overLimitOwn} />
            <Actions>
              <Btn kind={link ? undefined : 'pri'} onClick={() => actions.share({})} name="try-again">
                {SHARE_WORDS.tryAgain}
              </Btn>
              {link && (
                <LinkBtn href={link} name="open-space" primary>
                  {SHARE_WORDS.openInSpaces}
                </LinkBtn>
              )}
            </Actions>
          </>
        );
      }
      return (
        <>
          <Status warn title={SHARE_WORDS.overLimit} />
          <Actions>
            <Btn kind="pri" onClick={actions.keep} name="sign-in">
              {SHARE_WORDS.signIn}
            </Btn>
          </Actions>
        </>
      );
    case 'failed':
    case 'stopped':
      return (
        <>
          <Status warn title={status.phase === 'failed' ? SHARE_WORDS.failed : SHARE_WORDS.stopped} right={openMark} />
          <Actions>
            {link && <CopyBtn link={link} />}
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
          </Actions>
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
  const close = useCallback(() => {
    setOpen(false);
    setView('main');
  }, []);
  const content = status && <SharePanel status={status} view={view} onView={setView} mode={mode} onMode={setMode} actions={actions} />;
  const face = (
    <>
      {mark === 'spin' ? <Spinner /> : <Mark name={mark} />}
      <span>{button.label}</span>
    </>
  );
  const label = note ? `${button.label}: ${note}` : undefined;

  // A phone: the same panel in the Inbox's own bottom sheet (a card off the edges, a grab handle, 44 px targets).
  if (phone) {
    return (
      <>
        <button ref={trigger} type="button" className="ib-shr-btn" data-plan-share="" data-state={button.state} data-phone="" aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
          {face}
        </button>
        <BottomSheet open={open} onClose={close} title={SHARE_WORDS.share} host={portal} attrs={{ 'data-plan-share-sheet': '' }}>
          <div className="ib-shr" data-plan-share-panel="" data-phone="">
            {content}
          </div>
        </BottomSheet>
      </>
    );
  }
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setView('main');
      }}
    >
      <Popover.Trigger ref={trigger} className="ib-shr-btn" data-plan-share="" data-state={button.state} aria-label={label}>
        {face}
      </Popover.Trigger>
      <Popover.Portal container={portal ?? undefined}>
        <Popover.Positioner className="ib-oq-pos ib-shr-pos" side="bottom" align="end" sideOffset={6} collisionPadding={8}>
          {/* Focus goes to the panel itself, not to its first button. */}
          <Popover.Popup ref={popup} tabIndex={-1} initialFocus={popup} className="ib-shr" aria-label={SHARE_WORDS.share} data-plan-share-panel="">
            {content}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
