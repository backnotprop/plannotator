/**
 * Routines' routes (Bun Inbox only). The contract is research CONTRACT.md section 2; every POST carries the page's
 * `serverSession`. A routine lives and runs on the computer that made it: the list is this computer's and every linked
 * one's (`?machines=1`, each far row with `machine`), and a linked computer's routine is read and changed there,
 * through this Inbox's forward (`inboxUrl(…, machine)`), as its threads are. A write to a computer that is away waits
 * in this Inbox's outbox: the window's waiting toast says so (`onRoutineHeld`), and the merged read shows the row with
 * the write on it until that computer takes or refuses it. Run once now is the exception: at the press, or not at all.
 */
import type { InboxScheduledFolder, InboxScheduledIfMissed, InboxScheduledPreview, InboxScheduledRow, InboxScheduledRunSummary, InboxScheduledSchedule } from '@plannotator/core/inbox-scheduled-types';
import { apiGet, apiPost, InboxApiError, InboxHeldError } from '../api';
import { inboxUrl, linkedMachineFacts, machineOf, rememberMachine } from '../inboxUrl';
import { newUuid } from '../uuid';

declare module '../api' {
  interface SettingsModel {
    /** Settings → Capabilities → Routines. Absent where launch is not supported (Windows): no row. */
    scheduled_threads?: { on: boolean; login?: 'added' | 'unavailable' };
  }
}

export interface ScheduledFields {
  name: string;
  prompt: string;
  schedule: InboxScheduledSchedule;
  if_missed: InboxScheduledIfMissed;
  folder: InboxScheduledFolder;
  agent: string;
  model?: string;
  effort?: string;
  attachments: string[];
}

/** A linked computer that takes routines, as the merged read last said: whether they are on there, and whether it is away. */
export interface RoutineComputer {
  id: string;
  on: boolean;
  launch_on: boolean;
  away: boolean;
  /** When it last gave its routines (ISO). Absent from an older Inbox. */
  read_at?: string;
}

/** A linked computer's name, as the merged list says it. */
const nameOf = (machine: string) => linkedMachineFacts(machine)?.name ?? 'The other computer';

/** Run once now on a computer that cannot be reached: it never runs later, and the person is told so where they pressed. */
async function nowOrNot<T>(id: string, write: Promise<T>): Promise<T> {
  try {
    return await write;
  } catch (cause) {
    const machine = machineOf(id);
    if (machine && cause instanceof InboxApiError && cause.code === 'machine_offline') throw new InboxApiError(503, 'machine_offline', `${nameOf(machine)} is away. It didn't run.`);
    throw cause;
  }
}

/** The run a Stop is pressed for: the one the row shows going (its divider's id). */
export const runShown = (row: Pick<InboxScheduledRow, 'last_run'>): string | undefined => (row.last_run?.outcome === 'running' ? row.last_run.message_id : undefined);

/** One computer's routes: this one's, or a linked one's through the forward. */
const base = (machine: string | null) => inboxUrl('/scheduled', undefined, machine);
const one = (id: string, rest = '') => `${base(machineOf(id))}/${encodeURIComponent(id)}${rest}`;
type Saved = { scheduled: InboxScheduledRow };

/** A far routine's ids are that computer's: its editor, its thread and its project open there. */
function rememberRows<T extends { scheduled: readonly InboxScheduledRow[] }>(answer: T): T {
  for (const row of answer.scheduled) if (row.machine) rememberMachine([row.id, row.thread_id ?? '', 'project_id' in row.folder ? row.folder.project_id : ''], row.machine);
  return answer;
}

let heldSay: ((cause: InboxHeldError) => void) | null = null;
const said = new Set<string>();
/** The page's waiting toast for a write held for a computer that is away: once per held write. */
export function onRoutineHeld(say: ((cause: InboxHeldError) => void) | null): void {
  heldSay = say;
}
function tellHeld(cause: InboxHeldError): void {
  if (said.has(cause.outbox.key)) return;
  said.add(cause.outbox.key);
  heldSay?.(cause);
}

/**
 * A write held for a computer that is away: its toast, and `instead` (the row as it stands) in place of the answer
 * that computer gives when it takes the write. Without `instead` the held write is the caller's to handle.
 */
async function heldAs<T>(write: Promise<T>, instead?: () => T | null): Promise<T> {
  try {
    return await write;
  } catch (cause) {
    if (!(cause instanceof InboxHeldError)) throw cause;
    tellHeld(cause);
    const shown = instead?.();
    if (shown === undefined || shown === null) throw cause;
    return shown;
  }
}

/** The row the store holds (store.ts sets it), for a held write's stand-in answer. */
let rowNow: (id: string) => InboxScheduledRow | null = () => null;
export function setRoutineRowReader(read: (id: string) => InboxScheduledRow | null): void {
  rowNow = read;
}
const asItStands = (id: string, change: Partial<InboxScheduledRow> = {}) => () => {
  const row = rowNow(id);
  return row ? { scheduled: { ...row, ...change } } : null;
};

export const scheduledApi = {
  list: () => apiGet<{ scheduled: InboxScheduledRow[]; launch_on: boolean; computers?: RoutineComputer[] }>(inboxUrl('/scheduled', 'machines=1')).then(rememberRows),
  read: (id: string) => apiGet<{ scheduled: InboxScheduledRow; runs: InboxScheduledRunSummary[] }>(one(id)),
  /**
   * `key`: the editor's one key for a new routine, so its retries and a reloaded page's draft make it once. `machine`:
   * the linked computer it is made on (null: this one). Held for a computer that is away: the held error, tried again
   * under the same key until that computer answers it.
   */
  create: (fields: ScheduledFields & { enabled?: boolean }, key: string = newUuid(), keepalive = false, machine: string | null = null) =>
    heldAs(apiPost<Saved>(base(machine), { ...fields, idempotency_key: key }, { keepalive }).then((answer) => {
      if (!machine) return answer;
      rememberMachine([answer.scheduled.id], machine);
      return { ...answer, scheduled: { ...answer.scheduled, machine } };
    })),
  /** A change held for a computer that is away is shown as made: that computer takes it when it is back. */
  update: (id: string, fields: Partial<ScheduledFields>, keepalive = false) =>
    heldAs(apiPost<Saved>(one(id), fields, { keepalive }), () => asItStands(id, { ...fields, updated_at: new Date().toISOString() })()),
  turn: (id: string, on: boolean) => heldAs(apiPost<Saved>(one(id, on ? '/on' : '/off'), {}), asItStands(id)),
  /**
   * `202`: the run's divider; `failed`: why it didn't start (its thread says it too). On a linked computer it runs at
   * the press or not at all: away, it is never held to run later (`machine_offline`, "Studio is away. It didn't run.").
   */
  run: (id: string) => nowOrNot(id, apiPost<Saved & { message_id: string; failed?: string }>(one(id, '/run'), {})),
  /** `run`: the run it was pressed for (its divider's id), so a Stop that waits for an away computer ends that run only. */
  stop: (id: string, run?: string) => heldAs(apiPost<Saved>(one(id, '/stop'), run ? { run } : {}), asItStands(id)),
  /** `deleted: false`: held for a computer that is away, which deletes it when it is back (the toast says so). */
  remove: (id: string) => heldAs(apiPost<{ deleted: boolean }>(one(id, '/delete'), {}), () => ({ deleted: false })),
  /** A delete's Undo: back as it was. */
  restore: (id: string) => heldAs(apiPost<Saved>(one(id, '/restore'), {}), asItStands(id)),
  /** The schedule's words and next run, from the computer the routine runs on (`machine`; null: this one). */
  preview: (schedule: InboxScheduledSchedule, machine: string | null = null) => apiPost<InboxScheduledPreview>(`${base(machine)}/preview`, { schedule }),
  /** The capability switch (`POST /api/inbox/settings`). */
  saveSwitch: (on: boolean) => apiPost<{ scheduled_threads: { on: boolean; login?: 'added' | 'unavailable' } }>(inboxUrl('/settings'), { scheduled_threads: { on } }),
};
