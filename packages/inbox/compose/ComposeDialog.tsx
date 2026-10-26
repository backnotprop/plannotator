/**
 * Compose: send a new message to a connected agent (approval record
 * "inbox-compose-to-agent", 2026-10-14; variant Compose). A modal dialog
 * pinned to the upper part of the window like the search palette (a
 * full-screen sheet on a phone): To above the message.
 *
 * - A plain New message opens with To EMPTY and focus on To, so the person
 *   picks the agent before writing (the owner: "I keep sending messages to the
 *   wrong agent"). Send says "Choose an agent to send it." until one is picked.
 *   To is filled only where the person already chose: a reopened draft, and
 *   "Message <host>" (the palette, the first-run screen) (`composeOpening`).
 *
 * - Sending needs a live session. With none, Send stays visible but does
 *   nothing except say so, and Save draft is offered.
 * - Closing with words or files asks "Keep draft / Discard", every time
 *   (the owner's answer). Escape asks the same, then a second Escape goes
 *   back to writing. Nothing is saved without the person's choice.
 * - A reopened draft keeps the session it was for, struck through when that
 *   session has ended: it is never re-addressed on its own.
 * - Files: the paperclip, a drop or a paste (paste.ts), uploaded at once (ComposeFiles.tsx).
 */

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { inboxId, type InboxDraftTo } from '@plannotator/core/inbox-types';
import { InboxApiError, inboxApi, type ComposeSessionsModel, type DraftView, type StartThreadInput } from '../api';
import { whenTime } from '../format';
import { HostMark, Icon } from '../icons';
import { ComposeFileTiles, attachedAnnouncement, useComposeFiles } from './ComposeFiles';
import { ToPicker } from './ToPicker';
import { ThreadNameChip } from './ThreadNameChip';
import { useComposeSessions } from './useComposeSessions';
import { InboxComposerField, type CaretMenuOptions } from '../components/ComposerField';
import { Tip } from '../components/Tip';
import { INBOX_MESSAGE_SKILL_AUDIENCE, inboxSkillsBlock, withSkillsBlock } from '../skills';
import {
  NOTHING_SENT_NO_AGENT,
  composeGroups,
  composeTargets,
  draftSnapshot,
  draftThreadName,
  draftTo,
  findTarget,
  hostLabel,
  isDirty,
  composeOpening,
  statusLine,
  sendThreadName,
  suggestThreadName,
  threadNameStateOf,
  type ThreadNameState,
  type ComposeTarget,
} from './model';

/** A phone's picker shows at most 4½ rows of 44 px (the reply box's rule, inbox.css). */
const PHONE_SKILL_LIST_HEIGHT = 198;

export interface ComposeRequest {
  /** A draft to reopen (the Drafts page). */
  draft?: DraftView | null;
  /** Words the message starts with (the tour's suggested request). */
  body?: string;
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

/**
 * Where compose reads and sends (tour v2): the live sessions and the new
 * thread, and whether it keeps drafts and takes files. Absent: the Inbox's own
 * routes, drafts and uploads, exactly as always. The onboarding tour passes
 * one that writes nothing (`drafts: false`: closing asks nothing and Save
 * draft is gone; `uploads: false`: no paperclip, drop or paste).
 */
export interface ComposeTransport {
  sessions: () => Promise<ComposeSessionsModel>;
  startThread: (input: StartThreadInput) => Promise<{ thread_id: string; project?: { id: string; name: string; root: string } }>;
  drafts: boolean;
  uploads: boolean;
}

export interface ComposeDialogProps {
  request: ComposeRequest;
  phone: boolean;
  /** The project the person is looking at: the list's filter, or the open thread's. */
  current: { id: string | null; root: string | null; name: string | null } | null;
  /** The session the person last sent to: listed first in the picker while it is live; never put in To by itself. */
  lastSent: string | null;
  home: string | null;
  onSent: (sent: ComposeSent) => void;
  onSaved: (draft: DraftView) => void;
  onDeleted: (draft: DraftView) => void;
  onClose: () => void;
  transport?: ComposeTransport;
  /**
   * Drawn inside the dialog, after its own content (the tour's coach card): a
   * modal dialog is the top layer, so anything meant to show over it lives in
   * it. Absent: nothing.
   */
  aside?: React.ReactNode;
}

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function ComposeDialog(props: ComposeDialogProps) {
  const { request, phone, current, lastSent, home, transport } = props;
  const keepsDrafts = transport?.drafts ?? true;
  const takesFiles = transport?.uploads ?? true;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const toRef = useRef<HTMLButtonElement>(null);
  const opening = useRef(composeOpening(request)).current;
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const titleId = `ib-cp-title-${uid}`;
  const statusId = `ib-cp-status-${uid}`;

  const [draft, setDraft] = useState<DraftView | null>(request.draft ?? null);
  const [body, setBody] = useState(request.draft?.body ?? request.body ?? '');
  // The thread's name (its chip): follows the message until the person types in it (ThreadNameChip).
  const [nameState, setNameState] = useState<ThreadNameState>(() => threadNameStateOf(request.draft));
  const [chosen, setChosen] = useState<string | null>(opening.chosen);
  // A paste is said in the dialog's own polite region (the window's is outside the modal dialog).
  const [pasteSaid, setPasteSaid] = useState('');
  const files = useComposeFiles(request.draft?.files ?? [], {
    onPasted: (names) => {
      setPasteSaid('');
      setTimeout(() => setPasteSaid(attachedAnnouncement(names)), 30);
    },
  });
  const { model, load } = useComposeSessions(true, transport?.sessions);
  const projects = model?.projects ?? [];
  const target = findTarget(projects, chosen);
  const anyLive = composeTargets(projects).length > 0;
  const groups = useMemo(() => composeGroups(projects, current, lastSent), [projects, current, lastSent]);

  // To is never filled by itself. Focus that started on To moves to the message when the
  // first read finds no live agent (To is then a line of text, not a button).
  useEffect(() => {
    if (!model || anyLive || opening.focus !== 'to') return;
    const dialog = dialogRef.current;
    const active = document.activeElement;
    if (dialog && (!active || active === document.body || active === dialog || !dialog.contains(active))) textRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, anyLive]);

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
  // What is wrong with the name the person typed (409 `thread_name_taken`, or not a valid name): said on the chip until it changes.
  const [nameError, setNameError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<DraftView | null>(null);
  const [busy, setBusy] = useState<null | 'send' | 'save' | 'delete'>(null);
  const [dropping, setDropping] = useState(false);

  // The idempotency key of one Send: new whenever what would be sent changes.
  const sendKey = useRef(crypto.randomUUID());
  const uploadIds = files.uploaded.map((u) => u.upload_id);
  // The chip's suggestion, worked out a moment after typing stops; the same name again changes nothing on screen.
  const fileNames = files.files.map((file) => file.name).join('\n');
  const [suggested, setSuggested] = useState(() => suggestThreadName(body, fileNames ? fileNames.split('\n') : []));
  useEffect(() => {
    const timer = setTimeout(() => setSuggested(suggestThreadName(body, fileNames ? fileNames.split('\n') : [])), 250);
    return () => clearTimeout(timer);
  }, [body, fileNames]);
  const threadName = draftThreadName(nameState);
  useEffect(() => {
    sendKey.current = crypto.randomUUID();
  }, [body, chosen, threadName, nameState.edited ? '' : suggested, uploadIds.join(',')]);
  const draftId = useRef(request.draft?.id ?? inboxId('drf'));

  // Nothing written: no words, no files, no typed thread name. An empty compose is never kept as a draft.
  const empty = body.trim() === '' && files.files.length === 0 && threadName.trim() === '';
  const saved = draftSnapshot(draft);
  const dirty = isDirty({ body, session: chosen, files: uploadIds, threadName }, saved, draft !== null) || files.uploading;
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
    // A plain New message starts on To (empty: the person picks first); a draft or "Message <host>" starts in the message.
    if (opening.focus === 'to' && toRef.current) {
      toRef.current.focus();
      return;
    }
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
    // Something written that was not saved: ask. An empty compose (a draft emptied too) is never kept, so it
    // closes asking nothing; a reopened draft emptied this way stays saved as it was. No drafts (the tour): nothing to ask.
    if (keepsDrafts && dirty && !empty) {
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
    // The chip's suggestion as it would be once typing settles: never one a moment old.
    const named = sendThreadName(nameState, nameState.edited ? '' : suggestThreadName(body, fileNames ? fileNames.split('\n') : []));
    if ('error' in named) {
      setNameError(named.error);
      return;
    }
    setBusy('send');
    try {
      // The skills the words reference go with the message as one block at its end, as New message's do (skills.ts).
      const skills = transport ? null : await inboxSkillsBlock([body], INBOX_MESSAGE_SKILL_AUDIENCE);
      const result = await (transport ? transport.startThread : inboxApi.startThread)({
        to: { host: target.host, session: target.session },
        body: skills ? withSkillsBlock(body, skills) : body,
        idempotency_key: sendKey.current,
        uploads: uploadIds,
        ...named,
        ...(draft ? { draft_id: draft.id } : {}),
      });
      props.onSent({ threadId: result.thread_id, session: target.session, host: target.host, projectName: result.project?.name ?? target.project.name, draftId: draft?.id ?? null });
    } catch (cause) {
      if (cause instanceof InboxApiError && cause.code === 'session_not_live') {
        void load();
        setError('That session is not live any more: nothing was sent. Pick a live session, or save it as a draft.');
      } else if (cause instanceof InboxApiError && cause.code === 'thread_name_taken') {
        setNameError('Another open thread in this project has this name.');
      } else if (cause instanceof InboxApiError && cause.code === 'project_unresolved') {
        // git did not answer in time (#1919): the server's words are for an agent; the person presses Send again.
        setError('Could not tell which project that session works in: git did not answer in time. Nothing was sent; press Send again.');
      } else setError(cause instanceof InboxApiError ? cause.message : 'The message was not sent. Send again to retry.');
    } finally {
      setBusy(null);
    }
  };

  // ── drafts ──
  const save = async (base: string | null = draft?.updated_at ?? null): Promise<DraftView | null> => {
    if (empty) return null;
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
      const result = await inboxApi.saveDraft(draftId.current, { body, to, project, files: uploadIds, base, thread_name: threadName });
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

  // The skill picker's room. A desktop: the whole window (the visual viewport), so the picker floats over
  // everything in the dialog, the footer included, and past the dialog's bottom edge when it needs to; it is
  // in the dialog's top layer and painted after the footer, so nothing covers it. A phone (a full-screen
  // sheet): below its top bar, above its footer and the keyboard.
  const caretMenu = useMemo<CaretMenuOptions>(
    () => ({
      prefer: phone ? 'above' : 'below',
      maxListHeight: phone ? PHONE_SKILL_LIST_HEIGHT : undefined,
      bounds: () => {
        const viewport = window.visualViewport;
        const seen = viewport ? { top: viewport.offsetTop, bottom: viewport.offsetTop + viewport.height } : { top: 0, bottom: window.innerHeight };
        if (!phone) return seen;
        const dialog = dialogRef.current;
        if (!dialog) return null;
        const box = dialog.getBoundingClientRect();
        const bar = dialog.querySelector('.ib-cp-bar')?.getBoundingClientRect();
        const foot = dialog.querySelector('.ib-cp-foot, .ib-cp-ask')?.getBoundingClientRect();
        return { top: Math.max(seen.top, bar ? bar.bottom : box.top), bottom: Math.min(foot ? foot.top : box.bottom, seen.bottom) };
      },
    }),
    [phone],
  );

  // ── keys ──
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    // A key the skill picker took (Escape closing it, Enter on a row) is not the dialog's.
    if (event.nativeEvent.isComposing || event.defaultPrevented) return;
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
  // Save draft only for something written: an empty compose offers none (a phone shows the disabled Send instead).
  const saveOffered = keepsDrafts && !sendable && !loading && !empty;
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
          ref={toRef}
          type="button"
          className="ib-cp-tobtn"
          data-compose-to={target ? target.session : endedNote ? 'ended' : 'choose'}
          aria-haspopup="listbox"
          aria-expanded={picker}
          aria-label={
            target
              ? `To: ${hostLabel(target.host)} in ${target.project.name}. Change`
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
                · <bdi>{target.project.name}</bdi>
              </span>
            </>
          ) : endedNote ? (
            <>
              <HostMark host={endedNote.host} />
              <s>{hostLabel(endedNote.host)}</s>
              <span className="ib-cp-tod">
                ·{' '}
                {endedNote.project_name ? (
                  <>
                    <bdi>{endedNote.project_name}</bdi> ·{' '}
                  </>
                ) : null}
                ended
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
        if (!takesFiles || ![...event.dataTransfer.types].includes('Files')) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDropping(false);
      }}
      // A paste anywhere in the dialog that carries files attaches them; text pastes as text.
      onPaste={(event) => {
        if (takesFiles && files.paste(event)) setError(null);
      }}
      onDrop={(event) => {
        if (!takesFiles || event.dataTransfer.files.length === 0) return;
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
            <button
              type="button"
              className={`ib-cp-barb ib-strong${sendable ? '' : ' ib-dis'}`}
              aria-disabled={!sendable || undefined}
              onClick={() => void send()}
              disabled={busy !== null}
              data-compose-send=""
            >
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
            // Still nobody in To: back on To, where the choice is made.
            (target ? textRef.current : (toRef.current ?? textRef.current))?.focus();
          }}
        />
      )}
      <div className="ib-cp-thread" data-compose-thread-row="">
        <span className="ib-cp-tol">Thread</span>
        <ThreadNameChip
          state={nameState}
          suggested={suggested}
          error={nameError}
          onChange={(next) => {
            setNameState(next);
            setNameError(null);
          }}
          onDone={() => textRef.current?.focus()}
          onOverflow={(text) => {
            setBody((current) => (current.trim() ? `${current.replace(/\s+$/, '')}${/[\r\n]/.test(text) ? '\n' : ' '}${text}` : text));
            setError(null);
            // Dictation goes on in the message from here.
            requestAnimationFrame(() => {
              const area = textRef.current;
              if (!area) return;
              area.focus();
              area.setSelectionRange(area.value.length, area.value.length);
            });
          }}
          idBase={`ib-cp-tname-${uid}`}
        />
      </div>
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
        {/* The Inbox's composer field (#1914): the / and $ skill picker; the Send composes the block. */}
        <div className="ib-cp-field" data-compose-text="">
          <InboxComposerField
            textareaRef={textRef}
            ariaLabel="Message"
            ariaDescribedBy={statusId}
            destination="your message"
            placeholder="Write an idea or a request. It starts a new thread."
            // The field is tall and sits in a scrolling body above the footer: the picker opens at the
            // caret, inside the dialog and above its footer, and Escape closes it before the dialog.
            caretMenu={caretMenu}
            escapeClosesMenu
            value={body}
            onChange={(value) => {
              setBody(value);
              if (error) setError(null);
            }}
          />
        </div>
        <ComposeFileTiles
          files={files.files}
          onRemove={(key) => {
            files.remove(key);
            // The × goes with its tile: focus stays in the dialog, in the message.
            textRef.current?.focus();
          }}
        />
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
                  setNameState(threadNameStateOf(conflict));
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
          {takesFiles ? (
            <Tip content="Attach files">
              <label className="ib-cp-clip" aria-label="Attach files">
                <Icon name="clip" size={17} />
                <input
                  type="file"
                  multiple
                  className="ib-sr"
                  data-compose-attach=""
                  // A phone's picker offers the photo library and Files (iOS gives no Paste for a picture in a text
                  // field); what it hands over is named as a paste is (`image.jpg` -> `pasted-image-<stamp>.jpg`).
                  accept={phone ? 'image/*,*/*' : undefined}
                  onChange={(event) => {
                    if (event.target.files) (phone ? files.attach : files.add)(event.target.files);
                    event.target.value = '';
                  }}
                />
              </label>
            </Tip>
          ) : (
            <Tip content="Files: not in the tour">
              <span className="ib-cp-clip" role="img" aria-label="Files: not in the tour" aria-disabled="true" data-compose-attach-off="">
                <Icon name="clip" size={17} />
              </span>
            </Tip>
          )}
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
      <div className="ib-sr" aria-live="polite" data-compose-paste-live="">
        {pasteSaid}
      </div>
      {props.aside}
      {dropping && (
        <div className="ib-cp-drop" aria-hidden="true">
          <Icon name="clip" size={20} />
          Drop files to attach
        </div>
      )}
    </dialog>
  );
}
