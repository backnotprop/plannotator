import { formatCount } from '@plannotator/core/inbox-format';
import { Icon } from '../icons';
import { usePlans } from './store';

/**
 * The sidebar's "Plans" row, second under Inbox (approval "inbox-plans"), drawn only while Plans is on. Its number
 * is the plans that changed since you looked.
 */
export function PlansNav({ on, onClick }: { on: boolean; onClick: () => void }) {
  const changed = usePlans().plans?.filter((p) => p.changed).length ?? 0;
  return (
    <button type="button" className={`ib-nav${on ? ' ib-on' : ''}`} onClick={onClick} aria-current={on ? 'page' : undefined} data-plans-nav="">
      <Icon name="map" />
      Plans
      {changed > 0 && (
        <span className="ib-n" aria-label={`${changed} changed since you looked`}>
          {formatCount(changed)}
        </span>
      )}
    </button>
  );
}
