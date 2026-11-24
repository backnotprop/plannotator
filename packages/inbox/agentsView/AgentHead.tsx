/**
 * An agent's row in the list's Agents view (design A): its face at 44 (the animated mark with its picker, AgentMark.tsx),
 * its name and newest time, then one muted line "project · [machine ·] line", the line being what it does now
 * (agentProfile/line.ts: "Working · 3m", "Idle since 9:15 AM", amber "Asking for permission"), and folded, what waits
 * on the person (the rows' marks added up), else how many threads it has.
 *
 * In the window (approval "inbox-agent-profile-card", C1, C2) the row is one button that opens the agent's profile in
 * the reading pane (pressed while it is open), and the small arrow at its right end is its own button that opens or
 * folds its threads. Without the window's profile (`onOpen` absent: the tour, a picture, an agent the list no longer
 * names), the row folds, as before.
 *
 * Memoized on what it shows: a list read that changes one thread draws that thread's row and its agent's row again,
 * never the other agents' (40 of them, each with a moving face).
 */
import { memo } from 'react';
import { formatCount, shortTime } from '../format';
import { Icon } from '../icons';
import { AgentMark, type AgentMarkPicks } from '../agents/AgentMark';
import { ActionBadge, QuestionMark, rowMarks, type RowMarks, type WaitStep } from '../components/RowBadge';
import { agentLineOf, sameLineFacts } from '../agentProfile/line';
import { AgentLine } from '../agentProfile/AgentLine';
import type { AgentRow, ViewAgent } from './model';

const STEPS: readonly WaitStep[] = ['open', 'hold', 'stop'];
const higher = (a: WaitStep, b: WaitStep) => (STEPS.indexOf(a) >= STEPS.indexOf(b) ? a : b);

/** What waits on the person across an agent's threads: the rows' marks added up, each at its strongest step. */
export function agentMarks(rows: readonly AgentRow[]): RowMarks | null {
  const out: RowMarks = { questions: 0, question: 'open', actions: 0, action: 'open' };
  for (const { row } of rows) {
    const marks = rowMarks(row);
    if (marks.questions > 0) {
      out.questions += marks.questions;
      out.question = higher(out.question, marks.question);
    }
    if (marks.actions > 0) {
      out.actions += marks.actions;
      out.action = higher(out.action, marks.action);
    }
  }
  return out.questions > 0 || out.actions > 0 ? out : null;
}

export interface AgentHeadProps {
  agentKey: string;
  agent: ViewAgent;
  /** Its project and its machine when another one; then its line, the part never cut. */
  project: string | null;
  machine: string | null;
  picks: AgentMarkPicks;
  open: boolean;
  last: string;
  /** Folded: the marks added up (`agentMarks`), else how many threads. */
  marks: RowMarks | null;
  count: number;
  phone: boolean;
  onToggle: (key: string) => void;
  /** Opens (or closes) its profile; absent: the row folds, as before. */
  onOpen?: (key: string) => void;
  /** Its profile is open. */
  pressed?: boolean;
}

function AgentHeadView({ agentKey, agent, project, machine, picks, open, last, marks, count, phone, onToggle, onOpen, pressed = false }: AgentHeadProps) {
  const line = agentLineOf(agent);
  return (
    <div className="ib-agh" data-agent-opens={onOpen ? '' : undefined}>
      <AgentMark id={agent.id} host={agent.host} name={agent.name} agent={agent.ref} picks={picks} size={44} />
      <button
        type="button"
        className="ib-agh-b"
        data-agent-head=""
        aria-expanded={onOpen ? undefined : open}
        aria-pressed={onOpen ? pressed : undefined}
        data-agent-profile-opener={onOpen ? agent.id : undefined}
        onClick={() => (onOpen ? onOpen(agentKey) : onToggle(agentKey))}
      >
        <span className="ib-agh-1">
          <span className="ib-agh-n" dir="auto">
            {agent.name}
          </span>
          <span className="ib-t">{shortTime(last)}</span>
        </span>
        <span className="ib-agh-2">
          <span className="ib-agh-m">
            {project && (
              <span className="ib-agh-p" dir="auto">
                {project}
              </span>
            )}
            {machine && (
              <span className="ib-agh-k" dir="auto">
                {project ? ' · ' : ''}
                {machine}
              </span>
            )}
            {line && (
              <span className="ib-agh-s">
                {project || machine ? ' · ' : ''}
                <AgentLine line={line} />
              </span>
            )}
          </span>
          {!open &&
            (marks ? (
              // The summed marks with their own words as the tooltip: no row, so no one thread's details or card.
              <span className="ib-agh-marks">
                <ActionBadge marks={marks} tip={!phone} />
                <QuestionMark marks={marks} tip={!phone} />
              </span>
            ) : (
              <span className="ib-agh-c" data-agent-threads={count}>
                {formatCount(count)}
                <span className="ib-sr">{count === 1 ? ' thread' : ' threads'}</span>
              </span>
            ))}
        </span>
      </button>
      {onOpen && (
        // The fold, at the row's right end: open ⌄, folded ›, as the Smart groups' bands.
        <button type="button" className="ib-agh-fold" aria-expanded={open} aria-label={`${agent.name} threads`} data-agent-fold="" onClick={() => onToggle(agentKey)}>
          <Icon name="chevD" size={16} />
        </button>
      )}
    </div>
  );
}

const sameMarks = (a: RowMarks | null, b: RowMarks | null) =>
  a === b || (!!a && !!b && a.questions === b.questions && a.question === b.question && a.actions === b.actions && a.action === b.action);
const sameAgent = (a: ViewAgent, b: ViewAgent) =>
  a === b ||
  (a.id === b.id && a.host === b.host && a.name === b.name && sameLineFacts(a, b) && a.ref.id === b.ref.id && a.ref.session === b.ref.session && (a.ref.continues ?? []).join() === (b.ref.continues ?? []).join());

export const AgentHead = memo(
  AgentHeadView,
  (a, b) =>
    a.agentKey === b.agentKey &&
    sameAgent(a.agent, b.agent) &&
    a.project === b.project &&
    a.machine === b.machine &&
    a.picks === b.picks &&
    a.open === b.open &&
    a.last === b.last &&
    sameMarks(a.marks, b.marks) &&
    a.count === b.count &&
    a.phone === b.phone &&
    a.onToggle === b.onToggle &&
    a.onOpen === b.onOpen &&
    a.pressed === b.pressed,
);
