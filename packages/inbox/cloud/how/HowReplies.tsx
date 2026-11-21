import { HostMark, Icon } from '../../icons';
import { HowWire } from './HowWire';

function Lane({ wakes }: { wakes: boolean }) {
  return (
    <div className="ib-chow-lane" data-wakes={wakes ? '' : undefined}>
      <span className="ib-chow-lane-t">{wakes ? 'With a wake address' : 'Without one'}</span>
      <span className="ib-chow-lane-r">
        <span className="ib-chow-you">Ship it.</span>
        <HowWire toward="right" tone={wakes ? 'ok' : 'quiet'} chip={<Icon name={wakes ? 'play' : 'clock'} size={12} />} />
        <span className="ib-chow-agent">
          <HostMark host="cloud-grok" big />
          <span className="ib-chow-cap">{wakes ? 'Its service starts a run' : 'Reads it at its next check'}</span>
        </span>
      </span>
    </div>
  );
}

export function HowReplies() {
  return (
    <div className="ib-chow-p ib-chow-replies">
      <Lane wakes />
      <Lane wakes={false} />
    </div>
  );
}
