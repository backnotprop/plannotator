/**
 * A new routine not made yet (it has no name or no prompt) kept in this tab's sessionStorage, so a refresh, or leaving
 * and coming back to New routine, brings it back. sessionStorage is the tab's own: two tabs each keep their own. The
 * key is the one its create sends, so a page that went away mid-create makes it once when it comes back. Cleared once
 * the routine is made, or when its name and prompt are both emptied.
 */
import type { ScheduledFields } from './client';

const KEY = 'plannotator-routine-draft';

export interface KeptRoutine {
  fields: ScheduledFields;
  key: string;
}

function store(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function readKeptRoutine(): KeptRoutine | null {
  try {
    const kept = JSON.parse(store()?.getItem(KEY) ?? 'null') as KeptRoutine | null;
    return kept && typeof kept.key === 'string' && kept.fields && typeof kept.fields.prompt === 'string' && typeof kept.fields.name === 'string' ? kept : null;
  } catch {
    return null;
  }
}

/** Keeps it while it has a name or a prompt; forgets it when both are empty. */
export function keepRoutine(fields: ScheduledFields, key: string): void {
  try {
    if (fields.name.trim() || fields.prompt.trim()) store()?.setItem(KEY, JSON.stringify({ fields, key }));
    else store()?.removeItem(KEY);
  } catch {
    // Full or refused: the words stay in the fields.
  }
}

export function forgetKeptRoutine(): void {
  try {
    store()?.removeItem(KEY);
  } catch {
    // Nothing to forget.
  }
}
