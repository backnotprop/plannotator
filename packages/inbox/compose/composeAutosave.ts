/**
 * A New message keeps what is written as its draft from the first key (the owner: "The moment I start typing text,
 * that's a draft."): saved after a pause in typing to the dialog's own draft id, sent with `keepalive` as the page
 * hides or goes (a reload, an update's restart, a phone backgrounding the tab), and the page's "Leave page?" asks
 * until a save holds it (`reportUnsentCompose`). Closing the dialog still keeps it as before
 * (Escape keeps, "Draft saved"); a Send waits for a save on its way (`settle`), so no save lands after the Send took
 * the draft. Emptied, a draft this dialog made is deleted again; a reopened draft emptied stays as it was.
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
  /** The save's body (`inboxApi.saveDraft`'s input), from what is written now. */
  input: () => Record<string, unknown>;
  /** A save landed: the dialog holds this draft from now on. */
  onSaved: (draft: DraftView) => void;
}

export function useComposeAutosave(options: ComposeAutosaveOptions) {
  const latest = useRef(options);
  latest.current = options;
  /** The save on its way (one at a time). */
  const flight = useRef<Promise<void>>(Promise.resolve());
  /** A save of this dialog's landed: closing keeps it ("Draft saved"), a Send takes it. */
  const made = useRef(false);
  /** Another window changed the draft: no more quiet saves (Close shows the conflict, as before). */
  const refused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const saveNow = (keepalive = false) => {
    const now = latest.current;
    stopTimer();
    if (!now.keeps || refused.current) return;
    if (now.empty) {
      // Emptied: a draft this dialog made goes again (the person took the words out); a reopened one stays.
      if (made.current && now.fresh) {
        made.current = false;
        flight.current = flight.current.then(() => inboxApi.deleteDraft(now.id).then(() => undefined, () => undefined));
      }
      return;
    }
    if (!now.unsaved || !now.ready) return;
    const body = now.input();
    flight.current = flight.current.then(async () => {
      try {
        const answer = await apiPost<{ draft: DraftView }>(inboxUrl(`/drafts/${encodeURIComponent(now.id)}`), body, { keepalive });
        made.current = true;
        latest.current.onSaved(answer.draft);
      } catch (cause) {
        if (cause instanceof InboxApiError && cause.code === 'draft_conflict') refused.current = true;
      }
    });
  };

  // A pause in typing saves what is written.
  useEffect(() => {
    if (!options.keeps || !options.ready || (!options.unsaved && !(options.empty && options.fresh && made.current))) return;
    stopTimer();
    timer.current = setTimeout(() => saveNow(), COMPOSE_AUTOSAVE_MS);
    return stopTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.written, options.ready, options.unsaved, options.empty, options.keeps]);

  // The page hides (a phone's app switch, a tab in the background) or goes (a reload, a closed tab): sent at once.
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
    /** Before a Send: no save starts, and the one on its way is answered. */
    settle: async () => {
      stopTimer();
      await flight.current;
    },
  };
}
