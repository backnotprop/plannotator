import { basename, isAbsolute } from "node:path";
import { simpleShellCommandWords } from "./plannotator-tool";

export function quoteHookWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function t3HookCommand(executable: string, dataDir: string): string {
  return `PLANNOTATOR_DATA_DIR=${quoteHookWord(dataDir)} ${quoteHookWord(executable)} t3-hook`;
}

export function parseT3HookCommand(command: string): { executable: string } | undefined {
  const words = simpleShellCommandWords(command);
  if (!words) return;
  if (words[0]?.startsWith("PLANNOTATOR_DATA_DIR=")) words.shift();
  if (words.length !== 2 || words[1] !== "t3-hook") return;
  const executable = words[0]!;
  const name = basename(executable);
  if (executable === "plannotator" || (isAbsolute(executable) && (name === "plannotator" || name === "plannotator.exe"))) return { executable };
}
