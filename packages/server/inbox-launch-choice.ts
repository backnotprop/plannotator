import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxLaunchTokenOk, type InboxLaunchChoice, type InboxLaunchChoices } from "@plannotator/core/inbox-launch-choice";

const lastChoiceFile = (dataDir: string) => join(dataDir, "inbox", "launch", "last-choice.json");

/** Only plain tokens survive a read: the file may have been edited by hand. */
function cleanChoice(value: unknown): InboxLaunchChoice {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    ...(inboxLaunchTokenOk(raw.model) ? { model: raw.model } : {}),
    ...(inboxLaunchTokenOk(raw.effort) ? { effort: raw.effort } : {}),
    ...(inboxLaunchTokenOk(raw.primary_agent) ? { primary_agent: raw.primary_agent } : {}),
  };
}

function readAll(dataDir: string): Record<string, InboxLaunchChoice> {
  try {
    const parsed = JSON.parse(readFileSync(lastChoiceFile(dataDir), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).map(([agent, choice]) => [agent, cleanChoice(choice)]));
  } catch {
    return {};
  }
}

export function readLastLaunchChoice(dataDir: string, agent: string): InboxLaunchChoice {
  return readAll(dataDir)[agent] ?? {};
}

export function writeLastLaunchChoice(dataDir: string, agent: string, choice: InboxLaunchChoice): void {
  const all = { ...readAll(dataDir), [agent]: cleanChoice(choice) };
  const dir = join(dataDir, "inbox", "launch");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = lastChoiceFile(dataDir);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(all)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

export type LaunchChoiceLists = Omit<InboxLaunchChoices, "last">;

/** The lists are a nicety: an offer or a Send never waits on them longer than this. */
export const LAUNCH_CHOICES_WAIT_MS = 250;
export const LAUNCH_CHOICES_RUN_MS = 5_000;
/** Compose reads every few seconds; a CLI that can't list them is not asked again for this long. */
const FAILED_AGAIN_MS = 5 * 60_000;

/** `whileLate`: the answer when `answer` has not settled within `ms` (OpenCode's "being read" lists); null by default. */
export function withinLaunchWait<T>(answer: Promise<T | null>, ms = LAUNCH_CHOICES_WAIT_MS, whileLate: T | null = null): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T | null>((resolve) => {
    timer = setTimeout(() => resolve(whileLate), ms);
  });
  return Promise.race([answer.catch(() => null), late]).finally(() => clearTimeout(timer));
}

/** How many keys the cache remembers (lists and failures): a few config edits, never a growing map. */
const CHOICE_KEYS_KEPT = 16;

/** `map.set` that keeps `key` newest and drops the oldest past `CHOICE_KEYS_KEPT`. */
function setNewest<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > CHOICE_KEYS_KEPT) map.delete(map.keys().next().value!);
}

/**
 * `key` is the CLI's path and version (OpenCode adds its config and sign-in files' modification times): a help read
 * costs a process, and compose asks every few seconds. Per key: its lists once read, its failures, and at most one
 * read in flight, so keys that alternate keep each one's lists and wait.
 *
 * A key whose read failed is not read again for `failedAgainMs`, doubled after each failure in a row up to
 * `failedAgainMaxMs` (default: no doubling); a success starts over. A read fails with null, or with lists that say why
 * (`unread`, OpenCode): those are answered for that key until it is read again, so the menu says why meanwhile.
 *
 * `binaryOf` (opt-in, OpenCode): the part of a key that names the binary (path and version). With it, a new key of
 * the SAME binary answers the last good lists at once while it reads (in the background) and after its read failed,
 * so a config change never hides the menu or drops a pick. A new binary never gets an old binary's lists: it waits for
 * its own read, and a read that fails leaves no lists but its failure (Default only), as without `binaryOf`. With a
 * stale good list answered, its failure is not: the list shows as it was.
 */
export function launchChoiceCache(
  load: () => Promise<LaunchChoiceLists | null>,
  now: () => number = Date.now,
  options: { failedAgainMs?: number; failedAgainMaxMs?: number; binaryOf?: (key: string) => string } = {},
) {
  const failedAgainMs = options.failedAgainMs ?? FAILED_AGAIN_MS;
  const failedAgainMaxMs = Math.max(failedAgainMs, options.failedAgainMaxMs ?? failedAgainMs);
  const kept = new Map<string, LaunchChoiceLists>();
  const failed = new Map<string, { at: number; times: number; why: LaunchChoiceLists | null }>();
  const reading = new Map<string, Promise<LaunchChoiceLists | null>>();
  /** The key of the last read that succeeded, for `binaryOf`'s stale lists. */
  let lastGood: string | null = null;
  const staleFor = (key: string): Promise<LaunchChoiceLists | null> | null => {
    if (!options.binaryOf || lastGood === null || options.binaryOf(lastGood) !== options.binaryOf(key)) return null;
    const value = kept.get(lastGood);
    return value ? Promise.resolve(value) : null;
  };
  const read = (key: string | null): Promise<LaunchChoiceLists | null> => {
    if (key === null) return Promise.resolve(null);
    const value = kept.get(key);
    if (value) return Promise.resolve(value);
    const stale = staleFor(key);
    const failure = failed.get(key);
    if (failure && now() - failure.at < Math.min(failedAgainMaxMs, failedAgainMs * 2 ** (failure.times - 1))) return stale ?? Promise.resolve(failure.why);
    const under = reading.get(key);
    if (under) return stale ?? under;
    const answer = load()
      .catch(() => null)
      .then((lists) => {
        if (lists && !lists.unread) {
          setNewest(kept, key, lists);
          failed.delete(key);
          lastGood = key;
        } else {
          setNewest(failed, key, { at: now(), times: (failed.get(key)?.times ?? 0) + 1, why: lists });
        }
        return lists;
      })
      .finally(() => reading.delete(key));
    reading.set(key, answer);
    return stale ?? answer;
  };
  return read;
}
