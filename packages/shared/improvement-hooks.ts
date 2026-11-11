/** Reads improvement hook files from ~/.plannotator/hooks/, falling back to the legacy path only when the new file is absent (an invalid new file never resurrects stale instructions). Only allowlisted KNOWN_HOOKS paths, size-capped. */

import { join } from "path";
import { readFileSync, statSync } from "fs";
import { getPlannotatorDataDir } from "./data-dir";

/** Resolved per call: PLANNOTATOR_DATA_DIR may be set after this module is imported. */
function hooksBaseDir(): string {
  return join(getPlannotatorDataDir(), "hooks");
}

const MAX_FILE_SIZE = 50 * 1024;

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

function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

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

export function readImprovementHook(
  hookName: ImprovementHookName,
): ImprovementHookResult | null {
  const entry = KNOWN_HOOKS[hookName];
  if (!entry) return null;

  const newPath = join(hooksBaseDir(), entry.path);

  // New path exists: use it exclusively, even if invalid.
  if (fileExists(newPath)) {
    return tryReadHookFile(newPath, hookName);
  }

  const legacyFilePath = join(getPlannotatorDataDir(), entry.legacyPath);
  return tryReadHookFile(legacyFilePath, hookName);
}
