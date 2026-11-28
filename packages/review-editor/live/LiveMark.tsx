import { AuthorMark, HostMark, Icon } from '@plannotator/ui/components/inbox-thread/icons';
import type { LiveMessage } from './model';

export function LiveAuthorMark({ message, big }: { message: LiveMessage; big?: boolean }) {
  const author = message.author;
  return (
    <span className={`live-mk${big ? ' live-mk-big' : ''}`} data-live-mark={author.kind === 'agent' ? author.host ?? 'agent' : 'person'} aria-hidden="true">
      {author.kind === 'agent' ? (
        <AuthorMark author={author} big={big} />
      ) : (
        <span className={`ib-mk${big ? ' ib-big' : ''}`}>
          <Icon name="reply" />
        </span>
      )}
    </span>
  );
}

export function LiveHostMark({ host }: { host: string | null }) {
  return (
    <span className="live-mk" data-live-mark={host ?? 'agent'} aria-hidden="true">
      <HostMark host={host} />
    </span>
  );
}
