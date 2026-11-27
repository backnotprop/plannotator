/**
 * An agent's line as drawn (line.ts says what): a turning ring while it works, an amber pause mark while it asks the
 * person in its terminal, then the words, then how long ("· 3m") when it counts. The same piece on the card atop a
 * filtered list, on an agent's row in the Agents view and in its profile's Activity (`big`, the duration at the end
 * of the row). Reduced motion: the ring stands still.
 */
import { memo } from 'react';
import type { AgentLine as Line } from './line';
import { useDurationSince } from './clock';

function Glyph({ tone }: { tone: Line['tone'] }) {
  if (tone === 'working')
    return (
      <svg className="ib-apl-g ib-apl-spin" viewBox="0 0 14 14" aria-hidden="true">
        <circle className="ib-apl-tr" cx="7" cy="7" r="5.5" />
        <path className="ib-apl-arc" d="M7 1.5a5.5 5.5 0 0 1 5.5 5.5" />
      </svg>
    );
  if (tone === 'asking')
    return (
      <svg className="ib-apl-g ib-apl-pause" viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="7" cy="7" r="5.5" />
        <path d="M5.6 4.9v4.2M8.4 4.9v4.2" />
      </svg>
    );
  return null;
}

function Since({ from }: { from: string }) {
  const words = useDurationSince(from);
  return words ? (
    <span className="ib-apl-t" data-agent-line-time="">
      {words}
    </span>
  ) : null;
}

export interface AgentLineProps {
  line: Line | null;
  /** The profile's Activity row: larger, the duration at the row's end. */
  big?: boolean;
}

function AgentLineView({ line, big = false }: AgentLineProps) {
  if (!line) return null;
  return (
    <span className="ib-apl" data-tone={line.tone} data-big={big ? '' : undefined} data-agent-line={line.tone}>
      <Glyph tone={line.tone} />
      <span className="ib-apl-w" dir="auto">
        {line.words}
      </span>
      {line.from && <Since from={line.from} />}
    </span>
  );
}

export const AgentLine = memo(AgentLineView, (a, b) => a.big === b.big && (a.line === b.line || (!!a.line && !!b.line && a.line.tone === b.line.tone && a.line.words === b.line.words && a.line.from === b.line.from)));
