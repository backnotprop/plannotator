import type { InboxCloudAgentView } from '@plannotator/core/inbox-cloud';
import { relativeWords, useRelativeClock } from '../relativeTime';

export function CloudStatus({ agent }: { agent: InboxCloudAgentView }) {
  const now = useRelativeClock(agent.link.state === 'connected');
  const { state, last_seen_at } = agent.link;
  const text =
    state === 'connected'
      ? `Connected · last seen ${last_seen_at ? relativeWords(last_seen_at, now) : 'just now'}`
      : state === 'waiting'
        ? `Waiting for ${agent.name} to connect…`
        : state === 'relay_down'
          ? `This computer cannot reach the relay, so ${agent.name} cannot reach it. Check that this computer is online.`
          : 'Not connected: this computer could not reach the relay. Once it is online, make a new pairing.';
  return (
    <span className={`ib-cl-link-line ib-cl-${state}`} role="status" data-cloud-status={state}>
      <span className="ib-cl-dot" aria-hidden="true" />
      {text}
    </span>
  );
}
