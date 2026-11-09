/**
 * What a data dir holds as settings, read the way Plannotator reads it: config.json with this computer's state
 * (local-state.json, #2852) laid over it. A test that checks a dialog was marked, or that nothing was written,
 * reads both files through these.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfigAt } from "../../packages/shared/config";

export const savedConfig = (dataDir: string) => loadConfigAt(dataDir, { quiet: true }) as Record<string, any>;

/** The bytes of config.json and local-state.json together ("" for a missing one). */
export const savedFiles = (dataDir: string) =>
  ["config.json", "local-state.json"].map((name) => (existsSync(join(dataDir, name)) ? readFileSync(join(dataDir, name), "utf8") : "")).join("\n--- local-state.json ---\n");
