/**
 * The list's "Show archived" switch (approval "inbox-archived-group"; the ⋮ menu's View group): one preference for the
 * person, the same on every linked machine and in every window. Each Inbox keeps its copy in config.json
 * (`inboxShowArchived`); a save carries a revision one past the newest this Inbox knows of on any machine, and every
 * Inbox takes a newer one it reads in a linked machine's list (`show_archived`, sent to a machine only). Ties go to the
 * higher machine id, so two machines that saved at once settle on the same answer.
 */

export interface InboxShowArchived {
  on: boolean;
  rev: number;
  /** The machine whose save this is (`ibx_…`), or null for an Inbox that cannot link. */
  by: string | null;
}

export const SHOW_ARCHIVED_OFF: InboxShowArchived = { on: false, rev: 0, by: null };
/** The highest revision kept: no person flips the switch this often, and a save past a far copy above it stays here. */
export const SHOW_ARCHIVED_REV_MAX = 2 ** 31;

/** A saved or far copy, picked by name; anything else (a revision past the highest too) reads as never saved. */
export function readShowArchived(value: unknown): InboxShowArchived {
  if (!value || typeof value !== "object" || Array.isArray(value)) return SHOW_ARCHIVED_OFF;
  const v = value as Record<string, unknown>;
  if (typeof v.on !== "boolean" || typeof v.rev !== "number" || !Number.isInteger(v.rev) || v.rev < 0 || v.rev > SHOW_ARCHIVED_REV_MAX) return SHOW_ARCHIVED_OFF;
  return { on: v.on, rev: v.rev, by: typeof v.by === "string" && /^ibx_[0-9A-HJKMNP-TV-Z]{26}$/.test(v.by) ? v.by : null };
}

/** `next` wins over `held`: a higher revision, or the same one saved by the higher machine id. */
export function showArchivedNewer(next: InboxShowArchived, held: InboxShowArchived): boolean {
  if (next.rev !== held.rev) return next.rev > held.rev;
  return (next.by ?? "") > (held.by ?? "") && next.on !== held.on;
}

export interface ShowArchivedHost {
  load: () => unknown;
  /** Writes config.json; false when it could not. */
  save: (value: InboxShowArchived) => boolean;
  self: () => string | null;
  /** Every linked machine's copy this Inbox has read. */
  far: () => readonly InboxShowArchived[];
}

export function createShowArchived(host: ShowArchivedHost) {
  const listeners = new Set<(value: InboxShowArchived) => void>();
  const state = (): InboxShowArchived => readShowArchived(host.load());
  const write = (value: InboxShowArchived): InboxShowArchived => {
    if (!host.save(value) || state().rev !== value.rev) {
      throw Object.assign(new Error("config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it."), { code: "config_not_saved" });
    }
    for (const listener of listeners) listener(value);
    return value;
  };
  return {
    state,
    /** The person's switch: saved here past every revision any machine holds; the linked machines read it from this list. */
    set(on: boolean): InboxShowArchived {
      const rev = Math.min(SHOW_ARCHIVED_REV_MAX, Math.max(state().rev, ...host.far().map((far) => far.rev)) + 1);
      return write({ on, rev, by: host.self() });
    },
    /** A linked machine's copy: taken when it is newer than this one. */
    adopt(far: InboxShowArchived): boolean {
      if (!showArchivedNewer(far, state())) return false;
      write(far);
      return true;
    },
    subscribe(listener: (value: InboxShowArchived) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type ShowArchivedPref = ReturnType<typeof createShowArchived>;
