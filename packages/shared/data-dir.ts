/**
 * Plannotator Data Directory
 *
 * Returns the base directory for all Plannotator data files.
 *
 * Priority:
 *   1.  PLANNOTATOR_DATA_DIR environment variable (with ~ expansion)
 *   2.  Default: ~/.plannotator
 *
 * This mirrors PASTE_DATA_DIR for the paste service and allows users
 * to relocate all data (plans, history, drafts, config, hooks, sessions,
 * debug logs, IPC registry, etc.) via a single variable — useful for
 * XDG-style home directory cleanliness on Unix systems.
 */

import { homedir } from "os";
import { join, resolve } from "path";

/**
 * Resolve the Plannotator data directory.
 *
 * If PLANNOTATOR_DATA_DIR is set and non-empty, the value is used
 * as the base directory. Leading ~ is expanded to the user's home
 * directory.
 *
 * Falls back to ~/.plannotator when the env var is absent or empty.
 */
export function getPlannotatorDataDir(): string {
  const envDir = process.env.PLANNOTATOR_DATA_DIR?.trim();
  if (!envDir) {
    return join(homedir(), ".plannotator");
  }

  // Expand ~ to home directory
  const home = homedir();
  if (envDir === "~") return home;
  if (envDir.startsWith("~/") || envDir.startsWith("~\\")) {
    return join(home, envDir.slice(2));
  }

  return resolve(envDir);
}
