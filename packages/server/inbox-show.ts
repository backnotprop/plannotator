/** Ephemeral navigation requests. A live window must acknowledge before a caller is told it showed the thread. */
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxWindows } from "./inbox-windows";

export interface InboxShowRequest {
  request: string;
  window: string;
  thread: string;
  expires: number;
}

export type InboxShowResult = { shown: true; window: string } | { shown: false; url: string };

export function createInboxShow(options: {
  store: InboxStore;
  windows: InboxWindows;
  baseUrl: () => string;
  timeoutMs?: number;
}) {
  const listeners = new Set<(request: InboxShowRequest) => void>();
  const pending = new Map<string, { window: string; finish: (shown: boolean) => void }>();
  return {
    async show(thread: unknown): Promise<InboxShowResult> {
      if (typeof thread !== "string" || !thread || thread.length > 200) {
        throw new InboxError("validation_error", "thread: expected a thread id.");
      }
      const root = options.store.message(thread);
      if (!root || root.thread_id !== thread) throw new InboxError("thread_not_found", `No thread ${thread}.`);
      const fallback: InboxShowResult = { shown: false, url: `${options.baseUrl()}#thread=${encodeURIComponent(thread)}` };
      const window = options.windows.showTarget();
      if (!window) return fallback;
      const timeoutMs = options.timeoutMs ?? 2000;
      const request = crypto.randomUUID();
      return new Promise((resolve) => {
        const timer = setTimeout(() => finish(false), timeoutMs);
        const finish = (shown: boolean) => {
          clearTimeout(timer);
          pending.delete(request);
          resolve(shown ? { shown: true, window } : fallback);
        };
        pending.set(request, { window, finish });
        for (const listener of listeners) listener({ request, window, thread, expires: Date.now() + timeoutMs });
      });
    },
    acknowledge(request: string, window: string): boolean {
      const waiting = pending.get(request);
      if (!waiting || waiting.window !== window) return false;
      waiting.finish(true);
      return true;
    },
    subscribe(listener: (request: InboxShowRequest) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      for (const waiting of pending.values()) waiting.finish(false);
      listeners.clear();
    },
  };
}
