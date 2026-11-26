/**
 * Ship's note to the shipping agent in its thread (approval "inbox-ship-mode"): the Inbox's own notice, never a message
 * from the person, so one quiet line in place of the message, as a Tidy's ("Tidy sent to Claude Code · 8:54 AM"). What
 * it told the agent is in the ship log.
 */
import { Tip } from '../components/Tip';
import { SailGlyph } from './ShipRow';

export function ShipNote({ kind, agent, time, fullWhen }: { kind: 'watch' | 'stop'; agent: string; time: string; fullWhen: string }) {
  return (
    <p className="ib-tidy-mark" data-ship-note={kind}>
      <SailGlyph size={14} />
      <span>
        {kind === 'stop' ? 'Stop shipping' : 'Ship update'} sent to {agent}
        {' · '}
        <Tip content={fullWhen}>
          <span data-full-when="">{time}</span>
        </Tip>
      </span>
    </p>
  );
}
