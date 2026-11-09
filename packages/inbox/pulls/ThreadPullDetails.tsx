/**
 * The PR page's Details (description, comments, reviewers, checks, labels) in a thread's full-window review, when the
 * thread was handed exactly one PR (approval "inbox-review-details-panel"). The same panel and the same reads as the PR
 * page: the Inbox's PR list names the PR, then `GET /api/inbox/pulls/details`. A local review, or a thread handed
 * several PRs (a stack posts from each layer's own page), has none.
 */
import { useEffect, useRef, useState } from 'react';
import type { InboxPull, InboxThread } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { Icon } from '../icons';
import { inOverlay, isComposingKey, isEditableTarget, keyTarget, modalOpen } from '../shortcuts/guards';
import { PullDetails, usePullDetails } from './PullDetails';
import { forgeName } from './labels';

export type ThreadPullDetails = ReturnType<typeof useThreadPullDetails>;

/**
 * `known`: the pane's own read of the same PR (the post's), `undefined` when it reads none; it is not read twice.
 * `onOpen`: what else covers the code closes as the details open.
 */
export function useThreadPullDetails(thread: InboxThread, known: InboxPull | null | undefined, onOpen?: () => void) {
  const key = thread.pull_keys?.length === 1 ? thread.pull_keys[0]! : null;
  const ownRead = known === undefined;
  const [listed, setListed] = useState<InboxPull | null>(null);
  useEffect(() => {
    setListed(null);
    if (!key || !ownRead) return;
    const controller = new AbortController();
    inboxApi.pulls(false, controller.signal).then(
      (answer) => {
        if (!controller.signal.aborted) setListed(answer.pulls.find((pull) => pull.key === key) ?? null);
      },
      // The list could not be read: no details, as before.
      () => {},
    );
    return () => controller.abort();
  }, [key, ownRead]);
  const found = ownRead ? listed : known;
  const pull = key && found?.key === key ? found : null;
  const details = usePullDetails(pull ? key : null, pull ? `${pull.head_sha ?? ''}\u0000${pull.updated_at}` : '');
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const toggle = (event: React.MouseEvent<HTMLElement>) => {
    opener.current = event.currentTarget;
    if (!open) {
      details.retry();
      onOpen?.();
    }
    setOpen(!open);
  };
  const close = () => {
    setOpen(false);
    opener.current?.focus({ preventScroll: true });
  };
  // Escape closes the details before it closes the review: read on the document, after what is inside the page (a menu
  // over the bar marks its own Escape) and ahead of App's ladder on the window, and marked used so the ladder stands
  // down. The same Escape as the PR page's (`useSheetEscape`), not a new key.
  const closeRef = useRef(close);
  closeRef.current = close;
  const shown = open && !!pull;
  useEffect(() => {
    if (!shown) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isComposingKey(event) || modalOpen()) return;
      const from = keyTarget(event);
      if (from && (isEditableTarget(from) || inOverlay(from))) return;
      event.preventDefault();
      closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [shown]);
  useEffect(() => {
    if (open) panel.current?.focus({ preventScroll: true });
  }, [open]);
  // Tabbing out of the details closes them, so focus never lands unseen on what they cover (a click beside them does
  // not): the PR page's sheet keys.
  const tabbing = useRef(false);
  const keys = {
    onKeyDown: (event: React.KeyboardEvent) => {
      tabbing.current = event.key === 'Tab';
    },
    onKeyUp: () => {
      tabbing.current = false;
    },
    onBlur: (event: React.FocusEvent<HTMLElement>) => {
      const left = tabbing.current && event.relatedTarget instanceof Element && !event.currentTarget.contains(event.relatedTarget) && !inOverlay(event.relatedTarget);
      tabbing.current = false;
      if (left) setOpen(false);
    },
  };
  useEffect(() => setOpen(false), [key]);
  return { pull, details, open: shown, toggle, close, shut: () => setOpen(false), panel, keys };
}

/** A phone's row under the bar: the PR's title, which opens the details full screen, as on the PR page. */
export function ThreadPullTitleRow({ state }: { state: ThreadPullDetails }) {
  if (!state.pull) return null;
  return (
    <div className="ib-prp-row2" data-review-pull-row="">
      <button type="button" className={`ib-prp-this${state.open ? ' ib-on' : ''}`} aria-expanded={state.open} aria-label={`${state.pull.title}, opens details`} onClick={state.toggle} data-pull-details-button="">
        <bdi className="ib-prp-title">{state.pull.title}</bdi>
        <Icon name="chevD" size={13} />
      </button>
    </div>
  );
}

/** The panel over the review; a comment's file:line opens that file in All files (`onFile`). */
export function ThreadPullDetailsPanel({ state, phone, inDiff, onFile }: { state: ThreadPullDetails; phone: boolean; inDiff: (path: string) => boolean; onFile: (path: string) => void }) {
  const { pull, details } = state;
  if (!state.open || !pull) return null;
  return (
    <PullDetails
      layer={pull}
      description={details.data?.description}
      headSha={pull.head_sha}
      data={details.data}
      failed={details.failed}
      heldUntil={details.heldUntil}
      onRetry={details.retry}
      forge={forgeName(pull)}
      panel={state.panel}
      phone={phone}
      inDiff={inDiff}
      onClose={state.close}
      onFile={onFile}
      keys={state.keys}
      descriptionUnread={details.failed && !details.data}
    />
  );
}
