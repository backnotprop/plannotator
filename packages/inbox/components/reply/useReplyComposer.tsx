/**
 * The reply box's controller: one hook owns the words, the draft, the files, who gets the reply and Send, so a host
 * hands in what it has (replyComposerHost.ts, whose note states every rule) and renders `<ReplyBox {...box.props} />`.
 * The guards that keep a person's words live here, where no host can pass them by:
 *
 * 1. A Send while any file uploads is refused, from the button and from ⌘/Ctrl+Enter alike: the host is not called
 *    and the line says why.
 * 2. A draft save waiting in the typing pause is written before `host.send` runs, every save on its way is answered,
 *    and none runs while the Send is out (replyDraft.ts `claim`); after it, none queued before brings the draft back
 *    (`sent`), and none clears a draft the box's words are not in (`result.draft` null).
 * 3. `host.send` rejecting keeps the words and files and shows its message; resolving empties the box.
 * 4. One Send at a time per thread, and the box read-only while it is out: nothing typed or attached meanwhile.
 * 5. A refused draft save (a conflict) never replaces the box's words; saving waits for the host's choice.
 *
 * Each controller has its own mentions scope and draft page, so two boxes (even on one thread) share nothing, and with
 * `browserStorage: false` neither keeps anything in the browser. The Inbox's own thread pane still wires the same
 * hooks itself (Thread.tsx); this is the one contract another host takes.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { InboxDraftFile } from '@plannotator/core/inbox-types';
import { pastedSignature, useComposeFiles, useFileDrop } from '../../compose/ComposeFiles';
import { createReplyDraftPage } from '../../replyDraft';
import { useReplyTextStore, type ReplyText } from '../../replyText';
import { SEND_NOT_SENT, UPLOADING_LINE } from '../../sendFailure';
import { isComposingKey } from '../../shortcuts/guards';
import { createThreadMentions, type ThreadMentions } from '../../threadMentions';
import type { ReplyBoxProps } from './ReplyBox';
import type { ReplyBoxRecipients } from './replyBoxSeams';
import type { ReplyComposerDraft, ReplyComposerHost, ReplyDraftConflict, ReplySendResult } from './replyComposerHost';
import { hostSeams, NO_MENTION_REFS } from './replyComposerSeams';

export { UPLOADING_LINE };

/** The outside surfaces' way in: a closed foot, full screen's card, a pane drop, shortcuts, a row's Mention in reply. */
export interface ReplyComposerHandle {
  isOpen: boolean;
  /** Open the box; the field takes focus. */
  open: () => void;
  /** Close the box: the words stay, saved as the draft. */
  close: () => void;
  /** The live words (full screen's card writes into the same store). */
  replyText: ReplyText;
  /** Files from outside the box (a drop on the pane). Nothing while a Send is out. */
  addFiles: (list: FileList) => void;
  /** The same guarded Send as the button's. */
  send: () => Promise<void>;
  /** A Send of this thread is out. */
  sending: boolean;
  /** The host gave up on the Send that is out: the box is free again, words and files kept; its settling is ignored. */
  cancel: () => void;
  /** The box's draft: its conflict, its not-saved states and the choices that resume saving. */
  draft: ReplyComposerDraft;
  /** This box's mentions scope (`requestMention` puts a thread in its words). */
  mentions: ThreadMentions;
  /** Whether words or files wait for a draft save (a host's leave guard). */
  unsaved: () => boolean;
}

const NO_DROP = () => {};
const errorText = (error: unknown) => (error instanceof Error && error.message.trim() !== '' ? error.message : SEND_NOT_SENT);

export function useReplyComposer(host: ReplyComposerHost): { box: { props: ReplyBoxProps }; handle: ReplyComposerHandle } {
  const hostRef = useRef(host);
  hostRef.current = host;
  const { threadId } = host;
  const threadRef = useRef(threadId);
  threadRef.current = threadId;
  // Per box: its mentions, its draft page and its wrappers of the host's store and uploader (nothing at module level).
  const [seams] = useState(() => hostSeams(() => hostRef.current));
  const [mentions] = useState(() => createThreadMentions({ keepInBrowser: host.browserStorage, refs: host.mentionRefs ?? NO_MENTION_REFS }));
  const [page] = useState(() => createReplyDraftPage({ keepInBrowser: host.browserStorage, mentions }));
  const replyText = useReplyTextStore();
  const draft = page.useReplyDraft(threadId, { store: seams.store });
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [open, setOpen] = useState(true);
  const focusNext = useRef(false);
  /** Per thread: the line under the box (a Send that failed while another thread showed says so when it is back). */
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const setErrorFor = (target: string, line: string | null) =>
    setErrors((now) => {
      if ((now.get(target) ?? null) === line) return now;
      const next = new Map(now);
      if (line === null) next.delete(target);
      else next.set(target, line);
      return next;
    });
  /** Threads with a Send out, and each one's press (a ref, so a second press in the same frame sees it). */
  const out = useRef(new Map<string, number>());
  const pressSeq = useRef(0);
  const [outFor, setOutFor] = useState<readonly string[]>([]);
  const syncOut = () => setOutFor([...out.current.keys()]);
  const busy = () => out.current.has(threadRef.current);
  /** The thread whose good Send's discard was rejected. */
  const [clearFailed, setClearFailed] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const sendRef = useRef<HTMLButtonElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const draftAboveRef = useRef<HTMLDivElement | null>(null);

  const files = useComposeFiles([], {
    uploader: seams.uploader,
    text: {
      get value() {
        return replyText.get();
      },
      set: (text) => change(text),
    },
    // The box goes while files upload: each lands in its thread's draft when it finishes.
    onUnmountUploads: (uploads) => {
      for (const upload of uploads) void page.landInReplyDraft(threadRef.current, upload, seams.store);
    },
  });
  const addFiles = (list: Iterable<File>) => {
    if (busy()) return;
    files.add(list);
    setErrorFor(threadRef.current, null);
  };
  const drop = useFileDrop((list) => addFiles(list));

  /** The words changed: the draft saves them after a pause, with the files beside them. Read-only while a Send is out. */
  const change = (text: string) => {
    if (busy()) return;
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
    if (busy()) return;
    const text = replyText.get();
    draftRef.current.save(text, files.draftFiles(text));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesNow]);

  /** The box takes a draft's words and files (it opened, a read replaced them, Discard mine). */
  const takeIn = (target: string, body: string, list: readonly InboxDraftFile[]) => {
    replyText.set(body);
    files.restoreDraft(list, body);
    const held = files.draftFiles();
    filesSaved.current = pastedSignature(held);
    draftRef.current.boxTook(target, held.map((file) => file.upload_id));
  };

  // The thread's draft, once read, comes back into an untouched box: its words and its files.
  const restoredFor = useRef<string | null>(null);
  useEffect(() => {
    if (draft.loadedFor !== threadId || restoredFor.current === threadId) return;
    restoredFor.current = threadId;
    const saved = draft.draft;
    if (!saved || replyText.get() !== '' || files.current().length > 0) return;
    takeIn(threadId, saved.body, saved.files ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.loadedFor, threadId]);

  const chosenOf = (now: ReplyComposerHost): readonly string[] => now.recipients?.chosen ?? [];
  const [to, setTo] = useState<readonly string[]>(() => chosenOf(host));
  const toRef = useRef(to);
  toRef.current = to;
  // The host's choice, whenever it changes (not only as the box mounts).
  const chosenKey = chosenOf(host).join('\n');
  const chosenSeen = useRef(chosenKey);
  useEffect(() => {
    if (chosenSeen.current === chosenKey) return;
    chosenSeen.current = chosenKey;
    setTo(chosenOf(hostRef.current));
  }, [chosenKey]);
  /** Who the reply goes to as the picker shows it: the ids it lists, in order, at most `maxRecipients`. */
  const toNow = (): readonly string[] => {
    const list = hostRef.current.recipients;
    if (!list) return [];
    const ids = toRef.current.filter((id) => list.rows.some((row) => row.session === id));
    return list.maxRecipients && list.maxRecipients > 0 ? ids.slice(0, list.maxRecipients) : ids;
  };
  const [listOpen, setListOpen] = useState(false);
  const recipients: ReplyBoxRecipients | undefined = host.recipients
    ? {
        rows: host.recipients.rows,
        chosen: toNow().map((id) => host.recipients!.rows.find((row) => row.session === id)!),
        open: listOpen,
        onOpen: setListOpen,
        onChange: setTo,
        maxRecipients: host.recipients.maxRecipients,
        labels: host.recipients.labels,
        folderOf: host.recipients.folderOf,
      }
    : undefined;

  // Another thread: a new box. The words and files were this thread's (its draft keeps them: the save waiting goes
  // to it as the draft hook moves on, and uploads still on their way land in it); none of them stays for the next.
  const shownFor = useRef(threadId);
  useLayoutEffect(() => {
    const was = shownFor.current;
    if (was === threadId) return;
    shownFor.current = threadId;
    for (const upload of files.detach()) void page.landInReplyDraft(was, upload, seams.store);
    files.reset();
    replyText.set('');
    filesSaved.current = '';
    chosenSeen.current = chosenOf(hostRef.current).join('\n');
    setTo(chosenOf(hostRef.current));
    setListOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  /** The box's words and files saved again (a Send that did not go, or one given up). */
  const saveBox = (target: string) => {
    if (threadRef.current !== target) return;
    const text = replyText.get();
    draftRef.current.save(text, files.draftFiles(text));
  };

  const send = async (): Promise<void> => {
    const now = hostRef.current;
    const thread = threadRef.current;
    // (4) One Send at a time.
    if (out.current.has(thread)) return;
    // (1) Never while a file uploads: the host is not called.
    if (files.uploading) {
      setErrorFor(thread, now.uploadingLine ?? UPLOADING_LINE);
      return;
    }
    if (now.voice?.handle.busy || now.voice?.handle.others.busy) return;
    const body = replyText.get().trim();
    const carried = files.uploaded.map((upload) => upload.upload_id);
    if (body === '' && carried.length === 0 && !now.hasOtherContent?.()) return;
    const press = ++pressSeq.current;
    out.current.set(thread, press);
    syncOut();
    setErrorFor(thread, null);
    const result: Omit<ReplySendResult, 'draft'> = {
      threadId: thread,
      body,
      mentions: mentions.mentionsFor(thread, body),
      to: toNow(),
      reply_to: now.replyTo ?? null,
      files: carried,
      ...(now.extra ? { extra: now.extra() } : {}),
    };
    const given = () => out.current.get(thread) !== press;
    let version: string | null = null;
    try {
      // (2) The waiting save goes now, every save is answered, and none runs until `sent` or `release`.
      version = await draftRef.current.claim();
      if (given()) {
        // Given up while the claim was answered: the thread's saves run again.
        draftRef.current.release(thread);
        saveBox(thread);
        return;
      }
      await now.send({ ...result, draft: version });
    } catch (failed) {
      if (given()) return;
      // (3) Not sent: the words and files stay, saved again as they are now.
      out.current.delete(thread);
      syncOut();
      draftRef.current.release(thread);
      saveBox(thread);
      setErrorFor(thread, errorText(failed));
      return;
    }
    if (given()) return;
    // Sent: the files it carried leave the box, the words go, and the box is free at once.
    if (threadRef.current === thread) {
      const went = new Set(carried);
      files.forget(new Set(files.current().filter((file) => file.upload && went.has(file.upload.upload_id)).map((file) => file.key)));
      replyText.set('');
      // What the tiles hold once those are forgotten (the files hook's own list changes on its next render).
      filesSaved.current = pastedSignature(files.draftFiles('').filter((file) => !went.has(file.upload_id)));
    }
    out.current.delete(thread);
    syncOut();
    setClearFailed((was) => (was === thread ? null : was));
    // The draft: cleared by the host's send, or by one discard of the version the words were saved as. None holds
    // them (null): the server's draft is another window's, and stays.
    if (now.sendClearsDraft || version === null) return draftRef.current.sent(thread);
    // Saves of the next words wait for that discard (none races it); the box takes them meanwhile.
    const finish = () => {
      if (out.current.has(thread)) return;
      draftRef.current.sent(thread);
      if (threadRef.current === thread && (replyText.get() !== '' || files.current().length > 0)) saveBox(thread);
    };
    now.draftStore.discard(thread, { base: version }).then(finish, () => {
      setClearFailed(thread);
      finish();
    });
  };

  const cancel = () => {
    const thread = threadRef.current;
    if (!out.current.has(thread)) return;
    out.current.delete(thread);
    syncOut();
    draftRef.current.release(thread);
    saveBox(thread);
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

  const sending = outFor.includes(threadId);
  // While a Send is out the field takes no keys (as the Inbox's, Thread.tsx): nothing typed is accepted, then lost.
  useEffect(() => {
    if (textRef.current) textRef.current.readOnly = sending;
  });
  // Opened through the handle: the field takes focus once it is drawn.
  useEffect(() => {
    if (!focusNext.current || !textRef.current) return;
    focusNext.current = false;
    textRef.current.focus();
  });

  // A conflict raised: the host hears it, with the store's own refusal and the draft it holds now.
  const conflict: ReplyDraftConflict | null =
    draft.conflict === null ? null : { threadId, mine: draft.conflict, theirs: draft.draft, refusal: seams.refusals.get(threadId) ?? null };
  const conflictRef = useRef(conflict);
  conflictRef.current = conflict;
  const raised = conflict !== null;
  useEffect(() => {
    if (raised && conflictRef.current) hostRef.current.onDraftConflict?.(conflictRef.current);
  }, [raised, threadId]);

  const draftHandle: ReplyComposerDraft = {
    current: draft.draft,
    conflict,
    tooLong: draft.tooLong,
    failed: draft.failed,
    clearFailed: clearFailed === threadId,
    keepMine: () => {
      if (busy()) return;
      const text = replyText.get();
      draftRef.current.keepMine(text, files.draftFiles(text));
    },
    takeTheirs: () => {
      if (busy()) return;
      const theirs = draftRef.current.takeTheirs();
      takeIn(threadRef.current, theirs?.body ?? '', theirs?.files ?? []);
    },
    reload: async () => {
      const target = threadRef.current;
      const answer = await draftRef.current.reload(() => ({ text: replyText.get(), files: files.draftFiles(replyText.get()) }));
      if (!answer || threadRef.current !== target || busy()) return;
      if (answer.offered !== undefined) return takeIn(target, answer.offered, answer.draft?.files ?? []);
      if (answer.replaceBox) takeIn(target, answer.draft?.body ?? '', answer.draft?.files ?? []);
    },
  };

  const slots = host.slots ?? {};
  const error = errors.get(threadId) ?? null;
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
    onRemoveFile: (key) => {
      if (!busy()) files.remove(key);
    },
    onPutBackFile: (key, field) => {
      if (!busy()) files.putBack(key, field);
    },
    onAttachFiles: (list) => addFiles(list),
    onPaste: (event) => {
      if (busy()) return;
      if (files.paste(event)) setErrorFor(threadRef.current, null);
    },
    dropOver: drop.over,
    dropHandlers: drop.handlers,
    sending,
    sendRef,
    onSend: () => void send(),
    onSendWhileUploading: () => void send(),
    onDiscardDraft: () => {
      if (busy()) return;
      draftRef.current.discard();
      replyText.set('');
      files.reset();
      // The tiles went with the draft: no save of an empty box follows the discard.
      filesSaved.current = '';
      setErrorFor(threadRef.current, null);
    },
    onClose: close,
    // "Not saved" goes in the host's own line (`slots.draftStamp`); with none, no empty line is drawn.
    draftNotSaved: (draft.tooLong || draft.failed) && slots.draftStamp != null,
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
      open: () => {
        if (textRef.current) textRef.current.focus();
        else focusNext.current = true;
        setOpen(true);
      },
      close,
      replyText,
      addFiles: (list) => addFiles(list),
      send,
      sending,
      cancel,
      draft: draftHandle,
      mentions,
      unsaved: () => page.replyDraftUnsaved(),
    },
  };
}
