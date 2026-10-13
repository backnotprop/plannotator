/**
 * The Inbox's update control (design of record:
 * .product/approved/plannotator-updates/, Workspaces' rules): one full-width
 * filled button above Settings, no motion, never a percentage, never the
 * error colour; the update dialog with Update now in the first step; the
 * restart and failure dialogs; the What's new page; Settings → About.
 */

import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Viewer } from '@plannotator/ui/components/Viewer';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import type { InboxHealth } from '@plannotator/core/inbox-types';
import type { UpdateDetails, UpdateSwitches, WhatsNewModel } from '../api';
import { clockTime, dayWords, tildePath } from '../format';
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
  const label = restarting ? 'Restarting…' : LABEL[update.state];
  const tip = tipFor(update, restarting);
  const aria =
    update.state === 'failed' ? `Update failed: Plannotator ${update.version} didn't install` : busy ? label : `Update to Plannotator ${update.version}`;
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
        {label}
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
                  <ul className="ib-sess">
                    {details.sessions.map((s) => (
                      <li key={`${s.label}-${s.started_at}`}>
                        {s.project} · {s.mode === 'review' ? 'code review' : s.mode}, opened {clockTime(s.started_at)}
                      </li>
                    ))}
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
            It also updates the Claude Code plugin when it is installed, and OpenCode&apos;s cached plugin: restart those agents
            afterwards. Pi: run <code>pi update --extensions</code>.
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
          <span>Your reply to “{subject}” is not sent and will be lost. Picks and comments are saved.</span>
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

export function WhatsNewPage({
  model,
  error,
  update,
  onBack,
  onUpdate,
}: {
  model: WhatsNewModel | null;
  error: string | null;
  update: InboxHealth['update'];
  onBack: () => void;
  onUpdate: () => void;
}) {
  const blocks = useMemo(() => parseMarkdownToBlocks(model?.notes ?? '', { frontmatter: false }), [model?.notes]);
  const released = releasedOn(model?.published_at);
  const canUpdate = !!model && !!update && update.version === model.version && (update.state === 'available' || update.state === 'ready');
  return (
    <div className="ib-wn" aria-label="What's new" tabIndex={-1} data-whats-new-page={model?.version ?? ''}>
      <div className="ib-wn-in">
        <div className="ib-wn-head">
          <SidebarTrigger />
          <div>
            <h1>What&apos;s new in {model?.version ?? '…'}</h1>
            {model && (
              <div className="ib-meta">
                {released ? `Released ${released} · ` : ''}You have {model.current}
              </div>
            )}
          </div>
          <div className="ib-acts">
            <button type="button" className="ib-btn ib-ghost" onClick={onBack}>
              <Icon name="back" />
              Inbox
            </button>
            {model && (
              <a className="ib-btn" href={model.release_url} target="_blank" rel="noopener noreferrer">
                <Icon name="external" />
                View on GitHub
              </a>
            )}
            {canUpdate && (
              <button type="button" className="ib-btn ib-pri" onClick={onUpdate}>
                Update
              </button>
            )}
          </div>
        </div>
        {error && <div className="ib-error">{error}</div>}
        {model && model.skipped.length > 0 && (
          <div className="ib-wn-skipped">
            <h2>Also in the releases since {model.current}</h2>
            <ul>
              {model.skipped.map((h) => (
                <li key={h.version}>
                  <b>{h.version}</b> {h.text.replace(/`/g, '')}
                </li>
              ))}
            </ul>
          </div>
        )}
        {model && model.notes ? (
          <div className="ib-body ib-wn-body">
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
          </div>
        ) : (
          model && <p className="ib-sum">The release has no notes. They are on GitHub.</p>
        )}
      </div>
    </div>
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
  const last = details?.check.last_attempt_at;
  let status = '';
  if (version === 'dev') status = 'a development build';
  else if (details?.check.error) status = `the last check failed: ${details.check.error}`;
  else if (details?.update?.state === 'updating') status = `installing ${details.update.version}`;
  else if (details?.update?.state === 'ready') status = `${details.update.version} is installed; restart to use it`;
  else if (latest && newerThan(latest.version, version)) status = `${latest.version} is available`;
  else if (last) status = 'up to date';
  const day = last ? dayWords(last) : '';
  const checked = !last ? 'not checked yet' : day === 'today' || day === 'yesterday' ? `checked ${day} ${clockTime(last)}` : `checked ${day}`;
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
              <span className="ib-desc">Once a day, from this computer</span>
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
