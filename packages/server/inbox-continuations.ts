export const INBOX_CONTINUES_MAX = 8;
const SESSION_ID_MAX = 200;

export function parseInboxContinues(value: unknown, self: string): string[] {
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || id.length > SESSION_ID_MAX || id === self || out.includes(id)) continue;
    out.push(id);
    if (out.length >= INBOX_CONTINUES_MAX) break;
  }
  return out;
}

export interface InboxContinuations {
  claim(heir: string, continues: readonly string[]): void;
  lineOf(heir: string): string[];
  inheritedBy(heir: string): string[];
  heirOf(session: string): string | null;
  claimed(): string[];
  signature(): string;
}

export function createInboxContinuations(deps: { isLive(session: string): boolean }): InboxContinuations {
  const claims = new Map<string, string[]>();
  const holders = new Map<string, string>();

  const lineOf = (heir: string): string[] => {
    const out: string[] = [];
    const walk = (session: string) => {
      for (const named of claims.get(session) ?? []) {
        if (named === heir || out.includes(named)) continue;
        out.push(named);
        walk(named);
      }
    };
    walk(heir);
    return out;
  };

  const reachOf = (heir: string): string[] => {
    const out: string[] = [];
    for (const session of lineOf(heir)) {
      if (deps.isLive(session)) break;
      out.push(session);
    }
    return out;
  };

  const holds = (heir: string, session: string): boolean => deps.isLive(heir) && reachOf(heir).includes(session);

  const heirOf = (session: string): string | null => {
    if (deps.isLive(session)) {
      holders.delete(session);
      return null;
    }
    const current = holders.get(session);
    if (current !== undefined && holds(current, session)) return current;
    holders.delete(session);
    for (const heir of claims.keys()) {
      if (!holds(heir, session)) continue;
      holders.set(session, heir);
      return heir;
    }
    return null;
  };

  return {
    claim(heir, continues) {
      if (continues.length === 0) claims.delete(heir);
      else claims.set(heir, [...continues]);
    },
    lineOf,
    inheritedBy: (heir) => (deps.isLive(heir) ? reachOf(heir).filter((session) => heirOf(session) === heir) : []),
    heirOf,
    claimed: () => [...new Set([...claims.values()].flat())],
    signature: () =>
      [...new Set([...claims.values()].flat())]
        .sort()
        .flatMap((session) => {
          const heir = heirOf(session);
          return heir ? [`${session}>${heir}`] : [];
        })
        .join(","),
  };
}
