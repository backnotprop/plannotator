/**
 * "An agent has acted" signal for the indicator policy: NOTHING visible may appear merely
 * because `document.modelContext` exists.
 */
import { useSyncExternalStore } from 'react';

export interface WebMcpActivity {
  calls: number;
  lastTool: string | null;
}

let activity: WebMcpActivity = { calls: 0, lastTool: null };
const listeners = new Set<() => void>();

export function recordToolCall(tool: string): void {
  activity = { calls: activity.calls + 1, lastTool: tool };
  for (const listener of listeners) listener();
}

export function getWebMcpActivity(): WebMcpActivity {
  return activity;
}

export function subscribeWebMcpActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetWebMcpActivity(): void {
  activity = { calls: 0, lastTool: null };
  for (const listener of listeners) listener();
}

export function useWebMcpActivity(): WebMcpActivity {
  return useSyncExternalStore(subscribeWebMcpActivity, getWebMcpActivity, getWebMcpActivity);
}
