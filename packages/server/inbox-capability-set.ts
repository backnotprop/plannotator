/**
 * One set of Settings → Capabilities switches for all of a person's linked computers (the owner, 2026-11-24: "One
 * set for all: flip a switch once and it applies on every linked computer. The per-computer groups go away", and
 * "latest switch wins if any conflicting"). docs/agent-guides/inbox-machines.md, "One set of capabilities".
 *
 * Each switch keeps its own config.json key as before; besides it this Inbox keeps when the person last flipped it
 * and on which Inbox (config.json `inboxCapabilityFlips`). Its list gives every shared switch to a linked computer
 * (`capability_set`, to a machine's token only, mark `capability-set`), and each Inbox takes a flip it reads there that
 * is newer than its own (`capabilityFlipWins`): the later time, then the higher Inbox id, then on. A switch whose own
 * key is set but has no recorded flip (the person chose it before this was kept) counts as a flip at time 0, and one
 * at its untouched default as never flipped, so a choice always beats a default, either way; two choices with no
 * recorded time settle on ON, so nothing in use on one computer silently goes away. A switch at its untouched default
 * is never taken from a linked computer. A time more than a day past the reading computer's clock is not trusted there
 * and counts as a choice at 0 (`CAPABILITY_FLIP_AHEAD_MS`). A computer away gets the flip
 * when it is back, and two that both flipped while apart settle on the newer flip, because each reads the other's
 * list when they meet again.
 *
 * A switch an env var, the build or a test decides here (`shared` false) is neither given nor taken: it stays as that
 * decides, its row locked as before. Taking a flip turns the switch the way the person's row does (every window
 * follows), and posts nothing for the person: the line a turn posts is the computer's where it was turned.
 */
import { INBOX_CAPABILITY_SET_KEYS, type InboxCapabilitySetKey } from "@plannotator/core/inbox-types";

/** The mark a linked computer's list says it keeps the one set with. Without it, a computer keeps its own switches. */
export const CAPABILITY_SET_MARK = "capability-set";

/**
 * One switch as an Inbox gives it: its state, and the person's last flip of it. `at` 0: chosen before flips were kept
 * (its key is set, no time recorded); null: at its untouched default, never flipped.
 */
export interface CapabilityFlip {
  on: boolean;
  at: number | null;
  by: string | null;
}

export type CapabilitySet = Partial<Record<InboxCapabilitySetKey, CapabilityFlip>>;
export type CapabilityFlipTimes = Partial<Record<InboxCapabilitySetKey, { at: number; by: string | null }>>;

/**
 * How far past the reading computer's clock a flip's time is trusted. A time further ahead (a linked computer's clock
 * far ahead, or a bad list) is not trusted: it counts as a choice at time 0, the same rule on every side, for a far
 * flip and for a time kept here. The time itself is stored and given on as it came.
 */
export const CAPABILITY_FLIP_AHEAD_MS = 24 * 60 * 60 * 1000;

const INBOX_ID = /^ibx_[0-9A-HJKMNP-TV-Z]{26}$/;
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const idOf = (value: unknown): string | null => (typeof value === "string" && INBOX_ID.test(value) ? value : null);
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** config.json `inboxCapabilityFlips`, picked by name: an entry that does not read as one is no flip. */
export function readCapabilityFlipTimes(value: unknown): CapabilityFlipTimes {
  const out: CapabilityFlipTimes = {};
  if (!plain(value)) return out;
  for (const key of INBOX_CAPABILITY_SET_KEYS) {
    const entry = value[key];
    if (plain(entry) && isTime(entry.at)) out[key] = { at: entry.at, by: idOf(entry.by) };
  }
  return out;
}

/** A linked computer's `capability_set`, picked by name; null from an Inbox without it, or anything unreadable. */
export function readCapabilitySet(value: unknown): CapabilitySet | null {
  if (!plain(value)) return null;
  const out: CapabilitySet = {};
  for (const key of INBOX_CAPABILITY_SET_KEYS) {
    const entry = value[key];
    if (!plain(entry) || typeof entry.on !== "boolean") continue;
    const at = isTime(entry.at) ? entry.at : null;
    out[key] = { on: entry.on, at, by: at === null ? null : idOf(entry.by) };
  }
  return out;
}

/**
 * Which flip stands, the same answer on either computer: a flip beats never flipped; then the later time (a recorded
 * time beats a choice at 0); then the higher Inbox id; then on. Above 0: `a` stands over `b`.
 */
export function compareCapabilityFlips(a: CapabilityFlip, b: CapabilityFlip): number {
  if ((a.at === null) !== (b.at === null)) return a.at === null ? -1 : 1;
  if (a.at !== null && b.at !== null && a.at !== b.at) return a.at > b.at ? 1 : -1;
  const aBy = a.by ?? "";
  const bBy = b.by ?? "";
  if (aBy !== bBy) return aBy > bBy ? 1 : -1;
  return a.on === b.on ? 0 : a.on ? 1 : -1;
}

/**
 * A linked computer's flip is taken here only when it stands over this one's. One at its untouched default there (no
 * time) is never taken: nobody flipped it, so it never turns, or records a choice on, this computer.
 */
export const capabilityFlipWins = (far: CapabilityFlip, here: CapabilityFlip): boolean => far.at !== null && compareCapabilityFlips(far, here) > 0;

/** One switch as this Inbox keeps it. */
export interface CapabilitySetSwitch {
  /** Its state now. */
  on: () => boolean;
  /** Its own config.json key is set (the person chose it, perhaps before flips were kept); false at its untouched default. */
  chosen: () => boolean;
  /** Offered here and decided by the person (no env var, build or test decides it): only then given and taken. */
  shared: () => boolean;
  /** Turns it as the person's row does (every window follows); a save that fails throws. */
  apply: (on: boolean) => unknown;
}

export interface CapabilitySetHost {
  switches: Record<InboxCapabilitySetKey, CapabilitySetSwitch>;
  /** config.json `inboxCapabilityFlips` as it is now. */
  times: () => unknown;
  /** Merges these entries into `inboxCapabilityFlips`, key by key under the config lock: the others are kept. */
  saveTimes: (times: CapabilityFlipTimes) => void;
  /** This Inbox's id (`ibx_…`), or null. */
  self: () => string | null;
  now?: () => number;
}

/**
 * The set switches a settings save names: its switch keys, and `experimental`'s. Decision mode has its own key
 * (`decision_mode`, its Capabilities row) and its old place (`experimental.decision_mode`, an older window's switch).
 */
export function capabilitySetKeysIn(body: Record<string, unknown>): InboxCapabilitySetKey[] {
  const experimental = plain(body.experimental) ? body.experimental : {};
  return INBOX_CAPABILITY_SET_KEYS.filter((key) =>
    key === "grid" ? experimental[key] !== undefined : key === "decision_mode" ? body[key] !== undefined || experimental[key] !== undefined : body[key] !== undefined,
  );
}

export function createCapabilitySet(host: CapabilitySetHost) {
  const listeners = new Set<() => void>();
  const now = host.now ?? Date.now;
  /** A flip as this computer compares it: a time more than a day past this clock is not trusted and counts as 0. */
  const trusted = (flip: CapabilityFlip): CapabilityFlip => (flip.at !== null && flip.at > now() + CAPABILITY_FLIP_AHEAD_MS ? { ...flip, at: 0 } : flip);
  const times = (): CapabilityFlipTimes => readCapabilityFlipTimes(host.times());
  /** This switch as given, from the flip times read now: a time recorded (as it came), else 0 when its key is set, else never. */
  const flipOf = (key: InboxCapabilitySetKey): CapabilityFlip => {
    const kept = times()[key];
    const one = host.switches[key];
    if (kept) return { on: one.on(), at: kept.at, by: kept.by };
    return { on: one.on(), at: one.chosen() ? 0 : null, by: null };
  };
  /** The flip this computer holds, as it compares it. */
  const held = (key: InboxCapabilitySetKey): CapabilityFlip => trusted(flipOf(key));
  const tell = () => {
    for (const listener of listeners) listener();
  };
  // One take at a time, so two lists read at once never turn a switch twice.
  let taking: Promise<unknown> = Promise.resolve();
  return {
    /** What this Inbox gives its linked computers: every switch it shares, with the person's last flip. */
    wire(): CapabilitySet {
      const out: CapabilitySet = {};
      for (const key of INBOX_CAPABILITY_SET_KEYS) if (host.switches[key].shared()) out[key] = flipOf(key);
      return out;
    },
    /**
     * The person flipped these here (a Settings row, an agent's `plannotator inbox capability`, an older linked
     * computer's group): each is stamped now, and past the flip this Inbox holds, so it stands over every flip known here.
     */
    flipped(keys: readonly InboxCapabilitySetKey[]): void {
      const shared = keys.filter((key) => host.switches[key].shared());
      if (shared.length === 0) return;
      const at = now();
      const by = idOf(host.self());
      const stamped: CapabilityFlipTimes = {};
      // Past the flip held as this computer compares it (one not trusted counts as 0, so its far time is never carried
      // into this stamp), and always a safe integer, so it is never read back as no flip.
      for (const key of shared) stamped[key] = { at: Math.min(Math.max(at, (held(key).at ?? -1) + 1), Number.MAX_SAFE_INTEGER), by };
      host.saveTimes(stamped);
      tell();
    },
    /** A linked computer's set: each flip newer than this one's is taken. Resolves to the switches it turned. */
    take(far: CapabilitySet): Promise<InboxCapabilitySetKey[]> {
      const run = taking.then(async () => {
        const turned: InboxCapabilitySetKey[] = [];
        let stored = false;
        for (const key of INBOX_CAPABILITY_SET_KEYS) {
          const given = far[key];
          const one = host.switches[key];
          // At its untouched default there: nothing to take, and nothing written here.
          if (!given || given.at === null || !one.shared()) continue;
          const flip = trusted(given);
          // Read again for each switch: the person may have flipped one here while an earlier one waited.
          if (!capabilityFlipWins(flip, held(key))) continue;
          if (flip.on !== one.on()) {
            try {
              await one.apply(flip.on);
            } catch {
              // Not saved here (config.json unwritable): this switch stays as it is until the next read.
              continue;
            }
            if (one.on() !== flip.on) continue;
            turned.push(key);
            // Flipped here while that waited: the person's flip stands, with its own time.
            if (!capabilityFlipWins(flip, held(key))) continue;
          }
          // Stored as it came, so every computer it goes on to compares the same time by its own clock.
          host.saveTimes({ [key]: { at: given.at, by: given.by } });
          stored = true;
        }
        // The other linked computers read this list again, so a flip, or only its time, goes on to a third one.
        if (turned.length > 0 || stored) tell();
        return turned;
      });
      taking = run.catch(() => {});
      return run;
    },
    /** Told when a flip is made or taken here (the event a linked computer asks for, `capability-set=1`). */
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type InboxCapabilitySet = ReturnType<typeof createCapabilitySet>;
