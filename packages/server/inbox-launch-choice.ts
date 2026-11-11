/**
 * Model and effort at launch, the server's part (docs/agent-guides/inbox-launch.md "Model and effort"): the last
 * choice sent to each agent on this machine, which compose's menu starts on, and a CLI help read kept per version.
 * The values, their check and the arguments they become are packages/core/inbox-launch-choice.ts.
 */

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

/** The last choice a Send made for `agent` here; `{}` when it was the default, or none was ever made. */
export function readLastLaunchChoice(dataDir: string, agent: string): InboxLaunchChoice {
  return readAll(dataDir)[agent] ?? {};
}

/** A Send's choice for `agent` (the default too, as `{}`), so the next New message starts on it. Atomic. */
export function writeLastLaunchChoice(dataDir: string, agent: string, choice: InboxLaunchChoice): void {
  const all = { ...readAll(dataDir), [agent]: cleanChoice(choice) };
  const dir = join(dataDir, "inbox", "launch");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = lastChoiceFile(dataDir);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(all)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

export type LaunchChoiceLists = Omit<InboxLaunchChoices, "default" | "last">;

/** How long a launch offer (compose's read, a Send) waits on a host's lists before going on without them. */
export const LAUNCH_CHOICES_WAIT_MS = 250;
/** How long one help or model-list call may run before it is killed (the run's own deadline). */
export const LAUNCH_CHOICES_RUN_MS = 5_000;
/** A CLI that could not list them is not asked again for this long (a compose read comes every few seconds). */
const FAILED_AGAIN_MS = 5 * 60_000;

/** `answer`, or null once `ms` passed: the lists are a nicety, never what an offer waits for. The read itself goes on. */
export function withinLaunchWait<T>(answer: Promise<T | null>, ms = LAUNCH_CHOICES_WAIT_MS): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([answer.catch(() => null), late]).finally(() => clearTimeout(timer));
}

/**
 * A host's lists, read from its CLI once per `key` (the CLI's path and version): compose reads them every few seconds,
 * and a help read costs a process. One read at a time; a failed read is not tried again for a while.
 */
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
  /** What was read last, without reading (Settings → Agents' menus, drawn at once): null before any read. */
  read.kept = (): LaunchChoiceLists | null => kept?.value ?? null;
  return read;
}
