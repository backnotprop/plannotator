import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getPiSessionIdentity,
	notifyCurrentPiSession,
	registerCurrentPiSession,
	sendUserMessageToCurrentPiSession,
	type CurrentPiSessionRegistration,
} from "./current-pi-session.ts";
import { setPiHost } from "./pi-host.ts";

const registrations: CurrentPiSessionRegistration[] = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) registration.clear();
});

function createContext(sessionId: string, notifications: string[], idle = true): ExtensionContext {
	return {
		cwd: "/tmp",
		mode: "tui",
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => `/tmp/${sessionId}.jsonl`,
			getSessionName: () => sessionId,
		},
		ui: { notify: (message: string) => notifications.push(message) },
		isIdle: () => idle,
	} as unknown as ExtensionContext;
}

function registerSessionRuntime(
	sessionId: string,
	messages: string[],
	notifications: string[],
): { registration: CurrentPiSessionRegistration; ctx: ExtensionContext } {
	const pi = {
		sendUserMessage: (content: string) => messages.push(content),
	} as unknown as ExtensionAPI;
	const registration = registerCurrentPiSession(pi);
	registrations.push(registration);
	const ctx = createContext(sessionId, notifications);
	registration.update(ctx);
	return { registration, ctx };
}

describe("current Pi session feedback routing", () => {
	test("reload routes feedback to the replacement runtime with the same session ID", () => {
		const oldMessages: string[] = [];
		const oldNotifications: string[] = [];
		const oldRuntime = registerSessionRuntime("same-session", oldMessages, oldNotifications);
		const origin = getPiSessionIdentity(oldRuntime.ctx);

		const replacementMessages: string[] = [];
		const replacementNotifications: string[] = [];
		registerSessionRuntime("same-session", replacementMessages, replacementNotifications);
		oldRuntime.registration.clear();

		const result = sendUserMessageToCurrentPiSession(
			"annotation feedback",
			{ deliverAs: "followUp" },
			origin,
		);

		expect(result).toEqual({ ok: true });
		expect(notifyCurrentPiSession("feedback delivered", "info", origin)).toBe(true);
		expect(oldMessages).toEqual([]);
		expect(oldNotifications).toEqual([]);
		expect(replacementMessages).toEqual(["annotation feedback"]);
		expect(replacementNotifications).toEqual(["feedback delivered"]);
	});
});

describe("a message sent after a reload, while the agent is idle", () => {
	// Oh My Pi only queues a message that names `deliverAs`, even when idle, so
	// there the message must go without it to start a turn. Pi starts a turn
	// either way and keeps its options exactly as before.
	const cases = [
		{ host: "oh-my-pi", idle: true, expected: undefined },
		{ host: "oh-my-pi", idle: false, expected: { deliverAs: "followUp" } },
		{ host: "pi", idle: true, expected: { deliverAs: "followUp" } },
	] as const;
	for (const { host, idle, expected } of cases) {
		test(`${host}, ${idle ? "idle" : "busy"}: ${expected ? "keeps followUp" : "starts a turn"}`, () => {
			setPiHost(host);
			try {
				const oldRuntime = registerSessionRuntime("same-session", [], []);
				const origin = getPiSessionIdentity(oldRuntime.ctx);
				const sent: unknown[] = [];
				const replacement = registerCurrentPiSession({
					sendUserMessage: (_content: unknown, options?: unknown) => sent.push(options),
				} as unknown as ExtensionAPI);
				registrations.push(replacement);
				replacement.update(createContext("same-session", [], idle));
				oldRuntime.registration.clear();

				expect(sendUserMessageToCurrentPiSession("feedback", { deliverAs: "followUp" }, origin)).toEqual({ ok: true });
				expect(sent).toEqual([expected]);
			} finally {
				setPiHost("pi");
			}
		});
	}
});
