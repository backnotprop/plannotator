/**
 * A Reviews group (approval "inbox-reviews-compact-list"): its plain label and count, then its rows; a folded one has a
 * chevron and shows its rows only open. Any rows: review rows (ReviewsList.tsx) or this computer's work
 * (OnThisComputer.tsx). Nothing drawn for no rows.
 */
import { formatCount } from '@plannotator/core/inbox-format';
import { Icon } from '../icons';

export interface ReviewGroupFold {
  open: boolean;
  onToggle: () => void;
}

export function ReviewGroup({ label, name, count, fold, children }: { label: string; name: string; count: number; fold?: ReviewGroupFold; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <div className={`ib-group ib-rvr-grp${fold ? ' ib-pr-fold' : ''}`} role="group" aria-label={label} data-pulls-group={name}>
      {fold ? (
        <button type="button" className="ib-pr-foldbtn" onClick={fold.onToggle} aria-expanded={fold.open} data-reviews-fold={name}>
          <Icon name={fold.open ? 'chevD' : 'chevR'} size={14} />
          {label} <span className="ib-n">{formatCount(count)}</span>
        </button>
      ) : (
        <div className="ib-rvr-gl">
          {label} <span className="ib-n">{formatCount(count)}</span>
        </div>
      )}
      {(!fold || fold.open) && children}
    </div>
  );
}
