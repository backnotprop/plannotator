import type { AskKind } from '../notify';
import { Icon } from '../icons';

/**
 * The one-time ask (record 6.1): one line at the top of the list, in words
 * that say why, drawn in the page; Turn on raises the browser's own prompt.
 * After a port change it returns once as "The Inbox moved to a new address".
 */
export function NotificationAsk({ kind, onTurnOn, onNotNow }: { kind: AskKind; onTurnOn: () => void; onNotNow: () => void }) {
  return (
    <div className="ib-askline" role="region" aria-label="Desktop notifications" data-notification-ask={kind}>
      <Icon name="bell" />
      <span className="ib-grow">
        {kind === 'ask' ? (
          <>
            <b>Get a desktop notice when an agent stops on you.</b>{' '}
            <span className="ib-mut">Only for questions and stops, never for news. Your browser asks once.</span>
          </>
        ) : (
          <>
            <b>The Inbox moved to a new address.</b> <span className="ib-mut">Allow notifications again.</span>
          </>
        )}
      </span>
      <button type="button" className="ib-btn ib-pri ib-sm" onClick={onTurnOn}>
        Turn on
      </button>
      <button type="button" className="ib-btn ib-ghost ib-sm" onClick={onNotNow}>
        Not now
      </button>
    </div>
  );
}
