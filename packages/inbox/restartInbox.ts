import { inboxApi } from './api';
import { leaveOnPurpose } from './unsent';
import type { InboxToastModel } from './components/Toast';

const RESTART_NOT_BACK_MS = 20_000;

export async function restartInbox(before: string | undefined, viaTailnet: boolean, setRestarting: (on: boolean) => void, showToast: (toast: Omit<InboxToastModel, 'id'>, ms?: number) => void): Promise<void> {
  setRestarting(true);
  const notBack = () => {
    setRestarting(false);
    if (viaTailnet) showToast({ icon: 'warn', lead: 'The Inbox hasn’t come back yet. If it stays away, start it on the computer.', wrap: true }, RESTART_NOT_BACK_MS);
  };
  try {
    await inboxApi.restart();
  } catch {
    notBack();
    return;
  }
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const health = await inboxApi.health();
      if (health.serverSession !== before) {
        leaveOnPurpose();
        window.location.reload();
        return;
      }
    } catch {
      continue;
    }
  }
  notBack();
}
