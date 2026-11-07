/**
 * Context notes, take Line (approval "inbox-context-notes"): each note is one
 * row under its lines, the writer in words (a Picture also Show me's Pebble) and the first
 * words; a click (or Enter / Space: it is a button) opens it in place. A note
 * has no reply, edit, count or Post. A stale one is grey and says the code
 * changed, with Ask again, as Show me's corner card does.
 *
 * The diff draws the rows through review-editor's `contextNotes` seam: the
 * reader gets the anchors and `renderContextNote(id)`, which draws a row that
 * reads its note from this module's context, so a note that opens, moves or
 * goes stale redraws without the diff rebuilding.
 */
import { createContext, useCallback, useContext, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pebble } from '@plannotator/ui/components/shape/Pebble';
import type { ContextNoteAnchor } from '@plannotator/review-editor/components/AllFilesCodeView';
import { noteTime, staleWords, writerWord, type ContextNote } from './model';

/** What a host does for a note's actions. Absent: that action is not offered. */
export interface ContextNoteActions {
  /** A stale answer: ask about these lines again (the Ask window, its box filled). */
  onAskAgain?: (note: ContextNote) => void;
  /** A picture's note: open its board over the review. */
  onOpenPicture?: (note: ContextNote) => void;
}

interface NotesApi extends ContextNoteActions {
  byId: ReadonlyMap<string, ContextNote>;
  open: ReadonlySet<string>;
  toggle: (id: string) => void;
}

const NotesContext = createContext<NotesApi | null>(null);

/** The host's notes and the state of each row; `renderContextNote` and `anchors` go to the reader. */
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
  // The anchors are kept by identity while the places are the same, so the diff republishes only what moved.
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
  /** Open a note and bring its row into view (it may still be drawing: a file that just opened, a chapter scrolled to). */
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

/**
 * Who wrote the note and why it is there, in words: what the open note says after the writer. Only the approved
 * words: a risk place with no rule of the person's, or an answer to nothing the person said, says nothing more
 * (an answer still says when it came); nothing at all draws no line.
 */
function NoteBy({ note }: { note: ContextNote }) {
  const time = note.writer === 'thread' ? noteTime(note.at) : null;
  const words =
    note.writer === 'guide' ? (
      <>· {note.agent ?? 'The agent'}, in its review</>
    ) : note.writer === 'risk' ? (
      note.rule ? (
        <>
          · your rule <Quote>{note.rule}</Quote>
        </>
      ) : null
    ) : note.writer === 'thread' ? (
      note.asked || time ? (
        <>
          {note.asked && (
            <>
              · you asked <Quote>{note.asked}</Quote>
            </>
          )}
          {time ? `${note.asked ? ' ' : ''}· ${time}` : ''}
        </>
      ) : null
    ) : note.picture ? (
      <>
        · <Quote>{note.picture.title}</Quote>, {note.picture.part}
      </>
    ) : null;
  if (!words) return null;
  return (
    <span className="ib-ctxn-by" dir="auto">
      {words}
    </span>
  );
}

/**
 * The writer's name starts the row (the owner, q-9ad31b4e: no mark, only the writer's name). Only a Picture keeps
 * Show me's mark: it comes from a board, and that mark is drawing's and the board's. Risk has no mark yet.
 */
function NoteHead({ note }: { note: ContextNote }) {
  return (
    <span className="ib-ctxn-h">
      {note.writer === 'picture' && <Pebble alive={false} size={12} className="ib-sm-peb ib-ctxn-peb" />}
      <b>{writerWord(note)}</b>
      {note.writer === 'risk' && (
        <span className="ib-risk ib-ctxn-risk" data-risk="high">
          High
        </span>
      )}
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

/** One note's row under its lines: the writer and its first words; open, all of it. */
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
        <NoteHead note={note} />
        <span className="ib-ctxn-first" dir="auto">
          {note.stale ? 'Changed since · ' : ''}
          {note.text}
        </span>
        <svg className="ib-ctxn-chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path d="M5 6l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div className="ib-ctxn-open" id={bodyId} hidden={!open}>
        {open && (
          <>
            <NoteBy note={note} />
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

/** The thread's chip for a `:::note` block: where it is pinned, and the way to it. */
export function ContextNoteChip({ file, lines, onOpen }: { file: string; lines: string; onOpen?: () => void }) {
  const name = file.slice(file.lastIndexOf('/') + 1);
  // An answer's chip: no mark, as its row has none (q-9ad31b4e).
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
