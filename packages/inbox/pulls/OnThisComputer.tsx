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
import { formatCount } from '@plannotator/core/inbox-format';
import { Icon } from '../icons';
import { FileName } from '../components/FileName';
import { relativeTime, relativeWords, useRelativeClock } from '../relativeTime';
import { localWorkIn, readLocalFoldOpen, readLocalWork, saveLocalFoldOpen } from './localWork';

export interface OnThisComputerProps {
  /** The list's project filter. */
  project: string | null;
  projectNames: ReadonlyMap<string, string>;
  /** The row whose diff is open (`localOpenKey`), or null. */
  openKey: string | null;
  phone: boolean;
  /** A new list read: the group reads again (the server's kept answer, until it is old). */
  readAgain: unknown;
  onOpen: (work: InboxLocalWork) => void;
}

export function OnThisComputer({ project, projectNames, openKey, phone, readAgain, onOpen }: OnThisComputerProps) {
  const now = useRelativeClock(true);
  const [answer, setAnswer] = useState<InboxLocalWorkAnswer | null>(null);
  const [folded, setFolded] = useState(() => !readLocalFoldOpen());
  useEffect(() => {
    const controller = new AbortController();
    // A read that fails keeps what was last read: the group never says "nothing" for a read it did not get.
    readLocalWork(controller.signal).then(setAnswer, () => {});
    return () => controller.abort();
  }, [readAgain]);
  // Back from a row's diff: the focus it left goes back to its row.
  const wasOpen = useRef(openKey);
  const group = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const was = wasOpen.current;
    wasOpen.current = openKey;
    if (!was || openKey) return;
    requestAnimationFrame(() => {
      const lost = !document.activeElement || document.activeElement === document.body;
      if (lost) group.current?.querySelector<HTMLElement>(`[data-local-row="${CSS.escape(was)}"]`)?.focus({ preventScroll: true });
    });
  }, [openKey]);
  const items = answer ? localWorkIn(answer.items, project) : [];
  if (items.length === 0) return null;
  // A row open beside the list keeps its group open.
  const open = !folded || items.some((item) => inboxLocalWorkKey(item) === openKey);
  const toggle = () => {
    setFolded(open);
    saveLocalFoldOpen(!open);
  };
  return (
    <div ref={group} className="ib-group ib-pr-fold" role="group" aria-label="On this computer" data-reviews-local="">
      <button type="button" className="ib-pr-foldbtn" onClick={toggle} aria-expanded={open} data-reviews-local-toggle="">
        <Icon name={open ? 'chevD' : 'chevR'} size={14} />
        On this computer <span className="ib-n">{formatCount(items.length)}</span>
      </button>
      {open && items.map((item) => <LocalRow key={inboxLocalWorkKey(item)} item={item} projectName={projectNames.get(item.project_id) ?? null} selected={inboxLocalWorkKey(item) === openKey} phone={phone} now={now} onOpen={() => onOpen(item)} />)}
    </div>
  );
}

function LocalRow({ item, projectName, selected, phone, now, onOpen }: { item: InboxLocalWork; projectName: string | null; selected: boolean; phone: boolean; now: number; onOpen: () => void }) {
  const label = inboxLocalWorkLabel(item);
  return (
    <button
      type="button"
      className={`${phone ? 'ib-mrow' : 'ib-nrow'} ib-prrow ib-local-row${selected ? ' ib-sel' : ''}`}
      onClick={onOpen}
      aria-current={selected ? 'true' : undefined}
      aria-label={`${label}${projectName ? `, ${projectName}` : ''}, ${relativeWords(item.at, now)}`}
      data-local-row={inboxLocalWorkKey(item)}
      data-local-kind={item.kind}
    >
      <Icon name={item.kind === 'branch' ? 'gitBranch' : 'laptop'} size={15} />
      {/* Cut in the middle when short of room: a branch's end is what tells it from its neighbours. */}
      <FileName name={label} className="ib-local-name" />
      {projectName && (
        <span className="ib-local-project" dir="auto" data-local-project="">
          {projectName}
        </span>
      )}
      <span className="ib-local-age" aria-hidden="true">
        {relativeTime(item.at, now)}
      </span>
    </button>
  );
}
