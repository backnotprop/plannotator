import { inboxLaunchInT3, type InboxLaunchRecord, type InboxMessageWire } from '@plannotator/core/inbox-types';
import { selfMachineId } from '../inboxUrl';
import { startedWords } from '../scheduled/thread';
import { LaunchChoiceMeta } from './LaunchChoiceMeta';
import { hostName } from './NewMessage';

/**
 * A launched thread's meta line: "You started Claude Code in acme-api" ("Routine · Claude Code in acme-api"
 * when a schedule started it), then Full permissions and what was asked at launch. Started in T3 Code: "In T3 Code",
 * with the model T3 runs it on once that is known, in place of what was asked (T3 picks the model there).
 */
export function StartedBy({ launched, root, project }: { launched: InboxLaunchRecord; root: InboxMessageWire | undefined; project: string }) {
  const inT3 = inboxLaunchInT3(launched);
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
      {inT3 ? (
        <>
          <span className="ib-tdot" aria-hidden="true" />
          <span data-launch-t3="">
            In T3 Code{launched.inner?.model ? ` · ${launched.inner.model}` : ''}
            {/* T3 didn't take the person's model: it runs on T3's own, and says so. */}
            {launched.t3?.declined && launched.inner?.model !== launched.t3.declined ? ` (T3 Code didn't take ${launched.t3.declined})` : ''}
            {launched.t3?.declined_effort && !launched.t3.declined ? ` (T3 Code didn't take the effort ${launched.t3.declined_effort})` : ''}
          </span>
        </>
      ) : (
        <LaunchChoiceMeta launch={launched} />
      )}
    </div>
  );
}
