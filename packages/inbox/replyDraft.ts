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
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxReplyDraft } from '@plannotator/core/inbox-types';
import { inboxApi, InboxApiError, pageServerSession } from './api';

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
}

/** Saves waiting or in flight anywhere on the page, and words left unsaved by a conflict (the restart guard reads them). */
let unsaved = 0;
/**
 * Per thread, the words a refused save carried (both windows hold words), not
 * saved. Module-level, not the hook's: the thread pane unmounts when the thread
 * closes or another opens, and these words must come back when it reopens.
 */
const conflictWords = new Map<string, string>();
export function replyDraftUnsaved(): boolean {
  return unsaved > 0 || conflictWords.size > 0;
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


export function useReplyDraft(threadId: string) {
  const [state, setState] = useState<ReplyDraftState>({ loadedFor: null, draft: null, conflict: null });
  const stateRef = useRef(state);
  stateRef.current = state;
  const chain = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef<{ threadId: string; text: string } | null>(null);
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
  /** Per thread: the words the server held as this window last saved or read them (null: no draft). */
  const synced = useRef(new Map<string, string | null>());
  /**
   * Per thread: this window's own Send (unconfirmed) may have cleared the draft holding these words.
   * A save refused because of it is not another window's doing: adopted, and the words saved again.
   */
  const ownClears = useRef(new Map<string, string>());
  /** The words the last save queued here carries (or the draft read): the page's last save names them (`base_body`). */
  const lastWords = useRef<string | null>(null);
  /** Per thread: the words of the last save this window sent, answered or not; the next save names them (`base_body`). */
  const sentWords = useRef(new Map<string, string>());
  /** Raised by each `reload`: only the newest read applies its answer. */
  const readSeq = useRef(0);
  /** Raised each time this window learns the draft itself (its save, Send, Discard, a read-back): a read sent before is read again. */
  const learned = useRef(0);
  /** The keepalive save sent as the page went (its answer is never read): read back when the page comes back. */
  const keptAlive = useRef<{ threadId: string; text: string; generation: number } | null>(null);

  const generationOf = (target: string) => generations.current.get(target) ?? 0;
  const bump = (target: string) => generations.current.set(target, generationOf(target) + 1);
  const baseOf = (target: string) => bases.current.get(target) ?? null;
  const setConflict = (target: string, words: string | null) => {
    if (words === null) conflicts.current.delete(target);
    else conflicts.current.set(target, words);
    unsavedChanged();
  };
  /** The server holds this draft for the thread now: its base and words, as this window knows them. */
  const adopt = (target: string, draft: InboxReplyDraft | null) => {
    bases.current.set(target, draft?.updated_at ?? null);
    synced.current.set(target, draft?.body ?? null);
    if (target === current.current) lastWords.current = draft?.body ?? null;
  };
  /** adopt, from this window's own save, Send, Discard or read-back (not from a `reload`). */
  const learn = (target: string, draft: InboxReplyDraft | null) => {
    adopt(target, draft);
    learned.current += 1;
  };
  const show = (target: string, draft: InboxReplyDraft | null) => {
    if (target === current.current) setState({ loadedFor: target, draft, conflict: conflicts.current.get(target) ?? null });
  };
  /**
   * A save of `text` went without its answer reaching here: it may have landed. The draft holding
   * those words is this window's own, so its base is that draft's (and the Send's clear_draft names it).
   */
  const readBack = async (target: string, text: string, generation: number) => {
    const latest = await readDraft(target);
    if (latest?.body !== text || generation !== generationOf(target) || claimed.current.has(target)) return;
    learn(target, latest);
    show(target, latest);
  };

  const write = useCallback((target: string, text: string) => {
    unsaved += 1;
    unsavedChanged();
    const generation = generationOf(target);
    if (target === current.current) lastWords.current = text;
    chain.current = chain.current.then(async () => {
      try {
        // Claimed by a Send, sent or discarded since this save was queued, or
        // waiting on the person's choice after a conflict: the words must not land.
        if (generation !== generationOf(target) || claimed.current.has(target) || conflicts.current.has(target)) return;
        let answer: { draft: InboxReplyDraft | null };
        // `base_body`: a save of this window's that landed without its answer still counts as its own.
        const baseBody = sentWords.current.get(target);
        sentWords.current.set(target, text);
        try {
          answer = await inboxApi.saveReplyDraft(target, text, baseOf(target), baseBody ?? null);
        } catch (cause) {
          if (!(cause instanceof InboxApiError) || cause.code !== 'draft_conflict') throw cause;
          // Refused: these words never landed, so they are not this window's on the server.
          if (baseBody === undefined) sentWords.current.delete(target);
          else sentWords.current.set(target, baseBody);
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
            if (generation === generationOf(target)) write(target, text);
            return;
          }
          learn(target, latest);
          // A conflict only when both windows hold words: an empty box (or the same words) is not one,
          // and never deletes the other window's draft.
          if (generation === generationOf(target) && text.trim() !== '' && text !== (latest?.body ?? '')) setConflict(target, text);
          show(target, latest);
          return;
        }
        if (generation !== generationOf(target)) return;
        learn(target, answer.draft ?? null);
        show(target, answer.draft ?? null);
      } catch {
        // No answer: read back what may have landed. Otherwise kept in the box; the next pause in typing tries again.
        await readBack(target, text, generation);
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
    if (next) write(next.threadId, next.text);
  }, [write]);

  // The thread's draft, read when it opens; what waited for the last thread is saved first.
  useEffect(() => {
    let live = true;
    setState({ loadedFor: null, draft: null, conflict: null });
    void chain.current.then(async () => {
      try {
        // An older Inbox answers 404 (caught below): no draft.
        const draft = (await inboxApi.replyDraft(threadId)).draft ?? null;
        if (!live) return;
        adopt(threadId, draft);
        setState({ loadedFor: threadId, draft, conflict: conflicts.current.get(threadId) ?? null });
      } catch {
        if (live) setState({ loadedFor: threadId, draft: null, conflict: conflicts.current.get(threadId) ?? null });
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
      const session = pageServerSession();
      void fetch(`/api/inbox/threads/${encodeURIComponent(next.threadId)}/draft`, {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        // `base` may be a step behind a save still on its way; `base_body` names the words that save carries.
        body: JSON.stringify({
          body: next.text,
          base: baseOf(next.threadId),
          ...(lastWords.current !== null ? { base_body: lastWords.current } : {}),
          ...(session ? { serverSession: session } : {}),
        }),
      }).catch(() => {});
      sentWords.current.set(next.threadId, next.text);
      keptAlive.current = { threadId: next.threadId, text: next.text, generation: generationOf(next.threadId) };
    };
    // Back from the back/forward cache: the keepalive's answer was never read, and the `drafts` frames
    // sent meanwhile are not replayed. Read back what it saved.
    const onShow = (event: PageTransitionEvent) => {
      const kept = keptAlive.current;
      keptAlive.current = null;
      if (!event.persisted || !kept) return;
      chain.current = chain.current.then(() => readBack(kept.threadId, kept.text, kept.generation));
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
    (text: string) => {
      const target = current.current;
      if (claimed.current.has(target)) return;
      if (conflicts.current.has(target)) {
        // Emptied, or the same words the server holds: no conflict left. Otherwise still not
        // saved: the person chooses (Keep mine / Discard).
        if (text.trim() === '' || text === (synced.current.get(target) ?? '')) {
          setConflict(target, null);
          setState((s) => ({ ...s, conflict: null }));
        } else setConflict(target, text);
        return;
      }
      pending.current = { threadId: target, text };
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
    setConflict(target, null);
    // Dropped: a draft holding these words later is another window's, never this one's (`base_body`).
    sentWords.current.delete(target);
    learn(target, null);
    setState({ loadedFor: target, draft: null, conflict: null });
    chain.current = chain.current.then(() => inboxApi.discardReplyDraft(target).then(() => undefined, () => undefined));
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
    // After a conflict the Send carried this window's words and cleared nothing: the other
    // window's draft is still there, and the thread shows it.
    if (conflicts.current.has(target)) {
      setConflict(target, null);
      setState((s) => ({ ...s, loadedFor: target, conflict: null }));
      return;
    }
    learn(target, null);
    setState({ loadedFor: target, draft: null, conflict: null });
  }, []);

  /**
   * Read the thread's draft again (`event: drafts`: another window, or a phone's
   * Send, saved, sent or discarded it; or the foot's Send wants the words as they
   * are now). `boxWords` gives the open box's words as the answer comes (null:
   * the box is closed).
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
  const reload = useCallback(async (boxWords: () => string | null = () => null): Promise<{ draft: InboxReplyDraft | null; replaceBox: boolean } | undefined> => {
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
    const edits = local !== null && (waitingHere || local !== (synced.current.get(target) ?? ''));
    if (edits) {
      if (waitingHere) flush();
      else write(target, local);
      return { draft, replaceBox: false };
    }
    adopt(target, draft);
    show(target, draft);
    return { draft, replaceBox: local !== null };
  }, [flush, write]);

  /** After a conflict: these words go over the newer draft (or make one again). */
  const keepMine = useCallback(
    (text: string) => {
      const target = current.current;
      setConflict(target, null);
      setState((s) => ({ ...s, conflict: null }));
      write(target, text);
    },
    [write],
  );

  /** After a conflict, Discard: this window's words go (the server's draft stays); the box takes that draft's words ('' for none). */
  const takeTheirs = useCallback((): string => {
    const target = current.current;
    setConflict(target, null);
    setState((s) => ({ ...s, conflict: null }));
    return stateRef.current.draft?.body ?? '';
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

/** The thread's draft on the server (null: none), or undefined when it could not be read. */
async function readDraft(threadId: string): Promise<InboxReplyDraft | null | undefined> {
  try {
    return (await inboxApi.replyDraft(threadId)).draft ?? null;
  } catch {
    return undefined;
  }
}
