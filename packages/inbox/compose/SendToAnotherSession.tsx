import { useEffect, useId, useRef, useState } from 'react';
import { InboxApiError, inboxApi, type LiveSessionsModel } from '../api';
import { HostMark, Icon } from '../icons';
import { busyWord, hostLabel, startedLine } from './model';

/** After a move: the moved message's delivery line, else the thread's heading; never the page. */
function focusAfterMove(messageId: string): void {
  const target = () =>
    document.querySelector<HTMLElement>(`[data-message-article="${CSS.escape(messageId)}"] [data-delivery]`) ?? document.querySelector<HTMLElement>('.ib-pane .ib-subject');
  const attempt = (left: number) => {
    const el = target();
    if (el?.isConnected) {
      el.focus();
      if (document.activeElement === el) return;
    }
    // The thread re-renders after the move; try again on the next tasks for a moment.
    if (left > 0) setTimeout(() => attempt(left - 1), 16);
  };
  attempt(20);
}

/**
 * "Send to another session" (compose): a message of the person's that the
 * session it was addressed to never took, because that session stopped. It
 * moves the same message to another live session of the thread's project
 * (`POST /api/inbox/messages/:id/to`). Nothing moves on its own; a session
 * that comes back with the same id (a resume) still gets it until then.
 *
 * The choice is the ended-session reply's radio rows (ReplyRoute's
 * `RouteChoice` look): one radio group of the live sessions, arrows move the
 * selection, Enter or the primary moves the message, Esc or Cancel closes it.
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
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const openRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const name = `ib-readdress-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  const others = (live?.sessions ?? []).filter((s) => s.session !== ended.session);
  // The selection stays on its session across re-reads; one that left falls back to the first.
  const chosen = others.find((s) => s.session === selected) ?? others[0] ?? null;

  useEffect(() => {
    if (!open) return;
    void onReload();
    // onReload once per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // Opening puts focus on the selected radio (or the form's first control).
  useEffect(() => {
    if (!open) return;
    const form = formRef.current;
    (form?.querySelector<HTMLElement>('input[type=radio]:checked') ?? form?.querySelector<HTMLElement>('button'))?.focus();
  }, [open, others.length > 0]);

  const close = () => {
    setOpen(false);
    setError(null);
    requestAnimationFrame(() => openRef.current?.focus());
  };

  const move = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      await inboxApi.readdress(messageId, { host: chosen.host, session: chosen.session });
      setOpen(false);
      await onMoved();
      // The choice goes with the move: focus goes to the message's delivery line, else the thread's heading.
      focusAfterMove(messageId);
    } catch (cause) {
      setError(cause instanceof InboxApiError ? cause.message : 'It was not moved; try again.');
      void onReload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ib-readdress" data-readdress="">
      {!open && (
        <button type="button" ref={openRef} className="ib-btn ib-sm" aria-expanded={false} onClick={() => setOpen(true)} data-readdress-open="">
          <Icon name="forward" size={14} />
          Send to another session
        </button>
      )}
      {open && (
        <form
          ref={formRef}
          className="ib-routeform"
          data-readdress-choice=""
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            // Marked used, so the window's own Esc (close the thread) leaves it alone.
            event.preventDefault();
            close();
          }}
          onSubmit={(event) => {
            event.preventDefault();
            void move();
          }}
        >
          <fieldset className="ib-route">
            <legend>Send it to another session</legend>
            {others.length === 0 ? (
              <p className="ib-why">No other session is running in {project}. It waits here; a resumed session still gets it.</p>
            ) : (
              <div className="ib-gl">Live sessions in {project}</div>
            )}
            {others.map((session) => (
              <label className="ib-opt" key={session.session} data-readdress-session={session.session}>
                <input
                  type="radio"
                  name={name}
                  value={session.session}
                  checked={chosen?.session === session.session}
                  onChange={() => setSelected(session.session)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    void move();
                  }}
                />
                <HostMark host={session.host} />
                <span>
                  <span className="ib-t">
                    {hostLabel(session.host)} · {startedLine(session)}
                  </span>
                  <span className="ib-d">{busyWord(session)}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {error && (
            <div className="ib-error ib-route-error" role="alert">
              {error}
            </div>
          )}
          <div className="ib-acts ib-route-acts">
            {chosen && (
              <button type="submit" className="ib-btn ib-pri" disabled={busy} data-readdress-send="">
                <Icon name="send" size={15} />
                Send to {hostLabel(chosen.host)}
              </button>
            )}
            <button type="button" className="ib-btn ib-ghost" onClick={close}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
