/**
 * The window's side of Run (`:::run`) and Save (`:::secret`): packages/server/inbox-run-routes.ts. A message on a
 * linked machine goes to that machine (inboxUrl), where its command runs and its secret is kept.
 */
import { apiGet, apiPost } from '../api';
import { inboxUrl, machineOf } from '../inboxUrl';

export type RunStateName = 'starting' | 'running' | 'done' | 'stopped' | 'failed';

export interface RunView {
  key: string;
  run_id: string;
  state: RunStateName;
  exit_code: number | null;
  signal: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number;
  lines: string[];
  total_lines: number;
  partial: string;
  waiting_for_input: boolean;
  needs_terminal: boolean;
  error: string | null;
}

export interface RunBlockView {
  /** Where it runs, as the person reads it (`~/projects/x`); null when the project has no folder. */
  folder: string | null;
  folder_missing: boolean;
  hidden: { what: string; code: string; line: number; column: number; words: string } | null;
  /** Secrets this command names that the agent asked for and the person has not saved. */
  needs: string[];
}

export interface SavedSecret {
  name: string;
  saved_at: string;
  last4: string | null;
  store: string;
}

export interface RunStateWire {
  /** "your Mac", or this computer's name. */
  computer: string;
  /** Where a saved value goes, in words ("saved in your Keychain"). */
  store: string;
  blocks: Record<string, RunBlockView>;
  runs: Record<string, RunView>;
  secrets: SavedSecret[];
}

const url = (messageId: string, what: 'run' | 'secret') => inboxUrl(`/messages/${encodeURIComponent(messageId)}/${what}`, undefined, machineOf(messageId));

export const runApi = {
  state: (messageId: string) => apiGet<RunStateWire>(url(messageId, 'run')),
  start: (messageId: string, key: string, command: string) => apiPost<{ ok: true }>(url(messageId, 'run'), { key, op: 'start', command }),
  stop: (messageId: string, key: string) => apiPost<{ ok: true }>(url(messageId, 'run'), { key, op: 'stop' }),
  terminal: (messageId: string, key: string, command: string) => apiPost<{ ok: true; terminal: string }>(url(messageId, 'run'), { key, op: 'terminal', command }),
  saveSecret: (messageId: string, name: string, value: string) => apiPost<{ ok: true }>(url(messageId, 'secret'), { name, value }),
  removeSecret: (messageId: string, name: string) => apiPost<{ ok: true }>(url(messageId, 'secret'), { name, value: null }),
};
