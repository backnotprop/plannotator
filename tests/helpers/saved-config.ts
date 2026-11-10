/**
 * What a data dir holds as settings, read the way Plannotator reads it: config.json with this computer's state
 * (local-state.json, #2852) laid over it. A test that checks a dialog was marked, or that nothing was written,
 * reads both files through these.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_STATE_KEYS, loadConfigAt } from "../../packages/shared/config";

export const savedConfig = (dataDir: string) => loadConfigAt(dataDir, { quiet: true }) as Record<string, any>;

/** The bytes of config.json and local-state.json together ("" for a missing one). */
export const savedFiles = (dataDir: string) =>
  ["config.json", "local-state.json"].map((name) => (existsSync(join(dataDir, name)) ? readFileSync(join(dataDir, name), "utf8") : "")).join("\n--- local-state.json ---\n");

/**
 * Write config.json whole, as a test seeding an older Inbox's config does. Once local-state.json exists the Inbox
 * reads its state keys from there only, so they are written there too (and the file replaced, as config.json is).
 */
export function writeSavedConfig(dataDir: string, config: Record<string, unknown>): void {
  writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  const statePath = join(dataDir, "local-state.json");
  if (!existsSync(statePath)) return;
  const state: Record<string, unknown> = {};
  for (const key of LOCAL_STATE_KEYS) if (config[key] !== undefined) state[key] = config[key];
  const sound = config.inboxSound as Record<string, unknown> | undefined;
  if (sound && typeof sound === "object") {
    const marks = Object.fromEntries(Object.entries(sound).filter(([field]) => field === "dialogDueFor" || field === "dialogShownFor"));
    if (Object.keys(marks).length > 0) state.inboxSound = marks;
  }
  writeFileSync(statePath, JSON.stringify(state));
}
