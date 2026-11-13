import { HostMark, Icon, type IconName } from '../../icons';

const SEES: { host: string; why: string }[] = [
  { host: 'cloud-grok', why: 'It started' },
  { host: 'claude-code', why: 'Another agent’s' },
  { host: 'codex', why: 'Another project' },
];

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
          {SEES.map((thread) => (
            <span key={thread.why} className="ib-chow-thread">
              <HostMark host={thread.host} />
              <span className="ib-chow-bar" />
              <span className="ib-chow-why">{thread.why}</span>
            </span>
          ))}
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
