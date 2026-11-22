/**
 * The one place the Inbox window writes a server URL. Every `/api/inbox/...`
 * request, EventSource and attachment `src` goes through `inboxUrl`, so
 * routing another machine's threads touches this file alone.
 * `tests/inbox-url-helper.test.ts` fails on a raw `/api/inbox` string elsewhere.
 *
 * Linked machines (docs/agent-guides/inbox-machines.md): a thread lives on the
 * machine whose agent started it. Its routes go to that machine through this
 * Inbox's forward, `/api/inbox/m/<machine>/<door route>`; the door's routes are
 * the window's own paths after `/api/inbox/`. Which machine owns an id is
 * learned from what that machine sent (its list rows, its projects, its
 * thread reads): every id is a ULID, so an id names one machine's record.
 */

/** This Inbox's own machine id (`ibx_…`), from the merged list; null before it (or from an Inbox that cannot link). */
let selfMachine: string | null = null;
/** Ids that belong to another machine, and which. An id never seen here is this Inbox's. */
const owners = new Map<string, string>();
/**
 * Ids this Inbox's own answers named (its list rows, archived rows, pins, thread reads, its own events). They are
 * local for good: no linked machine's row, answer or frame can claim one. The server refuses to forward a route to
 * an id its store holds as well (`id_is_local`), whatever this map says.
 */
const local = new Set<string>();
/**
 * Ids two linked machines both claimed. Neither gets them: their routes go nowhere, and a read or write of one is
 * refused here with a plain error (`machine_conflict`). No first or last claim wins.
 */
const contested = new Set<string>();

const MACHINE_ID = /^ibx_[0-9A-HJKMNP-TV-Z]{26}$/;

/** What the merged list last said of each linked machine: its name, the marks it takes, and whether it can reach this Inbox. */
export interface LinkedMachineFacts {
  name: string;
  marks: readonly string[];
  /** It holds a link to this Inbox too (`both_ways`), so its Inbox can call this one's door. */
  both_ways: boolean;
  /** Its list was read (`list_cursor` not null): until then its marks are not known (an empty list says nothing). */
  listed: boolean;
  /** Its line's state (`needs_update`: too old to link at all). */
  state: string;
}
const linkedFacts = new Map<string, LinkedMachineFacts>();
/** This machine's own name, as the merged list names it. */
let selfName: string | null = null;

type MachineFactsWire = { id: string; self?: boolean; name: string; marks?: readonly string[]; both_ways?: boolean; list_cursor?: number | null; state?: string };

/** The merged list's machines: each linked one's facts, for what an agent there can read (threadMentions.ts). */
export function setLinkedMachines(machines: readonly MachineFactsWire[] | null | undefined): void {
  if (!machines) return;
  linkedFacts.clear();
  for (const m of machines) {
    if (m.self) selfName = m.name;
    else if (MACHINE_ID.test(m.id)) linkedFacts.set(m.id, { name: m.name, marks: m.marks ?? [], both_ways: m.both_ways === true, listed: m.list_cursor !== null && m.list_cursor !== undefined, state: m.state ?? '' });
  }
}

/** This machine's name as the merged list last said it, or null. */
export function selfMachineName(): string | null {
  return selfName;
}

/** A linked machine's facts as the merged list last said them, or null (not linked, or not heard of yet). */
export function linkedMachineFacts(id: string): LinkedMachineFacts | null {
  return linkedFacts.get(id) ?? null;
}

/** This Inbox's id, as the merged list names it, and (when the list carries them) every linked machine's facts. */
export function setSelfMachine(id: string | null | undefined, machines?: Parameters<typeof setLinkedMachines>[0]): void {
  if (typeof id === 'string' && MACHINE_ID.test(id)) selfMachine = id;
  setLinkedMachines(machines);
}

/** This Inbox's id once the merged list named it. */
export function selfMachineId(): string | null {
  return selfMachine;
}

/**
 * Remember that `ids` belong to `machine` (nothing for this Inbox's own, or for no machine). An id this Inbox named
 * stays this Inbox's. An id another linked machine already claimed is contested: it routes to neither.
 */
export function rememberMachine(ids: Iterable<string>, machine: string | null | undefined): void {
  if (!machine || machine === selfMachine || !MACHINE_ID.test(machine)) return;
  for (const id of ids) {
    if (!id || local.has(id) || contested.has(id)) continue;
    const held = owners.get(id);
    if (held && held !== machine) {
      owners.delete(id);
      contested.add(id);
      continue;
    }
    owners.set(id, machine);
  }
}

type SearchRowIds = { id: string; project: { id: string; machine?: string }; thread_id?: string; message_id?: string };

export function rememberSearchMachines<T extends { groups: Partial<Record<string, readonly SearchRowIds[]>> | null; recent: readonly SearchRowIds[] | null }>(model: T): T {
  for (const row of [...Object.values(model.groups ?? {}).flat(), ...(model.recent ?? [])]) {
    if (row?.project.machine) rememberMachine([row.id, row.project.id, row.thread_id ?? '', row.message_id ?? ''], row.project.machine);
  }
  return model;
}

/** Ids this Inbox's own answers named: theirs for good (an earlier claim by another machine is dropped). */
export function rememberLocal(ids: Iterable<string>): void {
  for (const id of ids) {
    if (!id) continue;
    local.add(id);
    owners.delete(id);
    contested.delete(id);
  }
}

/** The machine that owns `id`, or null for this Inbox (and for a contested id, which `isContested` tells). */
export function machineOf(id: string | null | undefined): string | null {
  return (id && owners.get(id)) ?? null;
}

/** Two linked machines claimed `id`: it opens on neither. */
export function isContested(id: string | null | undefined): boolean {
  return !!id && contested.has(id);
}

/** `/api/inbox/m/<machine>/<route>` → `/api/inbox/<route>`: this Inbox's own URL for a forwarded one. */
export function localRoute(url: string): string {
  return url.replace(/^\/api\/inbox\/m\/ibx_[0-9A-HJKMNP-TV-Z]{26}\//, '/api/inbox/');
}

/** Tests only: forget every machine. */
export function resetMachineRoutes(): void {
  selfMachine = null;
  selfName = null;
  linkedFacts.clear();
  owners.clear();
  local.clear();
  contested.clear();
}

/**
 * `path` is the part after `/api/inbox` and starts with `/` (it may carry its own `?query`); `query` is already
 * encoded, without the `?`. `machine`: another machine's id, for a route of one of its threads; null or this
 * Inbox's own id is this Inbox.
 */
export function inboxUrl(path: string, query?: string, machine?: string | null): string {
  const tail = `${path}${query ? `${path.includes('?') ? '&' : '?'}${query}` : ''}`;
  if (machine && machine !== selfMachine) return `/api/inbox/m/${machine}${tail}`;
  return `/api/inbox${tail}`;
}
