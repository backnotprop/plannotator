/**
 * A floating draft's window (approval "inbox-reply-floaters"): the thread's own reply draft (`useReplyDraft`) in
 * T6's box (approval "inbox-reply-box"): the words, then T6's row (ReplyRow.tsx) with Send, the paperclip, Skills,
 * the mic and the bin. It keeps no words of its own.
 *
 * - A computer: Ask's own window (`ChatFrame`), so it moves by its header, resizes by its corner grip and goes full
 *   screen exactly as Ask does. No "Draft · Saved · Discard" line: the box saves quietly and the bin discards; only
 *   "Not saved …" shows, over the row, as in the thread.
 * - A phone: the whole screen, T6's phone row (no bin) and T6's Draft line above the box, which keeps Discard.
 * - ⌘↵ sends (the thread box's own key). No Escape: Ask's window takes none (AskChat.tsx), and this is Ask's window.
 *
 * Send here is the plain case: words and files, to the message the words answer, in a thread with one agent. A
 * thread holding picks or comments, a chosen recipient, several agents or a hand-off, or whose agent has ended,
 * hands over to the thread ("Open to send"), whose Send knows how to carry them.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { InboxDraftFile, InboxMessageWire, InboxReplyDraftRow, InboxThread } from '@plannotator/core/inbox-types';
import type { ReplyDraftFileRef } from '@plannotator/core/inbox-reply-draft';
import { ChatFrame, type ChatWindowStore } from '@plannotator/ui/components/chat';
import { fetchSkillCatalog, getCachedSkillCatalog } from '@plannotator/ui/utils/skillCatalog';
import { inboxApi } from '../api';
import { AttachFilesButton, ComposeFileTiles, attachedAnnouncement, pastedSignature, useComposeFiles, useFileDrop } from '../compose/ComposeFiles';
import { InboxComposerField } from '../components/ComposerField';
import { conflictText, DraftHead, DraftStamp } from '../components/DraftLabel';
import { ReplyRow } from '../components/ReplyRow';
import { Tip } from '../components/Tip';
import { VoiceMicButton, VoiceStatusLine } from '../components/VoiceMic';
import { Icon } from '../icons';
import { landInReplyDraft, replySendStarts, useReplyDraft, type ReplyBoxTook } from '../replyDraft';
import { tookOverReply, wordsMessage } from '../sendTargets';
import { inboxThreadShortcuts } from '../shortcuts';
import { useShortcutAria } from '../shortcuts/hint';
import { INBOX_REPLY_SKILL_AUDIENCE, inboxSkillFilter, inboxSkillsBlock, withSkillsBlock } from '../skills';
import { activeHandoff, threadParticipants } from '../tags';
import { errorText } from '../toastError';
import { useVoiceSession } from '../voice';
import { floaterName, onFloaterEvent, peekText } from './model';
import { quoteLineText, quoteToSend } from '../replyQuote';
import { whenTime } from '../format';

const NO_UPLOADS: readonly InboxDraftFile[] = [];
/** How long the press waits to learn whether the agent ended (as the thread's Send does). */
const ENDED_READ_MS = 5_000;

/** Picks, comments and action items waiting in the thread: only the thread's Send carries them. */
export function carriedCount(row: InboxReplyDraftRow): number {
  return (row.unsent?.picks ?? 0) + (row.unsent?.comments ?? 0) + (row.unsent?.done ?? 0) + (row.unsent?.cant ?? 0);
}

/**
 * Whether this window's Send can carry the reply, or the thread must (its recipient pill, route choice and
 * hand-offs live there): one agent, no hand-off, no recipient chosen, nothing but words and files.
 */
export function sendsHere(thread: InboxThread | null, row: InboxReplyDraftRow, recipients: readonly string[] | undefined): boolean {
  if (carriedCount(row) > 0 || (recipients?.length ?? 0) > 0) return false;
  if (!thread) return true;
  return threadParticipants(thread).length <= 1 && activeHandoff(thread) === null && tookOverReply(thread) === null;
}

export interface FloaterBoxProps {
  row: InboxReplyDraftRow;
  phone: boolean;
  /** A computer: the draft window's store (Ask's ChatWindowStore class), so a size the person dragged holds. */
  frame: ChatWindowStore;
  /** Take focus when it opens (a person's press). */
  takeFocus: boolean;
  onMinimize: () => void;
  /** × : it stops floating and stays in Drafts. */
  onPutAway: () => void;
  onOpenThread: () => void;
  onSent: (agent: string) => void;
  /** Discarded; the words and files, for Undo. */
  onDiscarded: (words: string, files: readonly ReplyDraftFileRef[]) => void;
  /** Sent or discarded in another window. */
  onGone: () => void;
}

export function FloaterBox({ row, phone, frame, takeFocus, onMinimize, onPutAway, onOpenThread, onSent, onDiscarded, onGone }: FloaterBoxProps) {
  const threadId = row.thread_id;
  const [text, setText] = useState('');
  const textRef = useRef('');
  textRef.current = text;
  /** The bin was pressed: nothing this window still holds is saved again (no upload lands, no tile saves). */
  const discarded = useRef(false);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const [said, setSaid] = useState('');
  const takeFiles = useRef<(threadId: string, draft: { files?: readonly InboxDraftFile[] }, wanted: readonly string[]) => void>(() => {});
  const takeWords = useRef<(threadId: string, draft: { body: string; files?: readonly InboxDraftFile[] }, was: string) => ReplyBoxTook>(() => 'hidden');
  const draft = useReplyDraft(threadId, {
    onFiles: (id, saved, wanted) => takeFiles.current(id, saved, wanted),
    onWords: (id, saved, was) => takeWords.current(id, saved, was),
  });
  const files = useComposeFiles(NO_UPLOADS, {
    onPasted: (names) => setSaid(attachedAnnouncement(names)),
    text: {
      get value() {
        return textRef.current;
      },
      set: (next) => change(next),
    },
    onUnmountUploads: (uploads) => {
      // Discarded: what still uploads joins no draft (the bin threw the reply away).
      if (discarded.current) return;
      for (const upload of uploads) void landInReplyDraft(threadId, upload);
    },
  });
  const filesSaved = useRef('');
  const voice = useVoiceSession();
  // The window shows only while its store is not minimized: this box opening is the window opening.
  useLayoutEffect(() => {
    if (!phone) frame.setMinimized(false);
  }, [frame, phone]);

  function change(next: string) {
    // Before the draft's read lands the field is read-only: words typed then would be overwritten by the read.
    if (!loaded.current || discarded.current) return;
    setText(next);
    textRef.current = next;
    files.follow();
    const list = files.draftFiles(next);
    filesSaved.current = pastedSignature(list);
    draft.save(next, list);
  }

  // The draft's words and tiles come in once, when its read lands. Until then the field takes no typing.
  const loaded = useRef(false);
  const ready = draft.loadedFor === threadId;
  useLayoutEffect(() => {
    if (fieldRef.current) fieldRef.current.readOnly = !ready;
  });
  useEffect(() => {
    if (loaded.current || draft.loadedFor !== threadId) return;
    loaded.current = true;
    const body = draft.conflict ?? draft.draft?.body ?? '';
    setText(body);
    textRef.current = body;
    const kept = draft.draft?.files ?? [];
    if (kept.length > 0) {
      files.restoreDraft(kept, body, 'replace', []);
      filesSaved.current = pastedSignature(files.draftFiles());
      draft.boxTook(threadId, kept.map((file) => file.upload_id));
    }
    if (takeFocus) {
      requestAnimationFrame(() => {
        const field = fieldRef.current;
        field?.focus({ preventScroll: true });
        field?.setSelectionRange(body.length, body.length);
      });
    }
    // Read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.loadedFor]);

  // A tile finished or was removed: the draft keeps it.
  const signature = pastedSignature(files.draftFiles());
  useEffect(() => {
    if (!loaded.current || discarded.current || signature === filesSaved.current) return;
    filesSaved.current = signature;
    draft.save(textRef.current, files.draftFiles(textRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  takeWords.current = (id, saved, was) => {
    if (id !== threadId) return 'hidden';
    if (textRef.current !== was) return 'differs';
    setText(saved.body);
    textRef.current = saved.body;
    setSaid('This reply changed in another window.');
    return 'took';
  };
  takeFiles.current = (id, saved, wanted) => {
    if (id !== threadId) return;
    const want = new Set(wanted);
    const now = files.draftFiles(textRef.current).map((file) => file.upload_id);
    if (now.length === want.size && now.every((upload) => want.has(upload))) return;
    files.restoreDraft((saved.files ?? []).filter((file) => want.has(file.upload_id)), textRef.current, 'replace', wanted);
    filesSaved.current = pastedSignature(files.draftFiles());
    draft.boxTook(id, files.draftFiles().map((file) => file.upload_id));
  };

  // The thread as it is now: who the words go to, and what the agent last said.
  const [thread, setThread] = useState<InboxThread | null>(null);
  const firstLatest = useRef<string | null>(null);
  const [fresh, setFresh] = useState(false);
  const [peekOpen, setPeekOpen] = useState(false);
  const readThread = useCallback(() => {
    void inboxApi.thread(threadId).then(
      (model) => setThread(model.thread),
      () => {},
    );
  }, [threadId]);
  useEffect(readThread, [readThread]);
  const latest: InboxMessageWire | null = thread ? wordsMessage(thread) : null;
  useEffect(() => {
    if (!latest) return;
    if (firstLatest.current === null) firstLatest.current = latest.id;
    else if (firstLatest.current !== latest.id && latest.author.kind === 'agent') {
      setFresh(true);
      setSaid(`${latest.author.name ?? 'The agent'} wrote in this thread.`);
    }
  }, [latest?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Another window, a phone, or an agent.
  useEffect(
    () =>
      onFloaterEvent((kind, changed) => {
        if (kind === 'record') {
          readThread();
          return;
        }
        if (changed !== threadId) return;
        void draft.reload(() => ({ text: textRef.current, files: files.draftFiles(textRef.current) })).then((answer) => {
          if (!answer?.replaceBox) return;
          if (!answer.draft) {
            onGone();
            return;
          }
          setText(answer.draft.body);
          textRef.current = answer.draft.body;
          setSaid('This reply changed in another window.');
        });
      }),
    // `draft`'s functions are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threadId, readThread, onGone],
  );

  const agent = latest?.author.kind === 'agent' ? latest.author : row.author;
  const agentLabel = agent?.kind === 'agent' ? (agent.name ?? 'the agent') : 'the agent';
  const here = sendsHere(thread, row, draft.draft?.recipients);
  const skillFilter = useMemo(() => inboxSkillFilter(false), []);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The key of a Send that failed, kept for its retry only while the words and files are the same ones. */
  const sendKey = useRef<{ key: string; content: string } | null>(null);
  const hasSomething = text.trim() !== '' || files.draftFiles().length > 0;
  const send = async () => {
    if (sending || voice.busy) return;
    if (!here) {
      onOpenThread();
      return;
    }
    if (!hasSomething) {
      setError('Write a reply first.');
      return;
    }
    if (files.uploading) {
      setError('Wait for the files to finish uploading.');
      return;
    }
    setSending(true);
    setError(null);
    const ends = replySendStarts(threadId);
    let claimed = false;
    try {
      const model = await inboxApi.thread(threadId);
      setThread(model.thread);
      const target = wordsMessage(model.thread);
      // What the thread's Send would ask about first (its pill, the route choice, an ended agent) is the thread's.
      if (!sendsHere(model.thread, row, draft.draft?.recipients)) {
        onOpenThread();
        return;
      }
      const session = target.author.kind === 'agent' && target.wakes === true ? target.author.session : null;
      if (session) {
        const live = await inboxApi.sessions(threadId, session, [], ENDED_READ_MS).catch(() => null);
        if (live?.asker?.session === session && live.asker.live === false) {
          onOpenThread();
          return;
        }
      }
      const savedAs = await draft.claim();
      claimed = true;
      const words = textRef.current.trim();
      const skills = await inboxSkillsBlock([words], INBOX_REPLY_SKILL_AUDIENCE, undefined, skillFilter);
      const feedback = withSkillsBlock('', skills);
      const uploads = files.draftFiles().map((file) => file.upload_id);
      // A retry of the same reply keeps its key (a lost answer is not sent twice); changed words are a new reply.
      const content = `${words}\u0000${uploads.join(',')}`;
      if (sendKey.current?.content !== content) sendKey.current = { key: crypto.randomUUID(), content };
      await inboxApi.reply(target.id, {
        idempotency_key: sendKey.current.key,
        words,
        questions: [],
        ...(feedback ? { feedback } : {}),
        ...(uploads.length > 0 ? { uploads } : {}),
        // The message the draft quotes rides the words (approval "inbox-reply-quote").
        ...(() => {
          const sendQuote = words !== '' ? quoteToSend(draft.draft?.quote ?? null, model.thread.messages, whenTime) : undefined;
          return sendQuote ? { quote: sendQuote } : {};
        })(),
        clear_draft: savedAs ?? '',
      });
      sendKey.current = null;
      draft.sent();
      onSent(target.author.kind === 'agent' ? (target.author.name ?? agentLabel) : agentLabel);
    } catch (cause) {
      if (claimed) draft.release();
      if (textRef.current.trim() !== '') draft.save(textRef.current, files.draftFiles(textRef.current));
      setError(errorText(cause, 'That did not send. Your words are still here.'));
    } finally {
      ends();
      setSending(false);
    }
  };

  const discard = () => {
    // Mid-send the reply is on its way: throwing it away now would say "discarded" while it still posts.
    if (sending || discarded.current) return;
    const words = textRef.current;
    const kept: ReplyDraftFileRef[] = files.draftFiles(words).map((file) => (file.pasted ? { upload_id: file.upload_id, pasted: file.pasted } : { upload_id: file.upload_id }));
    discarded.current = true;
    draft.discard();
    // Uploads still in flight stop here; none is handed to the draft as the window goes.
    files.reset();
    onDiscarded(words, kept);
  };

  const drop = useFileDrop((list) => files.add(list));
  const name = floaterName(row);
  const whole = `${row.subject ?? name}, ${row.project.name}`;
  // A draft that quotes a message (approval "inbox-reply-quote"): the peek is that message, or the words quoted.
  const draftQuote = draft.draft?.quote ?? null;
  const quoted = draftQuote && thread ? thread.messages.find((m) => m.id === draftQuote.of) : undefined;
  const peek = quoted ? quoteLineText(quoted, draftQuote?.words) : latest ? peekText(latest.body) : '';
  const questions = quoted ? 0 : (latest?.questions ?? []).filter((q) => q.state === 'open').length;
  const conflictId = `ib-rf-conflict-${threadId}`;
  const peekId = `ib-rf-peek-${threadId}`;

  // ⌘↵ sends, as in the thread's box. No Escape: this is Ask's window, and Ask's window takes none.
  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      void send();
    }
  };

  // The header tells this window from Ask's at a glance: the reply arrow and "Reply to <thread title>".
  const title = (
    <span className="ib-rf-replyhead" data-rf-replyhead="">
      <Icon name="reply" size={phone ? 18 : 15} />
      <Tip content={whole}>
        <span className="ib-rf-name" dir="auto">
          Reply to {name}
        </span>
      </Tip>
    </span>
  );
  const openThread = (
    <Tip content="Open the thread">
      <button type="button" className="ib-rf-ic" aria-label="Open the thread" onClick={onOpenThread} data-rf-open-thread="">
        <Icon name="arrowUpRight" size={phone ? 18 : 15} />
      </button>
    </Tip>
  );
  // T6's Skills (the cube): a real `/` at the caret, so the field's own picker opens.
  const [noSkills, setNoSkills] = useState(false);
  const openSkills = () => {
    const field = fieldRef.current;
    if (!field) return;
    const slash = () => {
      field.focus();
      const at = field.selectionStart ?? field.value.length;
      const before = field.value.slice(0, at);
      document.execCommand('insertText', false, at === 0 || /\s$/.test(before) ? '/' : ' /');
    };
    const none = () => {
      setNoSkills(true);
      setTimeout(() => setNoSkills(false), 2000);
    };
    if (getCachedSkillCatalog().some(skillFilter)) return slash();
    void fetchSkillCatalog().then((catalog) => (catalog.some(skillFilter) ? slash() : none()));
  };
  const [fold, setFold] = useState(false);
  const sendAria = useShortcutAria({ scope: inboxThreadShortcuts, action: 'send' });
  const sendButton = (
    // No ⌘↵ on Send: the key is named to assistive technology only (approval "inbox-send-no-shortcut-hint").
    <Tip content={here ? '' : 'Open the thread to send'}>
      <button type="button" className="ib-btn ib-pri ib-rsend" onClick={() => void send()} disabled={sending || voice.busy} aria-keyshortcuts={here ? sendAria : undefined} data-rf-send="">
        {sending && <span className="ib-spin" aria-hidden="true" />}
        <span className="ib-rsend-w">{here ? 'Send' : 'Open to send'}</span>
      </button>
    </Tip>
  );
  const carries = carriedCount(row);
  const body = (
    <>
      {peek && (
        <button
          type="button"
          className="ib-rf-peek"
          aria-expanded={peekOpen}
          aria-controls={peekId}
          onClick={() => {
            setPeekOpen((open) => !open);
            setFresh(false);
          }}
          data-rf-peek=""
          data-fresh={fresh ? '' : undefined}
        >
          {fresh && <span className="ib-rf-dot" aria-hidden="true" />}
          <span className={peekOpen ? 'ib-rf-peekwhole' : 'ib-rf-peekline'} id={peekId} dir="auto">
            {peek}
          </span>
          {questions > 0 && !peekOpen && <span className="ib-rf-asks">{questions === 1 ? '1 question' : `${questions} questions`}</span>}
        </button>
      )}
      {draft.conflict !== null && (
        <div className="ib-rf-conflict">
          <DraftHead
            conflict={{
              id: conflictId,
              text: conflictText(draft.draft === null),
              onKeepMine: () => draft.keepMine(textRef.current, files.draftFiles(textRef.current)),
              onDiscard: () => {
                const kept = draft.takeTheirs();
                setText(kept?.body ?? '');
                textRef.current = kept?.body ?? '';
                fieldRef.current?.focus();
              },
            }}
          />
        </div>
      )}
      {/* A phone: T6 keeps Discard in the Draft line above the box (no bin in the row). */}
      {phone && (
        <div className="ib-rf-draftline" data-rf-draftline="">
          <DraftStamp savedAt={draft.draft?.updated_at ?? null} failed={draft.failed} onDiscard={discard} />
        </div>
      )}
      {/* T6's box: the words (and files) in one scroll region, then T6's row. */}
      <div
        className="ib-rbox ib-rf-t6"
        onPaste={(event) => files.paste(event)}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            event.preventDefault();
            fieldRef.current?.focus();
          }
        }}
      >
        <div className="ib-rscroll" data-rf-scroll="">
          <InboxComposerField
            textareaRef={fieldRef}
            voice={voice}
            voiceNoteGlide
            value={text}
            onChange={change}
            placeholder="Write a reply. Type / for a skill"
            ariaLabel={`Reply to ${agentLabel}`}
            ariaDescribedBy={draft.conflict !== null ? conflictId : undefined}
            destination="your reply"
            skillFilter={skillFilter}
          />
          {files.files.length > 0 && (
            <div className="ib-rfiles">
              <ComposeFileTiles files={files.files} onRemove={files.remove} onPutBack={files.putBack} />
            </div>
          )}
        </div>
        {!here && (
          <p className="ib-rf-rides" data-rf-rides="">
            {carries === 0 ? 'This reply is sent from its thread' : carries === 1 ? '1 pick waits in the thread' : `${carries} picks and comments wait in the thread`}
          </p>
        )}
        {error && (
          <p className="ib-rf-err" role="alert">
            {error}
          </p>
        )}
        {/* A computer saves without a word (T6): only "Not saved …" shows, on its own line over the row. */}
        {!phone && draft.failed && (
          <div className="ib-rnote" data-reply-note="">
            <DraftStamp savedAt={draft.draft?.updated_at ?? null} failed onDiscard={discard} />
          </div>
        )}
        <ReplyRow
          phone={phone}
          keepOpen={false}
          fold={fold}
          onFold={setFold}
          fitKey=""
          send={sendButton}
          clip={<AttachFilesButton className="ib-rclip" iconSize={phone ? 20 : 16} phone={phone} inputData="data-rf-attach" onFiles={(list) => files.add(list)} />}
          skills={
            <Tip content="Skills (or type / in the reply)">
              <button type="button" className="ib-ricon" aria-label="Skills" data-rf-skills="" onClick={openSkills}>
                <Icon name="cube" size={phone ? 20 : 16} />
              </button>
            </Tip>
          }
          mic={<VoiceMicButton voice={voice} phone={phone} />}
          status={<VoiceStatusLine voice={voice} phone={phone} />}
          files={null}
          chips={null}
          summary={null}
          pill={null}
          hint={noSkills ? 'No skills are installed' : null}
          discard={
            phone ? null : (
              <Tip content="Discard this draft">
                <button type="button" className="ib-ricon ib-rdiscard" aria-label="Discard draft" onClick={discard} disabled={sending} data-rf-discard="">
                  <Icon name="trash" size={16} />
                </button>
              </Tip>
            )
          }
        />
      </div>
      {drop.over && (
        <div className="ib-rf-drop" aria-hidden="true">
          <Icon name="clip" size={18} />
          Drop to attach
        </div>
      )}
      <div className="ib-sr" role="status">
        {said}
      </div>
    </>
  );
  const label = `Reply to ${agentLabel}: ${row.subject ?? name}`;

  if (!phone) {
    return (
      <ChatFrame
        store={frame}
        label={label}
        className="isolate ib-rf-frame"
        rootProps={{
          'data-popover-layer': '',
          'data-rf-box': threadId,
          'data-drop-over': drop.over ? '' : undefined,
          onDragOver: drop.handlers.onDragOver,
          onDragLeave: drop.handlers.onDragLeave,
          onDrop: drop.handlers.onDrop,
        }}
        header={() => (
          <>
            {title}
            {openThread}
          </>
        )}
        onMinimize={onMinimize}
        onClose={onPutAway}
        labels={{ close: 'Stop floating. It stays in Drafts.' }}
      >
        {() => (
          <div className="ib-rf-framebody" onKeyDown={onKey}>
            {body}
          </div>
        )}
      </ChatFrame>
    );
  }

  return (
    <div
      className="ib-rf-box ib-rf-sheet"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      data-rf-box={threadId}
      data-popover-layer=""
      data-chat-window=""
      data-drop-over={drop.over ? '' : undefined}
      {...drop.handlers}
      onKeyDown={onKey}
    >
      <div className="ib-rf-head">
        <button type="button" className="ib-rf-ic" aria-label="Minimize" onClick={onMinimize} data-rf-minimize="">
          <Icon name="chevD" size={18} />
        </button>
        {title}
        <span className="ib-rf-headacts">{openThread}</span>
      </div>
      {body}
    </div>
  );
}
