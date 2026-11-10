/** Both incoming window requests and browser agents navigate through the Inbox's existing hash route. */
import { useEffect } from 'react';
import { defineTool, fail, getRegistryFor, ok, resolveModelContext, useWebMcpToolsEnabled } from '@plannotator/ui/webmcp';
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

export function useInboxShowTool(): void {
  const enabled = useWebMcpToolsEnabled();
  useEffect(() => {
    const context = resolveModelContext();
    if (!context || !enabled) return;
    let active = true;
    // Document viewers remain opted out by configurePlannotatorUI. This set exposes only Inbox navigation.
    const tool = defineTool<{ thread_id: string }, { shown: true; thread_id: string }>({
      name: 'show_thread',
      description: 'Show an Inbox thread in this browser window without reloading. Does not raise another window, answer questions or send messages.',
      inputSchema: { type: 'object', properties: { thread_id: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['thread_id'], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false },
      execute: async ({ thread_id }, execution) => {
        try {
          await inboxApi.thread(thread_id);
          if (!active || execution.signal.aborted) return fail('not_available', 'The Inbox tool is no longer active.');
          showInboxThread(thread_id);
          return ok({ shown: true, thread_id });
        } catch {
          return fail('not_found', 'That thread could not be opened.');
        }
      },
    });
    const detach = getRegistryFor(context, { prefix: () => 'plannotator.' }).attach('inbox', [tool], { buildNudges: () => [] });
    return () => {
      active = false;
      detach();
    };
  }, [enabled]);
}
