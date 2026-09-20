/**
 * Improvement Hook Reader
 *
 * Reads improvement hook files from ~/.plannotator/hooks/.
 * Falls back to the legacy path (~/.plannotator/) when the new-path
 * file is absent, for compatibility with files written before the
 * path migration. If the new-path file exists but is invalid (empty,
 * oversized, not a regular file), the legacy path is NOT consulted —
 * this prevents resurrecting stale instructions.
 *
 * Runtime-agnostic: uses only node:fs, node:path, node:os.
 *
 * Security model:
 * - Hardcoded base paths (no user input determines file path)
 * - KNOWN_HOOKS allowlist (only pre-registered relative paths)
 * - Size cap to prevent runaway context injection
 * - Same trust model as ~/.plannotator/config.json
 */

import { join } from "path";
import { readFileSync, statSync } from "fs";
import { getPlannotatorDataDir } from "./data-dir";

/**
 * Hooks subdirectory (preferred location).
 *
 * Resolved per call: PLANNOTATOR_DATA_DIR may be set after this module is
 * imported, so a module-scope capture would freeze the pre-switch path.
 */
function hooksBaseDir(): string {
  return join(getPlannotatorDataDir(), "hooks");
}

/** Maximum file size to read (50 KB) */
const MAX_FILE_SIZE = 50 * 1024;

/**
 * Known improvement hook file paths, keyed by hook name.
 * `path` is relative to the hooks base dir (~/.plannotator/hooks/).
 * `legacyPath` is relative to the data dir itself (~/.plannotator/).
 */
const KNOWN_HOOKS = {
  "enterplanmode-improve": {
    path: "compound/enterplanmode-improve-hook.txt",
    legacyPath: "compound/enterplanmode-improve-hook.txt",
  },
} as const;

export type ImprovementHookName = keyof typeof KNOWN_HOOKS;

export function getImprovementHookExpectedPath(
  hookName: ImprovementHookName,
): string | null {
  const entry = KNOWN_HOOKS[hookName];
  if (!entry) return null;
  return join(hooksBaseDir(), entry.path);
}

export interface ImprovementHookResult {
  content: string;
  hookName: ImprovementHookName;
  filePath: string;
}

/** Check whether a path exists on disk (any file type). */
function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Validate and read a hook file. Returns the result, or null if invalid. */
function tryReadHookFile(
  filePath: string,
  hookName: ImprovementHookName,
): ImprovementHookResult | null {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_SIZE) return null;

    const content = readFileSync(filePath, "utf-8").trim();
    if (!content) return null;

    return { content, hookName, filePath };
  } catch {
    return null;
  }
}

/**
 * Read an improvement hook file by name.
 *
 * Lookup order:
 * 1. New path (hooks base dir + path). If it exists and validates, return it.
 * 2. If the new path exists but is invalid (empty, oversized, etc.), return null.
 * 3. Only if the new path does not exist, try the legacy path (data dir + legacyPath).
 */
export function readImprovementHook(
  hookName: ImprovementHookName,
): ImprovementHookResult | null {
  const entry = KNOWN_HOOKS[hookName];
  if (!entry) return null;

  const newPath = join(hooksBaseDir(), entry.path);

  // New path exists — use it exclusively (even if invalid)
  if (fileExists(newPath)) {
    return tryReadHookFile(newPath, hookName);
  }

  // New path absent — fall back to legacy path (directly in the data dir)
  const legacyFilePath = join(getPlannotatorDataDir(), entry.legacyPath);
  return tryReadHookFile(legacyFilePath, hookName);
}
