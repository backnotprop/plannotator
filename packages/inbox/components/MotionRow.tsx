import { chooseMotion, useInboxMotion, type InboxMotion } from '../motionSetting';

const MOTION_CHOICES: { id: InboxMotion; label: string }[] = [
  { id: 'device', label: 'Follow this device' },
  { id: 'reduced', label: 'Reduced' },
];

export function MotionRow() {
  const motion = useInboxMotion();
  return (
    <div className="ib-prow" data-settings-motion={motion}>
      <span className="ib-txt">
        <span className="ib-l" id="ib-motion-label">
          Motion
        </span>
        <span className="ib-desc">{motion === 'reduced' ? 'Short fades in place of slides, in this browser.' : "Moves less when this device's Reduce motion is on."}</span>
      </span>
      <span className="ib-ctl">
        <span className="ib-seg" role="radiogroup" aria-labelledby="ib-motion-label">
          {MOTION_CHOICES.map((choice) => (
            <label key={choice.id} className="ib-seg-o" data-on={motion === choice.id ? '' : undefined}>
              <input type="radio" name="ib-motion" value={choice.id} checked={motion === choice.id} onChange={() => chooseMotion(choice.id)} />
              {choice.label}
            </label>
          ))}
        </span>
      </span>
    </div>
  );
}
