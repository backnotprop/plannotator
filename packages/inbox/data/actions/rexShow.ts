/** Show in Rex (packages/server/inbox-rex.ts): Rex's app goes to the pane this computer's live session lives in. */
import { post } from '../../api';
import { dropRexShow } from '../../agentsList';
import { inboxUrl } from '../../inboxUrl';

/**
 * Ask for it; nothing else changes here. A refusal (the pane is gone, or Rex's app no longer takes actions) is
 * silent, and the item leaves the agent's menu at once: no dead item.
 */
export function showInRex(session: string): void {
  void post<{ shown: boolean }>(inboxUrl('/rex/show'), { session }).then(
    (answer) => {
      if (!answer.shown) dropRexShow(session);
    },
    () => dropRexShow(session),
  );
}
