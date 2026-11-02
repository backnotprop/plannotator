import { Icon } from '../icons';

/**
 * "Inbox updated to X · Reload" (stalePage.ts): this page is older than the Inbox it talks to. In the look of the
 * list's "N new · Show" line (the owner: "similar to when you get a new message and you click it and it refreshes
 * the page"), with a × that hides it until the next check. Never a reload by itself: the person presses it.
 */
export function StalePageNotice({ version, busy, onReload, onDismiss }: { version: string; busy: boolean; onReload: () => void; onDismiss: () => void }) {
  return (
    <div className="ib-notice ib-stale" data-stale-page="">
      <button type="button" className="ib-stale-go" onClick={onReload} disabled={busy} aria-busy={busy || undefined}>
        <Icon name="refresh" size={15} />
        <span className="ib-stale-say">Inbox updated to {version}</span>
        <b>{busy ? 'Reloading…' : 'Reload'}</b>
      </button>
      <button type="button" className="ib-stale-x" onClick={onDismiss} aria-label="Dismiss: reload later" disabled={busy}>
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}
