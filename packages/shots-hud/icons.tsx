import type { ReactNode } from 'react';

const PATHS: Record<string, ReactNode> = {
  box: <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />,
  arrow: <path d="M3 13 13 3M7 3h6v6" />,
  pen: <path d="M10.5 2.5l3 3L6 13H3v-3z" />,
  redact: <rect x="2.5" y="5" width="11" height="6" rx="1" fill="currentColor" stroke="none" />,
  note: (
    <>
      <path d="M3 3h10v7l-3 3H3z" />
      <path d="M10 13v-3h3" />
    </>
  ),
  text: <path d="M3 4h10M3 7h10M3 10h7M3 13h5" />,
  image: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.6" />
      <circle cx="6" cy="6.5" r="1.1" />
      <path d="M2.5 11l3.2-3 2.6 2.4 1.9-1.6 3.3 2.9" />
    </>
  ),
  ask: <path d="M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7l-3 2.5v-2.5h0a2 2 0 0 1-1.5-2z" />,
  left: <path d="M10 3 5 8l5 5" />,
  right: <path d="M6 3l5 5-5 5" />,
  up: <path d="M8 13V3M4 7l4-4 4 4" />,
  snapshot: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 5.5h12M5.5 8h5M8 8v3.5" />
    </>
  ),
  check: <path d="M3 8.5 6.5 12 13 4.5" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3.2l2 1.3" />
    </>
  ),
  warn: (
    <>
      <path d="M8 2.5 14 13H2z" />
      <path d="M8 6.5v3M8 11.3v.2" />
    </>
  ),
  collapse: <path d="M4 8h8" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3 3" />
    </>
  ),
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  more: (
    <>
      <circle cx="3.5" cy="8" r="1" fill="currentColor" />
      <circle cx="8" cy="8" r="1" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1" fill="currentColor" />
    </>
  ),
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className = 'ico', style }: { name: IconName; size?: number; className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={className} viewBox="0 0 16 16" width={size} height={size} style={{ width: size, height: size, ...style }} aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
