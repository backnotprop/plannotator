import { basename, isAbsolute } from "node:path";
import { simpleShellCommandWords } from "./plannotator-tool";

/** `<settings.json><suffix>`: the copy `t3-hook install` keeps of settings before its first change; uninstall removes it. */
export const T3_SETTINGS_BACKUP_SUFFIX = ".plannotator-t3.bak";

export function quoteHookWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The shell gate in front of the hook. T3 Code runs Claude through the Agent
 * SDK, which sets CLAUDE_CODE_ENTRYPOINT to `sdk-ts` (`sdk-py`, `sdk-cli`, …)
 * for the Claude it starts; an interactive `claude` reports `cli`. The hook
 * runs on every Bash call of every Claude session that loads this settings
 * file, so outside an SDK session the shell answers on its own (no output, no
 * decision) and the Plannotator binary never starts.
 */
const T3_HOOK_GATE_OPEN = 'case "$CLAUDE_CODE_ENTRYPOINT" in sdk*) ';
const T3_HOOK_GATE_CLOSE = ";; esac";

export function t3HookCommand(executable: string, dataDir: string): string {
  return `${T3_HOOK_GATE_OPEN}PLANNOTATOR_DATA_DIR=${quoteHookWord(dataDir)} ${quoteHookWord(executable)} t3-hook${T3_HOOK_GATE_CLOSE}`;
}

/** Whether a Claude session can be T3's: only Agent SDK sessions are. */
export function isAgentSdkEntrypoint(value: string | undefined): boolean {
  return typeof value === "string" && value.startsWith("sdk");
}

/**
 * The executable a T3 hook command runs, or undefined when the command is not
 * one. Accepts the gated form `t3HookCommand` writes and the ungated form
 * earlier builds of this integration wrote, so reinstall and uninstall clean
 * up either.
 */
export function parseT3HookCommand(command: string): { executable: string } | undefined {
  let inner = command.trim();
  if (inner.startsWith(T3_HOOK_GATE_OPEN) && inner.endsWith(T3_HOOK_GATE_CLOSE)) {
    inner = inner.slice(T3_HOOK_GATE_OPEN.length, -T3_HOOK_GATE_CLOSE.length);
  }
  const words = simpleShellCommandWords(inner);
  if (!words) return;
  if (words[0]?.startsWith("PLANNOTATOR_DATA_DIR=")) words.shift();
  if (words.length !== 2 || words[1] !== "t3-hook") return;
  const executable = words[0]!;
  const name = basename(executable);
  if (executable === "plannotator" || (isAbsolute(executable) && (name === "plannotator" || name === "plannotator.exe"))) return { executable };
}
