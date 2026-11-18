/**
 * Two of the thread bar's icon buttons (Thread.tsx, approval "inbox-thread-artifacts"): Artifacts (every file, image
 * and guided review in the thread, or only its links) with its count, and Expand / Fold all.
 */
import type { RefObject } from 'react';
import { Tip } from '../components/Tip';
import { Icon } from '../icons';
import { withShortcut } from '../shortcuts/hint';
import { inboxThreadShortcuts } from '../shortcuts/thread.shortcuts';

export function ArtifactsButton({ buttonRef, on, linksOnly, count, keys, onToggle }: { buttonRef: RefObject<HTMLButtonElement | null>; on: boolean; linksOnly: boolean; count: number; keys: string | undefined; onToggle: () => void }) {
  return (
    <Tip content={withShortcut(on ? 'Back to the thread' : linksOnly ? 'Links' : 'Artifacts: every file, image and guided review in this thread', { scope: inboxThreadShortcuts, action: 'artifacts' })}>
      <button ref={buttonRef} type="button" className="ib-iconbtn ib-artbtn" aria-label={linksOnly ? `Links, ${count}` : `Artifacts, ${count}`} aria-keyshortcuts={keys} aria-pressed={on} onClick={onToggle} data-artifacts-button="">
        <Icon name="artifacts" size={17} />
        <span className="ib-artbtn-n" aria-hidden="true">
          {count}
        </span>
      </button>
    </Tip>
  );
}

export function ExpandAllButton({ allOpen, onClick }: { allOpen: boolean; onClick: () => void }) {
  return (
    <Tip content={allOpen ? 'Fold the earlier messages' : 'Expand all messages'}>
      <button type="button" className="ib-iconbtn" data-expand-all="" onClick={onClick} aria-label={allOpen ? 'Fold the earlier messages' : 'Expand all messages'}>
        <Icon name={allOpen ? 'fold' : 'unfold'} size={16} />
      </button>
    </Tip>
  );
}
