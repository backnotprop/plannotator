/**
 * XDG Base Directory helpers for plannotator.
 *
 * Each helper falls back to ~/.plannotator when that directory already exists,
 * preserving backwards-compatibility for existing installations.
 *
 * New installations use the XDG Base Directory Specification:
 *   data   → $XDG_DATA_HOME/plannotator   (default: ~/.local/share/plannotator)
 *   state  → $XDG_STATE_HOME/plannotator  (default: ~/.local/state/plannotator)
 *   config → $XDG_CONFIG_HOME/plannotator (default: ~/.config/plannotator)
 *
 * Runtime-agnostic: uses only node:os, node:path, node:fs.
 */

import { homedir } from "os";
import { join } from "path";
import { existsSync } from "fs";

const LEGACY_DIR = join(homedir(), ".plannotator");

/** Persistent user data: plans, version history. */
export function getDataBase(): string {
  if (existsSync(LEGACY_DIR)) return LEGACY_DIR;
  const xdg = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(xdg, "plannotator");
}

/** Ephemeral state: drafts, sessions, debug logs. */
export function getStateBase(): string {
  if (existsSync(LEGACY_DIR)) return LEGACY_DIR;
  const xdg = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(xdg, "plannotator");
}

/** User configuration: config.json, improvement hooks. */
export function getConfigBase(): string {
  if (existsSync(LEGACY_DIR)) return LEGACY_DIR;
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdg, "plannotator");
}
