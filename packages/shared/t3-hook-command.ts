import { basename, isAbsolute } from "node:path";
import { simpleShellCommandWords } from "./plannotator-tool";

/** `<settings.json><suffix>`: the copy `t3-hook install` keeps of settings before its first change; uninstall removes it. */
export const T3_SETTINGS_BACKUP_SUFFIX = ".plannotator-t3.bak";

export function quoteHookWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The shell gate in front of the hook. T3 Code runs Claude through the Agent
 * SDK and names itself in CLAUDE_CODE_ENTRYPOINT (`t3-code`); other SDK apps
 * report `sdk-ts` (`sdk-py`, `sdk-cli`, …) and an interactive `claude` `cli`.
 * The hook runs on every Bash call of every Claude session that loads this
 * settings file, so outside an SDK session the shell answers on its own (no
 * output, no decision) and the Plannotator binary never starts.
 */
const T3_HOOK_GATE_OPEN = 'case "$CLAUDE_CODE_ENTRYPOINT" in sdk*|t3-code) ';
/** The gate earlier builds wrote, before T3 named its entrypoint: still read, so reinstall and uninstall clean it up. */
const T3_HOOK_GATE_OPEN_SDK_ONLY = 'case "$CLAUDE_CODE_ENTRYPOINT" in sdk*) ';
const T3_HOOK_GATE_CLOSE = ";; esac";

export function t3HookCommand(executable: string, dataDir: string): string {
  return `${T3_HOOK_GATE_OPEN}PLANNOTATOR_DATA_DIR=${quoteHookWord(dataDir)} ${quoteHookWord(executable)} t3-hook${T3_HOOK_GATE_CLOSE}`;
}

/** Whether a Claude session can be T3's: only Agent SDK sessions (T3's own `t3-code` included) are. */
export function isAgentSdkEntrypoint(value: string | undefined): boolean {
  return typeof value === "string" && (value.startsWith("sdk") || value === "t3-code");
}

/**
 * The executable a T3 hook command runs, or undefined when the command is not
 * one. Accepts the gated form `t3HookCommand` writes, the SDK-only gate and
 * the ungated form earlier builds of this integration wrote, so reinstall and
 * uninstall clean up any of them.
 */
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
