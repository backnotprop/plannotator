/**
 * One line of Grid (approval "inbox-agent-grid", round 3, take 1): the work's name and PR number, its agent, a bar of
 * its life on the page's clock, and the bar spelled out after it. What it asks the person sits under the name in
 * amber. Pointing at the line (focus too) shows its readout, the same pieces with their clock times, under the bar;
 * on a phone a tap opens the readout under the line, with Open thread.
 *
 * Nothing here measures: the bar's pieces sit at percentages of the clock, and the readout is the line's own child,
 * shown by CSS on hover and focus (the list's rows once read layout inside each row; this page reads none).
 */
import { memo, useId, useRef, type ReactNode } from 'react';
import { GRID_GROUPS, GRID_PIECE_NAMES, gridExact, gridRounded, gridSaid, gridSpoken, type GridLine as Line, type GridPiece } from '../../shared/inbox/grid';
import { HostMark, Icon } from '../icons';
import { RefMarkIcon } from '../board/RefMark';
import { gridNudgeOf, gridNudgePress, type GridNudgeSent } from './gridNudge';

export interface GridClock {
  from: number;
  to: number;
  /** The time as a line says it ("11:42 PM", "Mon 11:42 PM" when a day or more back). */
  at: (ms: number) => string;
}

const pct = (clock: GridClock, ms: number) => Math.min(100, Math.max(0, ((ms - clock.from) / (clock.to - clock.from)) * 100));

function Bar({ line, clock }: { line: Line; clock: GridClock }) {
  if (line.planned !== null && line.pieces.length === 0) {
    return (
      <span className="ib-grid-bar" aria-hidden="true">
        <i className="ib-grid-pt ib-grid-plan" data-clip={line.planned < clock.from ? '' : undefined} style={{ left: `${pct(clock, line.planned)}%` }} />
      </span>
    );
  }
  const shown = line.pieces.filter((p) => p.to > clock.from);
  // Glint's light (gridMotion.ts) crosses a Moving bar, a nudge's crosses a Stale one: a clip as wide as the bar shown.
  const lit = (line.group === 'move' || line.group === 'stale') && shown.length > 0 ? { left: pct(clock, shown[0]!.from), right: pct(clock, shown.at(-1)!.to) } : null;
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
      {lit && (
        <span className="ib-grid-glc" data-short={lit.right - lit.left < 5 ? '' : undefined} style={{ left: `${lit.left}%`, width: `max(3px, ${lit.right - lit.left}%)` }}>
          <i />
        </span>
      )}
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
  if (line.planned !== null && line.pieces.length === 0) {
    return (
      <span className="ib-grid-pc" data-on="">
        <b>Planned</b> {clock.at(line.planned)}
      </span>
    );
  }
  const { cut, pieces } = gridSaid(line, { phone });
  // A plan gone stale: "Planned 7:20 PM › Stale 14 h · not started".
  const planned = line.planned !== null && !cut;
  return (
    <>
      {cut && <span className="ib-grid-pc">…</span>}
      {planned && (
        <span className="ib-grid-pc">
          Planned {clock.at(line.planned!)}
        </span>
      )}
      {pieces.map((p, i) => (
        <span key={i} className="ib-grid-pc" data-k={p.kind} data-on={p.on ? '' : undefined}>
          {(i > 0 || cut || planned) && <i className="ib-grid-ar">›</i>}
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

/** The readout: every piece with its clock time (a nudge at its own), then the agent and its computer. */
function Readout({ line, clock, computer, nudged }: { line: Line; clock: GridClock; computer: string | null; nudged: { at: number; held: string | null } | null }) {
  const rows: { at: number; mark: ReactNode; what: string; how: ReactNode }[] = [];
  if (line.planned !== null) rows.push({ at: line.planned, mark: null, what: 'Planned', how: '' });
  // A stale line's times to the minute (what its nudge says); every other line's as before.
  const exact = line.group === 'stale';
  line.pieces.forEach((p: GridPiece, i) => {
    const detail = p.kind !== 'wait' && i === line.pieces.length - 1 ? line.detail : null;
    rows.push({
      at: p.from,
      mark: <i className="ib-grid-sw" data-k={p.kind} />,
      what: p.kind === 'pr' && line.pr ? `PR ${line.pr}` : GRID_PIECE_NAMES[p.kind],
      how: (
        <>
          {gridExact(p.to - p.from, exact)}
          {p.kind === 'wait' && line.ask ? ` · ${line.ask}` : null}
          {/* Failing tests in red, as on the line. */}
          {detail && (
            <>
              {' · '}
              <span data-bad={detail.bad ? '' : undefined}>{detail.words}</span>
            </>
          )}
        </>
      ),
    });
  });
  // Nudged: to the agent it went to, in the thread ("tide-ios, in the thread"); a held one says it waits for its computer.
  if (nudged) rows.push({ at: nudged.at, mark: null, what: 'Nudged', how: nudged.held ?? `${line.nudgeTo ?? line.agent?.name ?? 'its agent'}, in the thread` });
  if (line.merged !== null) rows.push({ at: line.merged, mark: <RefMarkIcon kind="pr" state="merged" size={12} />, what: 'Merged', how: line.pr ?? '' });
  if (line.dropped) rows.push({ at: line.dropped.at, mark: <Icon name="x" />, what: 'Dropped', how: line.dropped.why });
  rows.sort((a, b) => a.at - b.at);
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
  /** The nudge this window sent on the line (gridNudge.ts), and the press. */
  sent?: GridNudgeSent | null;
  onNudge?: (line: Line) => void;
}

/** A click this soon after a press of Nudge is the press's second (a double click or tap), never Open thread. */
const PRESS_GUARD_MS = 700;

/** "Nudged just now", "Nudged 12 min ago". */
const nudgedWords = (at: number, now: number) => (now - at < 60_000 ? 'Nudged just now' : `Nudged ${gridRounded(now - at)} ago`);

/** The line as a screen reader says it: its name, its group, and the bar spelled out ("Working 2 hours, PR 40 minutes"). */
export function gridLineSpoken(line: Line, clock: GridClock, phone: boolean): string {
  const group = GRID_GROUPS.find((g) => g.id === line.group)!.heading;
  let state: string;
  if (line.dropped) state = `Dropped ${clock.at(line.dropped.at)}, ${line.dropped.why}`;
  else if (line.planned !== null && line.pieces.length === 0) state = `Planned ${clock.at(line.planned)}`;
  else {
    const said = gridSaid(line, { phone }).pieces.map((p) => `${p.name} ${gridSpoken(p.length)}`);
    if (line.planned !== null) said.unshift(`Planned ${clock.at(line.planned)}`);
    if (line.detail) said.push(line.detail.words);
    if (line.merged !== null) said.push(`Merged ${clock.at(line.merged)}`);
    state = said.join(', ');
  }
  return [`${line.name}${line.pr ? ` ${line.pr}` : ''}`, group, state, line.ask].filter(Boolean).join('. ');
}

export const GridLineView = memo(function GridLineView({ line, clock, phone, computer, open, onOpen, onTap, observe, sent = null, onNudge }: GridLineProps) {
  const readoutId = useId();
  const thread = line.actions.find((a) => a.kind === 'open')?.thread ?? line.id;
  const words = <Said line={line} clock={clock} phone={phone} />;
  // Nudge (round 4): offered on a stale line until this window's press of the same stretch went (a held nudge, in any
  // window, is the line's own `nudged`: no Nudge is offered then either).
  const action = gridNudgeOf(line);
  const went = sent && !sent.failed ? sent : null;
  const canNudge = !!action && !!onNudge && !(went && went.press === gridNudgePress(action));
  // This window's press shows at once; a held one and the thread's own nudge as the line carries them.
  const mine = went && line.group === 'stale' && (!line.nudged || went.at > line.nudged.at) ? went : null;
  const nudged = mine ? { at: mine.at, held: mine.held ?? line.nudged?.held ?? null } : line.nudged ? { at: line.nudged.at, held: line.nudged.held } : null;
  const under = line.group !== 'stale' ? null : mine ? nudgedWords(mine.at, clock.to) : line.nudged?.now ? nudgedWords(line.nudged.at, clock.to) : null;
  // A nudge that did not go: why, in the status's grey (a refusal is news, not an error), until the line leaves Stale.
  const notSent = line.group !== 'stale' || under ? null : sent?.failed ?? line.refused;
  const agentName = action?.agent ?? line.nudgeTo ?? line.agent?.name ?? 'its agent';
  // A double click or a double tap on Nudge: its second click lands where the button was (the name's whole-line hit,
  // or Open thread beside it), and must not open the thread.
  const pressedAt = useRef(0);
  const press = () => {
    pressedAt.current = Date.now();
    onNudge!(line);
  };
  const justPressed = (event: { detail: number }) => event.detail > 1 || Date.now() - pressedAt.current < PRESS_GUARD_MS;
  const who = line.agent && (
    <span className="ib-grid-who">
      <span className="ib-grid-mk">
        <HostMark host={line.agent.host} />
      </span>
      <span className="ib-grid-nm">{line.agent.name}</span>
    </span>
  );
  // Its name says the states in words; the readout (every piece with its time) describes it. The bar is not read.
  const name = (
    <button
      type="button"
      className="ib-grid-name"
      onClick={(event) => {
        if (justPressed(event)) return;
        if (phone) onTap(line.id);
        else onOpen(thread);
      }}
      aria-expanded={phone ? open : undefined}
      aria-label={gridLineSpoken(line, clock, phone)}
      aria-describedby={phone ? (open ? readoutId : undefined) : readoutId}
    >
      <span className="ib-grid-t" title={line.name}>{line.name}</span>
      {line.pr && !phone && <span className="ib-grid-pn">{line.pr}</span>}
    </button>
  );
  const openThread = (event: { detail: number }) => {
    if (!justPressed(event)) onOpen(thread);
  };
  return (
    <div role="listitem" ref={observe} className="ib-grid-ln" data-grid-line={line.id} data-group={line.group} data-fresh={line.fresh ? '' : undefined} data-open={open ? '' : undefined}>
      {phone ? name : (
        // Nudge sits right after the name, shown on pointing or focus (CSS); its room is kept while hidden, so pointing
        // never moves where a long name is cut. One press sends it, nothing to confirm.
        <span className="ib-grid-nw">
          {name}
          {canNudge && (
            <button type="button" className="ib-grid-nudge" data-grid-nudge="" aria-label={`Nudge ${agentName}`} onClick={press}>
              Nudge
            </button>
          )}
        </span>
      )}
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
      {(under || notSent) && (
        <span className="ib-grid-ng" data-grid-nudged="" data-not-sent={notSent ? '' : undefined} role="status">
          {under ?? notSent}
        </span>
      )}
      {phone ? (
        open && (
          <span className="ib-grid-exp" data-grid-readout="" id={readoutId}>
            <Readout line={line} clock={clock} computer={computer} nudged={nudged} />
            {canNudge ? (
              // A stale line: Nudge beside Open thread, on one row.
              <span className="ib-grid-ro ib-grid-ro-acts">
                <button type="button" className="ib-grid-ro-open" data-grid-nudge="" onClick={press}>
                  {`Nudge ${agentName}`}
                </button>
                <button type="button" className="ib-grid-ro-open" onClick={openThread}>
                  Open thread <Icon name="chevR" />
                </button>
              </span>
            ) : (
              <button type="button" className="ib-grid-ro ib-grid-ro-open" onClick={openThread}>
                Open thread <Icon name="chevR" />
              </button>
            )}
          </span>
        )
      ) : (
        <span className="ib-grid-pop" data-grid-readout="" id={readoutId}>
          <Readout line={line} clock={clock} computer={computer} nudged={nudged} />
        </span>
      )}
    </div>
  );
});
