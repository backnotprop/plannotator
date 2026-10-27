/**
 * The Inbox's update control (design of record:
 * .product/approved/plannotator-updates/, Workspaces' rules): one full-width
 * filled button above Settings, no motion, never a percentage, never the
 * error colour; the update dialog with Update now in the first step; the
 * restart and failure dialogs; the What's new page; Settings → About.
 */

import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Viewer } from '@plannotator/ui/components/Viewer';
import { ImageResolverContext, type ImageResolution } from '@plannotator/ui/components/ImageResolverContext';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import type { InboxHealth } from '@plannotator/core/inbox-types';
import { whatsNewImageUrl, type UpdateCheckFailing, type UpdateDetails, type UpdateSwitches, type WhatsNewModel } from '../api';
import { clockTime, dayWords, formatCount, tildePath, whenTime } from '../format';
import { Icon } from '../icons';
import { CopyButton } from './ConnectPicker';
import { SidebarTrigger } from '../shell/sidebar';

type Update = NonNullable<InboxHealth['update']>;

const NO_ANNOTATIONS: never[] = [];
const noop = () => {};

/** a > b for X.Y.Z versions (anything else: false). */
function newerThan(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  if (pa.length !== 3 || pb.length !== 3 || [...pa, ...pb].some((n) => !Number.isInteger(n))) return false;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! > pb[i]!;
  return false;
}

/** "Oct 9", from an ISO date. */
function releasedOn(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date);
}

// ───────────────────────────── The sidebar button ─────────────────────────────

export interface UpdateButtonProps {
  update: InboxHealth['update'];
  /** Set by the page after Restart (or Update now's restart): "Restarting…". */
  restarting: boolean;
  /** This run started on a newer version: the quiet "What's new in X" link instead of a button. */
  updated: string | null;
  onPress: () => void;
  onWhatsNew: (version: string) => void;
}

const LABEL: Record<Update['state'], string> = {
  available: 'Update',
  ready: 'Update',
  updating: 'Updating…',
  failed: 'Update failed',
};

function tipFor(update: Update, restarting: boolean): string {
  if (restarting) return `Restarting into ${update.version}`;
  switch (update.state) {
    case 'available':
      return `Plannotator ${update.version} is available`;
    case 'ready':
      return `Plannotator ${update.version} is ready`;
    case 'updating':
      return `Installing Plannotator ${update.version}`;
    case 'failed':
      return `Plannotator ${update.version} didn't install`;
  }
}

/**
 * Up to date: nothing. Available and Ready: the filled Update. Updating and
 * Restarting: the same button, disabled, with a small spinner. Failed: a
 * neutral outline button. Updated: no button, a quiet link for this run.
 */
export function UpdateButton({ update, restarting, updated, onPress, onWhatsNew }: UpdateButtonProps) {
  if (!update) {
    return updated ? (
      <button type="button" className="ib-nav ib-quiet" data-whats-new-link={updated} onClick={() => onWhatsNew(updated)}>
        <Icon name="book" />
        What&apos;s new in {updated}
      </button>
    ) : null;
  }
  const busy = restarting || update.state === 'updating';
  // Available and Ready name their version ("Update to 0.28.22"), so the sidebar's
  // Update and the What's new page's are not two bare "Update"s.
  const label = restarting
    ? 'Restarting…'
    : update.state === 'available' || update.state === 'ready'
      ? `Update to ${update.version}`
      : LABEL[update.state];
  const tip = tipFor(update, restarting);
  // The name contains the visible words (WCAG 2.5.3 Label in Name: "click Update to 0.28.22" works by voice);
  // "Plannotator X" stays in the tooltip.
  const aria = update.state === 'failed' && !restarting ? `Update failed: Plannotator ${update.version} didn't install` : label;
  return (
    <div className="ib-upd" data-update-state={restarting ? 'restarting' : update.state}>
      <button
        type="button"
        className={`ib-upd-btn${update.state === 'failed' && !restarting ? ' ib-outline' : ''}`}
        disabled={busy}
        aria-label={aria}
        aria-describedby="ib-upd-tip"
        onClick={onPress}
      >
        {busy && <span className="ib-spin" aria-hidden="true" />}
        <span className="ib-upd-l">{label}</span>
      </button>
      <span className="ib-upd-tip" id="ib-upd-tip" role="tooltip">
        {tip}
      </span>
    </div>
  );
}

// ───────────────────────────── Dialogs ─────────────────────────────

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  /** The accessible name, when no element labels the dialog (`labelledBy`). */
  label?: string;
  labelledBy?: string;
  describedBy?: string;
  onClose: () => void;
  children: ReactNode;
  testId: string;
  /**
   * The dialog handles Tab and Escape itself: Tab cycles inside it (the
   * native modal leaves the browser's own chrome in the cycle), and Escape
   * closes it without reaching the page's own Escape (which closes a thread).
   */
  ownKeys?: boolean;
  /** Where focus goes on close when nothing focusable opened the dialog (the page heading). */
  fallbackFocus?: () => HTMLElement | null;
  /** A class beside `ib-dlg` (the agent-note dialog is wider, with a pinned footer). */
  className?: string;
}

/** A native modal dialog: focus stays inside, Escape closes, focus returns to what opened it. */
export function Modal({ label, labelledBy, describedBy, onClose, children, testId, ownKeys, fallbackFocus, className }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const fallback = useRef(fallbackFocus);
  fallback.current = fallbackFocus;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    opener.current = document.activeElement;
    if (typeof dialog.showModal === 'function' && !dialog.open) {
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute('open', '');
      }
    } else dialog.setAttribute('open', '');
    (dialog.querySelector('.ib-btn.ib-pri:not([disabled])') as HTMLElement | null)?.focus();
    return () => {
      if (opener.current instanceof HTMLElement && opener.current !== document.body && document.contains(opener.current)) opener.current.focus();
      else fallback.current?.()?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={className ? `ib-dlg ${className}` : 'ib-dlg'}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-modal={ownKeys ? 'true' : undefined}
      data-dialog={testId}
      onKeyDown={
        ownKeys
          ? (event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                onClose();
                return;
              }
              if (event.key !== 'Tab') return;
              const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
              if (items.length === 0) return;
              const first = items[0]!;
              const last = items[items.length - 1]!;
              const active = document.activeElement;
              if (!ref.current?.contains(active)) {
                event.preventDefault();
                first.focus();
              } else if (event.shiftKey && active === first) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && active === last) {
                event.preventDefault();
                first.focus();
              }
            }
          : undefined
      }
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="ib-dlg-in">{children}</div>
    </dialog>
  );
}

function CommandRow({ text }: { text: string }) {
  return (
    <div className="ib-cmd">
      <code>{text}</code>
      <CopyButton text={text} />
    </div>
  );
}

export interface UpdateDialogProps {
  details: UpdateDetails | null;
  update: Update;
  error: string | null;
  busy: boolean;
  onUpdateNow: () => void;
  onRemindTomorrow: () => void;
  onCancel: () => void;
  onWhatsNew: () => void;
  onAutoUpdate: (next: boolean) => void;
}

/** The open sessions the dialog names; the rest are counted. */
const SESSIONS_SHOWN = 5;

/** Available → press. Update now in the first step (the owner's answer 4). */
export function UpdateDialog({ details, update, error, busy, onUpdateNow, onRemindTomorrow, onCancel, onWhatsNew, onAutoUpdate }: UpdateDialogProps) {
  const released = releasedOn(details?.latest?.published_at ?? update.publishedAt);
  const managed = update.action === 'script';
  const auto = details?.auto_update;
  return (
    <Modal label={`Update to Plannotator ${update.version}`} onClose={onCancel} testId="update">
      <h2>Update to Plannotator {update.version}</h2>
      <p className="ib-sub">
        You have {update.current}
        {released ? ` · released ${released}` : ''}
      </p>
      {details?.summary && <p className="ib-sum">{details.summary}</p>}
      <button type="button" className="ib-lnk" onClick={onWhatsNew}>
        <Icon name="book" size={14} />
        What&apos;s new in {update.version}
      </button>
      {managed ? (
        <>
          <h3>What happens</h3>
          <ul className="ib-what">
            <li>
              <Icon name="restart" />
              <span>
                Runs the install script for v{update.version}
                {details && details.flags.length > 0 ? (
                  <>
                    {' '}with the choices from your last install: <code>{details.flags.join(' ')}</code>.
                  </>
                ) : (
                  '.'
                )}
              </span>
            </li>
            <li>
              <Icon name="doc" />
              <span>
                Open reviews keep running on {update.current} until you finish them; new ones open on {update.version}.
                {details && details.sessions.length > 0 && (
                  // The first few, then how many more: thirty open reviews never push Update now off the dialog (decision 7).
                  <ul className="ib-sess">
                    {details.sessions.slice(0, SESSIONS_SHOWN).map((s) => (
                      <li key={`${s.label}-${s.started_at}`}>
                        {s.project} · {s.mode === 'review' ? 'code review' : s.mode}, opened {whenTime(s.started_at)}
                      </li>
                    ))}
                    {details.sessions.length > SESSIONS_SHOWN && <li data-sessions-more="">and {formatCount(details.sessions.length - SESSIONS_SHOWN)} more</li>}
                  </ul>
                )}
              </span>
            </li>
            <li>
              <Icon name="inbox" />
              <span>The Inbox restarts when the update is in. Your picks, drafts and threads are saved.</span>
            </li>
          </ul>
        </>
      ) : (
        <>
          <h3>Update this copy yourself</h3>
          <p className="ib-sum" style={{ marginTop: 0 }}>
            This copy of Plannotator was not installed by the install script, so it can&apos;t update itself. Run:
          </p>
          {details && <CommandRow text={details.command} />}
        </>
      )}
      {details?.plugin_command ? (
        <>
          <h3>Updates separately</h3>
          <p className="ib-sum" style={{ margin: 0 }}>
            Claude Code plugin. In a terminal, then restart Claude Code:
          </p>
          <CommandRow text={details.plugin_command} />
        </>
      ) : (
        managed && (
          <p className="ib-sum ib-quietline">
            It also updates the Claude Code plugin when it is installed, and OpenCode&apos;s cached plugin: reload those agents
            afterwards (Settings, Agents says which). Pi: run <code>pi update --extensions</code>, then <code>/reload</code>.
          </p>
        )
      )}
      {managed && auto?.supported && (
        <label className="ib-opt">
          <input
            type="checkbox"
            checked={auto.on}
            disabled={auto.env !== null}
            onChange={(event) => onAutoUpdate(event.target.checked)}
            data-auto-update-checkbox=""
          />
          <span>
            Install new versions automatically
            <small>
              {auto.env !== null
                ? `PLANNOTATOR_AUTO_UPDATE is set in this Inbox's environment, so it is ${auto.env ? 'on' : 'off'}.`
                : 'At most once a day, never while another review is open. Change it in Settings.'}
            </small>
          </span>
        </label>
      )}
      {error && <div className="ib-error">{error}</div>}
      <div className="ib-acts-row">
        <button type="button" className="ib-btn ib-ghost ib-left" onClick={onRemindTomorrow}>
          Remind me tomorrow
        </button>
        <button type="button" className="ib-btn" onClick={onCancel}>
          Cancel
        </button>
        {managed && (
          <button type="button" className="ib-btn ib-pri" onClick={onUpdateNow} disabled={busy} data-update-now="">
            Update now
          </button>
        )}
      </div>
    </Modal>
  );
}

/** Ready → press with a reply in the box: say what a restart loses. */
export function RestartDialog({ update, subject, onRestart, onCancel }: { update: Update; subject: string; onRestart: () => void; onCancel: () => void }) {
  return (
    <Modal label="Restart the Inbox to finish updating?" onClose={onCancel} testId="restart">
      <h2>Restart the Inbox to finish updating?</h2>
      <p className="ib-sub">
        Plannotator {update.version} is installed. The Inbox is still running {update.current}.
      </p>
      <ul className="ib-what" style={{ marginTop: 14 }}>
        <li>
          <Icon name="info" />
          <span>The files pasted into your reply to “{subject}” are not saved and will be lost. Its words, picks and comments are kept as a draft.</span>
        </li>
      </ul>
      <div className="ib-acts-row">
        <button type="button" className="ib-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="ib-btn ib-pri" onClick={onRestart}>
          Restart Now
        </button>
      </div>
    </Modal>
  );
}

/** Failed → press: the plain reason, the log, Try Again. */
export function FailedDialog({
  update,
  details,
  home,
  onRetry,
  onClose,
}: {
  update: Update;
  details: UpdateDetails | null;
  home: string | null;
  onRetry: () => void;
  onClose: () => void;
}) {
  const code = details?.failure?.exit_code;
  return (
    <Modal label="The update didn't install" onClose={onClose} testId="failed">
      <h2>The update didn&apos;t install</h2>
      <p className="ib-sub">
        Plannotator is still {update.current}.{code !== undefined ? ` The install script exited with code ${code}.` : ''}
      </p>
      {details && (
        <>
          <p className="ib-sum">The log says what went wrong:</p>
          <CommandRow text={tildePath(details.log, home)} />
          <p className="ib-sum">Or run the install script yourself:</p>
          <CommandRow text={details.command} />
        </>
      )}
      <div className="ib-acts-row">
        <button type="button" className="ib-btn" onClick={onClose}>
          Close
        </button>
        <button type="button" className="ib-btn ib-pri" onClick={onRetry}>
          Try Again
        </button>
      </div>
    </Modal>
  );
}

// ───────────────────────────── What's new ─────────────────────────────

/** "October 15, 2026", from an ISO date. */
function releasedLong(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(date);
}

const STABLE = /^\d+\.\d+\.\d+$/;

/**
 * Where the person stands relative to the release the page shows (the
 * header's one chip): on it, on a development build, behind it (with the
 * releases in between, which the chip jumps to), or past it.
 */
export type WhatsNewStanding =
  | { kind: 'current' }
  | { kind: 'dev' }
  | { kind: 'behind'; current: string; between: number }
  | { kind: 'ahead'; current: string };

export function whatsNewStanding(model: Pick<WhatsNewModel, 'version' | 'current' | 'skipped'>): WhatsNewStanding {
  if (!STABLE.test(model.current)) return { kind: 'dev' };
  if (model.current === model.version) return { kind: 'current' };
  if (newerThan(model.version, model.current)) return { kind: 'behind', current: model.current, between: model.skipped.length };
  return { kind: 'ahead', current: model.current };
}

/** The page's Update: only for the release it shows, and only while that release can be installed today. */
export function whatsNewCanUpdate(model: Pick<WhatsNewModel, 'version'> | null, update: InboxHealth['update']): boolean {
  return !!model && !!update && update.version === model.version && (update.state === 'available' || update.state === 'ready');
}

const SKIPPED_ID = 'ib-wn-since';

function StandingChip({ standing, onJump }: { standing: WhatsNewStanding; onJump: () => void }) {
  switch (standing.kind) {
    case 'current':
      return (
        <span className="ib-wn-chip ib-good" data-whats-new-standing="current">
          <Icon name="check" />
          You&apos;re on this version
        </span>
      );
    case 'dev':
      return (
        <span className="ib-wn-chip" data-whats-new-standing="dev">
          Development build
        </span>
      );
    case 'ahead':
      return (
        <span className="ib-wn-chip" data-whats-new-standing="ahead">
          You have {standing.current}
        </span>
      );
    case 'behind':
      // Nothing listed in between (the notes name none): the version alone, with nowhere to jump.
      if (standing.between === 0) {
        return (
          <span className="ib-wn-chip" data-whats-new-standing="behind">
            You have {standing.current}
          </span>
        );
      }
      return (
        <button type="button" className="ib-wn-chip ib-lk" data-whats-new-standing="behind" aria-controls={SKIPPED_ID} onClick={onJump}>
          You have {standing.current} · {formatCount(standing.between)} {standing.between === 1 ? 'release' : 'releases'} in between
          <Icon name="arrowDown" />
        </button>
      );
  }
}

/**
 * The What's new page (design of record `.product/approved/inbox-whats-new-header/`,
 * variant Toolbar): a sticky bar with the way back on the left (`‹ Inbox |
 * What's new`) and the release link and Update on the right, then the
 * release itself under it, aligned to the notes: the version large, the date,
 * and one chip saying where the person stands.
 */
export function WhatsNewPage({
  model,
  error,
  update,
  onBack,
  onUpdate,
  onTakeTour,
}: {
  model: WhatsNewModel | null;
  error: string | null;
  update: InboxHealth['update'];
  onBack: () => void;
  onUpdate: () => void;
  /**
   * The quiet line under the notes (approval "inbox-onboarding-tour",
   * returning users: no dialog): "New: a 2-minute tour…". The window passes
   * it while the tour was never taken. Absent: no line.
   */
  onTakeTour?: () => void;
}) {
  const blocks = useMemo(() => parseMarkdownToBlocks(model?.notes ?? '', { frontmatter: false }), [model?.notes]);
  // The notes' images load from the copies the Inbox saved (never from GitHub:
  // the window's CSP allows only its own origin). One not saved is drawn as
  // its alt text in a quiet chip, never a broken image.
  const storedImages = useMemo(() => new Set(model?.images ?? []), [model?.images]);
  const modelVersion = model?.version;
  const resolveImage = useCallback(
    (src: string): ImageResolution | null => {
      if (/^(data|blob):/i.test(src)) return null;
      if (modelVersion && storedImages.has(src)) return { kind: 'src', src: whatsNewImageUrl(modelVersion, src) };
      return { kind: 'unavailable', title: 'This image is not saved on this computer. It is in the release on GitHub.' };
    },
    [modelVersion, storedImages],
  );
  const released = releasedLong(model?.published_at);
  const canUpdate = whatsNewCanUpdate(model, update);
  const standing = model ? whatsNewStanding(model) : null;
  const jumpToSkipped = () => {
    const section = document.getElementById(SKIPPED_ID);
    if (!section) return;
    if (section instanceof HTMLDetailsElement) section.open = true;
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    section.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    section.focus({ preventScroll: true });
  };
  return (
    <div className="ib-wn" aria-label="What's new" tabIndex={-1} data-whats-new-page={model?.version ?? ''}>
      <div className="ib-wn-bar">
        <SidebarTrigger />
        <button type="button" className="ib-pback" onClick={onBack} data-whats-new-back="">
          <Icon name="chevL" size={16} />
          <span className="ib-pback-l">Inbox</span>
        </button>
        <span className="ib-wn-div" aria-hidden="true" />
        <span className="ib-wn-title">What&apos;s new</span>
        <div className="ib-wn-acts">
          {model && (
            <a className="ib-wn-gh" href={model.release_url} target="_blank" rel="noopener noreferrer" data-whats-new-github="">
              <Icon name="github" />
              <span className="ib-wn-gh-l">GitHub</span>
              <span className="ib-sr"> release (opens in a new tab)</span>
            </a>
          )}
          {model && canUpdate && (
            <button type="button" className="ib-btn ib-pri" onClick={onUpdate} aria-label={`Update to ${model.version}`} data-whats-new-update="">
              <span>Update</span>
              {/* Dropped on the narrowest phones; the button's name keeps the version. */}
              <span className="ib-wn-to">to {model.version}</span>
            </button>
          )}
        </div>
      </div>
      <div className="ib-wn-in">
        <header className="ib-wn-hero">
          <p className="ib-wn-pre">What&apos;s new in Plannotator</p>
          <h1>{model?.version ?? '…'}</h1>
          {model && (
            <p className="ib-wn-line">
              {released && <span>Released {released}</span>}
              {standing && <StandingChip standing={standing} onJump={jumpToSkipped} />}
            </p>
          )}
        </header>
        {error && <div className="ib-error">{error}</div>}
        {model && model.notes ? (
          <div className="ib-body ib-wn-body">
            <ImageResolverContext.Provider value={resolveImage}>
            <Viewer
              blocks={blocks}
              markdown={model.notes}
              annotations={NO_ANNOTATIONS}
              onAddAnnotation={noop}
              onSelectAnnotation={noop}
              selectedAnnotationId={null}
              mode="selection"
              taterMode={false}
              maxWidth={null}
              stickyActions={false}
              disableCodePathValidation
              answerOnly
              readOnly
            />
            </ImageResolverContext.Provider>
          </div>
        ) : (
          model && <p className="ib-sum">The release has no notes. They are on GitHub.</p>
        )}
        {model && onTakeTour && (
          <p className="ib-wn-tour" data-whats-new-tour="">
            New: a 2-minute tour of how we built the Inbox with the Inbox.{' '}
            <button type="button" className="ib-lnk" onClick={onTakeTour}>
              Take the tour
            </button>
          </p>
        )}
        {/* The skipped releases come after this release's notes, folded when there are more than a few (decision 7). */}
        {model && model.skipped.length > 0 && <SkippedReleases since={model.since ?? model.current} skipped={model.skipped} />}
      </div>
    </div>
  );
}

/** More skipped releases than this are folded under their heading. */
const SKIPPED_SHOWN = 3;

function SkippedReleases({ since, skipped }: { since: string; skipped: WhatsNewModel['skipped'] }) {
  const items = (
    <ul>
      {skipped.map((h) => (
        <li key={h.version}>
          <b>{h.version}</b> {h.text.replace(/`/g, '')}
        </li>
      ))}
    </ul>
  );
  const heading = `Also in the releases since ${since}`;
  if (skipped.length <= SKIPPED_SHOWN) {
    return (
      <section className="ib-wn-skipped" id={SKIPPED_ID} tabIndex={-1} aria-label={heading} data-skipped-releases="">
        <h2>{heading}</h2>
        {items}
      </section>
    );
  }
  return (
    <details className="ib-wn-skipped" id={SKIPPED_ID} tabIndex={-1} data-skipped-releases="">
      <summary>
        <h2>
          {heading} <span className="ib-n">· {skipped.length}</span>
        </h2>
      </summary>
      {items}
    </details>
  );
}

// ──────────────────────── Checking for updates is failing ────────────────────────

/** "can't check for updates since 9:14 AM (GitHub API rate-limited)", from the server's failing record. */
export function checkFailingWords(failing: UpdateCheckFailing): string {
  const day = dayWords(failing.since);
  const when = day === 'today' ? clockTime(failing.since) : day === 'yesterday' ? `yesterday ${clockTime(failing.since)}` : day;
  return `can't check for updates since ${when} (${failing.error})`;
}

/**
 * The command that updates without the check (the install script finds the
 * newest release by itself), shown wherever checking is failing.
 */
export function CheckFailingCommand({ command }: { command: string }) {
  return (
    <div className="ib-chkfail" data-update-check-failing="">
      <span>The install script finds the newest release by itself. To update now, run:</span>
      <CommandRow text={command} />
    </div>
  );
}

/**
 * The sidebar's quiet row while checking for updates has failed for hours
 * and no Update button shows: "Can't check for updates", opening Settings →
 * About, which says why and gives the command. Never the error colour.
 */
export function CheckFailingRow({ failing, onOpen }: { failing: UpdateCheckFailing; onOpen: () => void }) {
  return (
    <button type="button" className="ib-nav ib-quiet ib-rw-restart" data-update-check-failing-row="" onClick={onOpen}>
      <Icon name="info" />
      <span className="ib-rw-label">Can&apos;t check for updates</span>
      <span className="ib-sr">. {checkFailingWords(failing).replace(/^./, (c) => c.toUpperCase())}. Opens Settings, About.</span>
    </button>
  );
}

/** "today 2:57 PM", "yesterday 2:57 PM", "Oct 3": when something happened. */
function whenWords(iso: string): string {
  const day = dayWords(iso);
  return day === 'today' || day === 'yesterday' ? `${day} ${clockTime(iso)}` : day;
}

/**
 * "Can't check for updates since 9:14 AM (…) · last tried 2:50 PM": the
 * failing line as Settings → General and About both show it.
 */
function checkFailingStatus(failing: UpdateCheckFailing, details: UpdateDetails | null): string {
  const tried = details?.check.last_attempt_at ? ` · last tried ${whenWords(details.check.last_attempt_at)}` : '';
  return `${checkFailingWords(failing).replace(/^./, (c) => c.toUpperCase())}${tried}`;
}

/** A successful check this recent backs "Up to date". */
export const UP_TO_DATE_FRESH_MS = 24 * 60 * 60 * 1000;

/**
 * What the last checks say, in words that claim nothing they cannot back:
 * "Up to date" only after a recent successful check with checks on; else
 * checks off, failing for hours (with when it last tried), the last check
 * failed, when it last checked, or not checked yet. `news`: an update is
 * known or in progress, so never "Up to date".
 */
export function checkStatusWords(details: UpdateDetails | null, news: boolean, now: number = Date.now()): string {
  if (!details) return '';
  const check = details.check;
  if (!check.on) return 'Update checks are off';
  if (check.failing) return checkFailingStatus(check.failing, details);
  if (check.last_failed_at) return `Last check failed ${whenWords(check.last_failed_at)}${check.error ? ` (${check.error})` : ''}`;
  const ok = details.latest?.fetched_at ?? null;
  const okAt = ok ? Date.parse(ok) : NaN;
  if (ok && Number.isFinite(okAt) && now - okAt < UP_TO_DATE_FRESH_MS && okAt - now < 60_000) {
    return news ? `Checked ${whenWords(ok)}` : `Up to date · checked ${whenWords(ok)}`;
  }
  if (ok) return `Last checked ${whenWords(ok)}`;
  return 'Not checked yet';
}

// ───────────────────────────── Settings → General ─────────────────────────────

/**
 * The first row of Settings → General (the owner, 2026-10-26: "the update
 * button to also show up in the general part of settings"): the version this
 * Inbox runs and the same action the sidebar's Update button offers, plus
 * Check now; the failing-check line with the install command when checking
 * fails. The page never renders it when opened over the tailnet.
 */
export function GeneralUpdateRow({
  version,
  details,
  update,
  restarting,
  checking,
  failing,
  onCheckNow,
  onUpdate,
  onWhatsNew,
}: {
  version: string;
  details: UpdateDetails | null;
  update: InboxHealth['update'];
  restarting: boolean;
  checking: boolean;
  failing: UpdateCheckFailing | null;
  onCheckNow: () => void;
  onUpdate: () => void;
  onWhatsNew: (version: string) => void;
}) {
  const known = details?.latest && newerThan(details.latest.version, version) ? details.latest.version : null;
  const busy = restarting || update?.state === 'updating';
  let status: ReactNode;
  if (version === 'dev') status = 'A development build';
  else if (restarting && update) status = `Restarting into ${update.version}…`;
  else if (update?.state === 'updating') status = `Installing ${update.version}…`;
  else if (update?.state === 'ready') status = `${update.version} is installed · restart to use it`;
  else if (update?.state === 'failed') status = `${update.version} didn't install`;
  else if (update?.state === 'available')
    status = (
      <>
        {update.version} is available ·{' '}
        <button type="button" className="ib-lnk" onClick={() => onWhatsNew(update.version)}>
          What&apos;s new
        </button>
      </>
    );
  else if (failing) status = checkFailingStatus(failing, details);
  // A newer release known but not offered (checks off, or Remind me tomorrow): never "Up to date".
  else status = [checkStatusWords(details, !!known), known && `${known} is available`].filter(Boolean).join(' · ');
  const label = restarting
    ? 'Restarting…'
    : update?.state === 'updating'
      ? 'Updating…'
      : update?.state === 'failed'
        ? 'Update failed…'
        : update
          ? `Update to ${update.version}`
          : null;
  return (
    <section className="ib-sgroup ib-sgroup-first" data-settings-update="" data-update-state={restarting ? 'restarting' : (update?.state ?? (failing ? 'check-failing' : 'none'))} aria-label="Plannotator version">
      <div className="ib-card">
        <div className="ib-prow">
          <span className="ib-tile">
            <Icon name="inbox" />
          </span>
          <span className="ib-txt">
            <span className="ib-l">Plannotator {version}</span>
            <span className="ib-desc" data-general-update-status="">
              {status}
            </span>
          </span>
          <span className="ib-ctl">
            {label && (
              <button
                type="button"
                className={`ib-btn ib-sm${update?.state === 'failed' ? '' : ' ib-pri'}`}
                onClick={onUpdate}
                disabled={busy}
                data-general-update=""
              >
                {busy && <span className="ib-spin" aria-hidden="true" />}
                {label}
              </button>
            )}
            {!busy && (
              <button type="button" className="ib-btn ib-sm" onClick={onCheckNow} disabled={checking || version === 'dev'} data-general-check="">
                {checking ? 'Checking…' : 'Check now'}
              </button>
            )}
          </span>
        </div>
      </div>
      {failing && !update && details && <CheckFailingCommand command={details.command} />}
    </section>
  );
}

// ───────────────────────────── Settings → About ─────────────────────────────

/**
 * Settings → About (design of record `.product/approved/inbox-settings-tabs/`):
 * the version with its status, Check now, Update now when a release is
 * available, the two update switches, and where things are on this computer.
 */
export function AboutBlock({
  version,
  details,
  switches,
  checking,
  error,
  onCheckNow,
  onToggle,
  update,
  onUpdate,
  onWhatsNew,
  where,
}: {
  version: string;
  details: UpdateDetails | null;
  switches: UpdateSwitches | undefined;
  checking: boolean;
  error: string | null;
  onCheckNow: () => void;
  onToggle: (change: { update_check?: boolean; auto_update?: boolean }) => void;
  /** The sidebar's update state: Update now while a release is available, ready or failed. */
  update?: InboxHealth['update'];
  onUpdate?: () => void;
  onWhatsNew?: (version: string) => void;
  /** "Where things are": the data folder and the MCP address and command. */
  where?: { data: string; mcpUrl: string; mcpCommand: string } | null;
}) {
  const latest = details?.latest;
  const failing = details?.check.failing ?? null;
  // What is happening with the version, beside what the checks say (checkStatusWords).
  let status = '';
  if (version === 'dev') status = 'a development build';
  else if (details?.update?.state === 'updating') status = `installing ${details.update.version}`;
  else if (details?.update?.state === 'ready') status = `${details.update.version} is installed; restart to use it`;
  else if (latest && newerThan(latest.version, version)) status = `${latest.version} is available`;
  const checked = version === 'dev' ? 'not checked' : checkStatusWords(details, status !== '');
  const checks = switches?.update_check;
  const auto = switches?.auto_update;
  const autoSupported = details?.auto_update.supported ?? false;
  const available = update?.version ?? (latest && newerThan(latest.version, version) ? latest.version : null);
  const updateLabel = update?.state === 'ready' ? 'Restart to update' : update?.state === 'failed' ? 'Update failed…' : 'Update now';
  const locked = (checks?.env !== null && checks?.env !== undefined) || (auto?.env !== null && auto?.env !== undefined);
  return (
    <>
      <section className="ib-sgroup ib-sgroup-first" data-settings-about="" aria-label="Version and updates">
        <div className="ib-card">
          <div className="ib-prow">
            <span className="ib-tile">
              <Icon name="inbox" />
            </span>
            <span className="ib-txt">
              <span className="ib-l">
                Plannotator {version}
                {available && update?.state !== 'updating' && <span className="ib-chip ib-chip-pri">{available} is available</span>}
              </span>
              <span className="ib-desc" data-update-status="">
                {[checked, status]
                  .filter(Boolean)
                  .join(' · ')
                  .replace(/^./, (first) => first.toUpperCase())}
                {available && onWhatsNew && (
                  <>
                    {' · '}
                    <button type="button" className="ib-lnk" onClick={() => onWhatsNew(available)}>
                      What&apos;s new in {available}
                    </button>
                  </>
                )}
              </span>
            </span>
            <span className="ib-ctl">
              {update && onUpdate && (
                <button type="button" className="ib-btn ib-sm ib-pri" onClick={onUpdate} disabled={update.state === 'updating'} data-about-update="">
                  {update.state === 'updating' ? 'Updating…' : updateLabel}
                </button>
              )}
              <button type="button" className="ib-btn ib-sm" onClick={onCheckNow} disabled={checking || version === 'dev'}>
                {checking ? 'Checking…' : 'Check now'}
              </button>
            </span>
          </div>
          <div className="ib-prow">
            <span className="ib-txt">
              <span className="ib-l" id="ib-upd-check">
                Tell me when a new version is out
              </span>
              <span className="ib-desc">Every few minutes, from this computer</span>
            </span>
            <span className="ib-ctl">
              <button
                type="button"
                role="switch"
                className="ib-sw"
                aria-checked={checks?.on ?? true}
                aria-labelledby="ib-upd-check"
                disabled={!checks || checks.env !== null}
                onClick={() => onToggle({ update_check: !(checks?.on ?? true) })}
              />
            </span>
          </div>
          <div className="ib-prow">
            <span className="ib-txt">
              <span className="ib-l" id="ib-upd-auto">
                Keep Plannotator up to date
              </span>
              <span className="ib-desc">
                {!autoSupported ? 'Only for the binary the install script manages' : checks && !checks.on ? 'Needs update checks' : 'Installs new versions automatically'}
              </span>
            </span>
            <span className="ib-ctl">
              <button
                type="button"
                role="switch"
                className="ib-sw"
                aria-checked={auto?.on ?? false}
                aria-labelledby="ib-upd-auto"
                disabled={!auto || auto.env !== null || !autoSupported || (checks !== undefined && !checks.on)}
                onClick={() => onToggle({ auto_update: !(auto?.on ?? false) })}
              />
            </span>
          </div>
        </div>
        <div className="ib-note">
          <Icon name="info" />
          {locked
            ? checks?.env !== null && checks?.env !== undefined
              ? `PLANNOTATOR_UPDATE_CHECK is set in this Inbox's environment, so update checks are ${checks.env ? 'on' : 'off'}.`
              : `PLANNOTATOR_AUTO_UPDATE is set in this Inbox's environment, so automatic updates are ${auto?.env ? 'on' : 'off'}.`
            : 'Off makes no request to GitHub at all. Check now always asks.'}
        </div>
        {failing && details && <CheckFailingCommand command={details.command} />}
        {error && <div className="ib-error">{error}</div>}
      </section>
      {where && (
        <section className="ib-sgroup" aria-labelledby="ib-g-where">
          <h2 id="ib-g-where">Where things are</h2>
          <div className="ib-card">
            <div className="ib-prow">
              <span className="ib-txt">
                <span className="ib-l">Data</span>
                <span className="ib-desc">
                  <code>{where.data}</code>
                </span>
              </span>
            </div>
            <div className="ib-prow">
              <span className="ib-txt">
                <span className="ib-l">MCP for other agents</span>
                <span className="ib-desc">
                  <code>{where.mcpUrl}</code> · or the command <code>{where.mcpCommand}</code>
                </span>
              </span>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
