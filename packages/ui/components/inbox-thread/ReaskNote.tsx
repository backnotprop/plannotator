import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import { Icon } from './icons';
import { reaskNoteSentence } from './reask';

/**
 * The person's Re-ask note as it reads in the thread (approval "inbox-reask"):
 * one line, and what the agent was sent behind a disclosure.
 */
export function ReaskNote({ message, agent, picks }: { message: InboxMessageWire; agent: string; picks: number }) {
  const asked = message.reask?.length ?? 0;
  // Action items it asked about (ids `<message id>/a-…`): the line names them.
  const actions = (message.reask ?? []).filter((id) => /\/a-[0-9a-f]/.test(id)).length;
  return (
    <div className="ib-reask" data-reask-note="">
      <p className="ib-reask-l">
        <Icon name="refresh" size={15} />
        <span>{reaskNoteSentence(agent, asked, picks, actions)}</span>
      </p>
      <details className="ib-reask-d">
        <summary>What {agent} was sent</summary>
        <pre>{message.body}</pre>
      </details>
    </div>
  );
}
