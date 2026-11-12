import React from 'react';

export type DiffLayout = 'split' | 'unified';

export function DiffLayoutIcon({ layout, size = 15 }: { layout: DiffLayout; size?: number }) {
  return layout === 'split' ? (
    <svg viewBox="0 0 15 15" width={size} height={size} fill="none" stroke="currentColor" aria-hidden="true" focusable="false">
      <path stroke="none" fill="currentColor" fillOpacity={0.1} d="M2 .5h5.5v14H2A1.5 1.5 0 0 1 .5 13V2A1.5 1.5 0 0 1 2 .5" />
      <path stroke="none" fill="currentColor" fillOpacity={0.24} d="M7.5 .5H13A1.5 1.5 0 0 1 14.5 2v11a1.5 1.5 0 0 1-1.5 1.5H7.5z" />
      <rect x=".5" y=".5" width="14" height="14" rx="1.5" />
      <path d="M7.5 .5v14M3 7.5h3M9 7.5h3M10.5 6v3" />
    </svg>
  ) : (
    <svg viewBox="0 0 15 15" width={size} height={size} fill="none" stroke="currentColor" aria-hidden="true" focusable="false">
      <path stroke="none" fill="currentColor" fillOpacity={0.1} d="M2 .5h11A1.5 1.5 0 0 1 14.5 2v5.5H.5V2A1.5 1.5 0 0 1 2 .5" />
      <path stroke="none" fill="currentColor" fillOpacity={0.24} d="M.5 7.5h14V13a1.5 1.5 0 0 1-1.5 1.5H2A1.5 1.5 0 0 1 .5 13z" />
      <rect x=".5" y=".5" width="14" height="14" rx="1.5" />
      <path d="M.5 7.5h14M6 3.5h3M6 11.5h3M7.5 10v3" />
    </svg>
  );
}

export function diffLayoutToggleTip(layout: DiffLayout): string {
  return layout === 'split' ? 'Split view. Click for Unified' : 'Unified view. Click for Split';
}

export interface DiffLayoutToggleProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'onChange'> {
  value: DiffLayout;
  onChange: (next: DiffLayout) => void;
  nativeTitle?: boolean;
}

export const DiffLayoutToggle = React.forwardRef<HTMLButtonElement, DiffLayoutToggleProps>(function DiffLayoutToggle(
  { value, onChange, nativeTitle = true, onClick, ...rest },
  ref,
) {
  const next: DiffLayout = value === 'split' ? 'unified' : 'split';
  return (
    <button
      type="button"
      {...rest}
      ref={ref}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onChange(next);
      }}
      aria-label={next === 'unified' ? 'Switch to Unified view' : 'Switch to Split view'}
      title={nativeTitle ? diffLayoutToggleTip(value) : undefined}
      data-diff-layout-toggle={value}
    >
      <DiffLayoutIcon layout={value} />
    </button>
  );
});
