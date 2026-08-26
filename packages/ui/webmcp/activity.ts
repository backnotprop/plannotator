/**
 * "An agent has acted" signal for the indicator policy: NOTHING visible may
 * appear merely because `document.modelContext` exists. Only after the first
 * successful tool call in a session does the header show its unobtrusive
 * affordance, which subscribes here.
 *
 * Module-level and dependency-free; a browser without WebMCP never records a
 * call, so subscribers render nothing and the store never changes.
 */
import { useSyncExternalStore } from 'react';

export interface WebMcpActivity {
  /** Successful tool calls in this page load. */
  calls: number;
  /** Prefixed name of the last successful tool call. */
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

/** Mainly for tests. */
export function resetWebMcpActivity(): void {
  activity = { calls: 0, lastTool: null };
  for (const listener of listeners) listener();
}

export function useWebMcpActivity(): WebMcpActivity {
  return useSyncExternalStore(subscribeWebMcpActivity, getWebMcpActivity, getWebMcpActivity);
}
