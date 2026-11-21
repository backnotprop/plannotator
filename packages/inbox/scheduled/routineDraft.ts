/**
 * A new routine not made yet (it has no name or no prompt) kept in this tab's sessionStorage, so a refresh, or leaving
 * and coming back to New routine, brings it back. sessionStorage is the tab's own: two tabs each keep their own. The
 * key is the one its create sends, so a page that went away mid-create makes it once when it comes back. Cleared once
 * the routine is made, or when its name and prompt are both emptied.
 *
 * A saved routine's edits not saved yet are kept too, by its id, with what the server had for each field then: a
 * reload (an Inbox that updated or restarted answers "Reload the page") brings them back over a field nobody else
 * changed meanwhile. Cleared once they are saved.
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

const EDITS = (id: string) => `plannotator-routine-edits:${id}`;

export interface KeptEdits {
  /** The person's words not saved yet. */
  fields: Partial<ScheduledFields>;
  /** What the server had for each of those fields when they were typed. */
  was: Partial<ScheduledFields>;
}

export function readKeptEdits(id: string): KeptEdits | null {
  try {
    const kept = JSON.parse(store()?.getItem(EDITS(id)) ?? 'null') as KeptEdits | null;
    return kept && typeof kept.fields === 'object' && typeof kept.was === 'object' ? kept : null;
  } catch {
    return null;
  }
}

/** Keeps them while there are any; forgets them when there are none. */
export function keepEdits(id: string, edits: KeptEdits): void {
  try {
    if (Object.keys(edits.fields).length > 0) store()?.setItem(EDITS(id), JSON.stringify(edits));
    else store()?.removeItem(EDITS(id));
  } catch {
    // Full or refused: the words stay in the fields.
  }
}
