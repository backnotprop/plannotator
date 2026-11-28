import type { InboxLaunchRecord, InboxMessageWire } from '@plannotator/core/inbox-types';
import { selfMachineId } from '../inboxUrl';
import { startedWords } from '../scheduled/thread';
import { LaunchChoiceMeta } from './LaunchChoiceMeta';
import { hostName } from './NewMessage';

/**
 * A launched thread's meta line: "You started Claude Code in acme-api" ("Routine · Claude Code in acme-api"
 * when a schedule started it), then Full permissions and what was asked at launch.
 */
export function StartedBy({ launched, root, project }: { launched: InboxLaunchRecord; root: InboxMessageWire | undefined; project: string }) {
  return (
    <div className="ib-tmeta" data-started-by="" data-launched={launched.id}>
      <span>
        {startedWords(root)}
        {hostName(launched.agent)} in <bdi>{project}</bdi>
        {/* Started from another linked machine's window (remote launch): which one. */}
        {launched.from && launched.from.machine !== selfMachineId() && <> from {launched.from.name}</>}
      </span>
      {launched.full_permissions && (
        <>
          <span className="ib-tdot" aria-hidden="true" />
          <span data-launch-full="">Full permissions</span>
        </>
      )}
      <LaunchChoiceMeta launch={launched} />
    </div>
  );
}
