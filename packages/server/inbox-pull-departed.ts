/**
 * A PR that left the list stays readable (the owner, 2026-11-23: "if I ever create a thread for any PR … it should
 * never disappear on me"). A list read that no longer names a PR (someone else merged or closed it, a search stopped
 * returning it) moves it here, so a page of it that is open in the window still reads its diff, details and files.
 * It is never listed again: only those reads take it (`InboxPulls` `readable`).
 *
 * Bounds: at most `INBOX_PULLS_DEPARTED_MAX` PRs, each for `INBOX_PULLS_DEPARTED_MS` from when it left; a PR listed
 * again leaves this map. Never kept: a PR of a host the next list did not ask (no CLI here signed in to it any more),
 * or one the person hid (`hidden`, asked at each read; a hidden repository counts). The repository rule (a project
 * removed) is the caller's, as for a listed PR.
 */
import type { InboxPull } from "@plannotator/core/inbox-types";

export const INBOX_PULLS_DEPARTED_MAX = 50;
export const INBOX_PULLS_DEPARTED_MS = 12 * 60 * 60_000;

export interface DepartedPulls {
  /** A list read replaced `before` with `after`, having asked `asked` (lowercased hosts). */
  note(before: ReadonlyMap<string, InboxPull>, after: ReadonlyMap<string, InboxPull>, asked: ReadonlySet<string>): void;
  get(key: string): InboxPull | undefined;
  size(): number;
}

export function createDepartedPulls(options: { now: () => number; hidden?: (key: string) => boolean }): DepartedPulls {
  const kept = new Map<string, { pull: InboxPull; at: number }>();
  return {
    note(before, after, asked) {
      const at = options.now();
      for (const key of after.keys()) kept.delete(key);
      for (const [key, pull] of before) {
        if (after.has(key) || !asked.has(pull.host.toLowerCase())) continue;
        // Newest last: the bound drops the oldest first.
        kept.delete(key);
        kept.set(key, { pull, at });
      }
      for (const [key, entry] of kept) if (!asked.has(entry.pull.host.toLowerCase())) kept.delete(key);
      while (kept.size > INBOX_PULLS_DEPARTED_MAX) kept.delete(kept.keys().next().value!);
    },
    get(key) {
      const entry = kept.get(key);
      if (!entry) return undefined;
      if (options.now() - entry.at > INBOX_PULLS_DEPARTED_MS || options.hidden?.(key)) {
        kept.delete(key);
        return undefined;
      }
      return entry.pull;
    },
    size: () => kept.size,
  };
}
