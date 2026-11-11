/** A picture, never a button: pressing it must not leave compose. */
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
