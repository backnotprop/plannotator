import { launchChoiceLine } from '@plannotator/core/inbox-launch-choice';
import type { InboxLaunchRecord } from '@plannotator/core/inbox-types';
import { shortLaunchModel } from '../compose/launchChoice';

/** What was asked at launch, not what the agent reports: the Inbox reads no model back from it. */
export function LaunchChoiceMeta({ launch }: { launch: Pick<InboxLaunchRecord, 'model' | 'effort'> }) {
  const line = launchChoiceLine(launch, shortLaunchModel);
  if (!line) return null;
  return (
    <>
      <span className="ib-tdot" aria-hidden="true" />
      <span data-launch-choice="">{line}</span>
    </>
  );
}
