import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { openFileInApp } from "./server/open-in-apps.ts";

const tempDirs: string[] = [];
function makeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-open-in-launch-"));
	tempDirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of tempDirs) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
		}
	}
});

const launcherShimName = process.platform === "darwin" ? "open" : "code";
const launchTest = process.platform === "win32" ? test.skip : test;

function writeShim(dir: string, script: string): void {
	const shim = join(dir, launcherShimName);
	writeFileSync(shim, script);
	chmodSync(shim, 0o755);
}

function pgidOf(pid: number): number {
	const out = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], {
		encoding: "utf-8",
	});
	return Number.parseInt(out.stdout.trim(), 10);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPidFile(path: string, timeoutMs = 5000): Promise<number> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const text = readFileSync(path, "utf-8").trim();
			if (text) return Number.parseInt(text, 10);
		} catch {
		}
		await sleep(25);
	}
	throw new Error(`timed out waiting for ${path}`);
}

describe("openFileInApp launch semantics (Pi mirror)", () => {
	launchTest(
		"a lingering launcher returns ok within the grace and runs detached from the server's process group",
		async () => {
			const shimDir = makeDir();
			const pidFile = join(shimDir, "child.pid");
			writeShim(shimDir, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`);
			const target = join(makeDir(), "file.txt");
			writeFileSync(target, "x");

			const oldPath = process.env.PATH;
			process.env.PATH = `${shimDir}${delimiter}${oldPath ?? ""}`;
			let childPid: number | null = null;
			try {
				const started = Date.now();
				const result = await openFileInApp(target, "vscode");
				const elapsed = Date.now() - started;

				expect(result.ok).toBe(true);
				expect(elapsed).toBeLessThan(8000);

				childPid = await waitForPidFile(pidFile);
				expect(() => process.kill(childPid!, 0)).not.toThrow();
				expect(pgidOf(childPid)).not.toBe(pgidOf(process.pid));
			} finally {
				process.env.PATH = oldPath;
				if (childPid != null) {
					try {
						process.kill(childPid, "SIGKILL");
					} catch {
					}
				}
			}
		},
		15000,
	);

	launchTest(
		"an instantly failing launcher still reports the friendly exit + stderr error",
		async () => {
			const shimDir = makeDir();
			writeShim(
				shimDir,
				`#!/bin/sh\necho "Unable to find application named 'ShimTarget'" >&2\nexit 1\n`,
			);
			const target = join(makeDir(), "file.txt");
			writeFileSync(target, "x");

			const oldPath = process.env.PATH;
			process.env.PATH = `${shimDir}${delimiter}${oldPath ?? ""}`;
			try {
				const result = await openFileInApp(target, "vscode");
				expect(result.ok).toBe(false);
				if (result.ok === false) {
					expect(result.error).toContain("Failed to open");
					expect(result.error).toContain("exit 1");
					expect(result.error).toContain(
						"Unable to find application named 'ShimTarget'",
					);
				}
			} finally {
				process.env.PATH = oldPath;
			}
		},
		15000,
	);

	launchTest(
		"a chatty launcher (>128KB stderr, then lingers) cannot deadlock the request",
		async () => {
			const shimDir = makeDir();
			const pidFile = join(shimDir, "child.pid");
			writeShim(
				shimDir,
				`#!/bin/sh\nhead -c 200000 /dev/zero | tr '\\0' e >&2\necho $$ > "${pidFile}"\nexec sleep 30\n`,
			);
			const target = join(makeDir(), "file.txt");
			writeFileSync(target, "x");

			const oldPath = process.env.PATH;
			process.env.PATH = `${shimDir}${delimiter}${oldPath ?? ""}`;
			let childPid: number | null = null;
			try {
				const started = Date.now();
				const result = await openFileInApp(target, "vscode");
				const elapsed = Date.now() - started;
				expect(result.ok).toBe(true);
				expect(elapsed).toBeLessThan(8000);
				childPid = await waitForPidFile(pidFile);
			} finally {
				process.env.PATH = oldPath;
				if (childPid != null) {
					try {
						process.kill(childPid, "SIGKILL");
					} catch {
					}
				}
			}
		},
		15000,
	);
});
