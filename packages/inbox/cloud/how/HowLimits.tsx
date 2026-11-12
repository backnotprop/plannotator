import { HostMark, Icon, type IconName } from '../../icons';

const SEES = ['It started', 'You sent it', 'You tagged it'];

const CANNOT: { icon: IconName; label: string }[] = [
  { icon: 'questionBubble', label: 'Answer your questions' },
  { icon: 'checkCircle', label: 'Approve anything' },
  { icon: 'terminal', label: 'Run anything on your computer' },
  { icon: 'folder', label: 'Open your files' },
];

export function HowLimits() {
  return (
    <div className="ib-chow-p ib-chow-limits">
      <div className="ib-chow-col">
        <span className="ib-chow-col-t">It sees</span>
        <div className="ib-chow-threads">
          {SEES.map((why) => (
            <span key={why} className="ib-chow-thread">
              <HostMark host="cloud-grok" />
              <span className="ib-chow-bar" />
              <span className="ib-chow-why">{why}</span>
            </span>
          ))}
          <span className="ib-chow-thread ib-chow-hidden">
            <Icon name="eyeOff" size={14} />
            <span className="ib-chow-why">Your other threads</span>
          </span>
        </div>
      </div>
      <div className="ib-chow-col">
        <span className="ib-chow-col-t">It can’t</span>
        <div className="ib-chow-cannot">
          {CANNOT.map((item) => (
            <span key={item.icon} className="ib-chow-no">
              <span className="ib-chow-no-i">
                <Icon name={item.icon} size={16} />
              </span>
              <span className="ib-chow-no-t">{item.label}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
