/**
 * A Reviews group (approval "inbox-reviews-compact-list"): its plain label and count, then its rows; a folded one has a
 * chevron and shows its rows only open. Any rows: review rows (ReviewsList.tsx) or this computer's work
 * (OnThisComputer.tsx). Nothing drawn for no rows, unless the group has something to say for them (`empty`: drawn
 * without a count, its words where the rows would be).
 */
import { formatCount } from '@plannotator/core/inbox-format';
import { Icon } from '../icons';

export interface ReviewGroupFold {
  open: boolean;
  onToggle: () => void;
}

/** `tool`: a control at the right end of a folded group's heading ("On this computer"'s +), beside its fold button. */
export function ReviewGroup({ label, name, count, fold, empty = false, tool, children }: { label: string; name: string; count: number; fold?: ReviewGroupFold; empty?: boolean; tool?: React.ReactNode; children: React.ReactNode }) {
  if (count === 0 && !empty) return null;
  const n = count > 0 && <span className="ib-n">{formatCount(count)}</span>;
  return (
    <div className={`ib-group ib-rvr-grp${fold ? ' ib-pr-fold' : ''}`} role="group" aria-label={label} data-pulls-group={name}>
      {fold && tool ? (
        <div className="ib-pr-foldhead">
          <button type="button" className="ib-pr-foldbtn" onClick={fold.onToggle} aria-expanded={fold.open} data-reviews-fold={name}>
            <Icon name={fold.open ? 'chevD' : 'chevR'} size={14} />
            {label} {n}
          </button>
          {tool}
        </div>
      ) : fold ? (
        <button type="button" className="ib-pr-foldbtn" onClick={fold.onToggle} aria-expanded={fold.open} data-reviews-fold={name}>
          <Icon name={fold.open ? 'chevD' : 'chevR'} size={14} />
          {label} {n}
        </button>
      ) : (
        <div className="ib-rvr-gl">
          {label} {n}
        </div>
      )}
      {(!fold || fold.open) && children}
    </div>
  );
}
