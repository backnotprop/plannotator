/**
 * The permission card (approved: permissions.html): a big picture of the exact
 * System Settings switch, one line, one button. The HUD window floats over
 * System Settings, so the picture stays beside the real switch. The native
 * app checks by itself and flips this to a check, then carries on.
 */

import { useEffect } from 'react';
import { Icon } from '../icons';

export type PermissionKind = 'screen' | 'accessibility';
export type PermissionState = 'ask' | 'waiting' | 'reopen' | 'granted';

const COPY: Record<PermissionKind, { title: string; line: React.ReactNode; done: string; doneLine: string }> = {
  screen: { title: 'Turn on Screen Recording', line: 'Switch on Plannotator Shots.', done: 'Screen Recording is on', doneLine: 'Drag a box around what you mean.' },
  accessibility: {
    title: 'Turn on Accessibility',
    line: (
      <>
        App shots include the window’s text.
        <br />
        Passwords are never read.
      </>
    ),
    done: 'Accessibility is on',
    doneLine: 'App shots include the window’s text.',
  },
};

export function PermissionCard(props: {
  kind: PermissionKind;
  state: PermissionState;
  appIcon: string | null;
  onRequest: () => void;
  onReopen: () => void;
  onDecline: () => void;
  onClose: () => void;
}) {
  const { kind, state } = props;
  const copy = COPY[kind];
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  if (state === 'granted') {
    return (
      <div className="perm glass" role="status" aria-live="polite">
        <div className="perm-pic">
          <div className="perm-check">
            <Icon name="check" size={44} />
          </div>
        </div>
        <div className="perm-body">
          <h3>{copy.done}</h3>
          <p className="last">{copy.doneLine}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="perm glass" role="dialog" aria-labelledby="perm-title" aria-describedby="perm-line">
      <div className="perm-pic" aria-hidden="true">
        <div className="perm-row">
          {props.appIcon ? <img className="perm-icon" src={props.appIcon} alt="" /> : <span className="perm-icon placeholder" />}
          Plannotator Shots
          <span className="perm-switch" />
        </div>
      </div>
      <div className="perm-body">
        <h3 id="perm-title">{state === 'reopen' ? 'Almost there' : copy.title}</h3>
        <p id="perm-line">{state === 'reopen' ? 'Reopen Plannotator Shots to finish.' : copy.line}</p>
        {state === 'ask' && (
          <button type="button" className="perm-btn" onClick={props.onRequest}>
            Open System Settings
          </button>
        )}
        {state === 'waiting' && (
          <button type="button" className="perm-btn quiet" onClick={props.onRequest} aria-label="Waiting for the switch. Open System Settings again">
            <span className="spin" />
            Waiting
          </button>
        )}
        {state === 'reopen' && (
          <button type="button" className="perm-btn" onClick={props.onReopen}>
            Reopen
          </button>
        )}
        {kind === 'accessibility' && state !== 'reopen' && (
          <button type="button" className="perm-link" onClick={props.onDecline}>
            Not now
          </button>
        )}
      </div>
    </div>
  );
}
