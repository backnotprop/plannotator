/**
 * Reviews' "On this computer" (approval "inbox-reviews-compact-list", part 2; picture r2-local-entry-dark.png): a
 * folded group at the foot of the list with this computer's work that is in no pull request, for every project (the
 * list's project filter keeps its own): each branch with work of its own, and each folder's uncommitted changes, with
 * its project and age. Read once the list is on screen, and again with each list read (the server keeps one answer
 * 20 s). A click opens that work's diff beside the list (localNav.ts); nothing goes to any agent. It takes the place of
 * Branch reviews' "Branches nobody reported", which listed the same branches for one project. No new keyboard shortcuts.
 */
import { useEffect, useRef, useState } from 'react';
import { inboxLocalWorkKey, inboxLocalWorkLabel, type InboxLocalWork, type InboxLocalWorkAnswer } from '@plannotator/core/inbox-types';
import { Icon } from '../icons';
import { Age, Title } from './ReviewRow';
import { useRelativeClock } from '../relativeTime';
import { localWorkIn, readLocalWork } from './localWork';
import { ReviewGroup, type ReviewGroupFold } from './ReviewGroup';

export interface OnThisComputerProps {
  /** The list's project filter. */
  project: string | null;
  projectNames: ReadonlyMap<string, string>;
  /** The row whose diff is open (`localOpenKey`), or null. */
  openKey: string | null;
  phone: boolean;
  /** A new list read: the group reads again (the server's kept answer, until it is old). */
  readAgain: unknown;
  /** The group's saved fold (ReviewsList's `folds.local`): closed until opened. */
  fold: ReviewGroupFold;
  onOpen: (work: InboxLocalWork) => void;
}

export function OnThisComputer({ project, projectNames, openKey, phone, readAgain, fold, onOpen }: OnThisComputerProps) {
  const now = useRelativeClock(true);
  const [answer, setAnswer] = useState<InboxLocalWorkAnswer | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    // A read that fails, or answers without rows (an older Inbox), keeps what was last read: the group never says
    // "nothing" for a read it did not get, and never takes the list down with it.
    readLocalWork(controller.signal).then(
      (read) => {
        if (Array.isArray(read?.items)) setAnswer(read);
      },
      () => {},
    );
    return () => controller.abort();
  }, [readAgain]);
  // Back from a row's diff: the focus it left goes back to its row.
  const wasOpen = useRef(openKey);
  useEffect(() => {
    const was = wasOpen.current;
    wasOpen.current = openKey;
    if (!was || openKey) return;
    requestAnimationFrame(() => {
      const lost = !document.activeElement || document.activeElement === document.body;
      if (lost) document.querySelector<HTMLElement>(`[data-pulls-group="local"] [data-local-row="${CSS.escape(was)}"]`)?.focus({ preventScroll: true });
    });
  }, [openKey]);
  const items = answer ? localWorkIn(answer.items, project) : [];
  if (items.length === 0) return null;
  // A row open beside the list keeps its group open.
  const open = fold.open || items.some((item) => inboxLocalWorkKey(item) === openKey);
  return (
    <ReviewGroup label="On this computer" name="local" count={items.length} fold={{ open, onToggle: fold.onToggle }}>
      {items.map((item) => <LocalRow key={inboxLocalWorkKey(item)} item={item} projectName={projectNames.get(item.project_id) ?? null} selected={inboxLocalWorkKey(item) === openKey} phone={phone} now={now} onOpen={() => onOpen(item)} />)}
    </ReviewGroup>
  );
}

/** One line, as a compact Reviews row (ReviewRow.tsx): the mark, the work (a long branch cut in its middle), the project quiet, the age. */
function LocalRow({ item, projectName, selected, phone, now, onOpen }: { item: InboxLocalWork; projectName: string | null; selected: boolean; phone: boolean; now: number; onOpen: () => void }) {
  return (
    <button
      type="button"
      className={`${phone ? 'ib-mrow' : 'ib-nrow'} ib-prrow ib-local-row${selected ? ' ib-sel' : ''}`}
      onClick={onOpen}
      aria-current={selected ? 'true' : undefined}
      data-local-row={inboxLocalWorkKey(item)}
      data-local-kind={item.kind}
    >
      <span className="ib-rvr-l1">
        <span className="ib-rvr-mark" aria-hidden="true">
          <Icon name={item.kind === 'branch' ? 'gitBranch' : 'laptop'} size={15} />
        </span>
        <Title text={inboxLocalWorkLabel(item)} />
        <span className="ib-rvr-end">
          {projectName && <span className="ib-sr">, </span>}
          {projectName && (
            <span className="ib-local-project" dir="auto" data-local-project="">
              {projectName}
            </span>
          )}
          <Age iso={item.at} now={now} />
        </span>
      </span>
    </button>
  );
}
