/**
 * The reason typed under an action item's "Can't do it…" in decision mode, kept as a draft like every answer: saved
 * after the typing pause (and at once on a move, Save, closing, or the page going, with a keepalive then), and read
 * back when the person returns to the card or opens the dialog again, on any computer the Inbox is open on. It lives
 * in the thread's comment drafts (one key per action item), which nothing lists or sends: the reason goes to the agent
 * only as the mark's note, once Save stages the mark.
 */
import { useState } from 'react';
import { inboxApi, InboxApiError } from '../api';
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
  /** Words waiting for their pause are saved now. */
  flush(): void;
  /** Every save answered: true when each reason is saved. */
  settled(): Promise<boolean>;
  /** The page hides or goes: the words waiting go now, with a keepalive request. */
  leave(): void;
}

export function createReasonDrafts(options: { onChange: (texts: ReadonlyMap<string, string>) => void; onFailed: (message: string) => void; store?: ReasonStore; delayMs?: number; timers?: TypedSavesTimers }): ReasonDrafts {
  const store = options.store ?? commentDrafts;
  const typed = createTypedSaves(options.delayMs, options.timers);
  let texts: ReadonlyMap<string, string> = new Map();
  const threads = new Map<string, string>();
  /** Read, or typed into, here: a read that lands later never replaces the person's words. */
  const known = new Set<string>();
  /** Reasons whose newest words are not saved: the next wait saves them again. */
  const owed = new Set<string>();
  const out = new Set<Promise<boolean>>();
  const set = (id: string, text: string) => {
    texts = new Map(texts).set(id, text);
    options.onChange(texts);
  };
  const save = (id: string, keepalive = false): Promise<boolean> => {
    const threadId = threads.get(id);
    if (!threadId) return Promise.resolve(true);
    const text = texts.get(id) ?? '';
    owed.delete(id);
    const run = store.write(threadId, reasonDraftKey(id), text, keepalive).then(
      () => true,
      (cause: unknown) => {
        // Not saved: the words stay on the card, and the next wait saves them (unless newer words already went).
        if ((texts.get(id) ?? '') === text) owed.add(id);
        options.onFailed(cause instanceof InboxApiError ? cause.message : 'Your reason was not saved.');
        return false;
      },
    );
    out.add(run);
    void run.finally(() => out.delete(run));
    return run;
  };
  return {
    text: (id) => texts.get(id) ?? '',
    load(threadId, id) {
      threads.set(id, threadId);
      if (known.has(id)) return;
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
      set(id, text);
      typed.type(id, () => void save(id));
    },
    flush: () => typed.flushAll(),
    async settled() {
      typed.flushAll();
      for (const id of [...owed]) void save(id);
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
