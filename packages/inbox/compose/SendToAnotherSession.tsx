import { useEffect, useRef, useState } from 'react';
import { InboxApiError, inboxApi, type LiveSessionsModel } from '../api';
import { whenTime } from '../format';
import { HostMark, Icon } from '../icons';
import { hostLabel } from './model';

/**
 * "Send to another session" (compose): a message of the person's that the
 * session it was addressed to never took, because that session stopped. It
 * moves the same message to another live session of the thread's project
 * (`POST /api/inbox/messages/:id/to`). Nothing moves on its own; a session
 * that comes back with the same id (a resume) still gets it until then.
 */
export function SendToAnotherSession({
  messageId,
  ended,
  project,
  live,
  onReload,
  onMoved,
}: {
  messageId: string;
  ended: { host: string; session: string };
  project: string;
  live: LiveSessionsModel | null;
  onReload: () => Promise<unknown>;
  onMoved: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const others = (live?.sessions ?? []).filter((s) => s.session !== ended.session);

  useEffect(() => {
    if (!open) return;
    void onReload();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
    };
    const onDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
    };
    // onReload once per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const move = async (to: { host: string; session: string }) => {
    setBusy(true);
    setError(null);
    try {
      await inboxApi.readdress(messageId, to);
      setOpen(false);
      await onMoved();
    } catch (cause) {
      setError(cause instanceof InboxApiError ? cause.message : 'It was not moved; try again.');
      void onReload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ib-readdress" ref={ref} data-readdress="">
      <button type="button" className="ib-btn ib-sm" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-readdress-open="">
        <Icon name="forward" size={14} />
        Send to another session
      </button>
      {open && (
        <div className="ib-menu ib-readdress-pop" role="menu" aria-label={`Live sessions in ${project}`}>
          <div className="ib-mh">{others.length > 0 ? `Live sessions in ${project}` : `No other session is running in ${project}.`}</div>
          {others.map((session) => (
            <button
              type="button"
              role="menuitem"
              className="ib-mi"
              key={session.session}
              disabled={busy}
              data-readdress-session={session.session}
              onClick={() => void move({ host: session.host, session: session.session })}
            >
              <HostMark host={session.host} />
              <span>
                <span className="ib-t">
                  {hostLabel(session.host)} · started {whenTime(session.started_at)}
                </span>
                <span className="ib-d">{session.busy ? 'Working' : 'Idle'}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {error && (
        <div className="ib-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
