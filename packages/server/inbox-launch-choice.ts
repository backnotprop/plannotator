import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxLaunchTokenOk, type InboxLaunchChoice, type InboxLaunchChoices } from "@plannotator/core/inbox-launch-choice";

const lastChoiceFile = (dataDir: string) => join(dataDir, "inbox", "launch", "last-choice.json");

/** Only plain tokens survive a read: the file may have been edited by hand. */
function cleanChoice(value: unknown): InboxLaunchChoice {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return { ...(inboxLaunchTokenOk(raw.model) ? { model: raw.model } : {}), ...(inboxLaunchTokenOk(raw.effort) ? { effort: raw.effort } : {}) };
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

export function withinLaunchWait<T>(answer: Promise<T | null>, ms = LAUNCH_CHOICES_WAIT_MS): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([answer.catch(() => null), late]).finally(() => clearTimeout(timer));
}

/** `key` is the CLI's path and version: a help read costs a process, and compose asks every few seconds. */
export function launchChoiceCache(load: () => Promise<LaunchChoiceLists | null>, now: () => number = Date.now) {
  let kept: { key: string; value: LaunchChoiceLists } | null = null;
  let failed: { key: string; at: number } | null = null;
  let reading: { key: string; answer: Promise<LaunchChoiceLists | null> } | null = null;
  const read = (key: string | null): Promise<LaunchChoiceLists | null> => {
    if (key === null) return Promise.resolve(null);
    if (kept?.key === key) return Promise.resolve(kept.value);
    if (failed?.key === key && now() - failed.at < FAILED_AGAIN_MS) return Promise.resolve(null);
    if (reading?.key === key) return reading.answer;
    const answer = load()
      .catch(() => null)
      .then((value) => {
        if (value) kept = { key, value };
        else failed = { key, at: now() };
        return value;
      })
      .finally(() => {
        if (reading?.answer === answer) reading = null;
      });
    reading = { key, answer };
    return answer;
  };
  return read;
}
