/**
 * One line of Grid (approval "inbox-agent-grid", round 3, take 1): the work's name and PR number, its agent, a bar of
 * its life on the page's clock, and the bar spelled out after it. What it asks the person sits under the name in
 * amber. Pointing at the line (focus too) shows its readout, the same pieces with their clock times, under the bar;
 * on a phone a tap opens the readout under the line, with Open thread.
 *
 * Nothing here measures: the bar's pieces sit at percentages of the clock, and the readout is the line's own child,
 * shown by CSS on hover and focus (the list's rows once read layout inside each row; this page reads none).
 */
import { memo, useId, type ReactNode } from 'react';
import { GRID_GROUPS, GRID_PIECE_NAMES, gridExact, gridSaid, gridSpoken, type GridLine as Line, type GridPiece } from '../../shared/inbox/grid';
import { HostMark, Icon } from '../icons';
import { RefMarkIcon } from '../board/RefMark';

export interface GridClock {
  from: number;
  to: number;
  /** The time as a line says it ("11:42 PM", "Mon 11:42 PM" when a day or more back). */
  at: (ms: number) => string;
}

const pct = (clock: GridClock, ms: number) => Math.min(100, Math.max(0, ((ms - clock.from) / (clock.to - clock.from)) * 100));

function Bar({ line, clock }: { line: Line; clock: GridClock }) {
  if (line.planned !== null) {
    return (
      <span className="ib-grid-bar" aria-hidden="true">
        <i className="ib-grid-pt ib-grid-plan" data-clip={line.planned < clock.from ? '' : undefined} style={{ left: `${pct(clock, line.planned)}%` }} />
      </span>
    );
  }
  const shown = line.pieces.filter((p) => p.to > clock.from);
  return (
    <span className="ib-grid-bar" aria-hidden="true">
      {shown.map((p, i) => (
        <i
          key={`${p.kind}${p.from}`}
          className="ib-grid-seg"
          data-k={p.kind}
          data-first={i === 0 ? '' : undefined}
          data-last={i === shown.length - 1 && line.merged === null && line.dropped === null ? '' : undefined}
          data-clip={i === 0 && p.from < clock.from ? '' : undefined}
          style={{ left: `${pct(clock, p.from)}%`, width: `max(3px, ${pct(clock, p.to) - pct(clock, p.from)}%)` }}
        />
      ))}
      {line.merged !== null && line.merged > clock.from && (
        <span className="ib-grid-pt" style={{ left: `${pct(clock, line.merged)}%` }}>
          <RefMarkIcon kind="pr" state="merged" size={13} />
        </span>
      )}
      {line.dropped && line.dropped.at > clock.from && (
        <span className="ib-grid-pt ib-grid-x" style={{ left: `${pct(clock, line.dropped.at)}%` }}>
          <Icon name="x" />
        </span>
      )}
    </span>
  );
}

function Said({ line, clock, phone }: { line: Line; clock: GridClock; phone: boolean }) {
  if (line.dropped) {
    return (
      <span className="ib-grid-pc" data-on="">
        <Icon name="x" />
        <b>Dropped</b> {clock.at(line.dropped.at)} · {line.dropped.why}
      </span>
    );
  }
  if (line.planned !== null) {
    return (
      <span className="ib-grid-pc" data-on="">
        <b>Planned</b> {clock.at(line.planned)}
      </span>
    );
  }
  const { cut, pieces } = gridSaid(line, { phone });
  return (
    <>
      {cut && <span className="ib-grid-pc">…</span>}
      {pieces.map((p, i) => (
        <span key={i} className="ib-grid-pc" data-k={p.kind} data-on={p.on ? '' : undefined}>
          {(i > 0 || cut) && <i className="ib-grid-ar">›</i>}
          <i className="ib-grid-sw" data-k={p.kind} />
          <b>{p.name}</b> {p.length}
          {p.on && p.kind !== 'wait' && line.detail && (
            <>
              {' · '}
              <span data-bad={line.detail.bad ? '' : undefined}>{line.detail.words}</span>
            </>
          )}
        </span>
      ))}
      {line.merged !== null && (
        <span className="ib-grid-pc" data-on="">
          <i className="ib-grid-ar">›</i>
          <RefMarkIcon kind="pr" state="merged" size={12} />
          <b>Merged</b> {clock.at(line.merged)}
        </span>
      )}
    </>
  );
}

/** The readout: every piece with its clock time, then the agent and its computer. */
function Readout({ line, clock, computer }: { line: Line; clock: GridClock; computer: string | null }) {
  const rows: { at: number; mark: ReactNode; what: string; how: string }[] = line.pieces.map((p: GridPiece, i) => ({
    at: p.from,
    mark: <i className="ib-grid-sw" data-k={p.kind} />,
    what: p.kind === 'pr' && line.pr ? `PR ${line.pr}` : GRID_PIECE_NAMES[p.kind],
    how: gridExact(p.to - p.from) + (p.kind === 'wait' && line.ask ? ` · ${line.ask}` : i === line.pieces.length - 1 && p.kind !== 'wait' && line.detail ? ` · ${line.detail.words}` : ''),
  }));
  if (line.planned !== null) rows.push({ at: line.planned, mark: null, what: 'Planned', how: '' });
  if (line.merged !== null) rows.push({ at: line.merged, mark: <RefMarkIcon kind="pr" state="merged" size={12} />, what: 'Merged', how: line.pr ?? '' });
  if (line.dropped) rows.push({ at: line.dropped.at, mark: <Icon name="x" />, what: 'Dropped', how: line.dropped.why });
  return (
    <>
      {rows.map((r, i) => (
        <span key={i} className="ib-grid-ro">
          <span className="ib-grid-ro-at">{clock.at(r.at)}</span>
          <span className="ib-grid-ro-w">
            {r.mark}
            {r.what}
          </span>
          <span className="ib-grid-ro-d">{r.how}</span>
        </span>
      ))}
      {line.steps && line.steps.total > 0 && (
        // The checklist (approval "inbox-agent-grid": steps may show): how far, and the step in progress.
        <span className="ib-grid-ro" data-grid-steps="">
          <span className="ib-grid-ro-at">{clock.at(Date.parse(line.steps.at))}</span>
          <span className="ib-grid-ro-w">{`Steps ${line.steps.done} of ${line.steps.total}`}</span>
          <span className="ib-grid-ro-d">{line.steps.doing ?? ''}</span>
        </span>
      )}
      <span className="ib-grid-ro ib-grid-ro-by">{[line.agent?.name, computer].filter(Boolean).join(' · ')}</span>
    </>
  );
}

export interface GridLineProps {
  line: Line;
  clock: GridClock;
  phone: boolean;
  /** The line's computer by name, for the readout; null for this computer's own (or nothing linked). */
  computer: string | null;
  /** Phone: the readout is open under the line. */
  open: boolean;
  onOpen: (thread: string) => void;
  onTap: (id: string) => void;
  /** Watches the line on screen (gridSeen.ts): what the person was shown counts as seen. */
  observe?: (el: HTMLElement | null) => (() => void) | void;
}

/** The line as a screen reader says it: its name, its group, and the bar spelled out ("Working 2 hours, PR 40 minutes"). */
export function gridLineSpoken(line: Line, clock: GridClock, phone: boolean): string {
  const group = GRID_GROUPS.find((g) => g.id === line.group)!.heading;
  let state: string;
  if (line.dropped) state = `Dropped ${clock.at(line.dropped.at)}, ${line.dropped.why}`;
  else if (line.planned !== null) state = `Planned ${clock.at(line.planned)}`;
  else {
    const said = gridSaid(line, { phone }).pieces.map((p) => `${p.name} ${gridSpoken(p.length)}`);
    if (line.detail) said.push(line.detail.words);
    if (line.merged !== null) said.push(`Merged ${clock.at(line.merged)}`);
    state = said.join(', ');
  }
  return [`${line.name}${line.pr ? ` ${line.pr}` : ''}`, group, state, line.ask].filter(Boolean).join('. ');
}

export const GridLineView = memo(function GridLineView({ line, clock, phone, computer, open, onOpen, onTap, observe }: GridLineProps) {
  const readoutId = useId();
  const thread = line.actions.find((a) => a.kind === 'open')?.thread ?? line.id;
  const words = <Said line={line} clock={clock} phone={phone} />;
  const who = line.agent && (
    <span className="ib-grid-who">
      <span className="ib-grid-mk">
        <HostMark host={line.agent.host} />
      </span>
      <span className="ib-grid-nm">{line.agent.name}</span>
    </span>
  );
  return (
    <div role="listitem" ref={observe} className="ib-grid-ln" data-grid-line={line.id} data-group={line.group} data-fresh={line.fresh ? '' : undefined} data-open={open ? '' : undefined}>
      {/* Its name says the states in words; the readout (every piece with its time) describes it. The bar is not read. */}
      <button
        type="button"
        className="ib-grid-name"
        onClick={() => (phone ? onTap(line.id) : onOpen(thread))}
        aria-expanded={phone ? open : undefined}
        aria-label={gridLineSpoken(line, clock, phone)}
        aria-describedby={phone ? (open ? readoutId : undefined) : readoutId}
      >
        <span className="ib-grid-t" title={line.name}>{line.name}</span>
        {line.pr && !phone && <span className="ib-grid-pn">{line.pr}</span>}
      </button>
      {!phone && who}
      <Bar line={line} clock={clock} />
      {phone ? (
        <span className="ib-grid-sub">
          {who}
          <span className="ib-grid-said" aria-hidden="true">
            <i className="ib-grid-dot">·</i>
            {words}
          </span>
        </span>
      ) : (
        <span className="ib-grid-s" aria-hidden="true">
          {words}
        </span>
      )}
      {line.ask && (
        <span className="ib-grid-q" aria-hidden="true">
          {line.ask}
        </span>
      )}
      {phone ? (
        open && (
          <span className="ib-grid-exp" data-grid-readout="" id={readoutId}>
            <Readout line={line} clock={clock} computer={computer} />
            <button type="button" className="ib-grid-ro ib-grid-ro-open" onClick={() => onOpen(thread)}>
              Open thread <Icon name="chevR" />
            </button>
          </span>
        )
      ) : (
        <span className="ib-grid-pop" data-grid-readout="" id={readoutId}>
          <Readout line={line} clock={clock} computer={computer} />
        </span>
      )}
    </div>
  );
});
