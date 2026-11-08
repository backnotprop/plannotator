/**
 * Update on a linked machine (approval "inbox-machine-update"): the word beside it and its little dialog. That machine
 * is the truth: the row and the dialog read its own state, so a restart of this Inbox loses nothing.
 */

import { useEffect, useRef, useState } from 'react';
import { INBOX_HOST_NAMES } from '@plannotator/core/inbox-types';
import { inboxApi, InboxApiError, InboxHeldError, type ComposeSessionsModel, type MachineUpdateDetails, type MachineView } from '../api';
import { COMPOSE_SESSIONS_REFRESH_MS } from '../compose/useComposeSessions';
import { Icon } from '../icons';
import { machineNotice, type MachineNotice } from '../machines';
import { newUuid } from '../uuid';
import { CopyButton } from './ConnectPicker';
import { FailedDialog, Modal } from './Updates';
import { Tip } from './Tip';

/** Older machines can only update at the machine, once. The same line for a person and for a shell that skips their PATH. */
export const UPDATE_BY_HAND = 'plannotator update && plannotator inbox restart';
export const UPDATE_BY_HAND_FULL_PATH = '~/.local/bin/plannotator update && ~/.local/bin/plannotator inbox restart';
/** Windows PowerShell 5.1 refuses `&&`, and the full path above does not exist there. Shown to everyone: an older machine does not say what it runs on. */
export const UPDATE_BY_HAND_POWERSHELL = 'plannotator update; plannotator inbox restart';

/**
 * What an agent on an older machine receives from "Ask an agent on <machine> to update it" (the owner's call,
 * 2026-11-08), sent as the person's own New message. Agent-facing: change it only with the owner's OK of the words and
 * a clean-room run (a fresh agent given only this, a fake `plannotator`). The update goes first and the restart only
 * after it: an Inbox restart started from inside the session drops the agent's Inbox calls for a few seconds, so it is
 * the last command, and the reply waits for the Inbox to be back.
 */
export const ASK_AGENT_TO_UPDATE = [
  'Please update Plannotator on this machine. Run these two commands, one at a time, in this order:',
  '',
  '1. `plannotator update`',
  '2. `plannotator inbox restart`',
  '',
  'Run step 2 only if step 1 succeeds ("already up to date" counts as success). If `plannotator` is not found, use the full path `~/.local/bin/plannotator` (on Windows, `$env:LOCALAPPDATA\\plannotator\\plannotator.exe`).',
  '',
  'The restart stops the Inbox for a few seconds. If your reply fails right after it, wait a few seconds and try again.',
  '',
  "Don't change anything else, and don't try to fix an error. Reply here when it's done, with the version the restart printed, or with the error.",
].join('\n');
/** The thread the ask starts. */
export const ASK_AGENT_TO_UPDATE_THREAD = 'Update Plannotator';

/** Puts a version back with the install scripts' own version flag, for a machine whose new version does not start. */
export function putBackCommands(version: string): { sh: string; ps: string } {
  return {
    sh: `curl -fsSL https://plannotator.ai/install.sh | bash -s -- --version v${version}`,
    ps: `& ([scriptblock]::Create((irm https://plannotator.ai/install.ps1))) -Version v${version}`,
  };
}

/** The word in the sidebar, beside the machine: its own target, while the row still filters. */
export function MachineSidebarWord({ notice, name, onPress }: { notice: MachineNotice; name: string; onPress: () => void }) {
  const mark = notice.busy ? (
    <span className="ib-spin" aria-hidden="true" />
  ) : notice.kind === 'updated' ? (
    <Icon name="check" size={13} />
  ) : notice.kind === 'failed' || notice.kind === 'not_back' ? (
    <Icon name="info" size={13} />
  ) : null;
  return (
    <Tip content={notice.tip} side="right">
      <button
        type="button"
        className="ib-mthing"
        data-kind={notice.kind}
        aria-label={`${name}: ${notice.tip}`}
        onClick={(event) => {
          event.stopPropagation();
          onPress();
        }}
      >
        {mark}
        <span>{notice.word}</span>
      </button>
    </Tip>
  );
}

/** The button on a machine's row in Settings → Machines. */
export function MachineUpdateButton({ machine, onPress }: { machine: MachineView; onPress: () => void }) {
  const notice = machineNotice(machine);
  if (!notice) return null;
  if (notice.kind === 'updated') {
    return (
      <span className="ib-paired ib-mdone" data-machine-update-done="">
        <Icon name="check" size={13} /> Updated
      </span>
    );
  }
  const word = notice.kind === 'failed' ? 'See why' : notice.kind === 'not_back' ? 'What now' : notice.kind === 'too_old' && machine.update?.asked ? 'Asked' : notice.kind === 'too_old' || notice.kind === 'by_hand' ? 'How to update' : notice.word;
  return (
    <button type="button" className={`ib-btn${notice.kind === 'update' || notice.kind === 'ready' ? ' ib-pri' : ''}`} onClick={onPress} data-machine-update={notice.kind}>
      {notice.busy && <span className="ib-spin" aria-hidden="true" />}
      {word}
      {notice.busy ? '…' : ''}
    </button>
  );
}

function Command({ text }: { text: string }) {
  return (
    <div className="ib-cmd">
      <code>{text}</code>
      <CopyButton text={text} />
    </div>
  );
}

/** What Snooze says when it opened this dialog. */
const SnoozeLine = ({ name }: { name: string }) => <p className="ib-sum">Snooze needs a newer Plannotator on {name}.</p>;

/** A live agent on that machine, as its own Inbox lists it (`GET sessions` through the forward). */
interface ThereAgent {
  host: string;
  session: string;
  name: string;
  project: string;
}

/** The agent to ask: one that is idle before one that is busy (it reads the message sooner), then the most recently seen. */
export function agentToAsk(model: Partial<ComposeSessionsModel> | null): ThereAgent | null {
  const all = (Array.isArray(model?.projects) ? model.projects : []).flatMap((group) =>
    (Array.isArray(group?.sessions) ? group.sessions : []).map((session) => ({ session, project: group.project?.name ?? '' })),
  );
  const rank = (busy: boolean | null | undefined) => (busy === false ? 0 : busy === true ? 2 : 1);
  const best = [...all].sort((a, b) => rank(a.session.busy) - rank(b.session.busy) || String(b.session.last_seen_at ?? '').localeCompare(String(a.session.last_seen_at ?? '')))[0];
  return best ? { host: best.session.host, session: best.session.session, name: INBOX_HOST_NAMES[best.session.host] ?? 'An agent', project: best.project } : null;
}

/**
 * "Ask an agent on <machine> to update it" (the owner's call, 2026-11-08), for an older machine that takes no update
 * from here. The same New message compose sends to a live session on a linked machine (the forward and its outbox), with
 * `ASK_AGENT_TO_UPDATE`; then this Inbox remembers the ask, so the row says Asked, Restarting, Updated.
 */
function useAskThere(machine: MachineView, active: boolean) {
  const online = machine.state === 'online';
  // undefined: not read yet; null: read, and no agent runs there.
  const [agent, setAgent] = useState<ThereAgent | null | undefined>(undefined);
  const [readFailed, setReadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ thread: string | null; agent: string } | null>(null);
  const [readAgain, setReadAgain] = useState(0);
  // One key per ask, so a retry after a lost answer is the same Send and never a second thread there.
  const key = useRef(newUuid());

  useEffect(() => {
    if (!active || !online) return;
    let live = true;
    const read = () =>
      inboxApi.composeSessions(null, null, machine.id).then(
        (model) => {
          if (!live) return;
          setAgent(agentToAsk(model));
          setReadFailed(false);
        },
        () => live && setReadFailed(true),
      );
    void read();
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void read();
    }, COMPOSE_SESSIONS_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [active, online, machine.id, readAgain]);

  const remember = (thread: string | null, who: string) => {
    setSent({ thread, agent: who });
    void inboxApi.machineUpdateAsked(machine.id, thread, who).catch(() => {});
  };

  const ask = async () => {
    if (!agent || busy) return;
    setBusy(true);
    setError(null);
    try {
      const started = await inboxApi.startThread(
        { to: { host: agent.host, session: agent.session }, body: ASK_AGENT_TO_UPDATE, idempotency_key: key.current, thread_name: ASK_AGENT_TO_UPDATE_THREAD },
        machine.id,
      );
      remember(started.thread_id, agent.name);
    } catch (cause) {
      // Held in this Inbox's outbox: it goes when that machine confirms, and its thread is not known yet.
      if (cause instanceof InboxHeldError) remember(null, agent.name);
      else if (cause instanceof InboxApiError && cause.code === 'session_not_live') {
        // That agent stopped while this was open: nothing was sent. Read who runs there now, with a new key.
        key.current = newUuid();
        setReadAgain((n) => n + 1);
        setError(`${agent.name} stopped on ${machine.name} before it got the message. Nothing was sent.`);
      } else setError(cause instanceof InboxApiError || cause instanceof Error ? cause.message : 'The message was not sent. Try again.');
    } finally {
      setBusy(false);
    }
  };

  // That machine's row is the truth once it says so (another tab, a reopened dialog); this tab's own Send until then.
  const asked = machine.update?.asked ?? sent;
  return { online, agent, readFailed, busy, error, asked, ask };
}

/**
 * The little dialog. It stays open through the update and follows the machine, or it can be closed at any point: the
 * row carries the same state. `onStartAgent`: New message, with the ask in it, to a new agent on that machine (remote
 * launch); absent where this window cannot start one.
 */
export function MachineUpdateDialog({ machine, snooze, onClose, onStartAgent }: { machine: MachineView; snooze: boolean; onClose: () => void; onStartAgent?: (machineId: string) => void }) {
  const [details, setDetails] = useState<MachineUpdateDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [upToDate, setUpToDate] = useState(false);
  const name = machine.name;
  const notice = machineNotice(machine);
  const phase = machine.update?.phase;

  useEffect(() => {
    if (machine.state !== 'online') return;
    let live = true;
    inboxApi.machineUpdate(machine.id).then(
      (next) => live && setDetails(next),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [machine.id, machine.state, phase]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await inboxApi.startMachineUpdate(machine.id);
    } catch (cause) {
      setError(cause instanceof InboxApiError || cause instanceof Error ? cause.message : 'The update could not start.');
      setUpToDate(cause instanceof InboxApiError && cause.code === 'update_up_to_date');
    } finally {
      setBusy(false);
    }
  };

  const to = machine.update?.target ?? details?.update?.version ?? 'the newest version';
  const from = machine.update?.from ?? details?.current ?? machine.version ?? 'an older version';
  const close = (
    <button type="button" className="ib-btn" onClick={onClose}>
      Close
    </button>
  );
  const errorLine = error && <div className="ib-error">{error}</div>;
  // Its door is older than the route: nothing here can start, restart or retry an update there.
  const tooOld = machine.update?.can_update === false || details?.too_old === true;
  const said = notice?.kind === 'updated' || notice?.kind === 'updating' || notice?.kind === 'restarting' || notice?.kind === 'not_back';
  const there = useAskThere(machine, tooOld && !said);

  // A restart on the way or just done is said before anything else: the machine's own answer comes after it.
  if (notice?.kind === 'updated') {
    return (
      <Modal label={`${name} is on ${to}`} onClose={onClose} testId="machine-update-done">
        <h2 className="ib-mh2">
          <Icon name="check" size={17} /> {name} is on {to}
        </h2>
        <p className="ib-sub">Updated from {machine.update?.from}. Its threads are back.</p>
        <div className="ib-acts-row">
          <button type="button" className="ib-btn ib-pri" onClick={onClose}>
            Done
          </button>
        </div>
      </Modal>
    );
  }
  if (notice?.kind === 'updating' || notice?.kind === 'restarting') {
    const restarting = notice.kind === 'restarting';
    return (
      <Modal label={restarting ? `${name} is restarting` : `Updating ${name}`} onClose={onClose} testId="machine-update-progress">
        <h2 className="ib-mh2">
          <span className="ib-spin" aria-hidden="true" /> {restarting ? `${name} is restarting on ${to}` : `Updating ${name} to ${to}`}
        </h2>
        <p className="ib-sub">{restarting ? 'Its threads come back in a moment.' : tooOld ? `It runs ${from} until the install is in.` : `It runs ${from} until the install is in, then its Inbox restarts.`} You can close this; it carries on.</p>
        <div className="ib-acts-row">{close}</div>
      </Modal>
    );
  }
  if (notice?.kind === 'not_back') {
    // The version it ran before the restart, when it is a plain release the install scripts can put back.
    const before = machine.update?.from;
    const putBack = before && /^\d+\.\d+\.\d+$/.test(before) ? { version: before, ...putBackCommands(before) } : null;
    return (
      <Modal label={`${name} has not come back`} onClose={onClose} testId="machine-update-not-back">
        <h2>{name} has not come back</h2>
        <p className="ib-sub">It was restarting on {to}. Its threads come back as soon as it does.</p>
        <p className="ib-sum">If it stays away, on {name}, in a terminal:</p>
        <Command text="plannotator inbox --background" />
        {putBack && (
          <>
            <p className="ib-sum ib-quietline">If that does not start it, put {putBack.version} back:</p>
            <Command text={putBack.sh} />
            <p className="ib-sum ib-quietline">In PowerShell on Windows:</p>
            <Command text={putBack.ps} />
          </>
        )}
        <div className="ib-acts-row">{close}</div>
      </Modal>
    );
  }
  if (tooOld) {
    const { agent, asked } = there;
    const canStart = !asked && there.online && agent === null && machine.launch === true && !!onStartAgent;
    // The commands are the fallback: folded while an agent there can do it, open when nothing here can.
    const byHandOpen = !asked && (!there.online || there.readFailed || (agent === null && !canStart));
    let status: React.ReactNode;
    let primary: React.ReactNode = null;
    if (asked) {
      status = (
        <div className="ib-mask" data-machine-ask="sent">
          <p className="ib-sum ib-mask-line">
            <Icon name="check" size={15} />
            <span>
              Asked {asked.agent} on {name}
            </span>
            {asked.thread ? (
              <a href={`#thread=${encodeURIComponent(asked.thread)}`} onClick={onClose} data-machine-ask-thread="">
                Open the thread
              </a>
            ) : (
              <span className="ib-mask-held">Sending to {name}…</span>
            )}
          </p>
          <p className="ib-sum ib-quietline">It updates Plannotator there and restarts its Inbox. This says Updated when {name} is back on the new version.</p>
        </div>
      );
    } else if (!there.online) {
      status = (
        <p className="ib-sum" data-machine-ask="asleep">
          {name} is asleep. Wake it to ask an agent there to update it.
        </p>
      );
    } else if (there.readFailed && agent === undefined) {
      status = (
        <p className="ib-sum" data-machine-ask="unread">
          {name} didn&apos;t say which agents run there.
        </p>
      );
    } else if (agent === null) {
      status = (
        <p className="ib-sum" data-machine-ask="none">
          No agent is running on {name} to ask. {canStart ? 'Start one there with the request in its first message.' : 'Start one there, then ask it here.'}
        </p>
      );
      if (canStart) {
        primary = (
          <button type="button" className="ib-btn ib-pri" onClick={() => onStartAgent!(machine.id)} data-machine-ask-start="">
            Start an agent on {name}
          </button>
        );
      }
    } else {
      status = agent ? (
        <p className="ib-sum" data-machine-ask="ready">
          {agent.name} is running there{agent.project ? ` in ${agent.project}` : ''}. It gets a message asking it to update Plannotator and restart the Inbox, and replies when it is done.
        </p>
      ) : null;
      primary = (
        <button type="button" className="ib-btn ib-pri" onClick={() => void there.ask()} disabled={!agent || there.busy} data-machine-ask-go="">
          {there.busy && <span className="ib-spin" aria-hidden="true" />}
          Ask an agent on {name} to update it
        </button>
      );
    }
    return (
      <Modal label={`Update ${name}`} onClose={onClose} testId="machine-update-too-old">
        <h2>Update {name}</h2>
        <p className="ib-sub">It runs {from}, from before machines could update each other.</p>
        {snooze && <SnoozeLine name={name} />}
        {status}
        {there.error && <div className="ib-error">{there.error}</div>}
        <details className="ib-mhand" open={byHandOpen || undefined}>
          <summary>{byHandOpen ? 'Update it yourself' : 'Or update it yourself'}</summary>
          <p className="ib-sum">On {name}, in a terminal:</p>
          <Command text={UPDATE_BY_HAND} />
          <p className="ib-sum ib-quietline">If that says command not found (SSH can skip your PATH), use the full path:</p>
          <Command text={UPDATE_BY_HAND_FULL_PATH} />
          <p className="ib-sum ib-quietline">In PowerShell on Windows:</p>
          <Command text={UPDATE_BY_HAND_POWERSHELL} />
          <p className="ib-sum ib-quietline">After this once, you can update it from here.</p>
        </details>
        <div className="ib-acts-row">
          {close}
          {primary}
        </div>
      </Modal>
    );
  }
  if (notice?.kind === 'failed' && details?.failure?.unchanged) {
    return (
      <Modal label={`The update didn't install on ${name}`} onClose={onClose} testId="machine-update-unchanged">
        <h2>The update didn&apos;t install on {name}</h2>
        <p className="ib-sub">The install script reported no error, but {name} is still on {from}.</p>
        {details.log && (
          <>
            <p className="ib-sum">On {name}, the log says what it did:</p>
            <Command text={details.log} />
          </>
        )}
        {details.command && (
          <>
            <p className="ib-sum">Or run the install script yourself there:</p>
            <Command text={details.command} />
          </>
        )}
        {errorLine}
        <div className="ib-acts-row">
          {close}
          <button type="button" className="ib-btn ib-pri" onClick={() => void start()} disabled={busy} data-machine-update-now="">
            Try Again
          </button>
        </div>
      </Modal>
    );
  }
  if (notice?.kind === 'failed') {
    return (
      <FailedDialog
        update={{ current: from, releaseUrl: `https://github.com/backnotprop/plannotator/releases/tag/v${to}` }}
        details={details ? { failure: details.failure ? { ...details.failure, log: details.log ?? '' } : null, log: details.log ?? '', command: details.command ?? '' } : null}
        home={null}
        machineName={name}
        error={error}
        onRetry={() => void start()}
        onClose={onClose}
      />
    );
  }
  if (notice?.kind === 'by_hand') {
    return (
      <Modal label={`Update ${name} by hand`} onClose={onClose} testId="machine-update-by-hand">
        <h2>Update {name} by hand</h2>
        <p className="ib-sub">Its copy of Plannotator was not installed by the install script, so it can&apos;t update itself. It runs {from}.</p>
        {snooze && <SnoozeLine name={name} />}
        {details?.command && (
          <>
            <p className="ib-sum">On {name}, in a terminal:</p>
            <Command text={details.command} />
          </>
        )}
        <div className="ib-acts-row">{close}</div>
      </Modal>
    );
  }
  if (machine.state === 'offline') {
    return (
      <Modal label={`${name} is asleep`} onClose={onClose} testId="machine-update-asleep">
        <h2>{name} is asleep</h2>
        <p className="ib-sub">It runs {from}. Wake it, then update it from here.</p>
        {snooze && <SnoozeLine name={name} />}
        <div className="ib-acts-row">{close}</div>
      </Modal>
    );
  }
  if (notice?.kind === 'ready') {
    return (
      <Modal label={`Restart the Inbox on ${name}`} onClose={onClose} testId="machine-update-ready">
        <h2>Restart the Inbox on {name}</h2>
        <p className="ib-sub">{to} is installed there. Its Inbox still runs {from}.</p>
        {snooze && <SnoozeLine name={name} />}
        {errorLine}
        <div className="ib-acts-row">
          <button type="button" className="ib-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="ib-btn ib-pri" onClick={() => void start()} disabled={busy} data-machine-update-now="">
            Restart
          </button>
        </div>
      </Modal>
    );
  }
  // It asked GitHub and said so (this Inbox runs ahead of the release), and the word has gone from its row.
  if (upToDate && !notice) {
    return (
      <Modal label={`${name} is up to date`} onClose={onClose} testId="machine-update-level">
        <h2>{name} is up to date</h2>
        <p className="ib-sub">It runs {from}.</p>
        <div className="ib-acts-row">{close}</div>
      </Modal>
    );
  }
  const reviews = details?.open_reviews ?? 0;
  return (
    <Modal label={`Update ${name} to ${to}`} onClose={onClose} testId="machine-update">
      <h2>Update {name} to {to}</h2>
      <p className="ib-sub">It runs {from}.</p>
      {snooze && <SnoozeLine name={name} />}
      <p className="ib-sum">
        The new version installs there and its Inbox restarts. Its agents keep working.
        {reviews > 0 && ` ${reviews === 1 ? 'One open review there keeps' : `${reviews} open reviews there keep`} running on ${from} until you finish ${reviews === 1 ? 'it' : 'them'}.`}
      </p>
      {errorLine}
      <div className="ib-acts-row">
        <button type="button" className="ib-btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="ib-btn ib-pri" onClick={() => void start()} disabled={busy} data-machine-update-now="">
          Update now
        </button>
      </div>
    </Modal>
  );
}
