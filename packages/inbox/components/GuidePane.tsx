/**
 * A guided review open in the Inbox (the record's 4.2): it takes the window
 * the way an attachment does, under a header naming who sent it, with
 * Plannotator's guide viewer below. The viewer mounts through a dynamic import
 * (React.lazy): in the single-file build its code is inline and its modules
 * run at page load, but nothing of the guide renders until Open. Reviewed
 * ticks are kept with the thread, on the message in the store, so they
 * survive a reload, another browser and the Inbox moving to another port.
 */

import { lazy, Suspense, useEffect, useState } from 'react';
import { parseGuideSnapshot, type GuideSnapshot } from '@plannotator/core/guide-format';
import type { InboxMessageWire, InboxThread } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { agentName, clockTime } from '../format';
import { Icon } from '../icons';

// `#guide-reader` is packages/inbox/guide/GuideReader.tsx (package.json `imports`).
const GuideReader = lazy(() => import('#guide-reader'));

export interface GuidePaneProps {
  thread: InboxThread;
  message: InboxMessageWire;
  /** Back to the thread. */
  onBack: () => void;
  /** Close the guide and the thread. */
  onClose: () => void;
}

export function GuidePane({ thread, message, onBack, onClose }: GuidePaneProps) {
  const [snapshot, setSnapshot] = useState<GuideSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState<boolean[]>(() => message.guide_reviewed ?? []);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSnapshot(null);
    setError(null);
    setReviewed(message.guide_reviewed ?? []);
    setSaveError(null);
    inboxApi
      .guide(message.id)
      .then((answer) => {
        if (cancelled) return;
        const parsed = parseGuideSnapshot(answer.snapshot);
        if (parsed.ok) setSnapshot(parsed.value);
        else setError(`This guided review could not be read (${parsed.error.path}: ${parsed.error.message}).`);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'The guided review did not load.');
      });
    return () => {
      cancelled = true;
    };
    // A tick saved from another tab arrives with the thread; the open pane keeps its own until then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message.id]);

  const changeReviewed = (next: boolean[]) => {
    setReviewed(next);
    setSaveError(null);
    inboxApi.saveGuideReviewed(message.id, next).then(
      (saved) => setReviewed(saved.reviewed),
      (cause: unknown) => setSaveError(cause instanceof Error ? cause.message : 'The reviewed tick was not saved.'),
    );
  };

  return (
    <section className="ib-viewer" aria-label="Guided review" data-guide-message={message.id}>
      <div className="ib-vhead">
        <button type="button" className="ib-back" onClick={onBack}>
          <Icon name="back" size={15} />
          Thread
        </button>
        <span className="ib-vsep" />
        <span className="ib-fn">Guided review</span>
        <span className="ib-from">
          from {agentName(message.author)} in {thread.project.name}, sent {clockTime(message.created_at)}
        </span>
        <span className="ib-sp" />
        <button type="button" className="ib-iconbtn" onClick={onClose} title="Close" aria-label="Close the guided review">
          <Icon name="x" />
        </button>
      </div>
      <div className="ib-gbody">
        {saveError && (
          <div className="ib-error ib-gerror" role="alert">
            {saveError}
          </div>
        )}
        {error ? (
          <div className="ib-error ib-gerror" role="alert">
            {error}
          </div>
        ) : snapshot ? (
          <Suspense fallback={null}>
            <GuideReader snapshot={snapshot} reviewed={reviewed} onReviewedChange={changeReviewed} />
          </Suspense>
        ) : null}
      </div>
    </section>
  );
}
