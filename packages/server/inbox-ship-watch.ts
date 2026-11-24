/**
 * Ship's watch and its records' changes (approval "inbox-ship-mode"; docs/agent-guides/inbox-ship.md).
 *
 * The watch lives in the Inbox, not in the agent, so it outlives the agent's session. While a ship is active one timer
 * (every `INBOX_SHIP_WATCH_MS`, the window poll's own cadence; nothing runs while none is) reads each shipping pull
 * request once (`readShipPull`) and tells the agent what changed (core `shipChanges`), all of a tick's changes in ONE
 * note, so one change is one wake and the same state read again sends nothing. The note is the Inbox's own notice
 * (store `tellShip`, `ship_note`), addressed to the shipping session (`shipper`: the one Ship was given, never the
 * thread's latest agent), so every agent kind's own wake carries it: the bridge poll (Claude Code, Pi, OpenCode),
 * `codex queue` (Codex), and a launched session's respawn (a watch note only: a stop never starts a session again).
 *
 * Stuck is shown, never enforced: the agent says so, a check failed on `INBOX_SHIP_STUCK_FAILS` different heads, a
 * session the Inbox cannot restart ended with a note waiting, or the pull request could not be read
 * `INBOX_SHIP_READ_MISSES` times in a row. The watch keeps going either way, and a stuck the watch saw ends by itself
 * when its cause does. Merged (by anyone) ends it; closed stops it with the closed line. Stop ends it at once with the
 * stop line. One pull request ships once across computers: a Ship tells every linked computer (`onStart`), and a
 * computer told of a newer ship of the same pull request stops its own (`newer`).
 */
import {
  INBOX_SHIP_ENDED_MS,
  INBOX_SHIP_READ_MISSES,
  SHIP_READ_STUCK,
  shipActive,
  shipChanges,
  shipFailsAfter,
  shipPullName,
  shipSeenAfter,
  shipStuckCheck,
  type InboxShip,
  type InboxShipAgent,
  type InboxShipLogEntry,
} from "@plannotator/core/inbox-ship";
import { shipClosedLine, shipStillLine, shipStopLine } from "@plannotator/core/inbox-ship-words";
import type { InboxShipReadResult } from "./inbox-ship-read";
import type { InboxShipStore } from "./inbox-ship-store";

export const INBOX_SHIP_WATCH_MS = 2 * 60_000;

export interface InboxShipWatchOptions {
  ships: InboxShipStore;
  /** One read of the ship's pull request; `{ failed }` (or null) when it could not be read (the next tick tries again). */
  read: (ship: InboxShip) => Promise<InboxShipReadResult | null>;
  /** Write a note to the ship's agent in its thread (store `tellShip`), addressed to `shipper`'s session. */
  note: (ship: InboxShip, body: string, kind: "watch" | "stop") => void;
  /**
   * The shipping session as it stands: the record's, or the session a new one's launch started (read from the
   * instruction's message). Absent: the record's.
   */
  shipper?: (ship: InboxShip) => { host: string; session: string } | null;
  /** Since when the ship's session has ended with a note of the ship's still waiting for it; null when it has not. */
  endedWaiting?: (ship: InboxShip) => number | null;
  /** A ship started here: every linked computer is told, so an older ship of the same pull request there stops. */
  onStart?: (ship: InboxShip) => void;
  /** A ship changed: the windows read again. */
  onChange?: () => void;
  now?: () => number;
  everyMs?: number;
}

export interface InboxShipStart {
  key: string;
  platform: InboxShip["platform"];
  url: string;
  title: string;
  number: number;
  repo: string;
  host: string;
  thread_id: string;
  project_id: string;
  agent: InboxShipAgent;
  instruction_id?: string | null;
}

export interface InboxShipStep {
  kind: "step" | "stuck" | "merged";
  text: string;
  sha?: string | null;
}

const newId = () => `shp_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

export function createInboxShipWatch(options: InboxShipWatchOptions) {
  const { ships } = options;
  const now = options.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  let timer: ReturnType<typeof setInterval> | null = null;
  const reading = new Set<string>();

  const changed = () => {
    options.onChange?.();
    arm();
  };
  /** The timer runs only while a ship is active. */
  const arm = () => {
    const any = ships.all().some(shipActive);
    if (any && !timer) {
      timer = setInterval(() => void tick(), options.everyMs ?? INBOX_SHIP_WATCH_MS);
      (timer as { unref?: () => void }).unref?.();
    } else if (!any && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  const entry = (kind: InboxShipLogEntry["kind"], text: string, by: InboxShipLogEntry["by"] = "inbox", sha?: string): InboxShipLogEntry => ({ at: iso(), by, kind, text, ...(sha ? { sha } : {}) });
  /** Who ships it now: the record's session, or the one a new session's launch started. */
  const shipperOf = (ship: InboxShip): { host: string; session: string } | null =>
    options.shipper ? options.shipper(ship) : ship.agent.session && ship.agent.host ? { host: ship.agent.host, session: ship.agent.session } : null;
  /** A new session started for the ship: its session is recorded, so its calls and its notes are its own. */
  const remember = (ship: InboxShip): InboxShip => {
    const who = shipperOf(ship);
    if (!who || (who.session === ship.agent.session && who.host === ship.agent.host)) return ship;
    return ships.update(ship.key, (was) => (was.id === ship.id ? { ...was, agent: { ...was.agent, host: who.host, session: who.session } } : was)) ?? ship;
  };

  /** A read that failed: counted; a few in a row show Stuck with why in the log. The next read that works ends it. */
  const missed = (fresh: InboxShip, why: string) => {
    const misses = (fresh.misses ?? 0) + 1;
    const stuck = misses >= INBOX_SHIP_READ_MISSES && fresh.state === "shipping";
    ships.update(fresh.key, (was) => ({
      ...was,
      misses,
      ...(stuck ? { state: "stuck" as const, reason: SHIP_READ_STUCK, stuck_by: "read" as const, log: [...was.log, entry("stuck", `Stuck: ${SHIP_READ_STUCK} (${why})`)] } : {}),
    }));
    process.stderr.write(`Inbox: Ship could not read ${fresh.url} (${misses} in a row): ${why}\n`);
    if (stuck) changed();
  };

  /** One ship, read once: what changed goes to the log, and to the agent in one note. */
  const look = async (key: string): Promise<void> => {
    const held = ships.get(key);
    if (!held || !shipActive(held) || reading.has(key)) return;
    reading.add(key);
    try {
      const ship = remember(held);
      const got = await options.read(ship);
      const fresh = ships.get(key);
      if (!fresh || !shipActive(fresh) || fresh.id !== ship.id) return;
      if (!got || "failed" in got) return missed(fresh, got?.failed ?? "no answer");
      const read = got;
      // The first read is where the agent starts from (its instruction covers it): remembered, never told.
      const first = !fresh.seen;
      const all = shipChanges(first ? { ...fresh, seen: { head_sha: read.head_sha, comment: read.comment, sent: {} } } : fresh, read);
      const changes = first ? all.filter((c) => c.kind === "merged" || c.kind === "closed") : all;
      const fails = shipFailsAfter(fresh.fails, read);
      const failing = shipStuckCheck(fails);
      const endedAt = options.endedWaiting?.(fresh) ?? null;
      const ended = endedAt !== null && now() - endedAt >= INBOX_SHIP_ENDED_MS;
      const merged = changes.find((c) => c.kind === "merged");
      const closed = changes.find((c) => c.kind === "closed");
      const lines = changes.flatMap((c) => (c.line ? [c.line] : []));
      const next = ships.update(key, (was) => {
        const log = [...was.log, ...changes.map((c) => entry(c.kind, c.log, "inbox", c.sha))];
        if (merged) return { ...was, state: "merged", reason: null, stuck_by: null, merged_at: read.merged_at ?? iso(), ended_at: iso(), log };
        if (closed) return { ...was, state: "stopped", reason: "closed", stuck_by: null, ended_at: iso(), log };
        let state = was.state;
        let reason = was.reason;
        let stuckBy = was.stuck_by ?? null;
        if (stuckBy !== "agent") {
          const why = failing ? `${failing} failing` : ended ? `${was.agent.name ?? "The agent"} ended` : null;
          if (why && (state !== "stuck" || reason !== why)) {
            state = "stuck";
            reason = why;
            stuckBy = failing ? "checks" : "ended";
            log.push(entry("stuck", `Stuck: ${why}`));
          } else if (!why && state === "stuck") {
            state = "shipping";
            reason = null;
            stuckBy = null;
          }
        }
        const { misses: _misses, ...kept } = was;
        return { ...kept, state, reason, stuck_by: stuckBy, fails, seen: shipSeenAfter(was, read, all), log };
      });
      if (!next) return;
      if (closed) options.note(next, shipClosedLine(shipPullName(next)), "stop");
      else if (!merged && lines.length > 0) options.note(next, [...lines, shipStillLine(shipPullName(next))].join("\n"), "watch");
      if (changes.length > 0 || next.state !== fresh.state) changed();
    } finally {
      reading.delete(key);
    }
  };

  const tick = async () => {
    for (const ship of ships.all()) if (shipActive(ship)) await look(ship.key);
  };

  return {
    /** The person pressed Ship and the agent has its instruction: the record, and the watch's first read. */
    start(input: InboxShipStart): InboxShip {
      const was = ships.get(input.key);
      // Shipped again with another agent (another thread, or another session in the same one): the one before is told to stop.
      if (was && shipActive(was) && (was.thread_id !== input.thread_id || shipperOf(was)?.session !== input.agent.session)) options.note(was, shipStopLine(shipPullName(was)), "stop");
      const ship: InboxShip = {
        id: newId(),
        ...input,
        started_at: iso(),
        state: "shipping",
        reason: null,
        stuck_by: null,
        ended_at: null,
        merged_at: null,
        seen: null,
        fails: {},
        told: [],
        log: [entry("started", "Started")],
      };
      ships.put(ship);
      changed();
      options.onStart?.(ship);
      void look(ship.key);
      return ship;
    },

    /**
     * Another computer started shipping this pull request (its Ship, through the outbox: an offline computer hears it
     * when back). An active ship here that started before it stops, and its agent is told; a newer one here stays (the
     * other computer hears of it the same way and stops its own). `where`: that computer's name, for the log.
     */
    newer(other: { key: string; id: string; started_at: string }, where: string | null): InboxShip | null {
      const ship = ships.get(other.key);
      if (!ship || !shipActive(ship) || ship.id === other.id) return null;
      const older = ship.started_at < other.started_at || (ship.started_at === other.started_at && ship.id < other.id);
      if (!older) return null;
      const next = ships.update(ship.key, (was) => ({ ...was, state: "stopped", reason: "elsewhere", stuck_by: null, ended_at: iso(), log: [...was.log, entry("stopped", `Stopped: shipping on ${where ?? "another computer"}`)] }));
      if (next) options.note(next, shipStopLine(shipPullName(next)), "stop");
      changed();
      return next;
    },

    /** Stop shipping: at once, whatever the agent is doing; the agent gets the stop line. */
    stop(id: string): InboxShip | null {
      const ship = ships.byId(id);
      if (!ship) return null;
      if (!shipActive(ship)) return ship;
      const next = ships.update(ship.key, (was) => ({ ...was, state: "stopped", reason: "stop", stuck_by: null, ended_at: iso(), log: [...was.log, entry("stopped", "Stopped")] }));
      if (next) options.note(next, shipStopLine(shipPullName(next)), "stop");
      changed();
      return next;
    },

    /**
     * The agent's `thread_pulls` `ship`: a line in the log; stuck says why; merged reads the pull request at once. Only
     * the shipping session's call (`session`) changes the ship: any other session's is null, as when nothing ships.
     */
    step(threadId: string, step: InboxShipStep, session: string | null): InboxShip | null {
      const held = ships.ofThread(threadId);
      if (!held || !shipActive(held) || !session) return null;
      const ship = remember(held);
      if (shipperOf(ship)?.session !== session) return null;
      const text = step.text.trim().slice(0, 200) || (step.kind === "merged" ? "Merged" : step.kind === "stuck" ? "Stuck" : "Step");
      const sha = step.sha && /^[0-9a-f]{7,64}$/i.test(step.sha) ? step.sha.toLowerCase() : undefined;
      const next = ships.update(ship.key, (was) => {
        const log = [...was.log, entry(step.kind === "stuck" ? "stuck" : step.kind === "merged" ? "merged" : "step", step.kind === "stuck" ? `Stuck: ${text}` : text, "agent", sha?.slice(0, 7))];
        const told = sha ? [...was.told, sha].slice(-50) : was.told;
        if (step.kind === "stuck") return { ...was, state: "stuck", reason: text.slice(0, 60), stuck_by: "agent", told, log };
        // Going on after saying stuck: shipping again.
        const going = was.stuck_by === "agent" ? { state: "shipping" as const, reason: null, stuck_by: null } : {};
        return { ...was, ...going, told, log };
      });
      changed();
      if (step.kind === "merged" && next) void look(next.key);
      return next;
    },

    /** A window's read saw this pull request: a shipping one whose head or checks moved is read now, not at the tick. */
    saw(pulls: readonly { key: string; head_sha?: string | null; state: string }[]): void {
      for (const pull of pulls) {
        const ship = ships.get(pull.key);
        if (ship && shipActive(ship) && ship.seen && (pull.state !== "open" && pull.state !== "draft" ? true : !!pull.head_sha && pull.head_sha !== ship.seen.head_sha)) void look(ship.key);
      }
    },

    /** Every active ship read once now (the tests' tick; the timer's). */
    tick,
    look,
    /** Start the timer when ships are active (the Inbox starting with ships from before). */
    resume: arm,
    close() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export type InboxShipWatch = ReturnType<typeof createInboxShipWatch>;

/**
 * Since when a ship's note has waited for its shipping session, which ended (`ended`, of that session, never the
 * thread's latest agent): the oldest of its notes not yet delivered, in ms. Null while the session is there or nothing
 * waits.
 */
export function shipEndedWaiting<S extends Pick<InboxShip, "id" | "thread_id">>(
  store: { threadMessageIds(threadId: string): readonly string[]; message(id: string): { created_at: string; ship_note?: { ship: string } | null; delivery?: unknown } | null | undefined },
  ship: S,
  ended: (ship: S) => boolean,
): number | null {
  if (!ended(ship)) return null;
  for (const id of store.threadMessageIds(ship.thread_id)) {
    const m = store.message(id);
    if (m?.ship_note?.ship === ship.id && !m.delivery) return Date.parse(m.created_at);
  }
  return null;
}
