import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What a data dir holds on disk, as loadConfig reads it: config.json's settings with state.json's machine state
 * (#2852; MACHINE_STATE_KEYS in packages/shared/config.ts). For tests that check a record the server
 * wrote, such as a one-time dialog's claim, without starting a second reader. A missing file reads as `{}`.
 */
export function savedConfig(dataDir: string): Record<string, any> {
  const read = (name: string) => {
    try {
      return JSON.parse(readFileSync(join(dataDir, name), "utf8")) ?? {};
    } catch {
      return {};
    }
  };
  const config = read("config.json");
  const state = read("state.json");
  // The server saves each record from loadConfig's merged view, so once state.json holds a record it is the merged
  // one: state.json's copy stands in for loadConfig's field-by-field merge (mergeMachineRecord), which config.test.ts
  // proves. The sound: config.json's settings with state.json's dialog fields.
  const merged = { ...config, ...state };
  if (state.inboxSound) {
    const { dialogDueFor: _due, dialogShownFor: _shown, ...settings } = config.inboxSound ?? {};
    merged.inboxSound = { ...settings, ...state.inboxSound };
  }
  return merged;
}

/**
 * Writes config.json as an older Plannotator left it, mid-test: these keys in config.json and none of them in
 * state.json (which would win over them), the rest of state.json kept.
 */
export function writeOldConfig(dataDir: string, config: Record<string, unknown>): void {
  writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(readFileSync(join(dataDir, "state.json"), "utf8"));
  } catch {
    return;
  }
  for (const key of Object.keys(config)) delete state[key];
  writeFileSync(join(dataDir, "state.json"), JSON.stringify(state));
}

/** Both files' bytes, for a test that proves a request wrote nothing to either. */
export function savedBytes(dataDir: string): string {
  const read = (name: string) => {
    try {
      return readFileSync(join(dataDir, name), "utf8");
    } catch {
      return "";
    }
  };
  return `${read("config.json")}\n--- state.json ---\n${read("state.json")}`;
}
