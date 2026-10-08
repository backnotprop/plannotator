/**
 * Plannotator Snapshots for Pi: `/plannotator-snapshot` and this session's
 * link to the Snapshots hub. The logic shared with the OpenCode plugin is
 * `packages/shared/snapshots/agent-link.ts` (vendored to
 * `generated/snapshots/`); this file is the Pi side of it.
 *
 * Decided once at extension load (one instance per session and per /reload):
 * only where the Snapshots switch is on (`PLANNOTATOR_SNAPSHOTS` /
 * `{ "snapshots": false }`, on by default for every agent). Off, nothing is
 * registered, no listener does anything, and no hub is contacted.
 *
 * Non-blocking, like `/plannotator-review`: the command runs
 * `plannotator snapshot --session pi:<id>` (starts the hub and the app, latches
 * this session, opens the capture overlay) and returns. The person's Send
 * arrives later as `pi.sendUserMessage(text, { deliverAs: "followUp" })`, the
 * text the hub composed (`packages/shared/snapshots/compose.ts`, identical on
 * every host), and counts as delivered when Pi starts that user message.
 * "Ask this session" from the HUD is a real turn of this session through the
 * same Pi session bridge the review servers use (`pi-session-bridge.ts`).
 *
 * Every interactive session links (a registry file check every 5 s, no
 * process), so a hotkey-started collection can go to the session the person
 * typed into last (`input` not from an extension). Capture is macOS only:
 * elsewhere the command explains and points at `plannotator snapshot add`;
 * Windows does not link at all.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { runPullSessionBridgeClient } from "./generated/ai/session-bridge-pull-client.ts";
import type { SessionBridge } from "./generated/ai/session-bridge.ts";
import { loadConfig, resolveSnapshotsEnabled } from "./generated/config.ts";
import { getPlannotatorDataDir } from "./generated/data-dir.ts";
import { SnapshotsAgentLink, summonSnapshots } from "./generated/snapshots/agent-link.ts";
import { getPiSessionIdentity, isCtxAlive, type PiSessionIdentity } from "./current-pi-session.ts";

export const PI_SNAPSHOTS_COMMAND = "plannotator-snapshot";
/** A send that has not entered the session after this long, while the session is idle, did not reach it. */
const DELIVERY_WATCHDOG_MS = 15_000;

type SnapshotsPi = Pick<ExtensionAPI, "registerCommand" | "sendUserMessage"> & {
	on(event: string, handler: (event: any, ctx?: any) => unknown): unknown;
};

export interface PiSnapshotsOptions {
	/** "Ask this session": the Pi session bridge for a ctx (pi-session-bridge.ts). */
	createBridge: (ctx: ExtensionContext, origin: PiSessionIdentity) => SessionBridge;
	/** Test seams. */
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	retryMs?: number;
}

function userText(message: { content?: unknown } | undefined): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: { type?: string; text?: unknown } | null) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
		.join("");
}

/** Called once at extension load. Returns whether Snapshots is on for this Pi. */
export function setupPiSnapshots(pi: SnapshotsPi, options: PiSnapshotsOptions): boolean {
	const env = options.env ?? process.env;
	if (!resolveSnapshotsEnabled(loadConfig(), env)) return false;
	const platform = options.platform ?? process.platform;
	const dataDir = getPlannotatorDataDir();
	const processId = randomBytes(6).toString("hex");

	let ctx: ExtensionContext | null = null;
	let link: SnapshotsAgentLink<SessionBridge> | null = null;
	/** Sends waiting to show up as a user message in the session. */
	const waiting = new Map<string, { text: string; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

	const endWaiting = (sendId: string, error?: Error) => {
		const entry = waiting.get(sendId);
		if (!entry) return;
		waiting.delete(sendId);
		clearTimeout(entry.timer);
		if (error) entry.reject(error);
		else entry.resolve();
	};

	const idleNow = (current: ExtensionContext): boolean => {
		try {
			return current.isIdle() && !current.hasPendingMessages();
		} catch {
			return false;
		}
	};

	const linkFor = (current: ExtensionContext): SnapshotsAgentLink<SessionBridge> | null => {
		if (platform === "win32") return null;
		const sessionId = current.sessionManager.getSessionId();
		if (link && link.sessionId === sessionId) return link;
		link?.dispose();
		link = new SnapshotsAgentLink<SessionBridge>({
			dataDir,
			host: "pi",
			sessionId,
			processId,
			cwd: current.cwd,
			title: current.sessionManager.getSessionName() ?? undefined,
			bridge: options.createBridge(current, getPiSessionIdentity(current)),
			ask: { turn: true, transient: false },
			runClient: runPullSessionBridgeClient,
			...(options.retryMs ? { retryMs: options.retryMs } : {}),
			target: {
				isBusy: () => {
					const live = ctx;
					return !live || !isCtxAlive(live) || !idleNow(live);
				},
				deliver: (text, sendId) =>
					new Promise<void>((resolve, reject) => {
						const watchdog = () => {
							const entry = waiting.get(sendId);
							if (!entry) return;
							const live = ctx;
							// Still busy (the person's run goes first): look again later.
							if (live && isCtxAlive(live) && !idleNow(live)) {
								entry.timer = setTimeout(watchdog, DELIVERY_WATCHDOG_MS);
								return;
							}
							endWaiting(sendId, new Error("the message did not reach the session"));
						};
						waiting.set(sendId, { text: text.trim(), resolve, reject, timer: setTimeout(watchdog, DELIVERY_WATCHDOG_MS) });
						try {
							pi.sendUserMessage(text, { deliverAs: "followUp" });
						} catch (error) {
							endWaiting(sendId, error instanceof Error ? error : new Error(String(error)));
						}
					}),
			},
			log: (line) => {
				if (env.PLANNOTATOR_DEBUG) console.error(line);
			},
		});
		link.start();
		return link;
	};

	pi.registerCommand(PI_SNAPSHOTS_COMMAND, {
		description: "Capture your screen with Plannotator Snapshots, mark it up, and send it here as one message; --app starts with an App Capture",
		handler: async (args: string | undefined, commandCtx: ExtensionContext) => {
			ctx = commandCtx;
			const current = linkFor(commandCtx);
			current?.noteHumanInput();
			const answer = await summonSnapshots({
				dataDir,
				host: "pi",
				sessionId: commandCtx.sessionManager.getSessionId(),
				args: args ?? "",
				cwd: commandCtx.cwd,
				platform,
				env,
			});
			// The hub may have just started: connect now rather than at the next registry check.
			current?.kick();
			commandCtx.ui.notify(answer.text, answer.ok ? "info" : "warning");
		},
	});

	pi.on("session_start", (_event, startCtx: ExtensionContext) => {
		ctx = startCtx;
		// Only a session with a person at it: a print/JSON run could never take a send later.
		if (startCtx.hasUI) linkFor(startCtx);
	});

	pi.on("session_shutdown", () => {
		link?.dispose();
		link = null;
		ctx = null;
		for (const sendId of [...waiting.keys()]) endWaiting(sendId, new Error("the session ended"));
	});

	// A person typed here: a hotkey-started collection goes to the session typed into last.
	pi.on("input", (event) => {
		if (event?.source !== "extension") link?.noteHumanInput(typeof event?.text === "string" ? event.text : undefined);
	});

	pi.on("message_start", (event) => {
		const message = event?.message as { role?: string; content?: unknown } | undefined;
		if (message?.role !== "user" || waiting.size === 0) return;
		const text = userText(message).trim();
		for (const [sendId, entry] of waiting) {
			if (entry.text === text) {
				endWaiting(sendId);
				return;
			}
		}
	});

	return true;
}
