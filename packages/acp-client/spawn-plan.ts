/**
 * Spawning the agent adapter safely on every platform. Kept apart from the
 * ACP client so the client and the agent table do not import each other.
 */

import { readFileSync } from "node:fs";
import { win32 } from "node:path";
import { findExecutable } from "./which";

/** How to spawn a command: on Windows a `.cmd` shim cannot be spawned without a shell. */
export interface SpawnPlan {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Windows: an npm-installed adapter is a `.cmd` shim, which Node refuses to
 * spawn without a shell. Read the shim for its JavaScript entry and run that
 * with Node (or VS Code's own runtime when no Node is on PATH). A `.cmd` we
 * cannot read is refused with a plain message rather than run through
 * `cmd.exe` with arguments it would interpret. Elsewhere the command is
 * spawned as it is. Not tested on Windows itself; the shim parsing is.
 */
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

/** The JavaScript file an npm `.cmd` shim runs (`"%dp0%\\node_modules\\…\\index.js"`). */
export function shimEntry(shimPath: string, text: string): string | null {
  const m = /"%(?:~dp0|dp0)%\\?([^"%]+?\.(?:c|m)?js)"/i.exec(text);
  if (!m) return null;
  const parts = m[1].split(/[\\/]+/).filter(Boolean);
  if (win32.isAbsolute(m[1]) || parts.includes("..")) return null;
  return win32.join(win32.dirname(shimPath), ...parts);
}
