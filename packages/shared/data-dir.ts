/**
 * Plannotator Data Directory
 *
 * Returns the base directory for all Plannotator data files.
 *
 * Priority:
 *   1.  PLANNOTATOR_DATA_DIR environment variable (with ~ expansion)
 *   2.  ~/.plannotator when it already exists (legacy default)
 *   3.  $XDG_DATA_HOME/plannotator when XDG_DATA_HOME is a non-empty
 *       absolute path
 *   4.  Default: ~/.plannotator
 *
 * This mirrors PASTE_DATA_DIR for the paste service and allows users
 * to relocate all data (plans, history, drafts, config, hooks, sessions,
 * debug logs, IPC registry, etc.) via a single variable — useful for
 * XDG-style home directory cleanliness on Unix systems.
 *
 * The XDG fallback follows git's legacy-first pattern: an existing
 * ~/.plannotator always wins, so current installs never move. Only when
 * the legacy directory is absent AND XDG_DATA_HOME is explicitly set does
 * the XDG location apply. Deliberately NOT implemented: the spec's
 * implicit ~/.local/share default (defaults stay unchanged when
 * XDG_DATA_HOME is unset) and any config/data/cache split — Plannotator
 * uses one monolithic directory.
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, resolve } from "path";

/**
 * Resolve the Plannotator data directory.
 *
 * If PLANNOTATOR_DATA_DIR is set and non-empty, the value is used
 * as the base directory. Leading ~ is expanded to the user's home
 * directory.
 *
 * Otherwise, ~/.plannotator is used when it exists; failing that,
 * $XDG_DATA_HOME/plannotator when XDG_DATA_HOME holds an absolute
 * path; failing that, ~/.plannotator.
 */
export function getPlannotatorDataDir(): string {
  const home = homedir();

  const envDir = process.env.PLANNOTATOR_DATA_DIR?.trim();
  if (envDir) {
    // Expand ~ to home directory
    if (envDir === "~") return home;
    if (envDir.startsWith("~/") || envDir.startsWith("~\\")) {
      return join(home, envDir.slice(2));
    }
    return resolve(envDir);
  }

  const legacyDir = join(home, ".plannotator");
  if (existsSync(legacyDir)) return legacyDir;

  const xdgDataHome = process.env.XDG_DATA_HOME?.trim();
  if (xdgDataHome && isAbsolute(xdgDataHome)) {
    return join(xdgDataHome, "plannotator");
  }

  return legacyDir;
}
