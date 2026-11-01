import { cn } from '../../lib/utils';

// A .tsx on purpose, with no JSX: the apps' Tailwind `@source` globs take
// `packages/ui/components/**/*.tsx`, so classes in a .ts here get no rule.

/** The one focus spelling in this folder: a 1 px accent border and a soft halo. */
export const FOCUS_RING =
  'outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring-soft';

/** The bordered floating surface the window wears. */
export const floatingDialogChrome =
  'bg-popover text-popover-foreground rounded-dialog border border-border shadow-dialog';

/** A control is at least 44 px on a phone, whatever it draws at. */
const PHONE_TARGET = 'max-md:min-h-11 max-md:min-w-11';

/** `Button` ghost and icon, narrowed to the window's 28 px control and quiet
 * hover. The `after:` box keeps a 36 px target around the 28 px one. */
export const CHAT_ICON_BUTTON = cn(
  'relative size-7 border border-transparent text-muted-foreground after:absolute after:-inset-1',
  '[@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface-hover',
  '[@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground',
  PHONE_TARGET,
  FOCUS_RING,
);

/** The composer's 32 px Send and Stop, with no resting shadow. */
export const CHAT_SEND_BUTTON = cn(
  'size-8 border border-transparent shadow-none',
  PHONE_TARGET,
  FOCUS_RING,
);

/** Stop's quiet fill on top of `CHAT_SEND_BUTTON`. */
export const CHAT_STOP_BUTTON = cn(
  CHAT_SEND_BUTTON,
  'bg-soft-quiet-fill',
  '[@media(hover:hover)_and_(pointer:fine)]:hover:bg-soft-quiet-fill-hover',
);
