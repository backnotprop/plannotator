import { useState } from 'react';
import type { InboxRun } from '@plannotator/core/inbox-types';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { InboxApiError, inboxApi } from '../api';
import { whenTime } from '../format';
import { Icon } from '../icons';
import { hostLabel } from '../compose/model';
import { Tip } from './Tip';
import { useMinuteClock } from './Undelivered';

/** "4 min" since `since`; nothing under a minute (never "1 min" a few seconds in). */
function minutesSince(since: string | null, now: number): string | null {
  if (!since) return null;
  const min = Math.floor((now - Date.parse(since)) / 60_000);
  return min >= 1 ? `${min} min` : null;
}

/** `claude attach 4f1c9a2e` on screen; the command copied also changes into the folder first. */
const shownCommand = (command: string) => command.replace(/^cd .*? && /, '');

const STOP_TIP = 'Stops the session. Commands it started in the background keep running.';

/**
 * A launched thread's run line (UX screens 05, 06, 08, 09, 11, 12, 14, 15): one
 * quiet line under the latest message, in place of the delivery line, saying
 * what the agent the person started is doing. It goes away while the agent
 * rests (`run` null: the thread draws nothing). Stop is a text button; the
 * bordered buttons are where something is blocked on the person: Open in
 * Terminal (a session waiting on Terminal, one that can't start; it is on no
 * menu, so it shows only then), and for an untrusted folder the owner's Trust
 * folder, which also works on a phone. No keyboard shortcuts.
 */
/**
 * `canOpen`: this window can open Terminal on this launch (the thread's rule: on the Inbox's computer, with
 * a session or a folder to trust). `canReaddress`: the waiting message can go to another session (Send to
 * another session is shown under the line). `guest`: a tailnet guest's page
 * (`tailnetGuest`), which gets no Stop or Try again (the server answers both `owner_only`), and whose stopped line
 * never says a reply starts it again.
 */
/**
 * `machine`: another machine's thread (remote launch): Stop, Try again and Trust folder go to that machine;
 * `machineName` names it in a clone's words ("Mac mini isn't signed in to github.com"). `onChangeUrl`: a clone no repo
 * answered (E5) offers Change the URL, which reopens New message with the URL in the filter.
 *
 * Clone from a git URL (approval "launch-create-clone", E1-E11): "Cloning acme/billing-api · Claude Code starts next"
 * with Cancel, git's percent and a thin bar after a few seconds; a failed clone says why (sign-in, no such repo,
 * network) and keeps the message, with Try again (and Copy clone command, or Change the URL); a cancelled one says
 * nothing was kept; a repo that brings hooks, MCP servers or settings waits for Trust and start.
 */
export function RunLine({
  run,
  canOpen,
  canReaddress = false,
  guest = false,
  machine = null,
  machineName = null,
  onChanged,
  onChangeUrl,
}: {
  run: InboxRun;
  canOpen: boolean;
  canReaddress?: boolean;
  guest?: boolean;
  machine?: string | null;
  machineName?: string | null;
  onChanged: () => void;
  onChangeUrl?: (url: string) => void;
}) {
  const [busy, setBusy] = useState<null | 'stop' | 'open' | 'retry' | 'trust'>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [cloneCopied, setCloneCopied] = useState(false);
  const [whatsIn, setWhatsIn] = useState(false);
  const clone = run.clone ?? null;
  // The machine in a clone's words: its name, else this computer (a sentence's first word takes a capital).
  const where = machineName ?? 'this computer';
  const Where = machineName ?? 'This computer';
  const ticking = run.state === 'working' || run.state === 'waiting_answer' || run.state === 'waiting_terminal';
  const now = useMinuteClock(ticking);
  const name = hostLabel(run.agent);
  const minutes = ticking ? minutesSince(run.since, now) : null;

  const act = async (what: 'stop' | 'open' | 'retry' | 'trust') => {
    setBusy(what);
    setError(null);
    try {
      if (what === 'stop') await inboxApi.launchStop(run.launch_id, machine);
      else if (what === 'retry') await inboxApi.launchRetry(run.launch_id, machine);
      else if (what === 'trust') await inboxApi.launchTrust(run.launch_id, run.trust?.warning ?? null, machine);
      else await inboxApi.launchOpen(run.launch_id);
      onChanged();
    } catch (cause) {
      setError(cause instanceof InboxApiError ? cause.message : what === 'open' ? 'Terminal did not open; copy the command instead.' : 'That did not work; try again.');
      // The folder changed since this line was read: draw the new warning for the next click.
      if (cause instanceof InboxApiError && cause.code === 'trust_warning_changed') onChanged();
    } finally {
      setBusy(null);
    }
  };
  /** E4: the clone as one command, to run by hand on that machine (git's own sign-in prompts work there). */
  const copyClone = async () => {
    if (!clone) return;
    const ok = await copyTextToClipboard(cloneCommand(clone));
    setCloneCopied(ok);
    if (ok) setTimeout(() => setCloneCopied(false), 1500);
    else setError('Could not copy; select the command and copy it.');
  };
  const copy = async () => {
    if (!run.attach_command) return;
    const ok = await copyTextToClipboard(run.attach_command);
    setCopied(ok);
    if (ok) setTimeout(() => setCopied(false), 1500);
    else setError('Could not copy; select the command and copy it.');
  };

  const stop = guest ? null : (
    <Tip content={STOP_TIP}>
      <button type="button" className="ib-run-btn" disabled={busy !== null} onClick={() => void act('stop')} data-run-stop="">
        Stop
      </button>
    </Tip>
  );
  const openTerminal = (
    <button type="button" className="ib-btn ib-sm" disabled={busy !== null} onClick={() => void act('open')} data-run-open="">
      <Icon name="terminal" size={14} />
      Open in Terminal
    </button>
  );
  const attach = run.attach_command && (
    <span className="ib-run-cmd" data-run-attach="">
      <code>{shownCommand(run.attach_command)}</code>
      <button type="button" className="ib-run-btn" onClick={() => void copy()} aria-label={`Copy ${shownCommand(run.attach_command)}`}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );

  let icon: 'spin' | 'warn' | 'stop' = 'spin';
  let text: React.ReactNode;
  let actions: React.ReactNode = null;
  const retry = (words: string) =>
    !guest && (
      <button type="button" className="ib-btn ib-sm" disabled={busy !== null} onClick={() => void act('retry')} data-run-retry="">
        {words}
      </button>
    );
  const kept = 'Your message is kept.';
  let bar: number | null = null;
  switch (run.state) {
    case 'starting':
      text = run.again ? `Starting ${name} again…` : (
        <>
          Starting {name} in <bdi>{run.project}</bdi>…
          {/* E11: the name was taken between the pick and the clone. */}
          {clone?.renamed_from && clone.folder_shown ? (
            <span className="ib-run-sub" data-run-clone-renamed="">
              Cloned into {clone.folder_shown}: {lastName(clone.renamed_from)} was taken by then.
            </span>
          ) : null}
        </>
      );
      break;
    case 'cloning':
      // E1, E2.
      text = (
        <>
          Cloning {clone?.slug ?? run.project}
          {clone?.pct != null ? ` · ${clone.pct}%` : ''} · {name} starts next
        </>
      );
      bar = clone?.pct ?? null;
      actions = guest ? null : (
        <button type="button" className="ib-run-btn" disabled={busy !== null} onClick={() => void act('stop')} data-run-clone-cancel="">
          Cancel
        </button>
      );
      break;
    case 'clone_failed': {
      icon = 'warn';
      const slug = clone?.slug ?? run.project;
      const host = clone?.host ?? '';
      const copyCommand = clone && (
        <button type="button" className="ib-btn ib-sm" onClick={() => void copyClone()} data-run-clone-copy="">
          {cloneCopied ? 'Copied' : 'Copy clone command'}
        </button>
      );
      if (clone?.error === 'auth') {
        // E4.
        text = (
          <>
            <b>Couldn't clone {slug}.</b> {Where} isn't signed in to {host}. {kept}
            <span className="ib-run-sub">
              Sign in to {host} on {where}, then try again.
            </span>
          </>
        );
        actions = (
          <>
            {retry('Try again')}
            {copyCommand}
          </>
        );
      } else if (clone?.error === 'not_found') {
        // E5.
        text = (
          <>
            <b>Couldn't clone {slug}.</b> {host} has no such repo, or {where} can't see it. {kept}
          </>
        );
        actions = (
          <>
            {onChangeUrl && clone && !guest && (
              <button type="button" className="ib-btn ib-sm" onClick={() => onChangeUrl(clone.url)} data-run-clone-change="">
                Change the URL
              </button>
            )}
            {retry('Try again')}
          </>
        );
      } else if (clone?.error === 'network') {
        // E6.
        text = (
          <>
            <b>
              Couldn't reach {host} from {where}.
            </b>{' '}
            {kept}
          </>
        );
        actions = retry('Try again');
      } else {
        // git failed another way (or the Inbox closed during the clone): its own words, and the command to run by hand.
        text = (
          <>
            <b>Couldn't clone {slug}.</b> {clone?.error_text ? `${clone.error_text.trim().split('\n').at(-1)} ` : ''}
            {kept}
          </>
        );
        actions = (
          <>
            {retry('Try again')}
            {copyCommand}
          </>
        );
      }
      break;
    }
    case 'clone_cancelled':
      // E7.
      icon = 'stop';
      text = guest ? `The clone was cancelled. Nothing was kept on ${where}.` : `You cancelled the clone. Nothing was kept on ${where}. Your reply starts it again.`;
      actions = guest ? null : (
        <button type="button" className="ib-run-btn" disabled={busy !== null} onClick={() => void act('retry')} data-run-retry="">
          Clone again
        </button>
      );
      break;
    case 'working':
      text = (
        <>
          {name} is working{minutes ? ` · ${minutes}` : ''}
        </>
      );
      actions = stop;
      break;
    case 'waiting_answer':
      // A permission prompt asked above, as a question card (screen 09): answering it is the action.
      text = (
        <>
          {name} is waiting on your answer{minutes ? ` · ${minutes}` : ''}
        </>
      );
      actions = stop;
      break;
    case 'waiting_terminal':
      icon = 'warn';
      text = (
        <>
          <b>{name} is waiting on a permission prompt</b>
          {minutes ? ` · ${minutes}` : ''}
          {canOpen ? null : <span className="ib-run-sub">Answer it in Terminal on your Mac:</span>}
        </>
      );
      actions = (
        <>
          {canOpen && openTerminal}
          {attach}
          {stop}
        </>
      );
      break;
    case 'stopped':
      icon = 'stop';
      // `cause`: the host's words for a stop that was not the person's (`LaunchHost.stoppedNote`). A guest's reply never
      // starts it again (the server's rule), and the Stop was never theirs.
      text = guest
        ? `${name} stopped. Your reply waits for it.`
        : run.stopped_by_person && run.since
          ? `You stopped ${name} at ${whenTime(run.since)}. Your reply starts it again.`
          : run.cause
            ? `${name} stopped. ${run.cause}`
            : `${name} stopped. Your reply starts it again.`;
      break;
    case 'failed':
      icon = 'warn';
      // E10: a cloned repo that brings hooks, MCP servers or settings starts once the person trusts it (decision 4a).
      if (clone?.brings && clone.brings.length > 0 && run.untrusted && run.trust) {
        text = (
          <>
            <b>
              <bdi>{run.project}</bdi> has its own {bringsWords(clone.brings)}.
            </b>{' '}
            {name} starts once you trust the folder.
            {whatsIn && run.trust.warning ? (
              <span className="ib-run-sub" data-run-trust-warning="">
                {run.trust.warning}
              </span>
            ) : null}
          </>
        );
        actions = (
          <>
            <button type="button" className="ib-btn ib-sm" disabled={busy !== null} onClick={() => void act('trust')} data-run-trust="">
              Trust and start
            </button>
            {run.trust.warning && (
              <button type="button" className="ib-btn ib-sm" aria-expanded={whatsIn} onClick={() => setWhatsIn((open) => !open)} data-run-whats-in="">
                What's in it
              </button>
            )}
          </>
        );
        break;
      }
      text = (
        <>
          <b>{name} didn't start.</b> {run.cause ?? ''} Your message is kept.
          {/* Create a folder (E8): the folder the Send made is not taken away when the agent doesn't start. */}
          {run.made_folder ? (
            <span className="ib-run-sub" data-run-made-folder="">
              {run.made_folder} was made and stays.
            </span>
          ) : null}
          {run.trust?.warning ? (
            <span className="ib-run-sub" data-run-trust-warning="">
              {run.trust.warning}
            </span>
          ) : null}
          {run.untrusted && !run.trust ? (
            <span className="ib-run-sub" data-run-trust-howto="">
              {run.trust_covers_home ? (
                "This folder can't be trusted because trust would cover your home folder. Start in a project folder with its own git repo."
              ) : run.home_folder ? (
                "Your home folder can't be trusted. Start in a folder inside it."
              ) : (
                <>To trust it, run {name} here in a terminal on the Inbox's computer.</>
              )}
            </span>
          ) : null}
        </>
      );
      actions = (
        <>
          {run.trust && (
            <button type="button" className="ib-btn ib-sm" disabled={busy !== null} onClick={() => void act('trust')} data-run-trust="">
              Trust folder
            </button>
          )}
          {canOpen && openTerminal}
          {!guest && (
            <button type="button" className="ib-btn ib-sm" disabled={busy !== null} onClick={() => void act('retry')} data-run-retry="">
              Try again
            </button>
          )}
        </>
      );
      break;
    case 'missing':
      icon = 'warn';
      text = (
        <>
          <b>{name} isn't on this computer any more.</b> Your reply is waiting. Install {name} again and it goes in{canReaddress ? ', or send the reply to another session.' : '.'}
        </>
      );
      break;
  }

  return (
    <div className="ib-run" data-run={run.state} data-run-again={run.again ? '' : undefined} tabIndex={-1}>
      <span className="ib-run-main">
        {icon === 'spin' ? <span className="ib-run-spin" aria-hidden="true" /> : icon === 'warn' ? <Icon name="warn" size={14} /> : <span className="ib-run-stopmark" aria-hidden="true" />}
        <span className="ib-run-text" role={run.state === 'failed' || run.state === 'waiting_terminal' || run.state === 'clone_failed' ? 'status' : undefined}>
          {text}
          {bar !== null && (
            <span className="ib-run-bar" aria-hidden="true" data-run-clone-bar="">
              <i style={{ width: `${bar}%` }} />
            </span>
          )}
        </span>
      </span>
      {actions && <span className="ib-run-acts">{actions}</span>}
      {error && (
        <p className="ib-error" role="alert" data-run-error="">
          {error}
        </p>
      )}
    </div>
  );
}

/** "hooks and MCP servers", "hooks, MCP servers and settings": what a cloned repo brings (E10). */
function bringsWords(brings: readonly string[]): string {
  if (brings.length <= 1) return brings[0] ?? '';
  return `${brings.slice(0, -1).join(', ')} and ${brings.at(-1)}`;
}

/** A path's last folder. */
const lastName = (path: string) => path.replace(/\/+$/, '').split('/').pop() ?? path;

/** E4's Copy clone command: the URL as git takes it, its branch, and the folder it was going to. */
export function cloneCommand(clone: { url: string; branch: string | null; folder_shown: string | null }): string {
  const quote = (text: string) => (/^[A-Za-z0-9_./:@~+-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`);
  // `~/` stays outside the quotes, so the shell still reads it as home.
  const folder = (path: string) => (path.startsWith('~/') ? `~/${quote(path.slice(2))}` : quote(path));
  return ['git clone', ...(clone.branch ? ['--branch', quote(clone.branch)] : []), quote(clone.url), ...(clone.folder_shown ? [folder(clone.folder_shown)] : [])].join(' ');
}
