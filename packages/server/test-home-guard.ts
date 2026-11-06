/**
 * Test runs only: a server started under PLANNOTATOR_TEST_SANDBOX refuses the
 * real home. The sandbox flag and a temp data dir do not move `~/.agents/skills`
 * or the `inbox mcp` shim's read of `~/.env` (the server's own Qwen reads are
 * sandboxed). No HOME, or an empty one, is the real home too: `os.homedir()` falls
 * back to the account's. Without the flag this does nothing.
 *
 * The account's home comes from `~user`, because Bun's `os.userInfo().homedir`
 * follows $HOME. It reads nothing from that folder. Skipped on Windows, where
 * `os.homedir()` follows USERPROFILE.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/** The real path, so a symlink to the home is the same folder. Only resolves the path. */
function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function accountHomeFromShell(): string | null {
  const out = spawnSync("/bin/sh", ["-c", 'eval echo "~$(id -un)"'], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }).stdout?.trim();
  return out || null;
}

/** Why this environment may not start a server, or null when it may. */
export function testHomeRefusal(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  accountHome: () => string | null = accountHomeFromShell,
): string | null {
  if (!env.PLANNOTATOR_TEST_SANDBOX || platform === "win32") return null;
  const home = env.HOME?.trim();
  const account = accountHome();
  if (home && (!account || canonical(home) !== canonical(account))) return null;
  return `PLANNOTATOR_TEST_SANDBOX is set and HOME is ${home || "not set"}, which is the real home. Set HOME to a scratch folder in this test's env.`;
}

export function assertTestHome(): void {
  const refusal = testHomeRefusal();
  if (refusal) throw new Error(refusal);
}
