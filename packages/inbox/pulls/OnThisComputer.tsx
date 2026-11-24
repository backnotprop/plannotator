/**
 * Reviews' "On this computer" (approval "inbox-reviews-compact-list", part 2; picture r2-local-entry-dark.png): a
 * folded group at the foot of the list with this computer's work that is in no pull request, for every project (the
 * list's project filter keeps its own): each branch with work of its own, and each folder's uncommitted changes, with
 * its project and age. Read once the list is on screen, and again with each list read (the server keeps one answer
 * 20 s). A click opens that work's diff beside the list (localNav.ts); nothing goes to any agent. It takes the place of
 * Branch reviews' "Branches nobody reported", which listed the same branches for one project, and keeps what it said: a
 * branch's commits not on the default branch (on the row where it fits, else for a screen reader and in its diff's
 * facts), all its branches behind the Agents view's "N more" fold, for a list filtered to one project with nothing
 * here, its words for that, and for git that could not be read, its "The branches could not be read." (a filtered
 * list reads that project's rows only, so none is crowded out by others). No new keyboard shortcuts.
 *
 * Its heading's + (approval "reviews-open-any-branch-a", OpenLocalPicker.tsx) opens any branch or worktree folder, or
 * a folder through "Another folder…"; what the person opens there stays in the group (localKept.ts), read again with
 * each list read, under the group's own rules (`keptShows`), and while open it shows whatever it holds.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { INBOX_UNREPORTED_BRANCH_DAYS, inboxLocalFolderQuiet, inboxLocalOneRowEach, inboxLocalWorkKey, inboxLocalWorkLabel, type InboxLocalWork, type InboxLocalWorkAnswer } from '@plannotator/core/inbox-types';
import { formatCount, plural } from '@plannotator/core/inbox-format';
import { Icon } from '../icons';
import { AGENT_ROWS_SHOWN } from '../agentsView/AgentsList';
import { Age, Title } from './ReviewRow';
import { useRelativeClock } from '../relativeTime';
import { localWorkIn, localWorkUnread, readLocalWork } from './localWork';
import { ReviewGroup, type ReviewGroupFold } from './ReviewGroup';
import { keepLocal, keptShows, useKeptLocal } from './localKept';
import { localOpenKey, type LocalOpen } from './localRoute';
import { OpenLocal } from './OpenLocalPicker';

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
  /** A row, or what the + picked, opened beside the list. */
  onOpen: (open: LocalOpen) => void;
}

/** What a row opens: its branch, its folder, or its project's uncommitted changes. */
export const localOpenOf = (work: InboxLocalWork): LocalOpen =>
  work.kind === 'folder' ? { project: work.project_id, branch: null, folder: work.folder ?? '' } : { project: work.project_id, branch: work.kind === 'branch' ? work.branch : null };

/**
 * The list's rows and what the person kept from the +: a kept row not listed already shows under `keptShows`, by age
 * with the rest; one that shows only because it is open (nothing beyond main, or quiet) goes first. One row for one
 * piece of work (`inboxLocalOneRowEach`): a kept folder and its branch's row are one.
 */
export function withKept(items: InboxLocalWork[], kept: readonly InboxLocalWork[] | undefined, opened: ReadonlyMap<string, number>, project: string | null, openKey: string | null, now: number): InboxLocalWork[] {
  if (!kept?.length) return items;
  const listed = new Set(items.map(inboxLocalWorkKey));
  const extra = kept.filter((row) => (project === null || row.project_id === project) && !listed.has(inboxLocalWorkKey(row)) && opened.has(inboxLocalWorkKey(row)));
  const first: InboxLocalWork[] = [];
  const rest = [...items];
  for (const row of extra) {
    const key = inboxLocalWorkKey(row);
    if (keptShows(row, opened.get(key)!, now, false)) rest.push(row);
    else if (key === openKey) first.push(row);
  }
  const all = rest.length === items.length ? [...first, ...items] : [...first, ...rest.sort((a, b) => b.at.localeCompare(a.at))];
  return inboxLocalOneRowEach(all, openKey);
}

export function OnThisComputer({ project, projectNames, openKey, phone, readAgain, fold, onOpen }: OnThisComputerProps) {
  const now = useRelativeClock(true);
  const [answer, setAnswer] = useState<InboxLocalWorkAnswer | null>(null);
  const kept = useKeptLocal();
  const keepKeys = kept.map((item) => item.key).join('\n');
  useEffect(() => {
    const controller = new AbortController();
    // A read that fails, or answers without rows (an older Inbox), keeps what was last read: the group never says
    // "nothing" for a read it did not get, and never takes the list down with it.
    readLocalWork(project, controller.signal, keepKeys ? keepKeys.split('\n') : []).then(
      (read) => {
        if (Array.isArray(read?.items)) setAnswer(read);
      },
      () => {},
    );
    return () => controller.abort();
  }, [readAgain, project, keepKeys]);
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
  // "N more" (the Agents view's fold): every row, until the group is drawn again for another list.
  const [more, setMore] = useState(false);
  const firstHidden = useRef<string | null>(null);
  useLayoutEffect(() => {
    const key = firstHidden.current;
    firstHidden.current = null;
    if (key) document.querySelector<HTMLElement>(`[data-pulls-group="local"] [data-local-row="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
  }, [more]);
  const opened = new Map(kept.map((item) => [item.key, item.at] as const));
  const items = answer ? withKept(localWorkIn(answer.items, project), answer.kept, opened, project, openKey, now) : [];
  // The heading's +: what it opens is kept, then opened as a row is.
  const plus = (
    <OpenLocal
      phone={phone}
      projectNames={projectNames}
      onOpen={(what) => {
        keepLocal(localOpenKey(what)!);
        onOpen(what);
      }}
    />
  );
  // Git that could not be read for this list: Branch reviews' words for it, where the group is, never "nothing".
  const unread = !!answer && localWorkUnread(answer, project);
  const unreadNote = unread && (
    <p className="ib-error" role="alert" data-local-unread="">
      The branches could not be read.
    </p>
  );
  if (items.length === 0) {
    // One project, read, with nothing here: Branch reviews' words for it.
    const nothing = project && answer && !unread ? (answer.not_git?.includes(project) ? "This project's folder isn't a git repository on this computer." : answer.quiet?.includes(project) ? `No other branch had a commit in the last ${INBOX_UNREPORTED_BRANCH_DAYS} days.` : null) : null;
    if (!nothing && !unread) {
      // Read, with no row: the heading and its + alone (nothing under it), so a clean checkout can still open a
      // branch or folder. No project known, nothing the + could list: no group.
      if (!answer || projectNames.size === 0) return null;
      return (
        <ReviewGroup label="On this computer" name="local" count={0} empty fold={fold} tool={plus}>
          {null}
        </ReviewGroup>
      );
    }
    return (
      <ReviewGroup label="On this computer" name="local" count={0} empty fold={fold} tool={plus}>
        {unreadNote || (
          <p className="ib-pr-risknote ib-local-none" data-local-none="">
            {nothing}
          </p>
        )}
      </ReviewGroup>
    );
  }
  // A row open beside the list keeps its group open, and shows past the fold.
  const open = fold.open || items.some((item) => inboxLocalWorkKey(item) === openKey);
  const folded = !more && items.length > AGENT_ROWS_SHOWN;
  const shown = folded ? items.filter((item, i) => i < AGENT_ROWS_SHOWN || inboxLocalWorkKey(item) === openKey) : items;
  const hidden = items.length - shown.length;
  return (
    <ReviewGroup label="On this computer" name="local" count={items.length} fold={{ open, onToggle: fold.onToggle }} tool={plus}>
      {shown.map((item) => <LocalRow key={inboxLocalWorkKey(item)} item={item} projectName={projectNames.get(item.project_id) ?? null} selected={inboxLocalWorkKey(item) === openKey} phone={phone} now={now} onOpen={() => onOpen(localOpenOf(item))} />)}
      {hidden > 0 && (
        <button
          type="button"
          className="ib-agmore ib-local-more"
          data-local-more=""
          onClick={() => {
            const next = items.find((item) => !shown.includes(item));
            firstHidden.current = next ? inboxLocalWorkKey(next) : null;
            setMore(true);
          }}
        >
          {formatCount(hidden)} more
        </button>
      )}
      {unreadNote}
    </ReviewGroup>
  );
}

/** A branch's commits not on its default branch, in Branch reviews' words ("3 commits not on main"); null for none. */
function aheadWords(item: InboxLocalWork): string | null {
  return item.kind === 'branch' && typeof item.ahead === 'number' && item.ahead > 0 && item.base ? `${plural(item.ahead, 'commit')} not on ${item.base}` : null;
}

/**
 * One line, as a compact Reviews row (ReviewRow.tsx): the mark, the work (a long branch cut in its middle), a branch's
 * commits not on its default branch where the row has room for them beside a readable name (inbox.css), the project
 * quiet, the age. A screen reader hears the commits always.
 */
function LocalRow({ item, projectName: project, selected, phone, now, onOpen }: { item: InboxLocalWork; projectName: string | null; selected: boolean; phone: boolean; now: number; onOpen: () => void }) {
  const ahead = aheadWords(item);
  // A folder: its own name (or, on no branch, its short commit) where a row's project goes.
  const projectName = item.kind === 'folder' ? inboxLocalFolderQuiet(item) : project;
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
          <Icon name={item.kind === 'branch' ? 'gitBranch' : item.kind === 'folder' ? 'folder' : 'laptop'} size={15} />
        </span>
        <Title text={inboxLocalWorkLabel(item)} />
        <span className="ib-rvr-end">
          {ahead && <span className="ib-sr">, {ahead}</span>}
          {ahead && (
            <span className="ib-local-ahead" aria-hidden="true" data-local-ahead="">
              {ahead}
            </span>
          )}
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
