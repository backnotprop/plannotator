/** Show in Rex (packages/server/inbox-rex.ts): Rex's app goes to the pane this computer's live session lives in. */
import { post } from '../../api';
import { dropRexShow } from '../../agentsList';
import { inboxUrl } from '../../inboxUrl';

/** What the window's live region says when Rex did not go to the pane. */
export const REX_SHOW_FAILED = "Rex didn't show it.";

/**
 * Ask for it, on the person's click. When Rex did not go there (the pane is gone, or its app said no or nothing
 * usable), `announce` says so and the item leaves the agent's menu until a read offers it again.
 */
export function showInRex(session: string, announce?: (text: string) => void): void {
  const failed = () => {
    dropRexShow(session);
    announce?.(REX_SHOW_FAILED);
  };
  void post<{ shown?: unknown }>(inboxUrl('/rex/show'), { session }).then(
    (answer) => {
      if (answer.shown !== true) failed();
    },
    failed,
  );
}
