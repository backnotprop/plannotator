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
 * draft_conflict`: another window changed the WORDS, sent or discarded since)
 * is never written over: this window adopts the draft as the server holds it
 * and keeps its own words in the box as not saved (`conflict`), until the
 * person picks Keep mine (`keepMine`, saved over the newer draft) or Discard
 * (`takeTheirs`: only this window's words go). So a draft another window sent
 * never comes back holding the words it sent.
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
 * with its place in the words. A save does not send the box's list: it sends
 * the box's file CHANGES since the box last held the draft's files (added,
 * removed, and long pastes' places; `ReplyDraftFileOps`), and the Inbox applies
 * them to the draft's files as they are then. So a save never touches a file it
 * does not name: another window's file stays, one another window removed stays
 * out, and files never refuse a save (only different words do). Changes that
 * did not land (refused, unanswered, or the save skipped behind a conflict) are
 * never dropped: they go with the next save of the box (`carried`). After every
 * save of this window lands, the box takes the draft's files with this window's
 * changes still on their way (`onFiles`), so box and draft agree.
 *
 * A file still uploading when the box closes or the thread changes is not
 * lost: it lands in that thread's draft when its upload finishes
 * (`landInReplyDraft`).
 *
 * Storage is the host's (`store`, @plannotator/core/inbox-reply-draft's
 * `ReplyDraftStore`); this Inbox's is HTTP (replyDraftHttp.ts).
 */
import { isRemoteThread, keepRemoteWords, remoteKept, remoteWords, remoteWordsToSave, resetRemoteThreadsForTests, setRemoteThreads } from './remoteReplyWords';
import { clearLateVoiceMiss, noteLateVoiceMiss } from './lateVoice';
import { resetLostDraftFilesForTests } from './lostDraftFiles';
import { heldOffered, heldOfferEnds, heldSettling, offerHeld, resetHeldOffersForTests, settleHeld } from './replyDraftHeldOffer';
import { spaced } from './voiceField';
import { useCallback, useEffect, useRef, useState } from 'react';
import { INBOX_DRAFT_BODY_MAX, type InboxReplyDraft, type InboxUpload } from '@plannotator/core/inbox-types';
import {
  applyReplyDraftFileOps,
  composeReplyDraftFileOps,
  diffReplyDraftFiles,
  NO_FILE_OPS,
  rewordReplyDraftFileOps,
  type ReplyDraftFileOps,
  type ReplyDraftFileRef,
  type ReplyDraftStore,
} from '@plannotator/core/inbox-reply-draft';
import { httpReplyDraftStore } from './replyDraftHttp';
import { dropKept, forgetWords, keepWords, keptWordsGone, newKeptPageForTests, type KeptWords } from './replyWordsKept';
import { onInboxReconnected } from './sessionAdopt';
import { clearReplyMentions, noteDraftMentions, replyMentionsSave } from './threadMentions';

import { NO_FILES, codeOf, draftFilesOf, draftKey, idsOf, messageOf, noOps, placesIn, replyContentKey, type ReplyDraftFiles, type ReplyDraftState } from './replyDraftKeys';
export { replyContentKey, type ReplyDraftFiles, type ReplyDraftState };

/** How long typing pauses before the words are saved. */
export const REPLY_DRAFT_SAVE_MS = 500;

/** Saves waiting or in flight anywhere on the page, and words left unsaved by a conflict (the restart guard reads them). */
let unsaved = 0;
/** When a save last ended (landed or not): a drafts list asked for before then may not have it yet. */
let lastSaveEnded = 0;
/** When a reply draft save last ended on this page (0: none yet); the row menu's Mention in reply reads it. */
export function replyDraftSaveEndedAt(): number {
  return lastSaveEnded;
}
/**
 * Per thread, the words a refused save carried (both windows hold words), not
 * saved. Module-level, not the hook's: the thread pane unmounts when the thread
 * closes or another opens, and these words must come back when it reopens.
 */
const conflictWords = new Map<string, string>();
const offers = new Map<string, InboxReplyDraft>();
const offerWords = new Map<string, string>();
/** Per thread: the box's words when its offer came (what the box and the offered draft may both go on from). */
const offerFrom = new Map<string, string>();
/** Threads whose box holds more words than a draft takes: not saved (the restart guard asks). */
const tooLongThreads = new Set<string>();
/**
 * Threads whose last save did not land: refused for another reason (`validation_error` not about the
 * body's length), or no answer and not found when read back. Their words are not saved until a later
 * save lands (the restart guard asks meanwhile, and the line above the box says so: `failed`).
 */
const refusedThreads = new Set<string>();
/**
 * Per thread, the words of the last save that did not land (refused, or no answer and not found when read back), kept
 * at module level as `conflictWords` are: the box shows them again when the thread opens, and they are saved again on
 * their own (the stream back, the page back online, the thread opened again) and with the next key.
 */
const failedWords = new Map<string, string>();
/**
 * Per thread: the draft the words that did not land were typed over (its `updated_at`, and its words when known), from
 * the first save of them that did not land. They are saved again on that draft only: a draft changed since is the
 * conflict, never saved over. No entry (words an earlier page kept with no base): not saved again on their own, only by
 * the person's next key, Keep mine or a Send.
 */
const failedOver = new Map<string, { base: string | null; words?: string | null }>();
/** Words that did not land go (saved, or the person let them go), and the draft they were typed over with them. */
const dropFailed = (threadId: string): boolean => {
  failedOver.delete(threadId);
  return failedWords.delete(threadId);
};
/**
 * Per thread, the box's file changes that did not land (a refused or unanswered save, or saves skipped behind a
 * conflict) and wait for the next save of the box, which carries them (module-level, as `conflictWords`). Until
 * then the restart guard asks for a file added (one only the box holds: a restart would lose it). A removal not
 * landed loses nothing (the file comes back), and a long paste's place goes with the words.
 */
const carried = new Map<string, ReplyDraftFileOps>();
const carriesFiles = () => [...carried.values()].some((ops) => ops.add.length > 0);
/** Files that left the box still uploading (Cancel, another thread) and have not landed in their draft yet. */
let landing = 0;
/** Per thread: raised by each Discard here. A file still landing from before one joins no draft (it was thrown away). */
const discards = new Map<string, number>();
const discardsOf = (threadId: string) => discards.get(threadId) ?? 0;
/** A linked computer's thread whose draft is not kept there (machineDrafts.ts): dictated words for its closed box wait in this page for the box. */
const heldVoice = new Map<string, string[]>();
/** Words the box shows for the thread that no draft holds: a save that did not land, or a remote thread's kept words. */
const unsavedOf = (threadId: string): string | null => (isRemoteThread(threadId) ? remoteWords.get(threadId) : undefined) ?? failedWords.get(threadId) ?? null;
/** Per thread: the `updated_at` of the draft this page last knew (the draft words kept here were typed over). */
const baseKnown = new Map<string, string | null>();
/** Per thread: the words of a Keep mine on its way: kept in the browser until a save lands (replyWordsKept.ts). */
const keepingMine = new Map<string, string>();
/** Per thread: what this page keeps in the browser for it now (replyWordsKept.ts). */
const keptHere = new Map<string, KeptWords>();
/** Threads whose words an earlier page kept in the browser were looked for (once per thread, as it first opens). */
const lookedForKept = new Set<string>();
/** Threads with another machine's words kept by an earlier page, not yet known here as that machine's: looked for again. */
const remoteWaiting = new Set<string>();
/**
 * The words each thread holds here and no draft holds, kept in the browser as they change (every change of them is
 * followed by `unsavedChanged`), and let go there with them: a tab the browser ends loses none (replyWordsKept.ts).
 */
function syncKept(): void {
  const want = new Map<string, KeptWords>();
  // A remote thread's words are kept beside its other words (their own entry), never written over by them.
  for (const [id, words] of remoteWords) if (isRemoteThread(id)) want.set(`${id}\n`, { kind: 'remote', words, base: baseKnown.get(id) ?? null });
  for (const [id, words] of failedWords) want.set(id, { kind: 'failed', words, base: failedOver.get(id)?.base ?? null });
  // The box's newer words on their way win over older ones that did not land (those come back once these end).
  for (const [id, words] of keepingMine) want.set(id, { kind: 'failed', words, base: failedOver.has(id) ? failedOver.get(id)!.base : (baseKnown.get(id) ?? null) });
  for (const [id, words] of conflictWords) want.set(id, { kind: 'conflict', words, base: baseKnown.get(id) ?? null });
  const thread = (id: string) => (id.endsWith('\n') ? id.slice(0, -1) : id);
  for (const [id, kept] of want) {
    const was = keptHere.get(id);
    if (was && was.kind === kept.kind && was.words === kept.words && was.base === kept.base) continue;
    keptHere.set(id, kept);
    keepWords(thread(id), kept);
  }
  for (const id of [...keptHere.keys()]) {
    if (want.has(id)) continue;
    keptHere.delete(id);
    forgetWords(thread(id), id.endsWith('\n') ? ':remote' : '');
  }
}
/**
 * The thread opens for the first time in this page: words an earlier page (one now gone) kept for it in the browser and
 * this page does not hold come back as they were (a conflict's, or not saved: the thread's read then saves them on the
 * draft they were typed over, or shows the conflict). Another machine's words wait until the thread is known as its.
 * True when words came back.
 */
async function takeKeptBack(threadId: string): Promise<boolean> {
  if (lookedForKept.has(threadId)) return false;
  lookedForKept.add(threadId);
  // Each slot's newest: words not saved and a remote thread's page-only words are kept apart, so both come back.
  const other = await takeKeptSlot(threadId, false);
  return (await takeKeptSlot(threadId, true)) || other;
}
async function takeKeptSlot(threadId: string, remote: boolean): Promise<boolean> {
  const found = await keptWordsGone(threadId, remote);
  if (!found || (found.kind === 'remote' ? remoteWords.has(threadId) : conflictWords.has(threadId) || failedWords.has(threadId))) return false;
  const { key, ...kept } = found;
  if (kept.kind === 'remote' && !isRemoteThread(threadId)) {
    lookedForKept.delete(threadId);
    remoteWaiting.add(threadId);
    return false;
  }
  remoteWaiting.delete(threadId);
  if (!baseKnown.has(threadId)) baseKnown.set(threadId, kept.base);
  if (kept.kind === 'conflict') conflictWords.set(threadId, kept.words);
  else if (kept.kind === 'remote') remoteWords.set(threadId, kept.words);
  else {
    failedWords.set(threadId, kept.words);
    // With no base, the draft they were typed over is not known: they wait for the person (the line says "Not saved").
    if (kept.base !== null) failedOver.set(threadId, { base: kept.base });
    refusedThreads.add(threadId);
  }
  // Kept under this page's own entry now, then the gone page's goes.
  unsavedChanged();
  dropKept(key);
  return true;
}
/** The dictated words waiting for this thread's box (`landWordsInReplyDraft` on another machine's thread), taken once. */
export function takeHeldVoiceWords(threadId: string): string[] {
  const words = heldVoice.get(threadId) ?? [];
  heldVoice.delete(threadId);
  if (words.length > 0) unsavedChanged();
  return words;
}
export function replyDraftUnsaved(): boolean {
  return unsaved > 0 || landing > 0 || heldVoice.size > 0 || conflictWords.size > 0 || offerWords.size > 0 || tooLongThreads.size > 0 || refusedThreads.size > 0 || failedWords.size > 0 || remoteKept() || carriesFiles();
}
/**
 * DOM tests: the words this page keeps per thread, as a new page has them (a killed tab, or the next test). Saves still
 * on their way are left to end (their counts are theirs); this page's localStorage is the test's to keep or clear.
 */
export function resetReplyDraftPageForTests(): void {
  for (const kept of [conflictWords, offers, offerWords, offerFrom, failedWords, failedOver, carried, discards, heldVoice, remoteWords, sendsOut, baseKnown, keepingMine, keptHere]) kept.clear();
  tooLongThreads.clear();
  refusedThreads.clear();
  lookedForKept.clear();
  remoteWaiting.clear();
  resetRemoteThreadsForTests();
  resetLostDraftFilesForTests();
  resetHeldOffersForTests();
  newKeptPageForTests();
}

/**
 * A file that left the reply box still uploading (the box closed, or the person went to another thread): once
 * its upload is in, it joins that thread's draft, beside whatever words and files the draft holds then (the save
 * names that file alone and keeps the draft's words; read again if the words changed meanwhile). Until then the
 * restart guard asks. An upload that fails or is stopped joins nothing, nor does one whose draft this window
 * discarded meanwhile.
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
      if (draftFilesOf(latest).some((file) => file.upload_id === done.upload_id)) return;
      try {
        await store.save(
          threadId,
          {
            body: latest?.body ?? '',
            base: latest?.updated_at ?? null,
            baseBody: latest?.body ?? null,
            files: { add: [{ upload_id: done.upload_id }], remove: [], place: [] },
          },
          { keepalive: false },
        );
        return;
      } catch (cause) {
        // The words changed meanwhile (or the draft went): read it again and add the file to that one.
        if (codeOf(cause) !== 'draft_conflict') return;
      }
    }
  })().finally(() => {
    landing -= 1;
    unsavedChanged();
  });
}

/** Per thread: the Sends on their way. A draft read meanwhile may hold words the Send is carrying. */
const sendsOut = new Map<string, Set<Promise<void>>>();

/** A Send of this thread starts: words landing in its draft wait for it. Returns what ends the wait. */
export function replySendStarts(threadId: string): () => void {
  const sends = sendsOut.get(threadId) ?? new Set<Promise<void>>();
  sendsOut.set(threadId, sends);
  let end = () => {};
  const send = new Promise<void>((done) => (end = done));
  sends.add(send);
  return () => {
    sends.delete(send);
    end();
  };
}

/** This window discarded the thread's draft: a file or words already landing there stop. */
export function replyDraftDiscarded(threadId: string): void {
  discards.set(threadId, discardsOf(threadId) + 1);
  heldVoice.delete(threadId);
}

/**
 * Dictated words whose box is not open (the person closed it or moved on while they were being transcribed): they join
 * the end of that thread's draft as the Inbox holds it then, as `landInReplyDraft` does a file, never the box of the
 * thread now open. They wait for a Send of that thread on its way, so they are never added to the words it carries. A
 * discard after this starts stops it (one before it threw away other words, not these). Words that could not be saved
 * stay for the thread to offer again (lateVoice.ts).
 */
export function landWordsInReplyDraft(threadId: string, words: string, store: ReplyDraftStore = httpReplyDraftStore, canPersist: (threadId: string) => boolean = () => true): Promise<void> {
  if (!canPersist(threadId)) {
    heldVoice.set(threadId, [...(heldVoice.get(threadId) ?? []), words]);
    unsavedChanged();
    return Promise.resolve();
  }
  landing += 1;
  unsavedChanged();
  const discarded = discardsOf(threadId);
  const retry = () => {
    clearLateVoiceMiss(threadId);
    void landWordsInReplyDraft(threadId, words, store, canPersist);
  };
  return (async () => {
    for (let sends = sendsOut.get(threadId); sends?.size; sends = sendsOut.get(threadId)) await Promise.all(sends);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (discardsOf(threadId) !== discarded) return;
      const latest = await store.read(threadId).catch(() => undefined);
      if (discardsOf(threadId) !== discarded) return;
      if (latest === undefined) break;
      const body = latest?.body ?? '';
      try {
        await store.save(
          threadId,
          { body: `${body}${spaced(body.at(-1), undefined, words)}`, base: latest?.updated_at ?? null, baseBody: latest?.body ?? null, files: NO_FILE_OPS },
          { keepalive: false },
        );
        return;
      } catch (cause) {
        if (codeOf(cause) !== 'draft_conflict') break;
      }
    }
    noteLateVoiceMiss(threadId, retry);
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
  syncKept();
  for (const listener of unsavedListeners) listener();
}

export interface ReplyDraftOptions {
  /** Where drafts are kept (default: this Inbox's, over HTTP). */
  store?: ReplyDraftStore;
  /**
   * A save of this window's landed: the box takes the draft's files (the thread whose draft it is, the draft as
   * saved, and `wanted`: the ids the box holds now, the draft's files with this window's changes still on their
   * way applied). The box then says what it holds (`boxTook`).
   */
  onFiles?: (threadId: string, draft: InboxReplyDraft, wanted: readonly string[]) => void;
  /**
   * Only another window changed the words (this box still holds the words this window last knew): no conflict. The
   * box takes the draft's words (`was`: the words it should hold now), and this window's file changes are saved with
   * them. Answers `took` (open on that thread, its live words still `was`: it took them), `hidden` (the box is
   * closed or shows another thread: no words of this window's to keep, so the change is saved with the newer words
   * all the same) or `differs` (its live words changed since: the conflict shows).
   */
  onWords?: (threadId: string, draft: InboxReplyDraft, was: string) => ReplyBoxTook;
  ownedBox?: (threadId: string) => { text: string; files: ReplyDraftFiles } | null;
  /**
   * A saved draft is offered (Restore draft) and the person edited the box (or had typed before the thread's first read
   * answered): the box takes the offered draft with its words after it (`restoreOffer`), which saves it. Typing is
   * always saved: an offer never holds typed words back.
   */
  onOffer?: (threadId: string) => void;
  /** Whether the host keeps this thread's draft (default: always). Not kept: nothing is sent, the words wait here, guarded. */
  canPersist?: (threadId: string) => boolean;
  /** Told when `canPersist` may answer otherwise (its answer stops it): the words that waited are saved once. */
  onPersistenceChange?: (listener: () => void) => () => void;
  /** Threads known to live elsewhere (default none): only theirs are words kept here while `canPersist` says no. */
  isRemote?: (threadId: string) => boolean;
}

/** What the box did with another window's newer words (`onWords`). */
export type ReplyBoxTook = 'took' | 'hidden' | 'differs';

/** One save on its way (queued or in flight): its words and file changes, which a refused or skipped save hands on. */
interface QueuedSave {
  text: string;
  ops: ReplyDraftFileOps;
  /** Its words went into an offered draft taken since (`restoreOffer`): the newer save with both carries them. */
  taken?: boolean;
  /** Words that did not land, saved again (`retry`): sent on the draft they were typed over, never a newer one. */
  over?: { base: string | null; words?: string | null };
  /** The thread's generation as it was queued: a Send or Discard since makes it nothing to send. */
  generation: number;
}

export function useReplyDraft(threadId: string, options: ReplyDraftOptions = {}) {
  const [state, setState] = useState<ReplyDraftState>({ loadedFor: null, draft: null, conflict: null, tooLong: false, failed: false });
  const stateRef = useRef(state);
  stateRef.current = state;
  const storeRef = useRef(options.store ?? httpReplyDraftStore);
  storeRef.current = options.store ?? httpReplyDraftStore;
  const onFilesRef = useRef(options.onFiles);
  onFilesRef.current = options.onFiles;
  const onWordsRef = useRef(options.onWords);
  onWordsRef.current = options.onWords;
  const ownedBoxRef = useRef(options.ownedBox);
  ownedBoxRef.current = options.ownedBox;
  const onOfferRef = useRef(options.onOffer);
  onOfferRef.current = options.onOffer;
  const canPersistRef = useRef(options.canPersist);
  canPersistRef.current = options.canPersist;
  if (options.isRemote) setRemoteThreads(options.isRemote);
  const keeps =(target: string) => canPersistRef.current?.(target) ?? true;
  const readDraft = (target: string) => readStoredDraft(storeRef.current, target);
  const chain = useRef<Promise<void>>(Promise.resolve());
  /** The save waiting for the pause in typing: the words, the box's files (for the long pastes' places) and the changes since the last. */
  const pending = useRef<{ threadId: string; text: string; files: ReplyDraftFiles; ops: ReplyDraftFileOps } | null>(null);
  /** Per thread: the file ids the box held as of its last save or the last draft it took (the changes are from these). */
  const held = useRef(new Map<string, readonly string[]>());
  /** Per thread: the saves queued or in flight, oldest first. */
  const queued = useRef(new Map<string, QueuedSave[]>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = useRef(threadId);
  current.current = threadId;
  /** Per thread: the `updated_at` of the draft this window last knew (null: none). */
  const bases = useRef(new Map<string, string | null>());
  /** Per thread: raised by a Send's claim, the Send and Discard; a save queued under an older one does nothing. */
  const generations = useRef(new Map<string, number>());
  /** Threads a Send has claimed: no save of theirs runs until it ends or fails. */
  const claimed = useRef(new Set<string>());
  const offeredSends = useRef(new Set<string>());
  /** Threads whose Send is claiming them (its saves still answering): a refused save there is a conflict, never quiet. */
  const claiming = useRef(new Set<string>());
  /** The words refused saves left unsaved, per thread (module-level: they outlive the pane). */
  const conflicts = useRef(conflictWords);
  /** Per thread: the words that did not land this box holds (it typed them, or showed them as the thread opened). */
  const heldFailed = useRef(new Map<string, string>());
  /** The save of words queued as the page hid behind one on its way (kept in the browser, `keepingMine`, until it ends). */
  const hidden = useRef<{ threadId: string; save: QueuedSave } | null>(null);
  /** Per thread: what the server held as this window last saved or read it (`replyContentKey`; null: no draft). */
  const synced = useRef(new Map<string, string | null>());
  /** Per thread: that draft's words (null: no draft). */
  const syncedWords = useRef(new Map<string, string | null>());
  /** Per thread: the base and draft this window knew before a draft was offered (Restore draft), known again if it goes. */
  const beforeOffer = useRef(new Map<string, { base: string | null; key: string | null; words: string | null }>());
  /**
   * Per thread: this window's own Send (unconfirmed) may have cleared the draft holding these words.
   * A save refused because of it is not another window's doing: adopted, and the words saved again.
   */
  const ownClears = useRef(new Map<string, string>());
  /** Per thread: the words of the last save this window sent, answered or not; the next save names them (`base_body`). */
  const sentWords = useRef(new Map<string, string>());
  /** Raised by each `reload`: only the newest read applies its answer. */
  const readSeq = useRef(0);
  /** Raised each time this window learns the draft itself (its save, Send, Discard, a read-back): a read sent before is read again. */
  const learned = useRef(0);
  /** The keepalive save sent as the page went (its answer is never read): read back when the page comes back. */
  const keptAlive = useRef<{ threadId: string; text: string; ops: ReplyDraftFileOps; generation: number; over: NonNullable<QueuedSave['over']> } | null>(null);
  /**
   * Per thread: who the reply goes to, as the recipient pill chose it (approval "inbox-reply-recipient"); each save
   * of that thread names it (`recipients`), so the draft comes back aimed. No entry: the save names none, and the
   * draft keeps what it has.
   */
  const aims = useRef(new Map<string, readonly string[]>());
  const aimOf = (target: string): { recipients?: readonly string[] } => {
    const list = aims.current.get(target);
    return list ? { recipients: list } : {};
  };
  /**
   * Per thread: the message the reply quotes (approval "inbox-reply-quote"; null: none any more); each save of that
   * thread names it, so the draft comes back quoting it. No entry: the save names none, and the draft keeps its own.
   */
  const quotes = useRef(new Map<string, { of: string; words?: string } | null>());
  const quoteOf = (target: string): { quote?: { of: string; words?: string } | null } => (quotes.current.has(target) ? { quote: quotes.current.get(target) ?? null } : {});

  const generationOf = (target: string) => generations.current.get(target) ?? 0;
  const bump = (target: string) => generations.current.set(target, generationOf(target) + 1);
  const baseOf = (target: string) => bases.current.get(target) ?? null;
  const queuedOf = (target: string) => {
    let list = queued.current.get(target);
    if (!list) queued.current.set(target, (list = []));
    return list;
  };
  /** The box's file changes since it last held these files (and its long pastes' places now); it holds `files` from here on. */
  const take = (target: string, files: ReplyDraftFiles, text: string): ReplyDraftFileOps => {
    const changes = diffReplyDraftFiles(held.current.get(target) ?? [], files);
    held.current.set(target, idsOf(files));
    return { ...changes, place: placesIn(files, text) };
  };
  /** Changes left over for the thread's next save, and taken by it. */
  const carry = (target: string, ops: ReplyDraftFileOps) => {
    const next = composeReplyDraftFileOps(carried.get(target) ?? NO_FILE_OPS, ops);
    if (noOps(next)) carried.delete(target);
    else carried.set(target, next);
    unsavedChanged();
  };
  const takeCarried = (target: string): ReplyDraftFileOps => {
    const ops = carried.get(target) ?? NO_FILE_OPS;
    if (carried.delete(target)) unsavedChanged();
    return ops;
  };
  /** Every change of this window's not landed yet, oldest first: left over, queued, waiting for the pause. */
  const outstanding = (target: string): ReplyDraftFileOps => {
    let ops = carried.get(target) ?? NO_FILE_OPS;
    for (const save of queued.current.get(target) ?? []) ops = composeReplyDraftFileOps(ops, save.ops);
    if (pending.current?.threadId === target) ops = composeReplyDraftFileOps(ops, pending.current.ops);
    return ops;
  };
  /** A save of this window's landed as `draft`: the box takes its files, with this window's changes still on their way. */
  const boxTakes = (target: string, draft: InboxReplyDraft | null) => {
    if (!draft) return;
    onFilesRef.current?.(target, draft, idsOf(applyReplyDraftFileOps(draftFilesOf(draft), outstanding(target))));
  };
  const setConflict = (target: string, words: string | null) => {
    if (words === null) (conflicts.current.delete(target), heldOfferEnds(target));
    else {
      conflicts.current.set(target, words);
      // The conflict keeps the box's newest words: they stand for any that failed before (or a Keep mine refused).
      dropFailed(target);
      keepingMine.delete(target);
    }
    unsavedChanged();
  };
  /** The server holds this draft for the thread now: its base and words, as this window knows them. */
  const adopt = (target: string, draft: InboxReplyDraft | null) => {
    // The threads its words mention (approval "inbox-drag-threads"): the box paints them for these words.
    noteDraftMentions(target, draft);
    bases.current.set(target, draft?.updated_at ?? null);
    baseKnown.set(target, draft?.updated_at ?? null);
    synced.current.set(target, draftKey(draft));
    syncedWords.current.set(target, draft?.body ?? null);
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
  /**
   * The thread's words were refused for another reason or did not land (on; `over`: the draft the save was typed over,
   * unless words that failed before already name an older one), or a save of them landed or they went (off).
   */
  const markRefused = (target: string, on: boolean, words?: string, over?: { base: string | null; words?: string | null }) => {
    // A Keep mine on its way has ended: landed (off), or its words are kept as not saved (on).
    keepingMine.delete(target);
    // The words that did not land are kept for the thread (`failedWords`) until a save of them lands or they go.
    if (on && words !== undefined) {
      if (over && (!failedWords.has(target) || !failedOver.has(target))) failedOver.set(target, over);
      failedWords.set(target, words);
      // This box typed them: its next saves go on from them.
      heldFailed.current.set(target, words);
    } else if (!on) dropFailed(target);
    if (on === refusedThreads.has(target)) return unsavedChanged();
    if (on) refusedThreads.add(target);
    else refusedThreads.delete(target);
    unsavedChanged();
    if (target === current.current) setState((s) => ({ ...s, failed: on, unsaved: unsavedOf(target) }));
  };
  /**
   * A save of this window's landed with `text`. Words that did not land go with it when it carries them: it holds them,
   * or this box held them (it typed them, or showed them as the thread opened) and the person typed on from them.
   * Another box's save of other words leaves them waiting (their next try finds the draft changed: the conflict).
   */
  const landed = (target: string, text: string) => {
    const waiting = failedWords.get(target);
    // Words kept in the browser as the page hid stay there while their own save is still behind this one.
    const hid = hidden.current?.threadId === target ? hidden.current : null;
    const onWay = hid && queuedOf(target).includes(hid.save) ? keepingMine.get(target) : undefined;
    if (hid && onWay === undefined) hidden.current = null;
    if (waiting === undefined || text.includes(waiting) || heldFailed.current.get(target) === waiting) markRefused(target, false);
    else if (onWay === undefined && keepingMine.delete(target)) unsavedChanged();
    if (onWay !== undefined && !keepingMine.has(target)) {
      keepingMine.set(target, onWay);
      unsavedChanged();
    }
  };
  /** The words that did not land, as the box shows them now the thread opened: its next saves go on from them. */
  const holdFailed = (target: string) => {
    const waiting = failedWords.get(target);
    if (waiting !== undefined && !conflicts.current.has(target)) heldFailed.current.set(target, waiting);
  };
  /** Words kept for a linked computer's thread that keeps drafts now: not saved yet over the draft this window knew (saved there once, or the conflict). */
  const remoteToDraft = (target: string): boolean => {
    const words = remoteWordsToSave(target, keeps);
    if (words === undefined) return false;
    // They were typed after (in a box that showed) any words of the thread not saved before: the newest stand for
    // those, as a conflict keeps the box's newest words. Kept elsewhere first, then let go here.
    if (conflicts.current.has(target)) setConflict(target, words);
    else {
      failedWords.set(target, words);
      if (!failedOver.has(target) && baseKnown.has(target)) failedOver.set(target, { base: baseKnown.get(target) ?? null, ...(syncedWords.current.has(target) ? { words: syncedWords.current.get(target) ?? null } : {}) });
      refusedThreads.add(target);
    }
    remoteWords.delete(target);
    unsavedChanged();
    return true;
  };
  /**
   * Words of the person's the store says the draft does not hold (`notLanded`: a draft held for another computer met
   * newer words there, or was refused there): a conflict, as one met by a save here (Keep mine / Discard mine), or
   * words "Not saved" over the draft shown, saved again by the next key. Never joined to the draft by themselves. A
   * conflict waits while another choice does (replyDraftHeldOffer.ts; `edits`: the box's); answers its words when offered now.
   */
  const offerNotLanded = (target: string, draft: InboxReplyDraft | null, edits = false): string | undefined => {
    const lost = storeRef.current.notLanded?.(target);
    if (!lost || lost.words.trim() === '' || conflicts.current.has(target) || heldSettling(target, lost.version)) return;
    if (!lost.conflict) return void (failedWords.has(target) || markRefused(target, true, lost.words, { base: draft?.updated_at ?? null, words: draft?.body ?? null }));
    const words = offerHeld(target, lost, draft, edits || offers.has(target), failedWords.get(target));
    if (words !== undefined) (refusedThreads.delete(target), setConflict(target, words));
    return words;
  };
  /** Words taken back from a gone page that the box the person typed in (before they came back) does not show. */
  const notShown = (target: string, draft: InboxReplyDraft | null): string | undefined => {
    const words = conflicts.current.get(target) ?? failedWords.get(target);
    const mine = ownedBoxRef.current?.(target);
    return words !== undefined && mine && onOfferRef.current && !mine.text.includes(words) && !(draft?.body ?? '').includes(words) ? words : undefined;
  };
  /** The box takes them as it takes an offered draft, the words typed there after them; their save or the conflict's choice follows. */
  const takeLate = (target: string, words: string, draft: InboxReplyDraft | null) => {
    offers.set(target, { ...(draft ?? { v: 1 as const, thread_id: target, created_at: '', updated_at: '' }), body: words });
    offerFrom.set(target, '');
    onOfferRef.current?.(target);
  };
  const show = (target: string, draft: InboxReplyDraft | null) => {
    if (target === current.current) setState({ loadedFor: target, draft, conflict: conflicts.current.get(target) ?? null, tooLong: tooLongThreads.has(target), failed: refusedThreads.has(target), offer: offers.get(target) ?? null, unsaved: unsavedOf(target) });
  };
  /**
   * A draft read while the person's box (`ownedBox`: they typed in it since it opened) holds other words. `offer`: the
   * box held nothing unsaved, so the draft waits behind Restore draft until the box's next edit takes it in. `typed`:
   * the thread's first read answered after the person typed (nothing of theirs was saved over it): offered, and taken
   * in at once. `edits`: unsaved edits over a draft this window knew: the conflict, as ever.
   */
  const ownedChange = (target: string, draft: InboxReplyDraft | null, first = false): 'offer' | 'typed' | 'edits' | null => {
    const mine = ownedBoxRef.current?.(target) ?? null;
    if (!mine || !draft || mine.text === draft.body) {
      offers.delete(target);
      offerFrom.delete(target);
      return null;
    }
    const edits = pending.current?.threadId === target || carried.has(target) || replyContentKey(mine.text, mine.files) !== (synced.current.get(target) ?? '');
    const typedFirst = edits && first && !synced.current.has(target) && !!onOfferRef.current;
    if (edits && !typedFirst) return 'edits';
    if (!offers.has(target)) beforeOffer.current.set(target, { base: baseOf(target), key: synced.current.get(target) ?? null, words: syncedWords.current.get(target) ?? null });
    adopt(target, draft);
    offers.set(target, draft);
    offerFrom.set(target, typedFirst ? '' : mine.text);
    return typedFirst ? 'typed' : 'offer';
  };
  /**
   * The offered draft is gone (sent or discarded elsewhere) or a newer one took its place: the offer goes, never to be
   * taken in by a later key, and this window knows the draft it knew before the offer came (its base and words).
   */
  const dropOffer = (target: string) => {
    const before = beforeOffer.current.get(target);
    beforeOffer.current.delete(target);
    offers.delete(target);
    offerFrom.delete(target);
    offerWords.delete(target);
    if (before) {
      bases.current.set(target, before.base);
      baseKnown.set(target, before.base);
      synced.current.set(target, before.key);
      syncedWords.current.set(target, before.words);
    }
    unsavedChanged();
  };
  const offerToConflict = (target: string): boolean => {
    if (!offers.has(target)) return false;
    offers.delete(target);
    offerFrom.delete(target);
    const words = offerWords.get(target);
    offerWords.delete(target);
    if (words !== undefined) setConflict(target, words);
    unsavedChanged();
    if (target === current.current) setState((s) => ({ ...s, offer: null, conflict: conflicts.current.get(target) ?? null }));
    return true;
  };
  /**
   * The draft holds these words, every file these changes add and none they remove: only then did a save with no
   * answer land. Otherwise its changes are sent again; the Inbox skips an add of a file removed since the version
   * that save names (another window took it out), so sending a change again never brings a removed file back.
   */
  const holds = (draft: InboxReplyDraft | null | undefined, text: string, ops: ReplyDraftFileOps) => {
    if (!draft || draft.body !== text) return false;
    const ids = new Set(idsOf(draft.files ?? []));
    return ops.add.every((file) => ids.has(file.upload_id)) && ops.remove.every((id) => !ids.has(id));
  };

  /**
   * Save `text` with the box's file changes `given` (and any left over from saves that did not land). Saves run
   * one at a time, in order. One that does not land hands its changes to the next save of the box (or, none
   * queued, keeps them for the next): a change is never dropped, and an older save never goes after a newer one.
   */
  const write = useCallback((target: string, text: string, given: ReplyDraftFileOps = NO_FILE_OPS, over?: QueuedSave['over']) => {
    unsaved += 1;
    unsavedChanged();
    const generation = generationOf(target);
    const save: QueuedSave = { text, ops: composeReplyDraftFileOps(takeCarried(target), given), generation, ...(over ? { over } : {}) };
    queuedOf(target).push(save);
    /** No longer on its way. */
    const leave = () => {
      const list = queuedOf(target);
      const at = list.indexOf(save);
      if (at >= 0) list.splice(at, 1);
    };
    /** A newer save of the box is behind this one (queued, or waiting for the pause in typing). */
    const newer = () => queuedOf(target).length > 1 + queuedOf(target).indexOf(save) || pending.current?.threadId === target;
    /** Not landed: its changes go with the next save of the box (or wait for one). */
    const handOn = () => {
      const list = queuedOf(target);
      const next = list[list.indexOf(save) + 1];
      leave();
      if (next) next.ops = composeReplyDraftFileOps(save.ops, next.ops);
      else if (pending.current?.threadId === target) pending.current = { ...pending.current, ops: composeReplyDraftFileOps(save.ops, pending.current.ops) };
      else carry(target, save.ops);
    };
    /** Saved again on the newer draft: by the newer save behind it when there is one (it carries newer words), else now. */
    const again = () => {
      if (newer()) handOn();
      else {
        leave();
        write(target, save.text, save.ops);
      }
    };
    /**
     * Only another window changed the words: the box takes them, quietly, when no Send is claiming the thread, every
     * newer save of the box (queued or waiting) still carries `text` (each then carries `latest`'s words, its long
     * pastes' places moved to them) and the box took them or is not showing the thread (`onWords`). False, nothing
     * changed: a conflict.
     */
    const takeTheirWords = (text: string, latest: InboxReplyDraft): boolean => {
      if (claimed.current.has(target) || claiming.current.has(target) || !onWordsRef.current) return false;
      const list = queuedOf(target);
      const behind = list.slice(list.indexOf(save) + 1);
      const waiting = pending.current?.threadId === target ? pending.current : null;
      if (behind.some((later) => later.text !== text) || (waiting && waiting.text !== text)) return false;
      const was = [save, ...behind].map((one) => ({ one, text: one.text, ops: one.ops }));
      for (const one of [save, ...behind]) {
        one.ops = rewordReplyDraftFileOps(one.ops, text, latest.body);
        one.text = latest.body;
      }
      if (waiting) pending.current = { ...waiting, text: latest.body, ops: rewordReplyDraftFileOps(waiting.ops, text, latest.body) };
      if (onWordsRef.current(target, latest, text) !== 'differs') return true;
      for (const { one, text: words, ops } of was) Object.assign(one, { text: words, ops });
      if (waiting && pending.current?.threadId === target) pending.current = waiting;
      return false;
    };
    /** The newest words of the box on their way (waiting for the pause, or the last save queued). */
    const newestWords = (): string => {
      if (pending.current?.threadId === target) return pending.current.text;
      const list = queuedOf(target);
      return list.length > 0 ? list[list.length - 1].text : save.text;
    };
    chain.current = chain.current.then(async () => {
      // Read as it runs: a refused save before it may have given it another window's words (`takeTheirWords`).
      const text = save.text;
      // `base_body`: a save of this window's that landed without its answer still counts as its own. Words that did not
      // land, saved again, count only themselves (they may have landed): never a newer draft of another box's.
      const prior = sentWords.current.get(target);
      const baseBody = save.over ? text : prior;
      /** Refused: these words never landed, so they are not this window's on the server. */
      const unsend = () => {
        if (prior === undefined) sentWords.current.delete(target);
        else sentWords.current.set(target, prior);
      };
      /** The draft these words go on (as it runs): words that did not land go on the one they were typed over. */
      const over = save.over ?? { base: baseOf(target), ...(syncedWords.current.has(target) ? { words: syncedWords.current.get(target) ?? null } : {}) };
      try {
        // Sent or discarded since this save was queued (its changes went with the draft), or claimed by a Send
        // (which carries the box): nothing to save.
        if (generation !== generationOf(target) || claimed.current.has(target)) {
          leave();
          return;
        }
        // Its words are in the box's newer words now, after the draft it took in: that save carries them.
        if (save.taken) {
          handOn();
          return;
        }
        // Waiting on the person's choice after a conflict: the words must not land; the changes wait for Keep mine.
        if (conflicts.current.has(target) || offers.has(target)) {
          if (offers.has(target) && (text.trim() !== '' || save.ops.add.length > 0)) offerWords.set(target, text);
          handOn();
          return;
        }
        const ops = save.ops;
        let answer: { draft: InboxReplyDraft | null };
        sentWords.current.set(target, text);
        try {
          answer = await storeRef.current.save(target, { body: text, base: over.base, baseBody: baseBody ?? null, files: ops, ...aimOf(target), ...quoteOf(target), ...replyMentionsSave(target, text) }, { keepalive: false });
        } catch (cause) {
          if (codeOf(cause) === 'validation_error') {
            // Refused: not saved. For its size (the Inbox's own limit, a `body:` refusal) the line above the box
            // says so; any other refusal is not "too long": the words stay unsaved (the restart guard asks) until
            // the next pause in typing saves them, with these file changes.
            unsend();
            handOn();
            if (generation !== generationOf(target)) return;
            if (messageOf(cause).startsWith('body:')) markTooLong(target, true);
            else markRefused(target, true, text, over);
            return;
          }
          if (codeOf(cause) !== 'draft_conflict') throw cause;
          unsend();
          // Another window changed the words, sent or discarded since: adopt the draft as it is there.
          const latest = await readDraft(target);
          if (latest === undefined) {
            handOn();
            return;
          }
          const own = ownClears.current.get(target);
          if (own !== undefined && (latest === null || latest.body === own)) {
            // This window's own Send cleared (or still holds) the draft: these words, edited since, are the draft now.
            ownClears.current.delete(target);
            learn(target, latest);
            show(target, latest);
            if (generation === generationOf(target)) again();
            else leave();
            return;
          }
          // Words that did not land, saved again: only the words they were typed over (when known) are this window's.
          const knownWords = save.over ? (save.over.words ?? undefined) : syncedWords.current.get(target);
          if (generation === generationOf(target) && latest !== null && (latest.body === text || (knownWords !== undefined && latest.body === knownWords))) {
            // The words agree (or only this window changed them): saved again on the newer draft, quietly.
            learn(target, latest);
            show(target, latest);
            again();
            return;
          }
          if (generation === generationOf(target) && latest !== null && knownWords !== undefined && text === knownWords) {
            // Only the other window changed the words (this box holds the words it last knew): no conflict, when the
            // box takes the newer words. These file changes are then saved with them (by a newer save behind, if any).
            learn(target, latest);
            if (takeTheirWords(text, latest)) {
              show(target, latest);
              if (newer()) handOn();
              else {
                leave();
                write(target, latest.body, save.ops);
              }
              return;
            }
          }
          learn(target, latest);
          // A conflict only when both windows hold words: an empty box (or the same words) is not one, and never
          // deletes the other window's draft. Either way these file changes wait (Keep mine sends them). The words
          // kept are the box's newest (a key typed while this save was on its way).
          const newest = newestWords();
          const mine = newest.trim() !== '' ? newest : text;
          handOn();
          if (generation === generationOf(target) && mine.trim() !== '' && mine !== (latest?.body ?? '')) setConflict(target, mine);
          show(target, latest);
          return;
        }
        leave();
        if (generation !== generationOf(target)) return;
        landed(target, text);
        learn(target, answer.draft ?? null);
        show(target, answer.draft ?? null);
        boxTakes(target, answer.draft ?? null);
      } catch {
        // No answer: read back what may have landed. Otherwise not saved (the line above the box says so), its file
        // changes wait (the restart guard asks for them) and the next pause in typing tries again.
        const latest = await readDraft(target);
        if (generation === generationOf(target) && !claimed.current.has(target) && holds(latest, text, save.ops)) {
          leave();
          landed(target, text);
          learn(target, latest!);
          show(target, latest!);
          boxTakes(target, latest!);
        } else if (generation === generationOf(target)) {
          handOn();
          // Only words or a file added are something a restart would lose: an emptied box's save (a delete) that
          // did not land loses nothing, so it leaves the mark as it was.
          if (!claimed.current.has(target) && (text.trim() !== '' || save.ops.add.length > 0)) markRefused(target, true, text, over);
          // Emptied on purpose: words that failed before are not brought back.
          else if (dropFailed(target)) unsavedChanged();
        } else leave();
      } finally {
        unsaved -= 1;
        lastSaveEnded = Date.now();
        unsavedChanged();
      }
    });
  }, []);

  /** Save what waits now (leaving the thread, the page going away). */
  const flush = useCallback(() => {
    offerToConflict(current.current);
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next) write(next.threadId, next.text, next.ops);
  }, [write]);

  /**
   * Words whose save did not land, saved again (the stream is back, the page is online, the thread opened again): the
   * newest waiting for the pause in typing, or those that failed. Never while a save of the thread is on its way, a
   * Send holds it, or a choice (a conflict, an offer) or their length stands.
   */
  const retry = useCallback(
    (target: string) => {
      const words = failedWords.get(target);
      if (words === undefined || !keeps(target) || claimed.current.has(target) || conflicts.current.has(target) || offers.has(target) || tooLongThreads.has(target)) return;
      if (queuedOf(target).length > 0) return;
      if (pending.current?.threadId === target) flush();
      // On the draft they were typed over (a newer one refuses them: the conflict). Not known: they wait for the person.
      else if (failedOver.has(target)) write(target, words, NO_FILE_OPS, failedOver.get(target));
    },
    [flush, write],
  );
  /**
   * The thread's draft read (as it opens, or again with the box closed) while words typed here wait unsaved
   * (`failedWords`): a draft holding them has them saved; one unchanged since they were typed takes them now; one another
   * window or device saved since keeps both, as a conflict (Keep mine / Discard mine), never taken in quietly. Not known
   * what they were typed over and no draft: they stay, "Not saved", for the person.
   */
  const failedAfterRead = (target: string, words: string, draft: InboxReplyDraft | null) => {
    const over = failedOver.get(target);
    if ((draft?.body ?? '').includes(words)) return markRefused(target, false);
    if (over && (draft?.updated_at ?? null) === over.base) return retry(target);
    if (!over && draft === null) return;
    setConflict(target, words);
    markRefused(target, false);
    show(target, draft);
  };
  // The Inbox answers again (the stream reconnected, the page took a restarted Inbox's session) or the device is back
  // online: words whose save did not land are saved again, the open thread's and every other this window knows.
  useEffect(() => {
    const again = () => {
      for (const target of [...failedWords.keys()]) if (target === current.current || bases.current.has(target)) retry(target);
    };
    window.addEventListener('online', again);
    const stop = onInboxReconnected(again);
    return () => {
      window.removeEventListener('online', again);
      stop();
    };
  }, [retry]);

  // The thread's draft, read when it opens; what waited for the last thread is saved first.
  useEffect(() => {
    let live = true;
    // Words of this window's not saved (a conflict's, a save that did not land) are known before the read answers: a box
    // opened meanwhile holds them, so a key typed there goes after them, never in their place.
    holdFailed(threadId);
    setState({ loadedFor: null, draft: null, conflict: null, tooLong: tooLongThreads.has(threadId), failed: refusedThreads.has(threadId), unsaved: conflicts.current.get(threadId) ?? unsavedOf(threadId) });
    void chain.current.then(async () => {
      let tookBack = false;
      try {
        // Words an earlier page of this browser kept for the thread (a tab the browser ended) are this page's again, and
        // shown from now: a box opened after holds them.
        tookBack = await takeKeptBack(threadId);
        // Words kept for a linked computer's thread that keeps drafts now: the read below saves them, or shows the conflict.
        remoteToDraft(threadId);
        if (tookBack && live) setState((s) => ({ ...s, failed: refusedThreads.has(threadId), unsaved: conflicts.current.get(threadId) ?? unsavedOf(threadId) }));
        // An older Inbox answers 404 (caught below): no draft.
        const draft = await storeRef.current.read(threadId);
        if (!live) return;
        offerNotLanded(threadId, draft);
        // Words kept here that the draft holds now are saved: no conflict is left over them.
        const kept = conflicts.current.get(threadId);
        if (draft && kept !== undefined && draft.body.includes(kept)) setConflict(threadId, null);
        const waiting = failedWords.get(threadId);
        const change = ownedChange(threadId, draft, true);
        if (change === null) adopt(threadId, draft);
        // Words taken back after the person typed in the box are not held as shown there: the box takes them in below.
        const late = tookBack && change !== 'edits' ? notShown(threadId, draft) : undefined;
        if (late === undefined) holdFailed(threadId);
        setState({ loadedFor: threadId, draft, conflict: conflicts.current.get(threadId) ?? null, tooLong: tooLongThreads.has(threadId), failed: refusedThreads.has(threadId), offer: offers.get(threadId) ?? null, unsaved: unsavedOf(threadId) });
        if (late === undefined && change === 'typed') onOfferRef.current?.(threadId);
        else if (waiting !== undefined) failedAfterRead(threadId, waiting, draft);
        if (late !== undefined) takeLate(threadId, late, draft);
      } catch {
        if (!live) return;
        const late = tookBack ? notShown(threadId, null) : undefined;
        setState({ loadedFor: threadId, draft: null, conflict: conflicts.current.get(threadId) ?? null, tooLong: tooLongThreads.has(threadId), failed: refusedThreads.has(threadId), unsaved: unsavedOf(threadId) });
        if (late !== undefined) takeLate(threadId, late, null);
      }
    });
    return () => {
      live = false;
      offerToConflict(threadId);
      flush();
    };
  }, [threadId, flush]);
  // Remote words an earlier page kept, for a thread not yet known as remote when it opened: looked for again once it is.
  useEffect(() => {
    if (!remoteWaiting.has(threadId) || !isRemoteThread(threadId)) return;
    remoteWaiting.delete(threadId);
    void takeKeptBack(threadId).then((took) => took && saveRemote.current(threadId));
  });
  /** Words kept for a linked computer's thread that keeps drafts now are saved there (`remoteToDraft`); the box is told. */
  const saveRemote = useRef((_target: string) => {});
  saveRemote.current = (target: string) => {
    if (remoteToDraft(target)) retry(target);
    if (target === current.current) setState((s) => ({ ...s, failed: refusedThreads.has(target), unsaved: unsavedOf(target) }));
  };
  useEffect(() => options.onPersistenceChange?.(() => [...remoteWords.keys()].forEach((target) => saveRemote.current(target))), []);
  // A reload or a closed tab while a save waits: sent as the page goes (keepalive).
  useEffect(() => {
    /** `going`: the page goes (`pagehide`: a reload, a closed tab), so nothing queued here would run after it. */
    const onHide = (going = false) => {
      // What waits for the pause in typing, else words of the open thread whose save did not land.
      const open = current.current;
      const failed = failedWords.get(open);
      const failedOn = failedOver.get(open);
      // The page goes: words queued behind a save on its way (never sent: not the last words sent) would never run.
      const last = going ? queuedOf(open).at(-1) : undefined;
      const unsent = last && last.generation === generationOf(open) && last.text !== sentWords.current.get(open) ? { threadId: open, text: last.text, files: NO_FILES, ops: NO_FILE_OPS, over: last.over } : null;
      // Words that did not land go on the draft they were typed over (not known: they wait for the person).
      const next = pending.current ?? unsent ?? (failed !== undefined && failedOn && queuedOf(open).length === 0 ? { threadId: open, text: failed, files: NO_FILES, ops: NO_FILE_OPS, over: failedOn } : null);
      if (!next || keptAlive.current || !keeps(next.threadId) || claimed.current.has(next.threadId) || conflicts.current.has(next.threadId) || offers.has(next.threadId)) return;
      // A save of the thread on its way (a desktop tab switch mid-save): these words go after it, in order, as any save
      // does; a keepalive beside it could land first and refuse it as another window's change. Kept in the browser
      // until they land, so a tab ended meanwhile loses none.
      if (!going && queuedOf(next.threadId).length > 0) {
        if (next !== pending.current) return;
        flush();
        const queuedNow = queuedOf(next.threadId).at(-1);
        if (queuedNow && next.text.trim() !== '') {
          hidden.current = { threadId: next.threadId, save: queuedNow };
          keepingMine.set(next.threadId, next.text);
          unsavedChanged();
        }
        return;
      }
      pending.current = null;
      if (timer.current) clearTimeout(timer.current);
      const ops = composeReplyDraftFileOps(carried.get(next.threadId) ?? NO_FILE_OPS, next.ops);
      const given = 'over' in next ? next.over : undefined;
      const over = given ?? { base: baseOf(next.threadId), ...(syncedWords.current.has(next.threadId) ? { words: syncedWords.current.get(next.threadId) ?? null } : {}) };
      // The words go in the browser's keep (`carry` writes it) before the keepalive goes, whose answer is never read and
      // which may not land: a tab ended loses none. The file changes are kept until the page comes back and reads it back.
      if (next.text.trim() !== '') keepingMine.set(next.threadId, next.text);
      carry(next.threadId, next.ops);
      // `base_body`, as any save names it: the words of this window's last save SENT (it may have landed without its
      // answer), never words queued behind it; words that did not land, saved again, name only themselves.
      void storeRef.current
        .save(next.threadId, { body: next.text, base: over.base, baseBody: given ? next.text : (sentWords.current.get(next.threadId) ?? null), files: ops, ...aimOf(next.threadId), ...quoteOf(next.threadId), ...replyMentionsSave(next.threadId, next.text) }, { keepalive: true })
        .catch(() => {});
      sentWords.current.set(next.threadId, next.text);
      keptAlive.current = { threadId: next.threadId, text: next.text, ops, generation: generationOf(next.threadId), over };
    };
    // Back (the tab shown again, or from the back/forward cache): the keepalive's answer was never read, and the
    // `drafts` frames sent meanwhile may not be replayed. Read back what it saved; words it did not land are saved again.
    const readBack = () => {
      const kept = keptAlive.current;
      keptAlive.current = null;
      if (!kept) return;
      chain.current = chain.current.then(async () => {
        const latest = await readDraft(kept.threadId);
        if (kept.generation !== generationOf(kept.threadId) || claimed.current.has(kept.threadId)) return;
        if (!holds(latest, kept.text, kept.ops)) {
          // Not read (no answer yet): kept as not saved, and saved again once the Inbox answers.
          if (latest === undefined) {
            if (kept.text.trim() !== '') markRefused(kept.threadId, true, kept.text, kept.over);
          }
          // Newer words of the box on their way (typed since, queued or waiting for the pause) carry these and the file
          // changes kept for them: these older words are never saved after them.
          else if (!conflicts.current.has(kept.threadId) && queuedOf(kept.threadId).length === 0 && pending.current?.threadId !== kept.threadId) write(kept.threadId, kept.text, NO_FILE_OPS, kept.over);
          return;
        }
        takeCarried(kept.threadId);
        landed(kept.threadId, kept.text);
        learn(kept.threadId, latest!);
        show(kept.threadId, latest!);
        boxTakes(kept.threadId, latest!);
      });
    };
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) readBack();
      else keptAlive.current = null;
    };
    // A phone hides the page (another app, the tab switcher, the screen locked) without `pagehide`, and may end it there:
    // what waits is sent as the page hides, as it is when the page goes.
    const onVisibility = () => (document.visibilityState === 'hidden' ? onHide() : readBack());
    const onGo = () => onHide(true);
    window.addEventListener('pagehide', onGo);
    window.addEventListener('pageshow', onShow);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onGo);
      window.removeEventListener('pageshow', onShow);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  /** The words changed: saved after a pause in typing (not while a Send holds the thread, nor after a conflict). */
  const save = useCallback(
    (text: string, files: ReplyDraftFiles = NO_FILES) => {
      const target = current.current;
      if (claimed.current.has(target)) return;
      // A thread whose draft the host does not keep (`canPersist`): the words are kept in this page (remoteReplyWords.ts).
      if (!keeps(target)) return (keepRemoteWords(target, text), unsavedChanged());
      // Longer than a draft holds: never sent (the Inbox would refuse it), said above the box instead. The file
      // changes wait for the next save (the box keeps its last held files).
      if (text.length > INBOX_DRAFT_BODY_MAX) {
        if (pending.current?.threadId === target) carry(target, pending.current.ops);
        pending.current = null;
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        markTooLong(target, true);
        return;
      }
      if (tooLongThreads.has(target)) markTooLong(target, false);
      if (offers.has(target)) {
        carry(target, take(target, files, text));
        // The first edit while a saved draft waits: the box takes it in, these words after it, and that is saved.
        if (onOfferRef.current && (text.trim() !== '' || files.length > 0)) {
          offerWords.set(target, text);
          onOfferRef.current(target);
          return;
        }
        if (text.trim() !== '' || files.length > 0) offerWords.set(target, text);
        else offerWords.delete(target);
        unsavedChanged();
        return;
      }
      if (conflicts.current.has(target)) {
        // The box's file changes made meanwhile (a tile removed or attached) wait with the others, so they hold
        // after the conflict clears, Cancel and Edit draft; Keep mine counts from here, Discard mine drops them.
        carry(target, take(target, files, text));
        // Emptied, or the same words the server holds: no conflict left. Otherwise still not
        // saved: the person chooses (Keep mine / Discard).
        if ((text.trim() === '' && files.length === 0) || replyContentKey(text, files) === (synced.current.get(target) ?? '')) {
          setConflict(target, null);
          setState((s) => ({ ...s, conflict: null }));
        } else setConflict(target, text);
        return;
      }
      const before = pending.current?.threadId === target ? pending.current.ops : NO_FILE_OPS;
      pending.current = { threadId: target, text, files, ops: composeReplyDraftFileOps(before, take(target, files, text)) };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, REPLY_DRAFT_SAVE_MS);
    },
    [flush],
  );

  /** The box took a draft's files (it opened, a read replaced it, Discard of a conflict): its changes count from these ids. */
  const boxTook = useCallback((target: string, ids: readonly string[]) => {
    held.current.set(target, [...ids]);
  }, []);

  /** The ids the box's next save counts its changes from (a finished tile not among them is in no save yet). */
  const heldOf = useCallback((target: string): readonly string[] => held.current.get(target) ?? [], []);

  /**
   * The draft's files as this box shows them when it opens again: with this window's changes not landed yet (a file
   * added whose save got no answer is still here; one removed stays out).
   */
  const withMyChanges = useCallback(<F extends ReplyDraftFileRef>(files: readonly F[]): F[] => {
    return applyReplyDraftFileOps(files, outstanding(current.current) as ReplyDraftFileOps<F>);
  }, []);

  /** Discard: the draft goes, here and on the server. */
  const discard = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    const target = current.current;
    const offered = offers.get(target);
    if (offered) {
      offers.delete(target);
      offerWords.delete(target);
      offerFrom.delete(target);
      takeCarried(target);
      held.current.set(target, []);
      unsavedChanged();
      setState({ loadedFor: target, draft: offered, conflict: null, tooLong: false, failed: false });
      return;
    }
    bump(target);
    // The version thrown away (a store for another computer discards only it, or the words this window saved last, which
    // a save on its way lands as newer), and whether a draft was shown: a host's one goes too, so it never comes back.
    const [base, baseBody] = [baseOf(target), sentWords.current.get(target)];
    const shown = base !== null || stateRef.current.draft !== null;
    // A file still landing from an earlier Cancel or thread switch was thrown away with the rest.
    replyDraftDiscarded(target);
    setConflict(target, null);
    takeCarried(target);
    held.current.set(target, []);
    // Dropped: a draft holding these words later is another window's, never this one's (`base_body`).
    sentWords.current.delete(target);
    clearReplyMentions(target);
    learn(target, null);
    tooLongThreads.delete(target);
    refusedThreads.delete(target);
    dropFailed(target);
    remoteWords.delete(target);
    keepingMine.delete(target);
    unsavedChanged();
    setState({ loadedFor: target, draft: null, conflict: null, tooLong: false, failed: false });
    if (!keeps(target) && !shown) return;
    chain.current = chain.current.then(() => storeRef.current.discard(target, { base, ...(baseBody !== undefined ? { baseBody } : {}) }).then(() => undefined, () => undefined));
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
    if (offers.has(target)) offeredSends.current.add(target);
    // From here a save refused because another window changed the words is a conflict (never taken quietly): the
    // Send must not clear a draft holding words it does not carry.
    claiming.current.add(target);
    try {
      // File changes still waiting for a save (one got no answer) go first, so the draft the Send clears is the box's:
      // with a save waiting, it carries them; otherwise a save of the draft's words does.
      // Words whose save did not land go first too, so the draft holds what the Send carries.
      if (failedWords.has(target)) retry(target);
      else if (carried.has(target) && pending.current?.threadId !== target) write(target, syncedWords.current.get(target) ?? '');
      flush();
      // Every save answered, those a refused save queued again too.
      for (let seen = chain.current; ; seen = chain.current) {
        await seen;
        if (seen === chain.current) break;
      }
    } finally {
      claiming.current.delete(target);
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    claimed.current.add(target);
    bump(target);
    if (conflicts.current.has(target) || offeredSends.current.has(target)) return null;
    return baseOf(target);
  }, [flush, write, retry]);

  /** The Send failed: the thread's words may be saved again (the caller saves the box's words). */
  const release = useCallback((thread?: string) => {
    const target = thread ?? current.current;
    offeredSends.current.delete(target);
    claimed.current.delete(target);
  }, []);

  /** The Send carried the words (the server deleted the draft with `clear_draft`): saves still queued do nothing. */
  const sent = useCallback((thread?: string) => {
    const target = thread ?? current.current;
    const open = target === current.current;
    if (open && timer.current) clearTimeout(timer.current);
    if (open) timer.current = null;
    if (open || pending.current?.threadId === target) pending.current = null;
    bump(target);
    claimed.current.delete(target);
    takeCarried(target);
    held.current.set(target, []);
    // Sent: a draft holding these words later is another window's, never this one's (`base_body`).
    sentWords.current.delete(target);
    // Its mentions went with it: none is left to paint in words typed next (another window's draft keeps its own).
    clearReplyMentions(target);
    tooLongThreads.delete(target);
    refusedThreads.delete(target);
    dropFailed(target);
    remoteWords.delete(target);
    keepingMine.delete(target);
    unsavedChanged();
    if (!open) {
      if (conflicts.current.has(target) || offeredSends.current.delete(target)) setConflict(target, null);
      else learn(target, null);
      return;
    }
    setState((s) => (s.tooLong || s.failed ? { ...s, tooLong: false, failed: false } : s));
    // After a conflict the Send carried this window's words and cleared nothing: the other
    // window's draft is still there, and the thread shows it.
    if (conflicts.current.has(target) || offeredSends.current.delete(target)) {
      setConflict(target, null);
      setState((s) => ({ ...s, loadedFor: target, conflict: null }));
      return;
    }
    learn(target, null);
    setState({ loadedFor: target, draft: null, conflict: null, tooLong: false, failed: false });
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
   * conflict shows; neither window's words are lost. Held words offered now: `offered`.
   *
   * Answers undefined when it was not read (the thread changed, the read failed).
   */
  const reload = useCallback(async (boxWords: () => { text: string; files: ReplyDraftFiles } | null = () => null): Promise<{ draft: InboxReplyDraft | null; replaceBox: boolean; offered?: string } | undefined> => {
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
    // The offered draft was sent or discarded elsewhere, or a newer one took its place: its words never come back.
    const shownOffer = offers.get(target);
    if (shownOffer && (draft?.updated_at ?? null) !== shownOffer.updated_at) dropOffer(target);
    const local = generation !== generationOf(target) || claimed.current.has(target) ? null : boxWords();
    const waitingHere = pending.current?.threadId === target;
    const edits = local !== null && (waitingHere || carried.has(target) || replyContentKey(local.text, local.files) !== (synced.current.get(target) ?? ''));
    // Words of the person's the draft there does not hold are a conflict, never replaced; offered now, the box takes them.
    const offered = offerNotLanded(target, draft, edits);
    if ((draft?.updated_at ?? null) === baseOf(target) && offered === undefined) {
      show(target, draft);
      return { draft, replaceBox: false };
    }
    if (conflicts.current.has(target)) {
      // The choice is already showing (or offered now): it now names the newest draft.
      adopt(target, draft);
      show(target, draft);
      return { draft, replaceBox: false, ...(offered !== undefined ? { offered } : {}) };
    }
    if (local !== null && draft !== null && ownedChange(target, draft) === 'offer') {
      show(target, draft);
      return { draft, replaceBox: false };
    }
    if (edits) {
      // Saved now: its answer brings the newer draft's files into the box, beside this window's.
      if (waitingHere) flush();
      else write(target, local.text, take(target, local.files, local.text));
      return { draft, replaceBox: false };
    }
    adopt(target, draft);
    const failed = failedWords.get(target);
    if (failed !== undefined && local === null) {
      // The box closed while its words wait unsaved: a draft changed since they were typed is the conflict (their next
      // try would otherwise save them over it); one holding them has them saved.
      failedAfterRead(target, failed, draft);
      show(target, draft);
      return { draft, replaceBox: false };
    }
    show(target, draft);
    return { draft, replaceBox: local !== null };
  }, [flush, write]);

  /**
   * After a conflict: these words go over the newer draft (or make one again), with this window's file changes
   * (those the refused saves carried and any since): the newer draft's other files stay, and the box takes the result.
   */
  const keepMine = useCallback(
    (text: string, files: ReplyDraftFiles = NO_FILES) => {
      const target = current.current;
      const version = heldOffered(target);
      // Kept in the browser until the save lands (replyWordsKept.ts): a tab ended meanwhile loses none of them.
      if (text.trim() !== '') keepingMine.set(target, text);
      setConflict(target, null);
      setState((s) => ({ ...s, conflict: null }));
      write(target, text, take(target, files, text));
      letOfferedGo(target, version, true);
    },
    [write],
  );

  /** Words a conflict met there offered go, only the version this page put in the box: Discard mine at once; Keep mine once its save is through. */
  const letOfferedGo = (target: string, version: string | undefined, kept = false) => {
    const choose = () => (kept && (conflicts.current.has(target) || failedWords.has(target) || queuedOf(target).length > 0) ? undefined : storeRef.current.discard(target, { notLanded: version! }));
    if (version !== undefined) chain.current = chain.current.then(settleHeld(target, version, choose));
  };

  /**
   * After a conflict, Discard: this window's words and its file changes go (the server's draft stays); the box takes
   * that draft (null: none, so the box empties).
   */
  const takeTheirs = useCallback((): InboxReplyDraft | null => {
    const target = current.current;
    const version = heldOffered(target);
    setConflict(target, null);
    takeCarried(target);
    setState((s) => ({ ...s, conflict: null }));
    letOfferedGo(target, version);
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

  /**
   * The open thread's words kept here and not saved, as they are now (a conflict's, a save that did not land, another
   * machine's thread): read after a Send's claim, whose save of them may have landed (then none is left: the draft holds them).
   */
  const unsavedNow = useCallback((): string | null => conflicts.current.get(current.current) ?? unsavedOf(current.current), []);
  /**
   * Before a reload (the stale page notice, stalePage.ts): the box's words (`text`, null for a closed box) and files
   * (`draftFiles`) are saved now, with this window's file changes still waiting (`carried`), and every save is
   * answered. A save the Inbox refused earlier (it restarted under the page) is made again. True when the Inbox holds
   * exactly these words and files; false while they are not saved (a conflict to resolve, too long, refused, no answer,
   * a file change still waiting, a Send on its way). A far thread whose draft is not kept there: true, as a reload always did.
   */
  const settle = useCallback(
    async (text: string | null, files: ReplyDraftFiles = NO_FILES): Promise<boolean> => {
      const target = current.current;
      if (!keeps(target)) return true;
      if (text !== null && (carried.has(target) || replyContentKey(text, files) !== (synced.current.get(target) ?? ''))) save(text, files);
      else if (text === null && carried.has(target)) write(target, syncedWords.current.get(target) ?? '');
      flush();
      for (let seen = chain.current; ; seen = chain.current) {
        await seen;
        if (seen === chain.current) break;
      }
      if (target !== current.current || claimed.current.has(target) || conflicts.current.has(target)) return false;
      if (tooLongThreads.has(target) || refusedThreads.has(target) || carried.has(target)) return false;
      return text === null || replyContentKey(text, files) === (synced.current.get(target) ?? '');
    },
    [save, flush, write],
  );

  /**
   * Who the reply goes to, from the recipient pill (null: none chosen): the open thread's next saves name it. The
   * caller saves the box's words after it, so a draft already kept learns it too.
   */
  const aim = useCallback((recipients: readonly string[] | null) => {
    aims.current.set(current.current, recipients ? [...recipients] : []);
  }, []);

  /**
   * The message the reply quotes (null: none): the open thread's next saves name it. The caller saves the box's words
   * after it, so a draft already kept learns it too.
   */
  const quote = useCallback((value: { of: string; words?: string } | null) => {
    quotes.current.set(current.current, value ? { ...value } : null);
  }, []);

  /**
   * Restore draft, or the box's first edit while the offer stands: the offered draft (null: none), whether words were
   * typed since it came (`typed`) and the box's words when it came (`from`). A save queued before this carried words the
   * box now holds after the draft: the save of the box's words does it.
   */
  const restoreOffer = useCallback((): { draft: InboxReplyDraft; typed: boolean; from: string } | null => {
    const target = current.current;
    const draft = offers.get(target);
    const typed = offerWords.has(target);
    const from = offerFrom.get(target) ?? '';
    offers.delete(target);
    offerWords.delete(target);
    offerFrom.delete(target);
    beforeOffer.current.delete(target);
    if (draft) for (const queuedSave of queuedOf(target)) queuedSave.taken = true;
    unsavedChanged();
    setState((s) => ({ ...s, offer: null }));
    return draft ? { draft, typed, from } : null;
  }, []);

  return { ...state, restoreOffer, save, flush, discard, sent, waiting, unsavedNow, claim, release, reload, keepMine, takeTheirs, expectOwnClear, boxTook, heldOf, withMyChanges, settle, aim, quote };
}

/** The thread's draft in the store (null: none), or undefined when it could not be read. */
async function readStoredDraft(store: ReplyDraftStore, threadId: string): Promise<InboxReplyDraft | null | undefined> {
  try {
    return await store.read(threadId);
  } catch {
    return undefined;
  }
}
