import type { ReactNode } from 'react';

export function HowWire({ toward, label, chip, tone }: { toward: 'right' | 'left'; label?: string; chip?: ReactNode; tone?: 'ok' | 'quiet' }) {
  return (
    <span className="ib-chow-wire" data-toward={toward} data-tone={tone}>
      <svg className="ib-chow-wire-l" viewBox="0 0 100 12" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <path pathLength={1} d={toward === 'right' ? 'M0 6H100' : 'M100 6H0'} />
      </svg>
      <svg className="ib-chow-wire-h" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
        <path d="M2 1.5 7 5 2 8.5" />
      </svg>
      {chip && <span className="ib-chow-chip">{chip}</span>}
      {label && <span className="ib-chow-wire-t">{label}</span>}
    </span>
  );
}
