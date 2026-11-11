import { inboxCloudWakeLine, type InboxCloudWake } from '@plannotator/core/inbox-cloud';
import { Icon } from '../icons';

/** The tone of each state: done, waiting, or not started. */
const TONE: Record<InboxCloudWake['state'], 'delivered' | 'queued' | 'undelivered'> = {
  started: 'delivered',
  held: 'queued',
  sending: 'queued',
  retrying: 'queued',
  rate_limited: 'queued',
  uncertain: 'undelivered',
  key_rejected: 'undelivered',
  failed: 'undelivered',
  unpaired: 'undelivered',
};

/**
 * The line under the person's last message to a cloud agent (packages/server/inbox-cloud-wake.ts): "Woke Nightly
 * fixer · run started" with the run's link, a wait with its time, or a plain failure. A refused key links to where a
 * new one is pasted. `wake` null: just sent, the Inbox has not written its state yet.
 */
export function CloudWakeLine({ wake, fallbackName, time }: { wake: InboxCloudWake | null | undefined; fallbackName: string; time: (iso: string) => string }) {
  const shown: InboxCloudWake = wake ?? { state: 'sending', name: fallbackName, at: '' };
  const tone = TONE[shown.state];
  return (
    <div className="ib-delivered" data-delivery={tone} data-cloud-wake={shown.state} tabIndex={-1}>
      <span className="ib-dl-main">
        <Icon name={tone === 'delivered' ? 'check' : tone === 'queued' ? 'clock' : 'warn'} size={14} />
        <span className="ib-dl-text">
          {inboxCloudWakeLine(shown, time)}
          {shown.state === 'started' && shown.run_url && (
            <>
              {' · '}
              <a href={shown.run_url} target="_blank" rel="noreferrer noopener" data-cloud-run="">
                Open the run
              </a>
            </>
          )}
          {shown.state === 'key_rejected' && (
            <>
              {' '}
              <a href="#settings/devices" data-cloud-rekey="">
                Paste the new key
              </a>
            </>
          )}
        </span>
      </span>
    </div>
  );
}
