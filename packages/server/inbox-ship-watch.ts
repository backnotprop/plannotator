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
 * computer told of a newer ship of the same pull request stops its own (`newer`): newer by the press's generation;
 * the press times recorded on each computer only break a tie, then the id.
 *
 * A new session's ship binds only to the session the instruction was delivered to, or to the one its own launch
 * (`launch_id`) reports (`shipper`, `mayBind`); never to whichever session calls `ship` first. A session an earlier
 * ship of the thread was given and told to stop gets the stop line back. Until the ship is bound its notes wait: the
 * watch reads, but what it would tell is kept for the bound session's first read.
 *
 * The agent's own doings never wake it: a push it logged (`told`; a new head is held one read, so a push it logs a
 * moment after is not told as a stranger's; one read only, so pushes it never logs still wake it), and the signed-in
 * login's comments a step of its claimed (`steps`:
 * each step reads the pull request, and what that login wrote before it is the agent's). What is left: a comment of
 * that login a read sees before the agent logs its next step wakes it once (it may be the person's own); a comment
 * id never wakes twice, so its own words never loop.
 */
import {
  INBOX_SHIP_ENDED_MS,
  INBOX_SHIP_READ_MISSES,
  INBOX_SHIP_START_MS,
  SHIP_READ_STUCK,
  SHIP_START_STUCK,
  shipActive,
  shipChanges,
  shipFailsAfter,
  shipNewerWins,
  shipPullName,
  shipSeenAfter,
  shipStuckCheck,
  type InboxShip,
  type InboxShipAgent,
  type InboxShipLogEntry,
  shipClosedLine,
  shipStillLine,
  shipStopLine,
} from "@plannotator/core/inbox-pull-handoff";
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
   * The shipping session as it stands: a bound ship's record's; else the session its own launch reported or the one
   * its instruction was delivered to, null while there is none (its notes wait). Absent: the record's.
   */
  shipper?: (ship: InboxShip) => { host: string; session: string } | null;
  /** An unbound ship: whether this session may bind it (its launch's session, or its instruction's delivery's). Absent: only `shipper`'s. */
  mayBind?: (ship: InboxShip, session: string) => boolean;
  /** The launch a message started (its `launch.id`): a ship ties its own when it starts. */
  launchOf?: (messageId: string) => string | null;
  /** An unbound ship's launch failed or was removed: why, in its own words (`shipLaunchFailed`). Absent: never. */
  launchFailed?: (ship: InboxShip) => string | null;
  /** Since when the ship's session has ended with a note of the ship's still waiting for it; null when it has not. */
  endedWaiting?: (ship: InboxShip) => number | null;
  /**
   * A ship started here: every linked computer is told (`to` absent), so an older ship of the same pull request there
   * stops; or one computer is (`to`), whose word of an older ship this one answers.
   */
  onStart?: (ship: InboxShip, to?: string) => void;
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
  /** The launch the instruction started (a new session). Absent: the instruction message's own (`launchOf`). */
  launch_id?: string | null;
  /**
   * The person chose this live session: settled. Absent: a new session's placeholder, bound to the session its launch
   * reports or its instruction is delivered to.
   */
  bound?: boolean;
}

/** A linked computer's word that it started shipping a pull request (`ships/newer`). */
export interface InboxShipNewer {
  key: string;
  id: string;
  started_at: string;
  generation: number;
}

/**
 * What the agent's `ship` call did: logged in the ship; nothing because another session ships it; or nothing because
 * this session's ship was stopped (`stopped`: the pull request's name, for the stop line).
 */
export type InboxShipStepResult = { ship: InboxShip } | { other: true } | { stopped: string } | null;

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
  // One read of a pull request at a time. Asked while one goes (a step logged meanwhile), one more read follows it,
  // and every ask until that one starts waits for it.
  const looks = new Map<string, { promise: Promise<void>; queued: boolean }>();

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
  /**
   * A new session's ship whose session is known now (its launch reported it, or its instruction was delivered to it):
   * bound to it, so its calls and its notes are its own and no other session's ever are.
   */
  const remember = (ship: InboxShip): InboxShip => {
    if (ship.bound || !options.shipper) return ship;
    const who = options.shipper(ship);
    if (!who) return ship;
    return ships.update(ship.key, (was) => (was.id === ship.id ? { ...was, bound: true, agent: { ...was.agent, host: who.host, session: who.session } } : was)) ?? ship;
  };

  /**
   * A new session's ship that has no session yet: bound when one is known (true: bound now, its waiting notes go out at
   * its next read); Stuck "the agent didn't start" when its launch failed (at once, its reason in the log) or none was
   * known `INBOX_SHIP_START_MS` after Ship; that Stuck ends by itself once the session is known.
   */
  const settleStart = (key: string): boolean => {
    const held = ships.get(key);
    if (!held || !shipActive(held) || !options.shipper) return false;
    const wasBound = !!held.bound;
    const ship = remember(held);
    if (ship.bound) {
      if (ship.stuck_by === "start") ships.update(key, (was) => (was.stuck_by === "start" ? { ...was, state: "shipping", reason: null, stuck_by: null } : was));
      if (!wasBound || ship.stuck_by === "start") changed();
      return !wasBound;
    }
    if (ship.state !== "shipping") return false;
    const failed = options.launchFailed?.(ship) ?? null;
    const why = failed ?? (now() - Date.parse(ship.started_at) >= INBOX_SHIP_START_MS ? "no session started" : null);
    if (!why) return false;
    ships.update(key, (was) => (was.state === "shipping" ? { ...was, state: "stuck", reason: SHIP_START_STUCK, stuck_by: "start", log: [...was.log, entry("stuck", `Stuck: ${SHIP_START_STUCK} (${why})`)] } : was));
    changed();
    return false;
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

  /** One ship, read now or right after the read going: what changed goes to the log, and to the agent in one note. */
  const look = (key: string): Promise<void> => {
    const going = looks.get(key);
    if (going?.queued) return going.promise;
    const run = () => {
      const entry = looks.get(key);
      if (entry) entry.queued = false;
      return readOnce(key);
    };
    const promise: Promise<void> = (going ? going.promise.catch(() => {}).then(run) : readOnce(key)).finally(() => {
      if (looks.get(key)?.promise === promise) looks.delete(key);
    });
    looks.set(key, { promise, queued: !!going });
    return promise;
  };

  const readOnce = async (key: string): Promise<void> => {
    settleStart(key);
    const held = ships.get(key);
    if (!held || !shipActive(held)) return;
    const ship = remember(held);
    // The agent's steps logged before this read was asked: this read covers them.
    const askedAfter = ship.steps ?? 0;
    const got = await options.read(ship);
    const fresh = ships.get(key);
    if (!fresh || !shipActive(fresh) || fresh.id !== ship.id) return;
    if (!got || "failed" in got) return missed(fresh, got?.failed ?? "no answer");
    const read = got;
    // The agent logged a step no read asked after it has covered: the signed-in login's comments not yet read are its
    // own. A read asked before the step still claims what it saw (older than the step); one asked after covers it.
    const claim = (fresh.steps ?? 0) > (fresh.seen?.claimed ?? 0);
    // The first read is where the agent starts from (its instruction covers it): remembered, never told.
    const first = !fresh.seen;
    const all = shipChanges(first ? { ...fresh, seen: { head_sha: read.head_sha, comments: read.comments.map((c) => c.id), sent: {} } } : fresh, read, { claim });
    const changes = first ? all.filter((c) => c.kind === "merged" || c.kind === "closed") : all;
    const fails = shipFailsAfter(fresh.fails, read);
    const failing = shipStuckCheck(fails);
    const endedAt = options.endedWaiting?.(fresh) ?? null;
    const ended = endedAt !== null && now() - endedAt >= INBOX_SHIP_ENDED_MS;
    const merged = changes.find((c) => c.kind === "merged");
    const closed = changes.find((c) => c.kind === "closed");
    const lines = changes.flatMap((c) => (c.line ? [c.line] : []));
    // Nobody is bound yet: what this read would tell waits (nothing is recorded), so the bound session's first read
    // tells it, and no other agent of the thread ever gets it.
    if (!merged && !closed && lines.length > 0 && !shipperOf(fresh)) return;
    const next = ships.update(key, (was) => {
      const log = [...was.log, ...changes.map((c) => entry(c.kind, c.log, "inbox", c.sha))];
      if (merged) return { ...was, state: "merged", reason: null, stuck_by: null, merged_at: read.merged_at ?? iso(), ended_at: iso(), log };
      if (closed) return { ...was, state: "stopped", reason: "closed", stuck_by: null, ended_at: iso(), log };
      let state = was.state;
      let reason = was.reason;
      let stuckBy = was.stuck_by ?? null;
      // The agent's own Stuck, and a new session that did not start, end only by themselves (`step`, `settleStart`).
      if (stuckBy !== "agent" && stuckBy !== "start") {
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
      return { ...kept, state, reason, stuck_by: stuckBy, fails, seen: shipSeenAfter(was, read, all, askedAfter), log };
    });
    if (!next) return;
    if (closed) options.note(next, shipClosedLine(shipPullName(next)), "stop");
    else if (!merged && lines.length > 0) options.note(next, [...lines, shipStillLine(shipPullName(next))].join("\n"), "watch");
    if (changes.length > 0 || next.state !== fresh.state) changed();
  };

  const tick = async () => {
    for (const ship of ships.all()) if (shipActive(ship)) await look(ship.key);
  };

  return {
    /** The person pressed Ship and the agent has its instruction: the record, and the watch's first read. */
    start(input: InboxShipStart): InboxShip {
      const was = ships.get(input.key);
      // Shipped again with another agent (another thread, or another session in the same one): the one before is told to
      // stop, and in the same thread its later `ship` calls get the stop line, never this ship.
      const before = was ? (shipperOf(was)?.session ?? null) : null;
      if (was && shipActive(was) && (was.thread_id !== input.thread_id || before !== input.agent.session)) options.note(was, shipStopLine(shipPullName(was)), "stop");
      // The sessions earlier ships of this thread were given that were stopped (now, by Stop, or from another computer).
      const same = !!was && was.thread_id === input.thread_id;
      const stopped = [...(same ? (was!.stopped_sessions ?? []) : []), ...(same && was!.state !== "merged" && before ? [before] : [])].filter((s) => s !== input.agent.session);
      const { bound, launch_id, ...rest } = input;
      const launch = launch_id ?? (input.instruction_id ? (options.launchOf?.(input.instruction_id) ?? null) : null);
      const ship: InboxShip = {
        id: newId(),
        ...rest,
        ...(bound ? { bound: true } : {}),
        ...(launch ? { launch_id: launch } : {}),
        ...(stopped.length > 0 ? { stopped_sessions: [...new Set(stopped)].slice(-20) } : {}),
        // One more than any Ship of this pull request this computer knows of, here or on a linked computer.
        generation: Math.max(was?.generation ?? 0, ships.heard(input.key)) + 1,
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
     * when back). The last press wins by what each computer knew when it was pressed (`generation`, core
     * `shipNewerWins`; the two computers' press times only break a tie, then the id): an active ship here that loses stops, and its agent is
     * told; one that wins stays, and answers that computer with its own word, so the older ship there stops.
     * `from`: that computer, for the log and the answer.
     */
    newer(other: InboxShipNewer, from: { id: string | null; name: string | null }): InboxShip | null {
      ships.hear(other.key, other.generation);
      const ship = ships.get(other.key);
      if (!ship || !shipActive(ship) || ship.id === other.id) return null;
      if (!shipNewerWins(other, ship)) {
        if (from.id) options.onStart?.(ship, from.id);
        return null;
      }
      const next = ships.update(ship.key, (was) => ({ ...was, state: "stopped", reason: "elsewhere", stuck_by: null, ended_at: iso(), log: [...was.log, entry("stopped", `Stopped: shipping on ${from.name ?? "another computer"}`)] }));
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
     * The agent's `thread_pulls` `ship`: a line in the log; stuck says why. Only the shipping session's call (`session`)
     * changes the ship; another session's changes nothing and says so (`{ other }`); a session whose ship of this
     * thread was stopped (Stop, another computer, or a Ship again to another session) gets the stop line (`{ stopped }`);
     * null when nothing ships here. A new session's ship binds only to the session its own launch reported or its
     * instruction was delivered to (`mayBind`), never to whichever session calls first. Each step reads the pull request
     * at once: what the signed-in login wrote before it is the agent's own (`steps`), and a merge ends the ship.
     */
    step(threadId: string, step: InboxShipStep, session: string | null): InboxShipStepResult {
      const held = ships.ofThread(threadId);
      if (!held) return null;
      const stoppedFor = (one: InboxShip) => !!session && (one.stopped_sessions?.includes(session) || (one.state === "stopped" && shipperOf(one)?.session === session));
      if (!shipActive(held)) return stoppedFor(held) ? { stopped: shipPullName(held) } : null;
      if (!session) return { other: true };
      const ship = remember(held);
      const mine = shipperOf(ship)?.session === session || (!ship.bound && options.mayBind?.(ship, session) === true);
      if (!mine) return stoppedFor(ship) ? { stopped: shipPullName(ship) } : { other: true };
      const bind = !ship.bound || ship.agent.session !== session;
      const text = step.text.trim().slice(0, 200) || (step.kind === "merged" ? "Merged" : step.kind === "stuck" ? "Stuck" : "Step");
      const sha = step.sha && /^[0-9a-f]{7,64}$/i.test(step.sha) ? step.sha.toLowerCase() : undefined;
      const next = ships.update(ship.key, (was) => {
        const log = [...was.log, entry(step.kind === "stuck" ? "stuck" : step.kind === "merged" ? "merged" : "step", step.kind === "stuck" ? `Stuck: ${text}` : text, "agent", sha?.slice(0, 7))];
        const told = sha ? [...was.told, sha].slice(-50) : was.told;
        const own = { bound: true, steps: (was.steps ?? 0) + 1, ...(bind ? { agent: { ...was.agent, session } } : {}) };
        if (step.kind === "stuck") return { ...was, ...own, state: "stuck", reason: text.slice(0, 60), stuck_by: "agent", told, log };
        // Going on after saying stuck, or the new session that had not started calling: shipping again.
        const going = was.stuck_by === "agent" || was.stuck_by === "start" ? { state: "shipping" as const, reason: null, stuck_by: null } : {};
        return { ...was, ...own, ...going, told, log };
      });
      changed();
      if (next) void look(next.key);
      return next ? { ship: next } : null;
    },

    /** A window's read saw this pull request: a shipping one whose head or checks moved is read now, not at the tick. */
    saw(pulls: readonly { key: string; head_sha?: string | null; state: string }[]): void {
      for (const pull of pulls) {
        const ship = ships.get(pull.key);
        if (ship && shipActive(ship) && ship.seen && (pull.state !== "open" && pull.state !== "draft" ? true : !!pull.head_sha && pull.head_sha !== ship.seen.head_sha)) void look(ship.key);
      }
    },

    /**
     * A launch moved (started, failed, removed): each new session's ship that has no session yet binds, or reads Stuck
     * at once when its launch failed. One that binds now is read at once, so its waiting notes go out.
     */
    starting(): void {
      for (const ship of ships.all()) if (shipActive(ship) && !ship.bound && settleStart(ship.key)) void look(ship.key);
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
