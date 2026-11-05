/**
 * Update on a linked machine (approval "inbox-machine-update"): the word beside it and its little dialog. That machine
 * is the truth: the row and the dialog read its own state, so a restart of this Inbox loses nothing.
 */

import { useEffect, useState } from 'react';
import { inboxApi, InboxApiError, type MachineUpdateDetails, type MachineView } from '../api';
import { Icon } from '../icons';
import { machineNotice, type MachineNotice } from '../machines';
import { CopyButton } from './ConnectPicker';
import { FailedDialog, Modal } from './Updates';
import { Tip } from './Tip';

/** Older machines can only update at the machine, once. The same line for a person and for a shell that skips their PATH. */
export const UPDATE_BY_HAND = 'plannotator update && plannotator inbox restart';
export const UPDATE_BY_HAND_FULL_PATH = '~/.local/bin/plannotator update && ~/.local/bin/plannotator inbox restart';
/** Windows PowerShell 5.1 refuses `&&`, and the full path above does not exist there. Shown to everyone: an older machine does not say what it runs on. */
export const UPDATE_BY_HAND_POWERSHELL = 'plannotator update; plannotator inbox restart';

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
  const word = notice.kind === 'failed' ? 'See why' : notice.kind === 'not_back' ? 'What now' : notice.kind === 'too_old' || notice.kind === 'by_hand' ? 'How to update' : notice.word;
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

/**
 * The little dialog. It stays open through the update and follows the machine, or it can be closed at any point: the
 * row carries the same state.
 */
export function MachineUpdateDialog({ machine, snooze, onClose }: { machine: MachineView; snooze: boolean; onClose: () => void }) {
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
    return (
      <Modal label={`${name} has not come back`} onClose={onClose} testId="machine-update-not-back">
        <h2>{name} has not come back</h2>
        <p className="ib-sub">It was restarting on {to}. Its threads come back as soon as it does.</p>
        <p className="ib-sum">If it stays away, on {name}, in a terminal:</p>
        <Command text="plannotator inbox --background" />
        <div className="ib-acts-row">{close}</div>
      </Modal>
    );
  }
  if (tooOld) {
    return (
      <Modal label={`Update ${name} by hand this once`} onClose={onClose} testId="machine-update-too-old">
        <h2>Update {name} by hand, this once</h2>
        <p className="ib-sub">It runs {from}, from before machines could update each other.</p>
        {snooze && <SnoozeLine name={name} />}
        <p className="ib-sum">On {name}, in a terminal:</p>
        <Command text={UPDATE_BY_HAND} />
        <p className="ib-sum ib-quietline">If that says command not found (SSH can skip your PATH), use the full path:</p>
        <Command text={UPDATE_BY_HAND_FULL_PATH} />
        <p className="ib-sum ib-quietline">In PowerShell on Windows:</p>
        <Command text={UPDATE_BY_HAND_POWERSHELL} />
        <p className="ib-sum ib-quietline">Or ask an agent on {name} to run it. After that, you can update it from here.</p>
        <div className="ib-acts-row">{close}</div>
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
