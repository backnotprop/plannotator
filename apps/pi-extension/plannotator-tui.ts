/**
 * TUI plan-review renderer — alternative to the browser session.
 *
 * Same decision contract as openPlanReviewBrowser (PlanReviewDecision), but the
 * human reviews the plan in plannotator-tui (https://github.com/plannotator/plannotator-tui)
 * running in a Herdr pane instead of the browser annotation UI.
 *
 * Mechanics:
 *  1. The TUI is spawned into a new Herdr pane (split beside pi's own pane) via
 *     the `herdr` CLI, with PLANNOTATOR_DATA_DIR pointed at a throwaway session
 *     dir so annotation readback is deterministic and the real annotation
 *     history stays untouched.
 *  2. Exit is detected by polling `herdr pane process-info` until the TUI
 *     leaves the pane's foreground process list.
 *  3. Outcome mapping (the TUI has no approve/deny gate):
 *       - closed with no annotations          → approved
 *       - closed with annotations             → denied + feedback text
 *     Feedback text prefers the TUI's own archive line (written by `E` send);
 *     if the reviewer never pressed `E`, it is rebuilt from annotations.json.
 *
 * Requires: herdr server running (pi inside Herdr), plannotator-tui on PATH or
 * pointed at via PLANNOTATOR_TUI_BIN.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { BROWSER_SESSION_STOPPED } from "./browser-session-error.ts";
import type { PlanReviewDecision } from "./plannotator-browser.ts";
import { appendFeedbackRecord, deriveFeedbackProject } from "./generated/feedback-archive.ts";

const execFileAsync = promisify(execFile);

/**
 * True when the TUI renderer is active. Precedence: PLANNOTATOR_RENDERER env
 * (explicit per-session override) > `"renderer": "tui"` in .pi/plannotator.json
 * (project) or ~/.pi/agent/plannotator.json (global), resolved by the caller
 * via resolveRenderer > default browser.
 */
export function isTuiRendererEnabled(configRenderer?: "browser" | "tui" | null): boolean {
	const env = (process.env.PLANNOTATOR_RENDERER ?? "").trim().toLowerCase();
	if (env) return env === "tui";
	return configRenderer === "tui";
}

const stoppedError = () => {
	const e = new Error("Plannotator TUI review session was stopped.");
	e.name = BROWSER_SESSION_STOPPED;
	return e;
};

async function runHerdr(args: string[], timeoutMs = 15_000): Promise<string> {
	try {
		const { stdout } = await execFileAsync("herdr", args, { timeout: timeoutMs, windowsHide: true });
		return stdout;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`herdr ${args[0]} failed: ${message}`);
	}
}

const PATH_DELIMITER = process.platform === "win32" ? ";" : ":";

function resolveTuiBinary(): string {
	const override = process.env.PLANNOTATOR_TUI_BIN?.trim();
	if (override) {
		if (!existsSync(override)) throw new Error(`PLANNOTATOR_TUI_BIN does not exist: ${override}`);
		return override;
	}
	const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
	for (const dir of (process.env.PATH ?? "").split(PATH_DELIMITER)) {
		if (!dir) continue;
		for (const ext of exts) {
			const candidate = join(dir, `plannotator-tui${ext}`);
			try {
				if (statSync(candidate).isFile()) return candidate;
			} catch {
				// not here
			}
		}
	}
	throw new Error(
		"plannotator-tui not found. Install it (https://github.com/plannotator/plannotator-tui/releases) or set PLANNOTATOR_TUI_BIN.",
	);
}

type TuiAnnotation = {
	anchor?: {
		originalText?: string;
		quote?: string;
		plannotator_tui?: { kind?: string; prefix?: string };
	};
	body?: string;
};

type TuiAnnotationDoc = { path?: string; annotations?: TuiAnnotation[] };

function listFilesRecursive(dir: string): string[] {
	const out: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = join(dir, entry);
		let isDir = false;
		try {
			isDir = statSync(full).isDirectory();
		} catch {
			continue;
		}
		if (isDir) out.push(...listFilesRecursive(full));
		else out.push(full);
	}
	return out;
}

/** Line number of an annotation, derived from its prefix (1-based, like the TUI's own export). */
function annotationLine(a: TuiAnnotation): number {
	const prefix = a.anchor?.plannotator_tui?.prefix;
	if (!prefix) return 1;
	return prefix.split("\n").length;
}

/** Rebuild the TUI's numbered feedback format from annotations.json. */
export function formatTuiFeedback(planPath: string, annotations: TuiAnnotation[]): string {
	const kindLabel: Record<string, string> = {
		looks_good: "Looks good",
		comment: "Comment",
		delete: "Delete",
	};
	const lines: string[] = [`# Annotations on ${basename(planPath)}`, ""];
	annotations.forEach((a, i) => {
		const quote = a.anchor?.originalText ?? a.anchor?.quote ?? "";
		const kind = kindLabel[a.anchor?.plannotator_tui?.kind ?? ""] ?? "Note";
		lines.push(`## Annotation ${i + 1} (line ${annotationLine(a)})`);
		if (quote) lines.push(`${kind}: "${quote}"`);
		else lines.push(kind);
		if (a.body?.trim()) lines.push("", a.body.trim());
		lines.push("");
	});
	// The TUI's own export ends with a blank line; keep both byte-identical.
	return lines.join("\n") + "\n";
}

/** The TUI archive line for this plan, if the reviewer pressed `E` (send). */
function readArchiveFeedback(dataDir: string, planPath: string): string | undefined {
	const feedbackDir = join(dataDir, "feedback");
	for (const file of listFilesRecursive(feedbackDir)) {
		if (!file.endsWith(".jsonl")) continue;
		try {
			for (const line of readFileSync(file, "utf-8").split("\n")) {
				if (!line.trim()) continue;
				try {
					const record = JSON.parse(line) as { target?: { filePath?: string }; feedback?: string };
					if (record.target?.filePath === planPath && record.feedback) return record.feedback;
				} catch {
					// skip malformed line
				}
			}
		} catch {
			// unreadable file — keep looking
		}
	}
	return undefined;
}

function readTuiAnnotations(dataDir: string, planPath: string): TuiAnnotation[] {
	const annotationsRoot = join(dataDir, "clients", "plannotator-tui", "annotations");
	const collected: TuiAnnotation[] = [];
	for (const file of listFilesRecursive(annotationsRoot)) {
		if (!file.endsWith("annotations.json")) continue;
		try {
			const doc = JSON.parse(readFileSync(file, "utf-8")) as TuiAnnotationDoc;
			if (doc.path !== planPath) continue;
			collected.push(...(doc.annotations ?? []));
		} catch {
			// skip malformed doc
		}
	}
	return collected;
}

async function currentHerdrPane(): Promise<string> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await runHerdr(["pane", "current"]));
	} catch {
		throw new Error("could not determine the current Herdr pane (is pi running inside Herdr?)");
	}
	const paneId = (parsed as { result?: { pane?: { pane_id?: string } } }).result?.pane?.pane_id;
	if (!paneId) throw new Error("could not determine the current Herdr pane");
	return paneId;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(stoppedError());
			},
			{ once: true },
		);
	});
}

async function paneRead(paneId: string): Promise<string | null> {
	// null = the pane itself is gone (closed by the reviewer)
	try {
		return await execFileAsync("herdr", ["pane", "read", paneId, "--lines", "60"], {
			timeout: 10_000,
			windowsHide: true,
			maxBuffer: 4 * 1024 * 1024,
		}).then((r) => r.stdout);
	} catch {
		return null;
	}
}

function shellQuote(value: string): string {
	const q = value.replace(/'/g, "'");
	return `'${q}'`;
}

export async function openPlanReviewTui(
	ctx: ExtensionContext,
	planAbsolutePath: string,
	signal?: AbortSignal,
): Promise<PlanReviewDecision> {
	const bin = resolveTuiBinary();
	const basePane = await currentHerdrPane();
	const dataDir = mkdtempSync(join(tmpdir(), "plannotator-tui-review-"));

	let paneId: string | undefined;
	try {
		const splitOutput = await runHerdr([
			"pane",
			"split",
			"--pane",
			basePane,
			"--direction",
			"right",
			"--cwd",
			dirname(planAbsolutePath),
			"--env",
			`PLANNOTATOR_DATA_DIR=${dataDir}`,
		]);
		paneId = (JSON.parse(splitOutput) as { result?: { pane?: { pane_id?: string } } }).result?.pane
			?.pane_id;
		if (!paneId) throw new Error("herdr pane split returned no pane id");

		// Launch: type the TUI command into the pane's shell, followed by an
		// exit sentinel carrying the process exit status. `pane run` is
		// send-text + Enter, so the pane's shell parses the whole line
		// (PowerShell on Windows, POSIX shells elsewhere). The sentinel is the
		// only reliable exit signal: `pane process-info` does not list the TUI
		// process on Windows, prompt text varies, and a fast reviewer can quit
		// before any poll observes the TUI's alt-screen frame.
		const sentinel = `PLANNOTATOR_TUI_REVIEW_DONE_${randomBytes(4).toString("hex")}`;
		const invocation = process.platform === "win32"
			? `& ${shellQuote(bin)} ${shellQuote(planAbsolutePath)}; "${sentinel}_$?"`
			: `${shellQuote(bin)} ${shellQuote(planAbsolutePath)}; echo "${sentinel}_$?"`;
		await runHerdr(["pane", "run", paneId, invocation], 10_000);

		const cleanExit = process.platform === "win32" ? `${sentinel}_True` : `${sentinel}_0`;

		// Wait for the sentinel (reviewer quit) — no timeout; the review may
		// take as long as it takes. The abort signal or a closed pane ends the
		// wait. A sentinel without a success status means the TUI failed to
		// launch or crashed: a broken launch must never map onto an approval.
		for (;;) {
			const frame = await paneRead(paneId);
			if (frame === null) throw stoppedError();
			if (frame.includes(cleanExit)) {
				break;
			}
			if (frame.includes(sentinel)) {
				throw new Error(
					`plannotator-tui failed to run in Herdr pane ${paneId} (non-zero exit). Check PLANNOTATOR_TUI_BIN/PATH and the plan path.`,
				);
			}
			await sleep(500, signal);
		}
	} catch (err) {
		if (paneId) await runHerdr(["pane", "close", paneId], 10_000).catch(() => {});
		rmSync(dataDir, { recursive: true, force: true });
		if (err instanceof Error && err.name === BROWSER_SESSION_STOPPED) {
			ctx.ui.notify("Plan review TUI was closed before a decision.", "info");
		}
		throw err;
	}

	const annotations = readTuiAnnotations(dataDir, planAbsolutePath);
	const feedback = annotations.length > 0
		? (readArchiveFeedback(dataDir, planAbsolutePath) ??
			formatTuiFeedback(planAbsolutePath, annotations))
		: undefined;

	// Pane may already be gone if the reviewer closed it — close is best-effort.
	if (paneId) await runHerdr(["pane", "close", paneId], 10_000).catch(() => {});
	rmSync(dataDir, { recursive: true, force: true });

	const decision: PlanReviewDecision = {
		approved: annotations.length === 0,
		...(feedback ? { feedback } : {}),
	};

	// Keep the shared feedback archive complete: the browser flow archives plan
	// decisions via the server; the TUI flow bypasses it, so append here.
	appendFeedbackRecord({
		project: deriveFeedbackProject(ctx.cwd),
		origin: "pi",
		surface: "plan",
		decision: decision.approved ? "approved" : "denied",
		...(decision.feedback ? { feedback: decision.feedback } : {}),
		target: { filePath: planAbsolutePath },
	});

	return decision;
}
