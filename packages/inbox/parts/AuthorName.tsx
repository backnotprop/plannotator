/** A message author's name with its session's label. */
import { authorWithLabel, shortLabel } from '../sessionLabels';
import { ROW_LABEL_MAX } from '../components/RowAgents';

/**
 * A named session's message author (issue #2450): the agent's name as ever, then " · " and the session's label in
 * the secondary colour, a little smaller and never bold, cut in the middle past ROW_LABEL_MAX and with "…" where the
 * column ends; the agent's name is never cut first. A span, so it can be a Tip's trigger. `open`: the open head's
 * name (`ib-who`). `hidden`: the fold button's label says it; otherwise (a one-message thread) a screen reader hears
 * the whole label, never the cut one. `onFold`: an open head with a fold button under it. The name takes the pointer
 * there (inbox.css), as the time does, so its hover can show the whole label, and a click on it still folds.
 */
export function labelledAuthorName({ agent, label, open = false, hidden, onFold }: { agent: string; label: string; open?: boolean; hidden?: true; onFold?: () => void }) {
  return (
    <span className={`ib-fl-nm${open ? ' ib-who' : ''}`} aria-hidden={hidden} data-session-label="" onClick={onFold}>
      <bdi className="ib-fl-agent" aria-hidden={hidden ? undefined : true} data-author-agent="">
        {agent}
      </bdi>
      <span className="ib-fl-lbl" aria-hidden={hidden ? undefined : true}>
        <span className="ib-fl-lsep">{' · '}</span>
        <bdi data-author-label="">{shortLabel(label, ROW_LABEL_MAX)}</bdi>
      </span>
      {!hidden && <span className="ib-sr">{authorWithLabel(agent, label).spoken}</span>}
    </span>
  );
}
