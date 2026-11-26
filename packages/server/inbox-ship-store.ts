/**
 * Ship's records (approval "inbox-ship-mode"; core `inbox-ship.ts`): one per pull request, on the computer that holds
 * the shipping agent's thread.
 *
 *   inbox/ships.json   { v: 1, ships: { [pull key]: InboxShip } }
 *
 * Written whole to a temp file, then renamed, 0600; a file that cannot be read is moved aside, never written over. A
 * write that fails (a read-only folder) keeps the records in memory. A ship that ended (merged or stopped) is kept so its
 * row and log still show; the newest `INBOX_SHIPS_KEPT` ended ones are kept.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_SHIP_LOG_MAX, shipActive, type InboxShip, type InboxShipLogEntry } from "@plannotator/core/inbox-pull-handoff";
import { inboxDir } from "@plannotator/shared/inbox/schema";

export const INBOX_SHIPS_FILE = "ships.json";
export const INBOX_SHIPS_KEPT = 200;

export interface InboxShipStore {
  all(): InboxShip[];
  get(key: string): InboxShip | null;
  byId(id: string): InboxShip | null;
  /** The ship of a thread (the agent's `thread_pulls` `ship`), the active one first. */
  ofThread(threadId: string): InboxShip | null;
  put(ship: InboxShip): void;
  /** Change one ship; null when there is none. */
  update(key: string, change: (ship: InboxShip) => InboxShip): InboxShip | null;
  /** The highest generation of a Ship of this pull request heard of from a linked computer (0: none). */
  heard(key: string): number;
  hear(key: string, generation: number): void;
}

const isShip = (value: unknown): value is InboxShip => {
  const v = value as Partial<InboxShip> | null;
  return !!v && typeof v.id === "string" && typeof v.key === "string" && typeof v.thread_id === "string" && typeof v.state === "string" && Array.isArray(v.log);
};

/** The log, oldest first, cut to its newest entries. */
export const shipLogKept = (log: readonly InboxShipLogEntry[]): InboxShipLogEntry[] => (log.length > INBOX_SHIP_LOG_MAX ? log.slice(log.length - INBOX_SHIP_LOG_MAX) : [...log]);

export function createInboxShipStore(dataDir: string): InboxShipStore {
  const dir = inboxDir(dataDir);
  const file = join(dir, INBOX_SHIPS_FILE);
  let ships: Map<string, InboxShip> | null = null;
  // The generations heard of from linked computers, per pull request key (`heard`).
  let heard = new Map<string, number>();

  const load = (): Map<string, InboxShip> => {
    if (ships) return ships;
    ships = new Map();
    if (!existsSync(file)) return ships;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; ships?: Record<string, unknown>; heard?: Record<string, unknown> };
      if (parsed.v !== 1 || !parsed.ships || typeof parsed.ships !== "object") throw new Error("not a ships file");
      for (const [key, value] of Object.entries(parsed.ships)) if (isShip(value)) ships.set(key, value);
      for (const [key, value] of Object.entries(parsed.heard && typeof parsed.heard === "object" ? parsed.heard : {})) if (Number.isSafeInteger(value) && (value as number) > 0) heard.set(key, value as number);
    } catch {
      try {
        renameSync(file, `${file}.unreadable-${Date.now()}`);
      } catch {
        // Left where it is.
      }
      ships = new Map();
      heard = new Map();
    }
    return ships;
  };

  const save = () => {
    const map = load();
    // The ended ones beyond the newest kept go; an active ship is never dropped.
    const ended = [...map.values()].filter((ship) => !shipActive(ship)).sort((a, b) => ((a.ended_at ?? a.started_at) < (b.ended_at ?? b.started_at) ? 1 : -1));
    for (const ship of ended.slice(INBOX_SHIPS_KEPT)) {
      map.delete(ship.key);
      if ((ship.generation ?? 0) > (heard.get(ship.key) ?? 0)) heard.set(ship.key, ship.generation!);
    }
    // A generation heard of is kept while it is above what this computer's own record of that pull request knows.
    for (const [key, generation] of heard) if ((map.get(key)?.generation ?? 0) >= generation) heard.delete(key);
    try {
      mkdirSync(dir, { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ v: 1, ships: Object.fromEntries(map), ...(heard.size > 0 ? { heard: Object.fromEntries(heard) } : {}) })}\n`, { mode: 0o600 });
      renameSync(temp, file);
    } catch {
      // A read-only folder: the records stay in memory.
    }
  };

  return {
    all: () => [...load().values()],
    get: (key) => load().get(key) ?? null,
    byId: (id) => [...load().values()].find((ship) => ship.id === id) ?? null,
    ofThread: (threadId) => {
      const mine = [...load().values()].filter((ship) => ship.thread_id === threadId);
      return mine.find(shipActive) ?? mine.sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0] ?? null;
    },
    put: (ship) => {
      load().set(ship.key, { ...ship, log: shipLogKept(ship.log) });
      save();
    },
    update: (key, change) => {
      const was = load().get(key);
      if (!was) return null;
      const next = change(was);
      // A tick that changed nothing writes nothing.
      if (next === was || JSON.stringify(next) === JSON.stringify(was)) return was;
      load().set(key, { ...next, log: shipLogKept(next.log) });
      save();
      return next;
    },
    heard: (key) => {
      load();
      return heard.get(key) ?? 0;
    },
    hear: (key, generation) => {
      load();
      if (!Number.isSafeInteger(generation) || generation <= (heard.get(key) ?? 0) || generation <= (load().get(key)?.generation ?? 0)) return;
      heard.set(key, generation);
      save();
    },
  };
}
