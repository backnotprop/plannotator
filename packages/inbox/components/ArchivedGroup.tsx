/**
 * The Archived group at the foot of the list (approval "inbox-archived-group", option A): on while the ⋮ menu's "Show
 * archived" is ticked, under Snoozed, with no count. Closed until the person opens it, and it reads nothing until
 * then (data/queries/archived.ts). Open: the newest archived first, 20 rows, then "Show 20 more", up to 100, past which
 * it points to Search. Each row is the list's own row with the time it was archived, and Unarchive as its hover
 * action, in its menu, and as a swipe to the left on a phone. It follows the project the list shows and the list's
 * filters.
 */
import { createContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { InboxListGroupId, InboxListRow } from '@plannotator/core/inbox-types';
import type { ArchivedGroupHost } from '../data/actions/archivedGroup';
import { ARCHIVED_MOST, ARCHIVED_STEP, useArchivedPage } from '../data/queries/archived';
import { errorText, INBOX_UNREACHABLE } from '../toastError';
import { Icon } from '../icons';
import { GroupBand } from './GroupBand';
import { SwipeToUnarchive } from './SwipeToUnarchive';

const NONE: readonly InboxListRow[] = [];

/** A row inside the Archived group: the group's header says Archived, so the row's words do not say it again. */
export const InArchivedGroup = createContext(false);

/** The row as the group draws it: its time is when it was archived, and nothing about a delivery or a snooze. */
function asArchived(row: InboxListRow): InboxListRow {
  return { ...row, last_at: row.resolved_at ?? row.last_at, delivery: null, snooze_back: null, snoozed: null };
}

/** A wide or three-line row's hover action (keyboard focus shows it too). */
export function UnarchiveAction({ row, label, onUnarchive }: { row: InboxListRow; label: string; onUnarchive: (row: InboxListRow) => void }) {
  return (
    <button
      type="button"
      className="ib-ract"
      data-row-unarchive=""
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onUnarchive(row);
      }}
    >
      <Icon name="archive" size={15} />
      Unarchive
    </button>
  );
}

interface GroupProps {
  host: ArchivedGroupHost;
  renderRow: (row: InboxListRow, drawn: InboxListGroupId) => ReactNode;
  /** The rows the group draws, as they change; none once it closes. */
  onRows?: (rows: readonly InboxListRow[]) => void;
  phone: boolean;
  onSearch?: (opener: HTMLElement) => void;
}

export function ArchivedGroup(props: GroupProps) {
  const [open, setOpen] = useState(false);
  const groupRef = useRef<HTMLDivElement>(null);
  // The row keyboard focus was last in: when it leaves the group (an Unarchive), focus goes to the row after it.
  const focusedRow = useRef<string | null>(null);
  return (
    <div
      ref={groupRef}
      className="ib-group"
      data-section-id="archived"
      data-archived-group=""
      role="group"
      aria-label="Archived"
      onFocus={(event) => {
        // The row itself, or its hover action beside it in the row's wrapper.
        const at = (event.target as HTMLElement).closest('[data-thread-id], [data-row]');
        focusedRow.current = at?.getAttribute('data-thread-id') ?? at?.getAttribute('data-row') ?? null;
      }}
    >
      <GroupBand
        open={open}
        onToggle={(band) => {
          const active = document.activeElement;
          if (open && active !== band && band.parentElement?.contains(active)) band.focus({ preventScroll: true });
          setOpen(!open);
        }}
      >
        Archived
      </GroupBand>
      {open && (
        <InArchivedGroup.Provider value={true}>
          <ArchivedRows key={props.host.project ?? ''} {...props} groupRef={groupRef} focusedRow={focusedRow} />
        </InArchivedGroup.Provider>
      )}
    </div>
  );
}

/** The open group's rows and lines; it is not drawn while the group is closed, so nothing is read or held then. */
function ArchivedRows({ host, renderRow, onRows, phone, onSearch, groupRef, focusedRow }: GroupProps & { groupRef: RefObject<HTMLDivElement | null>; focusedRow: RefObject<string | null> }) {
  const [count, setCount] = useState(ARCHIVED_STEP);
  // The list's filters dropped a row: the group reads up to its most at once, so the rows it shows are still 20.
  const [wide, setWide] = useState(false);
  const { page, partial, failed } = useArchivedPage({ project: host.project, merged: host.merged, limit: (wide ? ARCHIVED_MOST : count) + 1 });
  const rows = page?.threads ?? NONE;
  const filter = host.filter;
  const kept = useMemo(() => filter(rows), [filter, rows]);
  const dropped = kept.length < rows.length;
  useEffect(() => {
    if (dropped) setWide(true);
  }, [dropped]);
  const shown = useMemo(() => kept.slice(0, count).map(asArchived), [kept, count]);
  useEffect(() => onRows?.(shown), [onRows, shown]);
  useEffect(() => () => onRows?.(NONE), [onRows]);
  const more = count < ARCHIVED_MOST && kept.length > count;
  const past = count >= ARCHIVED_MOST && (kept.length > ARCHIVED_MOST || (page?.total ?? 0) > rows.length);
  // After "Show 20 more", focus goes to the first row it brought (the button leaves at 100).
  const focusAt = useRef<{ group: HTMLElement; at: number } | null>(null);
  useLayoutEffect(() => {
    const next = focusAt.current;
    if (next === null || shown.length <= next.at) return;
    focusAt.current = null;
    next.group.querySelectorAll<HTMLElement>('[data-thread-id]')[next.at]?.focus();
  }, [shown.length]);
  // The focused row left (an Unarchive) and took focus with it: the row after it takes focus, or the header.
  const drawnIds = useRef<readonly string[]>([]);
  useLayoutEffect(() => {
    const before = drawnIds.current;
    drawnIds.current = shown.map((row) => row.thread_id);
    const gone = focusedRow.current;
    const at = gone === null || drawnIds.current.includes(gone) ? -1 : before.indexOf(gone);
    if (at < 0) return;
    focusedRow.current = null;
    const active = document.activeElement;
    const group = groupRef.current;
    if (!group || (active && active !== document.body && active.isConnected)) return;
    const next = shown[at] ? [...group.querySelectorAll<HTMLElement>('[data-thread-id]')].find((el) => el.getAttribute('data-thread-id') === shown[at]!.thread_id) : undefined;
    (next ?? group.querySelector<HTMLElement>('.ib-band'))?.focus();
  }, [shown, focusedRow, groupRef]);
  return (
    <>
      {shown.map((row) =>
        phone ? (
          <SwipeToUnarchive key={row.thread_id} row={row} onUnarchive={host.unarchive}>
            {renderRow(row, 'archived')}
          </SwipeToUnarchive>
        ) : (
          renderRow(row, 'archived')
        ),
      )}
      {page && !partial && kept.length === 0 && (
        <p className="ib-arcg-line" data-archived-none="">
          Nothing archived.
        </p>
      )}
      {failed !== null && (
        <p className="ib-arcg-line" role="alert">
          {errorText(failed, INBOX_UNREACHABLE)}
        </p>
      )}
      {more && (
        <button
          type="button"
          className="ib-arcg-more"
          data-archived-more=""
          onClick={(event) => {
            const group = event.currentTarget.parentElement;
            if (group) focusAt.current = { group, at: count };
            setCount(Math.min(ARCHIVED_MOST, count + ARCHIVED_STEP));
          }}
        >
          Show 20 more
        </button>
      )}
      {past && (
        <p className="ib-arcg-line" data-archived-past="">
          Older ones are in{' '}
          <button type="button" className="ib-arcg-search" onClick={(event) => onSearch?.(event.currentTarget)} disabled={!onSearch}>
            Search
          </button>
          .
        </p>
      )}
    </>
  );
}
