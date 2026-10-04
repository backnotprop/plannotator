import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getPiSessionIdentity,
	notifyCurrentPiSession,
	registerCurrentPiSession,
	sendUserMessageToCurrentPiSession,
	resolveIdleDeliveryOptions,
	type CurrentPiSessionRegistration,
} from "./current-pi-session.ts";

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

describe("resolveIdleDeliveryOptions", () => {
	test("idle host drops deliverAs so the host starts a turn", () => {
		expect(
			resolveIdleDeliveryOptions({ isIdle: () => true }, { deliverAs: "followUp" }),
		).toBeUndefined();
	});

	test("streaming host keeps deliverAs", () => {
		expect(
			resolveIdleDeliveryOptions({ isIdle: () => false }, { deliverAs: "followUp" }),
		).toEqual({ deliverAs: "followUp" });
	});

	test("idle host keeps sibling options and drops only deliverAs", () => {
		expect(
			resolveIdleDeliveryOptions(
				{ isIdle: () => true },
				{ deliverAs: "followUp", expandPromptTemplates: true },
			),
		).toEqual({ expandPromptTemplates: true });
	});

	test("host without isIdle passes options through unchanged", () => {
		expect(resolveIdleDeliveryOptions({}, { deliverAs: "followUp" })).toEqual({
			deliverAs: "followUp",
		});
	});

	test("probe that throws passes options through unchanged", () => {
		expect(
			resolveIdleDeliveryOptions(
				{
					isIdle: () => {
						throw new Error("probe exploded");
					},
				},
				{ deliverAs: "followUp" },
			),
		).toEqual({ deliverAs: "followUp" });
	});

	test("undefined options stay undefined", () => {
		expect(resolveIdleDeliveryOptions({ isIdle: () => true })).toBeUndefined();
	});

	test("options without deliverAs are untouched even when idle", () => {
		expect(
			resolveIdleDeliveryOptions({ isIdle: () => true }, { expandPromptTemplates: true }),
		).toEqual({ expandPromptTemplates: true });
	});

	test("steer is also dropped when idle", () => {
		expect(
			resolveIdleDeliveryOptions({ isIdle: () => true }, { deliverAs: "steer" }),
		).toBeUndefined();
	});
});

describe("idle delivery through the current-session send path", () => {
	test("idle replacement runtime drops deliverAs so the host starts a turn", () => {
		const oldRuntime = registerSessionRuntime("same-session", [], []);
		const origin = getPiSessionIdentity(oldRuntime.ctx);

		const captured: Array<{ content: unknown; options: unknown }> = [];
		const replacementPi = {
			sendUserMessage: (content: unknown, options?: unknown) => {
				captured.push({ content, options });
			},
		} as unknown as ExtensionAPI;
		const replacement = registerCurrentPiSession(replacementPi);
		registrations.push(replacement);
		replacement.update(createContext("same-session", [], true));
		oldRuntime.registration.clear();

		const result = sendUserMessageToCurrentPiSession(
			"annotation feedback",
			{ deliverAs: "followUp" },
			origin,
		);

		expect(result).toEqual({ ok: true });
		expect(captured).toEqual([{ content: "annotation feedback", options: undefined }]);
	});

	test("streaming replacement runtime keeps deliverAs", () => {
		const oldRuntime = registerSessionRuntime("same-session", [], []);
		const origin = getPiSessionIdentity(oldRuntime.ctx);

		const captured: Array<{ content: unknown; options: unknown }> = [];
		const replacementPi = {
			sendUserMessage: (content: unknown, options?: unknown) => {
				captured.push({ content, options });
			},
		} as unknown as ExtensionAPI;
		const replacement = registerCurrentPiSession(replacementPi);
		registrations.push(replacement);
		replacement.update(createContext("same-session", [], false));
		oldRuntime.registration.clear();

		const result = sendUserMessageToCurrentPiSession(
			"annotation feedback",
			{ deliverAs: "followUp" },
			origin,
		);

		expect(result).toEqual({ ok: true });
		expect(captured).toEqual([
			{ content: "annotation feedback", options: { deliverAs: "followUp" } },
		]);
	});

	test("isIdle on ExtensionAPI is ignored; the context is the probe", () => {
		const oldRuntime = registerSessionRuntime("same-session", [], []);
		const origin = getPiSessionIdentity(oldRuntime.ctx);

		const captured: Array<{ content: unknown; options: unknown }> = [];
		const lyingPi = {
			isIdle: () => true,
			sendUserMessage: (content: unknown, options?: unknown) => {
				captured.push({ content, options });
			},
		} as unknown as ExtensionAPI;
		const replacement = registerCurrentPiSession(lyingPi);
		registrations.push(replacement);
		replacement.update(createContext("same-session", [], false));
		oldRuntime.registration.clear();

		const result = sendUserMessageToCurrentPiSession(
			"annotation feedback",
			{ deliverAs: "followUp" },
			origin,
		);

		expect(result).toEqual({ ok: true });
		expect(captured).toEqual([
			{ content: "annotation feedback", options: { deliverAs: "followUp" } },
		]);
	});
});
