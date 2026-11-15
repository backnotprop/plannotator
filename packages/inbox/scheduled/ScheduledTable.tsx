/**
 * The list: one table (Name, Run, Runs, Last run, Next run, Created, ⋯), newest last run first, and the turned-off ones
 * in their own small "Off" table under it. Beside an open editor it narrows to the Run button (leading each row, in
 * one column), Routine, Runs and Last run.
 */
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Menu } from '@base-ui/react/menu';
import { usePhone } from '../phone';
import type { InboxScheduledRow } from '@plannotator/core/inbox-scheduled-types';
import { formatCount } from '../format';
import { Icon } from '../icons';
import { RunningDots } from './marks';
import { createdWords, elapsedWords, lastRunWords, nextRunWords, shortScheduleWords, splitScheduled } from './words';

export interface RowActs {
  open: (row: InboxScheduledRow) => void;
  run: (row: InboxScheduledRow) => void;
  stop: (row: InboxScheduledRow) => void;
  turn: (row: InboxScheduledRow, on: boolean) => void;
  remove: (row: InboxScheduledRow) => void;
}

/** A clock for the running rows' time so far: ticks each second while one runs. */
function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const stopClick = (fn: () => void) => (event: MouseEvent) => {
  event.stopPropagation();
  fn();
};

function RunButton({ row, acts, short }: { row: InboxScheduledRow; acts: RowActs; short: boolean }) {
  const running = row.state === 'running';
  const label = running ? `Stop ${row.name}` : `Run ${row.name} now`;
  return (
    <button
      type="button"
      className={`st-run${short ? ' st-run-ic' : ''}`}
      data-off={row.state === 'off' ? '' : undefined}
      aria-label={label}
      title={short ? (running ? 'Stop' : 'Run now') : undefined}
      onClick={stopClick(() => (running ? acts.stop(row) : acts.run(row)))}
      data-scheduled-run={running ? 'stop' : 'run'}
    >
      {running ? <span className="st-stop" aria-hidden="true" /> : <Icon name="scheduled" />}
      {!short && (running ? 'Stop' : 'Run')}
    </button>
  );
}

function RowMenu({ row, acts }: { row: InboxScheduledRow; acts: RowActs }) {
  const anchor = useRef<HTMLButtonElement>(null);
  // On a phone, main's bottom sheet (inbox.css `.ib-pm-pos[data-phone]`): it fits the screen and scrolls.
  const sheet = usePhone();
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(anchor.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  const on = row.state !== 'off';
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger ref={anchor} className="st-more" aria-label={`More for ${row.name}`} onClick={(event) => event.stopPropagation()} data-scheduled-menu="">
        <Icon name="dots" />
      </Menu.Trigger>
      <Menu.Portal container={portal ?? undefined}>
        {sheet && <Menu.Backdrop className="ib-pm-scrim" />}
        <Menu.Positioner className="ib-pm-pos" side="bottom" align="end" sideOffset={4} data-phone={sheet ? '' : undefined}>
          {/* A portal's clicks bubble to the row in React's tree: a menu item never also opens the row. */}
          <Menu.Popup className="ib-pm" aria-label={row.name} onClick={(event) => event.stopPropagation()}>
            {row.state !== 'done' && (
              <Menu.Item className="ib-pmi" onClick={() => acts.turn(row, !on)} data-scheduled-turn={on ? 'off' : 'on'}>
                <span className="ib-pmi-l">{on ? 'Turn off' : 'Turn on'}</span>
              </Menu.Item>
            )}
            <Menu.Item className="ib-pmi" onClick={() => acts.remove(row)} data-scheduled-delete="">
              <span className="ib-pmi-l">Delete</span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function lastCell(row: InboxScheduledRow, now: number): ReactNode {
  if (row.state === 'running' && row.running_since)
    return (
      <span className="st-live" role="status">
        <RunningDots />
        <span>Running · {elapsedWords(row.running_since, now)}</span>
      </span>
    );
  if (!row.last_run) return '';
  const when = lastRunWords(row.last_run.started_at, new Date(now));
  // A run that didn't start says so here too; its time is in the tooltip and the editor's Runs.
  return row.last_run.outcome === 'didnt_start' ? <span className="st-bad" title={when} data-scheduled-last="didnt_start">Didn't start</span> : when;
}

function WideRow({ row, acts, now }: { row: InboxScheduledRow; acts: RowActs; now: number }) {
  const next = nextRunWords(row, now);
  return (
    <div className="st-row st-cols" role="row" onClick={() => acts.open(row)} data-scheduled-row={row.id} data-state={row.state}>
      <span role="cell" className="st-name">
        <button type="button" className="st-open" title={row.name} onClick={stopClick(() => acts.open(row))}>
          {row.name}
        </button>
      </span>
      <span role="cell">
        <RunButton row={row} acts={acts} short={false} />
      </span>
      <span role="cell">{formatCount(row.runs)}</span>
      <span role="cell">{lastCell(row, now)}</span>
      <span role="cell" className={/^In /.test(next) ? undefined : 'st-dim'} data-scheduled-next="">
        {next}
      </span>
      <span role="cell">{createdWords(row.created_at, now)}</span>
      <span role="cell" className="st-end">
        <RowMenu row={row} acts={acts} />
      </span>
    </div>
  );
}

function ShortRow({ row, acts, now, selected }: { row: InboxScheduledRow; acts: RowActs; now: number; selected: boolean }) {
  return (
    <div className="st-srow st-scols" role="row" onClick={() => acts.open(row)} data-scheduled-row={row.id} data-state={row.state} data-selected={selected ? '' : undefined}>
      <span role="cell" className="st-sname">
        <button type="button" className="st-open" title={row.name} aria-current={selected ? 'true' : undefined} onClick={stopClick(() => acts.open(row))}>
          {row.name}
        </button>
        <span className="st-when">{shortScheduleWords(row)}</span>
      </span>
      {/* Run or Stop right of the name, every row's on one line: the name column is the longest name's width. */}
      <span role="cell" className="st-sbtn">
        <RunButton row={row} acts={acts} short />
      </span>
      <span role="cell" className="st-num st-count">
        {formatCount(row.runs)}
      </span>
      <span role="cell" className="st-num st-last">
        {row.state === 'running' && row.running_since ? <span className="st-live"><RunningDots />{elapsedWords(row.running_since, now)}</span> : lastCell(row, now)}
      </span>
      <span role="cell" className="st-end">
        <RowMenu row={row} acts={acts} />
      </span>
    </div>
  );
}

const sortMark = (
  <span className="st-sort">
    Last run
    <Icon name="chevD" size={12} />
  </span>
);

export function ScheduledTable({ rows, acts, short, selected }: { rows: readonly InboxScheduledRow[]; acts: RowActs; short: boolean; selected: string | null }) {
  const { on, off } = splitScheduled(rows);
  const now = useTick(rows.some((row) => row.state === 'running'));
  if (short) {
    return (
      <div className="st-short" role="table" aria-label="Routines">
        <div className="st-shead st-scols" role="row">
          <span role="columnheader" className="st-sname">Routine</span>
          <span role="columnheader" className="st-sbtn" aria-label="Run" />
          <span role="columnheader" className="st-num st-count">Runs</span>
          <span role="columnheader" className="st-num st-last" aria-sort="descending">Last run</span>
          <span className="st-end" />
        </div>
        {on.map((row) => <ShortRow key={row.id} row={row} acts={acts} now={now} selected={row.id === selected} />)}
        {off.length > 0 && (
          <h3 className="st-offh st-offh-short" role="presentation">
            Off<span className="ib-n">{formatCount(off.length)}</span>
          </h3>
        )}
        {off.map((row) => <ShortRow key={row.id} row={row} acts={acts} now={now} selected={row.id === selected} />)}
      </div>
    );
  }
  return (
    <div className="st-wide">
      <div className="st-wgrid">
        {on.length > 0 && (
          <div className="st-table" role="table" aria-label="Routines">
            <div className="st-head st-cols" role="row">
              <span role="columnheader">Name</span>
              <span role="columnheader" aria-label="Run" />
              <span role="columnheader">Runs</span>
              <span role="columnheader" aria-sort="descending">{sortMark}</span>
              <span role="columnheader">Next run</span>
              <span role="columnheader">Created</span>
              <span />
            </div>
            {on.map((row) => <WideRow key={row.id} row={row} acts={acts} now={now} />)}
          </div>
        )}
        {off.length > 0 && (
          <>
            <h3 className="st-offh" id="st-offh">
              Off<span className="ib-n">{formatCount(off.length)}</span>
            </h3>
            <div className="st-table st-table-off" role="table" aria-labelledby="st-offh" data-scheduled-off="">
              {off.map((row) => <WideRow key={row.id} row={row} acts={acts} now={now} />)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
