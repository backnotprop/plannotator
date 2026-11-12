import { basename, isAbsolute } from "node:path";
import { simpleShellCommandWords } from "./plannotator-tool";

export const T3_SETTINGS_BACKUP_SUFFIX = ".plannotator-t3.bak";

export function quoteHookWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const T3_ENTRYPOINT_PATTERNS = ["sdk*", "t3-code"] as const;
const T3_HOOK_GATE_OPEN = `case "$CLAUDE_CODE_ENTRYPOINT" in ${T3_ENTRYPOINT_PATTERNS.join("|")}) `;
const T3_HOOK_GATE_OPEN_SDK_ONLY = 'case "$CLAUDE_CODE_ENTRYPOINT" in sdk*) ';
const T3_HOOK_GATE_CLOSE = ";; esac";

export function t3HookCommand(executable: string, dataDir: string): string {
  return `${T3_HOOK_GATE_OPEN}PLANNOTATOR_DATA_DIR=${quoteHookWord(dataDir)} ${quoteHookWord(executable)} t3-hook${T3_HOOK_GATE_CLOSE}`;
}

export function isAgentSdkEntrypoint(value: string | undefined): boolean {
  return typeof value === "string"
    && T3_ENTRYPOINT_PATTERNS.some((pattern) => pattern.endsWith("*") ? value.startsWith(pattern.slice(0, -1)) : value === pattern);
}

export function parseT3HookCommand(command: string): { executable: string } | undefined {
  let inner = command.trim();
  const gate = [T3_HOOK_GATE_OPEN, T3_HOOK_GATE_OPEN_SDK_ONLY].find((open) => inner.startsWith(open) && inner.endsWith(T3_HOOK_GATE_CLOSE));
  if (gate) inner = inner.slice(gate.length, -T3_HOOK_GATE_CLOSE.length);
  const words = simpleShellCommandWords(inner);
  if (!words) return;
  if (words[0]?.startsWith("PLANNOTATOR_DATA_DIR=")) words.shift();
  if (words.length !== 2 || words[1] !== "t3-hook") return;
  const executable = words[0]!;
  const name = basename(executable);
  if (executable === "plannotator" || (isAbsolute(executable) && (name === "plannotator" || name === "plannotator.exe"))) return { executable };
}
