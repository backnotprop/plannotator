/**
 * PROTOTYPE (proto/inbox-fixed-address, not for merge): the one-time
 * "Give the Inbox a fixed address" dialog and Settings → Devices' row.
 * Server: packages/server/inbox-name.ts. Sure runs portless's one privileged
 * step (the OS asks for the password), registers the name, verifies it, and
 * this page then moves to http://inbox.plannotator.localhost.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { inboxApi, type InboxNameState } from '../api';
import { Icon } from '../icons';
import { Modal } from './Updates';

const STEP_TEXT: Record<NonNullable<InboxNameState['step']>, string> = {
  preparing: 'Getting portless ready…',
  password: 'Waiting for your password. Your computer asks for it in its own window.',
  installing: 'Password accepted. Setting it up…',
  starting: 'Starting the address…',
  verifying: 'Checking the new address…',
};

/** How often the window reads the state while setup runs (the server moves a step within 250 ms of it happening). */
const SETUP_POLL_MS = 250;

export function stepText(state: InboxNameState): string {
  return state.step ? STEP_TEXT[state.step] : 'Starting…';
}

/** The fixed address's state, with on/off; polls every 250 ms while the server works. */
export function useFixedAddress(enabled: boolean) {
  const [state, setState] = useState<InboxNameState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  const poll = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const { name } = await inboxApi.nameState();
        if (!alive.current) return;
        setState(name);
        if (name.status === 'working') poll();
      } catch (e) {
        if (alive.current) setError(e instanceof Error ? e.message : String(e));
      }
    }, SETUP_POLL_MS);
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!enabled) return;
    inboxApi
      .nameState()
      .then(({ name }) => {
        if (!alive.current) return;
        setState(name);
        if (name.status === 'working') poll();
      })
      .catch(() => {});
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [enabled, poll]);

  const set = useCallback(
    async (on: boolean) => {
      setError(null);
      try {
        const { name } = await inboxApi.setName(on);
        setState(name);
        if (name.status === 'working') poll();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [poll],
  );

  return { state, setState, error, turnOn: () => set(true), turnOff: () => set(false) };
}

/** Move this tab to the name (keeping the route), once it answers. */
export function goToName(state: InboxNameState): void {
  if (location.host === state.host) return;
  location.assign(`${state.url.replace(/\/$/, '')}/${location.hash}`);
}

export interface FixedAddressDialogProps {
  initial: InboxNameState;
  onClose: () => void;
}

/** The one-time offer: "Give the Inbox a fixed address: inbox.plannotator.localhost · Sure · Not now". */
export function FixedAddressDialog({ initial, onClose }: FixedAddressDialogProps) {
  const name = useFixedAddress(true);
  const state = name.state ?? initial;
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current && state.status === 'on') {
      // A short beat so "Done" is seen, then the tab moves.
      const id = setTimeout(() => goToName(state), 400);
      return () => clearTimeout(id);
    }
  }, [state]);

  return (
    <Modal labelledBy="ib-name-title" describedBy="ib-name-desc" testId="fixed-address" onClose={onClose} ownKeys>
      <div className="ib-dlg-head">
        <h2 id="ib-name-title">Give the Inbox a fixed address</h2>
      </div>
      <p className="ib-sum" id="ib-name-desc">
        <b>{state.host}</b> stays the same when the Inbox’s port changes, so links and notification permission keep working. Your computer asks for your
        password once.
      </p>
      <div aria-live="polite" data-name-status={state.status}>
        {state.status === 'working' && <p className="ib-sum" data-name-step={state.step ?? ''}>{stepText(state)}</p>}
        {state.status === 'on' && (
          <p className="ib-sum" data-name-on="">
            <Icon name="check" size={13} /> Done. Opening {state.url}…{state.reason ? ` ${state.reason}` : ''}
          </p>
        )}
        {state.status === 'failed' && (
          <div className="ib-callout ib-err" role="alert" data-name-failed="">
            <Icon name="xCircle" />
            <span>{state.reason ?? 'It did not work.'} The Inbox stays at this address.</span>
          </div>
        )}
        {name.error && (
          <div className="ib-callout ib-err" role="alert">
            <Icon name="xCircle" />
            <span>{name.error}</span>
          </div>
        )}
      </div>
      <div className="ib-acts-row">
        <button type="button" className="ib-btn ib-ghost ib-left" data-name-later="" onClick={onClose}>
          {state.status === 'working' ? 'Close' : 'Not now'}
        </button>
        {state.status === 'on' ? (
          <button type="button" className="ib-btn ib-pri" data-name-open="" onClick={() => goToName(state)}>
            Open it
          </button>
        ) : (
          <button
            type="button"
            className="ib-btn ib-pri"
            data-name-sure=""
            disabled={state.status === 'working'}
            onClick={() => {
              asked.current = true;
              void name.turnOn();
            }}
          >
            {state.status === 'failed' ? 'Try again' : 'Sure'}
          </button>
        )}
      </div>
    </Modal>
  );
}

/** Settings → Devices: the fixed address, on/off, its state and Try again. */
export function FixedAddressSection({ via, localUrl }: { via: 'local' | 'tailnet'; localUrl: string }) {
  const remote = via === 'tailnet';
  const name = useFixedAddress(!remote);
  const state = name.state;
  // Nothing at all unless the prototype is switched on in the Inbox's environment.
  if (remote || !state || !state.prototype) return null;
  const here = state && typeof location !== 'undefined' && location.host === state.host;
  return (
    <section className="ib-sgroup" data-settings-fixed-address="" aria-labelledby="ib-g-name">
      <h2 id="ib-g-name">Fixed address</h2>
      <p>The Inbox at {state?.host ?? 'inbox.plannotator.localhost'} on this computer, whatever port it runs on. Prototype, through portless.</p>
      <div className="ib-card">
        <div className="ib-prow" data-name-row={state?.status ?? 'loading'}>
          <span className="ib-txt">
            <span className="ib-l">{state?.status === 'on' ? state.url : 'http://inbox.plannotator.localhost'}</span>
            <span className="ib-desc">
              {!state
                ? 'Checking…'
                : state.status === 'on'
                  ? `On${here ? ', and this page uses it' : ''}.${state.reason ? ` ${state.reason}` : ''}`
                  : state.status === 'off'
                    ? 'Off. The Inbox is at localhost and its port.'
                    : state.status === 'working'
                      ? stepText(state)
                      : state.status === 'unavailable'
                        ? `Not available: ${state.reason ?? ''}`
                        : `Did not work: ${state.reason ?? ''}`}
            </span>
            {state?.probe && <span className="ib-desc">Last check: {state.probe}</span>}
          </span>
          <span className="ib-ctl">
            {state?.status === 'on' && !here && (
              <button type="button" className="ib-btn" onClick={() => goToName(state)}>
                Open it
              </button>
            )}
            {state && state.status !== 'unavailable' && (
              <button
                type="button"
                className={`ib-btn${state.status === 'on' ? '' : ' ib-pri'}`}
                disabled={state.status === 'working'}
                data-name-toggle={state.status}
                onClick={() => {
                  if (state.status !== 'on') return void name.turnOn();
                  // This page came through the name: its listener closes, so go back to localhost.
                  void name.turnOff().then(() => {
                    if (here) location.assign(`${localUrl.replace(/\/$/, '')}/${location.hash}`);
                  });
                }}
              >
                {state.status === 'on' ? 'Turn off' : state.status === 'failed' ? 'Try again' : 'Turn on'}
              </button>
            )}
          </span>
        </div>
      </div>
      {name.error && (
        <div className="ib-callout ib-err" role="alert">
          <Icon name="xCircle" />
          <span>{name.error}</span>
        </div>
      )}
    </section>
  );
}
