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
  host?: string | null;
  agent?: string | null;
  lead?: ReactNode;
  title: string;
  detail?: string | null;
  end?: ReactNode;
  selected?: boolean;
  highlighted?: boolean;
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

export const SheetLine = () => <div className="ib-sheet-line" aria-hidden="true" />;
