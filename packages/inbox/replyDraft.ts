/**
 * The reply box's words, kept per thread as a server draft (approval
 * "inbox-reply-drafts"): saved while the person types (debounced), read back
 * when the thread opens, so they survive leaving the thread, a reload and a
 * restart. Discard drops the draft; the Send that carries the words clears
 * it (the server deletes it on `clear_draft`).
 *
 * Saves run one at a time, each with the `updated_at` this window last knew
 * for its thread as `base` (kept per thread, so the save made on leaving a
 * thread uses that thread's own). A save the server refuses (`409
 * draft_conflict`: another window saved, sent or discarded since) is never
 * written over: this window adopts the draft as the server holds it and keeps
 * its own words in the box as not saved (`conflict`), until the person picks
 * Keep mine (`keepMine`, saved over the newer draft) or Discard (`takeTheirs`:
 * only this window's words go). So a draft
 * another window sent never comes back holding the words it sent.
 *
 * A Send claims the thread when it starts (`claim`): the words waiting are
 * saved, every save in flight is answered, and from then on no save of that
 * thread runs (its generation is raised, so a save queued earlier does
 * nothing) until the Send ends (`sent`) or fails (`release`). The box is
 * read-only meanwhile. The Send names the `updated_at` its words were saved as
 * in `clear_draft`, so the server clears that draft only (or one holding
 * exactly the sent words: a save whose answer never came leaves the window's
 * `updated_at` behind).
 *
 * A read (`reload`) never writes back words a Send claimed, and never applies
 * an answer older than what the window learned since it went out. A save whose
 * answer never came (a lost answer, the keepalive as the page goes) is read
 * back, so the window's base follows what landed.
 *
 * The draft also keeps the box's files: every finished upload in the box
 * (paperclip, drop, paste), a long paste (approval "inbox-paste-attachment")
 * with its place in the words. `save(text, files)` carries them, and every
 * comparison here (a read-back, the edits a reload weighs, a conflict) is of
 * the words and those files together (`replyContentKey`). The save names the
 * files it saved last (`base_files`) beside `base_body`.
 *
 * Files never cause the conflict line. A save refused because another window
 * changed the draft is merged quietly while the words agree (or only this
 * window changed them): this window's own file change since its last read is
 * applied to the newer list (`mergeReplyDraftFiles`), saved, and the box takes
 * the result (`onFiles`). Only different words show "Keep mine / Discard";
 * Keep mine saves these words with the merged files.
 *
 * A file still uploading when the box closes or the thread changes is not
 * lost: it lands in that thread's draft when its upload finishes
 * (`landInReplyDraft`).
 *
 * Storage is the host's (`store`, @plannotator/core/inbox-reply-draft's
 * `ReplyDraftStore`); this Inbox's is HTTP (replyDraftHttp.ts).
 */
import { machineOf } from './inboxUrl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { INBOX_DRAFT_BODY_MAX, type InboxReplyDraft, type InboxUpload } from '@plannotator/core/inbox-types';
import { mergeReplyDraftFiles, type ReplyDraftFileRef, type ReplyDraftStore } from '@plannotator/core/inbox-reply-draft';
import { httpReplyDraftStore } from './replyDraftHttp';

/** The files a reply draft keeps beside its words: each finished upload, a long paste with its place. */
export type ReplyDraftFiles = readonly ReplyDraftFileRef[];
const NO_FILES: ReplyDraftFiles = [];

/** A refusal's code and field, whichever store refused (the seam's errors carry `code`, and `field` for a file). */
const codeOf = (cause: unknown): string | null =>
  cause && typeof cause === 'object' && typeof (cause as { code?: unknown }).code === 'string' ? (cause as { code: string }).code : null;
const fieldOf = (cause: unknown): string | null =>
  cause && typeof cause === 'object' && typeof (cause as { field?: unknown }).field === 'string' ? (cause as { field: string }).field : null;
const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : '');

/** What the box holds, as one string to compare: the words, and each long paste with its place. */
export function replyContentKey(text: string, files: ReplyDraftFiles | InboxReplyDraft['files'] = NO_FILES): string {
  const list = files ?? NO_FILES;
  if (list.length === 0) return text;
  return `${text}\u0000${list.map((file) => `${file.upload_id}@${file.pasted?.at ?? ''}`).join(',')}`;
}
const draftKey = (draft: InboxReplyDraft | null | undefined): string | null => (draft ? replyContentKey(draft.body, draft.files) : null);
const draftFilesOf = (draft: InboxReplyDraft | null | undefined): ReplyDraftFileRef[] =>
  (draft?.files ?? []).map((file) => (file.pasted ? { upload_id: file.upload_id, pasted: file.pasted } : { upload_id: file.upload_id }));
/** A long paste's place, kept inside `text` (one the other window placed in longer words goes to their end). */
const placedIn = (files: readonly ReplyDraftFileRef[], text: string): ReplyDraftFileRef[] =>
  files.map((file) => (file.pasted && file.pasted.at > text.length ? { ...file, pasted: { ...file.pasted, at: text.length } } : file));

/** How long typing pauses before the words are saved. */
export const REPLY_DRAFT_SAVE_MS = 500;

export interface ReplyDraftState {
  /** The thread the draft below was read for (null until the first read answers). */
  loadedFor: string | null;
  /** The draft as the server holds it (null: none). */
  draft: InboxReplyDraft | null;
  /**
   * The words typed here that the server refused because another window
   * changed the draft since (null: none). They stay in the box, not saved,
   * until the person picks Keep mine or Discard.
   */
  conflict: string | null;
  /**
   * The box's words are longer than a draft holds (INBOX_DRAFT_BODY_MAX): they
   * are not saved, and the line above the box says so, until they are shorter.
   */
  tooLong: boolean;
}

/** Saves waiting or in flight anywhere on the page, and words left unsaved by a conflict (the restart guard reads them). */
let unsaved = 0;
/**
 * Per thread, the words a refused save carried (both windows hold words), not
 * saved. Module-level, not the hook's: the thread pane unmounts when the thread
 * closes or another opens, and these words must come back when it reopens.
 */
const conflictWords = new Map<string, string>();
/** Threads whose box holds more words than a draft takes: not saved (the restart guard asks). */
const tooLongThreads = new Set<string>();
/**
 * Threads whose last save was refused for another reason (`validation_error` not about the body's
 * length): their words are not saved until a later save lands (the restart guard asks meanwhile).
 */
const refusedThreads = new Set<string>();
/**
 * Per thread, the file ids this window had last read or saved when a conflict over the words came (module-level,
 * as `conflictWords`): Keep mine applies this window's file change since then to the newer draft's files.
 */
const conflictFileBase = new Map<string, readonly string[]>();
/** Files that left the box still uploading (Cancel, another thread) and have not landed in their draft yet. */
let landing = 0;
/** Per thread: raised by each Discard here. A file still landing from before one joins no draft (it was thrown away). */
const discards = new Map<string, number>();
const discardsOf = (threadId: string) => discards.get(threadId) ?? 0;
export function replyDraftUnsaved(): boolean {
  return unsaved > 0 || landing > 0 || conflictWords.size > 0 || tooLongThreads.size > 0 || refusedThreads.size > 0;
}

/**
 * A file that left the reply box still uploading (the box closed, or the person went to another thread): once
 * its upload is in, it joins that thread's draft, beside whatever words and files the draft holds then (read,
 * then saved on that version; read again if another window saved meanwhile). Until then the restart guard asks.
 * An upload that fails or is stopped joins nothing, nor does one whose draft this window discarded meanwhile.
 */
export function landInReplyDraft(threadId: string, upload: Promise<InboxUpload | null>, store: ReplyDraftStore = httpReplyDraftStore): Promise<void> {
  landing += 1;
  unsavedChanged();
  const discarded = discardsOf(threadId);
  return (async () => {
    const done = await upload.catch(() => null);
    if (!done) return;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (discardsOf(threadId) !== discarded) return;
      const latest = await store.read(threadId).catch(() => undefined);
      if (latest === undefined || discardsOf(threadId) !== discarded) return;
      const files = draftFilesOf(latest);
      if (files.some((file) => file.upload_id === done.upload_id)) return;
      const body = latest?.body ?? '';
      try {
        await store.save(
          threadId,
          { body, base: latest?.updated_at ?? null, baseBody: null, files: [...files, { upload_id: done.upload_id }], baseFiles: null },
          { keepalive: false },
        );
        return;
      } catch (cause) {
        // Another window saved first: read its draft again and add the file to that one.
        if (codeOf(cause) !== 'draft_conflict') return;
      }
    }
  })().finally(() => {
    landing -= 1;
    unsavedChanged();
  });
}

/** Told when replyDraftUnsaved() may have changed (unsent.ts keeps the page's beforeunload question in step). */
const unsavedListeners = new Set<() => void>();
export function onReplyDraftUnsavedChange(listener: () => void): () => void {
  unsavedListeners.add(listener);
  return () => unsavedListeners.delete(listener);
}
function unsavedChanged(): void {
  for (const listener of unsavedListeners) listener();
}

export interface ReplyDraftOptions {
  /** Where drafts are kept (default: this Inbox's, over HTTP). */
  store?: ReplyDraftStore;
  /**
   * Two windows' file changes were merged quietly and saved: the box takes the draft's files (the thread
   * whose draft it is, and the draft as saved). `base`: the file ids the box held when the merge was made,
   * so a change the person made to the box since then is kept on top (`mergeReplyDraftFiles`).
   */
  onFiles?: (threadId: string, draft: InboxReplyDraft, base: readonly string[]) => void;
}

export function useReplyDraft(threadId: string, options: ReplyDraftOptions = {}) {
  const [state, setState] = useState<ReplyDraftState>({ loadedFor: null, draft: null, conflict: null, tooLong: false });
  const stateRef = useRef(state);
  stateRef.current = state;
  const storeRef = useRef(options.store ?? httpReplyDraftStore);
  storeRef.current = options.store ?? httpReplyDraftStore;
  const onFilesRef = useRef(options.onFiles);
  onFilesRef.current = options.onFiles;
  const readDraft = (target: string) => readStoredDraft(storeRef.current, target);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef<{ threadId: string; text: string; files: ReplyDraftFiles; seq: number } | null>(null);
  /** Raised each time the box's words and files are taken for a save: a save's place among the box's states. */
  const captures = useRef(0);
  const capture = () => captures.current++;
  /**
   * Per thread, the last quiet file merge saved: the box took its files (`onFiles`) once saves captured before
   * `before` were already taken. Those saves (queued, or waiting for the pause in typing) carry the box's files
   * from before the merge, so each applies its own change since `base` to the merged list (`theirs`) as it goes:
   * a file the other window added stays in the draft.
   */
  const merges = useRef(new Map<string, { before: number; base: readonly string[]; theirs: ReplyDraftFiles }>());
  /** `files` as a save captured at `seq` sends them: on the last merge's list when the box took it after. */
  const rebased = (target: string, text: string, files: ReplyDraftFiles, seq: number): ReplyDraftFiles => {
    const merge = merges.current.get(target);
    if (!merge || seq >= merge.before) return files;
    return placedIn(mergeReplyDraftFiles(merge.base, files, merge.theirs), text);
  };
  /** A quiet merge's files are in the draft as `draft`: the box takes them (its own change since `base` kept). */
  const tookMerge = (target: string, draft: InboxReplyDraft, base: readonly string[]) => {
    merges.current.set(target, { before: captures.current, base, theirs: draftFilesOf(draft) });
    onFilesRef.current?.(target, draft, base);
  };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = useRef(threadId);
  current.current = threadId;
  /** Per thread: the `updated_at` of the draft this window last knew (null: none). */
  const bases = useRef(new Map<string, string | null>());
  /** Per thread: raised by a Send's claim, the Send and Discard; a save queued under an older one does nothing. */
  const generations = useRef(new Map<string, number>());
  /** Threads a Send has claimed: no save of theirs runs until it ends or fails. */
  const claimed = useRef(new Set<string>());
  /** The words refused saves left unsaved, per thread (module-level: they outlive the pane). */
  const conflicts = useRef(conflictWords);
  /** Per thread: what the server held as this window last saved or read it (`replyContentKey`; null: no draft). */
  const synced = useRef(new Map<string, string | null>());
  /** Per thread: that draft's words (null: no draft) and file ids, which a quiet file merge starts from. */
  const syncedWords = useRef(new Map<string, string | null>());
  const syncedFiles = useRef(new Map<string, readonly string[]>());
  /**
   * Per thread: this window's own Send (unconfirmed) may have cleared the draft holding these words.
   * A save refused because of it is not another window's doing: adopted, and the words saved again.
   */
  const ownClears = useRef(new Map<string, string>());
  /** The words the last save queued here carries (or the draft read): the page's last save names them (`base_body`). */
  const lastWords = useRef<string | null>(null);
  /** The long pastes the last save queued here carries (or the draft read): the page's last save names them (`base_files`). */
  const lastFiles = useRef<ReplyDraftFiles>(NO_FILES);
  /** Per thread: the words of the last save this window sent, answered or not; the next save names them (`base_body`). */
  const sentWords = useRef(new Map<string, string>());
  /** Per thread: the long pastes that save carried; the next save names their ids (`base_files`). */
  const sentFiles = useRef(new Map<string, ReplyDraftFiles>());
  /** Raised by each `reload`: only the newest read applies its answer. */
  const readSeq = useRef(0);
  /** Raised each time this window learns the draft itself (its save, Send, Discard, a read-back): a read sent before is read again. */
  const learned = useRef(0);
  /** The keepalive save sent as the page went (its answer is never read): read back when the page comes back. */
  const keptAlive = useRef<{ threadId: string; text: string; files: ReplyDraftFiles; generation: number } | null>(null);

  const generationOf = (target: string) => generations.current.get(target) ?? 0;
  const bump = (target: string) => generations.current.set(target, generationOf(target) + 1);
  const baseOf = (target: string) => bases.current.get(target) ?? null;
  const setConflict = (target: string, words: string | null) => {
    if (words === null) {
      conflicts.current.delete(target);
      conflictFileBase.delete(target);
    } else conflicts.current.set(target, words);
    unsavedChanged();
  };
  /** The server holds this draft for the thread now: its base and words, as this window knows them. */
  const adopt = (target: string, draft: InboxReplyDraft | null) => {
    bases.current.set(target, draft?.updated_at ?? null);
    synced.current.set(target, draftKey(draft));
    syncedWords.current.set(target, draft?.body ?? null);
    syncedFiles.current.set(target, (draft?.files ?? []).map((file) => file.upload_id));
    if (target === current.current) {
      lastWords.current = draft?.body ?? null;
      lastFiles.current = draftFilesOf(draft);
    }
  };
  /** adopt, from this window's own save, Send, Discard or read-back (not from a `reload`). */
  const learn = (target: string, draft: InboxReplyDraft | null) => {
    adopt(target, draft);
    learned.current += 1;
  };
  /** The box's words are (or are no longer) longer than a draft holds. */
  const markTooLong = (target: string, on: boolean) => {
    if (on === tooLongThreads.has(target)) return;
    if (on) tooLongThreads.add(target);
    else tooLongThreads.delete(target);
    unsavedChanged();
    if (target === current.current) setState((s) => ({ ...s, tooLong: on }));
  };
  /** The thread's words were refused for another reason (on), or a save of them landed or they went (off). */
  const markRefused = (target: string, on: boolean) => {
    if (on === refusedThreads.has(target)) return;
    if (on) refusedThreads.add(target);
    else refusedThreads.delete(target);
    unsavedChanged();
  };
  const show = (target: string, draft: InboxReplyDraft | null) => {
    if (target === current.current) setState({ loadedFor: target, draft, conflict: conflicts.current.get(target) ?? null, tooLong: tooLongThreads.has(target) });
  };
  /**
   * A save of `text` went without its answer reaching here: it may have landed. The draft holding
   * those words is this window's own, so its base is that draft's (and the Send's clear_draft names it).
   */
  const readBack = async (target: string, text: string, generation: number, files: ReplyDraftFiles = NO_FILES) => {
    const latest = await readDraft(target);
    if (latest === undefined || draftKey(latest) !== replyContentKey(text, files) || generation !== generationOf(target) || claimed.current.has(target)) return;
    learn(target, latest);
    show(target, latest);
  };

  /**
   * Save `text` and `files`, taken from the box at `seq`. `mergedFrom`: the files are a quiet merge of two
   * windows' changes onto the box's files with these ids, so once saved the box takes them (`onFiles`).
   */
  const write = useCallback((target: string, text: string, captured: ReplyDraftFiles = NO_FILES, mergedFrom: readonly string[] | null = null, seq = capture()) => {
    unsaved += 1;
    unsavedChanged();
    const generation = generationOf(target);
    if (target === current.current) {
      lastWords.current = text;
      lastFiles.current = captured;
    }
    chain.current = chain.current.then(async () => {
      // Taken before the box took a quiet merge's files: sent on the merged list, never without the other window's file.
      const files = rebased(target, text, captured, seq);
      // `base_body` / `base_files`: a save of this window's that landed without its answer still counts as its own.
      const baseBody = sentWords.current.get(target);
      const baseFiles = sentFiles.current.get(target);
      /** Refused: these words never landed, so they are not this window's on the server. */
      const unsend = () => {
        if (baseBody === undefined) sentWords.current.delete(target);
        else sentWords.current.set(target, baseBody);
        if (baseFiles === undefined) sentFiles.current.delete(target);
        else sentFiles.current.set(target, baseFiles);
      };
      try {
        // Claimed by a Send, sent or discarded since this save was queued, or
        // waiting on the person's choice after a conflict: the words must not land.
        if (generation !== generationOf(target) || claimed.current.has(target) || conflicts.current.has(target)) return;
        let answer: { draft: InboxReplyDraft | null };
        sentWords.current.set(target, text);
        sentFiles.current.set(target, files);
        try {
          answer = await storeRef.current.save(
            target,
            { body: text, base: baseOf(target), baseBody: baseBody ?? null, files, baseFiles: (baseFiles ?? NO_FILES).map((file) => file.upload_id) },
            { keepalive: false },
          );
        } catch (cause) {
          if (codeOf(cause) === 'validation_error') {
            // Refused: not saved. For its size (the Inbox's own limit, a `body:` refusal) the line above the box
            // says so; any other refusal is not "too long": the words stay unsaved (the restart guard asks) until
            // the next pause in typing saves them.
            unsend();
            if (generation !== generationOf(target)) return;
            if (messageOf(cause).startsWith('body:')) markTooLong(target, true);
            else markRefused(target, true);
            return;
          }
          if (codeOf(cause) === 'upload_not_found' && files.length > 0) {
            // A file's upload is gone (sent or swept elsewhere): saved again without it, the other files kept
            // (the refusal names it, `files[i]`; without that, the words alone). Its tile stays in the box, not in
            // the draft, so the restart guard asks for it (Thread).
            unsend();
            const gone = /^files\[(\d+)\]$/.exec(fieldOf(cause) ?? '');
            const rest = gone ? files.filter((_, index) => index !== Number(gone[1])) : NO_FILES;
            if (generation === generationOf(target)) write(target, text, rest, mergedFrom, seq);
            return;
          }
          if (codeOf(cause) !== 'draft_conflict') throw cause;
          unsend();
          // Another window saved, sent or discarded since: adopt the draft as it is
          // there, and keep these words here, not saved, for the person to choose.
          const latest = await readDraft(target);
          if (latest === undefined) return;
          const own = ownClears.current.get(target);
          if (own !== undefined && (latest === null || latest.body === own)) {
            // This window's own Send cleared (or still holds) the draft: these words, edited since, are the draft now.
            ownClears.current.delete(target);
            learn(target, latest);
            show(target, latest);
            if (generation === generationOf(target)) write(target, text, files, null, seq);
            return;
          }
          // What this window last knew of the draft: its own change since is what it adds to the newer one.
          const knownFiles = syncedFiles.current.get(target) ?? [];
          const knownWords = syncedWords.current.get(target);
          if (generation === generationOf(target) && latest !== null && (latest.body === text || (knownWords !== undefined && latest.body === knownWords))) {
            // Files never cause the conflict line: the words agree (or only this window changed them), so this
            // window's file change goes onto the other window's list, quietly, and the box takes the result.
            learn(target, latest);
            show(target, latest);
            const together = placedIn(mergeReplyDraftFiles(knownFiles, files, draftFilesOf(latest)), text);
            const mine = files.map((file) => file.upload_id);
            if (replyContentKey(text, together) !== draftKey(latest)) write(target, text, together, mine, seq);
            else tookMerge(target, latest, mine);
            return;
          }
          learn(target, latest);
          // A conflict only when both windows hold words: an empty box (or the same words) is not one,
          // and never deletes the other window's draft.
          if (generation === generationOf(target) && (text.trim() !== '' || files.length > 0) && replyContentKey(text, files) !== (draftKey(latest) ?? '')) {
            setConflict(target, text);
            // Keep mine adds this window's file change since then to the newer draft's files.
            conflictFileBase.set(target, knownFiles);
          }
          show(target, latest);
          return;
        }
        if (generation !== generationOf(target)) return;
        markRefused(target, false);
        learn(target, answer.draft ?? null);
        show(target, answer.draft ?? null);
        if (mergedFrom && answer.draft) tookMerge(target, answer.draft, mergedFrom);
      } catch {
        // No answer: read back what may have landed. Otherwise kept in the box; the next pause in typing tries again.
        await readBack(target, text, generation, files);
      } finally {
        unsaved -= 1;
        unsavedChanged();
      }
    });
  }, []);

  /** Save what waits now (leaving the thread, the page going away). */
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next) write(next.threadId, next.text, next.files, null, next.seq);
  }, [write]);

  // The thread's draft, read when it opens; what waited for the last thread is saved first.
  useEffect(() => {
    let live = true;
    setState({ loadedFor: null, draft: null, conflict: null, tooLong: tooLongThreads.has(threadId) });
    void chain.current.then(async () => {
      try {
        // An older Inbox answers 404 (caught below): no draft.
        const draft = await storeRef.current.read(threadId);
        if (!live) return;
        adopt(threadId, draft);
        setState({ loadedFor: threadId, draft, conflict: conflicts.current.get(threadId) ?? null, tooLong: tooLongThreads.has(threadId) });
      } catch {
        if (live) setState({ loadedFor: threadId, draft: null, conflict: conflicts.current.get(threadId) ?? null, tooLong: tooLongThreads.has(threadId) });
      }
    });
    return () => {
      live = false;
      flush();
    };
  }, [threadId, flush]);

  // A reload or a closed tab while a save waits: sent as the page goes (keepalive).
  useEffect(() => {
    const onHide = () => {
      const next = pending.current;
      if (!next) return;
      pending.current = null;
      if (timer.current) clearTimeout(timer.current);
      if (claimed.current.has(next.threadId) || conflicts.current.has(next.threadId)) return;
      const files = rebased(next.threadId, next.text, next.files, next.seq);
      // `base` may be a step behind a save still on its way; `base_body` names the words that save carries.
      void storeRef.current
        .save(
          next.threadId,
          {
            body: next.text,
            base: baseOf(next.threadId),
            baseBody: lastWords.current,
            files,
            baseFiles: lastWords.current !== null ? lastFiles.current.map((file) => file.upload_id) : null,
          },
          { keepalive: true },
        )
        .catch(() => {});
      sentWords.current.set(next.threadId, next.text);
      sentFiles.current.set(next.threadId, files);
      keptAlive.current = { threadId: next.threadId, text: next.text, files, generation: generationOf(next.threadId) };
    };
    // Back from the back/forward cache: the keepalive's answer was never read, and the `drafts` frames
    // sent meanwhile are not replayed. Read back what it saved.
    const onShow = (event: PageTransitionEvent) => {
      const kept = keptAlive.current;
      keptAlive.current = null;
      if (!event.persisted || !kept) return;
      chain.current = chain.current.then(() => readBack(kept.threadId, kept.text, kept.generation, kept.files));
    };
    window.addEventListener('pagehide', onHide);
    window.addEventListener('pageshow', onShow);
    return () => {
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pageshow', onShow);
    };
  }, []);

  /** The words changed: saved after a pause in typing (not while a Send holds the thread, nor after a conflict). */
  const save = useCallback(
    (text: string, files: ReplyDraftFiles = NO_FILES) => {
      const target = current.current;
      // Another machine's thread (linked machines): its drafts live on that machine, whose door takes none, so
      // the words stay in this box only.
      if (claimed.current.has(target) || machineOf(target)) return;
      // Longer than a draft holds: never sent (the Inbox would refuse it), said above the box instead.
      if (text.length > INBOX_DRAFT_BODY_MAX) {
        pending.current = null;
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        markTooLong(target, true);
        return;
      }
      if (tooLongThreads.has(target)) markTooLong(target, false);
      if (conflicts.current.has(target)) {
        // Emptied, or the same words the server holds: no conflict left. Otherwise still not
        // saved: the person chooses (Keep mine / Discard).
        if ((text.trim() === '' && files.length === 0) || replyContentKey(text, files) === (synced.current.get(target) ?? '')) {
          setConflict(target, null);
          setState((s) => ({ ...s, conflict: null }));
        } else setConflict(target, text);
        return;
      }
      pending.current = { threadId: target, text, files, seq: capture() };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, REPLY_DRAFT_SAVE_MS);
    },
    [flush],
  );

  /** Discard: the draft goes, here and on the server. */
  const discard = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    const target = current.current;
    bump(target);
    // A file still landing from an earlier Cancel or thread switch was thrown away with the rest.
    discards.set(target, discardsOf(target) + 1);
    setConflict(target, null);
    // Dropped: a draft holding these words later is another window's, never this one's (`base_body`).
    sentWords.current.delete(target);
    sentFiles.current.delete(target);
    learn(target, null);
    tooLongThreads.delete(target);
    refusedThreads.delete(target);
    unsavedChanged();
    setState({ loadedFor: target, draft: null, conflict: null, tooLong: false });
    if (machineOf(target)) return;
    chain.current = chain.current.then(() => storeRef.current.discard(target).then(() => undefined, () => undefined));
  }, []);

  /**
   * A Send starts: the words waiting are saved now, every save in flight is
   * answered, and the thread is claimed (no save of it runs until `sent` or
   * `release`). Resolves with the `updated_at` the box's words were saved as,
   * which the Send names in `clear_draft`; null when no draft holds them (none
   * saved, or the words were refused by a conflict, so the newer draft stays).
   */
  const claim = useCallback(async (): Promise<string | null> => {
    const target = current.current;
    flush();
    await chain.current;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    claimed.current.add(target);
    bump(target);
    if (conflicts.current.has(target)) return null;
    return baseOf(target);
  }, [flush]);

  /** The Send failed: the thread's words may be saved again (the caller saves the box's words). */
  const release = useCallback(() => {
    claimed.current.delete(current.current);
  }, []);

  /** The Send carried the words (the server deleted the draft with `clear_draft`): saves still queued do nothing. */
  const sent = useCallback(() => {
    const target = current.current;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    bump(target);
    claimed.current.delete(target);
    // Sent: a draft holding these words later is another window's, never this one's (`base_body`).
    sentWords.current.delete(target);
    sentFiles.current.delete(target);
    tooLongThreads.delete(target);
    refusedThreads.delete(target);
    unsavedChanged();
    setState((s) => (s.tooLong ? { ...s, tooLong: false } : s));
    // After a conflict the Send carried this window's words and cleared nothing: the other
    // window's draft is still there, and the thread shows it.
    if (conflicts.current.has(target)) {
      setConflict(target, null);
      setState((s) => ({ ...s, loadedFor: target, conflict: null }));
      return;
    }
    learn(target, null);
    setState({ loadedFor: target, draft: null, conflict: null, tooLong: false });
  }, []);

  /**
   * Read the thread's draft again (`event: drafts`: another window, or a phone's
   * Send, saved, sent or discarded it; or the foot's Send wants the words as they
   * are now). `boxWords` gives the open box's words and long pastes as the answer
   * comes (null: the box is closed).
   *
   * Only the newest read applies its answer, and one sent before this window
   * learned the draft itself (its save, Send or Discard answered meanwhile) is
   * read again (it gives up, answering undefined, after three reads). Once a Send claimed (or sent) the words, or a Discard dropped
   * them, the box's words are not edits: never written back as a draft.
   *
   * Unchanged since this window's base: nothing moves. Changed, and the box has
   * no edits since its last save or read (or is closed): the window takes the
   * server's draft, and `replaceBox` tells the thread to put its words in the
   * box (or close it when the draft is gone). Changed while the box HAS edits:
   * the base does not move, so this window's save (made now) is refused and the
   * conflict shows; neither window's words are lost.
   *
   * Answers undefined when it was not read (the thread changed, the read failed).
   */
  const reload = useCallback(async (boxWords: () => { text: string; files: ReplyDraftFiles } | null = () => null): Promise<{ draft: InboxReplyDraft | null; replaceBox: boolean } | undefined> => {
    const target = current.current;
    const read = ++readSeq.current;
    const generation = generationOf(target);
    let draft: InboxReplyDraft | null | undefined;
    for (let attempt = 0; ; attempt += 1) {
      // After this window's queued saves and Discard, so a read again is never served before them.
      await chain.current;
      if (target !== current.current) return undefined;
      const knew = learned.current;
      draft = await readDraft(target);
      if (draft === undefined || target !== current.current || read !== readSeq.current) return undefined;
      if (knew === learned.current) break;
      if (attempt === 2) return undefined;
    }
    const local = generation !== generationOf(target) || claimed.current.has(target) ? null : boxWords();
    if ((draft?.updated_at ?? null) === baseOf(target)) {
      show(target, draft);
      return { draft, replaceBox: false };
    }
    if (conflicts.current.has(target)) {
      // The choice is already showing: it now names the newest draft.
      adopt(target, draft);
      show(target, draft);
      return { draft, replaceBox: false };
    }
    const waitingHere = pending.current?.threadId === target;
    const edits = local !== null && (waitingHere || replyContentKey(local.text, local.files) !== (synced.current.get(target) ?? ''));
    if (edits) {
      if (waitingHere) flush();
      else write(target, local.text, local.files);
      return { draft, replaceBox: false };
    }
    adopt(target, draft);
    show(target, draft);
    return { draft, replaceBox: local !== null };
  }, [flush, write]);

  /**
   * After a conflict: these words go over the newer draft (or make one again), with its files and this window's
   * own file change since the conflict's base (`mergeReplyDraftFiles`): the box takes them once saved.
   */
  const keepMine = useCallback(
    (text: string, files: ReplyDraftFiles = NO_FILES) => {
      const target = current.current;
      const base = conflictFileBase.get(target);
      const theirs = stateRef.current.draft;
      setConflict(target, null);
      setState((s) => ({ ...s, conflict: null }));
      if (base === undefined || theirs === null) write(target, text, files);
      else
        write(
          target,
          text,
          placedIn(mergeReplyDraftFiles(base, files, draftFilesOf(theirs)), text),
          files.map((file) => file.upload_id),
        );
    },
    [write],
  );

  /**
   * After a conflict, Discard: this window's words and its file change go (the server's draft stays); the box takes
   * that draft (null: none, so the box empties).
   */
  const takeTheirs = useCallback((): InboxReplyDraft | null => {
    const target = current.current;
    setConflict(target, null);
    setState((s) => ({ ...s, conflict: null }));
    return stateRef.current.draft;
  }, []);

  /**
   * This window's Send of `words` may have gone without its answer (and with it cleared their draft):
   * a later save refused for that reason saves the box's words again instead of showing a conflict.
   */
  const expectOwnClear = useCallback((words: string) => {
    ownClears.current.set(current.current, words);
  }, []);

  /** A save is waiting for the pause in typing (the words are not on the server yet). */
  const waiting = useCallback(() => pending.current !== null, []);

  return { ...state, save, flush, discard, sent, waiting, claim, release, reload, keepMine, takeTheirs, expectOwnClear };
}

/** The thread's draft in the store (null: none), or undefined when it could not be read. */
async function readStoredDraft(store: ReplyDraftStore, threadId: string): Promise<InboxReplyDraft | null | undefined> {
  try {
    return await store.read(threadId);
  } catch {
    return undefined;
  }
}
