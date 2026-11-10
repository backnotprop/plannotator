/** Both incoming window requests and browser agents navigate through the Inbox's existing hash route. */
import { inboxApi, type InboxEventHandlers } from './api';

export function showInboxThread(thread: string): void {
  const hash = `#thread=${encodeURIComponent(thread)}`;
  if (window.location.hash !== hash) window.location.hash = hash;
}

export function acceptInboxShow(windowId: string, request: Parameters<NonNullable<InboxEventHandlers['onShow']>>[0]): void {
  if (request.window !== windowId || request.expires <= Date.now()) return;
  showInboxThread(request.thread);
  void inboxApi.acknowledgeShow({ request: request.request, window: windowId }).catch(() => {
    // The caller gets a URL fallback if the acknowledgement cannot reach this run.
  });
}
