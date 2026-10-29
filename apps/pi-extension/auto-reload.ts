/**
 * Pi reloads itself to load an updated Plannotator.
 *
 * An update (the installer's `pi update`, `pi update --extensions`) replaces
 * this package's files under a running Pi, which keeps the old code until the
 * person types `/reload` (package-version.ts). Here Pi reloads by itself,
 * through its own command path: `pi.sendUserMessage("/plannotator-reload
 * auto", { expandPromptTemplates: true })` runs this extension's command,
 * whose context has `reload()` (Pi's `/reload`: it refuses while a response
 * is streaming or a compaction runs). Pi 0.84.2 added `expandPromptTemplates`;
 * before it the same call would send the text to the model, so an older Pi
 * gets only the one-line note.
 *
 * It reloads only when nothing can be lost. Each gate was added because a
 * real-host probe lost something without it (auto-reload spike, Pi 0.84.4):
 *   - the same new version has been on disk for STABLE_MS (an install that is
 *     still writing files is never loaded half-way);
 *   - no run: agent_start .. agent_settled, ctx.isIdle(), no queued message;
 *   - no submitted prompt on its way to a run: Pi runs its `input` handlers
 *     before the run starts, and a reload in that gap dropped the prompt;
 *   - no compaction (Pi refuses the reload, with a warning, during one);
 *   - no dialog of any extension open (ui_prompt_start .. ui_prompt_end): a
 *     reload closed it without an answer;
 *   - no Plannotator review, plan review or Ask question open;
 *   - nothing typed for QUIET_MS, and an empty editor (Pi swaps the editor
 *     for its "Reloading..." box for a moment; keys typed then are lost).
 * All of it is checked on every poll and again inside the command, the last
 * moment before the reload. One try per version: a reload that fails leaves
 * Pi's own "Reload failed" line, and the note with `/reload` is shown instead
 * of a second try.
 *
 * Oh My Pi has no reload for extension code (its `/restart` restarts the
 * process and stops a running turn, and is not reachable from an extension),
 * so there it is the note only, once per version, when the session is free.
 * Nothing is ever typed into the editor for the person (no pre-fill): in Oh My
 * Pi, what they typed next would be appended to it.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadedPackageVersion, packageUpdatedMessage, readPackageVersion } from "./package-version.ts";
import type { PiAgentToolHost } from "./pi-host.ts";

export const AUTO_RELOAD_COMMAND = "plannotator-reload";
/** The same version on disk this long before it is loaded. */
export const STABLE_MS = 10_000;
/** Nothing typed this long before a reload. */
export const QUIET_MS = 15_000;
/** A submitted prompt that never started a run stops holding the reload after this long. */
export const INPUT_GRACE_MS = 30_000;
/** How often the version on disk and the session are looked at. */
export const POLL_MS = 2_000;
/** A marker older than this is not the reload that is loading now. */
const MARKER_MAX_AGE_MS = 60_000;
/** Pi added `expandPromptTemplates` to `sendUserMessage` in 0.84.2. */
export const MIN_PI_FOR_AUTO_RELOAD = "0.84.2";

/** Carried from the instance that reloads to the one that loads (same process). */
const MARKER_KEY = "__plannotatorAutoReload_v1";
/** Versions already announced in this process, so a reload's new instance does not repeat it. */
const NOTICED_KEY = "__plannotatorUpdateNoticed_v1";

interface ReloadMarker {
	from: string | null;
	to: string;
	at: number;
}

function store(): Record<string, unknown> {
	return globalThis as unknown as Record<string, unknown>;
}

function noticed(): Set<string> {
	const s = store();
	const existing = s[NOTICED_KEY];
	if (existing instanceof Set) return existing as Set<string>;
	const fresh = new Set<string>();
	s[NOTICED_KEY] = fresh;
	return fresh;
}

function readMarker(): ReloadMarker | undefined {
	const marker = store()[MARKER_KEY] as ReloadMarker | undefined;
	return marker && typeof marker.to === "string" ? marker : undefined;
}

function clearMarker(): void {
	delete store()[MARKER_KEY];
}

/** The line after an automatic reload. */
export function autoReloadedText(to: string): string {
	return `Plannotator updated to ${to}. Pi reloaded while idle.`;
}

/** "0.84.2" >= "0.84.2"; anything unparseable counts as too old. */
export function piSupportsAutoReload(version: string | null | undefined): boolean {
	if (typeof version !== "string" || !version) return false;
	const parse = (v: string) => v.trim().replace(/^v/, "").split(/[-+]/)[0]!.split(".");
	const have = parse(version);
	const need = parse(MIN_PI_FOR_AUTO_RELOAD).map((n) => Number(n));
	if (have.length < 3 || have.some((n) => !/^\d+$/.test(n))) return false;
	for (let i = 0; i < 3; i++) {
		const h = Number(have[i]);
		if (h > need[i]!) return true;
		if (h < need[i]!) return false;
	}
	return true;
}

/** Everything the decision reads, at one moment. */
export interface QuietState {
	now: number;
	running: boolean;
	idle: boolean;
	pendingMessages: boolean;
	compacting: boolean;
	openPrompts: number;
	inputAt: number | null;
	lastKeyAt: number | null;
	editorText: string;
	plannotatorBusy: string | null;
}

/** Why a reload must wait now, or null when nothing can be lost. */
export function reloadBlockedBy(s: QuietState): string | null {
	if (s.running || !s.idle) return "a run";
	if (s.pendingMessages) return "a queued message";
	if (s.compacting) return "a compaction";
	if (s.inputAt !== null && s.now - s.inputAt < INPUT_GRACE_MS) return "a submitted prompt";
	if (s.openPrompts > 0) return "an open dialog";
	if (s.plannotatorBusy) return s.plannotatorBusy;
	if (s.lastKeyAt !== null && s.now - s.lastKeyAt < QUIET_MS) return "typing";
	if (s.editorText.trim() !== "") return "text in the editor";
	return null;
}

/** The slice of Pi's ExtensionAPI this module uses (a fake in the tests). */
export type AutoReloadPi = Pick<ExtensionAPI, "sendUserMessage" | "registerCommand"> & {
	on(event: string, handler: (event: any, ctx: any) => unknown): unknown;
};

export interface AutoReloadOptions {
	host: PiAgentToolHost;
	/** resolveAutoReload(config, env), read once per extension instance. */
	enabled: boolean;
	/** Plannotator's own open work: a review, a plan review, an Ask question; null when none. */
	plannotatorBusy: () => string | null;
	/** Pi's version, or null when unknown (then: the note only). */
	piVersion: () => Promise<string | null>;
	/** Overridable for tests. */
	readOnDisk?: () => string | null;
	loaded?: string | null;
	now?: () => number;
	/** Tests drive `check()` themselves. */
	poll?: boolean;
}

export interface AutoReloadController {
	/**
	 * Whether another part (the Inbox's poll) may announce `version` now: once
	 * per version per process, and never while Pi will reload by itself.
	 */
	claimNotice(version: string): boolean;
	/** One poll now (the timer runs it every POLL_MS). */
	check(): void;
	/** Settles once the Pi version gate is decided. */
	ready: Promise<void>;
}

export function setupAutoReload(pi: AutoReloadPi, options: AutoReloadOptions): AutoReloadController {
	const now = options.now ?? Date.now;
	const readOnDisk = options.readOnDisk ?? (() => readPackageVersion());
	const loaded = options.loaded !== undefined ? options.loaded : loadedPackageVersion();
	const mayAuto = options.host === "pi" && options.enabled;
	/** Decided by the Pi version gate; until then nothing is reloaded and the note waits. */
	let auto = false;
	let decided = !mayAuto;
	let ctx: ExtensionContext | null = null;
	let running = false;
	let sawSettled = false;
	let compacting = false;
	let openPrompts = 0;
	let inputAt: number | null = null;
	let lastKeyAt: number | null = null;
	let candidate: { version: string; since: number } | null = null;
	const attempted = new Set<string>();
	let timer: ReturnType<typeof setInterval> | null = null;
	let stopKeys: (() => void) | null = null;

	const ready: Promise<void> = mayAuto
		? options
				.piVersion()
				.then(
					(v) => {
						auto = piSupportsAutoReload(v);
					},
					() => {
						auto = false;
					},
				)
				.finally(() => {
					decided = true;
				})
		: Promise.resolve();

	const hasUI = (c: ExtensionContext | null): boolean => {
		try {
			return !!c?.hasUI;
		} catch {
			return false;
		}
	};

	/** Pi will reload for `version` by itself (or may, once the gate is decided). */
	const autoWillHandle = (version: string): boolean => mayAuto && (!decided || auto) && !attempted.has(version) && hasUI(ctx);

	const state = (c: ExtensionContext): QuietState => {
		let idle = false;
		let pendingMessages = true;
		let editorText = "";
		try {
			idle = c.isIdle();
			pendingMessages = c.hasPendingMessages();
			const text = (c.ui as { getEditorText?: () => string }).getEditorText?.();
			editorText = typeof text === "string" ? text : "";
		} catch {
			// A replaced or closed session: never quiet.
			idle = false;
		}
		return {
			now: now(),
			running,
			idle,
			pendingMessages,
			compacting,
			openPrompts,
			inputAt,
			lastKeyAt,
			editorText,
			plannotatorBusy: options.plannotatorBusy(),
		};
	};

	const notify = (target: ExtensionContext | null, message: string, kind: "info" | "warning") => {
		try {
			target?.ui.notify(message, kind);
		} catch {
			// The session is gone.
		}
	};

	const sessionFree = (c: ExtensionContext): boolean => {
		if (running) return false;
		try {
			return c.isIdle();
		} catch {
			return false;
		}
	};

	const tick = () => {
		const c = ctx;
		if (!c || !hasUI(c) || !decided) return;
		const onDisk = readOnDisk();
		if (!onDisk || !loaded || onDisk === loaded) {
			candidate = null;
			return;
		}
		if (candidate?.version !== onDisk) {
			candidate = { version: onDisk, since: now() };
			return;
		}
		if (now() - candidate.since < STABLE_MS) return;
		if (!auto || attempted.has(onDisk)) {
			// Off, an older Pi, Oh My Pi, or the one try is spent: the note, once per version.
			if (sessionFree(c) && !noticed().has(onDisk)) {
				noticed().add(onDisk);
				notify(c, packageUpdatedMessage(loaded, onDisk, options.host), "warning");
			}
			return;
		}
		if (reloadBlockedBy(state(c)) !== null) return;
		attempted.add(onDisk);
		noticed().add(onDisk);
		store()[MARKER_KEY] = { from: loaded, to: onDisk, at: now() } satisfies ReloadMarker;
		try {
			pi.sendUserMessage(`/${AUTO_RELOAD_COMMAND} auto`, { expandPromptTemplates: true });
		} catch {
			clearMarker();
			notify(c, packageUpdatedMessage(loaded, onDisk, options.host), "warning");
		}
	};

	// Pi only: Oh My Pi's command context has no reload().
	if (options.host === "pi") pi.registerCommand(AUTO_RELOAD_COMMAND, {
		description: "Reload Pi to load the updated Plannotator (the same as /reload)",
		handler: async (args, cmdCtx) => {
			const automatic = args.trim() === "auto";
			if (automatic) {
				// Checked again here, in the command: the last moment before the reload.
				const marker = readMarker();
				if (!marker || reloadBlockedBy(state(cmdCtx)) !== null) {
					clearMarker();
					// Not a spent try: the next quiet moment tries again.
					if (marker) attempted.delete(marker.to);
					return;
				}
			}
			await cmdCtx.reload();
			// The new instance takes the marker in its session_start, before reload() returns.
			// Still here with the marker: the reload did not load a new Plannotator (Pi said why,
			// "Reload failed: …"), so the person gets the note and loads it themselves.
			const left = readMarker();
			if (automatic && left) {
				clearMarker();
				notify(cmdCtx, packageUpdatedMessage(left.from, left.to, options.host), "warning");
			}
		},
	});

	pi.on("session_start", (event, c: ExtensionContext) => {
		ctx = c;
		running = false;
		openPrompts = 0;
		inputAt = null;
		compacting = false;
		const marker = readMarker();
		if (marker && now() - marker.at >= MARKER_MAX_AGE_MS) clearMarker();
		else if (marker && (event as { reason?: string } | undefined)?.reason === "reload" && marker.to === loaded) {
			clearMarker();
			notify(c, autoReloadedText(marker.to), "info");
		}
		if (!hasUI(c)) return;
		stopKeys?.();
		stopKeys = null;
		try {
			stopKeys = c.ui.onTerminalInput(() => {
				lastKeyAt = now();
				return undefined;
			});
		} catch {
			stopKeys = null;
		}
		if (!timer && options.poll !== false) {
			void ready.then(() => {
				if (timer || !ctx) return;
				timer = setInterval(tick, POLL_MS);
				(timer as { unref?: () => void }).unref?.();
			});
		}
	});
	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		timer = null;
		stopKeys?.();
		stopKeys = null;
		ctx = null;
	});
	pi.on("input", () => {
		inputAt = now();
		return undefined;
	});
	pi.on("agent_start", () => {
		running = true;
		inputAt = null;
	});
	// Pi 0.80.4+ ends a run with agent_settled (after its follow-ups); before it, agent_end.
	pi.on("agent_end", () => {
		if (!sawSettled) running = false;
	});
	pi.on("agent_settled", () => {
		sawSettled = true;
		running = false;
	});
	pi.on("session_before_compact", () => {
		compacting = true;
		return undefined;
	});
	pi.on("session_compact", () => {
		compacting = false;
	});
	pi.on("session_compact_failed", () => {
		compacting = false;
	});
	pi.on("ui_prompt_start", () => {
		openPrompts++;
	});
	pi.on("ui_prompt_end", () => {
		openPrompts = Math.max(0, openPrompts - 1);
	});

	return {
		claimNotice(version: string) {
			if (autoWillHandle(version)) return false;
			if (noticed().has(version)) return false;
			noticed().add(version);
			return true;
		},
		check: tick,
		ready,
	};
}
