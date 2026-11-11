import type { ReactNode } from 'react';
import type { AskKind, TabSlept } from '../notify';
import { addressOf, browserName } from '../notifyStatus';
import { Icon } from '../icons';

function AskShell({
  className,
  icon,
  label,
  data,
  children,
  actions,
}: {
  className: string;
  icon: 'bell' | 'warn' | 'info';
  label: string;
  data: Record<string, string>;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className={className} role="region" aria-label={label} {...data}>
      <div className="ib-ask-in">
        <Icon name={icon} />
        <p className="ib-ask-text">{children}</p>
        <div className="ib-ask-acts">{actions}</div>
      </div>
    </div>
  );
}

export function NotificationAsk({
  kind,
  onTurnOn,
  onNotNow,
  onSettings,
  movedFrom = null,
  soundOn = false,
  firstRun = false,
}: {
  kind: AskKind;
  onTurnOn: () => void;
  onNotNow: () => void;
  onSettings?: () => void;
  movedFrom?: string | null;
  soundOn?: boolean;
  firstRun?: boolean;
}) {
  const browser = browserName();
  if (kind === 'blocked') {
    return (
      <AskShell
        className="ib-askline ib-askquiet"
        icon="bell"
        label="Desktop notifications"
        data={{ 'data-notification-ask': kind }}
        actions={
          <>
            {onSettings && (
              <button type="button" className="ib-btn ib-ghost ib-sm" onClick={onSettings}>
                How to allow
              </button>
            )}
            <button type="button" className="ib-btn ib-ghost ib-sm" onClick={onNotNow}>
              Hide
            </button>
          </>
        }
      >
        <span className="ib-mut">
          {browser === 'this browser' ? 'This browser' : browser} blocks notifications for {window.location.host}, so you get no notice when an agent {firstRun ? 'asks you its first question' : 'stops on you'}.
        </span>
      </AskShell>
    );
  }
  return (
    <AskShell
      className={kind === 'moved' ? 'ib-askline ib-askmoved' : 'ib-askline'}
      icon={kind === 'moved' ? 'warn' : 'bell'}
      label="Desktop notifications"
      data={{ 'data-notification-ask': kind }}
      actions={
        <>
          <button type="button" className="ib-btn ib-pri ib-sm" onClick={onTurnOn}>
            {kind === 'moved' ? 'Allow' : 'Turn on'}
          </button>
          <button type="button" className="ib-btn ib-ghost ib-sm" onClick={onNotNow}>
            Not now
          </button>
        </>
      }
    >
      {kind === 'ask' && firstRun ? (
        <>
          <b>Get a desktop notice when the first question arrives.</b>{' '}
          <span className="ib-mut">
            Turn it on before you try it, so you hear from your agent while this tab is in the background. Your browser asks once.{soundOn && ' Sound is on.'}
          </span>
        </>
      ) : kind === 'ask' ? (
        <>
          <b>Get a desktop notice when an agent needs you.</b>{' '}
          <span className="ib-mut">
            When an agent starts a thread or asks you something. Your browser asks once.{soundOn && ' Sound is on.'}
          </span>
        </>
      ) : (
        <>
          <b>Notifications are off at this address.</b>{' '}
          <span className="ib-mut">
            You allowed them at {movedFrom ? addressOf(movedFrom) : 'another address'}; the Inbox is now at {window.location.host}. Allow them again. Reload or close any tab still open on the old address, so notices don't arrive twice.
          </span>
        </>
      )}
    </AskShell>
  );
}

export function TabSleptLine({ slept, onDismiss }: { slept: Exclude<TabSlept, null>; onDismiss: () => void }) {
  const chrome = browserName() === 'Chrome' || browserName() === 'Edge';
  return (
    <AskShell
      className="ib-askline ib-askquiet"
      icon="info"
      label="Notifications paused"
      data={{ 'data-tab-slept': slept }}
      actions={
        <button type="button" className="ib-btn ib-ghost ib-sm" onClick={onDismiss}>
          Got it
        </button>
      }
    >
      <span className="ib-mut">
        {slept === 'discarded'
          ? 'Your browser closed this tab in the background to save memory, so it could not notify you meanwhile.'
          : 'Your browser paused this tab in the background, so notices came late or not at all.'}
        {chrome && ` To keep it running: Settings → Performance → "Always keep these sites active" → add ${window.location.hostname}.`}
      </span>
    </AskShell>
  );
}
