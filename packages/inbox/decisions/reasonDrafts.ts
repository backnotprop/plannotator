/**
 * The reason typed under an action item's "Can't do it…" in decision mode, kept as a draft like every answer: saved
 * after the typing pause (and at once on a move, Save, closing, or the page going, with a keepalive then), and read
 * back when the person returns to the card or opens the dialog again, on any computer the Inbox is open on. It lives
 * in the thread's comment drafts (one key per action item), which nothing lists or sends: the reason goes to the agent
 * only as the mark's note, once Save stages the mark.
 *
 * One reason's writes go one after another, each with the words as they are when it starts, so the last words always
 * land last. A thread on a linked computer keeps its reason on the card only: comment drafts are not forwarded there,
 * as the thread's own comment box keeps none for it (commentPictures.tsx).
 */
import { useState } from 'react';
import { inboxApi, InboxApiError } from '../api';
import { machineOf } from '../inboxUrl';
import { createTypedSaves, type TypedSavesTimers } from '../typedAnswers';

/** The comment-draft key of an action item's reason (`<message id>/<key>`). */
export const reasonDraftKey = (id: string) => `decision-reason:${id}`;

export interface ReasonStore {
  read: (threadId: string, key: string) => Promise<string | null>;
  write: (threadId: string, key: string, text: string, keepalive: boolean) => Promise<void>;
}

const commentDrafts: ReasonStore = {
  read: (threadId, key) => inboxApi.commentDraft(threadId, key).then(({ draft }) => draft?.text ?? null),
  // The last words typed stand (any window's): `force`, as a later click wins for picks.
  write: (threadId, key, text, keepalive) => inboxApi.saveCommentDraft(threadId, { key, text, images: [], base: null, force: true }, { keepalive }).then(() => undefined),
};

export interface ReasonDrafts {
  /** The reason on the card, typed here or read back; '' when none. */
  text(id: string): string;
  /** Read the saved reason once, when its card shows (words typed meanwhile win). */
  load(threadId: string, id: string): void;
  /** The person typed: drawn at once, saved once the typing pauses. */
  type(threadId: string, id: string, text: string): void;
  /**
   * The reason went with its mark (Save): its draft is emptied now. A failure of that write is not the person's to
   * fix (the reason is already in the mark): it is never told, never stops a reload, and is tried again quietly.
   */
  clear(threadId: string, id: string): void;
  /** Words waiting for their pause are saved now. */
  flush(): void;
  /** Every save answered: true when each reason is saved. */
  settled(): Promise<boolean>;
  /** The page hides or goes: the words waiting go now, with a keepalive request. */
  leave(): void;
}

export function createReasonDrafts(options: {
  onChange: (texts: ReadonlyMap<string, string>) => void;
  onFailed: (message: string) => void;
  store?: ReasonStore;
  /** The thread lives on a linked computer (its reason is never read or written). */
  far?: (threadId: string) => boolean;
  delayMs?: number;
  timers?: TypedSavesTimers;
}): ReasonDrafts {
  const store = options.store ?? commentDrafts;
  const far = options.far ?? ((threadId: string) => machineOf(threadId) !== null);
  const typed = createTypedSaves(options.delayMs, options.timers);
  let texts: ReadonlyMap<string, string> = new Map();
  const threads = new Map<string, string>();
  /** Read, or typed into, here: a read that lands later never replaces the person's words. */
  const known = new Set<string>();
  /** Reasons whose newest words are not saved: the next wait saves them again. */
  const owed = new Set<string>();
  /** Reasons emptied after their mark (`clear`): a failed write is tried again quietly, never told. */
  const quiet = new Set<string>();
  const quietOwed = new Set<string>();
  /** Each reason's write on its way, and the one waiting behind it. */
  const running = new Map<string, Promise<boolean>>();
  const waiting = new Map<string, Promise<boolean>>();
  const out = new Set<Promise<boolean>>();
  const set = (id: string, text: string) => {
    texts = new Map(texts).set(id, text);
    options.onChange(texts);
  };
  const track = (run: Promise<boolean>) => {
    out.add(run);
    void run.finally(() => out.delete(run));
    return run;
  };
  /** One write, with the words as they are now. */
  const write = (id: string, threadId: string, keepalive: boolean): Promise<boolean> => {
    const text = texts.get(id) ?? '';
    const silent = quiet.has(id) && text === '';
    const run = store.write(threadId, reasonDraftKey(id), text, keepalive).then(
      () => true,
      (cause: unknown) => {
        // Newer words were typed since, or a write waits behind this one: that one decides.
        if ((texts.get(id) ?? '') !== text || waiting.has(id)) return true;
        if (silent) {
          quietOwed.add(id);
          return true;
        }
        // Not saved: the words stay on the card, and the next wait saves them.
        owed.add(id);
        options.onFailed(cause instanceof InboxApiError ? cause.message : 'Your reason was not saved.');
        return false;
      },
    );
    running.set(id, run);
    void run.finally(() => {
      if (running.get(id) === run) running.delete(id);
    });
    return run;
  };
  const save = (id: string, keepalive = false): Promise<boolean> => {
    const threadId = threads.get(id);
    if (!threadId || far(threadId)) return Promise.resolve(true);
    owed.delete(id);
    quietOwed.delete(id);
    const before = running.get(id);
    if (!before) return track(write(id, threadId, keepalive));
    // The page going cannot wait for the write still out: the words also go on their own now.
    if (keepalive) void store.write(threadId, reasonDraftKey(id), texts.get(id) ?? '', true).catch(() => {});
    // A write still out: this one starts once it is answered, with the words as they are then (one waiting takes these).
    const queued = waiting.get(id);
    if (queued) return queued;
    const next = before.then(() => {
      waiting.delete(id);
      return write(id, threadId, false);
    });
    waiting.set(id, next);
    return track(next);
  };
  const retryQuiet = () => {
    for (const id of [...quietOwed]) void save(id);
  };
  return {
    text: (id) => texts.get(id) ?? '',
    load(threadId, id) {
      threads.set(id, threadId);
      if (known.has(id) || far(threadId)) return;
      known.add(id);
      void store.read(threadId, reasonDraftKey(id)).then(
        (text) => {
          if (text && !texts.has(id)) set(id, text);
        },
        () => known.delete(id),
      );
    },
    type(threadId, id, text) {
      threads.set(id, threadId);
      known.add(id);
      quiet.delete(id);
      set(id, text);
      typed.type(id, () => void save(id));
    },
    clear(threadId, id) {
      threads.set(id, threadId);
      known.add(id);
      quiet.add(id);
      typed.drop(id);
      set(id, '');
      void save(id);
    },
    flush() {
      typed.flushAll();
      retryQuiet();
    },
    async settled() {
      typed.flushAll();
      for (const id of [...owed]) void save(id);
      retryQuiet();
      const results = await Promise.all([...out]);
      return results.every(Boolean) && owed.size === 0;
    },
    leave() {
      for (const { id } of typed.take()) void save(id, true);
    },
  };
}

/** The sitting's reasons, drawn as they change. */
export function useReasonDrafts(onFailed: (message: string) => void): { reasons: ReasonDrafts; texts: ReadonlyMap<string, string> } {
  const [texts, setTexts] = useState<ReadonlyMap<string, string>>(new Map());
  const [reasons] = useState(() => createReasonDrafts({ onChange: setTexts, onFailed: (message) => onFailed(message) }));
  return { reasons, texts };
}
