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
import { inboxMarksHave, type InboxLinkedMark } from '@plannotator/core/inbox-types';

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

/** Bumps when the linked machines' facts changed (`onLinkedMachines`): what reads by them reads again. */
let linkedRev = 0;
const linkedListeners = new Set<() => void>();
const factsSignature = () => JSON.stringify([selfName, [...linkedFacts]]);

/** The merged list's machines: each linked one's facts, for what an agent there can read (threadMentions.ts). */
export function setLinkedMachines(machines: readonly MachineFactsWire[] | null | undefined): void {
  if (!machines) return;
  const was = factsSignature();
  linkedFacts.clear();
  for (const m of machines) {
    if (m.self) selfName = m.name;
    else if (MACHINE_ID.test(m.id)) linkedFacts.set(m.id, { name: m.name, marks: m.marks ?? [], both_ways: m.both_ways === true, listed: m.list_cursor !== null && m.list_cursor !== undefined, state: m.state ?? '' });
  }
  if (factsSignature() !== was) linkedChanged();
  for (const listener of listedListeners) listener();
}

const listedListeners = new Set<() => void>();
/** Called each time the merged list names the linked machines, changed or not (`onLinkedMachines` hears a change only). */
export function onLinkedMachinesListed(listener: () => void): () => void {
  listedListeners.add(listener);
  return () => {
    listedListeners.delete(listener);
  };
}

function linkedChanged() {
  linkedRev += 1;
  for (const listener of linkedListeners) listener();
}

/** Called when the linked machines' facts change; the answer stops it. */
export function onLinkedMachines(listener: () => void): () => void {
  linkedListeners.add(listener);
  return () => {
    linkedListeners.delete(listener);
  };
}

/** A count that moves with each change of the linked machines' facts (`useSyncExternalStore`'s snapshot). */
export function linkedMachinesRev(): number {
  return linkedRev;
}

/** This machine's name as the merged list last said it, or null. */
export function selfMachineName(): string | null {
  return selfName;
}

/** A linked machine's facts as the merged list last said them, or null (not linked, or not heard of yet). */
export function linkedMachineFacts(id: string): LinkedMachineFacts | null {
  return linkedFacts.get(id) ?? null;
}

/**
 * Whether a machine takes `mark`: this Inbox itself always does (null, its own id, or no machine at all); a linked one
 * (its id, or its view) when its list says so; one not heard of yet, or an older one, does not.
 */
export function hasMachineMark(machineOrId: string | { id: string; marks?: readonly string[] } | null | undefined, mark: InboxLinkedMark): boolean {
  if (!machineOrId) return true;
  const id = typeof machineOrId === 'string' ? machineOrId : machineOrId.id;
  if (id === selfMachine) return true;
  return inboxMarksHave(typeof machineOrId === 'string' ? linkedFacts.get(id)?.marks : machineOrId.marks, mark);
}

/** Every linked machine the merged list last named that can be read (not one too old to link, nor revoked), by id. */
export function linkedMachineIds(): string[] {
  return [...linkedFacts].filter(([, facts]) => facts.state !== 'needs_update' && facts.state !== 'revoked').map(([id]) => id).sort();
}

/** The linked machines the merged list last said take `mark`, by id (an older one, or one not listed yet, does not). */
export function linkedMachinesWith(mark: string): string[] {
  return [...linkedFacts].filter(([, facts]) => facts.marks.includes(mark) && facts.state !== 'needs_update' && facts.state !== 'revoked').map(([id]) => id).sort();
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

type ArtifactIds = { key: string; thread_id: string; machine?: string; message_id?: string; project?: { id: string }; attachment?: { id: string } | null };

/**
 * The merged artifact pins' and Wall's entries of another machine (`machine`, inbox-artifacts-merged.ts in the server):
 * their thread, message, project and file are that machine's, so a tile opens there and a pin goes there.
 */
export function rememberArtifactMachines<T extends { pins?: readonly ArtifactIds[]; artifacts?: readonly ArtifactIds[] }>(model: T): T {
  // An answer of another shape (an older Inbox's, a proxy's) names no machine: the reader decides what it means.
  const list = (value: unknown): readonly ArtifactIds[] => (Array.isArray(value) ? value : []);
  for (const entry of [...list(model?.pins), ...list(model?.artifacts)]) {
    if (!entry || typeof entry.machine !== 'string' || !entry.machine || typeof entry.key !== 'string' || typeof entry.thread_id !== 'string') continue;
    const file = entry.key.startsWith('guide:') || entry.key.startsWith('html:') ? '' : entry.key;
    rememberMachine([entry.thread_id, entry.message_id ?? '', entry.project?.id ?? '', entry.attachment?.id ?? '', file], entry.machine);
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
  linkedChanged();
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
