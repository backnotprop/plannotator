/**
 * IDE integration — open plan diffs in VS Code.
 * Node.js equivalent of packages/server/ide.ts.
 */

import { spawn } from "node:child_process";

/** Open two files in VS Code's diff viewer. Node.js equivalent of packages/server/ide.ts */
export function openEditorDiff(
	oldPath: string,
	newPath: string,
): Promise<{ ok: true } | { error: string }> {
	return new Promise((resolve) => {
		// windows-hide-guard: starts the app window the person asked for, which windowsHide would start hidden.
		const proc = spawn("code", ["--diff", oldPath, newPath], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		proc.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		proc.on("error", (err) => {
			if (err.message.includes("ENOENT")) {
				resolve({
					error:
						"VS Code CLI not found. Run 'Shell Command: Install code command in PATH' from the VS Code command palette.",
				});
			} else {
				resolve({ error: err.message });
			}
		});
		proc.on("close", (code) => {
			if (code !== 0) {
				if (stderr.includes("not found") || stderr.includes("ENOENT")) {
					resolve({
						error:
							"VS Code CLI not found. Run 'Shell Command: Install code command in PATH' from the VS Code command palette.",
					});
				} else {
					resolve({ error: `code --diff exited with ${code}: ${stderr}` });
				}
			} else {
				resolve({ ok: true });
			}
		});
	});
}
