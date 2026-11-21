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

/** This Inbox's id, as the merged list names it. */
export function setSelfMachine(id: string | null | undefined): void {
  if (typeof id === 'string' && MACHINE_ID.test(id)) selfMachine = id;
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
