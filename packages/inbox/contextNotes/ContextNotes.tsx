import { createContext, Fragment, useCallback, useContext, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pebble } from '@plannotator/ui/components/shape/Pebble';
import type { ContextNoteAnchor } from '@plannotator/review-editor/utils/contextNoteAnchor';
import { noteTime, staleWords, writerWord, type ContextNote } from './model';

export interface ContextNoteActions {
  onAskAgain?: (note: ContextNote) => void;
  onOpenPicture?: (note: ContextNote) => void;
}

interface NotesApi extends ContextNoteActions {
  byId: ReadonlyMap<string, ContextNote>;
  open: ReadonlySet<string>;
  toggle: (id: string) => void;
}

const NotesContext = createContext<NotesApi | null>(null);

export function useContextNotes(notes: readonly ContextNote[], actions: ContextNoteActions) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((id: string) => {
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const byId = useMemo(() => new Map(notes.map((note) => [note.id, note] as const)), [notes]);
  const anchorKey = notes.map((n) => `${n.id}\u0000${n.file}\u0000${n.side}\u0000${n.lineStart}-${n.lineEnd}`).join('\n');
  const anchors = useMemo<ContextNoteAnchor[]>(
    () => notes.map((note) => ({ id: note.id, filePath: note.file, side: note.side, lineStart: note.lineStart, lineEnd: note.lineEnd })),
    [anchorKey], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const api = useMemo<NotesApi>(
    () => ({
      byId,
      open,
      toggle,
      ...(actions.onAskAgain ? { onAskAgain: (note: ContextNote) => actionsRef.current.onAskAgain?.(note) } : {}),
      ...(actions.onOpenPicture ? { onOpenPicture: (note: ContextNote) => actionsRef.current.onOpenPicture?.(note) } : {}),
    }),
    [byId, open, toggle, !!actions.onAskAgain, !!actions.onOpenPicture], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const renderContextNote = useCallback((id: string) => <ContextNoteRow id={id} />, []);
  const show = useCallback((id: string) => {
    setOpen((was) => (was.has(id) ? was : new Set([...was, id])));
    let tries = 0;
    const look = () => {
      const row = document.querySelector<HTMLElement>(`[data-context-note="${CSS.escape(id)}"]`);
      if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      else if (tries++ < 60) setTimeout(look, 100);
    };
    setTimeout(look, 60);
  }, []);
  return { api, anchors, renderContextNote, show };
}

export function ContextNotesProvider({ api, children }: { api: NotesApi; children: ReactNode }) {
  return <NotesContext.Provider value={api}>{children}</NotesContext.Provider>;
}

function Quote({ children }: { children: ReactNode }) {
  return <span className="ib-ctxn-q">“{children}”</span>;
}

function noteByParts(note: ContextNote): ReactNode[] {
  if (note.writer === 'guide') return [<>{note.agent ?? 'The agent'}, in its review</>];
  if (note.writer === 'risk') return note.rule ? [<>your rule <Quote>{note.rule}</Quote></>] : [];
  if (note.writer === 'thread') {
    const time = noteTime(note.at);
    return [...(note.asked ? [<>you asked <Quote>{note.asked}</Quote></>] : []), ...(time ? [time] : [])];
  }
  return note.picture ? [<><Quote>{note.picture.title}</Quote>, {note.picture.part}</>] : [];
}

function NoteByInline({ note }: { note: ContextNote }) {
  const parts = noteByParts(note);
  if (parts.length === 0) return null;
  return (
    <span className="ib-ctxn-by" dir="auto" aria-hidden="true" data-context-note-by="">
      {parts.map((part, i) => (
        <Fragment key={i}>
          {'\u00a0· '}
          {part}
        </Fragment>
      ))}
    </span>
  );
}

function NoteByForReaders({ note }: { note: ContextNote }) {
  const parts = noteByParts(note);
  if (parts.length === 0) return null;
  return (
    <span className="sr-only">
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 ? ' · ' : '· '}
          {part}
        </Fragment>
      ))}
    </span>
  );
}

function RiskGauge() {
  return (
    <svg className="ib-ctxn-risk-mark" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 11.5a5.5 5.5 0 1 1 11 0" />
      <path d="M8 11.5l3-4" />
      <circle cx="8" cy="11.5" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

function NoteHead({ note, open }: { note: ContextNote; open: boolean }) {
  return (
    <span className="ib-ctxn-h">
      {note.writer === 'picture' && <Pebble alive={false} size={12} className="ib-sm-peb ib-ctxn-peb" />}
      {note.writer === 'risk' && <RiskGauge />}
      <b>{writerWord(note)}</b>
      {note.writer === 'risk' && (
        <span className="ib-risk ib-ctxn-risk" data-risk="high">
          High
        </span>
      )}
      {open && <NoteByInline note={note} />}
    </span>
  );
}

function NoteActions({ note, api }: { note: ContextNote; api: NotesApi }) {
  const stale = staleWords(note);
  if (stale) {
    return (
      <div className="ib-ctxn-stale" data-context-note-stale="">
        <span>{stale}</span>
        {note.writer === 'thread' && api.onAskAgain && (
          <button type="button" className="ib-btn ib-ctxn-act" onClick={() => api.onAskAgain?.(note)} data-context-note-ask-again="">
            Ask again
          </button>
        )}
        {note.writer === 'picture' && api.onOpenPicture && (
          <button type="button" className="ib-ctxn-link" onClick={() => api.onOpenPicture?.(note)} data-context-note-open-picture="">
            Open the picture
          </button>
        )}
      </div>
    );
  }
  if (note.writer === 'picture' && api.onOpenPicture) {
    return (
      <div className="ib-ctxn-acts">
        <button type="button" className="ib-ctxn-link" onClick={() => api.onOpenPicture?.(note)} data-context-note-open-picture="">
          Open the picture
        </button>
      </div>
    );
  }
  return null;
}

export function ContextNoteRow({ id }: { id: string }) {
  const api = useContext(NotesContext);
  const bodyId = useId();
  const note = api?.byId.get(id);
  if (!api || !note) return null;
  const open = api.open.has(id);
  return (
    <div
      className="ib-ctxn ib-ctxn-line"
      data-writer={note.writer}
      data-open={open ? '' : undefined}
      data-stale={note.stale ? '' : undefined}
      data-context-note-row={id}
      // A press in a note is the note's: never the diff's line selection under it.
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onMouseUp={(event) => event.stopPropagation()}
    >
      <button type="button" className="ib-ctxn-row" aria-expanded={open} aria-controls={bodyId} onClick={() => api.toggle(id)}>
        <NoteHead note={note} open={open} />
        {!open && (
          <span className="ib-ctxn-first" dir="auto">
            {note.stale ? 'Changed since · ' : ''}
            {note.text}
          </span>
        )}
        <svg className="ib-ctxn-chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path d="M5 6l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div className="ib-ctxn-open" id={bodyId} hidden={!open}>
        {open && (
          <>
            <NoteByForReaders note={note} />
            <p className="ib-ctxn-t" dir="auto">
              {note.text}
            </p>
            <NoteActions note={note} api={api} />
          </>
        )}
      </div>
    </div>
  );
}

export function ContextNoteChip({ file, lines, onOpen }: { file: string; lines: string; onOpen?: () => void }) {
  const name = file.slice(file.lastIndexOf('/') + 1);
  const body = (
    <>
      <span>
        On <span className="ib-ctxn-chip-f">{name}</span> {lines}
      </span>
      {onOpen && <span className="ib-ctxn-chip-go">· Open in the review</span>}
    </>
  );
  return onOpen ? (
    <button type="button" className="ib-ctxn-chip" onClick={onOpen} title={file} data-context-note-chip="">
      {body}
    </button>
  ) : (
    <span className="ib-ctxn-chip" title={file} data-context-note-chip="">
      {body}
    </span>
  );
}
