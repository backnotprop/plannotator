import React from 'react';

interface ListMarkerProps {
  level: number;
  ordered?: boolean;
  orderedIndex?: number | null;
  checked?: boolean; // undefined = not a checkbox
  interactive?: boolean;
  onToggle?: () => void;
}

const BULLET_BY_LEVEL = ['\u2022', '\u2022', '\u2022'];

export const ListMarker: React.FC<ListMarkerProps> = ({
  level,
  ordered,
  orderedIndex,
  checked,
  interactive,
  onToggle,
}) => {
  const isCheckbox = checked !== undefined;
  const showNumeral = !!ordered && orderedIndex != null;
  const bullet = BULLET_BY_LEVEL[Math.min(level, BULLET_BY_LEVEL.length - 1)];

  const handleClick = interactive && onToggle
    ? (e: React.MouseEvent) => { e.stopPropagation(); onToggle(); }
    : undefined;

  return (
    <span
      className={`annotation-exclude select-none shrink-0 self-start flex items-center gap-1${interactive ? ' cursor-pointer' : ''}`}
      onClick={handleClick}
      role={interactive ? 'checkbox' : undefined}
      aria-checked={interactive ? checked : undefined}
    >
      {showNumeral && (
        <span className="text-primary/60 tabular-nums text-right" style={{ minWidth: '1.5rem' }} data-list-numeral="">
          {orderedIndex}.
        </span>
      )}
      {isCheckbox ? (
        checked ? (
          <svg data-list-check="" className="w-4 h-4 text-success mt-[3px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        ) : (
          <svg data-list-check="" className={`w-4 h-4 text-muted-foreground/50 mt-[3px]${interactive ? ' hover:text-muted-foreground transition-colors' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="12" cy="12" r="9" />
          </svg>
        )
      ) : !showNumeral ? (
        <span className="text-primary/60">{bullet}</span>
      ) : null}
    </span>
  );
};
