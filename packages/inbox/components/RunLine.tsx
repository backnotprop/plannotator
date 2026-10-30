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
 * one bordered button is Open in Terminal, where something is blocked on the
 * person (a permission prompt, an untrusted folder). No keyboard shortcuts.
 */
/** `canReaddress`: the waiting message can go to another session (Send to another session is shown under the line). */
export function RunLine({ run, phone, canReaddress = false, onChanged }: { run: InboxRun; phone: boolean; canReaddress?: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState<null | 'stop' | 'open' | 'retry'>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const ticking = run.state === 'working' || run.state === 'waiting_answer' || run.state === 'waiting_terminal';
  const now = useMinuteClock(ticking);
  const name = hostLabel(run.agent);
  const minutes = ticking ? minutesSince(run.since, now) : null;

  const act = async (what: 'stop' | 'open' | 'retry') => {
    setBusy(what);
    setError(null);
    try {
      if (what === 'stop') await inboxApi.launchStop(run.launch_id);
      else if (what === 'retry') await inboxApi.launchRetry(run.launch_id);
      else await inboxApi.launchOpen(run.launch_id);
      if (what !== 'open') onChanged();
    } catch (cause) {
      setError(cause instanceof InboxApiError ? cause.message : what === 'open' ? 'Terminal did not open; copy the command instead.' : 'That did not work; try again.');
    } finally {
      setBusy(null);
    }
  };
  const copy = async () => {
    if (!run.attach_command) return;
    const ok = await copyTextToClipboard(run.attach_command);
    setCopied(ok);
    if (ok) setTimeout(() => setCopied(false), 1500);
    else setError('Could not copy; select the command and copy it.');
  };

  const stop = (
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
  switch (run.state) {
    case 'starting':
      text = run.again ? `Starting ${name} again…` : (
        <>
          Starting {name} in <bdi>{run.project}</bdi>…
        </>
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
          {phone ? <span className="ib-run-sub">Answer it in Terminal on your Mac:</span> : null}
        </>
      );
      actions = (
        <>
          {!phone && openTerminal}
          {attach}
          {stop}
        </>
      );
      break;
    case 'stopped':
      icon = 'stop';
      text = run.stopped_by_person && run.since ? `You stopped ${name} at ${whenTime(run.since)}. Your reply starts it again.` : `${name} stopped. Your reply starts it again.`;
      break;
    case 'failed':
      icon = 'warn';
      text = (
        <>
          <b>{name} didn't start.</b> {run.cause ?? ''} Your message is kept.
        </>
      );
      actions = (
        <>
          {run.untrusted && !phone && openTerminal}
          <button type="button" className="ib-btn ib-sm" disabled={busy !== null} onClick={() => void act('retry')} data-run-retry="">
            Try again
          </button>
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
        <span className="ib-run-text" role={run.state === 'failed' || run.state === 'waiting_terminal' ? 'status' : undefined}>
          {text}
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
