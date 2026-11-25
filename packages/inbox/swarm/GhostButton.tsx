import { Tip } from '../components/Tip';
import { GhostGlyph } from './GhostGlyph';

/** The Ghost button's words: its tooltip and its name. */
export function ghostButtonWords(unread: number): string {
  return unread > 0 ? `Ghost thread · ${unread} new` : 'Ghost thread';
}

/**
 * The Ghost button (approval "inbox-swarm-thread-ui", shot g-ghost-hug-nosmile-in-topbar): first in a swarm thread's
 * top bar, the ghost's small cut (GhostGlyph), the agents' new ghost messages counted beside it while there are any. Pressed (the
 * ghost pane open) it takes the accent and the count is gone: opening the pane marks them seen. No keyboard shortcut
 * (the owner's record: "No keyboard shortcut for the Ghost button").
 */
export function GhostButton({ unread, open, onToggle }: { unread: number; open: boolean; onToggle: () => void }) {
  const words = ghostButtonWords(open ? 0 : unread);
  return (
    <Tip content={words}>
      <button type="button" className="ib-iconbtn ib-artbtn ib-ghostbtn" aria-label={words} aria-pressed={open} onClick={onToggle} data-ghost-button="">
        <GhostGlyph size={18} />
        {!open && unread > 0 && (
          <span className="ib-artbtn-n ib-ghostbtn-n" aria-hidden="true" data-ghost-unread="">
            {unread}
          </span>
        )}
      </button>
    </Tip>
  );
}
