let selfMachine: string | null = null;
const owners = new Map<string, string>();
/** Ids this Inbox's own answers named are local for good: no linked machine's answer can claim one. */
const local = new Set<string>();
const contested = new Set<string>();

const MACHINE_ID = /^ibx_[0-9A-HJKMNP-TV-Z]{26}$/;

export function setSelfMachine(id: string | null | undefined): void {
  if (typeof id === 'string' && MACHINE_ID.test(id)) selfMachine = id;
}

export function selfMachineId(): string | null {
  return selfMachine;
}

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

export function rememberLocal(ids: Iterable<string>): void {
  for (const id of ids) {
    if (!id) continue;
    local.add(id);
    owners.delete(id);
    contested.delete(id);
  }
}

export function machineOf(id: string | null | undefined): string | null {
  return (id && owners.get(id)) ?? null;
}

export function isContested(id: string | null | undefined): boolean {
  return !!id && contested.has(id);
}

export function localRoute(url: string): string {
  return url.replace(/^\/api\/inbox\/m\/ibx_[0-9A-HJKMNP-TV-Z]{26}\//, '/api/inbox/');
}

export function resetMachineRoutes(): void {
  selfMachine = null;
  owners.clear();
  local.clear();
  contested.clear();
}

export function inboxUrl(path: string, query?: string, machine?: string | null): string {
  const tail = `${path}${query ? `${path.includes('?') ? '&' : '?'}${query}` : ''}`;
  if (machine && machine !== selfMachine) return `/api/inbox/m/${machine}${tail}`;
  return `/api/inbox${tail}`;
}
