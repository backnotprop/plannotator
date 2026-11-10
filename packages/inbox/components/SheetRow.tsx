/**
 * One row of a phone's bottom sheet (BottomSheet.tsx): an agent's mark (or an icon), a title, a quiet line under it,
 * and what is at its end (a check, a circle to add it). 56 px tall; the chosen row wears a fill, never a border.
 */
import type { ReactNode } from 'react';
import { HostMark } from '../icons';

export function SheetRow({
  id,
  host,
  agent,
  lead,
  title,
  detail,
  end,
  selected = false,
  highlighted = false,
  quiet = false,
  disabled = false,
  onClick,
  ariaLabel,
  attrs,
}: {
  id?: string;
  /** The agent whose mark leads the row. */
  host?: string | null;
  /** Its session: the mark shows the face chosen for it. */
  agent?: string | null;
  /** In the mark's place, for a row that is not an agent. */
  lead?: ReactNode;
  title: string;
  detail?: string | null;
  end?: ReactNode;
  selected?: boolean;
  /** The row the arrow keys are on. */
  highlighted?: boolean;
  /** A quieter row ("Tag another agent"). */
  quiet?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  ariaLabel?: string;
  attrs?: Record<string, string | undefined>;
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      aria-label={ariaLabel}
      className="ib-sheet-row"
      data-on={selected || highlighted ? '' : undefined}
      data-quiet={quiet ? '' : undefined}
      // Reachable without a pointer (a narrow window on a computer has the phone's layout): Tab, then Enter or Space.
      tabIndex={disabled || !onClick ? undefined : 0}
      onClick={disabled ? undefined : onClick}
      onKeyDown={(event) => {
        if (disabled || !onClick || event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        onClick();
      }}
      {...attrs}
    >
      {lead !== undefined ? <span className="ib-sheet-lead">{lead}</span> : <span className="ib-sheet-mark">{host !== undefined && <HostMark host={host} agent={agent} />}</span>}
      <span className="ib-sheet-words">
        <span className="ib-sheet-t" dir="auto">
          {title}
        </span>
        {detail && <span className="ib-sheet-d">{detail}</span>}
      </span>
      {end !== undefined && end !== null && end !== false && <span className="ib-sheet-end">{end}</span>}
    </div>
  );
}

/** The hairline between a sheet's groups. */
export const SheetLine = () => <div className="ib-sheet-line" aria-hidden="true" />;
