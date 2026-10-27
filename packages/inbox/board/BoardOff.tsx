import { useId } from 'react';
import { Icon } from '../icons';
import { SidebarTrigger } from '../shell/sidebar';

/**
 * A `#board` link while the Board is off (approval "inbox-board", 2026-10-26:
 * the Board is something the person turns on). It says so, what turning it on
 * does, and offers the one way: Turn it on (Settings → Capabilities has the
 * same switch, and the page links there). Nothing of the Board shows while it is off; its cards are kept.
 * Turning it on changes what agents on this computer are offered, so a page
 * that came through the tailnet says to do it on this computer.
 */
export function BoardOff({ via, onTurnOn, error }: { via: 'local' | 'tailnet'; onTurnOn: () => void; error: string | null }) {
  const titleId = useId();
  return (
    <section className="ib-bpage" aria-labelledby={titleId} data-board-page="" data-board-view="off">
      <div className="ib-bhead">
        <SidebarTrigger />
        <h1 id={titleId} tabIndex={-1}>
          Board
        </h1>
      </div>
      <div className="ib-boff" data-board-off="">
        <span className="ib-boff-icon" aria-hidden="true">
          <Icon name="board" size={22} />
        </span>
        <h2>The Board is off</h2>
        <p>
          Turn it on for a page of the work in flight: one card per piece of work, in the column of its stage, that your agents keep current. Agents pick it up
          in their next session. Turned off again, every card is kept.
        </p>
        {via === 'tailnet' ? (
          <p className="ib-boff-note">Turn it on from this computer’s own screen: it changes what agents here are offered.</p>
        ) : (
          <>
            <button type="button" className="ib-btn ib-pri" onClick={onTurnOn} data-board-turn-on="">
              Turn it on
            </button>
            <p className="ib-boff-note" data-board-settings-link="">
              The same switch is in <a href="#settings/capabilities">Settings → Capabilities</a>.
            </p>
          </>
        )}
        {error && (
          <p className="ib-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
