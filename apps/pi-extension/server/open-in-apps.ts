/**
 * Open-in-App launcher — Node.js equivalent of packages/server/open-in-apps.ts.
 *
 * Launches a file in a chosen desktop app (editor / file manager / terminal)
 * using node:child_process execFile with argv arrays (never shell strings) to
 * avoid command injection. The app catalog is the runtime-agnostic single
 * source of truth shared with the Bun server and the UI
 * (packages/shared/open-in-apps.ts, vendored into generated/).
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import os from "node:os";

import {
	OPEN_IN_APPS,
	getOpenInApp,
	resolveRevealIcon,
	resolveRevealLabel,
	type OpenInApp,
	type OpenInKind,
	type OpenInPlatform,
} from "../generated/open-in-apps.ts";

function currentPlatform(): OpenInPlatform {
	switch (process.platform) {
		case "win32":
			return "win";
		case "darwin":
			return "mac";
		default:
			return "linux";
	}
}

/** which()-equivalent: returns true if a binary resolves on PATH. */
function whichBin(bin: string): boolean {
	try {
		const finder = process.platform === "win32" ? "where" : "which";
		execFileSync(finder, [bin], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return true;
	} catch {
		return false;
	}
}

/** macOS: does an application bundle exist in any standard Applications dir? */
function macAppExists(appName: string): boolean {
	const candidates = [
		`/Applications/${appName}.app`,
		join(os.homedir(), "Applications", `${appName}.app`),
		`/System/Applications/${appName}.app`,
		// Terminal.app and other built-ins live in the Utilities subfolder.
		`/System/Applications/Utilities/${appName}.app`,
	];
	return candidates.some((p) => existsSync(p));
}

/** Is the given catalog app launchable on THIS host? */
function isAppAvailable(app: OpenInApp): boolean {
	// reveal is always available.
	if (app.id === "reveal") return true;

	const platform = currentPlatform();
	if (platform === "mac") {
		// We launch via `open -a "<appName>"`, so availability must mean the .app
		// bundle exists — matching the Bun runtime.
		return !!app.mac?.appName && macAppExists(app.mac.appName);
	}
	if (platform === "win") {
		return app.win?.bin ? whichBin(app.win.bin) : false;
	}
	// linux
	return app.linux?.bin ? whichBin(app.linux.bin) : false;
}

/**
 * The catalog filtered to apps launchable on this host (always including
 * `reveal`), in catalog order, with `reveal`'s label and
 * icon resolved per host platform. Used by GET /api/open-in/apps.
 */
export function getAvailableOpenInApps(): Array<{
	id: string;
	label: string;
	kind: OpenInKind;
	icon: string;
}> {
	const platform = currentPlatform();
	return OPEN_IN_APPS.filter(isAppAvailable).map((app) => {
		if (app.id === "reveal") {
			return {
				id: app.id,
				label: resolveRevealLabel(platform),
				kind: app.kind,
				icon: resolveRevealIcon(platform),
			};
		}
		return { id: app.id, label: app.label, kind: app.kind, icon: app.icon };
	});
}

/**
 * How long a launch may take to fail before we call it launched (ms). Mirrors
 * the Bun runtime (packages/server/open-in.ts).
 */
const LAUNCH_GRACE_MS = 2000;

/** Cap on captured stderr; the stream keeps draining beyond it. */
const LAUNCH_STDERR_CAP_BYTES = 8192;

/**
 * Run an argv launcher and surface ENOENT (app not found) as a friendly error.
 *
 * Mirrors the Bun runtime's runArgv semantics exactly: the child is spawned
 * DETACHED (its own process group) so an editor cold-started by a launcher CLI
 * can never be taken down by a signal aimed at this server's group, the wait
 * is BOUNDED so a launcher CLI that stays attached to the app it started
 * cannot hold the HTTP request hostage, and stderr is drained from spawn time
 * so a chatty child can never fill the pipe and deadlock inside the grace
 * window.
 */
function run(
	cmd: string,
	args: string[],
	notFoundLabel: string,
	opts?: { cwd?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
	return new Promise((resolve) => {
		const failure = (msg: string): { ok: false; error: string } =>
			/ENOENT|not found/i.test(msg)
				? { ok: false, error: `${notFoundLabel} was not found on this system.` }
				: { ok: false, error: msg };

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(cmd, args, {
				detached: true,
				stdio: ["ignore", "ignore", "pipe"],
				...(opts?.cwd ? { cwd: opts.cwd } : {}),
			});
		} catch (err) {
			resolve(failure(err instanceof Error ? err.message : String(err)));
			return;
		}

		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < LAUNCH_STDERR_CAP_BYTES) stderr += chunk.toString();
		});

		let settled = false;
		let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null =
			null;
		const finish = (result: { ok: true } | { ok: false; error: string }) => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			resolve(result);
		};

		const concludeExit = () => {
			if (!exitInfo) return;
			if (/not found|ENOENT/i.test(stderr)) {
				finish({ ok: false, error: `${notFoundLabel} was not found on this system.` });
				return;
			}
			const status = exitInfo.code ?? exitInfo.signal ?? "unknown";
			finish({
				ok: false,
				error: `Failed to open ${notFoundLabel} (exit ${status})${stderr ? `: ${stderr.trim()}` : ""}`,
			});
		};

		// Still running at the deadline: it launched. A failure observed just
		// before the deadline still reports as a failure.
		const deadline = setTimeout(() => {
			if (exitInfo) concludeExit();
			else finish({ ok: true });
		}, LAUNCH_GRACE_MS);

		child.once("error", (err) => {
			finish(failure(err instanceof Error ? err.message : String(err)));
		});

		child.once("exit", (code, signal) => {
			if (code === 0) {
				finish({ ok: true });
				return;
			}
			exitInfo = { code, signal };
			// Give the stderr pipe a beat to flush before reporting; "close" (all
			// stdio ended) concludes immediately when it arrives first. close alone
			// is not enough: a grandchild inheriting the pipe can hold it open.
			setTimeout(concludeExit, 50);
		});

		child.once("close", (code, signal) => {
			if (code === 0) {
				finish({ ok: true });
				return;
			}
			exitInfo = { code, signal };
			concludeExit();
		});

		// The launcher runs on its own; never keep this process alive for it.
		child.unref();
	});
}

/**
 * Spawn a launcher we can't meaningfully await — e.g. Windows `explorer`, which
 * exits non-zero even on success. Returns ok immediately; an async spawn failure
 * (missing binary) is swallowed so it can't crash the server. Mirrors the Bun
 * runtime's spawnDetached (packages/server/open-in.ts).
 */
function spawnDetached(
	cmd: string,
	args: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
	try {
		const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
		child.on("error", () => {}); // fire-and-forget; ignore async spawn failure
		child.unref();
		return Promise.resolve({ ok: true });
	} catch (err) {
		return Promise.resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
	}
}

/**
 * Launch `absPath` in the app identified by `appId` (defaults / unknown ->
 * the OS default handler). Mirrors the Bun-side launch semantics exactly.
 */
export function openFileInApp(
	absPath: string,
	appId?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const platform = currentPlatform();
	const app = appId ? getOpenInApp(appId) : undefined;

	// Unknown or undefined appId -> OS default handler on the file.
	if (!app) {
		if (platform === "mac") return run("open", [absPath], "Default app");
		if (platform === "win")
			return run("cmd", ["/c", "start", "", basename(absPath)], "Default app", { cwd: dirname(absPath) });
		return run("xdg-open", [absPath], "Default app");
	}

	if (app.kind === "file-manager") {
		// Reveal the file in the OS file manager.
		if (platform === "mac") return run("open", ["-R", absPath], "Finder");
		// explorer.exe exits non-zero even on success; launch fire-and-forget so
		// a successful reveal doesn't report failure.
		if (platform === "win") return spawnDetached("explorer", [`/select,${absPath}`]);
		return run("xdg-open", [dirname(absPath)], "File manager");
	}

	if (app.kind === "terminal") {
		// Terminals open the file's parent directory.
		const dir = dirname(absPath);
		if (platform === "mac") {
			if (!app.mac?.appName)
				return Promise.resolve({ ok: false, error: `${app.label} is not available on this platform.` });
			return run("open", ["-a", app.mac.appName, dir], app.label);
		}
		if (platform === "win") {
			if (!app.win?.bin)
				return Promise.resolve({ ok: false, error: `${app.label} is not available on this platform.` });
			// Open a new console window for the terminal. The directory is passed
			// via cwd (NOT a cmd argument) so a repo-controlled path never reaches
			// cmd's parser; `start` inherits that cwd. bin is a trusted catalog value.
			return run("cmd", ["/c", "start", "", app.win.bin], app.label, { cwd: dir });
		}
		if (!app.linux?.bin)
			return Promise.resolve({ ok: false, error: `${app.label} is not available on this platform.` });
		return run(app.linux.bin, [dir], app.label);
	}

	// editor -> open the file itself.
	if (platform === "mac") {
		if (!app.mac?.appName)
			return Promise.resolve({ ok: false, error: `${app.label} is not available on this platform.` });
		return run("open", ["-a", app.mac.appName, absPath], app.label);
	}
	if (platform === "win") {
		if (!app.win?.bin)
			return Promise.resolve({ ok: false, error: `${app.label} is not available on this platform.` });
		return run(app.win.bin, [absPath], app.label);
	}
	if (!app.linux?.bin)
		return Promise.resolve({ ok: false, error: `${app.label} is not available on this platform.` });
	return run(app.linux.bin, [absPath], app.label);
}
