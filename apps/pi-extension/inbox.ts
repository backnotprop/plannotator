import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { loadConfig, resolveInboxReminder, resolveInboxReminderText, resolveInboxTool } from "./generated/config.ts";
import { getPlannotatorDataDir } from "./generated/data-dir.ts";
import {
	discoverInboxTools,
	InboxAgentConnection,
	inboxRegistryFileOf,
	InboxWake,
} from "./generated/inbox/agent-link.ts";
import { inboxAgentTool, type InboxReplyCommand } from "./generated/inbox/connection.ts";
import { releasePiSessionClaim, writePiSessionClaim } from "./generated/inbox/pi-session-claim.ts";
import { isCtxAlive, resolveIdleDeliveryOptions } from "./current-pi-session.ts";
import { loadedPackageVersion, packageUpdatedMessage, readPackageVersion } from "./package-version.ts";
import { detectPiHost } from "./pi-host.ts";

const ON_DISK_FRESH_MS = 2_000;
let onDiskCache: { at: number; value: string | null } | null = null;

function readOnDiskVersion(): string | null {
	if (onDiskCache && Date.now() - onDiskCache.at < ON_DISK_FRESH_MS) return onDiskCache.value;
	const value = readPackageVersion();
	onDiskCache = { at: Date.now(), value };
	return value;
}
import { PI_INBOX_REMINDER_CUSTOM_TYPE } from "./pi-session-bridge.ts";

export { PI_INBOX_REMINDER_CUSTOM_TYPE };

export const PI_INBOX_HOST = "pi";
export const PI_INBOX_AGENT_NAME = "Pi";
const DELIVERY_WATCHDOG_MS = 15_000;

const NOT_ACTIVE_ON_REGISTRATION = { defaultActive: false } as const;

type InboxPi = Pick<ExtensionAPI, "registerTool" | "sendUserMessage" | "getActiveTools" | "setActiveTools"> & {
	on(event: string, handler: (event: any, ctx?: any) => unknown): unknown;
};

export interface PiInboxOptions {
	isAskActive: () => boolean;
	claimUpdateNotice?: (version: string) => boolean;
}

export function inboxUpdateNotice(
	loaded: string | null,
	onDisk: string | null,
	alreadyTold: string | null,
	claim: ((version: string) => boolean) | undefined,
	host: "pi" | "oh-my-pi",
): string | null {
	if (!loaded || !onDisk || onDisk === loaded || onDisk === alreadyTold) return null;
	if (claim && !claim(onDisk)) return null;
	return packageUpdatedMessage(loaded, onDisk, host);
}

export function editorWithout(editor: string, text: string): string | null {
	const at = text ? editor.indexOf(text) : -1;
	if (at < 0) return null;
	let before = editor.slice(0, at);
	let after = editor.slice(at + text.length);
	if (before.endsWith("\n\n")) before = before.slice(0, -2);
	if (after.startsWith("\n\n")) after = after.slice(2);
	return before && after ? `${before}\n\n${after}` : before + after;
}

function takeOutOfEditor(current: ExtensionContext, text: string): void {
	try {
		const ui = current.ui as { getEditorText?: () => string; setEditorText?: (text: string) => void };
		const editor = ui.getEditorText?.();
		if (typeof editor !== "string") return;
		const rest = editorWithout(editor, text);
		if (rest !== null) ui.setEditorText?.(rest);
	} catch {
	}
}

export function setupPiInbox(pi: InboxPi, options: PiInboxOptions): Promise<void> | undefined {
	const dataDir = getPlannotatorDataDir();
	if (!existsSync(inboxRegistryFileOf(dataDir))) return undefined;
	claimPiSessions(pi, dataDir);
	const config = loadConfig();
	if (!resolveInboxTool(config, process.env, "pi")) return undefined;
	const reminder = resolveInboxReminder(config, process.env, "pi") ? resolveInboxReminderText(config, "pi") : null;
	return discoverInboxTools(dataDir).then((tools) => {
		if (!tools) return;
		registerPiInbox(
			pi,
			new InboxAgentConnection({ dataDir, host: PI_INBOX_HOST, agentName: PI_INBOX_AGENT_NAME, tools }),
			{ ...options, reminder },
		);
	});
}

function claimPiSessions(pi: InboxPi, dataDir: string): void {
	const owner = randomUUID();
	const at = process.argv.indexOf("--mode");
	const rpc = (at >= 0 && process.argv[at + 1] === "rpc") || /-rpc$/.test(process.title);
	let claimed: string | null = null;
	const release = () => {
		if (claimed) releasePiSessionClaim(dataDir, claimed, process.pid, owner);
		claimed = null;
	};
	pi.on("session_start", (_event, startCtx: ExtensionContext) => {
		let session: string;
		try {
			session = startCtx.sessionManager.getSessionId();
		} catch {
			return;
		}
		if (claimed && claimed !== session) release();
		claimed = session;
		writePiSessionClaim(dataDir, { session, pid: process.pid, rpc, title: process.title, owner });
	});
	pi.on("session_shutdown", release);
}

type BranchEntry = { id?: string; type?: string; customType?: string; firstKeptEntryId?: string };

export function entriesCarryReminder(entries: readonly BranchEntry[]): boolean {
	let from = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "compaction") continue;
		const kept = entries.findIndex((candidate) => candidate?.id !== undefined && candidate.id === entry.firstKeptEntryId);
		from = kept >= 0 ? kept : i;
		break;
	}
	return entries.slice(from).some((entry) => entry?.type === "custom_message" && entry.customType === PI_INBOX_REMINDER_CUSTOM_TYPE);
}

async function sessionThreadsOf(connection: InboxAgentConnection, current: ExtensionContext | null): Promise<string | null> {
	if (!current || !isCtxAlive(current)) return null;
	try {
		return await connection.sessionThreads({ sessionId: current.sessionManager.getSessionId(), cwd: current.cwd });
	} catch {
		return null;
	}
}

function branchHasReminder(ctx: ExtensionContext): boolean {
	try {
		return entriesCarryReminder(ctx.sessionManager.getBranch() as BranchEntry[]);
	} catch {
		return true;
	}
}

function userText(message: { content?: unknown } | undefined): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: { type?: string; text?: unknown } | null) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
		.join("");
}

export function exportPiSessionProject(env: Record<string, string | undefined>, ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): void {
	try {
		env.PLANNOTATOR_SESSION_PROJECT = `${PI_INBOX_HOST}:${ctx.sessionManager.getSessionId()}:${ctx.cwd}`;
	} catch {
	}
}

function registerPiInbox(pi: InboxPi, connection: InboxAgentConnection, options: PiInboxOptions & { reminder: string | null }): void {
	const spec = inboxAgentTool(connection.tools);
	const ohMyPi = detectPiHost(pi) === "oh-my-pi";
	if (!spec) return;

	pi.registerTool({
		name: spec.name,
		label: "Plannotator Inbox",
		description: spec.description,
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
	let notifiedOnDisk: string | null = null;
	let activationSettled = false;
	let toolActive = false;
	let reminderDelivered = false;
	let settleEvents = false;
	let runOpen = false;
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

	const send = (text: string, command: InboxReplyCommand, deliverAs: "followUp" | "steer") =>
		new Promise<void>((resolve, reject) => {
			const current = ctx;
			const watchdog = () => {
				if (waiting?.id !== command.id) return;
				if (current && isCtxAlive(current) && !idleNow(current)) {
					waiting.timer = setTimeout(watchdog, DELIVERY_WATCHDOG_MS);
					return;
				}
				if (deliverAs === "steer" && current && isCtxAlive(current)) takeOutOfEditor(current, text);
				endWaiting(new Error("the message did not reach the session"));
			};
			waiting = { id: command.id, resolve, reject, timer: setTimeout(watchdog, DELIVERY_WATCHDOG_MS) };
			try {
				pi.sendUserMessage(text, resolveIdleDeliveryOptions(current ?? undefined, { deliverAs }));
			} catch (error) {
				endWaiting(error instanceof Error ? error : new Error(String(error)));
			}
		});

	const target = {
		canSteer: () => !options.isAskActive(),
		isBusy: () => {
			const current = ctx;
			if (!current || !isCtxAlive(current) || !idleNow(current)) return true;
			if (options.isAskActive()) return true;
			return settleEvents && runOpen;
		},
		deliver: (text: string, command: InboxReplyCommand) => send(text, command, "followUp"),
		steer: (text: string, command: InboxReplyCommand) => send(text, command, "steer"),
		notify: (message: string) => {
			try {
				ctx?.ui.notify(message, "warning");
			} catch {
			}
		},
		plugin: () => {
			const version = loadedPackageVersion();
			if (!version) return null;
			const onDisk = readOnDiskVersion();
			const note = inboxUpdateNotice(version, onDisk, notifiedOnDisk, options.claimUpdateNotice, ohMyPi ? "oh-my-pi" : "pi");
			if (note) {
				notifiedOnDisk = onDisk;
				try {
					ctx?.ui.notify(note, "warning");
				} catch {
				}
			}
			return { version, on_disk: onDisk, host: ohMyPi ? ("oh-my-pi" as const) : ("pi" as const) };
		},
		projectPath: () => {
			const current = ctx;
			if (!current || !isCtxAlive(current)) return null;
			try {
				return current.cwd;
			} catch {
				return null;
			}
		},
		label: () => {
			const current = ctx;
			if (!current || !isCtxAlive(current)) return null;
			try {
				return current.sessionManager.getSessionName() ?? "";
			} catch {
				return null;
			}
		},
	};

	pi.on("tool_call", (event: { toolName?: unknown } | undefined, callCtx: ExtensionContext) => {
		if (event?.toolName === "bash") exportPiSessionProject(process.env, callCtx);
	});

	pi.on("session_start", (_event, startCtx: ExtensionContext) => {
		ctx = startCtx;
		if (!activationSettled) {
			activationSettled = true;
			const active = pi.getActiveTools();
			const isActive = active.includes(spec.name);
			if (startCtx.hasUI && !isActive) pi.setActiveTools([...active, spec.name]);
			else if (!startCtx.hasUI && isActive) pi.setActiveTools(active.filter((tool) => tool !== spec.name));
			toolActive = startCtx.hasUI;
		}
		reminderDelivered = branchHasReminder(startCtx);
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

	const reminderText = options.reminder;
	if (reminderText) {
		let afterCompaction = false;
		pi.on("before_agent_start", async (_event, agentCtx: ExtensionContext) => {
			if (!toolActive || reminderDelivered) return undefined;
			reminderDelivered = true;
			let content = reminderText;
			if (afterCompaction) {
				afterCompaction = false;
				const threads = await sessionThreadsOf(connection, agentCtx ?? ctx);
				if (threads) content = `${reminderText}\n\n${threads}`;
			}
			return {
				message: { customType: PI_INBOX_REMINDER_CUSTOM_TYPE, content, display: false },
			};
		});
		pi.on("session_compact", (_event, compactCtx: ExtensionContext) => {
			reminderDelivered = compactCtx ? branchHasReminder(compactCtx) : false;
			afterCompaction = !reminderDelivered;
		});
		pi.on("session_tree", (_event, treeCtx: ExtensionContext) => {
			reminderDelivered = branchHasReminder(treeCtx);
		});
	}

	pi.on("session_shutdown", () => {
		wake?.dispose();
		wake = null;
		ctx = null;
		endWaiting(new Error("the session ended"));
	});

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
