/**
 * System's per-project setup file on disk (the contract: packages/core/inbox-system-setup.ts).
 *
 *   <data dir>/system/<project key>/setup.json   0600 in a 0700 folder, written whole (temp, then rename)
 *
 * The data dir is always passed in: nothing here reads ~/.plannotator on its own.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseSystemSetup, type SystemSetup } from "@plannotator/core/inbox-system-setup";

export const SYSTEM_DIR = "system";

/** A project's folder under `<data dir>/system/`; the key is `InboxProject.key`. */
export function systemProjectDir(dataDir: string, key: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(key) || key === "." || key === "..") throw new Error(`Not a project key: ${key}`);
  return join(dataDir, SYSTEM_DIR, key);
}

export function systemSetupPath(dataDir: string, key: string): string {
  return join(systemProjectDir(dataDir, key), "setup.json");
}

/** The project's setup, or null when there is none (or it is not a format 1 setup, which the next save replaces). */
export function readSystemSetup(dataDir: string, key: string): SystemSetup | null {
  try {
    return parseSystemSetup(JSON.parse(readFileSync(systemSetupPath(dataDir, key), "utf8")));
  } catch {
    return null;
  }
}

export function writeSystemSetup(dataDir: string, key: string, setup: SystemSetup): SystemSetup {
  const dir = systemProjectDir(dataDir, key);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700); // `mode` applies only on create.
  const path = join(dir, "setup.json");
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(setup, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return setup;
}
