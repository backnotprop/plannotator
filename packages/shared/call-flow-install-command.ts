import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** An argv vector for a Call flow install tool; never interpreted by a shell. */
export type CallFlowInstallCommand = readonly [string, ...string[]];

/** Resolve the npm install command selected from PATH without running it. */
export function resolveCallFlowNpmCommand(nodePath: string, npmPath: string):
  | { readonly ok: true; readonly command: CallFlowInstallCommand }
  | { readonly ok: false; readonly message: string } {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(npmPath)) {
    return { ok: true, command: [npmPath] };
  }
  // Windows cannot spawn a batch shim directly (EINVAL). Use npm's standard JS entry point,
  // not cmd.exe: verified-cache paths can contain shell metacharacters and must stay literal.
  const npmCli = join(dirname(npmPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!existsSync(npmCli)) {
    return { ok: false, message: `Call flow could not find npm's JavaScript entry point beside ${npmPath}. Put a standard Node.js/npm installation on PATH.` };
  }
  return { ok: true, command: [nodePath, npmCli] };
}

/** Resolve the compiler from the Call flow runtime's pinned TypeScript package. */
export function callFlowTypeScriptCommand(nodePath: string, installDir: string): CallFlowInstallCommand {
  // The dependency rebuild is not the last batch launch: .bin/tsc.cmd fails the same way.
  return [nodePath, join(installDir, "node_modules", "typescript", "bin", "tsc")];
}
