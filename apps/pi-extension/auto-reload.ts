import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadedPackageVersion, packageInstallSettled, packageUpdatedMessage, readPackageVersion } from "./package-version.ts";
import type { PiAgentToolHost } from "./pi-host.ts";

export const AUTO_RELOAD_COMMAND = "plannotator-reload";
export const STABLE_MS = 10_000;
export const INSTALL_STUCK_MS = 5 * 60_000;
export const QUIET_MS = 15_000;
export const INPUT_GRACE_MS = 30_000;
export const POLL_MS = 2_000;
export const TREE_HOLD_MAX_MS = 5 * 60_000;
const MARKER_MAX_AGE_MS = 60_000;
export const MIN_PI_FOR_AUTO_RELOAD = "0.84.2";

const MARKER_KEY = "__plannotatorAutoReload_v1";
const NOTICED_KEY = "__plannotatorUpdateNoticed_v1";
const TRIED_KEY = "__plannotatorAutoReloadTried_v1";

interface ReloadMarker {
	from: string | null;
	to: string;
	at: number;
}

function store(): Record<string, unknown> {
	return globalThis as unknown as Record<string, unknown>;
}

function processSet(key: string): Set<string> {
	const s = store();
	const existing = s[key];
	if (existing instanceof Set) return existing as Set<string>;
	const fresh = new Set<string>();
	s[key] = fresh;
	return fresh;
}

function noticed(): Set<string> {
	return processSet(NOTICED_KEY);
}

function readMarker(): ReloadMarker | undefined {
	const marker = store()[MARKER_KEY] as ReloadMarker | undefined;
	return marker && typeof marker.to === "string" ? marker : undefined;
}

function clearMarker(): void {
	delete store()[MARKER_KEY];
}

export function autoReloadedText(to: string): string {
	return `Plannotator updated to ${to}. Pi reloaded while idle.`;
}

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

export type AutoReloadPi = Pick<ExtensionAPI, "sendUserMessage" | "registerCommand"> & {
	on(event: string, handler: (event: any, ctx: any) => unknown): unknown;
	getCommands?: () => ReadonlyArray<{ name: string; source?: string }>;
};

const COMMAND_TEXT = new RegExp(`^/${AUTO_RELOAD_COMMAND}(?:\\s|$)`);

export interface AutoReloadOptions {
	host: PiAgentToolHost;
	enabled: boolean;
	plannotatorBusy: () => string | null;
	piVersion: () => Promise<string | null>;
	readOnDisk?: () => string | null;
	installSettled?: () => boolean;
	loaded?: string | null;
	now?: () => number;
	poll?: boolean;
}

export interface AutoReloadController {
	claimNotice(version: string): boolean;
	check(): void;
	ready: Promise<void>;
}

export function setupAutoReload(pi: AutoReloadPi, options: AutoReloadOptions): AutoReloadController {
	const now = options.now ?? Date.now;
	const readOnDisk = options.readOnDisk ?? (() => readPackageVersion());
	const installSettled = options.installSettled ?? (() => packageInstallSettled());
	const loaded = options.loaded !== undefined ? options.loaded : loadedPackageVersion();
	const mayAuto = options.host === "pi" && options.enabled;
	let auto = false;
	let decided = !mayAuto;
	let ctx: ExtensionContext | null = null;
	let running = false;
	let sawSettled = false;
	let compacting = false;
	let treeAt: number | null = null;
	let openPrompts = 0;
	let inputAt: number | null = null;
	let lastKeyAt: number | null = null;
	let candidate: { version: string; seen: number; since: number } | null = null;
	const attempted = processSet(TRIED_KEY);
	let afterReload: { message: string; kind: "info" | "warning" } | null = null;
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
			idle = false;
		}
		return {
			now: now(),
			running,
			idle,
			pendingMessages,
			compacting: compacting || (treeAt !== null && now() - treeAt < TREE_HOLD_MAX_MS),
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

	const commandReachable = (): boolean => {
		try {
			const commands = pi.getCommands?.();
			if (!Array.isArray(commands)) return true;
			return commands.some((cmd) => cmd?.name === AUTO_RELOAD_COMMAND && (cmd.source === undefined || cmd.source === "extension"));
		} catch {
			return true;
		}
	};

	const tick = () => {
		const c = ctx;
		if (!c || !hasUI(c)) return;
		if (afterReload) {
			notify(c, afterReload.message, afterReload.kind);
			afterReload = null;
		}
		if (!decided) return;
		const onDisk = readOnDisk();
		if (!onDisk || !loaded || onDisk === loaded) {
			candidate = null;
			return;
		}
		if (candidate?.version !== onDisk) {
			candidate = { version: onDisk, seen: now(), since: now() };
			return;
		}
		const settled = installSettled();
		if (!settled) candidate.since = now();
		const stuck = !settled && now() - candidate.seen >= INSTALL_STUCK_MS;
		if (!stuck && now() - candidate.since < STABLE_MS) return;
		if (!auto || attempted.has(onDisk) || stuck) {
			if (sessionFree(c) && !noticed().has(onDisk)) {
				noticed().add(onDisk);
				notify(c, packageUpdatedMessage(loaded, onDisk, options.host), "warning");
			}
			return;
		}
		if (reloadBlockedBy(state(c)) !== null) return;
		attempted.add(onDisk);
		noticed().add(onDisk);
		if (!commandReachable()) {
			notify(c, packageUpdatedMessage(loaded, onDisk, options.host), "warning");
			return;
		}
		store()[MARKER_KEY] = { from: loaded, to: onDisk, at: now() } satisfies ReloadMarker;
		try {
			pi.sendUserMessage(`/${AUTO_RELOAD_COMMAND} auto`, { expandPromptTemplates: true });
		} catch {
			clearMarker();
			notify(c, packageUpdatedMessage(loaded, onDisk, options.host), "warning");
		}
	};

	if (options.host === "pi") pi.registerCommand(AUTO_RELOAD_COMMAND, {
		description: "Reload Pi to load the updated Plannotator (the same as /reload)",
		handler: async (args, cmdCtx) => {
			const automatic = args.trim() === "auto";
			if (automatic) {
				const marker = readMarker();
				if (!marker || reloadBlockedBy(state(cmdCtx)) !== null) {
					clearMarker();
					if (marker) attempted.delete(marker.to);
					return;
				}
			}
			await cmdCtx.reload();
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
		treeAt = null;
		const marker = readMarker();
		if (marker && now() - marker.at >= MARKER_MAX_AGE_MS) clearMarker();
		else if (marker && (event as { reason?: string } | undefined)?.reason === "reload") {
			clearMarker();
			if (marker.to === loaded) afterReload = { message: autoReloadedText(marker.to), kind: "info" };
			else {
				afterReload = { message: packageUpdatedMessage(loaded, marker.to, options.host), kind: "warning" };
			}
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
	pi.on("input", (event, c: ExtensionContext) => {
		const text = typeof event?.text === "string" ? event.text.trim() : "";
		if (COMMAND_TEXT.test(text)) {
			const marker = readMarker();
			if (marker && text.slice(AUTO_RELOAD_COMMAND.length + 1).trim() === "auto") {
				clearMarker();
				notify(c ?? ctx, packageUpdatedMessage(marker.from, marker.to, options.host), "warning");
			}
			return { action: "handled" };
		}
		inputAt = now();
		return undefined;
	});
	pi.on("agent_start", () => {
		running = true;
		inputAt = null;
	});
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
	pi.on("session_before_tree", (event) => {
		const started = now();
		treeAt = started;
		const signal = (event as { signal?: AbortSignal } | undefined)?.signal;
		try {
			signal?.addEventListener(
				"abort",
				() => {
					if (treeAt === started) treeAt = null;
				},
				{ once: true },
			);
		} catch {
		}
		return undefined;
	});
	pi.on("session_tree", () => {
		treeAt = null;
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
