import { cn } from '../../lib/utils';

export const FOCUS_RING =
  'outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring-soft';

export const floatingDialogChrome =
  'bg-popover text-popover-foreground rounded-dialog border border-border shadow-dialog';

const PHONE_TARGET = 'max-md:min-h-11 max-md:min-w-11';

export const CHAT_ICON_BUTTON = cn(
  'relative size-7 border border-transparent text-muted-foreground after:absolute after:-inset-1',
  '[@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface-hover',
  '[@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground',
  PHONE_TARGET,
  FOCUS_RING,
);

export const CHAT_SEND_BUTTON = cn(
  'size-8 border border-transparent shadow-none',
  PHONE_TARGET,
  FOCUS_RING,
);

export const CHAT_STOP_BUTTON = cn(
  CHAT_SEND_BUTTON,
  'bg-soft-quiet-fill',
  '[@media(hover:hover)_and_(pointer:fine)]:hover:bg-soft-quiet-fill-hover',
);
