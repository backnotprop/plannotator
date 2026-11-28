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
  /** The Inbox ended while it ran: it quit and stopped it ("closed"), or died and found it after ("lost"). */
  interrupted: 'closed' | 'lost' | null;
  /** A lost run's command, looked for when the Inbox started again: still running (Stop ends it), ended, or unknown. */
  left_running?: boolean | null;
}

export interface RunBlockView {
  /** Where it runs, as the person reads it (`~/projects/x`); null when the project has no folder. */
  folder: string | null;
  folder_missing: boolean;
  hidden: { what: string; code: string; line: number; column: number; words: string; where: 'command' | 'folder' } | null;
  /** The saved secrets this run gets (`$NAME` in its command, or its `Uses:` line). */
  uses: string[];
  /** Those of `uses` not saved here that the person's shell sets: the run gets their own value ("from your shell"). */
  from_shell?: string[];
  /** For a needed name whose field is on another card: the message that card is in. */
  field_at?: Record<string, string>;
  /** Those of `uses` neither saved nor set by the shell: Run waits for them. */
  needs: string[];
  /** Of `needs`, those whose one field in the thread is on this card (the others' is on the secret's card or another run's). */
  fields: string[];
  /** Letters that look like Latin ones (Cyrillic, Greek…), in words, or null. */
  lookalike: string | null;
  /** Why it may not work in the shell it runs in (PowerShell on a PC with no Git Bash), or null. */
  shell_note: string | null;
}

export interface SavedSecret {
  name: string;
  saved_at: string;
  store: string;
}

export interface RunStateWire {
  /** "your Mac" in its own window; its name on a phone or a linked machine. */
  computer: string;
  /** Where a saved value is kept, in words, the same before and after Save ("in your Keychain"; "in its Keychain" when `computer` is a name). */
  store: string;
  /** What Save does, in words, under a secret field ("Saved to your Mac's Keychain."). Absent from an older Inbox. */
  kept?: string;
  /** The shell a command runs in ("zsh", "Git Bash", "PowerShell"); null before the computer has read it. */
  shell: string | null;
  blocks: Record<string, RunBlockView>;
  runs: Record<string, RunView>;
  secrets: SavedSecret[];
}

const url = (messageId: string, what: 'run' | 'secret') => inboxUrl(`/messages/${encodeURIComponent(messageId)}/${what}`, undefined, machineOf(messageId));

export const runApi = {
  state: (messageId: string) => apiGet<RunStateWire>(url(messageId, 'run')),
  start: (messageId: string, key: string, command: string) => apiPost<{ ok: true }>(url(messageId, 'run'), { key, op: 'start', command }),
  stop: (messageId: string, key: string) => apiPost<{ ok: true }>(url(messageId, 'run'), { key, op: 'stop' }),
  /** `copied`: the command is on the clipboard of the computer where the terminal opened. */
  terminal: (messageId: string, key: string, command: string) => apiPost<{ ok: true; terminal: string; copied: boolean }>(url(messageId, 'run'), { key, op: 'terminal', command }),
  saveSecret: (messageId: string, name: string, value: string) => apiPost<{ ok: true }>(url(messageId, 'secret'), { name, value }),
  removeSecret: (messageId: string, name: string) => apiPost<{ ok: true }>(url(messageId, 'secret'), { name, value: null }),
};
