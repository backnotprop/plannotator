import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { INBOX_INITIATIVE_NAME_MAX, type InboxInitiative } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { INITIATIVE_SAVE_FAILED, initiativeRefusal, restoreInitiatives, type InitiativesRestored } from './initiativeUndo';
import { Icon } from '../icons';
import { Tip } from '../components/Tip';
import { InboxToast, type InboxToastModel } from '../components/Toast';
import { Modal } from '../components/Updates';
import { initiativeDeletedToast } from './model';

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
  onChanged: (made?: InboxInitiative) => void;
  onCloseWithUndo?: (deleted: readonly InboxInitiative[]) => void;
  fallbackFocus?: () => HTMLElement | null;
}) {
  const [adding, setAdding] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleted, setDeleted] = useState<readonly InboxInitiative[]>([]);
  const [toastId, setToastId] = useState(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [focusTo, setFocusTo] = useState<{ kind: 'row'; id: string } | { kind: 'new' } | null>(null);
  const newField = useRef<HTMLInputElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusTo) return;
    const at = focusTo.kind === 'new' ? newField.current : inner.current?.querySelector<HTMLElement>(`[data-initiative-row="${focusTo.id}"] [data-initiative-delete]`);
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
    const at = visible.findIndex((other) => other.id === i.id);
    const next = visible[at + 1] ?? visible[at - 1];
    setFocusTo(next ? { kind: 'row', id: next.id } : { kind: 'new' });
    setDeleted((now) => [...now, i]);
    setToastId((id) => id + 1);
    armToast();
    onChanged();
  };
  const undoing = useRef<{ back: readonly InboxInitiative[]; run: Promise<InitiativesRestored> } | null>(null);
  const undo = async () => {
    if (undoing.current) return;
    const back = deleted;
    const run = restoreInitiatives(back);
    undoing.current = { back, run };
    setBusy(true);
    setError(null);
    const { restored, left, line } = await run;
    undoing.current = null;
    setBusy(false);
    setError(line);
    onChanged();
    const settled = new Set(back.filter((i) => !left.some((still) => still.id === i.id)).map((i) => i.id));
    setDeleted((now) => now.filter((i) => !settled.has(i.id)));
    if (left.length > 0) {
      armToast();
      return;
    }
    const last = restored.at(-1);
    setFocusTo(last ? { kind: 'row', id: last.id } : { kind: 'new' });
  };
  const close = () => {
    const running = undoing.current;
    if (running) {
      const others = deleted.filter((i) => !running.back.includes(i));
      void running.run.then(({ left }) => {
        if (left.length + others.length > 0) onCloseWithUndo?.([...left, ...others]);
      });
    } else if (deleted.length > 0) {
      onCloseWithUndo?.(deleted);
    }
    onClose();
  };
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
      setError(initiativeRefusal(cause) ?? INITIATIVE_SAVE_FAILED);
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
        <div className="ib-sr" aria-live="polite" data-initiative-live="">
          {words ? `${words.lead} ${words.detail}. Undo is available.` : ''}
        </div>
        {toast && <InboxToast toast={toast} phone={phone} onDismiss={clearToast} onHold={holdToast} />}
      </div>
    </Modal>
  );
}

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
