import { readFileSync } from "node:fs";
import { win32 } from "node:path";
import { findExecutable } from "./which";

export interface SpawnPlan {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export function planSpawn(
  command: string,
  args: string[],
  options: { platform?: NodeJS.Platform; readShim?: (path: string) => string; findNode?: () => string | null; execPath?: string } = {},
): SpawnPlan {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(command)) return { command, args };
  let text: string;
  try {
    text = (options.readShim ?? ((p) => readFileSync(p, "utf8")))(command);
  } catch (err) {
    throw new Error(`Could not read ${command}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const entry = shimEntry(command, text);
  if (!entry) throw new Error(`${command} is not an npm command shim, so it cannot be started safely. Set plannotator.guides.claudeCode.command to its .js entry or an .exe.`);
  const node = (options.findNode ?? (() => findExecutable("node")))();
  if (node) return { command: node, args: [entry, ...args] };
  return { command: options.execPath ?? process.execPath, args: [entry, ...args], env: { ELECTRON_RUN_AS_NODE: "1" } };
}

export function shimEntry(shimPath: string, text: string): string | null {
  const m = /"%(?:~dp0|dp0)%\\?([^"%]+?\.(?:c|m)?js)"/i.exec(text);
  if (!m) return null;
  const parts = m[1].split(/[\\/]+/).filter(Boolean);
  if (win32.isAbsolute(m[1]) || parts.includes("..")) return null;
  return win32.join(win32.dirname(shimPath), ...parts);
}
