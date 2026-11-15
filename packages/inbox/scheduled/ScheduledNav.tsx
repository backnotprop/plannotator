import { Icon } from '../icons';

/** The sidebar's "Routines" row, under Inbox beside Board, drawn only while the capability is on. */
export function ScheduledNav({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`ib-nav${on ? ' ib-on' : ''}`} onClick={onClick} aria-current={on ? 'page' : undefined} data-scheduled-nav="">
      <Icon name="scheduled" />
      Routines
    </button>
  );
}
