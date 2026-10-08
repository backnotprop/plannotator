/**
 * The Pi connection to the Plannotator Inbox (plan step 7): the
 * `plannotator_inbox` tool and the reply wake. The logic shared with the
 * OpenCode plugin is `packages/shared/inbox/agent-link.ts` (vendored to
 * `generated/inbox/`); this file is the Pi side of it.
 *
 * Found or not, decided once at extension load: only where the inbox tool
 * switch allows it for Pi (`PLANNOTATOR_INBOX_TOOL` / `inboxTool`, off by
 * default here: Pi sends every tool's full definition with each request) AND
 * `inbox/inbox.json` exists (the person ran the Inbox once). Otherwise nothing
 * is registered, nothing listens, nothing polls, and nothing is said.
 *
 * The tool is registered at load with the actions the Inbox's `/mcp` offers
 * (discovery bounded at 2 s; the factory awaits it), inactive on registration
 * (Pi 0.99+), and made active by the first `session_start` with an
 * interactive UI, never touched again: the tool list is part of the prompt
 * prefix. A print/JSON run has it inactive (nothing could wake that session).
 *
 * The wake: a reply waits here until the session is idle (`ctx.isIdle()`, no
 * queued messages, no "Ask this session" question running, and the last run
 * settled: `agent_settled` where Pi has it, idle alone on older Pi), goes in
 * with `pi.sendUserMessage(text, { deliverAs: "followUp" })` (a follow-up
 * never steers into a run that started in the same instant), and counts as
 * delivered when Pi starts that user message. Nothing here ever aborts a
 * run, so a prompt typed into the wake's turn takes it over, the rule of
 * `pi-session-bridge.ts`'s run protection, and the reply is never sent again.
 * Listeners are registered once, at load (`pi.on` has no unsubscribe before 1.0).
 *
 * Two Pi processes on one session (`pi -c` or `--session` twice): the one the
 * person used last delivers. A session start, a prompt the person submits
 * (`input` not from an extension) and a `plannotator_inbox` call touch the
 * session's lease in `InboxWake`; the other process defers while it is live.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { loadConfig, resolveInboxTool } from "./generated/config.ts";
import { getPlannotatorDataDir } from "./generated/data-dir.ts";
import {
	discoverInboxTools,
	InboxAgentConnection,
	inboxRegistryFileOf,
	InboxWake,
} from "./generated/inbox/agent-link.ts";
import { inboxAgentTool, type InboxReplyCommand } from "./generated/inbox/connection.ts";
import { isCtxAlive } from "./current-pi-session.ts";

export const PI_INBOX_HOST = "pi";
export const PI_INBOX_AGENT_NAME = "Pi";
/** A wake that has not entered the session after this long, while the session is idle, did not reach it. */
const DELIVERY_WATCHDOG_MS = 15_000;

/** `defaultActive: false`, spread in: the Pi floor's types (0.79.1) do not declare it. */
const NOT_ACTIVE_ON_REGISTRATION = { defaultActive: false } as const;

type InboxPi = Pick<ExtensionAPI, "registerTool" | "sendUserMessage" | "getActiveTools" | "setActiveTools"> & {
	on(event: string, handler: (event: any, ctx?: any) => unknown): unknown;
};

export interface PiInboxOptions {
	/** An "Ask this session" question is running (the session bridge hub). */
	isAskActive: () => boolean;
}

/**
 * Called once at extension load. Returns the discovery to await when the
 * Inbox connection applies to this Pi; undefined (and nothing done) otherwise.
 */
export function setupPiInbox(pi: InboxPi, options: PiInboxOptions): Promise<void> | undefined {
	if (!resolveInboxTool(loadConfig(), process.env, "pi")) return undefined;
	const dataDir = getPlannotatorDataDir();
	if (!existsSync(inboxRegistryFileOf(dataDir))) return undefined;
	return discoverInboxTools(dataDir).then((tools) => {
		if (!tools) return;
		registerPiInbox(
			pi,
			new InboxAgentConnection({ dataDir, host: PI_INBOX_HOST, agentName: PI_INBOX_AGENT_NAME, tools }),
			options,
		);
	});
}

function userText(message: { content?: unknown } | undefined): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: { type?: string; text?: unknown } | null) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
		.join("");
}

function registerPiInbox(pi: InboxPi, connection: InboxAgentConnection, options: PiInboxOptions): void {
	const spec = inboxAgentTool(connection.tools);
	if (!spec) return;

	pi.registerTool({
		name: spec.name,
		label: "Plannotator Inbox",
		description: spec.description,
		// Plain JSON Schema, which Pi validates since 0.79.1 (the peer floor).
		parameters: spec.inputSchema as any,
		...NOT_ACTIVE_ON_REGISTRATION,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			wake?.touch();
			const result = await connection.callTool(params, { sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, wakes: wake !== null });
			if (result.isError) throw new Error(result.text);
			return { content: [{ type: "text", text: result.text }], details: {} };
		},
	});

	let ctx: ExtensionContext | null = null;
	let wake: InboxWake | null = null;
	let activationSettled = false;
	/** Pi emits `agent_settled` (0.80.4+): a run counts as over only when it settled. */
	let settleEvents = false;
	let runOpen = false;
	/** The wake waiting to show up as a user message in the session. */
	let waiting: { id: string; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;

	const endWaiting = (error?: Error) => {
		const entry = waiting;
		if (!entry) return;
		waiting = null;
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

	const target = {
		isBusy: () => {
			const current = ctx;
			if (!current || !isCtxAlive(current) || !idleNow(current)) return true;
			if (options.isAskActive()) return true;
			return settleEvents && runOpen;
		},
		deliver: (text: string, command: InboxReplyCommand) =>
			new Promise<void>((resolve, reject) => {
				const current = ctx;
				const watchdog = () => {
					if (waiting?.id !== command.id) return;
					// Still busy (Pi preparing the run, or the person's run first): look again later.
					if (current && isCtxAlive(current) && !idleNow(current)) {
						waiting.timer = setTimeout(watchdog, DELIVERY_WATCHDOG_MS);
						return;
					}
					endWaiting(new Error("the message did not reach the session"));
				};
				waiting = { id: command.id, resolve, reject, timer: setTimeout(watchdog, DELIVERY_WATCHDOG_MS) };
				try {
					pi.sendUserMessage(text, { deliverAs: "followUp" });
				} catch (error) {
					endWaiting(error instanceof Error ? error : new Error(String(error)));
				}
			}),
		notify: (message: string) => {
			try {
				ctx?.ui.notify(message, "warning");
			} catch {
				// The session is gone: the reply stays readable in the Inbox.
			}
		},
	};

	pi.on("session_start", (_event, startCtx: ExtensionContext) => {
		ctx = startCtx;
		if (!activationSettled) {
			activationSettled = true;
			const active = pi.getActiveTools();
			const isActive = active.includes(spec.name);
			if (startCtx.hasUI && !isActive) pi.setActiveTools([...active, spec.name]);
			else if (!startCtx.hasUI && isActive) pi.setActiveTools(active.filter((tool) => tool !== spec.name));
		}
		const sessionId = startCtx.sessionManager.getSessionId();
		if (wake && wake.sessionId !== sessionId) {
			wake.dispose();
			wake = null;
		}
		if (!wake && startCtx.hasUI) {
			wake = new InboxWake(connection, sessionId, target);
			wake.start();
		}
	});

	pi.on("session_shutdown", () => {
		wake?.dispose();
		wake = null;
		ctx = null;
		endWaiting(new Error("the session ended"));
	});

	// The person submitted something: their turn goes first, and replies follow them to this process.
	pi.on("input", (event) => {
		wake?.onForeignPrompt();
		if (event?.source !== "extension") wake?.touch();
	});
	pi.on("agent_start", () => {
		runOpen = true;
	});
	pi.on("agent_settled", () => {
		settleEvents = true;
		runOpen = false;
	});
	pi.on("message_start", (event) => {
		const message = event?.message as { role?: string; content?: unknown } | undefined;
		if (message?.role !== "user" || !waiting) return;
		const firstLine = userText(message).split("\n", 1)[0] ?? "";
		if (firstLine.startsWith("Plannotator Inbox: ") && firstLine.endsWith(`(${waiting.id})`)) endWaiting();
	});
}
