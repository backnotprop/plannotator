/**
 * A New message keeps what is written as its draft from the first key (the owner: "The moment I start typing text,
 * that's a draft."): saved after a pause in typing to the dialog's own draft id, sent with `keepalive` as the page
 * hides or goes (a reload, an update's restart, a phone backgrounding the tab), and the page's "Leave page?" asks
 * until a save holds it (`reportUnsentCompose`). Closing the dialog still keeps it as before
 * (Escape keeps, "Draft saved"); a Send waits for a save on its way (`settle`), so no save lands after the Send took
 * the draft. Emptied, a draft this dialog made is deleted again; a reopened draft emptied stays as it was.
 *
 * The Inbox keeps a draft with a compare-and-set on `updated_at` (`base`). Saves run one at a time, and each one's
 * body is built as it runs, on the `updated_at` the save before it landed as (null once this dialog deleted its draft),
 * so the dialog never refuses its own save. A refusal is another window's doing, except when an earlier save of this
 * dialog's got no answer and landed all the same: that is read back, taken as the dialog's own, and saved on.
 */
import { useEffect, useRef } from 'react';
import { apiPost, InboxApiError, inboxApi, type DraftView } from '../api';
import { inboxUrl } from '../inboxUrl';
import { reportUnsentCompose } from '../unsent';

/** How long typing pauses before a New message is saved. */
export const COMPOSE_AUTOSAVE_MS = 800;

export interface ComposeAutosaveOptions {
  /** The dialog's draft id (a reopened draft's, or the one made for it). */
  id: string;
  /** The `updated_at` of the draft the dialog opened (null: a new message, no draft yet). */
  opened: string | null;
  /** The dialog keeps drafts (not a review box, not the tour). */
  keeps: boolean;
  /** The draft did not exist when the dialog opened (emptied, the one this dialog made is deleted again). */
  fresh: boolean;
  /** Something is written that its draft does not hold yet (words, files, a thread name). */
  unsaved: boolean;
  /** Nothing is written (an empty compose is never a draft). */
  empty: boolean;
  /** A save may go now: no file uploading, no Send or save on its way, no conflict, not too long. */
  ready: boolean;
  /** What is written, as one string: a change starts the pause again. */
  written: string;
  /** The save's body (`inboxApi.saveDraft`'s input), from what is written now, on `base`. */
  input: (base: string | null) => Record<string, unknown>;
  /** The dialog holds this draft from now on (null: the draft it made was deleted again). */
  onDraft: (draft: DraftView | null) => void;
}

/** What an unanswered step of this dialog's may have done on the Inbox: saved these words, or deleted the draft. */
type Unanswered = { words: unknown } | 'deleted' | null;

export function useComposeAutosave(options: ComposeAutosaveOptions) {
  const latest = useRef(options);
  latest.current = options;
  /** The steps queued or running (one at a time, in order). */
  const flight = useRef<Promise<void>>(Promise.resolve());
  const steps = useRef(0);
  /** The `updated_at` of the draft as this dialog's last save landed it (null: none, or deleted by this dialog). */
  const base = useRef<string | null>(options.opened);
  /** A save of this dialog's landed: closing keeps it ("Draft saved"), a Send takes it. */
  const made = useRef(false);
  /** Another window changed the draft: no more quiet saves (Close shows the conflict, as before). */
  const refused = useRef(false);
  /** The last step whose answer never came (no network, the page frozen): it may have landed. */
  const unanswered = useRef<Unanswered>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  /** The dialog holds this draft now: its saves go on it, and quiet saves go on after a conflict was resolved. */
  const landed = (draft: DraftView) => {
    base.current = draft.updated_at;
    made.current = true;
    refused.current = false;
    unanswered.current = null;
    latest.current.onDraft(draft);
  };

  /** Run `step` after the steps before it; at once when none is on its way (the page may be going: no wait). */
  const queue = (step: () => Promise<void>) => {
    const go = () => step().finally(() => (steps.current -= 1));
    flight.current = steps.current === 0 ? go() : flight.current.then(go);
    steps.current += 1;
  };

  const saveOnce = async (keepalive: boolean, again = true): Promise<void> => {
    const now = latest.current;
    // What is written as this save runs (a step before it may have answered meanwhile), on what that step landed.
    if (!now.keeps || refused.current || now.empty) return;
    const body = now.input(base.current);
    try {
      landed((await apiPost<{ draft: DraftView }>(inboxUrl(`/drafts/${encodeURIComponent(now.id)}`), body, { keepalive })).draft);
    } catch (cause) {
      if (!(cause instanceof InboxApiError)) {
        unanswered.current = { words: body.body };
        return;
      }
      if (cause.code !== 'draft_conflict') return;
      // Refused. An earlier save (or delete) of this dialog's that got no answer may have landed: then the draft is this
      // dialog's own, and these words are saved on it. Otherwise another window changed it.
      const mine = unanswered.current;
      unanswered.current = null;
      if (mine && again) {
        const held = await inboxApi.drafts().then((list) => list.drafts.find((draft) => draft.id === now.id) ?? null, () => undefined);
        if (held !== undefined && (mine === 'deleted' ? held === null : held?.body === mine.words)) {
          base.current = held?.updated_at ?? null;
          return saveOnce(keepalive, false);
        }
      }
      refused.current = true;
    }
  };

  const saveNow = (keepalive = false) => {
    const now = latest.current;
    stopTimer();
    if (!now.keeps || refused.current) return;
    if (now.empty) {
      // Emptied: a draft this dialog made goes again (the person took the words out); a reopened one stays.
      if (made.current && now.fresh) {
        made.current = false;
        queue(() =>
          inboxApi.deleteDraft(now.id).then(
            () => {
              base.current = null;
              unanswered.current = null;
              latest.current.onDraft(null);
            },
            (cause) => {
              // Not deleted: it is still this dialog's draft. No answer: it may be gone.
              made.current = true;
              if (!(cause instanceof InboxApiError)) unanswered.current = 'deleted';
            },
          ),
        );
      }
      return;
    }
    if (!now.unsaved || !now.ready) return;
    queue(() => saveOnce(keepalive));
  };

  // A pause in typing saves what is written.
  useEffect(() => {
    if (!options.keeps || !options.ready || (!options.unsaved && !(options.empty && options.fresh && made.current))) return;
    stopTimer();
    timer.current = setTimeout(() => saveNow(), COMPOSE_AUTOSAVE_MS);
    return stopTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.written, options.ready, options.unsaved, options.empty, options.keeps]);

  // The page hides (a phone's app switch, a tab in the background) or goes (a reload, a closed tab): sent at once, or
  // right after a save still on its way (on the draft that one lands as).
  useEffect(() => {
    const onHide = () => saveNow(true);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') onHide();
    };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
      stopTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Words not saved yet: the page's "Leave page?" asks.
  const guarded = options.keeps && options.unsaved && !options.empty;
  useEffect(() => reportUnsentCompose(guarded), [guarded]);
  useEffect(() => () => reportUnsentCompose(false), []);

  return {
    /** A save of this dialog's landed (closing keeps the draft: "Draft saved"). */
    saved: () => made.current,
    /** The `updated_at` the dialog's next save goes on (null: no draft on the Inbox as far as it knows). */
    base: () => base.current,
    /**
     * The Inbox may hold this dialog's draft: a save of it landed, or one got no answer (it may have landed). A Send
     * names the draft then, so a draft it left behind never comes back after sending (the Inbox ignores an id it lacks).
     */
    mayHold: () => base.current !== null || (unanswered.current !== null && unanswered.current !== 'deleted'),
    /** The dialog's own save landed, or it took the other window's draft: its saves go on that one. */
    landed,
    /** Before a Send or the dialog's own save: no quiet save starts, and every one on its way is answered. */
    settle: async () => {
      stopTimer();
      for (let seen = flight.current; ; seen = flight.current) {
        await seen;
        if (seen === flight.current) break;
      }
    },
  };
}
