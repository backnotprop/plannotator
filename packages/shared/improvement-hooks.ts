import { join } from "path";
import { readFileSync, statSync } from "fs";
import { getPlannotatorDataDir } from "./data-dir";

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

  if (fileExists(newPath)) {
    return tryReadHookFile(newPath, hookName);
  }

  const legacyFilePath = join(getPlannotatorDataDir(), entry.legacyPath);
  return tryReadHookFile(legacyFilePath, hookName);
}
