import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { INBOX_INITIATIVE_NAME_MAX, type InboxInitiative } from '@plannotator/core/inbox-types';
import { InboxApiError, inboxApi } from '../api';
import { Icon } from '../icons';
import { Tip } from '../components/Tip';
import { InboxToast, type InboxToastModel } from '../components/Toast';
import { Modal } from '../components/Updates';
import { initiativeDeletedToast } from './model';

/**
 * Initiatives (the filter's New initiative… and Edit initiatives…): every
 * live one as a name to edit in place (Enter or leaving the field renames it)
 * with Delete, one click and no question (the owner, 2026-11-04: "delete
 * initiatives very simply without friction"): the toast's Undo brings it and
 * its cards back; a field to add one. Every change is its own write; the Board
 * reads the cards again.
 *
 * The window's toast is under a modal dialog (showModal: the page behind is
 * inert), so while this is open the same toast draws inside it; closed with
 * the Undo still up, `onCloseWithUndo` hands it to the window's.
 */
/** The refusal whose server text the dialog shows as is (a 409): a name taken. */
const INITIATIVE_REFUSALS: ReadonlySet<string> = new Set(['initiative_exists']);
/** As long as the window's toast stays up (MARK_READ_UNDO_MS). */
const DELETED_TOAST_MS = 7_000;

export function InitiativesDialog({
  initiatives,
  start,
  phone,
  onClose,
  onChanged,
  onCloseWithUndo,
  fallbackFocus,
}: {
  initiatives: readonly InboxInitiative[];
  start: 'new' | 'edit';
  phone: boolean;
  onClose: () => void;
  /** An initiative was made, renamed or deleted: read the cards again. `made` names a new one. */
  onChanged: (made?: InboxInitiative) => void;
  /** Closed while the Undo was up: the window's toast takes it over, for these (deleted a moment ago). */
  onCloseWithUndo?: (deleted: readonly InboxInitiative[]) => void;
  /** Where focus goes on close when what opened it is gone (the menu item): the filter button. */
  fallbackFocus?: () => HTMLElement | null;
}) {
  const [adding, setAdding] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Deleted while the toast is up: their rows are gone at once, before the Board reads the cards again, and Undo brings them all back.
  const [deleted, setDeleted] = useState<readonly InboxInitiative[]>([]);
  const [toastId, setToastId] = useState(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Where focus goes once the next render is drawn: a row's Delete, or the name field.
  const [focusTo, setFocusTo] = useState<{ kind: 'row'; id: string } | { kind: 'new' } | null>(null);
  const newField = useRef<HTMLInputElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusTo) return;
    const at = focusTo.kind === 'new' ? newField.current : inner.current?.querySelector<HTMLElement>(`[data-initiative-row="${focusTo.id}"] [data-initiative-delete]`);
    // An undone row comes back with the Board's next read: focus waits for it.
    if (!at) return;
    at.focus();
    setFocusTo(null);
  }, [focusTo, initiatives]);
  const clearToast = useCallback(() => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = null;
    setDeleted([]);
  }, []);
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);
  const armToast = () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => {
      toastTimer.current = null;
      setDeleted([]);
    }, DELETED_TOAST_MS);
  };
  const holdToast = (held: boolean) => {
    if (!held) return armToast();
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = null;
  };
  const visible = initiatives.filter((i) => !deleted.some((gone) => gone.id === i.id));
  const remove = async (i: InboxInitiative) => {
    const gone = await run(async () => (await inboxApi.changeInitiative(i.id, { op: 'delete' })).initiative);
    if (!gone) return;
    // Focus moves to the next row's Delete (the one before when it was the last), else the name field.
    const at = visible.findIndex((other) => other.id === i.id);
    const next = visible[at + 1] ?? visible[at - 1];
    setFocusTo(next ? { kind: 'row', id: next.id } : { kind: 'new' });
    setDeleted((now) => [...now, i]);
    setToastId((id) => id + 1);
    armToast();
    onChanged();
  };
  const undo = async () => {
    const back = deleted;
    let done = 0;
    let refused = false;
    const ok = await run(async () => {
      let last = back[0]!;
      for (const i of back) {
        try {
          last = (await inboxApi.changeInitiative(i.id, { op: 'restore' })).initiative;
        } catch (cause) {
          refused = cause instanceof InboxApiError && INITIATIVE_REFUSALS.has(cause.code);
          throw cause;
        }
        done++;
      }
      return last;
    });
    // A name taken since refuses its restore: the line says so, what came back stays back, and the toast stops
    // offering that Undo. A failed save keeps it, to try again.
    if (done > 0 || refused) onChanged();
    if (!ok) {
      setDeleted((now) => now.slice(done + (refused ? 1 : 0)));
      return;
    }
    clearToast();
    setFocusTo({ kind: 'row', id: back[back.length - 1]!.id });
  };
  const close = () => {
    if (deleted.length > 0) onCloseWithUndo?.(deleted);
    onClose();
  };
  // The dialog first focuses its primary button: New initiative… lands in the name field instead.
  useEffect(() => {
    if (start !== 'new') return;
    const frame = requestAnimationFrame(() => newField.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [start]);
  const run = async (work: () => Promise<InboxInitiative>): Promise<InboxInitiative | null> => {
    setBusy(true);
    setError(null);
    try {
      return await work();
    } catch (cause) {
      // Only a name taken says why (the server's words); anything else, a network failure too, the one line.
      setError(cause instanceof InboxApiError && INITIATIVE_REFUSALS.has(cause.code) ? cause.message : 'That did not save. Try again.');
      return null;
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    const name = adding.replace(/\s+/g, ' ').trim();
    if (!name) {
      newField.current?.focus();
      return;
    }
    const made = await run(async () => (await inboxApi.createInitiative(name)).initiative);
    if (!made) return;
    setAdding('');
    onChanged(made);
    newField.current?.focus();
  };
  let body: ReactNode = null;
  if (visible.length > 0) {
    body = (
      <ul className="ib-inid-list" aria-label="Initiatives">
        {visible.map((i) => (
          <InitiativeRow
            key={i.id}
            initiative={i}
            busy={busy}
            onRename={async (name) => {
              const renamed = await run(async () => (await inboxApi.changeInitiative(i.id, { op: 'rename', name })).initiative);
              if (renamed) onChanged();
              return renamed !== null;
            }}
            onDelete={() => void remove(i)}
          />
        ))}
      </ul>
    );
  }
  const words = deleted.length > 0 ? initiativeDeletedToast(deleted) : null;
  const toast: InboxToastModel | null = words ? { id: toastId, icon: 'check', lead: words.lead, detail: words.detail, onUndo: () => void undo(), noKey: true } : null;
  return (
    <Modal label="Initiatives" testId="initiatives" onClose={close} ownKeys fallbackFocus={fallbackFocus} className={`ib-inid${phone ? ' ib-inid-phone' : ''}`}>
      <div className="ib-dlg-in" ref={inner}>
        <div className="ib-dlg-head">
          <h2>Initiatives</h2>
          <button type="button" className="ib-ncd-x" aria-label="Close" onClick={close}>
            <Icon name="x" size={16} />
          </button>
        </div>
        {body}
        <form
          className="ib-inid-add"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <span className="ib-bflt-ico" aria-hidden="true">
            <Icon name="plus" size={14} />
          </span>
          <input
            ref={newField}
            type="text"
            className="ib-inid-in"
            placeholder="New initiative"
            aria-label="New initiative"
            maxLength={INBOX_INITIATIVE_NAME_MAX}
            value={adding}
            onChange={(event) => setAdding(event.target.value)}
            data-initiative-new-name=""
          />
          <button type="submit" className="ib-btn ib-sm" disabled={busy || !adding.trim()} data-initiative-add="">
            Add
          </button>
        </form>
        {error && (
          <p className="ib-error ib-inid-err" role="alert" data-initiative-error="">
            {error}
          </p>
        )}
        <div className="ib-acts-row">
          <button type="button" className="ib-btn ib-pri" onClick={close} data-initiatives-done="">
            Done
          </button>
        </div>
        {/* It never takes focus, as the window's; inside the dialog, so its Undo can be pressed and this live region heard. */}
        <div className="ib-sr" aria-live="polite" data-initiative-live="">
          {words ? `${words.lead} ${words.detail}. Undo is available.` : ''}
        </div>
        {toast && <InboxToast toast={toast} phone={phone} onDismiss={clearToast} onHold={holdToast} />}
      </div>
    </Modal>
  );
}

/** One initiative in the dialog: its name, edited in place, and Delete. */
function InitiativeRow({ initiative, busy, onRename, onDelete }: { initiative: InboxInitiative; busy: boolean; onRename: (name: string) => Promise<boolean>; onDelete: () => void }) {
  const [draft, setDraft] = useState(initiative.name);
  useEffect(() => setDraft(initiative.name), [initiative.name]);
  const commit = async () => {
    const name = draft.replace(/\s+/g, ' ').trim();
    if (!name || name === initiative.name) {
      setDraft(initiative.name);
      return;
    }
    if (!(await onRename(name))) setDraft(initiative.name);
  };
  return (
    <li className="ib-inid-row" data-initiative-row={initiative.id}>
      <span className="ib-bflt-ico" aria-hidden="true">
        <Icon name="hash" size={14} />
      </span>
      <input
        type="text"
        className="ib-inid-in"
        aria-label={`Name of ${initiative.name}`}
        maxLength={INBOX_INITIATIVE_NAME_MAX}
        value={draft}
        dir="auto"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void commit();
          }
        }}
        data-initiative-name=""
      />
      <Tip content="Delete">
        <button
          type="button"
          className="ib-iconbtn ib-inid-del"
          aria-label={`Delete ${initiative.name}`}
          disabled={busy}
          // The second click of a double click would land on the row that moved up under the pointer.
          onClick={(event) => {
            if (event.detail <= 1) onDelete();
          }}
          data-initiative-delete=""
        >
          <Icon name="trash" size={15} />
        </button>
      </Tip>
    </li>
  );
}
