import { launchChoiceLine } from '@plannotator/core/inbox-launch-choice';
import type { InboxLaunchRecord } from '@plannotator/core/inbox-types';
import { shortLaunchModel } from '../compose/launchChoice';

/**
 * A launched thread's header, after "You started <agent> in <project>": the model and effort it was started with
 * ("opus · high"), as the launch record holds them (docs/agent-guides/inbox-launch.md "Model and effort"). Nothing
 * when it started with the agent's own default.
 */
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
