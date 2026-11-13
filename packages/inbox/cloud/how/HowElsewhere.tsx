import { INBOX_CLOUD_PRESET_LABELS, inboxCloudHostOf, type InboxCloudPreset } from '@plannotator/core/inbox-cloud';
import { HostMark, PlannotatorMark } from '../../icons';

const KINDS: InboxCloudPreset[] = ['claude-routine', 'grok-bot', 'muse', 'hermes', 'openclaw'];

export function HowElsewhere() {
  return (
    <div className="ib-chow-p ib-chow-else">
      <div className="ib-chow-kinds">
        {KINDS.map((kind) => (
          <span key={kind} className="ib-chow-kind">
            <HostMark host={inboxCloudHostOf(kind)} big />
            <span className="ib-chow-cap">{INBOX_CLOUD_PRESET_LABELS[kind]}</span>
          </span>
        ))}
      </div>
      <span className="ib-chow-drop" />
      <div className="ib-chow-win">
        <div className="ib-chow-win-h">
          <PlannotatorMark className="ib-chow-pmark" />
          <span>Your Inbox</span>
        </div>
        <div className="ib-chow-msg">
          <HostMark host="cloud-grok" />
          <span className="ib-chow-msg-b">
            <span className="ib-chow-who">
              Nightly fixer <span>Grok Bot</span>
            </span>
            <span className="ib-chow-said">The flaky test is fixed. Ship it tonight?</span>
          </span>
        </div>
        <div className="ib-chow-you">Yes, ship it.</div>
      </div>
    </div>
  );
}
