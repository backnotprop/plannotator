import { startTransition, useEffect, useState } from 'react';
import {
  EMPTY_REVIEW_FILE_FILTER,
  type ReviewFileFilter,
} from '@plannotator/shared/review-file-filter';

const FILTER_DELAY_MS = 100;

export function useReviewFileFilter() {
  const [applied, setApplied] = useState(EMPTY_REVIEW_FILE_FILTER);

  // The controls subscribe to the draft. The review receives only settled input.
  const [input] = useState(() =>
    createReviewFileFilterInput((filter) => {
      startTransition(() => setApplied(filter));
    }),
  );

  useEffect(() => input.cancel, [input]);

  return { applied, input };
}

interface FilterInputSnapshot {
  draft: ReviewFileFilter;
  open: boolean;
}

function createReviewFileFilterInput(onApply: (filter: ReviewFileFilter) => void) {
  let snapshot: FilterInputSnapshot = { draft: EMPTY_REVIEW_FILE_FILTER, open: false };
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  function publish(next: FilterInputSnapshot) {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function cancel() {
    clearTimeout(timer);
    timer = undefined;
  }

  return {
    getSnapshot: () => snapshot,

    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    toggle() {
      publish({ ...snapshot, open: !snapshot.open });
    },

    updateField(field: keyof ReviewFileFilter, value: string) {
      if (snapshot.draft[field] === value) return;

      const draft = { ...snapshot.draft, [field]: value };
      publish({ ...snapshot, draft });

      cancel();
      timer = setTimeout(() => {
        timer = undefined;
        onApply(draft);
      }, FILTER_DELAY_MS);
    },

    clear() {
      cancel();
      publish({ ...snapshot, draft: EMPTY_REVIEW_FILE_FILTER });
      onApply(EMPTY_REVIEW_FILE_FILTER);
    },

    cancel,
  };
}

export type ReviewFileFilterInput = ReturnType<typeof createReviewFileFilterInput>;
