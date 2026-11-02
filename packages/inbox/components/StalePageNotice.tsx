import { useRef } from 'react';
import { Icon } from '../icons';

/**
 * "Inbox updated to X · Reload" (stalePage.ts): this page is older than the Inbox it talks to. In the look of the
 * list's "N new · Show" line (the owner: "similar to when you get a new message and you click it and it refreshes
 * the page"), with a × that hides it for this release. Never a reload by itself: the person presses it.
 *
 * While Reload saves (`busy`) it stays focusable (`aria-disabled`, presses ignored), so focus is still on it when a
 * save fails and the toast says why; the × works throughout. The × moves focus to where the person was reading: the
 * thread's subject, or the list's first row.
 */
export function StalePageNotice({ version, busy, onReload, onDismiss }: { version: string; busy: boolean; onReload: () => void; onDismiss: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const dismiss = () => {
    const notice = ref.current;
    const hadFocus = !!notice && notice.contains(document.activeElement);
    const next = notice?.closest('.ib-pbody')?.querySelector<HTMLElement>('.ib-subject') ?? notice?.closest('.ib-lbody')?.querySelector<HTMLElement>('button[data-thread-id]') ?? null;
    onDismiss();
    if (hadFocus) next?.focus({ preventScroll: true });
  };
  return (
    <div ref={ref} className="ib-notice ib-stale" data-stale-page="">
      <button type="button" className="ib-stale-go" onClick={() => !busy && onReload()} aria-disabled={busy || undefined} aria-busy={busy || undefined}>
        <Icon name="refresh" size={15} />
        <span className="ib-stale-say">Inbox updated to {version}</span>
        <b>{busy ? 'Reloading…' : 'Reload'}</b>
      </button>
      <button type="button" className="ib-stale-x" onClick={dismiss} aria-label="Dismiss: reload later">
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}
