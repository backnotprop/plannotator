/**
 * One set of Settings → Capabilities switches for all of a person's linked computers (the owner, 2026-11-24: "One
 * set for all: flip a switch once and it applies on every linked computer. The per-computer groups go away", and
 * "latest switch wins if any conflicting"). docs/agent-guides/inbox-machines.md, "One set of capabilities".
 *
 * Each switch keeps its own config.json key as before; besides it this Inbox keeps when the person last flipped it
 * and on which Inbox (config.json `inboxCapabilityFlips`). Its list gives every shared switch to a linked computer
 * (`capability_set`, to a machine's token only, mark `capability-set`), and each Inbox takes a flip it reads there that
 * is newer than its own (`capabilityFlipWins`): a recorded time beats none, then the later time, then the higher Inbox
 * id. Two switches neither side ever flipped since this was kept (first contact, settings from before it) settle on ON,
 * so nothing in use on one computer silently goes away. A computer away gets the flip when it is back, and two that
 * both flipped while apart settle on the newer flip, because each reads the other's list when they meet again.
 *
 * A switch an env var, the build or a test decides here (`shared` false) is neither given nor taken: it stays as that
 * decides, its row locked as before. Taking a flip turns the switch the way the person's row does (every window
 * follows), and posts nothing for the person: the line a turn posts is the computer's where it was turned.
 */
import { INBOX_CAPABILITY_SET_KEYS, type InboxCapabilitySetKey } from "@plannotator/core/inbox-types";

/** The mark a linked computer's list says it keeps the one set with. Without it, a computer keeps its own switches. */
export const CAPABILITY_SET_MARK = "capability-set";

/** One switch as an Inbox gives it: its state, and the person's last flip of it (null: never flipped since this was kept). */
export interface CapabilityFlip {
  on: boolean;
  at: number | null;
  by: string | null;
}

export type CapabilitySet = Partial<Record<InboxCapabilitySetKey, CapabilityFlip>>;
export type CapabilityFlipTimes = Partial<Record<InboxCapabilitySetKey, { at: number; by: string | null }>>;

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
 * Which flip stands, the same answer on either computer: a recorded time beats none; then the later time; then the
 * higher Inbox id; then on. Above 0: `a` stands over `b`.
 */
export function compareCapabilityFlips(a: CapabilityFlip, b: CapabilityFlip): number {
  if ((a.at === null) !== (b.at === null)) return a.at === null ? -1 : 1;
  if (a.at !== null && b.at !== null && a.at !== b.at) return a.at > b.at ? 1 : -1;
  const aBy = a.by ?? "";
  const bBy = b.by ?? "";
  if (aBy !== bBy) return aBy > bBy ? 1 : -1;
  return a.on === b.on ? 0 : a.on ? 1 : -1;
}

/** A linked computer's flip is taken here only when it stands over this one's. */
export const capabilityFlipWins = (far: CapabilityFlip, here: CapabilityFlip): boolean => compareCapabilityFlips(far, here) > 0;

/** One switch as this Inbox keeps it. */
export interface CapabilitySetSwitch {
  /** Its state now. */
  on: () => boolean;
  /** Offered here and decided by the person (no env var, build or test decides it): only then given and taken. */
  shared: () => boolean;
  /** Turns it as the person's row does (every window follows); a save that fails throws. */
  apply: (on: boolean) => unknown;
}

export interface CapabilitySetHost {
  switches: Record<InboxCapabilitySetKey, CapabilitySetSwitch>;
  /** config.json `inboxCapabilityFlips` as it is now. */
  times: () => unknown;
  saveTimes: (times: CapabilityFlipTimes) => void;
  /** This Inbox's id (`ibx_…`), or null. */
  self: () => string | null;
  now?: () => number;
}

/** The set switches a settings save names: its switch keys, and `experimental`'s. */
export function capabilitySetKeysIn(body: Record<string, unknown>): InboxCapabilitySetKey[] {
  const experimental = plain(body.experimental) ? body.experimental : {};
  return INBOX_CAPABILITY_SET_KEYS.filter((key) => (key === "decision_mode" || key === "grid" ? experimental[key] !== undefined : body[key] !== undefined));
}

export function createCapabilitySet(host: CapabilitySetHost) {
  const listeners = new Set<() => void>();
  const now = host.now ?? Date.now;
  const times = () => readCapabilityFlipTimes(host.times());
  const flipOf = (key: InboxCapabilitySetKey, held: CapabilityFlipTimes): CapabilityFlip => ({ on: host.switches[key].on(), at: held[key]?.at ?? null, by: held[key]?.by ?? null });
  const tell = () => {
    for (const listener of listeners) listener();
  };
  // One take at a time, so two lists read at once never turn a switch twice.
  let taking: Promise<unknown> = Promise.resolve();
  return {
    /** What this Inbox gives its linked computers: every switch it shares, with the person's last flip. */
    wire(): CapabilitySet {
      const held = times();
      const out: CapabilitySet = {};
      for (const key of INBOX_CAPABILITY_SET_KEYS) if (host.switches[key].shared()) out[key] = flipOf(key, held);
      return out;
    },
    /**
     * The person flipped these here (a Settings row, an agent's `plannotator inbox capability`, an older linked
     * computer's group): each is stamped now, and past the flip this Inbox holds, so it stands over every flip known here.
     */
    flipped(keys: readonly InboxCapabilitySetKey[]): void {
      const shared = keys.filter((key) => host.switches[key].shared());
      if (shared.length === 0) return;
      const held = times();
      const at = now();
      const by = idOf(host.self());
      for (const key of shared) held[key] = { at: Math.max(at, (held[key]?.at ?? -1) + 1), by };
      host.saveTimes(held);
      tell();
    },
    /** A linked computer's set: each flip newer than this one's is taken. Resolves to the switches it turned. */
    take(far: CapabilitySet): Promise<InboxCapabilitySetKey[]> {
      const run = taking.then(async () => {
        const held = times();
        const turned: InboxCapabilitySetKey[] = [];
        let stamped = false;
        for (const key of INBOX_CAPABILITY_SET_KEYS) {
          const flip = far[key];
          const one = host.switches[key];
          if (!flip || !one.shared()) continue;
          const here = flipOf(key, held);
          if (!capabilityFlipWins(flip, here)) continue;
          if (flip.on !== here.on) {
            try {
              await one.apply(flip.on);
            } catch {
              // Not saved here (config.json unwritable): this switch stays as it is until the next read.
              continue;
            }
            if (one.on() !== flip.on) continue;
            turned.push(key);
          }
          // A first contact's ON is taken with no time: neither side flipped it yet.
          if (flip.at !== null) {
            held[key] = { at: flip.at, by: flip.by };
            stamped = true;
          }
        }
        if (stamped) host.saveTimes(held);
        // The other linked computers read this list again, so a flip goes on to a third one.
        if (turned.length > 0) tell();
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
