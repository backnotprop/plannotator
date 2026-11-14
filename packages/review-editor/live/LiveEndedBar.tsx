import { createPortal } from 'react-dom';

export function LiveEndedBar({ threadUrl }: { threadUrl: string }) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div role="status" data-live-ended className="fixed bottom-3 left-1/2 z-[1100] flex -translate-x-1/2 items-center gap-3 rounded border border-border bg-popover px-3 py-1.5 text-[13px] text-foreground">
      <span>This review has ended. Its threads are in the Inbox.</span>
      <a href={threadUrl} className="rounded px-1.5 py-0.5 text-[12px] font-medium text-primary hover:bg-muted">
        Open it again
      </a>
    </div>,
    document.body,
  );
}
