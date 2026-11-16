import type { Dispatch, SetStateAction } from 'react';
import type { InboxTourChange, InboxTourState } from '@plannotator/core/inbox-types';
import { storage } from '@plannotator/ui/utils/storage';
import { InboxApiError, inboxApi, type SettingsModel } from '../api';
import type { InboxToastModel } from '../components/Toast';

export const TOUR_DECIDED_COOKIE = 'plannotator-inbox-tour-decided';
const TOUR_SAVE_RETRY_MS = [1000, 4000];

type ShowToast = (next: Omit<InboxToastModel, 'id'>, ms?: number) => void;

export function saveTour(change: InboxTourChange, setSettings: Dispatch<SetStateAction<SettingsModel | null>>, showToast: ShowToast): void {
  const now = new Date().toISOString();
  setSettings((current) =>
    current?.tour
      ? {
          ...current,
          tour: {
            ...current.tour,
            seen_at: change.seen ? now : current.tour.seen_at,
            finished_at: change.finished ? now : current.tour.finished_at,
            skipped_at: change.skipped ? now : current.tour.skipped_at,
            notify_again: change.notify_again ?? current.tour.notify_again,
          },
        }
      : current,
  );
  const adopt = (tour: InboxTourState) =>
    setSettings((current) => {
      if (!current) return current;
      const local = current.tour;
      return {
        ...current,
        tour: local
          ? { ...tour, seen_at: tour.seen_at ?? local.seen_at, finished_at: tour.finished_at ?? local.finished_at, skipped_at: tour.skipped_at ?? local.skipped_at }
          : tour,
      };
    });
  const decision = change.finished ? 'finished' : change.skipped ? 'skipped' : null;
  const attempt = (tries: number) => {
    void inboxApi.saveTour(change).then(
      ({ tour }) => adopt(tour),
      (cause: unknown) => {
        const status = cause instanceof InboxApiError ? cause.status : 0;
        if (tries < TOUR_SAVE_RETRY_MS.length && !(status >= 400 && status < 500)) {
          setTimeout(() => attempt(tries + 1), TOUR_SAVE_RETRY_MS[tries]);
          return;
        }
        if (!decision) return;
        storage.setItem(TOUR_DECIDED_COOKIE, decision);
        const why = cause instanceof Error ? cause.message : String(cause);
        showToast(
          {
            icon: 'warn',
            lead: 'Not saved',
            detail: 'This browser remembers the tour',
            speech: `The tour could not be saved: ${why} This browser remembers that you ${decision === 'finished' ? 'finished' : 'left'} it, so it will not offer itself again here.`,
          },
          6000,
        );
      },
    );
  };
  attempt(0);
}
