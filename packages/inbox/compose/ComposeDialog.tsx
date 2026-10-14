/**
 * Compose: send a new message to a connected agent (approval record
 * "inbox-compose-to-agent", 2026-10-14; variant Compose). A modal dialog
 * pinned to the upper part of the window like the search palette (a
 * full-screen sheet on a phone): To, prefilled, above the message.
 *
 * - Sending needs a live session. With none, Send stays visible but does
 *   nothing except say so, and Save draft is offered.
 * - Closing with words or files asks "Keep draft / Discard", every time
 *   (the owner's answer). Escape asks the same, then a second Escape goes
 *   back to writing. Nothing is saved without the person's choice.
 * - A reopened draft keeps the session it was for, struck through when that
 *   session has ended: it is never re-addressed on its own.
 * - Files: the paperclip or a drop, uploaded at once (ComposeFiles.tsx).
 */

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { inboxId, type InboxDraftTo } from '@plannotator/core/inbox-types';
import { InboxApiError, inboxApi, type DraftView } from '../api';
import { whenTime } from '../format';
import { HostMark, Icon } from '../icons';
import { ComposeFileTiles, useComposeFiles } from './ComposeFiles';
import { ToPicker } from './ToPicker';
import { useComposeSessions } from './useComposeSessions';
import {
  NOTHING_SENT_NO_AGENT,
  busyWord,
  composeGroups,
  composeTargets,
  draftSnapshot,
  draftTo,
  findTarget,
  hostLabel,
  isDirty,
  preselect,
  statusLine,
  subjectPreview,
  type ComposeTarget,
} from './model';

export interface ComposeRequest {
  /** A draft to reopen (the Drafts page). */
  draft?: DraftView | null;
  /** A session to put in To (the palette's "Message <host> in <project>"). */
  session?: string | null;
}

export interface ComposeSent {
  threadId: string;
  session: string;
  host: string;
  projectName: string;
  /** The draft it was sent from (it is deleted with the Send), or null. */
  draftId: string | null;
}

export interface ComposeDialogProps {
  request: ComposeRequest;
  phone: boolean;
  /** The project the person is looking at: the list's filter, or the open thread's. */
  current: { id: string | null; root: string | null; name: string | null } | null;
  /** The session the person last sent to: preselected while it is live. */
  lastSent: string | null;
  home: string | null;
  onSent: (sent: ComposeSent) => void;
  onSaved: (draft: DraftView) => void;
  onDeleted: (draft: DraftView) => void;
  onClose: () => void;
}

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function ComposeDialog(props: ComposeDialogProps) {
  const { request, phone, current, lastSent, home } = props;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const titleId = `ib-cp-title-${uid}`;
  const statusId = `ib-cp-status-${uid}`;

  const [draft, setDraft] = useState<DraftView | null>(request.draft ?? null);
  const [body, setBody] = useState(request.draft?.body ?? '');
  const [chosen, setChosen] = useState<string | null>(request.draft ? (request.draft.to?.session ?? null) : (request.session ?? null));
  const files = useComposeFiles(request.draft?.files ?? []);
  const { model, load } = useComposeSessions(true);
  const projects = model?.projects ?? [];
  const target = findTarget(projects, chosen);
  const anyLive = composeTargets(projects).length > 0;
  const groups = useMemo(() => composeGroups(projects, current), [projects, current]);

  // Preselect once the sessions are first read, unless To was set (a draft keeps its own, even an ended one).
  const preselected = useRef(chosen !== null);
  useEffect(() => {
    if (!model || preselected.current) return;
    preselected.current = true;
    const pick = preselect(model.projects, { last: lastSent, current });
    if (pick) setChosen(pick.session);
    // Once, at the first read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  // A draft's chosen session that is not live: struck through, never re-addressed on its own.
  const endedTo: InboxDraftTo | null = model && chosen && !target && draft?.to?.session === chosen ? draft.to : null;
  // A session picked in this dialog that stopped polling meanwhile.
  const [lost, setLost] = useState<ComposeTarget | null>(null);
  const lastTarget = useRef<ComposeTarget | null>(null);
  useEffect(() => {
    if (target) {
      lastTarget.current = target;
      setLost(null);
    } else if (model && chosen && lastTarget.current?.session === chosen) setLost(lastTarget.current);
  }, [target, model, chosen]);

  const [picker, setPicker] = useState(false);
  const [question, setQuestion] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<DraftView | null>(null);
  const [busy, setBusy] = useState<null | 'send' | 'save' | 'delete'>(null);
  const [dropping, setDropping] = useState(false);

  // The idempotency key of one Send: new whenever what would be sent changes.
  const sendKey = useRef(crypto.randomUUID());
  const uploadIds = files.uploaded.map((u) => u.upload_id);
  useEffect(() => {
    sendKey.current = crypto.randomUUID();
  }, [body, chosen, uploadIds.join(',')]);
  const draftId = useRef(request.draft?.id ?? inboxId('drf'));

  const saved = draftSnapshot(draft);
  const dirty = isDirty({ body, session: chosen, files: uploadIds }, saved, draft !== null) || files.uploading;
  const subject = subjectPreview(body);
  const projectName = current?.name ?? null;

  // ── the dialog ──
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') {
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute('open', '');
      }
    } else dialog.setAttribute('open', '');
    const text = textRef.current;
    if (text) {
      text.focus();
      text.setSelectionRange(text.value.length, text.value.length);
    }
  }, []);

  const requestClose = () => {
    if (picker) {
      setPicker(false);
      return;
    }
    if (question) {
      setQuestion(false);
      textRef.current?.focus();
      return;
    }
    if (dirty) {
      setQuestion(true);
      return;
    }
    props.onClose();
  };

  // ── sending ──
  const send = async () => {
    // Still reading the live sessions: nothing to say yet, the status line says it.
    if (busy || !model) return;
    setError(null);
    if (!target) {
      // The error is an alert, which says it: no second announcement.
      setError(anyLive ? 'Nothing sent: choose a live agent first.' : NOTHING_SENT_NO_AGENT);
      return;
    }
    if (!body.trim()) {
      setError('Write a message first.');
      textRef.current?.focus();
      return;
    }
    if (files.uploading) {
      setError('Wait for the files to finish uploading.');
      return;
    }
    setBusy('send');
    try {
      const result = await inboxApi.startThread({
        to: { host: target.host, session: target.session },
        body,
        idempotency_key: sendKey.current,
        uploads: uploadIds,
        ...(draft ? { draft_id: draft.id } : {}),
      });
      props.onSent({ threadId: result.thread_id, session: target.session, host: target.host, projectName: result.project?.name ?? target.project.name, draftId: draft?.id ?? null });
    } catch (cause) {
      if (cause instanceof InboxApiError && cause.code === 'session_not_live') {
        void load();
        setError('That session is not live any more: nothing was sent. Pick a live session, or save it as a draft.');
      } else setError(cause instanceof InboxApiError ? cause.message : 'The message was not sent. Send again to retry.');
    } finally {
      setBusy(null);
    }
  };

  // ── drafts ──
  const save = async (base: string | null = draft?.updated_at ?? null): Promise<DraftView | null> => {
    if (files.uploading) {
      setError('Wait for the files to finish uploading.');
      return null;
    }
    setBusy('save');
    setError(null);
    try {
      const to = target ? draftTo(target) : chosen && draft?.to?.session === chosen ? draft.to : null;
      const project = target
        ? { id: target.project.id, root: target.project.root, name: target.project.name }
        : (draft?.project ?? (current?.root ? { id: current.id, root: current.root, name: current.name ?? current.root } : null));
      const result = await inboxApi.saveDraft(draftId.current, { body, to, project, files: uploadIds, base });
      setDraft(result.draft);
      setConflict(null);
      return result.draft;
    } catch (cause) {
      if (cause instanceof InboxApiError && cause.code === 'draft_conflict') {
        try {
          const newer = (await inboxApi.drafts()).drafts.find((d) => d.id === draftId.current) ?? null;
          setConflict(newer);
          setError(newer ? 'This draft changed in another window since you opened it.' : 'This draft was deleted in another window.');
        } catch {
          setError('This draft changed in another window.');
        }
      } else setError(cause instanceof InboxApiError ? cause.message : 'The draft was not saved.');
      return null;
    } finally {
      setBusy(null);
    }
  };

  const keepDraft = async () => {
    const result = await save(conflict ? conflict.updated_at : (draft?.updated_at ?? null));
    if (result) props.onSaved(result);
    else setQuestion(false);
  };

  const deleteDraft = async () => {
    if (!draft) return;
    setBusy('delete');
    try {
      await inboxApi.deleteDraft(draft.id);
      props.onDeleted(draft);
    } catch (cause) {
      setError(cause instanceof InboxApiError ? cause.message : 'The draft was not deleted.');
    } finally {
      setBusy(null);
    }
  };

  // ── keys ──
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      // Never the window's Escape (it would close the thread under the dialog).
      event.preventDefault();
      event.stopPropagation();
      requestClose();
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !question) {
      event.preventDefault();
      void send();
    }
  };

  const sendable = !!target;
  // While the sessions are read, neither Save draft nor a dead To: a neutral "Looking…" state.
  const loading = !model;
  const saveOffered = !sendable && !loading;
  const title = draft ? 'Draft' : 'New message';
  const status = statusLine({ target, anyLive, ended: endedTo, projectName: target?.project.name ?? projectName, loading: loading && !target });
  const endedNote = endedTo ?? (lost && !target ? { host: lost.host, session: lost.session, project_root: lost.project.root, project_name: lost.project.name, started_at: lost.started_at } : null);

  const toRow = (
    <div className="ib-cp-to">
      <span className="ib-cp-tol">To</span>
      {model && !anyLive && !endedNote ? (
        <span className="ib-cp-none-to" data-compose-to="none">
          <Icon name="info" size={15} />
          No agent is running
        </span>
      ) : (
        <button
          type="button"
          className="ib-cp-tobtn"
          data-compose-to={target ? target.session : endedNote ? 'ended' : 'choose'}
          aria-haspopup="listbox"
          aria-expanded={picker}
          aria-label={
            target
              ? `To: ${hostLabel(target.host)} in ${target.project.name}, ${busyWord(target).toLowerCase()}. Change`
              : endedNote
                ? `To: ${hostLabel(endedNote.host)}, ended. Pick a session`
                : loading
                  ? 'To: looking for live agents'
                  : 'To: choose an agent'
          }
          aria-disabled={loading || undefined}
          data-loading={loading ? '' : undefined}
          // Focusable while the sessions are read (Tab still reaches it); it opens once they are.
          onClick={() => !loading && setPicker((open) => !open)}
          disabled={!loading && !anyLive && !endedNote}
        >
          {target ? (
            <>
              <HostMark host={target.host} />
              <b>{hostLabel(target.host)}</b>
              <span className="ib-cp-tod">
                in <bdi>{target.project.name}</bdi> · started {whenTime(target.started_at)} · {busyWord(target).toLowerCase()}
              </span>
            </>
          ) : endedNote ? (
            <>
              <HostMark host={endedNote.host} />
              <s>{hostLabel(endedNote.host)}</s>
              <span className="ib-cp-tod">
                {endedNote.project_name ? (
                  <>
                    in <bdi>{endedNote.project_name}</bdi> ·{' '}
                  </>
                ) : null}
                {endedNote.started_at ? `started ${whenTime(endedNote.started_at)} · ` : ''}ended
              </span>
            </>
          ) : (
            <span className="ib-cp-tod">{model ? 'Choose an agent' : 'Looking for live agents…'}</span>
          )}
          <Icon name="chevD" size={15} />
        </button>
      )}
      {draft && !phone && <span className="ib-cp-dsaved">Draft · saved {whenTime(draft.updated_at)}</span>}
    </div>
  );

  return (
    <dialog
      ref={dialogRef}
      className="ib-cp"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-compose=""
      data-phone={phone ? '' : undefined}
      onKeyDown={onKeyDown}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onClick={(event) => {
        const dialog = dialogRef.current;
        if (!dialog || event.target !== dialog) return;
        const r = dialog.getBoundingClientRect();
        if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) requestClose();
      }}
      onDragOver={(event) => {
        if (![...event.dataTransfer.types].includes('Files')) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDropping(false);
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        setDropping(false);
        files.add(event.dataTransfer.files);
      }}
    >
      {phone ? (
        <div className="ib-cp-bar">
          <button type="button" className="ib-cp-barb" onClick={requestClose} data-compose-cancel="">
            Cancel
          </button>
          <h2 id={titleId}>{title}</h2>
          {saveOffered ? (
            <button type="button" className="ib-cp-barb ib-strong" onClick={() => void keepDraft()} disabled={busy !== null} data-compose-save="">
              Save draft
            </button>
          ) : (
            <button type="button" className="ib-cp-barb ib-strong" onClick={() => void send()} disabled={busy !== null} data-compose-send="">
              Send
            </button>
          )}
        </div>
      ) : (
        <h2 id={titleId} className="ib-sr">
          {title}
        </h2>
      )}
      {toRow}
      {picker && (
        <ToPicker
          groups={groups}
          selected={target?.session ?? null}
          home={home}
          phone={phone}
          onPick={(picked) => {
            setChosen(picked.session);
            setPicker(false);
            setError(null);
            textRef.current?.focus();
          }}
          onClose={() => {
            setPicker(false);
            textRef.current?.focus();
          }}
        />
      )}
      {model && !anyLive && !endedNote && (
        <div className="ib-cp-note" data-compose-note="none">
          <Icon name="info" size={16} />
          <div>
            <b>No agent is running{projectName ? ` in ${projectName}` : ''}.</b>
            <p>Nothing can be sent until one is. Save it as a draft; it waits under Drafts, and you send it when Claude Code, Pi or OpenCode is running.</p>
          </div>
        </div>
      )}
      {endedNote && !target && (
        <div className="ib-cp-note ib-warn" data-compose-note="ended">
          <Icon name="warn" size={16} />
          <div>
            <b>The {hostLabel(endedNote.host)} session this {draft ? 'draft' : 'message'} was for has ended.</b>
            <p>
              {endedNote.project_name ? `It was in ${endedNote.project_name}` : 'It'}
              {endedNote.started_at ? `, started ${whenTime(endedNote.started_at)}` : ''}. Pick a live session to send it, or keep it as a draft.
            </p>
            {anyLive && (
              <button type="button" className="ib-btn ib-sm" onClick={() => setPicker(true)} data-compose-pick="">
                Pick a session
              </button>
            )}
          </div>
        </div>
      )}
      <div className="ib-cp-body">
        <textarea
          ref={textRef}
          className="ib-cp-text"
          aria-label="Message"
          aria-describedby={statusId}
          placeholder="Write an idea or a request. It starts a new thread."
          value={body}
          onChange={(event) => {
            setBody(event.target.value);
            if (error) setError(null);
          }}
          data-compose-text=""
        />
        <ComposeFileTiles
          files={files.files}
          onRemove={(key) => {
            files.remove(key);
            // The × goes with its tile: focus stays in the dialog, in the message.
            textRef.current?.focus();
          }}
        />
        {subject && (
          <div className="ib-cp-subj" data-compose-subject="">
            New thread: <b dir="auto">{subject}</b>
          </div>
        )}
      </div>
      {error && (
        <div className="ib-cp-error" role="alert" data-compose-error="">
          {error}
          {conflict && (
            <span className="ib-cp-conflict">
              <button type="button" className="ib-lnk" onClick={() => void keepDraft()}>
                Keep mine
              </button>
              <button
                type="button"
                className="ib-lnk"
                onClick={() => {
                  setDraft(conflict);
                  setBody(conflict.body);
                  setChosen(conflict.to?.session ?? null);
                  setConflict(null);
                  setError(null);
                }}
              >
                Use the other
              </button>
            </span>
          )}
        </div>
      )}
      {question ? (
        <div className="ib-cp-ask" role="alertdialog" aria-labelledby={`${titleId}-ask`} data-compose-question="">
          <span id={`${titleId}-ask`}>{draft ? 'Keep your changes to this draft?' : 'Keep this message as a draft?'}</span>
          <span className="ib-sp" />
          <button type="button" className="ib-btn ib-ghost" onClick={() => setQuestion(false)}>
            Keep writing
          </button>
          <button type="button" className="ib-btn" onClick={props.onClose} data-compose-discard="">
            Discard
          </button>
          <button type="button" className="ib-btn ib-pri" onClick={() => void keepDraft()} disabled={busy !== null} data-compose-keep="" autoFocus>
            Keep draft
          </button>
        </div>
      ) : (
        <div className="ib-cp-foot">
          <label className="ib-cp-clip" title="Attach files" aria-label="Attach files">
            <Icon name="clip" size={17} />
            <input
              type="file"
              multiple
              className="ib-sr"
              data-compose-attach=""
              onChange={(event) => {
                if (event.target.files) files.add(event.target.files);
                event.target.value = '';
              }}
            />
          </label>
          {/* On a desktop the To line already says "Draft · saved". */}
          {draft && !dirty && phone && (
            <span className="ib-cp-savedline" data-compose-saved="">
              <Icon name="check" size={14} />
              Saved as a draft {whenTime(draft.updated_at)}
            </span>
          )}
          {draft && (
            <button type="button" className="ib-cp-del" onClick={() => void deleteDraft()} disabled={busy !== null} data-compose-delete="">
              Delete draft
            </button>
          )}
          <span className="ib-sp" />
          <span className="ib-cp-status" id={statusId} data-compose-status="">
            {status}
          </span>
          {saveOffered && !phone && (
            <button type="button" className="ib-btn" onClick={() => void keepDraft()} disabled={busy !== null} data-compose-save="">
              Save draft
            </button>
          )}
          {!phone && (
            <button
              type="button"
              className={`ib-btn ib-pri${sendable ? '' : ' ib-dis'}`}
              aria-disabled={!sendable || undefined}
              aria-keyshortcuts={isMac() ? 'Meta+Enter' : 'Control+Enter'}
              onClick={() => void send()}
              disabled={busy !== null}
              data-compose-send=""
            >
              <Icon name="send" size={15} />
              Send
              <kbd className="ib-kbd" aria-hidden="true">
                {isMac() ? '⌘↵' : 'Ctrl ↵'}
              </kbd>
            </button>
          )}
        </div>
      )}
      {dropping && (
        <div className="ib-cp-drop" aria-hidden="true">
          <Icon name="clip" size={20} />
          Drop files to attach
        </div>
      )}
    </dialog>
  );
}
