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
 * delivered when Pi starts that user message. Send now (the person pressed
 * it in the Inbox; the command's `now`) goes in at once instead: as a
 * `deliverAs: "steer"` while a run is going, which Pi reads after the run's
 * current tool calls, else as the follow-up. Nothing here ever aborts a
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
import { loadConfig, resolveInboxReminder, resolveInboxReminderText, resolveInboxTool } from "./generated/config.ts";
import { getPlannotatorDataDir } from "./generated/data-dir.ts";
import {
	discoverInboxTools,
	InboxAgentConnection,
	inboxRegistryFileOf,
	InboxWake,
} from "./generated/inbox/agent-link.ts";
import { inboxAgentTool, type InboxReplyCommand } from "./generated/inbox/connection.ts";
import { isCtxAlive } from "./current-pi-session.ts";
import { loadedPackageVersion, packageUpdatedMessage, readPackageVersion } from "./package-version.ts";
import { detectPiHost } from "./pi-host.ts";

/** How long a read of package.json on disk is reused: every poll asks. */
const ON_DISK_FRESH_MS = 2_000;
let onDiskCache: { at: number; value: string | null } | null = null;

/** The extension's version on disk now (null: unreadable or gone), read at most once per 2 s. */
function readOnDiskVersion(): string | null {
	if (onDiskCache && Date.now() - onDiskCache.at < ON_DISK_FRESH_MS) return onDiskCache.value;
	const value = readPackageVersion();
	onDiskCache = { at: Date.now(), value };
	return value;
}
import { PI_INBOX_REMINDER_CUSTOM_TYPE } from "./pi-session-bridge.ts";

/**
 * The Inbox reminder's custom message (INBOX_REMINDER_TEXT, `display: false`),
 * delivered once per session by `before_agent_start`. Defined beside the "Ask
 * this session" bridge, which never reads it as a take-over.
 */
export { PI_INBOX_REMINDER_CUSTOM_TYPE };

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
 * The editor without `text` (Pi joins restored queued messages and the draft
 * with a blank line): the joint closes up, the person's own words stay.
 */
export function editorWithout(editor: string, text: string): string | null {
	const at = text ? editor.indexOf(text) : -1;
	if (at < 0) return null;
	let before = editor.slice(0, at);
	let after = editor.slice(at + text.length);
	if (before.endsWith("\n\n")) before = before.slice(0, -2);
	if (after.startsWith("\n\n")) after = after.slice(2);
	return before && after ? `${before}\n\n${after}` : before + after;
}

/** Takes `text` out of the session's editor, where Pi puts queued messages when a run is aborted. Best effort. */
function takeOutOfEditor(current: ExtensionContext, text: string): void {
	try {
		const ui = current.ui as { getEditorText?: () => string; setEditorText?: (text: string) => void };
		const editor = ui.getEditorText?.();
		if (typeof editor !== "string") return;
		const rest = editorWithout(editor, text);
		if (rest !== null) ui.setEditorText?.(rest);
	} catch {
		// No editor (a session without UI): nothing was moved there.
	}
}

/**
 * Called once at extension load. Returns the discovery to await when the
 * Inbox connection applies to this Pi; undefined (and nothing done) otherwise.
 */
export function setupPiInbox(pi: InboxPi, options: PiInboxOptions): Promise<void> | undefined {
	const config = loadConfig();
	if (!resolveInboxTool(config, process.env, "pi")) return undefined;
	const dataDir = getPlannotatorDataDir();
	if (!existsSync(inboxRegistryFileOf(dataDir))) return undefined;
	// Decided with the tool, once per extension instance (each session, /reload):
	// the line (the person's own from config.json prompts.inbox, else
	// INBOX_REMINDER_TEXT), or null when the reminder is off.
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

type BranchEntry = { id?: string; type?: string; customType?: string; firstKeptEntryId?: string };

/**
 * Whether the context the model reads on this path already carries the
 * reminder (a resumed or reloaded session, a branch that had it): a reminder
 * entry the latest compaction kept (from its first kept entry on), or any one
 * when nothing was compacted. Exported for the tests.
 */
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

function branchHasReminder(ctx: ExtensionContext): boolean {
	try {
		return entriesCarryReminder(ctx.sessionManager.getBranch() as BranchEntry[]);
	} catch {
		// Unknown: say nothing rather than twice.
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

function registerPiInbox(pi: InboxPi, connection: InboxAgentConnection, options: PiInboxOptions & { reminder: string | null }): void {
	const spec = inboxAgentTool(connection.tools);
	const ohMyPi = detectPiHost(pi) === "oh-my-pi";
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
	/** The on-disk version the session was last told about (#2085's message, once per version). */
	let notifiedOnDisk: string | null = null;
	let activationSettled = false;
	/** The tool is active in this instance's session (an interactive UI): only then is there a reminder to give. */
	let toolActive = false;
	/** The reminder is already in the session's current path; set from the branch at session start and /tree. */
	let reminderDelivered = false;
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

	/** Put the wake text into the session and wait until Pi starts it as a user message. */
	const send = (text: string, command: InboxReplyCommand, deliverAs: "followUp" | "steer") =>
		new Promise<void>((resolve, reject) => {
			const current = ctx;
			const watchdog = () => {
				if (waiting?.id !== command.id) return;
				// Still busy (Pi preparing the run, or the person's run first): look again later.
				if (current && isCtxAlive(current) && !idleNow(current)) {
					waiting.timer = setTimeout(watchdog, DELIVERY_WATCHDOG_MS);
					return;
				}
				// A steer that never started: the person pressed Esc during the run, and Pi moved its
				// queued messages into the editor. Take ours back out, so the reply, which now waits for
				// idle and arrives as a follow-up, is not also sent a second time from the editor.
				if (deliverAs === "steer" && current && isCtxAlive(current)) takeOutOfEditor(current, text);
				endWaiting(new Error("the message did not reach the session"));
			};
			waiting = { id: command.id, resolve, reject, timer: setTimeout(watchdog, DELIVERY_WATCHDOG_MS) };
			try {
				pi.sendUserMessage(text, { deliverAs });
			} catch (error) {
				endWaiting(error instanceof Error ? error : new Error(String(error)));
			}
		});

	const target = {
		// Never steer into this session's own "Ask this session" question (its answer streams to
		// Plannotator; the Claude Code mod's rule): the reply waits for idle, and the poll stops offering Send now.
		canSteer: () => !options.isAskActive(),
		isBusy: () => {
			const current = ctx;
			if (!current || !isCtxAlive(current) || !idleNow(current)) return true;
			if (options.isAskActive()) return true;
			return settleEvents && runOpen;
		},
		deliver: (text: string, command: InboxReplyCommand) => send(text, command, "followUp"),
		// Send now while a run is going: a steer, which Pi puts into the run after its current tool calls.
		steer: (text: string, command: InboxReplyCommand) => send(text, command, "steer"),
		notify: (message: string) => {
			try {
				ctx?.ui.notify(message, "warning");
			} catch {
				// The session is gone: the reply stays readable in the Inbox.
			}
		},
		// What this process loaded and what is on disk now, and which host (owner approval "reload-hosts"):
		// the Inbox says `/reload` (Oh My Pi `/restart`) when the package changed under the session, or
		// the update and the reload when both are behind it. The first time the files on disk differ, the
		// session hears it once, before a command fails (#2085).
		plugin: () => {
			const version = loadedPackageVersion();
			if (!version) return null;
			const onDisk = readOnDiskVersion();
			if (onDisk && onDisk !== version && notifiedOnDisk !== onDisk) {
				notifiedOnDisk = onDisk;
				try {
					ctx?.ui.notify(packageUpdatedMessage(version, onDisk, ohMyPi ? "oh-my-pi" : "pi"), "warning");
				} catch {
					// No UI: the Inbox still says it.
				}
			}
			return { version, on_disk: onDisk, host: ohMyPi ? ("oh-my-pi" as const) : ("pi" as const) };
		},
		// The session's working folder, so the Inbox lists it under its project from its first poll.
		projectPath: () => {
			const current = ctx;
			if (!current || !isCtxAlive(current)) return null;
			try {
				return current.cwd;
			} catch {
				return null;
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

	// The reminder (INBOX_REMINDER_TEXT): one hidden custom message on the
	// session's first prompt, only where the tool is active and `inboxReminder`
	// allows it. A conversation-suffix append, never `systemPrompt`, so it
	// moves no cached prefix. Not again after /reload or /resume (the branch
	// already holds it); again after a compaction that summarized it away
	// (which has invalidated the cache anyway, the plan framing's rule).
	const reminderText = options.reminder;
	if (reminderText) {
		pi.on("before_agent_start", () => {
			if (!toolActive || reminderDelivered) return undefined;
			reminderDelivered = true;
			return {
				message: { customType: PI_INBOX_REMINDER_CUSTOM_TYPE, content: reminderText, display: false },
			};
		});
		pi.on("session_compact", (_event, compactCtx: ExtensionContext) => {
			reminderDelivered = compactCtx ? branchHasReminder(compactCtx) : false;
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
