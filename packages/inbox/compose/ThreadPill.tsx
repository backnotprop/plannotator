/**
 * A thread as a small raised pill: the mark of the agent that has it, the thread's name, and its state when it waits
 * on the person (Stopped, Holds N, its open questions). The starred pills' look (approval "inbox-starred-pills"),
 * with the agent's mark where their star is. A picture, never a button: compose shows it as where "Send to that
 * thread" goes, and pressing it must not leave compose. Its name for a screen reader: "<thread name>, with <agent>".
 */
import type { InboxAuthor } from '@plannotator/core/inbox-types';
import { formatCount } from '@plannotator/core/inbox-format';
import { AuthorMark, Icon } from '../icons';
import type { PinnedState } from '../pins';

export function ThreadPill(props: { name: string; author: InboxAuthor; agent: string; state: PinnedState | null }) {
  const { name, author, agent, state } = props;
  return (
    <span className="ib-tpill" role="img" aria-label={`${name}, with ${agent}`} data-compose-thread-pill="" data-state={state?.kind}>
      <AuthorMark author={author} />
      <bdi className="ib-tpill-n">{name}</bdi>
      {state?.kind === 'stop' && (
        <span className="ib-spill" data-k="stop" aria-hidden="true">
          Stopped
        </span>
      )}
      {state?.kind === 'hold' && (
        <span className="ib-spill" data-k="hold" aria-hidden="true">
          Holds {formatCount(state.n)}
        </span>
      )}
      {state?.kind === 'wait' && (
        <span className="ib-tpill-q" aria-hidden="true">
          <Icon name="questionBubble" size={12} />
          {formatCount(state.n)}
        </span>
      )}
    </span>
  );
}
