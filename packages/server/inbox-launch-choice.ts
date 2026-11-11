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

/**
 * A host's lists, read from its CLI once per `key` (the CLI's path and version): compose reads them every few seconds,
 * and a help read costs a process. One read at a time; a failed read is tried again on the next ask.
 */
export function launchChoiceCache(load: () => Promise<LaunchChoiceLists | null>) {
  let kept: { key: string; value: LaunchChoiceLists } | null = null;
  let reading: { key: string; answer: Promise<LaunchChoiceLists | null> } | null = null;
  const read = (key: string | null): Promise<LaunchChoiceLists | null> => {
    if (key === null) return Promise.resolve(null);
    if (kept?.key === key) return Promise.resolve(kept.value);
    if (reading?.key === key) return reading.answer;
    const answer = load()
      .then((value) => {
        if (value) kept = { key, value };
        return value;
      })
      .catch(() => null)
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
