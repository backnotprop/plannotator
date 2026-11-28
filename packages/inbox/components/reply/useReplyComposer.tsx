/**
 * The reply box's controller: one hook owns the words, the draft, the files, who gets the reply and Send, so a host
 * hands in what it has (replyComposerHost.ts) and renders `<ReplyBox {...box.props} />`. The guards that keep a
 * person's words live here, where no host can pass them by:
 *
 * 1. A Send while any file uploads is refused, from the button and from ⌘/Ctrl+Enter alike: the host is not called
 *    and the line says why.
 * 2. A draft save waiting in the typing pause is written before `host.send` runs, every save on its way is answered,
 *    and none runs while the Send is out (replyDraft.ts `claim`); after it, none queued before brings the draft back
 *    (`sent`).
 * 3. `host.send` rejecting keeps the words and files and shows its message; resolving empties the box and clears the
 *    draft.
 * 4. One Send at a time: a second press while one is out does nothing.
 *
 * Each controller has its own mentions scope and draft page, so two boxes (even on one thread) share nothing, and with
 * `browserStorage: false` neither keeps anything in the browser. The Inbox's own thread pane still wires the same
 * hooks itself (Thread.tsx); this is the one contract another host takes.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { pastedSignature, useComposeFiles, useFileDrop } from '../../compose/ComposeFiles';
import { createReplyDraftPage } from '../../replyDraft';
import { useReplyTextStore, type ReplyText } from '../../replyText';
import { SEND_NOT_SENT } from '../../sendFailure';
import { isComposingKey } from '../../shortcuts/guards';
import { createThreadMentions, type ThreadMentions } from '../../threadMentions';
import type { ReplyBoxProps } from './ReplyBox';
import type { ReplyBoxRecipients } from './replyBoxSeams';
import type { ReplyComposerHost, ReplySendResult } from './replyComposerHost';

/** The Inbox's line for a Send pressed while a file uploads (Thread.tsx says the same). */
export const UPLOADING_LINE = 'Wait for the files to finish uploading.';

/** The outside surfaces' way in: a closed foot, full screen's card, a pane drop, shortcuts, a row's Mention in reply. */
export interface ReplyComposerHandle {
  isOpen: boolean;
  open: () => void;
  /** Close the box: the words stay, saved as the draft. */
  close: () => void;
  /** The live words (full screen's card writes into the same store). */
  replyText: ReplyText;
  /** Files from outside the box (a drop on the pane). */
  addFiles: (list: FileList) => void;
  /** The same guarded Send as the button's. */
  send: () => Promise<void>;
  /** This box's mentions scope (`requestMention` puts a thread in its words). */
  mentions: ThreadMentions;
  /** Whether words or files wait for a draft save (a host's leave guard). */
  unsaved: () => boolean;
  sending: boolean;
}

const NO_DROP = () => {};
const errorText = (error: unknown) => (error instanceof Error && error.message.trim() !== '' ? error.message : SEND_NOT_SENT);

export function useReplyComposer(host: ReplyComposerHost): { box: { props: ReplyBoxProps }; handle: ReplyComposerHandle } {
  const hostRef = useRef(host);
  hostRef.current = host;
  const { threadId } = host;
  // Per box: its mentions and its draft page (nothing at module level, nothing shared with another box).
  const [mentions] = useState(() => createThreadMentions({ keepInBrowser: host.browserStorage }));
  const [page] = useState(() => createReplyDraftPage({ keepInBrowser: host.browserStorage, mentions }));
  const replyText = useReplyTextStore();
  const draft = page.useReplyDraft(threadId, { store: host.draftStore });
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [open, setOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  /** A Send is out (a ref, so a second press in the same frame sees it). */
  const out = useRef(false);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const sendRef = useRef<HTMLButtonElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const draftAboveRef = useRef<HTMLDivElement | null>(null);

  const files = useComposeFiles([], {
    uploader: host.uploader,
    text: {
      get value() {
        return replyText.get();
      },
      set: (text) => change(text),
    },
  });
  const drop = useFileDrop((list) => {
    files.add(list);
    setError(null);
  });

  /** The words changed: the draft saves them after a pause, with the files beside them. Read-only while a Send is out. */
  const change = (text: string) => {
    if (out.current) return;
    replyText.set(text);
    files.follow();
    draftRef.current.save(text, files.draftFiles(text));
  };

  // A file finished uploading or a tile was removed: the draft keeps the tiles as they are now (never while a Send is out).
  const filesNow = pastedSignature(files.draftFiles());
  const filesSaved = useRef(filesNow);
  useEffect(() => {
    if (filesNow === filesSaved.current) return;
    filesSaved.current = filesNow;
    if (out.current) return;
    const text = replyText.get();
    draftRef.current.save(text, files.draftFiles(text));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesNow]);

  // The thread's draft, once read, comes back into an untouched box: its words and its files.
  const restoredFor = useRef<string | null>(null);
  useEffect(() => {
    if (draft.loadedFor !== threadId || restoredFor.current === threadId) return;
    restoredFor.current = threadId;
    const saved = draft.draft;
    if (!saved || replyText.get() !== '' || files.current().length > 0) return;
    replyText.set(saved.body);
    files.restoreDraft(saved.files ?? [], saved.body);
    filesSaved.current = pastedSignature(files.draftFiles());
    draft.boxTook(threadId, (saved.files ?? []).map((file) => file.upload_id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.loadedFor, threadId]);

  const [to, setTo] = useState<readonly string[]>(() => host.recipients?.chosen ?? []);
  const [listOpen, setListOpen] = useState(false);
  const recipients: ReplyBoxRecipients | undefined = host.recipients
    ? {
        rows: host.recipients.rows,
        chosen: host.recipients.rows.filter((row) => to.includes(row.session)),
        open: listOpen,
        onOpen: setListOpen,
        onChange: setTo,
        maxRecipients: host.recipients.maxRecipients,
        labels: host.recipients.labels,
        folderOf: host.recipients.folderOf,
      }
    : undefined;

  const send = async (): Promise<void> => {
    const now = hostRef.current;
    // (4) One Send at a time.
    if (out.current) return;
    // (1) Never while a file uploads: the host is not called.
    if (files.uploading) {
      setError(now.uploadingLine ?? UPLOADING_LINE);
      return;
    }
    if (now.voice?.handle.busy || now.voice?.handle.others.busy) return;
    const body = replyText.get().trim();
    const carried = files.uploaded.map((upload) => upload.upload_id);
    if (body === '' && carried.length === 0) return;
    out.current = true;
    setSending(true);
    setError(null);
    const result: Omit<ReplySendResult, 'draft'> = {
      body,
      mentions: mentions.mentionsFor(threadId, body),
      to: recipients ? to : [],
      reply_to: now.replyTo ?? null,
      files: carried,
      ...(now.extra ? { extra: now.extra() } : {}),
    };
    let version: string | null = null;
    try {
      // (2) The waiting save goes now, every save is answered, and none runs until `sent` or `release`.
      version = await draftRef.current.claim();
      await now.send({ ...result, draft: version });
    } catch (failed) {
      // (3) Not sent: the words and files stay, saved again as they are now.
      out.current = false;
      setSending(false);
      draftRef.current.release();
      const text = replyText.get();
      draftRef.current.save(text, files.draftFiles(text));
      setError(errorText(failed));
      return;
    }
    // Sent: the files it carried leave the box, the words go, and the draft with them.
    const went = new Set(carried);
    files.forget(new Set(files.current().filter((file) => file.upload && went.has(file.upload.upload_id)).map((file) => file.key)));
    replyText.set('');
    filesSaved.current = pastedSignature(files.draftFiles(''));
    const done = () => {
      draftRef.current.sent();
      out.current = false;
      setSending(false);
    };
    if (now.sendClearsDraft) done();
    else await now.draftStore.discard(threadId, { base: version }).then(done, done);
  };

  const close = () => {
    draftRef.current.flush();
    setOpen(false);
  };

  const onFieldKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      void send();
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      // An input method's Escape ends its composition, never the box.
      if (isComposingKey(event.nativeEvent)) return;
      event.preventDefault();
      close();
    }
  };

  const slots = host.slots ?? {};
  const props: ReplyBoxProps = {
    phone: host.phone ?? false,
    offerShown: false,
    onRestoreDraft: NO_DROP,
    conflict: null,
    takeBack: null,
    onJump: NO_DROP,
    draftStamp: null,
    draftAboveRef,
    quote: null,
    quotedMessage: undefined,
    onRemoveQuote: NO_DROP,
    scrollRef,
    replyToNames: host.replyToNames ?? '',
    placeholder: host.placeholder ?? '',
    askerNoteId: null,
    tags: undefined,
    onShowFiles: NO_DROP,
    draftAnswers: [],
    draftActions: [],
    replySkip: { count: 0, keepOpen: true, onToggle: NO_DROP },
    dropped: 0,
    comments: null,
    replySummaryShown: false,
    chips: null,
    fold: false,
    onFold: NO_DROP,
    fitKey: '',
    routeChoiceOpen: false,
    routeChoice: null,
    sendAria: undefined,
    ...slots,
    // What the controller owns comes last: a slot never stands in for it.
    threadId,
    mentions,
    replyText,
    sendingWords: false,
    textRef,
    voice: host.voice,
    skills: host.skills,
    recipients,
    onChange: change,
    onFieldKeyDown,
    files: files.files,
    onRemoveFile: files.remove,
    onPutBackFile: files.putBack,
    onAttachFiles: (list) => {
      files.add(list);
      setError(null);
    },
    onPaste: (event) => {
      if (files.paste(event)) setError(null);
    },
    dropOver: drop.over,
    dropHandlers: drop.handlers,
    sending,
    sendRef,
    onSend: () => void send(),
    onSendWhileUploading: () => void send(),
    onDiscardDraft: () => {
      draftRef.current.discard();
      replyText.set('');
      files.reset();
      setError(null);
    },
    onClose: close,
    draftNotSaved: draft.tooLong || draft.failed,
    errorLine: error === null ? null : (
      <div className="ib-error" role="alert">
        {error}
      </div>
    ),
  };

  return {
    box: { props },
    handle: {
      isOpen: open,
      open: () => setOpen(true),
      close,
      replyText,
      addFiles: (list) => {
        files.add(list);
        setError(null);
      },
      send,
      mentions,
      unsaved: () => page.replyDraftUnsaved(),
      sending,
    },
  };
}
